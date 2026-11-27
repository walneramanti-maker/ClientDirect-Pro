import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.js';

const app = await setup({ ADMIN_EMAIL: 'admin@clientdirectpro.fr' });
const { db } = app;
test.after(() => app.close());
const A = await import('../src/adminClients.js');

const now = Date.now();
function mk({ name, country = 'GF', status = 'trial', plan = 'pro', source = 'direct', city = 'Cayenne', tpl = 'garage', email, owner = 'Jean Client', address = '', sub = null, end = null, created = now, example = 0 }) {
  const u = Number(db.run("INSERT INTO users(email,pass_hash,name,role,created_at) VALUES(?,?,?,'pro',?)", email, 'x', owner, created).lastInsertRowid);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + u;
  return Number(db.run('INSERT INTO tenants(slug,name,tpl,metier,city,address,phone,cc,email,country,status,plan,source,owner_user_id,trial_ends_at,current_period_end,stripe_sub,example,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    slug, name, tpl, tpl, city, address, '694 12 34 56', '594', email, country, status, plan, source, u, status === 'trial' ? now + 5 * 864e5 : null, end, sub, example, created).lastInsertRowid);
}
const ids = {
  gf: mk({ name: 'Garage Kourou', email: 'a@kourou.fr', address: '1 rue X 97310 Kourou', city: 'Kourou' }),
  fr: mk({ name: 'Salon Lyon', country: 'FR', status: 'active', tpl: 'coiffeur', city: 'Lyon', email: 'b@lyon.fr', address: '2 rue Y 69008 Lyon', sub: 'sub_x', end: now + 20 * 864e5 }),
  mq: mk({ name: 'Resto Fort', country: 'MQ', status: 'past_due', tpl: 'restaurant', city: 'Fort-de-France', email: 'c@mq.fr', sub: 'sub_y', end: now - 864e5 }),
  be: mk({ name: 'Garage Bruxelles', country: 'BE', status: 'canceled', email: 'd@be.be' }),
  ctl: mk({ name: 'Controle pro', source: 'utm:controle-lancement', email: 'e@ctl.fr' }),
  demo: mk({ name: 'Démo prospect', status: 'demo', email: 'f@demo.fr' })
};
db.run("INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,status,paid_at,created_at) VALUES(?,'in_1',54800,'paid',?,?)", ids.fr, now, now);
db.run("INSERT INTO tickets(tenant_id,email,subject,status,created_at,updated_at) VALUES(?,'b@lyon.fr','Question facture','open',?,?)", ids.fr, now, now);

async function adminClient() {
  const { hashPassword, newTotpSecret, totpCode } = app.sec; const secret = newTotpSecret();
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES('boss@cdp.fr',?,'Boss','superadmin',1,?,?)", hashPassword('AdminTresLong2026'), secret, Date.now());
  app.sec.resetRateLimits(); const c = app.client();
  await c.submit('/connexion', '/connexion', { email: 'boss@cdp.fr', password: 'AdminTresLong2026' }); await c.submit('/connexion/2fa', '/connexion/2fa', { code: totpCode(secret) });
  return c;
}
const admin = await adminClient();

test('liste des entreprises : clients réels séparés des démonstrations et comptes de contrôle, filtres, territoires', async () => {
  const r = await admin.get('/admin/clients'); assert.equal(r.status, 200);
  for (const n of ['Garage Kourou', 'Salon Lyon', 'Resto Fort', 'Garage Bruxelles']) assert.match(r.text, new RegExp(n));
  assert.doesNotMatch(r.text, /Controle pro|Démo prospect/, 'contrôle et démonstrations hors de la liste des clients');
  assert.match(r.text, /Jean Client/); assert.match(r.text, /b@lyon\.fr/); assert.match(r.text, /\+594 694 12 34 56/); assert.match(r.text, /5 j d’essai/);
  const terr = await admin.get('/admin/clients?terr=MQ'); assert.match(terr.text, /Resto Fort/); assert.doesNotMatch(terr.text, /Salon Lyon/);
  const other = await admin.get('/admin/clients?terr=XX'); assert.match(other.text, /Garage Bruxelles/); assert.doesNotMatch(other.text, /Garage Kourou/);
  const q = await admin.get('/admin/clients?q=lyon.fr'); assert.match(q.text, /Salon Lyon/); assert.doesNotMatch(q.text, /Garage Kourou/);
  const st = await admin.get('/admin/clients?status=past_due'); assert.match(st.text, /Resto Fort/); assert.doesNotMatch(st.text, /Salon Lyon/);
  const tpl = await admin.get('/admin/clients?tpl=coiffeur&plan=pro&city=Lyon'); assert.match(tpl.text, /Salon Lyon/); assert.doesNotMatch(tpl.text, /Resto Fort/);
  const demos = await admin.get('/admin/clients?kind=demo'); assert.match(demos.text, /Démo prospect/);
  const inj = await admin.get('/admin/clients?q=%25%27%22%3Cscript%3E'); assert.equal(inj.status, 200); assert.doesNotMatch(inj.text, /<script>/, 'recherche échappée');
  assert.equal((await app.client().get('/admin/clients')).status === 200, false, 'réservé à l’administrateur');
});

test('pagination : plusieurs milliers d’entreprises, 50 par page, sans limite de 500', async () => {
  db.tx(() => { for (let i = 0; i < 2600; i++) db.run("INSERT INTO tenants(slug,name,tpl,metier,city,country,status,plan,created_at) VALUES(?,?,'artisan','Artisan','Rennes','FR','trial','essentiel',?)", `masse-${i}`, `Artisan Masse ${String(i).padStart(4, '0')}`, now - 10e6 - i); });
  const f = A.clientFilters(new URLSearchParams('q=Artisan%20Masse&sort=nom&page=52'));
  const t0 = Date.now(); const r = A.listClients(db, f); const ms = Date.now() - t0;
  assert.equal(r.total, 2600); assert.equal(r.pages, 52); assert.equal(r.page, 52); assert.equal(r.rows.length, 2600 - 51 * 50); assert.equal(r.rows.at(-1).name, 'Artisan Masse 2599');
  assert.ok(ms < 1500, `liste rapide (${ms} ms)`);
  const p = await admin.get('/admin/clients?q=Artisan+Masse&page=3'); assert.match(p.text, /Page 3 sur 52/); assert.match(p.text, /Suivante/); assert.match(p.text, /Précédente/);
  const csv = await admin.get('/admin/clients.csv?q=Artisan+Masse'); assert.equal(csv.status, 200); assert.equal(csv.text.trim().split('\r\n').length, 2601, 'export complet, toutes pages');
  db.run("DELETE FROM tenants WHERE slug LIKE 'masse-%'");
});

test('fiche entreprise : site, coordonnées, territoire, abonnement, factures, assistance, historique', async () => {
  const r = await admin.get(`/admin/clients/${ids.fr}`); assert.equal(r.status, 200);
  assert.match(r.text, /Salon Lyon/); assert.match(r.text, /France métropolitaine/); assert.match(r.text, /69 Rhône/); assert.match(r.text, /Abonné payant/);
  assert.match(r.text, /548(,00)?[\s\u202f\u00a0]€/); assert.match(r.text, /in_1/); assert.match(r.text, /Question facture/); assert.match(r.text, /prochain prélèvement/); assert.match(r.text, /Voir le site/);
  const g = await admin.get(`/admin/clients/${ids.gf}`); assert.match(g.text, /973 Guyane/); assert.match(g.text, /fin de l’essai/); assert.match(g.text, /Prolonger l’essai/);
  assert.doesNotMatch(r.text, /Suspendre le site/, 'pas de suspension d’un abonné payant depuis l’administration');
  assert.equal((await admin.get('/admin/clients/999999')).status, 404);
});

test('actions sécurisées : confirmation obligatoire, journalisées, sans toucher à la facturation', async () => {
  const before = db.one('SELECT trial_ends_at FROM tenants WHERE id=?', ids.gf).trial_ends_at;
  const no = await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/prolonger`, { days: '14' }); assert.equal(no.status, 400); assert.match(no.text, /Je confirme/);
  assert.equal(db.one('SELECT trial_ends_at FROM tenants WHERE id=?', ids.gf).trial_ends_at, before, 'rien sans confirmation');
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/prolonger`, { days: '14', confirm: '1' });
  assert.ok(db.one('SELECT trial_ends_at FROM tenants WHERE id=?', ids.gf).trial_ends_at >= before + 14 * 864e5 - 1000);
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/suspendre`, { reason: 'test', confirm: '1' }); assert.equal(db.one('SELECT status FROM tenants WHERE id=?', ids.gf).status, 'paused');
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/reactiver`, { confirm: '1' }); assert.equal(db.one('SELECT status FROM tenants WHERE id=?', ids.gf).status, 'trial');
  const ref = await admin.submit(`/admin/clients/${ids.fr}`, `/admin/clients/${ids.fr}/suspendre`, { confirm: '1' }); assert.equal(ref.status, 400); assert.match(ref.text, /Stripe/);
  assert.equal(db.one('SELECT status FROM tenants WHERE id=?', ids.fr).status, 'active');
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/note`, { note: 'Rappeler lundi', confirm: '1' }); assert.equal(db.one('SELECT admin_note FROM tenants WHERE id=?', ids.gf).admin_note, 'Rappeler lundi');
  const pw = db.one('SELECT pass_hash FROM users WHERE id=(SELECT owner_user_id FROM tenants WHERE id=?)', ids.gf).pass_hash;
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/mdp`, { confirm: '1' });
  assert.ok(db.one("SELECT 1 FROM outbox WHERE template='reset_password' AND to_addr='a@kourou.fr'")); assert.equal(db.one('SELECT pass_hash FROM users WHERE id=(SELECT owner_user_id FROM tenants WHERE id=?)', ids.gf).pass_hash, pw, 'mot de passe inchangé');
  const h = await admin.get(`/admin/clients/${ids.gf}`); assert.match(h.text, /Essai prolongé/); assert.match(h.text, /Site suspendu/); assert.match(h.text, /Lien de mot de passe envoyé/);
  assert.equal(db.one("SELECT COUNT(*) n FROM audit WHERE tenant_id=? AND action LIKE 'admin.%'", ids.gf).n, 5);
  // Sans jeton CSRF : refusé
  const raw = await admin.post(`/admin/clients/${ids.gf}/interne`, { value: '1', confirm: '1' });
  assert.ok(raw.status >= 400, `refusé (${raw.status})`); assert.equal(db.one('SELECT internal FROM tenants WHERE id=?', ids.gf).internal, 0);
});

