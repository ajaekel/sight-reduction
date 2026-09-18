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
 * This module's live-fetch paths (fetchAlmanacFill, getAlmanacFillWithCache's
 * network fallback, fetchAndCacheRange) only ever run from an explicit user
 * action -- clicking "Auto-fill" or "Download & Cache Range". The cache-only
 * path (getAlmanacFillFromCacheOnly) is safe to call reactively/automatically
 * since it never reaches the network; the rest of the app works fully
 * offline without any of this.
 *
 * USNO's API docs don't publish a rate limit for this endpoint, and there's
 * no bulk/date-range query for it (unlike some of their other services) --
 * so fetchAndCacheRange makes one request per hour, paced with a short delay
 * between requests, with backoff-and-retry for transient failures and
 * specific handling for HTTP 429 (pause and honor Retry-After if given,
 * rather than plowing through the rest of the batch). See its own comment
 * for the exact policy.
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
 *   - getAlmanacFillFromCacheOnly() -- same lookup, but never touches the
 *                                       network; used for automatic/reactive fill
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
        if (!resp.ok) {
          var httpErr = new Error('USNO server returned HTTP ' + resp.status + '.');
          httpErr.httpStatus = resp.status;
          // 5xx is the server's own problem, worth a couple of quiet retries;
          // 4xx (aside from 429) means our request itself is wrong and
          // retrying it verbatim would just repeat the same failure.
          httpErr.retryable = resp.status >= 500;
          if (resp.status === 429) {
            httpErr.isRateLimited = true;
            httpErr.retryable = true;
            var retryAfter = resp.headers && resp.headers.get && resp.headers.get('Retry-After');
            var retrySec = retryAfter ? parseInt(retryAfter, 10) : NaN;
            if (!isNaN(retrySec)) httpErr.retryAfterMs = retrySec * 1000;
          }
          throw httpErr;
        }
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
          var timeoutErr = new Error('Request to USNO timed out. Check your connection and try again.');
          timeoutErr.retryable = true; // transient -- a slow/dropped connection, not a bad request
          throw timeoutErr;
        }
        // A raw network failure (offline, DNS, CORS, connection reset) surfaces
        // as a TypeError from fetch() itself, with none of our flags set yet.
        if (err instanceof TypeError && err.retryable === undefined) {
          err.retryable = true;
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
   * Cache-only lookup: same result shape as getAlmanacFillWithCache, but
   * NEVER touches the network -- not even on a miss. Used by the automatic/
   * reactive fill path so that typing in the form can't silently trigger a
   * live fetch; only the explicit "Auto-fill" button does that. Resolves
   * null (not a rejected promise) when either bracketing hour isn't cached.
   */
  function getAlmanacFillFromCacheOnly(body, baseHourUtcDate, nextHourUtcDate) {
    return Promise.all([
      global.AlmanacCache.getHour(baseHourUtcDate),
      global.AlmanacCache.getHour(nextHourUtcDate)
    ]).then(function (cached) {
      var baseCached = cached[0];
      var nextCached = cached[1];
      if (!baseCached || !nextCached) return null;
      return { fill: assembleFill(body, baseCached, nextCached), fromCache: true };
    });
  }

  /**
   * Single-hour versions of getAlmanacFillWithCache/getAlmanacFillFromCacheOnly,
   * for a caller (Meridian Passage) that only needs the value at the
   * NEAREST almanac hour, not interpolated between two bracketing ones --
   * see calc.js's reduceMeridianSight for why that's correct here (the
   * Sun's declination barely moves within an hour). Reuses assembleFill
   * with the SAME data map passed as both "base" and "next" -- harmless,
   * since interpolating a value with itself just returns that value -- so
   * exactly one cache lookup / one live fetch happens for this hour, never
   * two.
   */
  function getAlmanacFillWithCacheSingleHour(body, hourUtcDate, latDecimal, lonDecimal) {
    return global.AlmanacCache.getHour(hourUtcDate).then(function (cached) {
      var mapPromise = cached ? Promise.resolve(cached) : fetchCelnavAt(hourUtcDate, latDecimal, lonDecimal).then(function (raw) {
        var map = normalizeUsnoData(raw);
        return global.AlmanacCache.setHour(hourUtcDate, map).catch(function () {}).then(function () { return map; });
      });
      return mapPromise.then(function (map) {
        return { fill: assembleFill(body, map, map), fromCache: !!cached };
      });
    });
  }

  function getAlmanacFillFromCacheOnlySingleHour(body, hourUtcDate) {
    return global.AlmanacCache.getHour(hourUtcDate).then(function (map) {
      if (!map) return null;
      return { fill: assembleFill(body, map, map), fromCache: true };
    });
  }

  var REQUEST_DELAY_MS = 200;          // polite pacing between consecutive requests in a batch
  var MAX_RETRIES_PER_HOUR = 2;        // for transient (5xx/timeout/network) failures
  var RETRY_BACKOFF_MS = 1000;
  var MAX_RATE_LIMIT_BACKOFFS = 3;     // cap on how many times we'll wait-and-retry a single hour after a 429
  var RATE_LIMIT_BASE_BACKOFF_MS = 3000;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /**
   * Fetches one UTC hour at a time across the range and stores each into
   * AlmanacCache, sequentially with a short pause between requests (polite
   * to USNO's free service, and makes progress reporting straightforward).
   *
   * Transient failures (timeouts, network errors, 5xx) get a couple of
   * quiet retries with backoff; a 4xx (other than 429) is treated as
   * permanent, since retrying the identical request would just repeat it.
   * A 429 (rate limited) pauses and retries that hour specifically --
   * honoring a Retry-After header if the server sent one -- with its own
   * capped backoff so a server that keeps saying "slow down" doesn't turn
   * into an unbounded wait loop.
   *
   * Individual hour failures (after retries are exhausted) are logged and
   * skipped rather than aborting the whole batch -- rerunning the same
   * range afterward safely fills any gaps (setHour overwrites).
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

    function attemptHour(utcDate, retriesLeft, rateLimitBackoffsLeft) {
      return fetchCelnavAt(utcDate, latDecimal, lonDecimal)
        .then(function (raw) {
          return global.AlmanacCache.setHour(utcDate, normalizeUsnoData(raw));
        })
        .catch(function (err) {
          if (err && err.isRateLimited && rateLimitBackoffsLeft > 0) {
            var waitMs = err.retryAfterMs || (RATE_LIMIT_BASE_BACKOFF_MS * (MAX_RATE_LIMIT_BACKOFFS - rateLimitBackoffsLeft + 1));
            return sleep(waitMs).then(function () {
              return attemptHour(utcDate, retriesLeft, rateLimitBackoffsLeft - 1);
            });
          }
          if (err && err.retryable && !err.isRateLimited && retriesLeft > 0) {
            return sleep(RETRY_BACKOFF_MS).then(function () {
              return attemptHour(utcDate, retriesLeft - 1, rateLimitBackoffsLeft);
            });
          }
          throw err; // permanent failure, or every retry/backoff budget is spent
        });
    }

    function step(i) {
      if (i >= hours.length) {
        return Promise.resolve({ total: total, succeeded: succeeded, failed: failed });
      }
      var utcDate = hours[i];
      return attemptHour(utcDate, MAX_RETRIES_PER_HOUR, MAX_RATE_LIMIT_BACKOFFS)
        .then(function () {
          succeeded++;
        })
        .catch(function (err) {
          failed++;
          console.warn('Almanac cache: failed to fetch ' + utcDate.toISOString(), err);
        })
        .then(function () {
          if (onProgress) onProgress(i + 1, total, failed);
          return sleep(REQUEST_DELAY_MS).then(function () { return step(i + 1); });
        });
    }

    return step(0);
  }

  var RSTT_URL = 'https://aa.usno.navy.mil/api/rstt/oneday';

  /** "YYYY-MM-DD" (from an <input type="date">) -> "YYYY-M-D", matching the non-padded format the celnav endpoint above is confirmed to accept. */
  function reformatDateForUsno(dateStr) {
    var p = dateStr.split('-');
    return parseInt(p[0], 10) + '-' + parseInt(p[1], 10) + '-' + parseInt(p[2], 10);
  }

  /** { phen, time }[] -> the "HH:MM" time string for that phenomenon, or null if it doesn't occur that day (e.g. no moonrise). */
  function phenTime(list, phen) {
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].phen === phen) return list[i].time;
    }
    return null;
  }

  /**
   * Impure: fetches sunrise/sunset/upper-transit and moonrise/moonset/upper-
   * transit for one date at one location, in the requested zone offset --
   * USNO converts server-side when `tz` is supplied, so what comes back is
   * already the observer's local clock time, not UTC. Returns a plain map
   * of "HH:MM" strings (or null for an event that doesn't occur that day).
   */
  function fetchRiseSetTransit(dateStr, latDecimal, lonDecimal, tzOffsetHours) {
    var coords = latDecimal.toFixed(6) + ',' + lonDecimal.toFixed(6);
    var url = RSTT_URL + '?date=' + encodeURIComponent(reformatDateForUsno(dateStr)) +
              '&coords=' + encodeURIComponent(coords) +
              '&tz=' + encodeURIComponent(tzOffsetHours) +
              '&dst=false' + // we supply our own numeric offset; don't let USNO adjust it further
              '&ID=' + API_ID;

    var controller = ('AbortController' in global) ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, TIMEOUT_MS) : null;

    return fetch(url, controller ? { signal: controller.signal } : undefined)
      .then(function (resp) {
        if (timeoutId) clearTimeout(timeoutId);
        if (!resp.ok) {
          var err = new Error('USNO server returned HTTP ' + resp.status + '.');
          err.httpStatus = resp.status;
          err.retryable = resp.status >= 500;
          if (resp.status === 429) { err.isRateLimited = true; err.retryable = true; }
          throw err;
        }
        return resp.json();
      })
      .then(function (json) {
        var data = json && json.properties && json.properties.data;
        if (!data || !data.sundata || !data.moondata) {
          throw new Error('Unexpected response shape from the USNO API.');
        }
        return {
          sunrise: phenTime(data.sundata, 'Rise'),
          sunset: phenTime(data.sundata, 'Set'),
          sunTransit: phenTime(data.sundata, 'Upper Transit'),
          // USNO's rstt/oneday service computes Civil Twilight for the Sun, but not
          // Nautical or Astronomical Twilight -- those simply aren't in this response.
          civilTwilightAM: phenTime(data.sundata, 'Begin Civil Twilight'),
          civilTwilightPM: phenTime(data.sundata, 'End Civil Twilight'),
          moonrise: phenTime(data.moondata, 'Rise'),
          moonset: phenTime(data.moondata, 'Set'),
          moonTransit: phenTime(data.moondata, 'Upper Transit')
        };
      })
      .catch(function (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err && err.name === 'AbortError') {
          var timeoutErr = new Error('Request to USNO timed out. Check your connection and try again.');
          timeoutErr.retryable = true;
          throw timeoutErr;
        }
        if (err instanceof TypeError && err.retryable === undefined) err.retryable = true;
        throw err;
      });
  }

  global.SightUsno = {
    fetchAlmanacFill: fetchAlmanacFill,
    getAlmanacFillWithCache: getAlmanacFillWithCache,
    getAlmanacFillFromCacheOnly: getAlmanacFillFromCacheOnly,
    getAlmanacFillWithCacheSingleHour: getAlmanacFillWithCacheSingleHour,
    getAlmanacFillFromCacheOnlySingleHour: getAlmanacFillFromCacheOnlySingleHour,
    fetchRiseSetTransit: fetchRiseSetTransit,
    fetchAndCacheRange: fetchAndCacheRange,
    assembleFill: assembleFill,             // exported for unit testing
    normalizeUsnoData: normalizeUsnoData,   // exported for unit testing
    findObject: findObject,                 // exported for unit testing
    eachUtcHourInRange: eachUtcHourInRange  // exported for unit testing
  };
})(window);
