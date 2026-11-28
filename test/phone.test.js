// Numéros de téléphone : France, Outre-mer et international (E.164), de la saisie à WhatsApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ AUTORISER_IA_PAYANTE: 'oui', AUTORISER_WHATSAPP_PAYANT: 'oui', WHATSAPP_TOKEN: 'test-token', WHATSAPP_PHONE_ID: '123', MAKE_WEBHOOK_URL: 'https://hook.test/make', MAKE_EVENTS: 'inscription,rdv,devis' });
const { db } = app;
const { toE164, e164Ok, phoneValid, domCountryOf } = await import('../src/phone.js');
const { processOutbox } = await import('../src/notify.js');
const { openDb } = await import('../src/db.js');
test.after(() => app.close());

let n = 0;
/** Inscription par le formulaire sans JavaScript : champs tels que le navigateur les envoie. */
async function register(form, headers = {}) {
  app.sec.resetRateLimits(); const c = app.client(); n++;
  const page = await c.get('/inscription', headers);
  const r = await c.post('/inscription', { csrf: c.csrf(page.text), business: `Entreprise ${n}`, tpl: 'garage', city: 'Ville', plan: 'pro', name: 'Pro', email: `pro${n}@tel.test`, password: 'Telephone2026ok', cgu: 'on', ...form }, headers);
  const t = db.one("SELECT t.* FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email=?", `pro${n}@tel.test`);
  return { r, t, page: page.text, c };
}

test('E.164 : Guyane, Martinique, Guadeloupe, La Réunion, Mayotte et métropole, toutes écritures', () => {
  const cases = [
    // [saisie, indicatif du professionnel, attendu]
    ['0694 12 34 56', '594', '594694123456'], ['0594 30 00 00', '594', '594594300000'], ['06.94.12.34.56', '33', '594694123456'],
    ['+594 694 12 34 56', '', '594694123456'], ['00594694123456', '1', '594694123456'], ['+594 (0)694 12 34 56', '', '594694123456'],
    ['0696 12 34 56', '594', '596696123456'], ['0697 12 34 56', '33', '596697123456'], ['0596 60 00 00', '262', '596596600000'],
    ['0690 12 34 56', '594', '590690123456'], ['0691 12 34 56', '33', '590691123456'], ['0590 80 00 00', '596', '590590800000'],
    ['0692 12 34 56', '594', '262692123456'], ['0693 12 34 56', '33', '262693123456'], ['0262 20 00 00', '262', '262262200000'],
    ['0639 12 34 56', '262', '262639123456'], ['0269 61 00 00', '33', '262269610000'],
    ['06 12 34 56 78', '33', '33612345678'], ['06 12 34 56 78', '594', '33612345678'], ['07-12-34-56-78', '262', '33712345678'],
    ['01 23 45 67 89', '596', '33123456789'], ['+33 6 12 34 56 78', '594', '33612345678'], ['+33 (0)1 23 45 67 89', '', '33123456789'],
    ['694123456', '594', '594694123456'], ['594694123456', '594', '594694123456']
  ];
  for (const [raw, cc, want] of cases) { assert.equal(toE164(raw, cc), want, `${raw} (+${cc})`); assert.ok(phoneValid(raw, cc), `${raw} valide`); }
});

test('jamais de numéro d’Outre-mer transformé en numéro métropolitain, quel que soit l’indicatif', () => {
  const dom = { 594: ['594', '694'], 590: ['590', '690', '691'], 596: ['596', '696', '697'], 262: ['262', '263', '692', '693', '269', '639'] };
  for (const [code, prefixes] of Object.entries(dom)) for (const p of prefixes) for (const cc of ['33', '594', '590', '596', '262']) {
    const nat = `0${p}112233`; const out = toE164(nat, cc);
    assert.equal(out, code + nat.slice(1), `${nat} saisi avec +${cc}`); assert.ok(!out.startsWith('33'));
    // Écrit par erreur avec +33 : rattaché à son territoire, jamais l'inverse
    assert.equal(toE164(`+33 ${nat.slice(1)}`, ''), code + nat.slice(1));
  }
  assert.equal(domCountryOf('594694123456'), 'GF'); assert.equal(domCountryOf('596696123456'), 'MQ'); assert.equal(domCountryOf('590690123456'), 'GP');
  assert.equal(domCountryOf('262692123456'), 'RE'); assert.equal(domCountryOf('262639123456'), 'YT'); assert.equal(domCountryOf('33612345678'), null);
});

