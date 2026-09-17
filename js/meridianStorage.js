/**
 * meridianStorage.js
 * Persists Meridian Passage records: a Local Apparent Noon sight (Sun
 * only), which yields a latitude directly rather than an azimuth-intercept
 * LOP relative to an assumed position. Its own dedicated module rather than
 * SightStorage, since the record shape genuinely differs from a normal
 * Sight -- no assumed position, no GHA/LHA, a single observation, and a
 * sunBearsSouth flag a normal Sight has no equivalent of (see
 * calc.js's reduceMeridianSight) -- matching how Fix/DR Leg/Passage each
 * got their own module when their shape differed rather than overloading
 * SightStorage's.
 *
 * Same Promise-based localStorage save()/list()/get()/remove() pattern as
 * storage.js/fixStorage.js/drlegStorage.js, with update-in-place saves (a
 * Meridian Passage result can be corrected/edited after the fact, like a
 * Fix, rather than being treated as immutable history like a DR Leg).
 *
 * Shape: { id, schemaVersion, savedAt, title, notes, date, body,
 *   tzOffset, time: {h, m}, hs: {deg, min}, corrections, sunBearsSouth,
 *   almanac: {decBaseDeg, decBaseMin, decBaseNS, decNextDeg, decNextMin,
 *   decNextNS}, results: {interpolatedDec, zenithDistance, latitude, ho,
 *   observationTime} | null, mirrorSightId, mirrorLon }
 *
 * mirrorSightId/mirrorLon: bookkeeping for "Add to a Fix" (see
 * meridian.js's onConfirmAddToFix). A meridian sight has no zn/interceptNM
 * of its own kind for the existing Fix/multi-LOP solver to use, but its
 * result CAN be represented as a degenerate east-west LOP (zn 000° or
 * 180° depending on sunBearsSouth, intercept 0 nm, AP latitude = the
 * computed latitude) that solver already handles. Rather than teaching
 * FixStorage/fixes.js/chart.js about a second kind of fix member, "Add to a
 * Fix" creates/updates a single ordinary SightStorage record mirroring that
 * degenerate LOP, and mirrorSightId remembers which one so repeat clicks
 * update it in place instead of piling up duplicates. mirrorLon is the
 * longitude used to place that mirror on a chart (see meridian.js -- it
 * never affects the calculated latitude or the intercept, which is always
 * exactly 0; it's purely a plotting placement, sourced from the average of
 * the target Fix's other members when it has any, falling back to a
 * handed-off DR/Fix longitude and then 0° only when it doesn't).
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:meridian:';
  var INDEX_KEY = 'ocsr:meridian:index';

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
    return 'meridian_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /** Save (create or overwrite). Mutates record.id/savedAt if new. */
  function save(record) {
    return new Promise(function (resolve, reject) {
      try {
        if (!record.id) record.id = uid();
        record.savedAt = new Date().toISOString();
        if (record.mirrorSightId === undefined) record.mirrorSightId = null;

        localStorage.setItem(PREFIX + record.id, JSON.stringify(record));

        var idx = readIndex().filter(function (e) { return e.id !== record.id; });
        idx.unshift({
          id: record.id,
          savedAt: record.savedAt,
          date: record.date,
          title: record.title || '',
          latitude: (record.results && typeof record.results.latitude === 'number') ? record.results.latitude : null
        });
        writeIndex(idx);

        resolve(record);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List saved Meridian Passage records (lightweight index entries only), most recent first. */
  function list() {
    return Promise.resolve(readIndex());
  }

  /** Load a full Meridian Passage record by id. Resolves null if not found. */
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

  global.MeridianStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove
  };
})(window);
