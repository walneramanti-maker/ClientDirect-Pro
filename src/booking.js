import crypto from 'node:crypto';
import { nowIn, addDays, dowOf, toMin, fromMin, isDate, isTime, phoneOk, intlPhone, emailOk, clampStr, zonedToUtc, randomId, sha256, safeEq, dlabel, hfr } from './util.js';
import { isDial } from './phone.js';
import { planHas, config } from './config.js';
import { t as tr, fmtDay, fmtTime } from './i18n.js';
import { track } from './stats.js';

export const STEP = 30;
const LEAD_MIN = 60; // délai minimum avant un rendez-vous (minutes)

const busyFor = (db, tenantId, date) => db.all("SELECT staff_id, start_min, dur FROM appointments WHERE tenant_id=? AND date=? AND status IN ('pending','confirmed')", tenantId, date);

function freeStaff(t, busy, start, dur) {
  return t.staff.find((s) => !busy.some((b) => b.staff_id === s.id && start < b.start_min + b.dur && start + dur > b.start_min)) || null;
}

/** Horizon maximal de réservation en ligne. */
export const MAX_AHEAD_DAYS = 180;

/** Heures de début libres pour une prestation, un jour donné, à l'heure locale de l'entreprise. */
export function freeSlots(db, t, date, serviceId) {
  if (!isDate(date)) return [];
  const svc = t.services.find((s) => s.id === Number(serviceId)); if (!svc) return [];
  const h = t.hours[dowOf(date)]; if (!h) return [];
  const now = nowIn(t.tz); if (date < now.date || date > addDays(now.date, MAX_AHEAD_DAYS)) return [];
  const busy = busyFor(db, t.id, date); const out = [];
  for (let m = toMin(h[0]); m + svc.dur <= toMin(h[1]); m += STEP) {
    if (date === now.date && m < now.min + LEAD_MIN) continue;
    if (freeStaff(t, busy, m, svc.dur)) out.push(fromMin(m));
  }
  return out;
}

export function openDays(db, t, n = 10, serviceId = null) {
  const start = nowIn(t.tz).date; const out = [];
  for (let k = 0; k < 60 && out.length < n; k++) {
    const d = addDays(start, k); if (!t.hours[dowOf(d)]) continue;
    if (serviceId && k === 0 && !freeSlots(db, t, d, serviceId).length) continue;
    out.push(d);
  }
  return out;
}

/**
 * Réserve un créneau. La vérification et l'enregistrement se font dans une transaction exclusive :
 * deux demandes simultanées ne peuvent pas obtenir le même poste au même moment.
 */
