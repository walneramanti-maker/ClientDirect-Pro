// Parrainage (clients) et partenariat (prescripteurs) : récompenses UNIQUEMENT sur des paiements réellement encaissés.
// Une récompense naît d'une facture payée, attend 30 jours (délai de remboursement), puis est validée.
// Un remboursement pendant l'attente l'annule. Rien n'est versé automatiquement à un partenaire : vous faites le virement.
import { config } from './config.js';
import { priceOf } from './markets.js';
import { randomId, sha256 } from './util.js';
import { recordIncident } from './incidents.js';

export const PROGRAM = {
  holdDays: 30,                 // délai avant validation (remboursements, impayés)
  partnerRatePct: 20,           // commission partenaire sur les sommes HT encaissées
  partnerMonths: 12,            // pendant les 12 premiers mois du client
  partnerMinPayout: 50,         // versement à partir de 50 €
  referralMaxPerYear: 12        // mois offerts au maximum par parrain et par an
};

/** Montant hors taxes d'une facture Stripe (centimes). */
export const excludingTax = (o) => Math.max(0, Number(o.total_excluding_tax ?? (Number(o.amount_paid || 0) - Number(o.tax || 0))) || 0);

/** Appelée à chaque facture payée (dans la transaction du webhook). Idempotente. */
export function onInvoicePaid(db, t, o, now = Date.now()) {
  const net = excludingTax(o); if (!net || !o.id) return;
  const hold = now + PROGRAM.holdDays * 864e5;
  const ins = (kind, f) => db.run(`INSERT OR IGNORE INTO rewards(kind,beneficiary_tenant_id,partner_id,source_tenant_id,invoice,amount_cents,currency,status,available_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
    kind, f.tenant || null, f.partner || null, t.id, o.id, f.cents, (f.currency || o.currency || 'eur').toLowerCase(), hold, now);
  // Partenaire : 20 % du HT encaissé pendant les 12 premiers mois du client apporté
  if (t.partner_id) {
    const p = db.one("SELECT * FROM partners WHERE id=? AND status='active'", t.partner_id);
    const first = db.one("SELECT MIN(paid_at) at FROM invoices WHERE tenant_id=? AND status='paid'", t.id).at || now;
    if (p && p.rate_pct > 0 && now - first <= PROGRAM.partnerMonths * 30.44 * 864e5) ins('commission', { partner: p.id, cents: Math.round(net * (p.rate_pct ?? PROGRAM.partnerRatePct) / 100) });
  }
  // Parrainage : au PREMIER paiement du filleul, un mois offert au parrain et au filleul
  if (t.referred_by_tenant_id && db.one("SELECT COUNT(*) n FROM invoices WHERE tenant_id=? AND status='paid'", t.id).n === 1) {
    const r = db.one("SELECT * FROM tenants WHERE id=? AND status IN ('active','trial','past_due')", t.referred_by_tenant_id);
    const yearCount = r ? db.one("SELECT COUNT(*) n FROM rewards WHERE kind='credit' AND beneficiary_tenant_id=? AND source_tenant_id!=? AND created_at>? AND status!='canceled'", r.id, r.id, now - 365 * 864e5).n : 0;
    if (r && yearCount < PROGRAM.referralMaxPerYear) { const pr = priceOf(r.plan, r.currency); ins('credit', { tenant: r.id, cents: pr.monthly * 100, currency: pr.currency }); }
    const pt = priceOf(t.plan, t.currency); ins('credit_referee', { tenant: t.id, cents: pt.monthly * 100, currency: pt.currency });
  }
}

/** Remboursement : les récompenses encore en attente sur cette facture sont annulées. */
export function onRefund(db, invoiceId, now = Date.now()) {
  if (!invoiceId) return 0;
  const n = Number(db.run("UPDATE rewards SET status='canceled', updated_at=? WHERE invoice=? AND status IN ('pending','approved')", now, invoiceId).changes);
  if (db.one("SELECT 1 FROM rewards WHERE invoice=? AND status='paid'", invoiceId)) recordIncident(db, { kind: 'parrainage', severity: 'warning', message: `Facture ${invoiceId} remboursée alors qu'une récompense a déjà été appliquée : à vérifier` });
  db.run("UPDATE invoices SET status='refunded' WHERE stripe_invoice=?", invoiceId);
  return n;
}

/**
 * Tâche quotidienne : valide les récompenses dont le délai est passé.
 * Mois offerts : crédit déduit automatiquement de la prochaine facture Stripe du bénéficiaire.
 * Commissions : « à verser » ; le virement est fait par vous, puis marqué versé dans l'administration.
 */
export async function processRewards(db, { now = Date.now(), stripeCall = null } = {}) {
  const r = { approved: 0, applied: 0, canceled: 0 };
  for (const w of db.all("SELECT * FROM rewards WHERE status='pending' AND available_at<=?", now)) {
    const inv = db.one('SELECT status FROM invoices WHERE stripe_invoice=?', w.invoice);
    const src = db.one('SELECT status FROM tenants WHERE id=?', w.source_tenant_id);
    if (!inv || inv.status !== 'paid' || !src || src.status === 'canceled') { db.run("UPDATE rewards SET status='canceled', updated_at=? WHERE id=?", now, w.id); r.canceled++; continue; }
    if (w.kind === 'commission') { db.run("UPDATE rewards SET status='approved', updated_at=? WHERE id=?", now, w.id); r.approved++; continue; }
    const b = db.one('SELECT * FROM tenants WHERE id=?', w.beneficiary_tenant_id);
    if (!b || b.status === 'canceled') { db.run("UPDATE rewards SET status='canceled', updated_at=? WHERE id=?", now, w.id); r.canceled++; continue; }
    if (b.stripe_customer && stripeCall) {
      try {
        const tx = await stripeCall(`customers/${b.stripe_customer}/balance_transactions`, { amount: -w.amount_cents, currency: w.currency, description: w.kind === 'credit' ? 'ClientDirect Pro – mois offert (parrainage)' : 'ClientDirect Pro – mois offert (bienvenue parrainage)', 'metadata[reward_id]': w.id });
        db.run("UPDATE rewards SET status='paid', applied_ref=?, updated_at=? WHERE id=?", tx?.id || '', now, w.id); r.applied++;
      } catch (e) { recordIncident(db, { kind: 'parrainage', severity: 'warning', message: `Mois offert non appliqué (${b.name}) : ${String(e.message).slice(0, 120)}` }); }
    } else { db.run("UPDATE rewards SET status='approved', updated_at=? WHERE id=?", now, w.id); r.approved++; }
  }
  return r;
}

// ---------- Partenaires ----------
const slug = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12) || 'partenaire';
/**
 * Pas de commission pour les organismes publics (CMA, CCI) ni pour les professions dont la déontologie
 * encadre ou interdit les rémunérations liées aux résultats ou à l'apport d'affaires (experts-comptables, avocats…) :
 * ils restent partenaires « relais » (lien suivi, statistiques) sans rémunération.
 * Les autres doivent avoir un SIRET (facture obligatoire) et certifier que leur statut les y autorise.
 */
