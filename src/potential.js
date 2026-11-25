// Potentiel commercial d'un prospect (0 à 100) : plus il est élevé, plus ClientDirect Pro lui apporte.
// Priorité : pas de site Internet > simple page sur une plateforme > site vieillissant > site récent,
// avec un bonus quand il manque la réservation en ligne ou le formulaire de devis.
// L'analyse d'un site réutilise la page d'accueil déjà lue pour chercher l'e-mail : aucun crédit supplémentaire.

export const PLATFORMS = /(^|\.)(facebook|instagram|tiktok|linkedin|twitter|x|youtube|simplybook|planity|treatwell|calendly|doctolib|ubereats|deliveroo|tripadvisor|google|wa|whatsapp|linktr|pagesjaunes|business\.site|wixsite|jimdosite)\.[a-z.]+$/i;
export const isPlatform = (website) => { try { return PLATFORMS.test(new URL(website).hostname); } catch { return false; } };

const BOOKING = /(r[ée]server|r[ée]servation en ligne|prendre (un )?rendez-vous|prise de rendez-vous|rdv en ligne|book now|planity|calendly|doctolib|treatwell|simplybook|booksy|resalib|zenchef|thefork|lafourchette|kiute|rendez-vous en ligne)/i;

/** Analyse la page d'accueil d'un site : ancienneté et outils présents. */
export function analyzeSite({ url, html = '', md = '' }, year = new Date().getFullYear()) {
  const text = `${md}\n${html}`;
  const reasons = [];
  if (!/^https:/i.test(url || '')) reasons.push('pas de connexion sécurisée (https)');
  if (html && !/<meta[^>]+name=["']?viewport/i.test(html)) reasons.push('non adapté au téléphone');
  const years = [...text.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  if (years.length && Math.max(...years) <= year - 3) reasons.push(`mis à jour en ${Math.max(...years)}`);
  if (/\.swf\b|<frameset|<marquee|<font\s/i.test(html)) reasons.push('technologie ancienne');
  const booking = BOOKING.test(text);
  const forms = html.match(/<form[\s\S]*?<\/form>/gi) || [];
  const quote = /devis/i.test(text) && forms.some((f) => /<textarea|type=["']?(email|tel)/i.test(f));
  const contactForm = forms.some((f) => /<textarea/i.test(f));
  return { status: reasons.length ? 'vieillissant' : 'récent', reasons, booking, quote, contactForm };
}

const LABELS = { aucun: 'aucun site', aucun_probable: 'aucun site connu', plateforme: 'page sur une plateforme uniquement', vieillissant: 'site vieillissant', 'récent': 'site récent' };

/** Note de 0 à 100 et raisons lisibles. `score` est l'ancienne note métier/récence (1 à 6). */
export function potentialOf(p) {
  let flags = {}; try { flags = JSON.parse(p.site_flags || '{}'); } catch { flags = {}; }
  const st = p.site_status || (p.website ? (isPlatform(p.website) ? 'plateforme' : null) : null);
  const why = [];
  let v;
  switch (st) {
    case 'aucun': v = 92; why.push(LABELS.aucun); break;
    case 'aucun_probable': v = 82; why.push(LABELS.aucun_probable); break;
    case 'plateforme': v = 78; why.push(LABELS.plateforme); break;
    case 'vieillissant': v = 55; why.push(LABELS.vieillissant + (flags.reasons?.length ? ` (${flags.reasons.join(', ')})` : '')); break;
    case 'récent': v = 25; why.push(LABELS['récent']); break;
    default: v = 40; why.push('site à vérifier');
  }
  if (st === 'vieillissant' || st === 'récent') {
    if (!flags.booking) { v += 12; why.push('pas de réservation en ligne'); }
    if (!flags.quote) { v += 8; why.push('pas de formulaire de devis'); }
  }
  v += Math.min(6, Number(p.score) || 0); // métier et ancienneté de l'entreprise
  if (!(p.phone || p.email)) v -= 10; // pas encore joignable
  return { potential: Math.max(0, Math.min(100, v)), why };
}

/** Recalcule le potentiel des prospects à contacter. */
export function refreshPotentials(db) {
  let n = 0;
  for (const p of db.all("SELECT id, website, site_status, site_flags, score, phone, email, potential FROM prospects WHERE status='new'")) {
    const { potential } = potentialOf(p);
    if (potential !== p.potential) { db.run('UPDATE prospects SET potential=? WHERE id=?', potential, p.id); n++; }
  }
  return n;
}
