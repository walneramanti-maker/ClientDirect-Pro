// Administration des entreprises clientes : classement (client réel, démonstration, contrôle, interne), territoires,
// liste filtrée et paginée (plusieurs milliers d'entreprises), fiche individuelle, actions sécurisées, statistiques.
import { PLANS, config } from './config.js';
import { TEMPLATES } from './templates.js';
import { COUNTRIES } from './markets.js';
import { deptOf, DEPARTEMENTS } from './france.js';
import { tenantCosts } from './costs.js';

/** Territoires suivis séparément ; tout autre pays est regroupé dans « Autres pays ». */
export const TERRITORIES = { GF: 'Guyane', FR: 'France métropolitaine', MQ: 'Martinique', GP: 'Guadeloupe', RE: 'La Réunion', YT: 'Mayotte', XX: 'Autres pays' };
export const territoryCode = (country) => (TERRITORIES[country] && country !== 'XX' ? country : 'XX');
export const KINDS = { client: 'Clients réels', demo: 'Démonstrations (prospects)', controle: 'Comptes de contrôle et supprimés', interne: 'Comptes internes', exemple: 'Sites d’exemple' };
export const STATUS = { trial: 'Essai gratuit', active: 'Abonné payant', past_due: 'Impayé', paused: 'En pause', canceled: 'Résilié', demo: 'Démonstration' };

// Classement d'une entreprise, en SQL (alias t) : une seule définition pour la liste, les compteurs et les statistiques
export const KIND_SQL = `CASE WHEN t.status='demo' THEN 'demo' WHEN t.example=1 THEN 'exemple' WHEN t.internal=1 THEN 'interne'
  WHEN t.slug LIKE 'supprime-%' OR COALESCE(t.source,'') IN ('autotest') OR COALESCE(t.source,'') LIKE 'utm:controle%' THEN 'controle' ELSE 'client' END`;
const TERR_SQL = `CASE WHEN t.country IN ('GF','FR','MQ','GP','RE','YT') THEN t.country ELSE 'XX' END`;

