// Référencement : adresse canonique, balises, données structurées, sitemap et robots.txt.
import { config } from './config.js';
import { esc, DAYS } from './util.js';

const SCHEMA_TYPE = { garage: 'AutoRepair', coiffeur: 'HairSalon', restaurant: 'Restaurant', securite: 'ProfessionalService', location: 'AutoRental', artisan: 'HomeAndConstructionBusiness' };
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Adresse publique de référence d'un site : domaine propre vérifié, sinon sous-domaine, sinon /s/slug. */
export function siteUrl(t) {
  if (t.custom_domain && t.domain_status === 'verified') return `https://${t.custom_domain}/`;
  if (config.rootDomain) return `https://${t.slug}.${config.rootDomain}/`;
  return `${config.baseUrl}/s/${t.slug}`;
}
export function description(t) {
  const svc = t.services.slice(0, 3).map((s) => s.name).join(', ');
  return `${t.name}, ${t.metier.toLowerCase()}${t.city ? ` à ${t.city}` : ''}. ${svc}. Prise de rendez-vous en ligne, devis gratuit et contact WhatsApp.`.slice(0, 158);
}
/** Balises <head> d'un site d'entreprise. Les démos ne sont jamais indexées. */
export function siteHead(t, { mode = 'live' } = {}) {
  const url = siteUrl(t); const desc = description(t);
  const ld = {
    '@context': 'https://schema.org', '@type': SCHEMA_TYPE[t.tpl] || 'LocalBusiness', name: t.name, url, description: desc,
    telephone: t.phone ? `+${t.phone}` : undefined,
    address: { '@type': 'PostalAddress', streetAddress: t.address || undefined, addressLocality: t.city || undefined, addressCountry: 'FR' },
    openingHoursSpecification: Object.entries(t.hours).map(([d, h]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: DOW[d], opens: h[0], closes: h[1] })),
    makesOffer: t.services.slice(0, 10).map((s) => ({ '@type': 'Offer', name: s.name, price: s.price > 0 ? String(s.price) : undefined, priceCurrency: 'EUR' }))
  };
  const json = JSON.stringify(ld).replace(/</g, '\\u003c');
  const robots = mode === 'live' && config.isProd ? 'index, follow' : 'noindex, nofollow';
  return `<meta name="description" content="${esc(desc)}"><meta name="robots" content="${robots}"><link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(t.name)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(url)}"><meta property="og:locale" content="fr_FR">
<script type="application/ld+json">${json}</script>`;
}
const xmlEsc = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
const iso = (ms) => new Date(ms || Date.now()).toISOString().slice(0, 10);
export function sitemap(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map((e) => `<url><loc>${xmlEsc(e.loc)}</loc><lastmod>${iso(e.lastmod)}</lastmod></url>`).join('\n')}\n</urlset>\n`;
}
export function robots(sitemapUrl, { allow = true } = {}) {
  if (!allow) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nDisallow: /pro\nDisallow: /admin\nDisallow: /demo/\nDisallow: /connexion\nDisallow: /inscription\nDisallow: /annuler/\nDisallow: /stop/\nAllow: /\n\nSitemap: ${sitemapUrl}\n`;
}
/** Sites publiés (essai en cours, actifs ou en délai de grâce) pour le sitemap et l'annuaire. */
export function publicTenants(db, now = Date.now()) {
  return db.all(`SELECT id, slug, name, metier, city, custom_domain, domain_status, created_at, updated_at FROM tenants
    WHERE status='active' OR (status='trial' AND trial_ends_at > ?) OR (status='past_due' AND COALESCE(current_period_end,0) + ? > ?) ORDER BY city, name`, now, config.graceDays * 864e5, now);
}
export const DAYS_FR = DAYS;
