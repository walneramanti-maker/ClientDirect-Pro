import { isSuppressed } from './suppression.js';
import { refreshPotentials } from './potential.js';
import { config } from './config.js';
import { net } from './net.js';
import { TEMPLATES, tplFromNaf } from './templates.js';
import { createTenant } from './tenants.js';
import { clampStr, sha256, hmac } from './util.js';
import { recordIncident } from './incidents.js';
import { DEPARTEMENTS, DEPT_CODES, deptOf, territoryOf } from './france.js';

// Codes commune INSEE des principales villes ciblées
export const COMMUNES = {
  '97302': 'Cayenne', '97307': 'Matoury', '97309': 'Rémire-Montjoly', '97304': 'Kourou', '97311': 'Saint-Laurent-du-Maroni', '97305': 'Macouria',
  '97209': 'Fort-de-France', '97213': 'Le Lamentin', '97120': 'Pointe-à-Pitre', '97101': 'Les Abymes', '97411': 'Saint-Denis (Réunion)', '97416': 'Saint-Pierre (Réunion)'
};

/** Convertit un résultat de l'API Recherche d'entreprises. Renvoie null pour les entreprises à ne jamais démarcher. */
export function fromSirene(r, fallbackTpl = null, commune = null, dept = null) {
  // Non-diffusion (« [ND] ») ou opposition à l'utilisation commerciale des données : jamais importées
  if (r.statut_diffusion === 'P' || r.opposition_diffusion_commerciale === true || /\[ND\]/.test(r.nom_complet || '')) return null;
  const m = r.matching_etablissements || [];
  const e = (commune && m.find((x) => x.commune === commune)) || (dept && m.find((x) => deptOf(x.code_postal) === dept)) || r.siege || {};
  if (/\[ND\]/.test(e.adresse || '')) return null;
  return { siren: r.siren, siret: e.siret || '', name: clampStr(r.nom_complet || r.nom_raison_sociale || '', 120), naf: r.activite_principale || '',
    tpl: tplFromNaf(r.activite_principale) || fallbackTpl || 'artisan', city: e.libelle_commune || COMMUNES[commune] || '', postal: e.code_postal || '', address: clampStr(e.adresse || '', 200),
    created_on: r.date_creation || null, staff: r.tranche_effectif_salarie || 'NN', dept: deptOf(e.code_postal) };
}
/** Interroge l'API publique Recherche d'entreprises (gratuite, sans clé) : activité principale + commune OU département. */
export async function searchSirene({ tpl, commune = null, departement = null, page = 1, withMeta = false }) {
  const T = TEMPLATES[tpl]; if (!T) throw new Error('Métier inconnu');
  let where;
  if (departement) { if (!DEPARTEMENTS[departement]) throw new Error('Département inconnu'); where = `departement=${departement}`; }
  else { if (!COMMUNES[commune]) throw new Error('Commune inconnue'); where = `code_commune=${commune}`; }
  const url = `${config.sireneApi}/search?activite_principale=${encodeURIComponent(T.naf.join(','))}&${where}&etat_administratif=A&per_page=25&page=${page}`;
  let res;
  // API principale injoignable (connexions refusées depuis l'hébergeur) : la copie publique du registre prend le relais
  const viaFallback = async (err) => { if (!config.sireneFallback || !departement) throw err; let r; try { r = await searchSireneFallback({ tpl, departement, page }); } catch (fe) { throw Object.assign(new Error(`${err.message} ; ${fe.message}`), { network: !!(err.network || fe.network), rateLimited: fe.rateLimited }); } return withMeta ? r : r.list; };
  // Échec réseau : cause exacte (DNS, connexion refusée, TLS, délai) au lieu du seul « fetch failed »
  try { res = await net.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; contact@clientdirectpro.fr)' }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { const c = e.cause?.code || e.cause?.message || e.name; const err = Object.assign(new Error(`${e.message}${c && c !== e.message ? ` (${c})` : ''}`), { network: true }); return viaFallback(err); }
  if (res.status >= 500) return viaFallback(new Error(`API Recherche d'entreprises ${res.status}`));
  if (res.status === 429) throw Object.assign(new Error("L'API publique limite le nombre de requêtes, réessayez dans une minute."), { rateLimited: true });
  if (!res.ok) throw new Error(`API Recherche d'entreprises ${res.status}`);
  const j = await res.json();
  // Les grandes entreprises (plus de 20 salariés) ne sont pas la cible
  const list = (j.results || []).map((r) => fromSirene(r, tpl, commune, departement)).filter((p) => p && ['NN', '00', '01', '02', '03', '11'].includes(p.staff));
  return withMeta ? { list, totalPages: Number(j.total_pages) || 0, raw: (j.results || []).length } : list;
}
const STAFF_ODS = { 'Etablissement non employeur': 'NN', '0 salarié': '00', '1 ou 2 salariés': '01', '3 à 5 salariés': '02', '6 à 9 salariés': '03', '10 à 19 salariés': '11' };
/** Copie publique du registre SIRENE (OpenDataSoft, gratuite, sans clé) : mêmes critères que l'API principale. */
export async function searchSireneFallback({ tpl, departement, page = 1 }) {
  const T = TEMPLATES[tpl]; if (!T || !DEPARTEMENTS[departement]) throw new Error('Critères inconnus');
  const where = `activiteprincipaleetablissement in (${T.naf.map((n) => `"${n}"`).join(',')}) and codedepartementetablissement="${departement}" and etatadministratifetablissement="Actif" and statutdiffusionetablissement="O" and (trancheeffectifsetablissementtriable is null or trancheeffectifsetablissementtriable<=10)`;
  const url = `${config.sireneFallback}?where=${encodeURIComponent(where)}&order_by=siret&limit=25&offset=${(page - 1) * 25}`;
  let res;
  try { res = await net.fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ClientDirectPro/1.0 (prospection B2B ; contact@clientdirectpro.fr)' }, signal: AbortSignal.timeout(20000) }); }
  catch (e) { const c = e.cause?.code || e.cause?.message || e.name; throw Object.assign(new Error(`secours : ${e.message}${c && c !== e.message ? ` (${c})` : ''}`), { network: true }); }
  if (res.status === 429) throw Object.assign(new Error('Source de secours : limite de requêtes atteinte'), { rateLimited: true });
  if (!res.ok) throw Object.assign(new Error(`Source de secours ${res.status}`), { network: res.status >= 500 });
  const j = await res.json(); const rows = j.results || [];
  const list = rows.map((r) => {
    const legal = r.denominationunitelegale || [r.prenomusuelunitelegale || r.prenom1unitelegale, r.nomusageunitelegale || r.nomunitelegale].filter(Boolean).join(' ');
    const ens = r.enseigne1etablissement || r.denominationusuelleetablissement || r.denominationusuelle1unitelegale;
    const name = clampStr(`${legal || ens || ''}${ens && legal && ens !== legal ? ` (${ens})` : ''}`.toUpperCase(), 120);
    if (!name || /\[ND\]/.test(name)) return null;
    const postal = r.codepostaletablissement || '';
    return { siren: r.siren, siret: r.siret || '', name, naf: r.activiteprincipaleetablissement || '', tpl: tplFromNaf(r.activiteprincipaleetablissement) || tpl, city: r.libellecommuneetablissement || '', postal,
      address: clampStr([r.adresseetablissement, postal, r.libellecommuneetablissement].filter(Boolean).join(' '), 200), created_on: r.datecreationetablissement || null, staff: STAFF_ODS[r.trancheeffectifsetablissement] || 'NN', dept: deptOf(postal) || departement };
  }).filter(Boolean);
  return { list, totalPages: Math.ceil((Number(j.total_count) || 0) / 25), raw: rows.length, source: 'secours' };
}
/** Recherche une entreprise précise par son SIREN. */
export async function sireneBySiren(siren) {
  const res = await net.fetch(`${config.sireneApi}/search?q=${encodeURIComponent(siren)}&per_page=1`, { headers: { accept: 'application/json' } });
  if (res.status === 429) throw new Error('API Recherche d’entreprises 429');
  if (!res.ok) throw new Error(`API Recherche d'entreprises ${res.status}`);
  const r = (await res.json()).results?.find((x) => x.siren === siren);
  return r ? fromSirene(r, null, r.siege?.commune) : null;
}

/** Note de priorité : entreprises récentes et métiers où la prise de rendez-vous apporte le plus. */
export function scoreProspect(p, today = new Date()) {
  let s = 1;
  const y = p.created_on ? (today - new Date(p.created_on)) / (365.25 * 864e5) : null;
  if (y !== null && y < 1) s += 3; else if (y !== null && y < 5) s += 2;
  if (['garage', 'coiffeur', 'beaute', 'location'].includes(p.tpl)) s += 2; else if (['artisan', 'restaurant'].includes(p.tpl)) s += 1;
  return s;
}

/** Enregistre les entreprises trouvées sans créer de doublon. */
export function importProspects(db, list) {
  let added = 0;
  for (const p of list) {
    if (!p.siren || db.one('SELECT 1 FROM prospects WHERE siren=?', p.siren) || isSuppressed(db, { siren: p.siren })) continue;
    db.run('INSERT INTO prospects(siren,siret,name,naf,tpl,city,postal,address,created_on,score,created_at,dept,demo_token_hash,optout_token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', p.siren, p.siret, p.name, p.naf, p.tpl, p.city, p.postal, p.address, p.created_on, scoreProspect(p), Date.now(), p.dept || deptOf(p.postal), sha256(demoTokenFor(p.siren)), sha256(hmac(config.secret, 'stop:' + p.siren).slice(0, 32)));
    added++;
  }
  return added;
}

/** Prépare un site de démonstration au nom de l'entreprise prospectée (non publié). */
/** Nom commercial lisible : l'enseigne entre parenthèses plutôt que le nom de la personne (entreprise individuelle). */
const LEGAL_FORMS = /^(SAS|SARL|SASU|EURL|SNC|SCB|SCI|SCM|SCP|SELARL|SELAS|EIRL|EI|SA|SCOP|SARLU)\s+/i;
export function displayName(raw) {
  const m = /\(([^()]+)\)\s*$/.exec(raw || '');
  // « NOM (ENSEIGNE) » : l'enseigne est le nom connu des clients ; mais « NOM (SIGLE) » garde le nom complet, plus parlant
  const sigle = m && /^[A-Z0-9&.]{2,5}$/.test(m[1].trim());
  let s = (m && !sigle ? m[1] : m ? raw.slice(0, m.index) : raw || '').trim().replace(LEGAL_FORMS, '').trim();
  if (s === s.toUpperCase()) {
    s = s.toLowerCase().replace(/(^|[\s'’\-&.(])([a-zà-ÿ])/g, (x, a, b) => a + b.toUpperCase()).replace(/(?<=\s)(De|Du|Des|La|Le|Les|Et|Aux?|En|Sur|Sous)(?=\s)/g, (x) => x.toLowerCase()).replace(/(?<=\s)([LD])['’]/g, (x) => x.toLowerCase());
    // Sigles : mots courts avec chiffre ou sans voyelle (« S2R », « PW », « IYB ») restent en capitales
    s = s.replace(/(^|\s)([A-Za-z0-9]{1,4})(?=\s|$)/g, (x, a, w) => (/\d/.test(w) && /[a-z]/i.test(w)) || (!/[aeiouyàâéèêëîïôûù]/i.test(w) && w.length >= 2) || /^(Iyb|Cb|Bnb)$/i.test(w) ? a + w.toUpperCase() : x);
  }
  return s;
}
// Prénoms français courants : un nom commercial « PRÉNOM NOM » est en fait le nom de l'exploitant (entreprise individuelle)
const PRENOMS = new Set(('aline alain alexandre alexis alice amandine amelie anais andre angelique anne annie antoine arnaud arthur audrey aurelie baptiste beatrice benjamin benoit bernard brigitte bruno camille carine carole caroline catherine cecile celine chantal charles charlotte christelle christian christine christophe claire claude clement corinne cyril damien daniel david delphine denis didier dominique dylan eddy elodie emilie emma emmanuel eric estelle eva fabien fabienne fabrice florence florian francis franck francois francoise frederic gael gaelle gerard gilles gregory guillaume guy helene herve hugo isabelle jacques jean jeremy jerome jessica johan jonathan jordan joseph josiane julie julien justine karine kevin laetitia laura laurence laurent lea leo lionel louis lucas lucie ludovic magali manon marc marcel marie marine martine mathieu mathilde maxime melanie michel michele mickael monique nadia nathalie nicolas nicole noemie olivier pascal pascale patrice patricia patrick paul pauline philippe pierre quentin raphael regis remi renaud richard robert romain sabrina samuel sandrine sarah sebastien serge severine simon sophie stephane stephanie sylvain sylvie theo thierry thomas valentin valerie vanessa veronique victor vincent virginie xavier yannick yann yves').split(' '));
const fold = (x) => String(x).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
/** Vrai si le nom affiché est celui d'une personne (« Rémi François ») plutôt qu'un nom commercial. */
export function isPersonName(name) {
  const w = String(name || '').trim().split(/\s+/);
  return w.length >= 2 && w.length <= 3 && w.some((x) => PRENOMS.has(fold(x).replace(/[^a-z]/g, ''))) && !/\d|&|\b(garage|salon|coiffure|beaute|institut|restaurant|cafe|bar|pizza|auto|location|securite|bati|elec|plomberie)\b/i.test(fold(name));
}
/** Jeton de démonstration stable (le même lien survit à un redémarrage du serveur). */
export const demoTokenFor = (siren) => hmac(config.secret, 'demo:' + siren).slice(0, 32);
export function prepareDemo(db, prospectId, { stable = false } = {}) {
  const p = db.one('SELECT * FROM prospects WHERE id=?', prospectId); if (!p) throw new Error('Prospect introuvable');
  if (p.status === 'optout') throw new Error("Cette entreprise a demandé à ne plus être contactée.");
  if (p.demo_tenant_id && db.one("SELECT 1 FROM tenants WHERE id=? AND status='demo'", p.demo_tenant_id) && stable) return { tenantId: p.demo_tenant_id, demoUrl: `${config.baseUrl}/demo/${demoTokenFor(p.siren)}`, demoToken: demoTokenFor(p.siren) };
  const name = displayName(p.name);
  const r = createTenant(db, { name, tpl: p.tpl, city: displayName(p.city), address: p.address, country: territoryOf(p.postal), lang: 'fr', status: 'demo', prospectId: p.id, demoToken: stable ? demoTokenFor(p.siren) : null });
  db.run("UPDATE prospects SET status=CASE WHEN status IN ('new','contacted') THEN 'demo' ELSE status END, demo_tenant_id=? WHERE id=?", r.id, p.id);
  return { tenantId: r.id, demoUrl: `${config.baseUrl}/demo/${r.demoToken}`, demoToken: r.demoToken };
}

/** Message de prise de contact, prêt à copier (WhatsApp, e-mail, SMS). */
/** Message de prise de contact B2B : identifie l'expéditeur, l'origine des données et donne un moyen simple de s'opposer. */
import { sequenceEmail, sequenceSms } from './outreach.js';
export const PLAN_LINE = 'Trois formules, prix hors taxes : Essentiel, 79 €/mois + 199 € de mise en service, pour votre site, vos demandes de devis et WhatsApp ; Pro, 149 €/mois + 399 € de mise en service, qui ajoute la prise de rendez-vous en ligne, les rappels automatiques et les statistiques ; Premium, 249 €/mois + 599 € de mise en service, qui ajoute un assistant qui répond à vos clients 24 h/24. Essai gratuit 14 jours sans carte bancaire, puis abonnement avec engagement de 12 mois ; la mise en service est payée une seule fois. L’exemple montre toutes les fonctions (Premium).';
export function outreachMessage(p, demoUrl, stopUrl, { channel = 'email', step = 0 } = {}) {
  const name = displayName(p.name);
  if (channel === 'sms') return sequenceSms(p, { name, demoUrl, stopUrl });
  const token = String(demoUrl).split('/demo/')[1] || '';
  return sequenceEmail(p, { name, demoUrl, token, stopUrl, step }).text;
}

export function demoTenantByToken(db, token) {
  if (!token || !/^[\w-]{16,64}$/.test(token)) return null;
  const h = sha256(token);
  const t = db.one("SELECT * FROM tenants WHERE demo_token_hash=? AND status='demo'", h);
  if (t) return t;
  // Prospection nationale : la démo n'est fabriquée qu'à la première visite (des milliers de prospects, peu de visites)
  const p = db.one("SELECT * FROM prospects WHERE demo_token_hash=? AND status NOT IN ('optout','converted','lost')", h);
  if (!p || (p.demo_tenant_id && db.one('SELECT 1 FROM tenants WHERE id=?', p.demo_tenant_id))) return null;
  const r = prepareDemo(db, p.id, { stable: true });
  return db.one('SELECT * FROM tenants WHERE id=?', r.tenantId);
}
export function recordDemoView(db, tenant) {
  // Total anonyme par jour, sans lien avec l'entreprise
  db.run("INSERT INTO visits_source(day,source,n) VALUES(?,'demo',1) ON CONFLICT(day,source) DO UPDATE SET n=n+1", new Date().toISOString().slice(0, 10));
  if (config.trackDemoViews && tenant.prospect_id) db.run('UPDATE prospects SET demo_views=demo_views+1 WHERE id=?', tenant.prospect_id);
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
export async function seedProspects(db, sirens, { pause = 350 } = {}) {
  const r = { imported: 0, demos: 0, skipped: 0, errors: 0 };
  const { optoutLink } = await import('./privacy.js');
  for (const siren of sirens.map((x) => x.trim()).filter((x) => /^\d{9}$/.test(x))) {
    try {
      let p = db.one('SELECT * FROM prospects WHERE siren=?', siren);
      if (p?.status === 'optout') { r.skipped++; continue; }
      if (!p) {
        // L'API publique limite le débit : on réessaie après une pause plutôt que de perdre la démo
        let found = null;
        for (let k = 0; k < 4; k++) { try { found = await sireneBySiren(siren); break; } catch (e) { if (!/429/.test(e.message) || k === 3) throw e; await new Promise((ok) => setTimeout(ok, 1500 * (k + 1))); } }
        if (pause) await new Promise((ok) => setTimeout(ok, pause));
        if (!found) { r.skipped++; continue; }
        importProspects(db, [found]); r.imported++; p = db.one('SELECT * FROM prospects WHERE siren=?', siren);
      }
      prepareDemo(db, p.id, { stable: true }); optoutLink(db, p.id); r.demos++;
    } catch (e) { r.errors++; recordIncident(db, { kind: 'prospect_seed', severity: 'info', message: `Prospect ${siren} : ${String(e.message).slice(0, 120)}` }); }
  }
  return r;
}

// ---------- Prospection nationale automatique ----------
/** Toutes les combinaisons métier × département, parcourues page par page pour couvrir toute la France. */
// Ordre entrelacé : chaque tour couvre TOUS les départements (métropole et Outre-mer), avec un métier différent
// d'un département à l'autre, pour que la prospection soit nationale dès les premiers jours.
const TPLS = Object.keys(TEMPLATES);
export const CAMPAIGN_UNITS = TPLS.flatMap((_, k) => DEPT_CODES.map((d, i) => ({ d, tpl: TPLS[(k + i) % TPLS.length] })));
/**
 * Repère chaque jour de nouvelles entreprises dans le registre public, sur toute la France (métropole et Outre-mer).
 * Premier passage : la 1re page de chaque métier dans chaque département, puis la 2e page, etc.
 * N'envoie AUCUN message : les entreprises arrivent au statut « À contacter », avec démo et lien d'opposition prêts.
 */
/** Cadence quotidienne : réglée dans l'administration (prioritaire) ou par PROSPECT_DAILY. Ce n'est pas une limite définitive. */
export function prospectDaily(db) { const v = db.one("SELECT v FROM meta WHERE k='prospect_daily'")?.v; return v != null ? Number(v) : config.prospectDaily; }
export async function runNationalCampaign(db, { quota = prospectDaily(db), pause = config.prospectPauseMs, maxCalls = null, now = Date.now() } = {}) {
  const U = CAMPAIGN_UNITS.length;
  let cursor = Number(db.one("SELECT v FROM meta WHERE k='prospect_cursor'")?.v || 0);
  // Remise à zéro ponctuelle du curseur (PROSPECT_CURSOR_RESET), appliquée une seule fois par valeur
  const reset = process.env.PROSPECT_CURSOR_RESET;
  if (reset && /^\d+$/.test(reset) && db.one("SELECT v FROM meta WHERE k='prospect_cursor_reset'")?.v !== reset) {
    cursor = Number(reset); db.run("INSERT INTO meta(k,v) VALUES('prospect_cursor_reset',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", reset);
  }
  const r = { added: 0, calls: 0, cursorStart: cursor, stopped: '' }; let failsInRow = 0;
  const limitCalls = maxCalls ?? Math.max(10, Math.ceil(quota / 3));
  while (r.added < quota && r.calls < limitCalls) {
    const pass = Math.floor(cursor / U); const u = CAMPAIGN_UNITS[cursor % U];
    if (pass >= 40) { r.stopped = 'couverture complète'; break; }
    try {
      let list = null;
      // Service public limité à quelques requêtes par seconde : attente progressive avant de réessayer
      for (let k = 0; ; k++) {
        try { ({ list } = await searchSirene({ tpl: u.tpl, departement: u.d, page: pass + 1, withMeta: true })); break; }
        catch (e) { if (!e.rateLimited || k >= 4 || !pause) throw e; r.waits = (r.waits || 0) + 1; await new Promise((ok) => setTimeout(ok, 2000 * 2 ** k)); }
      }
      r.calls++; r.added += importProspects(db, list); r.ok = (r.ok || 0) + 1; failsInRow = 0;
    } catch (e) {
      r.calls++; r.failed = (r.failed || 0) + 1;
      if (e.rateLimited) { r.stopped = 'limite API'; break; }
      // Panne réseau : la page n'est PAS considérée comme parcourue (le curseur n'avance pas) ; arrêt après 3 échecs de suite
      if (e.network) {
        failsInRow++;
        if (failsInRow >= 3) { r.stopped = `réseau : ${String(e.message).slice(0, 100)}`; recordIncident(db, { kind: 'prospection_reseau', severity: 'warning', message: `Prospection suspendue : API Recherche d'entreprises injoignable (${String(e.message).slice(0, 100)})` }); break; }
        if (pause) await new Promise((ok) => setTimeout(ok, pause)); continue;
      }
      recordIncident(db, { kind: 'prospection', severity: 'info', message: `Campagne nationale (${u.tpl}, ${u.d}) : ${String(e.message).slice(0, 120)}` });
    }
    cursor++;
    if (pause) await new Promise((ok) => setTimeout(ok, pause));
  }
  db.run("INSERT INTO meta(k,v) VALUES('prospect_cursor',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(cursor));
  // Recherche rétablie : les incidents de panne réseau de la prospection sont clôturés
  if ((r.ok || 0) > 0 && !r.failed) db.run("UPDATE incidents SET resolved_at=? WHERE resolved_at IS NULL AND kind IN ('prospection','prospection_reseau') AND (message LIKE '%fetch failed%' OR message LIKE '%injoignable%')", now);
  db.run("INSERT INTO audit(action,detail,created_at) VALUES('job.prospect',?,?)", JSON.stringify({ added: r.added, calls: r.calls, ok: r.ok || 0, failed: r.failed || 0 }), now);
  refreshPotentials(db);
  return { ...r, cursor, coverage: Math.min(1, cursor / U) };
}
/** Avancement de la campagne pour l'administration. */
export function campaignStatus(db) {
  const cursor = Number(db.one("SELECT v FROM meta WHERE k='prospect_cursor'")?.v || 0);
  const last = db.one("SELECT detail, created_at FROM audit WHERE action='job.prospect' ORDER BY id DESC LIMIT 1");
  const depts = db.one("SELECT COUNT(DISTINCT dept) n FROM prospects WHERE dept!=''").n;
  return { cursor, units: CAMPAIGN_UNITS.length, pass: Math.floor(cursor / CAMPAIGN_UNITS.length) + 1, depts, daily: prospectDaily(db), last: last ? { ...JSON.parse(last.detail || '{}'), at: last.created_at } : null };
}