const like = (s) => `%${String(s).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
export const PER_PAGE = 50;

/** Filtres reconnus : q (nom, responsable, e-mail, téléphone, ville, site), tpl, city, country, terr, plan, status, kind, sort. */
export function clientFilters(sp) {
  const g = (k) => String(sp.get?.(k) ?? sp[k] ?? '').trim().slice(0, 80);
  const f = { q: g('q'), tpl: g('tpl'), city: g('city'), country: g('country'), terr: g('terr'), plan: g('plan'), status: g('status'), kind: g('kind') || 'client', periode: g('periode'), sort: g('sort') || 'recent', page: Math.max(1, Math.floor(Number(g('page')) || 1)) };
  if (!TEMPLATES[f.tpl]) f.tpl = ''; if (!PLANS[f.plan]) f.plan = ''; if (!STATUS[f.status]) f.status = ''; if (!TERRITORIES[f.terr]) f.terr = '';
  if (!COUNTRIES[f.country]) f.country = ''; if (!KINDS[f.kind] && f.kind !== 'tous') f.kind = 'client';
  if (!['recent', 'ancien', 'nom', 'essai', 'paiement'].includes(f.sort)) f.sort = 'recent';
  if (!['mois', '7j', '30j'].includes(f.periode)) f.periode = '';
  return f;
}
function where(f) {
  const w = []; const a = [];
  if (f.kind !== 'tous') { w.push(`(${KIND_SQL})=?`); a.push(f.kind); }
  if (f.q) { w.push("(t.name LIKE ? ESCAPE '\\' OR t.slug LIKE ? ESCAPE '\\' OR t.city LIKE ? ESCAPE '\\' OR t.phone LIKE ? ESCAPE '\\' OR t.email LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\')"); a.push(...Array(7).fill(like(f.q))); }
  if (f.tpl) { w.push('t.tpl=?'); a.push(f.tpl); }
  if (f.city) { w.push("t.city LIKE ? ESCAPE '\\'"); a.push(like(f.city)); }
  if (f.country) { w.push('t.country=?'); a.push(f.country); }
  if (f.terr) { w.push(`${TERR_SQL}=?`); a.push(f.terr); }
  if (f.plan) { w.push('t.plan=?'); a.push(f.plan); }
  if (f.status) { w.push('t.status=?'); a.push(f.status); }
  if (f.periode) { const now = new Date(); const since = f.periode === 'mois' ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) : Date.now() - (f.periode === '7j' ? 7 : 30) * 864e5; w.push('t.created_at>=?'); a.push(since); }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', args: a };
}
const ORDER = { recent: 't.created_at DESC, t.id DESC', ancien: 't.created_at ASC, t.id ASC', nom: 't.name COLLATE NOCASE ASC', essai: "CASE WHEN t.status='trial' THEN t.trial_ends_at ELSE 9e15 END ASC", paiement: 'COALESCE(t.current_period_end, 9e15) ASC' };

/** Département déduit du code postal de l'adresse (France et Outre-mer). */
export function deptOfTenant(t) { const m = /\b(\d{5})\b/.exec(t.address || ''); const d = m ? deptOf(m[1]) : ''; return d ? { code: d, nom: DEPARTEMENTS[d] || '' } : null; }
export function trialDaysLeft(t, now = Date.now()) { return t.status === 'trial' && t.trial_ends_at ? Math.max(0, Math.ceil((t.trial_ends_at - now) / 864e5)) : null; }
/** Prochaine échéance : prochain prélèvement pour un abonné ; fin d'essai sinon (aucun prélèvement sans souscription). */
export function nextPayment(t) {
  if (['active', 'past_due'].includes(t.status) && t.current_period_end) return { at: t.current_period_end, label: t.status === 'past_due' ? 'paiement en retard' : 'prochain prélèvement' };
  if (t.status === 'trial' && t.trial_ends_at) return { at: t.trial_ends_at, label: 'fin de l’essai (aucun prélèvement sans souscription)' };
  return null;
}

/** Liste paginée. */
export function listClients(db, f) {
  const q = where(f); const from = 'FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id';
  const total = db.one(`SELECT COUNT(*) n ${from} ${q.sql}`, ...q.args).n;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE)); const page = Math.min(f.page, pages);
  const rows = db.all(`SELECT t.*, u.name owner_name, u.email owner_email, (${KIND_SQL}) kind,
      (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.tenant_id=t.id AND i.status='paid') paid_cents,
      (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id=t.id) invoices
    ${from} ${q.sql} ORDER BY ${ORDER[f.sort]} LIMIT ? OFFSET ?`, ...q.args, PER_PAGE, (page - 1) * PER_PAGE);
  const counts = Object.fromEntries(db.all(`SELECT (${KIND_SQL}) k, COUNT(*) n FROM tenants t GROUP BY k`).map((r) => [r.k, r.n]));
  return { rows, total, page, pages, counts };
}
/** Export CSV de la liste filtrée (toutes les pages). */
export function clientsCsv(db, f) {
  const q = where(f);
  const rows = db.all(`SELECT t.*, u.name owner_name, u.email owner_email FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id ${q.sql} ORDER BY ${ORDER[f.sort]}`, ...q.args);
  const c = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`; const d = (x) => (x ? new Date(x).toISOString().slice(0, 10) : '');
  const head = ['Entreprise', 'Responsable', 'Métier', 'Territoire', 'Département', 'Ville', 'E-mail', 'Téléphone', 'Site', 'Inscription', 'Formule', 'Statut', 'Jours d’essai restants', 'Prochaine échéance'];
  return '﻿' + [head.map(c).join(';'), ...rows.map((t) => [t.name, t.owner_name, t.metier, TERRITORIES[territoryCode(t.country)], deptOfTenant(t)?.code, t.city, t.owner_email || t.email, t.phone ? `+${t.cc} ${t.phone}` : '', `${config.baseUrl}/s/${t.slug}`, d(t.created_at), PLANS[t.plan]?.name, STATUS[t.status], trialDaysLeft(t) ?? '', d(nextPayment(t)?.at)].map(c).join(';'))].join('\r\n');
}

