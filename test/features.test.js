// Référencement, domaines, statistiques, rentabilité, sauvegardes, RGPD, environnements, alertes, sécurité, paiements, concurrence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ AUTORISER_IA_PAYANTE: 'oui', AUTORISER_WHATSAPP_PAYANT: 'oui',
  ADMIN_EMAIL: 'admin@cdp.fr', BREVO_API_KEY: 'brevo_x', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_f', STRIPE_PRICE_PRO: 'price_pro',
  RENDER_API_KEY: 'rnd_x', RENDER_SERVICE_ID: 'srv-123', RENDER_HOSTNAME: 'clientdirect-pro.onrender.com',
  SUPABASE_URL: 'https://sb.example.co', SUPABASE_SERVICE_KEY: 'sb_service', BACKUP_KEY: 'k'.repeat(40), BACKUP_KEEP: '3', ANTHROPIC_API_KEY: 'sk-ant-x'
});
const { db } = app;
test.after(() => app.close());
const cfg = await import('../src/config.js');
const seo = await import('../src/seo.js');
const domains = await import('../src/domains.js');
const backup = await import('../src/backup.js');
const privacy = await import('../src/privacy.js');
const { tenantCosts } = await import('../src/costs.js');
const { runJobs } = await import('../src/jobs.js');
const { processOutbox } = await import('../src/notify.js');
const { recordIncident } = await import('../src/incidents.js');
const { loadTenant } = await import('../src/tenants.js');
const { openDb } = await import('../src/db.js');

