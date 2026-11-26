import crypto from 'node:crypto';
import { onInvoicePaid, onRefund } from './rewards.js';
import { config, PLANS } from './config.js';
import { net } from './net.js';
import { safeEq } from './util.js';
import { money } from './markets.js';
import { enqueue, emit } from './notify.js';
import { recordIncident } from './incidents.js';
import { audit } from './security.js';

export const billingConfigured = () => !!config.stripeKey;

function form(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out.join('&');
}
/** Appel à l'API Stripe (utilisé aussi pour appliquer les mois offerts). */
export async function stripe(path, params, method = 'POST') {
  const q = method === 'GET' && params ? `?${form(params)}` : '';
  const res = await net.fetch(`https://api.stripe.com/v1/${path}${q}`, { method, headers: { authorization: `Bearer ${config.stripeKey}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}), 'stripe-version': '2024-06-20' }, body: method === 'POST' ? form(params) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${j.error?.message || 'erreur'}`);
  return j;
}

// ---------- configuration automatique de Stripe (produits, prix par devise, webhook) ----------
let metaDb = null; // base utilisée pour retrouver les identifiants créés automatiquement
const meta = (k) => metaDb?.one('SELECT v FROM meta WHERE k=?', k)?.v || null;
const setMeta = (db, k, v) => db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);
export const isTestKey = (k = config.stripeKey) => /^(sk|rk)_test_/.test(k);
const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'charge.refunded'];
/**
 * Crée dans Stripe, s'ils n'existent pas, les produits et les prix de chaque formule dans chaque devise,
 * et le point de réception des notifications (webhook). Idempotent : relancé à chaque démarrage.
 * Par sécurité, ne s'exécute qu'avec une clé de TEST, sauf si STRIPE_AUTOSETUP=live est défini explicitement.
 */
export async function ensureStripe(db, { currencies = (process.env.STRIPE_CURRENCIES || 'EUR,USD,CAD,GBP').split(',') } = {}) {
  metaDb = db;
  if (!config.stripeKey) return { skipped: 'Pas de clé Stripe' };
  if (!isTestKey() && process.env.STRIPE_AUTOSETUP !== 'live') return { skipped: 'Clé réelle : configuration automatique désactivée' };
  const { PRICES } = await import('./markets.js');
  const out = { created: 0, existing: 0, webhook: null };
  const products = {};
  for (const plan of Object.keys(PLANS)) {
    for (const cur of currencies.filter((c) => PRICES[c])) {
      for (const kind of ['month', 'setup']) {
        const key = `cdp_${plan}_${kind}_${cur.toLowerCase()}`;
        if (meta(`stripe_price_${key}`)) { out.existing++; continue; }
        const found = (await stripe('prices', { lookup_keys: { 0: key }, active: 'true', limit: 1 }, 'GET')).data?.[0];
        if (found) { setMeta(db, `stripe_price_${key}`, found.id); out.existing++; continue; }
        if (!products[plan]) {
          const ex = (await stripe('products/search', { query: `metadata['cdp_plan']:'${plan}'` }, 'GET').catch(() => ({ data: [] }))).data?.[0];
          products[plan] = ex?.id || (await stripe('products', { name: `ClientDirect Pro ${PLANS[plan].name}`, metadata: { cdp_plan: plan } })).id;
        }
        const amount = PRICES[cur][plan][kind === 'month' ? 0 : 1] * 100;
        const p = await stripe('prices', { product: products[plan], currency: cur.toLowerCase(), unit_amount: amount, lookup_key: key, nickname: `${PLANS[plan].name} ${kind === 'month' ? 'mensuel' : 'mise en service'} ${cur}`, tax_behavior: 'exclusive', ...(kind === 'month' ? { recurring: { interval: 'month' } } : {}), metadata: { cdp_plan: plan, cdp_kind: kind } });
        setMeta(db, `stripe_price_${key}`, p.id); out.created++;
      }
    }
  }
  const url = `${config.baseUrl}/webhooks/stripe`;
  if (!config.stripeWebhookSecret && !meta('stripe_webhook_secret') && url.startsWith('https://')) {
    const list = (await stripe('webhook_endpoints', { limit: 100 }, 'GET')).data || [];
    const mine = list.filter((w) => w.url === url);
    // Stripe ne redonne jamais le secret d'un webhook existant. En mode test, on remplace donc le webhook dont le secret
    // a été perdu ; en mode réel, on ne touche à rien et on demande le secret (STRIPE_WEBHOOK_SECRET).
    if (mine.length && config.stripeKey.startsWith('sk_test_')) { for (const w of mine) await stripe(`webhook_endpoints/${w.id}`, null, 'DELETE'); }
    if (!mine.length || config.stripeKey.startsWith('sk_test_')) {
      const w = await stripe('webhook_endpoints', { url, enabled_events: Object.fromEntries(WEBHOOK_EVENTS.map((e, i) => [i, e])), description: `ClientDirect Pro (${config.appEnv})` });
      setMeta(db, 'stripe_webhook_secret', w.secret); out.webhook = mine.length ? 'recréé (secret perdu)' : 'créé';
    } else out.webhook = 'existe déjà (secret à renseigner dans STRIPE_WEBHOOK_SECRET)';
  }
  return out;
}
/** Identifiant Stripe du prix d'une formule, dans la devise de l'entreprise. */
export function priceIds(plan, currency = 'EUR') {
  const cur = String(currency || 'EUR').toLowerCase();
  const env = config.stripePrices[plan] || {};
  const month = meta(`stripe_price_cdp_${plan}_month_${cur}`) || (cur === 'eur' ? env.month : null);
  const setup = meta(`stripe_price_cdp_${plan}_setup_${cur}`) || (cur === 'eur' ? env.setup : null);
  return { month, setup };
}
export const webhookSecret = () => config.stripeWebhookSecret || meta('stripe_webhook_secret') || '';
export const useDb = (db) => { metaDb = db; };

