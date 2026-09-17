/**
 * planning.js
 * Sunrise/sunset, moonrise/moonset, and meridian passage for a date and
 * position -- either interpolated manually from a printed Nautical Almanac
 * (fully offline), or fetched from USNO's rstt/oneday endpoint in one call.
 *
 * "Start a Sight with this AP" hands Date/TZ/AP to index.html via
 * sessionStorage (see also applyPendingHandoff() in app.js, which consumes
 * it). Only this direction -- planning -> index -- exists today.
 */

var _planningMode = 'manual'; // 'manual' | 'autofill'

/**
 * PlanningStorage lives in a separate file (js/planningStorage.js) that must be
 * included before this one. If it's ever missing (a deploy that dropped the new
 * file, a stale cache, etc.), persistence should just quietly not happen rather
 * than break the actual calculator -- hence the guard on every call site below.
 */
function hasPlanningStorage() {
  if (typeof PlanningStorage === 'undefined') {
    console.warn('PlanningStorage is not loaded (missing js/planningStorage.js?) -- form/cache persistence is disabled this session.');
    return false;
  }
  return true;
}

/**
 * Every LOGICAL field whose value should survive navigating away and back.
 * Most of these map 1:1 to a DOM element by id. The time fields (Sunrise,
 * Sunset, Meridian Passage, etc.) instead map to a pair of digit boxes,
 * id+'H' and id+'M' -- see getFieldValue/setFieldValue, which are the only
 * two places that need to know about that split. Everything else (parsing,
 * persistence, calculation) keeps working against a plain "HH:MM" string.
 */
var PLANNING_FIELD_IDS = [
  'planDate', 'planTzOffset', 'planLatDeg', 'planLatMin', 'planLatNS', 'planLonDeg', 'planLonMin', 'planLonEW',
  'refLatAboveSun', 'refLatBelowSun',
  'sunriseTimeBelow', 'sunriseTimeAbove', 'sunsetTimeBelow', 'sunsetTimeAbove', 'sunTransitTime',
  'moonriseTimeBelow', 'moonriseTimeAbove', 'moonsetTimeBelow', 'moonsetTimeAbove', 'moonTransitTime',
  'moonriseTimeBelowAdj', 'moonriseTimeAboveAdj', 'moonsetTimeBelowAdj', 'moonsetTimeAboveAdj', 'moonTransitTimeAdj'
];

/** Reads a logical field's value as a plain string ("HH:MM" for time fields). */
function getFieldValue(id) {
  var hEl = document.getElementById(id + 'H');
  var mEl = document.getElementById(id + 'M');
  if (hEl && mEl) {
    if (hEl.value === '' && mEl.value === '') return '';
    var hh = (hEl.value || '0').length < 2 ? ('0' + hEl.value).slice(-2) : hEl.value;
    var mm = (mEl.value || '0').length < 2 ? ('0' + mEl.value).slice(-2) : mEl.value;
    return hh + ':' + mm;
  }
  var el = document.getElementById(id);
  return el ? el.value : '';
}

/** Writes a plain string ("HH:MM" for time fields) into a logical field. */
function setFieldValue(id, val) {
  var hEl = document.getElementById(id + 'H');
  var mEl = document.getElementById(id + 'M');
  if (hEl && mEl) {
    var p = (val || '').split(':');
    hEl.value = p[0] || '';
    mEl.value = p[1] || '';
    return;
  }
  var el = document.getElementById(id);
  if (el) el.value = val;
}

/** Serializes all persisted fields + the current mode, and writes them to localStorage. */
function savePlanningForm() {
  if (!hasPlanningStorage()) return;
  var data = { mode: _planningMode, fields: {} };
  PLANNING_FIELD_IDS.forEach(function (id) {
    data.fields[id] = getFieldValue(id);
  });
  PlanningStorage.saveForm(data);
}

/** Restores previously-saved field values + mode, if any. Returns true if anything was restored. */
function restorePlanningForm() {
  if (!hasPlanningStorage()) return false;
  var data = PlanningStorage.loadForm();
  if (!data || !data.fields) return false;
  PLANNING_FIELD_IDS.forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(data.fields, id) && data.fields[id]) {
      setFieldValue(id, data.fields[id]);
    }
  });
  if (data.mode === 'manual' || data.mode === 'autofill') _planningMode = data.mode;
  return true;
}

/**
 * Consumes a one-time Date/TZ/AP handoff from drleg.html's "Send to Planning"
 * (see sessionStorage key 'ocsrPlanningApHandoff' in js/drleg.js). Same
 * {date, tzOffset, latDeg, latMin, latNS, lonDeg, lonMin, lonEW} shape as
 * the existing DR-Leg-to-New-Sight / Planning-to-New-Sight handoff
 * (sessionStorage key 'ocsrApHandoff', consumed in app.js) -- just a
 * different destination page, so it gets its own key rather than racing
 * index.html for the same one.
 */
