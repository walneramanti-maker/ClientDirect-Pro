// Numéros et pays dans un vrai navigateur (Chromium), avec des appareils réglés sur différents fuseaux horaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, signup } from './helpers.js';

const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { try { pw = require('/home/claude/.npm-global/lib/node_modules/playwright'); } catch { pw = null; } }
const app = await setup({ BASE_URL: 'http://127.0.0.1', RATE_BOOK_MAX: '200' });
let browser; test.before(async () => { if (pw) browser = await pw.chromium.launch(); });
test.after(async () => { await browser?.close(); await app.close(); });
const skip = !pw && 'Playwright absent';
const PHONE = { viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
async function ctxFor(opts) { const c = await browser.newContext({ ...PHONE, ...opts, extraHTTPHeaders: { 'accept-language': opts.locale || 'fr-FR' } }); await c.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); return c; }
const errorsOf = (p) => { const e = []; p.on('pageerror', (x) => e.push(x.message)); p.on('console', (m) => m.type() === 'error' && !/fonts|ERR_FAILED|status of 40[09]/.test(m.text()) && e.push(m.text())); return e; };
let n = 0;
async function signupIn(p, { phone, before = async () => {} }) {
  n++; await p.goto(app.base + '/inscription'); await before(p);
  await p.fill('#business', `Entreprise Nav ${n}`); await p.fill('#city', 'Ville'); await p.fill('#phone', phone);
  await p.fill('#name', 'Pro'); await p.fill('#email', `nav${n}@tel.test`); await p.fill('#password', 'Navigateur2026ok'); await p.check('input[name=cgu]');
  await Promise.all([p.waitForURL(/\/pro/), p.click('#signup button[type=submit]')]);
  return app.db.one('SELECT * FROM tenants WHERE name=?', `Entreprise Nav ${n}`);
}

test('appareil à Cayenne, navigateur en fr-FR : Guyane et +594 proposés, numéro guyanais conservé', { skip }, async () => {
  const ctx = await ctxFor({ timezoneId: 'America/Cayenne', locale: 'fr-FR' }); const p = await ctx.newPage(); const errs = errorsOf(p);
  const t = await signupIn(p, { phone: '0694 12 34 56', before: async (pg) => {
    assert.equal(await pg.inputValue('#country'), 'GF'); assert.equal(await pg.inputValue('#phone_cc'), '594'); assert.equal(await pg.inputValue('#country_guess'), 'GF');
  } });
  assert.equal(t.country, 'GF'); assert.equal(t.cc, '594'); assert.equal(t.phone, '594694123456'); assert.equal(t.tz, 'America/Cayenne');
  assert.deepEqual(errs, []); await ctx.close();
});

test('appareil à l’heure UTC : un numéro guyanais n’est pas rattaché à la métropole', { skip }, async () => {
  const ctx = await ctxFor({ timezoneId: 'UTC', locale: 'fr-FR' }); const p = await ctx.newPage();
  const t = await signupIn(p, { phone: '0694 55 66 77' });
  assert.equal(t.country, 'GF'); assert.equal(t.phone, '594694556677'); await ctx.close();
});

test('choix explicite du pays depuis Paris : respecté, l’indicatif suit le pays', { skip }, async () => {
  const ctx = await ctxFor({ timezoneId: 'Europe/Paris', locale: 'fr-FR' }); const p = await ctx.newPage();
  const t = await signupIn(p, { phone: '0696 11 22 33', before: async (pg) => {
    assert.equal(await pg.inputValue('#country'), 'FR'); await pg.selectOption('#country', 'MQ'); assert.equal(await pg.inputValue('#phone_cc'), '596');
  } });
  assert.equal(t.country, 'MQ'); assert.equal(t.cc, '596'); assert.equal(t.phone, '596696112233'); assert.equal(t.tz, 'Europe/Paris');
  // Cayenne, mais le professionnel choisit explicitement la France : France, et son 0694 reste guyanais
  const p2 = await ctx.newPage();
  const t2 = await signupIn(p2, { phone: '0694 99 88 77', before: async (pg) => { await pg.selectOption('#country', 'GF'); await pg.selectOption('#country', 'FR'); } });
  assert.equal(t2.country, 'FR'); assert.equal(t2.phone, '594694998877'); await ctx.close();
});

test('indicatif choisi à la main (Londres) : respecté même si le pays proposé est différent', { skip }, async () => {
  const ctx = await ctxFor({ timezoneId: 'UTC', locale: 'en-US' }); const p = await ctx.newPage();
  const t = await signupIn(p, { phone: '07911 123456', before: async (pg) => { await pg.selectOption('#phone_cc', '44'); await pg.selectOption('#country', 'GB'); assert.equal(await pg.inputValue('#phone_cc'), '44', 'indicatif choisi conservé'); } });
  assert.equal(t.country, 'GB'); assert.equal(t.phone, '447911123456'); await ctx.close();
});

test('réservation sur téléphone : indicatif modifiable, champ lisible, numéro au format international', { skip }, async () => {
  const { t } = await signup(app, { business: 'Garage Indicatif', email: 'indicatif@tel.test' });
  app.db.run('UPDATE tenants SET auto_confirm=1 WHERE id=?', t.id);
  const ctx = await ctxFor({ timezoneId: 'America/Cayenne', locale: 'fr-FR' }); const p = await ctx.newPage(); const errs = errorsOf(p);
  await p.goto(`${app.base}/s/${t.slug}#rdv`); await p.waitForSelector('#b-slots .chip');
  assert.equal(await p.inputValue('#b-cc'), '594', 'indicatif du professionnel par défaut');
  const w = await p.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, cc: document.getElementById('b-cc').getBoundingClientRect(), ph: document.getElementById('b-phone').getBoundingClientRect() }));
  assert.ok(w.doc <= w.vw + 1, 'pas de débordement'); assert.ok(w.cc.height >= 36 && w.ph.height >= 36, 'assez grands pour le doigt'); assert.ok(w.ph.width >= 120, 'numéro lisible');
  for (const [cc, raw, want] of [['32', '0470 12 34 56', '32470123456'], ['594', '06 12 34 56 78', '33612345678'], ['594', '0694 11 22 33', '594694112233']]) {
    await p.tap('#b-slots .chip >> nth=0'); await p.selectOption('#b-cc', cc);
    const name = `Client ${want}`; await p.fill('#b-name', name); await p.fill('#b-phone', raw); await p.tap('#book button[type=submit]');
    await p.waitForFunction(() => /enregistrée|confirmé/i.test(document.getElementById('b-ok').textContent));
    assert.equal(app.db.one('SELECT customer_phone FROM appointments WHERE customer_name=?', name).customer_phone, want, `${raw} avec +${cc}`);
    await p.evaluate(() => { document.getElementById('b-ok').textContent = ''; }); await p.waitForSelector('#b-slots .chip');
  }
  assert.deepEqual(errs, []); await ctx.close();
});
