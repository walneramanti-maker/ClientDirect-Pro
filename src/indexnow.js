// IndexNow (gratuit, sans compte) : signale les pages du site à Bing, Yandex, Seznam… à chaque nouvelle version en ligne.
// Clé générée une fois et gardée dans la base ; fichier de vérification servi à /indexnow-<clé>.txt.
import crypto from 'node:crypto';
import { config } from './config.js';
import { net } from './net.js';

export function indexNowKey(db) {
  let k = db.one("SELECT v FROM meta WHERE k='indexnow_key'")?.v;
  if (!k) { k = crypto.randomBytes(16).toString('hex'); db.run("INSERT OR IGNORE INTO meta(k,v) VALUES('indexnow_key',?)", k); }
  return k;
}
/** Envoie la liste des pages publiques si elle a changé depuis le dernier envoi (production uniquement). */
export async function submitIndexNow(db, urls) {
  if (!config.isProd || !/^https:\/\//.test(config.baseUrl)) return { skipped: 'hors production' };
  const host = new URL(config.baseUrl).host; const key = indexNowKey(db);
  const sig = crypto.createHash('sha256').update(urls.join('\n')).digest('hex').slice(0, 16);
  if (db.one("SELECT v FROM meta WHERE k='indexnow_sig'")?.v === sig) return { skipped: 'liste inchangée' };
  const res = await net.fetch('https://api.indexnow.org/indexnow', { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key, keyLocation: `${config.baseUrl}/indexnow-${key}.txt`, urlList: urls.slice(0, 10000) }) });
  if (res.status === 200 || res.status === 202) { db.run("INSERT INTO meta(k,v) VALUES('indexnow_sig',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", sig); return { ok: true, status: res.status, urls: urls.length }; }
  return { ok: false, status: res.status };
}
