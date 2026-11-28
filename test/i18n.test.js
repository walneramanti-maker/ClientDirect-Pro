// Traductions : chaque texte affiché a sa version anglaise ; formats de date, heure, devise et téléphone selon le pays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setup, signup } from './helpers.js';

const app = await setup();
test.after(() => app.close());
const i18n = await import('../src/i18n.js');
const markets = await import('../src/markets.js');
const util = await import('../src/util.js');

test('i18n : tous les textes de l’interface ont une traduction anglaise', () => {
  const pat = /\b(?:t|tr|T)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`$]*)`)/g;
  const missing = [];
  for (const f of [...fs.readdirSync('src').filter((x) => x.endsWith('.js')).map((x) => 'src/' + x), 'public/site.js']) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(pat)) { const k = (m[1] ?? m[2] ?? m[3]).replace(/\\'/g, "'"); if (k && !i18n.hasTranslation(k, 'en')) missing.push(`${f}: ${k}`); }
  }
  assert.deepEqual(missing, []);
});
test('i18n : langue détectée depuis le navigateur, choix mémorisé', async () => {
  assert.equal(i18n.detectLang({ accept: 'en-CA,en;q=0.9,fr;q=0.8' }), 'en');
  assert.equal(i18n.detectLang({ accept: 'de-DE,de;q=0.9' }), 'fr', 'langue non gérée : français par défaut');
  assert.equal(i18n.detectLang({ query: 'en', accept: 'fr-FR' }), 'en');
  assert.equal(i18n.regionFromAccept('fr-BE,fr;q=0.9'), 'BE');
  const en = await app.client().get('/', { 'accept-language': 'en-US,en;q=0.9' });
  assert.match(en.text, /<html lang="en">/); assert.match(en.text, /Your website works for you, even while you sleep/); assert.match(en.text, /\$169/, 'prix en dollars US pour un visiteur américain');
  const ca = await app.client().get('/', { 'accept-language': 'fr-CA,fr;q=0.9' });
  assert.match(ca.text, /Votre site travaille pour vous, même pendant votre sommeil/); assert.match(ca.text, /219\s\$/, 'Canadien francophone : dollars canadiens');
  const c = app.client(); const r = await c.get('/?lang=en'); assert.match(r.headers.get('set-cookie') || '', /lang=en/);
  assert.match((await c.get('/connexion')).text, /Forgot your password/, 'choix de langue conservé');
});
test('international : un restaurateur canadien s’inscrit en anglais, son site est en anglais et en dollars canadiens', async () => {
  app.sec.resetRateLimits(); const c = app.client();
  const page = await c.get('/inscription', { 'accept-language': 'en-CA' });
  assert.match(page.text, /Create my site/); assert.match(page.text, /<option value="CA" selected>/);
  const r = await c.post('/inscription', { csrf: c.csrf(page.text), business: 'Maple Bistro', tpl: 'restaurant', city: 'Toronto', country: 'CA', tz: 'America/Toronto', lang: 'en', phone: '(416) 555-0199', plan: 'pro', name: 'Sam', email: 'sam@maple.ca', password: 'MapleBistro2026', cgu: 'on' });
  assert.equal(r.status, 303);
  const tn = app.db.one("SELECT * FROM tenants WHERE name='Maple Bistro'");
  assert.equal(tn.country, 'CA'); assert.equal(tn.currency, 'CAD'); assert.equal(tn.lang, 'en'); assert.equal(tn.tz, 'America/Toronto'); assert.equal(tn.phone, '14165550199');
  const site = (await app.client().get(`/s/${tn.slug}`)).text;
  assert.match(site, /<html lang="en">/); assert.match(site, /Book a table/); assert.match(site, /Free booking/); assert.match(site, /Monday/);
  const dash = (await c.get('/pro')).text; assert.match(dash, /What your site brought you/);
  const bill = (await c.get('/pro/abonnement')).text; assert.match(bill, /not yet open in your country/, 'abonnements payants fermés tant que le Canada n’est pas vérifié');
  const s = await app.client().json(`/s/${tn.slug}/creneaux?service=${app.db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', tn.id).id}`);
  const svc = app.db.one('SELECT id FROM services WHERE tenant_id=? LIMIT 1', tn.id).id; const day = s.days[1];
  const time = (await app.client().json(`/s/${tn.slug}/creneaux?service=${svc}&date=${day}`)).slots[0];
  const b = await app.client().json(`/s/${tn.slug}/rdv`, { date: day, time, serviceId: svc, name: 'Alex', phone: '416 555 0123', email: 'alex@x.ca' });
  assert.match(b.msg, /Appointment request received for .* (AM|PM)/);
  const mail = JSON.parse(app.db.one("SELECT payload FROM outbox WHERE to_addr='alex@x.ca'").payload); assert.equal(mail.lang, 'en');
});
test('international : un coiffeur belge (euros, français, fuseau de Bruxelles) et un artisan américain', async () => {
  const { t: be } = await signup(app, { business: 'Salon Bruxelles', email: 'be@test.be', tpl: 'coiffeur' });
  app.db.run("UPDATE tenants SET country='BE', tz='Europe/Brussels', cc='32' WHERE id=?", be.id);
  assert.equal(util.intlPhone('0470 12 34 56', '32'), '32470123456');
  assert.equal(markets.priceOf('pro', 'EUR').monthly, 149); assert.equal(markets.priceOf('pro', 'USD').monthly, 169);
  assert.equal(markets.billingOpen('BE'), false); assert.equal(markets.billingOpen('GF'), true); assert.equal(markets.billingOpen('US'), false);
  assert.equal(markets.money(1299, 'USD', 'en-US'), '$1,299');
  assert.equal(i18n.fmtTime('15:30', 'en'), '3:30 PM'); assert.equal(i18n.fmtTime('15:30', 'fr'), '15h30');
  assert.ok(markets.ALL_TZ.length > 300, 'tous les fuseaux du monde');
  assert.ok(markets.validTz('America/Chicago')); assert.ok(!markets.validTz('Mars/Olympus'));
});
test('exemples : sites fictifs testables sans inscription, rien n’est enregistré', async () => {
  const page = await app.client().get('/exemple/coiffeur');
  assert.equal(page.status, 200); assert.match(page.text, /Site d’exemple fictif/); assert.match(page.text, /noindex/);
  const svc = /<option value="(\d+)">/.exec(page.text)[1];
  const d = (await app.client().json(`/exemple/coiffeur/creneaux?service=${svc}`)).days[1];
  const before = app.db.one('SELECT COUNT(*) n FROM appointments').n;
  const r = await app.client().json('/exemple/coiffeur/rdv', { date: d, time: '10:00', serviceId: svc, name: 'Test', phone: '0600000000' });
  assert.equal(r.demo, true); assert.equal(app.db.one('SELECT COUNT(*) n FROM appointments').n, before);
  const chat = await app.client().json('/exemple/coiffeur/chat', { q: 'horaires ?' }); assert.match(chat.text, /horaires/i);
  const en = await app.client().get('/exemple/garage?lang=en'); assert.match(en.text, /Riverside Auto Care/); assert.match(en.text, /Fictional example site/);
  const dash = await app.client().get('/exemple/espace-pro'); assert.equal(dash.status, 200); assert.match(dash.text, /Espace professionnel d’exemple/); assert.doesNotMatch(dash.text, /<button class="btn sm " type="submit" >/);
  assert.equal((await app.client().get('/s/exemple-coiffeur-fr')).status, 404, 'un exemple n’est jamais publié comme vrai site');
  assert.doesNotMatch((await app.client().get('/sitemap.xml')).text, /exemple/);
  assert.equal((await app.client().get('/exemple/inconnu')).status, 404);
});
test('formules : les trois formules et leurs différences sont clairement affichées', async () => {
  const p = (await app.client().get('/')).text;
  assert.match(p, /Recommandé/);
  for (const n of ['Essentiel', 'Pro', 'Premium']) assert.match(p, new RegExp(`<h3>${n}</h3>`));
  assert.match(p, /<table class="compare">/);
  const rows = p.match(/<tr><th scope="row">/g).length; assert.ok(rows >= 9, 'comparatif ligne par ligne');
  assert.match(p, /Assistant IA 24 h\/24/); assert.match(p, /79\s€/); assert.match(p, /149\s€/); assert.match(p, /249\s€/);
  assert.match(p, /mise en service/);
});
test('vidéo : servie par morceaux (lecture sur iPhone/Safari)', async () => {
  const r = await fetch(app.base + '/static/video/presentation-fr.mp4', { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206); assert.match(r.headers.get('content-range'), /^bytes 0-99\/\d+$/); assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  assert.equal((await fetch(app.base + '/static/video/presentation-fr.mp4', { headers: { range: 'bytes=999999999-' } })).status, 416);
});
test('i18n : un sélecteur de langue FR/EN est présent sur toutes les pages publiques et de compte, et le choix est mémorisé', async () => {
  const c = app.client();
  const pages = ['/', '/exemples', '/metiers', '/partenaires', '/annuaire', '/cgu', '/cgv', '/confidentialite', '/mentions-legales', '/connexion', '/inscription', '/mot-de-passe-oublie', '/exemple/garage', '/partenaires/conditions'];
  const sans = [];
  for (const p of pages) { const r = await c.get(p); if (r.status !== 200 || !/class="langs"/.test(r.text) || !/hreflang="en"/.test(r.text)) sans.push(`${p} (HTTP ${r.status})`); }
  assert.deepEqual(sans, [], 'pages sans sélecteur de langue');
  const en = await c.get('/cgv?lang=en'); assert.match(en.text, /<html lang="en"/);
  const next = await c.get('/mentions-legales'); assert.match(next.text, /<html lang="en"/, 'la langue choisie est gardée sur la page suivante');
  const { c: pro } = await signup(app, { business: 'Garage Langue', email: 'langue@test.fr' });
  const dash = await pro.get('/pro'); assert.match(dash.text, /class="langs"/, 'espace pro');
});
test('i18n : la page d’accueil n’annonce plus « changez quand vous voulez » (engagement de 12 mois des CGV)', async () => {
  const r = await app.client().get('/?lang=fr');
  assert.doesNotMatch(r.text, /quand vous voulez/); assert.match(r.text, /Engagement de 12 mois/);
});