test('tableau de bord : par territoire, prospects / démonstrations / clients séparés, compte interne exclu', async () => {
  const T = A.territoryStats(db, now);
  const by = Object.fromEntries(T.list.map((b) => [b.code, b]));
  assert.equal(by.GF.essais, 1); assert.equal(by.FR.payants, 1); assert.equal(by.FR.mrr, 149); assert.equal(by.FR.encaisse, 548); assert.equal(by.MQ.impayes, 1); assert.equal(by.MQ.mrr, 149);
  assert.equal(T.totals.payants, 1); assert.equal(T.kinds.controle, 1); assert.equal(T.kinds.demo, 1);
  const d = await admin.get('/admin'); assert.equal(d.status, 200);
  assert.match(d.text, /Par territoire/); assert.match(d.text, /Guyane/); assert.match(d.text, /Martinique/); assert.match(d.text, /démonstrations préparées/); assert.match(d.text, /prospects repérés/); assert.match(d.text, /Entreprises récentes/); assert.match(d.text, /Actions rapides/); assert.match(d.text, /Incidents \/ alertes/);
  assert.doesNotMatch(d.text, /Controle pro/);
  await admin.submit(`/admin/clients/${ids.gf}`, `/admin/clients/${ids.gf}/interne`, { value: '1', confirm: '1' });
  const T2 = A.territoryStats(db, now); assert.equal(T2.list.find((b) => b.code === 'GF').essais, 0, 'compte interne exclu des statistiques'); assert.equal(T2.kinds.interne, 1);
  const list = await admin.get('/admin/clients?kind=interne'); assert.match(list.text, /Garage Kourou/);
});

