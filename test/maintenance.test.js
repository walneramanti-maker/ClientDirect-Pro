// Migration sans perte : maintenance (écritures bloquées), dernière sauvegarde, test de restauration de cette sauvegarde.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { setup, signup } from './helpers.js';

const store = new Map();
const storage = http.createServer((req, res) => {
  let body = []; req.on('data', (d) => body.push(d)); req.on('end', () => {
    body = Buffer.concat(body); const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer svc_key') { res.writeHead(401); return res.end('{}'); }
    if (u.pathname.startsWith('/storage/v1/object/list/')) { const { prefix } = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify([...store.keys()].filter((k) => k.startsWith('backups/' + prefix)).map((k) => ({ name: k.split('/').pop(), created_at: new Date().toISOString() })))); }
    const key = u.pathname.replace('/storage/v1/object/', '');
    if (req.method === 'POST') { store.set(key, body); res.writeHead(200); return res.end('{}'); }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end('[]'); }
    if (store.has(key)) { res.writeHead(200); return res.end(store.get(key)); }
    res.writeHead(404); res.end('{}');
  });
});
await new Promise((r) => storage.listen(0, '127.0.0.1', r));
const app = await setup({ SUPABASE_URL: `http://127.0.0.1:${storage.address().port}`, SUPABASE_SERVICE_KEY: 'svc_key', BACKUP_KEY: 'k'.repeat(40), STRIPE_WEBHOOK_SECRET: 'whsec_m' });
app.net.setFetch(app.realFetch);
test.after(async () => { await app.close(); storage.close(); });
const { db } = app;

async function admin() {
  const secret = app.sec.newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?) ON CONFLICT(email) DO UPDATE SET totp_secret=excluded.totp_secret", app.sec.hashPassword('AdminTresLong2026'), secret, Date.now());
  app.sec.resetRateLimits(); const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  await c.submit('/connexion/2fa', '/connexion/2fa', { code: app.sec.totpCode(secret) });
  return c;
}

test('maintenance : dernière sauvegarde vérifiée, plus aucune écriture client, Stripe invité à renvoyer, puis réouverture', async () => {
  await signup(app, { business: 'Garage Avant Migration', email: 'avant@test.fr' });
  const a = await admin();
  const on = await a.submit('/admin/pret', '/admin/maintenance', { on: '1' });
  assert.equal(on.status, 303); const msg = decodeURIComponent(on.location.split('msg=')[1]);
  assert.match(msg, /restauration vérifiée/); assert.match(msg, /Vous pouvez migrer/);
  assert.ok([...store.keys()].some((k) => k.includes('cdp-')), 'sauvegarde envoyée hors du serveur');
  // Écritures refusées : inscription, webhook Stripe (503 : Stripe renverra plus tard)
  app.sec.resetRateLimits();
  const c = app.client(); const p = await c.get('/inscription');
  const r = await c.post('/inscription', { csrf: c.csrf(p.text), business: 'Pendant', tpl: 'garage', city: 'Cayenne', phone: '0694000002', plan: 'pro', name: 'X', email: 'pendant@test.fr', password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(r.status, 503); assert.match(r.text, /Maintenance en cours/);
  assert.equal(db.one("SELECT COUNT(*) n FROM users WHERE email='pendant@test.fr'").n, 0);
  const raw = JSON.stringify({ id: 'evt_m', type: 'invoice.paid', data: { object: { id: 'in_m', customer: 'cus_m' } } }); const ts = Math.floor(Date.now() / 1000);
  const wh = await fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${crypto.createHmac('sha256', 'whsec_m').update(`${ts}.${raw}`).digest('hex')}` }, body: raw });
  assert.equal(wh.status, 503); assert.equal(wh.headers.get('retry-after'), '300');
  assert.equal(db.one("SELECT 1 x FROM webhook_events WHERE id='evt_m'"), undefined, 'événement non consommé : Stripe le renverra');
  const { runJobs } = await import('../src/jobs.js'); assert.deepEqual(await runJobs(db), { maintenance: true });
  assert.equal((await (await fetch(app.base + '/health')).json()).ready.maintenance, true);
  // Consultation toujours possible
  assert.equal((await app.client().get('/')).status, 200);
  // Réouverture
  const off = await a.submit('/admin/pret', '/admin/maintenance', { on: '0' }); assert.match(decodeURIComponent(off.location), /désactivée/);
  await signup(app, { business: 'Garage Apres Migration', email: 'apres@test.fr' });
});

test('tableau de bord quotidien : inscriptions, nouveaux abonnés, revenus, dépenses et bénéfice (comptes de test exclus)', async () => {
  const { dailyReport } = await import('../src/daily.js');
  const { t } = await signup(app, { business: 'Garage Payant', email: 'payant@test.fr' });
  const { t: auto } = await signup(app, { business: 'Autotest X', email: 'autox@test.fr' });
  db.run("UPDATE tenants SET source='autotest' WHERE id=?", auto.id);
  const now = Date.now(); const m = new Date(now).toISOString().slice(0, 7);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,?,54800,'eur','paid',?,?)", t.id, 'in_d1', now, now);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,?,84800,'eur','paid',?,?)", auto.id, 'in_auto', now, now);
  db.run("UPDATE tenants SET status='active' WHERE id=?", t.id);
  db.run("INSERT INTO expenses(label,amount_cents,month,recurring,created_at) VALUES('Render Starter + disque',700,?,1,?)", m, now);
  const d = dailyReport(db, { now });
  const today = d.jours[0];
  assert.equal(today.revenus, 548, 'la facture de test (848 €) est exclue');
  assert.equal(today.nouveauxAbonnes, 1); assert.ok(today.inscriptions >= 2);
  assert.equal(today.fraisStripe, Math.round((548 * 0.022 + 0.25) * 100) / 100);
  assert.ok(today.fraisFixes > 0 && today.fraisFixes < 1, 'frais fixes répartis par jour');
  assert.equal(today.benefice, Math.round((548 - today.fraisStripe - today.fraisFixes) * 100) / 100);
  const a = await admin(); const page = await a.get('/admin/journal');
  assert.equal(page.status, 200); assert.match(page.text, /Tableau de bord quotidien/); assert.match(page.text, /548 €/);
});
