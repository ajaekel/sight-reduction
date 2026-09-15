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
 * the existing DR-Leg-to-New-Sighting / Planning-to-New-Sighting handoff
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

function refreshManualResults() {
  var pos = getPlanningPosition();
  if (!pos) { clearResults(); return; }

  var tz = parseFloat(document.getElementById('planTzOffset').value) || 0;

  // Reference latitude bands are entered as a plain 0-90 magnitude (matching the
  // almanac page) -- the hemisphere is inferred from the AP's own latitude, since
  // a real navigator wouldn't be reading a band from the opposite hemisphere.
  var latSign = pos.lat < 0 ? -1 : 1;
  var refAbove = latSign * parseFloat(document.getElementById('refLatAboveSun').value);
  var refBelow = latSign * parseFloat(document.getElementById('refLatBelowSun').value);

  var sunriseLmt = interpolatedLmt('sunriseTimeBelow', 'sunriseTimeAbove', refBelow, refAbove, pos.lat);
  var sunsetLmt = interpolatedLmt('sunsetTimeBelow', 'sunsetTimeAbove', refBelow, refAbove, pos.lat);
  var transitLmt = parseTimeField('sunTransitTime');

  setResult('resSunrise', sunriseLmt === null ? null : SightCalc.manualEventToZoneTime(sunriseLmt, pos.lon, tz));
  setResult('resSunset', sunsetLmt === null ? null : SightCalc.manualEventToZoneTime(sunsetLmt, pos.lon, tz));
  setResult('resSunTransit', transitLmt === null ? null : SightCalc.manualEventToZoneTime(transitLmt, pos.lon, tz));

  // Civil/Nautical Twilight are derived from the Sun data already entered above
  // (see calc.js's computeTwilightTimes) -- no separate almanac lookup needed.
  var twilight = transitLmt === null ? null : SightCalc.computeTwilightTimes(pos.lat, transitLmt, sunriseLmt, sunsetLmt);
  var toZone = function (sec) { return sec === null || sec === undefined ? null : SightCalc.manualEventToZoneTime(sec, pos.lon, tz); };
  setResult('resCivilTwilightAM', twilight ? toZone(twilight.civilAM) : null);
  setResult('resCivilTwilightPM', twilight ? toZone(twilight.civilPM) : null);
  setResult('resNauticalTwilightAM', twilight ? toZone(twilight.nauticalAM) : null);
  setResult('resNauticalTwilightPM', twilight ? toZone(twilight.nauticalPM) : null);

  setResult('resMoonrise', computeManualRiseSet('moonriseTimeBelow', 'moonriseTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz, 'moonriseTimeBelowAdj', 'moonriseTimeAboveAdj'));
  setResult('resMoonset', computeManualRiseSet('moonsetTimeBelow', 'moonsetTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz, 'moonsetTimeBelowAdj', 'moonsetTimeAboveAdj'));
  setResult('resMoonTransit', computeManualTransit('moonTransitTime', pos.lon, tz, 'moonTransitTimeAdj'));
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
