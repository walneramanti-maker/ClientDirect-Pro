// Campagnes commerciales : sélection par filtres, aperçu, validation groupée en un clic.
// Une campagne validée n'envoie RIEN : aucun canal d'envoi n'est branché tant que vous ne l'avez pas autorisé.
import { isSuppressed } from './suppression.js';
import { config } from './config.js';
import { demoTokenFor, displayName } from './prospect.js';
import { optoutLink } from './privacy.js';
import { TEMPLATES } from './templates.js';
import { DEPARTEMENTS, territoryOf } from './france.js';
import { country as countryOf } from './markets.js';
import { sendMail, buildMessage } from './smtp.js';
import { recordIncident } from './incidents.js';
import { sequenceEmail, sequenceSms, callPitch, nextDelayMs, LAST_STEP, SEQUENCE } from './outreach.js';

export const CHANNELS = { email: 'E-mail', sms: 'SMS', appel: 'Appel téléphonique' };
export const MAX_CAMPAIGN = 5000;

// Accroche d'appel selon l'analyse (jamais envoyée : aide pour la personne qui appelle). Formulée sans affirmer ce qui n'est pas vérifié.
const OPENERS = {
  aucun: "Je n'ai pas trouvé de site Internet pour votre entreprise : vos clients ne peuvent pas vous trouver ni réserver en ligne.",
  aucun_probable: "Je n'ai pas trouvé de site Internet à votre nom (à confirmer avec la personne).",
  plateforme: 'Vous êtes présent sur une plateforme ou un réseau social, mais sans site à votre nom.',
  vieillissant: 'Votre site existe, mais il est ancien',
  'récent': 'Votre site est récent'
};
export function callOpener(p) {
  const st = p.site_status || (p.website ? null : 'aucun_probable');
  let f = {}; try { f = JSON.parse(p.site_flags || '{}'); } catch { f = {}; }
  let o = OPENERS[st] || '';
  if (st === 'vieillissant') o += f.reasons?.length ? ` (${f.reasons.join(', ')}).` : '.';
  if (st === 'vieillissant' || st === 'récent') o += `${st === 'récent' ? ' ; ' : ' '}${[!f.booking && 'pas de réservation en ligne', !f.quote && 'pas de formulaire de devis'].filter(Boolean).join(', ') || 'il a déjà l’essentiel : proposer plutôt l’assistant 24 h/24 (Premium)'}.`;
  return o;
}
export function callScript(p, demoUrl) {
  const opener = callOpener(p);
  return `${opener ? `[Accroche, après la présentation : ${opener}] ` : ''}${callPitch(p, { name: displayName(p.name), demoUrl })}`;
}

/** Message personnalisé d'une étape (métier, besoin constaté, liens personnels de démonstration, d'essai et d'opposition). */
export function itemMessage(db, p, channel, step = 0) {
  const token = demoTokenFor(p.siren); const demoUrl = `${config.baseUrl}/demo/${token}`; const stopUrl = optoutLink(db, p.id); const name = displayName(p.name);
  if (channel === 'appel') return { subject: null, text: callScript(p, demoUrl) };
  if (channel === 'sms') return { subject: null, text: sequenceSms(p, { name, demoUrl, stopUrl }) };
  return sequenceEmail(p, { name, demoUrl, token, stopUrl, step });
}

/** Entreprises éligibles : à contacter, coordonnée présente pour le canal, ouvertes, pas déjà dans une campagne. */
function eligibleSql({ channel, depts = [], tpls = [], minScore = 0, minPotential = 0 }) {
  const w = ["p.status='new'", 'p.maps_closed=0', 'p.score>=?', 'p.potential>=?', "NOT EXISTS (SELECT 1 FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE i.prospect_id=p.id AND c.status!='canceled')"];
  const a = [Number(minScore) || 0, Math.max(0, Math.min(100, Number(minPotential) || 0))];
  w.push(channel === 'email' ? 'p.email IS NOT NULL AND p.email_ok=1 AND p.bounced_at IS NULL' : 'p.phone IS NOT NULL'); // e-mail : adresse vérifiée (domaine qui reçoit le courrier), jamais en rebond
  const d = depts.filter((x) => DEPARTEMENTS[x]); if (d.length) { w.push(`p.dept IN (${d.map(() => '?').join(',')})`); a.push(...d); }
  const t = tpls.filter((x) => TEMPLATES[x]); if (t.length) { w.push(`p.tpl IN (${t.map(() => '?').join(',')})`); a.push(...t); }
  return { where: w.join(' AND '), args: a };
}
export function countEligible(db, f) { const q = eligibleSql(f); return db.one(`SELECT COUNT(*) n FROM prospects p WHERE ${q.where}`, ...q.args).n; }

