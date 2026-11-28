// Tableau de bord quotidien : inscriptions, nouveaux abonnés, revenus encaissés, dépenses et bénéfice estimé.
// Chiffres réels de la base (comptes de test et exemples exclus). Dépenses : frais Stripe de chaque facture,
// frais fixes saisis dans « Rentabilité » répartis par jour, et coûts IA / e-mails / WhatsApp du mois.
import { config } from './config.js';
import { tenantCosts } from './costs.js';
import { funnelReport } from './funnel.js';

const REAL = "t.example=0 AND COALESCE(t.internal,0)=0 AND t.status!='demo' AND COALESCE(t.source,'')!='autotest' AND COALESCE(t.source,'') NOT LIKE 'utm:controle%'";
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

/**
 * Bilan commercial (chiffres agrégés, aucune donnée personnelle) : prospection, réponses, inscriptions,
 * essais, abonnements, chiffre d'affaires et dépenses réelles. Écrit une fois par jour dans le journal du serveur.
 */
export function commercialReport(db, now = Date.now()) {
  const day = dayIso(now); const d0 = Date.parse(day + 'T00:00:00Z'); const month = day.slice(0, 7); const m0 = Date.parse(month + '-01T00:00:00Z');
  const n = (sql, ...a) => db.one(sql, ...a).n;
  const prospection = {
    prospects: n("SELECT COUNT(*) n FROM prospects WHERE status!='optout'"),
    joignablesEmail: n("SELECT COUNT(*) n FROM prospects WHERE email IS NOT NULL AND email!='' AND status!='optout' AND bounced_at IS NULL"),
    contactesTotal: n("SELECT COUNT(DISTINCT prospect_id) n FROM campaign_items WHERE status='sent'"),
    contactesAujourdhui: n("SELECT COUNT(*) n FROM campaign_items WHERE status='sent' AND sent_at>=?", d0),
    relancesEnvoyees: n('SELECT COUNT(*) n FROM campaign_items WHERE step>0'),
    reponses: n('SELECT COUNT(*) n FROM prospects WHERE replied_at IS NOT NULL'),
    oppositions: n("SELECT COUNT(*) n FROM prospects WHERE status='optout'"),
    rebonds: n('SELECT COUNT(*) n FROM prospects WHERE bounced_at IS NOT NULL'),
    demosVues: db.one("SELECT COALESCE(SUM(n),0) n FROM visits_source WHERE source='demo'").n,
    campagnesEnAttente: n("SELECT COUNT(*) n FROM campaigns WHERE status='draft'"),
    campagnesActives: n("SELECT COUNT(*) n FROM campaigns c WHERE status='approved' AND EXISTS (SELECT 1 FROM campaign_items i WHERE i.campaign_id=c.id AND i.status='ready')")
  };
  const clients = {
    inscriptionsTotal: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL}`),
    inscriptionsAujourdhui: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.created_at>=?`, d0),
    inscriptionsMois: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.created_at>=?`, m0),
    issuesDeLaProspection: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.prospect_id IS NOT NULL`),
    essaisEnCours: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status='trial' AND t.trial_ends_at>?`, now),
    essaisTerminesNonConvertis: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status='trial' AND t.trial_ends_at<=?`, now),
    abonnesPayants: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status IN ('active','past_due')`),
    impayes: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status='past_due'`),
    resilies: n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status='canceled'`)
  };
  clients.tauxConversion = clients.inscriptionsTotal ? r2((clients.abonnesPayants / clients.inscriptionsTotal) * 100) : 0;
  const parFormule = Object.fromEntries(['essentiel', 'pro', 'premium'].map((p) => [p, n(`SELECT COUNT(*) n FROM tenants t WHERE ${REAL} AND t.status IN ('active','past_due') AND t.plan=?`, p)]));
  const mrr = ['essentiel', 'pro', 'premium'].reduce((a, p) => a + parFormule[p] * ({ essentiel: 79, pro: 149, premium: 249 }[p]), 0);
  const enc = db.one(`SELECT COALESCE(SUM(i.amount_cents),0) c, COUNT(*) k FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE ${REAL} AND i.status='paid' AND i.paid_at>=?`, m0);
  const encTotal = db.one(`SELECT COALESCE(SUM(i.amount_cents),0) c FROM invoices i JOIN tenants t ON t.id=i.tenant_id WHERE ${REAL} AND i.status='paid'`).c / 100;
  const rep = dailyReport(db, { days: 31, now });
  const argent = {
    revenuRecurrentMensuel: mrr, encaisseMois: r2(enc.c / 100), facturesMois: enc.k, encaisseTotal: r2(encTotal),
    fraisStripeMois: rep.mois.fraisStripe, chargesFixesMois: rep.mois.fraisFixes, coutsVariablesMois: rep.mois.coutsVariables,
    beneficeMois: r2(enc.c / 100 - rep.mois.fraisStripe - rep.mois.fraisFixes - rep.mois.coutsVariables),
    // Estimation après cotisations sociales de micro-entreprise (21,3 % du chiffre d'affaires encaissé)
    depensesMois: r2(rep.mois.fraisStripe + rep.mois.fraisFixes + rep.mois.coutsVariables),
    beneficeNetMois: r2(enc.c / 100 * (1 - 0.213) - rep.mois.fraisStripe - rep.mois.fraisFixes - rep.mois.coutsVariables)
  };
  const servicesPayants = { assistantIA: config.anthropicKey ? 'activé' : 'désactivé', whatsapp: config.waToken && config.waPhoneId ? 'activé' : 'désactivé' };
  // Entonnoir : jour courant, 7 derniers jours et depuis la mise en place de la mesure
  const ago = (k) => dayIso(now - k * 86400e3);
  const entonnoir = { aujourdhui: funnelReport(db, day, day), septJours: funnelReport(db, ago(6), day), total: funnelReport(db, '2000-01-01', day) };
  // Résumé lisible : les chiffres qui comptent, sans robots ni consultations de l'administrateur
  const hier = funnelReport(db, ago(1), ago(1));
  const essentiel = { visiteursReelsHier: hier.etapes.visite, visiteursReels7j: entonnoir.septJours.etapes.visite, demosConsulteesHier: hier.etapes.demo_vue, demosConsultees7j: entonnoir.septJours.etapes.demo_vue,
    inscriptionsMois: clients.inscriptionsMois, abonnesPayants: clients.abonnesPayants, chiffreAffairesMois: argent.encaisseMois, depensesMois: argent.depensesMois, beneficeNetMois: argent.beneficeNetMois };
  return { jour: day, essentiel, prospection, entonnoir, clients, parFormule, argent, servicesPayants };
}