test('E.164 : pays étrangers (indicatif, 0 national, 00, +1, Italie)', () => {
  const cases = [
    ['0470 12 34 56', '32', '32470123456'], ['+32 (0)470 12 34 56', '', '32470123456'], ['079 123 45 67', '41', '41791234567'],
    ['07911 123456', '44', '447911123456'], ['+44 (0)7911 123456', '', '447911123456'], ['0151 23456789', '49', '4915123456789'],
    ['06 1234 5678', '39', '390612345678'], ['+39 06 1234 5678', '', '390612345678'], ['612 34 56 78', '34', '34612345678'],
    ['(416) 555-0199', '1', '14165550199'], ['416.555.0199', '1', '14165550199'], ['1 212 555 0123', '1', '12125550123'], ['011 33 6 12 34 56 78', '1', '33612345678'],
    ['(11) 98765-4321', '55', '5511987654321'], ['0612 345678', '212', '212612345678'], ['77 123 45 67', '221', '221771234567'],
    ['07 07 12 34 56', '225', '2250707123456'], ['3712 3456', '509', '50937123456'], ['812 3456', '597', '5978123456'], ['0612 345 678', '31', '31612345678'],
    ['+216 20 123 456', '33', '21620123456'], ['0021620123456', '33', '21620123456']
  ];
  for (const [raw, cc, want] of cases) { assert.equal(toE164(raw, cc), want, `${raw} (+${cc})`); assert.ok(phoneValid(raw, cc), `${raw} valide`); }
});

test('numéros invalides refusés (longueur, indicatif manquant, lettres)', () => {
  for (const [raw, cc] of [['123', '594'], ['0694 12 34', '594'], ['0694 12 34 56 78', '33'], ['+33 6 12 34 56', ''], ['06 12 34 56 78', ''], ['', '33'], ['abcdef', '33'],
    ['+1 012 555 0199', ''], ['416 555 019', '1'], ['+1234567890123456', ''], ['+0 694 12 34 56', '']]) assert.equal(phoneValid(raw, cc), false, `${raw} (+${cc}) refusé`);
  assert.equal(e164Ok('0694123456'), false); assert.equal(e164Ok('33612345678'), true); assert.equal(e164Ok('3361234567'), false); assert.equal(e164Ok('5940694123456'), false);
});

