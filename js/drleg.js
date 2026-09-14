/**
 * drleg.js
 * Dead Reckoning leg calculator. All the actual math (mid-latitude sailing,
 * local<->UTC date/time arithmetic) lives in calc.js as pure functions; this
 * file only reads the form, calls into SightCalc, and renders the result.
 *
 * Mirrors planning.js's conventions on purpose (time-box H/M pairs instead
 * of native <input type="time">, live recalculation on every input, a
 * localStorage-backed form that survives navigating away and back) since
 * this is the same kind of "before you start observing" planning tool.
 */

var _drMode = 'duration'; // 'duration' | 'endtime'

// Provenance of the START position -- 'KNOWN' unless it was carried in from
// chaining a previous leg (see onChainLeg), in which case it's 'DR'. Reset
// to 'KNOWN' the moment the person actually edits a start field by hand
// (see the DR_START_FIELD_IDS wiring below) -- editing implies they're
// overriding it with a value they're now vouching for directly.
var _drStartPositionType = 'KNOWN';

/** Every logical field whose value should survive navigating away and back. Time fields map to id+'H'/id+'M' -- see getFieldValue/setFieldValue. */
var DRLEG_FIELD_IDS = [
  'drStartDate', 'drStartTime', 'drTzOffset',
  'drLatDeg', 'drLatMin', 'drLatNS', 'drLonDeg', 'drLonMin', 'drLonEW',
  'drSog', 'drCourse',
  'drDurationHours', 'drDurationMinutes',
  'drEndDate', 'drEndTime'
];

/** The subset of the above that define the START position's identity -- editing any of these by hand means it's no longer a carried-over DR position (see _drStartPositionType). */
var DR_START_FIELD_IDS = [
  'drStartDate', 'drStartTime', 'drLatDeg', 'drLatMin', 'drLatNS', 'drLonDeg', 'drLonMin', 'drLonEW'
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

/** "HH:MM" -> seconds-of-day, or null if blank/invalid. */
function parseHHMM(v) {
  if (!v) return null;
  var p = v.split(':');
  if (p.length < 2) return null;
  var h = parseInt(p[0], 10), m = parseInt(p[1], 10);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 3600 + m * 60;
}

function parseTimeField(id) {
  return parseHHMM(getFieldValue(id));
}

/** Digit-only filtering, optional range validation (via .input-error), and auto-advance to nextId once full (if maxLen given). */
function wireDigitBox(id, maxLen, min, max, nextId) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', function () { this.select(); });
  el.addEventListener('input', function () {
    var cleaned = maxLen ? this.value.replace(/[^0-9]/g, '').slice(0, maxLen) : this.value.replace(/[^0-9]/g, '');
    if (cleaned !== this.value) this.value = cleaned;
    if (min !== null && max !== null) {
      var n = parseInt(cleaned, 10);
      this.classList.toggle('input-error', cleaned !== '' && (isNaN(n) || n < min || n > max));
    }
    if (maxLen && cleaned.length >= maxLen && nextId) {
      var nextEl = document.getElementById(nextId);
      if (nextEl) { nextEl.focus(); nextEl.select(); }
    }
  });
}

function getDrPosition() {
  var latDeg = parseFloat(document.getElementById('drLatDeg').value);
  var lonDeg = parseFloat(document.getElementById('drLonDeg').value);
  if (isNaN(latDeg) || isNaN(lonDeg)) return null;
  return SightCalc.signedPositionFromRecord({
    latDeg: latDeg,
    latMin: parseFloat(document.getElementById('drLatMin').value) || 0,
    latNS: document.getElementById('drLatNS').value,
    lonDeg: lonDeg,
    lonMin: parseFloat(document.getElementById('drLonMin').value) || 0,
    lonEW: document.getElementById('drLonEW').value
  });
}

function setStatus(msg, kind) {
  var el = document.getElementById('drStatus');
  el.textContent = msg;
  el.className = 'usno-status' + (kind ? ' ' + kind : '');
}

function resetResults() {
  document.getElementById('resDrLat').textContent = "--\u00B0 --.-'";
  document.getElementById('resDrLon').textContent = "--\u00B0 --.-'";
  document.getElementById('resDistance').textContent = '--.- nm';
  document.getElementById('resDuration').textContent = '--h --m';
  document.getElementById('resArrival').textContent = '----\u2011--\u2011-- --:--';
  document.getElementById('btnToSighting').disabled = true;
  document.getElementById('btnToPlanning').disabled = true;
  document.getElementById('btnChainLeg').disabled = true;
  document.getElementById('btnSaveLeg').disabled = true;
  window._lastDrResult = null;
}

