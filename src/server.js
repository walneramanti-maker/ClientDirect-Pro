import http from 'node:http';
import { config, envProblems } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import fs from 'node:fs';
import { startScheduler } from './jobs.js';
import { restore, migrateFrom, createBackup, remoteConfigured } from './backup.js';

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
    if (process.env.MIGRATE_FROM_ENV) {
      // Premier démarrage de la production : reprise de la sauvegarde vérifiée de la recette (MIGRATE_FROM_ENV + MIGRATE_FROM_BACKUP)
      try { const m = await migrateFrom(config.dbPath, { fromEnv: process.env.MIGRATE_FROM_ENV.trim(), name: (process.env.MIGRATE_FROM_BACKUP || '').trim() }); restoredFrom = m.migrated; console.log(`Migration réussie depuis ${m.migrated} : ${JSON.stringify(m.counts)}`); }
      catch (e2) { console.error(`Migration impossible, démarrage refusé : ${e2.message}`); process.exit(1); }
    } else if (config.isProd && remoteConfigured() && process.env.FRESH_START !== '1') {
      // Production sans sauvegarde ni migration : jamais de base vide implicite (données perdues sans que personne ne le voie)
      console.error('Production : aucune sauvegarde et aucune migration configurée, démarrage refusé (FRESH_START=1 pour une base neuve volontaire).'); process.exit(1);
    } else console.log('Aucune sauvegarde : nouvelle base.');
  }
}
const db = openDb(config.dbPath, { appEnv: config.appEnv });
// Trace de la dernière restauration, visible dans /health (preuve que la reprise après redémarrage fonctionne)
if (restoredFrom) db.run("INSERT INTO meta(k,v) VALUES('restored_from',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", `${restoredFrom} @ ${new Date().toISOString()}`);
// Après une migration : première sauvegarde de l'environnement cible IMMÉDIATEMENT, avant d'accepter le trafic.
// Sans elle, un redéploiement (ou la maintenance, qui suspend les sauvegardes) laisserait l'espace de sauvegarde vide :
// le serveur suivant repartirait d'une base neuve. En cas d'échec, démarrage refusé (l'ancien serveur reste en service).
if (restoredFrom && process.env.MIGRATE_FROM_ENV && restoredFrom.startsWith(`${process.env.MIGRATE_FROM_ENV.trim()}/`) && remoteConfigured()) {
  try { const b = await createBackup(db); console.log(`Première sauvegarde « ${config.appEnv} » après migration : ${b?.name || 'ok'}`); }
  catch (e) { console.error(`Sauvegarde après migration impossible, démarrage refusé : ${e.message}`); db.close(); process.exit(1); }
}
// Opérations ponctuelles pilotées par variables (date de lancement, suppression vérifiée d'un compte de test)
{ const { applyLaunchDate, closeTestAccount } = await import('./bootops.js');
  try { applyLaunchDate(db); } catch (e) { console.error('Date de lancement :', e.message); }
  try { closeTestAccount(db); } catch (e) { console.error('Compte de test :', e.message); } }
