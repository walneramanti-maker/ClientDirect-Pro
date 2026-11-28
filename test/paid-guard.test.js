// Garde-fous financiers : une clé seule n'active rien sans l'autorisation du propriétaire,
// et les dépenses du mois (donc les plafonds) survivent à un redémarrage du serveur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';

const freePort = () => new Promise((r) => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function boot(env) {
  const port = await freePort(); const dir = env.DIR;
  const p = spawn(process.execPath, ['--no-warnings', 'src/server.js'], { env: { ...process.env, NODE_ENV: 'development', APP_ENV: 'development', PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, DB_PATH: path.join(dir, 'db.sqlite'), DISABLE_JOBS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 100 && !/Fonctions payantes/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  return { p, port, log: () => out, stop: () => new Promise((r) => { p.on('exit', r); p.kill('SIGTERM'); }) };
}

test('clés présentes mais sans autorisation : rien de payant ne s’active', async () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-guard-'));
  const s = await boot({ DIR, ANTHROPIC_API_KEY: 'sk-ant-fausse', WHATSAPP_TOKEN: 'faux', WHATSAPP_PHONE_ID: '1' });
  try {
    assert.match(s.log(), /assistant IA NON ACTIVÉ \(clé présente, autorisation AUTORISER_IA_PAYANTE non donnée\)/);
    assert.match(s.log(), /WhatsApp automatique NON ACTIVÉ \(clé présente, autorisation AUTORISER_WHATSAPP_PAYANT non donnée\)/);
    const h = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
    assert.match(h, /bientôt disponible/, 'toujours affiché « bientôt disponible »');
  } finally { await s.stop(); fs.rmSync(DIR, { recursive: true, force: true }); }
});

test('dépenses du mois conservées après redémarrage : le plafond reste atteint', async () => {
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-guard2-'));
  const dbPath = path.join(DIR, 'db.sqlite');
  try {
    const { openDb } = await import('../src/db.js');
    let db = openDb(dbPath); const m = new Date().toISOString().slice(0, 7);
    db.run("INSERT INTO tenants(slug,name,tpl,metier,plan,status,created_at,lang,country,currency) VALUES('x','X','garage','Garage','premium','active',?, 'fr','GF','EUR')", Date.now());
    db.run('INSERT INTO ai_usage(tenant_id,month,calls,in_tokens,out_tokens) VALUES(1,?,5,200000000,0)', m);
    for (let i = 0; i < 50; i++) db.run("INSERT INTO outbox(tenant_id,channel,to_addr,template,payload,status,next_at,created_at) VALUES(1,'whatsapp','33600000000','appt_reminder','{}','sent',0,?)", Date.now());
    db.close();
    // « Redémarrage » : nouvelle connexion à la même base sur disque
    db = openDb(dbPath);
    const { aiSpentEur, aiBudgetEur } = await import('../src/ai.js');
    const { waSpentEur, waBudgetEur } = await import('../src/notify.js');
    assert.ok(aiSpentEur(db) >= aiBudgetEur(db), `IA : ${aiSpentEur(db)} € dépensés pour un budget de ${aiBudgetEur(db)} €`);
    assert.ok(waSpentEur(db) >= waBudgetEur(db) - 0.01 || waSpentEur(db) > 1, 'WhatsApp : dépense relue depuis la base');
    assert.equal(waSpentEur(db).toFixed(2), (50 * 0.0248).toFixed(2));
    db.close();
  } finally { fs.rmSync(DIR, { recursive: true, force: true }); }
});