function setDrMode(mode) {
  _drMode = mode;
  document.getElementById('modeDuration').setAttribute('aria-pressed', mode === 'duration' ? 'true' : 'false');
  document.getElementById('modeEndTime').setAttribute('aria-pressed', mode === 'endtime' ? 'true' : 'false');
  document.getElementById('durationCard').style.display = mode === 'duration' ? 'block' : 'none';
  document.getElementById('endTimeCard').style.display = mode === 'endtime' ? 'block' : 'none';
  saveForm();
  recompute();
}

function recompute() {
  setStatus('', '');

  var pos = getDrPosition();
  var dateVal = document.getElementById('drStartDate').value;
  var startSec = parseTimeField('drStartTime');
  var tzOffset = parseFloat(document.getElementById('drTzOffset').value);

  if (!pos || !dateVal || startSec === null || isNaN(tzOffset)) {
    resetResults();
    return;
  }

  var sog = parseFloat(document.getElementById('drSog').value);
  var course = parseFloat(document.getElementById('drCourse').value);
  if (isNaN(sog) || sog < 0) {
    resetResults();
    if (document.getElementById('drSog').value !== '') setStatus('SOG must be zero or greater.', 'error');
    return;
  }
  if (isNaN(course) || course < 0 || course > 360) {
    resetResults();
    if (document.getElementById('drCourse').value !== '') setStatus('Course must be between 0 and 360 degrees.', 'error');
    return;
  }

  var startUtcMs = SightCalc.localDateTimeToUtcMs(dateVal, startSec, tzOffset);
  var durationHours = null;
  var endUtcMs = null;

  if (_drMode === 'duration') {
    var hoursVal = document.getElementById('drDurationHours').value;
    var minutesVal = document.getElementById('drDurationMinutes').value;
    if (hoursVal === '' && minutesVal === '') { resetResults(); return; }
    var hours = parseInt(hoursVal, 10) || 0;
    var minutes = parseInt(minutesVal, 10) || 0;
    durationHours = hours + minutes / 60;
  } else {
    var endDateVal = document.getElementById('drEndDate').value;
    var endSec = parseTimeField('drEndTime');
    if (!endDateVal || endSec === null) { resetResults(); return; }
    endUtcMs = SightCalc.localDateTimeToUtcMs(endDateVal, endSec, tzOffset);
  }

  var leg = SightCalc.computeDrLeg({
    startLatDeg: pos.lat,
    startLonDeg: pos.lon,
    startUtcMs: startUtcMs,
    sog: sog,
    courseDegTrue: course,
    durationHours: durationHours,
    endUtcMs: endUtcMs
  });

  if (leg.durationHours < 0) {
    resetResults();
    setStatus('End date/time must be after the start date/time.', 'error');
    return;
  }

  document.getElementById('resDrLat').textContent = SightCalc.formatLat(leg.latDeg);
  document.getElementById('resDrLon').textContent = SightCalc.formatLon(leg.lonDeg);
  document.getElementById('resDistance').textContent = leg.distanceNM.toFixed(1) + ' nm';

  var durH = Math.floor(leg.durationHours);
  var durM = Math.round((leg.durationHours - durH) * 60);
  if (durM === 60) { durH += 1; durM = 0; }
  document.getElementById('resDuration').textContent = durH + 'h ' + durM + 'm';

  var arrival = SightCalc.utcMsToLocalDateTime(leg.endUtcMs, tzOffset);
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  var arrH = Math.floor(arrival.secOfDay / 3600);
  var arrM = Math.floor((arrival.secOfDay % 3600) / 60);
  document.getElementById('resArrival').textContent = arrival.dateStr + ' ' + pad2(arrH) + ':' + pad2(arrM);

  // The full domain-model result: a start Position (provenance tracked in
  // _drStartPositionType) and an end Position (always DR-derived), plus the
  // inputs that produced it. This is what feeds the handoffs, chaining, and
  // "Save Leg" -- see docs/passage-design.md's DrLeg model.
  window._lastDrResult = {
    startPosition: SightCalc.makePosition(new Date(startUtcMs).toISOString(), pos.lat, pos.lon, _drStartPositionType),
    endPosition: SightCalc.makePosition(new Date(leg.endUtcMs).toISOString(), leg.latDeg, leg.lonDeg, SightCalc.POSITION_TYPES.DR),
    sog: sog,
    courseDegTrue: course,
    durationHours: leg.durationHours,
    distanceNM: leg.distanceNM,
    tzOffset: tzOffset
  };
  document.getElementById('btnToSighting').disabled = false;
  document.getElementById('btnToPlanning').disabled = false;
  document.getElementById('btnChainLeg').disabled = false;
  document.getElementById('btnSaveLeg').disabled = false;

  saveForm();
}

