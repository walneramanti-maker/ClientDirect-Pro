// Opérations ponctuelles d'administration au démarrage, pilotées par des variables d'environnement (hébergement sans console).
// Chacune est idempotente et journalisée ; une opération risquée refuse d'agir au moindre doute.
import { deleteTenant } from './privacy.js';

const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;
const setMeta = (db, k, v) => db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, v);
const mask = (e) => String(e || '').replace(/^(.).*(@.*)$/, '$1***$2');

/** LAUNCH_DATE=AAAA-MM-JJ (et LAUNCH_AT=horodatage ISO facultatif) : date officielle de lancement commercial. */
export function applyLaunchDate(db, env = process.env, log = console.log) {
  const d = String(env.LAUNCH_DATE || '');
  if (!d) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d))) { log(`LAUNCH_DATE ignorée (format attendu AAAA-MM-JJ) : ${d}`); return null; }
  const at = env.LAUNCH_AT && !Number.isNaN(Date.parse(env.LAUNCH_AT)) ? new Date(Date.parse(env.LAUNCH_AT)).toISOString() : null;
  if (meta(db, 'launch_date') === d && (!at || meta(db, 'launch_at') === at)) return { inchange: d };
  setMeta(db, 'launch_date', d); if (at) setMeta(db, 'launch_at', at);
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('lancement.date',?,?)", `${d}${at ? ` (${at})` : ''}`, Date.now());
  log(`Date de lancement officielle enregistrée : ${d}${at ? ` (${at})` : ''}`);
  return { date: d, at };
}

/**
 * CLOSE_TEST_ACCOUNT=<adresse du site> : supprime (anonymisation RGPD, parcours normal) UN compte de test, seulement si
 * toutes les vérifications passent : nom de test, essai gratuit, aucun lien de paiement, aucune demande d'un vrai client.
 */
export function closeTestAccount(db, env = process.env, log = console.log) {
  const slug = String(env.CLOSE_TEST_ACCOUNT || '').trim().toLowerCase();
  if (!slug) return null;
  const t = db.one('SELECT * FROM tenants WHERE slug=?', slug);
  if (!t) { log(`Compte de test « ${slug} » : introuvable (déjà supprimé ?)`); return { absent: slug }; }
  const owner = db.one('SELECT id, email FROM users WHERE id=?', t.owner_user_id);
  const counts = { rendezVous: db.one('SELECT COUNT(*) n FROM appointments WHERE tenant_id=?', t.id).n, devis: db.one('SELECT COUNT(*) n FROM quotes WHERE tenant_id=?', t.id).n, factures: db.one('SELECT COUNT(*) n FROM invoices WHERE tenant_id=?', t.id).n };
  const identite = { id: t.id, nom: t.name, site: t.slug, ville: t.city, email: mask(owner?.email), statut: t.status, formule: t.plan, origine: t.source || 'directe', cree: new Date(t.created_at).toISOString(), stripe: !!(t.stripe_customer || t.stripe_sub), ...counts };
  log(`Compte de test, identité vérifiée : ${JSON.stringify(identite)}`);
  const refus = [];
  if (!/contr[oô]le|test/i.test(t.name)) refus.push('le nom n’est pas celui d’un compte de test');
  if (t.status !== 'trial') refus.push(`statut ${t.status} (essai attendu)`);
  if (identite.stripe || counts.factures) refus.push('compte lié à un paiement');
  if (counts.rendezVous || counts.devis) refus.push('demandes de clients présentes');
  if (refus.length) { log(`Suppression REFUSÉE : ${refus.join(' ; ')}`); return { refus, identite }; }
  deleteTenant(db, t.id, owner?.id ?? null);
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('compte.test.supprime',?,?)", JSON.stringify(identite), Date.now());
  log(`Compte de test supprimé (anonymisé) : ${t.name} (${t.slug})`);
  return { supprime: identite };
}

/**
 * Diagnostic du compte administrateur (lecture seule, aucun secret journalisé) : compare la base aux variables
 * ADMIN_LOGIN / ADMIN_PASSWORD / ADMIN_TOTP_SECRET. Ne modifie rien.
 */
