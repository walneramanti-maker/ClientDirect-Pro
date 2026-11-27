import crypto from 'node:crypto';
import { config, recipientAllowed } from './config.js';
import { t as tr, withLang, fmtDay, fmtTime } from './i18n.js';
import { net } from './net.js';
import { dlabel, hfr, esc, phoneFmt } from './util.js';
import { e164Ok } from './phone.js';
import { recordIncident } from './incidents.js';
import { apptCancelToken } from './booking.js';

// ---------- contenu des messages ----------
// Les textes sont traduits dans la langue enregistrée avec le message (p.lang), au moment de l'envoi.
const MAIL = {
  appt_customer: (p) => ({ subject: p.status === 'confirmed' ? tr('Rendez-vous confirmé chez {t}', { t: p.tenant }) : tr('Demande de rendez-vous chez {t}', { t: p.tenant }),
    text: `${tr('Bonjour {n},', { n: p.name })}\n\n${p.status === 'confirmed' ? tr('Votre rendez-vous est confirmé : {s}, le {w}.', { s: p.service, w: p.when }) : tr('Votre demande de rendez-vous est bien reçue, le professionnel va la confirmer : {s}, le {w}.', { s: p.service, w: p.when })}\n\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}\n\n${p.tenant}` }),
  appt_confirmed: (p) => ({ subject: tr('Rendez-vous confirmé chez {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('{t} confirme votre rendez-vous : {s}, le {w}.', { t: p.tenant, s: p.service, w: p.when })}\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}` }),
  appt_refused: (p) => ({ subject: tr('Rendez-vous non disponible chez {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('{t} ne peut pas vous recevoir le {w}. Vous pouvez choisir un autre créneau : {u}', { t: p.tenant, w: p.when, u: p.siteUrl })}` }),
  appt_reminder: (p) => ({ subject: tr('Rappel : votre rendez-vous du {w} chez {t}', { w: p.when, t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('Rappel de votre rendez-vous : {s}, le {w}.', { s: p.service, w: p.when })}\n${tr('Adresse : {a}', { a: p.address })}\n${tr('Pour annuler : {u}', { u: p.cancelUrl })}` }),
  quote_ack: (p) => ({ subject: tr('Votre demande de devis à {t}', { t: p.tenant }), text: `${tr('Bonjour {n},', { n: p.name })}\n\n${tr('{t} a bien reçu votre demande de devis ({s}) et vous recontacte rapidement.', { t: p.tenant, s: p.service || tr('demande') })}\n${p.phone ? tr('Pour toute précision : {p}', { p: p.phone }) : ''}` }),
  pro_new_request: (p) => ({ subject: tr('Nouvelle demande : {k}', { k: tr(p.kind) }), text: `${tr('Nouvelle demande sur votre site {t} ({k}) :', { t: p.tenant, k: tr(p.kind) })}\n${p.summary}\n\n${tr('Gérez-la dans votre espace : {u}', { u: p.dashUrl })}` }),
  verify_email: (p) => ({ subject: tr('Confirmez votre adresse e-mail'), text: `${tr('Bonjour,')}\n\n${tr('Confirmez votre adresse pour activer votre espace ClientDirect Pro : {u}', { u: p.url })}\n\n${tr('Ce lien expire dans 48 heures.')}` }),
  reset_password: (p) => ({ subject: tr('Réinitialisation de votre mot de passe'), text: `${tr('Bonjour,')}\n\n${tr('Pour choisir un nouveau mot de passe : {u}', { u: p.url })}\n${tr('Ce lien expire dans 2 heures. Si vous n’avez rien demandé, ignorez ce message.')}` }),
  welcome: (p) => ({ subject: tr('Votre site est en ligne'), text: `${tr('Bonjour,')}\n\n${tr('Votre site {t} est en ligne : {u}', { t: p.tenant, u: p.siteUrl })}\n${tr('Votre espace pro : {u}', { u: p.dashUrl })}\n${tr('Essai gratuit jusqu’au {d}.', { d: p.trialEnd })}` }),
  trial_ending: (p) => ({ subject: tr('Votre essai se termine bientôt'), text: `${tr('Bonjour,')}\n\n${tr('L’essai de {t} se termine le {d}. Pour garder votre site en ligne, choisissez votre formule : {u}', { t: p.tenant, d: p.trialEnd, u: p.billingUrl })}` }),
  trial_ended: (p) => ({ subject: tr('Votre essai est terminé : votre site est hors ligne'), text: `${tr('Bonjour,')}\n\n${tr('L’essai gratuit de {t} est terminé et le site n’est plus visible. Vos réglages, prestations et demandes sont conservés : choisissez votre formule pour le remettre en ligne immédiatement : {u}', { t: p.tenant, u: p.billingUrl })}\n${tr('Une question ? Répondez simplement à cet e-mail.')}` }),
  payment_failed: (p) => ({ subject: tr('Échec du paiement de votre abonnement'), text: `${tr('Bonjour,')}\n\n${tr('Le paiement de l’abonnement de {t} a échoué. Mettez à jour votre moyen de paiement : {u}', { t: p.tenant, u: p.billingUrl })}\n${tr('Sans régularisation, le site sera mis en pause après {g} jours.', { g: config.graceDays })}` }),
  ticket_reply: (p) => ({ subject: tr('Réponse à votre demande : {s}', { s: p.subject }), text: `${tr('Bonjour,')}\n\n${p.body}\n\n${tr('Suivi : {u}', { u: p.url })}` }),
  monthly_report: (p) => ({ subject: tr('{t} : votre site en {m}', { t: p.tenant, m: p.monthLabel }), text: `${tr('Bonjour,')}\n\n${tr('Voici ce que votre site vous a apporté en {m} :', { m: p.monthLabel })}\n- ${tr('{v} visites', { v: p.views })}\n- ${tr('{r} demandes reçues ({b} réservations, {q} devis, {w} contacts WhatsApp)', { r: p.requests, b: p.bookings, q: p.quotes, w: p.wa_clicks })}\n- ${tr('{c} rendez-vous confirmés, pour {v} de prestations', { c: p.confirmed, v: p.valueLabel || p.value + ' €' })}\n\n${tr('Détail dans votre espace : {u}', { u: p.dashUrl })}\n\nClientDirect Pro` }),
  subscription_confirmed: (p) => ({ subject: tr('Votre abonnement {f} est actif', { f: p.plan }), text: `${tr('Bonjour,')}\n\n${tr('Merci ! L’abonnement {f} de {t} est actif. Votre site reste en ligne sans interruption.', { f: p.plan, t: p.tenant })}\n${tr('Factures et moyen de paiement : {u}', { u: p.billingUrl })}` }),
  payment_receipt: (p) => ({ subject: tr('Paiement reçu : {m}', { m: p.amount }), text: `${tr('Bonjour,')}\n\n${tr('Nous avons bien reçu votre paiement de {m} pour {t}.', { m: p.amount, t: p.tenant })}${p.invoiceUrl ? `\n${tr('Votre facture : {u}', { u: p.invoiceUrl })}` : ''}\n${tr('Factures et moyen de paiement : {u}', { u: p.billingUrl })}` }),
  subscription_canceled: (p) => ({ subject: tr('Votre abonnement est résilié'), text: `${tr('Bonjour,')}\n\n${tr('L’abonnement de {t} est résilié. Vos données restent disponibles ; vous pouvez reprendre une formule à tout moment : {u}', { t: p.tenant, u: p.billingUrl })}` }),
  renewal_reminder: (p) => ({ subject: tr('Votre engagement se renouvelle le {d}', { d: p.renewal }), text: `${tr('Bonjour,')}\n\n${tr('La période d’engagement de 12 mois de {t} se termine le {d}. Sans action de votre part, l’abonnement se poursuit aux mêmes conditions.', { t: p.tenant, d: p.renewal })}\n${tr('Gérer votre abonnement : {u}', { u: p.billingUrl })}` }),
  site_paused: (p) => ({ subject: tr('Votre site est en pause'), text: `${tr('Bonjour,')}\n\n${tr('Le paiement de l’abonnement de {t} n’a pas été régularisé : le site est en pause. Il revient en ligne dès le paiement : {u}', { t: p.tenant, u: p.billingUrl })}` }),
  admin_new_signup: (p) => ({ subject: `[ClientDirect Pro] Nouvelle inscription : ${p.tenant}`, text: `Nouvelle inscription le ${p.at} :\n${p.tenant} (${p.metier}, ${p.city}), formule ${p.plan}, origine ${p.source || 'directe'}.\nSite : ${p.siteUrl}\nAdministration : ${p.adminUrl}` }),
  admin_prospect_reply: (p) => ({ subject: `[ClientDirect Pro] Réponse de ${p.prospect}`, text: `${p.prospect} (${p.city}, ${p.email}) a répondu à la campagne.\n${p.issue}\n\nDébut de la réponse :\n${p.extract}\n\nLe message complet est dans la boîte contact@. Prospection : ${p.url}` }),
  admin_alert: (p) => ({ subject: `[ClientDirect Pro] ALERTE : ${p.message.slice(0, 80)}`, text: `Incident critique détecté le ${p.at} :\n${p.message}\n\nType : ${p.kind}\nTableau de bord : ${p.url}` }),
  admin_digest: (p) => ({ subject: `ClientDirect Pro : ${p.count} incident(s) à traiter`, text: p.lines.join('\n') })
};
// Modèles WhatsApp (à faire approuver par Meta avec ces paramètres, dans cet ordre)
// WhatsApp : un modèle approuvé par Meta par langue (suffixe _en pour l'anglais)
const waName = (base, p) => (p.lang && p.lang !== 'fr' ? `${base}_${p.lang}` : base);
export const WA = {
  appt_confirmed: (p) => ({ name: waName(config.waTplConfirm, p), lang: p.lang || config.waLang, params: [p.name, p.tenant, p.service, p.when] }),
  appt_customer: (p) => (p.status === 'confirmed' ? WA.appt_confirmed(p) : null),
  appt_reminder: (p) => ({ name: waName(config.waTplReminder, p), lang: p.lang || config.waLang, params: [p.name, p.tenant, p.service, p.when] })
};

/**
 * Met un message en file d'envoi. `key` (facultatif) rend l'envoi unique : un second message avec la même clé est ignoré
 * (ex. un reçu par facture Stripe, même si l'événement est reçu deux fois). Renvoie l'identifiant, ou null si doublon.
 */
export function enqueue(db, { tenantId = null, channel, to, template, payload = {}, at = Date.now(), key = null }) {
  if (!to) return null;
  const r = db.run('INSERT OR IGNORE INTO outbox(tenant_id,channel,to_addr,template,payload,next_at,created_at,dedup_key) VALUES(?,?,?,?,?,?,?,?)', tenantId, channel, String(to), template, JSON.stringify(payload), at, Date.now(), key);
  return r.changes ? Number(r.lastInsertRowid) : null;
}

/** Paramètres communs d'un message lié à un rendez-vous. */
export function apptPayload(t, a, cancelToken) {
  const lang = t.lang || 'fr';
  return { lang, tenant: t.name, replyTo: t.email || '', color: t.color || '', name: a.customer_name, service: a.service_name, when: `${fmtDay(a.date, lang)} · ${fmtTime(a.time, lang)}`, address: t.address || t.city, status: a.status,
    cancelUrl: `${config.baseUrl}/annuler/${cancelToken || apptCancelToken(a.id)}`, siteUrl: `${config.baseUrl}/s/${t.slug}` };
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
  const replyTo = msg.replyTo || config.mailReplyTo;
  const body = { sender: { name: (msg.fromName || m[1].trim()).slice(0, 70), email: m[2].trim() }, to: [{ email: to }], subject: msg.subject, textContent: msg.text, htmlContent: msg.html || htmlEmail(msg),
    ...(replyTo ? { replyTo: { email: replyTo } } : {}), tags: [msg.tag || 'transactionnel'] };
  let res;
  try { res = await net.fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': config.brevoKey, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
  catch (e) { throw Object.assign(new Error(`Brevo injoignable : ${e.message}`), { retry: 'panne' }); }
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 200);
    // 429 : débit ou quota ; 401/403 : clé refusée ; 5xx : panne. Aucun de ces cas ne consomme d'essai définitivement.
    const kind = res.status === 429 || /limit|quota|credits/i.test(txt) ? 'quota' : res.status === 401 || res.status === 403 ? 'cle' : res.status >= 500 ? 'panne' : null;
    throw Object.assign(new Error(`Brevo ${res.status}: ${txt}`), { retry: kind });
  }
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
/** Dépense WhatsApp estimée du mois (messages réellement envoyés × tarif Meta du pays), toutes entreprises confondues. */
export function waSpentEur(db, now = Date.now()) {
  const d = new Date(now); const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const rows = db.all("SELECT to_addr FROM outbox WHERE channel='whatsapp' AND status='sent' AND created_at>=?", start);
  const C = config.costs.waByCc; return rows.reduce((a, r) => a + (String(r.to_addr).replace(/^\+/, '').startsWith('594') ? C['594'] : String(r.to_addr).replace(/^\+/, '').startsWith('33') ? C['33'] : C.default), 0);
}
function waBudgetAlert(db) {
  const k = `wa_budget_alert_${new Date().toISOString().slice(0, 7)}`; if (db.one('SELECT 1 FROM meta WHERE k=?', k)) return;
  db.run('INSERT OR IGNORE INTO meta(k,v) VALUES(?,?)', k, String(Date.now()));
  recordIncident(db, { kind: 'whatsapp', severity: 'critical', message: `Plafond mensuel WhatsApp atteint (${config.waMonthlyBudgetEur} €) : confirmations et rappels par e-mail seulement jusqu'au mois prochain. Relevez WA_MONTHLY_BUDGET_EUR pour continuer.` });
}
export async function sendWhatsApp(to, tpl) {
  // Destinataire au format E.164 (chiffres seuls) : un numéro incomplet n'est jamais envoyé à WhatsApp
  if (!e164Ok(String(to || '').replace(/^\+/, ''))) return { skipped: 'Numéro WhatsApp invalide (format international attendu)' };
  to = String(to).replace(/^\+/, '');
  if (!config.waToken || !config.waPhoneId) return { skipped: 'WhatsApp non configuré (WHATSAPP_TOKEN absent)' };
  const res = await net.fetch(`https://graph.facebook.com/v21.0/${config.waPhoneId}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${config.waToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: tpl.name, language: { code: tpl.lang || config.waLang }, components: [{ type: 'body', parameters: tpl.params.map((x) => ({ type: 'text', text: String(x).slice(0, 200) })) }] } })
  });
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { ok: true };
}

/** Envoie les messages en attente. Réessaie 5 fois avec un délai croissant, puis signale un incident. */
/** Exemples de contenu pour l'aperçu des modèles (administration) : rien n'est envoyé. */
export function sampleEmails() {
  const u = config.baseUrl; const tenant = 'Garage Exemple'; const base = { lang: 'fr', tenant, billingUrl: `${u}/pro/abonnement` };
  const appt = { ...base, name: 'Marie', service: 'Vidange et filtres', when: 'ven. 27/11 · 9h', address: '12 rue des Palmistes, Kourou', status: 'confirmed', cancelUrl: `${u}/annuler/exemple`, siteUrl: `${u}/s/exemple`, replyTo: 'garage@exemple.fr', color: '#c81e1e' };
  return {
    verify_email: { ...base, url: `${u}/verifier/exemple` }, reset_password: { ...base, url: `${u}/mot-de-passe/exemple` },
    welcome: { ...base, siteUrl: `${u}/s/exemple`, dashUrl: `${u}/pro`, trialEnd: '10/12/2026' }, trial_ending: { ...base, trialEnd: '10/12/2026' }, trial_ended: { ...base },
    subscription_confirmed: { ...base, plan: 'Pro' }, payment_receipt: { ...base, amount: '548 €', invoiceUrl: '' }, payment_failed: base,
    site_paused: base, renewal_reminder: { ...base, renewal: '26/11/2027' }, subscription_canceled: base,
    appt_customer: appt, appt_confirmed: appt, appt_refused: appt, appt_reminder: appt, quote_ack: { ...appt, service: 'Remplacement embrayage', phone: '+594 694 12 34 56' },
    pro_new_request: { ...base, kind: 'demande de devis', summary: 'Marie (+594 694 11 22 33) · Vidange · Clio 2019', dashUrl: `${u}/pro` },
    monthly_report: { ...base, monthLabel: 'novembre 2026', views: 312, requests: 14, bookings: 9, quotes: 4, wa_clicks: 11, dashUrl: `${u}/pro` },
    ticket_reply: { ...base, subject: 'Changer mes horaires', body: 'Bonjour, c’est fait : vos nouveaux horaires sont en ligne.', url: `${u}/pro/aide` },
    admin_new_signup: { tenant, metier: 'Garage', city: 'Kourou', plan: 'pro', source: 'direct', at: '26/11/2026 14:30 (Guyane)', siteUrl: `${u}/s/exemple`, adminUrl: `${u}/admin` },
    admin_prospect_reply: { prospect: 'GARAGE EXEMPLE', city: 'Kourou', email: 'contact@garage-exemple.fr', issue: 'Relances arrêtées : répondez-lui personnellement depuis contact@.', extract: 'Bonjour, ça m’intéresse, pouvez-vous m’appeler ?', url: `${u}/admin/prospection` },
    admin_alert: { message: 'Sauvegarde impossible (exemple)', kind: 'backup', at: '26/11/2026 14:30', url: `${u}/admin` },
    admin_digest: { count: 2, lines: ['Exemple : sauvegarde en retard', 'Exemple : envoi WhatsApp refusé'] }
  };
}
/** E-mails envoyés au nom d'un professionnel à SES clients : son nom en expéditeur, réponses vers lui. */
const CUSTOMER_FACING = new Set(['appt_customer', 'appt_confirmed', 'appt_refused', 'appt_reminder', 'quote_ack']);
/** Construit le message final (texte + HTML, expéditeur affiché, adresse de réponse) dans la langue du destinataire. */
export function renderEmail(template, p) {
  const f = MAIL[template]; if (!f) throw new Error('Modèle inconnu ' + template);
  const msg = withLang(p.lang || 'fr', () => f(p));
  const pro = CUSTOMER_FACING.has(template);
  return { ...msg, tag: template, fromName: pro && p.tenant ? `${p.tenant} via ClientDirect Pro` : undefined, replyTo: pro ? (p.replyTo || '') : undefined,
    html: htmlEmail({ ...msg, brand: pro ? p.tenant : 'ClientDirect Pro', color: pro && /^#[0-9a-f]{6}$/i.test(p.color || '') ? p.color : '#14161a', lang: p.lang || 'fr' }) };
}
/** Mise en page HTML sobre, lisible sur téléphone (une colonne, 560 px max), liens en boutons, pied de page légal. */
export function htmlEmail({ subject, text, brand = 'ClientDirect Pro', color = '#14161a', lang = 'fr' }) {
  // Texte lisible sur la couleur du professionnel : foncé sur une couleur claire (ex. jaune par défaut), blanc sinon
  const lum = (() => { const m = /^#([0-9a-f]{6})$/i.exec(color); if (!m) return 0; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; })();
  const ink = lum > 0.6 ? '#14161a' : '#ffffff';
  const URL_RE = /(https?:\/\/[^\s<>"')]+)/g;
  const line = (l) => {
    const m = /^(.*?)\s*:?\s*(https?:\/\/\S+)\s*$/.exec(l);
    if (m && m[2].length > 8) return `${m[1] ? `<p style="margin:16px 0 8px">${esc(m[1].replace(/\s*:$/, ''))}</p>` : ''}<p style="margin:0 0 16px"><a href="${esc(m[2])}" style="display:inline-block;background:${color};color:${ink};text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">${esc(lang === 'en' ? 'Open' : 'Ouvrir')}</a><br><span style="font-size:12px;color:#6b7280;word-break:break-all">${esc(m[2])}</span></p>`;
    return l.trim() ? `<p style="margin:0 0 12px">${esc(l).replace(URL_RE, (u) => `<a href="${u}" style="color:${color}">${u}</a>`)}</p>` : '';
  };
  const L = config.legal;
  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14161a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:${color};color:${ink};padding:18px 24px;font-size:18px;font-weight:800">${esc(brand)}</td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5">${String(text || '').split('\n').map(line).join('')}</td></tr>
<tr><td style="padding:16px 24px;background:#fafafa;font-size:12px;line-height:1.5;color:#6b7280">${esc(brand !== 'ClientDirect Pro' ? (lang === 'en' ? `Message sent by ${brand} via ClientDirect Pro.` : `Message envoyé par ${brand} via ClientDirect Pro.`) : 'ClientDirect Pro')}<br>${esc(L.name)}${L.email ? ` · <a href="mailto:${esc(L.email)}" style="color:#6b7280">${esc(L.email)}</a>` : ''} · <a href="${esc(config.baseUrl)}" style="color:#6b7280">${esc(config.baseUrl.replace(/^https?:\/\//, ''))}</a></td></tr>
</table></td></tr></table></body></html>`;
}

/** Messages prioritaires (accès au compte, alertes) envoyés avant les autres quand le quota du jour est serré. */
const PRIORITY = ['verify_email', 'reset_password', 'admin_alert', 'payment_failed', 'appt_customer', 'appt_confirmed', 'appt_reminder', 'pro_new_request'];
const nextUtcDay = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5); };
/** E-mails envoyés aujourd'hui (UTC) par la plateforme : base du plafond quotidien partagé. */
export const emailsSentToday = (db, now = Date.now()) => db.one("SELECT COUNT(*) n FROM outbox WHERE channel='email' AND status='sent' AND sent_at>=?", now - (now % 864e5)).n;
const allowlisted = (to) => !config.emailAllowlist.length || config.emailAllowlist.some((a) => (a.startsWith('@') ? String(to).toLowerCase().endsWith(a) : String(to).toLowerCase() === a));

/** Envoie les messages en attente. Pannes, quotas et clé refusée : nouvel essai plus tard ; 8 essais (≈ 16 h) avant abandon. */
export async function processOutbox(db, limit = 50) {
  const now0 = Date.now();
  const rows = db.all(`SELECT * FROM outbox WHERE status='pending' AND next_at<=? ORDER BY CASE WHEN template IN (${PRIORITY.map(() => '?').join(',')}) THEN 0 ELSE 1 END, id LIMIT ?`, now0, ...PRIORITY, limit);
  let sent = 0, failed = 0, skipped = 0, deferred = 0;
  let budget = config.emailDailyMax - emailsSentToday(db, now0);
  for (const r of rows) {
    const p = JSON.parse(r.payload || '{}');
    try {
      let out;
      if (r.channel === 'email' && config.brevoKey && budget <= 0) {
        // Plafond du jour atteint (quota Brevo partagé) : report à demain, sans perdre d'essai
        db.run('UPDATE outbox SET next_at=?, last_error=? WHERE id=?', nextUtcDay(now0), `Plafond quotidien atteint (${config.emailDailyMax})`, r.id); deferred++; continue;
      }
      if (r.channel !== 'make' && !recipientAllowed(r.to_addr)) { out = { skipped: `Recette : ${r.to_addr} hors liste blanche, message non envoyé` }; }
      else if (r.channel === 'email' && !allowlisted(r.to_addr)) { out = { skipped: `EMAIL_ALLOWLIST : ${r.to_addr} non autorisé pendant les essais, message non envoyé` }; }
      else if (r.channel === 'make') { out = await sendMake(r.template, p); }
      else if (r.channel === 'email') { out = await sendEmail(r.to_addr, renderEmail(r.template, p)); if (out.ok) budget--; }
      else { const f = WA[r.template]; const tpl = f && f(p); if (!tpl) { out = { skipped: 'Pas de modèle WhatsApp' }; } else if (waSpentEur(db) >= config.waMonthlyBudgetEur) { out = { skipped: `Plafond mensuel WhatsApp atteint (${config.waMonthlyBudgetEur} €) : e-mail seul` }; waBudgetAlert(db); } else out = await sendWhatsApp(r.to_addr, tpl); }
      if (out.skipped) { db.run("UPDATE outbox SET status='skipped', last_error=?, attempts=attempts+1 WHERE id=?", out.skipped, r.id); skipped++; }
      else { db.run("UPDATE outbox SET status='sent', sent_at=?, attempts=attempts+1 WHERE id=?", Date.now(), r.id); sent++; }
    } catch (e) {
      if (e.retry === 'quota') { db.run('UPDATE outbox SET next_at=?, last_error=? WHERE id=?', /limit|quota|credits/i.test(e.message) ? nextUtcDay(now0) : Date.now() + 15 * 60e3, String(e.message).slice(0, 300), r.id); deferred++; budget = 0; continue; }
      if (e.retry === 'cle') {
        db.run('UPDATE outbox SET next_at=?, last_error=? WHERE id=?', Date.now() + 60 * 60e3, String(e.message).slice(0, 300), r.id); deferred++;
        recordIncident(db, { kind: 'send_email_key', severity: 'critical', message: 'Clé Brevo refusée : e-mails en attente (vérifier BREVO_API_KEY dans Render)' }); break;
      }
      const attempts = r.attempts + 1; const dead = attempts >= 8;
      db.run('UPDATE outbox SET attempts=?, status=?, next_at=?, last_error=? WHERE id=?', attempts, dead ? 'failed' : 'pending', Date.now() + Math.min(5 * 2 ** (attempts - 1), 360) * 60e3, String(e.message).slice(0, 300), r.id);
      failed++;
      if (dead) recordIncident(db, { kind: `send_${r.channel}`, severity: 'warning', message: `Envoi ${r.channel} impossible après 8 essais : ${String(e.message).slice(0, 160)}`, tenantId: r.tenant_id });
      if (e.retry === 'panne') break; // Brevo en panne : inutile d'insister sur les messages suivants à ce passage
    }
  }
  return { sent, failed, skipped, deferred };
}
export { MAIL, esc, phoneFmt };
