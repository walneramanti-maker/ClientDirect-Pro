// E-mails transactionnels (Brevo) : contenu, expéditeur, réponse, anti-doublon, plafond partagé, pannes et quotas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'ClientDirect Pro <contact@clientdirectpro.fr>', LEGAL_EMAIL: 'contact@clientdirectpro.fr', ADMIN_EMAIL: 'admin@clientdirectpro.fr', EMAIL_DAILY_MAX: '50' });
const { db } = app;
const N = await import('../src/notify.js');
const { config } = await import('../src/config.js');
const { handleStripeEvent } = await import('../src/billing.js');
const { runJobs } = await import('../src/jobs.js');
test.after(() => app.close());
let calls = [];
const brevo = (handler = () => jsonResponse({ messageId: 'm' }, 201)) => app.net.setFetch(async (url, opt = {}) => { if (String(url).includes('brevo')) { calls.push(JSON.parse(opt.body)); return handler(); } return jsonResponse({}, 200); });
const clear = () => { db.run("UPDATE outbox SET status='sent', sent_at=0 WHERE status='pending'"); calls = []; };

test('mise en forme : HTML pour téléphone, texte brut, expéditeur et réponse au nom du professionnel', async () => {
  clear(); brevo();
  N.enqueue(db, { channel: 'email', to: 'client@exemple.fr', template: 'appt_customer', payload: { lang: 'fr', tenant: 'Garage Kourou', replyTo: 'garage@kourou.fr', color: '#c81e1e', name: 'Marie', service: 'Vidange', when: 'ven. 27/11 · 9h', address: 'Kourou', status: 'confirmed', cancelUrl: 'https://clientdirectpro.fr/annuler/x' } });
  N.enqueue(db, { channel: 'email', to: 'pro@exemple.fr', template: 'welcome', payload: { lang: 'fr', tenant: 'Garage Kourou', siteUrl: 'https://clientdirectpro.fr/s/g', dashUrl: 'https://clientdirectpro.fr/pro', trialEnd: '10/12/2026' } });
  assert.equal((await N.processOutbox(db)).sent, 2);
  const [rdv, bienvenue] = calls;
  assert.equal(rdv.sender.email, 'contact@clientdirectpro.fr'); assert.equal(rdv.sender.name, 'Garage Kourou via ClientDirect Pro');
  assert.deepEqual(rdv.replyTo, { email: 'garage@kourou.fr' }, 'le client répond au professionnel');
  assert.match(rdv.htmlContent, /<meta name="viewport"/); assert.match(rdv.htmlContent, /max-width:560px/); assert.match(rdv.htmlContent, /background:#c81e1e/);
  assert.match(rdv.htmlContent, /href="https:\/\/clientdirectpro\.fr\/annuler\/x"/); assert.match(rdv.textContent, /Pour annuler/);
  assert.match(N.htmlEmail({ subject: 's', text: 'x', brand: 'G', color: '#ffcf33' }), /background:#ffcf33;color:#14161a/, 'texte foncé sur jaune');
  assert.match(N.htmlEmail({ subject: 's', text: 'x', brand: 'G', color: '#14161a' }), /background:#14161a;color:#ffffff/, 'texte blanc sur foncé');
  assert.equal(bienvenue.sender.name, 'ClientDirect Pro'); assert.deepEqual(bienvenue.replyTo, { email: 'contact@clientdirectpro.fr' });
  assert.match(bienvenue.htmlContent, /contact@clientdirectpro\.fr/, 'pied de page légal');
  assert.doesNotMatch(JSON.stringify(calls), /xkeysib/, 'la clé ne figure jamais dans le contenu');
});

test('anti-doublon : un même événement ne produit qu’un e-mail', async () => {
  clear(); brevo();
  const a = N.enqueue(db, { channel: 'email', to: 'pro@exemple.fr', template: 'payment_receipt', key: 'recu:in_1', payload: { lang: 'fr', tenant: 'G', amount: '149 €', billingUrl: 'u' } });
  const b = N.enqueue(db, { channel: 'email', to: 'pro@exemple.fr', template: 'payment_receipt', key: 'recu:in_1', payload: { lang: 'fr', tenant: 'G', amount: '149 €', billingUrl: 'u' } });
  assert.ok(a); assert.equal(b, null); await N.processOutbox(db); assert.equal(calls.length, 1);
});

test('Stripe : abonnement confirmé, reçu par facture (une fois même si Stripe renvoie), résiliation', async () => {
  clear(); brevo();
  const { t } = await signup(app, { business: 'Garage Paiement', email: 'paiement@exemple.fr' });
  db.run("UPDATE tenants SET stripe_customer='cus_p', stripe_sub='sub_p' WHERE id=?", t.id);
  handleStripeEvent(db, { id: 'evt_1', type: 'checkout.session.completed', data: { object: { customer: 'cus_p', subscription: 'sub_p', metadata: { plan: 'pro', tenant_id: t.id } } } });
  for (const id of ['evt_2', 'evt_3']) handleStripeEvent(db, { id, type: 'invoice.paid', data: { object: { id: 'in_p1', customer: 'cus_p', amount_paid: 54800, currency: 'eur', hosted_invoice_url: 'https://invoice.stripe.com/i/x' } } });
  handleStripeEvent(db, { id: 'evt_4', type: 'customer.subscription.deleted', data: { object: { id: 'sub_p', customer: 'cus_p', status: 'canceled' } } });
  const tpl = db.all("SELECT template FROM outbox WHERE tenant_id=? AND template IN ('subscription_confirmed','payment_receipt','subscription_canceled') ORDER BY id", t.id).map((r) => r.template);
  assert.deepEqual(tpl, ['subscription_confirmed', 'payment_receipt', 'subscription_canceled'], 'un seul reçu pour deux événements de la même facture');
  await N.processOutbox(db);
  const recu = calls.find((c) => /Paiement reçu/.test(c.subject)); assert.match(recu.subject, /548/); assert.match(recu.textContent, /invoice\.stripe\.com/);
  const sub = calls.filter((c) => /abonnement|Paiement reçu/i.test(c.subject)); assert.equal(sub.length, 3);
  assert.ok(sub.every((c) => c.to[0].email === 'paiement@exemple.fr'), 'au titulaire du compte');
});

test('liste blanche EMAIL_ALLOWLIST : seules les adresses autorisées reçoivent pendant les essais', async () => {
  clear(); brevo(); const before = config.emailAllowlist; config.emailAllowlist = ['@clientdirectpro.fr'];
  try {
    N.enqueue(db, { channel: 'email', to: 'contact@clientdirectpro.fr', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
    const out = N.enqueue(db, { channel: 'email', to: 'vrai.client@gmail.com', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
    const r = await N.processOutbox(db); assert.equal(r.sent, 1); assert.equal(r.skipped, 1);
    assert.match(db.one('SELECT last_error FROM outbox WHERE id=?', out).last_error, /EMAIL_ALLOWLIST/);
  } finally { config.emailAllowlist = before; }
});

test('plafond quotidien partagé (Ti-Job) : report au lendemain sans perte, priorité à l’accès au compte', async () => {
  clear(); brevo(); const before = config.emailDailyMax; config.emailDailyMax = N.emailsSentToday(db) + 1;
  try {
    const rapport = N.enqueue(db, { channel: 'email', to: 'a@x.fr', template: 'monthly_report', payload: { lang: 'fr', tenant: 'G', monthLabel: 'nov.', views: 1, requests: 0, bookings: 0, quotes: 0, wa_clicks: 0, dashUrl: 'u' } });
    const verif = N.enqueue(db, { channel: 'email', to: 'b@x.fr', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
    const r = await N.processOutbox(db); assert.equal(r.sent, 1); assert.equal(r.deferred, 1);
    assert.equal(db.one('SELECT status FROM outbox WHERE id=?', verif).status, 'sent', 'la vérification d’adresse passe en premier');
    const rep = db.one('SELECT * FROM outbox WHERE id=?', rapport); assert.equal(rep.status, 'pending'); assert.equal(rep.attempts, 0); assert.ok(rep.next_at > Date.now() + 60e3, 'reporté au lendemain');
  } finally { config.emailDailyMax = before; }
});

test('Brevo : quota (429) et clé refusée (401) reportent sans consommer d’essai ; panne : nouvel essai espacé', async () => {
  clear(); brevo(() => jsonResponse({ message: 'Too many requests' }, 429));
  const q = N.enqueue(db, { channel: 'email', to: 'q@x.fr', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
  await N.processOutbox(db); let row = db.one('SELECT * FROM outbox WHERE id=?', q); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0); assert.ok(row.next_at > Date.now());
  db.run("UPDATE outbox SET status='sent' WHERE id=?", q);
  brevo(() => jsonResponse({ message: 'Key not found' }, 401));
  const k = N.enqueue(db, { channel: 'email', to: 'k@x.fr', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
  await N.processOutbox(db); row = db.one('SELECT * FROM outbox WHERE id=?', k); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0);
  assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='send_email_key'"), 'incident « clé Brevo refusée »');
  db.run("UPDATE outbox SET status='sent' WHERE id=?", k); clear();
  app.net.setFetch(async () => { throw new Error('ECONNRESET'); });
  const p = N.enqueue(db, { channel: 'email', to: 'p@x.fr', template: 'verify_email', payload: { lang: 'fr', url: 'u' } });
  await N.processOutbox(db); row = db.one('SELECT * FROM outbox WHERE id=?', p); assert.equal(row.status, 'pending'); assert.equal(row.attempts, 1); assert.match(row.last_error, /injoignable/);
  db.run("UPDATE outbox SET status='sent' WHERE id=?", p);
});

test('tâches : rappels selon la formule, site en pause, renouvellement à 30 jours, une seule fois', async () => {
  clear(); brevo(); const now = Date.now();
  const ess = (await signup(app, { business: 'Garage Essentiel Mail', email: 'ess@exemple.fr', plan: 'essentiel' })).t;
  const pro = (await signup(app, { business: 'Garage Pro Mail', email: 'pro-mail@exemple.fr', plan: 'pro' })).t;
  for (const t of [ess, pro]) db.run("INSERT INTO appointments(tenant_id,service_name,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,starts_at,created_at) VALUES(?,'Vidange','2030-01-01','09:00',540,60,1,'P',?,'594694000000',?,'confirmed',?,?)", t.id, `Client ${t.id}`, `c${t.id}@x.fr`, now + 5 * 36e5, now);
  db.run("UPDATE tenants SET status='past_due', current_period_end=? WHERE id=?", now - 30 * 864e5, ess.id);
  db.run("UPDATE tenants SET status='active' WHERE id=?", pro.id);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,'in_renew',54800,'eur','paid',?,?)", pro.id, now - 345 * 864e5, now);
  await runJobs(db, now); await runJobs(db, now + 60e3);
  const rem = (t) => db.one("SELECT COUNT(*) n FROM outbox WHERE template='appt_reminder' AND tenant_id=? AND channel='email'", t.id).n;
  assert.equal(rem(ess), 0, 'pas de rappel en Essentiel'); assert.equal(rem(pro), 1, 'rappel en Pro, une seule fois');
  assert.equal(db.one("SELECT COUNT(*) n FROM outbox WHERE template='site_paused' AND tenant_id=?", ess.id).n, 1);
  assert.equal(db.one("SELECT COUNT(*) n FROM outbox WHERE template='renewal_reminder' AND tenant_id=?", pro.id).n, 1);
});

test('inscription : alerte à l’administrateur (pas pour les comptes de contrôle) ; aperçu des modèles sans envoi', async () => {
  const { t } = await signup(app, { business: 'Garage Nouveau', email: 'nouveau@exemple.fr' });
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='admin_new_signup' AND to_addr='admin@clientdirectpro.fr' AND dedup_key=?", `inscription:${t.id}`));
  for (const [k, p] of Object.entries(N.sampleEmails())) { const m = N.renderEmail(k, p); assert.ok(m.subject && m.text && m.html.includes('<!DOCTYPE html>'), k); }
  const { hashPassword, newTotpSecret, totpCode } = app.sec; const secret = newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", hashPassword('AdminTresLong2026'), secret, Date.now());
  app.sec.resetRateLimits(); const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' }); await c.submit('/connexion/2fa', '/connexion/2fa', { code: totpCode(secret) });
  const before = db.one('SELECT COUNT(*) n FROM outbox').n;
  const list = await c.get('/admin/emails'); assert.equal(list.status, 200); assert.match(list.text, /payment_receipt/);
  const page = await c.get('/admin/emails/appt_customer'); assert.equal(page.status, 200); assert.match(page.text, /data-from="Garage Exemple via ClientDirect Pro"/);
  assert.equal(db.one('SELECT COUNT(*) n FROM outbox').n, before, 'l’aperçu n’envoie rien');
  assert.equal((await app.client().get('/admin/emails')).status === 200, false, 'réservé à l’administrateur');
});

test('prospection : jamais par le relais SMTP de Brevo (comptes transactionnels et Ti-Job protégés)', async () => {
  const C = await import('../src/campaigns.js');
  assert.equal(C.brevoRelay('smtp-relay.brevo.com'), true); assert.equal(C.brevoRelay('smtp-relay.sendinblue.com'), true); assert.equal(C.brevoRelay('ssl0.ovh.net'), false);
  const s = { ...config.smtp }; const on = config.campaignSending;
  Object.assign(config.smtp, { host: 'smtp-relay.brevo.com', user: 'u', pass: 'p', from: 'contact@clientdirectpro.fr' }); config.campaignSending = true;
  try { assert.equal(C.sendingReady(), false); config.smtp.host = 'ssl0.ovh.net'; assert.equal(C.sendingReady(), true); } finally { Object.assign(config.smtp, s); config.campaignSending = on; }
});