let calls = [];
const store = new Map(); // faux Supabase Storage
let renderVerified = new Set();
function mock(extra = () => null) {
  app.net.setFetch(async (url, opt = {}) => {
    url = String(url); calls.push({ url, opt });
    const x = extra(url, opt); if (x) return x;
    if (url.startsWith('https://sb.example.co/storage/v1/')) {
      const rest = url.slice('https://sb.example.co/storage/v1/'.length);
      if (rest.startsWith('object/list/')) { const { prefix } = JSON.parse(opt.body); return jsonResponse([...store.keys()].filter((k) => k.startsWith('backups/' + prefix)).map((k) => ({ name: k.split('/').pop() }))); }
      if (opt.method === 'DELETE') { for (const p of JSON.parse(opt.body).prefixes) store.delete('backups/' + p); return jsonResponse({}); }
      const key = rest.replace(/^object\//, '');
      if (opt.method === 'POST') { store.set(key, Buffer.from(opt.body)); return jsonResponse({ Key: key }); }
      return store.has(key) ? new Response(store.get(key)) : jsonResponse({ error: 'not found' }, 404);
    }
    if (url.startsWith('https://api.render.com/v1/services/srv-123/custom-domains')) {
      const name = decodeURIComponent(url.split('/custom-domains')[1].replace(/^\//, '').replace(/\/verify$/, ''));
      if (opt.method === 'POST' && !name) { const b = JSON.parse(opt.body); if (b.name === 'refuse.fr') return jsonResponse({ message: 'no' }, 400); return jsonResponse({ name: b.name, verificationStatus: 'unverified' }, 201); }
      if (opt.method === 'POST') return jsonResponse({});
      if (opt.method === 'DELETE') return new Response(null, { status: 204 });
      return jsonResponse({ name, verificationStatus: renderVerified.has(name) ? 'verified' : 'unverified' });
    }
    return jsonResponse({ ok: true }, 201);
  });
}
mock();
const futureDay = async (slug, svc) => (await app.client().json(`/s/${slug}/creneaux?service=${svc}`)).days[1];
const firstSvc = (t) => db.one('SELECT id FROM services WHERE tenant_id=? ORDER BY id LIMIT 1', t.id).id;
async function slot(t, i = 0) { const svc = firstSvc(t); const day = await futureDay(t.slug, svc); const slots = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots; return { svc, day, time: slots[i] }; }
async function makeAdmin() {
  const secret = app.sec.newTotpSecret();
  if (!db.one("SELECT 1 FROM users WHERE email='boss@cdp.fr'")) db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", app.sec.hashPassword('AdminTresLong2026'), secret, Date.now());
  else db.run("UPDATE users SET totp_secret=?, failed_logins=0, locked_until=0 WHERE email='boss@cdp.fr'", secret);
  app.sec.resetRateLimits();
  const c = app.client(); await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  await c.submit('/connexion/2fa', '/connexion/2fa', { code: app.sec.totpCode(secret) });
  return c;
}
const hook = async (ev) => { const raw = JSON.stringify(ev); const ts = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', 'whsec_f').update(`${ts}.${raw}`).digest('hex'); const r = await fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw }); return r.status; };

// ================= Environnements =================
test('env : clé Stripe de test refusée en production', () => {
  const p = cfg.envProblems({ ...cfg.config, appEnv: 'production', secret: 'x'.repeat(40), baseUrl: 'https://a.fr', stripeKey: 'sk_test_1', testAllowlist: [], supabaseUrl: '', backupKey: '' });
  assert.ok(p.some((x) => /TEST interdite/.test(x)));
});
test('env : clé Stripe réelle refusée en recette', () => {
  assert.ok(cfg.envProblems({ ...cfg.config, appEnv: 'staging', baseUrl: 'https://test.a.fr', stripeKey: 'sk_live_1' }).some((x) => /RÉELLE interdite/.test(x)));
  assert.ok(cfg.envProblems({ ...cfg.config, appEnv: 'development', stripeKey: 'rk_live_1' }).length > 0);
});
test('env : configuration de production correcte acceptée, secret faible refusé', () => {
  const good = { ...cfg.config, appEnv: 'production', secret: 'x'.repeat(40), baseUrl: 'https://a.fr', stripeKey: 'sk_live_1', testAllowlist: [], supabaseUrl: 'https://s', backupKey: 'b'.repeat(40) };
  assert.deepEqual(cfg.envProblems(good), []);
  assert.ok(cfg.envProblems({ ...good, secret: 'court' }).length === 1);
  assert.ok(cfg.envProblems({ ...good, backupKey: '' }).some((x) => /BACKUP_KEY/.test(x)));
});
test('env : une base de recette ne peut pas être ouverte par la production', () => {
  const f = db.file + '.envtest'; const d = openDb(f, { appEnv: 'staging' }); d.close();
  assert.throws(() => openDb(f, { appEnv: 'production' }), /appartient à l'environnement « staging »/);
  const again = openDb(f, { appEnv: 'staging' }); again.close();
});
test('env : en recette, messages limités à la liste blanche', () => {
  const c = { ...cfg.config, appEnv: 'staging', testAllowlist: ['walner@test.fr', '@exemple.fr'] };
  assert.equal(cfg.recipientAllowed('walner@test.fr', c), true);
  assert.equal(cfg.recipientAllowed('qui@exemple.fr', c), true);
  assert.equal(cfg.recipientAllowed('vrai.client@gmail.com', c), false);
  assert.equal(cfg.recipientAllowed('594694000000', c), false, 'WhatsApp bloqué aussi');
  assert.equal(cfg.recipientAllowed('vrai.client@gmail.com', { ...c, appEnv: 'production' }), true);
});
test('env : hors production, rien n’est indexé (en-tête + robots.txt)', async () => {
  const r = await app.client().get('/');
  assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match((await app.client().get('/robots.txt')).text, /Disallow: \//);
});
test('migrations : schéma versionné, colonnes ajoutées', () => {
  assert.ok(db.raw.prepare('PRAGMA user_version').get().user_version >= 9);
  assert.ok(db.all('PRAGMA table_info(tenants)').some((c) => c.name === 'custom_domain'));
});

// ================= Référencement =================
test('SEO : description, adresse canonique et données structurées LocalBusiness', async () => {
  const { t } = await signup(app, { business: 'Garage <Seo> & Fils', email: 'seo@test.fr' });
  const page = (await app.client().get(`/s/${t.slug}`)).text;
  assert.match(page, /<meta name="description" content="Garage &lt;Seo&gt; &amp; Fils, garage automobile à Cayenne/);
  assert.match(page, new RegExp(`<link rel="canonical" href="http://127.0.0.1/s/${t.slug}">`));
  const ld = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)[1]);
  assert.equal(ld['@type'], 'AutoRepair'); assert.equal(ld.name, 'Garage <Seo> & Fils');
  assert.ok(ld.openingHoursSpecification.length >= 5); assert.ok(ld.makesOffer.length >= 3);
  assert.doesNotMatch(/<script type="application\/ld\+json">(.*?)<\/script>/s.exec(page)[1], /</, 'pas de « < » brut dans le JSON-LD');
});
test('SEO : en production les sites sont indexables, les démos jamais', () => {
  const t = loadTenant(db, 'slug', 'garage-seo-fils');
  const prev = cfg.config.isProd; cfg.config.isProd = true;
  try { assert.match(seo.siteHead(t), /content="index, follow"/); assert.match(seo.siteHead(t, { mode: 'demo' }), /noindex/); } finally { cfg.config.isProd = prev; }
});
test('SEO : sitemap avec les sites publiés, sans les démos ni les sites en pause', async () => {
  const { t: live } = await signup(app, { business: 'Garage Visible', email: 'visible@test.fr' });
  const { t: paused } = await signup(app, { business: 'Garage Pause', email: 'pause@test.fr' });
  db.run("UPDATE tenants SET status='paused' WHERE id=?", paused.id);
  db.run("INSERT INTO tenants(slug,name,tpl,metier,status,created_at) VALUES('demo-cachee','Démo','garage','Garage','demo',?)", Date.now());
  const xml = (await app.client().get('/sitemap.xml')).text;
  assert.match(xml, /<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/);
  assert.match(xml, new RegExp(`/s/${live.slug}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}`));
  assert.doesNotMatch(xml, /garage-pause|demo-cachee/);
});
test('SEO : robots.txt et sitemap propres à chaque site, annuaire public', async () => {
  const t = loadTenant(db, 'slug', 'garage-visible');
  cfg.config.isProd = true; let robotsTxt; try { robotsTxt = (await app.client().get(`/s/${t.slug}/robots.txt`)).text; } finally { cfg.config.isProd = false; }
  assert.match(robotsTxt, /Disallow: \/pro/);
  assert.match(robotsTxt, /Sitemap: http:\/\/127.0.0.1\/s\/garage-visible\/sitemap.xml/);
  assert.match((await app.client().get(`/s/${t.slug}/sitemap.xml`)).text, /<loc>http:\/\/127.0.0.1\/s\/garage-visible<\/loc>/);
  const dir = (await app.client().get('/annuaire')).text;
  assert.match(dir, /Garage Visible/); assert.doesNotMatch(dir, /Garage Pause/);
});

// ================= Domaines personnalisés =================
test('domaines : validation des noms saisis', () => {
  assert.equal(domains.normalizeDomain('https://WWW.Mon-Garage.fr/accueil').domain, 'www.mon-garage.fr');
  assert.ok(domains.normalizeDomain('pas un domaine').error);
  assert.ok(domains.normalizeDomain('localhost').error);
  assert.ok(domains.normalizeDomain('127.0.0.1').error);
  assert.equal(domains.normalizeDomain('').domain, null);
});
test('domaines : ajout automatique chez Render, vérification, puis le site répond sur son domaine', async () => {
  const { c, t } = await signup(app, { business: 'Garage Domaine', email: 'dom@test.fr' });
  calls = []; let page = await c.get('/pro/reglages');
  let r = await c.post('/pro/domaine', { csrf: c.csrf(page.text), domain: 'www.garage-domaine.fr' });
  assert.equal(r.status, 200); assert.match(r.text, /CNAME/); assert.match(r.text, /clientdirect-pro.onrender.com/);
  const add = calls.find((x) => x.url.endsWith('/custom-domains') && x.opt.method === 'POST');
  assert.equal(JSON.parse(add.opt.body).name, 'www.garage-domaine.fr'); assert.equal(add.opt.headers.authorization, 'Bearer rnd_x');
  assert.equal(db.one('SELECT domain_status FROM tenants WHERE id=?', t.id).domain_status, 'pending');
  const http = await import('node:http');
  const hostGet = (h, p = '/') => new Promise((ok, ko) => http.get(app.base + p, { headers: { host: h } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => ok({ status: res.statusCode, text: b })); }).on('error', ko));
  assert.doesNotMatch((await hostGet('www.garage-domaine.fr')).text, /Garage Domaine/, 'pas servi avant vérification');
  db.run("DELETE FROM audit WHERE action='job.domains'"); renderVerified.add('www.garage-domaine.fr');
  await runJobs(db);
  assert.equal(db.one('SELECT domain_status FROM tenants WHERE id=?', t.id).domain_status, 'verified');
  const served = await hostGet('www.garage-domaine.fr');
  assert.equal(served.status, 200); assert.match(served.text, /Garage Domaine/); assert.match(served.text, /rel="canonical" href="https:\/\/www.garage-domaine.fr\/"/);
  cfg.config.isProd = true; try { assert.match((await hostGet('www.garage-domaine.fr', '/robots.txt')).text, /Sitemap: https:\/\/www.garage-domaine.fr\/sitemap.xml/); } finally { cfg.config.isProd = false; }
  // un autre client ne peut pas prendre ce domaine
  const B = await signup(app, { business: 'Garage Voleur', email: 'voleur@test.fr' });
  page = await B.c.get('/pro/reglages');
  r = await B.c.post('/pro/domaine', { csrf: B.c.csrf(page.text), domain: 'www.garage-domaine.fr' });
  assert.equal(r.status, 400); assert.match(r.text, /déjà utilisé/);
});
test('domaines : réservé aux formules Pro/Premium, refus de l’hébergeur signalé', async () => {
  const E = await signup(app, { business: 'Garage Essentiel', email: 'ess@test.fr', plan: 'essentiel' });
  let p = await E.c.get('/pro/reglages'); assert.match(p.text, /Disponible avec les formules Pro et Premium/);
  assert.equal((await E.c.post('/pro/domaine', { csrf: E.c.csrf(p.text), domain: 'www.ess.fr' })).status, 403);
  const P = await signup(app, { business: 'Garage Refus', email: 'refus@test.fr' });
  p = await P.c.get('/pro/reglages');
  const r = await P.c.post('/pro/domaine', { csrf: P.c.csrf(p.text), domain: 'refuse.fr' });
  assert.equal(r.status, 400); assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='domain'"));
});

// ================= Statistiques pour les pros =================
test('statistiques : visites (hors robots), réservations, devis, WhatsApp et assistant comptés', async () => {
  const { c, t } = await signup(app, { business: 'Garage Stats', email: 'stats@test.fr' });
  const ua = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' };
  for (let i = 0; i < 3; i++) await app.client().get(`/s/${t.slug}`, ua);
  await app.client().get(`/s/${t.slug}`, { 'user-agent': 'Googlebot/2.1' });
  const s = await slot(t);
  await app.client().json(`/s/${t.slug}/rdv`, { date: s.day, time: s.time, serviceId: s.svc, name: 'Léa', phone: '0694112233' });
  await app.client().json(`/s/${t.slug}/devis`, { name: 'Max', phone: '0694112233' });
  await app.client().json(`/s/${t.slug}/chat`, { q: 'horaires ?' });
  const wa = await app.client().get(`/s/${t.slug}/wa`, ua);
  assert.equal(wa.status, 303); assert.match(wa.location, /^https:\/\/wa.me\/594694000001\?text=/);
  const row = db.one('SELECT SUM(views) v, SUM(bookings) b, SUM(quotes) q, SUM(chats) ch, SUM(wa_clicks) w FROM stats_daily WHERE tenant_id=?', t.id);
  assert.deepEqual({ ...row }, { v: 3, b: 1, q: 1, ch: 1, w: 1 });
  const dash = (await c.get('/pro')).text;
  assert.match(dash, /Ce que votre site vous a apporté/); assert.match(dash, /<strong>3<\/strong><span>visites/); assert.match(dash, /<strong>3<\/strong><span>demandes reçues/);
});
test('statistiques : bilan mensuel envoyé une seule fois le 1er du mois', async () => {
  const t = loadTenant(db, 'slug', 'garage-stats');
  const lastMonthDay = new Date(); lastMonthDay.setUTCDate(1); lastMonthDay.setUTCMonth(lastMonthDay.getUTCMonth() - 1);
  db.run('INSERT INTO stats_daily(tenant_id, day, views, bookings) VALUES(?,?,40,5)', t.id, lastMonthDay.toISOString().slice(0, 10));
  const first = new Date(); first.setUTCDate(1); first.setUTCHours(12);
  const r1 = await runJobs(db, first.getTime()); assert.ok(r1.monthly >= 1);
  const mail = db.one("SELECT payload FROM outbox WHERE template='monthly_report' AND to_addr='stats@test.fr'");
  const p = JSON.parse(mail.payload); assert.equal(p.views, 40); assert.equal(p.bookings, 5);
  const r2 = await runJobs(db, first.getTime() + 3600e3); assert.equal(r2.monthly, undefined, 'pas de second envoi');
});

// ================= Rentabilité =================
test('rentabilité : coût réel par client (IA, messages, Stripe, frais fixes) et marge', async () => {
  const { t } = await signup(app, { business: 'Garage Rentable', email: 'rent@test.fr', plan: 'premium' });
  const m = new Date().toISOString().slice(0, 7);
  db.run("UPDATE tenants SET status='active' WHERE id=?", t.id);
  db.run('INSERT INTO ai_usage(tenant_id,month,calls,in_tokens,out_tokens) VALUES(?,?,100,2000000,200000)', t.id, m);
  for (let i = 0; i < 10; i++) db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,status,next_at,created_at,sent_at) VALUES(?,'email','x@y.fr','welcome','sent',0,?,?)", t.id, Date.now(), Date.now());
  for (let i = 0; i < 4; i++) db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,status,next_at,created_at,sent_at) VALUES(?,'whatsapp','594694000000','appt_reminder','sent',0,?,?)", t.id, Date.now(), Date.now());
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,status,paid_at,created_at) VALUES(?,'in_rent',24900,'paid',?,?)", t.id, Date.now(), Date.now());
  const r = tenantCosts(db, m); const row = r.rows.find((x) => x.id === t.id);
  assert.equal(row.revenue, 249);
  assert.equal(row.costs.ai, Math.round((2 * 0.10 + 0.2 * 0.50) * 0.92 * 100) / 100, 'jetons IA réels × prix');
  assert.equal(row.costs.email, Math.round(10 * 0.0015 * 100) / 100);
  assert.equal(row.costs.whatsapp, Math.round(4 * 0.0104 * 100) / 100);
  assert.equal(row.costs.stripe, Math.round((249 * 0.022 + 0.25) * 100) / 100);
  assert.ok(Math.abs(row.margin - (row.revenue - row.total)) < 0.011);
  const admin = await makeAdmin(); const page = await admin.get('/admin/rentabilite');
  assert.equal(page.status, 200); assert.match(page.text, /Garage Rentable/); assert.match(page.text, /Rentabilité par client/);
  const pro = await signup(app, { business: 'Curieux', email: 'curieux@test.fr' });
  assert.equal((await pro.c.get('/admin/rentabilite')).status, 303, 'réservé à l’administrateur');
});

// ================= Sauvegardes =================
test('sauvegardes : chiffrement AES-256-GCM, mauvaise clé ou fichier altéré refusés', () => {
  const data = Buffer.from('données sensibles des clients');
  const enc = backup.encrypt(data, 'cle-1'); assert.ok(!enc.includes(data));
  assert.deepEqual(backup.decrypt(enc, 'cle-1'), data);
  assert.throws(() => backup.decrypt(enc, 'cle-2'), /Clé de sauvegarde incorrecte/);
  const bad = Buffer.from(enc); bad[bad.length - 1] ^= 1; assert.throws(() => backup.decrypt(bad, 'cle-1'), /altéré/);
});
test('sauvegardes : envoi chiffré vers Supabase Storage et rétention limitée', async () => {
  store.clear(); calls = [];
  for (let i = 0; i < 5; i++) await backup.createBackup(db, { now: new Date(Date.UTC(2026, 10, 25, 10, i)) });
  const up = calls.find((x) => x.opt.method === 'POST' && x.url.includes('/object/backups/test/'));
  assert.ok(up); assert.equal(up.opt.headers.authorization, 'Bearer sb_service'); assert.equal(up.opt.headers['x-upsert'], 'true');
  assert.equal([...store.keys()].length, 3, 'seules les 3 plus récentes sont gardées (BACKUP_KEEP=3)');
  assert.ok([...store.keys()].every((k) => k.startsWith('backups/test/cdp-')));
  assert.equal(db.one("SELECT COUNT(*) n FROM backups WHERE status='ok'").n >= 5, true);
});
test('sauvegardes : restauration complète d’une base perdue', async () => {
  const { t } = await signup(app, { business: 'Garage Sauvé', email: 'sauve@test.fr' });
  await backup.createBackup(db, { now: new Date(Date.UTC(2026, 10, 25, 11, 0)) });
  const target = db.file + '.restore-test';
  const r = await backup.restore(target);
  assert.match(r.restored, /^cdp-20261125T1100/);
  const restored = openDb(target, { appEnv: 'test' });
  assert.equal(restored.one('SELECT name FROM tenants WHERE id=?', t.id).name, 'Garage Sauvé');
  assert.ok(restored.one("SELECT 1 FROM users WHERE email='sauve@test.fr'"));
  restored.close();
});
test('sauvegardes : fichier corrompu ou d’un autre environnement refusé, base existante intacte', async () => {
  const target = db.file + '.restore-test2'; fs.writeFileSync(target, 'base actuelle');
  const name = [...store.keys()].sort().pop().split('/').pop();
  const k = `backups/test/${name}`; const orig = store.get(k);
  store.set(k, Buffer.concat([orig.subarray(0, 40), Buffer.from('xxxx'), orig.subarray(44)]));
  await assert.rejects(backup.restore(target), /altéré/); assert.equal(fs.readFileSync(target, 'utf8'), 'base actuelle');
  store.set(k, orig);
  // sauvegarde venant d'une autre base (production) : refusée
  const prodFile = db.file + '.prod'; const prod = openDb(prodFile, { appEnv: 'production' }); prod.file = prodFile;
  const zlib = await import('node:zlib'); prod.raw.exec(`VACUUM INTO '${prodFile}.copy'`); prod.close();
  store.set('backups/test/cdp-29991231T235959Z.db.gz.enc', backup.encrypt(zlib.gzipSync(fs.readFileSync(prodFile + '.copy')), 'k'.repeat(40)));
  await assert.rejects(backup.restore(target), /environnement « production »/); assert.equal(fs.readFileSync(target, 'utf8'), 'base actuelle');
  store.delete('backups/test/cdp-29991231T235959Z.db.gz.enc');
});
test('sauvegardes : automatiques quand elles sont dues, alerte critique en cas d’échec', async () => {
  db.run('DELETE FROM backups');
  const r = await backup.backupJob(db); assert.ok(r.name, 'sauvegarde faite car aucune récente');
  const again = await backup.backupJob(db); assert.equal(again.name, undefined, 'pas de doublon dans l’intervalle');
  db.run('DELETE FROM backups'); db.run("DELETE FROM outbox WHERE template='admin_alert'");
  mock((url) => (url.includes('sb.example.co') ? jsonResponse({ error: 'quota' }, 507) : null));
  await backup.backupJob(db);
  assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='backup' AND resolved_at IS NULL"));
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='admin_alert' AND to_addr='admin@cdp.fr'"), 'administrateur alerté immédiatement');
  mock();
});

// ================= RGPD et prospection =================
test('RGPD : pages légales publiées (mentions, confidentialité, CGU avec sous-traitance)', async () => {
  const m = await app.client().get('/mentions-legales'); assert.equal(m.status, 200); assert.match(m.text, /Pop Chity High-Tech/); assert.match(m.text, /Hébergeur/);
  const c = (await app.client().get('/confidentialite')).text; assert.match(c, /sous-traitant \(article 28/); assert.match(c, /24 mois/); assert.match(c, /Cookies/);
  assert.match((await app.client().get('/cgu')).text, /Accord de sous-traitance/);
});
test('RGPD : information des clients sous chaque formulaire du site', async () => {
  const page = (await app.client().get('/s/garage-visible')).text;
  assert.equal((page.match(/Vos coordonnées servent uniquement à Garage Visible/g) || []).length, 2);
});
test('RGPD : export complet des données par le professionnel', async () => {
  const { c, t } = await signup(app, { business: 'Garage Export', email: 'export@test.fr' });
  const s = await slot(t); await app.client().json(`/s/${t.slug}/rdv`, { date: s.day, time: s.time, serviceId: s.svc, name: 'Ana', phone: '0694112233' });
  const r = await c.get('/pro/donnees/export');
  assert.match(r.headers.get('content-disposition'), /attachment; filename="clientdirect-garage-export.json"/);
  const j = JSON.parse(r.text);
  assert.equal(j.entreprise.name, 'Garage Export'); assert.equal(j.rendez_vous[0].customer_name, 'Ana'); assert.ok(j.prestations.length > 0);
  assert.doesNotMatch(r.text, /pass_hash|scrypt\$/, 'jamais le mot de passe');
});
test('RGPD : suppression du compte (mot de passe exigé), données effacées', async () => {
  const { c, t } = await signup(app, { business: 'Garage Supprimé', email: 'suppr@test.fr' });
  const s = await slot(t); await app.client().json(`/s/${t.slug}/rdv`, { date: s.day, time: s.time, serviceId: s.svc, name: 'Zoé', phone: '0694112233' });
  let p = await c.get('/pro/reglages');
  assert.equal((await c.post('/pro/compte/supprimer', { csrf: c.csrf(p.text), password: 'mauvais' })).status, 400);
  p = await c.get('/pro/reglages');
  assert.equal((await c.post('/pro/compte/supprimer', { csrf: c.csrf(p.text), password: 'MotDePasse2026' })).status, 303);
  assert.equal(db.one('SELECT COUNT(*) n FROM appointments WHERE tenant_id=?', t.id).n, 0);
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 404);
  assert.equal(db.one("SELECT COUNT(*) n FROM users WHERE email='suppr@test.fr'").n, 0);
  app.sec.resetRateLimits();
  assert.equal((await app.client().submit('/connexion', '/connexion', { email: 'suppr@test.fr', password: 'MotDePasse2026' })).status, 401);
});
test('RGPD : durées de conservation appliquées automatiquement', () => {
  const t = loadTenant(db, 'slug', 'garage-visible'); const old = Date.now() - 26 * 30.5 * 864e5;
  db.run("INSERT INTO appointments(tenant_id,service_name,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,starts_at,created_at) VALUES(?,'Vidange','2024-01-01','09:00',540,60,1,'P','Vieux Client','594694000000','vieux@x.fr','done',0,?)", t.id, old);
  db.run("INSERT INTO chat_logs(tenant_id,conv,role,body,created_at) VALUES(?,'c','user','ancienne question',?)", t.id, Date.now() - 100 * 864e5);
  db.run("INSERT INTO prospects(siren,name,created_at,status) VALUES('900000001','Vieux prospect',?,'contacted')", Date.now() - 40 * 30.5 * 864e5);
  db.run("INSERT INTO prospects(siren,name,created_at,status) VALUES('900000002','Opposé',?,'optout')", Date.now() - 40 * 30.5 * 864e5);
  const r = privacy.retentionJob(db);
  assert.ok(r.appointments >= 1 && r.chats >= 1 && r.prospects >= 1);
  assert.equal(db.one("SELECT customer_name FROM appointments WHERE customer_email='' AND date='2024-01-01'").customer_name, '(anonymisé)');
  assert.equal(db.one("SELECT COUNT(*) n FROM prospects WHERE siren='900000001'").n, 0);
  assert.equal(db.one("SELECT COUNT(*) n FROM prospects WHERE siren='900000002'").n, 1, 'opposition conservée pour ne jamais recontacter');
});
test('prospection : lien d’opposition, démo supprimée, entreprise jamais réimportée', async () => {
  const admin = await makeAdmin();
  mock((url) => (url.includes('recherche-entreprises') ? jsonResponse({ results: url.includes('96.02A') ? [
    { siren: '777888999', nom_complet: 'SALON KOUROU', activite_principale: '96.02A', siege: { libelle_commune: 'KOUROU', adresse: '1 RUE 97310 KOUROU' } },
    { siren: '111000111', nom_complet: '[ND]', activite_principale: '96.02A', statut_diffusion: 'P', siege: { adresse: '[ND]' } }] : [] }) : null));
  let p = await admin.get('/admin/prospection');
  let r = await admin.post('/admin/prospection/recherche', { csrf: admin.csrf(p.text), tpl: 'coiffeur', commune: '97304' });
  assert.match(r.text, /1 entreprise\(s\) trouvée\(s\), 1 nouvelle/, 'non-diffusible ignorée');
  const pr = db.one("SELECT * FROM prospects WHERE siren='777888999'");
  r = await admin.post(`/admin/prospection/${pr.id}/demo`, { csrf: admin.csrf(p.text) });
  const stop = new URL(/(http:\/\/127.0.0.1\/stop\/[\w-]+)/.exec(r.text)[1]).pathname;
  const v = app.client(); const done = await v.submit(stop, stop, {});
  assert.match(done.text, /ne serez plus contacté/);
  const after = db.one("SELECT * FROM prospects WHERE siren='777888999'");
  assert.equal(after.status, 'optout'); assert.equal(after.name, '(opposition)');
  assert.equal(db.one('SELECT COUNT(*) n FROM tenants WHERE id=?', pr.demo_tenant_id ?? db.one('SELECT demo_tenant_id d FROM prospects WHERE id=?', pr.id).d).n, 0, 'démo supprimée');
  p = await admin.get('/admin/prospection');
  r = await admin.post('/admin/prospection/recherche', { csrf: admin.csrf(p.text), tpl: 'coiffeur', commune: '97304' });
  assert.match(r.text, /0 nouvelle/); assert.doesNotMatch(r.text, /SALON KOUROU/);
  mock();
});

// ================= Incidents et alertes =================
test('alertes : incident critique => e-mail immédiat à l’admin, une seule fois', async () => {
  db.run("DELETE FROM outbox WHERE template='admin_alert'");
  recordIncident(db, { kind: 'disk', severity: 'critical', message: 'Disque plein à 95 %' });
  recordIncident(db, { kind: 'disk', severity: 'critical', message: 'Disque plein à 96 %' });
  assert.equal(db.all("SELECT * FROM outbox WHERE template='admin_alert' AND payload LIKE '%Disque plein%'").length, 1);
  calls = []; await processOutbox(db);
  const sent = calls.find((x) => x.url.includes('brevo') && /ALERTE/.test(JSON.parse(x.opt.body).subject));
  assert.ok(sent); assert.equal(JSON.parse(sent.opt.body).to[0].email, 'admin@cdp.fr');
});
test('alertes : une panne serveur crée un incident critique', async () => {
  const { c } = await signup(app, { business: 'Garage Panne', email: 'panne@test.fr' });
  mock((url) => (url.includes('api.stripe.com') ? jsonResponse({ error: { message: 'boom' } }, 500) : null));
  const p = await c.get('/pro/abonnement');
  const r = await c.post('/pro/abonnement/checkout', { csrf: c.csrf(p.text), plan: 'pro', cgv: 'on' });
  assert.equal(r.status, 500); assert.match(r.text, /signalée automatiquement/); assert.doesNotMatch(r.text, /boom/, 'pas de détail technique affiché');
  assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='http' AND severity='critical' AND message LIKE '%checkout%'"));
  mock();
});
test('alertes : /health passe en erreur si les tâches automatiques sont bloquées', async () => {
  db.run("INSERT INTO meta(k,v) VALUES('jobs_heartbeat',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(Date.now()));
  // DISABLE_JOBS=1 dans les tests : on vérifie la règle directement
  const h = await app.client().json('/health'); assert.equal(h.ok, true); assert.equal(h.env, 'test');
  cfg.config.disableJobs = false; db.run("UPDATE meta SET v=? WHERE k='jobs_heartbeat'", String(Date.now() - 60 * 60e3));
  try { const r = await fetch(app.base + '/health'); assert.equal(r.status, 503); } finally { cfg.config.disableJobs = true; }
});

// ================= Sécurité =================
test('sécurité : cookie de session HttpOnly + SameSite, déconnexion effective', async () => {
  app.sec.resetRateLimits(); const c = app.client();
  const page = await c.get('/connexion');
  const res = await fetch(app.base + '/connexion', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: Object.entries(c.jar).map(([k, v]) => `${k}=${v}`).join('; ') }, body: new URLSearchParams({ csrf: c.csrf(page.text), email: 'visible@test.fr', password: 'MotDePasse2026' }) });
  const sc = res.headers.getSetCookie().find((x) => x.startsWith('cdp_s='));
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/);
  const token = sc.split(';')[0];
  assert.equal((await fetch(app.base + '/pro', { headers: { cookie: token }, redirect: 'manual' })).status, 200);
  const dash = await (await fetch(app.base + '/pro', { headers: { cookie: token } })).text();
  await fetch(app.base + '/deconnexion', { method: 'POST', redirect: 'manual', headers: { cookie: token, 'content-type': 'application/x-www-form-urlencoded' }, body: `csrf=${encodeURIComponent(c.csrf(dash))}` });
  assert.equal((await fetch(app.base + '/pro', { headers: { cookie: token }, redirect: 'manual' })).status, 303, 'session détruite côté serveur');
});
test('sécurité : contenu saisi jamais exécuté (XSS)', async () => {
  const { c, t } = await signup(app, { business: 'Garage XSS', email: 'xss@test.fr' });
  await app.client().json(`/s/${t.slug}/devis`, { name: '<img src=x onerror=alert(1)>', phone: '0694112233', message: '<script>alert(2)</script>' });
  const dash = (await c.get('/pro')).text;
  assert.doesNotMatch(dash, /<img src=x|<script>alert/); assert.match(dash, /&lt;script&gt;alert\(2\)&lt;\/script&gt;/);
});
test('sécurité : double authentification limitée en tentatives', async () => {
  app.sec.resetRateLimits(); const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  const st = []; for (let i = 0; i < 12; i++) st.push((await c.submit('/connexion/2fa', '/connexion/2fa', { code: '123456' })).status);
  assert.ok(st.includes(429));
});
test('sécurité : corps de requête trop volumineux refusé', async () => {
  const r = await fetch(app.base + '/s/garage-visible/devis', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ name: 'x', message: 'a'.repeat(1_100_000) }) }).catch((e) => ({ status: 413 }));
  assert.equal(r.status, 413);
});
test('sécurité : action pro sans jeton CSRF refusée, adresses piégées sans effet', async () => {
  const { c } = await signup(app, { business: 'Garage Csrf', email: 'csrf@test.fr' });
  assert.equal((await c.post('/pro/reglages', { name: 'Pirate' })).status, 403);
  assert.equal(db.one("SELECT COUNT(*) n FROM tenants WHERE name='Pirate'").n, 0);
  assert.equal((await app.client().get("/s/x'%20OR%201=1--")).status, 404);
  assert.equal((await app.client().get('/s/%2e%2e%2fadmin')).status, 404);
});
test('sécurité : réinitialisation du mot de passe = toutes les sessions fermées', async () => {
  const { c } = await signup(app, { business: 'Garage Reset', email: 'reset@test.fr' });
  assert.equal((await c.get('/pro')).status, 200);
  await app.client().submit('/mot-de-passe-oublie', '/mot-de-passe-oublie', { email: 'reset@test.fr' });
  const url = JSON.parse(db.one("SELECT payload FROM outbox WHERE template='reset_password' AND to_addr='reset@test.fr'").payload).url; const p = new URL(url).pathname;
  await app.client().submit(p, p, { password: 'NouveauMdp2026x' });
  assert.equal((await c.get('/pro')).status, 303, 'ancienne session invalidée');
});

