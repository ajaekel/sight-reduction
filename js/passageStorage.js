/**
 * passageStorage.js
 * A Passage's own record is deliberately small: {id, name, notes,
 * startingPosition, startedAt, endedAt, createdAt}. It does NOT hold a list
 * of member ids. Membership lives entirely on each Sight/Fix/DrLeg's own
 * passageId field (added to their respective storage modules alongside
 * this file) -- a Passage's members are found by querying for that field,
 * not by maintaining a second, separate list that could drift out of sync
 * with what those records actually say about themselves.
 *
 * That's possible in the first place because every candidate record already
 * carries its own timestamp (a Sight's observationTime, a Fix's
 * resolvedPosition.time, a DR Leg's startPosition.time) -- chronological
 * order is therefore a query (sort by time), not something that needs its
 * own storage. getPassageTimeline() below is exactly that query, computed
 * fresh every time it's called -- a VIEW over the other stores, not stored
 * data of its own.
 *
 * startedAt/endedAt on the Passage record itself are a cached summary (the
 * earliest/latest member timestamp) for cheap display without walking the
 * whole timeline -- same derived-and-cached pattern as Fix.resolvedPosition
 * or a Sight's results. Same Promise-based localStorage pattern as
 * storage.js/fixStorage.js/drlegStorage.js.
 */
(function (global) {
  'use strict';

  var PREFIX = 'ocsr:passage:';
  var INDEX_KEY = 'ocsr:passage:index';

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
    return 'passage_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Save (create or overwrite). Mutates passage.id/createdAt if new.
   * Shape: { id, name, notes, startingPosition, startedAt, endedAt, createdAt }
   * where startingPosition is calc.js's Position shape (sourceType usually
   * 'KNOWN' -- a passage typically begins from a known/verified position).
   */
  function save(passage) {
    return new Promise(function (resolve, reject) {
      try {
        if (!passage.id) {
          passage.id = uid();
          passage.createdAt = new Date().toISOString();
        }

        localStorage.setItem(PREFIX + passage.id, JSON.stringify(passage));

        var idx = readIndex().filter(function (e) { return e.id !== passage.id; });
        idx.unshift({
          id: passage.id,
          name: passage.name || 'Untitled Passage',
          startedAt: passage.startedAt || null,
          endedAt: passage.endedAt || null,
          createdAt: passage.createdAt
        });
        writeIndex(idx);

        resolve(passage);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List passages (lightweight index entries only), most recently saved first. */
  function list() {
    return Promise.resolve(readIndex());
  }

  /** Load a full passage record by id. Resolves null if not found. */
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
   * Fetches every full record (not just index entries) from a given storage
   * module and keeps only the ones whose own passageId matches. Guards
   * against the module not being loaded at all (a page that only needs
   * some of Sight/Fix/DrLeg won't have included every storage script) by
   * quietly returning an empty list rather than throwing.
   */
  function matchingRecords(storage, passageId) {
    if (!storage) return Promise.resolve([]);
    return storage.list().then(function (entries) {
      return Promise.all(entries.map(function (e) { return storage.get(e.id); }));
    }).then(function (records) {
      return records.filter(function (r) { return r && r.passageId === passageId; });
    });
  }

  /**
   * Every Sight, Fix, and DR Leg belonging to this passage -- i.e. the
   * membership query described in the file header. Returns
   * { sights, fixes, drLegs }, each a plain array of full records.
   */
  function getPassageRecords(passageId) {
    return Promise.all([
      matchingRecords(global.SightStorage, passageId),
      matchingRecords(global.FixStorage, passageId),
      matchingRecords(global.DrLegStorage, passageId)
    ]).then(function (results) {
      return { sights: results[0], fixes: results[1], drLegs: results[2] };
    });
  }

  /**
   * The chronological story of a passage: its starting position plus every
   * Sight/Fix/DrLeg belonging to it, sorted by time. A VIEW, not stored
   * data -- computed fresh on every call (see file header). Each entry is
   * { type, time, record } so a caller can branch on type without having
   * to guess it from the record's shape.
   *
   * Time used per type:
   *  - 'position' (the passage's own starting position): its own time.
   *  - 'sight': results.observationTime -- skipped if the sight has never
   *    actually been reduced, since there's no real instant to place it at.
   *  - 'fix': resolvedPosition.time -- skipped if never resolved.
   *  - 'drleg': startPosition.time, deliberately the START rather than the
   *    end. A leg then sorts immediately after whatever established that
   *    start (a prior fix, a chained leg's own start) and before whatever
   *    happens at its end, rather than risking a tie with the very next
   *    entry's timestamp if it were keyed by its end instead.
   */
  function getPassageTimeline(passageId) {
    return Promise.all([get(passageId), getPassageRecords(passageId)]).then(function (results) {
      var passage = results[0];
      var records = results[1];
      var entries = [];

      if (passage && passage.startingPosition && passage.startingPosition.time) {
        entries.push({ type: 'position', time: passage.startingPosition.time, record: passage.startingPosition });
      }
      records.sights.forEach(function (s) {
        if (s.results && s.results.observationTime) {
          entries.push({ type: 'sight', time: s.results.observationTime, record: s });
        }
      });
      records.fixes.forEach(function (f) {
        if (f.resolvedPosition && f.resolvedPosition.time) {
          entries.push({ type: 'fix', time: f.resolvedPosition.time, record: f });
        }
      });
      records.drLegs.forEach(function (leg) {
        if (leg.startPosition && leg.startPosition.time) {
          entries.push({ type: 'drleg', time: leg.startPosition.time, record: leg });
        }
      });

      entries.sort(function (a, b) { return a.time < b.time ? -1 : (a.time > b.time ? 1 : 0); });
      return entries;
    });
  }

  global.PassageStorage = {
    save: save,
    list: list,
    get: get,
    remove: remove,
    getPassageRecords: getPassageRecords,
    getPassageTimeline: getPassageTimeline
  };
})(window);
