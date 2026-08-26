/**
 * nav.js
 * Small shared hamburger-menu behavior for the top nav (#btnMenu / #appMenu),
 * identical on index.html and fixes.html. Deliberately has no app-specific
 * logic -- just open/close/outside-click/Escape and marking the current page.
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    var btn = document.getElementById('btnMenu');
    var menu = document.getElementById('appMenu');
    if (!btn || !menu) return;

    function closeMenu() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
    function openMenu() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }

    btn.addEventListener('click', function (evt) {
      evt.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });
    document.addEventListener('click', function (evt) {
      if (!menu.hidden && !menu.contains(evt.target) && evt.target !== btn) closeMenu();
    });
    document.addEventListener('keydown', function (evt) {
      if (evt.key === 'Escape') closeMenu();
    });

    // Mark the current page's link so an open menu shows where you are.
    var here = (location.pathname.split('/').pop() || 'index.html');
    Array.prototype.forEach.call(menu.querySelectorAll('.app-menu-item'), function (a) {
      var target = a.getAttribute('href').split('#')[0] || 'index.html';
      if (target === here) a.setAttribute('aria-current', 'page');
    });
  });
})();