function applyPendingPlanningHandoff() {
  var raw;
  try {
    raw = sessionStorage.getItem('ocsrPlanningApHandoff');
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  sessionStorage.removeItem('ocsrPlanningApHandoff'); // one-time consume, even if parsing fails below

  var h;
  try {
    h = JSON.parse(raw);
  } catch (e) {
    return false;
  }

  if (h.date) document.getElementById('planDate').value = h.date;
  if (h.tzOffset !== undefined) document.getElementById('planTzOffset').value = h.tzOffset;
  if (h.latDeg !== undefined) document.getElementById('planLatDeg').value = h.latDeg;
  if (h.latMin !== undefined) document.getElementById('planLatMin').value = h.latMin;
  if (h.latNS) document.getElementById('planLatNS').value = h.latNS;
  if (h.lonDeg !== undefined) document.getElementById('planLonDeg').value = h.lonDeg;
  if (h.lonMin !== undefined) document.getElementById('planLonMin').value = h.lonMin;
  if (h.lonEW) document.getElementById('planLonEW').value = h.lonEW;

  return true;
}

/** Digit-only filtering, range validation (via .input-error), and auto-advance to nextId once full. */
function wireDigitBox(id, maxLen, min, max, nextId) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', function () { this.select(); });
  el.addEventListener('input', function () {
    var cleaned = this.value.replace(/[^0-9]/g, '').slice(0, maxLen);
    if (cleaned !== this.value) this.value = cleaned;
    var n = parseInt(cleaned, 10);
    this.classList.toggle('input-error', cleaned !== '' && (isNaN(n) || n < min || n > max));
    if (cleaned.length >= maxLen && nextId) {
      var nextEl = document.getElementById(nextId);
      if (nextEl) { nextEl.focus(); nextEl.select(); }
    }
  });
}

/**
 * The Moon uses the same reference latitude bands as the Sun (same almanac
 * page, same two rows) -- rather than make the person type them twice,
 * canonicalId is the value actually used in calculations and mirrorId is a
 * second, visually-identical box that stays in sync with it either way.
 */
function wireLatMirror(canonicalId, mirrorId) {
  var canonical = document.getElementById(canonicalId);
  var mirror = document.getElementById(mirrorId);
  canonical.addEventListener('input', function () { mirror.value = canonical.value; });
  mirror.addEventListener('input', function () {
    canonical.value = mirror.value;
    refreshPlanning();
    savePlanningForm();
    if (_planningMode === 'autofill') refreshRsttStalenessStatus();
  });
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('modeManual').addEventListener('click', function () { setPlanningMode('manual'); });
  document.getElementById('modeAutoFill').addEventListener('click', function () { setPlanningMode('autofill'); });
  document.getElementById('btnFetchRstt').addEventListener('click', onFetchRstt);
  document.getElementById('btnStartSight').addEventListener('click', onStartSight);
  document.getElementById('btnToDrLeg').addEventListener('click', onToDrLeg);
  document.getElementById('drLegEventSelect').addEventListener('change', updateDrLegButton);
  document.getElementById('btnCalcEventPosition').addEventListener('click', onCalcEventPosition);
  document.getElementById('btnEventPosToDrLeg').addEventListener('click', onEventPosToDrLeg);

  wireDigitBox('eventPosStartTimeH', 2, 0, 23, 'eventPosStartTimeM');
  wireDigitBox('eventPosStartTimeM', 2, 0, 59, null);
  ['eventPosStartTimeH', 'eventPosStartTimeM', 'eventPosSog', 'eventPosCourse'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', updateEventPositionButton);
  });

  // Digit-box behavior (filtering/validation/auto-advance) for every H/M pair...
  PLANNING_FIELD_IDS.forEach(function (id) {
    var hEl = document.getElementById(id + 'H');
    var mEl = document.getElementById(id + 'M');
    if (hEl && mEl) {
      wireDigitBox(id + 'H', 2, 0, 23, id + 'M');
      wireDigitBox(id + 'M', 2, 0, 59, null);
    }
  });
  // ...and for the reference-latitude magnitude boxes (Sun canonical + Moon mirror).
  ['refLatAboveSun', 'refLatBelowSun', 'refLatAboveMoon', 'refLatBelowMoon'].forEach(function (id) {
    wireDigitBox(id, 2, 0, 90, null);
  });
  wireLatMirror('refLatAboveSun', 'refLatAboveMoon');
  wireLatMirror('refLatBelowSun', 'refLatBelowMoon');

  // Recalculate + persist on every change.
  PLANNING_FIELD_IDS.forEach(function (id) {
    var hEl = document.getElementById(id + 'H');
    var mEl = document.getElementById(id + 'M');
    var elems = (hEl && mEl) ? [hEl, mEl] : [document.getElementById(id)];
    elems.forEach(function (el) {
      if (!el) return;
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        refreshPlanning();
        savePlanningForm();
        if (_planningMode === 'autofill') refreshRsttStalenessStatus();
      });
    });
  });

  document.getElementById('planDate').valueAsDate = new Date(); // default, overridden below if a saved value exists
  var restored = restorePlanningForm();
  applyPendingPlanningHandoff(); // overrides the restored/default AP above if DR Leg just sent one
  // Moon's mirrored latitude boxes aren't persisted directly (see wireLatMirror) -- sync
  // them from the just-restored (or default-empty) Sun boxes now that both exist.
  document.getElementById('refLatAboveMoon').value = document.getElementById('refLatAboveSun').value;
  document.getElementById('refLatBelowMoon').value = document.getElementById('refLatBelowSun').value;

  // Reflect the restored (or default) mode in the UI without re-saving it as a
  // fresh "change" -- setPlanningMode() below already calls refreshPlanning().
  document.getElementById('modeManual').setAttribute('aria-pressed', _planningMode === 'manual' ? 'true' : 'false');
  document.getElementById('modeAutoFill').setAttribute('aria-pressed', _planningMode === 'autofill' ? 'true' : 'false');
  document.getElementById('manualCard').style.display = _planningMode === 'manual' ? 'block' : 'none';
  document.getElementById('autoFillCard').style.display = _planningMode === 'autofill' ? 'block' : 'none';

  refreshPlanning();
  if (_planningMode === 'autofill') restoreRsttCache();
  if (!restored) savePlanningForm(); // first visit: persist the defaults so the key exists
});

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

