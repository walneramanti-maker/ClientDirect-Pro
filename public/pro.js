// Espace pro sur téléphone : Rendez-vous / Devis en onglets, demandes compactes dépliables au toucher.
(function () {
  var phone = window.matchMedia('(max-width: 699px)');
  // 1. Onglets segmentés au-dessus des deux listes
  var wrap = document.querySelector('.seg-panels');
  if (wrap) {
    var panels = Array.prototype.slice.call(wrap.querySelectorAll('[data-seg]'));
    var seg = document.createElement('div'); seg.className = 'segctl'; seg.setAttribute('role', 'tablist');
    var show = function (i) { panels.forEach(function (p, k) { p.classList.toggle('seg-off', k !== i); seg.children[k].setAttribute('aria-selected', k === i ? 'true' : 'false'); }); try { sessionStorage.setItem('cdp_seg', String(i)); } catch (e) { /* stockage indisponible */ } };
    panels.forEach(function (p, i) { var b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'tab'); b.textContent = p.getAttribute('data-seg'); b.addEventListener('click', function () { show(i); }); seg.appendChild(b); });
    wrap.parentNode.insertBefore(seg, wrap);
    var start = 0; try { start = Number(sessionStorage.getItem('cdp_seg') || 0) || 0; } catch (e) { start = 0; }
    show(start < panels.length ? start : 0);
  }
  // 2. Demandes compactes : un toucher sur l'en-tête affiche coordonnées, message et toutes les actions
  document.addEventListener('click', function (e) {
    if (!phone.matches) return;
    var rh = e.target.closest && e.target.closest('.req .rh'); if (!rh || e.target.closest('a,button,input,select')) return;
    var r = rh.parentNode; r.classList.toggle('open'); rh.setAttribute('aria-expanded', r.classList.contains('open') ? 'true' : 'false');
  });
  Array.prototype.forEach.call(document.querySelectorAll('.req .rh'), function (rh) { rh.setAttribute('role', 'button'); rh.setAttribute('tabindex', '0'); rh.setAttribute('aria-expanded', 'false'); });
  // 3. Effet de pression au toucher
  document.addEventListener('touchstart', function () {}, { passive: true });
})();
