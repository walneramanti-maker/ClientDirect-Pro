import crypto from 'node:crypto';
import { config, recipientAllowed } from './config.js';
import { net } from './net.js';
import { dlabel, hfr, esc, phoneFmt } from './util.js';
import { recordIncident } from './incidents.js';

// ---------- contenu des messages ----------
const MAIL = {
  appt_customer: (p) => ({ subject: p.status === 'confirmed' ? `Rendez-vous confirmé chez ${p.tenant}` : `Demande de rendez-vous chez ${p.tenant}`,
    text: `Bonjour ${p.name},\n\n${p.status === 'confirmed' ? 'Votre rendez-vous est confirmé' : 'Votre demande de rendez-vous est bien reçue, le professionnel va la confirmer'} : ${p.service}, le ${p.when}.\n\nAdresse : ${p.address}\nPour annuler : ${p.cancelUrl}\n\n${p.tenant}` }),
  appt_confirmed: (p) => ({ subject: `Rendez-vous confirmé chez ${p.tenant}`, text: `Bonjour ${p.name},\n\n${p.tenant} confirme votre rendez-vous : ${p.service}, le ${p.when}.\nAdresse : ${p.address}\nPour annuler : ${p.cancelUrl}` }),
  appt_refused: (p) => ({ subject: `Rendez-vous non disponible chez ${p.tenant}`, text: `Bonjour ${p.name},\n\n${p.tenant} ne peut pas vous recevoir le ${p.when}. Vous pouvez choisir un autre créneau : ${p.siteUrl}` }),
  appt_reminder: (p) => ({ subject: `Rappel : rendez-vous demain chez ${p.tenant}`, text: `Bonjour ${p.name},\n\nRappel de votre rendez-vous : ${p.service}, le ${p.when}.\nAdresse : ${p.address}\nPour annuler : ${p.cancelUrl}` }),
  pro_new_request: (p) => ({ subject: `Nouvelle demande : ${p.kind}`, text: `Nouvelle ${p.kind} sur votre site ${p.tenant} :\n${p.summary}\n\nGérez-la dans votre espace : ${p.dashUrl}` }),
  verify_email: (p) => ({ subject: 'Confirmez votre adresse e-mail', text: `Bonjour,\n\nConfirmez votre adresse pour activer votre espace ClientDirect Pro : ${p.url}\n\nCe lien expire dans 48 heures.` }),
  reset_password: (p) => ({ subject: 'Réinitialisation de votre mot de passe', text: `Bonjour,\n\nPour choisir un nouveau mot de passe : ${p.url}\nCe lien expire dans 2 heures. Si vous n'avez rien demandé, ignorez ce message.` }),
  welcome: (p) => ({ subject: 'Votre site est en ligne', text: `Bonjour,\n\nVotre site ${p.tenant} est en ligne : ${p.siteUrl}\nVotre espace pro : ${p.dashUrl}\nEssai gratuit jusqu'au ${p.trialEnd}.` }),
  trial_ending: (p) => ({ subject: 'Votre essai se termine bientôt', text: `Bonjour,\n\nL'essai de ${p.tenant} se termine le ${p.trialEnd}. Pour garder votre site en ligne, choisissez votre formule : ${p.billingUrl}` }),
  payment_failed: (p) => ({ subject: 'Échec du paiement de votre abonnement', text: `Bonjour,\n\nLe paiement de l'abonnement de ${p.tenant} a échoué. Mettez à jour votre moyen de paiement : ${p.billingUrl}\nSans régularisation, le site sera mis en pause après ${config.graceDays} jours.` }),
  ticket_reply: (p) => ({ subject: `Réponse à votre demande : ${p.subject}`, text: `Bonjour,\n\n${p.body}\n\nSuivi : ${p.url}` }),
  monthly_report: (p) => ({ subject: `${p.tenant} : votre site en ${p.monthLabel}`, text: `Bonjour,\n\nVoici ce que votre site vous a apporté en ${p.monthLabel} :\n- ${p.views} visites\n- ${p.requests} demandes reçues (${p.bookings} réservations, ${p.quotes} devis, ${p.wa_clicks} contacts WhatsApp)\n- ${p.confirmed} rendez-vous confirmés, pour ${p.value} € de prestations\n\nDétail dans votre espace : ${p.dashUrl}\n\nClientDirect Pro` }),
  admin_alert: (p) => ({ subject: `[ClientDirect Pro] ALERTE : ${p.message.slice(0, 80)}`, text: `Incident critique détecté le ${p.at} :\n${p.message}\n\nType : ${p.kind}\nTableau de bord : ${p.url}` }),
  admin_digest: (p) => ({ subject: `ClientDirect Pro : ${p.count} incident(s) à traiter`, text: p.lines.join('\n') })
};
// Modèles WhatsApp (à faire approuver par Meta avec ces paramètres, dans cet ordre)
const WA = {
  appt_confirmed: (p) => ({ name: config.waTplConfirm, params: [p.name, p.tenant, p.service, p.when] }),
  appt_customer: (p) => (p.status === 'confirmed' ? WA.appt_confirmed(p) : null),
  appt_reminder: (p) => ({ name: config.waTplReminder, params: [p.name, p.tenant, p.service, p.when] })
};

