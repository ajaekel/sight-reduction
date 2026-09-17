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
var drViewport = null; // {originLat, originLon, scale} | null -- see chartPanZoom.js; null means "auto-fit," set once a gesture (or reset) establishes one
var drAutoScaleNM = null;
var drAutoOriginLat = null;
var drAutoOriginLon = null;

// Provenance of the START position, per calc.js's Position.sourceType/sourceId
// (see makePosition's own comment for the full reasoning). 'KNOWN'/null
// unless it was carried in from chaining a previous leg (onChainLeg /
// onChainFromSavedLeg) or receiving a handoff from Fix, in which case
// sourceType/sourceId identify where it actually came from. Reset to
// 'KNOWN'/null the moment the person actually edits a start field by hand
// (see the DR_START_FIELD_IDS wiring below) -- editing implies they're
// overriding it with a value they're now vouching for directly, not
// whatever record it used to trace back to.
var _drStartPositionType = 'KNOWN';
var _drStartSourceId = null;

/** Every logical field whose value should survive navigating away and back. Time fields map to id+'H'/id+'M' -- see getFieldValue/setFieldValue. */
var DRLEG_FIELD_IDS = [
  'drStartDate', 'drStartTime', 'drTzOffset',
  'drLatDeg', 'drLatMin', 'drLatNS', 'drLonDeg', 'drLonMin', 'drLonEW',
  'drSog', 'drCourse',
  'drDurationHours', 'drDurationMinutes',
  'drEndDate', 'drEndTime'
];

/** The subset of the above that define the START position's identity -- editing any of these by hand means it's no longer a carried-over DR/Fix position (see _drStartPositionType/_drStartSourceId). */
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
  document.getElementById('btnToSight').disabled = true;
  document.getElementById('btnToPlanning').disabled = true;
  document.getElementById('btnChainLeg').disabled = true;
  document.getElementById('btnSaveLeg').disabled = true;
  window._lastDrResult = null;
  renderDrLegChartDisplay(null);
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
  // _drStartPositionType/_drStartSourceId, set wherever the start actually
  // came from -- chaining, a Fix handoff, or plain hand-entry) and an end
  // Position (always DR-derived; sourceId stays null until this leg is
  // actually saved, since only then does it have a stable id of its own to
  // point back to -- see drlegStorage.js's save()). This is what feeds the
  // handoffs, chaining, and "Save Leg" below.
  window._lastDrResult = {
    startPosition: SightCalc.makePosition(new Date(startUtcMs).toISOString(), pos.lat, pos.lon, _drStartPositionType, _drStartSourceId),
    endPosition: SightCalc.makePosition(new Date(leg.endUtcMs).toISOString(), leg.latDeg, leg.lonDeg, SightCalc.POSITION_SOURCE_TYPES.DR, null),
    sog: sog,
    courseDegTrue: course,
    durationHours: leg.durationHours,
    distanceNM: leg.distanceNM,
    tzOffset: tzOffset
  };
  document.getElementById('btnToSight').disabled = false;
  document.getElementById('btnToPlanning').disabled = false;
  document.getElementById('btnChainLeg').disabled = false;
  document.getElementById('btnSaveLeg').disabled = false;

  renderDrLegChartDisplay(window._lastDrResult);

  saveForm();
}

/**
 * DR track caption, matching the convention already established for the
 * same annotation drawn inside a Fix's plot (fixes.js): "DR 0934-1834 ·
 * 135°T @ 10 kn · 90.0 NM" (same day), or "DR 15 Sep 2340 -> 16 Sep 0110 ·
 * ..." spanning midnight -- 4-digit 24h time, no colon, per USCG
 * convention. Duplicated here rather than shared, matching how this
 * codebase already keeps page-specific formatting local (e.g.
 * wireDigitBox exists separately in app.js/drleg.js/planning.js) rather
 * than factoring out a cross-page utility file for it.
 */