export function createCampaign(db, { name, channel, depts = [], tpls = [], minScore = 0, minPotential = 0, size = 500 }, now = Date.now()) {
  if (!CHANNELS[channel]) throw new Error('Canal inconnu');
  size = Math.max(1, Math.min(MAX_CAMPAIGN, Math.floor(Number(size) || 0)));
  const q = eligibleSql({ channel, depts, tpls, minScore, minPotential });
  // Jamais deux fois la même adresse : ni dans cette campagne, ni déjà présente dans une autre campagne en cours ou passée
  const used = new Set(db.all("SELECT LOWER(i.to_addr) a FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE c.status!='canceled' AND c.channel='email' AND i.to_addr IS NOT NULL").map((r) => r.a));
  const rows = db.all(`SELECT p.* FROM prospects p WHERE ${q.where} ORDER BY p.potential DESC, p.score DESC, p.id LIMIT ?`, ...q.args, size * 2).filter((p) => !isSuppressed(db, p))
    .filter((p) => { if (channel !== 'email') return true; const k = String(p.email || '').toLowerCase(); if (!k || used.has(k)) return false; used.add(k); return true; }).slice(0, size);
  if (!rows.length) throw new Error('Aucune entreprise ne correspond à ces critères (coordonnées requises pour ce canal).');
  let id;
  db.tx(() => {
    id = Number(db.run("INSERT INTO campaigns(name,channel,filters,size,status,created_at) VALUES(?,?,?,?,'draft',?)", String(name || '').slice(0, 80) || `Campagne ${new Date(now).toLocaleDateString('fr-FR')}`, channel, JSON.stringify({ depts, tpls, minScore }), rows.length, now).lastInsertRowid);
    for (const p of rows) {
      const m = itemMessage(db, p, channel, 0);
      db.run("INSERT INTO campaign_items(campaign_id,prospect_id,to_addr,message,subject,status) VALUES(?,?,?,?,?,'ready')", id, p.id, channel === 'email' ? p.email : p.phone, m.text, m.subject);
    }
  });
  return id;
}
export function campaignDetail(db, id) {
  const c = db.one('SELECT * FROM campaigns WHERE id=?', id); if (!c) return null;
  return {
    ...c, filters: JSON.parse(c.filters || '{}'),
    byDept: db.all('SELECT p.dept, COUNT(*) n FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? GROUP BY p.dept ORDER BY n DESC', id),
    byTpl: db.all('SELECT p.tpl, COUNT(*) n FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? GROUP BY p.tpl ORDER BY n DESC', id),
    // Échantillon réparti sur toute la campagne, pour relire avant de valider
    sample: db.all('SELECT i.*, p.name, p.city, p.dept FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? ORDER BY (i.id * 7919) % 1000 LIMIT 5', id),
    funnel: campaignFunnel(db, id),
    // Séquence complète (premier message et relances) pour une entreprise de l'échantillon
    sequence: c.channel === 'email' ? (() => { const it = db.one('SELECT prospect_id FROM campaign_items WHERE campaign_id=? ORDER BY id LIMIT 1', id); const p = it && db.one('SELECT * FROM prospects WHERE id=?', it.prospect_id); return p ? SEQUENCE.map((s) => ({ ...s, ...itemMessage(db, p, 'email', s.step), name: p.name })) : []; })() : [],
    optedOut: db.one("SELECT COUNT(*) n FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? AND p.status='optout'", id).n
  };
}
export function approveCampaign(db, id, now = Date.now()) {
  // Les entreprises qui se sont opposées entre-temps sont retirées au moment de la validation
  db.run("UPDATE campaign_items SET status='skipped' WHERE campaign_id=? AND prospect_id IN (SELECT id FROM prospects WHERE status='optout')", id);
  return Number(db.run("UPDATE campaigns SET status='approved', approved_at=? WHERE id=? AND status='draft'", now, id).changes);
}
export function cancelCampaign(db, id) { return Number(db.run("UPDATE campaigns SET status='canceled' WHERE id=? AND status='draft'", id).changes); }

/** Heure locale du prospect (métropole ou Outre-mer) : envoi en semaine, de 9 h à 18 h, uniquement. */
function businessHours(p, now) {
  const tz = countryOf(territoryOf(p.postal)).tz || 'Europe/Paris';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  const h = Number(parts.hour) % 24; return !['Sat', 'Sun'].includes(parts.weekday) && h >= 9 && h < 18;
}
/** Les campagnes de prospection ne passent JAMAIS par Brevo (règles anti-spam de Brevo : contacts sans consentement
 * interdits ; un blocage du compte toucherait aussi les e-mails transactionnels et les autres projets du compte). */
