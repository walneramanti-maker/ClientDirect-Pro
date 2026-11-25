import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_t', STRIPE_PRICE_PRO: 'price_pro', STRIPE_SETUP_PRO: 'price_setup_pro', STRIPE_PRICE_PREMIUM: 'price_prem', BREVO_API_KEY: 'brevo_x', ANTHROPIC_API_KEY: 'sk-ant-x', WHATSAPP_TOKEN: 'wa_x', WHATSAPP_PHONE_ID: '123', ADMIN_EMAIL: 'admin@cdp.fr', MAIL_FROM: 'CDP <no-reply@cdp.fr>', MAKE_WEBHOOK_URL: 'https://hook.eu1.make.com/test123', MAKE_WEBHOOK_SECRET: 'make_secret', MAKE_EVENTS: 'inscription,rdv,devis,incident,paiement_recu' });
const { db } = app;
test.after(() => app.close());
const { runJobs } = await import('../src/jobs.js');
const { processOutbox } = await import('../src/notify.js');

let calls = [];
const mock = (handler) => app.net.setFetch(async (url, opt = {}) => { calls.push({ url: String(url), opt }); return handler(String(url), opt); });

test('inscription : CSRF obligatoire, validation, création automatique du site', async () => {
  const c = app.client();
  const bad = await c.post('/inscription', { business: 'X', tpl: 'garage', name: 'a', email: 'x@y.fr', password: 'Abcdefgh123', cgu: 'on', plan: 'pro' });
  assert.equal(bad.status, 403, 'refusé sans jeton CSRF');
  const inval = await c.submit('/inscription', '/inscription', { business: 'X', tpl: 'garage', name: 'a', email: 'pas-un-mail', password: 'court', plan: 'pro' });
  assert.equal(inval.status, 400); assert.match(inval.text, /Adresse e-mail invalide/); assert.match(inval.text, /10 caractères/); assert.match(inval.text, /conditions/);
  const { c: pro, t } = await signup(app);
  assert.equal(t.status, 'trial'); assert.equal(t.slug, 'garage-alpha');
  assert.equal(db.all('SELECT * FROM services WHERE tenant_id=?', t.id).length > 3, true, 'prestations du modèle garage');
  const dash = await pro.get('/pro'); assert.equal(dash.status, 200); assert.match(dash.text, /Garage Alpha/);
  const site = await app.client().get('/s/garage-alpha'); assert.equal(site.status, 200); assert.match(site.text, /Prestations et tarifs/);
  const mails = db.all("SELECT template FROM outbox WHERE to_addr='alpha@test.fr'").map((r) => r.template).sort();
  assert.deepEqual(mails, ['verify_email', 'welcome']);
  const dup = await app.client().submit('/inscription', '/inscription', { business: 'Y', tpl: 'garage', name: 'a', email: 'ALPHA@test.fr', password: 'MotDePasse2026', cgu: 'on', plan: 'pro' });
  assert.equal(dup.status, 400); assert.match(dup.text, /existe déjà/);
});

async function futureDay(slug, svc) { const r = await app.client().json(`/s/${slug}/creneaux?service=${svc}`); return r.days.find((d, i) => i > 0); }

test('réservation : pas de double réservation, même avec des demandes simultanées', async () => {
  const { t } = await signup(app, { business: 'Coiffure Solo', email: 'solo@test.fr', tpl: 'coiffeur' });
  // un seul poste
  db.run('UPDATE staff SET active=0 WHERE tenant_id=? AND id != (SELECT MIN(id) FROM staff WHERE tenant_id=?)', t.id, t.id);
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? ORDER BY id LIMIT 1', t.id).id;
  const day = await futureDay(t.slug, svc);
  const slots = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots;
  const time = slots[2];
  const body = (n) => ({ date: day, time, serviceId: svc, name: 'Client ' + n, phone: '0694112233' });
  const results = await Promise.all([1, 2, 3, 4, 5].map((n) => app.client().json(`/s/${t.slug}/rdv`, body(n))));
  assert.equal(results.filter((r) => r.ok).length, 1, 'une seule réservation acceptée');
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  assert.match(results.find((r) => r.ok).msg, /Demande de rendez-vous enregistrée/, 'non confirmé tant que le pro ne confirme pas');
  const after = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots;
  assert.equal(after.includes(time), false, 'le créneau pris disparaît');
});