/** Shared by formatDrTrackLabel and the chart's own point labels. */
function fmtHHMM(secOfDay) {
  return String(Math.floor(secOfDay / 3600)).padStart(2, '0') + String(Math.floor((secOfDay % 3600) / 60)).padStart(2, '0');
}

function formatDrTrackLabel(r) {
  var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var fmtDayMonth = function (dateStr) {
    var parts = dateStr.split('-');
    return parseInt(parts[2], 10) + ' ' + MONTH_ABBR[parseInt(parts[1], 10) - 1];
  };
  var trimNum = function (n) { return String(Math.round(n * 10) / 10); };

  var start = SightCalc.utcMsToLocalDateTime(new Date(r.startPosition.time).getTime(), r.tzOffset);
  var end = SightCalc.utcMsToLocalDateTime(new Date(r.endPosition.time).getTime(), r.tzOffset);
  var timeRange = (start.dateStr !== end.dateStr)
    ? fmtDayMonth(start.dateStr) + ' ' + fmtHHMM(start.secOfDay) + ' \u2192 ' + fmtDayMonth(end.dateStr) + ' ' + fmtHHMM(end.secOfDay)
    : fmtHHMM(start.secOfDay) + '\u2013' + fmtHHMM(end.secOfDay);
  var courseStr = String(Math.round(r.courseDegTrue)).padStart(3, '0') + '\u00B0T';

  return 'DR ' + timeRange + ' \u00B7 ' + courseStr + ' @ ' + trimNum(r.sog) + ' kn \u00B7 ' + r.distanceNM.toFixed(1) + ' NM';
}

/** Renders (or hides, if there's nothing valid to show) the Plot card. */
/**
 * chartPanZoom.js's own callbacks -- see fixes.js's matching pair (and
 * chartPanZoom.js's own file header) for the full contract; identical
 * shape here, just for this page's single DR leg chart instead of a
 * multi-sight one.
 */
function getDrLegViewport() {
  return {
    originLat: drViewport ? drViewport.originLat : drAutoOriginLat,
    originLon: drViewport ? drViewport.originLon : drAutoOriginLon,
    scale: drViewport ? drViewport.scale : drAutoScaleNM,
    autoScale: drAutoScaleNM,
    autoOriginLat: drAutoOriginLat,
    autoOriginLon: drAutoOriginLon
  };
}

function onDrLegViewportChange(viewport) {
  drViewport = viewport;
  renderDrLegChartDisplay(window._lastDrResult);
}

function renderDrLegChartDisplay(r) {
  var card = document.getElementById('drLegChartCard');
  if (!r) {
    card.style.display = 'none';
    return;
  }
  card.style.display = 'block';
  var startLocal = SightCalc.utcMsToLocalDateTime(new Date(r.startPosition.time).getTime(), r.tzOffset);
  var endLocal = SightCalc.utcMsToLocalDateTime(new Date(r.endPosition.time).getTime(), r.tzOffset);
  var result = SightChart.renderDrLegChart(document.getElementById('drLegChartContainer'), {
    startLat: r.startPosition.lat,
    startLon: r.startPosition.lon,
    endLat: r.endPosition.lat,
    endLon: r.endPosition.lon,
    startSourceType: r.startPosition.sourceType,
    startTimeLabel: fmtHHMM(startLocal.secOfDay),
    endTimeLabel: fmtHHMM(endLocal.secOfDay),
    viewport: drViewport // null until a pan/zoom gesture (or reset) has set one -- renderDrLegChart auto-fits (centers on the track's midpoint) when this is null
  });
  // Always synced from what was ACTUALLY just rendered, same reasoning as
  // fixes.js's equivalent sync -- further gestures build on this render,
  // not a stale one, and "reset to fit" always has a real target.
  drViewport = { originLat: result.originLat, originLon: result.originLon, scale: result.scaleNM };
  drAutoScaleNM = result.autoScaleNM;
  drAutoOriginLat = result.autoOriginLat;
  drAutoOriginLon = result.autoOriginLon;
  // Displayed as a caption below the chart, not drawn inside the SVG --
  // see the comment in chart.js's renderDrLegChart for why: this caption
  // routinely runs 40-55+ characters, which doesn't fit gracefully inside
  // a chart this small no matter how its position is computed.
  document.getElementById('drLegChartCaption').textContent = formatDrTrackLabel(r);
}

