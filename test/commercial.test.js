// Référencement local, IndexNow et bilan commercial quotidien.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup } from './helpers.js';

const app = await setup();
const { db } = app;
test.after(() => app.close());

test('pages territoires : contenu local en français, dans le plan du site, inscription pré-réglée', async () => {
  const c = app.client();
  for (const [slug, code, ville] of [['guyane', 'GF', 'Cayenne'], ['reunion', 'RE', 'Saint-Denis'], ['metropole', 'FR', 'Lyon']]) {
    const p = await c.get(`/territoires/${slug}`);
    assert.equal(p.status, 200); assert.match(p.text, new RegExp(ville)); assert.match(p.text, new RegExp(`inscription\\?pays=${code}`));
    assert.match(p.text, /"@type":"Service"/); assert.match(p.text, /<html lang="fr"/);
  }
  assert.equal((await c.get('/territoires/atlantide')).status, 404);
  assert.match((await c.get('/sitemap.xml')).text, /\/territoires\/martinique</);
});

test('IndexNow : fichier de vérification servi, clé stable', async () => {
  const { indexNowKey } = await import('../src/indexnow.js');
  const k = indexNowKey(db); assert.equal(indexNowKey(db), k);
  const r = await app.client().get(`/indexnow-${k}.txt`); assert.equal(r.status, 200); assert.equal(r.text, k);
  assert.equal((await app.client().get('/indexnow-autre.txt')).status, 404);
});

test('bilan commercial : chiffres réels, comptes internes et exemples exclus, services payants signalés', async () => {
  const { commercialReport } = await import('../src/daily.js');
  const { t } = await signup(app, { business: 'Garage Bilan', email: 'bilan@test.fr', plan: 'pro' });
  const { t: t2 } = await signup(app, { business: 'Compte Interne', email: 'interne@test.fr' });
  db.run('UPDATE tenants SET internal=1 WHERE id=?', t2.id);
  db.run("UPDATE tenants SET status='active' WHERE id=?", t.id);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,?,?,?,?,?,?)", t.id, 'in_bilan', 54800, 'eur', 'paid', Date.now(), Date.now());
  const r = commercialReport(db);
  assert.equal(r.clients.abonnesPayants, 1); assert.equal(r.parFormule.pro, 1); assert.equal(r.argent.revenuRecurrentMensuel, 149);
  assert.equal(r.argent.encaisseMois, 548); assert.ok(r.argent.fraisStripeMois > 0);
  assert.ok(!JSON.stringify(r).includes('Compte Interne') && !JSON.stringify(r).includes('@'), 'aucune donnée personnelle');
  assert.equal(r.servicesPayants.assistantIA, 'désactivé'); assert.equal(r.servicesPayants.whatsapp, 'désactivé');
});
