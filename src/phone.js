// Numéros de téléphone : normalisation E.164 (stockés en chiffres seuls, sans « + »).
//
// France et Outre-mer partagent le même format national (0 + 9 chiffres) : c'est le préfixe qui désigne le
// territoire (plan de numérotation de l'ARCEP), pas le pays du professionnel. Un 0694… est donc toujours guyanais
// (+594), même saisi sur un compte « France », et un 06 12… reste métropolitain (+33), même saisi en Guyane.
// Jamais l'inverse : un numéro d'Outre-mer n'est jamais rattaché à +33.
import { COUNTRIES } from './markets.js';

/** Indicatifs du plan de numérotation français. */
const FR_PLAN = new Set(['33', '594', '590', '596', '262']);
/** Préfixes (9 chiffres après le 0) réservés à l'Outre-mer → indicatif et territoire. */
const DOM = [
  [/^(594|694)/, '594', 'GF'],
  [/^(590|690|691)/, '590', 'GP'],
  [/^(596|696|697)/, '596', 'MQ'],
  [/^(269|639)/, '262', 'YT'],
  [/^(262|263|692|693)/, '262', 'RE']
];
/** Indicatifs dont le 0 national tombe à l'international (+33 0… → +33…). L'Italie (+39) le conserve. */
const TRUNK0 = new Set([...FR_PLAN, '32', '41', '44', '49', '31', '43', '353', '61', '64', '55', '212', '27', '86', '81', '91', '20']);
/** Indicatifs où le 0 initial fait partie du numéro, y compris à l'international (Italie, Côte d'Ivoire depuis 2021). */
const KEEP0 = new Set(['39', '225', '378']);
/** Indicatifs connus (recherche du plus long préfixe). */
export const DIAL_CODES = [...new Set([...Object.values(COUNTRIES).map((c) => c.dial).filter(Boolean),
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '39', '41', '43', '44', '45', '46', '47', '49', '52', '55', '61', '64', '81', '86', '91',
  '212', '213', '216', '221', '225', '237', '262', '351', '352', '353', '377', '509', '590', '594', '596', '597', '687', '689'])];
export const isDial = (cc) => DIAL_CODES.includes(String(cc || ''));
const dialOf = (d) => DIAL_CODES.filter((x) => d.startsWith(x)).sort((a, b) => b.length - a.length)[0] || '';

/** Indicatif d'un numéro national français de 9 chiffres (sans le 0). */
export const frDial = (nsn) => (DOM.find(([re]) => re.test(nsn)) || [null, '33'])[1];

/**
 * Numéro saisi → E.164 en chiffres seuls (ex. « 0694 11 22 33 » → « 594694112233 »). Chaîne vide si rien n'est saisi.
 * `cc` est l'indicatif choisi par l'utilisateur (ou celui du professionnel) ; un numéro saisi avec « + » ou « 00 » le garde.
 */
export function toE164(raw, cc = '') {
  const s = String(raw ?? '').trim(); const d = s.replace(/\D/g, ''); cc = String(cc || '').replace(/\D/g, '');
  if (!d) return '';
  let n;
  if (s.startsWith('+')) n = d;
  else if (d.startsWith('00')) n = d.slice(2);
  else if (cc === '1' && d.startsWith('011')) n = d.slice(3);
  else if (FR_PLAN.has(cc) && /^0[1-9]\d{8}$/.test(d)) return frDial(d.slice(1)) + d.slice(1);
  else if (FR_PLAN.has(cc) && /^[1-9]\d{8}$/.test(d)) return frDial(d) + d; // 0 initial oublié
  else if (cc === '1') return d.length === 11 && d.startsWith('1') ? d : '1' + d; // longueur vérifiée ensuite (10 chiffres)
  else if (KEEP0.has(cc)) return d.startsWith(cc) && !d.startsWith('0') && e164Ok(d) ? d : cc + d; // le 0 fait partie du numéro
  else if (cc && d.startsWith('0')) return cc + d.slice(1);
  // Sans 0 national : l'indicatif est ajouté, sauf si le numéro le contient déjà (saisi sans « + ») et ne serait pas valide autrement
  else if (cc) { if (d.startsWith(cc) && e164Ok(d) && !e164Ok(cc + d)) n = d; else return cc + d; }
  else n = d;
  // Format international : 0 national recopié après l'indicatif (+33 0694…, +44 07…)
  const code = dialOf(n);
  if (code && TRUNK0.has(code) && n[code.length] === '0') n = code + n.slice(code.length + 1);
  // Numéro d'Outre-mer écrit avec +33 (+33 6 94…) : rattaché à son vrai territoire, jamais l'inverse
  if (n.startsWith('33') && n.length === 11) n = frDial(n.slice(2)) + n.slice(2);
  return n;
}

/** Numéro E.164 plausible : 8 à 15 chiffres, longueur exacte pour la France, l'Outre-mer et l'Amérique du Nord. */
export function e164Ok(n) {
  n = String(n || '');
  if (!/^[1-9]\d{7,14}$/.test(n)) return false;
  const code = dialOf(n);
  if (FR_PLAN.has(code)) return n.length === code.length + 9 && n[code.length] !== '0';
  if (code === '1') return n.length === 11 && /^1[2-9]\d{2}[2-9]/.test(n);
  return true;
}
/** Saisie valide : convertible en E.164. Sans indicatif connu, seul un numéro international (+…) est accepté. */
export function phoneValid(raw, cc = '') {
  const s = String(raw ?? '').trim(); cc = String(cc || '').replace(/\D/g, '');
  if (!cc && !/^(\+|00)/.test(s.replace(/\s/g, ''))) return false;
  return e164Ok(toE164(raw, cc));
}
/** Territoire d'Outre-mer d'un numéro E.164 (GF, GP, MQ, RE, YT), sinon null. */
export function domCountryOf(n) {
  n = String(n || ''); const code = dialOf(n);
  if (!FR_PLAN.has(code) || code === '33') return null;
  return (DOM.find(([re, dial]) => dial === code && re.test(n.slice(code.length))) || [])[2] || null;
}
/** Options d'indicatif pour les formulaires : « +594 Guyane », regroupés par indicatif. */
export function dialOptions(lang = 'fr') {
  const by = new Map();
  for (const [k, c] of Object.entries(COUNTRIES)) if (c.dial) by.set(c.dial, [...(by.get(c.dial) || []), lang === 'fr' ? c.fr : c.en]);
  return [...by.entries()].map(([dial, names]) => ({ dial, label: `+${dial} ${names.join(' / ')}` })).sort((a, b) => a.label.localeCompare(b.label, lang, { numeric: true }));
}
