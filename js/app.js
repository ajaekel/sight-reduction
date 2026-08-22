/**
 * app.js
 * UI layer only: DOM reads/writes, event wiring, validation feedback.
 * All actual math lives in calc.js (window.SightCalc).
 * All persistence lives in storage.js (window.SightStorage).
 *
 * The important seam: collectFormState() turns the DOM into a plain
 * "sight record" object, and applyFormState() does the reverse. Everything
 * else (save, export, import, calculation) operates on that plain object,
 * never on the DOM directly.
 */

var APP_VERSION = 'phase1-v1';
var sightingCount = 0;

document.addEventListener('DOMContentLoaded', initApp);

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
});

function initApp() {
  try {
    document.getElementById('sightDate').value = new Date().toISOString().split('T')[0];
  } catch (e) {}

  document.getElementById('bodyType').addEventListener('change', handleBodyTypeChange);
  document.getElementById('bodyName').addEventListener('input', updateHeaders);
  document.getElementById('planetSelect').addEventListener('change', function () {
    updateAverages();
    updateHeaders();
  });

  document.getElementById('btnAddSight').addEventListener('click', function () {
    addSightingLine(true);
  });
  document.getElementById('btnClearAll').addEventListener('click', clearAllData);
  document.getElementById('btnCalc').addEventListener('click', calculateSight);

  document.getElementById('btnSaveSight').addEventListener('click', onSaveSight);
  document.getElementById('btnExportJson').addEventListener('click', onExportJson);
  document.getElementById('fileImportJson').addEventListener('change', onImportJson);

  ['tzOffset', 'ieMin', 'dipMin', 'altCorrMin', 'addAltCorrMin'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', updateAverages);
  });
  ['ieSign', 'altCorrSign', 'addAltCorrSign'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', updateAverages);
  });

  // --- SECTION 1: AP POSITION VALIDATION ---
  var errLat = document.getElementById('errLat');
  var errLon = document.getElementById('errLon');

  var validateLat = function () { validateDegMinPair(document.getElementById('latDeg'), document.getElementById('latMin'), 90, 'Latitude', errLat); };
  var validateLon = function () { validateDegMinPair(document.getElementById('lonDeg'), document.getElementById('lonMin'), 180, 'Longitude', errLon); };

  document.getElementById('latDeg').addEventListener('input', validateLat);
  document.getElementById('latMin').addEventListener('input', validateLat);
  document.getElementById('lonDeg').addEventListener('input', validateLon);
  document.getElementById('lonMin').addEventListener('input', validateLon);

  // --- SECTION 3: STAR ALMANAC VALIDATION ---
  var errGhaAriesBase = document.getElementById('errGhaAriesBase');
  var errGhaAriesNext = document.getElementById('errGhaAriesNext');
  var errSha = document.getElementById('errSha');
  var errDecStar = document.getElementById('errDecStar');

  var validateGhaAriesBase = function () { validateDegMinPair(document.getElementById('ghaAriesBaseDeg'), document.getElementById('ghaAriesBaseMin'), 360, 'GHA Aries Base', errGhaAriesBase); };
  var validateGhaAriesNext = function () { validateDegMinPair(document.getElementById('ghaAriesNextDeg'), document.getElementById('ghaAriesNextMin'), 360, 'GHA Aries Next', errGhaAriesNext); };
  var validateSha = function () { validateDegMinPair(document.getElementById('shaDeg'), document.getElementById('shaMin'), 360, 'SHA', errSha); };
  var validateDecStar = function () { validateDegMinPair(document.getElementById('decStarDeg'), document.getElementById('decStarMin'), 90, 'Star Declination', errDecStar); };

  document.getElementById('ghaAriesBaseDeg').addEventListener('input', validateGhaAriesBase);
  document.getElementById('ghaAriesBaseMin').addEventListener('input', validateGhaAriesBase);
  document.getElementById('ghaAriesNextDeg').addEventListener('input', validateGhaAriesNext);
  document.getElementById('ghaAriesNextMin').addEventListener('input', validateGhaAriesNext);
  document.getElementById('shaDeg').addEventListener('input', validateSha);
  document.getElementById('shaMin').addEventListener('input', validateSha);
  document.getElementById('decStarDeg').addEventListener('input', validateDecStar);
  document.getElementById('decStarMin').addEventListener('input', validateDecStar);

  // --- SECTION 3: NON-STAR ALMANAC VALIDATION ---
  var errGhaBase = document.getElementById('errGhaBase');
  var errGhaNext = document.getElementById('errGhaNext');
  var errDecBase = document.getElementById('errDecBase');
  var errDecNext = document.getElementById('errDecNext');

  var validateGhaBase = function () { validateDegMinPair(document.getElementById('ghaBaseDeg'), document.getElementById('ghaBaseMin'), 360, 'GHA Base', errGhaBase); };
  var validateGhaNext = function () { validateDegMinPair(document.getElementById('ghaNextDeg'), document.getElementById('ghaNextMin'), 360, 'GHA Next', errGhaNext); };
  var validateDecBase = function () { validateDegMinPair(document.getElementById('decBaseDeg'), document.getElementById('decBaseMin'), 90, 'Declination Base', errDecBase); };
  var validateDecNext = function () { validateDegMinPair(document.getElementById('decNextDeg'), document.getElementById('decNextMin'), 90, 'Declination Next', errDecNext); };

  document.getElementById('ghaBaseDeg').addEventListener('input', validateGhaBase);
  document.getElementById('ghaBaseMin').addEventListener('input', validateGhaBase);
  document.getElementById('ghaNextDeg').addEventListener('input', validateGhaNext);
  document.getElementById('ghaNextMin').addEventListener('input', validateGhaNext);
  document.getElementById('decBaseDeg').addEventListener('input', validateDecBase);
  document.getElementById('decBaseMin').addEventListener('input', validateDecBase);
  document.getElementById('decNextDeg').addEventListener('input', validateDecNext);
  document.getElementById('decNextMin').addEventListener('input', validateDecNext);

  addSightingLine(false);
  handleBodyTypeChange();
  refreshSavedList();

  if (window.SightStorage && SightStorage.requestPersistence) {
    SightStorage.requestPersistence();
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(function (err) {
      console.warn('Service worker registration failed:', err);
    });
  }
}

