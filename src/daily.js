// Tableau de bord quotidien : inscriptions, nouveaux abonnés, revenus encaissés, dépenses et bénéfice estimé.
// Chiffres réels de la base (comptes de test et exemples exclus). Dépenses : frais Stripe de chaque facture,
// frais fixes saisis dans « Rentabilité » répartis par jour, et coûts IA / e-mails / WhatsApp du mois.
import { config } from './config.js';
import { tenantCosts } from './costs.js';

const REAL = "t.example=0 AND t.status!='demo' AND COALESCE(t.source,'')!='autotest'";
const dayIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const daysInMonth = (m) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
const r2 = (x) => Math.round(x * 100) / 100;

export function dailyReport(db, { days = 30, now = Date.now() } = {}) {
  const end = Date.parse(dayIso(now) + 'T23:59:59.999Z'); const start = end + 1 - days * 864e5;
  const rows = new Map(); for (let d = start; d <= end; d += 864e5) rows.set(dayIso(d), { day: dayIso(d), inscriptions: 0, nouveauxAbonnes: 0, factures: 0, revenus: 0, fraisStripe: 0, fraisFixes: 0 });
  for (const t of db.all(`SELECT t.created_at FROM tenants t WHERE ${REAL} AND t.created_at BETWEEN ? AND ?`, start, end)) rows.get(dayIso(t.created_at)).inscriptions++;
  for (const i of db.all(`SELECT i.tenant_id, i.amount_cents, i.paid_at, (SELECT MIN(j.paid_at) FROM invoices j WHERE j.tenant_id=i.tenant_id AND j.status='paid') first FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE i.status='paid' AND ${REAL} AND i.paid_at BETWEEN ? AND ?`, start, end)) {
    const r = rows.get(dayIso(i.paid_at)); const eur = i.amount_cents / 100;
    r.factures++; r.revenus += eur; r.fraisStripe += eur * config.costs.stripePct + config.costs.stripeFixed;
    if (i.first === i.paid_at) r.nouveauxAbonnes++;
  }
  const fixedOf = new Map();
  for (const r of rows.values()) {
    const m = r.day.slice(0, 7);
    if (!fixedOf.has(m)) fixedOf.set(m, db.one('SELECT COALESCE(SUM(amount_cents),0) c FROM expenses WHERE month=? OR (recurring=1 AND month<=?)', m, m).c / 100 / daysInMonth(m));
    r.fraisFixes = fixedOf.get(m);
  }
  const list = [...rows.values()].map((r) => ({ ...r, revenus: r2(r.revenus), fraisStripe: r2(r.fraisStripe), fraisFixes: r2(r.fraisFixes), benefice: r2(r.revenus - r.fraisStripe - r.fraisFixes) })).reverse();
  // Coûts variables du mois en cours (IA, e-mails, WhatsApp), comptés au mois car l'IA est mesurée par mois
  const month = dayIso(now).slice(0, 7); const tc = tenantCosts(db, month);
  const variables = r2(tc.rows.reduce((a, x) => a + (x.costs.ai || 0) + (x.costs.email || 0) + (x.costs.whatsapp || 0), 0));
  const mois = list.filter((r) => r.day.startsWith(month));
  const sum = (k) => r2(mois.reduce((a, r) => a + r[k], 0));
  const abonnes = db.one(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status IN ('active','past_due')`).n;
  const essais = db.one(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status='trial'`).n;
  return { jours: list, mois: { month, inscriptions: sum('inscriptions'), revenus: sum('revenus'), fraisStripe: sum('fraisStripe'), fraisFixes: sum('fraisFixes'), coutsVariables: variables, benefice: r2(sum('revenus') - sum('fraisStripe') - sum('fraisFixes') - variables) }, abonnes, essais };
}