export const brevoRelay = (host) => /(^|\.)brevo\.com$|sendinblue/i.test(String(host || ''));
export function sendingReady() { const s = config.smtp; return config.campaignSending && !!(s.host && s.user && s.pass && s.from) && !brevoRelay(s.host); }
export function sentToday(db, now = Date.now()) { return db.one('SELECT COUNT(*) n FROM campaign_sends WHERE sent_at>=?', now - (now % 864e5)).n; }
/** Une relance s'arrête dès que l'entreprise a répondu, s'est opposée, s'est inscrite, a refusé ou si l'adresse est invalide. */
const FOLLOWUP_OK = "p.status IN ('contacted','demo') AND p.replied_at IS NULL AND p.bounced_at IS NULL AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.prospect_id=p.id AND t.status!='demo')";
/**
 * Envoie AU PLUS UN e-mail par passage, espacés d'au moins CAMPAIGN_GAP_MIN minutes, sous le plafond quotidien,
 * uniquement depuis des campagnes e-mail validées, jamais à une entreprise qui s'est opposée.
 * Les relances dues (J+4 puis J+10) passent avant les premiers messages ; 3 messages au plus par entreprise.
 */
export async function sendNext(db, { now = Date.now(), send = sendMail } = {}) {
  if (!sendingReady()) return { skipped: 'envoi désactivé' };
  if (sentToday(db, now) >= config.campaignDailyMax) return { skipped: 'plafond quotidien' };
  const last = Number(db.one("SELECT v FROM meta WHERE k='campaign_last_send'")?.v || 0);
  if (now - last < config.campaignGapMin * 60e3) return { skipped: 'espacement' };
  const base = "SELECT i.*, p.name, p.postal, p.siren, p.status pstatus FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id JOIN prospects p ON p.id=i.prospect_id WHERE c.status='approved' AND c.channel='email'";
  // Relances qui ne sont plus d'actualité : arrêtées définitivement
  db.run(`UPDATE campaign_items SET next_at=NULL WHERE status='sent' AND next_at IS NOT NULL AND prospect_id IN (SELECT p.id FROM prospects p WHERE NOT (${FOLLOWUP_OK}))`);
  const due = db.all(`${base} AND i.status='sent' AND i.next_at IS NOT NULL AND i.next_at<=? AND ${FOLLOWUP_OK} ORDER BY i.next_at LIMIT 50`, now).map((x) => ({ ...x, follow: true }));
  const fresh = db.all(`${base} AND i.status='ready' ORDER BY c.approved_at, i.id LIMIT 50`);
  for (const it of [...due, ...fresh]) {
    if (it.pstatus === 'optout' || isSuppressed(db, { siren: it.siren, email: it.to_addr })) { db.run(`UPDATE campaign_items SET ${it.follow ? 'next_at=NULL' : "status='skipped'"}, error='opposition' WHERE id=?`, it.id); continue; }
    if (!businessHours(it, now)) continue;
    const step = it.follow ? it.step + 1 : 0;
    const p = db.one('SELECT * FROM prospects WHERE id=?', it.prospect_id);
    const m = step === 0 && it.subject ? { subject: it.subject, text: it.message } : itemMessage(db, p, 'email', step);
    db.run("INSERT INTO meta(k,v) VALUES('campaign_last_send',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(now));
    const stop = (/\/stop\/[A-Za-z0-9_-]+/.exec(m.text) || [''])[0];
    const data = buildMessage({ from: config.smtp.from, fromName: config.smtp.fromName, to: it.to_addr, subject: m.subject || `Un exemple de site pour ${displayName(it.name)}`, text: m.text, unsubscribeUrl: stop ? config.baseUrl + stop : null });
    try {
      await send({ ...config.smtp, to: it.to_addr, data });
      const next = step < LAST_STEP ? now + nextDelayMs(step) : null;
      db.run(`UPDATE campaign_items SET status='sent', step=?, next_at=?${step === 0 ? ', sent_at=?' : ''} WHERE id=?`, ...(step === 0 ? [step, next, now, it.id] : [step, next, it.id]));
      db.run('INSERT INTO campaign_sends(item_id,step,sent_at) VALUES(?,?,?)', it.id, step, now);
      db.run("UPDATE prospects SET status=CASE WHEN status='new' THEN 'contacted' ELSE status END, last_contact_at=? WHERE id=?", now, it.prospect_id);
      return { sent: it.id, step };
    } catch (e) {
      db.run(`UPDATE campaign_items SET ${it.follow ? 'next_at=NULL' : "status='skipped'"}, error=? WHERE id=?`, String(e.message).slice(0, 200), it.id);
      if (/^SMTP 55[0-3]/.test(e.message)) db.run('UPDATE prospects SET bounced_at=? WHERE id=?', now, it.prospect_id);
      recordIncident(db, { kind: 'campagne', severity: /^SMTP 5|auth/i.test(e.message) ? 'warning' : 'info', message: `Envoi refusé : ${String(e.message).slice(0, 140)}` });
      return { error: e.message };
    }
  }
  return { skipped: 'rien à envoyer à cette heure' };
}

/** Suivi des conversions d'une campagne : envois par étape, démonstrations ouvertes, réponses, inscriptions, paiements, oppositions. */
export function campaignFunnel(db, id) {
  const steps = Object.fromEntries(SEQUENCE.map((s) => [s.step, db.one('SELECT COUNT(*) n FROM campaign_sends s JOIN campaign_items i ON i.id=s.item_id WHERE i.campaign_id=? AND s.step=?', id, s.step).n]));
  const q = (w) => db.one(`SELECT COUNT(*) n FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? AND i.status='sent' AND ${w}`, id).n;
  const contacted = q('1');
  const r = {
    contacted, steps,
    demoOpened: q("(p.demo_views>0 OR p.status IN ('demo','converted') OR EXISTS (SELECT 1 FROM tenants t WHERE t.prospect_id=p.id))"),
    replied: q('p.replied_at IS NOT NULL'),
    signups: q("EXISTS (SELECT 1 FROM tenants t WHERE t.prospect_id=p.id AND t.status!='demo')"),
    paying: q("EXISTS (SELECT 1 FROM tenants t WHERE t.prospect_id=p.id AND t.status IN ('active','past_due'))"),
    optout: q("p.status='optout'"), bounced: q('p.bounced_at IS NOT NULL'), lost: q("p.status='lost'"),
    pendingFollowups: db.one("SELECT COUNT(*) n FROM campaign_items WHERE campaign_id=? AND status='sent' AND next_at IS NOT NULL", id).n,
    waiting: db.one("SELECT COUNT(*) n FROM campaign_items WHERE campaign_id=? AND status='ready'", id).n
  };
  const pct = (a) => (contacted ? Math.round((a / contacted) * 1000) / 10 : 0);
  r.rates = { demo: pct(r.demoOpened), reply: pct(r.replied), signup: pct(r.signups), paying: pct(r.paying), optout: pct(r.optout) };
  return r;
}

/** Préfixe des campagnes préparées automatiquement (régénérées chaque jour tant qu'elles ne sont pas validées). */
export const AUTO_PREFIX = 'Préparée automatiquement';
/**
 * Prépare les campagnes en brouillon, sans jamais les valider ni les envoyer : e-mail (potentiel ≥ 50) et appels (potentiel ≥ 75).
 * Les brouillons automatiques encore non validés sont recréés à chaque passage : prospects à jour, opposition respectée,
 * liens de démonstration construits sur l'adresse actuelle du site (ex. après le passage au nom de domaine définitif).
 * Une campagne validée par l'administrateur n'est jamais modifiée.
 */
export function prepareDrafts(db, now = Date.now()) {
  // Une entreprise n'est que dans une campagne à la fois : l'e-mail d'abord (envoi et relances automatiques),
  // les appels pour les entreprises de potentiel A joignables seulement par téléphone
  const plans = [
    { channel: 'email', minPotential: 50, size: 500, label: 'e-mails, potentiel A et B' },
    { channel: 'appel', minPotential: 75, size: 300, label: 'appels, potentiel A' }
  ];
  const out = {};
  db.run("UPDATE campaigns SET status='canceled' WHERE status='draft' AND name LIKE ?", `${AUTO_PREFIX}%`);
  for (const p of plans) {
    try {
      const id = createCampaign(db, { name: `${AUTO_PREFIX} : ${p.label} (${new Date(now).toISOString().slice(0, 10)})`, channel: p.channel, minPotential: p.minPotential, size: p.size }, now);
      out[p.channel] = { brouillon: id, entreprises: db.one('SELECT COUNT(*) n FROM campaign_items WHERE campaign_id=?', id).n };
    } catch (e) { out[p.channel] = { aucune: e.message }; }
  }
  return out;
}

/** Textes des campagnes non encore validées remis à jour avec les modèles actuels (mêmes destinataires, mêmes liens). */
export function refreshDraftTexts(db) {
  let n = 0;
  for (const it of db.all("SELECT i.id, i.prospect_id, c.channel FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE c.status='draft' AND i.status='ready'")) {
    const p = db.one('SELECT * FROM prospects WHERE id=?', it.prospect_id); if (!p) continue;
    const m = itemMessage(db, p, it.channel, 0); db.run('UPDATE campaign_items SET message=?, subject=? WHERE id=?', m.text, m.subject, it.id); n++;
  }
  return n;
}
/** Doublons d'adresse entre campagnes en cours ou passées (doit rester à 0). */
export function duplicateAddresses(db) {
  return db.all("SELECT LOWER(i.to_addr) a, COUNT(DISTINCT i.prospect_id) n FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE c.status!='canceled' AND c.channel='email' AND i.to_addr IS NOT NULL GROUP BY LOWER(i.to_addr) HAVING n>1").length;
}
