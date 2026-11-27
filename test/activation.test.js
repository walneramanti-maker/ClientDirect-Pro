// Assistant IA et WhatsApp : « bientôt disponible » tant que non branchés, plafonds de dépense respectés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ AI_MONTHLY_BUDGET_EUR: '0.001', WA_MONTHLY_BUDGET_EUR: '0.01' });
const { db } = app;
test.after(() => app.close());
const cfg = (await import('../src/config.js')).config;
const { answer, aiSpentEur } = await import('../src/ai.js');
const { loadTenant } = await import('../src/tenants.js');
const N = await import('../src/notify.js');

test('sans clés : les formules affichent « bientôt disponible » (jamais promis comme actif)', async () => {
  const h = (await app.client().get('/')).text;
  assert.match(h, /bientôt disponible/); assert.match(h, /WhatsApp bientôt disponible/);
});

test('avec clés : plus de mention « bientôt disponible »', async () => {
  Object.assign(cfg, { anthropicKey: 'sk-test', waToken: 'tok', waPhoneId: '123' });
  try { const h = (await app.client().get('/')).text; assert.doesNotMatch(h, /bientôt disponible/i); }
  finally { Object.assign(cfg, { anthropicKey: '', waToken: '', waPhoneId: '' }); }
});

test('assistant IA : modèle économique, effort bas, plafond mensuel global puis réponses simples + alerte', async () => {
  const { t } = await signup(app, { business: 'Garage IA', email: 'ia@test.fr', plan: 'premium' });
  const tn = loadTenant(db, 'id', t.id); const bodies = [];
  Object.assign(cfg, { anthropicKey: 'sk-test' });
  app.net.setFetch(async (url, opt) => { bodies.push(JSON.parse(opt.body)); return jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nous ouvrons à 8 h.' }], usage: { input_tokens: 9000, output_tokens: 600 } }); });
  try {
    const r1 = await answer(db, tn, 'c1', 'Vous ouvrez quand ?');
    assert.equal(r1.mode, 'ia'); assert.equal(bodies[0].model, cfg.aiModel); assert.deepEqual(bodies[0].output_config, { effort: 'low' }); assert.equal(bodies[0].max_tokens, 1024);
    assert.ok(aiSpentEur(db) > cfg.aiMonthlyBudgetEur, 'dépense enregistrée');
    const r2 = await answer(db, tn, 'c1', 'Et samedi ?');
    assert.equal(r2.mode, 'simple'); assert.equal(bodies.length, 1, 'aucun appel payant au-delà du plafond');
    assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='ai' AND message LIKE 'Plafond mensuel%'"), 'alerte administrateur');
  } finally { Object.assign(cfg, { anthropicKey: '' }); }
});

test('WhatsApp : plafond mensuel global, ensuite e-mail seul + alerte', async () => {
  Object.assign(cfg, { waToken: 'tok', waPhoneId: '123' }); let calls = 0;
  app.net.setFetch(async () => { calls++; return jsonResponse({ messages: [{ id: 'wamid' }] }); });
  try {
    const p = { lang: 'fr', name: 'Marie', tenant: 'Garage', service: 'Vidange', when: 'sam. 28/11 · 9h', status: 'confirmed' };
    N.enqueue(db, { channel: 'whatsapp', to: '33612345678', template: 'appt_reminder', payload: p, key: 'w1' });
    await N.processOutbox(db); assert.equal(calls, 1);
    N.enqueue(db, { channel: 'whatsapp', to: '33612345679', template: 'appt_reminder', payload: p, key: 'w2' });
    await N.processOutbox(db); assert.equal(calls, 1, 'plafond atteint : pas de second envoi');
    assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='whatsapp' AND message LIKE 'Plafond mensuel%'"));
  } finally { Object.assign(cfg, { waToken: '', waPhoneId: '' }); }
});
