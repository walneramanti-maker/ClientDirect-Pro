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

test('campagnes préparées automatiquement : brouillons régénérés chaque jour, jamais validés ni envoyés, campagne validée intacte', async () => {
  db.run("UPDATE prospects SET potential=80 WHERE dept='62'"); db.run("UPDATE prospects SET potential=55 WHERE dept='973'");
  const before = db.one("SELECT COUNT(*) n FROM campaign_items WHERE sent_at IS NOT NULL").n;
  const r1 = C.prepareDrafts(db, Date.UTC(2026, 10, 26));
  assert.ok(r1.email.brouillon && r1.appel.brouillon, JSON.stringify(r1));
  const d1 = db.all("SELECT id, status, channel FROM campaigns WHERE name LIKE ?", `${C.AUTO_PREFIX}%`);
  assert.deepEqual(d1.map((x) => x.status), ['draft', 'draft'], 'brouillons uniquement');
  const msg = db.one('SELECT message FROM campaign_items WHERE campaign_id=? LIMIT 1', r1.email.brouillon).message; assert.match(msg, /\/demo\//);
  // Le lendemain : anciens brouillons annulés et remplacés (liens et prospects à jour), toujours aucun envoi
  const r2 = C.prepareDrafts(db, Date.UTC(2026, 10, 27));
  assert.notEqual(r2.email.brouillon, r1.email.brouillon); assert.equal(r2.email.entreprises, r1.email.entreprises, 'mêmes entreprises reprises'); assert.equal(r2.appel.entreprises, r1.appel.entreprises);
  const both = db.one('SELECT COUNT(*) n FROM campaign_items a JOIN campaign_items b ON a.prospect_id=b.prospect_id WHERE a.campaign_id=? AND b.campaign_id=?', r2.email.brouillon, r2.appel.brouillon).n; assert.equal(both, 0, 'jamais sollicitée deux fois');
  assert.equal(db.one('SELECT status FROM campaigns WHERE id=?', r1.email.brouillon).status, 'canceled');
  assert.equal(db.one("SELECT COUNT(*) n FROM campaigns WHERE name LIKE ? AND status='draft'", `${C.AUTO_PREFIX}%`).n, 2);
  // Une campagne validée par l'administrateur n'est jamais touchée
  C.approveCampaign(db, r2.appel.brouillon); C.prepareDrafts(db, Date.UTC(2026, 10, 28));
  assert.equal(db.one('SELECT status FROM campaigns WHERE id=?', r2.appel.brouillon).status, 'approved');
  assert.equal(db.one("SELECT COUNT(*) n FROM campaign_items WHERE sent_at IS NOT NULL").n, before, 'aucun envoi');
});