/** Page de paiement Stripe : abonnement mensuel + frais de mise en service, dans la devise de l'entreprise. */
export async function createCheckout(t, userEmail, plan) {
  const P = priceIds(plan, t.currency); if (!PLANS[plan] || !P?.month) throw new Error('Formule non configurée');
  const items = { 0: { price: P.month, quantity: 1 } }; if (P.setup) items[1] = { price: P.setup, quantity: 1 };
  const s = await stripe('checkout/sessions', {
    mode: 'subscription', locale: t.lang === 'en' ? 'en' : 'fr', line_items: items, client_reference_id: t.id, tax_id_collection: { enabled: 'true' },
    customer: t.stripe_customer || undefined, customer_email: t.stripe_customer ? undefined : userEmail,
    metadata: { tenant_id: t.id, plan }, subscription_data: { metadata: { tenant_id: t.id, plan } },
    billing_address_collection: 'required', allow_promotion_codes: 'true',
    custom_text: { submit: { message: t.lang === 'en' ? 'Subscription with a 12-month commitment (see terms of sale). Setup fee charged once.' : 'Abonnement avec engagement de 12 mois (voir CGV). Frais de mise en service facturés une seule fois.' } },
    success_url: `${config.baseUrl}/pro/abonnement?ok=1`, cancel_url: `${config.baseUrl}/pro/abonnement?annule=1`
  });
  return s.url;
}
/** Espace client Stripe : changer de carte, de formule, télécharger les factures, résilier. */
export async function createPortal(t) {
  if (!t.stripe_customer) throw new Error('Aucun abonnement');
  return (await stripe('billing_portal/sessions', { customer: t.stripe_customer, return_url: `${config.baseUrl}/pro/abonnement` })).url;
}

/** Vérifie la signature Stripe-Signature (HMAC SHA-256, tolérance 5 min). */
export function verifyStripeSignature(payload, header, secret = webhookSecret(), toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t); if (!t || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some((s) => safeEq(s, expected));
}

const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', paused: 'paused' };
// Événements qui retirent un droit : ils ne s'appliquent qu'au client Stripe déjà rattaché à l'entreprise.
const NEEDS_CUSTOMER = new Set(['customer.subscription.deleted', 'invoice.payment_failed', 'charge.refunded']);
/**
 * Retrouve l'entreprise concernée. Le client Stripe fait foi : un numéro d'entreprise seul (métadonnée) peut désigner
 * une autre entreprise si un compte a été supprimé puis son numéro réattribué (SQLite réutilise les numéros).
 */
export const tenantFrom = (db, obj, type = '') => {
  const cust = typeof obj?.customer === 'string' ? obj.customer : obj?.customer?.id;
  if (cust) { const byCust = db.one('SELECT * FROM tenants WHERE stripe_customer=?', cust); if (byCust) return byCust; }
  const id = Number(obj?.metadata?.tenant_id || obj?.client_reference_id || obj?.subscription_details?.metadata?.tenant_id || 0);
  if (!id) return null;
  const t = db.one('SELECT * FROM tenants WHERE id=?', id); if (!t) return null;
  if (cust && t.stripe_customer && t.stripe_customer !== cust) return null; // autre client Stripe : ce n'est pas cette entreprise
  const linked = (cust && t.stripe_customer === cust) || (!cust && obj?.id && t.stripe_sub === obj.id);
  if (NEEDS_CUSTOMER.has(type) && !linked) return null;
  // Un client Stripe pas encore rattaché peut activer l'abonnement, jamais le dégrader (impayé, résilié…)
  if (type === 'customer.subscription.updated' && cust && !linked && STATUS[obj?.status] !== 'active') return null;
  return t;
};

