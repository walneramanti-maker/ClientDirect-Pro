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
