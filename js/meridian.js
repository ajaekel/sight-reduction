/**
 * meridian.js
 * Page logic for meridian.html: a Meridian Passage (Local Apparent Noon)
 * sight of the Sun. Distinct from New Sight (js/app.js) -- there's no
 * assumed position and no LHA/azimuth-intercept geometry, since LHA is 0 by
 * definition at meridian passage; the observed altitude gives latitude
 * directly via calc.js's reduceMeridianSight. UI layer only, same
 * separation of concerns as app.js: all math lives in calc.js, persistence
 * in meridianStorage.js.
 *
 * "Sun bears N/S" -- reduceMeridianSight's own comment explains why this is
 * needed at all: z = |lat - dec| is symmetric, so the same Ho and
 * declination are consistent with two different latitudes unless the
 * observer also knows which side of them the Sun was on. Defaulted from an
 * incoming DR/Fix position's latitude when a handoff supplies one (see
 * applyPendingHandoff/maybeSetSunBearsDefault), otherwise South -- but
 * always overridable, and never itself shown as a lat/lon input.
 *
 * "Add to a Fix" -- a meridian sight has no zn/interceptNM of the kind
 * every existing Fix relies on, but its result IS representable as a
 * degenerate east-west LOP (zn 000° or 180° depending on Sun
 * Bears, so the chart's azimuth-line indicator points the way it was
 * actually observed; intercept exactly 0 nm; AP latitude = the calculated
 * latitude) that the existing multi-LOP solver already handles correctly
 * (see calc.js's intersectTwoLops -- it solves each LOP as a true infinite
 * line, so the AP longitude used for this degenerate LOP cannot affect the
 * solved position, only where it's drawn on the chart). Rather than teach
 * FixStorage/fixes.js/chart.js about a second kind of fix member, this
 * creates/updates one ordinary SightStorage record mirroring that
 * degenerate LOP (see meridianStorage.js's buildMirrorSightRecord, the
 * single shared definition -- ensureMirrorSight here just supplies the
 * longitude and persists it) and adds THAT record's id to the Fix's
 * sightIds, same as any other sight. fixes.js's own "Add a Meridian
 * Passage" reuses the exact same buildMirrorSightRecord for an
 * already-saved Meridian Passage sight, triggered from the Fixes page
 * instead of from here.
 *
 * mirrorLon itself (see averageLonOfOtherFixMembers) is the average
 * longitude of the target Fix's OTHER members, not a fixed placeholder --
 * since the AP's longitude is otherwise arbitrary, aligning it with
 * wherever the rest of that Fix already is keeps the chart from looking
 * like this LOP belongs somewhere else entirely. Only falls back to a
 * handed-off DR/Fix longitude, then 0°, when the target Fix has no
 * other usable members yet.
 */

var _clockErrorDirection = 'fast';
var _sunBearsUserTouched = false;
var _handoffApLat = null; // internal only -- never shown as a Section 1 field, used only to default Sun Bears and to place a Fix mirror/DR Leg handoff
var _handoffLon = null;
var _currentRecordId = null;
var _currentMirrorSightId = null;
var _lastResult = null;
var _almanacFieldsContext = null;
var _autoFillLoopGuard = { signature: null, count: 0 };

document.addEventListener('DOMContentLoaded', initApp);
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
});

/**
 * Consumes the same one-time AP handoff app.js does ('ocsrApHandoff') --
 * this page has no Section 1 lat/lon fields to fill, so only date/time/tz
 * are applied to the form; the incoming lat/lon are kept internally
 * (_handoffApLat/_handoffLon) for the Sun Bears default and for placing a
 * Fix mirror or a Send-to-DR-Leg handoff, never surfaced as inputs.
 */
function applyPendingHandoff() {
  var raw;
  try {
    raw = sessionStorage.getItem('ocsrApHandoff');
  } catch (e) {
    return;
  }
  if (!raw) return;
  sessionStorage.removeItem('ocsrApHandoff'); // one-time consume, even if parsing fails below

  var h;
  try {
    h = JSON.parse(raw);
  } catch (e) {
    return;
  }

  if (h.position) {
    var tzOffset = h.tzOffset;
    var local = SightCalc.utcMsToLocalDateTime(new Date(h.position.time).getTime(), tzOffset);
    document.getElementById('meridianDate').value = local.dateStr;
    document.getElementById('meridianTz').value = tzOffset;
    document.getElementById('meridianTimeH').value = String(Math.floor(local.secOfDay / 3600)).padStart(2, '0');
    document.getElementById('meridianTimeM').value = String(Math.floor((local.secOfDay % 3600) / 60)).padStart(2, '0');
    _handoffApLat = h.position.lat;
    _handoffLon = h.position.lon;
    showToast('Date, time, and time zone filled in from ' + (h.sentFrom || 'another page') + '.');
    return;
  }

  // Older simple shape (Planning) -- date-only, no specific time.
  if (h.date) document.getElementById('meridianDate').value = h.date;
  if (h.tzOffset !== undefined) document.getElementById('meridianTz').value = h.tzOffset;
  if (h.latDeg !== undefined) {
    var latTotal = SightCalc.dmToDecimal(h.latDeg, h.latMin || 0);
    _handoffApLat = h.latNS === 'S' ? -latTotal : latTotal;
  }
  if (h.lonDeg !== undefined) {
    var lonTotal = SightCalc.dmToDecimal(h.lonDeg, h.lonMin || 0);
    _handoffLon = h.lonEW === 'W' ? -lonTotal : lonTotal;
  }
  showToast('Date and time zone filled in from Planning.');
}

/**
 * Consumes a one-time "load this saved Meridian Passage" handoff via
 * sessionStorage key 'ocsrLoadMeridianId' -- sent by fixes.js's chart
 * "Open Meridian Passage" action (see getFixSelectionDetail), the one place
 * outside this page that can reach a Meridian Passage record (through its
 * Fix mirror). Mirrors app.js's applyPendingSightLoad, but loads into this
 * page's own form via MeridianStorage, never into New Sight.
 */
