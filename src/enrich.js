// Recherche automatique des coordonnées professionnelles publiques (téléphone, site, e-mail générique).
// Source : fiches d'établissement publiques (Maps) via l'API Firecrawl, puis la page contact du site de l'entreprise.
// Désactivée tant qu'aucune clé n'est fournie et qu'aucun plafond mensuel de crédits n'est autorisé.
import { config } from './config.js';
import { net } from './net.js';
import { recordIncident } from './incidents.js';
import { TEMPLATES } from './templates.js';
import { displayName, fromSirene, importProspects, sireneBySiren } from './prospect.js';
import { tplFromNaf } from './templates.js';
import { isSuppressed } from './suppression.js';
// Types d'établissements OpenStreetMap correspondant aux métiers ciblés
const OSM_KIND_TPL = (k) => /^(hairdresser|beauty|massage|cosmetics|restaurant|fast_food|cafe|car_repair|car|tyres|motorcycle|car_rental|electrician|plumber|carpenter|builder|painter|roofer|hvac|locksmith|tiler|plasterer|glaziery|stonemason|metal_construction|gardener|security)$/.test(String(k || ''));
import { deptOf } from './france.js';
import { analyzeSite, isPlatform, refreshPotentials } from './potential.js';
import { osmPlaces, OSM_SOURCE } from './osm.js';
import { cleanContacts } from './suppression.js';

