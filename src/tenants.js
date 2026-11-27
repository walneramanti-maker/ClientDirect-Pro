import { ACTIVITIES, activityTemplate } from './activities.js';
import { TEMPLATES } from './templates.js';
import { slugify, randomId, sha256, phoneOk, intlPhone, isTime, toMin, clampStr } from './util.js';
import { isDial } from './phone.js';
import { COUNTRIES, country as countryOf, validTz, PRICES } from './markets.js';
import { LANGS, t as tr } from './i18n.js';
import { templateFor } from './templates.js';
import { config, PLANS } from './config.js';

const RESERVED = new Set(['www', 'app', 'admin', 'api', 'pro', 'static', 'mail', 'support', 'aide', 'demo', 's', 'login', 'inscription']);

export function uniqueSlug(db, name) {
  let base = slugify(name); if (RESERVED.has(base)) base += '-site';
  let s = base, i = 2;
  while (db.one('SELECT 1 FROM tenants WHERE slug=?', s)) s = `${base}-${i++}`;
  return s;
}

/** Crée une entreprise complète (prestations, postes, horaires) à partir d'un modèle de métier. */
export function createTenant(db, { name, tpl, activity = null, activityOther = '', city = '', phone = '', email = '', cc = null, tz = null, country = 'GF', lang = null, currency = null, example = 0, plan = 'pro', status = 'trial', ownerId = null, prospectId = null, address = '', demoToken: forcedToken = null, slug: forcedSlug = null, name2 = null, phoneCc = null }) {
  const C = countryOf(country); const ctry = COUNTRIES[country] ? country : 'OTHER';
  lang = LANGS[lang] ? lang : C.lang; currency = PRICES[currency] ? currency : (PRICES[C.cur] ? C.cur : 'EUR');
  // Indicatif par défaut des clients : celui du pays (pour « Autre pays », celui choisi par le professionnel)
  cc = cc || C.dial || (isDial(phoneCc) ? phoneCc : ''); tz = tz && validTz(tz) ? tz : C.tz;
  // Activité du catalogue ou saisie libre : textes, prestations, horaires adaptés ; sinon modèle historique
  const T = activity ? activityTemplate(activity, activityOther, lang, Object.fromEntries(Object.keys(TEMPLATES).map((k) => [k, templateFor(k, lang)]))) : templateFor(tpl, lang); const now = Date.now();
  if (activity) tpl = ACTIVITIES[T.activity]?.base || (TEMPLATES[tpl] ? tpl : 'artisan');
  const slug = forcedSlug || uniqueSlug(db, name);
  let demoToken = null;
  return db.tx(() => {
    const r = db.run(`INSERT INTO tenants(slug,name,tpl,metier,city,address,phone,email,cc,tz,color,lead,faq,obj_label,verb,plan,status,trial_ends_at,owner_user_id,prospect_id,demo_token_hash,created_at,lang,country,currency,example)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      slug, clampStr(name, 80), tpl in TEMPLATES ? tpl : 'garage', T.metier, clampStr(city, 60), clampStr(address || (city ? `${city}` : ''), 160), phone ? intlPhone(phone, isDial(phoneCc) ? phoneCc : cc) : '', clampStr(email, 190),
      String(cc).replace(/\D/g, '').slice(0, 4), tz, T.color, T.lead, T.faq, T.obj, T.verb,
      plan in PLANS ? plan : 'pro', status, status === 'trial' ? now + config.trialDays * 864e5 : null, ownerId, prospectId,
      status === 'demo' && (forcedToken || !forcedSlug) ? sha256(demoToken = forcedToken || randomId(18)) : null, now, lang, ctry, currency, example ? 1 : 0);
    const id = Number(r.lastInsertRowid);
    db.run('UPDATE tenants SET activity=?, activity_other=?, prices_confirmed=? WHERE id=?', activity ? T.activity : null, activity === 'autre' ? clampStr(activityOther, 60) : null, status === 'demo' || example ? 1 : 0, id);
    T.services.forEach((s, i) => db.run('INSERT INTO services(tenant_id,name,price,dur,descr,pos) VALUES(?,?,?,?,?,?)', id, s[0], s[1], s[2], s[3], i));
    T.staff.forEach((n) => db.run('INSERT INTO staff(tenant_id,name) VALUES(?,?)', id, n));
    for (const [d, h] of Object.entries(T.hours)) if (h) db.run('INSERT INTO hours(tenant_id,dow,open,close) VALUES(?,?,?,?)', id, Number(d), h[0], h[1]);
    if (ownerId) db.run('INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,?)', ownerId, id, 'owner');
    return { id, slug, demoToken };
  });
}

export function loadTenant(db, where, value) {
  const t = db.one(`SELECT * FROM tenants WHERE ${where === 'slug' ? 'slug' : 'id'}=?`, value);
  if (!t) return null;
  t.services = db.all('SELECT * FROM services WHERE tenant_id=? AND active=1 ORDER BY pos, id', t.id);
  t.staff = db.all('SELECT * FROM staff WHERE tenant_id=? AND active=1 ORDER BY id', t.id);
  t.hours = {}; for (const h of db.all('SELECT * FROM hours WHERE tenant_id=?', t.id)) t.hours[h.dow] = [h.open, h.close];
  return t;
}

/** Le site est-il visible du public ? */
export function siteState(t, now = Date.now()) {
  if (t.status === 'active') return 'live';
  if (t.status === 'trial') return t.trial_ends_at > now ? 'live' : 'expired';
  if (t.status === 'past_due') return (t.current_period_end || 0) + config.graceDays * 864e5 > now ? 'live' : 'expired';
  if (t.status === 'demo') return 'demo';
  return 'paused';
}

/** Vérifie et applique les réglages envoyés par le professionnel. Renvoie la liste des erreurs. */
export function updateSettings(db, tenantId, f) {
  const errors = [];
  const name = clampStr(f.name, 80); if (!name) errors.push(tr("Le nom de l'entreprise est obligatoire."));
  const ctry = COUNTRIES[f.country] ? f.country : null; if (!ctry) errors.push(tr('Pays inconnu.'));
  // Indicatif du numéro WhatsApp : choisi par le professionnel ; à défaut celui du pays
  const phoneCc = isDial(f.phone_cc) ? String(f.phone_cc) : (ctry ? COUNTRIES[ctry].dial : '');
  const cc = ctry ? (COUNTRIES[ctry].dial || (isDial(f.cc) ? String(f.cc) : phoneCc)) : null; if (ctry && !cc) errors.push(tr('Indicatif pays manquant.'));
  // Numéro inchangé : conservé tel quel (un numéro déjà enregistré n'est jamais réécrit sans action du professionnel)
  const prev = db.one('SELECT phone FROM tenants WHERE id=?', tenantId)?.phone || '';
  const same = f.phone && String(f.phone).replace(/\D/g, '') === prev && /^\s*\+/.test(f.phone);
  const tz = validTz(f.tz) ? f.tz : null; if (!tz) errors.push(tr('Fuseau horaire inconnu.'));
  const currency = PRICES[f.currency] ? f.currency : null; if (!currency) errors.push(tr('Devise inconnue.'));
  const lang = LANGS[f.lang] ? f.lang : null; if (!lang) errors.push(tr('Langue inconnue.'));
  if (f.phone && !same && !phoneOk(f.phone, phoneCc || cc)) errors.push(tr('Numéro WhatsApp invalide.'));
  const color = /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#ffcf33';
  const services = [];
  for (let i = 0; i < 40; i++) {
    if (f[`svc_name_${i}`] === undefined) continue;
    const n = clampStr(f[`svc_name_${i}`], 80); if (!n) continue;
    const price = Number(String(f[`svc_price_${i}`]).replace(',', '.')); const dur = Number(f[`svc_dur_${i}`]);
    if (!(price >= 0 && price < 100000)) { errors.push(tr('Prix invalide pour « {n} ».', { n })); continue; }
    if (!(Number.isInteger(dur) && dur >= 15 && dur <= 600 && dur % 15 === 0)) { errors.push(tr('Durée invalide pour « {n} » (multiple de 15 min).', { n })); continue; }
    services.push({ id: Number(f[`svc_id_${i}`]) || null, name: n, price, dur, descr: clampStr(f[`svc_desc_${i}`], 200) });
  }
  if (!services.length) errors.push(tr('Il faut au moins une prestation.'));
  const staff = [];
  for (let i = 0; i < 30; i++) { if (f[`staff_name_${i}`] === undefined) continue; const n = clampStr(f[`staff_name_${i}`], 60); if (n) staff.push({ id: Number(f[`staff_id_${i}`]) || null, name: n }); }
  if (!staff.length) errors.push(tr('Il faut au moins un poste ou un employé.'));
  const hours = {};
  for (let d = 0; d < 7; d++) {
    if (f[`open_${d}`] !== 'on') continue;
    const o = f[`from_${d}`], c = f[`to_${d}`];
    if (!isTime(o) || !isTime(c) || toMin(c) <= toMin(o)) { errors.push(tr('Horaires invalides le jour {d}.', { d })); continue; }
    hours[d] = [o, c];
  }
  if (errors.length) return errors;
  db.tx(() => {
    db.run('UPDATE tenants SET name=?,phone=?,cc=?,tz=?,country=?,currency=?,lang=?,color=?,address=?,city=?,lead=?,faq=?,auto_confirm=?,updated_at=? WHERE id=?',
      name, !f.phone ? '' : same ? prev : intlPhone(f.phone, phoneCc || cc), cc, tz, ctry, currency, lang, color, clampStr(f.address, 160), clampStr(f.city, 60), clampStr(f.lead, 400), clampStr(f.faq, 1500), f.auto_confirm === 'on' ? 1 : 0, Date.now(), tenantId);
    const keepS = []; services.forEach((s, i) => {
      if (s.id && db.one('SELECT 1 FROM services WHERE id=? AND tenant_id=?', s.id, tenantId)) { db.run('UPDATE services SET name=?,price=?,dur=?,descr=?,pos=?,active=1 WHERE id=? AND tenant_id=?', s.name, s.price, s.dur, s.descr, i, s.id, tenantId); keepS.push(s.id); }
      else keepS.push(Number(db.run('INSERT INTO services(tenant_id,name,price,dur,descr,pos) VALUES(?,?,?,?,?,?)', tenantId, s.name, s.price, s.dur, s.descr, i).lastInsertRowid));
    });
    db.run(`UPDATE services SET active=0 WHERE tenant_id=? AND id NOT IN (${keepS.map(() => '?').join(',')})`, tenantId, ...keepS);
    const keepT = []; staff.forEach((s) => {
      if (s.id && db.one('SELECT 1 FROM staff WHERE id=? AND tenant_id=?', s.id, tenantId)) { db.run('UPDATE staff SET name=?,active=1 WHERE id=? AND tenant_id=?', s.name, s.id, tenantId); keepT.push(s.id); }
      else keepT.push(Number(db.run('INSERT INTO staff(tenant_id,name) VALUES(?,?)', tenantId, s.name).lastInsertRowid));
    });
    db.run(`UPDATE staff SET active=0 WHERE tenant_id=? AND id NOT IN (${keepT.map(() => '?').join(',')})`, tenantId, ...keepT);
    db.run('DELETE FROM hours WHERE tenant_id=?', tenantId);
    for (const [d, h] of Object.entries(hours)) db.run('INSERT INTO hours(tenant_id,dow,open,close) VALUES(?,?,?,?)', tenantId, Number(d), h[0], h[1]);
    // Le professionnel a relu et enregistré ses prestations : ses tarifs peuvent désormais être publiés
    db.run('UPDATE tenants SET prices_confirmed=1 WHERE id=?', tenantId);
  });
  return [];
}

export const userTenants = (db, userId) => db.all('SELECT t.id,t.slug,t.name,t.status,t.plan FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=? ORDER BY t.id', userId);
export const canAccessTenant = (db, userId, tenantId) => !!db.one('SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?', userId, tenantId);