// ================= Paiements et activation autonome =================
test('autonomie : inscription → e-mail confirmé → essai → fin d’essai → paiement → site réactivé, sans intervention', async () => {
  const { c, t } = await signup(app, { business: 'Garage Autonome', email: 'auto@test.fr' });
  const v = JSON.parse(db.one("SELECT payload FROM outbox WHERE template='verify_email' AND to_addr='auto@test.fr'").payload).url;
  assert.match((await app.client().get(new URL(v).pathname)).text, /Adresse confirmée/);
  assert.equal(db.one("SELECT email_verified FROM users WHERE email='auto@test.fr'").email_verified, 1);
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 200, 'site en ligne dès l’inscription');
  db.run('UPDATE tenants SET trial_ends_at=? WHERE id=?', Date.now() + 2 * 864e5, t.id);
  await runJobs(db); assert.ok(db.one("SELECT 1 FROM outbox WHERE template='trial_ending' AND tenant_id=?", t.id), 'prévenu avant la fin de l’essai');
  db.run('UPDATE tenants SET trial_ends_at=? WHERE id=?', Date.now() - 1000, t.id);
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 503, 'essai terminé : site en pause');
  assert.equal(await hook({ id: 'evt_auto1', type: 'checkout.session.completed', data: { object: { customer: 'cus_auto', subscription: 'sub_auto', metadata: { tenant_id: String(t.id), plan: 'pro' } } } }), 200);
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 200, 'paiement reçu : site réactivé automatiquement');
  assert.match((await c.get('/pro/abonnement')).text, /Actif/);
});
test('paiements : résiliation Stripe => site mis hors ligne', async () => {
  const t = loadTenant(db, 'slug', 'garage-autonome');
  await hook({ id: 'evt_auto2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_auto', customer: 'cus_auto' } } });
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'canceled');
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 503);
});
test('paiements : changement de statut d’abonnement (impayé, réactivation) suivi', async () => {
  const { t } = await signup(app, { business: 'Garage Statut', email: 'statut@test.fr' });
  await hook({ id: 'evt_st1', type: 'customer.subscription.updated', data: { object: { id: 'sub_st', status: 'past_due', metadata: { tenant_id: String(t.id), plan: 'premium' } } } });
  let row = db.one('SELECT status, plan FROM tenants WHERE id=?', t.id); assert.deepEqual({ ...row }, { status: 'past_due', plan: 'premium' });
  await hook({ id: 'evt_st2', type: 'customer.subscription.updated', data: { object: { id: 'sub_st', status: 'active', metadata: { tenant_id: String(t.id), plan: 'premium' } } } });
  row = db.one('SELECT status FROM tenants WHERE id=?', t.id); assert.equal(row.status, 'active');
});
test('paiements : événement pour une entreprise inconnue signalé, sans plantage', async () => {
  // Paiement d'une autre activité du même compte Stripe (aucune marque ClientDirect Pro) : ignoré, pas d'incident
  assert.equal(await hook({ id: 'evt_autre', type: 'invoice.paid', data: { object: { id: 'in_autre', customer: 'cus_autre', amount_paid: 1900, lines: { data: [{ price: { lookup_key: null } }] } } } }), 200);
  assert.equal(db.one("SELECT COUNT(*) n FROM incidents WHERE kind='billing' AND message LIKE '%sans entreprise%'").n, 0);
  // Paiement marqué ClientDirect Pro mais entreprise introuvable : signalé
  assert.equal(await hook({ id: 'evt_unk', type: 'invoice.paid', data: { object: { id: 'in_unk', customer: 'cus_inconnu', amount_paid: 100, subscription_details: { metadata: { tenant_id: '999999' } } } } }), 200);
  assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='billing' AND message LIKE '%sans entreprise%'"));
});