function handleBodyTypeChange() {
  var type = document.getElementById('bodyType').value;
  var nameContainer = document.getElementById('bodyNameContainer');
  var nameLabel = document.getElementById('bodyNameLabel');
  var nameInput = document.getElementById('bodyName');
  var planetSelect = document.getElementById('planetSelect');
  var starFields = document.getElementById('starFields');
  var nonStarFields = document.getElementById('nonStarFields');

  nameInput.style.display = 'none';
  planetSelect.style.display = 'none';
  nameContainer.style.display = 'none';

  if (type === 'star') {
    nameContainer.style.display = 'block';
    nameLabel.innerText = 'Star Name';
    nameInput.style.display = 'block';
    starFields.style.display = 'block';
    nonStarFields.style.display = 'none';
  } else if (type === 'planet') {
    nameContainer.style.display = 'block';
    nameLabel.innerText = 'Planet Name';
    planetSelect.style.display = 'block';
    starFields.style.display = 'none';
    nonStarFields.style.display = 'block';
  } else {
    nameInput.value = '';
    starFields.style.display = 'none';
    nonStarFields.style.display = 'block';
  }

  updateHeaders();
}

function updateHeaders() {
  var type = document.getElementById('bodyType').value;
  var starHeader = document.getElementById('starSectionHeader');
  var nonStarHeader = document.getElementById('nonStarSectionHeader');

  var starInput = document.getElementById('bodyName');
  var starName = starInput ? starInput.value.trim().toUpperCase() : '';

  var planetSelect = document.getElementById('planetSelect');
  var planetName = planetSelect ? planetSelect.value.trim().toUpperCase() : '';

  if (starHeader) {
    starHeader.innerText = starName ? 'STAR ' + starName : 'STAR';
  }

  if (nonStarHeader) {
    if (type === 'planet') {
      nonStarHeader.innerText = planetName ? 'PLANET ' + planetName : 'PLANET';
    } else if (type === 'moon') {
      nonStarHeader.innerText = 'MOON';
    } else {
      nonStarHeader.innerText = 'SUN';
    }
  }
}