test('inscription : la proposition « France » du serveur ne l’emporte pas sur un numéro guyanais ni sur le fuseau', async () => {
  // Navigateur en fr-FR à Cayenne sans JavaScript : le formulaire renvoie la proposition FR telle quelle
  const a = await register({ country: 'FR', country_guess: 'FR', phone_cc: '33', tz: 'America/Cayenne', phone: '0694 12 34 56' }, { 'accept-language': 'fr-FR' });
  assert.match(a.page, /<option value="FR" selected>/, 'le serveur propose la France'); assert.match(a.page, /name="country_guess" id="country_guess" value="FR"/);
  assert.equal(a.r.status, 303); assert.equal(a.t.country, 'GF'); assert.equal(a.t.cc, '594'); assert.equal(a.t.phone, '594694123456'); assert.equal(a.t.tz, 'America/Cayenne');
  // Appareil à l'heure UTC (cas du test navigateur) : le numéro guyanais suffit
  const b = await register({ country: 'FR', country_guess: 'FR', phone_cc: '33', tz: 'UTC', phone: '0694 55 66 77' });
  assert.equal(b.t.country, 'GF'); assert.equal(b.t.phone, '594694556677');
  // Fuseau seul (pas de numéro)
  const c = await register({ country: 'FR', country_guess: 'FR', tz: 'America/Martinique' });
  assert.equal(c.t.country, 'MQ'); assert.equal(c.t.cc, '596');
  // Réunion et Mayotte (même indicatif +262)
  assert.equal((await register({ country: 'FR', country_guess: 'FR', tz: 'UTC', phone: '0692 12 34 56' })).t.country, 'RE');
  assert.equal((await register({ country: 'FR', country_guess: 'FR', tz: 'UTC', phone: '0639 12 34 56' })).t.country, 'YT');
  assert.equal((await register({ country: 'FR', country_guess: 'FR', tz: 'UTC', phone: '0690 12 34 56' })).t.country, 'GP');
  // Métropole
  const m = await register({ country: 'FR', country_guess: 'FR', tz: 'Europe/Paris', phone: '06 12 34 56 78' });
  assert.equal(m.t.country, 'FR'); assert.equal(m.t.cc, '33'); assert.equal(m.t.phone, '33612345678');
});

test('inscription : le pays choisi explicitement est toujours respecté, le numéro guyanais reste guyanais', async () => {
  // Proposition GF (appareil à Cayenne), le professionnel choisit France : France, mais son 0694 reste +594
  const a = await register({ country: 'FR', country_guess: 'GF', phone_cc: '33', tz: 'America/Cayenne', phone: '0694 12 34 56' });
  assert.equal(a.t.country, 'FR'); assert.equal(a.t.cc, '33'); assert.equal(a.t.phone, '594694123456');
  // Choix explicite de la Martinique depuis Paris
  const b = await register({ country: 'MQ', country_guess: 'FR', phone_cc: '596', tz: 'Europe/Paris', phone: '0696 11 22 33' });
  assert.equal(b.t.country, 'MQ'); assert.equal(b.t.cc, '596'); assert.equal(b.t.phone, '596696112233'); assert.equal(b.t.tz, 'Europe/Paris');
  // Choix explicite de la Guyane avec un portable métropolitain
  const c = await register({ country: 'GF', country_guess: 'FR', phone_cc: '594', tz: 'America/Cayenne', phone: '06 12 34 56 78' });
  assert.equal(c.t.country, 'GF'); assert.equal(c.t.phone, '33612345678');
  // L'utilisateur revient sur le pays proposé (France) après l'avoir changé : choix explicite respecté
  const e = await register({ country: 'FR', country_guess: 'FR', country_set: '1', tz: 'America/Cayenne', phone: '0694 12 34 99' });
  assert.equal(e.t.country, 'FR'); assert.equal(e.t.phone, '594694123499');
  // Anciens formulaires sans proposition (country seul) : choix explicite
  const d = await register({ country: 'BE', tz: 'Europe/Brussels', phone: '0470 12 34 56' });
  assert.equal(d.t.country, 'BE'); assert.equal(d.t.cc, '32'); assert.equal(d.t.phone, '32470123456');
});

