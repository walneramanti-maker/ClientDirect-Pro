import crypto from 'node:crypto';

export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const pad = (n) => String(n).padStart(2, '0');
export const toMin = (h) => { const [a, b] = String(h || '0:0').split(':').map(Number); return a * 60 + (b || 0); };
export const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const hfr = (h) => { const [a, b] = String(h).split(':'); return `${Number(a)}h${b === '00' ? '' : b}`; };
export const DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
export const DAYS_SHORT = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
export const dowOf = (d) => new Date(d + 'T12:00:00Z').getUTCDay();
export const addDays = (d, k) => { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + k); return x.toISOString().slice(0, 10); };
export const dlabel = (d) => { const x = new Date(d + 'T12:00:00Z'); return `${DAYS_SHORT[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
export const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s));

export const TIMEZONES = {
  'America/Cayenne': 'Guyane', 'America/Martinique': 'Martinique', 'America/Guadeloupe': 'Guadeloupe',
  'Indian/Reunion': 'La Réunion', 'Indian/Mayotte': 'Mayotte', 'Europe/Paris': 'France métropolitaine'
};
export const COUNTRY_CODES = { '594': 'Guyane', '596': 'Martinique', '590': 'Guadeloupe', '262': 'La Réunion / Mayotte', '33': 'France métropolitaine', '597': 'Suriname', '55': 'Brésil' };

/** Date et minute locales d'un fuseau horaire IANA. */
export function nowIn(tz, at = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Cayenne', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = {}; for (const p of f.formatToParts(at)) o[p.type] = p.value;
  const date = `${o.year}-${o.month}-${o.day}`;
  return { date, min: Number(o.hour) * 60 + Number(o.minute), dow: dowOf(date) };
}
/** Instant UTC (ms) correspondant à une date + heure locales dans un fuseau. */
export function zonedToUtc(date, time, tz) {
  const guess = Date.parse(`${date}T${time}:00Z`);
  const offset = (ms) => { const n = nowIn(tz, new Date(ms)); return Date.parse(`${n.date}T${fromMin(n.min)}:00Z`) - ms; };
  const o1 = offset(guess); const o2 = offset(guess - o1);
  return guess - o2;
}

/** Numéro au format international, chiffres seuls (E.164 sans +). */
export function intlPhone(raw, cc = '594') {
  const s = String(raw || '').trim(); const d = s.replace(/\D/g, '');
  if (!d) return '';
  if (s.startsWith('+')) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (d.startsWith('0')) return String(cc) + d.slice(1);
  return d;
}
export const phoneOk = (raw, cc) => { const n = intlPhone(raw, cc); return n.length >= 8 && n.length <= 15; };
export const phoneFmt = (n) => { n = String(n || ''); if (n.length < 10) return n ? '+' + n : ''; return '+' + n.slice(0, n.length - 9) + ' ' + n.slice(-9).replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4'); };
export const emailOk = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i.test(String(e || ''));

export const slugify = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'site';
export const randomId = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hmac = (key, s) => crypto.createHmac('sha256', key).update(String(s)).digest('hex');
export const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
export const clampStr = (s, n = 200) => String(s ?? '').trim().slice(0, n);
export const euros = (n) => `${Math.round(Number(n) * 100) / 100} €`.replace('.', ',');
export const nowMs = () => Date.now();