/** Reads the AP fields into a signed-decimal {lat, lon}, or null if incomplete. */
function getPlanningPosition() {
  var latDeg = parseFloat(document.getElementById('planLatDeg').value);
  var lonDeg = parseFloat(document.getElementById('planLonDeg').value);
  if (isNaN(latDeg) || isNaN(lonDeg)) return null;
  return SightCalc.signedPositionFromRecord({
    latDeg: latDeg,
    latMin: parseFloat(document.getElementById('planLatMin').value) || 0,
    latNS: document.getElementById('planLatNS').value,
    lonDeg: lonDeg,
    lonMin: parseFloat(document.getElementById('planLonMin').value) || 0,
    lonEW: document.getElementById('planLonEW').value
  });
}

/** "HH:MM" (from <input type="time">, or a plain string like a USNO result) -> seconds-of-day, or null if blank/invalid. */
function parseHHMM(v) {
  if (!v) return null;
  var p = v.split(':');
  if (p.length < 2) return null;
  return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60;
}

/** "HH:MM" -> seconds-of-day, or null if blank. */
function parseTimeField(id) {
  return parseHHMM(getFieldValue(id));
}

/** Below/above LMT fields -> latitude-interpolated LMT (seconds-of-day), or null if either input/ref is missing. */
function interpolatedLmt(belowId, aboveId, refBelow, refAbove, apLat) {
  var tBelow = parseTimeField(belowId);
  var tAbove = parseTimeField(aboveId);
  if (tBelow === null || tAbove === null || isNaN(refBelow) || isNaN(refAbove)) return null;
  return SightCalc.interpolateByLatitude(refBelow, tBelow, refAbove, tAbove, apLat);
}

/** { zoneSec, dayOffset } -> "HH:MM" with a "(+1 day)"-style suffix if the conversion crossed a calendar day. */
/** event id -> {zoneSec, dayOffset} | null -- the structured data behind what's shown as text, needed to build an accurate Position (see updateDrLegButton/onToDrLeg) rather than re-parsing display strings. */
var _planningResults = {};

function formatResultTime(zoneSec, dayOffset) {
  var timeStr = SightCalc.secondsToTimeString(zoneSec).slice(0, 5);
  if (dayOffset === 0) return timeStr;
  return timeStr + ' (' + (dayOffset > 0 ? '+' : '') + dayOffset + ' day' + (Math.abs(dayOffset) === 1 ? '' : 's') + ')';
}

function setResult(elId, result) {
  document.getElementById(elId).textContent = result ? formatResultTime(result.zoneSec, result.dayOffset) : '--:--';
  _planningResults[elId] = result ? { zoneSec: result.zoneSec, dayOffset: result.dayOffset } : null;
}

function clearResults() {
  [
    'resSunrise', 'resSunset', 'resSunTransit',
    'resCivilTwilightAM', 'resCivilTwilightPM', 'resNauticalTwilightAM', 'resNauticalTwilightPM',
    'resMoonrise', 'resMoonset', 'resMoonTransit'
  ].forEach(function (id) {
    document.getElementById(id).textContent = '--:--';
    _planningResults[id] = null;
  });
}