test('inscription : indicatif téléphonique sélectionnable, pays étrangers et « Autre pays »', async () => {
  const a = await register({ country: 'FR', country_guess: 'FR', phone_cc: '32', tz: 'Europe/Brussels', phone: '0470 12 34 56' });
  assert.equal(a.t.phone, '32470123456', 'indicatif choisi respecté'); assert.equal(a.t.country, 'BE');
  const b = await register({ country: 'CA', country_guess: 'US', phone_cc: '1', tz: 'America/Toronto', phone: '(416) 555-0199' });
  assert.equal(b.t.country, 'CA'); assert.equal(b.t.phone, '14165550199');
  const c = await register({ country: 'OTHER', country_guess: 'FR', phone_cc: '216', tz: 'Africa/Tunis', phone: '20 123 456' });
  assert.equal(c.t.country, 'OTHER'); assert.equal(c.t.cc, '216', 'indicatif des clients = celui choisi'); assert.equal(c.t.phone, '21620123456');
  const d = await register({ country: 'GB', country_guess: 'FR', phone_cc: '44', tz: 'Europe/London', phone: '07911 123456' });
  assert.equal(d.t.country, 'GB'); assert.equal(d.t.phone, '447911123456');
  // Le formulaire propose la liste des indicatifs, dont l'Outre-mer
  for (const dial of ['594', '596', '590', '262', '33', '32', '1', '44']) assert.match(a.page, new RegExp(`<option value="${dial}"`));
  // Numéro invalide : refus clair, rien n'est créé
  const bad = await register({ country: 'FR', country_guess: 'FR', tz: 'Europe/Paris', phone: '06 12' });
  assert.equal(bad.r.status, 400); assert.match(bad.r.text, /Numéro WhatsApp invalide/); assert.equal(bad.t, undefined);
});

/** Réserve sur le site du professionnel et renvoie la réponse et le rendez-vous enregistré. */
async function bookOn(t, phone, cc) {
  app.sec.resetRateLimits();
  const svc = db.one('SELECT id FROM services WHERE tenant_id=? AND active=1 ORDER BY id LIMIT 1', t.id).id;
  for (let i = 1; i < 21; i++) {
    const day = new Date(Date.now() + i * 864e5).toISOString().slice(0, 10);
    const slots = (await app.client().json(`/s/${t.slug}/creneaux?service=${svc}&date=${day}`)).slots || [];
    if (!slots.length) continue;
    const name = `Client ${Math.random().toString(36).slice(2, 8)}`;
    const r = await app.client().json(`/s/${t.slug}/rdv`, { date: day, time: slots[0], serviceId: svc, name, phone, ...(cc !== undefined ? { cc } : {}), email: '' });
    return { r, a: db.one('SELECT * FROM appointments WHERE customer_name=?', name) };
  }
  throw new Error('aucun créneau');
}

test('rendez-vous : numéros des clients normalisés, indicatif du client respecté, notifications au bon format', async () => {
  const { t } = await signup(app, { business: 'Garage Numéros', email: 'numeros@tel.test' });
  assert.equal(t.country, 'GF'); assert.equal(t.cc, '594');
  db.run("UPDATE tenants SET auto_confirm=1, status='active' WHERE id=?", t.id); // abonnement payé : WhatsApp et IA (services payants) actifs
  const site = (await app.client().get(`/s/${t.slug}`)).text;
  assert.match(site, /<select id="b-cc" name="cc"[^>]*>/); assert.match(site, /<option value="594" selected>/, 'indicatif du professionnel proposé par défaut');
  const cases = [['0694 11 22 33', undefined, '594694112233'], ['06 12 34 56 78', undefined, '33612345678'], ['0696 11 22 33', '594', '596696112233'],
    ['0470 12 34 56', '32', '32470123456'], ['(416) 555-0199', '1', '14165550199'], ['+44 7911 123456', '594', '447911123456'], ['0692 11 22 33', '33', '262692112233']];
  for (const [raw, cc, want] of cases) {
    const { r, a } = await bookOn(t, raw, cc);
    assert.equal(r.ok, true, `${raw} accepté`); assert.equal(a.customer_phone, want, `${raw} (+${cc ?? 'défaut'})`);
    const wa = db.one("SELECT * FROM outbox WHERE channel='whatsapp' AND to_addr=? ORDER BY id DESC LIMIT 1", want); assert.ok(wa, `confirmation WhatsApp vers ${want}`);
    const mail = db.one("SELECT payload FROM outbox WHERE channel='email' AND template='pro_new_request' AND payload LIKE ? ORDER BY id DESC LIMIT 1", `%${a.customer_name}%`);
    assert.match(JSON.parse(mail.payload).summary, new RegExp(`\\(\\+${want}\\)`), 'e-mail au professionnel');
    const mk = db.one("SELECT payload FROM outbox WHERE channel='make' AND template='rdv' AND payload LIKE ? ORDER BY id DESC LIMIT 1", `%${a.customer_name}%`);
    assert.equal(JSON.parse(mk.payload).telephone, '+' + want, 'événement Make');
  }
  const bad = await bookOn(t, '0694 11', undefined); assert.equal(bad.r.ok, false); assert.match(bad.r.msg, /Numéro de téléphone invalide/); assert.equal(bad.a, undefined);
  // Professionnel en métropole : un client guyanais reste guyanais
  const fr = (await register({ country: 'FR', country_guess: 'GF', tz: 'Europe/Paris', phone: '06 12 34 56 78' })).t;
  db.run('UPDATE tenants SET auto_confirm=1 WHERE id=?', fr.id);
  assert.equal(fr.cc, '33'); assert.equal((await bookOn(fr, '0694 11 22 33')).a.customer_phone, '594694112233');
});