test('réservation : deux postes = deux rendez-vous au même moment, confirmation automatique', async () => {
  const { t } = await signup(app, { business: 'Garage Duo', email: 'duo@test.fr' });
  db.run('UPDATE tenants SET auto_confirm=1 WHERE id=?', t.id);
  const staff = db.all('SELECT id FROM staff WHERE tenant_id=? AND active=1', t.id); assert.ok(staff.length >= 2);
  db.run('UPDATE staff SET active=0 WHERE tenant_id=? AND id NOT IN (?,?)', t.id, staff[0].id, staff[1].id);
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? ORDER BY id LIMIT 1', t.id).id;
  const day = await futureDay(t.slug, svc); const time = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots[0];
  const r = [];
  for (const n of [1, 2, 3]) r.push(await app.client().json(`/s/${t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'C' + n, phone: '+3361234567' + n, email: `c${n}@client.fr` }));
  assert.deepEqual(r.map((x) => x.ok), [true, true, false]);
  assert.match(r[0].msg, /Rendez-vous confirmé/);
  const a = db.one('SELECT * FROM appointments WHERE tenant_id=? ORDER BY id LIMIT 1', t.id);
  assert.equal(a.customer_phone, '33612345671', 'numéro international conservé');
  assert.equal(new Date(a.starts_at).getUTCHours(), Number(time.slice(0, 2)) + 3, 'heure de Cayenne = UTC-3');
  const out = db.all('SELECT channel, template FROM outbox WHERE tenant_id=? AND to_addr IN (?, ?)', t.id, 'c1@client.fr', '33612345671');
  assert.deepEqual(out.map((o) => o.channel).sort(), ['email', 'whatsapp'], 'confirmation e-mail + WhatsApp');
  const bad = await app.client().json(`/s/${t.slug}/rdv`, { date: day, time: '03:00', serviceId: svc, name: 'Nuit', phone: '0694112233' });
  assert.equal(bad.ok, false); assert.match(bad.msg, /horaires/);
  const badPhone = await app.client().json(`/s/${t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'X', phone: '123' });
  assert.match(badPhone.msg, /téléphone invalide/);
});

test('isolation : un professionnel ne peut pas toucher aux données d’un autre', async () => {
  const A = await signup(app, { business: 'Iso A', email: 'isoa@test.fr' });
  const B = await signup(app, { business: 'Iso B', email: 'isob@test.fr' });
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', B.t.id).id;
  const day = await futureDay(B.t.slug, svc); const time = (await app.client().json(`/s/${B.t.slug}/creneaux?service=${svc}&date=${day}`)).slots[0];
  await app.client().json(`/s/${B.t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'Client de B', phone: '0694112233' });
  const apptB = db.one('SELECT id FROM appointments WHERE tenant_id=?', B.t.id).id;
  const page = await A.c.get('/pro'); assert.doesNotMatch(page.text, /Client de B/);
  const r = await A.c.post(`/pro/rdv/${apptB}/statut`, { csrf: A.c.csrf(page.text), status: 'confirmed' });
  assert.equal(r.status, 400); assert.equal(db.one('SELECT status FROM appointments WHERE id=?', apptB).status, 'pending');
  const csrfB = B.c.csrf((await B.c.get('/pro')).text);
  const cross = await A.c.post(`/pro/rdv/${apptB}/statut`, { csrf: csrfB, status: 'confirmed' });
  assert.equal(cross.status, 403, 'le jeton CSRF d’une autre session est refusé');
  const ok = await B.c.post(`/pro/rdv/${apptB}/statut`, { csrf: csrfB, status: 'confirmed' });
  assert.equal(ok.status, 303); assert.equal(db.one('SELECT status FROM appointments WHERE id=?', apptB).status, 'confirmed');
  assert.equal((await A.c.get('/admin')).status, 303, 'un pro n’accède pas à l’administration');
});

test('réglages : les modifications du pro apparaissent sur son site', async () => {
  const { c, t } = await signup(app, { business: 'Garage Reglages', email: 'reg@test.fr' });
  const page = await c.get('/pro/reglages');
  const form = { csrf: c.csrf(page.text), name: 'Garage Réglé', cc: '594', tz: 'America/Cayenne', phone: '0694998877', color: '#123456', city: 'Kourou', address: '1 rue Test', lead: 'Accueil', faq: 'CB acceptée', svc_name_0: 'Vidange express', svc_price_0: '55', svc_dur_0: '45', svc_desc_0: 'Rapide', staff_name_0: 'Pont 1', open_1: 'on', from_1: '08:00', to_1: '12:00' };
  const r = await c.post('/pro/reglages', form); assert.equal(r.status, 303);
  const site = (await app.client().get(`/s/${t.slug}`)).text;
  assert.match(site, /Garage Réglé/); assert.match(site, /Vidange express/); assert.match(site, /55 €/); assert.match(site, /--brand:#123456/);
  assert.equal(db.one('SELECT COUNT(*) n FROM services WHERE tenant_id=? AND active=1', t.id).n, 1);
  const bad = await c.post('/pro/reglages', { ...form, csrf: c.csrf((await c.get('/pro/reglages')).text), svc_dur_0: '50' });
  assert.equal(bad.status, 400); assert.match(bad.text, /multiple de 15/);
});

test('abonnement : page de paiement Stripe puis activation par notification signée', async () => {
  const { c, t } = await signup(app, { business: 'Garage Stripe', email: 'stripe@test.fr' });
  calls = []; mock((url) => url.includes('checkout/sessions') ? jsonResponse({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }) : jsonResponse({}, 404));
  const page = await c.get('/pro/abonnement');
  const r = await c.post('/pro/abonnement/checkout', { csrf: c.csrf(page.text), plan: 'pro' });
  assert.equal(r.status, 303); assert.equal(r.location, 'https://checkout.stripe.com/c/pay/cs_1');
  const sent = decodeURIComponent(calls[0].opt.body);
  assert.match(sent, /line_items\[0\]\[price\]=price_pro/); assert.match(sent, /line_items\[1\]\[price\]=price_setup_pro/); assert.match(sent, new RegExp(`metadata\\[tenant_id\\]=${t.id}`));
  assert.equal(calls[0].opt.headers.authorization, 'Bearer sk_test_x');
  const hook = async (ev, secret = 'whsec_t') => { const raw = JSON.stringify(ev); const ts = Math.floor(Date.now() / 1000); const sig = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    const res = await fetch(app.base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: raw }); return { status: res.status, ...(await res.json()) }; };
  assert.equal((await hook({ id: 'evt_x', type: 'checkout.session.completed', data: { object: { metadata: { tenant_id: t.id, plan: 'pro' } } } }, 'mauvais')).status, 400, 'fausse signature refusée');
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'trial');
  await hook({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { customer: 'cus_1', subscription: 'sub_1', metadata: { tenant_id: String(t.id), plan: 'pro' } } } });
  await hook({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 59800, currency: 'eur', lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 30 * 86400 } }] } } } });
  const dup = await hook({ id: 'evt_2', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 59800 } } });
  assert.equal(dup.duplicate, true, 'événement rejoué ignoré');
  const after = db.one('SELECT * FROM tenants WHERE id=?', t.id);
  assert.equal(after.status, 'active'); assert.equal(after.stripe_customer, 'cus_1');
  assert.equal(db.one('SELECT COUNT(*) n FROM invoices WHERE tenant_id=?', t.id).n, 1);
  await hook({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } });
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'past_due');
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 200, 'site maintenu pendant le délai de grâce');
  db.run('UPDATE tenants SET current_period_end=? WHERE id=?', Date.now() - 8 * 864e5, t.id);
  app.net.resetFetch(); mock(() => jsonResponse({ messageId: 'm' }, 201));
  await runJobs(db);
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', t.id).status, 'paused', 'mis en pause après le délai de grâce');
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 503);
});

test('assistant IA : répond et réserve via l’outil, sans annoncer une réservation non faite', async () => {
  const { t } = await signup(app, { business: 'Garage IA', email: 'ia@test.fr', plan: 'premium' });
  db.run('UPDATE tenants SET auto_confirm=1 WHERE id=?', t.id);
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? ORDER BY id LIMIT 1', t.id).id;
  const day = await futureDay(t.slug, svc); const time = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots[1];
  let step = 0; calls = [];
  mock((url, opt) => {
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    const body = JSON.parse(opt.body); step++;
    if (step === 1) { assert.ok(body.tools.some((x) => x.name === 'reserver')); assert.match(body.system, /Garage IA/); return jsonResponse({ stop_reason: 'tool_use', usage: { input_tokens: 900, output_tokens: 40 }, content: [{ type: 'tool_use', id: 'tu1', name: 'reserver', input: { date: day, heure: time, service_id: svc, nom: 'Paul IA', telephone: '0694556677' } }] }); }
    const res = JSON.parse(body.messages.at(-1).content[0].content); assert.equal(res.ok, true, 'réservation réellement enregistrée');
    return jsonResponse({ stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 30 }, content: [{ type: 'text', text: res.message }] });
  });
  const r = await app.client().json(`/s/${t.slug}/chat`, { q: 'Je veux une vidange', conv: 'conv-1' });
  assert.equal(r.mode, 'ia'); assert.match(r.text, /confirmé/);
  const a = db.one("SELECT * FROM appointments WHERE tenant_id=? AND customer_name='Paul IA'", t.id);
  assert.ok(a); assert.equal(a.source, 'assistant'); assert.equal(a.status, 'confirmed');
  const u = db.one('SELECT * FROM ai_usage WHERE tenant_id=?', t.id); assert.equal(u.in_tokens, 1900); assert.equal(u.calls, 1);
  // panne de l'API : réponse simple + incident, jamais d'erreur pour le client
  mock(() => jsonResponse({ error: 'overloaded' }, 529));
  const down = await app.client().json(`/s/${t.slug}/chat`, { q: 'Quels sont vos horaires ?', conv: 'conv-2' });
  assert.equal(down.mode, 'simple'); assert.match(down.text, /horaires/i);
  assert.ok(db.one("SELECT * FROM incidents WHERE kind='ai'"));
  // formule sans IA : aucun appel à l'API
  const { t: t2 } = await signup(app, { business: 'Garage Sans IA', email: 'noia@test.fr', plan: 'pro' });
  calls = []; await app.client().json(`/s/${t2.slug}/chat`, { q: 'horaires ?' }); assert.equal(calls.length, 0);
});

test('envois : e-mail Brevo et WhatsApp, nouvelles tentatives puis incident', async () => {
  db.run("UPDATE outbox SET status='sent' WHERE status='pending'");
  const { enqueue } = await import('../src/notify.js');
  enqueue(db, { channel: 'email', to: 'client@x.fr', template: 'appt_reminder', payload: { tenant: 'G', name: 'Al', service: 'Vidange', when: 'lun. 1/12 à 9h', address: 'Cayenne', cancelUrl: 'u' } });
  enqueue(db, { channel: 'whatsapp', to: '594694000000', template: 'appt_reminder', payload: { tenant: 'G', name: 'Al', service: 'Vidange', when: 'lun. 1/12 à 9h' } });
  calls = []; mock((url) => jsonResponse({ ok: 1 }, 201));
  const r1 = await processOutbox(db); assert.equal(r1.sent, 2);
  const brevo = calls.find((x) => x.url.includes('brevo')); const b = JSON.parse(brevo.opt.body);
  assert.equal(b.to[0].email, 'client@x.fr'); assert.equal(b.sender.email, 'no-reply@cdp.fr'); assert.match(b.subject, /Rappel/);
  const wa = JSON.parse(calls.find((x) => x.url.includes('graph.facebook.com')).opt.body);
  assert.equal(wa.template.name, 'rdv_rappel'); assert.equal(wa.template.components[0].parameters.length, 4);
  const id = enqueue(db, { channel: 'email', to: 'fail@x.fr', template: 'welcome', payload: {} });
  mock(() => jsonResponse({ message: 'down' }, 500));
  for (let i = 0; i < 5; i++) { db.run('UPDATE outbox SET next_at=0 WHERE id=?', id); await processOutbox(db); }
  const row = db.one('SELECT * FROM outbox WHERE id=?', id);
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 5);
  assert.ok(db.one("SELECT * FROM incidents WHERE kind='send_email'"));
});

test('rappels automatiques la veille, une seule fois', async () => {
  const { t } = await signup(app, { business: 'Garage Rappel', email: 'rappel@test.fr' });
  const now = Date.now();
  db.run("INSERT INTO appointments(tenant_id,service_name,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,starts_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,?)", t.id, 'Vidange', '2030-01-01', '09:00', 540, 60, 1, 'Pont', 'Rita', '594694000001', 'rita@x.fr', now + 20 * 36e5, now);
  mock(() => jsonResponse({}, 201));
  const r = await runJobs(db, now); assert.ok(r.reminders >= 1);
  assert.ok(db.one("SELECT reminded_at FROM appointments WHERE customer_name='Rita'").reminded_at);
  assert.equal(db.all("SELECT * FROM outbox WHERE template='appt_reminder' AND to_addr IN ('rita@x.fr','594694000001')").length, 2, 'e-mail + WhatsApp');
  assert.equal((await runJobs(db, now)).reminders, 0, 'pas de doublon');
});

test('prospection : registre Sirene, démo personnalisée, activation par le prospect', async () => {
  const admin = await makeAdmin();
  mock((url) => {
    assert.match(url, /recherche-entreprises\.api\.gouv\.fr\/search\?code_naf=45\.20[AB]&code_commune=97311/);
    return jsonResponse({ results: url.includes('45.20A') ? [{ siren: '111222333', nom_complet: 'GARAGE DU MARONI (GDM)', activite_principale: '45.20A', date_creation: '2025-06-01', siege: { siret: '11122233300011', libelle_commune: 'SAINT-LAURENT-DU-MARONI', code_postal: '97320', adresse: '5 AV GASTON MONNERVILLE 97320 SAINT-LAURENT-DU-MARONI' } }] : [] });
  });
  let p = await admin.get('/admin/prospection');
  let r = await admin.post('/admin/prospection/recherche', { csrf: admin.csrf(p.text), tpl: 'garage', commune: '97311' });
  assert.match(r.text, /1 entreprise\(s\) trouvée\(s\), 1 nouvelle/);
  r = await admin.post('/admin/prospection/recherche', { csrf: admin.csrf(p.text), tpl: 'garage', commune: '97311' });
  assert.match(r.text, /0 nouvelle/, 'pas de doublon');
  const pr = db.one("SELECT * FROM prospects WHERE siren='111222333'"); assert.equal(pr.score, 5, 'créée il y a moins de 5 ans + métier prioritaire');
  r = await admin.post(`/admin/prospection/${pr.id}/demo`, { csrf: admin.csrf(p.text) });
  const url = /Lien : <a href="([^"]+)"/.exec(r.text)[1]; const token = url.split('/demo/')[1];
  assert.match(r.text, /GARAGE DU MARONI/); assert.match(r.text, /Pour ne plus être contacté/); assert.match(r.text, /\/stop\//);
  const v = app.client(); const demo = await v.get(`/demo/${token}`);
  assert.equal(demo.status, 200); assert.match(demo.text, /Démonstration préparée/);
  const dt = db.one("SELECT * FROM tenants WHERE status='demo' AND prospect_id=?", pr.id);
  assert.equal((await app.client().get(`/s/${dt.slug}`)).status, 404, 'une démo n’est pas publique');
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', dt.id).id;
  const day = (await v.json(`/demo/${token}/creneaux?service=${svc}`)).days[1];
  const fake = await v.json(`/demo/${token}/rdv`, { date: day, time: '09:00', serviceId: svc, name: 'X', phone: '0694000000' });
  assert.equal(fake.demo, true); assert.equal(db.one('SELECT COUNT(*) n FROM appointments WHERE tenant_id=?', dt.id).n, 0, 'rien enregistré en démo');
  assert.equal(db.one('SELECT demo_views FROM prospects WHERE id=?', pr.id).demo_views, 1);
  const claim = await v.submit(`/inscription?claim=${token}`, '/inscription', { claim: token, plan: 'pro', name: 'Patron', email: 'patron@gdm.fr', password: 'Maroni2026ok', cgu: 'on' });
  assert.equal(claim.status, 303);
  const t = db.one('SELECT * FROM tenants WHERE id=?', dt.id);
  assert.equal(t.status, 'trial'); assert.equal(t.demo_token_hash, null);
  assert.equal(db.one('SELECT status FROM prospects WHERE id=?', pr.id).status, 'converted');
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 200, 'site publié après activation');
  assert.equal((await app.client().get(`/demo/${token}`)).status, 404, 'lien de démo désactivé');
  assert.match((await v.get('/pro')).text, /GARAGE DU MARONI/);
});

async function makeAdmin() {
  const { hashPassword, newTotpSecret, totpCode } = app.sec;
  const secret = newTotpSecret();
  if (!db.one("SELECT 1 FROM users WHERE email='boss@cdp.fr'")) db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", hashPassword('AdminTresLong2026'), secret, Date.now());
  else db.run("UPDATE users SET totp_secret=? WHERE email='boss@cdp.fr'", secret);
  const c = app.client();
  const r = await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  assert.equal(r.location, '/connexion/2fa');
  assert.equal((await c.get('/admin')).location, '/connexion/2fa', 'administration bloquée sans 2FA');
  const bad = await c.submit('/connexion/2fa', '/connexion/2fa', { code: '000000' }); assert.equal(bad.status, 401);
  const ok = await c.submit('/connexion/2fa', '/connexion/2fa', { code: totpCode(secret) }); assert.equal(ok.location, '/admin');
  return c;
}

test('administration : chiffres, dépenses, incidents, suspension', async () => {
  const admin = await makeAdmin();
  let p = await admin.get('/admin'); assert.equal(p.status, 200);
  assert.match(p.text, /revenu mensuel récurrent/);
  await admin.post('/admin/depenses', { csrf: admin.csrf(p.text), label: 'Serveur', amount: '7,50', category: 'technique', recurring: 'on' });
  p = await admin.get('/admin'); assert.match(p.text, /Serveur \(mensuelle\)/); assert.match(p.text, /7,5 €/);
  const { t } = await signup(app, { business: 'Garage Suspendu', email: 'susp@test.fr' });
  await admin.post(`/admin/entreprises/${t.id}/statut`, { csrf: admin.csrf(p.text), status: 'paused' });
  assert.equal((await app.client().get(`/s/${t.slug}`)).status, 503);
  const inc = db.one('SELECT id FROM incidents WHERE resolved_at IS NULL LIMIT 1');
  await admin.post(`/admin/incidents/${inc.id}/resoudre`, { csrf: admin.csrf(p.text) });
  assert.ok(db.one('SELECT resolved_at FROM incidents WHERE id=?', inc.id).resolved_at);
  assert.ok(db.one("SELECT 1 FROM audit WHERE action='admin.statut.paused'"), 'action tracée');
});

test('assistance : réponse automatique, ticket, réponse de l’admin par e-mail', async () => {
  const { c, t } = await signup(app, { business: 'Garage Aide', email: 'aide@test.fr' });
  app.net.resetFetch(); mock(() => jsonResponse({ content: [{ type: 'text', text: 'Allez dans Réglages > Horaires.' }] }));
  let p = await c.get('/pro/aide');
  const a = await c.post('/pro/aide/question', { csrf: c.csrf(p.text), q: 'Comment changer mes horaires ?' });
  assert.match(a.text, /Réglages &gt; Horaires/);
  await c.post('/pro/aide/ticket', { csrf: c.csrf(p.text), subject: 'Horaires', body: 'Je ne trouve pas les horaires' });
  const tk = db.one('SELECT * FROM tickets WHERE tenant_id=?', t.id); assert.ok(tk);
  const admin = await makeAdmin(); p = await admin.get(`/admin/tickets/${tk.id}`);
  await admin.post(`/admin/tickets/${tk.id}`, { csrf: admin.csrf(p.text), body: 'Voici la marche à suivre.' });
  assert.equal(db.one('SELECT status FROM tickets WHERE id=?', tk.id).status, 'answered');
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='ticket_reply' AND to_addr='aide@test.fr'"));
});

test('client : annulation par lien, mot de passe oublié', async () => {
  const { t } = await signup(app, { business: 'Garage Annul', email: 'annul@test.fr' });
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', t.id).id;
  const day = await futureDay(t.slug, svc); const time = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots[0];
  const { notifyAppointment } = await import('../src/notify.js');
  await app.client().json(`/s/${t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'Ann', phone: '0694112233', email: 'ann@x.fr' });
  const mail = db.one("SELECT payload FROM outbox WHERE to_addr='ann@x.fr'"); const cancelUrl = JSON.parse(mail.payload).cancelUrl;
  const path = new URL(cancelUrl).pathname; const v = app.client();
  const r = await v.submit(path, path, {}); assert.match(r.text, /Rendez-vous annulé/);
  assert.equal(db.one("SELECT status FROM appointments WHERE customer_name='Ann'").status, 'canceled');
  const c = app.client(); await c.submit('/mot-de-passe-oublie', '/mot-de-passe-oublie', { email: 'annul@test.fr' });
  const url = JSON.parse(db.one("SELECT payload FROM outbox WHERE template='reset_password' AND to_addr='annul@test.fr'").payload).url;
  const rp = new URL(url).pathname;
  assert.equal((await c.submit(rp, rp, { password: 'NouveauMdp2026' })).location, '/connexion?ok=mdp');
  assert.ok((await c.submit(rp, rp, { password: 'EncoreUn2026x' })).status >= 400, 'lien à usage unique');
  assert.equal((await app.client().submit('/connexion', '/connexion', { email: 'annul@test.fr', password: 'NouveauMdp2026' })).location, '/pro');
});

test('sécurité HTTP : en-têtes, origine des appels, débit', async () => {
  const r = await app.client().get('/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const { t } = await signup(app, { business: 'Garage Origine', email: 'orig@test.fr' });
  const evil = await app.client().json(`/s/${t.slug}/devis`, { name: 'x', phone: '0694112233' }, { origin: 'https://evil.example' });
  assert.equal(evil.status, 403);
  const okq = await app.client().json(`/s/${t.slug}/devis`, { name: 'Bob', phone: '0694112233', message: 'Freins' });
  assert.equal(okq.ok, true); assert.ok(db.one("SELECT 1 FROM quotes WHERE customer_name='Bob'"));
  const statuses = []; for (let i = 0; i < 12; i++) statuses.push((await app.client().json(`/s/${t.slug}/devis`, { name: 'Spam', phone: '0694112233' })).status);
  assert.ok(statuses.includes(429), 'limitation des envois répétés');
  assert.equal((await app.client().get('/static/../src/config.js')).status, 404);
});

test('Make : événements métier signés envoyés au webhook, avec nouvelles tentatives', async () => {
  db.run("UPDATE outbox SET status='sent' WHERE status='pending'");
  const { t } = await signup(app, { business: 'Garage Make', email: 'make@test.fr' });
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', t.id).id;
  const day = await futureDay(t.slug, svc); const time = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots[0];
  await app.client().json(`/s/${t.slug}/rdv`, { date: day, time, serviceId: svc, name: 'Mia', phone: '0694112233' });
  const evs = db.all("SELECT template FROM outbox WHERE channel='make' AND status='pending' AND tenant_id=?", t.id).map((r) => r.template);
  assert.deepEqual(evs, ['inscription', 'rdv']);
  calls = []; mock((url) => (url.includes('make.com') ? new Response('Accepted', { status: 200 }) : jsonResponse({}, 201)));
  await processOutbox(db);
  const hooks = calls.filter((x) => x.url === 'https://hook.eu1.make.com/test123');
  assert.equal(hooks.length, 2);
  const rdv = hooks.find((h) => h.opt.headers['x-cdp-event'] === 'rdv'); const body = JSON.parse(rdv.opt.body);
  assert.equal(body.data.client, 'Mia'); assert.equal(body.data.telephone, '+594694112233'); assert.match(body.data.debut_utc, /Z$/);
  assert.equal(rdv.opt.headers['x-cdp-signature'], crypto.createHmac('sha256', 'make_secret').update(rdv.opt.body).digest('hex'));
  // incident critique => alerte Make immédiate, une seule fois
  const { recordIncident } = await import('../src/incidents.js');
  recordIncident(db, { kind: 'test', severity: 'critical', message: 'Base saturée' }); recordIncident(db, { kind: 'test', severity: 'critical', message: 'Base saturée' });
  assert.equal(db.all("SELECT 1 FROM outbox WHERE channel='make' AND template='incident' AND payload LIKE '%Base saturée%'").length, 1);
  // Make en panne : nouvelles tentatives, pas de perte
  mock(() => new Response('down', { status: 503 }));
  const r = await processOutbox(db); assert.ok(r.failed >= 1);
  assert.equal(db.one("SELECT status FROM outbox WHERE template='incident' AND channel='make'").status, 'pending');
});
