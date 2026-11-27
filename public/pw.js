// Bouton « œil » : afficher ou masquer le mot de passe saisi (rien n'est envoyé ni enregistré).
(function () {
  var fr = (document.documentElement.lang || 'fr').indexOf('en') !== 0;
  var L = fr ? { show: 'Afficher le mot de passe', hide: 'Masquer le mot de passe' } : { show: 'Show password', hide: 'Hide password' };
  var eye = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var off = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  Array.prototype.forEach.call(document.querySelectorAll('input[type="password"]'), function (inp) {
    var wrap = document.createElement('span'); wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp); wrap.appendChild(inp);
    var b = document.createElement('button'); b.type = 'button'; b.className = 'pw-eye'; b.setAttribute('aria-label', L.show); b.setAttribute('aria-pressed', 'false'); b.innerHTML = eye;
    b.addEventListener('click', function () {
      var shown = inp.type === 'text'; inp.type = shown ? 'password' : 'text';
      b.innerHTML = shown ? eye : off; b.setAttribute('aria-label', shown ? L.show : L.hide); b.setAttribute('aria-pressed', String(!shown)); inp.focus();
    });
    // Par sécurité, le mot de passe est toujours remasqué à l'envoi du formulaire
    if (inp.form) inp.form.addEventListener('submit', function () { inp.type = 'password'; });
    wrap.appendChild(b);
  });
})();
