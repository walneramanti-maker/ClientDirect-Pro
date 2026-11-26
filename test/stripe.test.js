// Stripe en mode test : configuration automatique (produits, prix par devise, webhook) puis paiement dans la devise du client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ STRIPE_SECRET_KEY: 'sk_test_auto', BASE_URL: 'https://cdp-test.example.com' });
test.after(() => app.close());
const billing = await import('../src/billing.js');
const cfg = await import('../src/config.js');
// Faux Stripe en mémoire
const S = { products: [], prices: [], hooks: [], calls: [] };
app.net.setFetch(async (url, opt = {}) => {
  const u = new URL(url); const p = u.pathname.replace('/v1/', ''); const body = new URLSearchParams(opt.body || ''); S.calls.push({ p, method: opt.method, body: Object.fromEntries(body), auth: opt.headers?.authorization });
  if (p === 'prices' && opt.method === 'GET') { const k = u.searchParams.get('lookup_keys[0]'); return jsonResponse({ data: S.prices.filter((x) => x.lookup_key === k) }); }
  if (p === 'products/search') { const m = /cdp_plan'\]:'(\w+)'/.exec(u.searchParams.get('query')); return jsonResponse({ data: S.products.filter((x) => x.metadata.cdp_plan === m[1]) }); }
  if (p === 'products') { const x = { id: 'prod_' + S.products.length, metadata: { cdp_plan: body.get('metadata[cdp_plan]') } }; S.products.push(x); return jsonResponse(x); }
  if (p === 'prices') { const x = { id: 'price_' + S.prices.length, lookup_key: body.get('lookup_key'), currency: body.get('currency'), unit_amount: Number(body.get('unit_amount')), recurring: body.get('recurring[interval]') }; S.prices.push(x); return jsonResponse(x); }
  if (p === 'webhook_endpoints' && opt.method === 'GET') return jsonResponse({ data: S.hooks });
  if (p === 'webhook_endpoints') { const x = { id: 'we_1', url: body.get('url'), secret: 'whsec_auto_123', events: [...body.entries()].filter(([k]) => k.startsWith('enabled_events')).map(([, v]) => v) }; S.hooks.push(x); return jsonResponse(x); }
  if (p === 'checkout/sessions') return jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' });
  return jsonResponse({ error: { message: 'inconnu ' + p } }, 404);
});

test('Stripe test : produits, 24 prix (3 formules × 4 devises × mensuel/mise en service) et webhook créés seuls', async () => {
  const r = await billing.ensureStripe(app.db);
  assert.equal(r.created, 24); assert.equal(S.products.length, 3); assert.equal(r.webhook, 'créé');
  const cad = S.prices.find((x) => x.lookup_key === 'cdp_pro_month_cad'); assert.equal(cad.unit_amount, 21900); assert.equal(cad.recurring, 'month');
  assert.equal(S.prices.find((x) => x.lookup_key === 'cdp_premium_setup_eur').unit_amount, 59900);
  assert.equal(S.hooks[0].url, 'https://cdp-test.example.com/webhooks/stripe'); assert.ok(S.hooks[0].events.includes('invoice.payment_failed'));
  assert.ok(S.calls.every((c) => c.auth === 'Bearer sk_test_auto'));
});
test('Stripe test : relancer la configuration ne crée aucun doublon', async () => {
  const r = await billing.ensureStripe(app.db); assert.equal(r.created, 0); assert.equal(r.existing, 24); assert.equal(S.prices.length, 24); assert.equal(S.hooks.length, 1);
});
test('Stripe : configuration automatique refusée avec une clé réelle', async () => {
  const prev = cfg.config.stripeKey; cfg.config.stripeKey = 'sk_live_reel';
  try { const r = await billing.ensureStripe(app.db); assert.match(r.skipped, /Clé réelle/); } finally { cfg.config.stripeKey = prev; }
});
test('Stripe test : le paiement utilise la devise du client et le secret du webhook créé automatiquement', async () => {
  const { c, t } = await signup(app, { business: 'Garage Devise', email: 'devise@test.fr' });
  app.db.run("UPDATE tenants SET currency='CAD', country='GF' WHERE id=?", t.id);
  S.calls = []; const page = await c.get('/pro/abonnement');
  const r = await c.post('/pro/abonnement/checkout', { csrf: c.csrf(page.text), plan: 'pro' });
  assert.equal(r.status, 303);
  const call = S.calls.find((x) => x.p === 'checkout/sessions');
  assert.equal(call.body['line_items[0][price]'], S.prices.find((x) => x.lookup_key === 'cdp_pro_month_cad').id);
  assert.equal(call.body['line_items[1][price]'], S.prices.find((x) => x.lookup_key === 'cdp_pro_setup_cad').id);
  assert.equal(call.body['tax_id_collection[enabled]'], 'true', 'numéro de TVA / TPS demandé au client professionnel');
  const raw = JSON.stringify({ id: 'evt_a', type: 'checkout.session.completed', data: { object: { customer: 'cus_a', metadata: { tenant_id: String(t.id), plan: 'pro' } } } });
  const ts = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', 'whsec_auto_123').update(`${ts}.${raw}`).digest('hex');
  const res = await fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw });
  assert.equal(res.status, 200); assert.equal(app.db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'active');
});
const hook = async (obj) => {
  const raw = JSON.stringify(obj); const ts = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', 'whsec_auto_123').update(`${ts}.${raw}`).digest('hex');
  return fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw });
};
test('Stripe : une résiliation tardive d’un compte supprimé n’annule pas le nouveau compte qui reprend son numéro (bug formule Pro)', async () => {
  const { purgeTestTenant } = await import('../src/privacy.js');
  const { t: old } = await signup(app, { business: 'Ancien Essentiel', email: 'ancien@test.fr', plan: 'essentiel' });
  app.db.run("UPDATE tenants SET stripe_customer='cus_ancien', source='autotest' WHERE id=?", old.id);
  await purgeTestTenant(app.db, old.id);
  const { t: neuf } = await signup(app, { business: 'Nouveau Pro', email: 'nouveau@test.fr', plan: 'pro' });
  assert.equal(neuf.id, old.id, 'SQLite réattribue le même numéro : c’est la condition du bug');
  const r = await hook({ id: 'evt_del_ancien', type: 'customer.subscription.deleted', data: { object: { id: 'sub_ancien', customer: 'cus_ancien', status: 'canceled', metadata: { tenant_id: String(old.id), plan: 'essentiel' } } } });
  assert.equal(r.status, 200);
  const after = app.db.one('SELECT status, plan FROM tenants WHERE id=?', neuf.id);
  assert.deepEqual({ ...after }, { status: 'trial', plan: 'pro' });
});
test('Stripe : renouvellement, échec de paiement, remboursement et résiliation du bon client', async () => {
  const { t } = await signup(app, { business: 'Cycle Complet', email: 'cycle@test.fr', plan: 'pro' });
  app.db.run("UPDATE tenants SET stripe_customer='cus_cycle', stripe_sub='sub_cycle' WHERE id=?", t.id);
  const st = () => app.db.one('SELECT status FROM tenants WHERE id=?', t.id).status;
  await hook({ id: 'evt_c1', type: 'invoice.paid', data: { object: { id: 'in_c1', customer: 'cus_cycle', amount_paid: 54800, currency: 'eur', lines: { data: [{ period: { end: 1800000000 } }] } } } });
  assert.equal(st(), 'active'); assert.equal(app.db.one("SELECT amount_cents FROM invoices WHERE stripe_invoice='in_c1'").amount_cents, 54800);
  await hook({ id: 'evt_c2', type: 'invoice.payment_failed', data: { object: { id: 'in_c2', customer: 'cus_cycle' } } }); assert.equal(st(), 'past_due');
  await hook({ id: 'evt_c3', type: 'invoice.paid', data: { object: { id: 'in_c3', customer: 'cus_cycle', amount_paid: 14900, currency: 'eur' } } }); assert.equal(st(), 'active', 'renouvellement payé après un échec');
  const r4 = await hook({ id: 'evt_c4', type: 'charge.refunded', data: { object: { id: 'ch_c4', customer: 'cus_cycle', invoice: 'in_c3' } } }); assert.equal(r4.status, 200);
  assert.ok(app.db.one("SELECT 1 FROM audit WHERE tenant_id=? AND action='paiement.rembourse'", t.id));
  // Un échec de paiement d'un AUTRE client portant ce numéro en métadonnée ne touche pas ce compte
  await hook({ id: 'evt_c5', type: 'invoice.payment_failed', data: { object: { id: 'in_x', customer: 'cus_autre', subscription_details: { metadata: { tenant_id: String(t.id) } } } } }); assert.equal(st(), 'active');
  await hook({ id: 'evt_c6', type: 'customer.subscription.deleted', data: { object: { id: 'sub_cycle', customer: 'cus_cycle', status: 'canceled', metadata: { tenant_id: String(t.id) } } } }); assert.equal(st(), 'canceled');
});