function saveForm() {
  var data = { mode: _drMode, startPositionType: _drStartPositionType, fields: {} };
  DRLEG_FIELD_IDS.forEach(function (id) {
    data.fields[id] = getFieldValue(id);
  });
  DrLegStorage.saveForm(data);
}

function restoreForm() {
  var data = DrLegStorage.loadForm();
  if (!data || !data.fields) return false;
  DRLEG_FIELD_IDS.forEach(function (id) {
    if (Object.prototype.hasOwnProperty.call(data.fields, id) && data.fields[id]) {
      setFieldValue(id, data.fields[id]);
    }
  });
  if (data.mode === 'duration' || data.mode === 'endtime') _drMode = data.mode;
  if (data.startPositionType === 'KNOWN' || data.startPositionType === 'DR') _drStartPositionType = data.startPositionType;
  return true;
}

/** Position -> {latDeg, latMin, latNS, lonDeg, lonMin, lonEW} for writing into deg/min/hemisphere form fields. */
function positionToDegMinFields(position) {
  var latAbs = Math.abs(position.lat);
  var lonAbs = Math.abs(position.lon);
  var latDM = SightCalc.decimalToDM(latAbs);
  var lonDM = SightCalc.decimalToDM(lonAbs);
  return {
    latDeg: String(latDM.deg), latMin: latDM.min.toFixed(1), latNS: position.lat < 0 ? 'S' : 'N',
    lonDeg: String(lonDM.deg), lonMin: lonDM.min.toFixed(1), lonEW: position.lon < 0 ? 'W' : 'E'
  };
}

/**
 * New Sighting handoff: the rich, Position-aware shape, since index.html
 * has somewhere meaningful to put an exact time (the first observation
 * line) -- see docs/passage-design.md section 8, prerequisite 3. Note this
 * is a convenience prefill, not a correctness fix: the AP itself never
 * needed a time (reduceSight only reads the observation's own clock time),
 * it's just a time-saver for the common "DR to an event, then observe"
 * workflow.
 */
function buildSightingHandoff() {
  var r = window._lastDrResult;
  if (!r) return null;
  return { position: r.endPosition, tzOffset: r.tzOffset };
}

/**
 * Planning handoff: kept in the older simple shape on purpose. Planning's
 * own fields have no specific time-of-day to receive precision into (its
 * "date" is a whole-day concept, used to look up that day's events) -- so
 * there's nowhere for the extra precision to go yet. Still sourced from the
 * same endPosition, just formatted the way Planning already expects.
 */
function buildPlanningHandoff() {
  var r = window._lastDrResult;
  if (!r) return null;
  var local = SightCalc.utcMsToLocalDateTime(new Date(r.endPosition.time).getTime(), r.tzOffset);
  var dm = positionToDegMinFields(r.endPosition);
  return {
    date: local.dateStr,
    tzOffset: String(r.tzOffset),
    latDeg: dm.latDeg, latMin: dm.latMin, latNS: dm.latNS,
    lonDeg: dm.lonDeg, lonMin: dm.lonMin, lonEW: dm.lonEW
  };
}

function onToSighting() {
  var handoff = buildSightingHandoff();
  if (!handoff) return;
  sessionStorage.setItem('ocsrApHandoff', JSON.stringify(handoff));
  location.href = 'index.html';
}

function onToPlanning() {
  var handoff = buildPlanningHandoff();
  if (!handoff) return;
  sessionStorage.setItem('ocsrPlanningApHandoff', JSON.stringify(handoff));
  location.href = 'planning.html';
}

