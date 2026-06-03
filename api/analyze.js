/* ============================================================
   PROXY SERVERLESS — /api/analyze  (Vercel Functions)
   v3 (P0) :
     - vérifie l'authentification (jeton Supabase)
     - consomme 1 crédit de façon ATOMIQUE (hard limit) avant l'appel IA
     - rembourse le crédit si l'analyse échoue
     - met en cache le bloc système + fiche de poste (cache_control)
     - renvoie un résumé structuré (forces / faiblesses / questions)

   Variables d'environnement requises :
     ANTHROPIC_API_KEY            — clé Anthropic (secrète)
     SUPABASE_URL                 — URL du projet Supabase
     SUPABASE_ANON_KEY            — clé anon (publique) pour valider le jeton
     SUPABASE_SERVICE_ROLE_KEY    — clé service_role (secrète) pour les crédits
   Aucune dépendance npm (fetch natif, Node 18+).
   ============================================================ */

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  // ---------- 1) AUTHENTIFICATION : récupère l'utilisateur depuis son jeton ----------
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Non authentifié' });

  let userId;
  try {
    const who = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: process.env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
    });
    if (!who.ok) return res.status(401).json({ error: 'Jeton invalide' });
    const user = await who.json();
    userId = user.id;
    if (!userId) return res.status(401).json({ error: 'Utilisateur introuvable' });
  } catch {
    return res.status(401).json({ error: 'Vérification du jeton impossible' });
  }

  // ---------- 2) Validation du corps ----------
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'JSON invalide' }); } }
  const { job, cv } = body || {};
  if (!cv || !cv.trim()) return res.status(400).json({ error: 'CV manquant' });
  if (!job)             return res.status(400).json({ error: 'Fiche de poste manquante' });

  // ---------- 3) HARD LIMIT : consommation atomique d'un crédit ----------
  // (la fonction consume_credit incrémente credits_used si < credits_limit)
  const consumed = await rpc('consume_credit', { uid: userId });
  if (consumed !== true) {
    return res.status(402).json({ error: 'Quota gratuit atteint', upgrade: true });
  }

  // ---------- 4) Construction du prompt ----------
  const must = (job.must || []).join(', ') || 'aucune';
  const nice = (job.nice || []).join(', ') || 'aucun';
  const years = Number(job.years) || 0;

  // Règles STATIQUES (identiques pour tous les candidats) — bon candidat au cache
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

  // Contexte du POSTE : identique pour tous les CV d'un même poste → on le met en cache.
  // Lors du tri de 50 CV sur le même poste, ce bloc n'est facturé plein tarif qu'une fois.
  const JOB_CONTEXT =
`FICHE DE POSTE
Intitulé : ${job.title || 'non précisé'}
Expérience requise : ${years} ans
Compétences indispensables : ${must}
Atouts appréciés : ${nice}`;

  const userMsg = `CV DU CANDIDAT\n${cv}`;

  // ---------- 5) Appel Anthropic (Claude Haiku 4.5) avec cache_control ----------
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        temperature: 0,
        // system = tableau de blocs ; le cache porte sur le préfixe jusqu'au bloc marqué.
        system: [
          { type: 'text', text: SYSTEM_RULES },
          { type: 'text', text: JOB_CONTEXT, cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!r.ok) {
      await rpc('refund_credit', { uid: userId });            // analyse non aboutie → on rembourse
      return res.status(502).json({ error: "Échec de l'analyse IA", detail: await r.text() });
    }

    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // ---------- 6) Parse robuste ----------
    let p;
    try { p = JSON.parse(text); }
    catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) { await rpc('refund_credit', { uid: userId }); return res.status(502).json({ error: 'Réponse IA illisible', raw: text }); }
      p = JSON.parse(m[0]);
    }

    // ---------- 7) Normalisation / garde-fous ----------
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
    await rpc('refund_credit', { uid: userId });
    return res.status(500).json({ error: 'Erreur serveur', detail: String(e) });
  }
}

/* ---------- Helper : appelle une fonction Postgres via la service_role key ----------
   (la service_role contourne la RLS — réservée au serveur, jamais exposée au client) */
async function rpc(fn, args) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
