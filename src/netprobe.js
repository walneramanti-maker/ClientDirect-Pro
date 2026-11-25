// Diagnostic réseau au démarrage : l'API Brevo (HTTPS) est-elle joignable ? Les ports SMTP sont-ils ouverts ?
// Render bloque les ports SMTP 25, 465 et 587 sur les serveurs gratuits : seule l'API HTTPS de Brevo fonctionne alors.
import net from 'node:net';
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
  r.smtp587 = await tcp('smtp-relay.brevo.com', 587);
  r.smtp465 = await tcp('smtp-relay.brevo.com', 465);
  return r;
}
