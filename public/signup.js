// Inscription : fuseau horaire et pays détectés automatiquement depuis l'appareil.
// Le serveur distingue la proposition (champ country_guess) du choix de l'utilisateur : tout pays modifié à la main
// est respecté. L'indicatif téléphonique suit le pays tant que l'utilisateur ne l'a pas changé lui-même.
(function () {
  'use strict';
  var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ancien navigateur */ }
  var f = document.getElementById('tz'); if (f && !f.value) f.value = tz;
  // Pays déduit du fuseau quand le navigateur ne l'indique pas clairement
  var map = { 'America/Cayenne': 'GF', 'America/Martinique': 'MQ', 'America/Guadeloupe': 'GP', 'America/Marigot': 'GP', 'America/St_Barthelemy': 'GP', 'Indian/Reunion': 'RE', 'Indian/Mayotte': 'YT', 'Europe/Paris': 'FR', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Luxembourg': 'LU', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'America/Toronto': 'CA', 'America/Montreal': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Halifax': 'CA', 'America/Winnipeg': 'CA', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'Pacific/Honolulu': 'US', 'America/Anchorage': 'US', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ', 'Pacific/Noumea': 'NC', 'Pacific/Tahiti': 'PF', 'America/Paramaribo': 'SR', 'America/Port-au-Prince': 'HT', 'Africa/Dakar': 'SN', 'Africa/Abidjan': 'CI', 'Africa/Casablanca': 'MA', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Lisbon': 'PT', 'Europe/Amsterdam': 'NL', 'Europe/Monaco': 'MC', 'America/Sao_Paulo': 'BR' };
  var c = document.getElementById('country'); var guess = document.getElementById('country_guess'); var cc = document.getElementById('phone_cc');
  var dials = {}; try { dials = JSON.parse((c && c.getAttribute('data-dials')) || '{}'); } catch (e) { /* attribut absent */ }
  var dialOf = function (code) { return dials[code] || ''; };
  var syncCc = function () { if (!cc || cc.dataset.touched) return; var d = dialOf(c.value); if (d && cc.querySelector('option[value="' + d + '"]')) cc.value = d; };
  if (c && map[tz] && !c.dataset.touched && !/[?&]pays=/.test(location.search)) {
    var guessed = map[tz]; var cur = c.value;
    // On ne remplace que l'estimation par défaut faite par le serveur, et on garde trace de la nouvelle proposition
    if (cur !== guessed && (!guess || cur === guess.value)) { c.value = guessed; if (guess) guess.value = guessed; syncCc(); }
  }
  var set = document.getElementById('country_set');
  if (c) c.addEventListener('change', function () { c.dataset.touched = '1'; if (set) set.value = '1'; syncCc(); });
  if (cc) cc.addEventListener('change', function () { cc.dataset.touched = '1'; });
})();
// Recherche d'activité : suggestions au fil de la frappe ; « Autre activité » si rien ne correspond.
(function () {
  'use strict';
  var sel = document.getElementById('activity'); var q = document.getElementById('activity_search'); var ul = document.getElementById('activity_results');
  var other = document.getElementById('activity_other'); var wrap = document.getElementById('other_wrap');
  if (!sel || !q || !ul) return;
  var fold = function (s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  var items = Array.prototype.map.call(sel.querySelectorAll('option[value]'), function (o) { return { v: o.value, l: o.textContent, g: o.parentNode.label || '', h: fold(o.textContent + ' ' + (o.getAttribute('data-kw') || '') + ' ' + (o.parentNode.label || '')) }; }).filter(function (x) { return x.v && x.v !== 'autre'; });
  var toggle = function () { var on = sel.value === 'autre'; wrap.hidden = !on; if (other) other.required = on; };
  q.hidden = false; toggle();
  var pick = function (v, text) { sel.value = v; if (v === 'autre' && other) { other.value = text || other.value; } ul.hidden = true; ul.innerHTML = ''; q.value = v === 'autre' ? '' : (sel.options[sel.selectedIndex] || {}).textContent || ''; toggle(); if (v === 'autre' && other) other.focus(); };
  q.addEventListener('input', function () {
    var words = fold(q.value).split(/\s+/).filter(function (w) { return w.length >= 2; });
    ul.innerHTML = '';
    if (!words.length) { ul.hidden = true; return; }
    var res = items.filter(function (x) { return words.every(function (w) { return x.h.indexOf(w) >= 0 || x.h.indexOf(w.slice(0, Math.max(3, w.length - 2))) >= 0; }); }).slice(0, 8);
    res.forEach(function (x) { var li = document.createElement('li'); li.setAttribute('role', 'option'); li.tabIndex = 0; li.dataset.key = x.v; li.innerHTML = '<b></b><span></span>'; li.firstChild.textContent = x.l; li.lastChild.textContent = x.g; li.addEventListener('click', function () { pick(x.v); }); li.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick(x.v); } }); ul.appendChild(li); });
    var li = document.createElement('li'); li.className = 'act-other'; li.dataset.key = 'autre'; li.tabIndex = 0; li.textContent = 'Autre activité : « ' + q.value.trim() + ' »'; li.addEventListener('click', function () { pick('autre', q.value.trim()); }); li.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); pick('autre', q.value.trim()); } }); ul.appendChild(li);
    ul.hidden = false;
  });
  q.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown' && ul.firstChild) { e.preventDefault(); ul.firstChild.focus(); } });
  sel.addEventListener('change', function () { toggle(); q.value = sel.value && sel.value !== 'autre' ? sel.options[sel.selectedIndex].textContent : ''; });
})();