function applyPendingMeridianLoad() {
  var id;
  try {
    id = sessionStorage.getItem('ocsrLoadMeridianId');
  } catch (e) {
    return;
  }
  if (!id) return;
  sessionStorage.removeItem('ocsrLoadMeridianId'); // one-time consume

  MeridianStorage.get(id).then(function (record) {
    if (!record) { showToast('Could not find that saved Meridian Passage sight.', true); return; }
    applyFormState(record);
    _currentRecordId = record.id;
    showToast('Loaded "' + (record.title || 'sight') + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that saved Meridian Passage sight.', true);
  });
}

function initApp() {
  try {
    document.getElementById('meridianDate').value = new Date().toISOString().split('T')[0];
  } catch (e) {}

  applyPendingHandoff();
  applyPendingMeridianLoad(); // may override the handoff above if a Fix's chart just sent one
  initNavMenu();

  document.getElementById('sunBears').addEventListener('change', function () {
    _sunBearsUserTouched = true;
    refreshLiveCalculations();
  });

  document.getElementById('btnFetchUsno').addEventListener('click', onFetchUsno);
  ['btnSaveTop', 'btnSaveBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', onSave);
  });
  ['btnExportJsonTop', 'btnExportJsonBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', onExportJson);
  });
  ['btnImportTop', 'btnImportBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', function () {
      document.getElementById('fileImportJson').click();
    });
  });
  document.getElementById('fileImportJson').addEventListener('change', onImportJson);
  ['btnClearAll', 'btnClearAllBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', clearAllData);
  });
  ['btnAddToFixTop', 'btnAddToFixBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', openAddToFixPanel);
  });
  ['btnSendToDrLegTop', 'btnSendToDrLegBottom'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', onSendToDrLeg);
  });
  document.getElementById('addToFixSelect').addEventListener('change', updateAddToFixPanel);
  document.getElementById('btnConfirmAddToFix').addEventListener('click', onConfirmAddToFix);
  document.getElementById('btnCancelAddToFix').addEventListener('click', closeAddToFixPanel);

  document.getElementById('meridianDate').addEventListener('change', refreshLiveCalculations);
  document.getElementById('toggleAutoFillCache').addEventListener('change', refreshLiveCalculations);
  document.getElementById('clockErrorSec').addEventListener('input', refreshLiveCalculations);
  document.getElementById('clockErrorFast').addEventListener('click', function () { setClockErrorDirection('fast'); });
  document.getElementById('clockErrorSlow').addEventListener('click', function () { setClockErrorDirection('slow'); });

  ['meridianTz', 'ieMin', 'dipMin', 'altCorrMin', 'addAltCorrMin'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', refreshLiveCalculations);
  });
  ['ieSign', 'altCorrSign', 'addAltCorrSign'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', refreshLiveCalculations);
  });

  wireTimeField('meridianTimeH', 0, 23, 'meridianTimeM');
  wireTimeField('meridianTimeM', 0, 59, null);

  var errMeridianHs = document.getElementById('errMeridianHs');
  document.getElementById('meridianHsDeg').addEventListener('input', function () {
    validateField(this, 0, 90, 'Degrees', errMeridianHs, false);
    refreshLiveCalculations();
  });
  document.getElementById('meridianHsMin').addEventListener('input', function () {
    validateField(this, 0, 60, 'Height Minutes', errMeridianHs, true);
    refreshLiveCalculations();
  });

  var errDecBase = document.getElementById('errDecBase');
  var errDecNext = document.getElementById('errDecNext');
  var validateDecBase = function () { validateDegMinPair(document.getElementById('decBaseDeg'), document.getElementById('decBaseMin'), 90, 'Declination Base', errDecBase); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateDecNext = function () { validateDegMinPair(document.getElementById('decNextDeg'), document.getElementById('decNextMin'), 90, 'Declination Next', errDecNext); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  document.getElementById('decBaseDeg').addEventListener('input', validateDecBase);
  document.getElementById('decBaseMin').addEventListener('input', validateDecBase);
  document.getElementById('decNextDeg').addEventListener('input', validateDecNext);
  document.getElementById('decNextMin').addEventListener('input', validateDecNext);
  ['decBaseNS', 'decNextNS'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () { markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); });
  });

  renderSavedMeridianList();
  refreshLiveCalculations();

  if (window.SightStorage && SightStorage.requestPersistence) {
    SightStorage.requestPersistence();
  }
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  }
}

// ---------------------------------------------------------------------
// SMALL FIELD HELPERS (page-local copies, same convention as every other
// page in this app -- see e.g. passages.js's wireDigitBox)
// ---------------------------------------------------------------------

function validateField(el, min, max, labelName, errorEl, isStrictMax) {
  var valStr = el.value.trim();

  if (valStr === '') {
    el.classList.remove('input-error');
    if (errorEl) errorEl.style.display = 'none';
    return true;
  }

  var val = parseFloat(valStr);
  var isTooHigh = false;
  if (max !== null) isTooHigh = isStrictMax ? (val >= max) : (val > max);

  if (isNaN(val) || (min !== null && val < min) || isTooHigh) {
    el.classList.add('input-error');
    if (errorEl) {
      var rangeText = isStrictMax ? (min + ' to < ' + max) : (min + '–' + max);
      errorEl.innerText = 'Invalid entry: ' + labelName + ' must be ' + rangeText;
      errorEl.style.display = 'block';
    }
    return false;
  }
  el.classList.remove('input-error');
  if (errorEl) errorEl.style.display = 'none';
  return true;
}