function saveForm() {
  var data = { mode: _drMode, startPositionType: _drStartPositionType, startSourceId: _drStartSourceId, fields: {} };
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
  if (data.startPositionType === 'KNOWN' || data.startPositionType === 'FIX' || data.startPositionType === 'DR') {
    _drStartPositionType = data.startPositionType;
  }
  _drStartSourceId = data.startSourceId || null;
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
 * New Sight handoff: the rich, Position-aware shape, since index.html
 * has somewhere meaningful to put an exact time (the first observation
 * line). Note this is a convenience prefill, not a correctness fix: the AP
 * itself never needed a time (reduceSight only reads the observation's own
 * clock time), it's just a time-saver for the common "DR to an event, then
 * observe" workflow.
 */
function buildSightHandoff() {
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

function onToSight() {
  var handoff = buildSightHandoff();
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

/**
 * Starts a new leg in-place from any given end position: fills the START
 * fields, marks provenance as sourceType 'DR' with sourceId set to whatever
 * this end position's own sourceId already is (a leg's end -- whether just
 * computed or pulled from a saved record -- is definitionally a DR
 * position; sourceId will be null if the leg producing it hasn't been
 * saved yet, since only a saved leg has a stable id to point back to), and
 * clears duration/end-time (unknown for the new leg). SOG/course are left
 * alone -- shared by both call sites below since they each decide separately
 * whether carrying them over makes sense.
 *
 * Rounds endPosition.time UP to the next whole minute before writing it
 * into the (seconds-less) start time field -- see
 * applyPendingDrLegStartHandoff's comment on why up, not down. In today's
 * DR Leg math this is normally already exact (duration/end-time entry has
 * no seconds either, so a leg's own endPosition never accumulates a
 * sub-minute remainder on its own), but rounding defensively here costs
 * nothing and keeps this function correct regardless of what produced the
 * position it's given.
 */
function chainFromPosition(endPosition, tzOffset) {
  var dm = positionToDegMinFields(endPosition);
  document.getElementById('drLatDeg').value = dm.latDeg;
  document.getElementById('drLatMin').value = dm.latMin;
  document.getElementById('drLatNS').value = dm.latNS;
  document.getElementById('drLonDeg').value = dm.lonDeg;
  document.getElementById('drLonMin').value = dm.lonMin;
  document.getElementById('drLonEW').value = dm.lonEW;

  var roundedMs = SightCalc.roundUpToMinuteMs(new Date(endPosition.time).getTime());
  var local = SightCalc.utcMsToLocalDateTime(roundedMs, tzOffset);
  document.getElementById('drStartDate').value = local.dateStr;
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  setFieldValue('drStartTime', pad2(Math.floor(local.secOfDay / 3600)) + ':' + pad2(Math.floor((local.secOfDay % 3600) / 60)));
  document.getElementById('drTzOffset').value = tzOffset;

  // This has to happen AFTER the field writes above: those are plain .value
  // assignments, which don't fire 'input' events, so they won't trip the
  // "the person edited it by hand" reset wired below.
  _drStartPositionType = SightCalc.POSITION_SOURCE_TYPES.DR;
  _drStartSourceId = endPosition.sourceId || null;

  // Duration/end-time are unknown for the new leg -- clear both sets of fields either way.
  document.getElementById('drDurationHours').value = '';
  document.getElementById('drDurationMinutes').value = '';
  document.getElementById('drEndDate').value = '';
  setFieldValue('drEndTime', '');

  recompute();
}

/** From the leg just computed on this page -- SOG/course carry over, since a leg often continues at the same speed/course right after. */
function onChainLeg() {
  var r = window._lastDrResult;
  if (!r) return;
  chainFromPosition(r.endPosition, r.tzOffset);
  showToast('Started a new leg from the DR position.');
}

/**
 * From a PREVIOUSLY saved leg's endpoint (not necessarily the one currently
 * on screen) -- resuming a passage after navigating away, or branching a new
 * leg off an old one. SOG/course are deliberately NOT carried over here: the
 * saved leg could be from a while ago, so assuming the same speed/course
 * still applies would be a bigger leap than chaining off what's freshly on
 * screen.
 */
function onChainFromSavedLeg(legId) {
  DrLegStorage.get(legId).then(function (leg) {
    if (!leg) { showToast('Could not find that saved leg.', true); return; }
    chainFromPosition(leg.endPosition, leg.tzOffset);
    document.getElementById('drSog').value = '';
    document.getElementById('drCourse').value = '';
    showToast('Started a new leg from "' + leg.name + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that saved leg.', true);
  });
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
 * Persists the current computed leg as a permanent, id'd record. Every save
 * creates a new record (DrLegStorage.save() always assigns a fresh id): a
 * logged DR leg is historical record of what was assumed at the time, not
 * something edited in place after the fact.
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
    tzOffset: r.tzOffset, // needed to reconstruct local date/time when resuming from this leg's endpoint (see onChainFromSavedLeg)
    passageId: null
  };

  DrLegStorage.save(record).then(function (saved) {
    // The live result's endPosition was built with sourceId null (this leg
    // didn't have an id yet -- see recompute()); now that it's saved and
    // DrLegStorage has stamped saved.endPosition.sourceId = saved.id, patch
    // the live result to match, so chaining from it immediately afterward
    // (without a reload in between) correctly points back to this leg
    // rather than staying null.
    r.endPosition.sourceId = saved.id;
    showToast('Saved "' + saved.name + '".');
    refreshSavedLegsList();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save this leg (storage may be full or unavailable).', true);
  });
}

/**
 * Reloads a previously saved leg's own inputs back onto the form -- distinct
 * from onChainFromSavedLeg, which only borrows the saved leg's ENDPOINT as
 * the start of a brand-new leg. This instead reconstructs the saved leg
 * itself: its start position (with original provenance), SOG, course, and
 * duration, so it recomputes to the same result and can be reviewed, tweaked,
 * or re-saved.
 *
 * Always lands in 'duration' mode: a saved record only stores durationHours
 * (see drlegStorage.js's save()), not which entry mode -- duration or
 * end-time -- originally produced it, and duration mode reproduces an
 * identical leg either way.
 *
 * Start date/time is written directly from startPosition.time with no
 * rounding (unlike chainFromPosition/applyPendingDrLegStartHandoff): this
 * time was itself derived from a whole-minute HH:MM field when the leg was
 * first computed, so it's already exact on a minute boundary.
 */
/**
 * Fills every DR-leg input field from a fully-specified leg (start
 * position+time, tz, sog, course, duration) -- shared by onLoadLeg
 * (loading a saved record) and applyPendingSolvedLegHandoff (receiving a
 * solved leg from Planning's "where will I be at this event?" feature),
 * so both fill an identical set of fields the identical way rather than
 * risking two near-copies drifting apart. Deliberately does NOT touch
 * _drMode/call setDrMode itself -- the two callers need this at different
 * points (onLoadLeg runs post-init, after a button click, and needs
 * setDrMode's own UI-sync/recompute; applyPendingSolvedLegHandoff runs
 * DURING init, where the init sequence's own end-of-function UI sync
 * already does that once, and calling setDrMode here too would just
 * recompute everything twice).
 */
function fillLegFields(startPosition, tzOffset, sog, courseDegTrue, durationHours) {
  var dm = positionToDegMinFields(startPosition);
  document.getElementById('drLatDeg').value = dm.latDeg;
  document.getElementById('drLatMin').value = dm.latMin;
  document.getElementById('drLatNS').value = dm.latNS;
  document.getElementById('drLonDeg').value = dm.lonDeg;
  document.getElementById('drLonMin').value = dm.lonMin;
  document.getElementById('drLonEW').value = dm.lonEW;

  var local = SightCalc.utcMsToLocalDateTime(new Date(startPosition.time).getTime(), tzOffset);
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  document.getElementById('drStartDate').value = local.dateStr;
  setFieldValue('drStartTime', pad2(Math.floor(local.secOfDay / 3600)) + ':' + pad2(Math.floor((local.secOfDay % 3600) / 60)));
  document.getElementById('drTzOffset').value = tzOffset;

  document.getElementById('drSog').value = sog;
  document.getElementById('drCourse').value = courseDegTrue;

  var hours = Math.floor(durationHours);
  var minutes = Math.round((durationHours - hours) * 60);
  if (minutes === 60) { hours += 1; minutes = 0; }
  document.getElementById('drDurationHours').value = hours;
  document.getElementById('drDurationMinutes').value = minutes;
  document.getElementById('drEndDate').value = '';
  setFieldValue('drEndTime', '');

  _drStartPositionType = startPosition.sourceType || 'KNOWN';
  _drStartSourceId = startPosition.sourceId || null;
}

function onLoadLeg(legId) {
  DrLegStorage.get(legId).then(function (leg) {
    if (!leg) { showToast('Could not find that saved leg.', true); return; }

    fillLegFields(leg.startPosition, leg.tzOffset, leg.sog, leg.courseDegTrue, leg.durationHours);
    setDrMode('duration'); // updates the toggle UI, persists the form, and recomputes
    showToast('Loaded "' + leg.name + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that saved leg.', true);
  });
}

/**
 * Receives a fully-solved DR leg from Planning's "where will I be at this
 * event?" feature (sessionStorage key 'ocsrSolvedLegHandoff'). Unlike
 * applyPendingDrLegStartHandoff (which only ever carries a START
 * position), this carries the ENTIRE leg -- start, course, speed, AND
 * duration -- since that feature's whole point is answering "how long do
 * I run, on what track" rather than just "where do I start from." Called
 * during init, alongside applyPendingDrLegStartHandoff; the two use
 * different sessionStorage keys, so there's no ambiguity about which one
 * (if either) actually has a pending handoff to apply.
 */
function applyPendingSolvedLegHandoff() {
  var raw;
  try { raw = sessionStorage.getItem('ocsrSolvedLegHandoff'); } catch (e) { return false; }
  if (!raw) return false;
  sessionStorage.removeItem('ocsrSolvedLegHandoff'); // one-time consume, even if parsing fails below

  var h;
  try { h = JSON.parse(raw); } catch (e) { return false; }
  if (!h || !h.startPosition || typeof h.durationHours !== 'number') return false;

  fillLegFields(h.startPosition, h.tzOffset, h.sog, h.courseDegTrue, h.durationHours);
  _drMode = 'duration'; // see fillLegFields' own comment on why this doesn't call setDrMode directly here
  showToast('DR leg filled in from ' + (h.sentFrom || 'another page') + '.');
  return true;
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
 * 'ocsrDrLegStartHandoff' -- sent by fixes.html's "Send to DR Leg" (see
 * onFixToDrLeg in js/fixes.js), planning.html's "Send to DR Leg" (see
 * onToDrLeg in js/planning.js), and index.html/sights.html's "Send to
 * DR Leg" (see onSendToDrLeg in js/app.js and js/sights.js), all
 * carrying the same { position: {time,lat,lon,sourceType,sourceId},
 * tzOffset, sentFrom } shape as the New Sight handoff. Fills the START
 * fields (not the result) and copies the incoming position's own
 * sourceType/sourceId directly -- whoever built the handoff already
 * stamped it correctly (a Fix stamps its own id when caching
 * resolvedPosition; Planning and a lone Sight have no id of their own in
 * the sourceType sense, so they send sourceType KNOWN, a Sight with its
 * own id as sourceId since it's still worth pointing back to even though
 * KNOWN doesn't imply a resolved fix), so there's nothing to re-derive
 * here.
 *
 * sentFrom is separate from sourceType on purpose: sourceType/sourceId
 * describe navigational provenance (how much to trust this position and
 * which record backs it), which is genuinely ambiguous between "Planning"
 * and "a lone Sight" since both are honestly just KNOWN with no fix behind
 * them -- sentFrom is purely "which page's button was clicked," used only
 * for this toast, so it doesn't need to (and shouldn't) piggyback on the
 * trust-category field.
 *
 * The incoming position.time may carry seconds (a Fix's resolvedPosition.time
 * is timestamped from a Sight's own observation seconds; Planning's computed
 * event times can too) -- but DR Leg's start time field is minutes-only, no
 * seconds input. Rounded UP to the next whole minute (see
 * SightCalc.roundUpToMinuteMs) rather than truncated down, so the leg's
 * start never appears to precede the exact instant it was derived from.
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

  var roundedMs = SightCalc.roundUpToMinuteMs(new Date(h.position.time).getTime());
  var local = SightCalc.utcMsToLocalDateTime(roundedMs, h.tzOffset);
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

  _drStartPositionType = h.position.sourceType || 'KNOWN';
  _drStartSourceId = h.position.sourceId || null;

  showToast('Start position filled in from ' + (h.sentFrom || 'another page') + '.');
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

    // Deep-link support for "open the underlying record" from elsewhere
    // (currently: a Passage's timeline) -- '#leg=<id>' highlights and
    // scrolls to that specific saved leg. This page has no per-leg detail
    // view of its own (a logged leg is historical record, not something
    // with its own editable page), so "opening" one just means finding it
    // in this list.
    var m = /^#leg=(.+)$/.exec(location.hash);
    var highlightId = m ? decodeURIComponent(m[1]) : null;

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
          '<button class="btn-mini btn-mini-load">Load</button>' +
          '<button class="btn-mini btn-mini-fix">Use as Start</button>' +
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = entry.name;
      item.querySelector('.saved-item-meta').textContent = meta;
      item.querySelector('.btn-mini-load').addEventListener('click', function () { onLoadLeg(entry.id); });
      item.querySelector('.btn-mini-fix').addEventListener('click', function () { onChainFromSavedLeg(entry.id); });
      item.querySelector('.btn-mini-del').addEventListener('click', function () { onDeleteLeg(entry.id); });

      if (highlightId && entry.id === highlightId) {
        item.classList.add('saved-item-highlight');
      }

      listEl.appendChild(item);
    });

    if (highlightId) {
      var highlighted = listEl.querySelector('.saved-item-highlight');
      if (highlighted && highlighted.scrollIntoView) highlighted.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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

  var drPanZoomApi = ChartPanZoom.wire('drLegChartWrap', { getViewport: getDrLegViewport, onViewportChange: onDrLegViewportChange });
  ChartFullscreen.wire('drLegChartWrap', 'drLegChartContainer', drPanZoomApi);

  document.getElementById('modeDuration').addEventListener('click', function () { setDrMode('duration'); });
  document.getElementById('modeEndTime').addEventListener('click', function () { setDrMode('endtime'); });
  document.getElementById('btnToSight').addEventListener('click', onToSight);
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
        if (isStartField) { _drStartPositionType = 'KNOWN'; _drStartSourceId = null; }
        recompute();
      });
    });
  });

  var restored = restoreForm();
  var handoffApplied = applyPendingDrLegStartHandoff(); // overrides the restored/default start position above if Fix just sent one
  var solvedHandoffApplied = applyPendingSolvedLegHandoff(); // overrides start/course/speed/duration above if Planning's event-position solver just sent a complete leg
  handoffApplied = handoffApplied || solvedHandoffApplied;
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
