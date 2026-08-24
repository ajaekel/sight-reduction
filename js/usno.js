/**
 * usno.js
 * Integration with the US Naval Observatory's public Celestial Navigation
 * Data API (https://aa.usno.navy.mil/data/celnav). This is a convenience
 * "autofill" for the Almanac Data section (Section 3) ONLY -- it fills in
 * GHA/Dec/SHA the same way you'd copy them from a printed Nautical Almanac.
 *
 * Deliberately out of scope: the altitude-correction fields in Section 2.
 * Those corrections are looked up using YOUR apparent altitude (Ha) from
 * your own sextant reading, whereas USNO's altitude_corrections are computed
 * from the theoretical/computed altitude (Hc) at the assumed position -- a
 * different quantity. Mixing the two would quietly corrupt the intercept
 * math, so that step stays manual.
 *
 * This module never runs unless the user explicitly clicks the fetch
 * button; the rest of the app works fully offline without it.
 *
 * Split into:
 *   - fetchCelnavAt()   -- the actual network call (impure)
 *   - assembleFill()    -- pure parsing/matching of already-fetched data,
 *                          independently unit-testable with mock payloads
 *   - fetchAlmanacFill()-- orchestrates the two calls (base/next hour) + assemble
 */
(function (global) {
  'use strict';

  var BASE_URL = 'https://aa.usno.navy.mil/api/celnav';
  var API_ID = 'OCSRApp'; // self-chosen per USNO's optional ID convention
  var TIMEOUT_MS = 10000;

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatUsnoDate(d) {
    return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1) + '-' + d.getUTCDate();
  }

  function formatUsnoTime(d) {
    return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ':' + pad2(d.getUTCSeconds());
  }

  function normalizeName(s) {
    return (s || '').trim().toLowerCase();
  }

  function findObject(dataList, name) {
    var target = normalizeName(name);
    for (var i = 0; i < dataList.length; i++) {
      if (normalizeName(dataList[i].object) === target) return dataList[i];
    }
    return null;
  }

  /**
   * Pure: given two already-fetched data arrays (base hour, next hour) and
   * the body being looked up, assembles the fill object the app's almanac
   * fields expect. Throws a descriptive Error if the body can't be matched.
   *
   * body = { type: 'sun'|'moon'|'planet'|'star', name: string }
   *
   * Returns, for non-star bodies:
   *   { ghaBaseDeg, ghaNextDeg, decBaseDeg, decBaseSign, decNextDeg, decNextSign }
   * Returns, for stars:
   *   { ghaAriesBaseDeg, ghaAriesNextDeg, shaDeg, decDeg, decSign }
   * (all angle values as raw decimal degrees -- caller converts to Deg/Min)
   */
  function assembleFill(body, baseDataList, nextDataList) {
    var lookupName = body.type === 'sun' ? 'Sun'
                    : body.type === 'moon' ? 'Moon'
                    : body.name;

    if (!lookupName) {
      throw new Error('No body name to look up.');
    }

    var baseObj = findObject(baseDataList, lookupName);
    var nextObj = findObject(nextDataList, lookupName);

    if (!baseObj || !nextObj) {
      throw new Error(
        'USNO did not return data for "' + lookupName + '" at this time/position. ' +
        'It may be below the horizon, or the name may not match the standard navigational star list.'
      );
    }

    if (body.type === 'star') {
      var ariesBase = findObject(baseDataList, 'Aries');
      var ariesNext = findObject(nextDataList, 'Aries');

      if (ariesBase && ariesNext) {
        var sha = ((baseObj.almanac_data.gha - ariesBase.almanac_data.gha) % 360 + 360) % 360;
        return {
          ghaAriesBaseDeg: ariesBase.almanac_data.gha,
          ghaAriesNextDeg: ariesNext.almanac_data.gha,
          shaDeg: sha,
          decDeg: Math.abs(baseObj.almanac_data.dec),
          decSign: baseObj.almanac_data.dec >= 0 ? 'N' : 'S'
        };
      }

      // Fallback if the response has no separate "Aries" entry: since
      // GHA_star = GHA_Aries + SHA and interpolation is linear, using the
      // star's own GHA directly in the "GHA Aries" slot with SHA = 0
      // produces an identical interpolated result -- just not labeled the
      // way a printed almanac page would show it.
      return {
        ghaAriesBaseDeg: baseObj.almanac_data.gha,
        ghaAriesNextDeg: nextObj.almanac_data.gha,
        shaDeg: 0,
        decDeg: Math.abs(baseObj.almanac_data.dec),
        decSign: baseObj.almanac_data.dec >= 0 ? 'N' : 'S'
      };
    }

    return {
      ghaBaseDeg: baseObj.almanac_data.gha,
      ghaNextDeg: nextObj.almanac_data.gha,
      decBaseDeg: Math.abs(baseObj.almanac_data.dec),
      decBaseSign: baseObj.almanac_data.dec >= 0 ? 'N' : 'S',
      decNextDeg: Math.abs(nextObj.almanac_data.dec),
      decNextSign: nextObj.almanac_data.dec >= 0 ? 'N' : 'S'
    };
  }

  /** Impure: fetches celnav data for one instant. Returns properties.data (array). */
  function fetchCelnavAt(utcDate, latDecimal, lonDecimal) {
    var coords = latDecimal.toFixed(6) + ',' + lonDecimal.toFixed(6);
    var url = BASE_URL + '?date=' + encodeURIComponent(formatUsnoDate(utcDate)) +
              '&time=' + encodeURIComponent(formatUsnoTime(utcDate)) +
              '&coords=' + encodeURIComponent(coords) +
              '&ID=' + API_ID;

    var controller = ('AbortController' in global) ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

    return fetch(url, controller ? { signal: controller.signal } : undefined)
      .then(function (resp) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!resp.ok) throw new Error('USNO server returned HTTP ' + resp.status + '.');
        return resp.json();
      })
      .then(function (json) {
        if (json && json.error) throw new Error('USNO API error: ' + json.error);
        var data = json && json.properties && json.properties.data;
        if (!Array.isArray(data)) throw new Error('Unexpected response shape from the USNO API.');
        return data;
      })
      .catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err && err.name === 'AbortError') {
          throw new Error('Request to USNO timed out. Check your connection and try again.');
        }
        throw err;
      });
  }

  /**
   * Fetches both the base and next UTC-hour boundary data and assembles the
   * fill object for the requested body. This is the main entry point the UI calls.
   */
  function fetchAlmanacFill(body, baseHourUtcDate, nextHourUtcDate, latDecimal, lonDecimal) {
    return Promise.all([
      fetchCelnavAt(baseHourUtcDate, latDecimal, lonDecimal),
      fetchCelnavAt(nextHourUtcDate, latDecimal, lonDecimal)
    ]).then(function (results) {
      return assembleFill(body, results[0], results[1]);
    });
  }

  global.SightUsno = {
    fetchAlmanacFill: fetchAlmanacFill,
    assembleFill: assembleFill, // exported for unit testing
    findObject: findObject      // exported for unit testing
  };
})(window);
