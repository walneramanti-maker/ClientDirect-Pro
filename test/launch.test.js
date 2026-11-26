// Préparation du lancement : suivi commercial, CGV, crédits répartis, maintien en éveil, e-mail de test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';

const app = await setup({ FIRECRAWL_API_KEY: 'fc-test', ADMIN_EMAIL: 'admin@exemple.fr', BREVO_API_KEY: 'xkeysib-test', MAIL_FROM: 'ClientDirect Pro <alertes@exemple.fr>' });
const { db } = app;
test.after(() => app.close());
const P = await import('../src/prospect.js');
const S = await import('../src/sales.js');
const E = await import('../src/enrich.js');

async function makeAdmin() {
  const { hashPassword, newTotpSecret, totpCode } = app.sec;
  const secret = newTotpSecret();
  if (!db.one("SELECT 1 FROM users WHERE email='boss@cdp.fr'")) db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", hashPassword('AdminTresLong2026'), secret, Date.now());
  else db.run("UPDATE users SET totp_secret=? WHERE email='boss@cdp.fr'", secret);
  app.sec.resetRateLimits();
  const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' });
  await c.submit('/connexion/2fa', '/connexion/2fa', { code: totpCode(secret) });
  return c;
}
const add = (siren, potential, tpl = 'garage') => { P.importProspects(db, [{ siren, siret: siren + '00011', name: 'ENTREPRISE ' + siren, naf: '45.20A', tpl, city: 'CAYENNE', postal: '97300', address: '1 RUE X 97300 CAYENNE', created_on: '2024-01-01', dept: '973' }]); db.run("UPDATE prospects SET potential=?, phone='+594594000000' WHERE siren=?", potential, siren); return db.one('SELECT id FROM prospects WHERE siren=?', siren).id; };

test('contacts notés : statut mis à jour, tableau de bord par potentiel, métier et canal', () => {
  const a = add('700000001', 90); const b = add('700000002', 60, 'coiffeur'); const c = add('700000003', 30);
  assert.equal(S.logContact(db, a, { outcome: 'injoignable' }), 'contacted');
  assert.equal(S.logContact(db, a, { outcome: 'demo_envoyee' }), 'demo');
  assert.equal(S.logContact(db, b, { outcome: 'refus', channel: 'sms' }), 'lost');
  S.logContact(db, c, { outcome: 'interesse', channel: 'visite' });
  assert.throws(() => S.logContact(db, a, { outcome: 'inconnu' }));
  // le prospect A devient client
  db.run("INSERT INTO tenants(slug,name,tpl,metier,plan,status,country,prospect_id,created_at) VALUES('client-a','Client A','garage','Garage','pro','active','GF',?,?)", a, Date.now());
  const today = new Date().toISOString().slice(0, 10);
  const r = S.salesData(db, today, today);
  assert.equal(r.totals.contacts, 4); assert.equal(r.totals.prospects, 3); assert.equal(r.totals.positive, 2);
  assert.equal(r.totals.signups, 1); assert.equal(r.totals.paying, 1);
  const A = r.byClass.find((g) => g.label.startsWith('A'));
  assert.equal(A.contacts, 2); assert.equal(A.prospects, 1); assert.equal(A.positive, 1); assert.equal(A.paying, 1);
  assert.equal(r.byChannel.find((g) => g.label === 'SMS').contacts, 1);
  assert.equal(r.outcomes.refus, 1);
  assert.equal(r.daily.length, 1); assert.equal(r.daily[0].contacts, 4);
  assert.ok(r.goal.clientsProNeeded > 0 && r.goal.mrr >= 149);
});

test('administration : noter un appel depuis la liste, bilan et export CSV', async () => {
  const admin = await makeAdmin();
  const id = add('700000010', 85);
  const page = await admin.get('/admin/prospection'); assert.match(page.text, /Noter/);
  const r = await admin.submit('/admin/prospection', `/admin/prospection/${id}/contact`, { outcome: 'interesse', channel: 'appel' });
  assert.equal(r.status, 303);
  assert.equal(db.one('SELECT status FROM prospects WHERE id=?', id).status, 'contacted');
  const b = await admin.get('/admin/bilan'); assert.match(b.text, /Suivi commercial/); assert.match(b.text, /Objectif 2027/);
  const csv = await admin.get('/admin/bilan/contacts.csv'); assert.equal(csv.status, 200); assert.match(csv.text, /Intéressé/);
});

test('CGV et mentions légales publiées, consentement à l’inscription', async () => {
  const c = app.client();
  const cgv = await c.get('/cgv'); assert.equal(cgv.status, 200);
  for (const s of [/12 mois/, /40 €/, /L\. 441-10/, /entrepreneur individuel \(EI\)/, /199 € HT/, /599 € HT/]) assert.match(cgv.text, s);
  const ml = await c.get('/mentions-legales'); assert.match(ml.text, /EI\)/); assert.match(ml.text, /Hébergeur/);
  const sign = await c.get('/inscription'); assert.match(sign.text, /href="\/cgv"/);
  assert.match((await c.get('/')).text, /href="\/cgv"/);
});

