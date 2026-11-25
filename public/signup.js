// Inscription : fuseau horaire et pays détectés automatiquement depuis l'appareil.
(function () {
  'use strict';
  var tz = ''; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ancien navigateur */ }
  var f = document.getElementById('tz'); if (f && !f.value) f.value = tz;
  // Pays déduit du fuseau quand le navigateur ne l'indique pas clairement
  var map = { 'America/Cayenne': 'GF', 'America/Martinique': 'MQ', 'America/Guadeloupe': 'GP', 'Indian/Reunion': 'RE', 'Indian/Mayotte': 'YT', 'Europe/Paris': 'FR', 'Europe/Brussels': 'BE', 'Europe/Zurich': 'CH', 'Europe/Luxembourg': 'LU', 'Europe/London': 'GB', 'Europe/Dublin': 'IE', 'America/Toronto': 'CA', 'America/Montreal': 'CA', 'America/Vancouver': 'CA', 'America/Edmonton': 'CA', 'America/Halifax': 'CA', 'America/Winnipeg': 'CA', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US', 'America/Los_Angeles': 'US', 'America/Phoenix': 'US', 'Pacific/Honolulu': 'US', 'America/Anchorage': 'US', 'Australia/Sydney': 'AU', 'Australia/Melbourne': 'AU', 'Australia/Brisbane': 'AU', 'Australia/Perth': 'AU', 'Pacific/Auckland': 'NZ', 'Pacific/Noumea': 'NC', 'Pacific/Tahiti': 'PF', 'America/Paramaribo': 'SR', 'America/Port-au-Prince': 'HT', 'Africa/Dakar': 'SN', 'Africa/Abidjan': 'CI', 'Africa/Casablanca': 'MA', 'Europe/Berlin': 'DE', 'Europe/Madrid': 'ES', 'Europe/Rome': 'IT', 'Europe/Lisbon': 'PT', 'Europe/Amsterdam': 'NL', 'Europe/Monaco': 'MC', 'America/Sao_Paulo': 'BR' };
  var c = document.getElementById('country');
  if (c && map[tz] && !c.dataset.touched && !/[?&]pays=/.test(location.search)) {
    var guessed = map[tz]; var cur = c.value;
    // On ne remplace que l'estimation par défaut faite par le serveur
    if (cur !== guessed && (cur === 'FR' || cur === 'US')) c.value = guessed;
  }
  if (c) c.addEventListener('change', function () { c.dataset.touched = '1'; });
})();