export function adminDiagnostic(db, env = process.env, { verifyPassword, totpCode } = {}, log = console.log) {
  const login = String(env.ADMIN_LOGIN || '').trim().toLowerCase();
  const admins = db.all("SELECT id, email, created_at, failed_logins, locked_until, deleted_at, totp_secret IS NOT NULL AND totp_secret!='' has_totp FROM users WHERE role='superadmin'");
  const same = login ? db.one('SELECT id, role, deleted_at, pass_hash, totp_secret, failed_logins, locked_until FROM users WHERE email=?', login) : null;
  const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const d = {
    variables: { ADMIN_LOGIN: !!login, ADMIN_PASSWORD: !!env.ADMIN_PASSWORD, ADMIN_TOTP_SECRET: !!env.ADMIN_TOTP_SECRET, ADMIN_LOGIN_espaces: login !== String(env.ADMIN_LOGIN || '').toLowerCase(), ADMIN_PASSWORD_espaces_debut_fin: !!env.ADMIN_PASSWORD && env.ADMIN_PASSWORD !== env.ADMIN_PASSWORD.trim() },
    administrateurs: admins.map((a) => ({ id: a.id, email: mask(a.email), cree: new Date(a.created_at).toISOString(), echecs: a.failed_logins, verrouille: a.locked_until > Date.now(), supprime: !!a.deleted_at, doubleAuth: !!a.has_totp, correspondAdminLogin: a.email === login })),
    compteAdminLogin: !same ? 'absent' : { id: same.id, role: same.role, supprime: !!same.deleted_at, echecs: same.failed_logins, verrouille: same.locked_until > Date.now(),
      motDePasseRenderCorrespond: !!(env.ADMIN_PASSWORD && verifyPassword?.(env.ADMIN_PASSWORD, same.pass_hash)),
      motDePasseRenderSansEspacesCorrespond: !!(env.ADMIN_PASSWORD && verifyPassword?.(env.ADMIN_PASSWORD.trim(), same.pass_hash)),
      cleDoubleAuthCorrespond: !!(env.ADMIN_TOTP_SECRET && same.totp_secret && totpCode?.(same.totp_secret) === totpCode?.(norm(env.ADMIN_TOTP_SECRET))) }
  };
  if (same) {
    // Historique des tentatives (7 jours) : où la connexion échoue-t-elle ? (adresses IP non journalisées)
    const since = Date.now() - 7 * 864e5; const iso = (t) => new Date(t).toISOString().slice(0, 16);
    d.tentatives = {
      echecsMotDePasse: db.all("SELECT created_at FROM audit WHERE action='connexion.echec' AND detail=? AND created_at>? ORDER BY created_at DESC LIMIT 15", login, since).map((r) => iso(r.created_at)),
      motDePasseAccepte: db.all("SELECT created_at FROM audit WHERE action='connexion' AND user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 10", same.id, since).map((r) => iso(r.created_at)),
      echecsCode2fa: db.all("SELECT created_at FROM audit WHERE action='2fa.echec' AND user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 15", same.id, since).map((r) => iso(r.created_at)),
      code2faAccepte: db.all("SELECT created_at FROM audit WHERE action='2fa.ok' AND user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 5", same.id, since).map((r) => iso(r.created_at)),
      // Autres adresses refusées (masquées) : révèle une faute de frappe dans l'adresse saisie
      autresAdressesEssayees: db.all("SELECT detail, COUNT(*) n, MAX(created_at) t FROM audit WHERE action='connexion.echec' AND detail!=? AND created_at>? GROUP BY detail ORDER BY t DESC LIMIT 10", login, since).map((r) => `${mask(r.detail)} ×${r.n} (dernier ${iso(r.t)}, ${r.detail.length} car., ${r.detail.length === login.length ? 'même longueur' : 'longueur différente'})`)
    };
  }
  d.formatCleRender = totpFormat(env.ADMIN_TOTP_SECRET); d.formatCleBase = same ? totpFormat(same.totp_secret) : null;
  log(`Diagnostic administrateur : ${JSON.stringify(d)}`);
  return d;
}

/**
 * Format d'une clé TOTP pour Google Authenticator (saisie manuelle) : Base32 RFC 4648, alphabet A–Z et 2–7 uniquement,
 * au moins 16 caractères (80 bits). Ne renvoie que des caractéristiques, jamais la clé.
 */
