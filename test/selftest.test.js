// Autotest des 3 formules : vrai serveur HTTP local, Stripe simulé (y compris le webhook en retour).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, jsonResponse } from './helpers.js';

const app = await setup({ STRIPE_SECRET_KEY: 'sk_test_autotest', STRIPE_PRICE_ESSENTIEL: 'price_e_m', STRIPE_SETUP_ESSENTIEL: 'price_e_s', STRIPE_PRICE_PRO: 'price_p_m', STRIPE_SETUP_PRO: 'price_p_s', STRIPE_PRICE_PREMIUM: 'price_x_m', STRIPE_SETUP_PREMIUM: 'price_x_s' });
const { db } = app;
test.after(() => app.close());
const { config, PLANS } = await import('../src/config.js');
const { handleStripeEvent } = await import('../src/billing.js');
const ST = await import('../src/selftest.js');

test('autotest : inscription, site, page de paiement, paiement test et webhook pour les 3 formules', async () => {
  config.baseUrl = app.base;
  const amount = { price_e_m: 7900, price_e_s: 19900, price_p_m: 14900, price_p_s: 39900, price_x_m: 24900, price_x_s: 59900 };
  let n = 0; const deleted = [];
  app.net.setFetch(async (url, opt = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com/')) return app.realFetch(url, opt);
    const p = new URLSearchParams(opt.body || ''); const path = u.replace('https://api.stripe.com/v1/', '').split('?')[0];
    if (opt.method === 'DELETE') { deleted.push(path); return jsonResponse({ deleted: true }); }
    if (path === 'checkout/sessions') return jsonResponse({ id: 'cs_test', url: 'https://checkout.stripe.com/c/pay/cs_test' });
    if (path === 'customers') return jsonResponse({ id: `cus_${++n}` });
    if (path.startsWith('payment_methods/')) return jsonResponse({ id: `pm_${n}` });
    if (path.startsWith('customers/')) return jsonResponse({ id: path.split('/')[1] });
    if (path === 'subscriptions') {
      const tid = p.get('metadata[tenant_id]'); const plan = p.get('metadata[plan]');
      const total = amount[p.get('items[0][price]')] + amount[p.get('add_invoice_items[0][price]')];
      const k = ++n; const inv = { id: `in_${k}`, status: 'paid', amount_paid: total, currency: 'eur', customer: p.get('customer'), subscription_details: { metadata: { tenant_id: tid, plan } } };
      // Stripe envoie ensuite le webhook au serveur
      setTimeout(() => { handleStripeEvent(db, { id: `evt_s_${k}`, type: 'customer.subscription.created', data: { object: { id: `sub_${tid}`, status: 'active', metadata: { tenant_id: tid, plan } } } }); handleStripeEvent(db, { id: `evt_i_${k}`, type: 'invoice.paid', data: { object: inv } }); }, 50);
      return jsonResponse({ id: `sub_${tid}`, status: 'active', latest_invoice: inv });
    }
    if (opt.method === 'DELETE') { deleted.push(path); return jsonResponse({ deleted: true }); }
    return jsonResponse({}, 404);
  });
  const r = await ST.runSelfTest(db);
  for (const f of r.formules) assert.equal(f.ok, true, `${f.formule} : ${JSON.stringify(f.etapes)}`);
  assert.equal(r.ok, true);
  assert.equal(deleted.filter((d) => d.startsWith('customers/')).length, 3, 'clients Stripe de test supprimés');
  const ess = r.formules.find((f) => f.formule === 'Essentiel');
  assert.match(ess.etapes.find((e) => e.etape === 'Site professionnel').detail, /non inclus/);
  assert.match(r.formules.find((f) => f.formule === 'Pro').etapes.find((e) => e.etape === 'Site professionnel').detail, /rendez-vous ✓/);
  assert.match(ess.etapes.find((e) => e.etape === 'Paiement test').detail, /278\.00 €/);
  // Comptes de test exclus des statistiques commerciales
  assert.equal(db.one("SELECT COUNT(*) n FROM tenants WHERE source='autotest'").n, 0, 'comptes de test supprimés entièrement');
  assert.equal(db.one("SELECT COUNT(*) n FROM users WHERE email LIKE 'autotest+%'").n, 0, 'utilisateurs supprimés : adresses réutilisables');
  assert.equal(db.one("SELECT COUNT(*) n FROM invoices").n, 0);
  const h = await (await app.realFetch(app.base + '/health')).json();
  assert.equal(h.ready.autotest.ok, true); assert.equal(Object.values(h.ready.comptes).reduce((a, b) => a + b, 0), 0);
  assert.ok(PLANS.premium);
});

test('autotest refusé avec une clé Stripe réelle', async () => {
  const k = config.stripeKey; config.stripeKey = 'sk_live_x';
  try { const r = await ST.runSelfTest(db); assert.equal(r.ok, false); assert.match(r.refuse, /mode test/); } finally { config.stripeKey = k; }
});
