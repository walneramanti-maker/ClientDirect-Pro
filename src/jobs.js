import { net } from './net.js';
import { config, PLANS, planHas } from './config.js';
import { processOutbox, enqueue, apptPayload } from './notify.js';
import { openIncidents, recordIncident } from './incidents.js';
import { loadTenant } from './tenants.js';
import { checkDomains } from './domains.js';
import { backupJob, verifyBackup, remoteConfigured } from './backup.js';
import { retentionJob } from './privacy.js';
import { previousMonth } from './stats.js';
import { money } from './markets.js';

/** Dernier passage des tâches automatiques (en mémoire : ne compte pas comme une modification des données). */
export const heartbeat = { at: 0 };
const lastRun = (db, action) => db.one('SELECT MAX(created_at) at FROM audit WHERE action=?', action).at || 0;
const mark = (db, action, now) => db.run('INSERT INTO audit(action,created_at) VALUES(?,?)', action, now);
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

/** Tâches automatiques : rappels, envois, fin d'essai, impayés, tickets, alertes. */
export async function runJobs(db, now = Date.now()) {
  if ((await import('./maintenance.js')).maintenanceOn(db)) return { maintenance: true }; // aucune écriture pendant une migration
  const r = { reminders: 0, trialNotices: 0, paused: 0, closed: 0, digest: false };
  // 1. Rappels la veille (entre 2 h et 24 h avant), une seule fois par rendez-vous
  const due = db.all("SELECT * FROM appointments WHERE status='confirmed' AND reminded_at IS NULL AND starts_at BETWEEN ? AND ?", now + 2 * 36e5, now + 24 * 36e5);
  const cache = new Map();
  for (const a of due) {
    let t = cache.get(a.tenant_id); if (!t) { t = loadTenant(db, 'id', a.tenant_id); cache.set(a.tenant_id, t); }
    // Rappels : seulement pour les formules qui les incluent (Pro, Premium)
    if (!planHas(t.plan, 'rappels')) { db.run('UPDATE appointments SET reminded_at=? WHERE id=?', now, a.id); continue; }
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
  { const toPause = db.all("SELECT t.id, t.name, t.lang, t.current_period_end, u.email FROM tenants t LEFT JOIN users u ON u.id=t.owner_user_id WHERE t.status='past_due' AND COALESCE(t.current_period_end,0) + ? < ?", config.graceDays * 864e5, now);
    r.paused = Number(db.run("UPDATE tenants SET status='paused' WHERE status='past_due' AND COALESCE(current_period_end,0) + ? < ?", config.graceDays * 864e5, now).changes);
    for (const t of toPause) if (t.email) enqueue(db, { tenantId: t.id, channel: 'email', to: t.email, template: 'site_paused', key: `pause:${t.id}:${t.current_period_end || 0}`, payload: { lang: t.lang, tenant: t.name, billingUrl: `${config.baseUrl}/pro/abonnement` } }); }
  // 3 bis. Fin de l'engagement de 12 mois (date anniversaire du premier paiement) : prévenir 30 jours avant, une fois par année
  for (const t of db.all("SELECT t.id, t.name, t.lang, u.email, MIN(i.paid_at) first FROM tenants t JOIN invoices i ON i.tenant_id=t.id AND i.status='paid' JOIN users u ON u.id=t.owner_user_id WHERE t.status IN ('active','past_due') GROUP BY t.id")) {
    const d0 = new Date(t.first); let y = 1, end;
    do { end = Date.UTC(d0.getUTCFullYear() + y, d0.getUTCMonth(), d0.getUTCDate()); y++; } while (end < now);
    if (end - now <= 30 * 864e5) enqueue(db, { tenantId: t.id, channel: 'email', to: t.email, template: 'renewal_reminder', key: `renouvellement:${t.id}:${new Date(end).toISOString().slice(0, 10)}`, payload: { lang: t.lang, tenant: t.name, renewal: new Date(end).toLocaleDateString(t.lang === 'en' ? 'en-US' : 'fr-FR', { timeZone: 'UTC' }), billingUrl: `${config.baseUrl}/pro/abonnement` } });
  }
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
  // Test de restauration à blanc une fois par jour (n'affecte pas la base en service)
  if (remoteConfigured() && now - lastRun(db, 'job.backup_verify') > 20 * 36e5) { r.backupVerify = await verifyBackup(db, { now }).catch((e) => ({ error: e.message })); console.log('Test de restauration :', JSON.stringify({ ok: r.backupVerify.ok, fichier: r.backupVerify.name, erreur: r.backupVerify.error, sauvegarde: r.backupVerify.backup, base: r.backupVerify.live })); }
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
  // 12. Prospection nationale (une fois par jour) et coordonnées (toutes les heures), aucun envoi.
  // Lancées en arrière-plan : ces tâches longues (services publics espacés) ne retardent jamais les sauvegardes.
  {
    const { runNationalCampaign, prospectDaily } = await import('./prospect.js');
    // Nouvel ordre national (tous les départements à chaque tour) : un premier passage immédiat
    const v2 = db.one("SELECT v FROM meta WHERE k='prospect_order'")?.v === 'v2';
    if (!v2) { db.run("INSERT INTO meta(k,v) VALUES('prospect_order','v2') ON CONFLICT(k) DO UPDATE SET v='v2'"); db.run("INSERT INTO meta(k,v) VALUES('prospect_cursor','0') ON CONFLICT(k) DO UPDATE SET v='0'"); }
    // Si le dernier passage a été interrompu (limite du service public) avant le quota du jour, il reprend une heure plus tard
    const lastP = db.one("SELECT detail, created_at FROM audit WHERE action='job.prospect' ORDER BY id DESC LIMIT 1");
    let lastAdded = Infinity; try { lastAdded = JSON.parse(lastP?.detail || '{}').added ?? Infinity; } catch { lastAdded = Infinity; }
    const addedToday = db.one("SELECT COUNT(*) n FROM prospects WHERE created_at > ?", now - 20 * 36e5).n;
    // Dernier passage entièrement en échec (API injoignable) : on attend 6 h au lieu de réessayer toutes les heures
    let lastAllFailed = false; try { const d = JSON.parse(lastP?.detail || '{}'); lastAllFailed = d.calls > 0 && !d.ok && d.failed >= d.calls; } catch { lastAllFailed = false; }
    // Après une panne de l'API : petite sonde toutes les 30 min (au lieu d'attendre 6 h) ; reprise dès qu'elle répond
    let cooling = lastAllFailed && now - lastP.created_at < 6 * 36e5;
    if (cooling && now - Math.max(lastP.created_at, Number(db.one("SELECT v FROM meta WHERE k='prospect_probe_at'")?.v || 0)) > 30 * 60e3) {
      db.run("INSERT INTO meta(k,v) VALUES('prospect_probe_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(now));
      const { searchSirene } = await import('./prospect.js');
      cooling = !(await searchSirene({ tpl: 'garage', departement: '973', page: 1 }).then(() => true).catch(() => false));
      if (!cooling) console.log('Prospection : API Recherche d’entreprises de nouveau joignable, reprise immédiate');
    }
    const resume = !cooling && lastP && now - lastP.created_at > 60 * 60e3 && lastAdded < prospectDaily(db) && addedToday < prospectDaily(db);
    if (prospectDaily(db) > 0 && !cooling && (!v2 || resume || now - lastRun(db, 'job.prospect') > 20 * 36e5)) r.prospect = background('prospect', () => runNationalCampaign(db, { now }), 'Prospection nationale');
    const { enrichEnabled, enrichBatch } = await import('./enrich.js');
    if ((enrichEnabled(db) || config.osmEnrich) && now - lastRun(db, 'job.enrich') > 55 * 60e3) r.enrich = background('enrich', () => enrichBatch(db, { now }), 'Coordonnées');
  }
  // 13. Parrainage et partenariat : validation des récompenses après 30 jours (une fois par jour)
  if (now - lastRun(db, 'job.rewards') > 20 * 36e5) {
    const { processRewards } = await import('./rewards.js'); const { stripe } = await import('./billing.js');
    r.rewards = await processRewards(db, { now, stripeCall: config.stripeKey ? stripe : null }).catch((e) => ({ error: e.message })); mark(db, 'job.rewards', now);
  }
  // 14 bis. Campagnes préparées en brouillon chaque jour (jamais validées ni envoyées automatiquement)
  // … et immédiatement si l'adresse du site a changé (liens de démonstration à jour, ex. passage au nom de domaine)
  const staleDraft = db.one("SELECT 1 FROM campaign_items i JOIN campaigns c ON c.id=i.campaign_id WHERE c.status='draft' AND c.name LIKE 'Préparée automatiquement%' AND ((i.message LIKE '%/demo/%' AND i.message NOT LIKE ?) OR (c.channel='email' AND i.subject IS NULL)) LIMIT 1", `%${config.baseUrl}/demo/%`)
    // … ou si aucun brouillon e-mail n'existe encore au format personnalisé (objet par métier)
    || (!db.one("SELECT 1 FROM meta WHERE k='drafts_v2'") && (db.run("INSERT OR IGNORE INTO meta(k,v) VALUES('drafts_v2','1')"), true));
  if (staleDraft || now - lastRun(db, 'job.drafts') > 20 * 36e5) { const { prepareDrafts } = await import('./campaigns.js'); r.drafts = prepareDrafts(db, now); mark(db, 'job.drafts', now); console.log('Campagnes préparées (brouillons, rien n’est envoyé) :', JSON.stringify(r.drafts)); }
  // 14. Campagnes e-mail validées : un envoi espacé par passage, seulement si l'envoi a été autorisé (CAMPAIGN_SENDING=on)
  // 14 a. Réponses aux campagnes (boîte contact@, lecture seule), toutes les 10 minutes : STOP, refus, rebonds, relances arrêtées
  if (now - lastRun(db, 'job.replies') > 10 * 60e3) {
    const { checkReplies, imapReady } = await import('./imap.js');
    if (imapReady()) { r.replies = await checkReplies(db, { now }).catch((e) => { recordIncident(db, { kind: 'campagne', severity: 'warning', message: `Lecture des réponses impossible : ${String(e.message).slice(0, 140)}` }); return { error: e.message }; }); mark(db, 'job.replies', now); }
  }
  // Les réponses sont lues AVANT tout envoi : un STOP reçu n'est jamais suivi d'une relance
  { const { sendNext } = await import('./campaigns.js'); const { imapReady } = await import('./imap.js'); r.campaign = r.replies?.error || (config.campaignSending && !imapReady()) ? { skipped: r.replies?.error ? 'réponses illisibles : envoi suspendu' : 'boîte de réception non lue : envoi suspendu' } : await sendNext(db, { now }).catch((e) => ({ error: e.message })); }
  // 14 ter. Disque presque plein : incident (alerte e-mail à l'administrateur quand les e-mails sont configurés)
  { const { diskUsage } = await import('./disk.js'); const d = diskUsage(); r.disque = d && d.utilisePct;
    if (d?.alerte) recordIncident(db, { kind: 'disk', severity: d.utilisePct >= 95 ? 'critical' : 'warning', message: `Disque de la base rempli à ${d.utilisePct} % (${d.libreMo} Mo libres) : augmenter la taille du disque dans Render` }); }
  // 14 quater. Incidents passagers résolus d'eux-mêmes (plus aucune répétition depuis 24 h) : clôturés automatiquement
  { const { autoResolveIncidents } = await import('./bootops.js'); r.incidentsClos = autoResolveIncidents(db, now); }
  // 15. Battement de cœur : prouve que les tâches automatiques tournent
  heartbeat.at = now;
  return r;
}

const runningBg = new Set();
/** Lance une tâche longue sans bloquer les autres ; une seule exécution à la fois par tâche. */
function background(name, fn, label) {
  if (runningBg.has(name)) return { enCours: true };
  runningBg.add(name);
  Promise.resolve().then(fn).then((res) => console.log(`${label} :`, JSON.stringify(res)), (e) => console.log(`${label} : erreur`, e.message)).finally(() => runningBg.delete(name));
  return { lance: true };
}
export const backgroundRunning = () => [...runningBg];

/** Dernier appel de maintien en éveil (serveur gratuit). */
export const keepAwake = { enabled: () => config.keepAwake, last: null };

export function startScheduler(db) {
  let running = false;
  const tick = async () => { if (running) return; running = true; try { await runJobs(db); } catch (e) { recordIncident(db, { kind: 'jobs', severity: 'critical', message: `Tâches automatiques en erreur : ${String(e.message).slice(0, 160)}` }); } finally { running = false; } };
  const h = setInterval(tick, config.jobsIntervalMs); h.unref?.(); setTimeout(tick, 2000).unref?.();
  let k = null;
  if (config.keepAwake) {
    const ping = async () => { try { const r = await net.fetch(`${config.baseUrl}/health?veille=1`, { headers: { 'user-agent': 'ClientDirectPro-veille' } }); const first = !keepAwake.last; keepAwake.last = { at: Date.now(), status: r.status }; if (first || r.status !== 200) console.log(`Maintien en éveil : /health → ${r.status}`); } catch (e) { keepAwake.last = { at: Date.now(), error: String(e.message).slice(0, 80) }; console.log('Maintien en éveil : échec', keepAwake.last.error); } };
    k = setInterval(ping, 10 * 60e3); k.unref?.(); setTimeout(ping, 60e3).unref?.();
  }
  return () => { clearInterval(h); if (k) clearInterval(k); };
}
