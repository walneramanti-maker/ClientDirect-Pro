// Autotest de bout en bout des 3 formules, en conditions réelles mais en MODE TEST Stripe uniquement :
// inscription par l'adresse publique (comme un visiteur), site professionnel créé et affiché, page de paiement
// Stripe générée, puis paiement test (carte de test Stripe « pm_card_visa ») et réception du webhook.
// Ne s'exécute jamais avec une clé Stripe réelle ni en production. Les abonnements de test sont résiliés ensuite.
import { config, PLANS } from './config.js';
import { net } from './net.js';
import { stripe, isTestKey, priceIds } from './billing.js';

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function jar() {
  const cookies = new Map();
  const store = (res) => { for (const c of res.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1)); } };
  const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const req = async (path, opt = {}) => {
    const res = await net.fetch(config.baseUrl + path, { ...opt, redirect: 'manual', signal: AbortSignal.timeout(45000), headers: { cookie: header(), 'user-agent': 'ClientDirectPro-autotest', ...(opt.headers || {}) } });
    store(res); return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  };
  const csrf = (html) => (/name="csrf" value="([^"]+)"/.exec(html) || [])[1];
  const post = (path, form) => req(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
  return { req, post, csrf };
}

export function selfTestAllowed() { return isTestKey() && !config.isProd; }

