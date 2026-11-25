const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const B = 'http://localhost:4317';
const HIDE = '.demo-bar,.env-bar,.envbar,[class*=env-bar]{display:none!important}';
(async () => {
  const b = await chromium.launch();
  for (const lang of ['fr', 'en']) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, locale: lang === 'fr' ? 'fr-FR' : 'en-US', timezoneId: lang === 'fr' ? 'Europe/Paris' : 'America/New_York' });
    const p = await ctx.newPage();
    const shot = async (name, url, prep) => {
      await p.goto(B + url + (url.includes('?') ? '&' : '?') + 'lang=' + lang);
      await p.addStyleTag({ content: HIDE }); await p.waitForTimeout(300);
      if (prep) await prep();
      await p.waitForTimeout(300);
      await p.screenshot({ path: `/tmp/ad/cap/${lang}-${name}.jpg`, type: 'jpeg', quality: 92 });
    };
    await shot('beaute', '/exemple/beaute');
    await shot('signup', '/inscription', async () => { const i = p.locator('form input:visible').first(); await i.fill(lang === 'fr' ? 'Garage du Fleuve' : 'Riverside Auto Care'); });
    await shot('quote', '/exemple/artisan', async () => { await p.locator('#devis').scrollIntoViewIfNeeded(); await p.evaluate(() => window.scrollBy(0, -20)); await p.fill('#q-name', lang === 'fr' ? 'Sophie Martin' : 'Sophie Martin'); await p.fill('#q-phone', '+33 6 12 34 56 78'); });
    await shot('booking', '/exemple/garage', async () => {
      await p.evaluate(() => document.getElementById('rdv').scrollIntoView()); await p.evaluate(() => window.scrollBy(0, -10));
      const chips = p.locator('#rdv .chip'); const n = await chips.count();
      if (n > 2) await chips.nth(1).click(); await p.waitForTimeout(300);
      await p.waitForSelector('#b-slots .chip'); const s = p.locator('#b-slots .chip'); const m = await s.count(); await s.nth(Math.min(4, m - 1)).click();
    });
    await shot('chat', '/exemple/garage', async () => {
      await p.evaluate(() => document.getElementById('chat').scrollIntoView()); await p.evaluate(() => window.scrollBy(0, -40));
      await p.fill('#q', lang === 'fr' ? 'Vous êtes ouverts samedi ?' : 'Are you open on Saturday?'); await p.click('#ask button'); await p.waitForTimeout(1500);
    });
    await shot('dash', '/exemple/espace-pro');
    await shot('dash2', '/exemple/espace-pro', async () => { await p.evaluate(() => { const h = [...document.querySelectorAll('h2,h3')].find((e) => /30/.test(e.textContent)); h.scrollIntoView(); window.scrollBy(0, -90); }); });
    await shot('resto', '/exemple/restaurant');
    await shot('garage', '/exemple/garage');
    await ctx.close();
  }
  await b.close();
})();
