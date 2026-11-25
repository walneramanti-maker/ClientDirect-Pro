import { config } from './config.js';
import { net } from './net.js';
import { TEMPLATES, tplFromNaf } from './templates.js';
import { createTenant } from './tenants.js';
import { clampStr, sha256, hmac } from './util.js';
import { recordIncident } from './incidents.js';

// Codes commune INSEE des principales villes ciblées
export const COMMUNES = {
  '97302': 'Cayenne', '97307': 'Matoury', '97309': 'Rémire-Montjoly', '97304': 'Kourou', '97311': 'Saint-Laurent-du-Maroni', '97305': 'Macouria',
  '97209': 'Fort-de-France', '97213': 'Le Lamentin', '97120': 'Pointe-à-Pitre', '97101': 'Les Abymes', '97411': 'Saint-Denis (Réunion)', '97416': 'Saint-Pierre (Réunion)'
};

/** Convertit un résultat de l'API Recherche d'entreprises. Renvoie null pour les entreprises à ne jamais démarcher. */
export function fromSirene(r, fallbackTpl = null, commune = null) {
  // Non-diffusion (« [ND] ») ou opposition à l'utilisation commerciale des données : jamais importées
  if (r.statut_diffusion === 'P' || r.opposition_diffusion_commerciale === true || /\[ND\]/.test(r.nom_complet || '')) return null;
  const e = (commune && (r.matching_etablissements || []).find((x) => x.commune === commune)) || r.siege || {};
  if (/\[ND\]/.test(e.adresse || '')) return null;
  return { siren: r.siren, siret: e.siret || '', name: clampStr(r.nom_complet || r.nom_raison_sociale || '', 120), naf: r.activite_principale || '',
    tpl: tplFromNaf(r.activite_principale) || fallbackTpl || 'artisan', city: e.libelle_commune || COMMUNES[commune] || '', postal: e.code_postal || '', address: clampStr(e.adresse || '', 200),
    created_on: r.date_creation || null, staff: r.tranche_effectif_salarie || 'NN' };
}
/** Interroge l'API publique Recherche d'entreprises (gratuite, sans clé) : activité principale + commune de l'établissement. */
export async function searchSirene({ tpl, commune, page = 1 }) {
  const T = TEMPLATES[tpl]; if (!T) throw new Error('Métier inconnu');
  if (!COMMUNES[commune]) throw new Error('Commune inconnue');
  const url = `${config.sireneApi}/search?activite_principale=${encodeURIComponent(T.naf.join(','))}&code_commune=${commune}&etat_administratif=A&per_page=25&page=${page}`;
  const res = await net.fetch(url, { headers: { accept: 'application/json' } });
  if (res.status === 429) throw new Error("L'API publique limite le nombre de requêtes, réessayez dans une minute.");
  if (!res.ok) throw new Error(`API Recherche d'entreprises ${res.status}`);
  const j = await res.json();
  // Les grandes entreprises (plus de 20 salariés) ne sont pas la cible
  return (j.results || []).map((r) => fromSirene(r, tpl, commune)).filter((p) => p && ['NN', '00', '01', '02', '03', '11'].includes(p.staff));
}
/** Recherche une entreprise précise par son SIREN. */
export async function sireneBySiren(siren) {
  const res = await net.fetch(`${config.sireneApi}/search?q=${encodeURIComponent(siren)}&per_page=1`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`API Recherche d'entreprises ${res.status}`);
  const r = (await res.json()).results?.find((x) => x.siren === siren);
  return r ? fromSirene(r, null, r.siege?.commune) : null;
}

/** Note de priorité : entreprises récentes et métiers où la prise de rendez-vous apporte le plus. */
export function scoreProspect(p, today = new Date()) {
  let s = 1;
  const y = p.created_on ? (today - new Date(p.created_on)) / (365.25 * 864e5) : null;
  if (y !== null && y < 1) s += 3; else if (y !== null && y < 5) s += 2;
  if (['garage', 'coiffeur', 'location'].includes(p.tpl)) s += 2; else if (['artisan', 'restaurant'].includes(p.tpl)) s += 1;
  return s;
}

/** Enregistre les entreprises trouvées sans créer de doublon. */
export function importProspects(db, list) {
  let added = 0;
  for (const p of list) {
    if (!p.siren || db.one('SELECT 1 FROM prospects WHERE siren=?', p.siren)) continue;
    db.run('INSERT INTO prospects(siren,siret,name,naf,tpl,city,postal,address,created_on,score,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)', p.siren, p.siret, p.name, p.naf, p.tpl, p.city, p.postal, p.address, p.created_on, scoreProspect(p), Date.now());
    added++;
  }
  return added;
}

