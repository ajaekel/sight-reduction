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
 * mirrorSightId/mirrorLon: bookkeeping for "Add to a Fix", triggerable both
 * from meridian.js's own page and from fixes.js's "Add a Meridian Passage"
 * (for an already-saved one). A meridian sight has no zn/interceptNM of its
 * own kind for the existing Fix/multi-LOP solver to use, but its result CAN
 * be represented as a degenerate east-west LOP (zn 000° or 180°
 * depending on sunBearsSouth, intercept 0 nm, AP latitude = the computed
 * latitude) that solver already handles -- see this file's own
 * buildMirrorSightRecord, the single shared definition of that mirror.
 * Rather than teaching FixStorage/fixes.js/chart.js about a second kind of
 * fix member, "Add to a Fix" creates/updates a single ordinary SightStorage
 * record mirroring that degenerate LOP, and mirrorSightId remembers which
 * one so repeat clicks update it in place instead of piling up duplicates.
 * mirrorLon is the longitude used to place that mirror on a chart -- it
 * never affects the calculated latitude or the intercept, which is always
 * exactly 0; it's purely a plotting placement, sourced from the average of
 * the target Fix's other members when it has any, falling back to a
 * handed-off DR/Fix longitude and then 0° only when it doesn't.
 *
 * passageId: same membership convention as Sight/Fix/DR Leg -- a Meridian
 * Passage sight belongs to at most one Passage, found by querying for this
 * field (see passageStorage.js), not by a list kept on the Passage itself.
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
        // Same convention as storage.js/fixStorage.js/drlegStorage.js: a
        // Meridian Passage sight belongs to at most one Passage, null until
        // a Passage feature actually assigns one.
        if (record.passageId === undefined) record.passageId = null;

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

  /**
   * Assigns (or clears, with passageId=null) this Meridian Passage sight's
   * passageId, in place -- same reasoning as SightStorage/FixStorage/
   * DrLegStorage's own setPassageId: filing it under a Passage is
   * organizational metadata added after the fact, not a correction to the
   * sight itself, so it doesn't go through save() and doesn't touch
   * savedAt. Resolves the updated record, or null if not found.
   */
  function setPassageId(id, passageId) {
    return new Promise(function (resolve, reject) {
      try {
        var raw = localStorage.getItem(PREFIX + id);
        if (!raw) { resolve(null); return; }
        var record = JSON.parse(raw);
        record.passageId = passageId;
        localStorage.setItem(PREFIX + id, JSON.stringify(record));
        resolve(record);
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Builds the ordinary SightStorage-shaped record representing a resolved
   * Meridian Passage sight as a degenerate east-west LOP, so it can join an
   * existing Fix's sightIds and be crossed by the existing multi-LOP solver
   * (see calc.js's intersectTwoLops -- it solves each LOP as a true
   * infinite line, so mirrorLon, used only to place the AP on a chart,
   * cannot affect the solved position). Pure/stateless: `record` is this
   * module's own save() shape and must already have `results` set (i.e.
   * already resolved to a latitude).
   *
   * Shared by meridian.js (its own "Add to a Fix") and fixes.js ("Add a
   * Meridian Passage" on the Fixes page, for an already-saved one) so both
   * stay in sync with exactly one definition of what this mirror looks
   * like. internal/derivedFromMeridianId mark it as NOT a real user-created
   * Sight -- see storage.js/sights.js/fixes.js, which all check `internal`
   * to keep it out of the ordinary Sights list and the "Add a Saved Sight"
   * picker, and fixes.js's chart "Open" action, which checks
   * derivedFromMeridianId to route back to this same Meridian Passage
   * record instead of opening it as a Sight.
   */
  function buildMirrorSightRecord(record, mirrorLon) {
    var result = record.results;
    var latAbs = SightCalc.decimalToDM(Math.abs(result.latitude));
    var lonAbs = SightCalc.decimalToDM(Math.abs(mirrorLon));
    var zn = record.sunBearsSouth ? 180 : 0;

    return {
      schemaVersion: 1,
      internal: true,
      derivedFromMeridianId: record.id,
      title: 'Meridian Passage — ' + (record.date || '') + ' latitude line',
      notes: 'Auto-generated from a Meridian Passage sight, to represent it as a line of constant latitude in this Fix. Editing this record directly will not update the original Meridian Passage sight.',
      date: record.date,
      body: { type: 'sun', name: null, limb: 'lower' },
      position: {
        latDeg: latAbs.deg, latMin: latAbs.min, latNS: result.latitude < 0 ? 'S' : 'N',
        lonDeg: lonAbs.deg, lonMin: lonAbs.min, lonEW: mirrorLon < 0 ? 'W' : 'E',
        tzOffset: record.tzOffset
      },
      observations: [{ h: record.time.h, m: record.time.m, s: 0, heightDeg: record.hs.deg, heightMin: record.hs.min }],
      corrections: {
        ieMin: record.corrections.ieMin, ieSign: record.corrections.ieSign,
        dipMin: record.corrections.dipMin,
        altCorrMin: record.corrections.altCorrMin, altCorrSign: record.corrections.altCorrSign,
        addAltCorrMin: record.corrections.addAltCorrMin, addAltCorrSign: record.corrections.addAltCorrSign,
        clockErrorSec: record.corrections.clockErrorSec, clockErrorDirection: record.corrections.clockErrorDirection
      },
      almanac: {
        nonStar: {
          ghaBaseDeg: 0, ghaBaseMin: 0, ghaNextDeg: 0, ghaNextMin: 0,
          decBaseDeg: record.almanac.decBaseDeg, decBaseMin: record.almanac.decBaseMin, decBaseNS: record.almanac.decBaseNS,
          decNextDeg: record.almanac.decNextDeg, decNextMin: record.almanac.decNextMin, decNextNS: record.almanac.decNextNS
        }
      },
      results: {
        interpolatedGha: 0,
        interpolatedDec: result.interpolatedDec,
        lha: 0,
        hc: result.ho,
        zn: zn,
        interceptNM: 0,
        interceptDirection: 'TOWARD',
        ho: result.ho,
        observationTime: result.observationTime
      }
    };
  }

  global.MeridianStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove,
    setPassageId: setPassageId,
    buildMirrorSightRecord: buildMirrorSightRecord
  };
})(window);
