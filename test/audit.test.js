// Non-régression des anomalies relevées par l'audit du 27/11/2026
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup } from './helpers.js';

const app = await setup({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t' });
const { db } = app;
test.after(() => app.close());
const U = await import('../src/util.js');
const B = await import('../src/booking.js');
const S = await import('../src/billing.js');
const { ruleAnswer } = await import('../src/ai.js');
const { loadTenant } = await import('../src/tenants.js');
const { clientIp } = await import('../src/app.js');
const { totpOk, totpCode, newTotpSecret, issueToken, useToken } = app.sec;

test('annuaire vide : hors plan du site et non indexé', async () => {
  const c = app.client();
  assert.doesNotMatch((await c.get('/sitemap.xml')).text, /\/annuaire/);
  assert.match((await c.get('/annuaire')).text, /noindex/);
});

test('dates impossibles refusées (plus de double réservation via 2027-02-30)', () => {
  assert.equal(U.isDate('2027-02-30'), false); assert.equal(U.isDate('2026-13-01'), false); assert.equal(U.isDate('2028-02-29'), true);
});

test('réservation : horizon maximal de 180 jours', async () => {
  const { t } = await signup(app, { business: 'Garage Horizon', email: 'horizon@test.fr' });
  const tn = loadTenant(db, 'id', t.id); const far = U.addDays(U.nowIn(tn.tz).date, 200);
  assert.deepEqual(B.freeSlots(db, tn, far, tn.services[0].id), []);
  const r = B.book(db, tn, { date: far, time: '09:00', serviceId: tn.services[0].id, name: 'A', phone: '0694000001' });
  assert.equal(r.ok, false);
});

test('Stripe : la formule suit le tarif de l’abonnement, un autre abonnement ne dégrade pas le compte', async () => {
  const { t } = await signup(app, { business: 'Garage Portail', email: 'portail@test.fr' });
  db.run("UPDATE tenants SET status='active', plan='pro', stripe_customer='cus_P', stripe_sub='sub_A' WHERE id=?", t.id);
  assert.equal(S.planOfSub({ items: { data: [{ price: { lookup_key: 'cdp_premium_month_eur' } }] }, metadata: { plan: 'pro' } }), 'premium');
  S.handleStripeEvent(db, { id: 'ev_a1', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', customer: 'cus_P', status: 'active', metadata: { plan: 'pro' }, items: { data: [{ price: { lookup_key: 'cdp_premium_month_eur' } }] } } } });
  assert.equal(db.one('SELECT plan FROM tenants WHERE id=?', t.id).plan, 'premium', 'changement fait dans l’espace client Stripe pris en compte');
  S.handleStripeEvent(db, { id: 'ev_a2', type: 'customer.subscription.updated', data: { object: { id: 'sub_OLD', customer: 'cus_P', status: 'past_due' } } });
  S.handleStripeEvent(db, { id: 'ev_a3', type: 'customer.subscription.deleted', data: { object: { id: 'sub_OLD', customer: 'cus_P', status: 'canceled' } } });
  S.handleStripeEvent(db, { id: 'ev_a4', type: 'invoice.payment_failed', data: { object: { id: 'in_x', customer: 'cus_P', subscription: 'sub_OLD' } } });
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'active');
  S.handleStripeEvent(db, { id: 'ev_a5', type: 'invoice.payment_failed', data: { object: { id: 'in_y', customer: 'cus_P', subscription: 'sub_A' } } });
  const x = db.one('SELECT status, past_due_since FROM tenants WHERE id=?', t.id);
  assert.equal(x.status, 'past_due'); assert.ok(Math.abs(x.past_due_since - Date.now()) < 5000, 'délai de grâce compté depuis l’impayé');
});

test('impayé : pas de second abonnement, renvoi vers l’espace client', async () => {
  const { c, t } = await signup(app, { business: 'Garage Impaye', email: 'impaye@test.fr' });
  db.run("UPDATE tenants SET status='past_due', stripe_customer='cus_I', stripe_sub='sub_I' WHERE id=?", t.id);
  let seen = ''; app.net.setFetch(async (url) => { seen = String(url); return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session' }), { status: 200 }); });
  const page = await c.get('/pro/abonnement');
  const r = await c.post('/pro/abonnement/checkout', { csrf: c.csrf(page.text), plan: 'pro', cgv: 'on' });
  assert.equal(r.status, 303); assert.match(r.location, /billing\.stripe\.com/); assert.match(seen, /billing_portal/); assert.doesNotMatch(seen, /checkout/);
});

test('assistant : salutation, formule Essentiel sans promesse de réservation, « demain matin »', async () => {
  const { t } = await signup(app, { business: 'Salon Essentiel', email: 'ess@test.fr', tpl: 'coiffeur', plan: 'essentiel' });
  const tn = loadTenant(db, 'id', t.id);
  assert.match(ruleAnswer(db, tn, 'Bonjour'), /Bonjour !/);
  assert.match(ruleAnswer(db, tn, 'je voudrais un rendez-vous demain'), /n’est pas proposée/);
  assert.doesNotMatch(ruleAnswer(db, tn, 'combien coûte une coupe homme ?'), /réserver en ligne/);
  assert.doesNotMatch(tn.lead, /[Rr]éserv/, 'phrase d’accueil sans réservation');
  assert.match(ruleAnswer(db, tn, 'où êtes-vous ?'), /Vous nous trouvez à/);
  const { t: t2 } = await signup(app, { business: 'Salon Pro', email: 'pro2@test.fr', tpl: 'coiffeur', plan: 'pro' });
  const tp = loadTenant(db, 'id', t2.id); const tomorrow = U.addDays(U.nowIn(tp.tz).date, 1);
  const a = ruleAnswer(db, tp, 'avez-vous de la place demain matin ?');
  if (tp.hours[U.dowOf(tomorrow)]) { assert.match(a, /\d/); for (const h of a.match(/\b(\d{1,2})[:h]\d{2}\b/g) || []) assert.ok(Number(h.split(/[:h]/)[0]) < 12, a); }
});

test('lien d’annulation valable aussi dans la confirmation et le rappel', async () => {
  const { t } = await signup(app, { business: 'Garage Annule', email: 'annule@test.fr' });
  const tn = loadTenant(db, 'id', t.id); let d = U.addDays(U.nowIn(tn.tz).date, 3); while (!tn.hours[U.dowOf(d)]) d = U.addDays(d, 1);
  const r = B.book(db, tn, { date: d, time: B.freeSlots(db, tn, d, tn.services[0].id)[0], serviceId: tn.services[0].id, name: 'A', phone: '0694000001' });
  assert.ok(r.ok); const link = B.apptCancelToken(r.id);
  assert.equal(B.cancelByCustomer(db, link.replace(/.$/, (c) => (c === '0' ? '1' : '0'))).ok, false, 'lien falsifié refusé');
  assert.equal(B.cancelByCustomer(db, link).ok, true);
});

test('adresse IP : X-Forwarded-For falsifié ignoré, Cloudflare reconnu', () => {
  const r = (xf, cf) => ({ headers: { 'x-forwarded-for': xf, 'cf-connecting-ip': cf }, socket: { remoteAddress: '10.0.0.5' } });
  assert.equal(clientIp(r('1.1.1.1, 6.6.6.6', '9.9.9.9'), true), '6.6.6.6');
  assert.equal(clientIp(r('1.1.1.1, 172.70.1.2', '5.6.7.8'), true), '5.6.7.8');
});

test('2FA : un code ne peut pas être rejoué ; un nouveau lien de réinitialisation annule l’ancien', () => {
  const s = newTotpSecret(); const code = totpCode(s);
  assert.equal(totpOk(s, code, Date.now(), 999), true); assert.equal(totpOk(s, code, Date.now(), 999), false);
  db.run("INSERT INTO users(email,pass_hash,role,created_at) VALUES('reset@test.fr','x','pro',?)", Date.now());
  const uid = db.one("SELECT id FROM users WHERE email='reset@test.fr'").id;
  const a = issueToken(db, 'reset', { userId: uid }); const b = issueToken(db, 'reset', { userId: uid });
  assert.equal(useToken(db, 'reset', a, { consume: false }), null); assert.ok(useToken(db, 'reset', b, { consume: false }));
});

test('export CSV : formules neutralisées', () => {
  assert.equal(U.csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`); assert.equal(U.csvCell('-12.5'), '"-12.5"');
});

test('accueil : « Recommandé », balises de partage, données structurées, police locale, favicon', async () => {
  const c = app.client(); const h = (await c.get('/')).text;
  assert.match(h, /Recommandé/); assert.doesNotMatch(h, /Le plus choisi/);
  assert.match(h, /og:image/); assert.match(h, /twitter:card/); assert.match(h, /"@type":"FAQPage"/); assert.match(h, /hreflang="x-default"/);
  assert.doesNotMatch(h, /fonts\.googleapis/); assert.match(h, /favicon\.svg/); assert.match(h, /apercu-fr\.webp/);
  assert.equal((await c.get('/favicon.svg')).status, 200);
  const robots = (await c.get('/robots.txt')).text; assert.doesNotMatch(robots, /inscription|connexion/);
  assert.match((await c.get('/connexion')).text, /name="robots" content="noindex"/);
});

test('langue : le changement de langue conserve le pays choisi, mémorisé par cookie', async () => {
  const c = app.client(); const h = (await c.get('/?pays=CA')).text;
  assert.match(h, /href="\/\?pays=CA&amp;lang=en"/); assert.equal(c.jar.pays, 'CA');
  assert.match((await c.get('/')).text, /data-cur="CAD"/);
});

test('domaine propre : jamais servi sans vérification', async () => {
  const { t } = await signup(app, { business: 'Garage Domaine', email: 'dom@test.fr' });
  db.run("UPDATE tenants SET custom_domain='www.exemple-pirate.fr', domain_status='manual' WHERE id=?", t.id);
  const { tenantByDomain } = await import('../src/domains.js');
  assert.equal(tenantByDomain(db, 'www.exemple-pirate.fr'), undefined);
});

test('devis : accusé de réception envoyé au client', async () => {
  const { t } = await signup(app, { business: 'Plomberie Devis', email: 'devis@test.fr' });
  const c = app.client(); const site = await c.get(`/s/${t.slug}`);
  const r = await c.post(`/s/${t.slug}/devis`, { csrf: c.csrf(site.text), name: 'Client', phone: '0694000002', email: 'client@exemple.fr', service: 'Vidange', message: 'Bonjour' });
  assert.equal(r.status, 200);
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='quote_ack' AND to_addr='client@exemple.fr'"));
});