/** Parcours complet pour une formule. Renvoie un compte rendu étape par étape. */
async function onePlan(db, plan, stamp) {
  const steps = []; const ok = (name, detail = '') => steps.push({ etape: name, ok: true, detail }); const fail = (name, detail) => { steps.push({ etape: name, ok: false, detail }); throw new Error(`${name} : ${detail}`); };
  const c = jar(); const email = `autotest+${plan}-${stamp}@clientdirect-pro.invalid`; const business = `Autotest ${PLANS[plan].name} ${stamp}`;
  let tenant = null;
  try {
    const page = await c.req(`/inscription?formule=${plan}&tpl=garage`);
    if (page.status !== 200 || !c.csrf(page.text)) fail('Page d’inscription', `HTTP ${page.status}`); ok('Page d’inscription', 'affichée');
    const r = await c.post('/inscription', { csrf: c.csrf(page.text), business, tpl: 'garage', city: 'Cayenne', country: 'GF', phone: '+594594000000', name: 'Autotest', email, password: `Autotest-${stamp}-Mdp!`, cgu: 'on', plan, lang: 'fr' });
    if (r.status !== 303 || !/^\/pro/.test(r.location || '')) fail('Inscription', `HTTP ${r.status} ${(r.text.match(/class="err[^>]*>([^<]+)/) || [])[1] || ''}`.trim());
    tenant = db.one('SELECT t.* FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email=?', email);
    if (!tenant || tenant.status !== 'trial' || tenant.plan !== plan) fail('Compte créé', JSON.stringify({ status: tenant?.status, plan: tenant?.plan }));
    db.run("UPDATE tenants SET source='autotest' WHERE id=?", tenant.id);
    ok('Inscription', `essai gratuit, formule ${PLANS[plan].name}`);
    const dash = await c.req('/pro'); if (dash.status !== 200) fail('Espace pro', `HTTP ${dash.status}`); ok('Espace pro', 'accessible');
    const site = await c.req(`/s/${tenant.slug}`);
    if (site.status !== 200 || !site.text.includes(business)) fail('Site professionnel', `HTTP ${site.status}`);
    const hasRdv = site.text.includes('id="rdv"'); const wantRdv = PLANS[plan].features.includes('rdv');
    if (hasRdv !== wantRdv) fail('Fonctions de la formule', `prise de rendez-vous ${hasRdv ? 'présente' : 'absente'} (attendu : ${wantRdv ? 'présente' : 'absente'})`);
    if (!site.text.includes('id="devis"')) fail('Fonctions de la formule', 'formulaire de devis absent');
    ok('Site professionnel', `en ligne, devis ✓, rendez-vous ${hasRdv ? '✓' : '— (non inclus)'}`);
    const bill = await c.req('/pro/abonnement'); const tok = c.csrf(bill.text);
    const co = await c.post('/pro/abonnement/checkout', { csrf: tok, plan });
    if (co.status !== 303 || !/^https:\/\/checkout\.stripe\.com\//.test(co.location || '')) fail('Page de paiement Stripe', `HTTP ${co.status} ${co.location || co.text.slice(0, 120)}`);
    ok('Page de paiement Stripe', 'générée (mode test)');
    // Paiement test : carte Visa de test Stripe, puis abonnement (mensualité + mise en service), comme après la page de paiement
    const P = priceIds(plan, 'EUR');
    const cus = await stripe('customers', { email, name: business, metadata: { tenant_id: tenant.id, autotest: '1' } });
    await stripe('payment_methods/pm_card_visa/attach', { customer: cus.id }).then((pm) => stripe(`customers/${cus.id}`, { invoice_settings: { default_payment_method: pm.id } }));
    db.run('UPDATE tenants SET stripe_customer=? WHERE id=?', cus.id, tenant.id);
    const sub = await stripe('subscriptions', { customer: cus.id, items: { 0: { price: P.month } }, ...(P.setup ? { add_invoice_items: { 0: { price: P.setup } } } : {}), metadata: { tenant_id: tenant.id, plan, autotest: '1' }, payment_behavior: 'error_if_incomplete', expand: { 0: 'latest_invoice' } });
    const inv = sub.latest_invoice || {};
    const expected = (PLANS[plan].monthly + PLANS[plan].setup) * 100;
    if (sub.status !== 'active' || inv.status !== 'paid') fail('Paiement test', `abonnement ${sub.status}, facture ${inv.status}`);
    ok('Paiement test', `${(inv.amount_paid / 100).toFixed(2)} € HT payés (attendu ${(expected / 100).toFixed(2)} €)${inv.amount_paid === expected ? '' : ' ⚠️ montant différent'}`);
    // Webhook : Stripe prévient le serveur, qui active l'abonnement et enregistre la facture
    let got = null;
    for (let i = 0; i < 30 && !got; i++) { await sleep(2000); got = db.one("SELECT i.amount_cents, t.status, t.plan FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE i.stripe_invoice=? AND i.status='paid'", inv.id); }
    if (!got) fail('Webhook Stripe', 'facture non reçue après 60 s');
    if (got.status !== 'active' || got.plan !== plan) fail('Abonnement activé', JSON.stringify(got));
    ok('Webhook Stripe et activation', `facture enregistrée, compte actif en ${PLANS[plan].name}`);
    // Nettoyage : résiliation immédiate de l'abonnement de test
    await stripe(`subscriptions/${sub.id}`, {}, 'DELETE').catch(() => null);
    ok('Nettoyage', 'abonnement de test résilié');
    return { formule: PLANS[plan].name, ok: true, etapes: steps };
  } catch (e) {
    if (!steps.length || steps[steps.length - 1].ok) steps.push({ etape: 'Erreur', ok: false, detail: String(e.message).slice(0, 200) });
    return { formule: PLANS[plan].name, ok: false, etapes: steps };
  } finally {
    // Les comptes de test sont retirés des statistiques commerciales
    if (tenant) db.run("UPDATE tenants SET source='autotest', status=CASE WHEN status='demo' THEN status ELSE 'canceled' END WHERE id=?", tenant.id);
  }
}

export async function runSelfTest(db, { plans = ['essentiel', 'pro', 'premium'] } = {}) {
  if (!selfTestAllowed()) return { ok: false, refuse: 'Autotest réservé au mode test Stripe hors production' };
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
  const out = []; for (const p of plans) out.push(await onePlan(db, p, stamp));
  const r = { at: new Date().toISOString(), ok: out.every((x) => x.ok), formules: out };
  db.run("INSERT INTO meta(k,v) VALUES('autotest_last',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(r));
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.autotest',?,?)", JSON.stringify({ ok: r.ok }), Date.now());
  return r;
}
