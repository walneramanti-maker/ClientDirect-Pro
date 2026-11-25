import crypto from 'node:crypto';
import { config, recipientAllowed } from './config.js';
import { t as tr, withLang, fmtDay, fmtTime } from './i18n.js';
import { net } from './net.js';
import { dlabel, hfr, esc, phoneFmt } from './util.js';
import { recordIncident } from './incidents.js';

// ---------- contenu des messages ----------
// Les textes sont traduits dans la langue enregistrée avec le message (p.lang), au moment de l'envoi.
const MAIL = {
  appt_customer: (p) => ({ subject: p.status === 'confirmed' ? tr('Rendez-vous confirmé chez {t}', { t: p.tenant }) : tr('Demande de rendez-vous chez {t}', { t: p.tenant }),
    text: `${tr('Bonjour {n},', { n: p.name })}\n\n${p.status === 'confirmed' ? tr('Votre rendez-vous est confirmé : {s}, le {w}.', { s: p.service, w: p.when }) : tr('Votre demande de rendez-vous est bien reçue, le professionnel va la confirmer : {s}, le {w}.', { s: p.service, w: p.when })}\n\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}\n\n${p.tenant}` }),
  appt_confirmed: (p) => ({ subject: tr('Rendez-vous confirmé chez {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('{t} confirme votre rendez-vous : {s}, le {w}.', { t: p.tenant, s: p.service, w: p.when })}\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}` }),
  appt_refused: (p) => ({ subject: tr('Rendez-vous non disponible chez {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('{t} ne peut pas vous recevoir le {w}. Vous pouvez choisir un autre créneau : {u}', { t: p.tenant, w: p.when, u: p.siteUrl })}` }),
  appt_reminder: (p) => ({ subject: tr('Rappel : rendez-vous demain chez {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('Rappel de votre rendez-vous : {s}, le {w}.', { s: p.service, w: p.when })}\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}` }),
  pro_new_request: (p) => ({ subject: tr('Nouvelle demande : {k}', { k: tr(p.kind) }), text: `${tr('Nouvelle demande sur votre site {t} ({k}) :', { t: p.tenant, k: tr(p.kind) })}\n${p.summary}\n\n${tr('Gérez-la dans votre espace : {u}', { u: p.dashUrl })}` }),
  verify_email: (p) => ({ subject: tr('Confirmez votre adresse e-mail'), text: `${tr('Bonjour,')}\n\n${tr('Confirmez votre adresse pour activer votre espace ClientDirect Pro : {u}', { u: p.url })}\n\n${tr('Ce lien expire dans 48 heures.')}` }),
  reset_password: (p) => ({ subject: tr('Réinitialisation de votre mot de passe'), text: `${tr('Bonjour,')}\n\n${tr('Pour choisir un nouveau mot de passe : {u}', { u: p.url })}\n${tr('Ce lien expire dans 2 heures. Si vous n’avez rien demandé, ignorez ce message.')}` }),
  welcome: (p) => ({ subject: tr('Votre site est en ligne'), text: `${tr('Bonjour,')}\n\n${tr('Votre site {t} est en ligne : {u}', { t: p.tenant, u: p.siteUrl })}\n${tr('Votre espace pro : {u}', { u: p.dashUrl })}\n${tr('Essai gratuit jusqu’au {d}.', { d: p.trialEnd })}` }),
  trial_ending: (p) => ({ subject: tr('Votre essai se termine bientôt'), text: `${tr('Bonjour,')}\n\n${tr('L’essai de {t} se termine le {d}. Pour garder votre site en ligne, choisissez votre formule : {u}', { t: p.tenant, d: p.trialEnd, u: p.billingUrl })}` }),
  payment_failed: (p) => ({ subject: tr('Échec du paiement de votre abonnement'), text: `${tr('Bonjour,')}\n\n${tr('Le paiement de l’abonnement de {t} a échoué. Mettez à jour votre moyen de paiement : {u}', { t: p.tenant, u: p.billingUrl })}\n${tr('Sans régularisation, le site sera mis en pause après {g} jours.', { g: config.graceDays })}` }),
  ticket_reply: (p) => ({ subject: tr('Réponse à votre demande : {s}', { s: p.subject }), text: `${tr('Bonjour,')}\n\n${p.body}\n\n${tr('Suivi : {u}', { u: p.url })}` }),
  monthly_report: (p) => ({ subject: tr('{t} : votre site en {m}', { t: p.tenant, m: p.monthLabel }), text: `${tr('Bonjour,')}\n\n${tr('Voici ce que votre site vous a apporté en {m} :', { m: p.monthLabel })}\n- ${tr('{v} visites', { v: p.views })}\n- ${tr('{r} demandes reçues ({b} réservations, {q} devis, {w} contacts WhatsApp)', { r: p.requests, b: p.bookings, q: p.quotes, w: p.wa_clicks })}\n- ${tr('{c} rendez-vous confirmés, pour {v} de prestations', { c: p.confirmed, v: p.valueLabel || p.value + ' €' })}\n\n${tr('Détail dans votre espace : {u}', { u: p.dashUrl })}\n\nClientDirect Pro` }),
  admin_alert: (p) => ({ subject: `[ClientDirect Pro] ALERTE : ${p.message.slice(0, 80)}`, text: `Incident critique détecté le ${p.at} :\n${p.message}\n\nType : ${p.kind}\nTableau de bord : ${p.url}` }),
  admin_digest: (p) => ({ subject: `ClientDirect Pro : ${p.count} incident(s) à traiter`, text: p.lines.join('\n') })
};
// Modèles WhatsApp (à faire approuver par Meta avec ces paramètres, dans cet ordre)
// WhatsApp : un modèle approuvé par Meta par langue (suffixe _en pour l'anglais)
const waName = (base, p) => (p.lang && p.lang !== 'fr' ? `${base}_${p.lang}` : base);
const WA = {
  appt_confirmed: (p) => ({ name: waName(config.waTplConfirm, p), lang: p.lang || config.waLang, params: [p.name, p.tenant, p.service, p.when] }),
  appt_customer: (p) => (p.status === 'confirmed' ? WA.appt_confirmed(p) : null),
  appt_reminder: (p) => ({ name: waName(config.waTplReminder, p), lang: p.lang || config.waLang, params: [p.name, p.tenant, p.service, p.when] })
};

export function enqueue(db, { tenantId = null, channel, to, template, payload = {}, at = Date.now() }) {
  if (!to) return null;
  return Number(db.run('INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,next_at,created_at) VALUES(?,?,?,?,?,?,?)', tenantId, channel, String(to), template, JSON.stringify(payload), at, Date.now()).lastInsertRowid);
}

/** Paramètres communs d'un message lié à un rendez-vous. */
export function apptPayload(t, a, cancelToken) {
  const lang = t.lang || 'fr';
  return { lang, tenant: t.name, name: a.customer_name, service: a.service_name, when: `${fmtDay(a.date, lang)} · ${fmtTime(a.time, lang)}`, address: t.address || t.city, status: a.status,
    cancelUrl: cancelToken ? `${config.baseUrl}/annuler/${cancelToken}` : `${config.baseUrl}/s/${t.slug}`, siteUrl: `${config.baseUrl}/s/${t.slug}` };
}
/** Prévient le client (e-mail + WhatsApp) et le professionnel (e-mail) d'un nouvel événement. */
export function notifyAppointment(db, t, a, template, cancelToken) {
  const p = apptPayload(t, a, cancelToken);
  if (a.customer_email) enqueue(db, { tenantId: t.id, channel: 'email', to: a.customer_email, template, payload: p });
  if (WA[template] && WA[template](p)) enqueue(db, { tenantId: t.id, channel: 'whatsapp', to: a.customer_phone, template, payload: p });
}

/** E-mail de test (administration) : vérifie Brevo ou le SMTP sans attendre une vraie alerte. */
export async function sendTestEmail(to) {
  return sendEmail(to, { subject: 'ClientDirect Pro : test des alertes', text: `Ceci est un e-mail de test envoyé le ${new Date().toLocaleString('fr-FR', { timeZone: 'America/Cayenne' })} (heure de Guyane).\n\nSi vous le recevez, les alertes techniques (sauvegarde échouée, panne, paiement) et les e-mails transactionnels fonctionnent.\n\n${config.baseUrl}/admin/pret` });
}
async function sendEmail(to, msg) {
  if (!config.brevoKey) {
    // Repli gratuit : la messagerie professionnelle (SMTP) si elle est configurée
    if (config.smtp?.host) { const { sendMail, buildMessage } = await import('./smtp.js'); const S = config.smtp; await sendMail({ ...S, to, data: buildMessage({ from: S.from, fromName: 'ClientDirect Pro', to, subject: msg.subject, text: msg.text }) }); return { ok: true, via: 'smtp' }; }
    return { skipped: 'E-mail non configuré (BREVO_API_KEY ou SMTP absents)' };
  }
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
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl.name, language: { code: tpl.lang || config.waLang }, components: [{ type: 'body', parameters: tpl.params.map((x) => ({ type: 'text', text: String(x).slice(0, 200) })) }] } })
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
      else if (r.channel === 'email') { const f = MAIL[r.template]; if (!f) throw new Error('Modèle inconnu ' + r.template); out = await sendEmail(r.to_addr, withLang(p.lang || 'fr', () => f(p))); }
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
