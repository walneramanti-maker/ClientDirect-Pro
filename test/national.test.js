import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, signup, jsonResponse } from './helpers.js';
import { deptOf, territoryOf, DEPT_CODES } from '../src/france.js';

const app = await setup({ ADMIN_EMAIL: 'admin@cdp.fr', PROSPECT_PAUSE_MS: '0' });
const { db } = app;
test.after(() => app.close());
const P = await import('../src/prospect.js');

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
const company = (siren, naf, postal, extra = {}) => ({ siren, nom_complet: `ENTREPRISE ${siren}`, activite_principale: naf, date_creation: '2024-03-01', tranche_effectif_salarie: 'NN', siege: { siret: siren + '00011', libelle_commune: 'VILLE', code_postal: postal, adresse: `1 RUE X ${postal} VILLE` }, ...extra });

test('départements : toute la France, Corse et Outre-mer, territoire déduit du code postal', () => {
  assert.equal(DEPT_CODES.length, 101);
  assert.equal(deptOf('75011'), '75'); assert.equal(deptOf('20000'), '2A'); assert.equal(deptOf('20200'), '2B');
  assert.equal(deptOf('97320'), '973'); assert.equal(deptOf('97600'), '976'); assert.equal(deptOf('abc'), '');
  assert.equal(territoryOf('69001'), 'FR'); assert.equal(territoryOf('97110'), 'GP'); assert.equal(territoryOf('97400'), 'RE');
});

test('prospection nationale : recherche par département, démo créée à la première visite, au bon fuseau', async () => {
  const seen = [];
  app.net.setFetch(async (url) => { seen.push(String(url)); return jsonResponse({ total_pages: 1, results: [company('300000001', '45.20A', '69003'), company('300000002', '45.20A', '69007', { opposition_diffusion_commerciale: true })] }); });
  const admin = await makeAdmin();
  const p = await admin.get('/admin/prospection');
  assert.match(p.text, /Prospection nationale automatique/); assert.match(p.text, /69 · Rhône/); assert.match(p.text, /973 · Guyane/);
  const r = await admin.post('/admin/prospection/recherche', { csrf: admin.csrf(p.text), tpl: 'garage', departement: '69' });
  assert.match(seen.at(-1), /departement=69/); assert.match(r.text, /1 entreprise\(s\) trouvée\(s\), 1 nouvelle/);
  const pr = db.one("SELECT * FROM prospects WHERE siren='300000001'");
  assert.equal(pr.dept, '69'); assert.equal(pr.demo_tenant_id, null, 'aucune démo fabriquée tant que personne ne la regarde');
  assert.equal(db.one("SELECT COUNT(*) n FROM prospects WHERE siren='300000002'").n, 0, 'opposition respectée');
  const demo = await app.client().get(`/demo/${P.demoTokenFor('300000001')}`);
  assert.equal(demo.status, 200); assert.match(demo.text, /Démonstration non officielle/);
  const t = db.one("SELECT * FROM tenants WHERE prospect_id=?", pr.id);
  assert.equal(t.country, 'FR'); assert.equal(t.tz, 'Europe/Paris'); assert.equal(t.currency, 'EUR');
  assert.equal((await app.client().get(`/demo/${P.demoTokenFor('300000001')}`)).status, 200);
  assert.equal(db.one('SELECT COUNT(*) n FROM tenants WHERE prospect_id=?', pr.id).n, 1, 'une seule démo par entreprise');
  assert.equal((await app.client().get(`/demo/${P.demoTokenFor('999999999')}`)).status, 404);
});

