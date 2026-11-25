// Noms de domaine propres aux entreprises (ex. www.garage-dupont.fr), ajoutés automatiquement sur Render.
import { config } from './config.js';
import { net } from './net.js';
import { recordIncident } from './incidents.js';

const RESERVED = () => [config.rootDomain, new URL(config.baseUrl).hostname].filter(Boolean);
/** Nettoie et valide un nom de domaine saisi par un professionnel. Renvoie { domain } ou { error }. */
export function normalizeDomain(raw) {
  let d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  if (!d) return { domain: null };
  try { d = new URL(`http://${d}`).hostname; } catch { return { error: 'Nom de domaine invalide.' }; }
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d)) return { error: 'Nom de domaine invalide (exemple : www.mon-garage.fr).' };
  if (RESERVED().some((r) => d === r || d.endsWith('.' + r))) return { error: 'Ce domaine appartient à ClientDirect Pro.' };
  return { domain: d };
}
export const renderConfigured = () => !!(config.renderApiKey && config.renderServiceId);
async function render(method, path, body) {
  const res = await net.fetch(`https://api.render.com/v1/services/${config.renderServiceId}/custom-domains${path}`, {
    method, headers: { authorization: `Bearer ${config.renderApiKey}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch { /* vide */ }
  return { status: res.status, ok: res.ok, j };
}
/** Enregistre le domaine d'une entreprise et le déclare chez l'hébergeur. */
export async function setDomain(db, t, raw) {
  const { domain, error } = normalizeDomain(raw); if (error) return { ok: false, msg: error };
  const other = domain && db.one('SELECT id FROM tenants WHERE custom_domain=? AND id!=?', domain, t.id);
  if (other) return { ok: false, msg: 'Ce domaine est déjà utilisé par une autre entreprise.' };
  if (t.custom_domain && t.custom_domain !== domain && renderConfigured()) await render('DELETE', `/${encodeURIComponent(t.custom_domain)}`).catch(() => {});
  if (!domain) { db.run("UPDATE tenants SET custom_domain=NULL, domain_status='none' WHERE id=?", t.id); return { ok: true, msg: 'Domaine retiré.' }; }
  let status = 'pending';
  if (renderConfigured()) {
    const r = await render('POST', '', { name: domain });
    if (!r.ok && r.status !== 409) { recordIncident(db, { kind: 'domain', severity: 'warning', message: `Ajout du domaine ${domain} refusé par Render (${r.status})`, tenantId: t.id }); return { ok: false, msg: "L'hébergeur a refusé ce domaine pour le moment. L'équipe est prévenue." }; }
  } else status = 'manual';
  db.run('UPDATE tenants SET custom_domain=?, domain_status=?, updated_at=? WHERE id=?', domain, status, Date.now(), t.id);
  return { ok: true, msg: 'Domaine enregistré. Configurez maintenant votre DNS comme indiqué ci-dessous.' };
}
/** Vérifie auprès de Render les domaines en attente (DNS configuré + certificat émis). */
export async function checkDomains(db) {
  if (!renderConfigured()) return { checked: 0, verified: 0 };
  let checked = 0, verified = 0;
  for (const t of db.all("SELECT id, custom_domain FROM tenants WHERE domain_status='pending' AND custom_domain IS NOT NULL LIMIT 50")) {
    checked++;
    await render('POST', `/${encodeURIComponent(t.custom_domain)}/verify`).catch(() => null);
    const r = await render('GET', `/${encodeURIComponent(t.custom_domain)}`).catch(() => null);
    if (r?.ok && String(r.j.verificationStatus || '').toLowerCase() === 'verified') { db.run("UPDATE tenants SET domain_status='verified', updated_at=? WHERE id=?", Date.now(), t.id); verified++; }
  }
  return { checked, verified };
}
/** Entreprise correspondant au nom d'hôte de la requête (domaine propre vérifié). */
export const tenantByDomain = (db, host) => db.one("SELECT slug FROM tenants WHERE custom_domain=? AND domain_status IN ('verified','manual')", host);
