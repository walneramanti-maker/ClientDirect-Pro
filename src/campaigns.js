// Campagnes commerciales : sélection par filtres, aperçu, validation groupée en un clic.
// Une campagne validée n'envoie RIEN : aucun canal d'envoi n'est branché tant que vous ne l'avez pas autorisé.
import { config } from './config.js';
import { outreachMessage, demoTokenFor, displayName } from './prospect.js';
import { optoutLink } from './privacy.js';
import { TEMPLATES } from './templates.js';
import { DEPARTEMENTS, territoryOf } from './france.js';
import { country as countryOf } from './markets.js';
import { sendMail, buildMessage } from './smtp.js';
import { recordIncident } from './incidents.js';

export const CHANNELS = { email: 'E-mail', sms: 'SMS', appel: 'Appel téléphonique' };
export const MAX_CAMPAIGN = 5000;

export function callScript(p, demoUrl) {
  const n = displayName(p.name); const m = (TEMPLATES[p.tpl]?.metier || 'votre activité').toLowerCase();
  return `« Bonjour, ${config.legal.owner}, de ClientDirect Pro. Je vous appelle au sujet de votre activité (${m}) ; vous avez deux minutes ? J'ai préparé gratuitement un exemple de site pour ${n} : vos clients y demandent un devis ou vous écrivent sur WhatsApp, à toute heure. Je peux vous l'envoyer par SMS ou par e-mail ? » — Si oui : envoyer le lien ${demoUrl}. — Si non : « Très bien, je ne vous rappellerai pas » et passer le statut à « Ne plus contacter ».`;
}

/** Entreprises éligibles : à contacter, coordonnée présente pour le canal, ouvertes, pas déjà dans une campagne. */
function eligibleSql({ channel, depts = [], tpls = [], minScore = 0 }) {
  const w = ["p.status='new'", 'p.maps_closed=0', 'p.score>=?', "NOT EXISTS (SELECT 1 FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE i.prospect_id=p.id AND c.status!='canceled')"];
  const a = [Number(minScore) || 0];
  w.push(channel === 'email' ? 'p.email IS NOT NULL' : 'p.phone IS NOT NULL');
  const d = depts.filter((x) => DEPARTEMENTS[x]); if (d.length) { w.push(`p.dept IN (${d.map(() => '?').join(',')})`); a.push(...d); }
  const t = tpls.filter((x) => TEMPLATES[x]); if (t.length) { w.push(`p.tpl IN (${t.map(() => '?').join(',')})`); a.push(...t); }
  return { where: w.join(' AND '), args: a };
}
export function countEligible(db, f) { const q = eligibleSql(f); return db.one(`SELECT COUNT(*) n FROM prospects p WHERE ${q.where}`, ...q.args).n; }

export function createCampaign(db, { name, channel, depts = [], tpls = [], minScore = 0, size = 500 }, now = Date.now()) {
  if (!CHANNELS[channel]) throw new Error('Canal inconnu');
  size = Math.max(1, Math.min(MAX_CAMPAIGN, Math.floor(Number(size) || 0)));
  const q = eligibleSql({ channel, depts, tpls, minScore });
  const rows = db.all(`SELECT p.* FROM prospects p WHERE ${q.where} ORDER BY p.score DESC, p.id LIMIT ?`, ...q.args, size);
  if (!rows.length) throw new Error('Aucune entreprise ne correspond à ces critères (coordonnées requises pour ce canal).');
  let id;
  db.tx(() => {
    id = Number(db.run("INSERT INTO campaigns(name,channel,filters,size,status,created_at) VALUES(?,?,?,?,'draft',?)", String(name || '').slice(0, 80) || `Campagne ${new Date(now).toLocaleDateString('fr-FR')}`, channel, JSON.stringify({ depts, tpls, minScore }), rows.length, now).lastInsertRowid);
    for (const p of rows) {
      const demo = `${config.baseUrl}/demo/${demoTokenFor(p.siren)}`; const stop = optoutLink(db, p.id);
      const msg = channel === 'appel' ? callScript(p, demo) : outreachMessage(p, demo, stop, { channel });
      db.run("INSERT INTO campaign_items(campaign_id,prospect_id,to_addr,message,status) VALUES(?,?,?,?,'ready')", id, p.id, channel === 'email' ? p.email : p.phone, msg);
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
export function sendingReady() { const s = config.smtp; return config.campaignSending && !!(s.host && s.user && s.pass && s.from); }
export function sentToday(db, now = Date.now()) { return db.one('SELECT COUNT(*) n FROM campaign_items WHERE sent_at>=?', now - (now % 864e5)).n; }
/**
 * Envoie AU PLUS UN e-mail par passage, espacés d'au moins CAMPAIGN_GAP_MIN minutes, sous le plafond quotidien,
 * uniquement depuis des campagnes e-mail validées, jamais à une entreprise qui s'est opposée.
 */
export async function sendNext(db, { now = Date.now(), send = sendMail } = {}) {
  if (!sendingReady()) return { skipped: 'envoi désactivé' };
  if (sentToday(db, now) >= config.campaignDailyMax) return { skipped: 'plafond quotidien' };
  const last = Number(db.one("SELECT v FROM meta WHERE k='campaign_last_send'")?.v || 0);
  if (now - last < config.campaignGapMin * 60e3) return { skipped: 'espacement' };
  const cands = db.all("SELECT i.*, p.name, p.postal, p.siren, p.status pstatus FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id JOIN prospects p ON p.id=i.prospect_id WHERE c.status='approved' AND c.channel='email' AND i.status='ready' ORDER BY c.approved_at, i.id LIMIT 50");
  for (const it of cands) {
    if (it.pstatus === 'optout') { db.run("UPDATE campaign_items SET status='skipped', error='opposition' WHERE id=?", it.id); continue; }
    if (!businessHours(it, now)) continue;
    db.run("INSERT INTO meta(k,v) VALUES('campaign_last_send',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(now));
    const stop = (/\/stop\/[A-Za-z0-9_-]+/.exec(it.message) || [''])[0];
    const data = buildMessage({ from: config.smtp.from, fromName: config.smtp.fromName, to: it.to_addr, subject: `Un exemple de site pour ${displayName(it.name)}`, text: it.message, unsubscribeUrl: stop ? config.baseUrl + stop : null });
    try {
      await send({ ...config.smtp, to: it.to_addr, data });
      db.run("UPDATE campaign_items SET status='sent', sent_at=? WHERE id=?", now, it.id);
      db.run("UPDATE prospects SET status=CASE WHEN status='new' THEN 'contacted' ELSE status END, last_contact_at=? WHERE id=?", now, it.prospect_id);
      return { sent: it.id };
    } catch (e) {
      db.run("UPDATE campaign_items SET status='skipped', error=? WHERE id=?", String(e.message).slice(0, 200), it.id);
      recordIncident(db, { kind: 'campagne', severity: /^SMTP 5|auth/i.test(e.message) ? 'warning' : 'info', message: `Envoi refusé : ${String(e.message).slice(0, 140)}` });
      return { error: e.message };
    }
  }
  return { skipped: 'rien à envoyer à cette heure' };
}