function validateDegMinPair(degEl, minEl, maxDeg, labelName, errorEl) {
  var degVal = parseFloat(degEl.value) || 0;
  var minVal = parseFloat(minEl.value) || 0;
  var totalDeg = degVal + (minVal / 60);
  var isInvalid = isNaN(totalDeg) || totalDeg < 0 || totalDeg > maxDeg;

  if (isInvalid && (degEl.value.trim() !== '' || minEl.value.trim() !== '')) {
    degEl.classList.add('input-error');
    minEl.classList.add('input-error');
    if (errorEl) {
      errorEl.innerText = 'Invalid entry: ' + labelName + ' total must be 0–' + maxDeg + '°';
      errorEl.style.display = 'block';
    }
    return false;
  }
  degEl.classList.remove('input-error');
  minEl.classList.remove('input-error');
  if (errorEl) errorEl.style.display = 'none';
  return true;
}

/** HH/MM box: digit-only, auto-advances into the next box, validates range, and recalculates -- this page's only such field, so folded into one helper rather than app.js's separate wireDigitBox+validateField+refresh calls. */
function wireTimeField(id, min, max, nextId) {
  var el = document.getElementById(id);
  var errEl = document.getElementById('errMeridianTime');
  el.addEventListener('focus', function () { this.select(); });
  el.addEventListener('input', function () {
    var cleaned = this.value.replace(/[^0-9]/g, '').slice(0, 2);
    if (cleaned !== this.value) this.value = cleaned;
    validateField(this, min, max, id === 'meridianTimeH' ? 'Hours' : 'Minutes', errEl);
    if (cleaned.length >= 2 && nextId) {
      var nextEl = document.getElementById(nextId);
      if (nextEl) { nextEl.focus(); nextEl.select(); }
    }
    refreshLiveCalculations();
  });
}

function hasCompleteTime() {
  return document.getElementById('meridianTimeH').value.trim() !== '' &&
         document.getElementById('meridianTimeM').value.trim() !== '';
}

function allFilled(ids) {
  return ids.every(function (id) {
    var el = document.getElementById(id);
    return !!el && el.value.trim() !== '';
  });
}

function getClockErrorCorrectedLocalSec(localSec) {
  var clockErrorSec = parseFloat(document.getElementById('clockErrorSec').value) || 0;
  var sign = (_clockErrorDirection === 'fast') ? -1 : 1;
  var corrected = localSec + sign * clockErrorSec;
  return ((corrected % 86400) + 86400) % 86400;
}

function setClockErrorDirection(direction) {
  _clockErrorDirection = direction;
  document.getElementById('clockErrorFast').setAttribute('aria-pressed', direction === 'fast' ? 'true' : 'false');
  document.getElementById('clockErrorSlow').setAttribute('aria-pressed', direction === 'slow' ? 'true' : 'false');
  refreshLiveCalculations();
}

function collectCorrections() {
  return {
    ieMin: parseFloat(document.getElementById('ieMin').value) || 0,
    ieSign: document.getElementById('ieSign').value,
    dipMin: parseFloat(document.getElementById('dipMin').value) || 0,
    altCorrMin: parseFloat(document.getElementById('altCorrMin').value) || 0,
    altCorrSign: document.getElementById('altCorrSign').value,
    addAltCorrMin: parseFloat(document.getElementById('addAltCorrMin').value) || 0,
    addAltCorrSign: document.getElementById('addAltCorrSign').value
  };
}

function currentUtcContext() {
  var dateInput = document.getElementById('meridianDate').value;
  if (!dateInput || !hasCompleteTime()) return null;
  var tzOffset = parseFloat(document.getElementById('meridianTz').value) || 0;
  var h = parseInt(document.getElementById('meridianTimeH').value, 10) || 0;
  var m = parseInt(document.getElementById('meridianTimeM').value, 10) || 0;
  var localSec = getClockErrorCorrectedLocalSec(h * 3600 + m * 60);
  var avgUtcSec = SightCalc.utcSecondsFromLocal(localSec, tzOffset);
  var baseUtcDate = new Date(dateInput + 'T00:00:00Z');
  baseUtcDate.setUTCSeconds(baseUtcDate.getUTCSeconds() + avgUtcSec);
  return { baseUtcDate: baseUtcDate, avgUtcSec: avgUtcSec, localSec: localSec };
}

function updateAlmanacHourLabels(baseUtcDate) {
  if (!baseUtcDate || isNaN(baseUtcDate.getTime())) return;
  var hourFloor = new Date(baseUtcDate.getTime());
  hourFloor.setUTCMinutes(0, 0, 0);
  var baseHour = hourFloor.getUTCHours();
  var nextUtcDate = new Date(hourFloor.getTime() + 3600 * 1000);
  var nextHour = nextUtcDate.getUTCHours();

  var options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  var baseDateStr = hourFloor.toLocaleDateString('en-US', options);
  var nextDateStr = nextUtcDate.toLocaleDateString('en-US', options);

  document.querySelectorAll('.lblBaseHour').forEach(function (el) { el.innerText = baseHour; });
  document.querySelectorAll('.lblNextHour').forEach(function (el) { el.innerText = nextHour; });
  document.querySelectorAll('.lblBaseDate').forEach(function (el) { el.innerText = baseDateStr; });
  document.querySelectorAll('.lblNextDate').forEach(function (el) { el.innerText = nextDateStr; });
}

// ---------------------------------------------------------------------
// STATE COLLECTION -- the DOM <-> plain-object seam, same pattern as
// app.js's collectFormState()/applyFormState().
// ---------------------------------------------------------------------

