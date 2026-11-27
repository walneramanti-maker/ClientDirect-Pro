// Suivi commercial des 30 premiers jours : chaque appel ou contact est noté, puis relié aux inscriptions et paiements.
import { applyOptout } from './suppression.js';
import { config, PLANS } from './config.js';
import { TEMPLATES } from './templates.js';

export const OUTCOMES = {
  interesse: { label: 'Intéressé', status: 'contacted', positive: true },
  demo_envoyee: { label: 'Démo envoyée (lien)', status: 'demo', positive: true },
  rappeler: { label: 'À rappeler', status: 'contacted' },
  injoignable: { label: 'Injoignable / messagerie', status: 'contacted' },
  refus: { label: 'Pas intéressé', status: 'lost' },
  opposition: { label: 'Ne veut plus être contacté', status: 'optout' },
  reponse: { label: 'A répondu par e-mail (à traiter)', status: 'contacted' }
};
export const CHANNELS = { appel: 'Appel', sms: 'SMS', email: 'E-mail', visite: 'Visite', autre: 'Autre' };

/** Enregistre un contact et met à jour le statut du prospect. */
export function logContact(db, prospectId, { outcome, channel = 'appel', note = '' }, now = Date.now()) {
  const o = OUTCOMES[outcome]; if (!o) throw new Error('Résultat inconnu');
  const ch = CHANNELS[channel] ? channel : 'autre';
  const p = db.one('SELECT id, status FROM prospects WHERE id=?', prospectId); if (!p) throw new Error('Prospect introuvable');
  db.run('INSERT INTO contacts(prospect_id,channel,outcome,note,created_at) VALUES(?,?,?,?,?)', p.id, ch, outcome, String(note).slice(0, 300), now);
  const status = p.status === 'converted' ? 'converted' : o.status;
  if (status === 'optout') applyOptout(db, p.id, 'opposition exprimée lors d’un contact');
  else db.run('UPDATE prospects SET status=?, last_contact_at=? WHERE id=?', status, now, p.id);
  // Un échange avec la personne (hors « injoignable ») : la suite est humaine, les relances automatiques s'arrêtent
  if (outcome !== 'injoignable') { db.run('UPDATE prospects SET replied_at=COALESCE(replied_at, ?) WHERE id=?', now, p.id); db.run("UPDATE campaign_items SET next_at=NULL WHERE prospect_id=? AND status='sent'", p.id); }
  return status;
}

const cls = (v) => (v >= 75 ? 'A' : v >= 50 ? 'B' : 'C');
const CLASS_LABEL = { A: 'A — sans site / plateforme', B: 'B — site vieillissant', C: 'C — site récent ou inconnu' };

