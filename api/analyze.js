/* ============================================================
   PROXY SERVERLESS — /api/analyze  (Vercel Functions)
   v4 — Moteur : Google Gemini (gemini-2.5-flash, tier gratuit AI Studio)
   ⚠️ gemini-1.5-flash est ARRÊTÉ (404). On utilise gemini-2.5-flash.

   Conserve toute la logique :
     - vérifie l'authentification (jeton Supabase)
     - consomme 1 crédit de façon ATOMIQUE (hard limit) avant l'appel IA
     - rembourse le crédit si l'analyse échoue
     - renvoie le JSON exact attendu par index.html
       { score, status, tier, strengths, weaknesses, questions[], summary }

   Variables d'environnement (Vercel → Settings → Environment Variables) :
     GEMINI_API_KEY               — clé Google AI Studio (secrète)
     SUPABASE_SERVICE_ROLE_KEY    — clé service_role Supabase (secrète)
     (SUPABASE_URL et SUPABASE_ANON_KEY ont des valeurs par défaut ci-dessous,
      tu peux aussi les définir dans Vercel pour les surcharger.)
   Aucune dépendance npm (fetch natif, Node 18+).
   ============================================================ */

// --- Config Supabase (l'URL et la clé "publishable" sont publiques par design) ---
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://jceghdnuzrpksrboubht.supabase.co';
const SUPABASE_ANON  = process.env.SUPABASE_ANON_KEY || 'sb_publishable_oqQeJRaYxBObuNGzP3hG4A_-hQBeJjH';
const SUPABASE_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY; // SECRÈTE — uniquement côté serveur

const GEMINI_MODEL = 'gemini-2.5-flash'; // alternative plus rapide : 'gemini-2.5-flash-lite'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY manquante dans Vercel' });
  if (!SUPABASE_SECRET)            return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquante dans Vercel' });

  // ---------- 1) AUTHENTIFICATION : qui est l'utilisateur ? ----------
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let userId;
  try {
    const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON, authorization: `Bearer ${token}` },
    });
    if (!who.ok) return res.status(401).json({ error: 'Jeton invalide' });
    const user = await who.json();
    userId = user.id;
    if (!userId) return res.status(401).json({ error: 'Utilisateur introuvable' });
  } catch (e) {
    console.error("Détail du bug d'analyse (auth) :", e);
    return res.status(401).json({ error: 'Vérification du jeton impossible' });
  }

  // ---------- 2) Validation du corps (texte du CV extrait par le site) ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON invalide' }); } }
  const { job, cv } = body || {};
  if (!cv || !cv.trim()) return res.status(400).json({ error: 'CV manquant' });
  if (!job)             return res.status(400).json({ error: 'Fiche de poste manquante' });

  // ---------- 3) HARD LIMIT : consommation atomique d'un crédit ----------
  const consumed = await rpc('consume_credit', { uid: userId });
  if (consumed !== true) {
    return res.status(402).json({ error: 'Quota gratuit atteint', upgrade: true });
  }

  // ---------- 4) Construction du prompt ----------
  const must  = (job.must || []).join(', ') || 'aucune';
  const nice  = (job.nice || []).join(', ') || 'aucun';
  const years = Number(job.years) || 0;

  const SYSTEM_RULES =
`Tu es un assistant de présélection RH. Tu compares un CV à une fiche de poste.
Tu réponds UNIQUEMENT par un objet JSON valide, sans texte ni Markdown autour.
Format exact :
{
  "score": <entier 0-100>,
  "status": "À rencontrer" | "À étudier" | "À écarter",
  "strengths": "<2-3 forces concrètes, séparées par des ;>",
  "weaknesses": "<2-3 faiblesses ou écarts, séparées par des ;>",
  "questions": ["<question d'entretien 1>", "<question 2>", "<question 3>"],
  "summary": "<synthèse de 2 phrases sur l'adéquation du profil>"
}
Règles de score : "À rencontrer" >= 70 ; "À étudier" 45-69 ; "À écarter" < 45.
Pondère : compétences indispensables > atouts > expérience.
Les "questions" visent à lever les doutes (compétences manquantes, écart d'expérience).
Aide à la décision uniquement : ne juge jamais sur des critères protégés (âge, sexe, origine, santé, etc.).`;

  const PROMPT =
`FICHE DE POSTE
Intitulé : ${job.title || 'non précisé'}
Expérience requise : ${years} ans
Compétences indispensables : ${must}
Atouts appréciés : ${nice}

CV DU CANDIDAT
${cv}`;

  // ---------- 5) Appel Gemini (sortie forcée en JSON) ----------
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
        contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',  // force une réponse JSON pure
          thinkingConfig: { thinkingBudget: 0 }, // désactive le "thinking" (plus rapide, évite les réponses vides)
        },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("Détail du bug d'analyse (Gemini) :", { status: r.status, detail });
      await rpc('refund_credit', { uid: userId });
      return res.status(502).json({ error: "Échec de l'analyse IA (Gemini)", status: r.status, detail });
    }

    const data = await r.json();

    // bloqué par les filtres de sécurité ou réponse vide ?
    const blocked = data?.promptFeedback?.blockReason;
    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (blocked || !text) {
      console.error("Détail du bug d'analyse (réponse vide/bloquée) :", JSON.stringify(data).slice(0, 500));
      await rpc('refund_credit', { uid: userId });
      return res.status(502).json({ error: 'Réponse IA vide ou bloquée', blockReason: blocked || null });
    }

    // ---------- 6) Parse robuste ----------
    let p;
    try { p = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { await rpc('refund_credit', { uid: userId }); return res.status(502).json({ error: 'Réponse IA illisible', raw: text }); }
      p = JSON.parse(m[0]);
    }

    // ---------- 7) Normalisation (JSON EXACT attendu par index.html) ----------
    const score = Math.max(0, Math.min(100, Math.round(Number(p.score) || 0)));
    const status = ['À rencontrer', 'À étudier', 'À écarter'].includes(p.status)
      ? p.status : (score >= 70 ? 'À rencontrer' : score >= 45 ? 'À étudier' : 'À écarter');
    const tier = score >= 70 ? 'good' : score >= 45 ? 'warn' : 'bad';
    const questions = Array.isArray(p.questions) ? p.questions.map(q => String(q).slice(0, 200)).slice(0, 5) : [];

    return res.status(200).json({
      score, status, tier,
      strengths: String(p.strengths || '').slice(0, 500),
      weaknesses: String(p.weaknesses || '').slice(0, 500),
      questions,
      summary: String(p.summary || '').slice(0, 500),
    });

  } catch (e) {
    console.error("Détail du bug d'analyse :", e);
    await rpc('refund_credit', { uid: userId });
    return res.status(500).json({ error: 'Erreur serveur', detail: String(e) });
  }
}

/* ---------- Helper : fonction Postgres via la service_role key (contourne la RLS) ---------- */
async function rpc(fn, args) {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: SUPABASE_SECRET,
        authorization: `Bearer ${SUPABASE_SECRET}`,
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) { console.error('RPC ' + fn + ' a échoué :', r.status, await r.text()); return null; }
    return await r.json();
  } catch (e) {
    console.error('RPC ' + fn + ' erreur :', e);
    return null;
  }
}