function addSightingLine(autoFocus) {
  sightingCount++;
  var container = document.getElementById('sightingsContainer');
  var div = document.createElement('div');
  div.className = 'sighting-item';
  div.id = 'sightLine_' + sightingCount;

  div.innerHTML =
    '<div class="input-row">' +
      '<div class="sighting-side-label">' + sightingCount + '</div>' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" class="time-box t-h" placeholder="12" maxlength="2">' +
      '<span>:</span>' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" class="time-box t-m" placeholder="00" maxlength="2">' +
      '<span>:</span>' +
      '<input type="text" inputmode="numeric" pattern="[0-9]*" class="time-box t-s" placeholder="00" maxlength="2">' +
      '<input type="text" inputmode="decimal" class="s-deg" placeholder="31">' +
      '<input type="text" inputmode="decimal" class="s-min" placeholder="08.1">' +
      (sightingCount > 1 ? '<button class="btn-del" type="button">\u2715</button>' : '') +
    '</div>' +
    '<div class="error-msg"></div>';

  container.appendChild(div);

  var th = div.querySelector('.t-h');
  var tm = div.querySelector('.t-m');
  var ts = div.querySelector('.t-s');
  var sd = div.querySelector('.s-deg');
  var sm = div.querySelector('.s-min');
  var errBox = div.querySelector('.error-msg');

  th.addEventListener('input', function () {
    validateField(this, 0, 23, 'Hours', errBox);
    autoFocusNext(th, 2, tm);
  });

  tm.addEventListener('input', function () {
    validateField(this, 0, 59, 'Minutes', errBox);
    autoFocusNext(tm, 2, ts);
  });

  ts.addEventListener('input', function () {
    validateField(this, 0, 59, 'Seconds', errBox);
    autoFocusNext(ts, 2, sd);
  });

  sd.addEventListener('input', function () {
    validateField(this, 0, 90, 'Degrees', errBox, false);
    updateAverages();
  });

  sm.addEventListener('input', function () {
    validateField(this, 0, 60, 'Height Minutes', errBox, true);
    updateAverages();
  });

  [th, tm, ts, sd, sm].forEach(function (input) {
    input.addEventListener('focus', function () { this.select(); });
  });

  if (sightingCount > 1) {
    var delBtn = div.querySelector('.btn-del');
    delBtn.addEventListener('click', function () {
      div.remove();
      updateAverages();
    });
  }

  updateAverages();

  if (autoFocus) {
    th.focus();
    th.click();
    th.select();
  }
}

function validateField(el, min, max, labelName, errorEl, isStrictMax) {
  var valStr = el.value.trim();

  if (valStr === '') {
    el.classList.remove('input-error');
    if (errorEl) errorEl.style.display = 'none';
    return true;
  }

  var val = parseFloat(valStr);
  var isTooHigh = false;

  if (max !== null) {
    isTooHigh = isStrictMax ? (val >= max) : (val > max);
  }

  if (isNaN(val) || (min !== null && val < min) || isTooHigh) {
    el.classList.add('input-error');
    if (errorEl) {
      var rangeText = isStrictMax ? (min + ' to < ' + max) : (min + '\u2013' + max);
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
      errorEl.innerText = 'Invalid entry: ' + labelName + ' total must be 0\u2013' + maxDeg + '\u00B0';
      errorEl.style.display = 'block';
    }
    return false;
  }
  degEl.classList.remove('input-error');
  minEl.classList.remove('input-error');
  if (errorEl) errorEl.style.display = 'none';
  return true;
}

function autoFocusNext(el, maxChars, nextEl) {
  if (el.value.length >= maxChars) {
    if (el.value.length > maxChars) {
      el.value = el.value.slice(0, maxChars);
    }
    if (nextEl) {
      nextEl.focus();
      nextEl.select();
    }
  }
  updateAverages();
}

// ---------------------------------------------------------------------
// STATE COLLECTION -- the DOM <-> plain-object seam. Everything below this
// line either reads the form INTO a plain object, or writes a plain object
// BACK onto the form. calc.js and storage.js never see the DOM directly.
// ---------------------------------------------------------------------

function collectObservations() {
  var rows = document.querySelectorAll('.sighting-item');
  var observations = [];
  rows.forEach(function (row) {
    observations.push({
      h: parseInt(row.querySelector('.t-h').value, 10) || 0,
      m: parseInt(row.querySelector('.t-m').value, 10) || 0,
      s: parseInt(row.querySelector('.t-s').value, 10) || 0,
      heightDeg: parseFloat(row.querySelector('.s-deg').value) || 0,
      heightMin: parseFloat(row.querySelector('.s-min').value) || 0
    });
  });
  return observations;
}

