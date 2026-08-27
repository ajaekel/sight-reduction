/**
 * fixStorage.js
 * Persists Fixes: named collections of saved-sighting IDs, representing a
 * position derived from multiple LOPs (a 3-star fix, a running fix, etc.).
 * A Fix references Sightings by id (SightStorage) rather than duplicating
 * their data -- a sighting reduced and saved once can belong to any number
 * of Fixes with no re-entry.
 *
 * Same Promise-based localStorage pattern as storage.js and almanacCache.js.
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:fix:';
  var INDEX_KEY = 'ocsr:fix:index';

  function readIndex() {
    try {
      return JSON.parse(localStorage.getItem(INDEX_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeIndex(idx) {
    localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
  }

  function uid() {
    return 'fix_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** Save (create or overwrite) a fix. Mutates fix.id/savedAt if new. */
  function save(fix) {
    return new Promise(function (resolve, reject) {
      try {
        if (!fix.id) fix.id = uid();
        if (!Array.isArray(fix.sightingIds)) fix.sightingIds = [];
        fix.savedAt = new Date().toISOString();

        localStorage.setItem(PREFIX + fix.id, JSON.stringify(fix));

        var idx = readIndex().filter(function (e) { return e.id !== fix.id; });
        idx.unshift({
          id: fix.id,
          name: fix.name || 'Untitled Fix',
          savedAt: fix.savedAt,
          sightingCount: fix.sightingIds.length
        });
        writeIndex(idx);

        resolve(fix);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List fixes (lightweight index entries only), most recently saved first. */
  function list() {
    return Promise.resolve(readIndex());
  }

  /** Load a full fix record by id. Resolves null if not found. */
  function get(id) {
    return new Promise(function (resolve, reject) {
      try {
        var raw = localStorage.getItem(PREFIX + id);
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        reject(e);
      }
    });
  }

  function remove(id) {
    return new Promise(function (resolve) {
      localStorage.removeItem(PREFIX + id);
      writeIndex(readIndex().filter(function (e) { return e.id !== id; }));
      resolve();
    });
  }

  global.FixStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove
  };
})(window);
