// Dessine les calques de chaque scène : fond (opaque), téléphone (transparent, animé), textes (transparent, fixe).
const { chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright');
const fs = require('fs');
const TL = JSON.parse(fs.readFileSync('/tmp/ad/timeline.json', 'utf8'));
const CAP = '/tmp/ad/cap';
const OUT = '/tmp/ad/layers';
fs.mkdirSync(OUT, { recursive: true });

const FMT = { v: { w: 1080, h: 1920 }, s: { w: 1080, h: 1080 } };
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const T = {
  fr: { notifApp: 'ClientDirect Pro', notifTime: '23:47', notif: 'Nouveau rendez-vous : Sophie M., mardi 9h30', cta: 'Créez votre site', free: 'Essayez gratuitement pendant 14 jours,', nocard: 'sans carte bancaire.', tag: 'Votre partenaire digital' },
  en: { notifApp: 'ClientDirect Pro', notifTime: '11:47 PM', notif: 'New booking: Sophie M., Tuesday 9:30 AM', cta: 'Create your site', free: 'Try it free for 14 days,', nocard: 'no credit card required.', tag: 'Your digital partner' },
};

const BASE_CSS = `*{box-sizing:border-box;margin:0;padding:0}html,body{background:transparent}
body{font-family:Inter,sans-serif;-webkit-font-smoothing:antialiased;color:#fff;overflow:hidden}
.disp{font-family:'Inter Display',Inter,sans-serif}
.phone{position:absolute;border-radius:var(--r);background:#0a0b0e;padding:var(--b);box-shadow:0 40px 90px rgba(0,0,0,.55),0 0 0 2px rgba(255,255,255,.08)}
.phone .scr{width:100%;height:100%;border-radius:calc(var(--r) - var(--b));overflow:hidden;background:#fff;position:relative}
.phone img{width:100%;display:block}
.notch{position:absolute;top:calc(var(--b) + 12px);left:50%;transform:translateX(-50%);width:28%;height:3.2%;background:#0a0b0e;border-radius:40px;z-index:3}
.notif{position:absolute;left:4%;right:4%;top:7%;z-index:4;background:rgba(245,246,248,.96);color:#14161a;border-radius:28px;padding:22px 24px;display:flex;gap:18px;align-items:center;box-shadow:0 18px 40px rgba(0,0,0,.35)}
.notif .ic{flex:0 0 64px;height:64px;border-radius:16px;background:#1f5eff;color:#fff;display:grid;place-items:center;font-weight:800;font-size:34px}
.notif .hd{display:flex;justify-content:space-between;font-size:22px;color:#5d6470;font-weight:600}
.notif .tx{font-size:27px;font-weight:600;line-height:1.25;margin-top:4px}
.logo{position:absolute;font-weight:800;letter-spacing:-.01em;display:flex;align-items:center;gap:14px}
.logo i{display:inline-block;border-radius:50%;background:#1f5eff;box-shadow:0 0 0 6px rgba(31,94,255,.25)}
.title{position:absolute;font-weight:800;letter-spacing:-.025em;line-height:1.02}
.title .l2{color:#8fb0ff}
.sub{text-wrap:balance;position:absolute;left:50%;transform:translateX(-50%);text-align:center;background:rgba(10,11,14,.82);border-radius:22px;font-weight:600;line-height:1.28;box-shadow:0 10px 30px rgba(0,0,0,.35)}
.sub span{color:#ffcf33}`;

function bgHtml(f) {
  return `<html><head><style>${BASE_CSS}
body{width:${f.w}px;height:${f.h}px;background:radial-gradient(120% 70% at 85% 10%,#22346b 0%,rgba(20,22,26,0) 55%),radial-gradient(90% 60% at 0% 100%,#1b2b55 0%,rgba(20,22,26,0) 60%),#14161a}
.grid{position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.035) 1px,transparent 1px);background-size:54px 54px;mask-image:radial-gradient(80% 60% at 50% 40%,#000 0%,transparent 80%)}
</style></head><body><div class="grid"></div></body></html>`;
}

function phoneBox(img, x, y, w, extra = '', rot = 0) {
  const h = Math.round(w * 844 / 390) + Math.round(w * 0.06);
  const r = Math.round(w * 0.13), b = Math.round(w * 0.028);
  return `<div class="phone" style="--r:${r}px;--b:${b}px;left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rot}deg)"><div class="notch"></div><div class="scr"><img src="file://${img}">${extra}</div></div>`;
}

function phoneHtml(f, fk, sc, lang) {
  const t = T[lang];
  let inner = '';
  const notif = sc.key === 'nuit' ? `<div class="notif" style="zoom:${fk === 'v' ? 1 : 0.68}"><div class="ic">C</div><div style="flex:1"><div class="hd"><span>${t.notifApp}</span><span>${t.notifTime}</span></div><div class="tx">${esc(t.notif)}</div></div></div>` : '';
  if (sc.cap === 'end') {
    inner = '';
  } else if (sc.cap === 'trio') {
    const w = fk === 'v' ? 470 : 330;
    const cx = f.w / 2, y = fk === 'v' ? 640 : 250;
    inner = phoneBox(`${CAP}/${lang}-resto.jpg`, cx - w / 2 - w * 0.62, y + 90, w, '', -9)
      + phoneBox(`${CAP}/${lang}-beaute.jpg`, cx - w / 2 + w * 0.62, y + 90, w, '', 9)
      + phoneBox(`${CAP}/${lang}-garage.jpg`, cx - w / 2, y, w);
  } else {
    const img = `${CAP}/${lang}-${sc.cap}.jpg`;
    if (fk === 'v') inner = phoneBox(img, (f.w - 620) / 2, 660, 620, notif);
    else inner = phoneBox(img, 600, 150, 400, notif);
  }
  return `<html><head><style>${BASE_CSS}body{width:${f.w}px;height:${f.h}px}</style></head><body>${inner}</body></html>`;
}

function ovHtml(f, fk, sc, lang) {
  const t = T[lang];
  const [l1, l2 = ''] = sc.title[lang].split('\n');
  const vo = esc(sc.vo[lang]);
  let body = '';
  if (sc.cap === 'end') {
    const big = fk === 'v' ? 96 : 70;
    body = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 70px;gap:${fk === 'v' ? 46 : 28}px">
      <div class="logo" style="position:static;font-size:${fk === 'v' ? 64 : 50}px"><i style="width:${fk === 'v' ? 30 : 24}px;height:${fk === 'v' ? 30 : 24}px"></i>ClientDirect Pro</div>
      <div class="disp" style="font-weight:800;font-size:${big}px;line-height:1.04;letter-spacing:-.025em">${esc(t.free)}<br><span style="color:#ffcf33">${esc(t.nocard)}</span></div>
      <div style="font-size:${fk === 'v' ? 40 : 32}px;color:#c9d3ea;font-weight:600">${esc(t.cta)}</div>
    </div>`;
  } else {
    const logo = fk === 'v' ? `<div class="logo" style="left:72px;top:150px;font-size:40px"><i style="width:18px;height:18px"></i>ClientDirect Pro</div>`
      : `<div class="logo" style="left:64px;top:70px;font-size:32px"><i style="width:14px;height:14px"></i>ClientDirect Pro</div>`;
    const title = fk === 'v' ? `<div class="title disp" style="left:72px;top:250px;width:936px;font-size:${l1.length > 20 || l2.length > 22 ? 78 : 92}px">${esc(l1)}<br><span class="l2">${esc(l2)}</span></div>`
      : `<div class="title disp" style="left:64px;top:160px;width:520px;font-size:${l1.length > 18 || l2.length > 20 ? 54 : 64}px">${esc(l1)}<br><span class="l2">${esc(l2)}</span></div>`;
    const sub = fk === 'v' ? `<div class="sub" style="bottom:400px;width:940px;font-size:46px;padding:26px 34px">${vo}</div>`
      : `<div class="sub" style="bottom:48px;width:1000px;font-size:34px;padding:20px 28px">${vo}</div>`;
    body = logo + title + sub;
  }
  return `<html><head><style>${BASE_CSS}body{width:${f.w}px;height:${f.h}px}</style></head><body>${body}</body></html>`;
}

function urlHtml(f, fk) {
  // Pastille d'adresse de la carte finale, animée séparément
  const size = fk === 'v' ? 50 : 38;
  const top = fk === 'v' ? 1330 : 850;
  return `<html><head><style>${BASE_CSS}body{width:${f.w}px;height:${f.h}px}</style></head><body>
  <div style="position:absolute;left:0;right:0;top:${top}px;display:flex;justify-content:center"><div style="background:#1f5eff;color:#fff;font-weight:800;font-size:${size}px;padding:${size * 0.55}px ${size * 0.9}px;border-radius:999px;box-shadow:0 18px 50px rgba(31,94,255,.45);letter-spacing:-.01em">${TL.url}</div></div></body></html>`;
}

(async () => {
  const b = await chromium.launch();
  const only = process.argv[2]; // ex. "v-fr-nuit" pour une seule scène
  for (const [fk, f] of Object.entries(FMT)) {
    const p = await b.newPage({ viewport: { width: f.w, height: f.h } });
    const render = async (html, path, transparent) => {
      fs.writeFileSync('/tmp/ad/_l.html', html);
      await p.goto('file:///tmp/ad/_l.html'); await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path, omitBackground: transparent });
    };
    await render(bgHtml(f), `${OUT}/${fk}-bg.png`, false);
    await render(urlHtml(f, fk), `${OUT}/${fk}-url.png`, true);
    for (const lang of ['fr', 'en']) for (const sc of TL.scenes) {
      const id = `${fk}-${lang}-${sc.key}`;
      if (only && only !== id) continue;
      await render(phoneHtml(f, fk, sc, lang), `${OUT}/${id}-phone.png`, true);
      await render(ovHtml(f, fk, sc, lang), `${OUT}/${id}-ov.png`, true);
    }
    await p.close();
  }
  await b.close();
})();
