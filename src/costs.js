// Rentabilité réelle par client : ce qu'il paie moins ce qu'il nous coûte, mois par mois.
import { config, PLANS } from './config.js';
import { aiCostEur } from './ai.js';

const monthRange = (m) => { const start = Date.parse(m + '-01T00:00:00Z'); const d = new Date(start); d.setUTCMonth(d.getUTCMonth() + 1); return [start, d.getTime()]; };

export function tenantCosts(db, month = new Date().toISOString().slice(0, 7)) {
  const [start, end] = monthRange(month);
  const tenants = db.all("SELECT id, name, plan, status, cc, custom_domain FROM tenants WHERE status IN ('trial','active','past_due')");
  const paying = tenants.filter((t) => t.status !== 'trial').length;
  // Frais fixes du mois (hébergement, domaine, abonnements) répartis entre les clients payants
  const fixed = db.one('SELECT COALESCE(SUM(amount_cents),0) c FROM expenses WHERE month=? OR (recurring=1 AND month<=?)', month, month).c / 100;
  const share = paying ? fixed / paying : 0;
  const rows = tenants.map((t) => {
    const ai = db.one('SELECT COALESCE(in_tokens,0) i, COALESCE(out_tokens,0) o, COALESCE(calls,0) calls FROM ai_usage WHERE tenant_id=? AND month=?', t.id, month) || { i: 0, o: 0, calls: 0 };
    const sent = Object.fromEntries(db.all("SELECT channel, to_addr, COUNT(*) n FROM outbox WHERE tenant_id=? AND status='sent' AND sent_at>=? AND sent_at<? GROUP BY channel, substr(to_addr,1,3)", t.id, start, end).map((r) => [r.channel + ':' + r.to_addr.slice(0, 3), r.n]));
    let emails = 0, waCost = 0, wa = 0;
    for (const [k, n] of Object.entries(sent)) {
      if (k.startsWith('email')) emails += n;
      else if (k.startsWith('whatsapp')) { wa += n; const pfx = k.split(':')[1]; const cc = ['594', '596', '590', '262'].includes(pfx) ? (pfx === '594' ? '594' : 'default') : pfx.startsWith('33') ? '33' : 'default'; waCost += n * (config.costs.waByCc[cc] ?? config.costs.waByCc.default); }
    }
    const inv = db.one("SELECT COALESCE(SUM(amount_cents),0) c, COUNT(*) n FROM invoices WHERE tenant_id=? AND status='paid' AND paid_at>=? AND paid_at<?", t.id, start, end);
    const revenue = inv.c / 100;
    const stripe = inv.n ? revenue * config.costs.stripePct + inv.n * config.costs.stripeFixed : 0;
    const costs = { ai: aiCostEur(ai.i, ai.o), email: emails * config.costs.email, whatsapp: waCost, stripe, domain: t.custom_domain ? config.costs.domain : 0, share: t.status === 'trial' ? 0 : share };
    const total = Object.values(costs).reduce((a, b) => a + b, 0);
    const r2 = (x) => Math.round(x * 100) / 100;
    return { id: t.id, name: t.name, plan: t.plan, status: t.status, listPrice: PLANS[t.plan].monthly, revenue: r2(revenue), emails, wa, aiCalls: ai.calls, costs: Object.fromEntries(Object.entries(costs).map(([k, v]) => [k, r2(v)])), total: r2(total), margin: r2(revenue - total) };
  });
  const sum = (f) => Math.round(rows.reduce((a, r) => a + f(r), 0) * 100) / 100;
  return { month, rows: rows.sort((a, b) => a.margin - b.margin), fixed, paying, totals: { revenue: sum((r) => r.revenue), costs: sum((r) => r.total), margin: sum((r) => r.margin) } };
}
