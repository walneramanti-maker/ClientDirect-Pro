// Recherche automatique des coordonnées professionnelles publiques (téléphone, site, e-mail générique).
// Source : fiches d'établissement publiques (Maps) via l'API Firecrawl, puis la page contact du site de l'entreprise.
// Désactivée tant qu'aucune clé n'est fournie et qu'aucun plafond mensuel de crédits n'est autorisé.
import { config } from './config.js';
import { net } from './net.js';
import { recordIncident } from './incidents.js';
import { TEMPLATES } from './templates.js';
import { displayName } from './prospect.js';

const API = () => (config.firecrawlApi || 'https://api.firecrawl.dev').replace(/\/$/, '');
const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;
const setMeta = (db, k, v) => db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));

/** Plafond mensuel : réglé dans l'administration (prioritaire) ou par ENRICH_MONTHLY_CREDITS. 0 = arrêté. */
export function enrichCap(db) { const v = meta(db, 'enrich_monthly_credits'); return v != null ? Number(v) : config.enrichMonthlyCredits; }
export function creditsUsed(db, now = Date.now()) { return Number(meta(db, `enrich_credits_${month(now)}`) || 0); }
function spend(db, n, now) { setMeta(db, `enrich_credits_${month(now)}`, creditsUsed(db, now) + n); }
export function enrichEnabled(db) { return !!config.firecrawlKey && enrichCap(db) > 0; }