/** Prépare un site de démonstration au nom de l'entreprise prospectée (non publié). */
/** Nom commercial lisible : l'enseigne entre parenthèses plutôt que le nom de la personne (entreprise individuelle). */
export function displayName(raw) {
  const m = /\(([^()]+)\)\s*$/.exec(raw || ''); let s = (m ? m[1] : raw || '').replace(/^(SAS|SARL|SASU|EURL)\s+/i, '').trim();
  if (s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|[\s'’\-&.(])([a-zà-ÿ])/g, (x, a, b) => a + b.toUpperCase()).replace(/\b(Slm|Sas|Sarl|Snc)\b/g, (x) => x.toUpperCase());
  return s;
}
/** Jeton de démonstration stable (le même lien survit à un redémarrage du serveur). */
export const demoTokenFor = (siren) => hmac(config.secret, 'demo:' + siren).slice(0, 32);
export function prepareDemo(db, prospectId, { stable = false } = {}) {
  const p = db.one('SELECT * FROM prospects WHERE id=?', prospectId); if (!p) throw new Error('Prospect introuvable');
  if (p.status === 'optout') throw new Error("Cette entreprise a demandé à ne plus être contactée.");
  if (p.demo_tenant_id && db.one("SELECT 1 FROM tenants WHERE id=? AND status='demo'", p.demo_tenant_id) && stable) return { tenantId: p.demo_tenant_id, demoUrl: `${config.baseUrl}/demo/${demoTokenFor(p.siren)}`, demoToken: demoTokenFor(p.siren) };
  const name = displayName(p.name);
  const r = createTenant(db, { name, tpl: p.tpl, city: displayName(p.city), address: p.address, status: 'demo', prospectId: p.id, demoToken: stable ? demoTokenFor(p.siren) : null });
  db.run("UPDATE prospects SET status=CASE WHEN status IN ('new','contacted') THEN 'demo' ELSE status END, demo_tenant_id=? WHERE id=?", r.id, p.id);
  return { tenantId: r.id, demoUrl: `${config.baseUrl}/demo/${r.demoToken}`, demoToken: r.demoToken };
}

/** Message de prise de contact, prêt à copier (WhatsApp, e-mail, SMS). */
/** Message de prise de contact B2B : identifie l'expéditeur, l'origine des données et donne un moyen simple de s'opposer. */
export function outreachMessage(p, demoUrl, stopUrl) {
  return `Bonjour, je suis ${config.legal.owner}, de ClientDirect Pro. J'ai préparé gratuitement un exemple de site pour ${displayName(p.name)} : vos clients y voient vos prestations, prennent rendez-vous en ligne et vous écrivent sur WhatsApp. C'est une démonstration non officielle, visible seulement par vous : ${demoUrl}\nSi ça vous intéresse, je passe vous le montrer en 10 minutes.\n\nVos coordonnées professionnelles proviennent du registre public des entreprises (INSEE). Pour ne plus être contacté et supprimer cette démo : ${stopUrl} (ou répondez STOP).`;
}

export function demoTenantByToken(db, token) {
  if (!token) return null;
  return db.one("SELECT * FROM tenants WHERE demo_token_hash=? AND status='demo'", sha256(token));
}
export function recordDemoView(db, tenant) {
  if (tenant.prospect_id) db.run('UPDATE prospects SET demo_views=demo_views+1 WHERE id=?', tenant.prospect_id);
}
export const PIPELINE = { new: 'À contacter', contacted: 'Contacté', demo: 'Démo envoyée', converted: 'Client', lost: 'Pas intéressé', optout: 'Ne plus contacter' };
export function prospectStats(db) {
  const rows = db.all('SELECT status, COUNT(*) n, SUM(demo_views) v FROM prospects GROUP BY status');
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n])); const total = rows.reduce((a, r) => a + r.n, 0);
  return { total, by, conversion: total ? Math.round(((by.converted || 0) / total) * 1000) / 10 : 0 };
}
export const safeSearch = async (db, q) => { try { return await searchSirene(q); } catch (e) { recordIncident(db, { kind: 'prospection', severity: 'info', message: String(e.message).slice(0, 160) }); throw e; } };

/**
 * Prépare au démarrage les prospects listés (PROSPECT_SEED = SIREN séparés par des virgules) et leur démo,
 * avec des liens stables : le même lien fonctionne même après un redémarrage du serveur.
 * Les entreprises qui se sont opposées ou qui figurent sur la liste d'opposition du registre sont ignorées.
 */
export async function seedProspects(db, sirens, { pause = 160 } = {}) {
  const r = { imported: 0, demos: 0, skipped: 0, errors: 0 };
  const { optoutLink } = await import('./privacy.js');
  for (const siren of sirens.map((x) => x.trim()).filter((x) => /^\d{9}$/.test(x))) {
    try {
      let p = db.one('SELECT * FROM prospects WHERE siren=?', siren);
      if (p?.status === 'optout') { r.skipped++; continue; }
      if (!p) {
        const found = await sireneBySiren(siren); if (pause) await new Promise((ok) => setTimeout(ok, pause));
        if (!found) { r.skipped++; continue; }
        importProspects(db, [found]); r.imported++; p = db.one('SELECT * FROM prospects WHERE siren=?', siren);
      }
      prepareDemo(db, p.id, { stable: true }); optoutLink(db, p.id); r.demos++;
    } catch (e) { r.errors++; recordIncident(db, { kind: 'prospect_seed', severity: 'info', message: `Prospect ${siren} : ${String(e.message).slice(0, 120)}` }); }
  }
  return r;
}
