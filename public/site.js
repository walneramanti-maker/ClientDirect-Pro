// Script des sites clients : créneaux libres, réservation, devis, assistant.
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let I18N = {}; try { I18N = JSON.parse(($('i18n') || {}).textContent || '{}'); } catch (e) { /* textes par défaut */ }
  const T = (k) => I18N[k] || k;
  const LANG = document.documentElement.lang || 'fr';
  async function call(url, body) {
    const opt = body ? { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) } : { headers: { accept: 'application/json' } };
    const r = await fetch(url, opt); let j = {}; try { j = await r.json(); } catch (e) { /* vide */ }
    return { status: r.status, ...j };
  }
  const fmt = (h) => { const [a, b] = h.split(':').map(Number); if (LANG === 'fr') return a + 'h' + (b ? String(b).padStart(2, '0') : ''); return ((a + 11) % 12 + 1) + ':' + String(b).padStart(2, '0') + ' ' + (a < 12 ? 'AM' : 'PM'); };

  // ----- réservation -----
  const book = $('book');
  if (book) {
    const base = book.dataset.base; let day = null, time = null;
    const slotsBox = $('b-slots'), err = $('b-err'), ok = $('b-ok'), svc = $('b-svc');
    const chips = () => Array.from($('b-days').querySelectorAll('.chip'));
    async function loadSlots() {
      time = null; slotsBox.innerHTML = '<p class="muted">' + T('Chargement…') + '</p>';
      if (!day) { slotsBox.innerHTML = '<p class="muted">' + T('Aucun jour disponible.') + '</p>'; return; }
      const r = await call(`${base}/creneaux?service=${encodeURIComponent(svc.value)}&date=${day}`);
      const list = r.slots || [];
      slotsBox.innerHTML = list.length ? '' : '<p class="muted">' + T('Plus de créneau libre ce jour-là. Choisissez un autre jour.') + '</p>';
      for (const s of list) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip'; b.textContent = fmt(s); b.dataset.t = s; b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', () => { time = s; slotsBox.querySelectorAll('.chip').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
        slotsBox.appendChild(b);
      }
    }
    function selectDay(btn) { day = btn ? btn.dataset.d : null; chips().forEach((x) => x.setAttribute('aria-pressed', String(x === btn))); loadSlots(); }
    chips().forEach((b) => b.addEventListener('click', () => selectDay(b)));
    svc.addEventListener('change', () => loadSlots());
    selectDay(chips()[0] || null);
    book.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; ok.textContent = '';
      if (!time) { err.textContent = T('Choisissez une heure.'); return; }
      const btn = book.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await call(`${base}/rdv`, { date: day, time, serviceId: svc.value, name: $('b-name').value, phone: $('b-phone').value, cc: $('b-cc') ? $('b-cc').value : '', email: $('b-email').value });
        if (r.ok) { ok.className = r.demo ? 'note' : 'success'; ok.textContent = r.msg; if (!r.demo) { book.reset(); } loadSlots(); }
        else { err.textContent = r.msg || T('Réservation impossible, réessayez.'); if (r.code === 'taken') loadSlots(); }
      } catch (x) { err.textContent = T('Connexion impossible. Vérifiez votre réseau et réessayez.'); }
      btn.disabled = false;
    });
  }

  // ----- devis -----
  const quote = $('quote');
  if (quote) {
    quote.addEventListener('submit', async (e) => {
      e.preventDefault(); const err = $('q-err'), ok = $('q-ok'); err.textContent = ''; ok.textContent = '';
      const btn = quote.querySelector('button[type=submit]'); btn.disabled = true;
      try {
        const r = await call(`${quote.dataset.base}/devis`, { name: $('q-name').value, phone: $('q-phone').value, cc: $('q-cc') ? $('q-cc').value : '', email: $('q-email').value, obj: $('q-obj').value, service: $('q-svc').value, message: $('q-msg').value });
        if (r.ok) { ok.className = r.demo ? 'note' : 'success'; ok.textContent = r.msg; if (!r.demo) quote.reset(); } else err.textContent = r.msg || T('Envoi impossible, réessayez.');
      } catch (x) { err.textContent = T('Connexion impossible. Vérifiez votre réseau et réessayez.'); }
      btn.disabled = false;
    });
  }

  // ----- assistant -----
  const chat = $('chat');
  if (chat) {
    let conv = ''; try { conv = sessionStorage.getItem('cdp_conv') || ''; } catch (e) { /* stockage indisponible */ }
    if (!conv) { conv = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 36); try { sessionStorage.setItem('cdp_conv', conv); } catch (e) { /* idem */ } }
    const msgs = $('msgs'), input = $('q');
    const add = (text, who) => { const d = document.createElement('div'); d.className = 'm' + (who === 'me' ? ' me' : ''); d.textContent = text; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
    $('ask').addEventListener('submit', async (e) => {
      e.preventDefault(); const q = input.value.trim(); if (!q) return; input.value = ''; add(q, 'me');
      const wait = add('…');
      try { const r = await call(`${chat.dataset.base}/chat`, { q, conv }); wait.textContent = r.text || r.msg || T('Je n’ai pas compris, reformulez votre question.'); if (r.text && /réserv|confirm/i.test(r.text) && book) { const ev = new Event('change'); $('b-svc').dispatchEvent(ev); } }
      catch (x) { wait.textContent = T('Connexion impossible. Réessayez.'); }
    });
  }
})();
// Clavier du téléphone ouvert : retirer la barre d'actions flottante pour ne jamais masquer le champ en cours de saisie
(function () {
  var f = function (on) { return function (e) { if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) document.body.classList.toggle('typing', on); }; };
  document.addEventListener('focusin', f(true)); document.addEventListener('focusout', f(false));
})();
// La barre d'actions ne s'affiche que lorsqu'aucun formulaire n'est à l'écran : elle ne recouvre jamais un bouton d'envoi
(function () {
  var bar = document.querySelector('.mbar'); if (!bar || !('IntersectionObserver' in window)) return;
  var seen = new Set();
  var io = new IntersectionObserver(function (list) { list.forEach(function (e) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }); document.body.classList.toggle('form-on-screen', seen.size > 0); }, { threshold: 0 });
  ['rdv', 'devis', 'chat'].forEach(function (id) { var el = document.getElementById(id); if (el) io.observe(el); });
})();