// ================= Réservations simultanées =================
test('concurrence : 20 demandes simultanées sur 2 postes => exactement 2 réservations', async () => {
  cfg.config.rateBookMax = 1000; app.sec.resetRateLimits(); // on teste ici le verrou de réservation, pas la limite anti-abus
  const { t } = await signup(app, { business: 'Garage Foule', email: 'foule@test.fr' });
  const st = db.all('SELECT id FROM staff WHERE tenant_id=? AND active=1', t.id);
  db.run('UPDATE staff SET active=0 WHERE tenant_id=? AND id NOT IN (?,?)', t.id, st[0].id, st[1].id);
  const s = await slot(t, 3);
  const res = await Promise.all(Array.from({ length: 20 }, (_, i) => app.client().json(`/s/${t.slug}/rdv`, { date: s.day, time: s.time, serviceId: s.svc, name: 'C' + i, phone: '0694' + String(100000 + i) })));
  assert.equal(res.filter((r) => r.ok).length, 2); assert.equal(res.filter((r) => r.status === 409).length, 18);
  const rows = db.all('SELECT staff_id FROM appointments WHERE tenant_id=? AND date=? AND time=?', t.id, s.day, s.time);
  assert.equal(new Set(rows.map((r) => r.staff_id)).size, 2, 'un poste différent pour chacun');
});
test('concurrence : demandes simultanées sur des créneaux différents toutes acceptées', async () => {
  const t = loadTenant(db, 'slug', 'garage-foule'); const svc = firstSvc(t); const day = await futureDay(t.slug, svc);
  const slots = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots.slice(-6);
  const res = await Promise.all(slots.map((time, i) => app.client().json(`/s/${t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'D' + i, phone: '0694200000' })));
  assert.ok(res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok)));
});
test('concurrence : l’assistant et le site visent le même créneau => un seul gagne', async () => {
  const { t } = await signup(app, { business: 'Garage Course', email: 'course@test.fr', plan: 'premium' });
  db.run("UPDATE tenants SET status='active' WHERE id=?", t.id); // IA réservée aux abonnés payants
  db.run('UPDATE staff SET active=0 WHERE tenant_id=? AND id != (SELECT MIN(id) FROM staff WHERE tenant_id=?)', t.id, t.id);
  const s = await slot(t, 4); let step = 0;
  mock((url, opt) => {
    if (!url.includes('anthropic')) return null; step++;
    if (step === 1) return jsonResponse({ stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 't1', name: 'reserver', input: { date: s.day, heure: s.time, service_id: s.svc, nom: 'Via IA', telephone: '0694300000' } }] });
    const res = JSON.parse(JSON.parse(opt.body).messages.at(-1).content[0].content);
    return jsonResponse({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: res.ok ? res.message : 'Ce créneau vient d’être pris, je vous en propose un autre.' }] });
  });
  const [web, ia] = await Promise.all([app.client().json(`/s/${t.slug}/rdv`, { date: s.day, time: s.time, serviceId: s.svc, name: 'Via site', phone: '0694300001' }), app.client().json(`/s/${t.slug}/chat`, { q: 'je réserve', conv: 'race' })]);
  const n = db.one('SELECT COUNT(*) n FROM appointments WHERE tenant_id=? AND date=? AND time=?', t.id, s.day, s.time).n;
  assert.equal(n, 1);
  if (!web.ok) assert.match(ia.text, /confirmé|enregistrée/); else assert.match(ia.text, /pris/);
  mock();
});
