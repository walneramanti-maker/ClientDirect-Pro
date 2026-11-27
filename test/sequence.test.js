import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { setup } from './helpers.js';

// Faux serveur SMTP : accepte tout, garde les messages
function fakeSmtp() {
  const got = [];
  const srv = net.createServer((s) => {
    let inData = false; let buf = '';
    s.write('220 test\r\n');
    s.on('data', (d) => {
      buf += d.toString();
      if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i >= 0) { got.push(buf.slice(0, i)); buf = ''; inData = false; s.write('250 OK\r\n'); } return; }
      let k; while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2);
        if (/^EHLO/.test(line)) s.write('250-test\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') s.write('334 VXNlcm5hbWU6\r\n');
        else if (/^[A-Za-z0-9+/=]+$/.test(line) && !/^(QUIT|DATA)$/.test(line)) s.write(Buffer.from(line, 'base64').toString().includes('@') ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n');
        else if (/^(MAIL|RCPT)/.test(line)) s.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; s.write('354 go\r\n'); }
        else if (line === 'QUIT') s.end('221 bye\r\n');
      }
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port, got })));
}
// Faux serveur IMAP : répond aux commandes du client avec des messages préparés
function fakeImap(messages) {
  const seen = [];
  const srv = net.createServer((s) => {
    s.write('* OK IMAP pret\r\n'); let buf = '';
    s.on('data', (d) => {
      buf += d.toString(); let k;
      while ((k = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 2); seen.push(line); const [tag, ...rest] = line.split(' '); const c = rest.join(' ');
        if (/^LOGIN/.test(c)) s.write(`${tag} OK connecte\r\n`);
        else if (/^EXAMINE/.test(c)) s.write(`* ${messages.length} EXISTS\r\n${tag} OK [READ-ONLY] ok\r\n`);
        else if (/^UID SEARCH/.test(c)) { const min = Number((/UID (\d+):\*/.exec(c) || [0, 0])[1]); s.write(`* SEARCH ${messages.filter((m) => m.uid >= min).map((m) => m.uid).join(' ')}\r\n${tag} OK\r\n`); }
        else if (/^UID FETCH/.test(c)) {
          const want = (/UID FETCH ([\d,]+)/.exec(c)[1]).split(',').map(Number);
          for (const [i, m] of messages.entries()) {
            if (!want.includes(m.uid)) continue;
            const h = Buffer.from(m.header); const t = Buffer.from(m.text);
            s.write(Buffer.concat([Buffer.from(`* ${i + 1} FETCH (UID ${m.uid} BODY[HEADER.FIELDS (FROM SUBJECT CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] {${h.length}}\r\n`), h, Buffer.from(` BODY[TEXT]<0> {${t.length}}\r\n`), t, Buffer.from(')\r\n')]));
          }
          s.write(`${tag} OK fetch\r\n`);
        } else if (/^LOGOUT/.test(c)) s.end(`* BYE\r\n${tag} OK\r\n`);
        else s.write(`${tag} BAD\r\n`);
      }
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, port: srv.address().port, seen })));
}

const smtp = await fakeSmtp();
const app = await setup({ CAMPAIGN_SENDING: 'on', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: '0', SMTP_USER: 'contact@clientdirectpro.fr', SMTP_PASS: 'x', CAMPAIGN_DAILY_MAX: '50', CAMPAIGN_GAP_MIN: '1', ADMIN_EMAIL: 'admin@clientdirectpro.fr' });
const { db } = app;
test.after(() => { app.close(); smtp.srv.close(); });
const P = await import('../src/prospect.js');
const C = await import('../src/campaigns.js');
const O = await import('../src/outreach.js');
const I = await import('../src/imap.js');
const { TEMPLATES } = await import('../src/templates.js');
const decode = (raw) => ({ subject: Buffer.from(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw)[1], 'base64').toString(), body: Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString() });
const tue = Date.parse('2026-12-01T13:00:00Z'); // mardi, 14 h à Paris