/** E-mail au titulaire du compte (une seule fois par clé, même si Stripe renvoie l'événement). */
function mailOwner(db, t, template, payload, key) {
  const owner = db.one('SELECT email FROM users WHERE id=?', t.owner_user_id); if (!owner) return;
  enqueue(db, { tenantId: t.id, channel: 'email', to: owner.email, template, key, payload: { lang: t.lang, tenant: t.name, billingUrl: `${config.baseUrl}/pro/abonnement`, ...payload } });
}
/** Traite un événement Stripe vérifié. Idempotent : un même événement n'est appliqué qu'une fois. */
export function handleStripeEvent(db, ev) {
  if (!ev?.id || !ev?.type) return { ok: false };
  if (db.one('SELECT 1 FROM webhook_events WHERE id=?', ev.id)) return { ok: true, duplicate: true };
  const o = ev.data?.object || {}; const t = tenantFrom(db, o, ev.type); const now = Date.now();
  db.tx(() => {
    db.run('INSERT INTO webhook_events(id,type,received_at) VALUES(?,?,?)', ev.id, ev.type, now);
    if (!t) { if (/^(checkout|invoice|customer\.subscription)/.test(ev.type)) recordIncident(db, { kind: 'billing', severity: 'warning', message: `Événement ${ev.type} sans entreprise associée` }); return; }
    switch (ev.type) {
      case 'checkout.session.completed': {
        const plan = PLANS[o.metadata?.plan] ? o.metadata.plan : t.plan;
        db.run("UPDATE tenants SET status='active', plan=?, stripe_customer=COALESCE(?,stripe_customer), stripe_sub=COALESCE(?,stripe_sub) WHERE id=?", plan, o.customer || null, o.subscription || null, t.id);
        audit(db, { tenantId: t.id, action: 'abonnement.active', detail: plan });
        mailOwner(db, t, 'subscription_confirmed', { plan: PLANS[plan].name }, `abonnement:${t.id}:${o.id}`); break;
      }
      case 'invoice.paid': case 'invoice.payment_succeeded': {
        const end = (o.lines?.data?.[0]?.period?.end || o.period_end || 0) * 1000 || null;
        db.run(`INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(stripe_invoice) DO UPDATE SET status=excluded.status, paid_at=excluded.paid_at`, t.id, o.id, Number(o.amount_paid || 0), o.currency || 'eur', 'paid', now, now);
        db.run("UPDATE tenants SET status='active', current_period_end=COALESCE(?,current_period_end) WHERE id=?", end, t.id);
        emit(db, 'paiement_recu', { entreprise: t.name, montant_eur: Number(o.amount_paid || 0) / 100, facture: o.id }, t.id);
        onInvoicePaid(db, db.one('SELECT * FROM tenants WHERE id=?', t.id), o, now);
        if (Number(o.amount_paid || 0) > 0) mailOwner(db, t, 'payment_receipt', { amount: money(Number(o.amount_paid) / 100, String(o.currency || 'eur').toUpperCase(), t.lang === 'en' ? 'en-US' : 'fr-FR'), invoiceUrl: o.hosted_invoice_url || '' }, `recu:${o.id}`); break;
      }
      case 'charge.refunded': {
        const n = onRefund(db, o.invoice, now);
        audit(db, { tenantId: t.id, action: 'paiement.rembourse', detail: `${o.invoice || o.id} (${n} récompense(s) annulée(s))` }); break;
      }
      case 'invoice.payment_failed': {
        db.run("UPDATE tenants SET status='past_due' WHERE id=?", t.id);
        const owner = db.one('SELECT u.email FROM users u WHERE u.id=?', t.owner_user_id);
        if (owner) enqueue(db, { tenantId: t.id, channel: 'email', to: owner.email, template: 'payment_failed', key: `echec:${o.id || ev.id}`, payload: { lang: t.lang, tenant: t.name, billingUrl: `${config.baseUrl}/pro/abonnement` } });
        recordIncident(db, { kind: 'billing', severity: 'info', message: `Paiement échoué : ${t.name}`, tenantId: t.id });
        emit(db, 'paiement_echoue', { entreprise: t.name, email: owner?.email || '' }, t.id); break;
      }
      case 'customer.subscription.updated': case 'customer.subscription.created': {
        const st = STATUS[o.status] || t.status; const plan = PLANS[o.metadata?.plan] ? o.metadata.plan : t.plan;
        db.run('UPDATE tenants SET status=?, plan=?, stripe_sub=?, current_period_end=COALESCE(?,current_period_end) WHERE id=?', st, plan, o.id || t.stripe_sub, o.current_period_end ? o.current_period_end * 1000 : null, t.id); break;
      }
      case 'customer.subscription.deleted':
        db.run("UPDATE tenants SET status='canceled' WHERE id=?", t.id); audit(db, { tenantId: t.id, action: 'abonnement.resilie' });
        mailOwner(db, t, 'subscription_canceled', {}, `resiliation:${t.id}:${o.id || ev.id}`); break;
      default: break;
    }
  });
  return { ok: true };
}
