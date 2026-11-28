// Assistant IA et WhatsApp : « bientôt disponible » tant que non branchés, réservés aux abonnés payants,
// plafonds par client et budget global limité à une part du revenu récurrent (0 client payant = 0 € dépensé).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup();
const { db } = app;
test.after(() => app.close());
const cfg = (await import('../src/config.js')).config;
const { answer, aiSpentEur, aiBudgetEur, aiAvailable } = await import('../src/ai.js');
const { loadTenant } = await import('../src/tenants.js');
const N = await import('../src/notify.js');
const aiOk = () => jsonResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Nous ouvrons à 8 h.' }], usage: { input_tokens: 3000, output_tokens: 300 } });

test('sans clés : les formules affichent « bientôt disponible »', async () => {
  const h = (await app.client().get('/')).text;
  assert.match(h, /bientôt disponible/); assert.match(h, /WhatsApp bientôt disponible/);
});
test('avec clés : plus de mention « bientôt disponible »', async () => {
  Object.assign(cfg, { anthropicKey: 'sk-test', waToken: 'tok', waPhoneId: '123' });
  try { assert.doesNotMatch((await app.client().get('/')).text, /bientôt disponible/i); }
  finally { Object.assign(cfg, { anthropicKey: '', waToken: '', waPhoneId: '' }); }
});

test('aucun client payant : budget 0 €, aucun appel payant même avec la clé', async () => {
  const { t } = await signup(app, { business: 'Garage Essai', email: 'essai@test.fr', plan: 'premium' });
  const tn = loadTenant(db, 'id', t.id); let calls = 0;
  Object.assign(cfg, { anthropicKey: 'sk-test' }); app.net.setFetch(async () => { calls++; return aiOk(); });
  try {
    assert.equal(aiAvailable(tn), false, 'essai gratuit : pas de service payant');
    assert.equal((await answer(db, tn, 'e1', 'Vous ouvrez quand ?')).mode, 'simple'); assert.equal(calls, 0);
    assert.equal(aiBudgetEur(db), 0); assert.equal(N.waBudgetEur(db), 0);
  } finally { Object.assign(cfg, { anthropicKey: '' }); }
});

test('abonné Premium payé : IA active (Haiku, effort bas), puis plafond global = 2 % du revenu récurrent', async () => {
  const { t } = await signup(app, { business: 'Garage Payant', email: 'payant@test.fr', plan: 'premium' });
  db.run("UPDATE tenants SET status='active' WHERE id=?", t.id); const tn = loadTenant(db, 'id', t.id);
  const bodies = []; Object.assign(cfg, { anthropicKey: 'sk-test' }); app.net.setFetch(async (u, o) => { bodies.push(JSON.parse(o.body)); return aiOk(); });
  try {
    assert.equal(aiBudgetEur(db), Math.min(cfg.aiMonthlyBudgetEur, 249 * 0.02));
    const r = await answer(db, tn, 'p1', 'Vous ouvrez quand ?');
    assert.equal(r.mode, 'ia'); assert.equal(bodies[0].model, 'claude-haiku-5-5'); assert.deepEqual(bodies[0].output_config, { effort: 'low' });
    db.run("UPDATE ai_usage SET in_tokens=in_tokens+100000000 WHERE tenant_id=?", t.id); // simule un mois très consommateur
    assert.ok(aiSpentEur(db) >= aiBudgetEur(db));
    assert.equal((await answer(db, tn, 'p1', 'Et samedi ?')).mode, 'simple'); assert.equal(bodies.length, 1, 'plus aucun appel payant');
    assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='ai' AND message LIKE 'Plafond mensuel%'"));
  } finally { Object.assign(cfg, { anthropicKey: '' }); }
});

test('WhatsApp : réservé aux abonnés payés, limite par client, budget global puis e-mail seul', async () => {
  const { t } = await signup(app, { business: 'Garage WA', email: 'wa@test.fr', plan: 'pro' });
  Object.assign(cfg, { waToken: 'tok', waPhoneId: '123', waMonthlyPerTenant: 2 }); let calls = 0;
  app.net.setFetch(async () => { calls++; return jsonResponse({ messages: [{ id: 'wamid' }] }); });
  try {
    assert.equal(N.waAllowedFor(db, loadTenant(db, 'id', t.id)), false, 'essai : pas de WhatsApp payant');
    db.run("UPDATE tenants SET status='active' WHERE id=?", t.id); const tn = loadTenant(db, 'id', t.id);
    assert.equal(N.waAllowedFor(db, tn), true);
    for (const k of ['a', 'b']) N.enqueue(db, { tenantId: t.id, channel: 'whatsapp', to: '33612345678', template: 'appt_reminder', payload: { lang: 'fr', name: 'M', tenant: 'G', service: 'V', when: 'x' }, key: k });
    assert.equal(N.waAllowedFor(db, tn), false, 'limite mensuelle du client atteinte');
    db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,status,next_at,created_at) SELECT tenant_id,channel,to_addr,template,payload,'sent',next_at,created_at FROM outbox WHERE channel='whatsapp' LIMIT 1");
    for (let i = 0; i < 700; i++) db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,status,next_at,created_at) VALUES(?,'whatsapp','33600000000','appt_reminder','{}','sent',0,?)", t.id, Date.now());
    await N.processOutbox(db);
    assert.equal(calls, 0, 'budget global dépassé : rien n’est envoyé'); assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='whatsapp' AND message LIKE 'Plafond mensuel%'"));
  } finally { Object.assign(cfg, { waToken: '', waPhoneId: '', waMonthlyPerTenant: 200 }); }
});