test('nouvelle interface : menu latéral, recherche globale, filtres rapides, paiements, tickets, paramètres', async () => {
  const d = await admin.get('/admin'); assert.match(d.text, /class="side"/); assert.match(d.text, /Rechercher une entreprise/); assert.match(d.text, /aria-current="page"[^>]*>.*Tableau de bord/s);
  assert.match(d.text, /c-neg|c-pos/, 'résultat coloré selon le signe');
  const mq = await admin.get('/admin?terr=MQ'); assert.match(mq.text, /Resto Fort/); assert.doesNotMatch(mq.text.split('id="recentes"')[1].split('</section>')[0], /Salon Lyon/, 'filtre rapide par territoire');
  const p = await admin.get('/admin/paiements'); assert.equal(p.status, 200); assert.match(p.text, /in_1/); assert.match(p.text, /548\s€/); assert.match(p.text, /Resto Fort/, 'impayé signalé');
  const t = await admin.get('/admin/tickets'); assert.equal(t.status, 200); assert.match(t.text, /Question facture/); assert.match((await admin.get('/admin/tickets?statut=closed')).text, /Aucun ticket/);
  const s = await admin.get('/admin/parametres'); assert.equal(s.status, 200); assert.match(s.text, /Envoi des campagnes/); assert.match(s.text, /Lancement et réglages techniques/);
  const g = await admin.get('/admin/clients?kind=tous&q=Bruxelles'); assert.match(g.text, /Garage Bruxelles/, 'la recherche globale couvre tous les comptes');
  for (const u of ['/admin/paiements', '/admin/tickets', '/admin/parametres']) assert.notEqual((await app.client().get(u)).status, 200, `${u} réservé`);
});

