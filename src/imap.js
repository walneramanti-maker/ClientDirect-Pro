// Lecture des réponses aux campagnes dans la boîte du domaine (IMAP, lecture seule : EXAMINE + BODY.PEEK, rien n'est
// marqué lu, déplacé ni supprimé). Sert à respecter immédiatement les « STOP », arrêter les relances et repérer les rebonds.
import net from 'node:net';
import tls from 'node:tls';
import { applyOptout } from './suppression.js';
import { enqueue } from './notify.js';
import { config } from './config.js';

const q = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

/** Client IMAP minimal. Retourne les messages reçus après lastUid (au plus `max`) : { uid, from, subject, text }. */
export function fetchSince({ host, port = 993, secure = true, user, pass, lastUid = 0, sinceDays = 14, max = 50, timeoutMs = 25000 }) {
  return new Promise((resolve, reject) => {
    const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = Buffer.alloc(0); let n = 0; let pending = null; let done = false;
    const fail = (e) => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch { /* fermé */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('Délai IMAP dépassé')), timeoutMs);
    sock.on('error', fail); sock.on('close', () => fail(new Error('Connexion IMAP fermée')));
    const check = () => {
      if (!pending) return;
      const s = buf.toString('latin1'); const m = new RegExp(`(^|\\r\\n)${pending.tag} (OK|NO|BAD)([^\\r\\n]*)\\r\\n`).exec(s);
      if (!m) return;
      const end = m.index + m[0].length; const body = buf.subarray(0, end); buf = buf.subarray(end);
      const p = pending; pending = null;
      if (m[2] !== 'OK') p.reject(new Error(`IMAP ${m[2]}${m[3]}`.slice(0, 160))); else p.resolve(body);
    };
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); if (greet) { const s = buf.toString('latin1'); const i = s.indexOf('\r\n'); if (i >= 0) { const g = greet; greet = null; buf = buf.subarray(i + 2); g(s.slice(0, i)); } } else check(); });
    const cmd = (c) => new Promise((res, rej) => { const tag = `A${++n}`; pending = { tag, resolve: res, reject: rej }; sock.write(`${tag} ${c}\r\n`); check(); });
    let greet = null;
    new Promise((r) => { greet = r; }).then(async (g) => {
      if (!/^\* (OK|PREAUTH)/.test(g)) throw new Error(`Accueil IMAP inattendu : ${g.slice(0, 80)}`);
      await cmd(`LOGIN ${q(user)} ${q(pass)}`);
      await cmd('EXAMINE INBOX');
      const since = new Date(Date.now() - sinceDays * 864e5); const mon = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[since.getUTCMonth()];
      const sr = (await cmd(lastUid ? `UID SEARCH UID ${lastUid + 1}:*` : `UID SEARCH SINCE ${since.getUTCDate()}-${mon}-${since.getUTCFullYear()}`)).toString('latin1');
      const uids = ((/\* SEARCH([^\r\n]*)/.exec(sr) || [])[1] || '').trim().split(/\s+/).filter(Boolean).map(Number).filter((u) => u > lastUid).sort((a, b) => a - b).slice(0, max);
      const out = [];
      if (uids.length) {
        const raw = await cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.4000>)`);
        out.push(...parseFetch(raw));
      }
      await cmd('LOGOUT').catch(() => {});
      done = true; clearTimeout(timer); sock.destroy(); resolve(out);
    }).catch(fail);
  });
}

/** Découpe une réponse FETCH en tenant compte des littéraux {n} (octets exacts). */
export function parseFetch(raw) {
  const msgs = []; let cur = null; let i = 0; const s = raw.toString('latin1');
  while (i < raw.length) {
    const lit = /\{(\d+)\}\r\n/g; lit.lastIndex = i;
    const start = /\* \d+ FETCH \(/g; start.lastIndex = i;
    const ms = start.exec(s); const ml = lit.exec(s);
    if (ms && (!ml || ms.index < ml.index)) { cur = { uid: 0, header: '', text: '' }; msgs.push(cur); i = ms.index + ms[0].length; const u = /UID (\d+)/.exec(s.slice(i, i + 200)); if (u) cur.uid = Number(u[1]); continue; }
    if (!ml) break;
    const before = s.slice(Math.max(0, ml.index - 120), ml.index); const len = Number(ml[1]); const dataStart = ml.index + ml[0].length;
    const chunk = raw.subarray(dataStart, dataStart + len);
    if (cur) { if (/BODY\[HEADER[^\]]*\]\s*$/.test(before)) cur.header = chunk.toString('utf8'); else if (/BODY\[TEXT\](<\d+>)?\s*$/.test(before)) cur.text = chunk; const u = /UID (\d+)/.exec(s.slice(dataStart + len, dataStart + len + 200)); if (!cur.uid && u) cur.uid = Number(u[1]); }
    i = dataStart + len;
  }
  return msgs.map((m) => { const h = unfold(m.header); return { uid: m.uid, from: decodeWords(hdr(h, 'from')), subject: decodeWords(hdr(h, 'subject')), text: bodyText(h, m.text || Buffer.alloc(0)) }; });
}
const unfold = (h) => String(h).replace(/\r?\n[ \t]+/g, ' ');
const hdr = (h, k) => (new RegExp(`^${k}:\\s*(.*)$`, 'im').exec(h) || [])[1] || '';
function decodeWords(v) {
  return String(v).replace(/=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g, (x, cs, enc, txt) => {
    const b = enc.toUpperCase() === 'B' ? Buffer.from(txt, 'base64') : Buffer.from(txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (y, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1');
    return /utf-?8/i.test(cs) ? b.toString('utf8') : b.toString('latin1');
  }).replace(/\?=\s+=\?/g, '');
}
function decodePart(buf, cte, ctype) {
  let b = buf;
  if (/base64/i.test(cte)) b = Buffer.from(buf.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (/quoted-printable/i.test(cte)) b = Buffer.from(buf.toString('latin1').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (y, hx) => String.fromCharCode(parseInt(hx, 16))), 'latin1');
  const t = /charset="?utf-?8/i.test(ctype) || !/charset/i.test(ctype) ? b.toString('utf8') : b.toString('latin1');
  return /text\/html/i.test(ctype) ? t.replace(/<blockquote[\s\S]*$/i, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : t;
}
/** Texte lisible du message : première partie texte d'un message multipart, décodée (base64, quoted-printable). */
function bodyText(h, raw) {
  const ctype = hdr(h, 'content-type'); const bnd = (/boundary="?([^";]+)"?/i.exec(ctype) || [])[1];
  if (!bnd) return decodePart(raw, hdr(h, 'content-transfer-encoding'), ctype);
  const s = raw.toString('latin1'); const parts = s.split(`--${bnd}`).slice(1);
  for (const p of parts) {
    const k = p.indexOf('\r\n\r\n'); if (k < 0) continue;
    const ph = unfold(p.slice(0, k)); const pt = hdr(ph, 'content-type');
    if (/multipart\//i.test(pt)) { const inner = bodyText(ph, Buffer.from(p.slice(k + 4), 'latin1')); if (inner) return inner; continue; }
    if (/text\/(plain|html)/i.test(pt) || !pt) return decodePart(Buffer.from(p.slice(k + 4), 'latin1'), hdr(ph, 'content-transfer-encoding'), pt);
  }
  return '';
}

/** Partie écrite par l'expéditeur (sans la citation de notre message, qui contient lui-même le mot STOP). */
export function ownText(text) {
  const lines = String(text).replace(/\r/g, '').split('\n'); const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l) || /^(Le |On ).{5,200}(a écrit|wrote)\s*:?\s*$/i.test(l.trim()) || /^-{2,}\s*(Original|Message d'origine|Message transféré)/i.test(l.trim()) || /^(De|From)\s*:/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').trim();
}
export const OPTOUT_RE = /\bstop\b|d[ée]sinscri|d[ée]sabonn|ne (plus|pas) (me |nous )?(contacter|recontacter|[ée]crire|relancer|envoyer)|ne plus recevoir|retirez|supprimez (mes|nos)|rayez|unsubscribe|spam/i;
export const REFUSAL_RE = /pas int[ée]ress|non merci|aucun int[ée]r[êe]t|d[ée]j[àa] un site|pas besoin/i;
const GENERIC = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|aol|gmx|proton(mail)?|orange|wanadoo|free|sfr|neuf|laposte|bbox|numericable|club-internet|cegetel|aliceadsl|voila|mediaserv|canl|outremer-telecom)\.[a-z.]+$/i;

/** Applique les réponses reçues : rebond, opposition (STOP), refus, ou réponse à traiter (relances arrêtées). */
export function processReplies(db, msgs, now = Date.now()) {
  const r = { lus: msgs.length, reponses: 0, oppositions: 0, refus: 0, rebonds: 0, inconnus: 0 };
  const contacted = "EXISTS (SELECT 1 FROM campaign_items i WHERE i.prospect_id=p.id AND i.status='sent')";
  for (const m of msgs) {
    const from = ((/<([^>]+)>/.exec(m.from) || [])[1] || m.from).trim().toLowerCase();
    if (from === String(config.smtp.from || '').toLowerCase()) continue;
    if (/mailer-daemon|postmaster|mail delivery/i.test(m.from) || /undeliver|non remis|delivery status|[ée]chec de (la )?(remise|distribution)|returned mail|failure notice|adresse introuvable/i.test(m.subject)) {
      const addrs = [...new Set((String(m.text).match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).map((x) => x.toLowerCase()))];
      for (const a of addrs) { const p = db.one(`SELECT id FROM prospects p WHERE email=? AND ${contacted}`, a); if (p) { db.run('UPDATE prospects SET bounced_at=? WHERE id=?', now, p.id); r.rebonds++; } }
      continue;
    }
    let p = db.one(`SELECT * FROM prospects p WHERE email=? AND ${contacted}`, from);
    const dom = from.split('@')[1] || '';
    if (!p && dom && !GENERIC.test(dom)) p = db.one(`SELECT * FROM prospects p WHERE email LIKE ? AND ${contacted} ORDER BY last_contact_at DESC LIMIT 1`, `%@${dom}`);
    if (!p) { r.inconnus++; continue; }
    const own = `${m.subject.replace(/^(re|tr|fwd?)\s*:\s*/gi, '')}\n${ownText(m.text)}`;
    let outcome = 'reponse';
    if (OPTOUT_RE.test(own)) { applyOptout(db, p.id, 'réponse STOP par e-mail'); outcome = 'opposition'; r.oppositions++; }
    else if (REFUSAL_RE.test(own)) { db.run("UPDATE prospects SET status=CASE WHEN status='converted' THEN status ELSE 'lost' END WHERE id=?", p.id); outcome = 'refus'; r.refus++; }
    else r.reponses++;
    db.run('UPDATE prospects SET replied_at=COALESCE(replied_at, ?), last_contact_at=? WHERE id=?', now, now, p.id);
    db.run("UPDATE campaign_items SET next_at=NULL WHERE prospect_id=? AND status='sent'", p.id);
    db.run("INSERT INTO contacts(prospect_id,channel,outcome,note,created_at) VALUES(?,'email',?,?,?)", p.id, outcome, own.slice(0, 300), now);
    if (config.adminEmail) enqueue(db, { channel: 'email', to: config.adminEmail, template: 'admin_prospect_reply', key: `reponse:${p.id}:${m.uid}`, payload: { lang: 'fr', prospect: p.name, city: p.city, email: from, issue: { opposition: 'Opposition enregistrée définitivement (STOP) : plus aucun message ne lui sera envoyé.', refus: 'Refus : relances arrêtées, entreprise classée « Pas intéressé ».', reponse: 'Relances arrêtées : répondez-lui personnellement depuis contact@.' }[outcome], extract: own.slice(0, 600), url: `${config.baseUrl}/admin/prospection` } });
  }
  return r;
}

export const imapReady = () => { const c = config.imap; return !!(c.host && c.user && c.pass); };
/** Passage périodique : lit les nouveaux messages et applique les réponses. Le dernier UID lu est mémorisé. */
export async function checkReplies(db, { now = Date.now(), fetch = fetchSince } = {}) {
  if (!imapReady()) return { skipped: 'boîte de réception non configurée' };
  const lastUid = Number(db.one("SELECT v FROM meta WHERE k='imap_last_uid'")?.v || 0);
  const msgs = await fetch({ ...config.imap, lastUid });
  const r = processReplies(db, msgs, now);
  const maxUid = msgs.reduce((a, m) => Math.max(a, m.uid || 0), lastUid);
  db.run("INSERT INTO meta(k,v) VALUES('imap_last_uid',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(maxUid));
  return r;
}