function collectFormState() {
  var g = function (id) { return document.getElementById(id); };
  var num = function (id) { return parseFloat(g(id).value) || 0; };

  return {
    schemaVersion: 1,
    title: null,
    notes: g('meridianNotes').value.trim(),
    date: g('meridianDate').value,
    body: { type: 'sun', name: null, limb: 'lower' },
    tzOffset: num('meridianTz'),
    sunBearsSouth: g('sunBears').value === 'S',
    time: { h: parseInt(g('meridianTimeH').value, 10) || 0, m: parseInt(g('meridianTimeM').value, 10) || 0 },
    hs: { deg: num('meridianHsDeg'), min: num('meridianHsMin') },
    corrections: {
      ieMin: num('ieMin'), ieSign: g('ieSign').value,
      dipMin: num('dipMin'),
      altCorrMin: num('altCorrMin'), altCorrSign: g('altCorrSign').value,
      addAltCorrMin: num('addAltCorrMin'), addAltCorrSign: g('addAltCorrSign').value,
      clockErrorSec: num('clockErrorSec'), clockErrorDirection: _clockErrorDirection
    },
    almanac: {
      decBaseDeg: num('decBaseDeg'), decBaseMin: num('decBaseMin'), decBaseNS: g('decBaseNS').value,
      decNextDeg: num('decNextDeg'), decNextMin: num('decNextMin'), decNextNS: g('decNextNS').value
    },
    mirrorSightId: _currentMirrorSightId,
    mirrorLon: _handoffLon
  };
}

/** Writes a plain Meridian Passage record back onto the form (used by Load / Import). */
function applyFormState(state) {
  var g = function (id) { return document.getElementById(id); };
  var setVal = function (id, v) { g(id).value = (v === undefined || v === null) ? '' : v; };

  setVal('meridianNotes', state.notes || '');
  setVal('meridianDate', state.date || '');
  setVal('meridianTz', state.tzOffset);
  setVal('sunBears', state.sunBearsSouth === false ? 'N' : 'S');
  _sunBearsUserTouched = true; // a loaded/imported record's choice was deliberate, not a live default to keep recomputing

  var t = state.time || {};
  setVal('meridianTimeH', t.h !== undefined ? String(t.h).padStart(2, '0') : '');
  setVal('meridianTimeM', t.m !== undefined ? String(t.m).padStart(2, '0') : '');

  var hs = state.hs || {};
  setVal('meridianHsDeg', hs.deg);
  setVal('meridianHsMin', hs.min);

  var c = state.corrections || {};
  setVal('ieMin', c.ieMin); setVal('ieSign', c.ieSign || 'on');
  setVal('dipMin', c.dipMin);
  setVal('altCorrMin', c.altCorrMin); setVal('altCorrSign', c.altCorrSign || '+');
  setVal('addAltCorrMin', c.addAltCorrMin); setVal('addAltCorrSign', c.addAltCorrSign || '+');
  setVal('clockErrorSec', c.clockErrorSec || 0);
  setClockErrorDirection(c.clockErrorDirection === 'slow' ? 'slow' : 'fast');

  var a = state.almanac || {};
  setVal('decBaseDeg', a.decBaseDeg); setVal('decBaseMin', a.decBaseMin); setVal('decBaseNS', a.decBaseNS || 'N');
  setVal('decNextDeg', a.decNextDeg); setVal('decNextMin', a.decNextMin); setVal('decNextNS', a.decNextNS || 'N');

  _handoffLon = (state.mirrorLon !== undefined) ? state.mirrorLon : null;
  _currentMirrorSightId = state.mirrorSightId || null;

  _almanacFieldsContext = currentAlmanacContextKey();
  refreshLiveCalculations();
}

/** Shape SightCalc.computeAutoName() expects -- same "yyyy-mm-dd HH.mm.ss Sun" naming convention as every other sight. */
function autoNameStateFromMeridian(state) {
  return {
    date: state.date,
    body: { type: 'sun', name: null },
    observations: [{ h: state.time.h, m: state.time.m, s: 0, heightDeg: state.hs.deg, heightMin: state.hs.min }],
    corrections: { clockErrorSec: state.corrections.clockErrorSec, clockErrorDirection: state.corrections.clockErrorDirection }
  };
}

// ---------------------------------------------------------------------
// LIVE / REACTIVE CALCULATION -- same model as app.js's refreshLiveCalculations.
// ---------------------------------------------------------------------

function updateObservationSummary() {
  var hsDegVal = document.getElementById('meridianHsDeg').value;
  var ctx = currentUtcContext();
  if (!ctx || hsDegVal.trim() === '') {
    resetObservationDisplay();
    return;
  }

  var hs = SightCalc.dmToDecimal(parseFloat(hsDegVal) || 0, parseFloat(document.getElementById('meridianHsMin').value) || 0);
  var corrections = collectCorrections();
  var ha = SightCalc.computeHa(hs, corrections);
  var ho = SightCalc.computeHo(hs, corrections);
  document.getElementById('avgLocalTimeCorrected').innerText = SightCalc.secondsToTimeString(ctx.localSec);
  document.getElementById('avgUtcTime').innerText = SightCalc.secondsToTimeString(ctx.avgUtcSec) + ' UTC';
  document.getElementById('avgHs').innerText = SightCalc.formatDegMin(hs);
  document.getElementById('computedHa').innerText = SightCalc.formatDegMin(ha);
  document.getElementById('computedHo').innerText = SightCalc.formatDegMin(ho);

  updateAlmanacHourLabels(ctx.baseUtcDate);
}

function resetObservationDisplay() {
  document.getElementById('avgLocalTimeCorrected').innerText = '--:--:--';
  document.getElementById('avgUtcTime').innerText = '--:--:-- UTC';
  document.getElementById('avgHs').innerText = "--° --.-'";
  document.getElementById('computedHa').innerText = "--° --.-'";
  document.getElementById('computedHo').innerText = "--° --.-'";
}

function getAlmanacFieldIds() {
  return ['decBaseDeg', 'decBaseMin', 'decNextDeg', 'decNextMin'];
}

function almanacFieldsAnyFilled() {
  return getAlmanacFieldIds().some(function (id) { return document.getElementById(id).value.trim() !== ''; });
}

