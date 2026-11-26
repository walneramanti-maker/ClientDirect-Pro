// Fiabilité réelle des sauvegardes : vrai serveur, vrai arrêt, disque effacé, redémarrage, données retrouvées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { makeClient } from './helpers.js';

// Faux Supabase Storage (stockage en mémoire, même API que le vrai)
const store = new Map();
const storage = http.createServer((req, res) => {
  let body = []; req.on('data', (d) => body.push(d)); req.on('end', () => {
    body = Buffer.concat(body); const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer svc_key') { res.writeHead(401); return res.end('{}'); }
    if (u.pathname.startsWith('/storage/v1/object/list/')) { const { prefix } = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([...store.keys()].filter((k) => k.startsWith('backups/' + prefix)).map((k) => ({ name: k.split('/').pop() })))); }
    const key = u.pathname.replace('/storage/v1/object/', '');
    if (req.method === 'POST') { store.set(key, body); res.writeHead(200); return res.end('{}'); }
    if (req.method === 'DELETE') { for (const p of JSON.parse(body).prefixes) store.delete('backups/' + p); res.writeHead(200); return res.end('[]'); }
    if (store.has(key)) { res.writeHead(200); return res.end(store.get(key)); }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => storage.listen(0, '127.0.0.1', r));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-restart-'));
const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
let port;
const ENV = (extra = {}) => ({ ...process.env, APP_ENV: 'development', NODE_ENV: 'development', PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, DB_PATH: path.join(dir, 'data', 'cdp.db'),
  SUPABASE_URL: `http://127.0.0.1:${storage.address().port}`, SUPABASE_SERVICE_KEY: 'svc_key', BACKUP_KEY: 'b'.repeat(40), RESTORE_ON_BOOT: '1', JOBS_INTERVAL_MS: '400', BACKUP_EVERY_HOURS: '100', ...extra });
async function start(extra) {
  const p = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { env: ENV(extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d)); p.log = () => out;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 200 || r.status === 503) return p; } catch { /* démarrage */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('Serveur non démarré : ' + out);
}
const stop = (p, sig = 'SIGTERM') => new Promise((r) => { p.on('exit', r); p.kill(sig); });
test.after(async () => { storage.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('sauvegarde à l’arrêt du serveur, puis restauration automatique sur un disque vierge', async () => {
  port = await freePort(); let srv = await start();
  const c = makeClient(`http://127.0.0.1:${port}`);
  const r = await c.submit('/inscription', '/inscription', { business: 'Garage Persistant', tpl: 'garage', city: 'Cayenne', country: 'GF', tz: 'America/Cayenne', phone: '0694000009', plan: 'pro', name: 'Test', email: 'persist@test.fr', password: 'Persistant2026', cgu: 'on' });
  assert.equal(r.status, 303);
  await stop(srv); // mise à jour / mise en veille : SIGTERM
  assert.equal([...store.keys()].filter((k) => k.startsWith('backups/development/')).length, 1, 'sauvegarde envoyée hors du serveur à l’arrêt');
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }); // disque éphémère perdu
  srv = await start();
  assert.match(srv.log(), /Base restaurée depuis cdp-/);
  const page = await fetch(`http://127.0.0.1:${port}/s/garage-persistant`); assert.equal(page.status, 200);
  const c2 = makeClient(`http://127.0.0.1:${port}`);
  const login = await c2.submit('/connexion', '/connexion', { email: 'persist@test.fr', password: 'Persistant2026' });
  assert.equal(login.location, '/pro', 'le compte et le mot de passe ont survécu');
  await stop(srv);
});
test('panne brutale : les données de la dernière sauvegarde automatique sont retrouvées', async () => {
  store.clear(); fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  let srv = await start({ BACKUP_EVERY_HOURS: '0.0003' }); // sauvegarde toutes les ~1 s pour le test
  const c = makeClient(`http://127.0.0.1:${port}`);
  await c.submit('/inscription', '/inscription', { business: 'Garage Panne Brutale', tpl: 'garage', city: 'Kourou', country: 'GF', tz: 'America/Cayenne', plan: 'pro', name: 'T', email: 'crash@test.fr', password: 'CrashTest2026', cgu: 'on' });
  const t0 = store.size; for (let i = 0; i < 40 && store.size <= t0; i++) await new Promise((r) => setTimeout(r, 150));
  assert.ok(store.size > t0, 'sauvegarde automatique faite');
  await stop(srv, 'SIGKILL'); // coupure sans arrêt propre
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  srv = await start();
  assert.equal((await fetch(`http://127.0.0.1:${port}/s/garage-panne-brutale`)).status, 200);
  await stop(srv);
});
test('restauration impossible (mauvaise clé ou stockage injoignable) : le serveur refuse de démarrer avec une base vide', async () => {
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  const before = [...store.keys()].sort();
  for (const extra of [{ BACKUP_KEY: 'x'.repeat(40) }, { SUPABASE_URL: 'http://127.0.0.1:1' }]) {
    const p = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { env: ENV(extra), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stderr.on('data', (d) => (out += d));
    const code = await new Promise((r) => p.on('exit', r));
    assert.equal(code, 1); assert.match(out, /Restauration impossible, démarrage refusé/);
  }
  assert.deepEqual([...store.keys()].sort(), before, 'les bonnes sauvegardes ne sont jamais écrasées');
});
test('migration recette → production : reprise de la sauvegarde vérifiée, une seule fois, sans réglages Stripe de test', async () => {
  store.clear(); fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  let srv = await start();
  const c = makeClient(`http://127.0.0.1:${port}`);
  await c.submit('/inscription', '/inscription', { business: 'Garage Migration', tpl: 'garage', city: 'Cayenne', country: 'GF', tz: 'America/Cayenne', plan: 'pro', name: 'T', email: 'migration@test.fr', password: 'Migration2026', cgu: 'on' });
  await stop(srv);
  // Réglage Stripe du mode test enregistré dans la base de recette : ne doit pas suivre en production
  { const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(path.join(dir, 'data', 'cdp.db')); d.prepare("INSERT INTO meta(k,v) VALUES('stripe_webhook_secret','whsec_test') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(); d.close(); }
  srv = await start({ RESTORE_ON_BOOT: '0' }); await stop(srv); // nouvelle sauvegarde à l'arrêt, avec ce réglage
  const name = [...store.keys()].filter((k) => k.startsWith('backups/development/')).map((k) => k.split('/').pop()).sort().pop();
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }); // nouveau serveur, disque vide
  const PROD = { APP_ENV: 'production', NODE_ENV: 'production', BASE_URL: 'https://clientdirectpro.example', APP_SECRET: 's'.repeat(40), MIGRATE_FROM_ENV: 'development' };
  // Sans le nom exact de la sauvegarde : refus de démarrer, rien n'est créé
  { const p = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { env: ENV(PROD), stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stderr.on('data', (d) => (out += d));
    assert.equal(await new Promise((r) => p.on('exit', r)), 1); assert.match(out, /Migration impossible, démarrage refusé : MIGRATE_FROM_BACKUP manquant/); }
  assert.equal(fs.existsSync(path.join(dir, 'data', 'cdp.db')), false);
  srv = await start({ ...PROD, MIGRATE_FROM_BACKUP: name });
  assert.match(srv.log(), /Migration réussie depuis development\//);
  assert.equal((await fetch(`http://127.0.0.1:${port}/s/garage-migration`)).status, 200, 'le site du client est repris');
  const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(h.ready.stripeWebhook, false, 'le secret de webhook du mode test n’est pas repris');
  assert.match(h.ready.restoredFrom, new RegExp(`development/${name}`));
  await stop(srv);
  assert.ok([...store.keys()].some((k) => k.startsWith('backups/production/')), 'la production sauvegarde dans son propre espace');
  // Redémarrage : la production repart de SES sauvegardes, la migration n'est jamais rejouée
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  srv = await start({ ...PROD, MIGRATE_FROM_BACKUP: name });
  assert.doesNotMatch(srv.log(), /Migration réussie/); assert.match(srv.log(), /Base restaurée depuis cdp-/);
  await stop(srv);
});
