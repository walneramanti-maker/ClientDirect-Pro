import { TEMPLATES } from './templates.js';
import { slugify, randomId, sha256, phoneOk, intlPhone, isTime, toMin, clampStr, TIMEZONES, COUNTRY_CODES } from './util.js';
import { config, PLANS } from './config.js';

const RESERVED = new Set(['www', 'app', 'admin', 'api', 'pro', 'static', 'mail', 'support', 'aide', 'demo', 's', 'login', 'inscription']);

export function uniqueSlug(db, name) {
  let base = slugify(name); if (RESERVED.has(base)) base += '-site';
  let s = base, i = 2;
  while (db.one('SELECT 1 FROM tenants WHERE slug=?', s)) s = `${base}-${i++}`;
  return s;
}

/** Crée une entreprise complète (prestations, postes, horaires) à partir d'un modèle de métier. */
export function createTenant(db, { name, tpl, city = '', phone = '', email = '', cc = '594', tz = 'America/Cayenne', plan = 'pro', status = 'trial', ownerId = null, prospectId = null, address = '' }) {
  const T = TEMPLATES[tpl] || TEMPLATES.garage; const now = Date.now();
  const slug = uniqueSlug(db, name);
  let demoToken = null;
  return db.tx(() => {
    const r = db.run(`INSERT INTO tenants(slug,name,tpl,metier,city,address,phone,email,cc,tz,color,lead,faq,obj_label,verb,plan,status,trial_ends_at,owner_user_id,prospect_id,demo_token_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      slug, clampStr(name, 80), tpl in TEMPLATES ? tpl : 'garage', T.metier, clampStr(city, 60), clampStr(address || (city ? `${city}` : ''), 160), phone ? intlPhone(phone, cc) : '', clampStr(email, 190),
      cc in COUNTRY_CODES ? cc : '594', tz in TIMEZONES ? tz : 'America/Cayenne', T.color, T.lead, T.faq, T.obj, T.verb,
      plan in PLANS ? plan : 'pro', status, status === 'trial' ? now + config.trialDays * 864e5 : null, ownerId, prospectId,
      status === 'demo' ? sha256(demoToken = randomId(18)) : null, now);
    const id = Number(r.lastInsertRowid);
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
  const name = clampStr(f.name, 80); if (!name) errors.push("Le nom de l'entreprise est obligatoire.");
  const cc = COUNTRY_CODES[f.cc] ? f.cc : null; if (!cc) errors.push('Indicatif pays inconnu.');
  const tz = TIMEZONES[f.tz] ? f.tz : null; if (!tz) errors.push('Fuseau horaire inconnu.');
  if (f.phone && !phoneOk(f.phone, cc || '594')) errors.push('Numéro WhatsApp invalide.');
  const color = /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#ffcf33';
  const services = [];
  for (let i = 0; i < 40; i++) {
    if (f[`svc_name_${i}`] === undefined) continue;
    const n = clampStr(f[`svc_name_${i}`], 80); if (!n) continue;
    const price = Number(String(f[`svc_price_${i}`]).replace(',', '.')); const dur = Number(f[`svc_dur_${i}`]);
    if (!(price >= 0 && price < 100000)) { errors.push(`Prix invalide pour « ${n} ».`); continue; }
    if (!(Number.isInteger(dur) && dur >= 15 && dur <= 600 && dur % 15 === 0)) { errors.push(`Durée invalide pour « ${n} » (multiple de 15 min).`); continue; }
    services.push({ id: Number(f[`svc_id_${i}`]) || null, name: n, price, dur, descr: clampStr(f[`svc_desc_${i}`], 200) });
  }
  if (!services.length) errors.push('Il faut au moins une prestation.');
  const staff = [];
  for (let i = 0; i < 30; i++) { if (f[`staff_name_${i}`] === undefined) continue; const n = clampStr(f[`staff_name_${i}`], 60); if (n) staff.push({ id: Number(f[`staff_id_${i}`]) || null, name: n }); }
  if (!staff.length) errors.push('Il faut au moins un poste ou un employé.');
  const hours = {};
  for (let d = 0; d < 7; d++) {
    if (f[`open_${d}`] !== 'on') continue;
    const o = f[`from_${d}`], c = f[`to_${d}`];
    if (!isTime(o) || !isTime(c) || toMin(c) <= toMin(o)) { errors.push(`Horaires invalides le jour ${d}.`); continue; }
    hours[d] = [o, c];
  }
  if (errors.length) return errors;
  db.tx(() => {
    db.run('UPDATE tenants SET name=?,phone=?,cc=?,tz=?,color=?,address=?,city=?,lead=?,faq=?,auto_confirm=?,updated_at=? WHERE id=?',
      name, f.phone ? intlPhone(f.phone, cc) : '', cc, tz, color, clampStr(f.address, 160), clampStr(f.city, 60), clampStr(f.lead, 400), clampStr(f.faq, 1500), f.auto_confirm === 'on' ? 1 : 0, Date.now(), tenantId);
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
  });
  return [];
}

export const userTenants = (db, userId) => db.all('SELECT t.id,t.slug,t.name,t.status,t.plan FROM tenants t JOIN memberships m ON m.tenant_id=t.id WHERE m.user_id=? ORDER BY t.id', userId);
export const canAccessTenant = (db, userId, tenantId) => !!db.one('SELECT 1 FROM memberships WHERE user_id=? AND tenant_id=?', userId, tenantId);
