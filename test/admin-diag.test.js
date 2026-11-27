import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const app = await setup({});
test.after(() => app.close());
const { adminDiagnostic } = await import('../src/bootops.js');
const S = await import('../src/security.js');

test('diagnostic administrateur : correspondances sans divulguer de secret, rien n’est modifié', () => {
  const { db } = app; const secret = S.newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('chef@cdp.fr',?,'A','superadmin',1,?,?)", S.hashPassword('MotDePasseRender2026'), secret, Date.now());
  const before = JSON.stringify(db.all('SELECT * FROM users'));
  const lines = []; const spaced = secret.replace(/(.{4})/g, '$1 ').toLowerCase();
  const ok = adminDiagnostic(db, { ADMIN_LOGIN: ' Chef@cdp.fr', ADMIN_PASSWORD: 'MotDePasseRender2026', ADMIN_TOTP_SECRET: spaced }, S, (l) => lines.push(l));
  assert.equal(ok.compteAdminLogin.motDePasseRenderCorrespond, true); assert.equal(ok.compteAdminLogin.cleDoubleAuthCorrespond, true); assert.equal(ok.variables.ADMIN_LOGIN_espaces, true);
  const bad = adminDiagnostic(db, { ADMIN_LOGIN: 'chef@cdp.fr', ADMIN_PASSWORD: 'autre', ADMIN_TOTP_SECRET: S.newTotpSecret() }, S, (l) => lines.push(l));
  assert.equal(bad.compteAdminLogin.motDePasseRenderCorrespond, false); assert.equal(bad.compteAdminLogin.cleDoubleAuthCorrespond, false);
  assert.equal(adminDiagnostic(db, { ADMIN_LOGIN: 'x@y.fr' }, S, () => {}).compteAdminLogin, 'absent');
  assert.ok(!lines.join().includes('MotDePasseRender2026') && !lines.join().includes(secret) && !lines.join().includes('chef@'), 'aucun secret ni adresse en clair');
  assert.equal(JSON.stringify(db.all('SELECT * FROM users')), before, 'lecture seule');
});

test('clé 2FA : contrôle du format Base32 pour Google Authenticator, alignement strict et sans toucher au reste', async () => {
  const { totpFormat, strictTotp, syncAdminTotp } = await import('../src/bootops.js');
  const good = S.newTotpSecret();
  assert.equal(good.length, 32); assert.equal(totpFormat(good).compatibleGoogleAuthenticator, true); assert.equal(strictTotp(good), good);
  const f = totpFormat('JBSWY3DP=1 8X'); assert.equal(f.compatibleGoogleAuthenticator, false); assert.deepEqual(f.typesInvalides.sort(), ['chiffres 0, 1, 8 ou 9', 'signe = (remplissage)'].sort());
  assert.equal(totpFormat('JBSWY3DPEHPK3PX').compatibleGoogleAuthenticator, false, 'trop courte (moins de 16)');
  assert.equal(strictTotp('jbswy3dpehpk3pxpjbswy3dpehpk3pxp'), null, 'minuscules refusées en mode strict');
  const { db } = app; const old = S.newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('sync@cdp.fr','h','A','superadmin',1,?,?)", old, Date.now());
  assert.equal(syncAdminTotp(db, { ADMIN_LOGIN: 'sync@cdp.fr', ADMIN_TOTP_SECRET: good }, () => {}), null, 'inactif sans ADMIN_TOTP_SYNC=1');
  assert.equal(syncAdminTotp(db, { ADMIN_TOTP_SYNC: '1', ADMIN_LOGIN: 'sync@cdp.fr', ADMIN_TOTP_SECRET: 'ABC1' }, () => {}).refus, 'clé non conforme');
  assert.equal(db.one("SELECT totp_secret FROM users WHERE email='sync@cdp.fr'").totp_secret, old);
  assert.deepEqual(syncAdminTotp(db, { ADMIN_TOTP_SYNC: '1', ADMIN_LOGIN: 'sync@cdp.fr', ADMIN_TOTP_SECRET: good }, () => {}), { aligne: true });
  const u = db.one("SELECT * FROM users WHERE email='sync@cdp.fr'"); assert.equal(u.totp_secret, good); assert.equal(u.pass_hash, 'h'); assert.equal(u.role, 'superadmin');
  assert.deepEqual(syncAdminTotp(db, { ADMIN_TOTP_SYNC: '1', ADMIN_LOGIN: 'sync@cdp.fr', ADMIN_TOTP_SECRET: good }, () => {}), { inchange: true });
  assert.ok(S.totpOk(u.totp_secret, S.totpCode(good)), 'le code généré par l’application avec la clé de Render est accepté');
});
