// Restaure la dernière sauvegarde (ou celle donnée en argument). Arrêtez le serveur avant.
// Usage : npm run restore            -> dernière sauvegarde
//         npm run restore -- liste   -> affiche les sauvegardes disponibles
//         npm run restore -- cdp-20261125T120000Z.db.gz.enc
import { config } from '../src/config.js';
import { restore, list } from '../src/backup.js';
const arg = process.argv[2];
if (arg === 'liste') { for (const n of await list(config.dbPath)) console.log(n); process.exit(0); }
const r = await restore(config.dbPath, { name: arg || null });
console.log(`Base restaurée depuis ${r.restored} (environnement ${config.appEnv}). L'ancienne base est dans ${config.dbPath}.avant-restauration`);
