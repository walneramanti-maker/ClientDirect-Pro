import { sha256 } from './util.js';
import { config } from './config.js';

/** Regroupe les incidents identiques (même empreinte) au lieu de les dupliquer. */
export function recordIncident(db, { kind, severity = 'warning', message, tenantId = null }) {
  const fp = sha256(`${kind}|${tenantId ?? ''}|${String(message).replace(/\d+/g, '#').slice(0, 120)}`);
  const now = Date.now();
  const ex = db.one('SELECT id FROM incidents WHERE fingerprint=?', fp);
  if (ex) db.run('UPDATE incidents SET count=count+1, last_at=?, resolved_at=NULL, severity=? WHERE id=?', now, severity, ex.id);
  else {
    db.run('INSERT INTO incidents(fingerprint,kind,severity,message,tenant_id,first_at,last_at) VALUES(?,?,?,?,?,?,?)', fp, kind, severity, String(message).slice(0, 500), tenantId, now, now);
    // Nouvel incident critique : alerte immédiate via Make (une seule fois par incident)
    // Nouvel incident critique : e-mail immédiat à l'administrateur (en plus du résumé quotidien)
    if (severity === 'critical' && config.adminEmail && kind !== 'send_email')
      db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,next_at,created_at) VALUES(?,'email',?,'admin_alert',?,?,?)", tenantId, config.adminEmail, JSON.stringify({ kind, message: String(message).slice(0, 300), at: new Date(now).toISOString(), url: `${config.baseUrl}/admin` }), now, now);
    if (severity === 'critical' && config.makeWebhookUrl && config.makeEvents.includes('incident') && !kind.startsWith('send_make'))
      db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,next_at,created_at) VALUES(?,'make','make','incident',?,?,?)", tenantId, JSON.stringify({ kind, message: String(message).slice(0, 300) }), now, now);
  }
}
export const openIncidents = (db) => db.all('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY CASE severity WHEN \'critical\' THEN 0 WHEN \'warning\' THEN 1 ELSE 2 END, last_at DESC LIMIT 200');
export const resolveIncident = (db, id) => db.run('UPDATE incidents SET resolved_at=? WHERE id=?', Date.now(), id);
