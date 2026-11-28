// RGPD : liste d'opposition permanente. Une entreprise qui s'oppose n'est plus jamais sollicitée,
// même si elle réapparaît dans le registre, sur OpenStreetMap ou sur Maps sous un autre SIREN.
// On ne conserve que des empreintes (SHA-256 avec sel) du SIREN, du téléphone et de l'e-mail : pas les données elles-mêmes.
import { config } from './config.js';
import { hmac } from './util.js';

/** Téléphone au format international (+33…, +594…, +590…, +596…, +262…). null si invalide ou surtaxé. */
export function normPhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('+')) {
    if (/^\+33[1-9]\d{8}$/.test(d)) return d.startsWith('+3389') ? null : d;
    if (/^\+(594|590|596|262|269)\d{9}$/.test(d)) return d.replace(/^\+269/, '+262');
    return /^\+\d{8,15}$/.test(d) ? d : null;
  }
  if (!/^0[1-9]\d{8}$/.test(d)) return null;
  if (/^089/.test(d)) return null; // numéros surtaxés : pas une ligne d'entreprise à démarcher
  const dom = [[/^0(594|694|9763|9764)/, '+594'], [/^0(590|690|691)/, '+590'], [/^0(596|696|697)/, '+596'], [/^0(262|263|692|693)/, '+262'], [/^0(269|639)/, '+262']];
  for (const [re, cc] of dom) if (re.test(d)) return cc + d.slice(1);
  return '+33' + d.slice(1);
}
const normEmail = (e) => String(e || '').trim().toLowerCase() || null;
const fp = (kind, v) => hmac(config.secret, `suppr:${kind}:${v}`);

/** Ajoute l'entreprise (et ses coordonnées) à la liste d'opposition. */
export function suppress(db, { siren, phone, email }, source = 'opposition') {
  const now = Date.now(); let n = 0;
  for (const [kind, v] of [['siren', siren ? String(siren).replace(/\D/g, '') : null], ['phone', normPhone(phone)], ['email', normEmail(email)]]) {
    if (!v) continue;
    n += Number(db.run('INSERT OR IGNORE INTO suppressions(kind,hash,source,created_at) VALUES(?,?,?,?)', kind, fp(kind, v), source, now).changes);
  }
  return n;
}
export function isSuppressed(db, { siren, phone, email }) {
  const checks = [['siren', siren ? String(siren).replace(/\D/g, '') : null], ['phone', normPhone(phone)], ['email', normEmail(email)]].filter(([, v]) => v);
  return checks.some(([kind, v]) => db.one('SELECT 1 x FROM suppressions WHERE kind=? AND hash=?', kind, fp(kind, v)));
}
/** Opposition enregistrée : statut, suppression des coordonnées, démo supprimée, ajout à la liste permanente. */
export function applyOptout(db, prospectId, source = 'opposition') {
  const p = db.one('SELECT * FROM prospects WHERE id=?', prospectId); if (!p) return null;
  suppress(db, p, source);
  db.run("UPDATE prospects SET status='optout', name='(opposition)', address='', notes='', siret='', phone=NULL, email=NULL, website=NULL, optout_token_hash=NULL, last_contact_at=? WHERE id=?", Date.now(), p.id);
  if (p.demo_tenant_id) db.run("DELETE FROM tenants WHERE id=? AND status='demo'", p.demo_tenant_id);
  db.run("UPDATE campaign_items SET status='skipped', error='opposition' WHERE prospect_id=? AND status='ready'", p.id);
  return p;
}

/**
 * Contrôle qualité des coordonnées : format international, doublons (même téléphone ou e-mail sur plusieurs fiches),
 * prospects qui correspondent à une opposition. Idempotent.
 */
