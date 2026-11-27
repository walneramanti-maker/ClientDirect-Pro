import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setup } from './helpers.js';

// Faux serveur SMTP local : enregistre le dialogue et le message reçu
function fakeSmtp() {
  const got = { lines: [], data: '' };
  const srv = net.createServer((s) => {
    let inData = false; let buf = '';
    s.write('220 test ESMTP\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i >= 0) { got.data = buf.slice(0, i); buf = ''; inData = false; s.write('250 OK queued\r\n'); } return; }
      let k; while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2); got.lines.push(line);
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (got.lines.at(-2) === 'AUTH LOGIN') s.write('334 UGFzc3dvcmQ6\r\n');
        else if (got.lines.at(-3) === 'AUTH LOGIN') s.write(Buffer.from(line, 'base64').toString() === 'bon-mot-de-passe' ? '235 ok\r\n' : '535 refus\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); if (buf) s.emit('data', ''); }
        else if (line === 'QUIT') s.end('221 bye\r\n');
      }
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port, got })));
}

const smtp = await fakeSmtp();
const app = await setup({ CAMPAIGN_SENDING: 'on', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: '0', SMTP_USER: 'contact@clientdirectpro.fr', SMTP_PASS: 'bon-mot-de-passe', CAMPAIGN_DAILY_MAX: '2', CAMPAIGN_GAP_MIN: '8' });
const { db } = app;
test.after(() => { app.close(); smtp.srv.close(); });
const P = await import('../src/prospect.js');
const C = await import('../src/campaigns.js');

test('envoi des campagnes validées : un e-mail espacé, en heures ouvrées, plafonné, conforme', async () => {
  for (const [i, siren] of ['700000001', '700000002', '700000003'].entries()) {
    P.importProspects(db, [{ siren, siret: '', name: `GARAGE ${i}`, naf: '', tpl: 'garage', city: 'LILLE', postal: '59000', address: '', created_on: '2025-01-01', dept: '59' }]);
    db.run('UPDATE prospects SET email=?, score=5 WHERE siren=?', `contact@g${i}.fr`, siren);
  }
  const id = C.createCampaign(db, { channel: 'email', depts: ['59'], tpls: ['garage'], size: 10 });
  const tue10 = Date.parse('2026-12-01T09:30:00Z'); // mardi 10 h 30 à Paris
  assert.deepEqual(await C.sendNext(db, { now: tue10 }), { skipped: 'rien à envoyer à cette heure' }, 'campagne non validée : rien ne part');
  C.approveCampaign(db, id);
  const sun = Date.parse('2026-12-06T10:00:00Z');
  assert.equal((await C.sendNext(db, { now: sun })).skipped, 'rien à envoyer à cette heure', 'pas le dimanche');
  const r1 = await C.sendNext(db, { now: tue10 }); assert.ok(r1.sent, JSON.stringify(r1));
  assert.match(Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(smtp.got.data)[1], 'base64').toString(), /^Garage 0 : vos clients peuvent-ils réserver leur entretien en ligne \?$/); assert.match(smtp.got.data, /From: =\?UTF-8\?B\?/); assert.match(smtp.got.data, /List-Unsubscribe: <https?:\/\/[^>]+\/stop\//); assert.match(smtp.got.data, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  const body = Buffer.from(smtp.got.data.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString();
  assert.match(body, /399 € HT de mise en service/); assert.match(body, /engagement de 12 mois/); assert.match(body, /SIRET/); assert.match(body, /Pour ne plus recevoir aucun message/); assert.match(body, /sans carte bancaire/);
  assert.equal((await C.sendNext(db, { now: tue10 + 60e3 })).skipped, 'espacement');
  db.run("UPDATE prospects SET status='optout' WHERE siren='700000002'");
  const r2 = await C.sendNext(db, { now: tue10 + 9 * 60e3 }); assert.ok(r2.sent);
  assert.equal(db.one("SELECT i.status FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE p.siren='700000002'").status, 'skipped', 'opposition respectée');
  assert.equal((await C.sendNext(db, { now: tue10 + 20 * 60e3 })).skipped, 'plafond quotidien');
  assert.equal(db.one("SELECT COUNT(*) n FROM prospects WHERE status='contacted'").n, 2);
});

test('désinscription en un clic depuis la messagerie (sans formulaire)', async () => {
  const tok = (/\/stop\/([A-Za-z0-9_-]+)/.exec(db.one("SELECT message FROM campaign_items WHERE status='ready' OR status='sent' LIMIT 1").message))[1];
  const res = await fetch(`${app.base}/stop/${tok}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.equal(res.status, 200);
  assert.ok(db.one("SELECT COUNT(*) n FROM prospects WHERE status='optout'").n >= 2);
});
