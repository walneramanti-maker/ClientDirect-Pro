import crypto from 'node:crypto';
import { randomId, sha256, safeEq } from './util.js';

// ---------- mots de passe (scrypt, sel unique) ----------
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[2], 'base64'); const want = Buffer.from(parts[3], 'base64');
  const got = crypto.scryptSync(String(pw), salt, want.length, { N: Number(parts[1]), r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(got, want);
}
export const passwordProblem = (pw) => {
  pw = String(pw || '');
  if (pw.length < 10) return 'Le mot de passe doit faire au moins 10 caractères.';
  if (!/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) return 'Le mot de passe doit contenir des lettres et des chiffres.';
  return null;
};

// ---------- sessions ----------
const SESSION_DAYS = 30;
export function createSession(db, userId) {
  const token = randomId(32); const csrf = randomId(24); const now = Date.now();
  db.run('INSERT INTO sessions(id_hash,user_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)', sha256(token), userId, csrf, now, now + SESSION_DAYS * 864e5);
  return { token, csrf };
}
export function readSession(db, token) {
  if (!token) return null;
  const s = db.one('SELECT s.*, u.email, u.name, u.role, u.email_verified, u.totp_secret, u.lang FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=?', sha256(token));
  if (!s || s.expires_at < Date.now()) return null;
  return s;
}
export const destroySession = (db, token) => token && db.run('DELETE FROM sessions WHERE id_hash=?', sha256(token));
export const destroyUserSessions = (db, userId) => db.run('DELETE FROM sessions WHERE user_id=?', userId);
export const csrfOk = (session, sent) => !!session && !!sent && safeEq(session.csrf, sent);

// ---------- jetons à usage unique (vérification e-mail, mot de passe, revendication de démo) ----------
export function issueToken(db, type, { userId = null, tenantId = null, hours = 48 } = {}) {
  const t = randomId(24);
  db.run('INSERT INTO tokens(id_hash,type,user_id,tenant_id,expires_at) VALUES(?,?,?,?,?)', sha256(t), type, userId, tenantId, Date.now() + hours * 36e5);
  return t;
}
export function useToken(db, type, t, { consume = true } = {}) {
  if (!t) return null;
  const row = db.one('SELECT * FROM tokens WHERE id_hash=? AND type=?', sha256(t), type);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  if (consume) db.run('UPDATE tokens SET used_at=? WHERE id_hash=?', Date.now(), row.id_hash);
  return row;
}

// ---------- double authentification TOTP (RFC 6238, compatible Google Authenticator) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function unbase32(s) { let bits = 0, val = 0; const out = []; for (const c of String(s).replace(/=+$/, '').toUpperCase()) { const i = B32.indexOf(c); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
export const newTotpSecret = () => base32(crypto.randomBytes(20));
export function totpCode(secret, at = Date.now(), step = 30) {
  const counter = Math.floor(at / 1000 / step); const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(buf).digest(); const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
export function totpOk(secret, code, at = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code))) return false;
  return [-1, 0, 1].some((w) => safeEq(totpCode(secret, at + w * 30000), code));
}

// ---------- limitation de débit (mémoire du processus) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now(); let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset < now) buckets.delete(k);
  return b.n <= max;
}
export const resetRateLimits = () => buckets.clear();

// ---------- connexion avec verrouillage après échecs ----------
export function login(db, email, password) {
  const u = db.one('SELECT * FROM users WHERE email=?', String(email || '').trim());
  if (!u) { verifyPassword(password, 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '=='); return { ok: false }; }
  if (u.locked_until > Date.now()) return { ok: false, locked: true };
  if (!verifyPassword(password, u.pass_hash)) {
    const fails = u.failed_logins + 1;
    db.run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', fails, fails >= 8 ? Date.now() + 15 * 60e3 : 0, u.id);
    return { ok: false };
  }
  db.run('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?', u.id);
  return { ok: true, user: u };
}

export const audit = (db, { userId = null, tenantId = null, action, detail = '', ip = '' }) =>
  db.run('INSERT INTO audit(user_id,tenant_id,action,detail,ip,created_at) VALUES(?,?,?,?,?,?)', userId, tenantId, action, String(detail).slice(0, 500), ip, Date.now());
