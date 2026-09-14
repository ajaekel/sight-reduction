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
 *    SightStorage/FixStorage. This is what makes a DR Leg something a
 *    Passage timeline (or anything else) can reference by id -- see
 *    docs/passage-design.md section 8, prerequisite 1. A DR Leg, once
 *    logged, is treated as historical record (see the design doc's answer
 *    to "is Passage immutable or editable" -- a leg says what was assumed
 *    at the time, and isn't meant to be edited after the fact), so there's
 *    no update-in-place here: every save creates a new record.
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
   *                    durationHours, endPosition, passageId }
   * where startPosition/endPosition are calc.js's Position shape.
   */
  function save(record) {
    return new Promise(function (resolve, reject) {
      try {
        record.id = uid(); // always a new id -- see file header
        record.savedAt = new Date().toISOString();
        if (record.passageId === undefined) record.passageId = null;

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