// Premier démarrage sans accès console (hébergement sans terminal) : création du compte administrateur depuis les variables
// ADMIN_LOGIN, ADMIN_PASSWORD et ADMIN_TOTP_SECRET, uniquement s'il n'existe encore aucun administrateur.
if (process.env.ADMIN_LOGIN && process.env.ADMIN_PASSWORD && process.env.ADMIN_TOTP_SECRET && !db.one("SELECT 1 FROM users WHERE role='superadmin'")) {
  const { hashPassword } = await import('./security.js');
  db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES(?,?,'Administrateur','superadmin',1,?,?)", process.env.ADMIN_LOGIN.trim().toLowerCase(), hashPassword(process.env.ADMIN_PASSWORD), process.env.ADMIN_TOTP_SECRET.trim().toUpperCase(), Date.now());
  console.log('Compte administrateur créé à partir des variables d’environnement.');
}
import('./bootops.js').then(({ approveAutoCampaign }) => approveAutoCampaign(db)).catch((e) => console.error('Validation de campagne :', e.message));
{ const { markInternal } = await import('./bootops.js'); try { markInternal(db); } catch (e) { console.error('Comptes internes :', e.message); } }
{ const { syncFixedCosts } = await import('./bootops.js'); try { syncFixedCosts(db); } catch (e) { console.error('Dépenses fixes :', e.message); } }
if (process.env.CLEAN_STRIPE_TEST_DATA === '1') import('./bootops.js').then(async ({ cleanStripeTestData }) => { const { stripe } = await import('./billing.js'); return cleanStripeTestData(db, process.env, { stripeGet: (p) => stripe(p, null, 'GET'), liveKey: /^(sk|rk)_live_/.test(config.stripeKey || '') }); }).catch((e) => console.error('Nettoyage Stripe :', e.message));
{ const { auditReport, campaignPreview } = await import('./bootops.js'); try { auditReport(db); campaignPreview(db); } catch (e) { console.error('Audit :', e.message); } }
{ const { syncAdminTotp } = await import('./bootops.js'); try { syncAdminTotp(db); } catch (e) { console.error('Clé 2FA :', e.message); } }
{ const { adminDiagnostic } = await import('./bootops.js'); const S = await import('./security.js'); try { adminDiagnostic(db, process.env, S); } catch (e) { console.error('Diagnostic administrateur :', e.message); } }
const server = http.createServer(createApp(db));
server.headersTimeout = 20_000; server.requestTimeout = 30_000;
const stopJobs = config.disableJobs ? () => {} : startScheduler(db);
server.listen(config.port, () => console.log(`ClientDirect Pro sur ${config.baseUrl} (port ${config.port})`));
// Prospects préparés à l'avance (liens de démonstration stables)
if (process.env.PROSPECT_SEED) import('./prospect.js').then(({ seedProspects }) => seedProspects(db, process.env.PROSPECT_SEED.split(','))).then((r) => console.log('Prospects :', JSON.stringify(r))).catch((e) => console.error('Prospects :', e.message));
// Stripe (mode test) : produits, prix et webhook créés automatiquement à partir de la seule clé secrète
import('./potential.js').then(({ refreshPotentials }) => refreshPotentials(db)).then(() => import('./readiness.js')).then(({ readiness }) => { const r = readiness(db); console.log(`Préparation du lancement : ${r.done}/${r.total} — restant : ${r.items.filter((i) => !i.ok).map((i) => `${i.key} (${i.detail})`).join(' ; ')}`); }).catch((e) => console.error('Préparation :', e.message));
import('./suppression.js').then(({ cleanContacts }) => console.log('Qualité des coordonnées :', JSON.stringify(cleanContacts(db)))).catch((e) => console.error('Qualité :', e.message));
// Messagerie contact@ : test réel d'authentification SMTP et IMAP (aucun e-mail envoyé, boîte en lecture seule)
if (config.smtp.host && config.smtp.pass) import('./smtp.js').then(({ verifySmtp }) => verifySmtp(config.smtp)).then((r) => console.log(`SMTP ${config.smtp.host}:${config.smtp.port} : ${r}`)).catch((e) => console.error(`SMTP ${config.smtp.host}:${config.smtp.port} : ÉCHEC ${e.message}`));
else console.log(`SMTP : ${config.smtp.host ? 'mot de passe SMTP_PASS absent' : 'non configuré'}`);
import('./imap.js').then(async ({ fetchSince, imapReady }) => { if (!imapReady()) return console.log('IMAP : non configuré (IMAP_HOST, SMTP_USER/SMTP_PASS)'); const m = await fetchSince({ ...config.imap, max: 0 }); console.log(`IMAP ${config.imap.host}:${config.imap.port} : connexion réussie (lecture seule), ${m.length} message(s) lu(s)`); }).catch((e) => console.error(`IMAP ${config.imap.host}:${config.imap.port} : ÉCHEC ${e.message}`));
import('./netprobe.js').then(({ probeNetwork }) => probeNetwork()).then((r) => { console.log('Réseau :', JSON.stringify(r)); db.run("INSERT INTO meta(k,v) VALUES('netprobe',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify({ ...r, at: new Date().toISOString() })); }).catch((e) => console.error('Réseau :', e.message));
// Comptes de test à supprimer entièrement (PURGE_TEST_ACCOUNTS : adresses e-mail ou noms de site, séparés par des virgules)
setTimeout(() => import('./privacy.js').then(async ({ purgeTestTenant }) => {
  const keys = (process.env.PURGE_TEST_ACCOUNTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const ids = db.all("SELECT t.id FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id WHERE t.source='autotest'" + (keys.length ? ` OR LOWER(t.slug) IN (${keys.map(() => '?').join(',')}) OR LOWER(u.email) IN (${keys.map(() => '?').join(',')})` : ''), ...keys, ...keys).map((r) => r.id);
  for (const id of ids) { try { const r = await purgeTestTenant(db, id); if (r) console.log(`Compte de test supprimé entièrement : ${r.slug}`); } catch (e) { console.log('Suppression du compte de test refusée :', e.message); break; } }
}).catch((e) => console.error('Purge :', e.message)), 5000).unref?.();
// Autotest de bout en bout des 3 formules (mode test Stripe, hors production) : AUTOTEST=1, au plus toutes les 6 heures
if (process.env.AUTOTEST === '1' || process.env.AUTOTEST === 'force') setTimeout(() => import('./selftest.js').then(async ({ runSelfTest, selfTestAllowed }) => {
  if (!selfTestAllowed()) return console.log('Autotest : refusé (clé Stripe réelle ou production)');
  const last = db.one("SELECT MAX(created_at) at FROM audit WHERE action='job.autotest'").at || 0;
  if (process.env.AUTOTEST !== 'force' && Date.now() - last < 6 * 36e5) return console.log('Autotest : déjà effectué il y a moins de 6 h');
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