test('devis : numéro normalisé avec l’indicatif choisi, e-mail et événement Make', async () => {
  const { t } = await signup(app, { business: 'Garage Devis Tel', email: 'devis@tel.test' });
  for (const [raw, cc, want] of [['0694 22 33 44', '', '594694223344'], ['079 123 45 67', '41', '41791234567'], ['06 98 76 54 32', '594', '33698765432']]) {
    app.sec.resetRateLimits(); const name = `Devis ${want}`;
    const r = await app.client().json(`/s/${t.slug}/devis`, { name, phone: raw, cc, email: '', obj: 'Clio', service: 'Vidange', message: 'Bonjour' });
    assert.equal(r.ok, true); assert.equal(db.one('SELECT customer_phone FROM quotes WHERE customer_name=?', name).customer_phone, want);
    assert.match(JSON.parse(db.one("SELECT payload FROM outbox WHERE template='pro_new_request' AND payload LIKE ?", `%${name}%`).payload).summary, new RegExp(`\\+${want}`));
    assert.equal(JSON.parse(db.one("SELECT payload FROM outbox WHERE channel='make' AND template='devis' AND payload LIKE ?", `%${name}%`).payload).telephone, '+' + want);
  }
});

test('WhatsApp : envoi au format E.164, numéro invalide jamais envoyé', async () => {
  const sent = [];
  app.net.setFetch(async (url, opt = {}) => { if (String(url).includes('graph.facebook.com')) sent.push(JSON.parse(opt.body)); return jsonResponse({ messages: [{ id: 'wamid' }] }); });
  db.run("UPDATE outbox SET status='sent' WHERE status='pending'");
  const { enqueue } = await import('../src/notify.js');
  const p = { lang: 'fr', name: 'Client', tenant: 'Garage', service: 'Vidange', when: 'demain 9h', status: 'confirmed' };
  for (const to of ['594694112233', '+596696112233', '262639123456', '14165550199', '0694112233', '12']) enqueue(db, { channel: 'whatsapp', to, template: 'appt_confirmed', payload: p });
  await processOutbox(db);
  assert.deepEqual(sent.map((b) => b.to), ['594694112233', '596696112233', '262639123456', '14165550199']);
  const skipped = db.all("SELECT to_addr, status FROM outbox WHERE channel='whatsapp' AND to_addr IN ('0694112233','12')");
  assert.equal(skipped.length, 2); for (const s of skipped) assert.notEqual(s.status, 'pending');
  app.net.resetFetch();
});

