import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, jsonResponse } from './helpers.js';

const app = await setup({ FIRECRAWL_API_KEY: 'fc-test', PROSPECT_PAUSE_MS: '0', OSM_ENRICH: '0' });
const { db } = app;
test.after(() => app.close());
const E = await import('../src/enrich.js');
const P = await import('../src/prospect.js');

const add = (siren, name, postal, city, tpl = 'garage') => P.importProspects(db, [{ siren, siret: siren + '00011', name, naf: '45.20A', tpl, city, postal, address: `1 RUE X ${postal} ${city}`, created_on: '2024-01-01', dept: postal.slice(0, 2) }]);

test('coordonnées : arrêt total tant qu’aucun plafond n’est autorisé', async () => {
  add('500000001', 'DUPONT JEAN (GARAGE DU FLEUVE)', '69003', 'LYON');
  let called = 0; app.net.setFetch(async () => { called++; return jsonResponse({}); });
  assert.equal(E.enrichEnabled(db), false, 'clé présente mais plafond à 0');
  const r = await E.enrichBatch(db); assert.equal(r.stopped, 'désactivé'); assert.equal(called, 0, 'aucun appel, aucun crédit');
});

test('coordonnées : une recherche par ville et métier, téléphone, site et e-mail générique', async () => {
  add('500000002', 'MARTIN PAUL (ATELIER MARTIN AUTO)', '69003', 'LYON');
  add('500000003', 'SARL INTROUVABLE MECA', '69003', 'LYON');
  db.run("INSERT INTO meta(k,v) VALUES('enrich_monthly_credits','100') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const calls = [];
  app.net.setFetch(async (url, opt) => {
    const body = JSON.parse(opt.body); calls.push(body);
    if (body.alexandria) {
      assert.equal(body.alexandria.provider, 'firecrawl-maps'); assert.equal(body.alexandria.options.country, 'fr'); assert.equal(body.alexandria.options.locality, '69003');
      return jsonResponse({ success: true, data: { alexandria: [{ provider: 'firecrawl-maps', capability: 'businesses/search', data: { results: [
        { name: 'Garage du Fleuve', address: '12 Rue Duguesclin, 69003 Lyon', phone: '04 78 00 00 01', phone_e164: '+33478000001', website: 'https://garagedufleuve.fr/', business_status: 'operational' },
        { name: 'Atelier Martin', address: '5 Cours Gambetta, 69003 Lyon', phone_e164: '+33478000002', business_status: 'operational' },
        { name: 'Garage Fermé', address: '69003 Lyon', business_status: 'permanently_closed' }
      ] } }] } });
    }
    assert.equal(body.url, 'https://garagedufleuve.fr/');
    return jsonResponse({ success: true, data: { markdown: 'Écrivez-nous : contact@garagedufleuve.fr ou jean.dupont@gmail.com — logo@2x.png', metadata: { statusCode: 200 } } });
  });
  const r = await E.enrichBatch(db, { maxSearches: 5 });
  assert.equal(r.searches, 1, 'trois entreprises de la même ville et du même métier : une seule recherche');
  assert.equal(r.matched, 2); assert.equal(r.emails, 1); assert.equal(r.credits, 11);
  const a = db.one("SELECT * FROM prospects WHERE siren='500000001'");
  assert.equal(a.phone, '+33478000001'); assert.equal(a.website, 'https://garagedufleuve.fr/'); assert.equal(a.email, 'contact@garagedufleuve.fr', 'adresse générique préférée');
  assert.match(a.contact_source, /fiche publique/);
  assert.equal(db.one("SELECT phone FROM prospects WHERE siren='500000002'").phone, '+33478000002');
  const c = db.one("SELECT * FROM prospects WHERE siren='500000003'"); assert.equal(c.phone, null); assert.equal(c.contact_source, 'non trouvé'); assert.ok(c.enriched_at, 'pas recherchée deux fois');
  assert.equal(E.creditsUsed(db), 11);
  assert.equal((await E.enrichBatch(db)).searches, 0, 'rien à refaire');
});

test('coordonnées : le plafond mensuel arrête la dépense', async () => {
  add('500000004', 'GARAGE DES PINS', '13001', 'MARSEILLE'); add('500000005', 'GARAGE DU PORT', '06000', 'NICE');
  db.run("UPDATE meta SET v='15' WHERE k='enrich_monthly_credits'"); // 11 déjà consommés
  let n = 0; app.net.setFetch(async () => { n++; return jsonResponse({ data: { alexandria: [{ data: { results: [] } }] } }); });
  const r = await E.enrichBatch(db, { maxSearches: 5 });
  assert.equal(r.stopped, 'plafond mensuel atteint'); assert.equal(n, 0);
});

test('coordonnées : crédits épuisés chez Firecrawl, arrêt propre', async () => {
  db.run("UPDATE meta SET v='1000' WHERE k='enrich_monthly_credits'");
  app.net.setFetch(async () => new Response('', { status: 402 }));
  const r = await E.enrichBatch(db, { maxSearches: 5 }); assert.equal(r.stopped, 'Crédits Firecrawl épuisés'); assert.equal(r.matched, 0);
});

test('cadence de prospection réglable sans redéploiement', async () => {
  db.run("INSERT INTO meta(k,v) VALUES('prospect_daily','600') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  assert.equal(P.prospectDaily(db), 600);
  assert.equal(P.campaignStatus(db).daily, 600);
});