test('messages personnalisés : un objet et un besoin par métier, essai 14 jours sans carte, mentions obligatoires', () => {
  const subjects = new Set();
  for (const tpl of Object.keys(TEMPLATES)) {
    assert.ok(O.TRADES[tpl], `textes prévus pour ${tpl}`);
    const p = { siren: '1', name: 'TEST', tpl, site_status: 'aucun', postal: '59000' };
    for (const step of [0, 1, 2]) {
      const m = O.sequenceEmail(p, { name: 'Test', demoUrl: 'https://x/demo/t', token: 't', stopUrl: 'https://x/stop/s', step });
      assert.match(m.text, /14 jours, sans carte bancaire/, `${tpl} étape ${step}`);
      assert.match(m.text, /https:\/\/x\/stop\/s \(ou répondez STOP\)/); assert.match(m.text, /SIRET/); assert.match(m.text, /registre public des entreprises \(INSEE\)/);
      assert.match(m.text, /\/inscription\?claim=t&formule=(essentiel|pro|premium)/);
      if (step === 0) { subjects.add(m.subject); assert.match(m.text, new RegExp(O.TRADES[tpl].need.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))); }
    }
    assert.match(O.sequenceEmail(p, { name: 'Test', demoUrl: 'd', token: 't', stopUrl: 's', step: 2 }).text, /je ne vous relancerai plus/);
  }
  assert.equal(subjects.size, Object.keys(TEMPLATES).length, 'un objet différent par métier');
  // Le constat reste prudent et suit l'analyse du site
  assert.match(O.needLine({ site_status: 'plateforme' }), /plateforme/);
  assert.match(O.needLine({ site_status: 'vieillissant', site_flags: '{"booking":false,"quote":true}' }), /ne propose pas encore la réservation en ligne/);
  assert.equal(O.needLine({ site_status: null, website: 'https://x.fr' }), '');
});