function setRsttStatus(msg, kind) {
  var el = document.getElementById('rsttStatus');
  el.textContent = msg;
  el.className = 'usno-status' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------

function setPlanningMode(mode) {
  _planningMode = mode;
  document.getElementById('modeManual').setAttribute('aria-pressed', mode === 'manual' ? 'true' : 'false');
  document.getElementById('modeAutoFill').setAttribute('aria-pressed', mode === 'autofill' ? 'true' : 'false');
  document.getElementById('manualCard').style.display = mode === 'manual' ? 'block' : 'none';
  document.getElementById('autoFillCard').style.display = mode === 'autofill' ? 'block' : 'none';
  setRsttStatus('', '');
  clearResults();
  savePlanningForm();
  refreshPlanning();
  if (mode === 'autofill') restoreRsttCache();
}

// ---------------------------------------------------------------------
// Manual mode -- fully reactive, no network involved at all.
// ---------------------------------------------------------------------

/**
 * adjBelowId/adjAboveId are optional -- when both are filled in, they're
 * treated as the adjacent Greenwich date's tabulated times (following date
 * if the AP is in west longitude, preceding date if east -- see
 * applyMoonLongitudeCorrection's comment) and used to correct for the body's
 * day-to-day drift. Pass them for Moon events; omit for the Sun, whose drift
 * is negligible.
 */
function computeManualRiseSet(belowId, aboveId, refBelow, refAbove, apLat, lon, tz, adjBelowId, adjAboveId) {
  var lmt = interpolatedLmt(belowId, aboveId, refBelow, refAbove, apLat);
  if (lmt === null) return null;

  if (adjBelowId && adjAboveId) {
    var adjLmt = interpolatedLmt(adjBelowId, adjAboveId, refBelow, refAbove, apLat);
    if (adjLmt !== null) lmt = SightCalc.applyMoonLongitudeCorrection(lon, lmt, adjLmt);
  }

  return SightCalc.manualEventToZoneTime(lmt, lon, tz);
}

/** adjFieldId is optional -- see computeManualRiseSet's note on adjacent-day fields. */
function computeManualTransit(fieldId, lon, tz, adjFieldId) {
  var t = parseTimeField(fieldId);
  if (t === null) return null;
  if (adjFieldId) {
    var adj = parseTimeField(adjFieldId);
    if (adj !== null) t = SightCalc.applyMoonLongitudeCorrection(lon, t, adj);
  }
  return SightCalc.manualEventToZoneTime(t, lon, tz);
}

/**
 * Computes ONE named event's zone time (the same key names _planningResults
 * uses) at an ARBITRARY position -- the same Manual-mode pipeline
 * refreshManualResults() uses for the current AP, factored out so the
 * event-position solver (further below) can ask "what time does this event
 * happen at this position" for any position along a DR track, not just
 * whatever's currently in the AP fields. refreshManualResults() itself now
 * calls this too, for the current AP, so there's exactly one place this
 * logic lives.
 */
function computeManualEventAtPosition(eventFieldId, lat, lon, tz) {
  var latSign = lat < 0 ? -1 : 1;
  var refAbove = latSign * parseFloat(document.getElementById('refLatAboveSun').value);
  var refBelow = latSign * parseFloat(document.getElementById('refLatBelowSun').value);

  if (eventFieldId === 'resSunrise') {
    var sunriseLmt = interpolatedLmt('sunriseTimeBelow', 'sunriseTimeAbove', refBelow, refAbove, lat);
    return sunriseLmt === null ? null : SightCalc.manualEventToZoneTime(sunriseLmt, lon, tz);
  }
  if (eventFieldId === 'resSunset') {
    var sunsetLmt = interpolatedLmt('sunsetTimeBelow', 'sunsetTimeAbove', refBelow, refAbove, lat);
    return sunsetLmt === null ? null : SightCalc.manualEventToZoneTime(sunsetLmt, lon, tz);
  }
  if (eventFieldId === 'resSunTransit') {
    var transitLmt = parseTimeField('sunTransitTime');
    return transitLmt === null ? null : SightCalc.manualEventToZoneTime(transitLmt, lon, tz);
  }
  if (eventFieldId === 'resCivilTwilightAM' || eventFieldId === 'resCivilTwilightPM' ||
      eventFieldId === 'resNauticalTwilightAM' || eventFieldId === 'resNauticalTwilightPM') {
    var tTransitLmt = parseTimeField('sunTransitTime');
    if (tTransitLmt === null) return null;
    var tSunriseLmt = interpolatedLmt('sunriseTimeBelow', 'sunriseTimeAbove', refBelow, refAbove, lat);
    var tSunsetLmt = interpolatedLmt('sunsetTimeBelow', 'sunsetTimeAbove', refBelow, refAbove, lat);
    var twilight = SightCalc.computeTwilightTimes(lat, tTransitLmt, tSunriseLmt, tSunsetLmt);
    if (!twilight) return null;
    var twilightKey = { resCivilTwilightAM: 'civilAM', resCivilTwilightPM: 'civilPM', resNauticalTwilightAM: 'nauticalAM', resNauticalTwilightPM: 'nauticalPM' }[eventFieldId];
    var twilightSec = twilight[twilightKey];
    return (twilightSec === null || twilightSec === undefined) ? null : SightCalc.manualEventToZoneTime(twilightSec, lon, tz);
  }
  if (eventFieldId === 'resMoonrise') return computeManualRiseSet('moonriseTimeBelow', 'moonriseTimeAbove', refBelow, refAbove, lat, lon, tz, 'moonriseTimeBelowAdj', 'moonriseTimeAboveAdj');
  if (eventFieldId === 'resMoonset') return computeManualRiseSet('moonsetTimeBelow', 'moonsetTimeAbove', refBelow, refAbove, lat, lon, tz, 'moonsetTimeBelowAdj', 'moonsetTimeAboveAdj');
  if (eventFieldId === 'resMoonTransit') return computeManualTransit('moonTransitTime', lon, tz, 'moonTransitTimeAdj');
  return null;
}

function refreshManualResults() {
  var pos = getPlanningPosition();
  if (!pos) { clearResults(); return; }

  var tz = parseFloat(document.getElementById('planTzOffset').value) || 0;

  [
    'resSunrise', 'resSunset', 'resSunTransit',
    'resCivilTwilightAM', 'resCivilTwilightPM', 'resNauticalTwilightAM', 'resNauticalTwilightPM',
    'resMoonrise', 'resMoonset', 'resMoonTransit'
  ].forEach(function (eventFieldId) {
    setResult(eventFieldId, computeManualEventAtPosition(eventFieldId, pos.lat, pos.lon, tz));
  });
}

// ---------------------------------------------------------------------
// Auto-fill mode -- one explicit, user-triggered USNO request; never reactive.
// ---------------------------------------------------------------------

/** Renders a USNO fetch result (fresh or restored from cache) into the result spans. */
/** Sets an auto-fill result's displayed text AND stashes the equivalent structured data into _planningResults (dayOffset always 0 -- USNO's fetch is scoped to exactly the requested calendar date, no rollover to track). */
function setRsttResultText(elId, text) {
  document.getElementById(elId).textContent = text;
  var sec = parseHHMM(text);
  _planningResults[elId] = (sec === null) ? null : { zoneSec: sec, dayOffset: 0 };
}

function renderRsttResult(pos, result) {
  setRsttResultText('resSunrise', result.sunrise || 'Does not occur');
  setRsttResultText('resSunset', result.sunset || 'Does not occur');
  setRsttResultText('resCivilTwilightAM', result.civilTwilightAM || 'Does not occur');
  setRsttResultText('resCivilTwilightPM', result.civilTwilightPM || 'Does not occur');
  setRsttResultText('resSunTransit', result.sunTransit || 'Does not occur');
  setRsttResultText('resMoonrise', result.moonrise || 'Does not occur');
  setRsttResultText('resMoonset', result.moonset || 'Does not occur');
  setRsttResultText('resMoonTransit', result.moonTransit || 'Does not occur');

  // USNO's rstt/oneday service doesn't report Nautical Twilight at all, so it's
  // derived from the Sun data it DOES report (same approach as manual mode).
  var transitSec = parseHHMM(result.sunTransit);
  var twilight = transitSec === null ? null : SightCalc.computeTwilightTimes(pos.lat, transitSec, parseHHMM(result.sunrise), parseHHMM(result.sunset));
  var fmt = function (sec) { return (sec === null || sec === undefined) ? null : SightCalc.secondsToTimeString(sec).slice(0, 5); };
  setRsttResultText('resNauticalTwilightAM', (twilight && fmt(twilight.nauticalAM)) || 'Does not occur');
  setRsttResultText('resNauticalTwilightPM', (twilight && fmt(twilight.nauticalPM)) || 'Does not occur');

  updateDrLegButton();
}

/** True if a cached fetch's inputs still match what's currently in the form. */
function rsttCacheMatchesCurrentInputs(cached, pos, dateVal, tz) {
  return !!cached && !!pos &&
    cached.date === dateVal && cached.tz === tz &&
    Math.abs(cached.lat - pos.lat) < 1e-6 && Math.abs(cached.lon - pos.lon) < 1e-6;
}

/** Re-checks whether the cached USNO fetch still matches the current form inputs, and updates the status line. Safe to call anytime; no-ops if nothing has ever been fetched this session. */
function refreshRsttStalenessStatus() {
  if (!hasPlanningStorage()) return;
  var cached = PlanningStorage.loadRsttCache();
  if (!cached) return;

  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tz = parseFloat(document.getElementById('planTzOffset').value) || 0;

  if (rsttCacheMatchesCurrentInputs(cached, pos, dateVal, tz)) {
    setRsttStatus('Fetched from USNO.', 'ok');
  } else {
    setRsttStatus('Showing last USNO fetch (' + cached.date + ', ' + cached.lat.toFixed(2) + ', ' + cached.lon.toFixed(2) + '). Date or position has changed since -- fetch again to update.', 'loading');
  }
}

/** On page load (or switching into Auto-fill mode), show the last USNO fetch from this session, if any. */
function restoreRsttCache() {
  if (!hasPlanningStorage()) return;
  var cached = PlanningStorage.loadRsttCache();
  if (!cached) return;

  // Render with whatever position the fetch was actually made for, even if the
  // form has since changed -- the result text came from that position/date.
  renderRsttResult({ lat: cached.lat, lon: cached.lon }, cached.result);
  refreshRsttStalenessStatus();
}

function onFetchRstt() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tz = parseFloat(document.getElementById('planTzOffset').value) || 0;

  if (!pos || !dateVal) {
    setRsttStatus('Enter the date and assumed position first.', 'error');
    return;
  }

  var btn = document.getElementById('btnFetchRstt');
  btn.disabled = true;
  setRsttStatus('Checking USNO\u2026', 'loading');

  SightUsno.fetchRiseSetTransit(dateVal, pos.lat, pos.lon, tz)
    .then(function (result) {
      renderRsttResult(pos, result);
      if (hasPlanningStorage()) {
        PlanningStorage.saveRsttCache({ date: dateVal, lat: pos.lat, lon: pos.lon, tz: tz, result: result });
      }
      setRsttStatus('Fetched from USNO.', 'ok');
    })
    .catch(function (err) {
      console.error(err);
      setRsttStatus(err && err.message ? err.message : 'Could not fetch data from USNO.', 'error');
    })
    .finally(function () {
      btn.disabled = false;
    });
}