test('campagne nationale quotidienne : avance département par département, n’envoie rien', async () => {
  let n = 400000000;
  app.net.setFetch(async (url) => { const d = /departement=(\w+)/.exec(String(url))[1]; const postal = d.length === 3 ? d + '10' : (d === '2A' ? '20000' : d.padStart(2, '0') + '100'); return jsonResponse({ total_pages: 3, results: [company(String(n++), '96.02A', postal), company(String(n++), '96.02B', postal)] }); });
  const outboxBefore = db.one('SELECT COUNT(*) n FROM outbox').n;
  const r = await P.runNationalCampaign(db, { quota: 30, maxCalls: 20 });
  assert.ok(r.added >= 30 && r.calls <= 20, JSON.stringify(r));
  assert.equal(db.one('SELECT COUNT(*) n FROM outbox').n, outboxBefore, 'aucun message envoyé');
  const st = P.campaignStatus(db); assert.equal(st.cursor, r.cursor); assert.ok(st.depts >= 2);
  const r2 = await P.runNationalCampaign(db, { quota: 4, maxCalls: 5 });
  assert.equal(r2.cursorStart, r.cursor, 'reprend là où elle s’était arrêtée');
  const pr = db.one("SELECT * FROM prospects WHERE status='new' AND dept!='' LIMIT 1");
  assert.ok(pr.optout_token_hash, 'lien d’opposition prêt dès l’import');
  // limite de l'API : arrêt propre, réessai le lendemain
  app.net.setFetch(async () => new Response('', { status: 429 }));
  const r3 = await P.runNationalCampaign(db, { quota: 10, maxCalls: 5 }); assert.equal(r3.stopped, 'limite API'); assert.equal(r3.added, 0);
});

test('export CSV des messages à valider : démo, opposition, message à distance', async () => {
  const admin = await makeAdmin();
  const r = await admin.get('/admin/prospection/export.csv?statut=new');
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /NON ENVOYÉ/); assert.match(r.text, /\/demo\/[a-f0-9]{32}/); assert.match(r.text, /\/stop\/[a-f0-9]{32}/);
  assert.match(r.text, /par téléphone ou en visio/); assert.match(r.text, /registre public des entreprises/);
  assert.equal((await app.client().get('/admin/prospection/export.csv')).status === 200, false, 'réservé à l’administrateur');
  // le lien d'opposition du fichier fonctionne
  const stop = /\/stop\/([a-f0-9]{32})/.exec(r.text)[1];
  const o = await app.client().get(`/stop/${stop}`); assert.ok([200, 303].includes(o.status));
});

