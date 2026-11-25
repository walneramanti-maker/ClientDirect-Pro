// Routeur HTTP de ClientDirect Pro. Aucune dépendance externe.
import { potentialOf } from './potential.js';
import { backupHealth } from './backup.js';
import { readiness } from './readiness.js';
import { applyOptout } from './suppression.js';
import { keepAwake } from './jobs.js';
import { logContact, salesData, OUTCOMES, CHANNELS as CONTACT_CHANNELS } from './sales.js';
import { config, PLANS, planHas } from './config.js';
import { parseCookies, cookie, readBody, parseForm, html, json, redirect, serveStatic, send } from './http.js';
import * as V from './views.js';
import { TEMPLATES } from './templates.js';
import { emailOk, randomId, safeEq, clampStr, nowIn, intlPhone } from './util.js';
import { hashPassword, passwordProblem, createSession, readSession, destroySession, destroyUserSessions, csrfOk, issueToken, useToken, totpOk, rateLimit, login, audit } from './security.js';
import { createTenant, loadTenant, siteState, updateSettings, userTenants } from './tenants.js';
import { freeSlots, openDays, book, createQuote, setAppointmentStatus, cancelByCustomer } from './booking.js';
import { notifyAppointment, enqueue, emit } from './notify.js';
import { answer, aiAvailable, ruleAnswer, aiCostEur } from './ai.js';
import { billingConfigured, createCheckout, createPortal, verifyStripeSignature, handleStripeEvent, useDb } from './billing.js';
import { safeSearch, importProspects, prepareDemo, outreachMessage, demoTenantByToken, recordDemoView, prospectStats, PIPELINE, runNationalCampaign, campaignStatus, demoTokenFor, displayName } from './prospect.js';
import { DEPARTEMENTS } from './france.js';
import { enrichBatch, enrichStatus } from './enrich.js';
import { heartbeat as jobsHeartbeat } from './jobs.js';
import { createCampaign, campaignDetail, approveCampaign, cancelCampaign } from './campaigns.js';
import { applyPartner, approvePartner, partnerByToken, partnerStats, referralStats, PROGRAM } from './rewards.js';
import { supportAnswer, openTicket, replyTicket } from './support.js';
import { recordIncident, openIncidents, resolveIncident } from './incidents.js';
import { t as tr, withLang, detectLang, regionFromAccept, LANGS, setLang, currentLang } from './i18n.js';
import { COUNTRIES, country as countryOf, billingOpen, validTz, PRICES, countryByTz } from './markets.js';
import { exampleTenant, exampleDashboardData, EXAMPLE_TPLS } from './examples.js';
import { siteHead, siteUrl, sitemap, robots, publicTenants } from './seo.js';
import { setDomain, tenantByDomain } from './domains.js';
import { track, isBot, last30, daily } from './stats.js';
import { tenantCosts } from './costs.js';
import { optoutLink, optout, exportTenant, deleteTenant } from './privacy.js';
import { verifyPassword } from './security.js';

const SESSION = 'cdp_s', PRE = 'cdp_pre';
const month = () => new Date().toISOString().slice(0, 7);
const HttpError = (status, msg) => Object.assign(new Error(msg), { status });

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (config.env === 'production' && xf ? String(xf).split(',')[0] : req.socket.remoteAddress || '').trim();
}
/** Les appels JSON publics doivent venir du site lui-même (protection contre les formulaires d'autres sites). */
function sameOrigin(req) {
  const o = req.headers.origin; if (!o) return true;
  try { const u = new URL(o); return u.host === req.headers.host || o === new URL(config.baseUrl).origin; } catch { return false; }
}

const method0 = (req) => (req.method === 'HEAD' ? 'GET' : req.method);
/** Canal d'acquisition d'une visite : lien de recommandation, campagne, page métier, sinon rien. */
export function sourceFrom(url, path) {
  const clean = (v) => String(v || '').toLowerCase().replace(/[^\w.-]/g, '').slice(0, 40);
  const ref = clean(url.searchParams.get('ref')); if (ref) return ref.startsWith('p-') ? `partner:${ref.slice(2)}` : `site:${ref}`;
  const utm = clean(url.searchParams.get('utm_source')); if (utm) return `utm:${utm}`;
  if (path.startsWith('/metiers/')) return `metier:${clean(path.split('/')[2])}`;
  if (path === '/' || path === '/exemples' || path.startsWith('/exemple/')) return 'direct';
  return '';
}
function countVisit(db, source) {
  const day = new Date().toISOString().slice(0, 10);
  try { db.run('INSERT INTO visits_source(day,source,n) VALUES(?,?,1) ON CONFLICT(day,source) DO UPDATE SET n=n+1', day, source.startsWith('site:') ? 'site' : source); } catch { /* jamais bloquant */ }
}

