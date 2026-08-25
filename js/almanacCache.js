/**
 * almanacCache.js
 * Persists fetched USNO almanac data (GHA/Dec per celestial object) keyed by
 * UTC date+hour, so a range fetched once while online can drive both the
 * single-sight "Fetch from USNO" autofill AND future sights fully offline.
 *
 * Same Promise-based localStorage pattern as storage.js, kept as its own
 * module/key namespace since this cache has different lifecycle semantics
 * (bulk-populated, safe to clear/regenerate anytime, not "your data" the
 * way saved sights are).
 *
 * Each cached hour stores a normalized object map (see usno.js's
 * normalizeUsnoData): { [lowercaseName]: { name, gha, dec } }.
 * GHA/Dec are geocentric almanac values -- the same for every observer on
 * Earth at a given instant (exactly how a printed Nautical Almanac works),
 * so a cached hour is reusable regardless of which AP a later sight uses.
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:almanac:';
  var INDEX_KEY = 'ocsr:almanac:index';

  function pad2(n) { return String(n).padStart(2, '0'); }

  /** e.g. "2026-06-02T14" -- one entry per UTC hour. */
  function hourKey(utcDate) {
    return utcDate.getUTCFullYear() + '-' + pad2(utcDate.getUTCMonth() + 1) + '-' +
           pad2(utcDate.getUTCDate()) + 'T' + pad2(utcDate.getUTCHours());
  }

  function readIndex() {
    try {
      return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeIndex(keys) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(keys));
  }

  function setHour(utcDate, objectsMap) {
    return new Promise(function (resolve, reject) {
      try {
        var key = hourKey(utcDate);
        localStorage.setItem(PREFIX + key, JSON.stringify(objectsMap));
        var idx = readIndex();
        if (idx.indexOf(key) === -1) {
          idx.push(key);
          idx.sort();
          writeIndex(idx);
        }
        resolve(key);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** Resolves the cached objects map for that UTC hour, or null if not cached. */
  function getHour(utcDate) {
    return new Promise(function (resolve, reject) {
      try {
        var raw = localStorage.getItem(PREFIX + hourKey(utcDate));
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** { count, first, last, approxBytes } describing what's currently cached. */
  function summary() {
    return new Promise(function (resolve) {
      var idx = readIndex();
      if (!idx.length) {
        resolve({ count: 0, first: null, last: null, approxBytes: 0 });
        return;
      }
      var approxBytes = 0;
      idx.forEach(function (key) {
        var raw = localStorage.getItem(PREFIX + key);
        if (raw) approxBytes += raw.length;
      });
      resolve({ count: idx.length, first: idx[0], last: idx[idx.length - 1], approxBytes: approxBytes });
    });
  }

  function clearAll() {
    return new Promise(function (resolve) {
      var idx = readIndex();
      idx.forEach(function (key) { localStorage.removeItem(PREFIX + key); });
      localStorage.removeItem(INDEX_KEY);
      resolve();
    });
  }

  global.AlmanacCache = {
    hourKey: hourKey,
    setHour: setHour,
    getHour: getHour,
    summary: summary,
    clearAll: clearAll
  };
})(window);
