// Outils de test : application sur une base temporaire, client HTTP avec cookies, faux services externes.
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

export async function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-test-'));
  Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(dir, 'db.sqlite'), DISABLE_JOBS: '1', BASE_URL: 'http://127.0.0.1', ...env });
  const [{ openDb }, { createApp }, net, sec] = await Promise.all([import('../src/db.js'), import('../src/app.js'), import('../src/net.js'), import('../src/security.js')]);
  const db = openDb(process.env.DB_PATH);
  const server = http.createServer(createApp(db));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  const close = async () => { net.resetFetch(); await new Promise((r) => server.close(r)); db.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { db, base, close, net, sec, realFetch, client: () => makeClient(base, realFetch) };
}

function makeClient(base, f) {
  const jar = {};
  const store = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i); const v = kv.slice(i + 1); if (/Max-Age=0/.test(c)) delete jar[k]; else jar[k] = v; } };
  const hdr = () => ({ cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') });
  const c = {
    jar,
    async get(p, h = {}) { const r = await f(base + p, { headers: { ...hdr(), ...h }, redirect: 'manual' }); store(r); return { status: r.status, location: r.headers.get('location'), text: await r.text(), headers: r.headers }; },
    async post(p, form, h = {}) { const r = await f(base + p, { method: 'POST', headers: { ...hdr(), 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(form).toString(), redirect: 'manual' }); store(r); return { status: r.status, location: r.headers.get('location'), text: await r.text() }; },
    async json(p, body, h = {}) { const r = await f(base + p, { method: body ? 'POST' : 'GET', headers: { ...hdr(), 'content-type': 'application/json', accept: 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined }); store(r); return { status: r.status, ...(await r.json()) }; },
    csrf: (htmlText) => (/name="csrf" value="([^"]+)"/.exec(htmlText) || [])[1],
    /** Récupère le jeton CSRF d'une page puis envoie le formulaire. */
    async submit(pageUrl, action, form) { const p = await c.get(pageUrl); return c.post(action, { csrf: c.csrf(p.text), ...form }); }
  };
  return c;
}

export const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

/** Inscrit un professionnel par le vrai formulaire et renvoie son client connecté. */
export async function signup(app, { business = 'Garage Alpha', email = 'alpha@test.fr', tpl = 'garage', plan = 'pro', password = 'MotDePasse2026' } = {}) {
  app.sec.resetRateLimits(); // tous les tests viennent de la même adresse IP
  const c = app.client();
  const r = await c.submit('/inscription', '/inscription', { business, tpl, city: 'Cayenne', tz: 'America/Cayenne', phone: '0694000001', plan, name: 'Test', email, password, cgu: 'on' });
  if (r.status !== 303) throw new Error('Inscription refusée : ' + r.text.slice(0, 400));
  const t = app.db.one('SELECT t.* FROM tenants t JOIN users u ON u.id=t.owner_user_id WHERE u.email=?', email);
  return { c, t };
}
