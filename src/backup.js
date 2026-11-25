// Sauvegardes automatiques : copie cohérente de la base, compressée, chiffrée (AES-256-GCM),
// envoyée vers Supabase Storage (hors du serveur) ou, à défaut, dans un dossier local. Restauration vérifiée.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { net } from './net.js';
import { recordIncident } from './incidents.js';

const MAGIC = Buffer.from('CDPB1');
const keyOf = (secret) => crypto.createHash('sha256').update(String(secret)).digest();
export const remoteConfigured = () => !!(config.supabaseUrl && config.supabaseServiceKey);

export function encrypt(buf, secret) {
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', keyOf(secret), iv);
  const body = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}
export function decrypt(buf, secret) {
  if (!buf.subarray(0, 5).equals(MAGIC)) throw new Error('Fichier de sauvegarde non reconnu');
  const iv = buf.subarray(5, 17), tag = buf.subarray(17, 33);
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(secret), iv); d.setAuthTag(tag);
  try { return Buffer.concat([d.update(buf.subarray(33)), d.final()]); } catch { throw new Error('Clé de sauvegarde incorrecte ou fichier altéré'); }
}
const secretOf = () => config.backupKey || config.secret;
const localDir = (dbFile) => path.join(path.dirname(path.resolve(dbFile)), 'backups', config.appEnv);
const storage = (p, opt = {}) => net.fetch(`${config.supabaseUrl}/storage/v1/${p}`, { ...opt, headers: { authorization: `Bearer ${config.supabaseServiceKey}`, apikey: config.supabaseServiceKey, ...(opt.headers || {}) } });

async function put(name, data, dbFile) {
  if (!remoteConfigured()) { const f = path.join(localDir(dbFile), name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return; }
  const r = await storage(`object/${config.backupBucket}/${config.appEnv}/${name}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, body: data });
  if (!r.ok) throw new Error(`Supabase Storage ${r.status}: ${(await r.text()).slice(0, 160)}`);
}
export async function list(dbFile) {
  if (!remoteConfigured()) { const d = localDir(dbFile); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.enc')).sort().reverse() : []; }
  const r = await storage(`object/list/${config.backupBucket}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefix: `${config.appEnv}/`, limit: 1000, sortBy: { column: 'name', order: 'desc' } }) });
  if (!r.ok) throw new Error(`Supabase Storage ${r.status}`);
  return (await r.json()).map((o) => o.name).filter((n) => n.endsWith('.enc')).sort().reverse();
}
async function get(name, dbFile) {
  if (!remoteConfigured()) return fs.readFileSync(path.join(localDir(dbFile), name));
  const r = await storage(`object/${config.backupBucket}/${config.appEnv}/${name}`);
  if (!r.ok) throw new Error(`Supabase Storage ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
async function remove(names, dbFile) {
  if (!names.length) return;
  if (!remoteConfigured()) { for (const n of names) fs.rmSync(path.join(localDir(dbFile), n), { force: true }); return; }
  await storage(`object/${config.backupBucket}`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: names.map((n) => `${config.appEnv}/${n}`) }) });
}

/** Crée une sauvegarde complète. Renvoie { name, bytes }. */
export async function createBackup(db, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `cdp-${stamp}.db.gz.enc`;
  const tmp = path.join(path.dirname(path.resolve(db.file)), `.backup-${process.pid}-${Date.now()}.db`);
  try {
    db.raw.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`); // copie cohérente, même pendant l'utilisation
    const data = encrypt(zlib.gzipSync(fs.readFileSync(tmp), { level: 9 }), secretOf());
    await put(name, data, db.file);
    db.run("INSERT INTO backups(name,bytes,sha256,status,created_at) VALUES(?,?,?,'ok',?)", name, data.length, crypto.createHash('sha256').update(data).digest('hex'), Date.now());
    const all = await list(db.file); await remove(all.slice(config.backupKeep), db.file);
    return { name, bytes: data.length };
  } catch (e) {
    db.run("INSERT INTO backups(name,bytes,sha256,status,error,created_at) VALUES(?,0,'','failed',?,?)", name, String(e.message).slice(0, 300), Date.now());
    recordIncident(db, { kind: 'backup', severity: 'critical', message: `Sauvegarde impossible : ${String(e.message).slice(0, 160)}` });
    throw e;
  } finally { fs.rmSync(tmp, { force: true }); }
}

/**
 * Restaure une sauvegarde (la plus récente par défaut) vers dbFile. La base est vérifiée (intégrité + environnement)
 * avant de remplacer quoi que ce soit ; l'ancienne base est conservée à côté (.avant-restauration).
 */
export async function restore(dbFile, { name = null } = {}) {
  const names = await list(dbFile); const pick = name || names[0];
  if (!pick) throw new Error('Aucune sauvegarde disponible');
  const raw = zlib.gunzipSync(decrypt(await get(pick, dbFile), secretOf()));
  const tmp = `${dbFile}.restauration`; fs.mkdirSync(path.dirname(path.resolve(dbFile)), { recursive: true }); fs.writeFileSync(tmp, raw);
  const check = new DatabaseSync(tmp);
  try {
    const ok = check.prepare('PRAGMA integrity_check').get().integrity_check;
    if (ok !== 'ok') throw new Error('Sauvegarde corrompue : ' + ok);
    const env = check.prepare("SELECT v FROM meta WHERE k='app_env'").get()?.v;
    if (env && env !== config.appEnv) throw new Error(`Cette sauvegarde appartient à l'environnement « ${env} »`);
  } catch (e) { check.close(); fs.rmSync(tmp, { force: true }); throw e; }
  check.close();
  if (fs.existsSync(dbFile)) fs.renameSync(dbFile, `${dbFile}.avant-restauration`);
  for (const s of ['-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });
  fs.renameSync(tmp, dbFile);
  return { restored: pick };
}

/** Âge maximal toléré de la dernière sauvegarde réussie avant alerte critique. */
export const maxBackupAgeMs = () => Math.max(2, config.backupEveryHours * 3) * 36e5;
const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;
const setMeta = (db, k, v) => db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));

