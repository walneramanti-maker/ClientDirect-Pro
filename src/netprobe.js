// Diagnostic réseau au démarrage : l'API Brevo (HTTPS) est-elle joignable ? Les ports SMTP sont-ils ouverts ?
// Render bloque les ports SMTP 25, 465 et 587 sur les serveurs gratuits : seule l'API HTTPS de Brevo fonctionne alors.
import net from 'node:net';
import https from 'node:https';
import { config } from './config.js';
import { net as http } from './net.js';

function tcp(host, port, ms = 6000) {
  return new Promise((ok) => {
    const s = net.connect({ host, port }); const t = setTimeout(() => { s.destroy(); ok('bloqué (délai dépassé)'); }, ms);
    s.once('connect', () => { clearTimeout(t); s.end(); ok('ouvert'); });
    s.once('error', (e) => { clearTimeout(t); ok(`fermé (${e.code || e.message})`); });
  });
}
export async function probeNetwork() {
  const r = {};
  try {
    const res = await http.fetch('https://api.brevo.com/v3/account', { headers: { accept: 'application/json', ...(config.brevoKey ? { 'api-key': config.brevoKey } : {}) }, signal: AbortSignal.timeout(15000) });
    r.brevoApi = res.status === 200 ? 'joignable, clé valide' : res.status === 401 ? (config.brevoKey ? 'joignable, CLÉ REFUSÉE' : 'joignable (clé non encore configurée)') : `joignable, HTTP ${res.status}`;
  } catch (e) { r.brevoApi = `injoignable (${e.message})`; }
  // Serveurs OpenStreetMap (coordonnées gratuites) : requête minimale, cause exacte en cas d'échec
  r.overpass = {};
  for (const api of config.overpassApis) {
    const t0 = Date.now();
    try {
      const res = await http.fetch(api, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; requetes espacees)' }, body: 'data=' + encodeURIComponent('[out:json][timeout:10];node(1);out;'), signal: AbortSignal.timeout(20000) });
      r.overpass[new URL(api).host] = `HTTP ${res.status} en ${Date.now() - t0} ms`;
    } catch (e) { r.overpass[new URL(api).host] = `échec : ${e.cause?.code || e.cause?.message || e.name || e.message} en ${Date.now() - t0} ms`; }
  }
  // API publique Recherche d'entreprises (prospection nationale)
  { const t0 = Date.now();
    try { const res = await http.fetch(`${config.sireneApi}/search?q=garage&per_page=1`, { headers: { accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; contact@clientdirectpro.fr)' }, signal: AbortSignal.timeout(15000) }); r.sirene = `HTTP ${res.status} en ${Date.now() - t0} ms`; }
    catch (e) { r.sirene = `échec : ${e.cause?.code || e.cause?.message || e.name || e.message} en ${Date.now() - t0} ms`; } }
  if (config.sireneFallback) { const t0 = Date.now();
    try { const res = await http.fetch(`${config.sireneFallback}?limit=1`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); r.sirene_secours = `HTTP ${res.status} en ${Date.now() - t0} ms`; }
    catch (e) { r.sirene_secours = `échec : ${e.cause?.code || e.cause?.message || e.name || e.message} en ${Date.now() - t0} ms`; } }
  // Même API en IPv4 puis en IPv6 forcés : distingue un blocage d'adresse d'un problème de famille d'adresses
  for (const family of [4, 6]) {
    r[`sirene_ipv${family}`] = await new Promise((ok) => {
      const t0 = Date.now(); const u = new URL(`${config.sireneApi}/search?q=garage&per_page=1`);
      const req = https.get({ host: u.hostname, path: u.pathname + u.search, family, timeout: 15000, headers: { accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; contact@clientdirectpro.fr)' } }, (res) => { res.resume(); ok(`HTTP ${res.statusCode} en ${Date.now() - t0} ms`); });
      req.on('timeout', () => { req.destroy(); ok('délai dépassé'); }); req.on('error', (e) => ok(`échec : ${e.code || e.message} (${e.address || '?'}) en ${Date.now() - t0} ms`));
    });
  }
  r.smtp587 = await tcp('smtp-relay.brevo.com', 587);
  r.smtp465 = await tcp('smtp-relay.brevo.com', 465);
  return r;
}