export function book(db, t, { date, time, serviceId, name, phone, cc = '', email = '', source = 'site' }) {
  const pcc = isDial(cc) ? String(cc) : t.cc; // indicatif choisi par le client, sinon celui du professionnel
  if (!planHas(t.plan, 'rdv')) return { ok: false, code: 'plan', msg: tr("La prise de rendez-vous en ligne n'est pas incluse dans cette formule.") };
  name = clampStr(name, 80); email = clampStr(email, 190);
  if (!name) return { ok: false, code: 'name', msg: tr('Indiquez votre nom.') };
  if (!phoneOk(phone, pcc)) return { ok: false, code: 'phone', msg: tr('Numéro de téléphone invalide.') };
  if (email && !emailOk(email)) return { ok: false, code: 'email', msg: tr('Adresse e-mail invalide.') };
  if (!isDate(date) || !isTime(time)) return { ok: false, code: 'slot', msg: tr('Date ou heure invalide.') };
  const svc = t.services.find((s) => s.id === Number(serviceId)); if (!svc) return { ok: false, code: 'service', msg: tr('Prestation inconnue.') };
  const h = t.hours[dowOf(date)]; const start = toMin(time);
  if (!h || start < toMin(h[0]) || start + svc.dur > toMin(h[1]) || (start - toMin(h[0])) % STEP) return { ok: false, code: 'hours', msg: tr("En dehors des horaires d'ouverture.") };
  const now = nowIn(t.tz); if (date < now.date || (date === now.date && start < now.min + LEAD_MIN)) return { ok: false, code: 'past', msg: tr('Ce créneau est déjà passé.') };
  if (date > addDays(now.date, MAX_AHEAD_DAYS)) return { ok: false, code: 'far', msg: tr('Les réservations sont ouvertes jusqu’à {n} jours à l’avance.', { n: MAX_AHEAD_DAYS }) };
  const cancelToken = randomId(18);
  const res = db.tx(() => {
    const stf = freeStaff(t, busyFor(db, t.id, date), start, svc.dur);
    if (!stf) return null;
    const status = t.auto_confirm ? 'confirmed' : 'pending';
    const r = db.run(`INSERT INTO appointments(tenant_id,service_id,service_name,price,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,source,starts_at,cancel_token_hash,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t.id, svc.id, svc.name, svc.price, date, time, start, svc.dur, stf.id, stf.name, name, intlPhone(phone, pcc), email, status, source, zonedToUtc(date, time, t.tz), sha256(cancelToken), Date.now());
    return { id: Number(r.lastInsertRowid), status, staff: stf.name };
  });
  if (!res) return { ok: false, code: 'taken', msg: tr('Ce créneau vient d’être pris. Choisissez une autre heure.') };
  track(db, t, 'bookings');
  const when = `${fmtDay(date)} · ${fmtTime(time)}`;
  return { ok: true, ...res, cancelToken, msg: res.status === 'confirmed' ? tr('Rendez-vous confirmé le {w} ({s}).', { w: when, s: svc.name }) : tr('Demande de rendez-vous enregistrée pour le {w} ({s}). {n} vous la confirme.', { w: when, s: svc.name, n: t.name }) };
}

export function createQuote(db, t, { name, phone, cc = '', email = '', obj = '', service = '', message = '' }) {
  const pcc = isDial(cc) ? String(cc) : t.cc;
  name = clampStr(name, 80);
  if (!name) return { ok: false, msg: tr('Indiquez votre nom.') };
  if (!phoneOk(phone, pcc)) return { ok: false, msg: tr('Numéro de téléphone invalide.') };
  if (email && !emailOk(email)) return { ok: false, msg: tr('Adresse e-mail invalide.') };
  const r = db.run('INSERT INTO quotes(tenant_id,customer_name,customer_phone,customer_email,obj,service,message,created_at) VALUES(?,?,?,?,?,?,?,?)',
    t.id, name, intlPhone(phone, pcc), clampStr(email, 190), clampStr(obj, 160), clampStr(service, 80), clampStr(message, 2000), Date.now());
  track(db, t, 'quotes');
  return { ok: true, id: Number(r.lastInsertRowid) };
}

const TRANSITIONS = { pending: ['confirmed', 'refused', 'canceled'], confirmed: ['done', 'canceled'], done: [], refused: [], canceled: [] };
/** Change le statut d'un rendez-vous de l'entreprise (jamais d'une autre). */
export function setAppointmentStatus(db, tenantId, id, status) {
  const a = db.one('SELECT * FROM appointments WHERE id=? AND tenant_id=?', id, tenantId);
  if (!a) return { ok: false, msg: tr('Rendez-vous introuvable.') };
  if (!TRANSITIONS[a.status].includes(status)) return { ok: false, msg: tr('Changement de statut impossible.') };
  db.run('UPDATE appointments SET status=? WHERE id=? AND tenant_id=?', status, id, tenantId);
  return { ok: true, appt: { ...a, status } };
}
/** Lien d'annulation stable d'un rendez-vous (signé), utilisable dans la confirmation du professionnel et dans le rappel. */
export const apptCancelToken = (id) => `a${id}-${crypto.createHmac('sha256', config.secret).update(`annulation:${id}`).digest('hex').slice(0, 24)}`;
export function cancelByCustomer(db, token) {
  const m = /^a(\d+)-[0-9a-f]{24}$/.exec(String(token || ''));
  const a = m && safeEq(String(token), apptCancelToken(Number(m[1])))
    ? db.one("SELECT * FROM appointments WHERE id=? AND status IN ('pending','confirmed')", Number(m[1]))
    : db.one("SELECT * FROM appointments WHERE cancel_token_hash=? AND status IN ('pending','confirmed')", sha256(token || ''));
  if (!a) return { ok: false };
  if (a.starts_at < Date.now() + 2 * 36e5) return { ok: false, late: true, appt: a };
  db.run("UPDATE appointments SET status='canceled' WHERE id=?", a.id);
  return { ok: true, appt: a };
}