/** Reads the entire form into a plain, serializable "sight record" object. */
function collectFormState() {
  var g = function (id) { return document.getElementById(id); };
  var num = function (id) { return parseFloat(g(id).value) || 0; };

  var bodyType = g('bodyType').value;

  return {
    id: null,
    schemaVersion: 1,
    label: g('sightLabel').value.trim(),
    date: g('sightDate').value,
    body: {
      type: bodyType,
      name: bodyType === 'star' ? g('bodyName').value.trim()
          : bodyType === 'planet' ? g('planetSelect').value
          : ''
    },
    position: {
      latDeg: num('latDeg'), latMin: num('latMin'), latNS: g('latNS').value,
      lonDeg: num('lonDeg'), lonMin: num('lonMin'), lonEW: g('lonEW').value,
      tzOffset: num('tzOffset')
    },
    observations: collectObservations(),
    corrections: {
      ieMin: num('ieMin'), ieSign: g('ieSign').value,
      dipMin: num('dipMin'),
      altCorrMin: num('altCorrMin'), altCorrSign: g('altCorrSign').value,
      addAltCorrMin: num('addAltCorrMin'), addAltCorrSign: g('addAltCorrSign').value
    },
    almanac: {
      star: {
        ghaAriesBaseDeg: num('ghaAriesBaseDeg'), ghaAriesBaseMin: num('ghaAriesBaseMin'),
        ghaAriesNextDeg: num('ghaAriesNextDeg'), ghaAriesNextMin: num('ghaAriesNextMin'),
        shaDeg: num('shaDeg'), shaMin: num('shaMin'),
        decDeg: num('decStarDeg'), decMin: num('decStarMin'), decNS: g('decStarNS').value
      },
      nonStar: {
        ghaBaseDeg: num('ghaBaseDeg'), ghaBaseMin: num('ghaBaseMin'),
        ghaNextDeg: num('ghaNextDeg'), ghaNextMin: num('ghaNextMin'),
        decBaseDeg: num('decBaseDeg'), decBaseMin: num('decBaseMin'), decBaseNS: g('decBaseNS').value,
        decNextDeg: num('decNextDeg'), decNextMin: num('decNextMin'), decNextNS: g('decNextNS').value
      }
    }
  };
}