function currentAlmanacContextKey() {
  var ctx = currentUtcContext();
  if (!ctx) return null;
  var hourFloor = new Date(ctx.baseUtcDate.getTime());
  hourFloor.setUTCMinutes(0, 0, 0);
  return 'sun|' + hourFloor.toISOString();
}

function getAlmanacFetchReadiness() {
  return !!document.getElementById('meridianDate').value &&
         hasCompleteTime() &&
         document.querySelectorAll('.input-error').length === 0;
}

function getCalcReadiness() {
  return getAlmanacFetchReadiness() &&
         document.getElementById('meridianHsDeg').value.trim() !== '' &&
         allFilled(getAlmanacFieldIds()) &&
         document.querySelectorAll('.input-error').length === 0;
}

function resetInterpAndResultsDisplay() {
  document.getElementById('outputCard').style.display = 'none';
  document.getElementById('resLatitude').innerText = '--';
  _lastResult = null;
}

function setFetchButtonState(enabled, label) {
  var btn = document.getElementById('btnFetchUsno');
  btn.disabled = !enabled;
  btn.textContent = label;
}

function markAlmanacFieldsManuallyEdited() {
  _almanacFieldsContext = currentAlmanacContextKey();
}

/** Cache-only reactive fill, same policy as app.js's tryAutoFillAlmanacFromCache -- see its own comment for the blank/stale/valid state machine this mirrors. */
function tryAutoFillAlmanacFromCache() {
  if (!getAlmanacFetchReadiness()) {
    setFetchButtonState(false, 'Download data');
    setUsnoStatus('', '');
    _autoFillLoopGuard = { signature: null, count: 0 };
    return;
  }

  var currentContext = currentAlmanacContextKey();
  var almanacIds = getAlmanacFieldIds();
  var isComplete = allFilled(almanacIds);
  var hasAnyValue = almanacFieldsAnyFilled();

  if (hasAnyValue && _almanacFieldsContext === null) {
    _almanacFieldsContext = currentContext;
  }
  var isStale = hasAnyValue && _almanacFieldsContext !== currentContext;

  if (isComplete && !isStale) {
    setFetchButtonState(false, 'Fill with cached data');
    setUsnoStatus('', '');
    _autoFillLoopGuard = { signature: null, count: 0 };
    return;
  }

  var ctx = currentUtcContext();
  var hourFloor = new Date(ctx.baseUtcDate.getTime());
  hourFloor.setUTCMinutes(0, 0, 0);
  var nextUtcDate = new Date(hourFloor.getTime() + 3600 * 1000);

  SightUsno.getAlmanacFillFromCacheOnly({ type: 'sun', name: null }, hourFloor, nextUtcDate)
    .then(function (result) {
      if (!getAlmanacFetchReadiness()) return;

      var contextNow = currentAlmanacContextKey();
      var isCompleteNow = allFilled(almanacIds);
      var hasAnyValueNow = almanacFieldsAnyFilled();
      var isStaleNow = hasAnyValueNow && _almanacFieldsContext !== contextNow;
      if (isCompleteNow && !isStaleNow) return;

      var cached = !!result;
      var autoFillOn = document.getElementById('toggleAutoFillCache').checked;

      if (!(autoFillOn && cached)) {
        var label = (autoFillOn && !cached) ? 'Download data' : cached ? 'Fill with cached data' : 'Download data and fill fields';
        setFetchButtonState(true, label);
        if (isStaleNow && !autoFillOn) {
          setUsnoStatus('Section 3 no longer matches the current date/time — tap "' + label + '" to update it.', 'error');
        } else if (autoFillOn && !cached) {
          setUsnoStatus('Not cached for this hour — tap Download to fetch from USNO.', '');
        } else {
          setUsnoStatus('', '');
        }
        _autoFillLoopGuard = { signature: null, count: 0 };
        return;
      }

      var signature = 'sun|' + contextNow;
      if (_autoFillLoopGuard.signature === signature) {
        _autoFillLoopGuard.count++;
      } else {
        _autoFillLoopGuard = { signature: signature, count: 1 };
      }
      if (_autoFillLoopGuard.count > 3) {
        setFetchButtonState(true, 'Download data');
        setUsnoStatus('Auto-fill isn’t able to complete this automatically — tap Download, or check the declination fields manually.', 'error');
        return;
      }

      applyUsnoFill(result.fill);
      setFetchButtonState(false, 'Fill with cached data');
      setUsnoStatus('Filled from cache.', 'ok');
    })
    .catch(function (err) {
      console.error(err);
      setFetchButtonState(true, 'Download data');
    });
}

/** Defaults Sun Bears from an incoming DR/Fix handoff latitude compared against declination -- see reduceMeridianSight's comment. Never overrides a choice the user (or a loaded record) already made. */
function maybeSetSunBearsDefault() {
  if (_sunBearsUserTouched || _handoffApLat === null) return;
  var degVal = document.getElementById('decBaseDeg').value;
  if (degVal.trim() === '') return;
  var dec = SightCalc.dmToDecimal(parseFloat(degVal) || 0, parseFloat(document.getElementById('decBaseMin').value) || 0);
  if (document.getElementById('decBaseNS').value === 'S') dec = -dec;
  document.getElementById('sunBears').value = (dec < _handoffApLat) ? 'S' : 'N';
}