test('relances automatiques : J+4 puis J+10, arrêt sur réponse, opposition, inscription ; 3 messages au plus', async () => {
  for (const [i, siren] of ['810000001', '810000002', '810000003', '810000004'].entries()) {
    P.importProspects(db, [{ siren, siret: '', name: `COIFFURE ${i}`, naf: '', tpl: 'coiffeur', city: 'LILLE', postal: '59000', address: '', created_on: '2025-01-01', dept: '59' }]);
    db.run('UPDATE prospects SET email=?, score=5 WHERE siren=?', `salon@coiffure${i}.fr`, siren);
  }
  const id = C.createCampaign(db, { channel: 'email', depts: ['59'], tpls: ['coiffeur'], size: 10 });
  assert.match(db.one('SELECT subject FROM campaign_items WHERE campaign_id=? LIMIT 1', id).subject, /des réservations en ligne, même pendant vos coupes/);
  C.approveCampaign(db, id);
  let t = tue;
  for (let k = 0; k < 4; k++) { const r = await C.sendNext(db, { now: t }); assert.equal(r.step, 0, JSON.stringify(r)); t += 2 * 60e3; }
  assert.equal(smtp.got.length, 4);
  assert.equal((await C.sendNext(db, { now: t })).skipped, 'rien à envoyer à cette heure', 'aucune relance avant J+4');
  const ids = db.all("SELECT i.id, p.id pid, p.siren FROM campaign_items i JOIN prospects p ON p.id=i.prospect_id WHERE campaign_id=? ORDER BY i.id", id);
  // Entreprise 1 répond, 2 s'oppose, 3 s'inscrit, 4 ne répond pas
  db.run('UPDATE prospects SET replied_at=? WHERE id=?', t, ids[0].pid);
  db.run("UPDATE prospects SET status='optout' WHERE id=?", ids[1].pid);
  db.run("INSERT INTO tenants(slug,name,tpl,metier,status,prospect_id,created_at) VALUES('salon-3','Salon 3','coiffeur','Salon','trial',?,?)", ids[2].pid, t);
  assert.equal((await C.sendNext(db, { now: tue + 4 * 864e5 + 3600e3 })).skipped, 'rien à envoyer à cette heure', 'J+4 tombe un samedi : attente du lundi');
  const j4 = tue + 6 * 864e5;
  const r = await C.sendNext(db, { now: j4 }); assert.equal(r.step, 1, JSON.stringify(r)); assert.equal(r.sent, ids[3].id);
  const m1 = decode(smtp.got.at(-1)); assert.match(m1.subject, /^Re: Coiffure 3 : /); assert.match(m1.body, /Je me permets de revenir vers vous/); assert.match(m1.body, /sans carte bancaire/);
  assert.equal((await C.sendNext(db, { now: j4 + 2 * 60e3 })).skipped, 'rien à envoyer à cette heure', 'les 3 autres sont arrêtées');
  assert.equal(db.one("SELECT COUNT(*) n FROM campaign_items WHERE campaign_id=? AND next_at IS NULL", id).n, 3);
  assert.equal((await C.sendNext(db, { now: j4 + 5 * 864e5 })).skipped, 'rien à envoyer à cette heure', 'dernière relance 6 jours après la première');
  const r2 = await C.sendNext(db, { now: j4 + 7 * 864e5 }); assert.equal(r2.step, 2);
  assert.match(decode(smtp.got.at(-1)).body, /C'est mon dernier message : je ne vous relancerai plus/);
  assert.equal((await C.sendNext(db, { now: tue + 30 * 864e5 })).skipped, 'rien à envoyer à cette heure', 'jamais plus de 3 messages');
  assert.equal(db.one('SELECT COUNT(*) n FROM campaign_sends s JOIN campaign_items i ON i.id=s.item_id WHERE i.campaign_id=? AND i.prospect_id=?', id, ids[3].pid).n, 3);
  const f = C.campaignFunnel(db, id);
  assert.equal(f.contacted, 4); assert.deepEqual(f.steps, { 0: 4, 1: 1, 2: 1 }); assert.equal(f.replied, 1); assert.equal(f.optout, 1); assert.equal(f.signups, 1); assert.equal(f.rates.signup, 25);
});

test('réponses lues dans la boîte : STOP enregistré, citation ignorée, refus, rebond, alerte à l’administrateur', async () => {
  const mk = (id, tpl) => { P.importProspects(db, [{ siren: id, siret: '', name: `ENTREPRISE ${id}`, naf: '', tpl, city: 'CAYENNE', postal: '97300', address: '', created_on: '2025-01-01', dept: '973' }]); return db.one('SELECT id FROM prospects WHERE siren=?', id).id; };
  const ps = ['820000001', '820000002', '820000003', '820000004', '820000005'].map((s) => mk(s, 'garage'));
  ['a@garage-a.fr', 'b@garage-b.fr', 'c@garage-c.fr', 'd@garage-d.fr', 'e@gmail.com'].forEach((e, i) => db.run("UPDATE prospects SET email=?, status='contacted' WHERE id=?", e, ps[i]));
  const cid = Number(db.run("INSERT INTO campaigns(name,channel,size,status,created_at) VALUES('t','email',5,'approved',?)", Date.now()).lastInsertRowid);
  ps.forEach((p) => db.run("INSERT INTO campaign_items(campaign_id,prospect_id,to_addr,message,status,step,next_at) VALUES(?,?,?,'m','sent',0,?)", cid, p, 'x', Date.now() + 864e5));
  const quoted = 'Bonjour, merci, pouvez-vous m’appeler demain ?\r\n\r\nLe mar. 1 déc. 2026 à 14:00, Walner Amantie <contact@clientdirectpro.fr> a écrit :\r\n> Pour ne plus recevoir aucun message : https://x/stop/y (ou répondez STOP).\r\n';
  const qp = 'Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n';
  const msgs = [
    { uid: 7, header: 'From: Garage A <a@garage-a.fr>\r\nSubject: Re: Garage A\r\n', text: quoted },
    { uid: 8, header: 'From: b@garage-b.fr\r\nSubject: Re: votre message\r\n', text: 'STOP\r\n' },
    { uid: 9, header: `From: =?UTF-8?B?${Buffer.from('Gérant C').toString('base64')}?= <gerant@garage-c.fr>\r\nSubject: Re: offre\r\n${qp}`, text: 'Non merci, je ne suis pas int=C3=A9ress=C3=A9.\r\n' },
    { uid: 10, header: 'From: Mail Delivery System <MAILER-DAEMON@ovh.net>\r\nSubject: Undelivered Mail Returned to Sender\r\n', text: 'This is the mail system. <d@garage-d.fr>: host not found\r\n' },
    { uid: 11, header: 'From: Inconnu <x@ailleurs.fr>\r\nSubject: bonjour\r\n', text: 'publicité' },
    { uid: 12, header: 'From: Gilles <autre@gmail.com>\r\nSubject: Re\r\nContent-Type: multipart/alternative; boundary="b1"\r\n', text: `--b1\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from('Merci de me désinscrire.').toString('base64')}\r\n--b1--\r\n` }
  ];
  const imap = await fakeImap(msgs);
  try {
    const got = await I.fetchSince({ host: '127.0.0.1', port: imap.port, secure: false, user: 'contact@clientdirectpro.fr', pass: 'p"q' });
    assert.equal(got.length, 6); assert.equal(got[2].from, 'Gérant C <gerant@garage-c.fr>'); assert.match(got[2].text, /intéressé/); assert.match(got[5].text, /désinscrire/);
    assert.ok(imap.seen.some((l) => /EXAMINE INBOX/.test(l)), 'lecture seule'); assert.ok(!imap.seen.some((l) => /STORE|EXPUNGE|COPY|MOVE|SELECT/.test(l)), 'rien n’est modifié dans la boîte');
    assert.ok(imap.seen.some((l) => /LOGIN "contact@clientdirectpro.fr" "p\\"q"/.test(l)));
    const r = I.processReplies(db, got);
    assert.deepEqual({ ...r, lus: undefined }, { lus: undefined, reponses: 1, oppositions: 1, refus: 1, rebonds: 1, inconnus: 2 });
    const st = (i) => db.one('SELECT status, replied_at, bounced_at FROM prospects WHERE id=?', ps[i]);
    assert.equal(st(0).status, 'contacted', 'le STOP cité dans notre propre message n’est PAS une opposition'); assert.ok(st(0).replied_at);
    assert.equal(st(1).status, 'optout'); assert.equal(st(2).status, 'lost'); assert.ok(st(3).bounced_at);
    assert.equal(st(4).status, 'contacted', 'adresse gmail différente : pas de rapprochement par domaine');
    assert.equal(db.one('SELECT COUNT(*) n FROM campaign_items WHERE campaign_id=? AND next_at IS NOT NULL', cid).n, 2, 'relances arrêtées pour les 3 qui ont répondu');
    assert.equal(db.one("SELECT COUNT(*) n FROM outbox WHERE template='admin_prospect_reply'").n, 3);
    // Passage périodique : reprise après le dernier message lu
    const seenBefore = imap.seen.length;
    db.run("INSERT INTO meta(k,v) VALUES('imap_last_uid','12') ON CONFLICT(k) DO UPDATE SET v=excluded.v");
    const again = await I.fetchSince({ host: '127.0.0.1', port: imap.port, secure: false, user: 'u', pass: 'p', lastUid: 12 });
    assert.equal(again.length, 0); assert.ok(imap.seen.slice(seenBefore).some((l) => /UID SEARCH UID 13:\*/.test(l)));
  } finally { imap.srv.close(); }
});

test('citation et formules d’opposition', () => {
  assert.equal(I.ownText('Oui je veux bien\n\nOn Tue, Dec 1, 2026 at 2:00 PM Walner <c@x.fr> wrote:\n> répondez STOP'), 'Oui je veux bien');
  for (const s of ['STOP', 'stop merci', 'Ne plus me contacter', 'désinscription', 'merci de ne pas me recontacter']) assert.match(s, I.OPTOUT_RE, s);
  for (const s of ['Oui, appelez-moi', 'Je stoppe mon activité en mars ? non', 'Combien ça coûte ?']) assert.doesNotMatch(s.replace('stoppe', 'arrête'), I.OPTOUT_RE, s);
});

test('inscription directe avec l’adresse prospectée : comptée comme conversion', async () => {
  P.importProspects(db, [{ siren: '830000001', siret: '', name: 'GARAGE DIRECT', naf: '', tpl: 'garage', city: 'KOUROU', postal: '97310', address: '', created_on: '2025-01-01', dept: '973' }]);
  db.run("UPDATE prospects SET email='patron@garage-direct.fr', status='contacted' WHERE siren='830000001'");
  const c = app.client();
  await c.submit('/inscription', '/inscription', { business: 'Garage Direct', tpl: 'garage', city: 'Kourou', name: 'Patron', email: 'patron@garage-direct.fr', password: 'MotDePasseTresLong2026', cgu: 'on', plan: 'pro', country: 'GF' });
  const p = db.one("SELECT id, status FROM prospects WHERE siren='830000001'"); assert.equal(p.status, 'converted');
  assert.equal(db.one('SELECT source FROM tenants WHERE prospect_id=?', p.id).source, 'prospection');
});

test('noms : formes juridiques retirées, sigles en capitales, nom de personne remplacé par « votre métier à ville »', async () => {
  assert.equal(P.displayName('SARL S2R'), 'S2R'); assert.equal(P.displayName('SNC GAMARD'), 'Gamard'); assert.equal(P.displayName('IYB KEBAB'), 'IYB Kebab');
  assert.equal(P.displayName('SCB DOLCE VITA'), 'Dolce Vita'); assert.equal(P.displayName("LE LYON DE L'ATLAS"), "Le Lyon de l'Atlas"); assert.equal(P.displayName('ALINE LUU (SAIGON)'), 'Saigon');
  assert.equal(P.isPersonName('Remi Francois'), true); assert.equal(P.isPersonName('Garage du Maroni'), false); assert.equal(P.isPersonName('Mala Neva'), false);
  const m = O.sequenceEmail({ tpl: 'coiffeur', city: 'ROUEN', site_status: 'aucun' }, { name: 'Remi Francois', demoUrl: 'd', token: 't', stopUrl: 's' });
  assert.equal(m.subject, 'Votre salon de coiffure à Rouen : des réservations en ligne, même pendant vos coupes');
  assert.match(m.text, /exemple de site pour votre salon de coiffure à Rouen\./); assert.doesNotMatch(m.text, /Remi|\u0000/);
});
