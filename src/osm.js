// Coordonnées professionnelles publiques depuis OpenStreetMap (gratuit, licence ODbL : attribution obligatoire).
// Une requête par code postal renvoie tous les établissements nommés qui ont un téléphone.
// Utilisé AVANT Firecrawl : ce qui est trouvé ici ne coûte aucun crédit.
import { config } from './config.js';
import { net } from './net.js';

export const OSM_SOURCE = 'OpenStreetMap (© contributeurs OSM, ODbL)';
const first = (v) => (v ? String(v).split(';')[0].trim() : null);

/** Centre de la commune (API publique gratuite geo.api.gouv.fr), pour une recherche par zone rapide. */
export async function communeCentre(postal, city) {
  const res = await net.fetch(`${config.geoApi}/communes?codePostal=${encodeURIComponent(String(postal).replace(/\D/g, ''))}&fields=nom,centre&format=json`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return null;
  const list = await res.json(); if (!Array.isArray(list) || !list.length) return null;
  const norm = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  const c = list.find((x) => norm(x.nom) === norm(city)) || list[0];
  const [lon, lat] = c.centre?.coordinates || []; return Number.isFinite(lat) ? { lat, lon } : null;
}
/** Requête légère : établissements nommés avec téléphone dans un carré d'environ 9 km autour du centre. */
export function overpassQuery({ lat, lon }, half = 0.04) {
  const n = (v) => Number(v).toFixed(5);
  const bb = `(${n(lat - half)},${n(lon - half)},${n(lat + half)},${n(lon + half)})`;
  return `[out:json][timeout:25];(${['phone', 'contact:phone', 'mobile', 'contact:mobile'].map((k) => `nwr["${k}"]["name"]${bb};`).join('')});out tags 800;`;
}

let preferred = 0; // dernier serveur qui a répondu
const down = new Map(); // serveur en échec -> écarté pendant 30 minutes
export const resetOsmHealth = () => down.clear();
export async function osmPlaces(postal, city) {
  const centre = await communeCentre(postal, city).catch(() => null);
  if (!centre) return [];
  const apis = config.overpassApis; let res = null; let lastErr = '';
  for (let k = 0; k < apis.length; k++) {
    const i = (preferred + k) % apis.length;
    if ((down.get(apis[i]) || 0) > Date.now()) { lastErr = lastErr || 'serveurs OpenStreetMap indisponibles'; continue; }
    try {
      res = await net.fetch(apis[i], {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; requetes espacees)' },
        body: 'data=' + encodeURIComponent(overpassQuery(centre)),
        signal: AbortSignal.timeout(20000)
      });
    } catch (e) { lastErr = `${e.message}${e.cause?.code ? ' (' + e.cause.code + ')' : ''}`; res = null; down.set(apis[i], Date.now() + 30 * 60e3); continue; }
    if (res.ok) { preferred = i; break; }
    lastErr = `OpenStreetMap ${res.status}`; res = null; down.set(apis[i], Date.now() + 30 * 60e3); // saturé ou refusé : serveur suivant
  }
  if (!res) throw Object.assign(new Error(lastErr || 'OpenStreetMap indisponible'), { stop: true });
  const seen = new Set();
  return ((await res.json()).elements || []).map((e) => e.tags || {}).filter((t) => {
    const k = `${t.name}|${t.phone || t['contact:phone'] || t.mobile || t['contact:mobile']}`; if (seen.has(k)) return false; seen.add(k); return !t.disused && !t['disused:shop'];
  }).map((t) => ({
    name: t.name,
    address: [t['addr:housenumber'], t['addr:street'], t['addr:postcode'] || postal, t['addr:city'] || city].filter(Boolean).join(' '),
    phone: first(t.phone || t['contact:phone'] || t.mobile || t['contact:mobile']),
    website: first(t.website || t['contact:website'] || t.url),
    email: first(t.email || t['contact:email']),
    siren: /^\d{14}$/.test(String(t['ref:FR:SIRET'] || '').replace(/\s/g, '')) ? String(t['ref:FR:SIRET']).replace(/\s/g, '').slice(0, 9) : null,
    kind: t.shop || t.amenity || t.craft || t.office || t.tourism || '',
    business_status: 'operational'
  }));
}
