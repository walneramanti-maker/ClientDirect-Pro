import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export function parseCookies(h = '') {
  const out = {}; for (const p of String(h).split(';')) { const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(); try { out[k] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* ignore */ } } } return out;
}
export function cookie(name, value, { maxAge = null, httpOnly = true } = {}) {
  const secure = config.baseUrl.startsWith('https://');
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure ? '; Secure' : ''}${maxAge !== null ? `; Max-Age=${maxAge}` : ''}`;
}
export function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('Corps trop volumineux'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}
export function parseForm(raw, type = '') {
  if (type.includes('application/json')) { try { const j = JSON.parse(raw || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } }
  const out = {}; for (const [k, v] of new URLSearchParams(raw)) out[k] = v; return out;
}
export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Opener-Policy': 'same-origin'
};
export function send(res, status, body, headers = {}) {
  const h = { ...SECURITY_HEADERS, ...headers };
  if (!config.isProd) h['X-Robots-Tag'] = 'noindex, nofollow';
  if (config.baseUrl.startsWith('https://')) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  res.writeHead(status, h); res.end(body);
}
export const html = (res, body, status = 200, headers = {}) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
export const json = (res, obj, status = 200, headers = {}) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
export const redirect = (res, to, headers = {}) => send(res, 303, '', { Location: to, ...headers });

const PUB = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4', '.ico': 'image/x-icon' };
export function serveStatic(res, rel, req = null) {
  const file = path.resolve(PUB, rel.replace(/^\/+/, ''));
  if (!file.startsWith(PUB + path.sep)) return false;
  let stat; try { stat = fs.statSync(file); if (!stat.isFile()) return false; } catch { return false; }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const range = req?.headers?.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  // Lecture partielle (obligatoire pour les vidéos sur iPhone / Safari)
  if (range) {
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]); let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : stat.size - 1;
    if (!(start >= 0 && start <= end && end < stat.size)) { send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` }); return true; }
    const fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(end - start + 1); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd);
    send(res, 206, buf, { 'Content-Type': type, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600' });
  return true;
}