/** Starts a new leg in-place: the DR result becomes the new start, duration/end-time are cleared (unknown for the new leg), SOG/course carry over since a leg often continues at the same speed/course. */
function onChainLeg() {
  var r = window._lastDrResult;
  if (!r) return;

  var dm = positionToDegMinFields(r.endPosition);
  document.getElementById('drLatDeg').value = dm.latDeg;
  document.getElementById('drLatMin').value = dm.latMin;
  document.getElementById('drLatNS').value = dm.latNS;
  document.getElementById('drLonDeg').value = dm.lonDeg;
  document.getElementById('drLonMin').value = dm.lonMin;
  document.getElementById('drLonEW').value = dm.lonEW;

  var local = SightCalc.utcMsToLocalDateTime(new Date(r.endPosition.time).getTime(), r.tzOffset);
  document.getElementById('drStartDate').value = local.dateStr;
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  setFieldValue('drStartTime', pad2(Math.floor(local.secOfDay / 3600)) + ':' + pad2(Math.floor((local.secOfDay % 3600) / 60)));

  // The new leg's start IS the previous leg's DR-derived end -- mark the
  // provenance accordingly (see _drStartPositionType's comment). This has
  // to happen AFTER the field writes above: those are plain .value
  // assignments, which don't fire 'input' events, so they won't trip the
  // "the person edited it by hand" reset wired below.
  _drStartPositionType = 'DR';

  // Duration/end-time are unknown for the new leg -- clear both sets of fields either way.
  document.getElementById('drDurationHours').value = '';
  document.getElementById('drDurationMinutes').value = '';
  document.getElementById('drEndDate').value = '';
  setFieldValue('drEndTime', '');

  showToast('Started a new leg from the DR position.');
  recompute();
}

/**
 * Auto-generated, no prompt -- same philosophy as the Sight page's save
 * naming: derived from the data that defines this leg, not hand-typed.
 * "yyyy-mm-dd HH.mm DR <course>\u00B0/<sog>kt", local start time.
 */
function computeLegName(result) {
  var local = SightCalc.utcMsToLocalDateTime(new Date(result.startPosition.time).getTime(), result.tzOffset);
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  var h = Math.floor(local.secOfDay / 3600), m = Math.floor((local.secOfDay % 3600) / 60);
  var courseStr = String(Math.round(result.courseDegTrue)).padStart(3, '0');
  return local.dateStr + ' ' + pad2(h) + '.' + pad2(m) + ' DR ' + courseStr + '\u00B0/' + result.sog + 'kt';
}

/**
 * Persists the current computed leg as a permanent, id'd record -- see
 * docs/passage-design.md section 8, prerequisite 1. Every save creates a
 * new record (DrLegStorage.save() always assigns a fresh id): a logged DR
 * leg is historical record of what was assumed at the time, not something
 * edited in place after the fact.
 */
function onSaveLeg() {
  var r = window._lastDrResult;
  if (!r) return;

  var record = {
    name: computeLegName(r),
    startPosition: r.startPosition,
    sog: r.sog,
    courseDegTrue: r.courseDegTrue,
    durationHours: r.durationHours,
    endPosition: r.endPosition,
    passageId: null
  };

  DrLegStorage.save(record).then(function (saved) {
    showToast('Saved "' + saved.name + '".');
    refreshSavedLegsList();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save this leg (storage may be full or unavailable).', true);
  });
}

function onDeleteLeg(id) {
  if (!confirm('Delete this saved DR leg? This cannot be undone.')) return;
  DrLegStorage.remove(id).then(function () {
    showToast('Deleted.');
    refreshSavedLegsList();
  });
}

/**
 * Consumes a one-time start-position handoff via sessionStorage key
 * 'ocsrDrLegStartHandoff' -- currently sent only by fixes.html's "Send to DR
 * Leg" (see onFixToDrLeg in js/fixes.js), carrying the same
 * { position: {time,lat,lon,type}, tzOffset } shape as the New Sighting
 * handoff. Fills the START fields (not the result) and marks the start
 * position's provenance as whatever the sender's Position.type says --
 * 'FIX' from a Fix, matching the DR Leg's own POSITION_TYPES.
 */