test('accueil : filtres pays / territoire / ville, lignes cliquables, formules, temps réel, couleurs du résultat', async () => {
  const d = await admin.get('/admin'); const rec = () => (x) => x.split('id="recentes"')[1].split('</section>')[0];
  assert.match(d.text, /data-href="\/admin\/clients\/\d+"/, 'lignes cliquables'); assert.match(d.text, /\/static\/admin\.js/);
  assert.match(d.text, /Abonnements et essais par formule/); for (const p of ['Essentiel', 'Pro', 'Premium']) assert.match(d.text, new RegExp(`<b>${p}</b>`));
  assert.doesNotMatch(d.text, /Standard/, 'seulement les trois formules existantes');
  const be = await admin.get('/admin?pays=BE'); assert.match(rec()(be.text), /Garage Bruxelles/); assert.doesNotMatch(rec()(be.text), /Salon Lyon/);
  const city = await admin.get('/admin?ville=Fort'); assert.match(rec()(city.text), /Resto Fort/); assert.doesNotMatch(rec()(city.text), /Garage Bruxelles/);
  const both = await admin.get('/admin?terr=FR&ville=Lyon'); assert.match(rec()(both.text), /Salon Lyon/); assert.match(both.text, /country=|terr=FR/);
  const inj = await admin.get('/admin?ville=%25%27%3Cb%3E'); assert.equal(inj.status, 200); assert.doesNotMatch(inj.text, /value="%'<b>"/);
  const live = await admin.get('/admin/live.json'); assert.equal(live.status, 200); const j = JSON.parse(live.text);
  for (const k of ['active', 'trial', 'pastDue', 'mrr', 'revenue', 'expenses', 'result', 'byPlan', 'at']) assert.ok(k in j, k);
  assert.equal(j.byPlan.length, 3); assert.deepEqual(j.byPlan.map((p) => p.plan), ['essentiel', 'pro', 'premium']);
  assert.equal(j.result, Math.round((j.revenue - j.expenses) * 100) / 100);
  assert.match(d.text, j.result < 0 ? /kc c-neg" data-k="result"/ : /kc c-pos" data-k="result"/, 'résultat rouge si négatif, vert sinon');
  assert.notEqual((await app.client().get('/admin/live.json')).status, 200, 'réservé à l’administrateur');
});
