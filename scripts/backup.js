// Sauvegarde immédiate (en plus des sauvegardes automatiques).
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createBackup } from '../src/backup.js';
const db = openDb(config.dbPath, { appEnv: config.appEnv });
const r = await createBackup(db); console.log(`Sauvegarde ${r.name} (${r.bytes} octets)`); db.close();