/** Writes a plain "sight record" object back onto the form (used by Load / Import). */
function applyFormState(state) {
  var g = function (id) { return document.getElementById(id); };
  var setVal = function (id, v) { g(id).value = (v === undefined || v === null) ? '' : v; };

  setVal('sightLabel', state.label || '');
  setVal('sightDate', state.date || '');
  setVal('bodyType', (state.body && state.body.type) || 'sun');
  handleBodyTypeChange();

  if (state.body && state.body.type === 'star') {
    setVal('bodyName', state.body.name || '');
  } else if (state.body && state.body.type === 'planet') {
    setVal('planetSelect', state.body.name || '');
  }

  var p = state.position || {};
  setVal('latDeg', p.latDeg); setVal('latMin', p.latMin); setVal('latNS', p.latNS || 'N');
  setVal('lonDeg', p.lonDeg); setVal('lonMin', p.lonMin); setVal('lonEW', p.lonEW || 'W');
  setVal('tzOffset', p.tzOffset);

  var c = state.corrections || {};
  setVal('ieMin', c.ieMin); setVal('ieSign', c.ieSign || 'on');
  setVal('dipMin', c.dipMin);
  setVal('altCorrMin', c.altCorrMin); setVal('altCorrSign', c.altCorrSign || '+');
  setVal('addAltCorrMin', c.addAltCorrMin); setVal('addAltCorrSign', c.addAltCorrSign || '+');

  var a = state.almanac || {};
  var st = a.star || {};
  setVal('ghaAriesBaseDeg', st.ghaAriesBaseDeg); setVal('ghaAriesBaseMin', st.ghaAriesBaseMin);
  setVal('ghaAriesNextDeg', st.ghaAriesNextDeg); setVal('ghaAriesNextMin', st.ghaAriesNextMin);
  setVal('shaDeg', st.shaDeg); setVal('shaMin', st.shaMin);
  setVal('decStarDeg', st.decDeg); setVal('decStarMin', st.decMin); setVal('decStarNS', st.decNS || 'N');

  var ns = a.nonStar || {};
  setVal('ghaBaseDeg', ns.ghaBaseDeg); setVal('ghaBaseMin', ns.ghaBaseMin);
  setVal('ghaNextDeg', ns.ghaNextDeg); setVal('ghaNextMin', ns.ghaNextMin);
  setVal('decBaseDeg', ns.decBaseDeg); setVal('decBaseMin', ns.decBaseMin); setVal('decBaseNS', ns.decBaseNS || 'N');
  setVal('decNextDeg', ns.decNextDeg); setVal('decNextMin', ns.decNextMin); setVal('decNextNS', ns.decNextNS || 'N');

  // Rebuild sighting rows to match the loaded observation count.
  document.getElementById('sightingsContainer').innerHTML = '';
  sightingCount = 0;
  var obs = (state.observations && state.observations.length) ? state.observations : [{}];
  obs.forEach(function () { addSightingLine(false); });

  var rows = document.querySelectorAll('.sighting-item');
  rows.forEach(function (row, i) {
    var o = obs[i] || {};
    row.querySelector('.t-h').value = (o.h !== undefined) ? String(o.h).padStart(2, '0') : '';
    row.querySelector('.t-m').value = (o.m !== undefined) ? String(o.m).padStart(2, '0') : '';
    row.querySelector('.t-s').value = (o.s !== undefined) ? String(o.s).padStart(2, '0') : '';
    row.querySelector('.s-deg').value = (o.heightDeg !== undefined) ? o.heightDeg : '';
    row.querySelector('.s-min').value = (o.heightMin !== undefined) ? o.heightMin : '';
  });

  updateHeaders();
  updateAverages();
  document.getElementById('outputCard').style.display = 'none';
}

function getLineSeconds(row) {
  var h = parseInt(row.querySelector('.t-h').value, 10) || 0;
  var m = parseInt(row.querySelector('.t-m').value, 10) || 0;
  var s = parseInt(row.querySelector('.t-s').value, 10) || 0;
  return h * 3600 + m * 60 + s;
}

function updateAlmanacHourLabels(baseUtcDate) {
  if (!baseUtcDate || isNaN(baseUtcDate.getTime())) return;

  var baseHour = baseUtcDate.getUTCHours();
  var nextUtcDate = new Date(baseUtcDate.getTime() + (3600 * 1000));
  var nextHour = nextUtcDate.getUTCHours();

  var options = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  var baseDateStr = baseUtcDate.toLocaleDateString('en-US', options);
  var nextDateStr = nextUtcDate.toLocaleDateString('en-US', options);

  document.querySelectorAll('.lblBaseHour').forEach(function (el) { el.innerText = baseHour; });
  document.querySelectorAll('.lblNextHour').forEach(function (el) { el.innerText = nextHour; });
  document.querySelectorAll('.lblBaseDate').forEach(function (el) { el.innerText = baseDateStr; });
  document.querySelectorAll('.lblNextDate').forEach(function (el) { el.innerText = nextDateStr; });
}

/** Recomputes the running averages/Ho display as the user types (uses calc.js). */
function updateAverages() {
  var observations = collectObservations();
  var avg = SightCalc.averageObservations(observations);
  if (!avg) return;

  var corrections = {
    ieMin: parseFloat(document.getElementById('ieMin').value) || 0,
    ieSign: document.getElementById('ieSign').value,
    dipMin: parseFloat(document.getElementById('dipMin').value) || 0,
    altCorrMin: parseFloat(document.getElementById('altCorrMin').value) || 0,
    altCorrSign: document.getElementById('altCorrSign').value,
    addAltCorrMin: parseFloat(document.getElementById('addAltCorrMin').value) || 0,
    addAltCorrSign: document.getElementById('addAltCorrSign').value
  };
  var ho = SightCalc.computeHo(avg.avgHsDeg, corrections);

  var tzOffset = parseFloat(document.getElementById('tzOffset').value) || 0;
  var avgUtcSec = SightCalc.utcSecondsFromLocal(avg.avgLocalSec, tzOffset);

  document.getElementById('avgLocalTime').innerText = SightCalc.secondsToTimeString(avg.avgLocalSec);
  document.getElementById('avgUtcTime').innerText = SightCalc.secondsToTimeString(avgUtcSec) + ' UTC';
  document.getElementById('avgHs').innerText = SightCalc.formatDegMin(avg.avgHsDeg);
  document.getElementById('computedHo').innerText = SightCalc.formatDegMin(ho);

  var dateInput = document.getElementById('sightDate').value;
  var baseUtcDate = dateInput ? new Date(dateInput + 'T00:00:00Z') : new Date();
  baseUtcDate.setUTCSeconds(baseUtcDate.getUTCSeconds() + avgUtcSec);

  updateAlmanacHourLabels(baseUtcDate);
}

