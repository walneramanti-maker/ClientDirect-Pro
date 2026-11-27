import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, jsonResponse } from './helpers.js';
import { ACTIVITIES, CATEGORIES, matchActivity, activityTemplate, extensionTargets } from '../src/activities.js';

const app = await setup({ PROSPECT_PAUSE_MS: '0' });
const { db } = app;
test.after(() => app.close());
const P = await import('../src/prospect.js');

test('catalogue : plus de 100 activités rangées en catégories, libellés FR et EN', () => {
  const list = Object.values(ACTIVITIES);
  assert.ok(list.length >= 100, String(list.length));
  assert.ok(Object.keys(CATEGORIES).length >= 12);
  for (const a of list) { assert.ok(CATEGORIES[a.cat], a.key); assert.ok(a.label && a.labelEn, a.key); }
});

test('« Autre activité » : le texte libre est rapproché d’un métier proche, sinon modèle générique', () => {
  assert.equal(matchActivity('toiletteuse pour chiens')?.key, 'toilettage');
  assert.equal(matchActivity('prof de yoga')?.key, 'yoga');
  const T = activityTemplate('autre', 'Fabricant de pirogues traditionnelles', 'fr', {});
  assert.equal(T.metier, 'Fabricant de pirogues traditionnelles'); assert.ok(T.services.length >= 3);
  assert.ok(T.services.every((s) => s[1] === 0), 'aucun prix inventé');
});

async function signupWith(form) {
  app.sec.resetRateLimits(); const c = app.client();
  const r = await c.submit('/inscription', '/inscription', { business: 'Biz', city: 'Cayenne', tz: 'America/Cayenne', phone: '0694000001', plan: 'pro', name: 'Test', password: 'MotDePasse2026', cgu: 'on', ...form });
  return { c, r, t: db.one('SELECT t.* FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email=?', form.email) };
}

test('inscription : nouvelle activité → site adapté, tarifs masqués tant que le pro ne les a pas validés', async () => {
  const { c, r, t } = await signupWith({ email: 'plomb@test.fr', activity: 'plombier', business: 'Plomberie Durand' });
  assert.equal(r.status, 303); assert.equal(t.activity, 'plombier'); assert.equal(t.prices_confirmed, 0);
  const site = await app.client().get(`/s/${t.slug}`);
  assert.match(site.text, /Plombier/); assert.match(site.text, /Dépannage plomberie/); assert.match(site.text, /Tarif sur demande/);
  const pro = await c.get('/pro'); assert.match(pro.text, /Vérifier mes prestations/);
});

test('inscription : « Autre activité » exige une précision, puis génère le site avec le libellé saisi', async () => {
  const bad = await signupWith({ email: 'autre0@test.fr', activity: 'autre', activity_other: '' });
  assert.notEqual(bad.r.status, 303); assert.ok(!bad.t);
  const { r, t } = await signupWith({ email: 'autre1@test.fr', activity: 'autre', activity_other: 'Réparateur de pirogues' });
  assert.equal(r.status, 303); assert.equal(t.activity, 'autre'); assert.equal(t.activity_other, 'Réparateur de pirogues');
  const site = await app.client().get(`/s/${t.slug}`); assert.match(site.text, /Réparateur de pirogues/);
});

test('ancien formulaire (champ tpl) toujours accepté', async () => {
  const { r, t } = await signupWith({ email: 'old@test.fr', tpl: 'garage' });
  assert.equal(r.status, 303); assert.equal(t.activity, 'garage');
});

test('pages métiers : une page par activité, dans le plan du site, lien d’inscription direct', async () => {
  const c = app.client();
  const idx = await c.get('/metiers'); assert.match(idx.text, /\/metiers\/plombier/); assert.match(idx.text, /\/metiers\/hebergement/);
  const p = await c.get('/metiers/plombier'); assert.equal(p.status, 200); assert.match(p.text, /inscription\?activite=plombier/);
  assert.doesNotMatch(p.text, /à partir de/, 'pas de prix fictif');
  assert.match(p.text, /hreflang="x-default"/);
  assert.equal((await c.get('/metiers/nimporte-quoi')).status, 404);
  const sm = await c.get('/sitemap.xml'); assert.match(sm.text, /\/metiers\/yoga</);
  const ins = await c.get('/inscription?activite=yoga'); assert.match(ins.text, /<option value="yoga"[^>]*selected/);
});

test('prospection : les nouvelles activités sont ciblées progressivement, hors professions réglementées', async () => {
  const T = extensionTargets([]); const keys = T.map((x) => x.activity);
  assert.ok(T.length >= 50); assert.ok(!keys.includes('avocat') && !keys.includes('medecin'));
  const seen = []; let n = 500000000;
  app.net.setFetch(async (url) => { seen.push(String(url)); const naf = decodeURIComponent(/activite_principale=([^&]+)/.exec(String(url))?.[1] || '').split(',')[0]; return jsonResponse({ total_pages: 1, results: [{ siren: String(n++), nom_complet: 'ENT', activite_principale: naf, date_creation: '2024-01-01', tranche_effectif_salarie: 'NN', siege: { siret: '1', libelle_commune: 'VILLE', code_postal: '75011', adresse: '1 rue' } }] }); });
  const before = db.one('SELECT COUNT(*) n FROM outbox').n;
  const r = await P.runExtensionCampaign(db, { calls: 4, pause: 0 });
  assert.equal(r.calls, 4); assert.ok(r.added >= 1, JSON.stringify(r));
  const acts = db.all("SELECT DISTINCT activity FROM prospects WHERE activity IS NOT NULL").map((x) => x.activity);
  assert.ok(acts.some((a) => P.EXT_TARGETS.some((x) => x.activity === a)), acts.join());
  assert.equal(db.one('SELECT COUNT(*) n FROM outbox').n, before, 'aucun message envoyé');
  assert.equal(Number(db.one("SELECT v FROM meta WHERE k='prospect_cursor_ext'").v), 4, 'reprend là où elle s’est arrêtée');
});
