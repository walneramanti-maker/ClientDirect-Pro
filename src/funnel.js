// Entonnoir d'acquisition, mesuré sans cookie tiers ni donnée personnelle : uniquement des compteurs par jour,
// par étape et par canal (google, facebook, e-mail de prospection…). Les robots et les comptes connectés sont exclus.
const BOT = /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|headless|lighthouse|go-http|node-fetch|axios|java\/|okhttp|scan|uptime|render/i;
const SOCIAL = [['google', /(^|\.)google\./], ['bing', /(^|\.)bing\.com$/], ['duckduckgo', /duckduckgo\.com$/], ['qwant', /qwant\.com$/], ['ecosia', /ecosia\.org$/], ['yahoo', /yahoo\./],
  ['facebook', /(^|\.)(facebook\.com|fb\.com|fb\.me)$/], ['instagram', /instagram\.com$/], ['whatsapp', /(whatsapp\.com|wa\.me)$/], ['linkedin', /(linkedin\.com|lnkd\.in)$/],
  ['tiktok', /tiktok\.com$/], ['youtube', /(youtube\.com|youtu\.be)$/], ['x', /(^|\.)(t\.co|twitter\.com|x\.com)$/], ['webmail', /(mail\.|webmail|outlook\.|live\.com$|orange\.fr$|free\.fr$|laposte\.net$|sfr\.fr$)/]];
export const STEPS = ['visite', 'page_inscription', 'formulaire_commence', 'envoi', 'inscrit'];

export function isBot(req) { const ua = String(req.headers['user-agent'] || ''); return !ua || BOT.test(ua); }

/** Canal : paramètre utm/ref s'il existe, sinon le site d'où vient le visiteur, sinon « direct ». */
export function channelOf(req, url, ownHosts = []) {
  const clean = (v) => String(v || '').toLowerCase().replace(/[^\w.-]/g, '').slice(0, 30);
  const utm = clean(url.searchParams.get('utm_source')); if (utm) return utm === 'prospection' || utm === 'email' ? 'email' : `utm:${utm}`;
  const ref = clean(url.searchParams.get('ref')); if (ref) return ref.startsWith('p-') ? 'partenaire' : 'lien-site-client';
  let h = ''; try { h = new URL(String(req.headers.referer || '')).hostname.toLowerCase(); } catch { return 'direct'; }
  if (!h) return 'direct';
  if (ownHosts.some((o) => h === o || h.endsWith('.' + o))) return 'interne';
  for (const [name, re] of SOCIAL) if (re.test(h)) return name;
  return 'autre-site';
}

export function count(db, step, channel = '', now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  try { db.run('INSERT INTO funnel(day,step,channel,n) VALUES(?,?,?,1) ON CONFLICT(day,step,channel) DO UPDATE SET n=n+1', day, String(step).slice(0, 60), String(channel).slice(0, 40)); } catch { /* jamais bloquant */ }
}

/** Erreurs de formulaire regroupées par champ, pour savoir où les visiteurs abandonnent. */
export function errorField(msg) {
  const m = String(msg);
  if (/entreprise/i.test(m)) return 'entreprise'; if (/activit/i.test(m)) return 'activite'; if (/WhatsApp|téléphone|phone/i.test(m)) return 'telephone';
  if (/nom/i.test(m)) return 'nom'; if (/compte existe/i.test(m)) return 'email_deja_inscrit'; if (/e-mail|email/i.test(m)) return 'email';
  if (/mot de passe|password|caract/i.test(m)) return 'mot_de_passe'; if (/conditions/i.test(m)) return 'cgu'; if (/formule/i.test(m)) return 'formule';
  return 'autre';
}

export function funnelReport(db, fromIso, toIso) {
  const rows = db.all('SELECT step, channel, SUM(n) n FROM funnel WHERE day BETWEEN ? AND ? GROUP BY step, channel', fromIso, toIso);
  const etapes = Object.fromEntries(STEPS.map((s) => [s, 0])); const canaux = {}; const erreurs = {}; const pages = {};
  for (const r of rows) {
    if (r.step in etapes) etapes[r.step] += r.n;
    if (r.step === 'visite') canaux[r.channel || 'direct'] = (canaux[r.channel || 'direct'] || 0) + r.n;
    if (r.step.startsWith('erreur:')) erreurs[r.step.slice(7)] = (erreurs[r.step.slice(7)] || 0) + r.n;
    if (r.step.startsWith('page:')) pages[r.step.slice(5)] = (pages[r.step.slice(5)] || 0) + r.n;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return { etapes, canaux, pagesVues: pages, erreursParChamp: erreurs,
    taux: { visiteVersPageInscription: pct(etapes.page_inscription, etapes.visite), pageVersFormulaire: pct(etapes.formulaire_commence, etapes.page_inscription), formulaireVersEnvoi: pct(etapes.envoi, etapes.formulaire_commence), envoiVersInscrit: pct(etapes.inscrit, etapes.envoi) },
    abandonsFormulaire: Math.max(0, etapes.formulaire_commence - etapes.inscrit) };
}