/** Converts a collected form-state object into the plain input shape calc.js expects. */
function buildCalcInput(state, avg, ho, avgUtcSec) {
  var p = state.position;
  var latTotal = SightCalc.dmToDecimal(p.latDeg, p.latMin);
  var lat = (p.latNS === 'S') ? -latTotal : latTotal;
  var lonTotal = SightCalc.dmToDecimal(p.lonDeg, p.lonMin);

  var minSecFractionHours = (avgUtcSec % 3600) / 3600;

  var input = {
    bodyType: state.body.type,
    lat: lat,
    lon: lonTotal,
    lonEW: p.lonEW,
    utcFractionOfHour: minSecFractionHours,
    ho: ho
  };

  if (state.body.type === 'star') {
    var st = state.almanac.star;
    var decVal = SightCalc.dmToDecimal(st.decDeg, st.decMin);
    if (st.decNS === 'S') decVal = -decVal;
    input.star = {
      ghaAriesBase: SightCalc.dmToDecimal(st.ghaAriesBaseDeg, st.ghaAriesBaseMin),
      ghaAriesNext: SightCalc.dmToDecimal(st.ghaAriesNextDeg, st.ghaAriesNextMin),
      sha: SightCalc.dmToDecimal(st.shaDeg, st.shaMin),
      dec: decVal
    };
  } else {
    var ns = state.almanac.nonStar;
    var decBase = SightCalc.dmToDecimal(ns.decBaseDeg, ns.decBaseMin);
    if (ns.decBaseNS === 'S') decBase = -decBase;
    var decNext = SightCalc.dmToDecimal(ns.decNextDeg, ns.decNextMin);
    if (ns.decNextNS === 'S') decNext = -decNext;
    input.nonStar = {
      ghaBase: SightCalc.dmToDecimal(ns.ghaBaseDeg, ns.ghaBaseMin),
      ghaNext: SightCalc.dmToDecimal(ns.ghaNextDeg, ns.ghaNextMin),
      decBase: decBase,
      decNext: decNext
    };
  }

  return { input: input, lat: lat, latAbs: latTotal, lonTotal: lonTotal };
}