function applyPendingDrLegStartHandoff() {
  var raw;
  try {
    raw = sessionStorage.getItem('ocsrDrLegStartHandoff');
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  sessionStorage.removeItem('ocsrDrLegStartHandoff'); // one-time consume, even if parsing fails below

  var h;
  try {
    h = JSON.parse(raw);
  } catch (e) {
    return false;
  }
  if (!h.position) return false;

  var local = SightCalc.utcMsToLocalDateTime(new Date(h.position.time).getTime(), h.tzOffset);
  var dm = positionToDegMinFields(h.position);
  var pad2 = function (n) { return String(n).padStart(2, '0'); };

  document.getElementById('drStartDate').value = local.dateStr;
  setFieldValue('drStartTime', pad2(Math.floor(local.secOfDay / 3600)) + ':' + pad2(Math.floor((local.secOfDay % 3600) / 60)));
  document.getElementById('drTzOffset').value = h.tzOffset;
  document.getElementById('drLatDeg').value = dm.latDeg;
  document.getElementById('drLatMin').value = dm.latMin;
  document.getElementById('drLatNS').value = dm.latNS;
  document.getElementById('drLonDeg').value = dm.lonDeg;
  document.getElementById('drLonMin').value = dm.lonMin;
  document.getElementById('drLonEW').value = dm.lonEW;

  _drStartPositionType = h.position.type || 'KNOWN';

  showToast('Start position filled in from Fix.');
  return true;
}

function refreshSavedLegsList() {
  DrLegStorage.list().then(function (entries) {
    var listEl = document.getElementById('savedLegsList');
    var emptyEl = document.getElementById('savedLegsEmpty');
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    entries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'saved-item';

      var meta = 'saved ' + new Date(entry.savedAt).toLocaleString();

      item.innerHTML =
        '<div class="saved-item-info">' +
          '<div class="saved-item-title"></div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' +
        '<div class="saved-item-actions">' +
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = entry.name;
      item.querySelector('.saved-item-meta').textContent = meta;
      item.querySelector('.btn-mini-del').addEventListener('click', function () { onDeleteLeg(entry.id); });

      listEl.appendChild(item);
    });
  }).catch(function (err) {
    console.error(err);
  });
}

function showToast(msg, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('modeDuration').addEventListener('click', function () { setDrMode('duration'); });
  document.getElementById('modeEndTime').addEventListener('click', function () { setDrMode('endtime'); });
  document.getElementById('btnToSighting').addEventListener('click', onToSighting);
  document.getElementById('btnToPlanning').addEventListener('click', onToPlanning);
  document.getElementById('btnChainLeg').addEventListener('click', onChainLeg);
  document.getElementById('btnSaveLeg').addEventListener('click', onSaveLeg);

  // Digit-box behavior for every H/M time-field pair.
  DRLEG_FIELD_IDS.forEach(function (id) {
    var hEl = document.getElementById(id + 'H');
    var mEl = document.getElementById(id + 'M');
    if (hEl && mEl) {
      wireDigitBox(id + 'H', 2, 0, 23, id + 'M');
      wireDigitBox(id + 'M', 2, 0, 59, null);
    }
  });
  // Duration hours has no fixed length (a leg can run more than 24h) and no upper bound to validate against.
  wireDigitBox('drDurationHours', null, null, null, null);
  wireDigitBox('drDurationMinutes', 2, 0, 59, null);

  // Recalculate + persist on every change. Editing any of the start-identity
  // fields by hand also resets the start position's provenance back to
  // KNOWN (see _drStartPositionType) -- this only fires on genuine input
  // events, which programmatic field writes (like onChainLeg's) don't emit,
  // so chaining's own 'DR' marking survives.
  DRLEG_FIELD_IDS.forEach(function (id) {
    var hEl = document.getElementById(id + 'H');
    var mEl = document.getElementById(id + 'M');
    var elems = (hEl && mEl) ? [hEl, mEl] : [document.getElementById(id)];
    var isStartField = DR_START_FIELD_IDS.indexOf(id) !== -1;
    elems.forEach(function (el) {
      if (!el) return;
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        if (isStartField) _drStartPositionType = 'KNOWN';
        recompute();
      });
    });
  });

  var restored = restoreForm();
  var handoffApplied = applyPendingDrLegStartHandoff(); // overrides the restored/default start position above if Fix just sent one
  if (!restored && !handoffApplied) {
    var now = new Date();
    document.getElementById('drStartDate').valueAsDate = now;
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    setFieldValue('drStartTime', pad2(now.getHours()) + ':' + pad2(now.getMinutes()));
  }

  document.getElementById('modeDuration').setAttribute('aria-pressed', _drMode === 'duration' ? 'true' : 'false');
  document.getElementById('modeEndTime').setAttribute('aria-pressed', _drMode === 'endtime' ? 'true' : 'false');
  document.getElementById('durationCard').style.display = _drMode === 'duration' ? 'block' : 'none';
  document.getElementById('endTimeCard').style.display = _drMode === 'endtime' ? 'block' : 'none';

  recompute();
  if (!restored || handoffApplied) saveForm();
  refreshSavedLegsList();
});
