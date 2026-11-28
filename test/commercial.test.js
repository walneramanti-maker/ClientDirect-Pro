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

test('e-mails publics : lus gratuitement sur le site de l’entreprise, une seule visite par entreprise', async () => {
  const { freeEmailPass } = await import('../src/enrich.js');
  db.run("INSERT INTO prospects(siren,name,naf,tpl,city,postal,created_at,website,potential) VALUES('900000001','Garage Libre','45.20A','garage','Cayenne','97300',?,'https://garage-libre.fr',80)", Date.now());
  const seen = [];
  app.net.setFetch(async (url) => { seen.push(String(url)); return new Response(String(url).endsWith('/contact') ? '<a href="mailto:contact@garage-libre.fr">Écrire</a> logo@2x.png' : '<p>Bienvenue</p>', { status: 200, headers: { 'content-type': 'text/html' } }); });
  const r = await freeEmailPass(db, { max: 5 });
  assert.equal(r.found, 1); assert.equal(db.one("SELECT email FROM prospects WHERE siren='900000001'").email, 'contact@garage-libre.fr');
  assert.ok(seen.every((u) => u.startsWith('https://garage-libre.fr')), 'seul le site de l’entreprise est lu (aucun service payant)');
  assert.equal((await freeEmailPass(db, { max: 5 })).checked, 0, 'pas de seconde visite');
});

test('fiabilité des e-mails : domaine sans messagerie, adresse automatique ou jetable écartés ; seules les adresses fiables vont en campagne', async () => {
  const { verifyEmails } = await import('../src/suppression.js');
  const add = (siren, email) => db.run("INSERT INTO prospects(siren,name,naf,tpl,city,postal,created_at,email,potential,dept) VALUES(?,?,?,?,?,?,?,?,80,'973')", siren, 'ENT ' + siren, '45.20A', 'garage', 'Cayenne', '97300', Date.now(), email);
  add('910000001', 'Contact@Garage-Bon.fr'); add('910000002', 'contact@domaine-mort.fr'); add('910000003', 'noreply@garage-bon.fr'); add('910000004', 'x@yopmail.com');
  const resolveMx = async (d) => { if (d === 'garage-bon.fr') return [{ exchange: 'mx.garage-bon.fr', priority: 10 }]; const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e; };
  const r = await verifyEmails(db, { resolveMx });
  assert.equal(r.fiables, 1);
  for (const x of ['910000002', '910000003', '910000004']) assert.equal(db.one('SELECT email_ok FROM prospects WHERE siren=?', x).email_ok, 0, x);
  assert.equal(db.one("SELECT email, email_ok FROM prospects WHERE siren='910000001'").email, 'contact@garage-bon.fr');
  const C = await import('../src/campaigns.js');
  assert.equal(C.countEligible(db, { channel: 'email', depts: ['973'] }), 1, 'seule l’adresse vérifiée est éligible');
});
