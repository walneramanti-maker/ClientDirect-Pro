// Parcours complets dans un vrai navigateur sur trois profils : iPhone, Android et ordinateur.
// Limite : seul Chromium est disponible ici ; l'iPhone est simulé (taille d'écran, tactile, navigateur mobile), pas Safari.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './helpers.js';

const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { try { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); } catch { pw = null; } }
const SHOTS = process.env.SHOTS_DIR || '';
const app = await setup({ BASE_URL: 'http://127.0.0.1', RATE_BOOK_MAX: '500' });
const DEVICES = {
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1', locale: 'fr-FR' },
  android: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36', locale: 'en-US' },
  desktop: { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false, locale: 'fr-FR' }
};
let browser; test.before(async () => { if (pw) browser = await pw.chromium.launch(); });
test.after(async () => { await browser?.close(); await app.close(); });
const skip = !pw && 'Playwright absent';
async function ctxFor(name) { const c = await browser.newContext({ ...DEVICES[name], extraHTTPHeaders: { 'accept-language': DEVICES[name].locale } }); await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return c; }
async function check(p, name) {
  const w = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }));
  if (SHOTS) await p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
  assert.ok(w.doc <= w.vw + 1, `${name} : débordement horizontal (${w.doc} > ${w.vw})`);
}
const errorsOf = (p) => { const e = []; p.on('pageerror', (x) => e.push(x.message)); p.on('console', (m) => m.type() === 'error' && !/fonts|ERR_FAILED|status of 40[09]/.test(m.text()) && e.push(m.text())); return e; };

for (const dev of Object.keys(DEVICES)) {
  test(`${dev} : page d’accueil, comparatif des formules, langue détectée`, { skip }, async () => {
    const ctx = await ctxFor(dev); const p = await ctx.newPage(); const errs = errorsOf(p);
    await p.goto(app.base + '/'); await check(p, `${dev}-accueil`);
    const lang = await p.getAttribute('html', 'lang'); assert.equal(lang, DEVICES[dev].locale.slice(0, 2));
    assert.ok(await p.isVisible('.plan.best')); assert.ok(await p.isVisible('table.compare'));
    await p.locator('#formules').scrollIntoViewIfNeeded(); await check(p, `${dev}-formules`);
    assert.deepEqual(errs, []); await ctx.close();
  });
  test(`${dev} : tester un exemple sans inscription (réservation, devis, assistant)`, { skip }, async () => {
    const ctx = await ctxFor(dev); const p = await ctx.newPage(); const errs = errorsOf(p);
    await p.goto(app.base + '/'); await Promise.all([p.waitForURL(/\/exemple\/garage/), p.click('.hero-mk .cta a.btn.ghost-light')]);
    await p.waitForSelector('#b-slots .chip'); await check(p, `${dev}-exemple`);
    await p.click('#b-slots .chip >> nth=0'); await p.fill('#b-name', 'Test'); await p.fill('#b-phone', '0612345678'); await p.click('#book button[type=submit]');
    await p.waitForSelector('#b-ok:not(:empty)'); assert.match(await p.textContent('#b-ok'), /Démonstration|Demo/);
    await p.fill('#q', dev === 'android' ? 'What are your opening hours?' : 'Vos horaires ?'); await p.click('#ask button');
    await p.waitForFunction(() => document.querySelectorAll('#msgs .m').length >= 3 && !/^…$/.test(document.querySelector('#msgs .m:last-child').textContent));
    assert.deepEqual(errs, []); await ctx.close();
  });
  test(`${dev} : inscription, site créé automatiquement, confirmation d’un rendez-vous`, { skip }, async () => {
    const ctx = await ctxFor(dev); const p = await ctx.newPage(); const errs = errorsOf(p);
    await p.goto(app.base + '/inscription'); await check(p, `${dev}-inscription`);
    await p.fill('#business', `Garage ${dev}`);
    await p.fill('#activity_search', 'garage'); await p.locator('#activity_results li[data-key="garage"]').click(); assert.equal(await p.inputValue('#activity'), 'garage');
    await p.fill('#city', 'Ville'); await p.fill('#phone', '0612345678');
    await p.fill('#name', 'Pro'); await p.fill('#email', `${dev}@devices.test`); await p.fill('#password', 'Appareil2026ok'); await p.check('input[name=cgu]');
    await Promise.all([p.waitForURL(/\/pro/), p.click('#signup button[type=submit]')]); await check(p, `${dev}-tableau-de-bord`);
    const tn = app.db.one('SELECT * FROM tenants WHERE name=?', `Garage ${dev}`); assert.ok(tn.tz, 'fuseau horaire détecté');
    const site = await ctx.newPage(); await site.goto(`${app.base}/s/${tn.slug}`); await site.waitForSelector('#b-slots .chip'); await check(site, `${dev}-site-pro`);
    await site.click('#b-days .chip >> nth=1'); await site.waitForSelector('#b-slots .chip');
    await site.click('#b-slots .chip >> nth=0'); await site.fill('#b-name', 'Client'); await site.fill('#b-phone', '0611111111'); await site.click('#book button[type=submit]');
    await site.waitForSelector('#b-ok.success');
    await p.reload(); await Promise.all([p.waitForURL(/m=ok/), p.click('button:has-text("Confirm")')]);
    assert.equal(app.db.one('SELECT status FROM appointments WHERE tenant_id=?', tn.id).status, 'confirmed');
    assert.deepEqual(errs, []); await ctx.close();
  });
}