function calculateSight() {
  if (document.querySelectorAll('.input-error').length > 0) {
    alert('Please fix the highlighted invalid entries before calculating.');
    return;
  }

  var rows = document.querySelectorAll('.sighting-item');
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var hVal = row.querySelector('.t-h').value.trim();
    var mVal = row.querySelector('.t-m').value.trim();
    var sVal = row.querySelector('.t-s').value.trim();
    if (hVal === '' || mVal === '' || sVal === '') {
      alert('Please enter a complete time (Hours, Minutes, and Seconds) for all sightings.');
      return;
    }
  }

  var state = collectFormState();

  if (state.body.type === 'planet' && !state.body.name) {
    alert('Please select a planet from the dropdown.');
    return;
  }

  var avg = SightCalc.averageObservations(state.observations);
  if (!avg) return;

  var ho = SightCalc.computeHo(avg.avgHsDeg, state.corrections);
  var avgUtcSec = SightCalc.utcSecondsFromLocal(avg.avgLocalSec, state.position.tzOffset);

  var built = buildCalcInput(state, avg, ho, avgUtcSec);
  var result = SightCalc.reduceSight(built.input);

  var apLatFormatted = SightCalc.formatDegMin(built.latAbs);
  var apLonFormatted = SightCalc.formatDegMin(built.lonTotal);
  var apString = apLatFormatted + state.position.latNS + ' ' + apLonFormatted + state.position.lonEW;

  var decAbs = Math.abs(result.interpolatedDec);
  var decNS = (result.interpolatedDec >= 0) ? 'N' : 'S';
  var decFormatted = SightCalc.formatDegMin(decAbs) + decNS;

  var interceptText = Math.abs(result.interceptNM).toFixed(1) + ' nm ' + result.interceptDirection;

  document.getElementById('resGHA').innerText = SightCalc.formatDegMin(result.interpolatedGha);
  document.getElementById('resDec').innerText = decFormatted;
  document.getElementById('resLHA').innerText = SightCalc.formatDegMin(result.lha);
  document.getElementById('resHc').innerText = SightCalc.formatDegMin(result.hc);
  document.getElementById('resAP').innerText = apString;
  document.getElementById('resIntercept').innerText = interceptText;
  document.getElementById('resZn').innerText = Math.round(result.zn).toString().padStart(3, '0') + '\u00B0';

  document.getElementById('outputCard').style.display = 'block';

  // Cache the last computed results on the record shape, useful for export/save.
  window._lastResult = result;
  window._lastResultDisplay = {
    ho: ho, apString: apString, interceptText: interceptText,
    zn: Math.round(result.zn).toString().padStart(3, '0') + '\u00B0'
  };
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
  document.getElementById('tzOffset').value = '-4';
  document.getElementById('sightingsContainer').innerHTML = '';
  sightingCount = 0;
  addSightingLine(false);
  document.getElementById('outputCard').style.display = 'none';
  window._lastResult = null;
  window._lastResultDisplay = null;
  updateAverages();
  updateHeaders();
}

// ---------------------------------------------------------------------
// SAVE / EXPORT / IMPORT
// ---------------------------------------------------------------------

function showToast(message, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

function onSaveSight() {
  var state = collectFormState();
  if (window._lastResult) state.results = window._lastResult;

  SightStorage.save(state).then(function (saved) {
    // Keep editing the same record on subsequent saves instead of creating duplicates.
    window._currentRecordId = saved.id;
    showToast('Sight saved to this device.');
    refreshSavedList();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save sight (storage may be full or unavailable).', true);
  });
}

function onExportJson() {
  var state = collectFormState();
  if (window._lastResult) state.results = window._lastResult;

  var filenameDate = state.date || new Date().toISOString().split('T')[0];
  var filenameBody = (state.body.name || state.body.type || 'sight').replace(/\s+/g, '_');
  var filename = 'sight_' + filenameDate + '_' + filenameBody + '.json';

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
      if (!parsed || !parsed.position || !parsed.observations) {
        throw new Error('File does not look like a sight record.');
      }
      applyFormState(parsed);
      window._currentRecordId = null; // imported sight is treated as new/unsaved until user hits Save
      showToast('Imported sight from ' + file.name);
    } catch (err) {
      console.error(err);
      showToast('Could not import file: not a valid sight JSON.', true);
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

function refreshSavedList() {
  SightStorage.list().then(function (entries) {
    var listEl = document.getElementById('savedList');
    var emptyEl = document.getElementById('savedListEmpty');
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    entries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'saved-item';

      var title = entry.label ? entry.label : (entry.bodyLabel + ' \u2014 ' + (entry.date || ''));
      var meta = entry.bodyLabel + ' \u2014 ' + (entry.date || 'no date') +
                 ' \u00B7 saved ' + new Date(entry.savedAt).toLocaleString();

      item.innerHTML =
        '<div class="saved-item-info">' +
          '<div class="saved-item-title"></div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' +
        '<div class="saved-item-actions">' +
          '<button class="btn-mini btn-mini-load">Load</button>' +
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = title;
      item.querySelector('.saved-item-meta').textContent = meta;

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        SightStorage.get(entry.id).then(function (record) {
          if (!record) { showToast('Could not find that saved sight.', true); return; }
          applyFormState(record);
          window._currentRecordId = record.id;
          showToast('Loaded "' + title + '"');
        });
      });

      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        if (!confirm('Delete this saved sight? This cannot be undone.')) return;
        SightStorage.remove(entry.id).then(function () {
          showToast('Deleted.');
          refreshSavedList();
        });
      });

      listEl.appendChild(item);
    });
  }).catch(function (err) {
    console.error(err);
  });
}
