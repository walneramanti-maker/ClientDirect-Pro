import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ STRIPE_SECRET_KEY: 'sk_test_r', STRIPE_WEBHOOK_SECRET: 'whsec_r', STRIPE_PRICE_PRO: 'price_pro', STRIPE_SETUP_PRO: 'price_setup', ADMIN_EMAIL: 'admin@cdp.fr' });
const { db } = app;
test.after(() => app.close());
const R = await import('../src/rewards.js');
const hook = async (ev) => { const raw = JSON.stringify(ev); const ts = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', 'whsec_r').update(`${ts}.${raw}`).digest('hex'); return (await fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw })).status; };
let evn = 0; const ev = (type, object) => ({ id: `evt_r${++evn}`, type, data: { object } });

async function viaLink(ref, { business, email, plan = 'pro' }) {
  app.sec.resetRateLimits();
  const v = app.client(); await v.get(`/?ref=${ref}`);
  const r = await v.submit('/inscription', '/inscription', { business, tpl: 'garage', city: 'Lyon', tz: 'Europe/Paris', plan, name: 'X', email, password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(r.status, 303);
  return db.one('SELECT t.* FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email=?', email);
}

test('parrainage : rien tant que le filleul ne paie pas, un mois chacun après paiement et 30 jours', async () => {
  const { c, t: parrain } = await signup(app, { business: 'Garage Parrain', email: 'parrain@r.fr' });
  db.run("UPDATE tenants SET status='active', stripe_customer='cus_parrain' WHERE id=?", parrain.id);
  const dash = await c.get('/pro'); assert.match(dash.text, /Parrainez un professionnel/); assert.match(dash.text, new RegExp(`\\?ref=${parrain.slug}`));
  const filleul = await viaLink(parrain.slug, { business: 'Garage Filleul', email: 'filleul@r.fr' });
  assert.equal(filleul.referred_by_tenant_id, parrain.id);
  assert.equal(db.one('SELECT COUNT(*) n FROM rewards').n, 0, 'inscription seule : aucune récompense');
  await hook(ev('checkout.session.completed', { customer: 'cus_filleul', subscription: 'sub_f', metadata: { tenant_id: String(filleul.id), plan: 'pro' } }));
  await hook(ev('invoice.paid', { id: 'in_f1', customer: 'cus_filleul', amount_paid: 54800, total_excluding_tax: 54800, currency: 'eur' }));
  const rw = db.all('SELECT * FROM rewards ORDER BY id');
  assert.deepEqual(rw.map((r) => [r.kind, r.amount_cents, r.status]), [['credit', 14900, 'pending'], ['credit_referee', 14900, 'pending']]);
  // deuxième facture : pas de nouveau mois offert
  await hook(ev('invoice.paid', { id: 'in_f2', customer: 'cus_filleul', amount_paid: 14900, currency: 'eur' }));
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE kind LIKE 'credit%'").n, 2);
  // avant 30 jours : rien n'est appliqué
  const calls = [];
  const stripeCall = async (path, params) => { calls.push({ path, params }); return { id: 'cbtxn_' + calls.length }; };
  assert.deepEqual(await R.processRewards(db, { stripeCall }), { approved: 0, applied: 0, canceled: 0 });
  const later = Date.now() + 31 * 864e5;
  const res = await R.processRewards(db, { now: later, stripeCall });
  assert.equal(res.applied, 2);
  assert.deepEqual(calls.map((x) => [x.path, x.params.amount]), [['customers/cus_parrain/balance_transactions', -14900], ['customers/cus_filleul/balance_transactions', -14900]]);
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE status='paid'").n, 2);
});

test('parrainage : remboursement pendant l’attente, récompenses annulées', async () => {
  const { t: p2 } = await signup(app, { business: 'Coiffure Parrain', email: 'p2@r.fr', tpl: 'coiffeur' });
  db.run("UPDATE tenants SET status='active' WHERE id=?", p2.id);
  const f2 = await viaLink(p2.slug, { business: 'Coiffure Filleul', email: 'f2@r.fr' });
  db.run("UPDATE tenants SET stripe_customer='cus_f2', status='active' WHERE id=?", f2.id);
  await hook(ev('invoice.paid', { id: 'in_f2a', customer: 'cus_f2', amount_paid: 54800, currency: 'eur' }));
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE invoice='in_f2a' AND status='pending'").n, 2);
  await hook(ev('charge.refunded', { id: 'ch_1', customer: 'cus_f2', invoice: 'in_f2a' }));
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE invoice='in_f2a' AND status='canceled'").n, 2);
  const r = await R.processRewards(db, { now: Date.now() + 40 * 864e5, stripeCall: async () => ({}) });
  assert.equal(r.applied, 0);
});

test('parrainage : on ne se parraine pas soi-même', async () => {
  const { t } = await signup(app, { business: 'Solo Garage', email: 'solo@r.fr' });
  app.sec.resetRateLimits();
  const v = app.client(); await v.get(`/?ref=${t.slug}`);
  // même adresse e-mail que le parrain : refusée à l'inscription (compte existant), donc aucun rattachement possible
  const r = await v.submit('/inscription', '/inscription', { business: 'Solo Bis', tpl: 'garage', city: 'Lyon', plan: 'pro', name: 'X', email: 'solo@r.fr', password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(r.status, 400);
});

test('partenaires : candidature, validation, lien suivi, 20 % du HT encaissé, versement manuel', async () => {
  app.sec.resetRateLimits();
  const pub = app.client(); const page = await pub.get('/partenaires');
  assert.match(page.text, /20 %/); assert.match(page.text, /437,40/);
  const bad = await pub.post('/partenaires', { csrf: pub.csrf(page.text), name: 'A', company: '', email: 'x' }); assert.equal(bad.status, 400);
  const ok = await pub.post('/partenaires', { csrf: pub.csrf(page.text), name: 'Claire Compta', company: 'Cabinet Compta Lyon', email: 'claire@compta.fr', phone: '0478000000', siret: '12345678900012', activity: 'Agence ou consultant', certify: 'on', cgu: 'on' });
  assert.equal(ok.status, 200); assert.match(ok.text, /candidature est enregistrée/);
  const p = db.one("SELECT * FROM partners WHERE email='claire@compta.fr'"); assert.equal(p.status, 'pending');
  const { link, dashboard } = R.approvePartner(db, p.id);
  const code = /ref=p-(\w+)/.exec(link)[1];
  const client = await viaLink(`p-${code}`, { business: 'Garage Compta', email: 'gc@r.fr' });
  assert.equal(client.partner_id, p.id); assert.equal(client.source, `partner:${code}`);
  db.run("UPDATE tenants SET stripe_customer='cus_gc', status='active' WHERE id=?", client.id);
  // 548 € TTC dont 109,60 € de TVA : commission sur le HT (438,40 €) → 87,68 €
  await hook(ev('invoice.paid', { id: 'in_gc1', customer: 'cus_gc', amount_paid: 54800, tax: 10960, currency: 'eur' }));
  const c1 = db.one("SELECT * FROM rewards WHERE kind='commission'"); assert.equal(c1.amount_cents, 8768); assert.equal(c1.status, 'pending');
  await R.processRewards(db, { now: Date.now() + 31 * 864e5, stripeCall: null });
  assert.equal(db.one('SELECT status FROM rewards WHERE id=?', c1.id).status, 'approved', 'à verser par virement, jamais automatiquement');
  const dash = await app.client().get(new URL(dashboard).pathname);
  assert.equal(dash.status, 200); assert.match(dash.text, /Cabinet Compta Lyon/); assert.match(dash.text, /87,68/);
  assert.equal((await app.client().get('/partenaire/faux-jeton-de-vingt-caracteres')).status, 404);
  // après 12 mois : plus de commission
  db.run("UPDATE invoices SET paid_at=? WHERE stripe_invoice='in_gc1'", Date.now() - 400 * 864e5);
  await hook(ev('invoice.paid', { id: 'in_gc13', customer: 'cus_gc', amount_paid: 14900, currency: 'eur' }));
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE kind='commission'").n, 1);
});

test('partenaires : expert-comptable ou CCI sans commission, et pas de commission sans SIRET', async () => {
  const ec = R.applyPartner(db, { name: 'EC', company: 'Cabinet EC', email: 'ec@x.fr', siret: '12345678900099', activity: 'Expert-comptable', certify: 'on' });
  const cci = R.applyPartner(db, { name: 'CCI', company: 'CCI Guyane', email: 'cci@x.fr', activity: 'Chambre de métiers ou CCI', certify: 'on' });
  const nosiret = R.applyPartner(db, { name: 'Ag', company: 'Agence', email: 'ag@x.fr', activity: 'Agence ou consultant', certify: 'on' });
  for (const id of [ec, cci, nosiret]) assert.equal(db.one('SELECT rate_pct FROM partners WHERE id=?', id).rate_pct, 0);
  const { link } = R.approvePartner(db, ec); const code = /ref=p-(\w+)/.exec(link)[1];
  const cl = await viaLink(`p-${code}`, { business: 'Garage EC', email: 'gec@r.fr' });
  db.run("UPDATE tenants SET stripe_customer='cus_gec', status='active' WHERE id=?", cl.id);
  await hook(ev('invoice.paid', { id: 'in_gec', customer: 'cus_gec', amount_paid: 54800, currency: 'eur' }));
  assert.equal(db.one("SELECT COUNT(*) n FROM rewards WHERE invoice='in_gec'").n, 0, 'partenaire relais : aucune commission');
  assert.match((await app.client().get('/partenaires/conditions')).text, /SIRET 944 602 226 00010|SIRET/);
});