export function createApp(db) {
  useDb(db);
  const routes = [];
  const on = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler });

  // ---------- contexte et garde-fous ----------
  function csrfToken(c) { return c.session ? c.session.csrf : c.pre; }
  function checkCsrf(c) {
    const sent = c.form.csrf;
    const ok = c.session ? csrfOk(c.session, sent) : !!sent && !!c.cookies[PRE] && safeEq(c.cookies[PRE], sent);
    if (!ok) throw HttpError(403, 'Formulaire expiré. Rechargez la page et recommencez.');
  }
  function limit(c, key, max, windowMs) { if (!rateLimit(`${key}:${c.ip}`, max, windowMs)) throw HttpError(429, 'Trop de tentatives. Patientez quelques minutes.'); }
  function requirePro(c) {
    if (!c.session) throw Object.assign(new Error('auth'), { redirect: '/connexion' });
    if (c.session.role === 'superadmin') throw Object.assign(new Error('admin'), { redirect: '/admin' });
    const list = userTenants(db, c.session.user_id); if (!list.length) throw HttpError(403, 'Aucune entreprise associée à ce compte.');
    c.tenant = loadTenant(db, 'id', list[0].id);
    c.user = { id: c.session.user_id, email: c.session.email, name: c.session.name, email_verified: c.session.email_verified, lang: c.session.lang };
    if (!c.url.searchParams.get('lang')) c.setLang(c.session.lang || c.tenant.lang || 'fr');
    else if (LANGS[c.url.searchParams.get('lang')]) db.run('UPDATE users SET lang=? WHERE id=?', c.url.searchParams.get('lang'), c.session.user_id);
  }
  function requireAdmin(c) {
    if (!c.session || c.session.role !== 'superadmin') throw Object.assign(new Error('auth'), { redirect: '/connexion' });
    if (!c.session.totp_ok) throw Object.assign(new Error('2fa'), { redirect: '/connexion/2fa' });
  }
  const proEmail = (t) => db.one('SELECT email FROM users WHERE id=?', t.owner_user_id)?.email || t.email;
  const notifyPro = (t, kind, summary) => enqueue(db, { tenantId: t.id, channel: 'email', to: proEmail(t), template: 'pro_new_request', payload: { lang: t.lang, kind, tenant: t.name, summary, dashUrl: `${config.baseUrl}/pro` } });

  // ---------- site public ClientDirect Pro ----------
  /** Pays probable du visiteur : choix explicite, région du navigateur, sinon France. */
  const guessCountry = (c) => { const q = c.url.searchParams.get('pays'); if (COUNTRIES[q]) return q; const r = regionFromAccept(c.req.headers['accept-language']); return COUNTRIES[r] ? r : (c.lang === 'en' ? 'US' : 'FR'); };
  on('GET', '/', (c) => { const ctry = guessCountry(c); const cur = PRICES[c.url.searchParams.get('devise')] ? c.url.searchParams.get('devise') : countryOf(ctry).cur; html(c.res, V.marketing({ csrf: csrfToken(c), cur: PRICES[cur] ? cur : 'EUR', country: ctry })); });
  // ---------- programme partenaires ----------
  on('GET', '/partenaires', (c) => html(c.res, V.partnersPage({ csrf: csrfToken(c) })));
  on('POST', '/partenaires', (c) => {
    checkCsrf(c); limit(c, 'partner', 5, 3600e3);
    const f = { name: clampStr(c.form.name, 80), company: clampStr(c.form.company, 120), email: clampStr(c.form.email, 190).toLowerCase(), phone: clampStr(c.form.phone, 30), siret: String(c.form.siret || '').replace(/\D/g, '').slice(0, 14), activity: clampStr(c.form.activity, 80), certify: c.form.certify };
    const errors = [];
    if (!f.name) errors.push(tr('Indiquez votre nom.')); if (!f.company) errors.push(tr('Indiquez le nom de l’entreprise.')); if (!emailOk(f.email)) errors.push(tr('Adresse e-mail invalide.')); if (c.form.cgu !== 'on') errors.push(tr('Vous devez accepter les conditions du programme.'));
    if (errors.length) return html(c.res, V.partnersPage({ csrf: csrfToken(c), errors, f }), 400);
    const id = applyPartner(db, f);
    if (config.adminEmail) enqueue(db, { channel: 'email', to: config.adminEmail, template: 'pro_new_request', payload: { kind: 'candidature partenaire', tenant: f.company, summary: `${f.name} · ${f.activity} · ${f.email} ${f.phone}`, dashUrl: `${config.baseUrl}/admin/partenaires` } });
    emit(db, 'partenaire', { entreprise: f.company, nom: f.name, activite: f.activity, id });
    html(c.res, V.partnersPage({ csrf: csrfToken(c), sent: true }));
  });
  on('GET', '/partenaires/conditions', (c) => html(c.res, V.partnerTerms()));
  on('GET', '/partenaire/:token', (c) => {
    const p = partnerByToken(db, c.params.token); if (!p) throw HttpError(404, 'Page introuvable');
    html(c.res, V.partnerDashboard(p, partnerStats(db, p), `${config.baseUrl}/?ref=p-${p.code}`));
  });
  // ---------- pages par métier (référencement naturel) ----------
  on('GET', '/metiers', (c) => html(c.res, V.metiersIndex()));
  on('GET', '/metiers/:tpl', (c) => {
    if (!TEMPLATES[c.params.tpl]) throw HttpError(404, 'Page introuvable');
    const cur = countryOf(guessCountry(c)).cur; html(c.res, V.metierPage(c.params.tpl, { cur: PRICES[cur] ? cur : 'EUR' }));
  });
  // ---------- exemples à tester sans inscription ----------
  on('GET', '/exemples', (c) => html(c.res, V.examplesPage()));
  on('GET', '/exemple/espace-pro', (c) => { const d = exampleDashboardData(db, c.lang); html(c.res, V.proDashboard(d.tenant, d.user, '', { ...d, example: true })); });
  on('GET', '/exemple/:tpl', (c) => {
    if (!EXAMPLE_TPLS.includes(c.params.tpl)) throw HttpError(404, 'Page introuvable');
    const tn = exampleTenant(db, c.params.tpl, c.lang); renderSite(c, tn, `/exemple/${c.params.tpl}`, 'example');
  });
  on('GET', '/robots.txt', (c) => send(c.res, 200, robots(`${config.baseUrl}/sitemap.xml`, { allow: config.isProd }), { 'Content-Type': 'text/plain; charset=utf-8' }));
  on('GET', '/sitemap.xml', (c) => {
    // Seules les adresses du même domaine sont acceptées par Google dans un sitemap ; les domaines propres ont le leur.
    const own = publicTenants(db).filter((t) => !(t.custom_domain && t.domain_status === 'verified'));
    const entries = [{ loc: `${config.baseUrl}/`, lastmod: Date.now() }, { loc: `${config.baseUrl}/annuaire`, lastmod: Date.now() }, { loc: `${config.baseUrl}/metiers`, lastmod: Date.now() }, ...Object.keys(TEMPLATES).map((k) => ({ loc: `${config.baseUrl}/metiers/${k}`, lastmod: Date.now() }))];
    if (!config.rootDomain) for (const t of own) entries.push({ loc: `${config.baseUrl}/s/${t.slug}`, lastmod: t.updated_at || t.created_at });
    send(c.res, 200, sitemap(entries), { 'Content-Type': 'application/xml; charset=utf-8' });
  });
  on('GET', '/annuaire', (c) => html(c.res, V.directoryPage(publicTenants(db), (t) => siteUrl({ ...t, services: [] }))));
  for (const k of ['cgu', 'cgv', 'confidentialite', 'mentions-legales']) on('GET', `/${k}`, (c) => html(c.res, V.legalPage(k)));
  on('GET', '/stop/:token', (c) => html(c.res, V.confirmPage('Ne plus être contacté', 'Confirmez-vous ne plus vouloir recevoir de message de ClientDirect Pro ? La démonstration préparée pour votre entreprise sera supprimée.', 'Oui, ne plus me contacter', csrfToken(c))));
  on('POST', '/stop/:token', (c) => {
    // Désinscription « en un clic » depuis la messagerie (RFC 8058) : pas de jeton de formulaire possible
    if (!/List-Unsubscribe=One-Click/.test(c.raw)) checkCsrf(c);
    limit(c, 'stop', 20, 3600e3);
    const p = optout(db, c.params.token);
    if (p) audit(db, { action: 'prospect.opposition', detail: String(p.id), ip: c.ip });
    html(c.res, V.messagePage('C’est noté', 'Vous ne serez plus contacté par ClientDirect Pro et la démonstration a été supprimée. Merci et bonne continuation.'));
  });
  // Santé : utilisé par Render et par un service de surveillance externe (UptimeRobot, gratuit). 503 si les tâches automatiques sont bloquées.
  on('GET', '/health', (c) => {
    db.one('SELECT 1 x');
    const hb = jobsHeartbeat.at;
    const jobsOk = config.disableJobs || !hb || Date.now() - hb < 15 * 60e3;
    // État de la configuration (sans aucun secret) : permet de vérifier la mise en production
    const lastBackup = db.one("SELECT created_at FROM backups WHERE status='ok' ORDER BY id DESC LIMIT 1")?.created_at || null;
    const ready = { backups: !!(config.supabaseUrl && config.supabaseServiceKey), lastBackup: lastBackup ? new Date(lastBackup).toISOString() : null, restoredFrom: db.one("SELECT v FROM meta WHERE k='restored_from'")?.v || null, stripe: !!config.stripeKey, stripeWebhook: !!(config.stripeWebhookSecret || db.one("SELECT 1 FROM meta WHERE k='stripe_webhook_secret'")), firecrawl: !!config.firecrawlKey, emailSending: !!(config.campaignSending && config.smtp.host) };
    // Compteurs anonymes pour vérifier les tests d'inscription et de paiement (aucune donnée personnelle)
    ready.comptes = Object.fromEntries(db.all("SELECT status, COUNT(*) n FROM tenants WHERE example=0 AND status!='demo' AND COALESCE(source,'')!='autotest' GROUP BY status").map((r) => [r.status, r.n]));
    { const w = db.one('SELECT type, received_at FROM webhook_events ORDER BY received_at DESC LIMIT 1'); ready.dernierEvenementStripe = w ? { type: w.type, at: new Date(w.received_at).toISOString() } : null; }
    ready.facturesPayees = db.one("SELECT COUNT(*) n FROM invoices WHERE status='paid'").n;
    { let a = null; try { a = JSON.parse(db.one("SELECT v FROM meta WHERE k='autotest_last'")?.v || 'null'); } catch { a = null; } ready.autotest = a ? { at: a.at, ok: a.ok, formules: a.formules.map((f) => `${f.formule} : ${f.ok ? 'réussi' : 'échec'}`) } : null; }
    { const b = backupHealth(db); ready.sauvegardes = { ok: b.ok, problemes: b.problems, echecsDepuisDerniereReussite: b.failedSince, testRestauration: b.verified ? { ok: b.verified.ok, at: b.verified.at, fichier: b.verified.name, erreur: b.verified.error || null, contenu: b.verified.backup || null } : null }; }
    { const pot = db.all("SELECT CASE WHEN potential>=75 THEN 'A' WHEN potential>=50 THEN 'B' ELSE 'C' END cl, COUNT(*) n FROM prospects WHERE status='new' AND (phone IS NOT NULL OR email IS NOT NULL) GROUP BY cl"); ready.potentielJoignables = Object.fromEntries(pot.map((r) => [r.cl, r.n])); }
    ready.alertesEmail = !!(config.adminEmail && (config.brevoKey || config.smtp.host));
    ready.veille = { maintienEveil: config.keepAwake, dernierAppel: keepAwake.last ? { at: new Date(keepAwake.last.at).toISOString(), statut: keepAwake.last.status || keepAwake.last.error } : null };
    { const rd = readiness(db); ready.lancement = { faits: rd.done, total: rd.total, restants: rd.items.filter((i) => !i.ok).map((i) => i.key) }; }
    { const e = enrichStatus(db); ready.prospection = { prospects: db.one("SELECT COUNT(*) n FROM prospects WHERE status!='optout'").n, departements: db.one("SELECT COUNT(DISTINCT dept) n FROM prospects WHERE dept!=''").n, coordonnees: { actif: e.enabled, plafond: e.cap, creditsMois: e.used, joignablesMois: e.reachableMonth, creditsParJoignable: e.creditsPerReachable != null ? Math.round(e.creditsPerReachable * 100) / 100 : null, telephones: e.phones || 0, emails: e.emails || 0 } }; }
    json(c.res, { ok: jobsOk, env: config.appEnv, jobs: hb ? new Date(hb).toISOString() : null, time: new Date().toISOString(), ready }, jobsOk ? 200 : 503);
  });

  // Surveillance externe des sauvegardes (UptimeRobot gratuit) : 503 dès qu'un problème est détecté
  on('GET', '/health/sauvegardes', (c) => { const b = backupHealth(db); json(c.res, { ok: b.ok, problemes: b.problems, derniere: b.lastOk, test: b.verified ? { ok: b.verified.ok, at: b.verified.at } : null }, b.ok ? 200 : 503); });

  // ---------- inscription ----------
  on('GET', '/inscription', (c) => {
    const claim = c.url.searchParams.get('claim'); const demo = claim ? demoTenantByToken(db, claim) : null;
    if (claim && !demo) return html(c.res, V.messagePage('Lien expiré', 'Cette démonstration a déjà été activée ou n’existe plus.', ['Créer un site', '/inscription']), 404);
    const plan = c.url.searchParams.get('formule'); const tpl = c.url.searchParams.get('tpl');
    html(c.res, V.signupPage({ csrf: csrfToken(c), f: { plan: PLANS[plan] ? plan : 'pro', tpl: demo?.tpl || (TEMPLATES[tpl] ? tpl : undefined), country: demo?.country || guessCountry(c), lang: c.lang }, claim: demo ? claim : null, demo }));
  });
  on('POST', '/inscription', (c) => {
    checkCsrf(c); limit(c, 'signup', 10, 3600e3);
    const f = c.form; const errors = [];
    const demo = f.claim ? demoTenantByToken(db, f.claim) : null;
    if (f.claim && !demo) errors.push(tr('Cette démonstration a déjà été activée.'));
    const email = clampStr(f.email, 190).toLowerCase(); const name = clampStr(f.name, 80);
    if (!demo) { if (!clampStr(f.business, 80)) errors.push(tr("Indiquez le nom de l'entreprise.")); if (!TEMPLATES[f.tpl]) errors.push(tr('Choisissez un métier.')); if (f.country && !COUNTRIES[f.country]) errors.push(tr('Pays inconnu.')); }
    if (!name) errors.push(tr('Indiquez votre nom.'));
    if (!emailOk(email)) errors.push(tr('Adresse e-mail invalide.'));
    const pw = passwordProblem(f.password); if (pw) errors.push(tr(pw));
    if (f.cgu !== 'on') errors.push(tr("Vous devez accepter les conditions d'utilisation."));
    if (!PLANS[f.plan]) errors.push(tr('Formule inconnue.'));
    if (emailOk(email) && db.one('SELECT 1 FROM users WHERE email=?', email)) errors.push(tr('Un compte existe déjà avec cette adresse. Connectez-vous.'));
    if (errors.length) return html(c.res, V.signupPage({ csrf: csrfToken(c), f, errors, claim: demo ? f.claim : null, demo }), 400);
    const now = Date.now();
    const ulang = LANGS[f.lang] ? f.lang : c.lang;
    const userId = Number(db.run('INSERT INTO users(email,pass_hash,name,role,created_at,lang) VALUES(?,?,?,?,?,?)', email, hashPassword(f.password), name, 'pro', now, ulang).lastInsertRowid);
    let tenantId;
    if (demo) {
      db.tx(() => {
        db.run("UPDATE tenants SET status='trial', trial_ends_at=?, owner_user_id=?, email=?, plan=?, demo_token_hash=NULL, source=? WHERE id=? AND status='demo'", now + config.trialDays * 864e5, userId, email, f.plan, demo.prospect_id ? 'prospection' : (c.source || 'direct'), demo.id);
        db.run('INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,?)', userId, demo.id, 'owner');
        if (demo.prospect_id) db.run("UPDATE prospects SET status='converted' WHERE id=?", demo.prospect_id);
      });
      tenantId = demo.id;
    } else {
      const ctry = COUNTRIES[f.country] ? f.country : (countryByTz(f.tz) || guessCountry(c));
      tenantId = createTenant(db, { name: f.business, tpl: f.tpl, city: f.city, phone: f.phone, email, country: ctry, tz: validTz(f.tz) ? f.tz : null, lang: ulang, plan: f.plan, status: 'trial', ownerId: userId }).id;
      db.run('UPDATE tenants SET source=? WHERE id=?', c.source || 'direct', tenantId);
      // Parrainage et partenariat : rattachement à l'inscription, récompense seulement après paiement
      if (c.source.startsWith('site:')) { const r = db.one("SELECT t.id, u.email FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.slug=? AND t.status IN ('trial','active','past_due')", c.source.slice(5)); if (r && r.email !== email) db.run('UPDATE tenants SET referred_by_tenant_id=? WHERE id=?', r.id, tenantId); }
      if (c.source.startsWith('partner:')) { const pa = db.one("SELECT id, email FROM partners WHERE code=? AND status='active'", c.source.slice(8)); if (pa && pa.email !== email) db.run('UPDATE tenants SET partner_id=? WHERE id=?', pa.id, tenantId); }
    }
    const t = loadTenant(db, 'id', tenantId);
    const vt = issueToken(db, 'verify', { userId, hours: 48 });
    enqueue(db, { tenantId, channel: 'email', to: email, template: 'verify_email', payload: { lang: ulang, url: `${config.baseUrl}/verifier/${vt}` } });
    enqueue(db, { tenantId, channel: 'email', to: email, template: 'welcome', payload: { lang: ulang, tenant: t.name, siteUrl: `${config.baseUrl}/s/${t.slug}`, dashUrl: `${config.baseUrl}/pro`, trialEnd: new Date(t.trial_ends_at).toLocaleDateString(ulang === 'fr' ? 'fr-FR' : 'en-US') } });
    audit(db, { userId, tenantId, action: demo ? 'inscription.demo' : 'inscription', ip: c.ip });
    emit(db, 'inscription', { entreprise: t.name, metier: t.metier, ville: t.city, formule: t.plan, email, nom: name, depuis_demo: !!demo, site: `${config.baseUrl}/s/${t.slug}` }, tenantId);
    const s = createSession(db, userId);
    redirect(c.res, '/pro?bienvenue=1', { 'Set-Cookie': cookie(SESSION, s.token, { maxAge: 30 * 86400 }) });
  });

  // ---------- connexion ----------
  on('GET', '/connexion', (c) => html(c.res, V.loginPage({ csrf: csrfToken(c), info: c.url.searchParams.get('ok') === 'mdp' ? tr('Mot de passe modifié. Connectez-vous.') : '' })));
  on('POST', '/connexion', (c) => {
    checkCsrf(c); limit(c, 'login', 20, 15 * 60e3);
    const email = clampStr(c.form.email, 190).toLowerCase();
    if (!rateLimit(`login-mail:${email}`, 10, 15 * 60e3)) throw HttpError(429, 'Trop de tentatives pour ce compte. Patientez 15 minutes.');
    const r = login(db, email, c.form.password);
    if (!r.ok) { audit(db, { action: 'connexion.echec', detail: email, ip: c.ip }); return html(c.res, V.loginPage({ csrf: csrfToken(c), email, error: tr(r.locked ? 'Compte verrouillé 15 minutes après plusieurs échecs.' : 'E-mail ou mot de passe incorrect.') }), 401); }
    if (c.session) destroySession(db, c.cookies[SESSION]);
    const s = createSession(db, r.user.id);
    audit(db, { userId: r.user.id, action: 'connexion', ip: c.ip });
    redirect(c.res, r.user.role === 'superadmin' ? '/connexion/2fa' : '/pro', { 'Set-Cookie': cookie(SESSION, s.token, { maxAge: 30 * 86400 }) });
  });
  on('GET', '/connexion/2fa', (c) => {
    if (!c.session || c.session.role !== 'superadmin') return redirect(c.res, '/connexion');
    if (!c.session.totp_secret) return html(c.res, V.messagePage('Double authentification non configurée', 'Lancez « npm run create-admin » sur le serveur pour générer la clé.'), 403);
    html(c.res, V.totpPage({ csrf: csrfToken(c) }));
  });
  on('POST', '/connexion/2fa', (c) => {
    if (!c.session || c.session.role !== 'superadmin') return redirect(c.res, '/connexion');
    checkCsrf(c); limit(c, 'totp', 10, 15 * 60e3);
    if (!totpOk(c.session.totp_secret, c.form.code)) { audit(db, { userId: c.session.user_id, action: '2fa.echec', ip: c.ip }); return html(c.res, V.totpPage({ csrf: csrfToken(c), error: tr('Code incorrect.') }), 401); }
    db.run('UPDATE sessions SET totp_ok=1 WHERE id_hash=?', c.session.id_hash);
    audit(db, { userId: c.session.user_id, action: '2fa.ok', ip: c.ip });
    redirect(c.res, '/admin');
  });
  on('POST', '/deconnexion', (c) => { if (c.session) { checkCsrf(c); destroySession(db, c.cookies[SESSION]); } redirect(c.res, '/connexion', { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0 }) }); });
  on('GET', '/verifier/:token', (c) => {
    const tk = useToken(db, 'verify', c.params.token);
    if (!tk) return html(c.res, V.messagePage('Lien expiré', 'Ce lien de confirmation n’est plus valable.', ['Espace pro', '/pro']), 400);
    db.run('UPDATE users SET email_verified=1 WHERE id=?', tk.user_id);
    html(c.res, V.messagePage('Adresse confirmée', 'Merci, votre adresse e-mail est confirmée.', ['Aller à mon espace', '/pro']));
  });
  on('GET', '/mot-de-passe-oublie', (c) => html(c.res, V.forgotPage({ csrf: csrfToken(c) })));
  on('POST', '/mot-de-passe-oublie', (c) => {
    checkCsrf(c); limit(c, 'forgot', 5, 3600e3);
    const u = db.one('SELECT id,email,lang FROM users WHERE email=?', clampStr(c.form.email, 190).toLowerCase());
    if (u) { const t = issueToken(db, 'reset', { userId: u.id, hours: 2 }); enqueue(db, { channel: 'email', to: u.email, template: 'reset_password', payload: { lang: u.lang, url: `${config.baseUrl}/reinitialiser/${t}` } }); }
    html(c.res, V.forgotPage({ csrf: csrfToken(c), sent: true }));
  });
  on('GET', '/reinitialiser/:token', (c) => {
    if (!useToken(db, 'reset', c.params.token, { consume: false })) return html(c.res, V.messagePage('Lien expiré', 'Demandez un nouveau lien.', ['Mot de passe oublié', '/mot-de-passe-oublie']), 400);
    html(c.res, V.resetPage({ csrf: csrfToken(c), token: c.params.token }));
  });
  on('POST', '/reinitialiser/:token', (c) => {
    checkCsrf(c);
    const p = passwordProblem(c.form.password);
    if (p) return html(c.res, V.resetPage({ csrf: csrfToken(c), token: c.params.token, error: tr(p) }), 400);
    const tk = useToken(db, 'reset', c.params.token);
    if (!tk) return html(c.res, V.messagePage('Lien expiré', 'Demandez un nouveau lien.', ['Mot de passe oublié', '/mot-de-passe-oublie']), 400);
    db.run('UPDATE users SET pass_hash=?, failed_logins=0, locked_until=0 WHERE id=?', hashPassword(c.form.password), tk.user_id);
    destroyUserSessions(db, tk.user_id); audit(db, { userId: tk.user_id, action: 'mdp.reinitialise', ip: c.ip });
    redirect(c.res, '/connexion?ok=mdp', { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0 }) });
  });

  // ---------- annulation par le client ----------
  on('GET', '/annuler/:token', (c) => html(c.res, V.confirmPage('Annuler mon rendez-vous', 'Voulez-vous vraiment annuler ce rendez-vous ?', 'Oui, annuler', csrfToken(c))));
  on('POST', '/annuler/:token', (c) => {
    checkCsrf(c); limit(c, 'cancel', 20, 3600e3);
    const r = cancelByCustomer(db, c.params.token);
    if (r.late) return html(c.res, V.messagePage('Trop tard pour annuler en ligne', 'Le rendez-vous a lieu dans moins de 2 heures : contactez directement le professionnel.'), 400);
    if (!r.ok) return html(c.res, V.messagePage('Lien expiré', 'Ce rendez-vous est déjà annulé ou n’existe pas.'), 404);
    const t = loadTenant(db, 'id', r.appt.tenant_id);
    notifyPro(t, 'annulation', `${r.appt.customer_name} a annulé son rendez-vous du ${r.appt.date} à ${r.appt.time} (${r.appt.service_name}).`);
    html(c.res, V.messagePage('Rendez-vous annulé', tr('Votre rendez-vous chez {n} est annulé. Le professionnel est prévenu.', { n: t.name })));
  });

  // ---------- sites des entreprises ----------
  const firstSvc = (t) => t.services[0]?.id || null;
  function renderSite(c, t, base, mode, demoClaim = null) {
    c.setLang(t.lang || 'fr');
    if (mode === 'live' && !isBot(c.req.headers['user-agent'])) track(db, t, 'views');
    html(c.res, V.tenantSite(t, { base, mode, days: openDays(db, t, 10, firstSvc(t)), aiMode: mode === 'live' && aiAvailable(t) ? 'ia' : 'simple', demoClaim, head: siteHead(t, { mode }) }));
  }
  function liveTenant(slug, c = null) {
    const t = loadTenant(db, 'slug', slug);
    if (!t || t.status === 'demo') throw HttpError(404, 'Site introuvable.');
    if (c) c.setLang(t.lang || 'fr');
    return t;
  }
  on('GET', '/s/:slug', (c) => {
    const t = liveTenant(c.params.slug);
    if (siteState(t) !== 'live') return html(c.res, V.pausedPage(t), 503);
    renderSite(c, t, c.base ?? `/s/${t.slug}`, 'live');
  });
  on('GET', '/s/:slug/robots.txt', (c) => { const t = liveTenant(c.params.slug); const u = siteUrl(t); send(c.res, 200, robots(`${u.replace(/\/$/, '')}/sitemap.xml`, { allow: config.isProd }), { 'Content-Type': 'text/plain; charset=utf-8' }); });
  on('GET', '/s/:slug/sitemap.xml', (c) => { const t = liveTenant(c.params.slug); send(c.res, 200, sitemap([{ loc: siteUrl(t), lastmod: t.updated_at || t.created_at }]), { 'Content-Type': 'application/xml; charset=utf-8' }); });
  // API publique (JSON) d'un site
  function siteApi(prefix, resolve) {
    on('GET', `${prefix}/wa`, (c) => {
      const { t, demo } = resolve(c, { html: true }); if (!t.phone) throw HttpError(404, 'Pas de numéro WhatsApp');
      if (!demo && !isBot(c.req.headers['user-agent'])) track(db, t, 'wa_clicks');
      redirect(c.res, `https://wa.me/${t.phone}?text=${encodeURIComponent(`Bonjour ${t.name}, `)}`);
    });
    on('GET', `${prefix}/creneaux`, (c) => {
      const { t } = resolve(c); limit(c, 'slots', 120, 60e3);
      const svc = c.url.searchParams.get('service'); const date = c.url.searchParams.get('date');
      json(c.res, { slots: freeSlots(db, t, date, svc), days: date ? undefined : openDays(db, t, 10, svc) });
    });
    on('POST', `${prefix}/rdv`, (c) => {
      const { t, demo } = resolve(c); limit(c, 'book', config.rateBookMax, 600e3);
      if (demo) return json(c.res, { ok: true, demo: true, msg: tr('Démonstration : sur le site activé, ce créneau serait réservé et le professionnel prévenu. Rien n’a été enregistré.') });
      const r = book(db, t, { ...c.form, source: 'site' });
      if (!r.ok) return json(c.res, { ok: false, code: r.code, msg: r.msg }, r.code === 'taken' ? 409 : 400);
      const a = db.one('SELECT * FROM appointments WHERE id=?', r.id);
      notifyAppointment(db, t, a, 'appt_customer', r.cancelToken);
      notifyPro(t, r.status === 'confirmed' ? 'réservation' : 'demande de rendez-vous', `${a.customer_name} (+${a.customer_phone}) · ${a.service_name} · ${a.date} à ${a.time} · ${a.staff_name}`);
      emit(db, 'rdv', { entreprise: t.name, statut: r.status, client: a.customer_name, telephone: '+' + a.customer_phone, email: a.customer_email, prestation: a.service_name, date: a.date, heure: a.time, debut_utc: new Date(a.starts_at).toISOString(), duree_min: a.dur, poste: a.staff_name, fuseau: t.tz }, t.id);
      json(c.res, { ok: true, status: r.status, msg: r.msg });
    });
    on('POST', `${prefix}/devis`, (c) => {
      const { t, demo } = resolve(c); limit(c, 'quote', 10, 600e3);
      if (demo) return json(c.res, { ok: true, demo: true, msg: tr('Démonstration : sur le site activé, cette demande arriverait dans l’espace du professionnel. Rien n’a été enregistré.') });
      const r = createQuote(db, t, c.form);
      if (!r.ok) return json(c.res, { ...r, msg: tr(r.msg) }, 400);
      notifyPro(t, 'demande de devis', `${clampStr(c.form.name, 80)} (+${intlPhone(c.form.phone, t.cc)}) · ${clampStr(c.form.service, 80)} · ${clampStr(c.form.message, 300)}`);
      emit(db, 'devis', { entreprise: t.name, client: clampStr(c.form.name, 80), telephone: '+' + intlPhone(c.form.phone, t.cc), prestation: clampStr(c.form.service, 80), message: clampStr(c.form.message, 500) }, t.id);
      json(c.res, { ok: true, msg: tr('Demande envoyée à {n}. Vous serez recontacté rapidement.', { n: t.name }) });
    });
    on('POST', `${prefix}/chat`, async (c) => {
      const { t, demo } = resolve(c); limit(c, 'chat', 30, 60e3);
      const q = clampStr(c.form.q, 600); if (!q) return json(c.res, { text: '', mode: 'simple' }, 400);
      if (demo) return json(c.res, { text: ruleAnswer(db, t, q), mode: 'simple' });
      track(db, t, 'chats');
      json(c.res, await answer(db, t, c.form.conv, q));
    });
  }
  siteApi('/s/:slug', (c) => {
    if (!sameOrigin(c.req)) throw HttpError(403, 'Origine refusée');
    const t = liveTenant(c.params.slug, c); if (siteState(t) !== 'live') throw HttpError(503, 'Site indisponible');
    return { t, demo: false };
  });
  const demoResolve = (c) => {
    if (!sameOrigin(c.req)) throw HttpError(403, 'Origine refusée');
    const row = demoTenantByToken(db, c.params.token); if (!row) throw HttpError(404, 'Démonstration introuvable');
    c.setLang(row.lang || 'fr');
    return { t: loadTenant(db, 'id', row.id), demo: true };
  };
  siteApi('/exemple/:tpl', (c) => {
    if (!sameOrigin(c.req)) throw HttpError(403, 'Origine refusée');
    if (!EXAMPLE_TPLS.includes(c.params.tpl)) throw HttpError(404, 'Page introuvable');
    const tn = exampleTenant(db, c.params.tpl, c.lang); c.setLang(tn.lang); return { t: tn, demo: true };
  });
  on('GET', '/demo/:token', (c) => {
    const row = demoTenantByToken(db, c.params.token);
    if (!row) return html(c.res, V.messagePage('Démonstration terminée', 'Ce site a été activé ou la démonstration n’existe plus.', ['Découvrir ClientDirect Pro', '/']), 404);
    recordDemoView(db, row);
    if (row.prospect_id && config.trackDemoViews) emit(db, 'demo_vue', { entreprise: row.name, prospect_id: row.prospect_id }, row.id);
    renderSite(c, loadTenant(db, 'id', row.id), `/demo/${c.params.token}`, 'demo', c.params.token);
  });
  siteApi('/demo/:token', demoResolve);

  // ---------- espace professionnel ----------
  const msgFrom = (c) => { const k = c.url.searchParams.get('bienvenue') ? 'bienvenue' : c.url.searchParams.get('m'); const m = { bienvenue: 'Votre site est en ligne ! Vérifiez vos prestations et horaires dans Réglages.', ok: 'Modification enregistrée.', avis: 'Merci pour votre avis !' }[k]; return m ? tr(m) : ''; };
  on('POST', '/pro/avis', (c) => {
    requirePro(c); checkCsrf(c);
    const score = Number(c.form.score); if (!(score >= 1 && score <= 5)) throw HttpError(400, 'Note invalide');
    db.run('INSERT INTO feedback(tenant_id,user_id,score,comment,created_at) VALUES(?,?,?,?,?)', c.tenant.id, c.user.id, score, clampStr(c.form.comment, 1000), Date.now());
    emit(db, 'avis', { entreprise: c.tenant.name, note: score, commentaire: clampStr(c.form.comment, 300) }, c.tenant.id);
    redirect(c.res, '/pro?m=avis');
  });
  on('GET', '/pro', (c) => {
    requirePro(c); const t = c.tenant; const today = nowIn(t.tz).date;
    const appts = db.all("SELECT * FROM appointments WHERE tenant_id=? AND date>=? AND status IN ('pending','confirmed') ORDER BY date, time LIMIT 200", t.id, today);
    const quotes = db.all("SELECT * FROM quotes WHERE tenant_id=? ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, id DESC LIMIT 50", t.id);
    const stats = { pending: appts.filter((a) => a.status === 'pending').length, upcoming: appts.length, quotes: quotes.filter((q) => q.status === 'new').length, revenue: appts.filter((a) => a.status === 'confirmed').reduce((s, a) => s + a.price, 0) };
    // Avis demandé après 7 jours d'utilisation, puis au plus une fois par mois
    const askFeedback = Date.now() - t.created_at > 7 * 864e5 && !db.one('SELECT 1 FROM feedback WHERE tenant_id=? AND created_at>?', t.id, Date.now() - 30 * 864e5);
    html(c.res, V.proDashboard(t, c.user, csrfToken(c), { appts, quotes, stats, msg: msgFrom(c), perf: last30(db, t), curve: daily(db, t, 30), askFeedback, referral: ['trial', 'active', 'past_due'].includes(t.status) ? referralStats(db, t) : null }));
  });
  on('POST', '/pro/rdv/:id/statut', (c) => {
    requirePro(c); checkCsrf(c); const t = c.tenant;
    const r = setAppointmentStatus(db, t.id, Number(c.params.id), c.form.status);
    if (!r.ok) throw HttpError(400, r.msg);
    const tpl = { confirmed: 'appt_confirmed', refused: 'appt_refused', canceled: 'appt_refused' }[c.form.status];
    if (tpl) notifyAppointment(db, t, r.appt, tpl, null);
    audit(db, { userId: c.user.id, tenantId: t.id, action: `rdv.${c.form.status}`, detail: String(r.appt.id), ip: c.ip });
    redirect(c.res, '/pro?m=ok');
  });
  on('POST', '/pro/devis/:id/statut', (c) => {
    requirePro(c); checkCsrf(c);
    if (!['handled', 'refused'].includes(c.form.status)) throw HttpError(400, 'Statut inconnu');
    const ch = db.run('UPDATE quotes SET status=? WHERE id=? AND tenant_id=?', c.form.status, Number(c.params.id), c.tenant.id).changes;
    if (!Number(ch)) throw HttpError(404, 'Demande introuvable');
    redirect(c.res, '/pro?m=ok');
  });
  const settingsPage = (c, extra = {}, status = 200) => html(c.res, V.proSettings(c.tenant, c.user, csrfToken(c), { dnsTarget: config.renderHostname, ...extra }), status);
  on('GET', '/pro/reglages', (c) => { requirePro(c); settingsPage(c, { saved: c.url.searchParams.get('m') === 'ok' }); });
  on('POST', '/pro/domaine', async (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'domain', 10, 3600e3);
    if (!planHas(c.tenant.plan, 'rdv')) throw HttpError(403, 'Disponible avec les formules Pro et Premium.');
    const r = await setDomain(db, c.tenant, c.form.domain);
    audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'domaine', detail: String(c.form.domain || '').slice(0, 120), ip: c.ip });
    c.tenant = loadTenant(db, 'id', c.tenant.id);
    settingsPage(c, r.ok ? { domainMsg: tr(r.msg) } : { errors: [tr(r.msg)] }, r.ok ? 200 : 400);
  });
  on('GET', '/pro/donnees/export', (c) => {
    requirePro(c); audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'export', ip: c.ip });
    send(c.res, 200, JSON.stringify(exportTenant(db, c.tenant.id, c.user.id), null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="clientdirect-${c.tenant.slug}.json"`, 'Cache-Control': 'no-store' });
  });
  on('POST', '/pro/compte/supprimer', (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'delete', 5, 3600e3);
    const u = db.one('SELECT pass_hash FROM users WHERE id=?', c.user.id);
    if (!verifyPassword(c.form.password || '', u.pass_hash)) return settingsPage(c, { errors: [tr('Mot de passe incorrect : compte non supprimé.')] }, 400);
    deleteTenant(db, c.tenant.id, c.user.id, c.ip);
    redirect(c.res, '/?compte=supprime', { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0 }) });
  });
  on('POST', '/pro/reglages', (c) => {
    requirePro(c); checkCsrf(c);
    const errors = updateSettings(db, c.tenant.id, c.form);
    if (errors.length) return settingsPage(c, { errors }, 400);
    audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'reglages', ip: c.ip });
    redirect(c.res, '/pro/reglages?m=ok');
  });
  on('GET', '/pro/abonnement', (c) => {
    requirePro(c); const q = c.url.searchParams;
    const msg = q.get('ok') ? 'Paiement reçu. Votre abonnement s’active dès la confirmation de Stripe (quelques secondes).' : q.get('annule') ? 'Paiement annulé, rien n’a été débité.' : '';
    html(c.res, V.proBilling(c.tenant, c.user, csrfToken(c), { configured: billingConfigured(), open: billingOpen(c.tenant.country), msg: tr(msg), invoices: db.all('SELECT * FROM invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 24', c.tenant.id) }));
  });
  on('POST', '/pro/abonnement/checkout', async (c) => {
    requirePro(c); checkCsrf(c);
    if (!billingConfigured()) throw HttpError(503, 'Le paiement en ligne n’est pas encore activé.');
    if (!billingOpen(c.tenant.country)) throw HttpError(403, 'Les abonnements payants ne sont pas encore ouverts dans votre pays.');
    const url = await createCheckout(c.tenant, c.user.email, c.form.plan);
    audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'checkout', detail: c.form.plan, ip: c.ip });
    redirect(c.res, url);
  });
  on('POST', '/pro/abonnement/portail', async (c) => { requirePro(c); checkCsrf(c); redirect(c.res, await createPortal(c.tenant)); });
  const proTickets = (c) => db.all('SELECT * FROM tickets WHERE tenant_id=? ORDER BY id DESC LIMIT 20', c.tenant.id).map((tk) => ({ ...tk, messages: db.all('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id', tk.id) }));
  on('GET', '/pro/aide', (c) => { requirePro(c); html(c.res, V.proHelp(c.tenant, c.user, csrfToken(c), { tickets: proTickets(c), msg: c.url.searchParams.get('m') === 'ticket' ? 'Ticket envoyé. Nous vous répondons par e-mail.' : '' })); });
  on('POST', '/pro/aide/question', async (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'support', 30, 3600e3);
    const q = clampStr(c.form.q, 800); const a = q ? await supportAnswer(q) : null; if (a && a.mode !== 'ia') a.text = tr(a.text);
    html(c.res, V.proHelp(c.tenant, c.user, csrfToken(c), { q, answer: a, tickets: proTickets(c) }));
  });
  on('POST', '/pro/aide/ticket', async (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'ticket', 10, 3600e3);
    const body = clampStr(c.form.body, 4000); if (!body) throw HttpError(400, 'Décrivez votre demande.');
    const id = openTicket(db, { tenantId: c.tenant.id, userId: c.user.id, email: c.user.email, subject: c.form.subject, body });
    const a = await supportAnswer(body);
    if (a.articles.length) db.run('INSERT INTO ticket_messages(ticket_id,author,body,created_at) VALUES(?,?,?,?)', id, 'bot', `Réponse automatique : ${a.text}`, Date.now());
    if (config.adminEmail) enqueue(db, { channel: 'email', to: config.adminEmail, template: 'pro_new_request', payload: { kind: 'ticket d’assistance', tenant: c.tenant.name, summary: body.slice(0, 500), dashUrl: `${config.baseUrl}/admin/tickets/${id}` } });
    emit(db, 'ticket', { entreprise: c.tenant.name, email: c.user.email, sujet: clampStr(c.form.subject, 140), message: body.slice(0, 500), lien: `${config.baseUrl}/admin/tickets/${id}` }, c.tenant.id);
    redirect(c.res, '/pro/aide?m=ticket');
  });

  // ---------- administration générale ----------
  function adminData(c, msg = '') {
    const m = month(); const start = Date.parse(m + '-01T00:00:00Z');
    const tenants = db.all("SELECT t.*, (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id=t.id) appts FROM tenants t WHERE t.status!='demo' ORDER BY t.id DESC LIMIT 500");
    const ai = db.one('SELECT COALESCE(SUM(calls),0) calls, COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o FROM ai_usage WHERE month=?', m);
    const expenses = db.all('SELECT * FROM expenses WHERE month=? OR (recurring=1 AND month<=?) ORDER BY id DESC', m, m);
    const aiCost = aiCostEur(ai.i, ai.o);
    const count = (s) => db.one('SELECT COUNT(*) n FROM tenants WHERE status=?', s).n;
    return {
      msg, tenants, expenses, aiCost, aiCalls: ai.calls,
      counts: { active: count('active'), trial: count('trial') },
      mrr: db.all("SELECT plan FROM tenants WHERE status IN ('active','past_due')").reduce((s, r) => s + PLANS[r.plan].monthly, 0),
      revenueMonth: db.one("SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='paid' AND paid_at>=?", start).c / 100,
      expensesMonth: expenses.reduce((s, e) => s + e.amount_cents, 0) / 100 + aiCost,
      incidents: openIncidents(db),
      lastBackup: db.one("SELECT * FROM backups WHERE status='ok' ORDER BY id DESC LIMIT 1"),
      pendingOutbox: db.one("SELECT COUNT(*) n FROM outbox WHERE status='pending'").n,
      tickets: db.all("SELECT * FROM tickets WHERE status!='closed' ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, updated_at DESC LIMIT 30")
    };
  }
  on('GET', '/admin', (c) => { requireAdmin(c); html(c.res, V.adminDashboard(csrfToken(c), adminData(c, c.url.searchParams.get('m') === 'ok' ? 'Enregistré.' : ''))); });
  // Bilan d'une période : inscriptions, abonnements, revenus, dépenses, canaux, territoires, avis
  function reviewData(fromIso, toIso) {
    const from = Date.parse(fromIso + 'T00:00:00Z'), to = Date.parse(toIso + 'T23:59:59Z');
    const T = db.all("SELECT id, plan, status, country, source, created_at FROM tenants WHERE status NOT IN ('demo') AND example=0 AND COALESCE(source,'')!='autotest' AND created_at BETWEEN ? AND ?", from, to);
    const paid = db.all("SELECT i.tenant_id, i.amount_cents FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE i.status='paid' AND COALESCE(t.source,'')!='autotest' AND i.paid_at BETWEEN ? AND ?", from, to);
    const revBy = new Map(); for (const i of paid) revBy.set(i.tenant_id, (revBy.get(i.tenant_id) || 0) + i.amount_cents / 100);
    const isPaying = (t) => ['active', 'past_due'].includes(t.status);
    const months = []; for (let d = new Date(fromIso + 'T00:00:00Z'); d <= new Date(to); d.setUTCMonth(d.getUTCMonth() + 1, 1)) months.push(d.toISOString().slice(0, 7));
    const exp = months.reduce((sum, m) => sum + db.all('SELECT amount_cents FROM expenses WHERE month=? OR (recurring=1 AND month<=?)', m, m).reduce((a, e) => a + e.amount_cents, 0) / 100, 0);
    const ai = months.reduce((sum, m) => { const r = db.one('SELECT COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o FROM ai_usage WHERE month=?', m); return sum + aiCostEur(r.i, r.o); }, 0);
    const label = (src) => !src || src === 'direct' ? 'Accès direct' : src === 'prospection' ? 'Prospection (démo activée)' : src === 'site' || src.startsWith('site:') ? 'Recommandation (site client)' : src.startsWith('partner:') ? 'Partenaires prescripteurs' : src.startsWith('metier:') ? 'Pages métiers (Google)' : src.startsWith('utm:') ? `Campagne ${src.slice(4)}` : src;
    const groups = new Map();
    const add = (key, lab) => { if (!groups.has(key)) groups.set(key, { label: lab, visits: 0, signups: 0, paying: 0, revenue: 0 }); return groups.get(key); };
    for (const v of db.all('SELECT source, SUM(n) n FROM visits_source WHERE day BETWEEN ? AND ? GROUP BY source', fromIso, toIso)) add(label(v.source), label(v.source)).visits += v.n;
    for (const t of T) { const g = add(label(t.source), label(t.source)); g.signups++; if (isPaying(t)) g.paying++; g.revenue += revBy.get(t.id) || 0; }
    const ter = new Map();
    for (const t of T) { const lab = COUNTRIES[t.country]?.fr || t.country; if (!ter.has(lab)) ter.set(lab, { label: lab, signups: 0, paying: 0, revenue: 0 }); const g = ter.get(lab); g.signups++; if (isPaying(t)) g.paying++; g.revenue += revBy.get(t.id) || 0; }
    const fbl = db.all('SELECT f.*, t.name FROM feedback f LEFT JOIN tenants t ON t.id=f.tenant_id WHERE f.created_at BETWEEN ? AND ? ORDER BY f.id DESC LIMIT 100', from, to);
    const pr = db.one("SELECT COUNT(*) found, SUM(demo_views>0) viewed, SUM(status='converted') converted, SUM(status='optout') optout, COUNT(DISTINCT NULLIF(dept,'')) depts FROM prospects WHERE created_at BETWEEN ? AND ?", from, to);
    return {
      from: fromIso, to: toIso, signups: T.length, trials: T.filter((t) => t.status === 'trial').length, paying: T.filter(isPaying).length,
      revenue: paid.reduce((a, i) => a + i.amount_cents, 0) / 100, expenses: exp + ai,
      mrr: db.all("SELECT plan FROM tenants WHERE status IN ('active','past_due')").reduce((a, r) => a + PLANS[r.plan].monthly, 0),
      churn: T.filter((t) => ['canceled', 'paused'].includes(t.status)).length,
      bySource: [...groups.values()].sort((a, b) => b.signups - a.signups || b.visits - a.visits),
      byTerritory: [...ter.values()].sort((a, b) => b.signups - a.signups),
      feedback: { list: fbl, count: fbl.length, avg: fbl.length ? Math.round((fbl.reduce((a, f) => a + f.score, 0) / fbl.length) * 10) / 10 : null },
      tickets: db.one("SELECT COUNT(*) total, SUM(status='open') open FROM tickets WHERE created_at BETWEEN ? AND ?", from, to),
      prospects: { found: pr.found || 0, viewed: db.one("SELECT COALESCE(SUM(n),0) n FROM visits_source WHERE source='demo' AND day BETWEEN ? AND ?", fromIso, toIso).n, converted: pr.converted || 0, optout: pr.optout || 0, depts: pr.depts || 0 }
    };
  }
  on('GET', '/admin/campagnes', (c) => { requireAdmin(c); html(c.res, V.adminCampaigns(csrfToken(c), { list: db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 200') })); });
  on('POST', '/admin/campagnes', (c) => {
    requireAdmin(c); checkCsrf(c);
    const depts = String(c.form.depts || '').split(/[\s,;]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);
    const tpls = Object.keys(TEMPLATES).filter((k) => c.form[`tpl_${k}`] === 'on');
    try { const id = createCampaign(db, { name: c.form.name, channel: c.form.channel, depts, tpls, minScore: c.form.minScore, minPotential: c.form.minPotential, size: c.form.size }); audit(db, { action: 'campagne.preparee', detail: String(id), ip: c.ip }); redirect(c.res, `/admin/campagnes/${id}`); }
    catch (e) { html(c.res, V.adminCampaigns(csrfToken(c), { list: db.all('SELECT * FROM campaigns ORDER BY id DESC LIMIT 200'), msg: e.message }), 400); }
  });
  on('GET', '/admin/campagnes/:id', (c) => { requireAdmin(c); const d = campaignDetail(db, Number(c.params.id)); if (!d) throw HttpError(404, 'Campagne introuvable'); html(c.res, V.adminCampaign(csrfToken(c), d)); });
  on('POST', '/admin/campagnes/:id/valider', (c) => { requireAdmin(c); checkCsrf(c); approveCampaign(db, Number(c.params.id)); audit(db, { action: 'campagne.validee', detail: String(c.params.id), ip: c.ip }); redirect(c.res, `/admin/campagnes/${Number(c.params.id)}`); });
  on('POST', '/admin/campagnes/:id/annuler', (c) => { requireAdmin(c); checkCsrf(c); cancelCampaign(db, Number(c.params.id)); redirect(c.res, '/admin/campagnes'); });
  on('GET', '/admin/campagnes/:id/export.csv', (c) => {
    requireAdmin(c); const id = Number(c.params.id);
    const cmp = db.one("SELECT * FROM campaigns WHERE id=? AND status='approved'", id); if (!cmp) throw HttpError(404, 'Campagne non validée');
    const rows = db.all("SELECT i.*, p.name, p.city, p.dept, p.siren FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? AND i.status='ready' AND p.status!='optout' ORDER BY i.id", id);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    send(c.res, 200, '\ufeff' + [['Entreprise', 'Ville', 'Département', 'SIREN', 'Destinataire', 'Message'].map(q).join(';'), ...rows.map((r) => [displayName(r.name), displayName(r.city), r.dept, r.siren, r.to_addr, r.message].map(q).join(';'))].join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="campagne-${id}.csv"` });
  });
  on('GET', '/admin/partenaires', (c) => {
    requireAdmin(c);
    const partners = db.all('SELECT * FROM partners ORDER BY status, id DESC').map((p) => ({ ...p, st: p.code ? partnerStats(db, p) : null }));
    const rewards = db.all(`SELECT r.*, s.name source_name, b.name beneficiary_name, p.company partner_name FROM rewards r LEFT JOIN tenants s ON s.id=r.source_tenant_id LEFT JOIN tenants b ON b.id=r.beneficiary_tenant_id LEFT JOIN partners p ON p.id=r.partner_id ORDER BY r.id DESC LIMIT 300`);
    html(c.res, V.adminPartners(csrfToken(c), { partners, rewards, program: PROGRAM, created: c.url.searchParams.get('lien') ? { link: c.url.searchParams.get('lien'), dashboard: c.url.searchParams.get('espace') } : null }));
  });
  on('POST', '/admin/partenaires/:id/valider', (c) => {
    requireAdmin(c); checkCsrf(c); const r = approvePartner(db, Number(c.params.id));
    audit(db, { action: 'partenaire.valide', detail: String(c.params.id), ip: c.ip });
    redirect(c.res, `/admin/partenaires?lien=${encodeURIComponent(r.link)}&espace=${encodeURIComponent(r.dashboard)}`);
  });
  on('POST', '/admin/partenaires/:id/arreter', (c) => { requireAdmin(c); checkCsrf(c); db.run("UPDATE partners SET status='stopped' WHERE id=?", Number(c.params.id)); redirect(c.res, '/admin/partenaires'); });
  on('POST', '/admin/recompenses/:id/verse', (c) => {
    requireAdmin(c); checkCsrf(c);
    db.run("UPDATE rewards SET status='paid', updated_at=? WHERE id=? AND kind='commission' AND status='approved'", Date.now(), Number(c.params.id));
    audit(db, { action: 'commission.versee', detail: String(c.params.id), ip: c.ip }); redirect(c.res, '/admin/partenaires');
  });
  on('GET', '/admin/pret', (c) => { requireAdmin(c); html(c.res, V.adminReadiness(csrfToken(c), readiness(db), c.url.searchParams.get('msg') || '')); });
  on('POST', '/admin/test-email', async (c) => {
    requireAdmin(c);
    let msg;
    if (!config.adminEmail) msg = 'ADMIN_EMAIL absent : indiquez votre adresse dans Render.';
    else { try { const { sendTestEmail } = await import('./notify.js'); const r = await sendTestEmail(config.adminEmail); msg = r.ok ? `E-mail de test envoyé à ${config.adminEmail}${r.via === 'smtp' ? ' (SMTP)' : ' (Brevo)'}. Vérifiez votre boîte (et les indésirables).` : r.skipped; } catch (e) { msg = `Échec : ${String(e.message).slice(0, 200)}`; } }
    audit(db, { action: 'admin.test_email', detail: msg.slice(0, 200), ip: c.ip });
    redirect(c.res, '/admin/pret?msg=' + encodeURIComponent(msg));
  });
  on('GET', '/admin/bilan', (c) => {
    requireAdmin(c);
    const iso = (d) => d.toISOString().slice(0, 10); const ok = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '') && !Number.isNaN(Date.parse(v));
    // Le bilan du mois 1 couvre les 30 jours qui suivent le lancement commercial officiel
    const launch = db.one("SELECT v FROM meta WHERE k='launch_date'")?.v || null;
    const defTo = launch ? iso(new Date(Date.parse(launch) + 29 * 864e5)) : iso(new Date());
    const to = ok(c.url.searchParams.get('au')) ? c.url.searchParams.get('au') : defTo;
    const from = ok(c.url.searchParams.get('du')) ? c.url.searchParams.get('du') : (launch || iso(new Date(Date.parse(to) - 29 * 864e5)));
    html(c.res, V.adminReview(csrfToken(c), { ...reviewData(from, to), sales: salesData(db, from, to), launch, reviewDay: launch ? iso(new Date(Date.parse(launch) + 30 * 864e5)) : null }));
  });
  on('POST', '/admin/lancement', (c) => {
    requireAdmin(c); checkCsrf(c);
    const d = String(c.form.date || '');
    if (d && !(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)))) throw HttpError(400, 'Date invalide');
    if (d) db.run("INSERT INTO meta(k,v) VALUES('launch_date',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", d); else db.run("DELETE FROM meta WHERE k='launch_date'");
    audit(db, { action: 'lancement.date', detail: d || 'effacée', ip: c.ip }); redirect(c.res, '/admin/bilan');
  });
  on('GET', '/admin/rentabilite', (c) => { requireAdmin(c); const m = /^\d{4}-\d{2}$/.test(c.url.searchParams.get('mois') || '') ? c.url.searchParams.get('mois') : undefined; html(c.res, V.adminProfit(csrfToken(c), tenantCosts(db, m))); });
  on('POST', '/admin/depenses', (c) => {
    requireAdmin(c); checkCsrf(c);
    const amount = Math.round(Number(String(c.form.amount).replace(',', '.')) * 100); const label = clampStr(c.form.label, 80);
    if (!label || !(amount > 0 && amount < 1e8)) throw HttpError(400, 'Libellé ou montant invalide.');
    db.run('INSERT INTO expenses(label,amount_cents,month,category,recurring,created_at) VALUES(?,?,?,?,?,?)', label, amount, month(), ['technique', 'commercial', 'administratif'].includes(c.form.category) ? c.form.category : 'technique', c.form.recurring === 'on' ? 1 : 0, Date.now());
    redirect(c.res, '/admin?m=ok');
  });
  on('POST', '/admin/depenses/:id/supprimer', (c) => { requireAdmin(c); checkCsrf(c); db.run('DELETE FROM expenses WHERE id=?', Number(c.params.id)); redirect(c.res, '/admin?m=ok'); });
  on('POST', '/admin/incidents/:id/resoudre', (c) => { requireAdmin(c); checkCsrf(c); resolveIncident(db, Number(c.params.id)); redirect(c.res, '/admin?m=ok'); });
  on('POST', '/admin/entreprises/:id/statut', (c) => {
    requireAdmin(c); checkCsrf(c);
    if (!['paused', 'active'].includes(c.form.status)) throw HttpError(400, 'Statut inconnu');
    db.run("UPDATE tenants SET status=? WHERE id=? AND status!='demo'", c.form.status, Number(c.params.id));
    audit(db, { userId: c.session.user_id, tenantId: Number(c.params.id), action: `admin.statut.${c.form.status}`, ip: c.ip });
    redirect(c.res, '/admin?m=ok');
  });
  on('GET', '/admin/tickets/:id', (c) => {
    requireAdmin(c); const tk = db.one('SELECT * FROM tickets WHERE id=?', Number(c.params.id)); if (!tk) throw HttpError(404, 'Ticket introuvable');
    html(c.res, V.adminTicket(csrfToken(c), tk, db.all('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id', tk.id)));
  });
  on('POST', '/admin/tickets/:id', (c) => {
    requireAdmin(c); checkCsrf(c); const body = clampStr(c.form.body, 4000); if (!body) throw HttpError(400, 'Réponse vide');
    if (!replyTicket(db, Number(c.params.id), body, 'admin')) throw HttpError(404, 'Ticket introuvable');
    redirect(c.res, `/admin/tickets/${Number(c.params.id)}`);
  });
  function prospectPage(c, { msg = '', demo = null, status = 200 } = {}) {
    const filter = PIPELINE[c.url.searchParams.get('statut')] ? c.url.searchParams.get('statut') : '';
    const dept = DEPARTEMENTS[c.url.searchParams.get('dept')] ? c.url.searchParams.get('dept') : '';
    const where = []; const args = [];
    if (filter) { where.push('status=?'); args.push(filter); } else where.push("status!='optout'");
    if (dept) { where.push('dept=?'); args.push(dept); }
    const list = db.all(`SELECT * FROM prospects WHERE ${where.join(' AND ')} ORDER BY potential DESC, score DESC, id DESC LIMIT 300`, ...args);
    const byDept = db.all("SELECT dept, COUNT(*) n, COALESCE(SUM(demo_views),0) v, SUM(status='converted') c FROM prospects WHERE dept!='' AND status!='optout' GROUP BY dept ORDER BY n DESC");
    html(c.res, V.adminProspects(csrfToken(c), { list, stats: prospectStats(db), filter, msg, demo, campaign: campaignStatus(db), byDept, dept, enrich: enrichStatus(db) }), status);
  }
  on('GET', '/admin/prospection', (c) => { requireAdmin(c); prospectPage(c); });
  on('POST', '/admin/prospection/recherche', async (c) => {
    requireAdmin(c); checkCsrf(c);
    try { const q = DEPARTEMENTS[c.form.departement] ? { tpl: c.form.tpl, departement: c.form.departement } : { tpl: c.form.tpl, commune: c.form.commune }; const found = await safeSearch(db, q); const added = importProspects(db, found); prospectPage(c, { msg: `${found.length} entreprise(s) trouvée(s), ${added} nouvelle(s) ajoutée(s).` }); }
    catch (e) { prospectPage(c, { msg: `Recherche impossible : ${e.message}`, status: 502 }); }
  });
  on('POST', '/admin/prospection/campagne', async (c) => {
    requireAdmin(c); checkCsrf(c);
    const r = await runNationalCampaign(db, { quota: 50, maxCalls: 25 });
    prospectPage(c, { msg: `Campagne nationale : ${r.added} nouvelle(s) entreprise(s) repérée(s) en ${r.calls} recherche(s)${r.stopped ? ` (${r.stopped})` : ''}. Aucun message envoyé.` });
  });
  on('POST', '/admin/prospection/reglages', (c) => {
    requireAdmin(c); checkCsrf(c);
    const daily = Math.max(0, Math.min(20000, Math.floor(Number(c.form.daily) || 0)));
    const cap = Math.max(0, Math.min(1000000, Math.floor(Number(c.form.cap) || 0)));
    db.run("INSERT INTO meta(k,v) VALUES('prospect_daily',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(daily));
    db.run("INSERT INTO meta(k,v) VALUES('enrich_monthly_credits',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(cap));
    audit(db, { action: 'prospect.reglages', detail: JSON.stringify({ daily, cap }), ip: c.ip });
    prospectPage(c, { msg: `Enregistré : ${daily} entreprises par jour, plafond de ${cap} crédits par mois pour les coordonnées.` });
  });
  on('POST', '/admin/prospection/enrichir', async (c) => {
    requireAdmin(c); checkCsrf(c);
    const r = await enrichBatch(db, { maxSearches: 5 });
    prospectPage(c, { msg: r.stopped === 'désactivé' ? 'Recherche de coordonnées arrêtée : ajoutez la clé Firecrawl et un plafond mensuel.' : `Coordonnées : ${r.matched} entreprise(s) complétée(s), ${r.emails} e-mail(s), ${r.credits} crédit(s) utilisés${r.stopped ? ` (${r.stopped})` : ''}. Aucun message envoyé.` });
  });
  // Export des messages à valider : rien n'est envoyé, le fichier sert à relire et à contacter à la main
  on('GET', '/admin/prospection/export.csv', (c) => {
    requireAdmin(c);
    const st = PIPELINE[c.url.searchParams.get('statut')] ? c.url.searchParams.get('statut') : 'new';
    const dept = DEPARTEMENTS[c.url.searchParams.get('dept')] ? c.url.searchParams.get('dept') : '';
    const rows = db.all(`SELECT * FROM prospects WHERE status=?${dept ? ' AND dept=?' : ''} ORDER BY (phone IS NOT NULL OR email IS NOT NULL) DESC, potential DESC, score DESC, id LIMIT 5000`, ...(dept ? [st, dept] : [st]));
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Entreprise', 'Métier', 'Ville', 'Département', 'Potentiel (0-100)', 'Pourquoi', 'SIREN', 'Téléphone', 'E-mail', 'Site', 'Source des coordonnées', 'Démo (non officielle)', "Lien d'opposition", 'Message proposé (NON ENVOYÉ)'];
    const lines = rows.map((p) => { const demoUrl = `${config.baseUrl}/demo/${demoTokenFor(p.siren)}`; const stop = optoutLink(db, p.id); return [displayName(p.name), TEMPLATES[p.tpl]?.label || p.naf, displayName(p.city), p.dept, p.potential, potentialOf(p).why.join(' ; '), p.siren, p.phone, p.email, p.website, p.contact_source, demoUrl, stop, outreachMessage(p, demoUrl, stop)].map(q).join(';'); });
    send(c.res, 200, '\ufeff' + [head.map(q).join(';'), ...lines].join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="prospects-${st}${dept ? '-' + dept : ''}.csv"` });
  });
  on('POST', '/admin/prospection/:id/demo', (c) => {
    requireAdmin(c); checkCsrf(c);
    const r = prepareDemo(db, Number(c.params.id)); const p = db.one('SELECT * FROM prospects WHERE id=?', Number(c.params.id));
    prospectPage(c, { demo: { name: p.name, url: r.demoUrl, message: outreachMessage(p, r.demoUrl, optoutLink(db, p.id)) } });
  });
  on('POST', '/admin/prospection/:id/contact', (c) => {
    requireAdmin(c); checkCsrf(c);
    try { logContact(db, Number(c.params.id), { outcome: c.form.outcome, channel: c.form.channel, note: c.form.note || '' }); } catch (e) { throw HttpError(400, e.message); }
    redirect(c.res, '/admin/prospection');
  });
  on('GET', '/admin/bilan/contacts.csv', (c) => {
    requireAdmin(c);
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = db.all('SELECT c.created_at, c.channel, c.outcome, c.note, p.name, p.tpl, p.dept, p.potential, p.phone FROM contacts c JOIN prospects p ON p.id=c.prospect_id ORDER BY c.id DESC LIMIT 20000');
    const lines = rows.map((r) => [new Date(r.created_at).toLocaleString('fr-FR', { timeZone: 'America/Cayenne' }), CONTACT_CHANNELS[r.channel] || r.channel, OUTCOMES[r.outcome]?.label || r.outcome, r.note, displayName(r.name), TEMPLATES[r.tpl]?.label || r.tpl, r.dept, r.potential, r.phone].map(q).join(';'));
    send(c.res, 200, '\ufeff' + [['Date (heure de Guyane)', 'Canal', 'Résultat', 'Note', 'Entreprise', 'Métier', 'Département', 'Potentiel', 'Téléphone'].map(q).join(';'), ...lines].join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="contacts.csv"' });
  });
  on('POST', '/admin/prospection/:id/statut', (c) => {
    requireAdmin(c); checkCsrf(c); if (!PIPELINE[c.form.status]) throw HttpError(400, 'Statut inconnu');
    if (c.form.status === 'optout') applyOptout(db, Number(c.params.id), 'opposition saisie par l’administrateur');
    else db.run('UPDATE prospects SET status=?, last_contact_at=? WHERE id=?', c.form.status, Date.now(), Number(c.params.id));
    redirect(c.res, '/admin/prospection');
  });

  // ---------- paiement : notifications Stripe ----------
  on('POST', '/webhooks/stripe', (c) => {
    if (!verifyStripeSignature(c.raw, c.req.headers['stripe-signature'])) { recordIncident(db, { kind: 'webhook', severity: 'warning', message: 'Notification Stripe refusée (signature invalide)' }); return json(c.res, { error: 'signature' }, 400); }
    let ev; try { ev = JSON.parse(c.raw); } catch { return json(c.res, { error: 'json' }, 400); }
    json(c.res, handleStripeEvent(db, ev));
  });

  // ---------- point d'entrée ----------
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    let path = url.pathname; let base;
    if (path.startsWith('/static/')) { if (!serveStatic(res, path.slice(8), req)) send(res, 404, 'Introuvable', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
    // Sous-domaine : garage-x.<ROOT_DOMAIN>/  =>  /s/garage-x/
    const host = String(req.headers.host || '').split(':')[0].toLowerCase();
    const mainHost = new URL(config.baseUrl).hostname;
    let siteSlug = null;
    if (config.rootDomain && host.endsWith('.' + config.rootDomain)) {
      const sub = host.slice(0, -config.rootDomain.length - 1);
      if (sub && !['www', 'app'].includes(sub) && !sub.includes('.')) siteSlug = sub;
    } else if (host && host !== mainHost && host !== config.rootDomain && host !== 'localhost' && host !== '127.0.0.1') {
      siteSlug = tenantByDomain(db, host)?.slug || null; // domaine propre d'une entreprise
    }
    if (siteSlug) { path = `/s/${siteSlug}${path === '/' ? '' : path}`; base = ''; }
    const cookies = parseCookies(req.headers.cookie);
    const session = readSession(db, cookies[SESSION]);
    const qLang = url.searchParams.get('lang');
    const lang = detectLang({ query: qLang, cookie: cookies.lang, accept: req.headers['accept-language'] });
    const c = { req, res, url, cookies, session, ip: clientIp(req), base, form: {}, raw: '', lang, setLang: (l) => { setLang(l); c.lang = currentLang(); } };
    const extra = [];
    if (!session) { c.pre = cookies[PRE] && /^[\w-]{20,}$/.test(cookies[PRE]) ? cookies[PRE] : randomId(18); if (c.pre !== cookies[PRE]) extra.push(cookie(PRE, c.pre, { maxAge: 86400 })); }
    if (qLang && LANGS[qLang] && qLang !== cookies.lang) extra.push(cookie('lang', qLang, { maxAge: 365 * 86400, httpOnly: false }));
    // Origine du visiteur (premier contact, 90 jours) : sert uniquement à mesurer les canaux d'acquisition, sans pistage tiers
    const newSrc = !siteSlug && method0(req) === 'GET' ? sourceFrom(url, path) : '';
    c.source = cookies.cdp_src && /^[\w:.-]{1,60}$/.test(cookies.cdp_src) ? cookies.cdp_src : newSrc;
    if (newSrc && !cookies.cdp_src) extra.push(cookie('cdp_src', newSrc, { maxAge: 90 * 86400 }));
    if (newSrc && (path === '/' || path.startsWith('/metiers/'))) countVisit(db, newSrc);
    if (extra.length) { const orig = res.writeHead.bind(res); res.writeHead = (st, h = {}) => { const sc = h['Set-Cookie']; h['Set-Cookie'] = [...extra, ...(sc ? [].concat(sc) : [])]; return orig(st, h); }; }
    return withLang(lang, async () => {
    try {
      const method = req.method === 'HEAD' ? 'GET' : req.method;
      let found = null, methodMismatch = false;
      for (const r of routes) { const m = r.re.exec(path); if (!m) continue; if (r.method !== method) { methodMismatch = true; continue; } found = r; c.params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)])); break; }
      if (!found) throw HttpError(methodMismatch ? 405 : 404, methodMismatch ? 'Méthode non autorisée' : 'Page introuvable');
      if (method === 'POST') { c.raw = await readBody(req); c.form = parseForm(c.raw, String(req.headers['content-type'] || '')); }
      await found.handler(c);
    } catch (e) {
      if (res.headersSent) return;
      if (e.redirect) return redirect(res, e.redirect);
      const status = e.status || 500;
      if (status >= 500 && status !== 503) { recordIncident(db, { kind: 'http', severity: 'critical', message: `${req.method} ${path} : ${String(e.message).slice(0, 160)}` }); if (config.env !== 'test') console.error(e); }
      const msg = tr(status >= 500 && status !== 503 && status !== 502 ? 'Une erreur est survenue. Elle a été signalée automatiquement.' : e.message);
      const wantsJson = String(req.headers.accept || '').includes('application/json') || String(req.headers['content-type'] || '').includes('application/json');
      if (wantsJson) json(res, { ok: false, msg }, status); else html(res, V.messagePage(status === 404 ? 'Page introuvable' : 'Oups', msg, ['Accueil', '/']), status);
    }
    });
  };
}
