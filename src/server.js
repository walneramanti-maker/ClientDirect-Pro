import http from 'node:http';
import { config, envProblems } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import fs from 'node:fs';
import { startScheduler } from './jobs.js';
import { restore, createBackup, remoteConfigured } from './backup.js';

const problems = envProblems();
if (problems.length) { console.error(`Configuration refusée (${config.appEnv}) :\n- ` + problems.join('\n- ')); process.exit(1); }

// Serveur neuf (disque vide) : on repart automatiquement de la dernière sauvegarde.
let restoredFrom = null;
if (config.restoreOnBoot && !fs.existsSync(config.dbPath)) {
  try { const r = await restore(config.dbPath); restoredFrom = r.restored; console.log(`Base restaurée depuis ${r.restored}`); }
  catch (e) {
    // Aucune sauvegarde : premier démarrage, on part d'une base neuve. Toute autre erreur (réseau, clé, fichier altéré) :
    // on refuse de démarrer, pour ne jamais remplacer les bonnes sauvegardes par une base vide.
    if (e.message !== 'Aucune sauvegarde disponible') { console.error(`Restauration impossible, démarrage refusé : ${e.message}`); process.exit(1); }
    console.log('Aucune sauvegarde : nouvelle base.');
  }
}
const db = openDb(config.dbPath, { appEnv: config.appEnv });
// Trace de la dernière restauration, visible dans /health (preuve que la reprise après redémarrage fonctionne)
if (restoredFrom) db.run("INSERT INTO meta(k,v) VALUES('restored_from',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", `${restoredFrom} @ ${new Date().toISOString()}`);
// Premier démarrage sans accès console (hébergement sans terminal) : création du compte administrateur depuis les variables
// ADMIN_LOGIN, ADMIN_PASSWORD et ADMIN_TOTP_SECRET, uniquement s'il n'existe encore aucun administrateur.
if (process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD && process.env.ADMIN_TOTP_SECRET && !db.one("SELECT 1 FROM users WHERE role='superadmin'")) {
  const { hashPassword } = await import('./security.js');
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES(?,?,'Administrateur','superadmin',1,?,?)", process.env.ADMIN_LOGIN.trim().toLowerCase(), hashPassword(process.env.ADMIN_PASSWORD), process.env.ADMIN_TOTP_SECRET.trim().toUpperCase(), Date.now());
  console.log('Compte administrateur créé à partir des variables d’environnement.');
}
const server = http.createServer(createApp(db));
server.headersTimeout = 20_000; server.requestTimeout = 30_000;
const stopJobs = config.disableJobs ? () => {} : startScheduler(db);
server.listen(config.port, () => console.log(`ClientDirect Pro sur ${config.baseUrl} (port ${config.port})`));
// Prospects préparés à l'avance (liens de démonstration stables)
if (process.env.PROSPECT_SEED) import('./prospect.js').then(({ seedProspects }) => seedProspects(db, process.env.PROSPECT_SEED.split(','))).then((r) => console.log('Prospects :', JSON.stringify(r))).catch((e) => console.error('Prospects :', e.message));
// Stripe (mode test) : produits, prix et webhook créés automatiquement à partir de la seule clé secrète
import('./potential.js').then(({ refreshPotentials }) => refreshPotentials(db)).then(() => import('./readiness.js')).then(({ readiness }) => { const r = readiness(db); console.log(`Préparation du lancement : ${r.done}/${r.total} — restant : ${r.items.filter((i) => !i.ok).map((i) => `${i.key} (${i.detail})`).join(' ; ')}`); }).catch((e) => console.error('Préparation :', e.message));
import('./suppression.js').then(({ cleanContacts }) => console.log('Qualité des coordonnées :', JSON.stringify(cleanContacts(db)))).catch((e) => console.error('Qualité :', e.message));
import('./netprobe.js').then(({ probeNetwork }) => probeNetwork()).then((r) => { console.log('Réseau :', JSON.stringify(r)); db.run("INSERT INTO meta(k,v) VALUES('netprobe',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify({ ...r, at: new Date().toISOString() })); }).catch((e) => console.error('Réseau :', e.message));
// Autotest de bout en bout des 3 formules (mode test Stripe, hors production) : AUTOTEST=1, au plus toutes les 6 heures
if (process.env.AUTOTEST === '1') setTimeout(() => import('./selftest.js').then(async ({ runSelfTest, selfTestAllowed }) => {
  if (!selfTestAllowed()) return console.log('Autotest : refusé (clé Stripe réelle ou production)');
  const last = db.one("SELECT MAX(created_at) at FROM audit WHERE action='job.autotest'").at || 0;
  if (Date.now() - last < 6 * 36e5) return console.log('Autotest : déjà effectué il y a moins de 6 h');
  const r = await runSelfTest(db);
  for (const f of r.formules || []) console.log(`Autotest ${f.formule} : ${f.ok ? 'RÉUSSI' : 'ÉCHEC'} — ${f.etapes.map((e) => `${e.ok ? '✓' : '✗'} ${e.etape}${e.detail ? ' (' + e.detail + ')' : ''}`).join(' ; ')}`);
}).catch((e) => console.error('Autotest :', e.message)), 25000).unref?.();
import('./billing.js').then(({ ensureStripe }) => ensureStripe(db)).then((r) => r && console.log('Stripe :', JSON.stringify(r))).catch((e) => { console.error('Stripe :', e.message); import('./incidents.js').then(({ recordIncident }) => recordIncident(db, { kind: 'stripe_setup', severity: 'warning', message: `Configuration Stripe impossible : ${String(e.message).slice(0, 160)}` })); });

// Arrêt (mise à jour, redémarrage) : dernière sauvegarde avant de fermer.
const shutdown = async () => {
  stopJobs(); setTimeout(() => process.exit(0), 25000).unref();
  if (remoteConfigured()) { try { const b = await createBackup(db); console.log(`Arrêt : sauvegarde finale envoyée (${b?.name || 'ok'})`); } catch (e) { console.error(`Arrêt : sauvegarde finale impossible : ${e.message}`); } }
  server.close(() => { db.close(); process.exit(0); });
};
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
