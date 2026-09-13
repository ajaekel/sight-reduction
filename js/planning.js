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

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('modeManual').addEventListener('click', function () { setPlanningMode('manual'); });
  document.getElementById('modeAutoFill').addEventListener('click', function () { setPlanningMode('autofill'); });
  document.getElementById('btnFetchRstt').addEventListener('click', onFetchRstt);
  document.getElementById('btnStartSight').addEventListener('click', onStartSight);

  var reactiveIds = [
    'planDate', 'planTzOffset', 'planLatDeg', 'planLatMin', 'planLatNS', 'planLonDeg', 'planLonMin', 'planLonEW',
    'refLatBelow', 'refLatAbove',
    'sunriseTimeBelow', 'sunriseTimeAbove', 'sunsetTimeBelow', 'sunsetTimeAbove', 'sunTransitTime',
    'moonriseTimeBelow', 'moonriseTimeAbove', 'moonsetTimeBelow', 'moonsetTimeAbove', 'moonTransitTime'
  ];
  reactiveIds.forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', refreshPlanning);
  });

  document.getElementById('planDate').valueAsDate = new Date();

  refreshPlanning();
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

/** "HH:MM" (from <input type="time">) -> seconds-of-day, or null if blank. */
function parseTimeField(id) {
  var v = document.getElementById(id).value;
  if (!v) return null;
  var p = v.split(':');
  return parseInt(p[0], 10) * 3600 + parseInt(p[1], 10) * 60;
}

/** { zoneSec, dayOffset } -> "HH:MM" with a "(+1 day)"-style suffix if the conversion crossed a calendar day. */
function formatResultTime(zoneSec, dayOffset) {
  var timeStr = SightCalc.secondsToTimeString(zoneSec).slice(0, 5);
  if (dayOffset === 0) return timeStr;
  return timeStr + ' (' + (dayOffset > 0 ? '+' : '') + dayOffset + ' day' + (Math.abs(dayOffset) === 1 ? '' : 's') + ')';
}

function setResult(elId, result) {
  document.getElementById(elId).textContent = result ? formatResultTime(result.zoneSec, result.dayOffset) : '--:--';
}

function clearResults() {
  ['resSunrise', 'resSunset', 'resSunTransit', 'resMoonrise', 'resMoonset', 'resMoonTransit'].forEach(function (id) {
    document.getElementById(id).textContent = '--:--';
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
  refreshPlanning();
}

// ---------------------------------------------------------------------
// Manual mode -- fully reactive, no network involved at all.
// ---------------------------------------------------------------------

function computeManualRiseSet(belowId, aboveId, refBelow, refAbove, apLat, lon, tz) {
  var tBelow = parseTimeField(belowId);
  var tAbove = parseTimeField(aboveId);
  if (tBelow === null || tAbove === null || isNaN(refBelow) || isNaN(refAbove)) return null;
  var lmt = SightCalc.interpolateByLatitude(refBelow, tBelow, refAbove, tAbove, apLat);
  return SightCalc.manualEventToZoneTime(lmt, lon, tz);
}

function computeManualTransit(fieldId, lon, tz) {
  var t = parseTimeField(fieldId);
  if (t === null) return null;
  return SightCalc.manualEventToZoneTime(t, lon, tz);
}

function refreshManualResults() {
  var pos = getPlanningPosition();
  if (!pos) { clearResults(); return; }

  var tz = parseFloat(document.getElementById('planTzOffset').value) || 0;
  var refBelow = parseFloat(document.getElementById('refLatBelow').value);
  var refAbove = parseFloat(document.getElementById('refLatAbove').value);

  setResult('resSunrise', computeManualRiseSet('sunriseTimeBelow', 'sunriseTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz));
  setResult('resSunset', computeManualRiseSet('sunsetTimeBelow', 'sunsetTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz));
  setResult('resSunTransit', computeManualTransit('sunTransitTime', pos.lon, tz));
  setResult('resMoonrise', computeManualRiseSet('moonriseTimeBelow', 'moonriseTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz));
  setResult('resMoonset', computeManualRiseSet('moonsetTimeBelow', 'moonsetTimeAbove', refBelow, refAbove, pos.lat, pos.lon, tz));
  setResult('resMoonTransit', computeManualTransit('moonTransitTime', pos.lon, tz));
}

// ---------------------------------------------------------------------
// Auto-fill mode -- one explicit, user-triggered USNO request; never reactive.
// ---------------------------------------------------------------------

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
      document.getElementById('resSunrise').textContent = result.sunrise || 'Does not occur';
      document.getElementById('resSunset').textContent = result.sunset || 'Does not occur';
      document.getElementById('resSunTransit').textContent = result.sunTransit || 'Does not occur';
      document.getElementById('resMoonrise').textContent = result.moonrise || 'Does not occur';
      document.getElementById('resMoonset').textContent = result.moonset || 'Does not occur';
      document.getElementById('resMoonTransit').textContent = result.moonTransit || 'Does not occur';
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
