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
  log(`Diagnostic administrateur : ${JSON.stringify(d)}`);
  return d;
}
