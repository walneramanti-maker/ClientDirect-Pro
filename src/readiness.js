// Préparation du lancement commercial : chaque condition est vérifiée automatiquement (aucun secret affiché).
import { config } from './config.js';
import { backupHealth } from './backup.js';

const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;

export function readiness(db, now = Date.now()) {
  const b = backupHealth(db, now);
  const prices = db.one("SELECT COUNT(*) n FROM meta WHERE k LIKE 'stripe_price_%'").n;
  const live = /^sk_live_|^rk_live_/.test(config.stripeKey || '');
  const paidEvent = db.one("SELECT 1 x FROM webhook_events WHERE type IN ('invoice.paid','checkout.session.completed') LIMIT 1");
  const reach = db.all("SELECT CASE WHEN potential>=75 THEN 'A' WHEN potential>=50 THEN 'B' ELSE 'C' END cl, COUNT(*) n FROM prospects WHERE status='new' AND maps_closed=0 AND (phone IS NOT NULL OR email IS NOT NULL) GROUP BY cl");
  const cls = Object.fromEntries(reach.map((r) => [r.cl, r.n]));
  const depts = db.one("SELECT COUNT(DISTINCT dept) n FROM prospects WHERE dept!=''").n;
  const legalOk = !/à compléter/.test(config.legal.address) && !!config.legal.email && !/à compléter/.test(config.legal.siret) && !/à compléter/.test(config.legal.vat);
  const items = [
    { key: 'stripe', label: 'Stripe configuré (prix et webhook)', ok: !!config.stripeKey && prices >= 24 && !!(config.stripeWebhookSecret || meta(db, 'stripe_webhook_secret')), detail: `${prices} prix, mode ${live ? 'réel' : 'test'}` },
    { key: 'paiement_test', label: 'Paiement test complet réussi', ok: !!paidEvent, detail: paidEvent ? 'événement de paiement reçu' : 'à faire : carte 4242 4242 4242 4242', action: 'Vous' },
    { key: 'stripe_reel', label: 'Clés Stripe en mode réel', ok: live, detail: live ? 'mode réel' : 'après le paiement test, sur votre autorisation', action: 'Vous' },
    { key: 'sauvegardes', label: 'Sauvegardes hors serveur et test de restauration', ok: b.ok && !!b.verified?.ok, detail: b.ok ? (b.verified?.ok ? `restauration vérifiée le ${b.verified.at.slice(0, 10)}` : 'premier test de restauration en attente') : b.problems.join(', ') },
    { key: 'alertes', label: 'Alertes e-mail en cas de panne', ok: !!(config.adminEmail && (config.brevoKey || config.smtp.host)), detail: !config.adminEmail ? 'ADMIN_EMAIL absent' : (config.brevoKey || config.smtp.host) ? 'actives' : 'Brevo (gratuit) ou SMTP à configurer', action: 'Vous' },
    { key: 'production', label: 'Serveur de production avec disque permanent', ok: config.isProd, detail: config.isProd ? 'production' : `environnement « ${config.appEnv} »`, action: 'Votre autorisation (≈ 7,25 $/mois)' },
    { key: 'domaine', label: 'Nom de domaine clientdirectpro.fr', ok: !/onrender\.com|127\.0\.0\.1|localhost/.test(config.baseUrl), detail: config.baseUrl.replace(/^https?:\/\//, ''), action: 'Votre autorisation (4,99 € HT)' },
    { key: 'mentions', label: 'Mentions légales complètes (adresse, e-mail, SIRET)', ok: legalOk, detail: legalOk ? 'complètes (mentions légales et CGV)' : 'à fournir : adresse, e-mail, téléphone et régime de TVA (LEGAL_ADDRESS, LEGAL_EMAIL, LEGAL_PHONE, LEGAL_VAT)', action: 'Vous' },
    { key: 'prospects', label: 'Prospects joignables classés', ok: (cls.A || 0) + (cls.B || 0) >= 50, detail: `A (sans site) : ${cls.A || 0} · B : ${cls.B || 0} · C : ${cls.C || 0} · ${depts} départements` },
    { key: 'envoi', label: 'Envoi des e-mails de prospection', ok: !!(config.campaignSending && config.smtp.host), detail: config.campaignSending ? 'activé' : 'désactivé jusqu’à votre autorisation (appels possibles dès maintenant)', action: 'Votre autorisation' },
    { key: 'ia', label: 'Assistant IA (formule Premium)', ok: !!config.anthropicKey, detail: config.anthropicKey ? `actif · modèle ${config.aiModel} · plafond ${config.aiMonthlyBudgetEur} €/mois` : 'ANTHROPIC_API_KEY à ajouter dans Render (affiché « bientôt disponible » en attendant)', action: 'Vous' },
    { key: 'whatsapp', label: 'Confirmations et rappels WhatsApp', ok: !!(config.waToken && config.waPhoneId), detail: config.waToken && config.waPhoneId ? `actif · modèles ${config.waTplConfirm} / ${config.waTplReminder} · plafond ${config.waMonthlyBudgetEur} €/mois` : 'WHATSAPP_TOKEN et WHATSAPP_PHONE_ID à ajouter dans Render (affiché « bientôt disponible » en attendant)', action: 'Vous' },
    { key: 'date', label: 'Date de lancement officielle', ok: !!meta(db, 'launch_date'), detail: meta(db, 'launch_date') || 'à fixer (démarre le bilan de 30 jours)', action: 'Vous' }
  ];
  return { items, done: items.filter((i) => i.ok).length, total: items.length };
}
