// Routeur HTTP de ClientDirect Pro. Aucune dépendance externe.
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
import { billingConfigured, createCheckout, createPortal, verifyStripeSignature, handleStripeEvent } from './billing.js';
import { safeSearch, importProspects, prepareDemo, outreachMessage, demoTenantByToken, recordDemoView, prospectStats, PIPELINE } from './prospect.js';
import { supportAnswer, openTicket, replyTicket } from './support.js';
import { recordIncident, openIncidents, resolveIncident } from './incidents.js';
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

export function createApp(db) {
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
    c.user = { id: c.session.user_id, email: c.session.email, name: c.session.name, email_verified: c.session.email_verified };
  }
  function requireAdmin(c) {
    if (!c.session || c.session.role !== 'superadmin') throw Object.assign(new Error('auth'), { redirect: '/connexion' });
    if (!c.session.totp_ok) throw Object.assign(new Error('2fa'), { redirect: '/connexion/2fa' });
  }
  const proEmail = (t) => db.one('SELECT email FROM users WHERE id=?', t.owner_user_id)?.email || t.email;
  const notifyPro = (t, kind, summary) => enqueue(db, { tenantId: t.id, channel: 'email', to: proEmail(t), template: 'pro_new_request', payload: { kind, tenant: t.name, summary, dashUrl: `${config.baseUrl}/pro` } });

  // ---------- site public ClientDirect Pro ----------
  on('GET', '/', (c) => html(c.res, V.marketing({ csrf: csrfToken(c) })));
  on('GET', '/robots.txt', (c) => send(c.res, 200, robots(`${config.baseUrl}/sitemap.xml`, { allow: config.isProd }), { 'Content-Type': 'text/plain; charset=utf-8' }));
  on('GET', '/sitemap.xml', (c) => {
    // Seules les adresses du même domaine sont acceptées par Google dans un sitemap ; les domaines propres ont le leur.
    const own = publicTenants(db).filter((t) => !(t.custom_domain && t.domain_status === 'verified'));
    const entries = [{ loc: `${config.baseUrl}/`, lastmod: Date.now() }, { loc: `${config.baseUrl}/annuaire`, lastmod: Date.now() }];
    if (!config.rootDomain) for (const t of own) entries.push({ loc: `${config.baseUrl}/s/${t.slug}`, lastmod: t.updated_at || t.created_at });
    send(c.res, 200, sitemap(entries), { 'Content-Type': 'application/xml; charset=utf-8' });
  });
  on('GET', '/annuaire', (c) => html(c.res, V.directoryPage(publicTenants(db), (t) => siteUrl({ ...t, services: [] }))));
  for (const k of ['cgu', 'confidentialite', 'mentions-legales']) on('GET', `/${k}`, (c) => html(c.res, V.legalPage(k)));
  on('GET', '/stop/:token', (c) => html(c.res, V.layout('Ne plus être contacté', `<main class="auth"><h1>Ne plus être contacté</h1><form method="post" class="card"><input type="hidden" name="csrf" value="${csrfToken(c)}"><p>Confirmez-vous ne plus vouloir recevoir de message de ClientDirect Pro ? La démonstration préparée pour votre entreprise sera supprimée.</p><button class="btn red wide" type="submit">Oui, ne plus me contacter</button></form></main>`)));
  on('POST', '/stop/:token', (c) => {
    checkCsrf(c); limit(c, 'stop', 20, 3600e3);
    const p = optout(db, c.params.token);
    if (p) audit(db, { action: 'prospect.opposition', detail: String(p.id), ip: c.ip });
    html(c.res, V.messagePage('C’est noté', 'Vous ne serez plus contacté par ClientDirect Pro et la démonstration a été supprimée. Merci et bonne continuation.'));
  });
  // Santé : utilisé par Render et par un service de surveillance externe (UptimeRobot, gratuit). 503 si les tâches automatiques sont bloquées.
  on('GET', '/health', (c) => {
    db.one('SELECT 1 x');
    const hb = Number(db.one("SELECT v FROM meta WHERE k='jobs_heartbeat'")?.v || 0);
    const jobsOk = config.disableJobs || !hb || Date.now() - hb < 15 * 60e3;
    json(c.res, { ok: jobsOk, env: config.appEnv, jobs: hb ? new Date(hb).toISOString() : null, time: new Date().toISOString() }, jobsOk ? 200 : 503);
  });

  // ---------- inscription ----------
  on('GET', '/inscription', (c) => {
    const claim = c.url.searchParams.get('claim'); const demo = claim ? demoTenantByToken(db, claim) : null;
    if (claim && !demo) return html(c.res, V.messagePage('Lien expiré', 'Cette démonstration a déjà été activée ou n’existe plus.', ['Créer un site', '/inscription']), 404);
    const plan = c.url.searchParams.get('formule');
    html(c.res, V.signupPage({ csrf: csrfToken(c), f: { plan: PLANS[plan] ? plan : 'pro', tpl: demo?.tpl }, claim: demo ? claim : null, demo }));
  });
  on('POST', '/inscription', (c) => {
    checkCsrf(c); limit(c, 'signup', 10, 3600e3);
    const f = c.form; const errors = [];
    const demo = f.claim ? demoTenantByToken(db, f.claim) : null;
    if (f.claim && !demo) errors.push('Cette démonstration a déjà été activée.');
    const email = clampStr(f.email, 190).toLowerCase(); const name = clampStr(f.name, 80);
    if (!demo) { if (!clampStr(f.business, 80)) errors.push("Indiquez le nom de l'entreprise."); if (!TEMPLATES[f.tpl]) errors.push('Choisissez un métier.'); }
    if (!name) errors.push('Indiquez votre nom.');
    if (!emailOk(email)) errors.push('Adresse e-mail invalide.');
    const pw = passwordProblem(f.password); if (pw) errors.push(pw);
    if (f.cgu !== 'on') errors.push("Vous devez accepter les conditions d'utilisation.");
    if (!PLANS[f.plan]) errors.push('Formule inconnue.');
    if (emailOk(email) && db.one('SELECT 1 FROM users WHERE email=?', email)) errors.push('Un compte existe déjà avec cette adresse. Connectez-vous.');
    if (errors.length) return html(c.res, V.signupPage({ csrf: csrfToken(c), f, errors, claim: demo ? f.claim : null, demo }), 400);
    const now = Date.now();
    const userId = Number(db.run('INSERT INTO users(email,pass_hash,name,role,created_at) VALUES(?,?,?,?,?)', email, hashPassword(f.password), name, 'pro', now).lastInsertRowid);
    let tenantId;
    if (demo) {
      db.tx(() => {
        db.run("UPDATE tenants SET status='trial', trial_ends_at=?, owner_user_id=?, email=?, plan=?, demo_token_hash=NULL WHERE id=? AND status='demo'", now + config.trialDays * 864e5, userId, email, f.plan, demo.id);
        db.run('INSERT INTO memberships(user_id,tenant_id,role) VALUES(?,?,?)', userId, demo.id, 'owner');
        if (demo.prospect_id) db.run("UPDATE prospects SET status='converted' WHERE id=?", demo.prospect_id);
      });
      tenantId = demo.id;
    } else {
      tenantId = createTenant(db, { name: f.business, tpl: f.tpl, city: f.city, phone: f.phone, email, tz: f.tz, plan: f.plan, status: 'trial', ownerId: userId }).id;
    }
    const t = loadTenant(db, 'id', tenantId);
    const vt = issueToken(db, 'verify', { userId, hours: 48 });
    enqueue(db, { tenantId, channel: 'email', to: email, template: 'verify_email', payload: { url: `${config.baseUrl}/verifier/${vt}` } });
    enqueue(db, { tenantId, channel: 'email', to: email, template: 'welcome', payload: { tenant: t.name, siteUrl: `${config.baseUrl}/s/${t.slug}`, dashUrl: `${config.baseUrl}/pro`, trialEnd: new Date(t.trial_ends_at).toLocaleDateString('fr-FR') } });
    audit(db, { userId, tenantId, action: demo ? 'inscription.demo' : 'inscription', ip: c.ip });
    emit(db, 'inscription', { entreprise: t.name, metier: t.metier, ville: t.city, formule: t.plan, email, nom: name, depuis_demo: !!demo, site: `${config.baseUrl}/s/${t.slug}` }, tenantId);
    const s = createSession(db, userId);
    redirect(c.res, '/pro?bienvenue=1', { 'Set-Cookie': cookie(SESSION, s.token, { maxAge: 30 * 86400 }) });
  });

  // ---------- connexion ----------
  on('GET', '/connexion', (c) => html(c.res, V.loginPage({ csrf: csrfToken(c), info: c.url.searchParams.get('ok') === 'mdp' ? 'Mot de passe modifié. Connectez-vous.' : '' })));
  on('POST', '/connexion', (c) => {
    checkCsrf(c); limit(c, 'login', 20, 15 * 60e3);
    const email = clampStr(c.form.email, 190).toLowerCase();
    if (!rateLimit(`login-mail:${email}`, 10, 15 * 60e3)) throw HttpError(429, 'Trop de tentatives pour ce compte. Patientez 15 minutes.');
    const r = login(db, email, c.form.password);
    if (!r.ok) { audit(db, { action: 'connexion.echec', detail: email, ip: c.ip }); return html(c.res, V.loginPage({ csrf: csrfToken(c), email, error: r.locked ? 'Compte verrouillé 15 minutes après plusieurs échecs.' : 'E-mail ou mot de passe incorrect.' }), 401); }
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
    if (!totpOk(c.session.totp_secret, c.form.code)) { audit(db, { userId: c.session.user_id, action: '2fa.echec', ip: c.ip }); return html(c.res, V.totpPage({ csrf: csrfToken(c), error: 'Code incorrect.' }), 401); }
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
    const u = db.one('SELECT id,email FROM users WHERE email=?', clampStr(c.form.email, 190).toLowerCase());
    if (u) { const t = issueToken(db, 'reset', { userId: u.id, hours: 2 }); enqueue(db, { channel: 'email', to: u.email, template: 'reset_password', payload: { url: `${config.baseUrl}/reinitialiser/${t}` } }); }
    html(c.res, V.forgotPage({ csrf: csrfToken(c), sent: true }));
  });
  on('GET', '/reinitialiser/:token', (c) => {
    if (!useToken(db, 'reset', c.params.token, { consume: false })) return html(c.res, V.messagePage('Lien expiré', 'Demandez un nouveau lien.', ['Mot de passe oublié', '/mot-de-passe-oublie']), 400);
    html(c.res, V.resetPage({ csrf: csrfToken(c), token: c.params.token }));
  });
  on('POST', '/reinitialiser/:token', (c) => {
    checkCsrf(c);
    const p = passwordProblem(c.form.password);
    if (p) return html(c.res, V.resetPage({ csrf: csrfToken(c), token: c.params.token, error: p }), 400);
    const tk = useToken(db, 'reset', c.params.token);
    if (!tk) return html(c.res, V.messagePage('Lien expiré', 'Demandez un nouveau lien.', ['Mot de passe oublié', '/mot-de-passe-oublie']), 400);
    db.run('UPDATE users SET pass_hash=?, failed_logins=0, locked_until=0 WHERE id=?', hashPassword(c.form.password), tk.user_id);
    destroyUserSessions(db, tk.user_id); audit(db, { userId: tk.user_id, action: 'mdp.reinitialise', ip: c.ip });
    redirect(c.res, '/connexion?ok=mdp', { 'Set-Cookie': cookie(SESSION, '', { maxAge: 0 }) });
  });

  // ---------- annulation par le client ----------
  on('GET', '/annuler/:token', (c) => html(c.res, V.layout('Annuler mon rendez-vous', `<main class="auth"><h1>Annuler mon rendez-vous</h1><form method="post" class="card"><input type="hidden" name="csrf" value="${csrfToken(c)}"><p>Voulez-vous vraiment annuler ce rendez-vous ?</p><button class="btn red wide" type="submit">Oui, annuler</button></form></main>`)));
  on('POST', '/annuler/:token', (c) => {
    checkCsrf(c); limit(c, 'cancel', 20, 3600e3);
    const r = cancelByCustomer(db, c.params.token);
    if (r.late) return html(c.res, V.messagePage('Trop tard pour annuler en ligne', 'Le rendez-vous a lieu dans moins de 2 heures : contactez directement le professionnel.'), 400);
    if (!r.ok) return html(c.res, V.messagePage('Lien expiré', 'Ce rendez-vous est déjà annulé ou n’existe pas.'), 404);
    const t = loadTenant(db, 'id', r.appt.tenant_id);
    notifyPro(t, 'annulation', `${r.appt.customer_name} a annulé son rendez-vous du ${r.appt.date} à ${r.appt.time} (${r.appt.service_name}).`);
    html(c.res, V.messagePage('Rendez-vous annulé', `Votre rendez-vous chez ${t.name} est annulé. Le professionnel est prévenu.`));
  });

  // ---------- sites des entreprises ----------
  const firstSvc = (t) => t.services[0]?.id || null;
  function renderSite(c, t, base, mode, demoClaim = null) {
    if (mode === 'live' && !isBot(c.req.headers['user-agent'])) track(db, t, 'views');
    html(c.res, V.tenantSite(t, { base, mode, days: openDays(db, t, 10, firstSvc(t)), aiMode: mode === 'live' && aiAvailable(t) ? 'ia' : 'simple', demoClaim, head: siteHead(t, { mode }) }));
  }
  function liveTenant(slug) {
    const t = loadTenant(db, 'slug', slug);
    if (!t || t.status === 'demo') throw HttpError(404, 'Site introuvable.');
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
      if (demo) return json(c.res, { ok: true, demo: true, msg: 'Démonstration : sur le site activé, ce créneau serait réservé et le professionnel prévenu. Rien n’a été enregistré.' });
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
      if (demo) return json(c.res, { ok: true, demo: true, msg: 'Démonstration : sur le site activé, cette demande arriverait dans l’espace du professionnel. Rien n’a été enregistré.' });
      const r = createQuote(db, t, c.form);
      if (!r.ok) return json(c.res, r, 400);
      notifyPro(t, 'demande de devis', `${clampStr(c.form.name, 80)} (+${intlPhone(c.form.phone, t.cc)}) · ${clampStr(c.form.service, 80)} · ${clampStr(c.form.message, 300)}`);
      emit(db, 'devis', { entreprise: t.name, client: clampStr(c.form.name, 80), telephone: '+' + intlPhone(c.form.phone, t.cc), prestation: clampStr(c.form.service, 80), message: clampStr(c.form.message, 500) }, t.id);
      json(c.res, { ok: true, msg: `Demande envoyée à ${t.name}. Vous serez recontacté rapidement.` });
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
    const t = liveTenant(c.params.slug); if (siteState(t) !== 'live') throw HttpError(503, 'Site indisponible');
    return { t, demo: false };
  });
  const demoResolve = (c) => {
    if (!sameOrigin(c.req)) throw HttpError(403, 'Origine refusée');
    const row = demoTenantByToken(db, c.params.token); if (!row) throw HttpError(404, 'Démonstration introuvable');
    return { t: loadTenant(db, 'id', row.id), demo: true };
  };
  on('GET', '/demo/:token', (c) => {
    const row = demoTenantByToken(db, c.params.token);
    if (!row) return html(c.res, V.messagePage('Démonstration terminée', 'Ce site a été activé ou la démonstration n’existe plus.', ['Découvrir ClientDirect Pro', '/']), 404);
    recordDemoView(db, row);
    if (row.prospect_id) emit(db, 'demo_vue', { entreprise: row.name, prospect_id: row.prospect_id, vues: db.one('SELECT demo_views FROM prospects WHERE id=?', row.prospect_id)?.demo_views || 0 }, row.id);
    renderSite(c, loadTenant(db, 'id', row.id), `/demo/${c.params.token}`, 'demo', c.params.token);
  });
  siteApi('/demo/:token', demoResolve);

  // ---------- espace professionnel ----------
  const msgFrom = (c) => ({ bienvenue: 'Votre site est en ligne ! Vérifiez vos prestations et horaires dans Réglages.', ok: 'Modification enregistrée.' })[c.url.searchParams.get('bienvenue') ? 'bienvenue' : c.url.searchParams.get('m')] || '';
  on('GET', '/pro', (c) => {
    requirePro(c); const t = c.tenant; const today = nowIn(t.tz).date;
    const appts = db.all("SELECT * FROM appointments WHERE tenant_id=? AND date>=? AND status IN ('pending','confirmed') ORDER BY date, time LIMIT 200", t.id, today);
    const quotes = db.all("SELECT * FROM quotes WHERE tenant_id=? ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, id DESC LIMIT 50", t.id);
    const stats = { pending: appts.filter((a) => a.status === 'pending').length, upcoming: appts.length, quotes: quotes.filter((q) => q.status === 'new').length, revenue: appts.filter((a) => a.status === 'confirmed').reduce((s, a) => s + a.price, 0) };
    html(c.res, V.proDashboard(t, c.user, csrfToken(c), { appts, quotes, stats, msg: msgFrom(c), perf: last30(db, t), curve: daily(db, t, 30) }));
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
    settingsPage(c, r.ok ? { domainMsg: r.msg } : { errors: [r.msg] }, r.ok ? 200 : 400);
  });
  on('GET', '/pro/donnees/export', (c) => {
    requirePro(c); audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'export', ip: c.ip });
    send(c.res, 200, JSON.stringify(exportTenant(db, c.tenant.id, c.user.id), null, 2), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="clientdirect-${c.tenant.slug}.json"`, 'Cache-Control': 'no-store' });
  });
  on('POST', '/pro/compte/supprimer', (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'delete', 5, 3600e3);
    const u = db.one('SELECT pass_hash FROM users WHERE id=?', c.user.id);
    if (!verifyPassword(c.form.password || '', u.pass_hash)) return settingsPage(c, { errors: ['Mot de passe incorrect : compte non supprimé.'] }, 400);
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
    html(c.res, V.proBilling(c.tenant, c.user, csrfToken(c), { configured: billingConfigured(), msg, invoices: db.all('SELECT * FROM invoices WHERE tenant_id=? ORDER BY id DESC LIMIT 24', c.tenant.id) }));
  });
  on('POST', '/pro/abonnement/checkout', async (c) => {
    requirePro(c); checkCsrf(c);
    if (!billingConfigured()) throw HttpError(503, 'Le paiement en ligne n’est pas encore activé.');
    const url = await createCheckout(c.tenant, c.user.email, c.form.plan);
    audit(db, { userId: c.user.id, tenantId: c.tenant.id, action: 'checkout', detail: c.form.plan, ip: c.ip });
    redirect(c.res, url);
  });
  on('POST', '/pro/abonnement/portail', async (c) => { requirePro(c); checkCsrf(c); redirect(c.res, await createPortal(c.tenant)); });
  const proTickets = (c) => db.all('SELECT * FROM tickets WHERE tenant_id=? ORDER BY id DESC LIMIT 20', c.tenant.id).map((tk) => ({ ...tk, messages: db.all('SELECT * FROM ticket_messages WHERE ticket_id=? ORDER BY id', tk.id) }));
  on('GET', '/pro/aide', (c) => { requirePro(c); html(c.res, V.proHelp(c.tenant, c.user, csrfToken(c), { tickets: proTickets(c), msg: c.url.searchParams.get('m') === 'ticket' ? 'Ticket envoyé. Nous vous répondons par e-mail.' : '' })); });
  on('POST', '/pro/aide/question', async (c) => {
    requirePro(c); checkCsrf(c); limit(c, 'support', 30, 3600e3);
    const q = clampStr(c.form.q, 800); const a = q ? await supportAnswer(q) : null;
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
    const list = filter ? db.all('SELECT * FROM prospects WHERE status=? ORDER BY score DESC, id DESC LIMIT 300', filter) : db.all("SELECT * FROM prospects WHERE status!='optout' ORDER BY score DESC, id DESC LIMIT 300");
    html(c.res, V.adminProspects(csrfToken(c), { list, stats: prospectStats(db), filter, msg, demo }), status);
  }
  on('GET', '/admin/prospection', (c) => { requireAdmin(c); prospectPage(c); });
  on('POST', '/admin/prospection/recherche', async (c) => {
    requireAdmin(c); checkCsrf(c);
    try { const found = await safeSearch(db, { tpl: c.form.tpl, commune: c.form.commune }); const added = importProspects(db, found); prospectPage(c, { msg: `${found.length} entreprise(s) trouvée(s), ${added} nouvelle(s) ajoutée(s).` }); }
    catch (e) { prospectPage(c, { msg: `Recherche impossible : ${e.message}`, status: 502 }); }
  });
  on('POST', '/admin/prospection/:id/demo', (c) => {
    requireAdmin(c); checkCsrf(c);
    const r = prepareDemo(db, Number(c.params.id)); const p = db.one('SELECT * FROM prospects WHERE id=?', Number(c.params.id));
    prospectPage(c, { demo: { name: p.name, url: r.demoUrl, message: outreachMessage(p, r.demoUrl, optoutLink(db, p.id)) } });
  });
  on('POST', '/admin/prospection/:id/statut', (c) => {
    requireAdmin(c); checkCsrf(c); if (!PIPELINE[c.form.status]) throw HttpError(400, 'Statut inconnu');
    db.run('UPDATE prospects SET status=?, last_contact_at=? WHERE id=?', c.form.status, Date.now(), Number(c.params.id));
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
    if (path.startsWith('/static/')) { if (!serveStatic(res, path.slice(8))) send(res, 404, 'Introuvable', { 'Content-Type': 'text/plain; charset=utf-8' }); return; }
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
    const c = { req, res, url, cookies, session, ip: clientIp(req), base, form: {}, raw: '' };
    const extra = [];
    if (!session) { c.pre = cookies[PRE] && /^[\w-]{20,}$/.test(cookies[PRE]) ? cookies[PRE] : randomId(18); if (c.pre !== cookies[PRE]) extra.push(cookie(PRE, c.pre, { maxAge: 86400 })); }
    if (extra.length) { const orig = res.writeHead.bind(res); res.writeHead = (st, h = {}) => { const sc = h['Set-Cookie']; h['Set-Cookie'] = [...extra, ...(sc ? [].concat(sc) : [])]; return orig(st, h); }; }
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
      const msg = status >= 500 && status !== 503 && status !== 502 ? 'Une erreur est survenue. Elle a été signalée automatiquement.' : e.message;
      const wantsJson = String(req.headers.accept || '').includes('application/json') || String(req.headers['content-type'] || '').includes('application/json');
      if (wantsJson) json(res, { ok: false, msg }, status); else html(res, V.messagePage(status === 404 ? 'Page introuvable' : 'Oups', msg, ['Accueil', '/']), status);
    }
  };
}