export function totpFormat(raw) {
  const s = String(raw ?? '');
  const compact = s.replace(/\s+/g, '').toUpperCase();
  const bad = [...compact].filter((c) => !/[A-Z2-7]/.test(c));
  const kinds = [...new Set(bad.map((c) => (/[0189]/.test(c) ? 'chiffres 0, 1, 8 ou 9' : c === '=' ? 'signe = (remplissage)' : /["'`]/.test(c) ? 'guillemets' : /[-_]/.test(c) ? 'tiret ou soulignement' : 'autre caractère')))];
  const valid = compact.length > 0 && bad.length === 0;
  return {
    longueur: compact.length, espaces: /\s/.test(s), espacesDebutFin: s !== s.trim(), minuscules: /[a-z]/.test(s),
    caracteresInvalides: bad.length, typesInvalides: kinds, bits: valid ? compact.length * 5 : null,
    longueurMultipleDe8: compact.length % 8 === 0,
    compatibleGoogleAuthenticator: valid && compact.length >= 16
  };
}
/** Clé strictement conforme (celle qu'on accepte d'enregistrer) : Base32 majuscules, 32 caractères ou plus, multiple de 8. */
export const strictTotp = (raw) => { const c = String(raw ?? '').replace(/\s+/g, ''); return /^[A-Z2-7]+$/.test(c) && c.length >= 32 && c.length % 8 === 0 ? c : null; };

/**
 * ADMIN_TOTP_SYNC=1 : aligne la clé de double authentification de l'administrateur ADMIN_LOGIN sur ADMIN_TOTP_SECRET,
 * seulement si cette clé est strictement conforme. Ne touche ni à l'identifiant ni au mot de passe ; la double
 * authentification reste obligatoire. Idempotent.
 */
export function syncAdminTotp(db, env = process.env, log = console.log) {
  if (env.ADMIN_TOTP_SYNC !== '1') return null;
  const login = String(env.ADMIN_LOGIN || '').trim().toLowerCase();
  const key = strictTotp(env.ADMIN_TOTP_SECRET);
  if (!key) { log('Clé 2FA : synchronisation REFUSÉE, ADMIN_TOTP_SECRET non conforme (Base32 A–Z/2–7, 32 caractères)'); return { refus: 'clé non conforme' }; }
  const u = db.one("SELECT id, totp_secret FROM users WHERE email=? AND role='superadmin'", login);
  if (!u) { log('Clé 2FA : synchronisation REFUSÉE, administrateur ADMIN_LOGIN introuvable'); return { refus: 'administrateur introuvable' }; }
  if (u.totp_secret === key) { log('Clé 2FA : déjà alignée sur Render'); return { inchange: true }; }
  db.run('UPDATE users SET totp_secret=? WHERE id=?', key, u.id);
  db.run("INSERT INTO audit(user_id,action,detail,created_at) VALUES(?,'2fa.cle.alignee','clé alignée sur ADMIN_TOTP_SECRET',?)", u.id, Date.now());
  log('Clé 2FA : base de production alignée sur ADMIN_TOTP_SECRET (identifiant et mot de passe inchangés)');
  return { aligne: true };
}

/** Relevé d'audit (lecture seule) : facturation, incidents ouverts, dépenses, prospection. Adresses masquées. */
export function auditReport(db, log = console.log) {
  const iso = (t) => (t ? new Date(t).toISOString().slice(0, 16) : null);
  const facturation = db.all("SELECT t.id, t.slug, t.name, t.status, t.plan, t.source, t.example, t.created_at, t.stripe_customer, t.stripe_sub, t.current_period_end, u.email FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id WHERE t.status IN ('active','past_due','canceled','paused') OR t.stripe_customer IS NOT NULL OR t.stripe_sub IS NOT NULL OR EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id=t.id)")
    .map((t) => ({ id: t.id, site: t.slug, nom: t.name, statut: t.status, formule: t.plan, origine: t.source, exemple: t.example, cree: iso(t.created_at), email: mask(t.email), client: t.stripe_customer, abonnement: t.stripe_sub, finPeriode: iso(t.current_period_end),
      factures: db.all('SELECT stripe_invoice, amount_cents, status, paid_at FROM invoices WHERE tenant_id=?', t.id).map((i) => `${i.stripe_invoice} ${i.amount_cents / 100}€ ${i.status} ${iso(i.paid_at)}`) }));
  // Comptes en essai : le titulaire est-il l'administrateur lui-même (compte interne) ? Sans afficher d'adresse.
  const admin = String(process.env.ADMIN_LOGIN || '').trim().toLowerCase();
  log(`Audit essais : ${JSON.stringify(db.all("SELECT t.id, t.slug, t.name, t.source, t.internal, t.created_at, t.trial_ends_at, u.email, u.name owner, (SELECT COUNT(*) FROM appointments a WHERE a.tenant_id=t.id) rdv, (SELECT COUNT(*) FROM quotes q WHERE q.tenant_id=t.id) devis, (SELECT COUNT(*) FROM services s WHERE s.tenant_id=t.id) services FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id WHERE t.status='trial'").map((t) => ({ id: t.id, site: t.slug, nom: t.name, origine: t.source, interne: t.internal, cree: iso(t.created_at), finEssai: iso(t.trial_ends_at), titulaireEstAdministrateur: !!admin && String(t.email || '').toLowerCase() === admin, nomCompteTest: /contr[oô]le|test|autotest/i.test(t.name + ' ' + t.slug), emailTest: /example\.(org|com)|\+(cdp|ouverture|test)/i.test(t.email || ''), rdv: t.rdv, devis: t.devis, services: t.services })))}`);
  log(`Audit facturation : ${JSON.stringify(facturation)}`);
  const inc = db.all('SELECT id, kind, severity, count, message, first_at, last_at, tenant_id FROM incidents WHERE resolved_at IS NULL ORDER BY id');
  for (let i = 0; i < inc.length; i += 8) log(`Audit incidents ${i + 1}-${Math.min(i + 8, inc.length)}/${inc.length} : ${JSON.stringify(inc.slice(i, i + 8).map((x) => ({ id: x.id, type: x.kind, gravite: x.severity, nb: x.count, premier: iso(x.first_at), dernier: iso(x.last_at), client: x.tenant_id, message: x.message.slice(0, 170) })))}`);
  log(`Audit dépenses : ${JSON.stringify(db.all('SELECT label, amount_cents, month, category, recurring FROM expenses'))}`);
  const meta = Object.fromEntries(db.all("SELECT k, v FROM meta WHERE k LIKE 'prospect%' OR k LIKE 'job.%' OR k LIKE 'national%' OR k LIKE 'enrich%'").map((r) => [r.k, /^\d{12,}$/.test(r.v) ? iso(Number(r.v)) : String(r.v).slice(0, 120)]));
  log(`Audit prospection : ${JSON.stringify({ meta, prospects: db.one('SELECT COUNT(*) n, MAX(created_at) dernier FROM prospects').n, dernierAjout: iso(db.one('SELECT MAX(created_at) t FROM prospects').t), parJour: db.all("SELECT date(created_at/1000,'unixepoch') j, COUNT(*) n FROM prospects GROUP BY j ORDER BY j DESC LIMIT 5"), audits: db.all("SELECT action, detail, created_at FROM audit WHERE action LIKE 'prospection%' ORDER BY id DESC LIMIT 5").map((a) => `${iso(a.created_at)} ${a.action} ${a.detail.slice(0, 140)}`) })}`);
}

/**
 * CLEAN_STRIPE_TEST_DATA=1 : retire les données de facturation issues du MODE TEST de Stripe, après vérification une par
 * une auprès du compte Stripe RÉEL (clé live) : seules les factures et abonnements que Stripe déclare inexistants
 * (« No such … ») sont retirés. Un vrai paiement n'est jamais touché. Le compte du client repasse en essai gratuit.
 */
export async function cleanStripeTestData(db, env = process.env, { stripeGet, liveKey, now = Date.now() } = {}, log = console.log) {
  if (env.CLEAN_STRIPE_TEST_DATA !== '1') return null;
  if (!liveKey || !stripeGet) { log('Nettoyage Stripe REFUSÉ : clé Stripe réelle (live) requise pour vérifier chaque élément'); return { refus: 'clé live absente' }; }
  const missing = async (path) => { try { await stripeGet(path); return false; } catch (e) { if (/No such|resource_missing|404/.test(e.message)) return true; throw e; } };
  const out = { facturesRetirees: [], comptesRepasseEnEssai: [], incidentsClos: 0, conserves: [] };
  for (const inv of db.all('SELECT id, tenant_id, stripe_invoice, amount_cents FROM invoices WHERE stripe_invoice IS NOT NULL')) {
    if (await missing(`invoices/${inv.stripe_invoice}`)) { db.run('DELETE FROM invoices WHERE id=?', inv.id); out.facturesRetirees.push(`${inv.stripe_invoice} (${inv.amount_cents / 100} €, compte ${inv.tenant_id})`); }
    else out.conserves.push(inv.stripe_invoice);
  }
  for (const t of db.all("SELECT id, slug, status, stripe_customer, stripe_sub FROM tenants WHERE stripe_sub IS NOT NULL OR stripe_customer IS NOT NULL")) {
    const subGone = t.stripe_sub ? await missing(`subscriptions/${t.stripe_sub}`) : true;
    const cusGone = t.stripe_customer ? await missing(`customers/${t.stripe_customer}`) : true;
    if (!subGone || !cusGone) { out.conserves.push(t.slug); continue; }
    const toTrial = ['active', 'past_due'].includes(t.status);
    db.run(`UPDATE tenants SET stripe_customer=NULL, stripe_sub=NULL, current_period_end=NULL${toTrial ? ", status='trial', trial_ends_at=?" : ''} WHERE id=?`, ...(toTrial ? [now + 14 * 864e5, t.id] : [t.id]));
    out.comptesRepasseEnEssai.push(`${t.slug} (${t.status} → ${toTrial ? 'essai gratuit 14 jours' : t.status})`);
  }
  // Notifications Stripe reçues pendant les essais en mode test (aucune entreprise associée) : sans objet en production
  out.incidentsClos = Number(db.run("UPDATE incidents SET resolved_at=? WHERE resolved_at IS NULL AND kind='billing' AND message LIKE 'Événement % sans entreprise associée' AND first_at<?", now, Date.parse('2026-11-27T00:00:00Z')).changes);
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('stripe.test.nettoye',?,?)", JSON.stringify(out), now);
  log(`Nettoyage des données de test Stripe (vérifiées auprès du compte réel) : ${JSON.stringify(out)}`);
  return out;
}

/**
 * FIXED_COSTS : dépenses fixes réelles, enregistrées comme dépenses récurrentes (idempotent, par libellé).
 * Format JSON : [{"label":"Hébergement Render","eur":6.70,"category":"technique"}]. Un montant modifié est mis à jour.
 */
export function syncFixedCosts(db, env = process.env, log = console.log, now = Date.now()) {
  if (!env.FIXED_COSTS) return null;
  let list; try { list = JSON.parse(env.FIXED_COSTS); } catch { log('FIXED_COSTS ignoré : JSON invalide'); return null; }
  const month = new Date(now).toISOString().slice(0, 7); const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const label = String(c.label || '').slice(0, 80); const cents = Math.round(Number(c.eur) * 100);
    if (!label || !(cents >= 0)) continue;
    const ex = db.one('SELECT id, amount_cents FROM expenses WHERE label=? AND recurring=1', label);
    if (!ex) { db.run('INSERT INTO expenses(label,amount_cents,month,category,recurring,created_at) VALUES(?,?,?,?,1,?)', label, cents, c.since || month, ['technique', 'commercial', 'administratif'].includes(c.category) ? c.category : 'technique', now); out.push(`${label} ajoutée`); }
    else if (ex.amount_cents !== cents) { db.run('UPDATE expenses SET amount_cents=? WHERE id=?', cents, ex.id); out.push(`${label} mise à jour`); }
  }
  if (out.length) log(`Dépenses fixes : ${out.join(' ; ')}`);
  return out;
}

/** Clôture des incidents passagers qui ne se reproduisent plus (réseau, enrichissement, prospection) depuis 24 h. */
export function autoResolveIncidents(db, now = Date.now()) {
  // Ancien format : un incident par métier et département pour une même panne réseau. Désormais une panne réseau
  // produit un seul incident « prospection_reseau » : les doublons de l'ancien format sont clos (remplacés).
  const dup = Number(db.run("UPDATE incidents SET resolved_at=? WHERE resolved_at IS NULL AND kind='prospection' AND message LIKE 'Campagne nationale (%) : fetch failed%'", now).changes);
  return dup + Number(db.run("UPDATE incidents SET resolved_at=? WHERE resolved_at IS NULL AND kind IN ('enrichissement','prospection','prospection_reseau','netprobe') AND severity!='critical' AND last_at<?", now, now - 864e5).changes);
}

/** Aperçu de la campagne e-mail préparée (pour validation) : entreprises, besoin constaté, objet. Adresses masquées. */
export function campaignPreview(db, log = console.log) {
  const c = db.one("SELECT id, name, size, status FROM campaigns WHERE channel='email' AND status IN ('draft','approved') ORDER BY id DESC LIMIT 1");
  if (!c) return log('Aperçu campagne : aucune campagne e-mail préparée');
  const rows = db.all('SELECT p.name, p.city, p.dept, p.postal, p.tpl, p.site_status, p.site_flags, p.potential, p.email, i.subject FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE i.campaign_id=? ORDER BY p.potential DESC, i.id', c.id);
  log(`Aperçu campagne ${c.id} (${c.status}, ${rows.length} entreprises) : ${JSON.stringify(rows.map((r) => ({ ...r, email: mask(r.email) })))}`);
}