export function cleanContacts(db) {
  const r = { normalized: 0, invalid: 0, duplicates: 0, suppressed: 0, optoutsSecured: 0 };
  // Oppositions déjà enregistrées : empreintes ajoutées à la liste permanente, coordonnées effacées
  for (const p of db.all("SELECT * FROM prospects WHERE status='optout'")) {
    r.optoutsSecured += suppress(db, p, 'opposition');
    if (p.phone || p.email || p.website) db.run('UPDATE prospects SET phone=NULL, email=NULL, website=NULL WHERE id=?', p.id);
  }
  for (const p of db.all("SELECT id, siren, phone, email FROM prospects WHERE status NOT IN ('optout') AND (phone IS NOT NULL OR email IS NOT NULL)")) {
    if (isSuppressed(db, p)) { applyOptout(db, p.id, 'opposition (même coordonnée)'); r.suppressed++; continue; }
    if (p.phone) {
      const n = normPhone(p.phone);
      if (!n) { db.run("UPDATE prospects SET phone=NULL, contact_source=COALESCE(contact_source,'') || ' (téléphone invalide retiré)' WHERE id=?", p.id); r.invalid++; }
      else if (n !== p.phone) { db.run('UPDATE prospects SET phone=? WHERE id=?', n, p.id); r.normalized++; }
    }
    if (p.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(p.email)) { db.run('UPDATE prospects SET email=NULL WHERE id=?', p.id); r.invalid++; }
  }
  // Doublons : on garde la fiche au meilleur potentiel (puis la plus ancienne), les autres perdent la coordonnée en double
  for (const col of ['phone', 'email']) {
    for (const g of db.all(`SELECT ${col} v FROM prospects WHERE ${col} IS NOT NULL AND status NOT IN ('optout','converted') GROUP BY ${col} HAVING COUNT(*) > 1`)) {
      const rows = db.all(`SELECT id FROM prospects WHERE ${col}=? AND status NOT IN ('optout','converted') ORDER BY (status!='new') DESC, potential DESC, id`, g.v);
      for (const x of rows.slice(1)) { db.run(`UPDATE prospects SET ${col}=NULL, contact_source=COALESCE(contact_source,'') || ' (doublon de #${rows[0].id})' WHERE id=?`, x.id); r.duplicates++; }
    }
  }
  return r;
}

// ---------- Fiabilité des adresses e-mail (gratuit : simple interrogation DNS du domaine) ----------
const NO_MAIL = /^(no-?reply|ne-?pas-?repondre|donotreply|mailer-daemon|postmaster|abuse|webmaster|test|example)@/i;
const BAD_DOMAIN = /(^|\.)(example\.(com|fr|org)|test\.fr|domain\.(com|fr)|email\.com|wixpress\.com|sentry\.io|yopmail\.com|mailinator\.com|guerrillamail\.com|trashmail\.com)$/i;
/**
 * Vérifie que chaque adresse peut recevoir du courrier : format, adresse non automatique, domaine non jetable,
 * et domaine doté d'un serveur de messagerie (enregistrement MX). Résultat gardé : email_ok = 1 (fiable) ou 0 (écartée).
 * Seules les adresses fiables entrent dans une campagne. Un domaine n'est interrogé qu'une fois par passage.
 */
export async function verifyEmails(db, { max = 300, now = Date.now(), resolveMx = null } = {}) {
  const dns = resolveMx ? null : new (await import('node:dns')).promises.Resolver({ timeout: 4000, tries: 2 });
  const mx = resolveMx || ((d) => dns.resolveMx(d));
  const r = { verifiees: 0, fiables: 0, ecartees: 0, raisons: {} }; const cache = new Map();
  const bad = (p, why) => { db.run('UPDATE prospects SET email_ok=0, email_checked_at=? WHERE id=?', now, p.id); r.ecartees++; r.raisons[why] = (r.raisons[why] || 0) + 1; };
  for (const p of db.all("SELECT id, email FROM prospects WHERE email IS NOT NULL AND email!='' AND email_ok IS NULL AND status!='optout' LIMIT ?", max)) {
    r.verifiees++; const e = String(p.email).trim().toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) { bad(p, 'format'); continue; }
    if (NO_MAIL.test(e)) { bad(p, 'adresse automatique'); continue; }
    const domain = e.split('@')[1]; if (BAD_DOMAIN.test(domain)) { bad(p, 'domaine jetable ou fictif'); continue; }
    if (!cache.has(domain)) cache.set(domain, await mx(domain).then((l) => (Array.isArray(l) && l.some((x) => x && x.exchange && x.exchange !== '.') ? 'ok' : 'aucun serveur'), (err) => (/ENOTFOUND|ENODATA|NXDOMAIN/.test(String(err.code)) ? 'domaine sans messagerie' : 'indéterminé')));
    const v = cache.get(domain);
    if (v === 'ok') { db.run('UPDATE prospects SET email=?, email_ok=1, email_checked_at=? WHERE id=?', e, now, p.id); r.fiables++; }
    else if (v === 'indéterminé') { r.raisons['réessai plus tard'] = (r.raisons['réessai plus tard'] || 0) + 1; } // panne DNS : on réessaiera
    else bad(p, v);
  }
  return r;
}
