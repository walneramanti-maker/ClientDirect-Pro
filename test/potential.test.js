import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, jsonResponse } from './helpers.js';

const app = await setup({ FIRECRAWL_API_KEY: 'fc-test', PROSPECT_PAUSE_MS: '0', ENRICH_PACING: '0', OSM_ENRICH: '1' });
const { db } = app;
test.after(() => app.close());
const E = await import('../src/enrich.js');
const P = await import('../src/prospect.js');
const POT = await import('../src/potential.js');
const OSM = await import('../src/osm.js');

const add = (siren, name, postal, city, tpl = 'coiffeur') => P.importProspects(db, [{ siren, siret: siren + '00011', name, naf: '96.02A', tpl, city, postal, address: `1 RUE X ${postal} ${city}`, created_on: '2024-01-01', dept: postal.slice(0, 3) === '973' ? '973' : postal.slice(0, 2) }]);
const row = (siren) => db.one('SELECT * FROM prospects WHERE siren=?', siren);

test('analyse de site : vieillissant, sans réservation ni devis', () => {
  const old = POT.analyzeSite({ url: 'http://salon-ancien.fr/', html: '<html><body><font size=2>Bienvenue</font><form><input name=q></form></body></html>', md: '© 2016 Salon Ancien' }, 2026);
  assert.equal(old.status, 'vieillissant');
  assert.ok(old.reasons.includes('pas de connexion sécurisée (https)'));
  assert.ok(old.reasons.includes('non adapté au téléphone'));
  assert.ok(old.reasons.includes('mis à jour en 2016'));
  assert.equal(old.booking, false); assert.equal(old.quote, false);
  const fresh = POT.analyzeSite({ url: 'https://salon-neuf.fr/', html: '<meta name="viewport" content="width=device-width"><a href="https://www.planity.com/x">Réserver</a><form><input type="email"><textarea></textarea></form>', md: 'Demandez votre devis gratuit. © 2026' }, 2026);
  assert.equal(fresh.status, 'récent'); assert.equal(fresh.booking, true); assert.equal(fresh.quote, true);
});

test('potentiel : pas de site > plateforme > site vieillissant > site récent', () => {
  const base = { score: 3, phone: '+594594000000' };
  const none = POT.potentialOf({ ...base, site_status: 'aucun' }).potential;
  const fb = POT.potentialOf({ ...base, website: 'https://www.facebook.com/salon' }).potential;
  const old = POT.potentialOf({ ...base, site_status: 'vieillissant', site_flags: JSON.stringify({ reasons: ['non adapté au téléphone'], booking: false, quote: false }) });
  const fresh = POT.potentialOf({ ...base, site_status: 'récent', site_flags: JSON.stringify({ booking: true, quote: true }) }).potential;
  assert.ok(none > fb && fb > old.potential && old.potential > fresh, `${none} > ${fb} > ${old.potential} > ${fresh}`);
  assert.ok(old.why.some((w) => w.includes('pas de réservation en ligne')));
  assert.ok(POT.potentialOf({ score: 3, site_status: 'aucun' }).potential < none, 'pas encore joignable : un peu moins prioritaire');
});

test('requête OpenStreetMap : code postal nettoyé, téléphone exigé', () => {
  const q = OSM.overpassQuery('97300"];out;');
  assert.ok(q.includes('"postal_code"="97300out"') || q.includes('"97300'), q);
  assert.ok(!q.includes('"];out;"]'), 'pas d’injection dans la requête');
  assert.ok(q.includes('phone'));
});

