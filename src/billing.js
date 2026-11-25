import crypto from 'node:crypto';
import { config, PLANS } from './config.js';
import { net } from './net.js';
import { safeEq } from './util.js';
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
async function stripe(path, params) {
  const res = await net.fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers: { authorization: `Bearer ${config.stripeKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form(params) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${j.error?.message || 'erreur'}`);
  return j;
}

/** Page de paiement Stripe : abonnement mensuel + frais de mise en service. */
export async function createCheckout(t, userEmail, plan) {
  const P = config.stripePrices[plan]; if (!PLANS[plan] || !P?.month) throw new Error('Formule non configurée');
  const items = { 0: { price: P.month, quantity: 1 } }; if (P.setup) items[1] = { price: P.setup, quantity: 1 };
  const s = await stripe('checkout/sessions', {
    mode: 'subscription', locale: 'fr', line_items: items, client_reference_id: t.id,
    customer: t.stripe_customer || undefined, customer_email: t.stripe_customer ? undefined : userEmail,
    metadata: { tenant_id: t.id, plan }, subscription_data: { metadata: { tenant_id: t.id, plan } },
    billing_address_collection: 'required', allow_promotion_codes: 'true',
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
export function verifyStripeSignature(payload, header, secret = config.stripeWebhookSecret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t); if (!t || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return sigs.some((s) => safeEq(s, expected));
}

const STATUS = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled', incomplete_expired: 'canceled', paused: 'paused' };
const tenantFrom = (db, obj) => {
  const id = Number(obj?.metadata?.tenant_id || obj?.client_reference_id || obj?.subscription_details?.metadata?.tenant_id || 0);
  if (id) return db.one('SELECT * FROM tenants WHERE id=?', id);
  if (obj?.customer) return db.one('SELECT * FROM tenants WHERE stripe_customer=?', obj.customer);
  return null;
};

/** Traite un événement Stripe vérifié. Idempotent : un même événement n'est appliqué qu'une fois. */
export function handleStripeEvent(db, ev) {
  if (!ev?.id || !ev?.type) return { ok: false };
  if (db.one('SELECT 1 FROM webhook_events WHERE id=?', ev.id)) return { ok: true, duplicate: true };
  const o = ev.data?.object || {}; const t = tenantFrom(db, o); const now = Date.now();
  db.tx(() => {
    db.run('INSERT INTO webhook_events(id,type,received_at) VALUES(?,?,?)', ev.id, ev.type, now);
    if (!t) { if (/^(checkout|invoice|customer\.subscription)/.test(ev.type)) recordIncident(db, { kind: 'billing', severity: 'warning', message: `Événement ${ev.type} sans entreprise associée` }); return; }
    switch (ev.type) {
      case 'checkout.session.completed': {
        const plan = PLANS[o.metadata?.plan] ? o.metadata.plan : t.plan;
        db.run("UPDATE tenants SET status='active', plan=?, stripe_customer=COALESCE(?,stripe_customer), stripe_sub=COALESCE(?,stripe_sub) WHERE id=?", plan, o.customer || null, o.subscription || null, t.id);
        audit(db, { tenantId: t.id, action: 'abonnement.active', detail: plan }); break;
      }
      case 'invoice.paid': case 'invoice.payment_succeeded': {
        const end = (o.lines?.data?.[0]?.period?.end || o.period_end || 0) * 1000 || null;
        db.run(`INSERT INTO invoices(tenant_id,stripe_invoice,amount_cents,currency,status,paid_at,created_at) VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(stripe_invoice) DO UPDATE SET status=excluded.status, paid_at=excluded.paid_at`, t.id, o.id, Number(o.amount_paid || 0), o.currency || 'eur', 'paid', now, now);
        db.run("UPDATE tenants SET status='active', current_period_end=COALESCE(?,current_period_end) WHERE id=?", end, t.id);
        emit(db, 'paiement_recu', { entreprise: t.name, montant_eur: Number(o.amount_paid || 0) / 100, facture: o.id }, t.id); break;
      }
      case 'invoice.payment_failed': {
        db.run("UPDATE tenants SET status='past_due' WHERE id=?", t.id);
        const owner = db.one('SELECT u.email FROM users u WHERE u.id=?', t.owner_user_id);
        if (owner) enqueue(db, { tenantId: t.id, channel: 'email', to: owner.email, template: 'payment_failed', payload: { tenant: t.name, billingUrl: `${config.baseUrl}/pro/abonnement` } });
        recordIncident(db, { kind: 'billing', severity: 'info', message: `Paiement échoué : ${t.name}`, tenantId: t.id });
        emit(db, 'paiement_echoue', { entreprise: t.name, email: owner?.email || '' }, t.id); break;
      }
      case 'customer.subscription.updated': case 'customer.subscription.created': {
        const st = STATUS[o.status] || t.status; const plan = PLANS[o.metadata?.plan] ? o.metadata.plan : t.plan;
        db.run('UPDATE tenants SET status=?, plan=?, stripe_sub=?, current_period_end=COALESCE(?,current_period_end) WHERE id=?', st, plan, o.id || t.stripe_sub, o.current_period_end ? o.current_period_end * 1000 : null, t.id); break;
      }
      case 'customer.subscription.deleted':
        db.run("UPDATE tenants SET status='canceled' WHERE id=?", t.id); audit(db, { tenantId: t.id, action: 'abonnement.resilie' }); break;
      default: break;
    }
  });
  return { ok: true };
}
