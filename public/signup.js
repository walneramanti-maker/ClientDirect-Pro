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
