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
