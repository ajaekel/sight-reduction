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

var sightingCount = 0;

document.addEventListener('DOMContentLoaded', initApp);

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
});

/**
 * Consumes a one-time Date/TZ/AP handoff from planning.html's
 * "Start a Sight with this AP" (see sessionStorage key 'ocsrApHandoff' in
 * js/planning.js). Only this direction -- planning -> index -- exists
 * today; nothing currently reads FROM index.html's live fields.
 */
function applyPendingHandoff() {
  var raw;
  try {
    raw = sessionStorage.getItem('ocsrApHandoff');
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  sessionStorage.removeItem('ocsrApHandoff'); // one-time consume, even if parsing fails below

  var h;
  try {
    h = JSON.parse(raw);
  } catch (e) {
    return false;
  }

  if (h.date) document.getElementById('sightDate').value = h.date;
  if (h.tzOffset !== undefined) document.getElementById('tzOffset').value = h.tzOffset;
  if (h.latDeg !== undefined) document.getElementById('latDeg').value = h.latDeg;
  if (h.latMin !== undefined) document.getElementById('latMin').value = h.latMin;
  if (h.latNS) document.getElementById('latNS').value = h.latNS;
  if (h.lonDeg !== undefined) document.getElementById('lonDeg').value = h.lonDeg;
  if (h.lonMin !== undefined) document.getElementById('lonMin').value = h.lonMin;
  if (h.lonEW) document.getElementById('lonEW').value = h.lonEW;

  showToast('Date, time zone, and AP filled in from Planning.');
  return true;
}

/**
 * Consumes a one-time "load this saved sighting" handoff from sightings.html's
 * "Load" button (see sessionStorage key 'ocsrLoadSightingId' in js/sightings.js).
 * Sightings.html can't apply the record itself (it doesn't have the sight
 * reduction form), so it hands the id off here instead.
 */
function applyPendingSightingLoad() {
  var id;
  try {
    id = sessionStorage.getItem('ocsrLoadSightingId');
  } catch (e) {
    return;
  }
  if (!id) return;
  sessionStorage.removeItem('ocsrLoadSightingId'); // one-time consume

  SightStorage.get(id).then(function (record) {
    if (!record) { showToast('Could not find that saved sight.', true); return; }
    applyFormState(record);
    window._currentRecordId = record.id;
    window._currentTitle = record.title || '';
    showToast('Loaded "' + (record.title || 'sight') + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that saved sight.', true);
  });
}

function initApp() {
  try {
    document.getElementById('sightDate').value = new Date().toISOString().split('T')[0];
  } catch (e) {}

  applyPendingHandoff(); // overrides the date above if Planning just sent one
  applyPendingSightingLoad(); // may override the AP/date further if Sightings just sent one

  document.getElementById('bodyType').addEventListener('change', function () {
    handleBodyTypeChange();
    refreshLiveCalculations();
  });
  initStarCombo();
  initNavMenu();
  document.getElementById('planetSelect').addEventListener('change', function () {
    updateHeaders();
    refreshLiveCalculations();
  });

  document.getElementById('btnAddSight').addEventListener('click', function () {
    addSightingLine(true);
  });
  document.getElementById('btnClearAll').addEventListener('click', clearAllData);

  document.getElementById('btnSaveSight').addEventListener('click', onSaveSight);
  document.getElementById('btnExportJson').addEventListener('click', onExportJson);
  document.getElementById('fileImportJson').addEventListener('change', onImportJson);
  document.getElementById('btnFetchUsno').addEventListener('click', onFetchUsno);
  document.getElementById('btnCacheRange').addEventListener('click', onCacheRange);
  document.getElementById('btnClearCache').addEventListener('click', onClearCache);

  document.getElementById('sightDate').addEventListener('change', refreshLiveCalculations);
  document.getElementById('toggleAutoFillCache').addEventListener('change', refreshLiveCalculations);
  document.getElementById('clockErrorSec').addEventListener('input', refreshLiveCalculations);
  document.getElementById('clockErrorFast').addEventListener('click', function () { setClockErrorDirection('fast'); });
  document.getElementById('clockErrorSlow').addEventListener('click', function () { setClockErrorDirection('slow'); });

  ['tzOffset', 'ieMin', 'dipMin', 'altCorrMin', 'addAltCorrMin'].forEach(function (id) {
    document.getElementById(id).addEventListener('input', refreshLiveCalculations);
  });
  ['ieSign', 'altCorrSign', 'addAltCorrSign'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', refreshLiveCalculations);
  });

  // --- SECTION 1: AP POSITION VALIDATION ---
  var errLat = document.getElementById('errLat');
  var errLon = document.getElementById('errLon');

  var validateLat = function () { validateDegMinPair(document.getElementById('latDeg'), document.getElementById('latMin'), 90, 'Latitude', errLat); refreshLiveCalculations(); };
  var validateLon = function () { validateDegMinPair(document.getElementById('lonDeg'), document.getElementById('lonMin'), 180, 'Longitude', errLon); refreshLiveCalculations(); };

  document.getElementById('latDeg').addEventListener('input', validateLat);
  document.getElementById('latMin').addEventListener('input', validateLat);
  document.getElementById('lonDeg').addEventListener('input', validateLon);
  document.getElementById('lonMin').addEventListener('input', validateLon);
  ['latNS', 'lonEW'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', refreshLiveCalculations);
  });

  // --- SECTION 3: STAR ALMANAC VALIDATION ---
  var errGhaAriesBase = document.getElementById('errGhaAriesBase');
  var errGhaAriesNext = document.getElementById('errGhaAriesNext');
  var errSha = document.getElementById('errSha');
  var errDecStar = document.getElementById('errDecStar');

  var validateGhaAriesBase = function () { validateDegMinPair(document.getElementById('ghaAriesBaseDeg'), document.getElementById('ghaAriesBaseMin'), 360, 'GHA Aries Base', errGhaAriesBase); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateGhaAriesNext = function () { validateDegMinPair(document.getElementById('ghaAriesNextDeg'), document.getElementById('ghaAriesNextMin'), 360, 'GHA Aries Next', errGhaAriesNext); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateSha = function () { validateDegMinPair(document.getElementById('shaDeg'), document.getElementById('shaMin'), 360, 'SHA', errSha); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateDecStar = function () { validateDegMinPair(document.getElementById('decStarDeg'), document.getElementById('decStarMin'), 90, 'Star Declination', errDecStar); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };

  document.getElementById('ghaAriesBaseDeg').addEventListener('input', validateGhaAriesBase);
  document.getElementById('ghaAriesBaseMin').addEventListener('input', validateGhaAriesBase);
  document.getElementById('ghaAriesNextDeg').addEventListener('input', validateGhaAriesNext);
  document.getElementById('ghaAriesNextMin').addEventListener('input', validateGhaAriesNext);
  document.getElementById('shaDeg').addEventListener('input', validateSha);
  document.getElementById('shaMin').addEventListener('input', validateSha);
  document.getElementById('decStarDeg').addEventListener('input', validateDecStar);
  document.getElementById('decStarMin').addEventListener('input', validateDecStar);
  document.getElementById('decStarNS').addEventListener('change', function () { markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); });

  // --- SECTION 3: NON-STAR ALMANAC VALIDATION ---
  var errGhaBase = document.getElementById('errGhaBase');
  var errGhaNext = document.getElementById('errGhaNext');
  var errDecBase = document.getElementById('errDecBase');
  var errDecNext = document.getElementById('errDecNext');

  var validateGhaBase = function () { validateDegMinPair(document.getElementById('ghaBaseDeg'), document.getElementById('ghaBaseMin'), 360, 'GHA Base', errGhaBase); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateGhaNext = function () { validateDegMinPair(document.getElementById('ghaNextDeg'), document.getElementById('ghaNextMin'), 360, 'GHA Next', errGhaNext); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateDecBase = function () { validateDegMinPair(document.getElementById('decBaseDeg'), document.getElementById('decBaseMin'), 90, 'Declination Base', errDecBase); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };
  var validateDecNext = function () { validateDegMinPair(document.getElementById('decNextDeg'), document.getElementById('decNextMin'), 90, 'Declination Next', errDecNext); markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); };

  document.getElementById('ghaBaseDeg').addEventListener('input', validateGhaBase);
  document.getElementById('ghaBaseMin').addEventListener('input', validateGhaBase);
  document.getElementById('ghaNextDeg').addEventListener('input', validateGhaNext);
  document.getElementById('ghaNextMin').addEventListener('input', validateGhaNext);
  document.getElementById('decBaseDeg').addEventListener('input', validateDecBase);
  document.getElementById('decBaseMin').addEventListener('input', validateDecBase);
  document.getElementById('decNextDeg').addEventListener('input', validateDecNext);
  document.getElementById('decNextMin').addEventListener('input', validateDecNext);
  ['decBaseNS', 'decNextNS'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', function () { markAlmanacFieldsManuallyEdited(); refreshLiveCalculations(); });
  });

  addSightingLine(false);
  handleBodyTypeChange();
  refreshLiveCalculations();
  refreshCacheSummary();

  try {
    var today = new Date().toISOString().split('T')[0];
    document.getElementById('cacheFromDate').value = today;
    document.getElementById('cacheToDate').value = today;
  } catch (e) {}

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

/**
 * Searchable dropdown for the Star Name field. Filters NAV_STARS as the
 * user types but never restricts the value to that list -- it's a plain
 * text input underneath, so any text (a name not in the list, a bearing
 * note, anything) is accepted as-is.
 */
function initStarCombo() {
  var input = document.getElementById('bodyName');
  var list = document.getElementById('bodyNameSuggestions');
  if (!input || !list) return;

  function renderSuggestions(query) {
    var q = (query || '').trim().toLowerCase();
    var stars = window.NAV_STARS || [];
    var startsWith = [];
    var contains = [];

    stars.forEach(function (name) {
      var lower = name.toLowerCase();
      if (!q) {
        startsWith.push(name);
      } else if (lower.indexOf(q) === 0) {
        startsWith.push(name);
      } else if (lower.indexOf(q) !== -1) {
        contains.push(name);
      }
    });

    var matches = startsWith.concat(contains).slice(0, 10);

    list.innerHTML = '';
    if (matches.length === 0) {
      list.style.display = 'none';
      return;
    }

    matches.forEach(function (name) {
      var item = document.createElement('div');
      item.className = 'combo-item';
      item.textContent = name;
      // mousedown (not click) fires before the input's blur, so we can set
      // the value and hide the list without the field losing focus first.
      item.addEventListener('mousedown', function (e) {
        e.preventDefault();
        input.value = name;
        list.style.display = 'none';
        updateHeaders();
        refreshLiveCalculations();
      });
      list.appendChild(item);
    });

    list.style.display = 'block';
  }

  input.addEventListener('input', function () {
    renderSuggestions(input.value);
    updateHeaders();
    refreshLiveCalculations();
  });

  input.addEventListener('focus', function () {
    renderSuggestions(input.value);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') list.style.display = 'none';
  });

  document.addEventListener('click', function (e) {
    if (e.target !== input && !list.contains(e.target)) {
      list.style.display = 'none';
    }
  });
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
    refreshLiveCalculations();
  });

  sm.addEventListener('input', function () {
    validateField(this, 0, 60, 'Height Minutes', errBox, true);
    refreshLiveCalculations();
  });

  [th, tm, ts, sd, sm].forEach(function (input) {
    input.addEventListener('focus', function () { this.select(); });
  });

  if (sightingCount > 1) {
    var delBtn = div.querySelector('.btn-del');
    delBtn.addEventListener('click', function () {
      div.remove();
      refreshLiveCalculations();
    });
  }

  refreshLiveCalculations();

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
  refreshLiveCalculations();
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
    notes: g('sightNotes').value.trim(),
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
      addAltCorrMin: num('addAltCorrMin'), addAltCorrSign: g('addAltCorrSign').value,
      clockErrorSec: num('clockErrorSec'), clockErrorDirection: _clockErrorDirection
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

  setVal('sightNotes', state.notes || '');
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
  setVal('clockErrorSec', c.clockErrorSec || 0);
  setClockErrorDirection(c.clockErrorDirection === 'slow' ? 'slow' : 'fast'); // older saved records have neither field -- default matches a fresh page

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
  // The loaded record's almanac fields (if any) correspond to ITS OWN
  // date/body/time, all of which we just set above -- so the current
  // context is exactly what they should be valid for.
  _almanacFieldsContext = currentAlmanacContextKey();
  refreshLiveCalculations(); // recalculates immediately if the loaded record is complete
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

var _clockErrorDirection = 'fast'; // 'fast' or 'slow' -- see getClockErrorCorrectedLocalSec

function setClockErrorDirection(direction) {
  _clockErrorDirection = direction;
  document.getElementById('clockErrorFast').setAttribute('aria-pressed', direction === 'fast' ? 'true' : 'false');
  document.getElementById('clockErrorSlow').setAttribute('aria-pressed', direction === 'slow' ? 'true' : 'false');
  refreshLiveCalculations();
}

/**
 * Applies the Clock Error correction to an averaged local-time-of-day (in
 * seconds), using the standard chronometer convention: a watch that's FAST
 * reads ahead of the true time, so the error is SUBTRACTED to get the true
 * time; a watch that's SLOW reads behind, so the error is ADDED.
 */
function getClockErrorCorrectedLocalSec(avgLocalSec) {
  var clockErrorSec = parseFloat(document.getElementById('clockErrorSec').value) || 0;
  var sign = (_clockErrorDirection === 'fast') ? -1 : 1;
  var corrected = avgLocalSec + sign * clockErrorSec;
  return ((corrected % 86400) + 86400) % 86400; // wrap into [0, 86400)
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
  var ha = SightCalc.computeHa(avg.avgHsDeg, corrections);
  var ho = SightCalc.computeHo(avg.avgHsDeg, corrections);

  var tzOffset = parseFloat(document.getElementById('tzOffset').value) || 0;
  var correctedLocalSec = getClockErrorCorrectedLocalSec(avg.avgLocalSec);
  var avgUtcSec = SightCalc.utcSecondsFromLocal(correctedLocalSec, tzOffset);

  document.getElementById('avgLocalTime').innerText = SightCalc.secondsToTimeString(avg.avgLocalSec);
  document.getElementById('avgLocalTimeCorrected').innerText = SightCalc.secondsToTimeString(correctedLocalSec);
  document.getElementById('avgUtcTime').innerText = SightCalc.secondsToTimeString(avgUtcSec) + ' UTC';
  document.getElementById('avgHs').innerText = SightCalc.formatDegMin(avg.avgHsDeg);
  document.getElementById('computedHa').innerText = SightCalc.formatDegMin(ha);
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

// ---------------------------------------------------------------------
// LIVE / REACTIVE CALCULATION -- replaces the old "Calculate Reduction" /
// "Plot This Fix" button model. refreshLiveCalculations() is the single
// entry point every relevant input listener calls; it fans out to the
// almanac cache auto-fill (network-free) and the full reduction
// calculation, each independently gated on whether it has what it needs.
// ---------------------------------------------------------------------

/** True if every field id in `ids` has a non-blank value. Blank, not 0-vs-empty -- unlike collectFormState()'s num() helper, this can tell "never typed" from "typed 0". */
function allFilled(ids) {
  return ids.every(function (id) {
    var el = document.getElementById(id);
    return !!el && el.value.trim() !== '';
  });
}

function getAlmanacFieldIds(bodyType) {
  return bodyType === 'star'
    ? ['ghaAriesBaseDeg', 'ghaAriesBaseMin', 'ghaAriesNextDeg', 'ghaAriesNextMin', 'shaDeg', 'shaMin', 'decStarDeg', 'decStarMin']
    : ['ghaBaseDeg', 'ghaBaseMin', 'ghaNextDeg', 'ghaNextMin', 'decBaseDeg', 'decBaseMin', 'decNextDeg', 'decNextMin'];
}

/** True if ANY of this body type's almanac fields has something in it. */
function almanacFieldsAnyFilled(bodyType) {
  return getAlmanacFieldIds(bodyType).some(function (id) {
    return document.getElementById(id).value.trim() !== '';
  });
}

/**
 * A key representing "the date/body/hour Section 3's values should
 * currently reflect" -- used to detect when previously-filled (or
 * manually-edited) almanac fields have gone stale because the date, body,
 * or average sighting time changed underneath them. Returns null if there
 * isn't yet enough info to compute it.
 */
function currentAlmanacContextKey() {
  var dateInput = document.getElementById('sightDate').value;
  if (!dateInput) return null;

  var bodyType = document.getElementById('bodyType').value;
  var bodyName = bodyType === 'star' ? document.getElementById('bodyName').value.trim()
    : bodyType === 'planet' ? document.getElementById('planetSelect').value.trim() : '';

  var state = collectFormState();
  var avg = SightCalc.averageObservations(state.observations);
  if (!avg) return null;

  var avgUtcSec = SightCalc.utcSecondsFromLocal(getClockErrorCorrectedLocalSec(avg.avgLocalSec), state.position.tzOffset);
  var baseUtcDate = new Date(dateInput + 'T00:00:00Z');
  baseUtcDate.setUTCSeconds(baseUtcDate.getUTCSeconds() + avgUtcSec);
  baseUtcDate.setUTCMinutes(0, 0, 0);

  return bodyType + '|' + bodyName + '|' + baseUtcDate.toISOString();
}

function hasCompleteTimeAllRows() {
  var rows = document.querySelectorAll('.sighting-item');
  return rows.length > 0 && Array.prototype.every.call(rows, function (row) {
    return row.querySelector('.t-h').value.trim() !== '' &&
           row.querySelector('.t-m').value.trim() !== '' &&
           row.querySelector('.t-s').value.trim() !== '';
  });
}

function hasApEntered() {
  var latEntered = document.getElementById('latDeg').value.trim() !== '' || document.getElementById('latMin').value.trim() !== '';
  var lonEntered = document.getElementById('lonDeg').value.trim() !== '' || document.getElementById('lonMin').value.trim() !== '';
  return latEntered && lonEntered;
}

function hasValidBodyName(bodyType) {
  if (bodyType === 'star') return document.getElementById('bodyName').value.trim() !== '';
  if (bodyType === 'planet') return document.getElementById('planetSelect').value.trim() !== '';
  return true; // sun/moon need no name
}

/**
 * Everything needed to attempt a cache-only almanac lookup: enough to know
 * WHICH hour/body to look up, but deliberately not requiring the almanac
 * fields themselves (filling those in is the point).
 */
function getAlmanacFetchReadiness(bodyType) {
  return !!document.getElementById('sightDate').value &&
         hasValidBodyName(bodyType) &&
         hasCompleteTimeAllRows() &&
         hasApEntered() &&
         document.querySelectorAll('.input-error').length === 0;
}

/** Everything needed to run a full sight reduction. */
function getCalcReadiness(bodyType) {
  return getAlmanacFetchReadiness(bodyType) &&
         allFilled(getAlmanacFieldIds(bodyType)) &&
         document.querySelectorAll('.input-error').length === 0;
}

function resetInterpAndResultsDisplay() {
  document.getElementById('resGHA').innerText = "--\u00B0 --.-'";
  document.getElementById('resDec').innerText = "--\u00B0 --.-'";
  document.getElementById('resLHA').innerText = "--\u00B0 --.-'";
  document.getElementById('almanacInterpBox').classList.remove('summary-box-error');
  document.getElementById('outputCard').style.display = 'none';
  document.getElementById('chartCard').style.display = 'none';
  window._lastResult = null;
  window._lastResultDisplay = null;
}

/**
 * Keeps Section 3 in sync with the current date/body/average-time:
 *
 *   - Blank fields: cache-check-then-decide, same as before.
 *   - Stale fields (something in Section 3 was filled/edited for a
 *     different date, body, or time than now): checkbox on -> silently
 *     re-fetch and overwrite; checkbox off -> red outline + a message
 *     telling the user which button to tap to correct them.
 *   - Valid fields (already correct for the current context): left alone,
 *     button disabled.
 *
 * The cache is always CHECKED (read-only, never the network) regardless of
 * the checkbox -- that's what lets the button's label say whether clicking
 * it will be instant or needs the network. The checkbox only controls
 * whether a cache hit gets APPLIED automatically. Whenever something does
 * get applied -- automatically or via the button -- it OVERWRITES whatever
 * was there, even a manually-typed value; that's the whole point of a
 * deliberate trigger (checkbox on, or a button click).
 */
var _autoFillLoopGuard = { signature: null, count: 0 };
var _almanacFieldsContext = null; // see currentAlmanacContextKey()

function setFetchButtonState(enabled, label) {
  var btn = document.getElementById('btnFetchUsno');
  btn.disabled = !enabled;
  btn.textContent = label;
}

/** Called by Section 3's own field listeners -- marks whatever's there now as deliberately valid for the current context. */
function markAlmanacFieldsManuallyEdited() {
  _almanacFieldsContext = currentAlmanacContextKey();
}

function tryAutoFillAlmanacFromCache() {
  var box = document.getElementById('almanacInterpBox');
  var bodyType = document.getElementById('bodyType').value;

  if (!getAlmanacFetchReadiness(bodyType)) {
    setFetchButtonState(false, 'Download data');
    box.classList.remove('summary-box-error');
    setUsnoStatus('', '');
    _autoFillLoopGuard = { signature: null, count: 0 };
    return;
  }

  var currentContext = currentAlmanacContextKey();
  var almanacIds = getAlmanacFieldIds(bodyType);
  var isComplete = allFilled(almanacIds);      // every field has something
  var hasAnyValue = almanacFieldsAnyFilled(bodyType); // at least one does -- used only for context tracking

  if (hasAnyValue && _almanacFieldsContext === null) {
    // First time this session we're tracking context -- treat whatever's
    // already there (e.g. a freshly-loaded sighting) as the established
    // baseline rather than immediately flagging it stale.
    _almanacFieldsContext = currentContext;
  }

  var isStale = hasAnyValue && _almanacFieldsContext !== currentContext;

  if (isComplete && !isStale) {
    // Every field is filled AND still correct for the current date/body/time.
    setFetchButtonState(false, 'Fill with cached data');
    box.classList.remove('summary-box-error');
    setUsnoStatus('', '');
    _autoFillLoopGuard = { signature: null, count: 0 };
    return;
  }

  var state = collectFormState();
  var position = getAssumedPositionSigned();
  var avg = SightCalc.averageObservations(state.observations);
  var avgUtcSec = SightCalc.utcSecondsFromLocal(getClockErrorCorrectedLocalSec(avg.avgLocalSec), state.position.tzOffset);
  var dateInput = document.getElementById('sightDate').value;
  var baseUtcDate = new Date(dateInput + 'T00:00:00Z');
  baseUtcDate.setUTCSeconds(baseUtcDate.getUTCSeconds() + avgUtcSec);
  baseUtcDate.setUTCMinutes(0, 0, 0); // floor to the top of the bracketing hour
  var nextUtcDate = new Date(baseUtcDate.getTime() + 3600 * 1000);

  SightUsno.getAlmanacFillFromCacheOnly(state.body, baseUtcDate, nextUtcDate)
    .then(function (result) {
      if (!getAlmanacFetchReadiness(bodyType)) return;

      // Recompute fresh -- the context or the fields themselves may have
      // moved on while this lookup was in flight.
      var contextNow = currentAlmanacContextKey();
      var isCompleteNow = allFilled(almanacIds);
      var hasAnyValueNow = almanacFieldsAnyFilled(bodyType);
      var isStaleNow = hasAnyValueNow && _almanacFieldsContext !== contextNow;
      if (isCompleteNow && !isStaleNow) return; // already resolved in the meantime

      var cached = !!result;
      var autoFillOn = document.getElementById('toggleAutoFillCache').checked;

      if (!(autoFillOn && cached)) {
        box.classList.toggle('summary-box-error', (autoFillOn && !cached) || (isStaleNow && !autoFillOn));

        var label = (autoFillOn && !cached) ? 'Download data'
          : cached ? 'Fill with cached data'
          : 'Download data and fill fields';
        setFetchButtonState(true, label);

        if (isStaleNow && !autoFillOn) {
          setUsnoStatus('Section 3 no longer matches the current date, body, or time \u2014 tap "' + label + '" to update it.', 'error');
        } else if (autoFillOn && !cached) {
          setUsnoStatus('Not cached for this hour \u2014 tap Download to fetch from USNO.', '');
        } else {
          setUsnoStatus('', '');
        }
        _autoFillLoopGuard = { signature: null, count: 0 };
        return;
      }

      // toggle on + cached -> auto-overwrite.
      //
      // Safety net: this reactive chain (applyUsnoFill -> refreshLiveCalculations
      // -> tryAutoFillAlmanacFromCache -> cache hit -> applyUsnoFill -> ...) is
      // supposed to always converge, since a successful fill marks the
      // context valid and isStale becomes false on the next pass. If the
      // exact same context ends up asking for another auto-overwrite several
      // times in a row, something isn't actually resolving -- stop retrying
      // automatically instead of spinning forever.
      var signature = bodyType + '|' + contextNow;
      if (_autoFillLoopGuard.signature === signature) {
        _autoFillLoopGuard.count++;
      } else {
        _autoFillLoopGuard = { signature: signature, count: 1 };
      }
      if (_autoFillLoopGuard.count > 3) {
        setFetchButtonState(true, 'Download data');
        box.classList.add('summary-box-error');
        setUsnoStatus('Auto-fill isn\u2019t able to complete this automatically \u2014 tap Download, or check the almanac fields manually.', 'error');
        return;
      }

      applyUsnoFill(bodyType, result.fill); // overwrites, marks context valid, re-runs refreshLiveCalculations()
      setFetchButtonState(false, 'Fill with cached data');
      box.classList.remove('summary-box-error');
      setUsnoStatus('Filled from cache.', 'ok');
    })
    .catch(function (err) {
      console.error(err);
      setFetchButtonState(true, 'Download data');
      box.classList.add('summary-box-error');
    });
}

/**
 * Stage B: runs the full reduction the moment all the inputs it needs are
 * present and valid, and populates both the Section 3 interpolation box and
 * the Sight Reduction Results card. Resets both to their placeholder state
 * (rather than erroring) when something's still missing -- there's no
 * button click to gate on anymore, so a mid-typing form is a normal state,
 * not an error.
 */
function tryAutoCalculateReduction() {
  var state = collectFormState();

  if (!getCalcReadiness(state.body.type)) {
    resetInterpAndResultsDisplay();
    return;
  }

  var avg = SightCalc.averageObservations(state.observations);
  if (!avg) { resetInterpAndResultsDisplay(); return; }

  var ho = SightCalc.computeHo(avg.avgHsDeg, state.corrections);
  var avgUtcSec = SightCalc.utcSecondsFromLocal(getClockErrorCorrectedLocalSec(avg.avgLocalSec), state.position.tzOffset);

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
  document.getElementById('almanacInterpBox').classList.remove('summary-box-error');

  document.getElementById('resHc').innerText = SightCalc.formatDegMin(result.hc);
  document.getElementById('resIntercept').innerText = interceptText;
  document.getElementById('resZn').innerText = Math.round(result.zn).toString().padStart(3, '0') + '\u00B0';

  document.getElementById('outputCard').style.display = 'block';

  renderChart(state, result, apString, built);

  // The exact UTC instant the averaged sighting corresponds to (same
  // construction used elsewhere to bracket the almanac hour).
  var obsUtcDate = state.date ? new Date(state.date + 'T00:00:00Z') : new Date();
  obsUtcDate.setUTCSeconds(obsUtcDate.getUTCSeconds() + avgUtcSec);

  // Cache the last computed results on the record shape, useful for export/save.
  window._lastResult = {
    interpolatedGha: result.interpolatedGha,
    interpolatedDec: result.interpolatedDec,
    lha: result.lha,
    hc: result.hc,
    zn: result.zn,
    interceptNM: result.interceptNM,
    interceptDirection: result.interceptDirection,
    ho: ho,
    observationTime: obsUtcDate.toISOString()
  };
  window._lastResultDisplay = {
    ho: ho, apString: apString, interceptText: interceptText,
    zn: Math.round(result.zn).toString().padStart(3, '0') + '\u00B0'
  };
}

/** The single entry point every relevant input listener calls. */
function refreshLiveCalculations() {
  updateAverages();
  tryAutoFillAlmanacFromCache();
  tryAutoCalculateReduction();
}

function formatBodyLabel(body) {
  return SightCalc.formatBodyLabel(body);
}

function renderChart(state, result, apString, built) {
  var container = document.getElementById('chartContainer');
  var bodyLabel = formatBodyLabel(state.body);
  var lonSigned = (state.position.lonEW === 'W') ? -built.lonTotal : built.lonTotal;

  var chartInfo = SightChart.renderSightChart(container, {
    zn: result.zn,
    interceptNM: result.interceptNM,
    apLat: built.lat,
    apLon: lonSigned,
    apLabel: apString,
    bodyLabel: bodyLabel
  });

  document.getElementById('chartCaption').innerText =
    'AP ' + apString + '  \u00B7  Zn ' + chartInfo.znLabel + '  \u00B7  Intercept ' + chartInfo.interceptText +
    '  \u00B7  Grid edge = ' + chartInfo.scaleNM + ' nm';

  document.getElementById('chartCard').style.display = 'block';
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
  document.getElementById('tzOffset').value = '-4';
  document.getElementById('sightingsContainer').innerHTML = '';
  sightingCount = 0;
  addSightingLine(false);
  window._currentRecordId = null;
  window._currentTitle = null;
  _almanacFieldsContext = null;
  _autoFillLoopGuard = { signature: null, count: 0 };
  setClockErrorDirection('fast');
  updateHeaders();
  refreshLiveCalculations();
}

// ---------------------------------------------------------------------
// USNO AUTOFILL
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
  // Force a reflow so re-adding the class restarts the animation on repeat fetches.
  void el.offsetWidth;
  el.classList.add('autofilled-flash');
}

/**
 * Fills one GHA/SHA (no sign) or Dec (with N/S sign) field-group from USNO
 * data. Always overwrites, even if the field already has a value -- both an
 * automatic cache-fill (checkbox on) and the explicit Download/Fill button
 * are a deliberate "replace what's there" trigger, not a "top up the
 * blanks" one.
 */
function fillDegMin(degId, minId, signId, decimalDeg, signValue) {
  var dm = SightCalc.decimalToDM(decimalDeg);
  document.getElementById(degId).value = dm.deg;
  document.getElementById(minId).value = dm.min.toFixed(1);
  flashField(degId);
  flashField(minId);
  if (signId) document.getElementById(signId).value = signValue;
}

/** Overwrites all of this body type's almanac fields with USNO data and marks Section 3 valid for the current context. */
function applyUsnoFill(bodyType, fill) {
  if (bodyType === 'star') {
    fillDegMin('ghaAriesBaseDeg', 'ghaAriesBaseMin', null, fill.ghaAriesBaseDeg);
    fillDegMin('ghaAriesNextDeg', 'ghaAriesNextMin', null, fill.ghaAriesNextDeg);
    fillDegMin('shaDeg', 'shaMin', null, fill.shaDeg);
    fillDegMin('decStarDeg', 'decStarMin', 'decStarNS', fill.decDeg, fill.decSign);
  } else {
    fillDegMin('ghaBaseDeg', 'ghaBaseMin', null, fill.ghaBaseDeg);
    fillDegMin('ghaNextDeg', 'ghaNextMin', null, fill.ghaNextDeg);
    fillDegMin('decBaseDeg', 'decBaseMin', 'decBaseNS', fill.decBaseDeg, fill.decBaseSign);
    fillDegMin('decNextDeg', 'decNextMin', 'decNextNS', fill.decNextDeg, fill.decNextSign);
  }

  _almanacFieldsContext = currentAlmanacContextKey();
  refreshLiveCalculations(); // refreshes hour labels/Ho AND runs the reduction now that almanac data is in
  return getAlmanacFieldIds(bodyType).length / 2; // always overwrites every field-group for this body type
}

/**
 * Reads the Section 1 assumed position directly from the DOM and returns
 * signed decimal degrees (S/W negative). Shared by every feature that needs
 * the AP but isn't already holding a collectFormState() object (or wants a
 * fresh read without re-collecting the whole form).
 */
function getAssumedPositionSigned() {
  var latDeg = parseFloat(document.getElementById('latDeg').value) || 0;
  var latMin = parseFloat(document.getElementById('latMin').value) || 0;
  var lonDeg = parseFloat(document.getElementById('lonDeg').value) || 0;
  var lonMin = parseFloat(document.getElementById('lonMin').value) || 0;

  var latTotal = SightCalc.dmToDecimal(latDeg, latMin);
  var lonTotal = SightCalc.dmToDecimal(lonDeg, lonMin);

  return {
    lat: document.getElementById('latNS').value === 'S' ? -latTotal : latTotal,
    lon: document.getElementById('lonEW').value === 'W' ? -lonTotal : lonTotal
  };
}

function onFetchUsno() {
  var btn = document.getElementById('btnFetchUsno');
  var state = collectFormState();

  var missing = [];
  if (!document.getElementById('sightDate').value) missing.push('the date (Section 1)');

  var latEntered = document.getElementById('latDeg').value.trim() !== '' || document.getElementById('latMin').value.trim() !== '';
  var lonEntered = document.getElementById('lonDeg').value.trim() !== '' || document.getElementById('lonMin').value.trim() !== '';
  if (!latEntered || !lonEntered) missing.push('your assumed position (Section 1)');

  if (state.body.type === 'planet' && !state.body.name) missing.push('a planet selection (Section 2)');
  if (state.body.type === 'star' && !state.body.name) missing.push('the star name (Section 2)');

  var rows = document.querySelectorAll('.sighting-item');
  var hasCompleteTime = rows.length > 0 && Array.prototype.every.call(rows, function (row) {
    return row.querySelector('.t-h').value.trim() !== '' &&
           row.querySelector('.t-m').value.trim() !== '' &&
           row.querySelector('.t-s').value.trim() !== '';
  });
  var avg = SightCalc.averageObservations(state.observations);
  if (!avg || !hasCompleteTime) missing.push('a complete sighting time \u2014 Hours, Minutes, and Seconds (Section 2)');

  if (document.querySelectorAll('.input-error').length > 0) missing.push('valid values for the field(s) currently outlined in red');

  if (missing.length) {
    setUsnoStatus('Can\u2019t fetch almanac data yet \u2014 still missing: ' + missing.join('; ') + '.', 'error');
    return;
  }

  var position = getAssumedPositionSigned();
  var avgUtcSec = SightCalc.utcSecondsFromLocal(getClockErrorCorrectedLocalSec(avg.avgLocalSec), state.position.tzOffset);
  var dateInput = document.getElementById('sightDate').value;
  var baseUtcDate = new Date(dateInput + 'T00:00:00Z');
  baseUtcDate.setUTCSeconds(baseUtcDate.getUTCSeconds() + avgUtcSec);
  baseUtcDate.setUTCMinutes(0, 0, 0); // floor to the top of the bracketing hour
  var nextUtcDate = new Date(baseUtcDate.getTime() + 3600 * 1000);

  btn.disabled = true;
  setUsnoStatus('Checking cache\u2026', 'loading');

  // Cache-first: instant and works offline if this hour was pre-downloaded
  // via the Offline Almanac Cache section below. Falls back to a live fetch
  // (and backfills the cache) only for whatever isn't already cached.
  SightUsno.getAlmanacFillWithCache(state.body, baseUtcDate, nextUtcDate, position.lat, position.lon)
    .then(function (result) {
      var filledGroups = applyUsnoFill(state.body.type, result.fill);
      var msg = 'Filled ' + filledGroups + ' field' + (filledGroups === 1 ? '' : 's') + ' ' +
        (result.fromCache ? 'from cache' : 'from USNO') + ' for ' + formatBodyLabel(state.body) + ', hour ' +
        String(baseUtcDate.getUTCHours()).padStart(2, '0') + '\u2013' +
        String(nextUtcDate.getUTCHours()).padStart(2, '0') + 'z on ' +
        baseUtcDate.toISOString().split('T')[0] + '.';
      setUsnoStatus(msg, 'ok');
      showToast('Almanac data filled' + (result.fromCache ? ' (from cache).' : '.'));
      refreshCacheSummary();
    })
    .catch(function (err) {
      console.error(err);
      var msg = err && err.message ? err.message : 'Could not get almanac data.';
      if (navigator.onLine === false) {
        msg += ' You appear to be offline and this hour isn\u2019t cached yet \u2014 download it in advance with the Offline Almanac Cache section below, or enter the data manually.';
      }
      setUsnoStatus(msg, 'error');
      // applyUsnoFill (which re-derives button/outline state on its own)
      // never ran on this path, so the button's still stuck disabled from
      // the start of this function -- re-derive it here. (On success this
      // isn't needed -- and used to double-run here via .finally(), which
      // was clobbering the "Filled N fields..." message right after it was
      // set, since a fresh check immediately finds everything valid again
      // and clears the status text.)
      tryAutoFillAlmanacFromCache();
    });
}

// ---------------------------------------------------------------------
// OFFLINE ALMANAC CACHE (date-range pre-download)
// ---------------------------------------------------------------------

function setCacheProgress(msg, kind) {
  var el = document.getElementById('cacheProgress');
  el.textContent = msg;
  el.className = 'cache-progress' + (kind ? ' ' + kind : '');
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function refreshCacheSummary() {
  if (!window.AlmanacCache) return;
  AlmanacCache.summary().then(function (s) {
    var el = document.getElementById('cacheSummary');
    if (!s.count) {
      el.textContent = 'No almanac data cached yet.';
      return;
    }
    el.textContent = s.count + ' hour' + (s.count === 1 ? '' : 's') + ' cached (\u2248' + formatBytes(s.approxBytes) +
                      '), spanning ' + s.first + 'z \u2013 ' + s.last + 'z.';
  }).catch(function () {});
}

function onCacheRange() {
  var btn = document.getElementById('btnCacheRange');
  var from = document.getElementById('cacheFromDate').value;
  var to = document.getElementById('cacheToDate').value;

  if (!from || !to) {
    setCacheProgress('Enter both a "From" and "To" date first.', 'error');
    return;
  }
  if (to < from) {
    setCacheProgress('"To" date must be on or after "From" date.', 'error');
    return;
  }
  if (navigator.onLine === false) {
    setCacheProgress('You appear to be offline. Connect to download almanac data.', 'error');
    return;
  }

  var latEntered = document.getElementById('latDeg').value.trim() !== '' || document.getElementById('latMin').value.trim() !== '';
  var lonEntered = document.getElementById('lonDeg').value.trim() !== '' || document.getElementById('lonMin').value.trim() !== '';
  if (!latEntered || !lonEntered) {
    setCacheProgress('Enter your assumed position (Section 1) first \u2014 required by the USNO API call, though GHA/Dec themselves are the same worldwide, just like a printed almanac.', 'error');
    return;
  }

  // Surfaces the real cost of a large range before committing to it --
  // USNO's celnav endpoint has no bulk/date-range query, so this is
  // genuinely one HTTP request per hour. Small ranges (a day or so) just
  // proceed; anything bigger asks first.
  var hourCount;
  try {
    hourCount = SightUsno.eachUtcHourInRange(from, to).length;
  } catch (e) {
    hourCount = null;
  }
  if (hourCount && hourCount > 24) {
    var days = Math.round(hourCount / 24);
    if (!confirm(
      'This will make about ' + hourCount + ' requests to the USNO server (roughly one per hour across ~' + days + ' days). ' +
      'It\u2019ll take a little while and is paced to be polite to their free service. Continue?'
    )) {
      return;
    }
  }

  var position = getAssumedPositionSigned();

  btn.disabled = true;
  setCacheProgress('Starting\u2026', 'loading');

  SightUsno.fetchAndCacheRange(from, to, position.lat, position.lon, function (done, total, failedSoFar) {
    setCacheProgress(
      'Fetched ' + done + ' of ' + total + ' hours' + (failedSoFar ? ' (' + failedSoFar + ' failed)' : '') + '\u2026',
      'loading'
    );
  })
    .then(function (result) {
      var msg = 'Cached ' + result.succeeded + ' of ' + result.total + ' hours.';
      if (result.failed > 0) {
        msg += ' ' + result.failed + ' failed \u2014 re-run the same range to retry just those.';
      }
      setCacheProgress(msg, result.failed > 0 ? 'error' : 'ok');
      showToast('Almanac cache updated.');
      refreshCacheSummary();
    })
    .catch(function (err) {
      console.error(err);
      setCacheProgress(err && err.message ? err.message : 'Could not download almanac data.', 'error');
    })
    .finally(function () {
      btn.disabled = false;
    });
}

function onClearCache() {
  if (!confirm('Clear all cached almanac data from this device? (Saved sights are not affected.)')) return;
  AlmanacCache.clearAll().then(function () {
    refreshCacheSummary();
    setCacheProgress('', '');
    showToast('Almanac cache cleared.');
  });
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

  // The save name is its own concept, tracked independently of Notes (see
  // window._currentTitle, set on Load) -- it must never read from or write
  // back into the Notes field.
  var suggestedTitle = formatBodyLabel(state.body) + (state.date ? ' - ' + state.date : '');
  var name = prompt('Save this sight as:', window._currentTitle || suggestedTitle);
  if (name === null) return; // user cancelled

  state.title = name.trim() || suggestedTitle;
  window._currentTitle = state.title;

  // If we're editing a sight we just loaded/saved this session, update that
  // same record instead of creating a duplicate.
  if (window._currentRecordId) state.id = window._currentRecordId;

  if (window._lastResult) state.results = window._lastResult;

  SightStorage.save(state).then(function (saved) {
    window._currentRecordId = saved.id;
    showToast('Saved as "' + state.title + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save sight (storage may be full or unavailable).', true);
  });
}

function onExportJson() {
  var state = collectFormState();
  if (window._lastResult) state.results = window._lastResult;

  var filename = buildExportFilename(state) + '.json';

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

/**
 * "yyyy-mm-dd HH-mm-ss <type> <name>" -- date/time come from the observation
 * itself (first sighting line's UTC time), not the moment of export, so
 * re-exporting the same sight later reproduces the same filename. <name> is
 * whatever save title is already known for this sight (see window._currentTitle,
 * set on Save/Load; see the Notes/title split from earlier), falling back to
 * the body's own name (star/planet) and omitted entirely if neither exists.
 */
function buildExportFilename(state) {
  var pad2 = function (n) { return String(n).padStart(2, '0'); };
  var now = new Date();

  var dateStr = state.date || now.toISOString().split('T')[0];

  var firstObs = state.observations && state.observations[0];
  var timeStr = firstObs
    ? pad2(firstObs.h) + '-' + pad2(firstObs.m) + '-' + pad2(firstObs.s)
    : pad2(now.getHours()) + '-' + pad2(now.getMinutes()) + '-' + pad2(now.getSeconds());

  var typeStr = (state.body && state.body.type) || 'sight';
  var nameStr = (window._currentTitle || (state.body && state.body.name) || '').trim();

  var parts = [dateStr, timeStr, typeStr];
  if (nameStr) parts.push(nameStr);

  // Strip characters that are illegal (or awkward) in filenames on common filesystems.
  return parts.join(' ').replace(/[\\/:*?"<>|]/g, '_');
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
      window._currentTitle = parsed.title || null;
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