// ---------------------------------------------------------------------
// Master refresh + AP handoff to index.html
// ---------------------------------------------------------------------

function refreshPlanning() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tzEntered = document.getElementById('planTzOffset').value.trim() !== '';

  document.getElementById('btnStartSight').disabled = !(pos && dateVal && tzEntered);
  document.getElementById('btnFetchRstt').disabled = !(pos && dateVal);

  if (_planningMode === 'manual') refreshManualResults();
  // Auto-fill results only ever populate from an explicit button click.
  updateDrLegButton();
  updateEventPositionButton();
}

/**
 * Sends the current AP plus the currently-selected event's computed time to
 * DR Leg as its start position (sessionStorage key 'ocsrDrLegStartHandoff',
 * same shape fixes.html's "Send to DR Leg" already uses -- see
 * applyPendingDrLegStartHandoff in js/drleg.js). Uses the structured
 * {zoneSec, dayOffset} behind the displayed text (see _planningResults),
 * not a re-parse of it, so a rollover like a post-midnight moonset still
 * lands on the correct calendar date.
 */
function updateDrLegButton() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tzOffset = parseFloat(document.getElementById('planTzOffset').value);
  var r = _planningResults[document.getElementById('drLegEventSelect').value];
  document.getElementById('btnToDrLeg').disabled = !(pos && dateVal && !isNaN(tzOffset) && r);
}

