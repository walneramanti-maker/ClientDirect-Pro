// Coordonnées professionnelles publiques depuis OpenStreetMap (gratuit, licence ODbL : attribution obligatoire).
// Une requête par code postal renvoie tous les établissements nommés qui ont un téléphone.
// Utilisé AVANT Firecrawl : ce qui est trouvé ici ne coûte aucun crédit.
import { config } from './config.js';
import { net } from './net.js';

export const OSM_SOURCE = 'OpenStreetMap (© contributeurs OSM, ODbL)';
const PHONE_KEYS = '^(phone|contact:phone|mobile|contact:mobile)$';
const first = (v) => (v ? String(v).split(';')[0].trim() : null);

export function overpassQuery(postal) {
  const p = String(postal).replace(/[^0-9A-Za-z]/g, '');
  return `[out:json][timeout:25];area["boundary"="postal_code"]["postal_code"="${p}"]->.pc;(nwr(area.pc)["name"][~"${PHONE_KEYS}"~"."];nwr["addr:postcode"="${p}"]["name"][~"${PHONE_KEYS}"~"."];);out tags 500;`;
}

/** Établissements avec téléphone d'un code postal, au format des fiches utilisées pour la correspondance. */
let preferred = 0; // dernier serveur qui a répondu
const down = new Map(); // serveur en échec -> écarté pendant 30 minutes
export const resetOsmHealth = () => down.clear();
export async function osmPlaces(postal, city) {
  const apis = config.overpassApis; let res = null; let lastErr = '';
  for (let k = 0; k < apis.length; k++) {
    const i = (preferred + k) % apis.length;
    if ((down.get(apis[i]) || 0) > Date.now()) { lastErr = lastErr || 'serveurs OpenStreetMap indisponibles'; continue; }
    try {
      res = await net.fetch(apis[i], {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; requetes espacees)' },
        body: 'data=' + encodeURIComponent(overpassQuery(postal)),
        signal: AbortSignal.timeout(20000)
      });
    } catch (e) { lastErr = e.message; res = null; down.set(apis[i], Date.now() + 30 * 60e3); continue; }
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
    business_status: 'operational'
  }));
}
