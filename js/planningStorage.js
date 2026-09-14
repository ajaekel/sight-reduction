/**
 * planningStorage.js
 * Persistence for the Planning page, kept separate from planning.js the same
 * way storage.js/fixStorage.js are kept separate from app.js/fixes.js.
 *
 * Two different lifetimes, deliberately:
 *  - Form fields (date/TZ/AP, ref latitudes, manual LMT entries, mode) go in
 *    localStorage. This is real work the user typed in from a printed
 *    almanac; it should survive navigating away, closing the tab, even
 *    restarting the browser, same as a saved sighting would.
 *  - The auto-fill result (one USNO fetch) goes in sessionStorage, per the
 *    "at least for the session" ask. It's just a cached network response,
 *    cheap to re-fetch, and not meant to be a substitute for the real batch
 *    almanac cache planned for later.
 */
(function (global) {
  'use strict';

  var FORM_KEY = 'ocsr:planning:form';
  var RSTT_CACHE_KEY = 'ocsr:planning:rsttCache';

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

  /** entry: { date, lat, lon, tz, result } -- result is whatever SightUsno.fetchRiseSetTransit resolved. */
  function saveRsttCache(entry) {
    try {
      sessionStorage.setItem(RSTT_CACHE_KEY, JSON.stringify(entry));
    } catch (e) {}
  }

  function loadRsttCache() {
    try {
      var raw = sessionStorage.getItem(RSTT_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  global.PlanningStorage = {
    saveForm: saveForm,
    loadForm: loadForm,
    saveRsttCache: saveRsttCache,
    loadRsttCache: loadRsttCache
  };
})(window);
