// Configuration lue dans les variables d'environnement. Aucun secret dans le code.
const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

// APP_ENV sépare strictement les environnements : development, test, staging (recette), production.
const appEnv = ['development', 'test', 'staging', 'production'].includes(env.APP_ENV) ? env.APP_ENV : (env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development');
export const config = {
  env: appEnv === 'production' || appEnv === 'staging' ? 'production' : (env.NODE_ENV || 'development'),
  appEnv,
  isProd: appEnv === 'production',
  port: num(env.PORT, 3000),
  baseUrl: (env.BASE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  // Domaine racine des sites clients : garage-x.<rootDomain>
  rootDomain: env.ROOT_DOMAIN || '',
  dbPath: env.DB_PATH || 'data/clientdirect.db',
  // Clé de signature interne (cookies CSRF, liens de démo). 32 octets aléatoires minimum en production.
  secret: env.APP_SECRET || 'dev-secret-change-me-dev-secret-change-me',
  trialDays: num(env.TRIAL_DAYS, 14),
  graceDays: num(env.GRACE_DAYS, 7),
  // Sites exclus du sitemap, de l'annuaire et de l'indexation (comptes de démonstration), séparés par des virgules
  sitemapExclude: String(env.SITEMAP_EXCLUDE || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  // Google Search Console : code de la balise de vérification (méthode « Balise HTML »)
  googleVerification: String(env.GOOGLE_SITE_VERIFICATION || '').replace(/[^\w-]/g, '').slice(0, 100),
  // Alerte quand le disque de la base dépasse ce taux de remplissage (%)
  diskAlertPct: num(env.DISK_ALERT_PCT, 85),
  // IA (Claude). Sans clé : réponses automatiques simples.
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  aiModel: env.AI_MODEL || 'claude-haiku-5-5',
  aiPriceInPerMTok: num(env.AI_PRICE_IN, 0.10), // USD, prompts < 100k tokens
  aiPriceOutPerMTok: num(env.AI_PRICE_OUT, 0.50),
  aiMonthlyMessagesPerTenant: num(env.AI_MONTHLY_CAP, 1500),
  usdToEur: num(env.USD_EUR, 0.92),
  // Paiement (Stripe)
  stripeKey: env.STRIPE_SECRET_KEY || '',
  stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  stripePrices: {
    essentiel: { month: env.STRIPE_PRICE_ESSENTIEL || '', setup: env.STRIPE_SETUP_ESSENTIEL || '' },
    pro: { month: env.STRIPE_PRICE_PRO || '', setup: env.STRIPE_SETUP_PRO || '' },
    premium: { month: env.STRIPE_PRICE_PREMIUM || '', setup: env.STRIPE_SETUP_PREMIUM || '' }
  },
  // E-mail (Brevo)
  brevoKey: env.BREVO_API_KEY || '',
  mailFrom: env.MAIL_FROM || 'ClientDirect Pro <no-reply@example.com>',
  // Adresse de réponse des e-mails de la plateforme (les e-mails d'un professionnel à ses clients répondent au professionnel)
  mailReplyTo: env.MAIL_REPLY_TO || env.LEGAL_EMAIL || '',
  // Plafond quotidien d'e-mails transactionnels (Brevo gratuit : 300/jour PARTAGÉS avec les autres projets du compte)
  emailDailyMax: num(env.EMAIL_DAILY_MAX, 200),
  // Liste blanche d'e-mails (adresses ou @domaines) appliquée même en production : tests réels avant ouverture complète
  emailAllowlist: String(env.EMAIL_ALLOWLIST || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  adminEmail: env.ADMIN_EMAIL || '',
  // WhatsApp Cloud API (Meta)
  waToken: env.WHATSAPP_TOKEN || '',
  waPhoneId: env.WHATSAPP_PHONE_ID || '',
  waTplConfirm: env.WHATSAPP_TPL_CONFIRM || 'rdv_confirmation',
  waTplReminder: env.WHATSAPP_TPL_REMINDER || 'rdv_rappel',
  waLang: env.WHATSAPP_LANG || 'fr',
  // Make (automatisations externes) : URL d'un webhook personnalisé Make + secret de signature
  makeWebhookUrl: env.MAKE_WEBHOOK_URL || '',
  makeWebhookSecret: env.MAKE_WEBHOOK_SECRET || '',
  // Seuls les événements peu fréquents partent vers Make par défaut (l'offre gratuite = 1 000 crédits/mois).
  // Ajoutez rdv,devis si votre forfait Make le permet.
  makeEvents: (env.MAKE_EVENTS || 'inscription,paiement_recu,paiement_echoue,incident,ticket,demo_vue').split(',').map((x) => x.trim()).filter(Boolean),
  // Prospection : API publique Recherche d'entreprises (gratuite, sans clé)
  prospectExtension: env.PROSPECT_EXTENSION !== '0',
  sireneApi: env.SIRENE_API || 'https://recherche-entreprises.api.gouv.fr',
  // Source de secours gratuite, sans clé (copie publique du registre SIRENE) si l'API principale refuse nos connexions
  sireneFallback: env.SIRENE_FALLBACK === '0' ? '' : (env.SIRENE_FALLBACK || 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/economicref-france-sirene-v3/records'),
  // Prospection nationale automatique : nombre de nouvelles entreprises repérées par jour (0 = arrêtée)
  prospectDaily: num(env.PROSPECT_DAILY, 0),
  prospectPauseMs: num(env.PROSPECT_PAUSE_MS, 600),
  // Recherche automatique des coordonnées (Firecrawl). Rien ne part sans clé ET sans plafond mensuel autorisé.
  firecrawlKey: env.FIRECRAWL_API_KEY || '',
  firecrawlApi: env.FIRECRAWL_API || '',
  geoApi: env.GEO_API || 'https://geo.api.gouv.fr',
  osmEnrich: env.OSM_ENRICH ? env.OSM_ENRICH !== '0' : env.NODE_ENV !== 'test',
  // Plusieurs serveurs publics : le principal (overpass-api.de) est souvent saturé
  overpassApis: (env.OVERPASS_API || 'https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.private.coffee/api/interpreter,https://overpass-api.de/api/interpreter').split(',').map((x) => x.trim()).filter(Boolean),
  // Délai minimal entre deux appels Firecrawl (offre gratuite : nombre de requêtes par minute limité)
  // Serveur gratuit Render : mise en veille après 15 min sans visite, ce qui arrête les tâches automatiques.
  // Un appel à /health toutes les 10 min le garde éveillé (inutile en production : l'offre payante ne dort pas).
  keepAwake: env.KEEP_AWAKE ? env.KEEP_AWAKE === '1' : (appEnv === 'staging' && /onrender\.com/.test(env.BASE_URL || '')),
  // Crédits Firecrawl répartis sur les jours restants du mois (évite d'épuiser le plafond en quelques heures)
  enrichPacing: env.ENRICH_PACING !== '0',
  firecrawlPauseMs: num(env.FIRECRAWL_PAUSE_MS, env.NODE_ENV === 'test' ? 0 : 6500),
  enrichMonthlyCredits: num(env.ENRICH_MONTHLY_CREDITS, 0),
  // Prix d'un crédit en euros pour le calcul du coût par prospect joignable (0 = crédits gratuits)
  enrichEurPerCredit: num(env.ENRICH_EUR_PER_CREDIT, 0),
  // Suivi des ouvertures de démo PAR entreprise : désactivé par défaut (seul un total anonyme par jour est compté)
  trackDemoViews: env.TRACK_DEMO_VIEWS === '1',
  // Envoi des campagnes validées par la boîte e-mail du domaine. Désactivé tant que CAMPAIGN_SENDING n'est pas « on ».
  campaignSending: env.CAMPAIGN_SENDING === 'on',
  campaignDailyMax: num(env.CAMPAIGN_DAILY_MAX, 40),
  campaignGapMin: num(env.CAMPAIGN_GAP_MIN, 8),
  // Lecture des réponses (même boîte, lecture seule). Par défaut, mêmes identifiants que l'envoi SMTP.
  imap: { host: env.IMAP_HOST || '', port: num(env.IMAP_PORT, 993), secure: env.IMAP_SECURE !== '0', user: env.IMAP_USER || env.SMTP_USER || '', pass: env.IMAP_PASS || env.SMTP_PASS || '' },
  smtp: { host: env.SMTP_HOST || '', port: num(env.SMTP_PORT, 465), secure: env.SMTP_SECURE !== '0', user: env.SMTP_USER || '', pass: env.SMTP_PASS || '', from: env.SMTP_FROM || env.SMTP_USER || '', fromName: env.SMTP_FROM_NAME || 'Walner Amantie – ClientDirect Pro' },
  // Recette : les e-mails/WhatsApp ne partent que vers ces adresses ou domaines (ex. "walner.amanti@gmail.com,@exemple.fr")
  testAllowlist: (env.TEST_ALLOWLIST || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
  // Domaines personnalisés (API Render)
  renderApiKey: env.RENDER_API_KEY || '',
  renderServiceId: env.RENDER_SERVICE_ID || '',
  renderHostname: env.RENDER_HOSTNAME || '', // ex. clientdirect-pro.onrender.com (cible CNAME des domaines propres)
  // Sauvegardes chiffrées vers Supabase Storage
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
  supabaseServiceKey: env.SUPABASE_SERVICE_KEY || '',
  backupBucket: env.BACKUP_BUCKET || 'backups',
  backupKey: env.BACKUP_KEY || '',
  backupEveryHours: num(env.BACKUP_EVERY_HOURS, 6),
  backupMinGapSec: num(env.BACKUP_MIN_GAP, 120),
  backupKeep: num(env.BACKUP_KEEP, 28),
  restoreOnBoot: env.RESTORE_ON_BOOT === '1',
  // RGPD : durées de conservation
  retentionCustomerMonths: num(env.RETENTION_CUSTOMER_MONTHS, 24),
  retentionChatDays: num(env.RETENTION_CHAT_DAYS, 90),
  retentionProspectMonths: num(env.RETENTION_PROSPECT_MONTHS, 36),
  // Mentions légales de l'éditeur
  legal: { name: env.LEGAL_NAME || 'Pop Chity High-Tech (entreprise individuelle)', owner: env.LEGAL_OWNER || 'Walner Amantie', siret: env.LEGAL_SIRET || 'à compléter', address: env.LEGAL_ADDRESS || 'à compléter, Guyane', email: env.LEGAL_EMAIL || env.ADMIN_EMAIL || '', phone: env.LEGAL_PHONE || '', vat: env.LEGAL_VAT || 'Régime de TVA : à compléter.', host: env.LEGAL_HOST || 'Render Services, Inc., 525 Brannan Street, San Francisco, CA 94107, États-Unis (serveurs à Francfort)' },
  // Coûts unitaires pour calculer la rentabilité réelle de chaque client (en euros)
  costs: {
    email: num(env.COST_EMAIL, 0.0015), // Brevo Starter ≈ 7 €/5 000 e-mails ; 0 sur l'offre gratuite
    waByCc: { '594': num(env.COST_WA_594, 0.0104), '33': num(env.COST_WA_33, 0.0276), default: num(env.COST_WA_DEFAULT, 0.0276) },
    stripePct: num(env.COST_STRIPE_PCT, 0.022), // 1,5 % carte + 0,7 % Billing
    stripeFixed: num(env.COST_STRIPE_FIXED, 0.25),
    domain: num(env.COST_DOMAIN, 0.23) // domaine personnalisé au-delà des 2 inclus sur Render (0,25 $)
  },
  rateBookMax: num(env.RATE_BOOK_MAX, 10), // réservations par adresse IP et par 10 minutes
  jobsIntervalMs: num(env.JOBS_INTERVAL_MS, 60_000),
  disableJobs: env.DISABLE_JOBS === '1'
};

export const PLANS = {
  essentiel: { name: 'Essentiel', monthly: 79, setup: 199, features: ['site', 'whatsapp', 'devis'] },
  pro: { name: 'Pro', monthly: 149, setup: 399, features: ['site', 'whatsapp', 'devis', 'rdv', 'dashboard', 'rappels', 'domaine'] },
  premium: { name: 'Premium', monthly: 249, setup: 599, features: ['site', 'whatsapp', 'devis', 'rdv', 'dashboard', 'rappels', 'domaine', 'ia'] }
};
export const planHas = (plan, f) => (PLANS[plan] || PLANS.pro).features.includes(f);

/** Vérifie que la configuration correspond bien à l'environnement (jamais de clé réelle en test, ni l'inverse). */
export function envProblems(c = config) {
  const p = [];
  const live = /^(sk|rk)_live_/.test(c.stripeKey), test = /^(sk|rk)_test_/.test(c.stripeKey);
  if (c.appEnv === 'production') {
    if (c.secret.startsWith('dev-secret') || c.secret.length < 32) p.push('APP_SECRET doit faire au moins 32 caractères aléatoires');
    if (!c.baseUrl.startsWith('https://')) p.push('BASE_URL doit commencer par https://');
    if (test) p.push('Clé Stripe de TEST interdite en production');
    if (c.testAllowlist.length) p.push('TEST_ALLOWLIST ne doit pas être défini en production');
    if (c.supabaseUrl && c.backupKey.length < 32) p.push('BACKUP_KEY (32 caractères minimum) obligatoire pour chiffrer les sauvegardes');
  } else {
    if (live) p.push(`Clé Stripe RÉELLE interdite en environnement ${c.appEnv}`);
    if (c.appEnv === 'staging' && !c.baseUrl.startsWith('https://')) p.push('BASE_URL doit commencer par https://');
    if (c.appEnv === 'staging' && (c.secret.startsWith('dev-secret') || c.secret.length < 32)) p.push('APP_SECRET doit faire au moins 32 caractères aléatoires (préproduction accessible sur Internet)');
  }
  return p;
};
/** En dehors de la production, les messages ne partent que vers la liste blanche. */
export function recipientAllowed(to, c = config) {
  if (c.appEnv === 'production') return true;
  if (c.appEnv === 'test' || c.appEnv === 'development') return true; // services simulés ou clés absentes
  const t = String(to).toLowerCase();
  return c.testAllowlist.some((a) => (a.startsWith('@') ? t.endsWith(a) : t === a));
}
