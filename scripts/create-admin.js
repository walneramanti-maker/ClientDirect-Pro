// Crée ou met à jour le compte super-administrateur et génère sa clé de double authentification.
// Usage : ADMIN_LOGIN=vous@exemple.fr ADMIN_PASSWORD='...' npm run create-admin
import { config } from '../src/config.js';
import { openDb } from '../src/db.js';
import { hashPassword, passwordProblem, newTotpSecret } from '../src/security.js';

const email = String(process.env.ADMIN_LOGIN || process.argv[2] || '').trim().toLowerCase();
const pw = process.env.ADMIN_PASSWORD || process.argv[3] || '';
if (!email || !pw) { console.error('Usage : ADMIN_LOGIN=email ADMIN_PASSWORD=motdepasse npm run create-admin'); process.exit(1); }
const p = passwordProblem(pw); if (p || pw.length < 14) { console.error(p || 'Le mot de passe administrateur doit faire au moins 14 caractères.'); process.exit(1); }
const db = openDb(config.dbPath);
const secret = newTotpSecret();
const u = db.one('SELECT id FROM users WHERE email=?', email);
if (u) db.run("UPDATE users SET pass_hash=?, role='superadmin', totp_secret=?, email_verified=1, failed_logins=0, locked_until=0 WHERE id=?", hashPassword(pw), secret, u.id);
else db.run("INSERT INTO users(email,pass_hash,name,role,email_verified,totp_secret,created_at) VALUES(?,?,?,'superadmin',1,?,?)", email, hashPassword(pw), 'Administrateur', secret, Date.now());
db.run('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE email=?)', email);
console.log(`Compte administrateur prêt : ${email}`);
console.log(`Clé de double authentification (à saisir dans Google Authenticator) : ${secret}`);
console.log(`Lien direct : otpauth://totp/ClientDirect%20Pro:${encodeURIComponent(email)}?secret=${secret}&issuer=ClientDirect%20Pro`);
db.close();
