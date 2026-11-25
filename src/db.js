import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, pass_hash TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'pro' CHECK(role IN ('pro','superadmin')), email_verified INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT, failed_logins INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS tenants(
  id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tpl TEXT NOT NULL, metier TEXT NOT NULL,
  city TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
  cc TEXT NOT NULL DEFAULT '594', tz TEXT NOT NULL DEFAULT 'America/Cayenne', color TEXT NOT NULL DEFAULT '#ffcf33',
  lead TEXT NOT NULL DEFAULT '', faq TEXT NOT NULL DEFAULT '', obj_label TEXT NOT NULL DEFAULT 'Précision', verb TEXT NOT NULL DEFAULT 'Prendre rendez-vous',
  auto_confirm INTEGER NOT NULL DEFAULT 0, plan TEXT NOT NULL DEFAULT 'pro' CHECK(plan IN ('essentiel','pro','premium')),
  status TEXT NOT NULL DEFAULT 'trial' CHECK(status IN ('demo','trial','active','past_due','paused','canceled')),
  trial_ends_at INTEGER, current_period_end INTEGER, stripe_customer TEXT, stripe_sub TEXT,
  owner_user_id INTEGER REFERENCES users(id), prospect_id INTEGER, demo_token_hash TEXT, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS memberships(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, role TEXT NOT NULL DEFAULT 'owner', PRIMARY KEY(user_id, tenant_id))`,
`CREATE TABLE IF NOT EXISTS services(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0, dur INTEGER NOT NULL DEFAULT 30, descr TEXT NOT NULL DEFAULT '', pos INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS staff(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1)`,
`CREATE TABLE IF NOT EXISTS hours(tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, dow INTEGER NOT NULL CHECK(dow BETWEEN 0 AND 6), open TEXT NOT NULL, close TEXT NOT NULL, PRIMARY KEY(tenant_id, dow))`,
`CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, service_id INTEGER, service_name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL, time TEXT NOT NULL, start_min INTEGER NOT NULL, dur INTEGER NOT NULL, staff_id INTEGER NOT NULL, staff_name TEXT NOT NULL,
  customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','done','refused','canceled')),
  source TEXT NOT NULL DEFAULT 'site', starts_at INTEGER NOT NULL, reminded_at INTEGER, cancel_token_hash TEXT, created_at INTEGER NOT NULL)`,
`CREATE INDEX IF NOT EXISTS appt_slot ON appointments(tenant_id, date, staff_id)`,
`CREATE INDEX IF NOT EXISTS appt_remind ON appointments(status, reminded_at, starts_at)`,
`CREATE TABLE IF NOT EXISTS quotes(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, customer_email TEXT NOT NULL DEFAULT '', obj TEXT NOT NULL DEFAULT '', service TEXT NOT NULL DEFAULT '', message TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','handled','refused')), created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS sessions(id_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, totp_ok INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS tokens(id_hash TEXT PRIMARY KEY, type TEXT NOT NULL CHECK(type IN ('verify','reset','claim')), user_id INTEGER, tenant_id INTEGER, expires_at INTEGER NOT NULL, used_at INTEGER)`,
`CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY, tenant_id INTEGER, channel TEXT NOT NULL CHECK(channel IN ('email','whatsapp','make')), to_addr TEXT NOT NULL, template TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','skipped')), attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL, sent_at INTEGER)`,
`CREATE INDEX IF NOT EXISTS outbox_due ON outbox(status, next_at)`,
`CREATE TABLE IF NOT EXISTS invoices(id INTEGER PRIMARY KEY, tenant_id INTEGER REFERENCES tenants(id), stripe_invoice TEXT UNIQUE, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'eur', status TEXT NOT NULL, paid_at INTEGER, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY, label TEXT NOT NULL, amount_cents INTEGER NOT NULL, month TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'technique', recurring INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS ai_usage(tenant_id INTEGER NOT NULL, month TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, in_tokens INTEGER NOT NULL DEFAULT 0, out_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id, month))`,
`CREATE TABLE IF NOT EXISTS incidents(id INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')), message TEXT NOT NULL, tenant_id INTEGER, count INTEGER NOT NULL DEFAULT 1, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, resolved_at INTEGER)`,
`CREATE TABLE IF NOT EXISTS tickets(id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER, email TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','closed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS ticket_messages(id INTEGER PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, author TEXT NOT NULL CHECK(author IN ('client','bot','admin')), body TEXT NOT NULL, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS prospects(id INTEGER PRIMARY KEY, siren TEXT UNIQUE, siret TEXT, name TEXT NOT NULL, naf TEXT NOT NULL DEFAULT '', tpl TEXT NOT NULL DEFAULT 'garage', city TEXT NOT NULL DEFAULT '', postal TEXT NOT NULL DEFAULT '', address TEXT NOT NULL DEFAULT '',
  created_on TEXT, score INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','demo','converted','lost','optout')), notes TEXT NOT NULL DEFAULT '',
  demo_tenant_id INTEGER, demo_views INTEGER NOT NULL DEFAULT 0, last_contact_at INTEGER, created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, user_id INTEGER, tenant_id INTEGER, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL)`,
`CREATE TABLE IF NOT EXISTS chat_logs(id INTEGER PRIMARY KEY, tenant_id INTEGER NOT NULL, conv TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)`
];

// Évolutions du schéma, appliquées une seule fois et dans l'ordre (PRAGMA user_version).
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  `ALTER TABLE tenants ADD COLUMN custom_domain TEXT`,
  `ALTER TABLE tenants ADD COLUMN domain_status TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE tenants ADD COLUMN updated_at INTEGER`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tenant_domain ON tenants(custom_domain) WHERE custom_domain IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS stats_daily(tenant_id INTEGER NOT NULL, day TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, bookings INTEGER NOT NULL DEFAULT 0, quotes INTEGER NOT NULL DEFAULT 0, chats INTEGER NOT NULL DEFAULT 0, wa_clicks INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(tenant_id, day))`,
  `ALTER TABLE prospects ADD COLUMN optout_token_hash TEXT`,
  `CREATE TABLE IF NOT EXISTS backups(id INTEGER PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL)`,
  `ALTER TABLE users ADD COLUMN deleted_at INTEGER`,
  `ALTER TABLE tenants ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr'`,
  `ALTER TABLE tenants ADD COLUMN country TEXT NOT NULL DEFAULT 'GF'`,
  `ALTER TABLE tenants ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR'`,
  `ALTER TABLE users ADD COLUMN lang TEXT NOT NULL DEFAULT 'fr'`,
  `ALTER TABLE tenants ADD COLUMN example INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE prospects ADD COLUMN demo_token_hash TEXT`,
  `CREATE INDEX IF NOT EXISTS prospect_demo ON prospects(demo_token_hash)`,
  `ALTER TABLE prospects ADD COLUMN dept TEXT NOT NULL DEFAULT ''`,
  `CREATE INDEX IF NOT EXISTS prospect_dept ON prospects(dept, status)`,
  `ALTER TABLE tenants ADD COLUMN source TEXT NOT NULL DEFAULT ''`,
  `CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY, tenant_id INTEGER, user_id INTEGER, score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5), comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS visits_source(day TEXT NOT NULL, source TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(day, source))`,
  `ALTER TABLE prospects ADD COLUMN phone TEXT`,
  `ALTER TABLE prospects ADD COLUMN email TEXT`,
  `ALTER TABLE prospects ADD COLUMN website TEXT`,
  `ALTER TABLE prospects ADD COLUMN contact_source TEXT`,
  `ALTER TABLE prospects ADD COLUMN enriched_at INTEGER`,
  `ALTER TABLE prospects ADD COLUMN maps_closed INTEGER NOT NULL DEFAULT 0`,
  `CREATE INDEX IF NOT EXISTS prospect_enrich ON prospects(status, enriched_at, tpl, postal)`,
  `ALTER TABLE tenants ADD COLUMN referred_by_tenant_id INTEGER`,
  `ALTER TABLE tenants ADD COLUMN partner_id INTEGER`,
  `CREATE TABLE IF NOT EXISTS partners(id INTEGER PRIMARY KEY, name TEXT NOT NULL, company TEXT NOT NULL DEFAULT '', email TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', siret TEXT NOT NULL DEFAULT '', activity TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','stopped')), code TEXT UNIQUE, token_hash TEXT, rate_pct INTEGER NOT NULL DEFAULT 20, created_at INTEGER NOT NULL, approved_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS rewards(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('credit','credit_referee','commission')), beneficiary_tenant_id INTEGER, partner_id INTEGER, source_tenant_id INTEGER NOT NULL, invoice TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'eur', status TEXT NOT NULL CHECK(status IN ('pending','approved','paid','canceled')), available_at INTEGER NOT NULL, applied_ref TEXT, created_at INTEGER NOT NULL, updated_at INTEGER)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS reward_once ON rewards(kind, invoice, COALESCE(beneficiary_tenant_id,0), COALESCE(partner_id,0))`,
  `CREATE TABLE IF NOT EXISTS campaigns(id INTEGER PRIMARY KEY, name TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('email','sms','appel')), filters TEXT NOT NULL DEFAULT '{}', size INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','approved','canceled')), created_at INTEGER NOT NULL, approved_at INTEGER)`,
  `CREATE TABLE IF NOT EXISTS campaign_items(id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE, prospect_id INTEGER NOT NULL, to_addr TEXT, message TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','sent','skipped')), UNIQUE(campaign_id, prospect_id))`,
  `ALTER TABLE campaign_items ADD COLUMN sent_at INTEGER`,
  `ALTER TABLE campaign_items ADD COLUMN error TEXT`,
  `ALTER TABLE prospects ADD COLUMN potential INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE prospects ADD COLUMN site_status TEXT`,
  `ALTER TABLE prospects ADD COLUMN site_flags TEXT`,
  `ALTER TABLE prospects ADD COLUMN site_checked_at INTEGER`,
  `ALTER TABLE prospects ADD COLUMN osm_checked_at INTEGER`,
  `CREATE INDEX IF NOT EXISTS prospects_potential ON prospects(status, potential DESC)`,
  `CREATE TABLE IF NOT EXISTS contacts(id INTEGER PRIMARY KEY, prospect_id INTEGER NOT NULL, channel TEXT NOT NULL, outcome TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS contacts_at ON contacts(created_at)`
];