const API = () => (config.firecrawlApi || 'https://api.firecrawl.dev').replace(/\/$/, '');
const month = (now = Date.now()) => new Date(now).toISOString().slice(0, 7);
const meta = (db, k) => db.one('SELECT v FROM meta WHERE k=?', k)?.v;
const setMeta = (db, k, v) => db.run('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));

/** Plafond mensuel : réglé dans l'administration (prioritaire) ou par ENRICH_MONTHLY_CREDITS. 0 = arrêté. */
export function enrichCap(db) { const v = meta(db, 'enrich_monthly_credits'); return v != null ? Number(v) : config.enrichMonthlyCredits; }
export function creditsUsed(db, now = Date.now()) { return Number(meta(db, `enrich_credits_${month(now)}`) || 0); }
const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
function spend(db, n, now) { setMeta(db, `enrich_credits_${month(now)}`, creditsUsed(db, now) + n); setMeta(db, `enrich_credits_day_${day(now)}`, usedToday(db, now) + n); }
export function usedToday(db, now = Date.now()) { return Number(meta(db, `enrich_credits_day_${day(now)}`) || 0); }
/** Plafond effectif du jour : le reste du mois réparti sur les jours restants (aujourd'hui compris). */
export function effectiveCap(db, now = Date.now()) {
  const cap = enrichCap(db); if (!config.enrichPacing) return cap;
  const d = new Date(now); const daysLeft = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() - d.getUTCDate() + 1;
  const before = creditsUsed(db, now) - usedToday(db, now);
  return Math.min(cap, before + Math.ceil(Math.max(0, cap - before) / daysLeft));
}
export function enrichEnabled(db) { return !!config.firecrawlKey && enrichCap(db) > 0; }

/** Mots significatifs d'un nom d'entreprise, sans formes juridiques ni mots vides. */
const STOP = new Set(['guyane', 'guadeloupe', 'martinique', 'reunion', 'mayotte', 'france', 'saint', 'sainte', 'st', 'ste', 'sur', 'en', 'centre', 'ville', 'sarl', 'sas', 'sasu', 'eurl', 'ei', 'snc', 'sci', 'et', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'chez', 'garage', 'auto', 'automobile', 'restaurant', 'snack', 'salon', 'coiffure', 'institut', 'beaute', 'location', 'multiservice', 'multiservices', 'services', 'service']);
export const words = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !STOP.has(w));
/** Une fiche correspond-elle à l'entreprise du registre ? Même code postal (ou même ville) et un nom proche. */
export function matches(place, p) {
  const addr = String(place.address || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const city = String(p.city || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const sameArea = (p.postal && addr.includes(p.postal)) || (city && addr.replace(/[^a-z]+/g, ' ').includes(city));
  if (!sameArea) return false;
  const cityWords = new Set(words(p.city));
  const clean = (arr) => arr.filter((w) => !cityWords.has(w));
  const trade = clean(words(displayName(p.name))); const a = new Set(trade.length ? trade : clean(words(p.name))); const b = clean(words(place.name));
  if (!a.size || !b.length) return false;
  const common = b.filter((w) => a.has(w)).length;
  return common >= Math.min(2, a.size) || (common >= 1 && a.size === 1);
}

let lastCall = 0;
async function paced() { const wait = lastCall + config.firecrawlPauseMs - Date.now(); if (wait > 0) await new Promise((ok) => setTimeout(ok, wait)); lastCall = Date.now(); }
async function alexandria(db, provider, capability, options, credits, now) {
  await paced();
  const res = await net.fetch(`${API()}/v2/scrape`, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { authorization: `Bearer ${config.firecrawlKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ alexandria: { provider, capability, options } }) });
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
// Pages qui ne sont pas le site de l'entreprise (leur e-mail serait celui de la plateforme) : voir potential.js
async function pageOn(db, url, now) {
  await paced();
  const res = await net.fetch(`${API()}/v2/scrape`, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { authorization: `Bearer ${config.firecrawlKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ url, formats: ['markdown', 'rawHtml'], onlyMainContent: false }) });
  spend(db, 1, now);
  if (!res.ok) return null;
  const j = await res.json(); if (Number(j.data?.metadata?.statusCode) >= 400) return null;
  const md = String(j.data?.markdown || ''); const html = String(j.data?.rawHtml || '');
  const emails = [...new Set((md.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((e) => e.toLowerCase()))].filter((e) => !/\.(png|jpe?g|gif|webp|svg)$/.test(e) && !/(example|sentry|wixpress|domain|godaddy|ovh)\./.test(e));
  return { md, html, emails };
}
/**
 * Lit le site de l'entreprise : page d'accueil (analyse du site + e-mail), puis page contact si l'e-mail manque.
 * 2 crédits au maximum. Adresses génériques préférées. Renvoie { email, site }.
 */
export async function inspectSite(db, website, now = Date.now(), cap = Infinity, { needEmail = true } = {}) {
  let url; try { url = new URL(website); } catch { return { email: null, site: null }; }
  if (!/^https?:$/.test(url.protocol) || isPlatform(website)) return { email: null, site: null };
  const host = url.hostname.replace(/^www\./, '');
  const pick = (list) => list.find((e) => /^(contact|info|bonjour|hello|accueil|devis|rdv|reservation|commande|admin|secretariat)@/.test(e)) || list.find((e) => e.endsWith('@' + host)) || list[0] || null;
  let site = null; let email = null;
  for (const [i, page] of [url.origin + '/', url.origin + '/contact'].entries()) {
    if (creditsUsed(db, now) + 1 > cap) break;
    if (i > 0 && (!needEmail || email)) break;
    const got = await pageOn(db, page, now).catch(() => null);
    if (!got) continue;
    if (i === 0) site = analyzeSite({ url: website, html: got.html, md: got.md });
    email = email || pick(got.emails);
  }
  return { email, site };
}
export async function findEmail(db, website, now = Date.now(), cap = Infinity) { return (await inspectSite(db, website, now, cap)).email; }
function saveSite(db, id, site, now) {
  if (site) db.run('UPDATE prospects SET site_status=?, site_flags=?, site_checked_at=? WHERE id=?', site.status, JSON.stringify(site), now, id);
}
/** Statut du site connu sans lecture : aucun, ou simple page sur une plateforme. */
function siteFromListing(website, confirmed) { return !website ? (confirmed ? 'aucun' : 'aucun_probable') : isPlatform(website) ? 'plateforme' : null; }
const phoneOk = (s) => /^\+?[\d\s.()-]{8,20}$/.test(String(s || ''));
/**
 * Vérifie une fiche Maps dans le registre public (gratuit) : entreprise active, même code postal, nom proche,
 * sans opposition à la prospection, petite taille. Renvoie le prospect à importer, ou null.
 */
export async function verifyInSirene(place, { postal, city, tpl }) {
  // La fiche peut être dans une commune voisine : on prend le code postal de SA propre adresse
  const own = (String(place.address || '').match(/\b(97[1-6]\d{2}|[0-9]{2}\d{3})\b/) || [])[1] || postal;
  const q = words(place.name).filter((w) => !words(city).includes(w)).slice(0, 4).join(' ');
  if (!q) return null;
  const res = await net.fetch(`${config.sireneApi}/search?q=${encodeURIComponent(q)}&code_postal=${own}&etat_administratif=A&per_page=5`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  postal = own;
  for (const r of (await res.json()).results || []) {
    const ens = [...(r.siege?.liste_enseignes || []), ...((r.matching_etablissements || []).flatMap((e) => e.liste_enseignes || []))];
    const label = ens.length ? `${r.nom_complet} (${ens[0]})` : r.nom_complet;
    if (!matches(place, { name: label, postal, city })) continue;
    const p = fromSirene(r, tpl, null, deptOf(postal));
    if (!p || !['NN', '00', '01', '02', '03', '11'].includes(p.staff)) return null; // opposition, non-diffusion ou trop grande
    return p;
  }
  return null;
}

/**
 * Coordonnées gratuites d'abord : OpenStreetMap, une requête par code postal et métier.
 * Les entreprises trouvées n'ont plus besoin de Firecrawl ; les autres restent pour la recherche Maps.
 */
export async function osmPass(db, { maxGroups = 25, now = Date.now(), pause = config.prospectPauseMs } = {}) {
  const r = { groups: 0, found: 0, stopped: '' };
  if (!config.osmEnrich) { r.stopped = 'désactivé'; return r; }
  const groups = db.all(`SELECT postal, MIN(city) city FROM prospects p WHERE status='new' AND enriched_at IS NULL AND osm_checked_at IS NULL AND postal!='' GROUP BY postal ORDER BY (SELECT COUNT(*) FROM prospects q WHERE q.dept=MIN(p.dept) AND q.osm_checked_at IS NOT NULL) ASC, MAX(score) DESC, COUNT(*) DESC LIMIT ?`, maxGroups);
  for (const g of groups) {
    let places = [];
    try { places = await osmPlaces(g.postal, g.city); r.groups++; }
    catch (e) { r.groups++; if (e.stop) { r.stopped = e.message; break; } recordIncident(db, { kind: 'enrichissement', severity: 'info', message: String(e.message).slice(0, 160) }); continue; }
    const used = new Set();
    for (const p of db.all("SELECT * FROM prospects WHERE status='new' AND enriched_at IS NULL AND postal=?", g.postal)) {
      // Correspondance exacte par numéro SIRET quand la fiche OpenStreetMap l'indique, sinon par nom et adresse
      let i = places.findIndex((x, j) => !used.has(j) && x.siren && x.siren === p.siren);
      if (i < 0) i = places.findIndex((x, j) => !used.has(j) && !x.siren && matches(x, p));
      if (i < 0) { db.run('UPDATE prospects SET osm_checked_at=? WHERE id=?', now, p.id); continue; }
      used.add(i); const pl = places[i];
      const phone = phoneOk(pl.phone) ? pl.phone : null;
      db.run('UPDATE prospects SET phone=?, website=?, email=?, contact_source=?, enriched_at=?, osm_checked_at=?, site_status=COALESCE(?, site_status) WHERE id=?',
        phone, pl.website || null, pl.email || null, OSM_SOURCE, phone || pl.email ? now : null, now, siteFromListing(pl.website, false), p.id);
      if (phone || pl.email) r.found++;
    }
    // Découverte gratuite : établissements des métiers ciblés présents sur OpenStreetMap avec leur SIRET,
    // vérifiés au registre public (actif, sans opposition, 20 salariés au plus) avant import
    let checked = 0;
    for (const [j, pl] of places.entries()) {
      if (used.has(j) || !pl.siren || !OSM_KIND_TPL(pl.kind) || checked >= 15) continue;
      if (db.one('SELECT 1 FROM prospects WHERE siren=?', pl.siren) || isSuppressed(db, { siren: pl.siren, phone: pl.phone, email: pl.email })) continue;
      checked++;
      let p = null; try { p = await sireneBySiren(pl.siren); } catch { p = null; }
      if (pause) await new Promise((ok) => setTimeout(ok, pause));
      if (!p || !['NN', '00', '01', '02', '03', '11'].includes(p.staff) || !tplFromNaf(p.naf)) continue;
      importProspects(db, [p]);
      const phone = phoneOk(pl.phone) ? pl.phone : null;
      db.run('UPDATE prospects SET phone=?, website=?, email=?, contact_source=?, enriched_at=?, osm_checked_at=?, site_status=? WHERE siren=?', phone, pl.website || null, pl.email || null, OSM_SOURCE + ', SIRET vérifié au registre', phone || pl.email ? now : null, now, siteFromListing(pl.website, false), pl.siren);
      r.discovered = (r.discovered || 0) + 1; if (phone || pl.email) r.found++;
    }
    if (r.groups % 5 === 0 && config.appEnv !== 'test') console.log(`Coordonnées (OpenStreetMap) : ${r.groups}/${groups.length} codes postaux, ${r.found} trouvées`);
    if (pause) await new Promise((ok) => setTimeout(ok, Math.max(pause, 1000))); // usage raisonnable du service public
  }
  return r;
}

/**
 * Complète les prospects « À contacter » sans coordonnées, groupés par ville et métier :
 * 1. OpenStreetMap (gratuit) ; 2. fiches Maps via Firecrawl (10 crédits la recherche) pour ce qui manque ;
 * 3. lecture des sites (1 à 2 crédits) pour l'e-mail et l'analyse du site. Les entreprises SANS site sont gardées :
 * ce sont les prospects prioritaires, joignables par téléphone. S'arrête au plafond mensuel de crédits.
 */
export async function enrichBatch(db, { maxSearches = 20, now = Date.now(), emails = true, discover = true, pause = config.prospectPauseMs, osm = config.osmEnrich } = {}) {
  const r = { osm: null, searches: 0, matched: 0, discovered: 0, unverified: 0, emails: 0, sites: 0, reachable: 0, credits: 0, stopped: '' };
  if (osm) { r.osm = await osmPass(db, { now, pause }).catch((e) => ({ error: e.message })); r.reachable += r.osm.found || 0; }
  if (!enrichEnabled(db)) { r.stopped = 'désactivé'; finish(db, r, now); return r; }
  const start = creditsUsed(db, now); const cap = effectiveCap(db, now);
  const siteFor = async (id, website, needEmail = true) => {
    if (!website || creditsUsed(db, now) + 1 > cap || isPlatform(website)) return null;
    try { const { email, site } = await inspectSite(db, website, now, cap, { needEmail: emails && needEmail }); saveSite(db, id, site, now); if (site) r.sites++; if (email) r.emails++; return email; } catch { return null; }
  };
  // Sites connus pas encore lus (trouvés via OpenStreetMap ou anciens passages) : analyse + e-mail
  for (const p of db.all("SELECT id, website, email FROM prospects WHERE website IS NOT NULL AND site_checked_at IS NULL AND status='new' LIMIT 10")) {
    if (isPlatform(p.website)) { db.run("UPDATE prospects SET site_status='plateforme', site_checked_at=? WHERE id=?", now, p.id); continue; }
    if (creditsUsed(db, now) + 2 > cap) break;
    const e = await siteFor(p.id, p.website, !p.email);
    db.run("UPDATE prospects SET email=COALESCE(email,?), site_checked_at=COALESCE(site_checked_at,?) WHERE id=?", e, now, p.id);
  }
  // Répartition nationale : d'abord les départements les moins couverts, pour ne pas privilégier un territoire
  const groups = db.all(`SELECT tpl, postal, MIN(city) city, MIN(dept) dept, COUNT(*) n FROM prospects p WHERE status='new' AND enriched_at IS NULL AND postal!='' GROUP BY tpl, postal ORDER BY (SELECT COUNT(*) FROM prospects q WHERE q.dept=MIN(p.dept) AND q.enriched_at IS NOT NULL) ASC, MAX(score) DESC, n DESC LIMIT ?`, maxSearches);
  for (const g of groups) {
    if (creditsUsed(db, now) + 10 > cap) { r.stopped = cap < enrichCap(db) ? 'quota du jour atteint (crédits répartis sur le mois)' : 'plafond mensuel atteint'; break; }
    const pending = db.all("SELECT * FROM prospects WHERE status='new' AND enriched_at IS NULL AND tpl=? AND postal=?", g.tpl, g.postal);
    const label = (TEMPLATES[g.tpl]?.metier || g.tpl).toLowerCase();
    let places = [];
    try { places = await searchPlaces(db, { query: `${label} ${g.postal} ${g.city}`, postal: g.postal }, now); r.searches++; }
    catch (e) { r.searches++; if (e.stop) { r.stopped = e.message; break; } recordIncident(db, { kind: 'enrichissement', severity: 'info', message: String(e.message).slice(0, 160) }); }
    const used = new Set();
    // 1. Entreprises déjà repérées dans le registre
    for (const p of pending) {
      const pl = places.find((x, i) => !used.has(i) && x.business_status !== 'permanently_closed' && matches(x, p));
      if (!pl) { db.run('UPDATE prospects SET enriched_at=?, contact_source=? WHERE id=?', now, 'non trouvé', p.id); continue; }
      used.add(places.indexOf(pl));
      const phone = phoneOk(pl.phone_e164 || pl.phone) ? (pl.phone_e164 || pl.phone) : null;
      db.run('UPDATE prospects SET phone=?, website=?, contact_source=?, enriched_at=?, maps_closed=?, site_status=? WHERE id=?', phone, pl.website || null, 'fiche publique (Maps) + site', now, pl.business_status === 'temporarily_closed' ? 1 : 0, siteFromListing(pl.website, true), p.id);
      const email = await siteFor(p.id, pl.website); if (email) db.run('UPDATE prospects SET email=? WHERE id=?', email, p.id);
      if (pl.website) db.run('UPDATE prospects SET site_checked_at=COALESCE(site_checked_at,?) WHERE id=?', now, p.id);
      r.matched++; if (phone || email) r.reachable++;
    }
    // 2. Autres établissements ouverts de la fiche, avec ou sans site : vérifiés dans le registre (gratuit) avant tout import
    if (discover) for (const [i, pl] of places.entries()) {
      if (used.has(i) || pl.business_status === 'permanently_closed' || !(pl.phone || pl.phone_e164 || pl.website)) continue;
      let p = null; try { p = await verifyInSirene(pl, { postal: g.postal, city: g.city, tpl: g.tpl }); } catch { p = null; }
      if (pause) await new Promise((ok) => setTimeout(ok, pause));
      if (!p) { r.unverified++; continue; }
      if (db.one('SELECT 1 FROM prospects WHERE siren=?', p.siren)) continue;
      importProspects(db, [p]);
      const id = db.one('SELECT id FROM prospects WHERE siren=?', p.siren).id;
      const phone = phoneOk(pl.phone_e164 || pl.phone) ? (pl.phone_e164 || pl.phone) : null;
      db.run('UPDATE prospects SET phone=?, website=?, contact_source=?, enriched_at=?, site_status=? WHERE id=?', phone, pl.website || null, 'fiche publique (Maps) vérifiée au registre', now, siteFromListing(pl.website, true), id);
      const email = await siteFor(id, pl.website); if (email) db.run('UPDATE prospects SET email=? WHERE id=?', email, id);
      if (pl.website) db.run('UPDATE prospects SET site_checked_at=COALESCE(site_checked_at,?) WHERE id=?', now, id);
      r.discovered++; if (phone || email) r.reachable++;
    }
  }
  r.credits = creditsUsed(db, now) - start;
  finish(db, r, now);
  return r;
}
function finish(db, r, now) {
  r.qualite = cleanContacts(db); // format international, doublons, oppositions
  setMeta(db, `enrich_reachable_${month(now)}`, Number(meta(db, `enrich_reachable_${month(now)}`) || 0) + r.reachable);
  refreshPotentials(db);
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.enrich',?,?)", JSON.stringify(r), now);
}
export function enrichStatus(db, now = Date.now()) {
  const c = db.one("SELECT COUNT(*) total, SUM(enriched_at IS NOT NULL) done, SUM(phone IS NOT NULL) phones, SUM(email IS NOT NULL) emails FROM prospects WHERE status!='optout'");
  const reach = Number(meta(db, `enrich_reachable_${month(now)}`) || 0); const used = creditsUsed(db, now);
  // Coût par prospect réellement joignable (téléphone ou e-mail trouvé), en crédits et en euros selon le prix du crédit
  const perReach = reach ? used / reach : null;
  return { enabled: enrichEnabled(db), keySet: !!config.firecrawlKey, cap: enrichCap(db), used, today: usedToday(db, now), todayCap: effectiveCap(db, now) - (used - usedToday(db, now)), reachableMonth: reach, creditsPerReachable: perReach, eurPerReachable: perReach != null ? perReach * config.enrichEurPerCredit : null, ...c };
}
