// Envoi d'e-mails par la boîte professionnelle du domaine (SMTP), sans dépendance.
// Utilisé UNIQUEMENT pour les campagnes de prospection validées, avec plafond quotidien.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const encWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Construit le message (texte brut UTF-8, en-têtes de désinscription en un clic). */
export function buildMessage({ from, fromName, to, subject, text, unsubscribeUrl, replyTo }) {
  const domain = String(from).split('@')[1] || 'localhost';
  const body = b64(text.replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  const h = [
    `From: ${fromName ? `${encWord(fromName)} <${from}>` : from}`, `To: ${to}`, `Subject: ${encWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`, `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'
  ];
  if (replyTo) h.push(`Reply-To: ${replyTo}`);
  if (unsubscribeUrl) h.push(`List-Unsubscribe: <${unsubscribeUrl}>, <mailto:${from}?subject=STOP>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  return `${h.join('\r\n')}\r\n\r\n${body}`;
}

/** Dialogue SMTP minimal : TLS direct (465) ou STARTTLS (587), authentification LOGIN. */
export function sendMail({ host, port = 465, secure = true, user, pass, from, to, data, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    let sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
    let buf = ''; let waiter = null; let done = false;
    const fail = (e) => { if (done) return; done = true; try { sock.destroy(); } catch { /* fermé */ } reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('Délai SMTP dépassé')), timeoutMs);
    const attach = (s) => { s.setEncoding('utf8'); s.on('data', (d) => { buf += d; const m = /(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/.exec(buf); if (m && waiter) { const w = waiter; waiter = null; const txt = buf; buf = ''; w(Number(m[1]), txt); } }); s.on('error', fail); };
    attach(sock);
    const read = () => new Promise((ok) => { waiter = (code, txt) => ok({ code, txt }); });
    const cmd = async (line, expect) => { if (line != null) sock.write(line + '\r\n'); const r = await read(); if (!expect.includes(r.code)) throw new Error(`SMTP ${r.code} : ${r.txt.trim().slice(0, 160)}`); return r; };
    (async () => {
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO clientdirect.pro', [250]);
      if (!secure && /STARTTLS/i.test(ehlo.txt)) {
        await cmd('STARTTLS', [220]);
        sock.removeAllListeners('data'); sock = tls.connect({ socket: sock, servername: host }); attach(sock);
        await new Promise((ok) => sock.once('secureConnect', ok));
        ehlo = await cmd('EHLO clientdirect.pro', [250]);
      }
      if (user) { await cmd('AUTH LOGIN', [334]); await cmd(b64(user), [334]); await cmd(b64(pass), [235]); }
      await cmd(`MAIL FROM:<${from}>`, [250]); await cmd(`RCPT TO:<${to}>`, [250, 251]); await cmd('DATA', [354]);
      const r = await cmd(data.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
      try { sock.write('QUIT\r\n'); } catch { /* sans importance */ }
      clearTimeout(timer); done = true; sock.end(); resolve(r.txt.trim());
    })().catch((e) => { clearTimeout(timer); fail(e); });
  });
}
