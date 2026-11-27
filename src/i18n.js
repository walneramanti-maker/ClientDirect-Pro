// Traductions : le texte français sert de clé ; chaque langue a son fichier src/i18n/<langue>.json.
// Ajouter une langue = ajouter un fichier JSON et l'inscrire dans LANGS. Les textes manquants restent en français.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const LANGS = { fr: 'Français', en: 'English' };
export const DEFAULT_LANG = 'fr';
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'i18n');
const DICT = {};
for (const l of Object.keys(LANGS)) { try { DICT[l] = JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), 'utf8')); } catch { DICT[l] = {}; } }

const als = new AsyncLocalStorage();
export const currentLang = () => als.getStore()?.lang || DEFAULT_LANG;
export const withLang = (lang, fn) => als.run({ lang: LANGS[lang] ? lang : DEFAULT_LANG }, fn);
/** Traduit un texte (clé = français) dans la langue courante, avec remplacement des {variables}. */
export function t(fr, vars = null, lang = currentLang()) {
  let s = (lang !== 'fr' && DICT[lang]?.[fr]) || fr;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  return s;
}
export const hasTranslation = (fr, lang) => lang === 'fr' || !!DICT[lang]?.[fr];
/** Langue préférée d'un visiteur : ?lang=, cookie, puis en-tête Accept-Language du navigateur. */
export function detectLang({ query = null, cookie = null, accept = '' } = {}) {
  for (const c of [query, cookie]) if (c && LANGS[c]) return c;
  for (const part of String(accept).split(',')) { const l = part.trim().slice(0, 2).toLowerCase(); if (LANGS[l]) return l; }
  return DEFAULT_LANG;
}
/** Pays probable d'après l'en-tête Accept-Language (ex. fr-CA → CA). */
export function regionFromAccept(accept = '') {
  for (const part of String(accept).split(',')) { const m = /^[a-z]{2}-([A-Z]{2})/i.exec(part.trim()); if (m) return m[1].toUpperCase(); }
  return null;
}
export const locale = (lang = currentLang(), country = null) => (lang === 'fr' ? (country && ['CA', 'BE', 'CH'].includes(country) ? `fr-${country}` : 'fr-FR') : (country && ['GB', 'CA', 'AU', 'IE'].includes(country) ? `en-${country}` : 'en-US'));
/** Heure locale lisible : « 9h30 » en français, « 9:30 AM » en anglais. */
export function fmtTime(hhmm, lang = currentLang()) {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (lang === 'fr') return `${h}h${m ? String(m).padStart(2, '0') : ''}`;
  return `${((h + 11) % 12) + 1}:${String(m || 0).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
/** Jour court lisible : « lun. 1/12 » ou « Mon 12/1 ». */
export function fmtDay(date, lang = currentLang()) {
  const d = new Date(date + 'T12:00:00Z');
  return new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' }).format(d);
}
export const dayName = (dow, lang = currentLang()) => new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + dow))).replace(/^./, (c) => c.toUpperCase());
export const fmtDate = (ms, lang = currentLang()) => new Date(ms).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-US');
/** Change la langue de la requête en cours (ex. un site d'entreprise s'affiche dans la langue de l'entreprise). */
/** Paramètres de l'adresse courante (hors langue), conservés par le sélecteur de langue. */
export const setQuery = (q) => { const s = als.getStore(); if (s) s.query = q; };
export const currentQuery = () => als.getStore()?.query || '';
export const setLang = (l) => { const s = als.getStore(); if (s && LANGS[l]) s.lang = l; };
