// Administration : lignes cliquables et indicateurs actualisés toutes les 60 secondes (aucune donnée envoyée).
(function () {
  document.addEventListener('click', function (e) {
    var tr = e.target.closest && e.target.closest('tr.go[data-href]');
    if (!tr || e.target.closest('a,button,input,select,label')) return;
    if (e.metaKey || e.ctrlKey) window.open(tr.getAttribute('data-href'), '_blank'); else location.href = tr.getAttribute('data-href');
  });
  var live = document.querySelector('[data-live]'); if (!live) return;
  var eur = function (n) { var v = Math.round(Number(n || 0) * 100) / 100; return v.toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).replace(/ /g, ' ') + ' €'; };
  var set = function (k, v) { var c = document.querySelector('.kc[data-k="' + k + '"] strong'); if (c && c.textContent !== v) { c.textContent = v; c.parentNode.classList.add('flash-up'); setTimeout(function () { c.parentNode.classList.remove('flash-up'); }, 1200); } };
  function tick() {
    if (document.hidden) return;
    fetch(live.getAttribute('data-live'), { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      if (!d) return;
      set('active', String(d.active)); set('trial', String(d.trial)); set('mrr', eur(d.mrr)); set('revenue', eur(d.revenue)); set('expenses', eur(d.expenses)); set('result', eur(d.result));
      ['prospects', 'pastDue', 'signupsMonth', 'incidents', 'tickets'].forEach(function (k) { var m = document.querySelector('.mk[data-k="' + k + '"]'); if (!m || d[k] == null) return; var st = m.querySelector('strong'); if (st.textContent !== String(d[k])) { st.textContent = d[k]; m.classList.add('flash-up'); setTimeout(function () { m.classList.remove('flash-up'); }, 1200); } m.classList.toggle('has', d[k] > 0); if (k === 'pastDue') m.classList.toggle('warn', d[k] > 0); });
      var rc = document.querySelector('.kc[data-k="result"]'); if (rc) { rc.classList.toggle('c-neg', d.result < 0); rc.classList.toggle('c-pos', d.result >= 0); var l = rc.querySelector('.kl'); if (l) l.textContent = d.result < 0 ? 'Perte du mois' : 'Bénéfice du mois'; }
      (d.byPlan || []).forEach(function (p) { var el = document.querySelector('[data-plan="' + p.plan + '"]'); if (!el) return; el.querySelector('[data-p="payants"]').textContent = p.payants; el.querySelector('[data-p="essais"]').textContent = p.essais; el.querySelector('[data-p="mrr"]').textContent = eur(p.payants * p.monthly); });
      var at = live.querySelector('[data-k="at"]'); if (at) at.textContent = new Date(d.at).toLocaleTimeString('fr-FR', { timeZone: 'America/Cayenne', hour: '2-digit', minute: '2-digit' });
      var b = document.querySelector('.bell'); if (b) { var n = b.querySelector('b'); if (d.alerts && !n) { n = document.createElement('b'); b.appendChild(n); } if (n) { if (d.alerts) n.textContent = d.alerts; else n.remove(); } }
    }).catch(function () {});
  }
  setInterval(tick, 60000); document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
// Effet de pression au toucher (iPhone, Android) : classe ajoutée dès l'appui, retirée au relâchement.
(function () {
  var SEL = '.glass, .qa a, .chip, .tab, .btn, .more, .side nav a, .mnav nav a, a.cnt';
  var cur = null;
  var up = function () { if (cur) { cur.classList.remove('pressed'); cur = null; } };
  document.addEventListener('pointerdown', function (e) { var el = e.target.closest && e.target.closest(SEL); if (!el) return; cur = el; el.classList.add('pressed'); }, { passive: true });
  ['pointerup', 'pointercancel', 'pointerleave', 'dragstart', 'scroll'].forEach(function (t) { document.addEventListener(t, up, { passive: true, capture: true }); });
  document.addEventListener('touchstart', function () {}, { passive: true }); // active :active sur Safari iOS
})();
// Tableaux sur téléphone : chaque ligne devient une carte lisible (libellé de colonne au-dessus de chaque valeur)
(function () {
  Array.prototype.forEach.call(document.querySelectorAll('.admbody table.list:not(.cards)'), function (t) {
    var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
    if (!heads.length) return;
    Array.prototype.forEach.call(t.querySelectorAll('tbody tr'), function (tr) {
      Array.prototype.forEach.call(tr.children, function (td, i) { if (!td.hasAttribute('data-l') && heads[i]) td.setAttribute('data-l', heads[i]); });
    });
    t.classList.add('cards');
  });
})();
// Bénéfices, marges et résultats : vert si positifs, rouge si négatifs (tableaux et chiffres clés de toutes les pages)
(function () {
  var RE = /b[ée]n[ée]fice|marge|r[ée]sultat/i;
  var tone = function (el, txt) { var v = parseFloat(String(txt).replace(/\s| | |€/g, '').replace(',', '.')); if (isNaN(v) || v === 0) return; el.classList.add(v < 0 ? 'neg' : 'pos'); };
  Array.prototype.forEach.call(document.querySelectorAll('.admbody td[data-l]'), function (td) { if (RE.test(td.getAttribute('data-l'))) tone(td, td.textContent); });
  Array.prototype.forEach.call(document.querySelectorAll('.admbody .kpis .k'), function (k) { var s = k.querySelector('span'), n = k.querySelector('strong'); if (s && n && RE.test(s.textContent)) tone(n, n.textContent); });
})();