function tryAutoCalculateReduction() {
  if (!getCalcReadiness()) {
    resetInterpAndResultsDisplay();
    return;
  }

  var hs = SightCalc.dmToDecimal(parseFloat(document.getElementById('meridianHsDeg').value) || 0, parseFloat(document.getElementById('meridianHsMin').value) || 0);
  var ho = SightCalc.computeHo(hs, collectCorrections());
  var ctx = currentUtcContext();
  var utcFractionOfHour = (ctx.avgUtcSec % 3600) / 3600;

  var decBase = SightCalc.dmToDecimal(parseFloat(document.getElementById('decBaseDeg').value) || 0, parseFloat(document.getElementById('decBaseMin').value) || 0);
  if (document.getElementById('decBaseNS').value === 'S') decBase = -decBase;
  var decNext = SightCalc.dmToDecimal(parseFloat(document.getElementById('decNextDeg').value) || 0, parseFloat(document.getElementById('decNextMin').value) || 0);
  if (document.getElementById('decNextNS').value === 'S') decNext = -decNext;

  var result = SightCalc.reduceMeridianSight({
    nonStar: { decBase: decBase, decNext: decNext },
    utcFractionOfHour: utcFractionOfHour,
    ho: ho,
    sunBearsSouth: document.getElementById('sunBears').value === 'S'
  });

  document.getElementById('resLatitude').innerText = SightCalc.formatLat(result.latitude);
  document.getElementById('outputCard').style.display = 'block';

  var obsUtcDate = new Date(ctx.baseUtcDate.getTime());

  _lastResult = {
    interpolatedDec: result.interpolatedDec,
    zenithDistance: result.zenithDistance,
    latitude: result.latitude,
    ho: ho,
    observationTime: obsUtcDate.toISOString()
  };
}

function refreshLiveCalculations() {
  updateObservationSummary();
  tryAutoFillAlmanacFromCache();
  maybeSetSunBearsDefault();
  tryAutoCalculateReduction();
  updateAutoNamePreview();
}

// ---------------------------------------------------------------------
// USNO AUTOFILL (declination only -- see usno.js: GHA/Dec are geocentric,
// position-independent, so this reuses the exact same cache/fetch plumbing
// as New Sight, just applying only the Declination half of the fill)
// ---------------------------------------------------------------------

function setUsnoStatus(msg, kind) {
  var el = document.getElementById('usnoStatus');
  el.textContent = msg;
  el.className = 'usno-status' + (kind ? ' ' + kind : '');
}

function flashField(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('autofilled-flash');
  void el.offsetWidth;
  el.classList.add('autofilled-flash');
}

function fillDegMin(degId, minId, signId, decimalDeg, signValue) {
  var dm = SightCalc.decimalToDM(decimalDeg);
  document.getElementById(degId).value = dm.deg;
  document.getElementById(minId).value = dm.min.toFixed(1);
  flashField(degId);
  flashField(minId);
  if (signId) document.getElementById(signId).value = signValue;
}

function applyUsnoFill(fill) {
  fillDegMin('decBaseDeg', 'decBaseMin', 'decBaseNS', fill.decBaseDeg, fill.decBaseSign);
  fillDegMin('decNextDeg', 'decNextMin', 'decNextNS', fill.decNextDeg, fill.decNextSign);
  _almanacFieldsContext = currentAlmanacContextKey();
  refreshLiveCalculations();
}

function onFetchUsno() {
  var btn = document.getElementById('btnFetchUsno');
  var missing = [];
  if (!document.getElementById('meridianDate').value) missing.push('the date (Section 1)');
  if (!hasCompleteTime()) missing.push('the observation time (Section 2)');
  if (document.querySelectorAll('.input-error').length > 0) missing.push('valid values for the field(s) currently outlined in red');

  if (missing.length) {
    setUsnoStatus('Can’t fetch almanac data yet — still missing: ' + missing.join('; ') + '.', 'error');
    return;
  }

  var ctx = currentUtcContext();
  var hourFloor = new Date(ctx.baseUtcDate.getTime());
  hourFloor.setUTCMinutes(0, 0, 0);
  var nextUtcDate = new Date(hourFloor.getTime() + 3600 * 1000);

  btn.disabled = true;
  setUsnoStatus('Checking cache…', 'loading');

  // GHA/Dec are geocentric (see usno.js) -- coords are a required API param
  // but don't affect the returned declination, so a handed-off DR/Fix
  // position is used opportunistically and 0,0 otherwise; never shown or
  // treated as this sight's own position.
  var lat = _handoffApLat !== null ? _handoffApLat : 0;
  var lon = _handoffLon !== null ? _handoffLon : 0;

  SightUsno.getAlmanacFillWithCache({ type: 'sun', name: null }, hourFloor, nextUtcDate, lat, lon)
    .then(function (result) {
      applyUsnoFill(result.fill);
      var msg = 'Filled declination ' + (result.fromCache ? 'from cache' : 'from USNO') + ' for hour ' +
        String(hourFloor.getUTCHours()).padStart(2, '0') + '–' +
        String(nextUtcDate.getUTCHours()).padStart(2, '0') + 'z on ' +
        hourFloor.toISOString().split('T')[0] + '.';
      setUsnoStatus(msg, 'ok');
      showToast('Almanac data filled' + (result.fromCache ? ' (from cache).' : '.'));
    })
    .catch(function (err) {
      console.error(err);
      var msg = err && err.message ? err.message : 'Could not get almanac data.';
      if (navigator.onLine === false) {
        msg += ' You appear to be offline and this hour isn’t cached yet — enter the declination manually, or pre-download it from the New Sight page’s Offline Almanac Cache section.';
      }
      setUsnoStatus(msg, 'error');
      tryAutoFillAlmanacFromCache();
    });
}

// ---------------------------------------------------------------------
// SAVED MERIDIAN PASSAGES (this page's own inline list -- MeridianStorage
// isn't SightStorage, so these don't appear on the Sights page)
// ---------------------------------------------------------------------

