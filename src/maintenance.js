// Mode maintenance : bloque toutes les écritures des clients (formulaires, réservations, paiements reçus) pendant une
// migration, pour qu'aucune donnée ne soit créée après la dernière sauvegarde vérifiée. Les pages restent consultables.
// Activation : bouton dans l'administration (mémorisé dans la base, donc encore actif après la restauration sur le
// nouveau disque) ou variable MAINTENANCE=1. Stripe reçoit « 503 » et renvoie ses notifications plus tard (jusqu'à 3 jours).
const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;
/** Formulaires encore autorisés : connexion (pour désactiver la maintenance) et déconnexion. */
export const MAINTENANCE_ALLOWED = new Set(['/connexion', '/connexion/2fa', '/deconnexion', '/admin/maintenance']);
export function maintenanceOn(db) { return process.env.MAINTENANCE === '1' || meta(db, 'maintenance') === '1'; }
export function setMaintenance(db, on) {
  db.run("INSERT INTO meta(k,v) VALUES('maintenance',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", on ? '1' : '0');
}
