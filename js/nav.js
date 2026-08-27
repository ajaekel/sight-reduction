/**
 * nav.js
 * Toggle behavior for the hamburger menu (#btnNavMenu / #navMenu), shared
 * across every page (index.html, fixes.html). Each page supplies its own
 * markup with those same ids; this file only owns open/close behavior.
 */
(function () {
  'use strict';

  function initNavMenu() {
    var btn = document.getElementById('btnNavMenu');
    var menu = document.getElementById('navMenu');
    if (!btn || !menu) return;

    function close() {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    }

    function toggle() {
      var willOpen = !menu.classList.contains('open');
      menu.classList.toggle('open', willOpen);
      btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      toggle();
    });

    document.addEventListener('click', function (e) {
      if (!menu.contains(e.target) && e.target !== btn) close();
    });

    menu.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') close();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') close();
    });
  }

  window.initNavMenu = initNavMenu;
})();