/** Fiche complète d'une entreprise. */
export function clientDetail(db, id) {
  const t = db.one(`SELECT t.*, (${KIND_SQL}) kind FROM tenants t WHERE t.id=?`, id); if (!t) return null;
  const owner = db.one('SELECT id, name, email, email_verified, created_at, deleted_at FROM users WHERE id=?', t.owner_user_id);
  const c = (sql) => db.one(sql, id).n;
  return {
    t, owner, dept: deptOfTenant(t), territory: TERRITORIES[territoryCode(t.country)], country: COUNTRIES[t.country]?.fr || t.country, trialDays: trialDaysLeft(t), next: nextPayment(t),
    invoices: db.all('SELECT * FROM invoices WHERE tenant_id=? ORDER BY created_at DESC LIMIT 200', id),
    tickets: db.all('SELECT * FROM tickets WHERE tenant_id=? ORDER BY updated_at DESC LIMIT 50', id),
    history: db.all('SELECT a.action, a.detail, a.created_at, u.email FROM audit a LEFT JOIN users u ON u.id=a.user_id WHERE a.tenant_id=? ORDER BY a.id DESC LIMIT 100', id),
    emails: db.all("SELECT template, to_addr, status, created_at, sent_at FROM outbox WHERE tenant_id=? AND channel='email' ORDER BY id DESC LIMIT 30", id),
    activity: { rendezVous: c('SELECT COUNT(*) n FROM appointments WHERE tenant_id=?'), devis: c('SELECT COUNT(*) n FROM quotes WHERE tenant_id=?'), services: c('SELECT COUNT(*) n FROM services WHERE tenant_id=?'), visites30j: db.one("SELECT COALESCE(SUM(views),0) n FROM stats_daily WHERE tenant_id=? AND day>=date('now','-30 day')", id)?.n ?? 0 },
    prospect: t.prospect_id ? db.one('SELECT id, siren, name, status FROM prospects WHERE id=?', t.prospect_id) : null,
    stripeUrl: t.stripe_customer ? `https://dashboard.stripe.com/customers/${t.stripe_customer}` : null
  };
}

/**
 * Actions administratives, toutes journalisées. Aucune ne supprime de donnée ni ne touche à la facturation Stripe :
 * prolonger l'essai, suspendre ou réactiver un compte sans abonnement, classer en compte interne, note interne,
 * envoi au titulaire d'un lien de réinitialisation du mot de passe (le titulaire choisit lui-même son mot de passe).
 */
export function clientAction(db, id, action, form, { adminId, now = Date.now(), issueToken, enqueue }) {
  const t = db.one('SELECT * FROM tenants WHERE id=?', id); if (!t) throw new Error('Entreprise introuvable');
  const log = (detail) => db.run('INSERT INTO audit(user_id,tenant_id,action,detail,created_at) VALUES(?,?,?,?,?)', adminId, id, `admin.${action}`, String(detail).slice(0, 300), now);
  const subscribed = !!t.stripe_sub && ['active', 'past_due'].includes(t.status);
  switch (action) {
    case 'prolonger': {
      const days = [7, 14, 30].includes(Number(form.days)) ? Number(form.days) : 14;
      if (subscribed || !['trial', 'paused'].includes(t.status)) throw new Error('Seul un compte en essai ou en pause sans abonnement peut être prolongé.');
      const end = Math.max(now, t.trial_ends_at || 0) + days * 864e5;
      db.run("UPDATE tenants SET status='trial', trial_ends_at=? WHERE id=?", end, id); log(`essai prolongé de ${days} jours, jusqu’au ${new Date(end).toLocaleDateString('fr-FR')}`);
      return `Essai prolongé de ${days} jours (jusqu’au ${new Date(end).toLocaleDateString('fr-FR')}).`;
    }
    case 'suspendre': {
      if (subscribed) throw new Error('Compte abonné : la suspension se fait depuis Stripe (résiliation), pour ne pas facturer un site hors ligne.');
      if (!['trial'].includes(t.status)) throw new Error('Seul un compte en essai peut être suspendu ici.');
      db.run("UPDATE tenants SET status='paused' WHERE id=?", id); log(`site suspendu : ${String(form.reason || 'sans motif').slice(0, 200)}`);
      return 'Site suspendu (hors ligne). Il peut être réactivé à tout moment.';
    }
    case 'reactiver': {
      if (t.status !== 'paused' || subscribed) throw new Error('Seul un compte en pause sans abonnement peut être réactivé ici.');
      const end = Math.max(now + 864e5, t.trial_ends_at || 0);
      db.run("UPDATE tenants SET status='trial', trial_ends_at=? WHERE id=?", end, id); log(`site réactivé en essai jusqu’au ${new Date(end).toLocaleDateString('fr-FR')}`);
      return 'Site réactivé.';
    }
    case 'interne': {
      const v = form.value === '1' ? 1 : 0;
      db.run('UPDATE tenants SET internal=? WHERE id=?', v, id); log(v ? 'classé compte interne (exclu des statistiques clients)' : 'reclassé client');
      return v ? 'Classé en compte interne : exclu des statistiques clients.' : 'Reclassé parmi les clients.';
    }
    case 'note': {
      const note = String(form.note || '').slice(0, 2000);
      db.run('UPDATE tenants SET admin_note=? WHERE id=?', note, id); log('note interne modifiée');
      return 'Note enregistrée.';
    }
    case 'mdp': {
      const u = db.one('SELECT id, email, lang FROM users WHERE id=? AND deleted_at IS NULL', t.owner_user_id); if (!u) throw new Error('Titulaire introuvable');
      const tk = issueToken(db, 'reset', { userId: u.id, hours: 2 });
      enqueue(db, { channel: 'email', to: u.email, template: 'reset_password', payload: { lang: u.lang, url: `${config.baseUrl}/reinitialiser/${tk}` } });
      log('lien de réinitialisation du mot de passe envoyé au titulaire');
      return 'Lien de réinitialisation envoyé au titulaire (valable 2 heures).';
    }
    default: throw new Error('Action inconnue');
  }
}