function renderSavedMeridianList() {
  MeridianStorage.list().then(function (entries) {
    var listEl = document.getElementById('savedMeridianList');
    var emptyEl = document.getElementById('savedMeridianEmpty');
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    entries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'saved-item';
      item.innerHTML =
        '<div class="saved-item-info"><div class="saved-item-title"></div><div class="saved-item-meta"></div></div>' +
        '<div class="saved-item-actions"><button class="btn-mini btn-mini-load">Load</button><button class="btn-mini btn-mini-del">Delete</button></div>';

      item.querySelector('.saved-item-title').textContent = entry.title || 'Untitled';
      item.querySelector('.saved-item-meta').textContent =
        (typeof entry.latitude === 'number' ? SightCalc.formatLat(entry.latitude) : 'not yet resolved') +
        ' · saved ' + new Date(entry.savedAt).toLocaleString();

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        MeridianStorage.get(entry.id).then(function (record) {
          if (!record) { showToast('Could not find that saved sight.', true); return; }
          applyFormState(record);
          _currentRecordId = record.id;
          showToast('Loaded "' + (record.title || 'sight') + '".');
        });
      });

      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        if (!confirm('Delete "' + (entry.title || 'this sight') + '"?')) return;
        MeridianStorage.remove(entry.id).then(function () {
          if (_currentRecordId === entry.id) _currentRecordId = null;
          showToast('Deleted.');
          renderSavedMeridianList();
        });
      });

      listEl.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------------
// SAVE / EXPORT / IMPORT / CLEAR
// ---------------------------------------------------------------------

function showToast(message, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

function updateAutoNamePreview() {
  var el = document.getElementById('autoNamePreview');
  if (!el) return;
  try {
    el.textContent = SightCalc.computeAutoName(autoNameStateFromMeridian(collectFormState()));
  } catch (e) {
    console.error('updateAutoNamePreview failed (non-fatal, preview left as-is):', e);
  }
}

function onSave() {
  var state = collectFormState();
  var autoName = SightCalc.computeAutoName(autoNameStateFromMeridian(state));

  var name = prompt('Save Meridian Passage sight as:', autoName);
  if (name === null) return; // cancelled
  name = name.trim() || autoName;

  MeridianStorage.list().then(function (existing) {
    resolveSaveName(existing, name, autoName, function (finalName, targetId) {
      if (finalName === null) return; // backed out of the whole save

      var toSave = collectFormState();
      toSave.title = finalName;
      if (targetId) toSave.id = targetId;
      if (_lastResult) toSave.results = _lastResult;

      var isNewRecord = !targetId;

      MeridianStorage.save(toSave).then(function (saved) {
        _currentRecordId = saved.id;
        showToast((isNewRecord ? 'Saved as new Meridian Passage sight "' : 'Saved as "') + finalName + '".');
        renderSavedMeridianList();
      }).catch(function (err) {
        console.error(err);
        showToast('Could not save (storage may be full or unavailable).', true);
      });
    });
  }).catch(function (err) {
    console.error(err);
    showToast('Could not check existing saved Meridian Passage sights.', true);
  });
}

/** Same "Save As" overwrite-or-rename flow as app.js's resolveSaveName -- see its own comment. */
function resolveSaveName(existing, name, autoName, callback) {
  var collision = null;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].title === name) { collision = existing[i]; break; }
  }

  if (!collision) {
    callback(name, null);
    return;
  }

  var overwrite = confirm(
    'A Meridian Passage sight named "' + name + '" already exists.\n\n' +
    'OK: save over it.\n' +
    'Cancel: change the name.'
  );
  if (overwrite) {
    callback(name, collision.id);
    return;
  }

  var retry = prompt('Save Meridian Passage sight as:', name);
  if (retry === null) { callback(null, null); return; }
  resolveSaveName(existing, retry.trim() || autoName, autoName, callback);
}

function onExportJson() {
  var state = collectFormState();
  if (_lastResult) state.results = _lastResult;

  var autoName = SightCalc.computeAutoName(autoNameStateFromMeridian(state));
  var name = prompt('Export Meridian Passage sight as:', autoName);
  if (name === null) return;
  name = name.trim() || autoName;

  var filename = name + '.json';
  var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast('Exported ' + filename);
}

function onImportJson(evt) {
  var file = evt.target.files && evt.target.files[0];
  if (!file) return;

  var reader = new FileReader();
  reader.onload = function () {
    try {
      var parsed = JSON.parse(reader.result);
      if (!parsed || !parsed.time || !parsed.hs) {
        throw new Error('File does not look like a Meridian Passage record.');
      }
      applyFormState(parsed);
      _currentRecordId = null; // imported record is treated as new/unsaved until Save
      showToast('Imported Meridian Passage sight from ' + file.name);
    } catch (err) {
      console.error(err);
      showToast('Could not import file: not a valid Meridian Passage JSON.', true);
    } finally {
      evt.target.value = '';
    }
  };
  reader.onerror = function () {
    showToast('Could not read the selected file.', true);
    evt.target.value = '';
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('Are you sure you want to clear all entered data?')) return;

  document.querySelectorAll('input').forEach(function (i) {
    if (i.type !== 'date' && i.type !== 'file') i.value = '';
  });
  document.getElementById('ieMin').value = '0.0';
  document.getElementById('dipMin').value = '0.0';
  document.getElementById('altCorrMin').value = '0.0';
  document.getElementById('addAltCorrMin').value = '0.0';
  document.getElementById('clockErrorSec').value = '0';
  document.getElementById('meridianTz').value = '-4';
  document.getElementById('sunBears').value = 'S';

  _sunBearsUserTouched = false;
  _handoffApLat = null;
  _handoffLon = null;
  _currentRecordId = null;
  _currentMirrorSightId = null;
  _almanacFieldsContext = null;
  _autoFillLoopGuard = { signature: null, count: 0 };

  setClockErrorDirection('fast');
  refreshLiveCalculations();
}

// ---------------------------------------------------------------------
// ADD TO A FIX / SEND TO DR LEG -- see file header for the mirror-sight
// design this relies on.
// ---------------------------------------------------------------------

/**
 * Longitude to place the mirror's AP at -- averaged from the target Fix's
 * OTHER members (excluding this same meridian sight's own prior mirror, if
 * it's already a member) so the LOP lands visually where the rest of that
 * Fix actually is, rather than off at some arbitrary point. Resolves null
 * if the fix has no other members with a usable position yet (a brand new
 * fix, or one containing only this mirror so far).
 */
