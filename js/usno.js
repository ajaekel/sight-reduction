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
 * This module never runs unless the user explicitly clicks a fetch/cache
 * button; the rest of the app works fully offline without it.
 *
 * Data shape used throughout (both freshly-fetched and cached):
 *   normalized map = { [lowercaseName]: { name, gha, dec } }
 * GHA/Dec are geocentric almanac values, the same for every observer on
 * Earth at a given instant -- exactly how a printed almanac works -- so a
 * cached hour is reusable for any later sight regardless of that sight's AP.
 *
 * File layout:
 *   - fetchCelnavAt()        -- one network call for one instant (impure)
 *   - normalizeUsnoData()    -- raw USNO array -> normalized map (pure)
 *   - assembleFill()         -- pure parsing/matching against two normalized
 *                                maps, independently unit-testable
 *   - eachUtcHourInRange()   -- pure: date range -> list of UTC hour Dates
 *   - fetchAndCacheRange()   -- orchestrates a batch fetch into AlmanacCache
 *   - getAlmanacFillWithCache() -- single-sight entry point: cache first,
 *                                   live fetch as fallback (and backfills cache)
 */
(function (global) {
  'use strict';

  var BASE_URL = 'https://aa.usno.navy.mil/api/celnav';
  var API_ID = 'OCSRApp'; // self-chosen per USNO's optional ID convention
  var TIMEOUT_MS = 10000;
  var MAX_CACHE_HOURS = 14 * 24 + 1; // ~14 days, plus one boundary hour

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

  /** Pure: raw USNO properties.data array -> normalized { [lowercaseName]: {name,gha,dec} } map. */
  function normalizeUsnoData(rawList) {
    var map = {};
    (rawList || []).forEach(function (entry) {
      if (!entry || !entry.object || !entry.almanac_data) return;
      map[normalizeName(entry.object)] = {
        name: entry.object,
        gha: entry.almanac_data.gha,
        dec: entry.almanac_data.dec
      };
    });
    return map;
  }

  function findObject(dataMap, name) {
    return (dataMap && dataMap[normalizeName(name)]) || null;
  }

  /**
   * Pure: given two normalized maps (base hour, next hour) and the body
   * being looked up, assembles the fill object the app's almanac fields
   * expect. Throws a descriptive Error if the body can't be matched.
   *
   * body = { type: 'sun'|'moon'|'planet'|'star', name: string }
   */
  function assembleFill(body, baseDataMap, nextDataMap) {
    var lookupName = body.type === 'sun' ? 'Sun'
                    : body.type === 'moon' ? 'Moon'
                    : body.name;

    if (!lookupName) {
      throw new Error('No body name to look up.');
    }

    var baseObj = findObject(baseDataMap, lookupName);
    var nextObj = findObject(nextDataMap, lookupName);

    if (!baseObj || !nextObj) {
      throw new Error(
        'No almanac data for "' + lookupName + '" at this time/position. ' +
        'It may be below the horizon, or the name may not match the standard navigational star list.'
      );
    }

    if (body.type === 'star') {
      var ariesBase = findObject(baseDataMap, 'Aries');
      var ariesNext = findObject(nextDataMap, 'Aries');

      if (ariesBase && ariesNext) {
        var sha = ((baseObj.gha - ariesBase.gha) % 360 + 360) % 360;
        return {
          ghaAriesBaseDeg: ariesBase.gha,
          ghaAriesNextDeg: ariesNext.gha,
          shaDeg: sha,
          decDeg: Math.abs(baseObj.dec),
          decSign: baseObj.dec >= 0 ? 'N' : 'S'
        };
      }

      // Fallback if there's no separate "Aries" entry: since
      // GHA_star = GHA_Aries + SHA and interpolation is linear, using the
      // star's own GHA directly in the "GHA Aries" slot with SHA = 0
      // produces an identical interpolated result -- just not labeled the
      // way a printed almanac page would show it.
      return {
        ghaAriesBaseDeg: baseObj.gha,
        ghaAriesNextDeg: nextObj.gha,
        shaDeg: 0,
        decDeg: Math.abs(baseObj.dec),
        decSign: baseObj.dec >= 0 ? 'N' : 'S'
      };
    }

    return {
      ghaBaseDeg: baseObj.gha,
      ghaNextDeg: nextObj.gha,
      decBaseDeg: Math.abs(baseObj.dec),
      decBaseSign: baseObj.dec >= 0 ? 'N' : 'S',
      decNextDeg: Math.abs(nextObj.dec),
      decNextSign: nextObj.dec >= 0 ? 'N' : 'S'
    };
  }

  /** Impure: fetches celnav data for one instant. Returns properties.data (raw array). */
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

  /** Pure: fromDateStr/toDateStr ('YYYY-MM-DD', UTC) -> array of UTC-hour Dates, inclusive, plus one trailing boundary hour. */
  function eachUtcHourInRange(fromDateStr, toDateStr) {
    var start = new Date(fromDateStr + 'T00:00:00Z');
    var end = new Date(toDateStr + 'T00:00:00Z');
    end.setUTCDate(end.getUTCDate() + 1); // include the trailing boundary hour past the last full day

    var hours = [];
    var cur = new Date(start.getTime());
    while (cur.getTime() <= end.getTime()) {
      hours.push(new Date(cur.getTime()));
      cur.setUTCHours(cur.getUTCHours() + 1);
    }
    return hours;
  }

  /**
   * Fetches both the base and next UTC-hour boundary data (live) and
   * assembles the fill object for the requested body. Always hits the
   * network -- use getAlmanacFillWithCache() for the cache-first version.
   */
  function fetchAlmanacFill(body, baseHourUtcDate, nextHourUtcDate, latDecimal, lonDecimal) {
    return Promise.all([
      fetchCelnavAt(baseHourUtcDate, latDecimal, lonDecimal),
      fetchCelnavAt(nextHourUtcDate, latDecimal, lonDecimal)
    ]).then(function (results) {
      return assembleFill(body, normalizeUsnoData(results[0]), normalizeUsnoData(results[1]));
    });
  }

  /**
   * Cache-first version of fetchAlmanacFill: checks AlmanacCache for both
   * bracketing hours first (instant, works offline). Falls back to a live
   * fetch only for whichever hour(s) are missing, and opportunistically
   * backfills the cache with anything freshly fetched.
   */
  function getAlmanacFillWithCache(body, baseHourUtcDate, nextHourUtcDate, latDecimal, lonDecimal) {
    return Promise.all([
      global.AlmanacCache.getHour(baseHourUtcDate),
      global.AlmanacCache.getHour(nextHourUtcDate)
    ]).then(function (cached) {
      var baseCached = cached[0];
      var nextCached = cached[1];

      function liveAndCache(utcDate) {
        return fetchCelnavAt(utcDate, latDecimal, lonDecimal).then(function (raw) {
          var map = normalizeUsnoData(raw);
          return global.AlmanacCache.setHour(utcDate, map).catch(function () {}).then(function () {
            return map;
          });
        });
      }

      var baseP = baseCached ? Promise.resolve(baseCached) : liveAndCache(baseHourUtcDate);
      var nextP = nextCached ? Promise.resolve(nextCached) : liveAndCache(nextHourUtcDate);

      return Promise.all([baseP, nextP]).then(function (maps) {
        return {
          fill: assembleFill(body, maps[0], maps[1]),
          fromCache: !!(baseCached && nextCached)
        };
      });
    });
  }

  /**
   * Fetches one UTC hour at a time across the range and stores each into
   * AlmanacCache, sequentially (polite to USNO's free service, and makes
   * progress reporting straightforward). Individual hour failures are
   * logged and skipped rather than aborting the whole batch -- rerunning
   * the same range afterward safely fills any gaps (setHour overwrites).
   *
   * onProgress(doneCount, total, failedCount) is called after every hour.
   * Returns a Promise resolving to { total, succeeded, failed }.
   */
  function fetchAndCacheRange(fromDateStr, toDateStr, latDecimal, lonDecimal, onProgress) {
    var hours;
    try {
      hours = eachUtcHourInRange(fromDateStr, toDateStr);
    } catch (e) {
      return Promise.reject(new Error('Invalid date range.'));
    }

    if (hours.length > MAX_CACHE_HOURS) {
      return Promise.reject(new Error(
        'That range is too large (' + hours.length + ' hours). Please cache at most 14 days at a time.'
      ));
    }

    var total = hours.length;
    var succeeded = 0;
    var failed = 0;

    function step(i) {
      if (i >= hours.length) {
        return Promise.resolve({ total: total, succeeded: succeeded, failed: failed });
      }
      var utcDate = hours[i];
      return fetchCelnavAt(utcDate, latDecimal, lonDecimal)
        .then(function (raw) {
          return global.AlmanacCache.setHour(utcDate, normalizeUsnoData(raw));
        })
        .then(function () {
          succeeded++;
        })
        .catch(function (err) {
          failed++;
          console.warn('Almanac cache: failed to fetch ' + utcDate.toISOString(), err);
        })
        .then(function () {
          if (onProgress) onProgress(i + 1, total, failed);
          return step(i + 1);
        });
    }

    return step(0);
  }

  global.SightUsno = {
    fetchAlmanacFill: fetchAlmanacFill,
    getAlmanacFillWithCache: getAlmanacFillWithCache,
    fetchAndCacheRange: fetchAndCacheRange,
    assembleFill: assembleFill,             // exported for unit testing
    normalizeUsnoData: normalizeUsnoData,   // exported for unit testing
    findObject: findObject,                 // exported for unit testing
    eachUtcHourInRange: eachUtcHourInRange  // exported for unit testing
  };
})(window);