/** Tableau de bord commercial d'une période (dates ISO incluses). */
export function salesData(db, fromIso, toIso) {
  const from = Date.parse(fromIso + 'T00:00:00Z'), to = Date.parse(toIso + 'T23:59:59Z');
  const contacts = db.all('SELECT c.*, p.potential, p.tpl, p.dept FROM contacts c JOIN prospects p ON p.id=c.prospect_id WHERE c.created_at BETWEEN ? AND ?', from, to);
  // Clients issus de la prospection : compte relié au prospect, créé pendant la période
  const won = db.all("SELECT t.id, t.status, t.plan, t.created_at, p.potential, p.tpl FROM tenants t JOIN prospects p ON p.id=t.prospect_id WHERE t.example=0 AND t.status!='demo' AND t.created_at BETWEEN ? AND ?", from, to);
  const paidBy = new Map(db.all("SELECT i.tenant_id, SUM(i.amount_cents) c FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE i.status='paid' AND COALESCE(t.source,'')!='autotest' AND COALESCE(t.source,'') NOT LIKE 'utm:controle%' AND i.paid_at BETWEEN ? AND ? GROUP BY i.tenant_id", from, to).map((r) => [r.tenant_id, r.c / 100]));
  const paying = (t) => ['active', 'past_due'].includes(t.status);

  const blank = (label) => ({ label, contacts: 0, prospects: new Set(), positive: 0, signups: 0, paying: 0, revenue: 0 });
  const byClass = { A: blank(CLASS_LABEL.A), B: blank(CLASS_LABEL.B), C: blank(CLASS_LABEL.C) };
  const byTpl = new Map(); const tplRow = (k) => { if (!byTpl.has(k)) byTpl.set(k, blank(TEMPLATES[k]?.label || k)); return byTpl.get(k); };
  const byChannel = new Map(); const chRow = (k) => { if (!byChannel.has(k)) byChannel.set(k, blank(CHANNELS[k] || k)); return byChannel.get(k); };
  const outcomes = Object.fromEntries(Object.keys(OUTCOMES).map((k) => [k, 0]));
  const days = new Map(); for (let d = from; d <= to; d += 864e5) days.set(new Date(d).toISOString().slice(0, 10), { contacts: 0, positive: 0, signups: 0, paid: 0 });
  const dayOf = (ms) => days.get(new Date(ms).toISOString().slice(0, 10));

  for (const c of contacts) {
    const pos = !!OUTCOMES[c.outcome]?.positive; outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
    for (const g of [byClass[cls(c.potential)], tplRow(c.tpl), chRow(c.channel)]) { g.contacts++; g.prospects.add(c.prospect_id); if (pos) g.positive++; }
    const d = dayOf(c.created_at); if (d) { d.contacts++; if (pos) d.positive++; }
  }
  for (const t of won) {
    const rev = paidBy.get(t.id) || 0;
    for (const g of [byClass[cls(t.potential)], tplRow(t.tpl)]) { g.signups++; if (paying(t)) g.paying++; g.revenue += rev; }
    const d = dayOf(t.created_at); if (d) d.signups++;
  }
  for (const i of db.all("SELECT i.paid_at FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE i.status='paid' AND COALESCE(t.source,'')!='autotest' AND COALESCE(t.source,'') NOT LIKE 'utm:controle%' AND i.paid_at BETWEEN ? AND ?", from, to)) { const d = dayOf(i.paid_at); if (d) d.paid++; }
  const fin = (g) => ({ ...g, prospects: g.prospects.size });

  // Coûts variables de la prospection sur la période
  const months = [...new Set([...days.keys()].map((d) => d.slice(0, 7)))];
  const credits = months.reduce((a, m) => a + Number(db.one('SELECT v FROM meta WHERE k=?', `enrich_credits_${m}`)?.v || 0), 0);
  const reachable = db.one("SELECT COUNT(*) n FROM prospects WHERE status='new' AND maps_closed=0 AND (phone IS NOT NULL OR email IS NOT NULL)").n;
  const reachByClass = Object.fromEntries(db.all("SELECT CASE WHEN potential>=75 THEN 'A' WHEN potential>=50 THEN 'B' ELSE 'C' END k, COUNT(*) n FROM prospects WHERE status='new' AND maps_closed=0 AND (phone IS NOT NULL OR email IS NOT NULL) GROUP BY k").map((r) => [r.k, r.n]));

  // Objectif 2027 : 50 000 € de bénéfice, soit environ 4 167 € par mois de revenu récurrent net des coûts fixes
  const target = 50000 / 12; const mrr = db.all("SELECT plan FROM tenants WHERE status IN ('active','past_due') AND example=0 AND COALESCE(source,'')!='autotest' AND COALESCE(source,'') NOT LIKE 'utm:controle%'").reduce((a, r) => a + (PLANS[r.plan]?.monthly || 0), 0);
  const totals = { contacts: contacts.length, prospects: new Set(contacts.map((c) => c.prospect_id)).size, positive: contacts.filter((c) => OUTCOMES[c.outcome]?.positive).length, signups: won.length, paying: won.filter(paying).length, revenue: [...paidBy.values()].reduce((a, b) => a + b, 0) };
  return {
    totals, outcomes, reachable, reachByClass,
    byClass: Object.values(byClass).map(fin), byTpl: [...byTpl.values()].map(fin).sort((a, b) => b.contacts - a.contacts), byChannel: [...byChannel.values()].map(fin),
    daily: [...days.entries()].map(([day, v]) => ({ day, ...v })),
    costs: { firecrawlCredits: credits, firecrawlEur: credits * config.enrichEurPerCredit },
    goal: { monthlyTarget: Math.round(target), mrr, clientsProNeeded: Math.ceil(Math.max(0, target - mrr) / PLANS.pro.monthly) }
  };
}