/** Statistiques par territoire (clients réels uniquement) et séparation prospects / démonstrations / clients. */
export function territoryStats(db, now = Date.now()) {
  const month = new Date(now).toISOString().slice(0, 7); const start = Date.parse(month + '-01T00:00:00Z');
  const base = {}; for (const k of Object.keys(TERRITORIES)) base[k] = { code: k, label: TERRITORIES[k], inscritsMois: 0, inscrits: 0, essais: 0, payants: 0, impayes: 0, pause: 0, resiliesMois: 0, mrr: 0, encaisse: 0, couts: 0, benefice: 0 };
  const rows = db.all(`SELECT t.id, t.status, t.plan, t.created_at, ${TERR_SQL} terr,
      (SELECT MAX(a.created_at) FROM audit a WHERE a.tenant_id=t.id AND a.action IN ('abonnement.resilie','stripe.subscription.deleted')) canceled_at,
      (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.tenant_id=t.id AND i.status='paid' AND i.paid_at>=?) month_cents
    FROM tenants t WHERE (${KIND_SQL})='client'`, start);
  const costs = new Map((tenantCosts(db, month).rows || []).map((r) => [r.id, r.total]));
  for (const r of rows) {
    const b = base[r.terr]; b.inscrits++; if (r.created_at >= start) b.inscritsMois++;
    if (r.status === 'trial') b.essais++; if (r.status === 'active') b.payants++; if (r.status === 'past_due') b.impayes++; if (r.status === 'paused') b.pause++;
    if (r.status === 'canceled' && (r.canceled_at || 0) >= start) b.resiliesMois++;
    if (['active', 'past_due'].includes(r.status)) b.mrr += PLANS[r.plan].monthly;
    b.encaisse += r.month_cents / 100; b.couts += costs.get(r.id) || 0;
  }
  const list = Object.values(base).map((b) => ({ ...b, couts: Math.round(b.couts * 100) / 100, benefice: Math.round((b.encaisse - b.couts) * 100) / 100 }));
  const sum = (k) => Math.round(list.reduce((a, b) => a + b[k], 0) * 100) / 100;
  const totals = Object.fromEntries(['inscritsMois', 'inscrits', 'essais', 'payants', 'impayes', 'pause', 'resiliesMois', 'mrr', 'encaisse', 'couts'].map((k) => [k, sum(k)]));
  // Frais fixes non répartis (aucun client payant) : ils pèsent quand même sur le résultat
  const fixed = db.one('SELECT COALESCE(SUM(amount_cents),0) c FROM expenses WHERE month=? OR (recurring=1 AND month<=?)', month, month).c / 100;
  const assignedFixed = totals.payants + totals.impayes ? fixed : 0;
  totals.fraisNonRepartis = Math.round((fixed - assignedFixed) * 100) / 100;
  totals.benefice = Math.round((totals.encaisse - totals.couts - totals.fraisNonRepartis) * 100) / 100;
  const kinds = Object.fromEntries(db.all(`SELECT (${KIND_SQL}) k, COUNT(*) n FROM tenants t GROUP BY k`).map((r) => [r.k, r.n]));
  const prospects = db.one("SELECT COUNT(*) n, SUM(status='new') nouveaux, SUM(status IN ('contacted','demo')) encours, SUM(status='converted') convertis, SUM(status='optout') opposes FROM prospects");
  return { month, list: list.filter((b) => b.inscrits || b.code === 'GF' || b.code === 'FR'), totals, kinds, prospects };
}