/** Mots significatifs d'un nom d'entreprise, sans formes juridiques ni mots vides. */
const STOP = new Set(['sarl', 'sas', 'sasu', 'eurl', 'ei', 'snc', 'sci', 'et', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'chez', 'garage', 'auto', 'automobile', 'restaurant', 'snack', 'salon', 'coiffure', 'institut', 'beaute', 'location', 'multiservice', 'multiservices', 'services', 'service']);
export const words = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));
/** Une fiche correspond-elle à l'entreprise du registre ? Même code postal (ou même ville) et un nom proche. */
export function matches(place, p) {
  const addr = String(place.address || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const city = String(p.city || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const sameArea = (p.postal && addr.includes(p.postal)) || (city && addr.replace(/[^a-z]+/g, ' ').includes(city));
  if (!sameArea) return false;
  const trade = words(displayName(p.name)); const a = new Set(trade.length ? trade : words(p.name)); const b = words(place.name);
  if (!a.size || !b.length) return false;
  const common = b.filter((w) => a.has(w)).length;
  return common >= Math.min(2, a.size) || (common >= 1 && a.size === 1);
}

async function alexandria(db, provider, capability, options, credits, now) {
  const res = await net.fetch(`${API()}/v2/scrape`, { method: 'POST', headers: { authorization: `Bearer ${config.firecrawlKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ alexandria: { provider, capability, options } }) });
  spend(db, credits, now);
  if (res.status === 402) throw Object.assign(new Error('Crédits Firecrawl épuisés'), { stop: true });
  if (res.status === 429) throw Object.assign(new Error('Limite de requêtes Firecrawl'), { stop: true });
  if (!res.ok) throw new Error(`Firecrawl ${res.status}`);
  const j = await res.json();
  const item = [].concat(j.data?.alexandria || [])[0] || {};
  if (item.error) throw new Error(`Firecrawl : ${item.error.code || item.error.message || 'erreur'}`);
  const d = item.data || {};
  return Array.isArray(d.results) ? d.results : Array.isArray(item.records) ? item.records : Array.isArray(d) ? d : [];
}
/** Cherche les fiches d'un métier dans une ville (20 par page, 10 crédits). */
export async function searchPlaces(db, { query, postal }, now = Date.now()) {
  return alexandria(db, 'firecrawl-maps', 'businesses/search', { query, country: 'fr', language: 'fr', locality: postal || undefined, include_opening_hours: false }, 10, now);
}
/** Adresse e-mail publique sur la page contact du site (1 crédit). Les adresses génériques (contact@…) sont préférées. */
export async function findEmail(db, website, now = Date.now()) {
  let url; try { url = new URL(website); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const res = await net.fetch(`${API()}/v2/scrape`, { method: 'POST', headers: { authorization: `Bearer ${config.firecrawlKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: url.origin + '/contact', formats: ['markdown'], onlyMainContent: false }) });
  spend(db, 1, now);
  if (!res.ok) return null;
  const md = String((await res.json()).data?.markdown || '');
  const found = [...new Set((md.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()))].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/(example|sentry|wixpress|domain)\./.test(e));
  const host = url.hostname.replace(/^www\./, '');
  const generic = found.find((e) => /^(contact|info|bonjour|hello|accueil|devis|rdv|reservation|commande|admin|secretariat)@/.test(e));
  return generic || found.find((e) => e.endsWith('@' + host)) || null;
}
const phoneOk = (s) => /^\+?[\d\s.()-]{8,20}$/.test(String(s || ''));

/**
 * Complète les prospects « À contacter » sans coordonnées, groupés par ville et métier :
 * une recherche couvre plusieurs entreprises de la même ville. S'arrête au plafond mensuel de crédits.
 */
export async function enrichBatch(db, { maxSearches = 20, now = Date.now(), emails = true } = {}) {
  const r = { searches: 0, matched: 0, emails: 0, credits: 0, stopped: '' };
  if (!enrichEnabled(db)) { r.stopped = 'désactivé'; return r; }
  const start = creditsUsed(db, now); const cap = enrichCap(db);
  const groups = db.all(`SELECT tpl, postal, MIN(city) city, COUNT(*) n FROM prospects WHERE status='new' AND enriched_at IS NULL AND postal!='' GROUP BY tpl, postal ORDER BY MAX(score) DESC, n DESC LIMIT ?`, maxSearches);
  for (const g of groups) {
    if (creditsUsed(db, now) + 10 > cap) { r.stopped = 'plafond mensuel atteint'; break; }
    const pending = db.all("SELECT * FROM prospects WHERE status='new' AND enriched_at IS NULL AND tpl=? AND postal=?", g.tpl, g.postal);
    const label = (TEMPLATES[g.tpl]?.metier || g.tpl).toLowerCase();
    let places = [];
    try { places = await searchPlaces(db, { query: `${label} ${g.postal} ${g.city}`, postal: g.postal }, now); r.searches++; }
    catch (e) { r.searches++; if (e.stop) { r.stopped = e.message; break; } recordIncident(db, { kind: 'enrichissement', severity: 'info', message: String(e.message).slice(0, 160) }); }
    for (const p of pending) {
      const pl = places.find((x) => x.business_status !== 'permanently_closed' && matches(x, p));
      if (!pl) { db.run('UPDATE prospects SET enriched_at=?, contact_source=? WHERE id=?', now, 'non trouvé', p.id); continue; }
      let email = null;
      if (emails && pl.website && creditsUsed(db, now) + 1 <= cap) { try { email = await findEmail(db, pl.website, now); } catch { email = null; } if (email) r.emails++; }
      db.run('UPDATE prospects SET phone=?, website=?, email=?, contact_source=?, enriched_at=?, maps_closed=? WHERE id=?',
        phoneOk(pl.phone_e164 || pl.phone) ? (pl.phone_e164 || pl.phone) : null, pl.website || null, email, 'fiche publique (Maps) + site', now, pl.business_status === 'temporarily_closed' ? 1 : 0, p.id);
      r.matched++;
    }
  }
  r.credits = creditsUsed(db, now) - start;
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.enrich',?,?)", JSON.stringify(r), now);
  return r;
}
export function enrichStatus(db, now = Date.now()) {
  const c = db.one("SELECT COUNT(*) total, SUM(enriched_at IS NOT NULL) done, SUM(phone IS NOT NULL) phones, SUM(email IS NOT NULL) emails FROM prospects WHERE status!='optout'");
  return { enabled: enrichEnabled(db), keySet: !!config.firecrawlKey, cap: enrichCap(db), used: creditsUsed(db, now), ...c };
}