function onToDrLeg() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tzOffset = parseFloat(document.getElementById('planTzOffset').value);
  var r = _planningResults[document.getElementById('drLegEventSelect').value];
  if (!pos || !dateVal || isNaN(tzOffset) || !r) return;

  var utcMs = SightCalc.localDateTimeToUtcMs(dateVal, 0, tzOffset) + r.dayOffset * 86400000 + r.zoneSec * 1000;
  // sourceId stays null: Planning's AP is a hand-entered field with no
  // record of its own to point back to (unlike a Fix, which always has a
  // stable id by the time it resolves a position).
  var position = SightCalc.makePosition(new Date(utcMs).toISOString(), pos.lat, pos.lon, SightCalc.POSITION_SOURCE_TYPES.KNOWN, null);
  sessionStorage.setItem('ocsrDrLegStartHandoff', JSON.stringify({ position: position, tzOffset: tzOffset, sentFrom: 'Planning' }));
  location.href = 'drleg.html';
}

/**
 * Auto-fill's equivalent of computeManualEventAtPosition: extracts ONE
 * named event's zone time from a raw USNO rstt/oneday response (see
 * renderRsttResult, which this factors the same mapping out of). lat is
 * only needed for the derived Nautical Twilight case (computeTwilightTimes
 * needs it; USNO's response itself doesn't report Nautical Twilight at
 * all -- see fetchRiseSetTransit's own comment on this).
 */
function computeAutofillEventAtPosition(eventFieldId, rsttResult, lat) {
  var directField = {
    resSunrise: 'sunrise', resSunset: 'sunset', resSunTransit: 'sunTransit',
    resCivilTwilightAM: 'civilTwilightAM', resCivilTwilightPM: 'civilTwilightPM',
    resMoonrise: 'moonrise', resMoonset: 'moonset', resMoonTransit: 'moonTransit'
  }[eventFieldId];
  if (directField) {
    var sec = parseHHMM(rsttResult[directField]);
    return sec === null ? null : { zoneSec: sec, dayOffset: 0 };
  }
  var transitSec = parseHHMM(rsttResult.sunTransit);
  if (transitSec === null) return null;
  var twilight = SightCalc.computeTwilightTimes(lat, transitSec, parseHHMM(rsttResult.sunrise), parseHHMM(rsttResult.sunset));
  if (!twilight) return null;
  var twilightKey = { resNauticalTwilightAM: 'nauticalAM', resNauticalTwilightPM: 'nauticalPM' }[eventFieldId];
  var twilightSec = twilight[twilightKey];
  return (twilightSec === null || twilightSec === undefined) ? null : { zoneSec: twilightSec, dayOffset: 0 };
}

/**
 * Builds the getEventTimeAtDuration callback SightCalc.solveEventPosition
 * needs, for Manual mode: a synchronous, purely local function, since
 * Manual mode's almanac interpolation already has everything it needs
 * without any network involvement. Position at each duration comes from
 * SightCalc.drPosition (the same DR math the DR Leg page itself uses via
 * computeDrLeg); the event's time at that position reuses
 * computeManualEventAtPosition unchanged -- exactly what the Results box
 * already computes for the current AP, just repeated at wherever the DR
 * track has gotten to.
 */
function buildManualEventTimeAtDuration(eventFieldId, startLatDeg, startLonDeg, courseDegTrue, sog, tz) {
  return function (durationHours) {
    var pos = SightCalc.drPosition(startLatDeg, startLonDeg, courseDegTrue, sog * durationHours);
    return computeManualEventAtPosition(eventFieldId, pos.latDeg, pos.lonDeg, tz);
  };
}

/**
 * Builds the same kind of callback for Auto-fill mode -- but since USNO
 * answers for one exact lat/lon at a time (unlike Manual mode's built-in
 * latitude interpolation), it can't be called fresh on every solver
 * iteration without hammering the network. Instead: fetch USNO ONCE at
 * the starting position (giving a first rough duration estimate -- the
 * fixed-point method's own first guess, computed here rather than inside
 * the solver, precisely so it can double as this acquire step's own
 * target for the second sample) and ONCE more at the position that
 * estimate implies, then build a straight-line model between those two
 * samples. The solve itself then runs entirely against that local model,
 * with no further network calls. Works entirely in absolute UTC
 * milliseconds internally (rather than juggling separate zoneSec/dayOffset
 * pairs relative to two different dates) specifically to avoid a subtle
 * class of bug: the second sample's own calendar date, in zone time, can
 * differ from the first if the rough estimate spans into the next day,
 * and mixing "dayOffset relative to date A" with "dayOffset relative to
 * date B" without a common absolute axis is exactly how that kind of
 * error creeps in unnoticed.
 *
 * Returns a Promise resolving to the callback, or to null if the event
 * does not occur at the starting position/date at all (checked upfront so
 * the caller can report that plainly rather than the solver discovering
 * it less directly).
 */
