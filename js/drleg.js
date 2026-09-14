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

/** Every logical field whose value should survive navigating away and back. Time fields map to id+'H'/id+'M' -- see getFieldValue/setFieldValue. */
var DRLEG_FIELD_IDS = [
  'drStartDate', 'drStartTime', 'drTzOffset',
  'drLatDeg', 'drLatMin', 'drLatNS', 'drLonDeg', 'drLonMin', 'drLonEW',
  'drSog', 'drCourse',
  'drDurationHours', 'drDurationMinutes',
  'drEndDate', 'drEndTime'
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

  window._lastDrResult = {
    latDeg: leg.latDeg,
    lonDeg: leg.lonDeg,
    dateStr: arrival.dateStr,
    secOfDay: arrival.secOfDay,
    tzOffset: tzOffset
  };
  document.getElementById('btnToSighting').disabled = false;
  document.getElementById('btnToPlanning').disabled = false;
  document.getElementById('btnChainLeg').disabled = false;

  saveForm();
}

function saveForm() {
  var data = { mode: _drMode, fields: {} };
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
  return true;
}

/** Builds the {date, tzOffset, latDeg, latMin, latNS, lonDeg, lonMin, lonEW} shape shared by both handoff destinations, from the last computed DR result. */
function buildPositionHandoff() {
  var r = window._lastDrResult;
  if (!r) return null;
  var latAbs = Math.abs(r.latDeg);
  var lonAbs = Math.abs(r.lonDeg);
  return {
    date: r.dateStr,
    tzOffset: String(r.tzOffset),
    latDeg: String(Math.floor(latAbs)),
    latMin: (Math.round((latAbs - Math.floor(latAbs)) * 60 * 10) / 10).toFixed(1),
    latNS: r.latDeg < 0 ? 'S' : 'N',
    lonDeg: String(Math.floor(lonAbs)),
    lonMin: (Math.round((lonAbs - Math.floor(lonAbs)) * 60 * 10) / 10).toFixed(1),
    lonEW: r.lonDeg < 0 ? 'W' : 'E'
  };
}

function onToSighting() {
  var handoff = buildPositionHandoff();
  if (!handoff) return;
  sessionStorage.setItem('ocsrApHandoff', JSON.stringify(handoff));
  location.href = 'index.html';
}

function onToPlanning() {
  var handoff = buildPositionHandoff();
  if (!handoff) return;
  sessionStorage.setItem('ocsrPlanningApHandoff', JSON.stringify(handoff));
  location.href = 'planning.html';
}

/** Starts a new leg in-place: the DR result becomes the new start, duration/end-time are cleared (unknown for the new leg), SOG/course carry over since a leg often continues at the same speed/course. */
function onChainLeg() {
  var r = window._lastDrResult;
  if (!r) return;

  var latAbs = Math.abs(r.latDeg);
  var lonAbs = Math.abs(r.lonDeg);
  document.getElementById('drLatDeg').value = Math.floor(latAbs);
  document.getElementById('drLatMin').value = (Math.round((latAbs - Math.floor(latAbs)) * 60 * 10) / 10).toFixed(1);
  document.getElementById('drLatNS').value = r.latDeg < 0 ? 'S' : 'N';
  document.getElementById('drLonDeg').value = Math.floor(lonAbs);
  document.getElementById('drLonMin').value = (Math.round((lonAbs - Math.floor(lonAbs)) * 60 * 10) / 10).toFixed(1);
  document.getElementById('drLonEW').value = r.lonDeg < 0 ? 'W' : 'E';

  document.getElementById('drStartDate').value = r.dateStr;
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  setFieldValue('drStartTime', pad2(Math.floor(r.secOfDay / 3600)) + ':' + pad2(Math.floor((r.secOfDay % 3600) / 60)));

  // Duration/end-time are unknown for the new leg -- clear both sets of fields either way.
  document.getElementById('drDurationHours').value = '';
  document.getElementById('drDurationMinutes').value = '';
  document.getElementById('drEndDate').value = '';
  setFieldValue('drEndTime', '');

  showToast('Started a new leg from the DR position.');
  recompute();
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

  // Recalculate + persist on every change.
  DRLEG_FIELD_IDS.forEach(function (id) {
    var hEl = document.getElementById(id + 'H');
    var mEl = document.getElementById(id + 'M');
    var elems = (hEl && mEl) ? [hEl, mEl] : [document.getElementById(id)];
    elems.forEach(function (el) {
      if (!el) return;
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', recompute);
    });
  });

  var restored = restoreForm();
  if (!restored) {
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
  if (!restored) saveForm();
});
