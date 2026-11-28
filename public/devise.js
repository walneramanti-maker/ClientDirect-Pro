// Devise d'après le fuseau horaire de l'appareil (plus fiable que la langue : un téléphone de Guyane réglé en anglais
// doit voir des euros). Une seule correction par visite ; un choix explicite (?devise= ou ?pays=) est toujours respecté.
(function () {
  var s = document.getElementById('formules'); if (!s) return;
  var q = new URLSearchParams(location.search); if (q.has('devise') || q.has('pays') || /(^|; )pays=/.test(document.cookie)) return;
  var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return; }
  var EUR = { 'America/Cayenne': 'GF', 'Europe/Paris': 'FR', 'America/Martinique': 'MQ', 'America/Guadeloupe': 'GP', 'Indian/Reunion': 'RE', 'Indian/Mayotte': 'YT', 'Europe/Brussels': 'BE', 'Europe/Luxembourg': 'LU', 'Europe/Monaco': 'MC' };
  var pays = EUR[tz]; if (!pays || s.getAttribute('data-cur') === 'EUR') return;
  try { if (sessionStorage.getItem('cdp_devise')) return; sessionStorage.setItem('cdp_devise', '1'); } catch (e) { /* stockage indisponible : on corrige quand même une fois */ }
  q.set('pays', pays); location.replace(location.pathname + '?' + q.toString() + location.hash);
})();
// Téléphone : le carrousel des formules s'ouvre sur la formule recommandée
(function () {
  if (!window.matchMedia('(max-width: 699px)').matches) return;
  var row = document.querySelector('.plans'), best = row && row.querySelector('.plan.best'); if (!best) return;
  row.scrollLeft = best.offsetLeft - (row.clientWidth - best.clientWidth) / 2;
})();
// Accueil sur téléphone : sections secondaires repliées derrière un bouton, bouton d'inscription fixe
(function () {
  var mq = window.matchMedia && window.matchMedia('(max-width:640px)');
  document.querySelectorAll('.m-fold[data-fold]').forEach(function (sec) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'fold-sum'; b.textContent = sec.getAttribute('data-fold');
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', function () { var o = sec.classList.toggle('open'); b.setAttribute('aria-expanded', o ? 'true' : 'false'); });
    sec.insertBefore(b, sec.firstChild);
    if (location.hash && sec.id && location.hash === '#' + sec.id) sec.classList.add('open');
  });
  document.querySelectorAll('a[href^="#"]').forEach(function (a) {
    a.addEventListener('click', function () { var t = document.querySelector(a.getAttribute('href')); if (t && t.classList.contains('m-fold')) { t.classList.add('open'); var b = t.querySelector('.fold-sum'); if (b) b.setAttribute('aria-expanded', 'true'); } });
  });
  // Le bouton fixe se cache quand un autre bouton d'inscription est déjà à l'écran (pas de doublon)
  var sticky = document.querySelector('.sticky-cta'); if (!sticky || !('IntersectionObserver' in window) || !mq || !mq.matches) return;
  var seen = new Set();
  var io = new IntersectionObserver(function (es) { es.forEach(function (e) { if (e.isIntersecting) seen.add(e.target); else seen.delete(e.target); }); sticky.classList.toggle('hide', seen.size > 0); });
  document.querySelectorAll('.hero-mk .cta .btn.blue, .cta-band .btn.blue').forEach(function (el) { io.observe(el); });
})();

