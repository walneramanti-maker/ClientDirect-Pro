import { config } from './config.js';
import { net } from './net.js';
import { TEMPLATES, tplFromNaf } from './templates.js';
import { createTenant } from './tenants.js';
import { clampStr, sha256 } from './util.js';
import { recordIncident } from './incidents.js';

// Codes commune INSEE des principales villes ciblées
export const COMMUNES = {
  '97302': 'Cayenne', '97307': 'Matoury', '97309': 'Rémire-Montjoly', '97304': 'Kourou', '97311': 'Saint-Laurent-du-Maroni', '97305': 'Macouria',
  '97209': 'Fort-de-France', '97213': 'Le Lamentin', '97120': 'Pointe-à-Pitre', '97101': 'Les Abymes', '97411': 'Saint-Denis (Réunion)', '97416': 'Saint-Pierre (Réunion)'
};

/** Interroge l'API publique Recherche d'entreprises (gratuite, sans clé) par code NAF et commune. */
export async function searchSirene({ tpl, commune, page = 1 }) {
  const T = TEMPLATES[tpl]; if (!T) throw new Error('Métier inconnu');
  if (!COMMUNES[commune]) throw new Error('Commune inconnue');
  const out = [];
  for (const naf of T.naf) {
    const url = `${config.sireneApi}/search?code_naf=${encodeURIComponent(naf)}&code_commune=${commune}&etat_administratif=A&per_page=25&page=${page}`;
    const res = await net.fetch(url, { headers: { accept: 'application/json' } });
    if (res.status === 429) throw new Error("L'API publique limite le nombre de requêtes, réessayez dans une minute.");
    if (!res.ok) throw new Error(`API Recherche d'entreprises ${res.status}`);
    const j = await res.json();
    for (const r of j.results || []) {
      // Entreprises ayant demandé la non-diffusion de leurs données (« [ND] ») : jamais importées
      if (r.statut_diffusion === 'P' || /\[ND\]/.test(r.nom_complet || '') || /\[ND\]/.test(r.siege?.adresse || '')) continue;
      const s = r.siege || {};
      out.push({ siren: r.siren, siret: s.siret || '', name: clampStr(r.nom_complet || r.nom_raison_sociale || '', 120), naf: r.activite_principale || naf,
        tpl: tplFromNaf(r.activite_principale) || tpl, city: s.libelle_commune || COMMUNES[commune], postal: s.code_postal || '', address: clampStr(s.adresse || '', 200), created_on: r.date_creation || s.date_creation || null });
    }
  }
  return out;
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
export function prepareDemo(db, prospectId) {
  const p = db.one('SELECT * FROM prospects WHERE id=?', prospectId); if (!p) throw new Error('Prospect introuvable');
  if (p.status === 'optout') throw new Error("Cette entreprise a demandé à ne plus être contactée.");
  const name = p.name.replace(/\s*\(.*?\)\s*/g, ' ').trim() || p.name;
  const r = createTenant(db, { name, tpl: p.tpl, city: p.city, address: p.address, status: 'demo', prospectId: p.id });
  db.run("UPDATE prospects SET status='demo', demo_tenant_id=? WHERE id=?", r.id, p.id);
  return { tenantId: r.id, demoUrl: `${config.baseUrl}/demo/${r.demoToken}`, demoToken: r.demoToken };
}

/** Message de prise de contact, prêt à copier (WhatsApp, e-mail, SMS). */
/** Message de prise de contact B2B : identifie l'expéditeur, l'origine des données et donne un moyen simple de s'opposer. */
export function outreachMessage(p, demoUrl, stopUrl) {
  return `Bonjour, je suis ${config.legal.owner}, de ClientDirect Pro. J'ai préparé gratuitement un exemple de site pour ${p.name} : vos clients y voient vos prestations, prennent rendez-vous en ligne et vous écrivent sur WhatsApp. Vous pouvez le regarder ici : ${demoUrl}\nSi ça vous intéresse, je passe vous le montrer en 10 minutes.\n\nVos coordonnées professionnelles proviennent du registre public des entreprises (INSEE). Pour ne plus être contacté et supprimer cette démo : ${stopUrl} (ou répondez STOP).`;
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
