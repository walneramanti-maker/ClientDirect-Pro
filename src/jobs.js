import { config } from './config.js';
import { processOutbox, enqueue, apptPayload } from './notify.js';
import { openIncidents, recordIncident } from './incidents.js';
import { loadTenant } from './tenants.js';
import { checkDomains } from './domains.js';
import { backupJob } from './backup.js';
import { retentionJob } from './privacy.js';
import { previousMonth } from './stats.js';
import { money } from './markets.js';

const lastRun = (db, action) => db.one('SELECT MAX(created_at) at FROM audit WHERE action=?', action).at || 0;
const mark = (db, action, now) => db.run('INSERT INTO audit(action,created_at) VALUES(?,?)', action, now);
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Tâches automatiques : rappels, envois, fin d'essai, impayés, tickets, alertes. */
export async function runJobs(db, now = Date.now()) {
  const r = { reminders: 0, trialNotices: 0, paused: 0, closed: 0, digest: false };
  // 1. Rappels la veille (entre 2 h et 24 h avant), une seule fois par rendez-vous
  const due = db.all("SELECT * FROM appointments WHERE status='confirmed' AND reminded_at IS NULL AND starts_at BETWEEN ? AND ?", now + 2 * 36e5, now + 24 * 36e5);
  const cache = new Map();
  for (const a of due) {
    let t = cache.get(a.tenant_id); if (!t) { t = loadTenant(db, 'id', a.tenant_id); cache.set(a.tenant_id, t); }
    const p = apptPayload(t, a, null);
    if (a.customer_email) enqueue(db, { tenantId: t.id, channel: 'email', to: a.customer_email, template: 'appt_reminder', payload: p });
    enqueue(db, { tenantId: t.id, channel: 'whatsapp', to: a.customer_phone, template: 'appt_reminder', payload: p });
    db.run('UPDATE appointments SET reminded_at=? WHERE id=?', now, a.id); r.reminders++;
  }
  // 2. Prévenir 3 jours avant la fin de l'essai
  for (const t of db.all("SELECT t.*, u.email owner_email FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.status='trial' AND t.trial_ends_at BETWEEN ? AND ?", now, now + 3 * 864e5)) {
    if (db.one("SELECT 1 FROM outbox WHERE tenant_id=? AND template='trial_ending'", t.id)) continue;
    enqueue(db, { tenantId: t.id, channel: 'email', to: t.owner_email, template: 'trial_ending', payload: { lang: t.lang, tenant: t.name, trialEnd: new Date(t.trial_ends_at).toLocaleDateString(t.lang === 'fr' ? 'fr-FR' : 'en-US'), billingUrl: `${config.baseUrl}/pro/abonnement` } });
    r.trialNotices++;
  }
  // 3. Impayés au-delà du délai de grâce : site en pause
  r.paused = Number(db.run("UPDATE tenants SET status='paused' WHERE status='past_due' AND COALESCE(current_period_end,0) + ? < ?", config.graceDays * 864e5, now).changes);
  // 4. Tickets répondus sans retour depuis 7 jours : fermés
  r.closed = Number(db.run("UPDATE tickets SET status='closed' WHERE status='answered' AND updated_at < ?", now - 7 * 864e5).changes);
  // 5. Envois en attente
  r.outbox = await processOutbox(db);
  // 6. Surveillance : file d'envoi bloquée
  const stuck = db.one("SELECT COUNT(*) n FROM outbox WHERE status='pending' AND next_at < ?", now - 3 * 36e5).n;
  if (stuck > 20) recordIncident(db, { kind: 'outbox', severity: 'critical', message: `${stuck} messages bloqués depuis plus de 3 heures` });
  // 7. Résumé quotidien des incidents à l'administrateur
  const last = db.one("SELECT MAX(created_at) at FROM audit WHERE action='digest'").at || 0;
  if (config.adminEmail && now - last > 20 * 36e5) {
    const inc = openIncidents(db);
    if (inc.length) { enqueue(db, { channel: 'email', to: config.adminEmail, template: 'admin_digest', payload: { count: inc.length, lines: inc.slice(0, 30).map((i) => `[${i.severity}] ${i.message} (x${i.count})`) } }); r.digest = true; }
    db.run("INSERT INTO audit(action,created_at) VALUES('digest',?)", now);
  }
  // 8. Domaines propres en attente de vérification (toutes les 10 minutes)
  if (now - lastRun(db, 'job.domains') > 10 * 60e3) { r.domains = await checkDomains(db).catch((e) => ({ error: e.message })); mark(db, 'job.domains', now); }
  // 9. Sauvegardes et surveillance de leur fraîcheur
  r.backup = await backupJob(db, now);
  // 10. RGPD : durées de conservation (une fois par jour)
  if (now - lastRun(db, 'job.retention') > 20 * 36e5) { r.retention = retentionJob(db, now); mark(db, 'job.retention', now); }
  // 11. Bilan mensuel envoyé à chaque professionnel (le 1er du mois, une seule fois)
  const ym = new Date(now).toISOString().slice(0, 7);
  if (new Date(now).getUTCDate() <= 3 && !db.one("SELECT 1 FROM audit WHERE action='job.monthly' AND detail=?", ym)) {
    let sent = 0;
    for (const row of db.all("SELECT t.id, u.email FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE t.status IN ('trial','active','past_due')")) {
      const t = loadTenant(db, 'id', row.id); const m = previousMonth(db, t, new Date(now));
      if (!m.views && !m.requests) continue;
      enqueue(db, { tenantId: t.id, channel: 'email', to: row.email, template: 'monthly_report', payload: { lang: t.lang, tenant: t.name, monthLabel: new Intl.DateTimeFormat(t.lang === 'fr' ? 'fr-FR' : 'en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(m.month + '-15T00:00:00Z')), ...m, valueLabel: money(m.value, t.currency || 'EUR', t.lang === 'fr' ? 'fr-FR' : 'en-US'), dashUrl: `${config.baseUrl}/pro` } }); sent++;
    }
    db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.monthly',?,?)", ym, now); r.monthly = sent;
  }
  // 12. Prospection nationale automatique (une fois par jour, aucun envoi)
  {
    const { runNationalCampaign, prospectDaily } = await import('./prospect.js');
    if (prospectDaily(db) > 0 && now - lastRun(db, 'job.prospect') > 20 * 36e5) r.prospect = await runNationalCampaign(db, { now }).catch((e) => ({ error: e.message }));
    // Coordonnées : par petites séries toutes les heures, dans la limite du plafond mensuel autorisé
    const { enrichEnabled, enrichBatch } = await import('./enrich.js');
    if (enrichEnabled(db) && now - lastRun(db, 'job.enrich') > 55 * 60e3) r.enrich = await enrichBatch(db, { now }).catch((e) => ({ error: e.message }));
  }
  // 13. Parrainage et partenariat : validation des récompenses après 30 jours (une fois par jour)
  if (now - lastRun(db, 'job.rewards') > 20 * 36e5) {
    const { processRewards } = await import('./rewards.js'); const { stripe } = await import('./billing.js');
    r.rewards = await processRewards(db, { now, stripeCall: config.stripeKey ? stripe : null }).catch((e) => ({ error: e.message })); mark(db, 'job.rewards', now);
  }
  // 14. Battement de cœur : prouve que les tâches automatiques tournent
  db.run("INSERT INTO meta(k,v) VALUES('jobs_heartbeat',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(now));
  return r;
}

export function startScheduler(db) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await runJobs(db); } catch (e) { recordIncident(db, { kind: 'jobs', severity: 'critical', message: `Tâches automatiques en erreur : ${String(e.message).slice(0, 160)}` }); } finally { running = false; } };
  const h = setInterval(tick, config.jobsIntervalMs); h.unref?.(); setTimeout(tick, 2000).unref?.();
  return () => clearInterval(h);
}