function acquireAutofillEventTimeAtDuration(eventFieldId, startLatDeg, startLonDeg, startZoneSec, dateVal, tz, courseDegTrue, sog) {
  function fetchEventAbsoluteMs(dateStr, lat, lon) {
    return SightUsno.fetchRiseSetTransit(dateStr, lat, lon, tz).then(function (result) {
      var event = computeAutofillEventAtPosition(eventFieldId, result, lat);
      if (!event) return null;
      return SightCalc.localDateTimeToUtcMs(dateStr, event.zoneSec, tz) + event.dayOffset * 86400000;
    });
  }

  function nextCalendarDateStr(dateStr) {
    // Midnight of dateStr (in zone time), plus 24 real hours, converted
    // back to a zone-time date string -- not a plain calendar-string
    // increment, so this still lands correctly across a DST-style zone
    // change if tzOffset itself changes (this app takes a fixed numeric
    // offset per leg, but the arithmetic stays correct either way since
    // it's anchored to an absolute instant, not to string manipulation).
    return SightCalc.utcMsToLocalDateTime(SightCalc.localDateTimeToUtcMs(dateStr, 0, tz) + 86400000, tz).dateStr;
  }

  // The event fetched for a given calendar date might already be earlier
  // than afterUtcMs -- an entirely ordinary case (e.g. asking for the next
  // sunset from an evening start, or the next moonrise from just after
  // this morning's). When that happens, the actual next occurrence is on
  // the FOLLOWING date instead; Auto-fill mode can simply ask USNO for
  // that date directly (unlike Manual mode, which only has one date's
  // worth of typed-in almanac data and genuinely cannot answer this).
  // Bounded to one retry: a normal DR-leg-scale question never needs more,
  // and further retries would risk masking a real polar day/night case as
  // a slow, silent chain of fetches instead of a clear answer.
  function fetchNextOccurrence(dateStr, lat, lon, afterUtcMs) {
    return fetchEventAbsoluteMs(dateStr, lat, lon).then(function (absMs) {
      if (absMs !== null && absMs >= afterUtcMs) return absMs;
      var nextDateStr = nextCalendarDateStr(dateStr);
      return fetchEventAbsoluteMs(nextDateStr, lat, lon);
    });
  }

  var startUtcMs = SightCalc.localDateTimeToUtcMs(dateVal, startZoneSec, tz);

  return fetchNextOccurrence(dateVal, startLatDeg, startLonDeg, startUtcMs).then(function (t0AbsoluteMs) {
    if (t0AbsoluteMs === null) return null;

    var d0Hours = (t0AbsoluteMs - startUtcMs) / 3600000;
    // The second sample point to fetch -- if the first guess already
    // implies a negative or wildly long duration, sampling right back at
    // the start is a safe, harmless fallback; the caller's
    // solveEventPosition call surfaces the real problem either way, this
    // acquire step doesn't need to pre-empt it.
    var sampleHours = (d0Hours > 0 && d0Hours < 120) ? d0Hours : 1;
    var pos1 = SightCalc.drPosition(startLatDeg, startLonDeg, courseDegTrue, sog * sampleHours);
    var sampleUtcMs = startUtcMs + sampleHours * 3600000;
    var sampleLocal = SightCalc.utcMsToLocalDateTime(sampleUtcMs, tz);

    return fetchNextOccurrence(sampleLocal.dateStr, pos1.latDeg, pos1.lonDeg, startUtcMs).then(function (t1AbsoluteMs) {
      if (t1AbsoluteMs === null) return null;

      var slopeMsPerHour = (t1AbsoluteMs - t0AbsoluteMs) / sampleHours;
      var startOfDateValMs = SightCalc.localDateTimeToUtcMs(dateVal, 0, tz);

      return function (durationHours) {
        var eventAbsoluteMs = t0AbsoluteMs + slopeMsPerHour * durationHours;
        var local = SightCalc.utcMsToLocalDateTime(eventAbsoluteMs, tz);
        var dayOffset = Math.round((SightCalc.localDateTimeToUtcMs(local.dateStr, 0, tz) - startOfDateValMs) / 86400000);
        return { zoneSec: local.secOfDay, dayOffset: dayOffset };
      };
    });
  });
}

// ---------------------------------------------------------------------
// "Where will I be at this event?" -- the event-position solver's UI
// ---------------------------------------------------------------------

var _lastEventPositionResult = null; // cached for onEventPosToDrLeg -- see its own comment

function setEventPositionStatus(msg, kind) {
  var el = document.getElementById('eventPositionStatus');
  el.textContent = msg;
  el.className = 'usno-status' + (kind ? ' ' + kind : '');
  el.style.display = msg ? 'block' : 'none';
}

function updateEventPositionButton() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tz = parseFloat(document.getElementById('planTzOffset').value);
  var startZoneSec = parseHHMM(getFieldValue('eventPosStartTime'));
  var sog = parseFloat(document.getElementById('eventPosSog').value);
  var course = parseFloat(document.getElementById('eventPosCourse').value);
  document.getElementById('btnCalcEventPosition').disabled =
    !(pos && dateVal && !isNaN(tz) && startZoneSec !== null && !isNaN(sog) && !isNaN(course));
}

