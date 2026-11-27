// Tests dans un vrai navigateur (Chromium) au format smartphone : affichage et parcours complets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { setup, signup } from './helpers.js';

const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { try { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); } catch { pw = null; } }
const SHOTS = process.env.SHOTS_DIR || '';

const app = await setup({ BASE_URL: 'http://127.0.0.1', RATE_BOOK_MAX: '100' });
let browser, ctx;
const PHONE = { viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' };
test.before(async () => { if (!pw) return; browser = await pw.chromium.launch(); ctx = await browser.newContext(PHONE); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); });
test.after(async () => { await browser?.close(); await app.close(); });
const skip = !pw && 'Playwright absent';

async function open(path) { const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => m.type() === 'error' && !/fonts|ERR_FAILED|status of 40[09]/.test(m.text()) && errors.push(m.text())); await p.goto(app.base + path); return { p, errors }; }
async function noOverflow(p, name) {
  const w = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  assert.ok(w.doc <= w.vw + 1, `${name} : la page déborde horizontalement (${w.doc}px > ${w.vw}px)`);
}
async function tapTargets(p, sel) {
  const small = await p.$$eval(sel, (els) => els.filter((e) => e.offsetParent).map((e) => ({ t: (e.textContent || e.getAttribute('aria-label') || e.name || '').trim().slice(0, 30), h: e.getBoundingClientRect().height })).filter((x) => x.h < 36));
  assert.deepEqual(small, [], 'éléments trop petits pour le doigt');
}
let T;
test('mobile : page d’accueil lisible, sans débordement, bouton d’inscription visible', { skip }, async () => {
  const { p, errors } = await open('/');
  await noOverflow(p, 'accueil');
  assert.ok(await p.isVisible('text=Créer mon site gratuitement'));
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : inscription complète depuis un téléphone', { skip }, async () => {
  const { p, errors } = await open('/inscription');
  await noOverflow(p, 'inscription');
  await p.fill('#business', 'Garage Mobile Kourou'); await p.selectOption('#activity', 'garage'); await p.fill('#city', 'Kourou'); await p.fill('#phone', '0694 55 66 77');
  await p.fill('#name', 'Patron Mobile'); await p.fill('#email', 'mobile@test.fr'); await p.fill('#password', 'Mobile2026ok'); await p.check('input[name=cgu]');
  await Promise.all([p.waitForURL(/\/pro/), p.click('button[type=submit]')]);
  assert.ok(await p.isVisible('text=Votre site est en ligne'));
  await noOverflow(p, 'espace-pro');
  assert.deepEqual(errors, []); await p.close();
  T = app.db.one("SELECT * FROM tenants WHERE name='Garage Mobile Kourou'");
});
test('mobile : site d’entreprise sans débordement, boutons assez grands', { skip }, async () => {
  const { p, errors } = await open(`/s/${T.slug}`);
  await noOverflow(p, 'site-entreprise');
  await tapTargets(p, '.btn, .chip, input, select, textarea');
  assert.ok(await p.isVisible('h1:has-text("Garage Mobile Kourou")'));
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : prise de rendez-vous complète au doigt', { skip }, async () => {
  const { p, errors } = await open(`/s/${T.slug}#rdv`);
  await p.waitForSelector('#b-slots .chip');
  await p.tap('#b-days .chip >> nth=1'); await p.waitForSelector('#b-slots .chip');
  const time = await p.textContent('#b-slots .chip >> nth=0'); await p.tap('#b-slots .chip >> nth=0');
  await p.fill('#b-name', 'Cliente Mobile'); await p.fill('#b-phone', '0694 11 22 33'); await p.fill('#b-email', 'cliente@test.fr');
  await p.tap('#book button[type=submit]');
  await p.waitForSelector('#b-ok:not(:empty)');
  assert.match(await p.textContent('#b-ok'), /Demande de rendez-vous enregistrée/);
  const a = app.db.one("SELECT * FROM appointments WHERE customer_name='Cliente Mobile'");
  assert.ok(a); assert.equal(a.customer_phone, '594694112233'); const [hh, mm] = time.trim().split('h'); assert.equal(a.time, `${hh.padStart(2, '0')}:${mm || '00'}`, 'heure affichée = heure enregistrée');
  // les créneaux sont rechargés après la réservation (le garage a plusieurs ponts : l'heure peut rester libre)
  await p.waitForSelector('#b-slots .chip');
  await noOverflow(p, 'rendez-vous-envoye');
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : demande de devis et erreurs de saisie affichées', { skip }, async () => {
  const { p, errors } = await open(`/s/${T.slug}#devis`);
  await p.fill('#q-name', 'Devis Mobile'); await p.fill('#q-phone', '12'); await p.tap('#quote button[type=submit]');
  await p.waitForSelector('#q-err:not(:empty)'); assert.match(await p.textContent('#q-err'), /téléphone invalide/i);
  await p.fill('#q-phone', '0694 99 88 77'); await p.fill('#q-msg', 'Bruit au freinage'); await p.tap('#quote button[type=submit]');
  await p.waitForSelector('#q-ok:not(:empty)'); assert.match(await p.textContent('#q-ok'), /Demande envoyée/);
  assert.ok(app.db.one("SELECT 1 FROM quotes WHERE customer_name='Devis Mobile'"));
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : l’assistant répond sur téléphone', { skip }, async () => {
  const { p, errors } = await open(`/s/${T.slug}`);
  await p.fill('#q', 'Quels sont vos horaires ?'); await p.tap('#ask button');
  await p.waitForFunction(() => document.querySelectorAll('#msgs .m').length >= 3 && !/^…$/.test(document.querySelector('#msgs .m:last-child').textContent));
  assert.match(await p.textContent('#msgs .m:last-child'), /horaires/i);
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : le professionnel confirme le rendez-vous depuis son téléphone', { skip }, async () => {
  const { p, errors } = await open('/connexion');
  await p.fill('#email', 'mobile@test.fr'); await p.fill('#password', 'Mobile2026ok');
  await Promise.all([p.waitForURL(/\/pro$/), p.tap('button[type=submit]')]);
  await noOverflow(p, 'tableau-de-bord');
  assert.ok(await p.isVisible('text=Cliente Mobile'));
  await Promise.all([p.waitForURL(/m=ok/), p.tap('button:has-text("Confirmer")')]);
  assert.equal(app.db.one("SELECT status FROM appointments WHERE customer_name='Cliente Mobile'").status, 'confirmed');
  assert.ok(app.db.one("SELECT 1 FROM outbox WHERE template='appt_confirmed' AND to_addr='cliente@test.fr'"));
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : réglages utilisables (tableaux défilants, pas de débordement)', { skip }, async () => {
  const { p, errors } = await open('/pro/reglages');
  await noOverflow(p, 'reglages');
  await p.fill('input[name=svc_price_0]', '65');
  await Promise.all([p.waitForURL(/m=ok/), p.tap('button:has-text("Enregistrer et mettre le site à jour")')]);
  assert.equal(app.db.one('SELECT price FROM services WHERE tenant_id=? ORDER BY pos, id LIMIT 1', T.id).price, 65);
  for (const path of ['/pro/abonnement', '/pro/aide']) { await p.goto(app.base + path); await noOverflow(p, path.slice(5)); }
  assert.deepEqual(errors, []); await p.close();
});
test('mobile : pages légales et annuaire lisibles', { skip }, async () => {
  for (const path of ['/confidentialite', '/cgu', '/mentions-legales', '/annuaire']) { const { p, errors } = await open(path); await noOverflow(p, path.slice(1)); assert.deepEqual(errors, []); await p.close(); }
});
test('mobile : aucune erreur de sécurité du navigateur (CSP) sur le site', { skip }, async () => {
  const p = await ctx.newPage(); const csp = []; p.on('console', (m) => /Content Security Policy/i.test(m.text()) && csp.push(m.text()));
  await p.goto(`${app.base}/s/${T.slug}`); await p.waitForSelector('#b-slots .chip');
  assert.deepEqual(csp, []); await p.close();
});
