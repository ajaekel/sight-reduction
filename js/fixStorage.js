/**
 * fixStorage.js
 * Persists Fix records locally on the device, mirroring storage.js's shape:
 * a lightweight index (for list rendering) plus full records behind
 * ocsr:fix:<id>.
 *
 * A Fix = { id, name, createdAt, sightingIds: [...] }. It does NOT duplicate
 * sighting data -- it only stores ids and looks the full records up via
 * SightStorage.get() when needed (editing, plotting). That means deleting a
 * sighting elsewhere can silently orphan a reference here; app.js is
 * responsible for calling findFixesContaining() before it lets a sighting be
 * deleted, so this file never has to reach into SightStorage itself.
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:fix:';
  var INDEX_KEY = 'ocsr:fixIndex';

  // Assigned by position in a fix's own sightingIds array (see colorForIndex),
  // so a sighting's color stays stable as other sightings are added/removed.
  var COLORS = ['#4fc3f7', '#ff8a65', '#aed581', '#ba68c8', '#ffd54f', '#4db6ac', '#f06292', '#90a4ae'];

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

  /** Save (create or overwrite) a fix. Mutates fix.id/createdAt if new. */
  function save(fix) {
    return new Promise(function (resolve, reject) {
      try {
        if (!fix.id) {
          fix.id = uid();
          fix.createdAt = new Date().toISOString();
        }
        fix.sightingIds = fix.sightingIds || [];

        localStorage.setItem(PREFIX + fix.id, JSON.stringify(fix));

        var idx = readIndex().filter(function (e) { return e.id !== fix.id; });
        idx.unshift({
          id: fix.id,
          name: fix.name || 'Untitled fix',
          createdAt: fix.createdAt,
          count: fix.sightingIds.length
        });
        writeIndex(idx);

        resolve(fix);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List fixes (lightweight index entries only), most recent first. */
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

  /** Delete a fix by id. Does not touch the sightings it referenced. */
  function remove(id) {
    return new Promise(function (resolve) {
      localStorage.removeItem(PREFIX + id);
      writeIndex(readIndex().filter(function (e) { return e.id !== id; }));
      resolve();
    });
  }

  /** All full fix records that currently reference the given sighting id. */
  function findFixesContaining(sightingId) {
    return list()
      .then(function (entries) {
        return Promise.all(entries.map(function (e) { return get(e.id); }));
      })
      .then(function (fixes) {
        return fixes.filter(function (f) {
          return f && f.sightingIds.indexOf(sightingId) !== -1;
        });
      });
  }

  /** Stable plot/legend color for the sighting at position `i` within a fix. */
  function colorForIndex(i) {
    return COLORS[i % COLORS.length];
  }

  global.FixStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove,
    findFixesContaining: findFixesContaining,
    colorForIndex: colorForIndex
  };
})(window);