test('numéros déjà enregistrés : jamais réécrits (redémarrage, réglages inchangés, affichage)', async () => {
  const { c, t } = await signup(app, { business: 'Garage Ancien', email: 'ancien@tel.test' });
  // Données antérieures au correctif : compte enregistré par erreur en « +33 694… », client avec un numéro local
  db.run("UPDATE tenants SET phone='33694000001', cc='33', country='FR' WHERE id=?", t.id);
  db.run("INSERT INTO appointments(tenant_id,service_name,date,time,start_min,dur,staff_id,staff_name,customer_name,customer_phone,customer_email,status,starts_at,created_at) VALUES(?,'Vidange','2030-01-02','09:00',540,60,1,'P','Ancien client','33694000002','','confirmed',?,?)", t.id, Date.now() + 864e5, Date.now());
  db.run("INSERT INTO quotes(tenant_id,customer_name,customer_phone,customer_email,created_at) VALUES(?,'Ancien devis','5940694000003','',?)", t.id, Date.now());
  const snap = () => [db.one('SELECT phone FROM tenants WHERE id=?', t.id).phone, db.one("SELECT customer_phone FROM appointments WHERE customer_name='Ancien client'").customer_phone, db.one("SELECT customer_phone FROM quotes WHERE customer_name='Ancien devis'").customer_phone];
  const before = snap(); assert.deepEqual(before, ['33694000001', '33694000002', '5940694000003']);
  // Réouverture de la base (migrations au démarrage) : rien ne change
  openDb(process.env.DB_PATH).close(); assert.deepEqual(snap(), before);
  // Réglages enregistrés sans toucher au numéro : conservé tel quel, avec un avertissement visible
  const page = await c.get('/pro/reglages'); assert.match(page.text, /value="\+33694000001"/); assert.match(page.text, /id="phone-warn"/);
  const form = { csrf: c.csrf(page.text), name: 'Garage Ancien', country: 'FR', currency: 'EUR', lang: 'fr', tz: 'Europe/Paris', phone: '+33694000001', phone_cc: '33', color: '#123456', city: 'Paris', address: '', lead: 'x', faq: 'y', svc_name_0: 'Vidange', svc_price_0: '50', svc_dur_0: '60', staff_name_0: 'Pont 1', open_1: 'on', from_1: '08:00', to_1: '12:00' };
  assert.equal((await c.post('/pro/reglages', form)).status, 303); assert.deepEqual(snap(), before, 'numéro inchangé = numéro conservé');
  // Le professionnel corrige lui-même son numéro et son indicatif : appliqué
  assert.equal((await c.post('/pro/reglages', { ...form, csrf: c.csrf((await c.get('/pro/reglages')).text), phone: '0694 00 00 01', phone_cc: '594', country: 'GF', tz: 'America/Cayenne' })).status, 303);
  assert.equal(db.one('SELECT phone FROM tenants WHERE id=?', t.id).phone, '594694000001');
  assert.equal(db.one('SELECT cc FROM tenants WHERE id=?', t.id).cc, '594');
  assert.doesNotMatch((await c.get('/pro/reglages')).text, /id="phone-warn"/);
  // Les rendez-vous et devis existants ne sont pas touchés par ce changement
  assert.deepEqual(snap().slice(1), before.slice(1));
  // Indicatif modifiable dans les réglages (pays « Autre »)
  assert.equal((await c.post('/pro/reglages', { ...form, csrf: c.csrf((await c.get('/pro/reglages')).text), phone: '20 123 456', phone_cc: '216', country: 'OTHER', tz: 'Africa/Tunis' })).status, 303);
  const after = db.one('SELECT phone, cc FROM tenants WHERE id=?', t.id); assert.equal(after.phone, '21620123456'); assert.equal(after.cc, '216');
  // Numéro invalide dans les réglages : refusé, ancien numéro conservé
  const bad = await c.post('/pro/reglages', { ...form, csrf: c.csrf((await c.get('/pro/reglages')).text), phone: '06 12', phone_cc: '33' });
  assert.equal(bad.status, 400); assert.match(bad.text, /Numéro WhatsApp invalide/); assert.equal(db.one('SELECT phone FROM tenants WHERE id=?', t.id).phone, '21620123456');
});