export function enqueue(db, { tenantId = null, channel, to, template, payload = {}, at = Date.now() }) {
  if (!to) return null;
  return Number(db.run('INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,next_at,created_at) VALUES(?,?,?,?,?,?,?)', tenantId, channel, String(to), template, JSON.stringify(payload), at, Date.now()).lastInsertRowid);
}

/** Paramètres communs d'un message lié à un rendez-vous. */
export function apptPayload(t, a, cancelToken) {
  return { tenant: t.name, name: a.customer_name, service: a.service_name, when: `${dlabel(a.date)} à ${hfr(a.time)}`, address: t.address || t.city, status: a.status,
    cancelUrl: cancelToken ? `${config.baseUrl}/annuler/${cancelToken}` : `${config.baseUrl}/s/${t.slug}`, siteUrl: `${config.baseUrl}/s/${t.slug}` };
}
/** Prévient le client (e-mail + WhatsApp) et le professionnel (e-mail) d'un nouvel événement. */
export function notifyAppointment(db, t, a, template, cancelToken) {
  const p = apptPayload(t, a, cancelToken);
  if (a.customer_email) enqueue(db, { tenantId: t.id, channel: 'email', to: a.customer_email, template, payload: p });
  if (WA[template] && WA[template](p)) enqueue(db, { tenantId: t.id, channel: 'whatsapp', to: a.customer_phone, template, payload: p });
}

async function sendEmail(to, msg) {
  if (!config.brevoKey) return { skipped: 'E-mail non configuré (BREVO_API_KEY absente)' };
  const m = /^(.*)<(.+)>$/.exec(config.mailFrom) || [null, 'ClientDirect Pro', config.mailFrom];
  const res = await net.fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST', headers: { 'api-key': config.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ sender: { name: m[1].trim(), email: m[2].trim() }, to: [{ email: to }], subject: msg.subject, textContent: msg.text })
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true };
}
/** Envoie un événement métier au webhook Make, signé (HMAC SHA-256) pour que le scénario puisse le vérifier. */
async function sendMake(event, payload) {
  if (!config.makeWebhookUrl) return { skipped: 'Make non configuré (MAKE_WEBHOOK_URL absente)' };
  const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
  const sig = config.makeWebhookSecret ? crypto.createHmac('sha256', config.makeWebhookSecret).update(body).digest('hex') : '';
  const res = await net.fetch(config.makeWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cdp-event': event, 'x-cdp-signature': sig }, body });
  if (!res.ok) throw new Error(`Make ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true };
}
/** Événements transmis à Make : inscription, rendez-vous, devis, paiement, incident critique, démo vue. */
export const EVENTS = ['inscription', 'rdv', 'devis', 'paiement_recu', 'paiement_echoue', 'incident', 'demo_vue', 'ticket'];
export function emit(db, event, payload = {}, tenantId = null) {
  if (!config.makeWebhookUrl || !EVENTS.includes(event) || !config.makeEvents.includes(event)) return null;
  return enqueue(db, { tenantId, channel: 'make', to: 'make', template: event, payload });
}
async function sendWhatsApp(to, tpl) {
  if (!config.waToken || !config.waPhoneId) return { skipped: 'WhatsApp non configuré (WHATSAPP_TOKEN absent)' };
  const res = await net.fetch(`https://graph.facebook.com/v21.0/${config.waPhoneId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${config.waToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl.name, language: { code: config.waLang }, components: [{ type: 'body', parameters: tpl.params.map((x) => ({ type: 'text', text: String(x).slice(0, 200) })) }] } })
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true };
}

/** Envoie les messages en attente. Réessaie 5 fois avec un délai croissant, puis signale un incident. */
export async function processOutbox(db, limit = 50) {
  const rows = db.all("SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT ?", Date.now(), limit);
  let sent = 0, failed = 0, skipped = 0;
  for (const r of rows) {
    const p = JSON.parse(r.payload || '{}');
    try {
      let out;
      if (r.channel !== 'make' && !recipientAllowed(r.to_addr)) { out = { skipped: `Recette : ${r.to_addr} hors liste blanche, message non envoyé` }; }
      else if (r.channel === 'make') { out = await sendMake(r.template, p); }
      else if (r.channel === 'email') { const f = MAIL[r.template]; if (!f) throw new Error('Modèle inconnu ' + r.template); out = await sendEmail(r.to_addr, f(p)); }
      else { const f = WA[r.template]; const tpl = f && f(p); if (!tpl) { out = { skipped: 'Pas de modèle WhatsApp' }; } else out = await sendWhatsApp(r.to_addr, tpl); }
      if (out.skipped) { db.run("UPDATE outbox SET status='skipped', last_error=?, attempts=attempts+1 WHERE id=?", out.skipped, r.id); skipped++; }
      else { db.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?", Date.now(), r.id); sent++; }
    } catch (e) {
      const attempts = r.attempts + 1; const dead = attempts >= 5;
      db.run('UPDATE outbox SET attempts=?, status=?, next_at=?, last_error=? WHERE id=?', attempts, dead ? 'failed' : 'pending', Date.now() + Math.min(2 ** attempts, 60) * 60e3, String(e.message).slice(0, 300), r.id);
      failed++;
      if (dead) recordIncident(db, { kind: `send_${r.channel}`, severity: 'warning', message: `Envoi ${r.channel} impossible après 5 essais : ${String(e.message).slice(0, 160)}`, tenantId: r.tenant_id });
    }
  }
  return { sent, failed, skipped };
}
export { MAIL, esc, phoneFmt };
