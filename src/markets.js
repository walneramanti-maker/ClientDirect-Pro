// Pays : indicatif, devise, langue par défaut et état des abonnements payants.
// La plateforme (inscription, essai gratuit, site, rendez-vous) est ouverte partout.
// Les abonnements payants ne s'activent qu'après vérification des paiements et de la fiscalité du pays (billing: true).
export const COUNTRIES = {
  FR: { fr: 'France métropolitaine', en: 'France', dial: '33', cur: 'EUR', lang: 'fr', tz: 'Europe/Paris', billing: true, tax: 'TVA 20 % (à confirmer selon le régime TVA de l’éditeur)' },
  GF: { fr: 'Guyane', en: 'French Guiana', dial: '594', cur: 'EUR', lang: 'fr', tz: 'America/Cayenne', billing: true, tax: 'TVA non applicable (art. 294-1 CGI)' },
  GP: { fr: 'Guadeloupe', en: 'Guadeloupe', dial: '590', cur: 'EUR', lang: 'fr', tz: 'America/Guadeloupe', billing: true, tax: 'TVA 8,5 %' },
  MQ: { fr: 'Martinique', en: 'Martinique', dial: '596', cur: 'EUR', lang: 'fr', tz: 'America/Martinique', billing: true, tax: 'TVA 8,5 %' },
  RE: { fr: 'La Réunion', en: 'Réunion', dial: '262', cur: 'EUR', lang: 'fr', tz: 'Indian/Reunion', billing: true, tax: 'TVA 8,5 %' },
  YT: { fr: 'Mayotte', en: 'Mayotte', dial: '262', cur: 'EUR', lang: 'fr', tz: 'Indian/Mayotte', billing: true, tax: 'TVA non applicable' },
  BE: { fr: 'Belgique', en: 'Belgium', dial: '32', cur: 'EUR', lang: 'fr', tz: 'Europe/Brussels', billing: false, tax: 'UE : autoliquidation B2B avec n° de TVA valide (VIES)' },
  LU: { fr: 'Luxembourg', en: 'Luxembourg', dial: '352', cur: 'EUR', lang: 'fr', tz: 'Europe/Luxembourg', billing: false, tax: 'UE : autoliquidation B2B' },
  CH: { fr: 'Suisse', en: 'Switzerland', dial: '41', cur: 'CHF', lang: 'fr', tz: 'Europe/Zurich', billing: false, tax: 'TVA suisse : seuil d’assujettissement à vérifier' },
  MC: { fr: 'Monaco', en: 'Monaco', dial: '377', cur: 'EUR', lang: 'fr', tz: 'Europe/Monaco', billing: false, tax: 'Régime TVA français' },
  CA: { fr: 'Canada', en: 'Canada', dial: '1', cur: 'CAD', lang: 'en', tz: 'America/Toronto', billing: false, tax: 'TPS/TVH : B2B avec n° de TPS = pas de collecte ; sinon inscription au-delà de 30 000 $ CA' },
  US: { fr: 'États-Unis', en: 'United States', dial: '1', cur: 'USD', lang: 'en', tz: 'America/New_York', billing: false, tax: 'Taxe de vente sur le SaaS selon l’État ; seuils de « nexus » souvent 100 000 $' },
  GB: { fr: 'Royaume-Uni', en: 'United Kingdom', dial: '44', cur: 'GBP', lang: 'en', tz: 'Europe/London', billing: false, tax: 'TVA UK : autoliquidation B2B' },
  IE: { fr: 'Irlande', en: 'Ireland', dial: '353', cur: 'EUR', lang: 'en', tz: 'Europe/Dublin', billing: false, tax: 'UE : autoliquidation B2B' },
  DE: { fr: 'Allemagne', en: 'Germany', dial: '49', cur: 'EUR', lang: 'en', tz: 'Europe/Berlin', billing: false, tax: 'UE : autoliquidation B2B' },
  ES: { fr: 'Espagne', en: 'Spain', dial: '34', cur: 'EUR', lang: 'en', tz: 'Europe/Madrid', billing: false, tax: 'UE : autoliquidation B2B' },
  IT: { fr: 'Italie', en: 'Italy', dial: '39', cur: 'EUR', lang: 'en', tz: 'Europe/Rome', billing: false, tax: 'UE : autoliquidation B2B' },
  PT: { fr: 'Portugal', en: 'Portugal', dial: '351', cur: 'EUR', lang: 'en', tz: 'Europe/Lisbon', billing: false, tax: 'UE : autoliquidation B2B' },
  NL: { fr: 'Pays-Bas', en: 'Netherlands', dial: '31', cur: 'EUR', lang: 'en', tz: 'Europe/Amsterdam', billing: false, tax: 'UE : autoliquidation B2B' },
  AU: { fr: 'Australie', en: 'Australia', dial: '61', cur: 'AUD', lang: 'en', tz: 'Australia/Sydney', billing: false, tax: 'GST : à vérifier' },
  NZ: { fr: 'Nouvelle-Zélande', en: 'New Zealand', dial: '64', cur: 'NZD', lang: 'en', tz: 'Pacific/Auckland', billing: false, tax: 'GST : à vérifier' },
  SR: { fr: 'Suriname', en: 'Suriname', dial: '597', cur: 'USD', lang: 'en', tz: 'America/Paramaribo', billing: false, tax: 'À vérifier' },
  BR: { fr: 'Brésil', en: 'Brazil', dial: '55', cur: 'USD', lang: 'en', tz: 'America/Sao_Paulo', billing: false, tax: 'À vérifier' },
  HT: { fr: 'Haïti', en: 'Haiti', dial: '509', cur: 'USD', lang: 'fr', tz: 'America/Port-au-Prince', billing: false, tax: 'À vérifier' },
  SN: { fr: 'Sénégal', en: 'Senegal', dial: '221', cur: 'EUR', lang: 'fr', tz: 'Africa/Dakar', billing: false, tax: 'À vérifier' },
  CI: { fr: 'Côte d’Ivoire', en: 'Côte d’Ivoire', dial: '225', cur: 'EUR', lang: 'fr', tz: 'Africa/Abidjan', billing: false, tax: 'À vérifier' },
  MA: { fr: 'Maroc', en: 'Morocco', dial: '212', cur: 'EUR', lang: 'fr', tz: 'Africa/Casablanca', billing: false, tax: 'À vérifier' },
  NC: { fr: 'Nouvelle-Calédonie', en: 'New Caledonia', dial: '687', cur: 'EUR', lang: 'fr', tz: 'Pacific/Noumea', billing: false, tax: 'TGC locale : à vérifier' },
  PF: { fr: 'Polynésie française', en: 'French Polynesia', dial: '689', cur: 'EUR', lang: 'fr', tz: 'Pacific/Tahiti', billing: false, tax: 'TVA locale : à vérifier' },
  OTHER: { fr: 'Autre pays', en: 'Other country', dial: '', cur: 'USD', lang: 'en', tz: 'UTC', billing: false, tax: 'À vérifier' }
};
// Tarifs mensuels et frais de mise en service par devise (HT). Arrondis commerciaux, ajustables.
export const PRICES = {
  EUR: { essentiel: [79, 199], pro: [149, 399], premium: [249, 599] },
  USD: { essentiel: [89, 219], pro: [169, 449], premium: [279, 669] },
  CAD: { essentiel: [119, 299], pro: [219, 589], premium: [369, 889] },
  GBP: { essentiel: [69, 179], pro: [129, 349], premium: [219, 529] },
  CHF: { essentiel: [79, 199], pro: [149, 399], premium: [249, 599] },
  AUD: { essentiel: [139, 349], pro: [259, 699], premium: [429, 1049] },
  NZD: { essentiel: [149, 379], pro: [279, 749], premium: [469, 1129] }
};
export const CURRENCIES = Object.keys(PRICES);
export const country = (code) => COUNTRIES[code] || COUNTRIES.OTHER;
export const countryName = (code, lang = 'fr') => (COUNTRIES[code] || COUNTRIES.OTHER)[lang === 'fr' ? 'fr' : 'en'];
export const priceOf = (plan, currency = 'EUR') => { const p = (PRICES[currency] || PRICES.EUR)[plan]; return { monthly: p[0], setup: p[1], currency: PRICES[currency] ? currency : 'EUR' }; };
export const billingOpen = (code, env = process.env) => !!country(code).billing || String(env.BILLING_COUNTRIES || '').split(',').includes(code);
export function money(amount, currency = 'EUR', loc = 'fr-FR') {
  try { return new Intl.NumberFormat(loc, { style: 'currency', currency, maximumFractionDigits: Number.isInteger(Number(amount)) ? 0 : 2 }).format(Number(amount)); } catch { return `${amount} ${currency}`; }
}
/** Fuseaux horaires reconnus par le moteur (tous les fuseaux IANA du monde). */
export const ALL_TZ = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['UTC', 'Europe/Paris', 'America/Cayenne']; } })();
export const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
/** Indicatif → pays par défaut (pour les anciens comptes). */
export const countryFromDial = (dial) => Object.entries(COUNTRIES).find(([, c]) => c.dial === String(dial))?.[0] || 'OTHER';
export const countryByTz = (tz) => Object.entries(COUNTRIES).find(([k, c]) => k !== 'OTHER' && c.tz === tz)?.[0] || null;