/**
 * Test de restauration à blanc (quotidien) : télécharge la dernière sauvegarde, la déchiffre, vérifie l'intégrité,
 * l'environnement et le contenu, SANS toucher à la base en service. Une erreur déclenche une alerte critique.
 */
export async function verifyBackup(db, { now = Date.now() } = {}) {
  const tmp = path.join(path.dirname(path.resolve(db.file)), `.verification-${process.pid}-${now}.db`);
  const r = { at: new Date(now).toISOString(), ok: false };
  try {
    const names = await list(db.file); r.name = names[0] || null; r.count = names.length;
    if (!r.name) throw new Error('Aucune sauvegarde disponible');
    const enc = await get(r.name, db.file); r.bytes = enc.length;
    fs.writeFileSync(tmp, zlib.gunzipSync(decrypt(enc, secretOf())));
    const check = new DatabaseSync(tmp, { readOnly: true });
    try {
      const ok = check.prepare('PRAGMA integrity_check').get().integrity_check;
      if (ok !== 'ok') throw new Error('Sauvegarde corrompue : ' + ok);
      const env = check.prepare("SELECT v FROM meta WHERE k='app_env'").get()?.v;
      if (env && env !== config.appEnv) throw new Error(`Sauvegarde d'un autre environnement (${env})`);
      const n = (t, w = '') => check.prepare(`SELECT COUNT(*) n FROM ${t} ${w}`).get().n;
      r.backup = { comptes: n('tenants', 'WHERE example=0'), prospects: n('prospects'), rendezVous: n('appointments') };
    } finally { check.close(); }
    const live = { comptes: db.one('SELECT COUNT(*) n FROM tenants WHERE example=0').n, prospects: db.one('SELECT COUNT(*) n FROM prospects').n, rendezVous: db.one('SELECT COUNT(*) n FROM appointments').n };
    r.live = live;
    // La sauvegarde a au plus quelques minutes de retard : un écart important signale une sauvegarde incomplète
    if (r.backup.comptes < live.comptes - 2 || r.backup.prospects < live.prospects * 0.5 || r.backup.rendezVous < live.rendezVous - 20)
      throw new Error(`Sauvegarde incomplète (comptes ${r.backup.comptes}/${live.comptes}, prospects ${r.backup.prospects}/${live.prospects})`);
    r.ok = true;
  } catch (e) {
    r.error = String(e.message).slice(0, 200);
    recordIncident(db, { kind: 'backup_verify', severity: 'critical', message: `Test de restauration échoué : ${r.error}` });
  } finally { fs.rmSync(tmp, { force: true }); }
  setMeta(db, 'backup_verified', JSON.stringify(r));
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.backup_verify',?,?)", JSON.stringify(r), now);
  return r;
}

/** État des sauvegardes pour /health et la surveillance externe. */
export function backupHealth(db, now = Date.now()) {
  const last = db.one("SELECT MAX(created_at) at FROM backups WHERE status='ok'").at || 0;
  const failedSince = db.one("SELECT COUNT(*) n FROM backups WHERE status='failed' AND created_at>?", last).n;
  let verified = null; try { verified = JSON.parse(meta(db, 'backup_verified') || 'null'); } catch { verified = null; }
  const problems = [];
  if (!remoteConfigured()) problems.push('sauvegarde hors serveur non configurée');
  if (!last) problems.push('aucune sauvegarde réussie');
  else if (now - last > maxBackupAgeMs()) problems.push('dernière sauvegarde trop ancienne');
  if (failedSince >= 3) problems.push(`${failedSince} échecs depuis la dernière réussite`);
  if (verified && !verified.ok) problems.push('dernier test de restauration échoué');
  return { ok: !problems.length, problems, lastOk: last ? new Date(last).toISOString() : null, failedSince, verified };
}

/** Surveillance : sauvegarde due ? trop ancienne ? */
let lastSavedChanges = -1;
export async function backupJob(db, now = Date.now()) {
  const last = db.one("SELECT MAX(created_at) at FROM backups WHERE status='ok'").at || 0;
  if (config.appEnv === 'test' && !remoteConfigured()) return { skipped: true };
  // Sauvegarde dès qu'il y a eu des modifications (au plus toutes les BACKUP_MIN_GAP secondes), et au minimum à intervalle régulier
  const changes = db.one('SELECT total_changes() c').c;
  const dirty = changes !== lastSavedChanges && remoteConfigured() && now - last >= config.backupMinGapSec * 1000;
  if (dirty || now - last >= config.backupEveryHours * 36e5 - 30e3) {
    try { const r = await createBackup(db); lastSavedChanges = db.one('SELECT total_changes() c').c; return r; } catch { /* incident déjà enregistré */ }
  }
  if (last && now - last > maxBackupAgeMs()) recordIncident(db, { kind: 'backup_age', severity: 'critical', message: `Aucune sauvegarde réussie depuis plus de ${Math.round(maxBackupAgeMs() / 36e5)} heures` });
  if (config.isProd && !remoteConfigured()) recordIncident(db, { kind: 'backup_offsite', severity: 'warning', message: 'Sauvegardes uniquement locales : configurez SUPABASE_URL et SUPABASE_SERVICE_KEY' });
  return { last };
}
