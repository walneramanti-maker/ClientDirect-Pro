import test from 'node:test';
import assert from 'node:assert/strict';
import { channelOf, isBot, errorField, count, funnelReport } from '../src/funnel.js';
import { openDb } from '../src/db.js';

const req = (ref, ua = 'Mozilla/5.0 (iPhone)') => ({ headers: { referer: ref, 'user-agent': ua } });
const u = (q = '') => new URL('https://clientdirectpro.fr/' + q);

test('canal déduit de la provenance', () => {
  assert.equal(channelOf(req('https://www.google.fr/'), u()), 'google');
  assert.equal(channelOf(req('https://m.facebook.com/x'), u()), 'facebook');
  assert.equal(channelOf(req('https://l.instagram.com/'), u()), 'instagram');
  assert.equal(channelOf(req(''), u()), 'direct');
  assert.equal(channelOf(req('https://clientdirectpro.fr/metiers/x'), u(), ['clientdirectpro.fr']), 'interne');
  assert.equal(channelOf(req('https://www.google.fr/'), u('?utm_source=prospection')), 'email');
});

test('robots exclus', () => {
  assert.equal(isBot(req('', 'Googlebot/2.1')), true);
  assert.equal(isBot(req('', '')), true);
  assert.equal(isBot(req('', 'Mozilla/5.0 (Linux; Android 14)')), false);
});

test('erreurs regroupées par champ', () => {
  assert.equal(errorField('Adresse e-mail invalide.'), 'email');
  assert.equal(errorField("Indiquez le nom de l'entreprise."), 'entreprise');
  assert.equal(errorField('Indiquez votre nom.'), 'nom');
  assert.equal(errorField('Un compte existe déjà avec cette adresse. Connectez-vous.'), 'email_deja_inscrit');
  assert.equal(errorField("Vous devez accepter les conditions d'utilisation."), 'cgu');
});

test('rapport d’entonnoir agrégé', () => {
  const db = openDb(':memory:');
  const now = new Date('2026-11-28T10:00:00Z');
  for (let i = 0; i < 10; i++) count(db, 'visite', i < 6 ? 'google' : 'direct', now);
  for (let i = 0; i < 4; i++) count(db, 'page_inscription', 'direct', now);
  count(db, 'formulaire_commence', '', now); count(db, 'formulaire_commence', '', now);
  count(db, 'envoi', '', now); count(db, 'erreur:email', '', now); count(db, 'envoi', '', now); count(db, 'inscrit', '', now);
  const r = funnelReport(db, '2026-11-28', '2026-11-28');
  assert.deepEqual(r.etapes, { visite: 10, demo_vue: 0, page_inscription: 4, formulaire_commence: 2, envoi: 2, inscrit: 1 });
  assert.equal(r.canaux.google, 6); assert.equal(r.erreursParChamp.email, 1);
  assert.equal(r.taux.visiteVersPageInscription, 40); assert.equal(r.abandonsFormulaire, 1);
});

test('parcours réel mesuré de bout en bout (visite → inscription), robots ignorés', async () => {
  const { setup, signup } = await import('./helpers.js');
  const app = await setup();
  try {
    const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)' };
    const c = app.client();
    await c.get('/', { ...UA, referer: 'https://www.google.fr/' });
    await c.get('/metiers/garage', UA); // même visiteur, même jour : une seule visite
    await app.client().get('/', { 'user-agent': 'Googlebot/2.1' });
    await c.get('/inscription', UA);
    await c.post('/f/commence', {}, UA);
    await c.submit('/inscription', '/inscription', { business: '', name: 'X', email: 'pas-un-email', password: 'MotDePasse2026', cgu: 'on', plan: 'pro' });
    const day = new Date().toISOString().slice(0, 10);
    const r = funnelReport(app.db, day, day);
    assert.equal(r.etapes.visite, 1); assert.equal(r.canaux.google, 1);
    assert.equal(r.etapes.formulaire_commence, 1); assert.ok(r.etapes.envoi >= 1);
    assert.ok(r.erreursParChamp.email >= 1 && r.erreursParChamp.entreprise >= 1);
    await signup(app, { email: 'funnel@test.fr' });
    assert.equal(funnelReport(app.db, day, day).etapes.inscrit, 1);
  } finally { app.close(); }
});

test('démonstrations : vues réelles comptées, administrateur et robots exclus', async () => {
  const { setup } = await import('./helpers.js');
  const { prepareDemo } = await import('../src/prospect.js');
  const app = await setup();
  try {
    const db = app.db;
    db.run("INSERT INTO prospects(name, city, tpl, status, created_at) VALUES('Démo Test','Cayenne','garage','new',1)");
    const id = db.one("SELECT id FROM prospects WHERE name='Démo Test'").id;
    const tok = prepareDemo(db, id).demoToken;
    const n = () => db.one("SELECT COALESCE(SUM(n),0) n FROM visits_source WHERE source='demo'").n;
    assert.equal((await app.client().get('/demo/' + tok, { 'user-agent': 'curl/8.0' })).status, 200);
    assert.equal(n(), 0, 'robot ignoré');
    await app.client().get('/demo/' + tok, { 'user-agent': 'Mozilla/5.0 (iPhone)' });
    assert.equal(n(), 1, 'vraie visite comptée');
  } finally { app.close(); }
});