function onCalcEventPosition() {
  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  var tz = parseFloat(document.getElementById('planTzOffset').value);
  var startZoneSec = parseHHMM(getFieldValue('eventPosStartTime'));
  var sog = parseFloat(document.getElementById('eventPosSog').value);
  var course = parseFloat(document.getElementById('eventPosCourse').value);
  var eventFieldId = document.getElementById('drLegEventSelect').value;
  if (!pos || !dateVal || isNaN(tz) || startZoneSec === null || isNaN(sog) || isNaN(course)) return;

  document.getElementById('eventPositionResult').style.display = 'none';
  _lastEventPositionResult = null;

  // Manual mode's callback is built and ready synchronously (no network
  // involved at all); Auto-fill's needs its own acquire phase first (see
  // acquireAutofillEventTimeAtDuration's own comment) -- wrapping the
  // synchronous case in Promise.resolve lets both paths share the same
  // .then() below rather than branching the whole rest of this function.
  var callbackPromise;
  if (_planningMode === 'manual') {
    setEventPositionStatus('', '');
    callbackPromise = Promise.resolve(buildManualEventTimeAtDuration(eventFieldId, pos.lat, pos.lon, course, sog, tz));
  } else {
    setEventPositionStatus('Fetching from USNO\u2026', 'loading');
    callbackPromise = acquireAutofillEventTimeAtDuration(eventFieldId, pos.lat, pos.lon, startZoneSec, dateVal, tz, course, sog);
  }

  callbackPromise.then(function (getEventTimeAtDuration) {
    if (!getEventTimeAtDuration) {
      setEventPositionStatus('This event does not occur at the starting position on this date.', 'error');
      return;
    }
    var result = SightCalc.solveEventPosition(startZoneSec, getEventTimeAtDuration);
    renderEventPositionResult(result, pos, dateVal, tz, course, sog, eventFieldId, startZoneSec);
  }).catch(function (err) {
    console.error(err);
    setEventPositionStatus(err && err.message ? err.message : 'Could not fetch data from USNO.', 'error');
  });
}

function renderEventPositionResult(result, startPos, dateVal, tz, course, sog, eventFieldId, startZoneSec) {
  if (!result.solved) {
    var messages = {
      'no-event': 'This event does not occur along this track.',
      'already-passed': 'This event\u2019s next occurrence, even from the unmoved starting position, is earlier than the start time \u2014 try a later start time or a different event.',
      'no-convergence': 'Could not find a stable answer. This can happen at very high latitudes, or near a seasonal boundary where this event\u2019s timing changes very quickly with position.'
    };
    setEventPositionStatus(messages[result.reason] || 'Could not calculate this.', 'error');
    return;
  }
  setEventPositionStatus('', '');

  var finalPos = SightCalc.drPosition(startPos.lat, startPos.lon, course, sog * result.durationHours);
  var eventLabel = document.getElementById('drLegEventSelect').selectedOptions[0].textContent;

  document.getElementById('eventPosResultTitle').textContent = eventLabel + ' ' + formatResultTime(result.eventZoneSec, result.eventDayOffset);
  document.getElementById('eventPosResultPosition').textContent = SightCalc.formatLat(finalPos.latDeg) + ', ' + SightCalc.formatLon(finalPos.lonDeg);

  var hours = Math.floor(result.durationHours);
  var minutes = Math.round((result.durationHours - hours) * 60);
  if (minutes === 60) { hours += 1; minutes = 0; }
  document.getElementById('eventPosResultDuration').textContent = hours + 'h ' + minutes + 'm';
  document.getElementById('eventPosResultCourseSpeed').textContent = String(Math.round(course)).padStart(3, '0') + '\u00B0T @ ' + sog + ' kn';
  document.getElementById('eventPosResultConverged').textContent = 'Converged in ' + result.iterations + ' iteration' + (result.iterations === 1 ? '' : 's') + '.';

  document.getElementById('eventPositionResult').style.display = 'block';

  _lastEventPositionResult = { result: result, startPos: startPos, dateVal: dateVal, tz: tz, course: course, sog: sog, startZoneSec: startZoneSec };
}

/**
 * Sends the solved leg to DR Leg as a COMPLETE leg (start, course, speed,
 * duration) -- not just a start position, which is what the existing
 * "Send AP + event time" button above sends. See applyPendingSolvedLegHandoff
 * in js/drleg.js for the receiving side. sourceId stays null: like
 * onToDrLeg's own handoff, Planning's AP is a hand-entered field with no
 * record of its own to point back to.
 */
function onEventPosToDrLeg() {
  var r = _lastEventPositionResult;
  if (!r || !r.result.solved) return;

  var startUtcMs = SightCalc.localDateTimeToUtcMs(r.dateVal, r.startZoneSec, r.tz);
  var startPosition = SightCalc.makePosition(new Date(startUtcMs).toISOString(), r.startPos.lat, r.startPos.lon, SightCalc.POSITION_SOURCE_TYPES.KNOWN, null);

  var handoff = {
    startPosition: startPosition,
    tzOffset: r.tz,
    sog: r.sog,
    courseDegTrue: r.course,
    durationHours: r.result.durationHours,
    sentFrom: 'Planning'
  };
  sessionStorage.setItem('ocsrSolvedLegHandoff', JSON.stringify(handoff));
  location.href = 'drleg.html';
}

function onStartSight() {

  var pos = getPlanningPosition();
  var dateVal = document.getElementById('planDate').value;
  if (!pos || !dateVal) return;

  var handoff = {
    date: dateVal,
    tzOffset: document.getElementById('planTzOffset').value,
    latDeg: document.getElementById('planLatDeg').value,
    latMin: document.getElementById('planLatMin').value,
    latNS: document.getElementById('planLatNS').value,
    lonDeg: document.getElementById('planLonDeg').value,
    lonMin: document.getElementById('planLonMin').value,
    lonEW: document.getElementById('planLonEW').value
  };
  sessionStorage.setItem('ocsrApHandoff', JSON.stringify(handoff));
  location.href = 'index.html';
}
