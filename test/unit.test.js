import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { setup } from './helpers.js';

const app = await setup({ STRIPE_WEBHOOK_SECRET: 'whsec_test' });
const { hashPassword, verifyPassword, passwordProblem, totpCode, totpOk, newTotpSecret, login } = app.sec;
const { verifyStripeSignature } = await import('../src/billing.js');
const util = await import('../src/util.js');
test.after(() => app.close());

test('mots de passe : hachage scrypt, vérification, règles', () => {
  const h = hashPassword('Bonjour2026x');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('Bonjour2026x', h), true);
  assert.equal(verifyPassword('bonjour2026x', h), false);
  assert.notEqual(hashPassword('Bonjour2026x'), h, 'sel unique');
  assert.ok(passwordProblem('court1'));
  assert.ok(passwordProblem('sanschiffresici'));
  assert.equal(passwordProblem('Correct2026ok'), null);
});

test('double authentification TOTP (vecteur RFC 6238)', () => {
  // Secret RFC 6238 "12345678901234567890" en base32, T=59 s => 287082 (6 chiffres)
  assert.equal(totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
  const s = newTotpSecret(); const now = Date.now();
  assert.equal(totpOk(s, totpCode(s, now), now), true);
  assert.equal(totpOk(s, totpCode(s, now - 30000), now), true, 'tolère 30 s de décalage');
  assert.equal(totpOk(s, totpCode(s, now - 120000), now), false);
  assert.equal(totpOk(s, 'abcdef', now), false);
});

test('verrouillage global du compte seulement après 50 échecs (le blocage courant est par compte et par adresse IP)', () => {
  app.db.run("INSERT INTO users(email,pass_hash,role,created_at) VALUES('lock@test.fr',?,'pro',?)", hashPassword('BonMotDePasse1'), Date.now());
  for (let i = 0; i < 8; i++) assert.equal(login(app.db, 'lock@test.fr', 'mauvais').ok, false);
  assert.equal(login(app.db, 'lock@test.fr', 'BonMotDePasse1').ok, true, '8 erreurs d’un tiers ne bloquent pas le titulaire');
  for (let i = 0; i < 50; i++) assert.equal(login(app.db, 'lock@test.fr', 'mauvais').ok, false);
  const r = login(app.db, 'lock@test.fr', 'BonMotDePasse1');
  assert.equal(r.ok, false); assert.equal(r.locked, true);
});

test('signature des notifications Stripe', () => {
  const payload = '{"id":"evt_1"}'; const t = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex');
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${sig}`), true);
  assert.equal(verifyStripeSignature(payload + ' ', `t=${t},v1=${sig}`), false, 'contenu modifié');
  assert.equal(verifyStripeSignature(payload, `t=${t - 600},v1=${crypto.createHmac('sha256', 'whsec_test').update(`${t - 600}.${payload}`).digest('hex')}`), false, 'trop ancien (rejeu)');
  assert.equal(verifyStripeSignature(payload, `t=${t},v1=${'0'.repeat(64)}`), false);
});

test('fuseaux horaires et numéros internationaux', () => {
  assert.equal(new Date(util.zonedToUtc('2026-12-01', '09:00', 'America/Cayenne')).toISOString(), '2026-12-01T12:00:00.000Z');
  assert.equal(new Date(util.zonedToUtc('2026-12-01', '09:00', 'Indian/Reunion')).toISOString(), '2026-12-01T05:00:00.000Z');
  assert.equal(new Date(util.zonedToUtc('2026-07-01', '09:00', 'Europe/Paris')).toISOString(), '2026-07-01T07:00:00.000Z', 'heure d’été');
  assert.equal(util.intlPhone('0694 12 34 56', '594'), '594694123456');
  assert.equal(util.intlPhone('+33 6 12 34 56 78', '594'), '33612345678');
  assert.equal(util.intlPhone('0692 11 22 33', '262'), '262692112233');
  assert.equal(util.phoneOk('123', '594'), false);
});
