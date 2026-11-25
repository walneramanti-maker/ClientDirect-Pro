// Données de démonstration locales (jamais en production) : un garage avec un compte pro.
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createTenant } from '../src/tenants.js';

if (config.env === 'production') { console.error('Refusé en production.'); process.exit(1); }
const db = openDb(config.dbPath);
const email = 'garage@demo.local';
if (db.one('SELECT 1 FROM users WHERE email=?', email)) { console.log('Déjà initialisé.'); process.exit(0); }
const uid = Number(db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,created_at) VALUES(?,?,?,'pro',1,?)", email, hashPassword('Garage2026demo'), 'Jean Test', Date.now()).lastInsertRowid);
const t = createTenant(db, { name: 'Garage Test Cayenne', tpl: 'garage', city: 'Cayenne', phone: '0694123456', email, plan: 'premium', ownerId: uid });
console.log(`Site : ${config.baseUrl}/s/${t.slug}\nConnexion : ${email} / Garage2026demo`);
db.close();
