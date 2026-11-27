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

test('nettoyage Stripe : seules les données inexistantes sur le compte réel sont retirées ; dépenses fixes ; incidents passagers clos', async () => {
  const B = await import('../src/bootops.js'); const { db } = app; const now = Date.now();
  db.run("INSERT INTO tenants(slug,name,tpl,metier,status,plan,stripe_customer,stripe_sub,created_at) VALUES('faux','Faux','garage','G','active','pro','cus_TEST','sub_TEST',?)", now);
  db.run("INSERT INTO tenants(slug,name,tpl,metier,status,plan,stripe_customer,stripe_sub,created_at) VALUES('vrai','Vrai','garage','G','active','pro','cus_LIVE','sub_LIVE',?)", now);
  const faux = db.one("SELECT id FROM tenants WHERE slug='faux'").id; const vrai = db.one("SELECT id FROM tenants WHERE slug='vrai'").id;
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,status,paid_at,created_at) VALUES(?,'in_TEST',54800,'paid',?,?)", faux, now, now);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,status,paid_at,created_at) VALUES(?,'in_LIVE',14900,'paid',?,?)", vrai, now, now);
  db.run("INSERT INTO incidents(fingerprint,kind,severity,message,first_at,last_at) VALUES('f1','billing','warning','Événement invoice.paid sans entreprise associée',?,?)", Date.parse('2026-11-25T23:41:00Z'), Date.parse('2026-11-25T23:41:00Z'));
  const stripeGet = async (p) => { if (/TEST/.test(p)) throw new Error('Stripe 404: No such object'); return {}; };
  assert.equal(await B.cleanStripeTestData(db, {}, { stripeGet, liveKey: true }, () => {}), null, 'inactif sans CLEAN_STRIPE_TEST_DATA=1');
  assert.equal((await B.cleanStripeTestData(db, { CLEAN_STRIPE_TEST_DATA: '1' }, { stripeGet, liveKey: false }, () => {})).refus, 'clé live absente');
  const r = await B.cleanStripeTestData(db, { CLEAN_STRIPE_TEST_DATA: '1' }, { stripeGet, liveKey: true, now }, () => {});
  assert.equal(r.facturesRetirees.length, 1); assert.equal(r.comptesRepasseEnEssai.length, 1); assert.equal(r.incidentsClos, 1);
  assert.equal(db.one("SELECT COUNT(*) n FROM invoices WHERE stripe_invoice='in_LIVE'").n, 1, 'vraie facture conservée');
  assert.equal(db.one("SELECT status, stripe_sub FROM tenants WHERE slug='vrai'").status, 'active', 'vrai client intact');
  const f = db.one("SELECT * FROM tenants WHERE slug='faux'"); assert.equal(f.status, 'trial'); assert.equal(f.stripe_sub, null); assert.ok(f.trial_ends_at > now + 13 * 864e5);
  await assert.rejects(B.cleanStripeTestData(db, { CLEAN_STRIPE_TEST_DATA: '1' }, { stripeGet: async () => { throw new Error('Stripe 500: panne'); }, liveKey: true }, () => {}), /panne/, 'en cas de doute (erreur Stripe), rien n’est retiré');
  assert.equal(db.one("SELECT COUNT(*) n FROM invoices WHERE stripe_invoice='in_LIVE'").n, 1);
  // Dépenses fixes réelles, idempotentes
  const env = { FIXED_COSTS: JSON.stringify([{ label: 'Hébergement Render', eur: 6.7 }]) };
  B.syncFixedCosts(db, env, () => {}); B.syncFixedCosts(db, env, () => {});
  assert.equal(db.one("SELECT COUNT(*) n, SUM(amount_cents) c FROM expenses WHERE label='Hébergement Render' AND recurring=1").c, 670);
  B.syncFixedCosts(db, { FIXED_COSTS: JSON.stringify([{ label: 'Hébergement Render', eur: 7 }]) }, () => {});
  assert.equal(db.one("SELECT amount_cents c FROM expenses WHERE label='Hébergement Render'").c, 700);
  // Incidents passagers : clos après 24 h sans répétition ; les critiques restent ouverts
  db.run("INSERT INTO incidents(fingerprint,kind,severity,message,first_at,last_at) VALUES('f2','enrichissement','info','fetch failed',?,?)", now - 3 * 864e5, now - 2 * 864e5);
  db.run("INSERT INTO incidents(fingerprint,kind,severity,message,first_at,last_at) VALUES('f3','prospection','info','fetch failed',?,?)", now - 3600e3, now - 3600e3);
  db.run("INSERT INTO incidents(fingerprint,kind,severity,message,first_at,last_at) VALUES('f4','backup','critical','sauvegarde',?,?)", now - 3 * 864e5, now - 2 * 864e5);
  db.run("INSERT INTO incidents(fingerprint,kind,severity,message,first_at,last_at) VALUES('f5','prospection','info','Campagne nationale (garage, 95) : fetch failed',?,?)", now - 3600e3, now - 3600e3);
  assert.equal(B.autoResolveIncidents(db, now), 2, 'ancien passager + doublon réseau de l’ancien format');
  assert.equal(db.one("SELECT resolved_at FROM incidents WHERE fingerprint='f3'").resolved_at, null, 'incident récent d’un autre type : reste ouvert');
  assert.equal(db.one("SELECT resolved_at FROM incidents WHERE fingerprint='f4'").resolved_at, null);
});

test('MARK_INTERNAL : classement réversible, idempotent, journalisé, sans suppression', async () => {
  const B = await import('../src/bootops.js'); const { db } = app;
  db.run("INSERT INTO tenants(slug,name,tpl,metier,status,created_at) VALUES('popx','Popx','garage','G','trial',?)", Date.now());
  assert.deepEqual(B.markInternal(db, { MARK_INTERNAL: 'popx, absent' }, () => {}), ['popx classé interne', 'absent introuvable']);
  assert.deepEqual(B.markInternal(db, { MARK_INTERNAL: 'popx' }, () => {}), []);
  const t = db.one("SELECT internal, status FROM tenants WHERE slug='popx'"); assert.equal(t.internal, 1); assert.equal(t.status, 'trial');
});
