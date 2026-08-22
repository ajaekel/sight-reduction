/**
 * storage.js
 * Persists sight records locally on the device. Deliberately kept as a small
 * Promise-based abstraction (save/get/list/remove) backed by localStorage today.
 * If a future need (larger blobs, structured queries) justifies it, only this
 * file needs to change to swap the backend to IndexedDB -- the rest of the app
 * only ever talks to SightStorage, never to localStorage directly.
 *
 * A companion "index" entry (a small array of {id, savedAt, date, bodyLabel})
 * is kept alongside the full records so the "Saved Sightings" list can render
 * without loading every full record.
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:sight:';
  var INDEX_KEY = 'ocsr:index';

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
    return 'sight_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function bodyLabel(body) {
    if (!body) return 'Unknown';
    if (body.type === 'star' || body.type === 'planet') {
      return body.name ? (body.type + ' ' + body.name) : body.type;
    }
    return body.type;
  }

  /** Ask the browser to protect this origin's storage from eviction under pressure. */
  function requestPersistence() {
    if (navigator.storage && navigator.storage.persist) {
      return navigator.storage.persist().catch(function () { return false; });
    }
    return Promise.resolve(false);
  }

  /** Save (create or overwrite) a sight record. Mutates record.id/savedAt if new. */
  function save(record) {
    return new Promise(function (resolve, reject) {
      try {
        if (!record.id) record.id = uid();
        record.savedAt = new Date().toISOString();

        localStorage.setItem(PREFIX + record.id, JSON.stringify(record));

        var idx = readIndex().filter(function (e) { return e.id !== record.id; });
        idx.unshift({
          id: record.id,
          savedAt: record.savedAt,
          date: record.date,
          label: record.label || '',
          bodyLabel: bodyLabel(record.body)
        });
        writeIndex(idx);

        resolve(record);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List saved sights (lightweight index entries only), most recent first. */
  function list() {
    return Promise.resolve(readIndex());
  }

  /** Load a full sight record by id. Resolves null if not found. */
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

  /** Delete a saved sight by id. */
  function remove(id) {
    return new Promise(function (resolve) {
      localStorage.removeItem(PREFIX + id);
      writeIndex(readIndex().filter(function (e) { return e.id !== id; }));
      resolve();
    });
  }

  global.SightStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove,
    requestPersistence: requestPersistence
  };
})(window);