function averageLonOfOtherFixMembers(fix) {
  var otherIds = fix.sightIds.filter(function (id) { return id !== _currentMirrorSightId; });
  if (!otherIds.length) return Promise.resolve(null);

  return Promise.all(otherIds.map(function (id) { return SightStorage.get(id); })).then(function (records) {
    var lons = [];
    records.forEach(function (r) {
      if (!r || !r.position) return;
      lons.push(SightCalc.signedPositionFromRecord(r.position).lon);
    });
    if (!lons.length) return null;
    return lons.reduce(function (a, b) { return a + b; }, 0) / lons.length;
  });
}

/** Creates/updates the mirror Sight (see meridianStorage.js's buildMirrorSightRecord) at the given longitude and returns a Promise<mirrorSightId>. */
function ensureMirrorSight(mirrorLon) {
  if (!_currentRecordId) return Promise.reject(new Error('Save this Meridian Passage sight first, then add it to a Fix.'));
  if (!_lastResult) return Promise.reject(new Error('Calculate a latitude first, then add it to a Fix.'));

  var record = collectFormState();
  record.id = _currentRecordId;
  record.results = _lastResult;

  var mirror = MeridianStorage.buildMirrorSightRecord(record, mirrorLon);
  if (_currentMirrorSightId) mirror.id = _currentMirrorSightId;

  return SightStorage.save(mirror).then(function (saved) {
    _currentMirrorSightId = saved.id;
    return MeridianStorage.get(_currentRecordId).then(function (rec) {
      if (!rec) return;
      rec.mirrorSightId = saved.id;
      rec.mirrorLon = mirrorLon;
      return MeridianStorage.save(rec);
    }).then(function () {
      return saved.id;
    });
  });
}

function openAddToFixPanel() {
  if (!_currentRecordId) { showToast('Save this Meridian Passage sight first, then add it to a Fix.', true); return; }
  if (!_lastResult) { showToast('Calculate a latitude first, then add it to a Fix.', true); return; }

  var select = document.getElementById('addToFixSelect');
  select.innerHTML = '<option value="__new__">+ Create a new fix</option>';

  FixStorage.list().then(function (entries) {
    entries.forEach(function (entry) {
      var opt = document.createElement('option');
      opt.value = entry.id;
      opt.textContent = entry.name || 'Untitled Fix';
      select.appendChild(opt);
    });
    var panel = document.getElementById('addToFixPanel');
    panel.style.display = 'block';
    updateAddToFixPanel();
    if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function updateAddToFixPanel() {
  var isNew = document.getElementById('addToFixSelect').value === '__new__';
  document.getElementById('newFixNameGroup').style.display = isNew ? 'block' : 'none';
  if (isNew && !document.getElementById('newFixNameInput').value) {
    var d = new Date();
    document.getElementById('newFixNameInput').value = 'Fix - ' + (d.getMonth() + 1) + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
  }
}

function closeAddToFixPanel() {
  document.getElementById('addToFixPanel').style.display = 'none';
}

function onConfirmAddToFix() {
  var select = document.getElementById('addToFixSelect');

  var fixPromise = select.value === '__new__'
    ? FixStorage.save({ name: document.getElementById('newFixNameInput').value.trim() || 'Untitled Fix', sightIds: [], type: 'SIGHT_DERIVED' })
    : FixStorage.get(select.value);

  fixPromise.then(function (fix) {
    if (!fix) throw new Error('Fix not found');

    return averageLonOfOtherFixMembers(fix).then(function (avgLon) {
      var usingFallback = avgLon === null && _handoffLon === null;
      var mirrorLon = avgLon !== null ? avgLon : (_handoffLon !== null ? _handoffLon : 0);

      return ensureMirrorSight(mirrorLon).then(function (mirrorSightId) {
        if (fix.sightIds.indexOf(mirrorSightId) === -1) fix.sightIds.push(mirrorSightId);
        if (fix.activeSightIds && fix.activeSightIds.indexOf(mirrorSightId) === -1) fix.activeSightIds.push(mirrorSightId);
        return FixStorage.save(fix).then(function (saved) {
          if (usingFallback) {
            showToast('Added "' + saved.name + '" — no other sights in this Fix yet to align with, so it’s placed at longitude 0° for now; run Add to a Fix again once this Fix has other sights, to re-center it.', true);
          } else {
            showToast('Added to "' + saved.name + '".');
          }
          closeAddToFixPanel();
        });
      });
    });
  }).catch(function (err) {
    console.error(err);
    showToast(err && err.message ? err.message : 'Could not add to that fix.', true);
  });
}

/**
 * Sends this result's position (calculated latitude + the longitude
 * carried in from a DR/Fix handoff) to DR Leg as its start. Unlike Add to
 * a Fix, this REQUIRES a real longitude -- a fabricated one would become a
 * position the user actually navigates from, not just a chart-placement
 * detail, so there's no 0,0 fallback here.
 */
function onSendToDrLeg() {
  if (!_currentRecordId) { showToast('Save this Meridian Passage sight first, then send it to DR Leg.', true); return; }
  if (!_lastResult) { showToast('Calculate a latitude first, then send it to DR Leg.', true); return; }
  if (_handoffLon === null) {
    showToast('No longitude is known for this sight — open Meridian Passage from a DR Leg or Fix so a longitude is carried along, then try again.', true);
    return;
  }

  var tzOffset = parseFloat(document.getElementById('meridianTz').value) || 0;
  var position = SightCalc.makePosition(_lastResult.observationTime, _lastResult.latitude, _handoffLon, SightCalc.POSITION_SOURCE_TYPES.FIX, _currentRecordId);
  sessionStorage.setItem('ocsrDrLegStartHandoff', JSON.stringify({ position: position, tzOffset: tzOffset, sentFrom: 'Meridian Passage' }));
  location.href = 'drleg.html';
}
