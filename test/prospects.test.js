// Prospection préparée à l'avance : démos stables, opposition respectée, aucun doublon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, jsonResponse } from './helpers.js';

const app = await setup({ ADMIN_EMAIL: 'admin@cdp.fr' });
test.after(() => app.close());
const P = await import('../src/prospect.js');
const { stopTokenFor } = await import('../src/privacy.js');
const REG = {
  '911879419': { siren: '911879419', nom_complet: 'CHWITNESS INSTITUT (CHWITNESS INSTITUT)', activite_principale: '96.02B', date_creation: '2022-03-01', tranche_effectif_salarie: 'NN', siege: { commune: '97311', libelle_commune: 'SAINT-LAURENT-DU-MARONI', adresse: '3 RUE DANIEL GASTON DARQUITAIN 97320 SAINT-LAURENT-DU-MARONI' } },
  '995141322': { siren: '995141322', nom_complet: 'EBELL-MAEL FERNANDES (FERNANDES MULTISERVICE)', activite_principale: '45.20A', date_creation: '2026-01-10', tranche_effectif_salarie: 'NN', siege: { commune: '97311', libelle_commune: 'SAINT-LAURENT-DU-MARONI', adresse: '12 RUE X 97320 SAINT-LAURENT-DU-MARONI' } },
  '777000777': { siren: '777000777', nom_complet: 'REFUS PROSPECTION', activite_principale: '45.20A', opposition_diffusion_commerciale: true, siege: {} }
};
app.net.setFetch(async (url) => { const q = new URL(url).searchParams.get('q'); return jsonResponse({ results: REG[q] ? [REG[q]] : [] }); });

test('prospects : démos préparées avec liens stables, nom commercial (pas le nom de la personne)', async () => {
  const r = await P.seedProspects(app.db, ['911879419', '995141322', '777000777', 'abc'], { pause: 0 });
  assert.deepEqual({ imported: r.imported, demos: r.demos, skipped: r.skipped }, { imported: 2, demos: 2, skipped: 1 });
  const tok = P.demoTokenFor('995141322');
  const page = await app.client().get(`/demo/${tok}`);
  assert.equal(page.status, 200); assert.match(page.text, /Fernandes Multiservice/); assert.doesNotMatch(page.text, /EBELL-MAEL/);
  assert.match(page.text, /Démonstration non officielle/); assert.match(page.text, /noindex/);
  assert.equal(P.displayName('WEI FENG ZHOU (RESTAURANT MAOYUAN)'), 'Restaurant Maoyuan');
  assert.equal(P.displayName('MARONI PROP AUTO SLM'), 'Maroni Prop Auto SLM');
});
test('prospects : relancer la préparation ne crée aucun doublon et garde les mêmes liens', async () => {
  const before = app.db.one("SELECT COUNT(*) n FROM tenants WHERE status='demo'").n;
  await P.seedProspects(app.db, ['911879419', '995141322'], { pause: 0 });
  assert.equal(app.db.one("SELECT COUNT(*) n FROM tenants WHERE status='demo'").n, before);
  assert.equal((await app.client().get(`/demo/${P.demoTokenFor('911879419')}`)).status, 200);
});
test('prospects : l’opposition supprime la démo, alerte l’administrateur et bloque toute nouvelle préparation', async () => {
  const stop = `/stop/${stopTokenFor('911879419')}`; const v = app.client();
  assert.match((await v.submit(stop, stop, {})).text, /ne serez plus contacté/);
  assert.equal((await app.client().get(`/demo/${P.demoTokenFor('911879419')}`)).status, 404);
  assert.ok(app.db.one("SELECT 1 FROM outbox WHERE template='admin_alert' AND payload LIKE '%911879419%'"));
  const r = await P.seedProspects(app.db, ['911879419'], { pause: 0 }); assert.equal(r.skipped, 1);
  assert.equal((await app.client().get(`/demo/${P.demoTokenFor('911879419')}`)).status, 404);
});