test('origine des inscriptions : lien « Site réalisé avec », page métier, démo activée', async () => {
  const { t: host } = await signup(app, { business: 'Garage Parrain', email: 'parrain@test.fr' });
  const site = await app.client().get(`/s/${host.slug}`);
  assert.match(site.text, new RegExp(`\\?ref=${host.slug}`));
  // un visiteur arrive par ce lien puis s'inscrit
  app.sec.resetRateLimits();
  const v = app.client(); await v.get(`/?ref=${host.slug}`);
  const r = await v.submit('/inscription', '/inscription', { business: 'Filleul Auto', tpl: 'garage', city: 'Lyon', tz: 'Europe/Paris', plan: 'pro', name: 'F', email: 'filleul@test.fr', password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(r.status, 303);
  assert.equal(db.one("SELECT source FROM tenants WHERE slug='filleul-auto'").source, `site:${host.slug}`);
  // page métier
  app.sec.resetRateLimits();
  const w = app.client(); const mp = await w.get('/metiers/coiffeur');
  assert.equal(mp.status, 200); assert.match(mp.text, /Salon de coiffure : votre site internet avec prise de rendez-vous en ligne/);
  await w.submit('/inscription', '/inscription', { business: 'Coupe Nette', tpl: 'coiffeur', city: 'Nantes', tz: 'Europe/Paris', plan: 'pro', name: 'C', email: 'coupe@test.fr', password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(db.one("SELECT source FROM tenants WHERE slug='coupe-nette'").source, 'metier:coiffeur');
  // démo de prospection activée
  const pr = db.one("SELECT * FROM prospects WHERE siren='300000001'"); const tok = P.demoTokenFor(pr.siren);
  app.sec.resetRateLimits();
  const x = app.client();
  const claim = await x.submit(`/inscription?claim=${tok}`, '/inscription', { claim: tok, plan: 'pro', name: 'Patron', email: 'patron69@test.fr', password: 'MotDePasse2026', cgu: 'on' });
  assert.equal(claim.status, 303);
  assert.equal(db.one('SELECT source FROM tenants WHERE prospect_id=?', pr.id).source, 'prospection');
});

test('pages métiers en français et en anglais, dans le plan du site', async () => {
  const idx = await app.client().get('/metiers'); assert.match(idx.text, /Institut de beauté/);
  const en = await app.client().get('/metiers/garage?lang=en'); assert.match(en.text, /Auto repair shop: your website with online booking/);
  assert.equal((await app.client().get('/metiers/inconnu')).status, 404);
  const sm = await app.client().get('/sitemap.xml'); assert.match(sm.text, /\/metiers\/beaute/);
});

test('avis des professionnels et page Bilan', async () => {
  const { c, t } = await signup(app, { business: 'Avis Plomberie', email: 'avis@test.fr', tpl: 'artisan' });
  let d = await c.get('/pro'); assert.doesNotMatch(d.text, /Votre avis compte/, 'pas d’avis demandé la première semaine');
  db.run('UPDATE tenants SET created_at=? WHERE id=?', Date.now() - 10 * 864e5, t.id);
  d = await c.get('/pro'); assert.match(d.text, /Votre avis compte/);
  const r = await c.post('/pro/avis', { csrf: c.csrf(d.text), score: '4', comment: 'Pratique, il manque le paiement en ligne.' });
  assert.equal(r.status, 303);
  assert.doesNotMatch((await c.get('/pro')).text, /Votre avis compte/, 'une fois par mois au plus');
  assert.equal((await c.post('/pro/avis', { csrf: c.csrf(d.text), score: '9' })).status, 400);
  const admin = await makeAdmin();
  const pr = await admin.get('/admin/pret'); assert.equal(pr.status, 200); assert.match(pr.text, /Préparation du lancement/); assert.match(pr.text, /Paiement test complet/);
  assert.notEqual((await app.client().get('/admin/pret')).status, 200, 'réservé à l’administrateur');
  const b = await admin.get('/admin/bilan');
  assert.equal(b.status, 200);
  assert.match(b.text, /inscriptions/); assert.match(b.text, /Recommandation \(site client\)/); assert.match(b.text, /Pages métiers \(Google\)/); assert.match(b.text, /Prospection \(démo activée\)/);
  assert.match(b.text, /France métropolitaine/); assert.match(b.text, /il manque le paiement en ligne/); assert.match(b.text, /moyenne 4\/5/);
  assert.equal((await app.client().get('/admin/bilan')).status === 200, false);
  // date de lancement : le bilan couvre les 30 jours suivants
  const r2 = await admin.post('/admin/lancement', { csrf: admin.csrf(b.text), date: '2026-12-01' }); assert.equal(r2.status, 303);
  const b2 = await admin.get('/admin/bilan'); assert.match(b2.text, /Bilan du 01\/12\/2026 au 30\/12\/2026/); assert.match(b2.text, /se lit le <b>31\/12\/2026/);
});

test('prospection : panne réseau = pages non perdues (curseur immobile), arrêt après 3 échecs, sonde toutes les 30 min, reprise au retour de l’API, remise à zéro ponctuelle', async () => {
  const { runJobs } = await import('../src/jobs.js');
  const cur = () => Number(db.one("SELECT v FROM meta WHERE k='prospect_cursor'")?.v || 0);
  const before = cur();
  app.net.setFetch(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
  const r = await P.runNationalCampaign(db, { quota: 50, maxCalls: 20 });
  assert.equal(cur(), before, 'aucune page marquée comme parcourue'); assert.equal(r.added, 0); assert.equal(r.calls, 3, 'arrêt après 3 échecs de suite');
  assert.match(r.stopped, /réseau : fetch failed \(ECONNRESET\)/, 'cause exacte');
  assert.ok(db.one("SELECT 1 FROM incidents WHERE kind='prospection_reseau'"));
  // Pause : pas de nouvelle tentative avant 6 h, puis reprise
  const now = Date.now(); let calls = 0;
  app.net.setFetch(async (url) => { if (String(url).includes('/search')) calls++; return jsonResponse({ results: [] }); });
  db.run("INSERT INTO meta(k,v) VALUES('prospect_order','v2') ON CONFLICT(k) DO UPDATE SET v='v2'");
  db.run("INSERT INTO meta(k,v) VALUES('prospect_daily','50') ON CONFLICT(k) DO UPDATE SET v='50'");
  await runJobs(db, now + 10 * 60e3); await new Promise((ok) => setTimeout(ok, 50)); assert.equal(calls, 0, 'en pause : aucune requête avant 30 min');
  // API toujours en panne : une seule petite sonde, pas de campagne
  app.net.setFetch(async (url) => { if (String(url).includes('/search')) calls++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
  await runJobs(db, now + 40 * 60e3); await new Promise((ok) => setTimeout(ok, 50)); assert.equal(calls, 1, 'une sonde, pas de campagne');
  await runJobs(db, now + 50 * 60e3); await new Promise((ok) => setTimeout(ok, 50)); assert.equal(calls, 1, 'sonde espacée de 30 min');
  // API rétablie : reprise immédiate à la sonde suivante, sans attendre 6 h ; incidents réseau clôturés
  calls = 0; app.net.setFetch(async (url) => { if (String(url).includes('/search')) calls++; return jsonResponse({ results: [] }); });
  await runJobs(db, now + 75 * 60e3); await new Promise((ok) => setTimeout(ok, 200)); assert.ok(calls > 1, 'reprise dès le retour de l’API');
  assert.equal(db.one("SELECT COUNT(*) n FROM incidents WHERE kind='prospection_reseau' AND resolved_at IS NULL").n, 0, 'incident réseau clôturé');
  // Remise à zéro du curseur, une seule fois par valeur
  process.env.PROSPECT_CURSOR_RESET = '2';
  try { await P.runNationalCampaign(db, { quota: 1, maxCalls: 1 }); assert.equal(cur(), 3); await P.runNationalCampaign(db, { quota: 1, maxCalls: 1 }); assert.equal(cur(), 4, 'pas réappliquée'); }
  finally { delete process.env.PROSPECT_CURSOR_RESET; }
});

test('prospection : API principale refusée → copie publique du registre (gratuite, sans clé) prend le relais', async () => {
  const seen = [];
  app.net.setFetch(async (url) => {
    const u = String(url); seen.push(u);
    if (u.includes('recherche-entreprises') || u.includes('/search')) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    return jsonResponse({ total_count: 2, results: [
      { siren: '912345678', siret: '91234567800011', denominationunitelegale: null, prenomusuelunitelegale: 'JEAN', nomunitelegale: 'NUMA', enseigne1etablissement: 'GARAGE DU FLEUVE', activiteprincipaleetablissement: '45.20A', codepostaletablissement: '97351', libellecommuneetablissement: 'MATOURY', adresseetablissement: '17 Rue SAPOTILLE', datecreationetablissement: '2025-04-07', trancheeffectifsetablissement: 'Etablissement non employeur' },
      { siren: '912345679', siret: '91234567900011', denominationunitelegale: 'AUTO PLUS', activiteprincipaleetablissement: '45.20A', codepostaletablissement: '97300', libellecommuneetablissement: 'CAYENNE', trancheeffectifsetablissement: '3 à 5 salariés' }] });
  });
  const r = await P.searchSirene({ tpl: 'garage', departement: '973', page: 1, withMeta: true });
  assert.equal(r.source, 'secours'); assert.equal(r.list.length, 2);
  assert.equal(r.list[0].name, 'JEAN NUMA (GARAGE DU FLEUVE)'); assert.equal(P.displayName(r.list[0].name), 'Garage du Fleuve'); assert.equal(r.list[0].dept, '973'); assert.equal(r.list[0].tpl, 'garage');
  const ods = seen.find((u) => u.includes('opendatasoft')); assert.ok(ods); const w = decodeURIComponent(ods);
  assert.match(w, /statutdiffusionetablissement="O"/, 'entreprises non diffusibles exclues'); assert.match(w, /etatadministratifetablissement="Actif"/); assert.match(w, /codedepartementetablissement="973"/);
  const n0 = db.one('SELECT COUNT(*) n FROM prospects').n; P.importProspects(db, r.list); assert.equal(db.one('SELECT COUNT(*) n FROM prospects').n, n0 + 2);
});