export function openDb(file, { appEnv = null } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL;');
  for (const s of SCHEMA) db.exec(s);
  const v = db.prepare('PRAGMA user_version').get().user_version;
  for (let i = v; i < MIGRATIONS.length; i++) { db.exec('BEGIN'); try { db.exec(MIGRATIONS[i]); db.exec(`PRAGMA user_version=${i + 1}`); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; } }
  // Une base créée pour un environnement ne peut pas être ouverte par un autre (évite de brancher la recette sur la production).
  if (appEnv) {
    const row = db.prepare("SELECT v FROM meta WHERE k='app_env'").get();
    if (!row) db.prepare("INSERT INTO meta(k,v) VALUES('app_env',?)").run(appEnv);
    else if (row.v !== appEnv) { db.close(); throw new Error(`Cette base appartient à l'environnement « ${row.v} », pas à « ${appEnv} ». Démarrage refusé.`); }
  }
  const cache = new Map();
  const stmt = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const norm = (r) => (r ? { ...r } : r);
  const api = {
    raw: db,
    one: (sql, ...p) => norm(stmt(sql).get(...p)),
    all: (sql, ...p) => stmt(sql).all(...p).map(norm),
    run: (sql, ...p) => stmt(sql).run(...p),
    /** Transaction exclusive : aucune autre écriture ne peut s'intercaler. */
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
    },
    file,
    close: () => db.close()
  };
  return api;
}
