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
test('répétition de la migration recette → production : toutes les tables identiques, sauvegardes de la recette intactes', async () => {
  store.clear(); fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true });
  let srv = await start();
  const c = makeClient(`http://127.0.0.1:${port}`);
  await c.submit('/inscription', '/inscription', { business: 'Garage Répétition', tpl: 'garage', city: 'Cayenne', country: 'GF', tz: 'America/Cayenne', phone: '0694 12 34 56', plan: 'pro', name: 'R', email: 'repetition@test.fr', password: 'Repetition2026', cgu: 'on' });
  await stop(srv);
  // Données de toutes natures, comme sur le serveur de recette : réglages, rendez-vous, devis, prospects, campagnes, factures, opposition
  { const { DatabaseSync } = await import('node:sqlite'); const d = new DatabaseSync(path.join(dir, 'data', 'cdp.db')); const now = Date.now();
    const t = d.prepare("SELECT id FROM tenants WHERE slug='garage-repetition'").get().id;
    d.prepare("UPDATE tenants SET lead='Accueil personnalisé', faq='CB et espèces', color='#112233', auto_confirm=1 WHERE id=?").run(t);
    d.prepare("INSERT INTO appointments(tenant_id,service_name,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,starts_at,created_at) VALUES(?,'Vidange','2030-01-02','09:00',540,60,1,'P','Client R','594694000002','c@r.fr','confirmed',?,?)").run(t, now + 864e5, now);
    d.prepare("INSERT INTO quotes(tenant_id,customer_name,customer_phone,customer_email,created_at) VALUES(?,'Devis R','33612345678','',?)").run(t, now);
    d.prepare("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,'in_r',54800,'eur','paid',?,?)").run(t, now, now);
    for (let i = 0; i < 25; i++) d.prepare("INSERT INTO prospects(siren,name,tpl,city,postal,dept,status,score,potential,phone,email,created_at) VALUES(?,?,?,?,?,?,'new',5,80,?,?,?)").run(String(700000000 + i), `PROSPECT ${i}`, 'garage', 'CAYENNE', '97300', '973', `+59459400${String(i).padStart(4, '0')}`, `p${i}@x.fr`, now);
    d.prepare("INSERT INTO campaigns(name,channel,filters,size,status,created_at) VALUES('Campagne R','email','{}',25,'draft',?)").run(now);
    d.prepare("INSERT INTO meta(k,v) VALUES('launch_date','2026-11-26') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
    d.prepare("INSERT INTO meta(k,v) VALUES('stripe_price_pro_EUR_month','price_test_x') ON CONFLICT(k) DO UPDATE SET v=excluded.v").run();
    d.close(); }
  srv = await start({ RESTORE_ON_BOOT: '0', DISABLE_JOBS: '1' }); await stop(srv); // sauvegarde de recette à l'arrêt
  const dbFile = path.join(dir, 'data', 'cdp.db');
  const { DatabaseSync } = await import('node:sqlite');
  const dump = (file) => { const d = new DatabaseSync(file); const tables = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
    const o = Object.fromEntries(tables.map((tb) => [tb, d.prepare(`SELECT * FROM ${tb} ORDER BY rowid`).all().map((r) => JSON.stringify(r))])); d.close(); return o; };
  const before = dump(dbFile);
  const stagingKeys = [...store.keys()].filter((k) => k.startsWith('backups/development/')).sort();
  const name = stagingKeys.map((k) => k.split('/').pop()).sort().pop();
  fs.rmSync(path.join(dir, 'data'), { recursive: true, force: true }); // serveur permanent neuf : disque vide
  // Migration seule (sans démarrer le serveur ni les tâches) pour comparer exactement la base obtenue
  const env = { ...ENV(), APP_ENV: 'production', NODE_ENV: 'production' };
  const code = `import('./src/backup.js').then(async (b) => { const r = await b.migrateFrom(process.env.DB_PATH, { fromEnv: 'development', name: ${JSON.stringify(name)} }); console.log(JSON.stringify(r)); })`;
  const out = await new Promise((ok, ko) => { const p = spawn(process.execPath, ['--no-warnings', '-e', code], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; p.stdout.on('data', (x) => (s += x)); p.stderr.on('data', (x) => (s += x)); p.on('exit', (e) => (e === 0 ? ok(s) : ko(new Error(s)))); });
  assert.match(out, /"comptes":\d+/);
  const after = dump(dbFile);
  // Référence exacte : la sauvegarde de recette restaurée telle quelle (même procédure qu'un redémarrage de la recette)
  const refFile = path.join(dir, 'reference', 'cdp.db'); fs.mkdirSync(path.dirname(refFile), { recursive: true });
  const code2 = `import('./src/backup.js').then(async (b) => { await b.restore(process.env.DB_PATH, { name: ${JSON.stringify(name)} }); })`;
  await new Promise((ok, ko) => { const p = spawn(process.execPath, ['--no-warnings', '-e', code2], { env: { ...ENV(), DB_PATH: refFile }, stdio: ['ignore', 'pipe', 'pipe'] }); let s = ''; p.stderr.on('data', (x) => (s += x)); p.on('exit', (e) => (e === 0 ? ok() : ko(new Error(s)))); });
  const backup = dump(refFile);
  // Rien de la recette n'est perdu : chaque ligne métier de la base vivante est dans la sauvegarde
  for (const tb of ['users', 'tenants', 'memberships', 'services', 'staff', 'hours', 'appointments', 'quotes', 'invoices', 'prospects', 'campaigns', 'campaign_items', 'partners', 'rewards', 'suppressions', 'contacts', 'tickets'])
    assert.deepEqual(backup[tb], before[tb], `sauvegarde complète : ${tb} (${before[tb].length} lignes)`);
  assert.deepEqual(Object.keys(after), Object.keys(before), 'mêmes tables');
  // Base de production = sauvegarde de recette, table par table, ligne par ligne
  for (const tb of Object.keys(backup)) if (tb !== 'meta') assert.deepEqual(after[tb], backup[tb], `table ${tb} identique (${backup[tb].length} lignes)`);
  const meta = (rows) => Object.fromEntries(rows.map((r) => JSON.parse(r)).map((r) => [r.k, r.v]));
  const mb = meta(backup.meta); const ma = meta(after.meta);
  for (const [k, v] of Object.entries(mb)) {
    if (k === 'app_env') assert.equal(ma[k], 'production');
    else if (k.startsWith('stripe_')) assert.equal(ma[k], undefined, `${k} (mode test) retiré`);
    else assert.equal(ma[k], v, `réglage ${k} conservé`);
  }
  assert.match(ma.migrated_from, new RegExp(`^development/${name}`));
  assert.ok(before.tenants.length >= 1 && before.prospects.length >= 25 && before.invoices.length >= 1 && before.campaigns.length >= 1);
  // Démarrage du serveur permanent sur la base migrée, puis sauvegarde dans son propre espace : la recette n'est jamais touchée
  srv = await start({ APP_ENV: 'production', NODE_ENV: 'production', BASE_URL: 'https://clientdirectpro.example', APP_SECRET: 's'.repeat(40), DISABLE_JOBS: '1' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/s/garage-repetition`)).status, 200);
  await stop(srv);
  assert.deepEqual([...store.keys()].filter((k) => k.startsWith('backups/development/')).sort(), stagingKeys, 'sauvegardes de la recette intactes');
  assert.ok([...store.keys()].some((k) => k.startsWith('backups/production/')), 'la production a ses propres sauvegardes');
});
