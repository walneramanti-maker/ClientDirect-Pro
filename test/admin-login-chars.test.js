import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const app = await setup({});
test.after(() => app.close());

test('connexion administrateur : mot de passe avec caractères spéciaux et accents accepté tel quel, puis code 2FA', async () => {
  const { db } = app; const S = app.sec; const secret = S.newTotpSecret();
  const pw = 'Ét3 +&=%#"\'<>;:!?€ ñ/\\Mot2026';
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('patron@cdp.fr',?,'A','superadmin',1,?,?)", S.hashPassword(pw), secret, Date.now());
  const c = app.client();
  const r = await c.submit('/connexion', '/connexion', { email: '  Patron@CDP.fr ', password: pw });
  assert.match(r.url || r.location || '', /2fa/, JSON.stringify({ status: r.status }).slice(0, 80));
  const ok = await c.submit('/connexion/2fa', '/connexion/2fa', { code: S.totpCode(secret) });
  assert.match(ok.url || ok.location || '', /admin/);
});