test('crédits Firecrawl répartis sur les jours restants du mois', () => {
  db.run("INSERT INTO meta(k,v) VALUES('enrich_monthly_credits','300') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
  const now = Date.parse('2026-11-25T12:00:00Z'); // 6 jours restants, aujourd'hui compris
  db.run("DELETE FROM meta WHERE k LIKE 'enrich_credits_%'");
  assert.equal(E.effectiveCap(db, now), 50);
  db.run("INSERT INTO meta(k,v) VALUES('enrich_credits_2026-11','120')"); // déjà dépensé les jours précédents
  assert.equal(E.effectiveCap(db, now), 120 + 30);
  assert.equal(E.effectiveCap(db, Date.parse('2026-11-30T12:00:00Z')), 300, 'dernier jour : tout le reste');
});

test('e-mail de test (Brevo) depuis la page Lancement', async () => {
  const sent = [];
  app.net.setFetch(async (url, opt) => { sent.push({ url: String(url), body: JSON.parse(opt.body) }); return jsonResponse({ messageId: 'x' }); });
  const admin = await makeAdmin();
  const r = await admin.submit('/admin/pret', '/admin/test-email', {});
  assert.equal(r.status, 303); assert.match(decodeURIComponent(r.location), /envoyé à admin@exemple\.fr \(Brevo\)/);
  assert.equal(sent[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(sent[0].body.to[0].email, 'admin@exemple.fr'); assert.equal(sent[0].body.sender.email, 'alertes@exemple.fr');
  const h = await (await app.realFetch(app.base + '/health')).json();
  assert.equal(h.ready.alertesEmail, true); assert.equal(h.ready.veille.maintienEveil, false, 'pas en test');
});

test('compte de test supprimé entièrement : même adresse réutilisable, rien ne reste', async () => {
  const { purgeTestTenant } = await import('../src/privacy.js');
  const c = app.client();
  const page = await c.get('/inscription');
  const form = { business: 'Garage Purge', tpl: 'garage', city: 'Cayenne', country: 'GF', phone: '+594594000001', name: 'Test', email: 'reutilisable+test@exemple.fr', password: 'MotDePasseTest-2026!', cgu: 'on', plan: 'pro', lang: 'fr' };
  await c.submit('/inscription', '/inscription', form);
  const t = db.one("SELECT t.id FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email='reutilisable+test@exemple.fr'");
  assert.ok(t && page.status === 200);
  db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,created_at,paid_at) VALUES(?,?,?,?,?,?,?)", t.id, 'in_purge', 54800, 'eur', 'paid', Date.now(), Date.now());
  const r = await purgeTestTenant(db, t.id);
  assert.equal(r.users, 1);
  assert.equal(db.one('SELECT COUNT(*) n FROM tenants WHERE id=?', t.id).n, 0);
  assert.equal(db.one("SELECT COUNT(*) n FROM users WHERE email='reutilisable+test@exemple.fr'").n, 0);
  assert.equal(db.one("SELECT COUNT(*) n FROM invoices WHERE stripe_invoice='in_purge'").n, 0);
  // La même adresse peut resservir immédiatement
  app.sec.resetRateLimits();
  await app.client().submit('/inscription', '/inscription', form);
  assert.ok(db.one("SELECT 1 x FROM users WHERE email='reutilisable+test@exemple.fr'"));
  // Interdit en production
  const { config } = await import('../src/config.js');
  const prod = config.isProd; config.isProd = true;
  try { await assert.rejects(purgeTestTenant(db, 1), /test/); } finally { config.isProd = prod; }
});
test('migration : le plan de production ne régénère ni BACKUP_KEY ni APP_SECRET (sinon les sauvegardes existantes seraient illisibles)', async () => {
  const yaml = (await import('node:fs')).readFileSync('render.yaml', 'utf8');
  for (const k of ['BACKUP_KEY', 'APP_SECRET']) assert.doesNotMatch(yaml, new RegExp(`key: ${k}\\n\\s+generateValue: true`), k);
});

test('lancement : espace disque surveillé, sites exclus du sitemap, comptes de contrôle hors statistiques, vérification Google', async () => {
  const { diskUsage } = await import('../src/disk.js'); const d = diskUsage();
  assert.ok(d && d.totalMo > 0 && d.libreMo >= 0 && d.utilisePct >= 0 && d.utilisePct <= 100 && typeof d.alerte === 'boolean', JSON.stringify(d));
  const h = await (await fetch(`${app.base}/health`)).json(); assert.equal(typeof h.ready.disque.utilisePct, 'number');
  const { config } = await import('../src/config.js'); const { publicTenants } = await import('../src/seo.js');
  const { t } = await signup(app, { business: 'Garage Vitrine Demo', email: 'vitrine-demo@test.fr' });
  assert.ok(publicTenants(app.db).some((x) => x.slug === t.slug));
  const before = config.sitemapExclude; config.sitemapExclude = [t.slug];
  try { assert.ok(!publicTenants(app.db).some((x) => x.slug === t.slug), 'exclu du sitemap et de l’annuaire'); } finally { config.sitemapExclude = before; }
  app.db.run("UPDATE tenants SET source='utm:controle-lancement' WHERE id=?", t.id);
  assert.ok(!publicTenants(app.db).some((x) => x.slug === t.slug), 'compte de contrôle jamais public');
  const g = config.googleVerification; config.googleVerification = 'abc123';
  try { assert.match((await app.client().get('/')).text, /<meta name="google-site-verification" content="abc123">/); } finally { config.googleVerification = g; }
});
