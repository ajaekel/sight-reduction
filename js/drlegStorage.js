/**
 * drlegStorage.js
 * Persistence for the DR Leg page, kept separate from drleg.js the same way
 * storage.js/planningStorage.js are kept separate from their pages. DR Leg
 * has no saved-records list (like Planning, it's a calculator, not a
 * collection) -- this just remembers the form across navigation, same
 * durability rationale as Planning's form fields: real typed-in work that
 * should survive closing the tab, not just a same-tab navigation.
 */
(function (global) {
  'use strict';

  var FORM_KEY = 'ocsr:drleg:form';

  function saveForm(data) {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(data));
    } catch (e) {
      // Storage full/unavailable (e.g. private browsing) -- fields just won't persist this time.
    }
  }

  function loadForm() {
    try {
      var raw = localStorage.getItem(FORM_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  global.DrLegStorage = {
    saveForm: saveForm,
    loadForm: loadForm
  };
})(window);
