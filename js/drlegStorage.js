/**
 * drlegStorage.js
 * Two distinct concerns, both persisted here:
 *
 *  - Form persistence (unchanged from before): the single in-progress form
 *    on drleg.html survives navigating away and back, same as Planning's
 *    fields. This is NOT a saved record -- it's just "what was I typing."
 *
 *  - Saved DR Leg records (new): an actual list of logged legs, each with a
 *    stable id, matching the same save()/list()/get()/remove() shape as
 *    SightStorage/FixStorage. That stable id is what lets a Passage (or
 *    anything else) reference "this specific leg" rather than having to
 *    describe it some other way. A DR Leg, once logged, is treated as
 *    historical record -- it says what was assumed at the time (course,
 *    speed, start position), and isn't meant to be corrected in place after
 *    the fact the way a live in-progress form would be -- so there's no
 *    update-in-place here: every save creates a new record.
 */
(function (global) {
  'use strict';

  var FORM_KEY = 'ocsr:drleg:form';
  var RECORD_PREFIX = 'ocsr:drleg:record:';
  var RECORD_INDEX_KEY = 'ocsr:drleg:index';

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

  function readRecordIndex() {
    try {
      return JSON.parse(localStorage.getItem(RECORD_INDEX_KEY) || '[]');
    } catch (e) {
      return [];
    }
  }

  function writeRecordIndex(idx) {
    localStorage.setItem(RECORD_INDEX_KEY, JSON.stringify(idx));
  }

  function uid() {
    return 'drleg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  /**
   * Save (always creates a new record -- see file header on why there's no
   * update-in-place). Mutates record.id/savedAt.
   * Expected shape: { id, savedAt, name, startPosition, sog, courseDegTrue,
   *                    durationHours, endPosition, tzOffset, passageId }
   * where startPosition/endPosition are calc.js's Position shape.
   */
  function save(record) {
    return new Promise(function (resolve, reject) {
      try {
        record.id = uid(); // always a new id -- see file header
        record.savedAt = new Date().toISOString();
        if (record.passageId === undefined) record.passageId = null;

        // endPosition is this leg's own definitive output -- now that the
        // leg has a stable id (just assigned above), stamp it as the
        // position's source so anything that later copies this position
        // elsewhere (a new Sight's AP, a chained leg's start) can say where
        // it actually came from. Can't do this any earlier: before this
        // point the leg has no id yet to point back to.
        if (record.endPosition) record.endPosition.sourceId = record.id;

        localStorage.setItem(RECORD_PREFIX + record.id, JSON.stringify(record));

        var idx = readRecordIndex();
        idx.unshift({
          id: record.id,
          savedAt: record.savedAt,
          name: record.name || '',
          startTime: record.startPosition && record.startPosition.time,
          endTime: record.endPosition && record.endPosition.time
        });
        writeRecordIndex(idx);

        resolve(record);
      } catch (e) {
        reject(e);
      }
    });
  }

  /** List saved DR Legs (lightweight index entries only), most recently saved first. */
  function list() {
    return Promise.resolve(readRecordIndex());
  }

  /** Load a full DR Leg record by id. Resolves null if not found. */
  function get(id) {
    return new Promise(function (resolve, reject) {
      try {
        var raw = localStorage.getItem(RECORD_PREFIX + id);
        resolve(raw ? JSON.parse(raw) : null);
      } catch (e) {
        reject(e);
      }
    });
  }

  function remove(id) {
    return new Promise(function (resolve) {
      localStorage.removeItem(RECORD_PREFIX + id);
      writeRecordIndex(readRecordIndex().filter(function (e) { return e.id !== id; }));
      resolve();
    });
  }

  global.DrLegStorage = {
    saveForm: saveForm,
    loadForm: loadForm,
    save: save,
    list: list,
    get: get,
    remove: remove
  };
})(window);
