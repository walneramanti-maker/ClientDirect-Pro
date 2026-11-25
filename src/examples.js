// Sites d'exemple fictifs (un par métier et par langue) que les visiteurs testent sans s'inscrire.
// Ils sont en statut « demo » : jamais publics, jamais indexés, et rien n'y est enregistré.
import { createTenant, loadTenant } from './tenants.js';
import { TEMPLATES } from './templates.js';
import { nowIn, addDays } from './util.js';

export const EXAMPLE_TPLS = Object.keys(TEMPLATES);
const NAMES = {
  fr: { garage: 'Garage du Fleuve', coiffeur: 'Studio Coiffure Belle Allure', restaurant: 'Le Petit Carbet', securite: 'Vigilance Sécurité', location: 'Évasion Location', artisan: 'Pro Dépannage Habitat' },
  en: { garage: 'Riverside Auto Care', coiffeur: 'Bella Hair Studio', restaurant: 'The Corner Bistro', securite: 'Shield Security Services', location: 'Easy Drive Rentals', artisan: 'Handy Home Repairs' }
};
const CITY = { fr: 'Votre ville', en: 'Your town' };

export function exampleTenant(db, tpl, lang = 'fr') {
  lang = NAMES[lang] ? lang : 'fr';
  const slug = `exemple-${tpl}-${lang}`;
  let tn = loadTenant(db, 'slug', slug);
  if (!tn) {
    try {
      createTenant(db, { name: NAMES[lang][tpl], tpl, city: CITY[lang], country: lang === 'fr' ? 'FR' : 'US', lang, plan: 'premium', status: 'demo', slug, example: 1 });
    } catch { /* créé en parallèle par une autre requête */ }
    tn = loadTenant(db, 'slug', slug);
  }
  tn.auto_confirm = 1;
  return tn;
}
/** Tableau de bord d'exemple : données fictives calculées à la volée, rien n'est stocké. */
export function exampleDashboardData(db, lang = 'fr') {
  const tn = exampleTenant(db, 'garage', lang);
  const today = nowIn(tn.tz).date; const s = tn.services; const fr = lang === 'fr';
  const people = fr ? ['Marie L.', 'Jean-Paul D.', 'Sandra K.', 'Kevin R.', 'Lucie M.'] : ['Mary L.', 'John D.', 'Sandra K.', 'Kevin R.', 'Lucy M.'];
  const appts = [0, 1, 1, 2, 3].map((d, i) => ({ id: i + 1, date: addDays(today, d + 1), time: ['08:30', '10:00', '14:30', '09:00', '15:30'][i], customer_name: people[i], customer_phone: '33600000000', customer_email: '', service_name: s[i % s.length].name, staff_name: tn.staff[i % tn.staff.length].name, price: s[i % s.length].price, status: i < 2 ? 'pending' : 'confirmed', source: i === 3 ? 'assistant' : 'site' }));
  const quotes = [{ id: 1, customer_name: fr ? 'Didier P.' : 'David P.', customer_phone: '33600000001', customer_email: '', service: s[1].name, obj: fr ? 'Peugeot 208, 2019' : 'Ford Focus, 2019', message: fr ? 'Bruit au freinage à l’avant.' : 'Squeaking brakes at the front.', status: 'new' }];
  const curve = Array.from({ length: 30 }, (_, i) => { const v = 8 + ((i * 7) % 11) + Math.round(i / 3); return { day: addDays(today, i - 29), views: v, requests: Math.max(0, Math.round(v / 6) - (i % 3 === 0 ? 1 : 0)) }; });
  const views = curve.reduce((a, d) => a + d.views, 0); const requests = curve.reduce((a, d) => a + d.requests, 0);
  const perf = { views, requests, bookings: Math.round(requests * 0.6), quotes: Math.round(requests * 0.25), wa_clicks: requests - Math.round(requests * 0.6) - Math.round(requests * 0.25), chats: 31, confirmed: Math.round(requests * 0.5), value: Math.round(requests * 0.5) * 74, conversion: Math.round((requests / views) * 1000) / 10 };
  return { tenant: { ...tn, status: 'trial', trial_ends_at: Date.now() + 10 * 864e5 }, user: { email_verified: 1 }, appts, quotes, stats: { pending: 2, upcoming: appts.length, quotes: 1, revenue: appts.filter((a) => a.status === 'confirmed').reduce((x, a) => x + a.price, 0) }, perf, curve, msg: '' };
}
