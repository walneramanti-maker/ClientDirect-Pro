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
