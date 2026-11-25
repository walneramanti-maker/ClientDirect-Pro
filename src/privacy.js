// RGPD : pages légales, export et suppression des données, durées de conservation, opposition à la prospection.
import { applyOptout } from './suppression.js';
import { config } from './config.js';
import { sha256, randomId, hmac } from './util.js';
import { audit } from './security.js';

/** Supprime ou anonymise ce qui dépasse les durées de conservation annoncées. */
export function retentionJob(db, now = Date.now()) {
  const custCut = now - config.retentionCustomerMonths * 30.44 * 864e5;
  const r = {
    appointments: Number(db.run("UPDATE appointments SET customer_name='(anonymisé)', customer_phone='', customer_email='', cancel_token_hash=NULL WHERE created_at < ? AND customer_name != '(anonymisé)'", custCut).changes),
    quotes: Number(db.run("UPDATE quotes SET customer_name='(anonymisé)', customer_phone='', customer_email='', message='' WHERE created_at < ? AND customer_name != '(anonymisé)'", custCut).changes),
    chats: Number(db.run('DELETE FROM chat_logs WHERE created_at < ?', now - config.retentionChatDays * 864e5).changes),
    // Prospects sans réponse : supprimés 3 ans après le dernier contact (ou l'import). Les oppositions sont conservées
    // sous forme minimale (SIREN) pour ne plus jamais les recontacter.
    prospects: Number(db.run("DELETE FROM prospects WHERE status NOT IN ('converted','optout') AND COALESCE(last_contact_at, created_at) < ?", now - config.retentionProspectMonths * 30.44 * 864e5).changes),
    sessions: Number(db.run('DELETE FROM sessions WHERE expires_at < ?', now).changes),
    tokens: Number(db.run('DELETE FROM tokens WHERE expires_at < ?', now - 30 * 864e5).changes),
    outbox: Number(db.run("UPDATE outbox SET payload='{}' WHERE status IN ('sent','skipped','failed') AND created_at < ?", now - 90 * 864e5).changes),
    audit: Number(db.run('DELETE FROM audit WHERE created_at < ?', now - 365 * 864e5).changes)
  };
  return r;
}
/** Lien « ne plus être contacté » à placer dans chaque message de prospection. */
export const stopTokenFor = (siren) => hmac(config.secret, 'stop:' + siren).slice(0, 32);
export function optoutLink(db, prospectId) {
  const p = db.one('SELECT siren FROM prospects WHERE id=?', prospectId);
  const tok = p?.siren ? stopTokenFor(p.siren) : randomId(18); db.run('UPDATE prospects SET optout_token_hash=? WHERE id=?', sha256(tok), prospectId);
  return `${config.baseUrl}/stop/${tok}`;
}
export function optout(db, token) {
  const p = db.one('SELECT id, name, siren, demo_tenant_id FROM prospects WHERE optout_token_hash=?', sha256(token || ''));
  if (!p) return null;
  db.tx(() => {
    // On ne garde que le strict nécessaire pour respecter l'opposition : SIREN + statut.
    // Liste d'opposition permanente (empreintes du SIREN, du téléphone et de l'e-mail), coordonnées effacées
    applyOptout(db, p.id, 'lien d’opposition');
    // Alerte : si la liste de démarrage PROSPECT_SEED contient ce SIREN, il faut l'en retirer
    if (config.adminEmail) db.run("INSERT INTO outbox(channel,to_addr,template,payload,next_at,created_at) VALUES('email',?,'admin_alert',?,?,?)", config.adminEmail, JSON.stringify({ kind: 'opposition', message: `Opposition à la prospection : ${p.name} (SIREN ${p.siren}). Ne plus le contacter ; retirez-le de PROSPECT_SEED s'il y figure.`, at: new Date().toISOString(), url: `${config.baseUrl}/admin/prospection?statut=optout` }), Date.now(), Date.now());
  });
  return p;
}
/** Toutes les données d'un professionnel et de son entreprise (droit d'accès et de portabilité). */
export function exportTenant(db, tenantId, userId) {
  const t = db.one('SELECT * FROM tenants WHERE id=?', tenantId);
  for (const k of ['demo_token_hash', 'stripe_sub']) delete t[k];
  const u = db.one('SELECT id, email, name, role, email_verified, created_at FROM users WHERE id=?', userId);
  const q = (sql) => db.all(sql, tenantId);
  return {
    exporte_le: new Date().toISOString(), compte: u, entreprise: t,
    prestations: q('SELECT name, price, dur, descr, active FROM services WHERE tenant_id=?'), postes: q('SELECT name, active FROM staff WHERE tenant_id=?'), horaires: q('SELECT dow, open, close FROM hours WHERE tenant_id=?'),
    rendez_vous: q('SELECT service_name, price, date, time, staff_name, customer_name, customer_phone, customer_email, status, source, created_at FROM appointments WHERE tenant_id=? ORDER BY id'),
    devis: q('SELECT customer_name, customer_phone, customer_email, obj, service, message, status, created_at FROM quotes WHERE tenant_id=? ORDER BY id'),
    factures: q('SELECT stripe_invoice, amount_cents, currency, status, paid_at FROM invoices WHERE tenant_id=?'),
    statistiques: q('SELECT day, views, bookings, quotes, chats, wa_clicks FROM stats_daily WHERE tenant_id=? ORDER BY day')
  };
}
/** Suppression définitive du compte et de l'entreprise (les factures sont conservées 10 ans, obligation comptable). */
export function deleteTenant(db, tenantId, userId, ip = '') {
  db.tx(() => {
    for (const tbl of ['appointments', 'quotes', 'services', 'staff', 'hours', 'stats_daily', 'chat_logs', 'ai_usage', 'memberships']) db.run(`DELETE FROM ${tbl} WHERE tenant_id=?`, tenantId);
    db.run('DELETE FROM outbox WHERE tenant_id=?', tenantId);
    db.run("UPDATE tenants SET status='canceled', name='(supprimé)', slug=?, phone='', email='', address='', lead='', faq='', custom_domain=NULL, domain_status='none', owner_user_id=NULL WHERE id=?", `supprime-${tenantId}-${randomId(4).toLowerCase()}`, tenantId);
    db.run('DELETE FROM sessions WHERE user_id=?', userId);
    db.run("UPDATE users SET email=?, name='', pass_hash='x', totp_secret=NULL, deleted_at=? WHERE id=?", `supprime-${userId}@invalid`, Date.now(), userId);
  });
  audit(db, { tenantId, action: 'compte.supprime', ip });
}