test('OpenStreetMap d’abord (gratuit) : entreprises sans site gardées et prioritaires, Firecrawl seulement pour le reste', async () => {
  add('600000001', 'LUCIE NOEL (SALON LUCIE COIFFURE)', '97300', 'CAYENNE');
  add('600000002', 'SARL BEL HAIR', '97300', 'CAYENNE');
  add('600000003', 'INTROUVABLE OSM', '97300', 'CAYENNE');
  db.run("INSERT INTO meta(k,v) VALUES('enrich_monthly_credits','100') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const firecrawl = [];
  app.net.setFetch(async (url, opt) => {
    if (String(url).includes('overpass')) {
      assert.match(decodeURIComponent(opt.body), /97300/);
      return jsonResponse({ elements: [
        { tags: { name: 'Salon Lucie Coiffure', phone: '+594 594 11 22 33', 'addr:city': 'Cayenne' } },
        { tags: { name: 'Bel Hair', 'contact:phone': '0594 44 55 66;0694 00 00 00', website: 'http://belhair-cayenne.fr', 'addr:postcode': '97300' } }
      ] });
    }
    const body = JSON.parse(opt.body); firecrawl.push(body);
    if (body.alexandria) return jsonResponse({ success: true, data: { alexandria: [{ data: { results: [] } }] } });
    assert.equal(body.url, 'http://belhair-cayenne.fr/');
    assert.ok(body.formats.includes('rawHtml'), 'la même lecture sert à l’analyse du site');
    return jsonResponse({ success: true, data: { markdown: 'Contact : contact@belhair-cayenne.fr © 2017', rawHtml: '<html><body>Bel Hair</body></html>', metadata: { statusCode: 200 } } });
  });
  const r = await E.enrichBatch(db, { maxSearches: 5 });
  assert.equal(r.osm.found, 2, 'deux entreprises trouvées gratuitement');
  const lucie = row('600000001');
  assert.equal(lucie.phone, '+594594112233', 'format international'); assert.equal(lucie.website, null);
  assert.equal(lucie.site_status, 'aucun_probable'); assert.match(lucie.contact_source, /OpenStreetMap.*ODbL/);
  const bel = row('600000002');
  assert.equal(bel.phone, '+594594445566', 'premier numéro seulement, format international'); assert.equal(bel.email, 'contact@belhair-cayenne.fr');
  assert.equal(bel.site_status, 'vieillissant');
  assert.equal(firecrawl.filter((b) => b.alexandria).length, 1, 'une seule recherche Maps, pour l’entreprise introuvable');
  assert.equal(r.credits, 11, '10 (Maps) + 1 (lecture du site), rien pour les entreprises trouvées sur OpenStreetMap');
  assert.ok(lucie.potential > bel.potential, 'l’entreprise sans site passe en premier');
  assert.ok(row('600000003').potential < bel.potential, 'non joignable : en dernier');
  // Deuxième passage : rien n'est redemandé à OpenStreetMap
  let overpass = 0; app.net.setFetch(async (url) => { if (String(url).includes('overpass')) overpass++; return jsonResponse({ success: true, data: { alexandria: [{ data: { results: [] } }] } }); });
  await E.enrichBatch(db, { maxSearches: 5 });
  assert.equal(overpass, 0);
});

test('OpenStreetMap saturé : arrêt propre sans bloquer la suite', async () => {
  add('600000010', 'GARAGE TEST OSM', '75011', 'PARIS', 'garage');
  app.net.setFetch(async (url) => String(url).includes('overpass') ? new Response('busy', { status: 429 }) : jsonResponse({ success: true, data: { alexandria: [{ data: { results: [] } }] } }));
  const r = await E.osmPass(db, {});
  assert.match(r.stopped, /429/);
  assert.equal(row('600000010').osm_checked_at, null, 'sera retenté au prochain passage');
});

test('appel : accroche adaptée au site, campagne filtrée par potentiel', async () => {
  const C = await import('../src/campaigns.js');
  assert.match(C.callOpener({ site_status: 'aucun' }), /pas trouvé de site/);
  assert.match(C.callOpener({ site_status: 'vieillissant', site_flags: JSON.stringify({ reasons: ['non adapté au téléphone'], booking: false, quote: true }) }), /ancien \(non adapté au téléphone\)\. pas de réservation en ligne/);
  assert.match(C.callOpener({ site_status: 'récent', site_flags: JSON.stringify({ booking: true, quote: true }) }), /Premium/);
  const id = C.createCampaign(db, { name: 'Sans site', channel: 'appel', minPotential: 75, size: 50 });
  const items = db.all('SELECT p.potential FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=?', id);
  assert.ok(items.length >= 1 && items.every((x) => x.potential >= 75), JSON.stringify(items));
  assert.match(db.one('SELECT message FROM campaign_items WHERE campaign_id=?', id).message, /Accroche/);
});

test('OpenStreetMap : serveur saturé (502), bascule automatique sur un autre serveur', async () => {
  OSM.resetOsmHealth(); const seen = [];
  app.net.setFetch(async (url) => { seen.push(String(url)); return seen.length === 1 ? new Response('busy', { status: 502 }) : jsonResponse({ elements: [{ tags: { name: 'Test', phone: '+33100000000' } }] }); });
  const list = await OSM.osmPlaces('75011', 'PARIS');
  assert.equal(list.length, 1); assert.equal(seen.length, 2); assert.notEqual(seen[0], seen[1]);
});

test('vérification au registre : code postal pris dans l’adresse de la fiche (commune voisine)', async () => {
  let asked = '';
  app.net.setFetch(async (url) => { asked = String(url); return jsonResponse({ results: [] }); });
  await E.verifyInSirene({ name: 'Salon Kalina', address: '12 Route de Montabo, 97354 Rémire-Montjoly' }, { postal: '97300', city: 'CAYENNE', tpl: 'coiffeur' });
  assert.match(asked, /code_postal=97354/);
});

test('RGPD : opposition permanente (SIREN, téléphone, e-mail), jamais réimportée ni recontactée', async () => {
  const SU = await import('../src/suppression.js');
  assert.equal(SU.normPhone('0694 12 34 56'), '+594694123456');
  assert.equal(SU.normPhone('05 90 11 22 33'), '+590590112233');
  assert.equal(SU.normPhone('0262 11 22 33'), '+262262112233');
  assert.equal(SU.normPhone('06 12 34 56 78'), '+33612345678');
  assert.equal(SU.normPhone('0899 12 34 56'), null, 'surtaxé refusé');
  assert.equal(SU.normPhone('12'), null);
  add('600000020', 'OPPOSANT SARL', '13001', 'MARSEILLE', 'garage');
  const p = row('600000020');
  db.run("UPDATE prospects SET phone='04 91 00 00 01', email='contact@opposant.fr' WHERE id=?", p.id);
  SU.applyOptout(db, p.id);
  const o = row('600000020');
  assert.equal(o.status, 'optout'); assert.equal(o.phone, null); assert.equal(o.email, null);
  assert.equal(db.one("SELECT COUNT(*) n FROM suppressions").n >= 3, true, 'empreintes conservées');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM suppressions')).includes('opposant'), 'aucune donnée en clair');
  // Supprimé puis retrouvé dans le registre : jamais réimporté
  db.run('DELETE FROM prospects WHERE id=?', p.id);
  assert.equal(P.importProspects(db, [{ siren: '600000020', siret: '60000002000011', name: 'OPPOSANT SARL', naf: '45.20A', tpl: 'garage', city: 'MARSEILLE', postal: '13001', address: '', created_on: '2024-01-01', dept: '13' }]), 0);
  // Même téléphone sous un autre SIREN : mis en opposition au contrôle qualité
  add('600000021', 'AUTRE NOM MEME TEL', '13001', 'MARSEILLE', 'garage');
  db.run("UPDATE prospects SET phone='+33491000001' WHERE siren='600000021'");
  const q = SU.cleanContacts(db);
  assert.ok(q.suppressed >= 1); assert.equal(row('600000021').status, 'optout');
});

test('contrôle qualité : doublons de téléphone retirés, meilleure fiche gardée', async () => {
  const SU = await import('../src/suppression.js');
  add('600000030', 'GARAGE A', '69001', 'LYON', 'garage'); add('600000031', 'GARAGE A BIS', '69001', 'LYON', 'garage');
  db.run("UPDATE prospects SET phone='04 78 00 00 09', potential=90 WHERE siren='600000030'");
  db.run("UPDATE prospects SET phone='+33478000009', potential=40 WHERE siren='600000031'");
  const r = SU.cleanContacts(db);
  assert.ok(r.duplicates >= 1);
  assert.equal(row('600000030').phone, '+33478000009'); assert.equal(row('600000031').phone, null);
  assert.match(row('600000031').contact_source, /doublon/);
});