export const NO_COMMISSION = ['Expert-comptable', 'Chambre de métiers ou CCI', 'Avocat ou autre profession réglementée'];
export function partnerRate(f) {
  if (NO_COMMISSION.includes(f.activity)) return 0;
  if (!/^\d{14}$/.test(String(f.siret || '')) || f.certify !== 'on') return 0;
  return PROGRAM.partnerRatePct;
}
export function applyPartner(db, f, now = Date.now()) {
  return Number(db.run("INSERT INTO partners(name,company,email,phone,siret,activity,status,rate_pct,created_at) VALUES(?,?,?,?,?,?,'pending',?,?)", f.name, f.company, f.email, f.phone || '', f.siret || '', f.activity || '', partnerRate(f), now).lastInsertRowid);
}
/** Validation par l'administrateur : crée le code du lien et l'accès privé au tableau de bord du partenaire. */
export function approvePartner(db, id, now = Date.now()) {
  const p = db.one('SELECT * FROM partners WHERE id=?', id); if (!p) throw new Error('Partenaire introuvable');
  const code = p.code || `${slug(p.company || p.name)}${randomId(3).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 3)}`;
  const token = randomId(24);
  db.run("UPDATE partners SET status='active', code=?, token_hash=?, approved_at=? WHERE id=?", code, sha256(token), now, id);
  return { code, link: `${config.baseUrl}/?ref=p-${code}`, dashboard: `${config.baseUrl}/partenaire/${token}` };
}
export const partnerByToken = (db, token) => (token && /^[\w-]{20,}$/.test(token) ? db.one("SELECT * FROM partners WHERE token_hash=? AND status!='pending'", sha256(token)) : null);
export function partnerStats(db, p) {
  const sum = (st) => db.one("SELECT COALESCE(SUM(amount_cents),0) c FROM rewards WHERE partner_id=? AND kind='commission' AND status=?", p.id, st).c / 100;
  return {
    clicks: db.one('SELECT COALESCE(SUM(n),0) n FROM visits_source WHERE source=?', `partner:${p.code}`).n,
    signups: db.one('SELECT COUNT(*) n FROM tenants WHERE partner_id=?', p.id).n,
    paying: db.one("SELECT COUNT(*) n FROM tenants WHERE partner_id=? AND status IN ('active','past_due')", p.id).n,
    pending: sum('pending'), toPay: sum('approved'), paid: sum('paid')
  };
}
export function referralStats(db, t) {
  return {
    referred: db.one('SELECT COUNT(*) n FROM tenants WHERE referred_by_tenant_id=?', t.id).n,
    paying: db.one("SELECT COUNT(*) n FROM tenants WHERE referred_by_tenant_id=? AND status IN ('active','past_due')", t.id).n,
    months: db.one("SELECT COUNT(*) n FROM rewards WHERE kind='credit' AND beneficiary_tenant_id=? AND status IN ('approved','paid')", t.id).n
  };
}