/**
 * Suppression TOTALE d'un compte de test (environnement de test uniquement) : site, réservations, factures de test,
 * utilisateur et client Stripe de test. Rien n'est conservé : la même adresse e-mail peut resservir.
 * Interdit en production (les vrais comptes passent par deleteTenant, qui garde les factures 10 ans).
 */
export async function purgeTestTenant(db, tenantId) {
  const { config } = await import('./config.js');
  const { isTestKey, stripe } = await import('./billing.js');
  if (config.isProd || (config.stripeKey && !isTestKey())) throw new Error('Suppression totale réservée à l’environnement de test');
  const t = db.one('SELECT * FROM tenants WHERE id=?', tenantId); if (!t) return null;
  const users = db.all('SELECT user_id id FROM memberships WHERE tenant_id=? UNION SELECT ? WHERE ? IS NOT NULL', tenantId, t.owner_user_id, t.owner_user_id).map((r) => r.id).filter(Boolean);
  // Client Stripe de test supprimé (ses abonnements de test sont résiliés avec lui)
  if (t.stripe_customer && isTestKey()) await stripe(`customers/${t.stripe_customer}`, {}, 'DELETE').catch(() => null);
  db.tx(() => {
    for (const tbl of ['appointments', 'quotes', 'services', 'staff', 'hours', 'stats_daily', 'chat_logs', 'ai_usage', 'memberships', 'outbox', 'invoices', 'feedback', 'audit']) db.run(`DELETE FROM ${tbl} WHERE tenant_id=?`, tenantId);
    db.run('DELETE FROM ticket_messages WHERE ticket_id IN (SELECT id FROM tickets WHERE tenant_id=?)', tenantId);
    db.run('DELETE FROM tickets WHERE tenant_id=?', tenantId);
    db.run('DELETE FROM rewards WHERE beneficiary_tenant_id=? OR source_tenant_id=?', tenantId, tenantId);
    db.run('UPDATE tenants SET referred_by_tenant_id=NULL WHERE referred_by_tenant_id=?', tenantId);
    db.run('UPDATE prospects SET demo_tenant_id=NULL WHERE demo_tenant_id=?', tenantId);
    db.run('DELETE FROM tenants WHERE id=?', tenantId);
    for (const u of users) {
      if (db.one('SELECT 1 FROM memberships WHERE user_id=?', u) || db.one("SELECT 1 FROM users WHERE id=? AND role IN ('admin','superadmin')", u)) continue;
      for (const tbl of ['sessions', 'tokens', 'audit', 'feedback']) db.run(`DELETE FROM ${tbl} WHERE user_id=?`, u);
      db.run('DELETE FROM users WHERE id=?', u);
    }
  });
  return { slug: t.slug, users: users.length };
}
