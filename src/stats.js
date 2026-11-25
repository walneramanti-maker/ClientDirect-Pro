// Statistiques par entreprise, sans cookie ni donnée personnelle : de simples compteurs par jour.
import { nowIn, addDays } from './util.js';

const FIELDS = new Set(['views', 'bookings', 'quotes', 'chats', 'wa_clicks']);
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|headless|lighthouse|curl|wget|python|node-fetch|undici/i;
export const isBot = (ua) => !ua || BOT.test(ua);

export function track(db, t, field, n = 1) {
  if (!FIELDS.has(field)) return;
  const day = nowIn(t.tz).date;
  db.run(`INSERT INTO stats_daily(tenant_id, day, ${field}) VALUES(?,?,?) ON CONFLICT(tenant_id, day) DO UPDATE SET ${field}=${field}+excluded.${field}`, t.id, day, n);
}
/** Totaux sur une période [from, to] (dates locales AAAA-MM-JJ), plus le chiffre d'affaires des rendez-vous confirmés. */
export function summary(db, t, from, to) {
  const s = db.one('SELECT COALESCE(SUM(views),0) views, COALESCE(SUM(bookings),0) bookings, COALESCE(SUM(quotes),0) quotes, COALESCE(SUM(chats),0) chats, COALESCE(SUM(wa_clicks),0) wa_clicks FROM stats_daily WHERE tenant_id=? AND day BETWEEN ? AND ?', t.id, from, to);
  const appt = db.one("SELECT COUNT(*) n, COALESCE(SUM(price),0) value FROM appointments WHERE tenant_id=? AND status IN ('confirmed','done') AND date BETWEEN ? AND ?", t.id, from, to);
  const requests = s.bookings + s.quotes + s.wa_clicks;
  return { ...s, requests, confirmed: appt.n, value: appt.value, conversion: s.views ? Math.round((requests / s.views) * 1000) / 10 : 0 };
}
export function last30(db, t) { const to = nowIn(t.tz).date; return { from: addDays(to, -29), to, ...summary(db, t, addDays(to, -29), to) }; }
/** Courbe jour par jour (pour le graphique de l'espace pro). */
export function daily(db, t, days = 30) {
  const to = nowIn(t.tz).date; const from = addDays(to, -(days - 1));
  const rows = new Map(db.all('SELECT * FROM stats_daily WHERE tenant_id=? AND day BETWEEN ? AND ?', t.id, from, to).map((r) => [r.day, r]));
  return Array.from({ length: days }, (_, i) => { const d = addDays(from, i); const r = rows.get(d) || {}; return { day: d, views: r.views || 0, requests: (r.bookings || 0) + (r.quotes || 0) + (r.wa_clicks || 0) }; });
}
/** Bilan du mois précédent : chiffres envoyés automatiquement au professionnel le 1er du mois. */
export function previousMonth(db, t, now = new Date()) {
  const local = nowIn(t.tz, now).date; const first = local.slice(0, 8) + '01';
  const to = addDays(first, -1); const from = to.slice(0, 8) + '01';
  return { month: from.slice(0, 7), ...summary(db, t, from, to) };
}
