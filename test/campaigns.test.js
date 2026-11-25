import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const app = await setup({ ADMIN_EMAIL: 'admin@cdp.fr' });
const { db } = app;
test.after(() => app.close());
const P = await import('../src/prospect.js');
const C = await import('../src/campaigns.js');

async function makeAdmin() {
  const { hashPassword, newTotpSecret, totpCode } = app.sec; const secret = newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", hashPassword('AdminTresLong2026'), secret, Date.now());
  app.sec.resetRateLimits(); const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  await c.submit('/connexion/2fa', '/connexion/2fa', { code: totpCode(secret) });
  return c;
}
let n = 600000000;
function seed(count, { dept, tpl, email = true, phone = true, score = 5 }) {
  for (let i = 0; i < count; i++) {
    const siren = String(n++); const postal = dept.length === 3 ? dept + '10' : dept + '100';
    P.importProspects(db, [{ siren, siret: '', name: `ENTREPRISE ${siren}`, naf: '', tpl, city: 'VILLE', postal, address: '', created_on: '2025-01-01', dept }]);
    db.run('UPDATE prospects SET score=?, email=?, phone=? WHERE siren=?', score, email ? `contact@e${siren}.fr` : null, phone ? '+33100000000' : null, siren);
  }
}

test('campagne : sélection par critères, message conforme, validation groupée sans envoi', async () => {
  seed(30, { dept: '59', tpl: 'garage' }); seed(10, { dept: '62', tpl: 'coiffeur' }); seed(5, { dept: '59', tpl: 'garage', email: false }); seed(4, { dept: '973', tpl: 'garage', score: 2 });
  assert.equal(C.countEligible(db, { channel: 'email', depts: ['59'], tpls: ['garage'], minScore: 3 }), 30);
  const admin = await makeAdmin();
  const page = await admin.get('/admin/campagnes'); assert.match(page.text, /Aucun envoi automatique/);
  const r = await admin.post('/admin/campagnes', { csrf: admin.csrf(page.text), name: 'Garages Nord', channel: 'email', depts: '59', tpl_garage: 'on', minScore: '3', size: '1000' });
  assert.equal(r.status, 303); const id = Number(r.location.split('/').pop());
  const cmp = db.one('SELECT * FROM campaigns WHERE id=?', id); assert.equal(cmp.size, 30, 'seules les entreprises avec e-mail');
  const det = await admin.get(`/admin/campagnes/${id}`);
  assert.match(det.text, /Valider les 30 messages/); assert.match(det.text, /Essentiel, 79 €\/mois \+ 199 € de mise en service/); assert.match(det.text, /Premium, 249 €\/mois \+ 599 € de mise en service/); assert.match(det.text, /engagement de 12 mois/);
  assert.match(det.text, /accessible uniquement par ce lien personnel/); assert.doesNotMatch(det.text, /visible seulement par vous/);
  assert.match(det.text, /SIRET/);
  // une opposition arrive entre la préparation et la validation
  const one = db.one('SELECT prospect_id FROM campaign_items WHERE campaign_id=? LIMIT 1', id).prospect_id;
  db.run("UPDATE prospects SET status='optout' WHERE id=?", one);
  const outbox = db.one('SELECT COUNT(*) n FROM outbox').n;
  await admin.post(`/admin/campagnes/${id}/valider`, { csrf: admin.csrf(det.text) });
  assert.equal(db.one('SELECT status FROM campaigns WHERE id=?', id).status, 'approved');
  assert.equal(db.one('SELECT COUNT(*) n FROM outbox').n, outbox, 'validation ≠ envoi');
  assert.equal(db.one("SELECT status FROM campaign_items WHERE prospect_id=?", one).status, 'skipped');
  const csv = await admin.get(`/admin/campagnes/${id}/export.csv`); assert.equal((csv.text.match(/contact@e/g) || []).length, 29);
  // pas de double sollicitation : ces entreprises ne peuvent pas entrer dans une autre campagne
  assert.throws(() => C.createCampaign(db, { channel: 'email', depts: ['59'], tpls: ['garage'], minScore: 3 }), /Aucune entreprise/);
  // SMS et appel : téléphone requis, message court ou script
  const sms = C.createCampaign(db, { channel: 'sms', depts: ['62'], tpls: ['coiffeur'], size: 3 });
  const m = db.one('SELECT message FROM campaign_items WHERE campaign_id=? LIMIT 1', sms).message; assert.ok(m.length < 320); assert.match(m, /STOP/);
  const call = C.createCampaign(db, { channel: 'appel', depts: ['59'], tpls: ['garage'], minScore: 0, size: 5 });
  assert.match(db.one('SELECT message FROM campaign_items WHERE campaign_id=? LIMIT 1', call).message, /je ne vous rappellerai pas/);
  assert.equal((await app.client().get('/admin/campagnes')).status === 200, false, 'réservé à l’administrateur');
});
