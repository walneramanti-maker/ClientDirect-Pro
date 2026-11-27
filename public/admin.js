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
      var rc = document.querySelector('.kc[data-k="result"]'); if (rc) { rc.classList.toggle('c-neg', d.result < 0); rc.classList.toggle('c-pos', d.result >= 0); var l = rc.querySelector('.kl'); if (l) l.textContent = d.result < 0 ? 'Perte du mois' : 'Bénéfice du mois'; }
      (d.byPlan || []).forEach(function (p) { var el = document.querySelector('[data-plan="' + p.plan + '"]'); if (!el) return; el.querySelector('[data-p="payants"]').textContent = p.payants; el.querySelector('[data-p="essais"]').textContent = p.essais; el.querySelector('[data-p="mrr"]').textContent = eur(p.payants * p.monthly); });
      var at = live.querySelector('[data-k="at"]'); if (at) at.textContent = new Date(d.at).toLocaleTimeString('fr-FR', { timeZone: 'America/Cayenne', hour: '2-digit', minute: '2-digit' });
      var b = document.querySelector('.bell'); if (b) { var n = b.querySelector('b'); if (d.alerts && !n) { n = document.createElement('b'); b.appendChild(n); } if (n) { if (d.alerts) n.textContent = d.alerts; else n.remove(); } }
    }).catch(function () {});
  }
  setInterval(tick, 60000); document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
})();
