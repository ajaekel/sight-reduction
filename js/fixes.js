/**
 * fixes.js
 * Page logic for fixes.html. A Fix is a named collection of saved Sight
 * ids (FixStorage); this file wires up create/list/delete, add/remove
 * sights, and plotting the Fix as a multi-LOP chart (SightChart /
 * SightCalc do the actual geometry -- this file is DOM glue only, same
 * separation of concerns as app.js).
 */

var currentFix = null;
var fixRenderToken = 0;
var lastChartInput = null; // cached so toggling azimuth/bisectors doesn't need to re-fetch sights
var currentSelection = null; // {type, recordId, part} | null -- see chartInteraction.js; independent of pan/zoom/fullscreen state
var fixChartFullscreenApi = null; // set once wired -- lets a selection's "Open" action exit fullscreen (see getFixSelectionDetail's 'fix' case)
var fixViewport = null; // {originLat, originLon, scale} | null -- see chartPanZoom.js; null means "auto-fit," set once a gesture (or reset) establishes one
var fixAutoScaleNM = null; // the CURRENT auto-fit scale, tracked separately from fixViewport since it needs to stay live even while a viewport override is active (chartPanZoom.js's zoom-out bound)
var fixAutoOriginLat = null; // ditto, the true auto-fit origin -- what "reset to fit" resets TO
var fixAutoOriginLon = null;
var fixAutoOriginLat = null; // ditto, the true auto-fit origin -- what "reset to fit" resets TO
var fixAutoOriginLon = null;
var bisectorMethodSelected = false; // false = least-squares, true = method of bisectors

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();
  var fixPanZoomApi = ChartPanZoom.wire('fixChartWrap', { getViewport: getFixViewport, onViewportChange: onFixViewportChange });
  fixChartFullscreenApi = ChartFullscreen.wire('fixChartWrap', 'fixChartContainer', fixPanZoomApi);
  ChartInteraction.wire('fixChartWrap', { getDetail: getFixSelectionDetail, onSelectionChange: onFixSelectionChange });

  document.getElementById('btnNewFix').addEventListener('click', onNewFixClick);
  document.getElementById('btnNewKnownFix').addEventListener('click', onNewKnownFixClick);
  document.getElementById('btnSaveKnownFix').addEventListener('click', onSaveKnownFixPosition);
  wireDigitBox('knownFixTimeH', 2, 0, 23, 'knownFixTimeM');
  wireDigitBox('knownFixTimeM', 2, 0, 59, null);
  document.getElementById('btnBackToList').addEventListener('click', function () {
    location.hash = '';
  });
  document.getElementById('btnDeleteFix').addEventListener('click', onDeleteFix);
  document.getElementById('toggleShowAzimuth').addEventListener('change', renderCurrentPlot);
  document.getElementById('methodLeastSquares').addEventListener('click', function () { setFixMethod(false); });
  document.getElementById('methodBisectors').addEventListener('click', function () { setFixMethod(true); });
  document.getElementById('btnSaveFixPosition').addEventListener('click', onSaveFixPosition);
  document.getElementById('btnFixToSight').addEventListener('click', onFixToSight);
  document.getElementById('btnFixToDrLeg').addEventListener('click', onFixToDrLeg);
  document.getElementById('btnCancelAdvance').addEventListener('click', closeAdvancePanel);

  window.addEventListener('hashchange', routeFromHash);
  routeFromHash();
});

function showToast(message, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

/** Digit-only filtering and auto-advance -- same small helper as passages.js/drleg.js/planning.js, kept page-local rather than shared (matches this codebase's existing convention). */
function wireDigitBox(id, maxLen, min, max, nextId) {
  var el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('focus', function () { this.select(); });
  el.addEventListener('input', function () {
    var cleaned = this.value.replace(/[^0-9]/g, '').slice(0, maxLen);
    if (cleaned !== this.value) this.value = cleaned;
    if (min !== null && max !== null) {
      var n = parseInt(cleaned, 10);
      this.classList.toggle('input-error', cleaned !== '' && (isNaN(n) || n < min || n > max));
    }
    if (cleaned.length >= maxLen && nextId) {
      var nextEl = document.getElementById(nextId);
      if (nextEl) { nextEl.focus(); nextEl.select(); }
    }
  });
}

function fixIdFromHash() {
  var m = /^#fix=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function routeFromHash() {
  var id = fixIdFromHash();
  if (id) {
    openFix(id);
  } else {
    showListView();
  }
}

function showListView() {
  currentFix = null;
  document.getElementById('fixListView').style.display = 'block';
  document.getElementById('fixDetailView').style.display = 'none';
  refreshFixList();
}

function showDetailView() {
  document.getElementById('fixListView').style.display = 'none';
  document.getElementById('fixDetailView').style.display = 'block';
}

// ---------------------------------------------------------------------
// LIST VIEW
// ---------------------------------------------------------------------

function refreshFixList() {
  FixStorage.list().then(function (entries) {
    var listEl = document.getElementById('fixList');
    var emptyEl = document.getElementById('fixListEmpty');
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
        '<div class="saved-item-info">' +
          '<div class="saved-item-title"></div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' +
        '<div class="saved-item-actions">' +
          '<button class="btn-mini btn-mini-load">Open</button>' +
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = entry.name;
      item.querySelector('.saved-item-meta').textContent =
        (entry.type === 'KNOWN' ? 'Known position' : entry.sightCount + ' sight' + (entry.sightCount === 1 ? '' : 's')) +
        ' \u00B7 saved ' + new Date(entry.savedAt).toLocaleString();

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        location.hash = 'fix=' + encodeURIComponent(entry.id);
      });

      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        if (!confirm('Delete the fix "' + entry.name + '"? Its sights are not affected, only the fix itself.')) return;
        FixStorage.remove(entry.id).then(function () {
          showToast('Fix deleted.');
          refreshFixList();
        });
      });

      listEl.appendChild(item);
    });
  });
}

/** "Fix - m/dd/yyyy" using today's local date, e.g. "Fix - 8/27/2026". */
function defaultFixName() {
  var d = new Date();
  return 'Fix - ' + (d.getMonth() + 1) + '/' + String(d.getDate()).padStart(2, '0') + '/' + d.getFullYear();
}

function onNewFixClick() {
  var suggested = defaultFixName();
  var name = prompt('Name this fix:', suggested);
  if (name === null) return; // cancelled

  name = name.trim() || suggested;

  FixStorage.save({ name: name, sightIds: [], type: 'SIGHT_DERIVED' }).then(function (saved) {
    showToast('Created "' + name + '".');
    location.hash = 'fix=' + encodeURIComponent(saved.id);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not create fix (storage may be full or unavailable).', true);
  });
}

function onNewKnownFixClick() {
  var suggested = defaultFixName();
  var name = prompt('Name this known fix:', suggested);
  if (name === null) return; // cancelled

  name = name.trim() || suggested;

  FixStorage.save({ name: name, sightIds: [], type: 'KNOWN' }).then(function (saved) {
    showToast('Created "' + name + '".');
    location.hash = 'fix=' + encodeURIComponent(saved.id);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not create fix (storage may be full or unavailable).', true);
  });
}

// ---------------------------------------------------------------------
// DETAIL VIEW
// ---------------------------------------------------------------------

function openFix(id) {
  var myToken = ++fixRenderToken;
  FixStorage.get(id).then(function (fix) {
    if (myToken !== fixRenderToken) return; // superseded by a newer openFix() call
    if (!fix) {
      showToast('That fix could not be found.', true);
      location.hash = '';
      return;
    }
    currentFix = fix;
    showDetailView();
    closeAdvancePanel();

    document.getElementById('fixDetailName').textContent = fix.name;

    setDetailCardsForType(fix.type);

    if (fix.type === 'KNOWN') {
      document.getElementById('fixDetailMeta').textContent = fix.resolvedPosition
        ? 'Known position \u00B7 as of ' + new Date(fix.resolvedPosition.time).toLocaleString()
        : 'Known position \u00B7 not yet set';
      renderKnownFixForm(fix);
      document.getElementById('fixPositionCard').style.display = fix.resolvedPosition ? 'block' : 'none';
      updateFixPositionButtons();
      return;
    }

    document.getElementById('fixDetailMeta').textContent =
      fix.sightIds.length + ' sight' + (fix.sightIds.length === 1 ? '' : 's') +
      ' \u00B7 saved ' + new Date(fix.savedAt).toLocaleString();

    document.getElementById('fixChartCard').style.display = 'none';
    document.getElementById('fixPlotStatus').textContent = '';
    lastChartInput = null;
    // Reflect whatever was last saved (if anything) immediately, before the
    // plot even loads -- renderCurrentPlot() below will refresh this to the
    // live-computed value once sights are fetched, which may differ if
    // anything's changed since the last Save.
    document.getElementById('fixPositionCard').style.display = fix.sightIds.length ? 'block' : 'none';
    updateFixPositionButtons();
    // Reflect whichever method was actually saved (if any) -- not just
    // always defaulting to least-squares. renderCurrentPlot() below will
    // fall back to least-squares on its own if this fix no longer has
    // enough active sights to support bisectors (see its own guard),
    // so this only needs to express what was last explicitly saved, not
    // re-validate it.
    setFixMethodState(fix.resolvedPositionMethod === 'bisector');

    renderFixSights(myToken);
    renderAvailableSights(myToken);
    autoPlotFix();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that fix.', true);
  });
}

/**
 * A sight is "active" (used in the plot and fed into fix resolution) by
 * default -- activeSightIds only gets materialized the first time
 * someone deselects one, so old fixes (and new ones nobody's touched yet)
 * correctly treat every member as active without needing a migration.
 */
function getActiveSightIds(fix) {
  return new Set(fix.activeSightIds || fix.sightIds);
}

function setSightActive(fix, id, isActive) {
  var current = fix.activeSightIds ? fix.activeSightIds.slice() : fix.sightIds.slice();
  var idx = current.indexOf(id);
  if (isActive && idx === -1) current.push(id);
  if (!isActive && idx !== -1) current.splice(idx, 1);
  fix.activeSightIds = current;
}

function sightRowLabel(record) {
  var title = record.title || SightCalc.formatBodyLabel(record.body);
  var meta = SightCalc.formatBodyLabel(record.body) + ' \u00B7 ' + (record.date || 'no date');
  if (record.results && record.results.observationTime) {
    var d = new Date(record.results.observationTime);
    meta += ' \u00B7 ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + 'z';
  }
  return { title: title, meta: meta };
}

function renderFixSights(token) {
  var listEl = document.getElementById('fixSightsList');
  var emptyEl = document.getElementById('fixSightsEmpty');
  listEl.innerHTML = '';

  if (!currentFix.sightIds.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  var idsAtRenderTime = currentFix.sightIds.slice();
  var advances = currentFix.advances || {};
  var legIdsNeeded = idsAtRenderTime.map(function (id) { return advances[id]; }).filter(function (legId) { return !!legId; });

  Promise.all([
    Promise.all(idsAtRenderTime.map(function (id) { return SightStorage.get(id); })),
    Promise.all(legIdsNeeded.map(function (legId) { return DrLegStorage.get(legId); }))
  ]).then(function (results) {
      if (token !== fixRenderToken) return; // a newer render superseded this one
      var records = results[0];
      var legsById = {};
      legIdsNeeded.forEach(function (legId, i) { legsById[legId] = results[1][i]; });
      listEl.innerHTML = '';

      records.forEach(function (record, i) {
        var id = idsAtRenderTime[i];
        var item = document.createElement('div');
        item.className = 'saved-item';
        var swatchColor = SightCalc.paletteColor(i);

        if (!record) {
          item.innerHTML =
            '<div class="saved-item-info">' +
              '<div class="saved-item-info-row"><span class="sight-color-dot" style="background:' + swatchColor + '"></span>' +
              '<div class="saved-item-title">(sight no longer exists)</div></div>' +
            '</div>' +
            '<div class="saved-item-actions"><button class="btn-mini btn-mini-del">Remove</button></div>';
        } else {
          var labels = sightRowLabel(record);
          var legId = advances[id];
          var advanceLine = '';
          if (legId) {
            var leg = legsById[legId];
            advanceLine = leg
              ? 'Advanced via "' + leg.name + '" \u2192 ' + new Date(leg.endPosition.time).toLocaleString()
              : 'Advanced via a DR Leg that no longer exists (using as-observed instead)';
          }
          item.innerHTML =
            '<div class="saved-item-info">' +
              '<div class="saved-item-info-row"><span class="sight-color-dot" style="background:' + swatchColor + '"></span>' +
              '<div><div class="saved-item-title"></div><div class="saved-item-meta"></div><div class="saved-item-meta advance-line" style="display:none;"></div></div></div>' +
            '</div>' +
            '<div class="saved-item-actions">' +
              '<button class="btn-mini btn-mini-fix btn-advance"></button>' +
              '<button class="btn-mini btn-mini-del">Remove</button>' +
            '</div>';
          item.querySelector('.saved-item-title').textContent = labels.title;
          item.querySelector('.saved-item-meta').textContent = labels.meta;
          if (advanceLine) {
            var advanceLineEl = item.querySelector('.advance-line');
            advanceLineEl.textContent = advanceLine;
            advanceLineEl.style.display = 'block';
          }
          var advanceBtn = item.querySelector('.btn-advance');
          advanceBtn.textContent = legId ? 'Un-advance' : 'Advance\u2026';
          advanceBtn.addEventListener('click', function () {
            if (legId) {
              onClearAdvance(id);
            } else {
              openAdvancePanel(id, record);
            }
          });
        }

        item.querySelector('.btn-mini-del').addEventListener('click', function () {
          currentFix.sightIds = currentFix.sightIds.filter(function (sid) { return sid !== id; });
          if (currentFix.activeSightIds) {
            currentFix.activeSightIds = currentFix.activeSightIds.filter(function (sid) { return sid !== id; });
          }
          if (currentFix.advances) delete currentFix.advances[id]; // don't leave a stale advance pointing at a sight no longer in this fix
          FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
        });

        listEl.appendChild(item);
      });
    });
}

function renderAvailableSights(token) {
  var listEl = document.getElementById('availableSightsList');
  var emptyEl = document.getElementById('availableSightsEmpty');
  listEl.innerHTML = '';

  SightStorage.list().then(function (entries) {
    if (token !== fixRenderToken) return; // a newer render superseded this one

    var available = entries.filter(function (e) { return currentFix.sightIds.indexOf(e.id) === -1; });

    if (!available.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    available.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'saved-item';
      item.innerHTML =
        '<div class="saved-item-info"><div class="saved-item-title"></div><div class="saved-item-meta"></div></div>' +
        '<div class="saved-item-actions"><button class="btn-mini btn-mini-load">Add</button></div>';

      item.querySelector('.saved-item-title').textContent = entry.title || entry.bodyLabel;
      item.querySelector('.saved-item-meta').textContent =
        entry.bodyLabel + ' \u00B7 ' + (entry.date || 'no date') + ' \u00B7 saved ' + new Date(entry.savedAt).toLocaleString();

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        currentFix.sightIds.push(entry.id);
        // New members default to active -- only append here if activeSightIds
        // has already been materialized (an untouched fix's fallback already
        // includes everyone via getActiveSightIds()).
        if (currentFix.activeSightIds) currentFix.activeSightIds.push(entry.id);
        FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
      });

      listEl.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------------
// RUNNING FIX: advancing a sight's LOP via a saved DR Leg
// ---------------------------------------------------------------------

var _advanceTargetId = null;

/**
 * Opens the shared "Advance via DR Leg" panel for one sight. Lists every
 * saved DR Leg (not filtered by proximity to this sight's own time --
 * simplest correct behavior for now: the person can see each leg's own
 * start/end times right in the list and judge for themselves which one
 * applies, rather than the app guessing at a "close enough" heuristic).
 */
function openAdvancePanel(sightId, sightRecord) {
  _advanceTargetId = sightId;

  DrLegStorage.list().then(function (legs) {
    var listEl = document.getElementById('advanceLegList');
    var emptyEl = document.getElementById('advanceLegEmpty');
    listEl.innerHTML = '';

    if (!legs.length) {
      emptyEl.style.display = 'block';
    } else {
      emptyEl.style.display = 'none';
      legs.forEach(function (entry) {
        var item = document.createElement('div');
        item.className = 'saved-item';
        item.innerHTML =
          '<div class="saved-item-info"><div class="saved-item-title"></div><div class="saved-item-meta"></div></div>' +
          '<div class="saved-item-actions"><button class="btn-mini btn-mini-load">Use</button></div>';
        item.querySelector('.saved-item-title').textContent = entry.name;
        item.querySelector('.saved-item-meta').textContent =
          new Date(entry.startTime).toLocaleString() + ' \u2192 ' + new Date(entry.endTime).toLocaleString();
        item.querySelector('.btn-mini-load').addEventListener('click', function () { onConfirmAdvance(entry.id); });
        listEl.appendChild(item);
      });
    }

    document.getElementById('advanceLegTargetLabel').textContent = sightRowLabel(sightRecord).title;
    var panel = document.getElementById('advanceLegPanel');
    panel.style.display = 'block';
    if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

function closeAdvancePanel() {
  document.getElementById('advanceLegPanel').style.display = 'none';
  _advanceTargetId = null;
}

function onConfirmAdvance(legId) {
  if (!_advanceTargetId) { closeAdvancePanel(); return; }
  if (!currentFix.advances) currentFix.advances = {};
  currentFix.advances[_advanceTargetId] = legId;
  closeAdvancePanel();
  FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
}

function onClearAdvance(sightId) {
  if (currentFix.advances) delete currentFix.advances[sightId];
  FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
}

function onDeleteFix() {
  if (!currentFix) return;
  if (!confirm('Delete the fix "' + currentFix.name + '"? Its sights are not affected, only the fix itself.')) return;
  FixStorage.remove(currentFix.id).then(function () {
    showToast('Fix deleted.');
    location.hash = '';
  });
}

// ---------------------------------------------------------------------
// KNOWN FIX: position/time entered directly, no underlying Sights
// ---------------------------------------------------------------------

/**
 * Toggles which detail-view cards apply -- a Known Fix has no Sights, so
 * everything that operates on sightIds (the sights list, the "Advance via
 * DR Leg" panel, the "Add a Saved Sight" picker, the LOP plot) is hidden in
 * favor of the direct-entry "Known Position" card. "Use This Fix" (New
 * Sight from Fix Position / Send to DR Leg) stays visible either way -- see
 * updateFixPositionButtons -- since those only depend on resolvedPosition
 * being set, not on how it got there; only its own "Save Position" row is
 * hidden for a Known Fix (see below).
 */
function setDetailCardsForType(type) {
  var isKnown = type === 'KNOWN';
  document.getElementById('knownFixCard').style.display = isKnown ? 'block' : 'none';
  document.getElementById('fixSightsCard').style.display = isKnown ? 'none' : 'block';
  document.getElementById('availableSightsCard').style.display = isKnown ? 'none' : 'block';
  document.getElementById('fixPlotCard').style.display = isKnown ? 'none' : 'block';
  // The "Save Position" button here is specifically for committing whichever
  // LOP-solver method is currently selected -- meaningless for a Known Fix,
  // which is already persisted the moment its own "Save Position" (in the
  // Known Position card above) is used. Hidden rather than relabeled, so
  // there's exactly one "Save Position" action for a Known Fix, not two
  // that do different things.
  document.getElementById('fixUseSaveRow').style.display = isKnown ? 'none' : 'block';
  document.getElementById('fixUseBlurb').textContent = isKnown
    ? 'The position and time entered above.'
    : 'Uses whichever method (least-squares or bisectors) is currently selected above. "Save ' +
      'Position" is a deliberate action -- toggling methods doesn’t save anything on its own, ' +
      'so switching to compare doesn’t silently change what’s stored for this fix.';
}

/**
 * Fills the Known Position form from the fix's currently-saved
 * resolvedPosition (via SightCalc.decimalToDM, the inverse of the deg/min
 * entry it was built from), or clears it for a fix that's never had a
 * position entered yet. Same field shape/ids as passages.html's Starting
 * Position form, read the same way by onSaveKnownFixPosition below.
 */
function renderKnownFixForm(fix) {
  var pos = fix.resolvedPosition;
  if (!pos) {
    document.getElementById('knownFixDate').value = '';
    document.getElementById('knownFixTimeH').value = '';
    document.getElementById('knownFixTimeM').value = '';
    document.getElementById('knownFixTz').value = -4;
    document.getElementById('knownFixLatDeg').value = '';
    document.getElementById('knownFixLatMin').value = '';
    document.getElementById('knownFixLatNS').value = 'N';
    document.getElementById('knownFixLonDeg').value = '';
    document.getElementById('knownFixLonMin').value = '';
    document.getElementById('knownFixLonEW').value = 'W';
    return;
  }

  var tzOffset = fix.resolvedPositionTzOffset || 0;
  var local = SightCalc.utcMsToLocalDateTime(new Date(pos.time).getTime(), tzOffset);
  var lat = SightCalc.decimalToDM(pos.lat);
  var lon = SightCalc.decimalToDM(pos.lon);

  document.getElementById('knownFixDate').value = local.dateStr;
  document.getElementById('knownFixTimeH').value = String(Math.floor(local.secOfDay / 3600)).padStart(2, '0');
  document.getElementById('knownFixTimeM').value = String(Math.floor((local.secOfDay % 3600) / 60)).padStart(2, '0');
  document.getElementById('knownFixTz').value = tzOffset;
  document.getElementById('knownFixLatDeg').value = lat.deg;
  document.getElementById('knownFixLatMin').value = lat.min;
  document.getElementById('knownFixLatNS').value = pos.lat < 0 ? 'S' : 'N';
  document.getElementById('knownFixLonDeg').value = lon.deg;
  document.getElementById('knownFixLonMin').value = lon.min;
  document.getElementById('knownFixLonEW').value = pos.lon < 0 ? 'W' : 'E';
}

/**
 * Parses the Known Position form and saves it as this fix's resolvedPosition
 * -- the direct-entry counterpart to cacheResolvedPosition()'s LOP-solver
 * output. sourceType KNOWN, sourceId this fix's own id, same as any other
 * hand-entered position in the app (see calc.js's makePosition/
 * POSITION_SOURCE_TYPES). resolvedPositionMethod is intentionally left
 * unset -- that field means "which LOP-crossing method," which doesn't
 * apply here.
 */
function onSaveKnownFixPosition() {
  var dateVal = document.getElementById('knownFixDate').value;
  var latDegVal = document.getElementById('knownFixLatDeg').value;
  var lonDegVal = document.getElementById('knownFixLonDeg').value;

  if (!dateVal || latDegVal === '' || lonDegVal === '') {
    showToast('Enter a date and both latitude and longitude.', true);
    return;
  }

  var latDeg = parseFloat(latDegVal), lonDeg = parseFloat(lonDegVal);
  if (isNaN(latDeg) || isNaN(lonDeg)) {
    showToast('Enter both latitude and longitude.', true);
    return;
  }

  var pos = SightCalc.signedPositionFromRecord({
    latDeg: latDeg,
    latMin: parseFloat(document.getElementById('knownFixLatMin').value) || 0,
    latNS: document.getElementById('knownFixLatNS').value,
    lonDeg: lonDeg,
    lonMin: parseFloat(document.getElementById('knownFixLonMin').value) || 0,
    lonEW: document.getElementById('knownFixLonEW').value
  });
  var tzOffset = parseFloat(document.getElementById('knownFixTz').value) || 0;
  var h = parseInt(document.getElementById('knownFixTimeH').value, 10) || 0;
  var m = parseInt(document.getElementById('knownFixTimeM').value, 10) || 0;
  var utcMs = SightCalc.localDateTimeToUtcMs(dateVal, h * 3600 + m * 60, tzOffset);

  currentFix.resolvedPosition = SightCalc.makePosition(new Date(utcMs).toISOString(), pos.lat, pos.lon, SightCalc.POSITION_SOURCE_TYPES.KNOWN, currentFix.id);
  currentFix.resolvedPositionTzOffset = tzOffset;
  currentFix.resolvedPositionMethod = null;

  FixStorage.save(currentFix).then(function () {
    showToast('Saved known position.');
    openFix(currentFix.id);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save (storage may be full or unavailable).', true);
  });
}

// ---------------------------------------------------------------------
// PLOTTING
// ---------------------------------------------------------------------

function setFixPlotStatus(msg, kind) {
  var el = document.getElementById('fixPlotStatus');
  el.textContent = msg;
  el.className = 'cache-progress' + (kind ? ' ' + kind : '');
}

function setFixResultStatus(msg, kind) {
  var el = document.getElementById('fixResultStatus');
  el.textContent = msg;
  el.className = 'cache-progress' + (kind ? ' ' + kind : '');
}

/** Updates bisectorMethodSelected + both buttons' aria-pressed, without re-rendering. */
function setFixMethodState(useBisectors) {
  bisectorMethodSelected = useBisectors;
  document.getElementById('methodLeastSquares').setAttribute('aria-pressed', useBisectors ? 'false' : 'true');
  document.getElementById('methodBisectors').setAttribute('aria-pressed', useBisectors ? 'true' : 'false');
}

/** Same, but also re-renders -- used by the button clicks themselves. */
function setFixMethod(useBisectors) {
  setFixMethodState(useBisectors);
  renderCurrentPlot();
}

/** Plots automatically whenever the fix's sights change -- called from openFix(). */
/**
 * A Running Fix isn't a different kind of Fix -- it's this same function,
 * given a sight that has an entry in currentFix.advances. For those,
 * the AP fed into the solver is shifted by the referenced DR Leg
 * (SightCalc.advancePositionByLeg -- see its own comment for why this is
 * ALL a Running Fix needs: Zn/interceptNM stay exactly as observed, only
 * the AP moves, and resolveMultiLopFix already handles a mix of APs across
 * LOPs). The "time" contributed for cacheResolvedPosition's latest-time
 * calc is likewise the leg's endPosition.time, not the sight's own
 * observation time -- an advanced LOP is being treated as current as of
 * when it was advanced TO, not when it was actually observed.
 */
function autoPlotFix() {
  if (!currentFix || !currentFix.sightIds.length) {
    document.getElementById('fixChartCard').style.display = 'none';
    setFixPlotStatus('Add at least one sight to this fix to see its plot.', '');
    return;
  }

  setFixPlotStatus('Loading sights\u2026', 'loading');

  var advances = currentFix.advances || {};
  var legIdsNeeded = currentFix.sightIds
    .map(function (id) { return advances[id]; })
    .filter(function (legId) { return !!legId; });

  Promise.all([
    Promise.all(currentFix.sightIds.map(function (id) { return SightStorage.get(id); })),
    Promise.all(legIdsNeeded.map(function (legId) { return DrLegStorage.get(legId); }))
  ]).then(function (results) {
      var records = results[0];
      var legsById = {};
      legIdsNeeded.forEach(function (legId, i) { legsById[legId] = results[1][i]; });

      var skippedMissing = 0;
      var skippedNoResults = 0;
      var skippedBrokenAdvance = 0;
      var chartInput = [];

      // Color and badge number are keyed to each sight's position in the
      // FULL fix list (not the filtered/plottable subset), so a sight's
      // color always matches its swatch in the "Sights in this Fix" list
      // above -- even when an earlier sight gets skipped from the plot.
      records.forEach(function (record, i) {
        if (!record) { skippedMissing++; return; }
        if (!record.results || typeof record.results.zn !== 'number' || typeof record.results.interceptNM !== 'number') {
          skippedNoResults++;
          return;
        }
        var id = currentFix.sightIds[i];
        var pos = SightCalc.signedPositionFromRecord(record.position);
        var observationTime = record.results.observationTime;
        var originalPos = null;
        var transferLabel = null;
        var drTrackLabel = null;

        // Standard USCG/commercial celestial-LOP plotting convention: every
        // LOP is labeled with the body's name and the 4-digit observation
        // time (e.g. "SUN 0915") -- never the time alone, since a multi-body
        // fix needs to say which body each line belongs to. Uses this
        // sight's own local time/tzOffset (not the leg's), matching how the
        // rest of the app shows times.
        var fmtHHMM = function (secOfDay) {
          return String(Math.floor(secOfDay / 3600)).padStart(2, '0') + String(Math.floor((secOfDay % 3600) / 60)).padStart(2, '0');
        };
        var MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        var fmtDayMonth = function (dateStr) {
          var parts = dateStr.split('-');
          return parseInt(parts[2], 10) + ' ' + MONTH_ABBR[parseInt(parts[1], 10) - 1];
        };
        // Drops a trailing ".0" (10 -> "10", 10.5 -> "10.5") -- SOG is
        // usually a whole number and the convention's own example shows it
        // unadorned ("10 kn"), not "10.0 kn".
        var trimNum = function (n) { return String(Math.round(n * 10) / 10); };

        var bodyLabelChart = SightCalc.formatBodyLabelChart(record.body);
        var localObs = SightCalc.utcMsToLocalDateTime(new Date(record.results.observationTime).getTime(), record.position.tzOffset);
        var chartLabel = bodyLabelChart + ' ' + fmtHHMM(localObs.secOfDay);

        var legId = advances[id];
        if (legId) {
          var leg = legsById[legId];
          if (!leg) {
            // The referenced leg was deleted out from under this advance --
            // fail safe to the as-observed LOP rather than silently
            // dropping the sight or crashing the plot; renderFixSights()
            // surfaces this same brokenness so it's not silent.
            skippedBrokenAdvance++;
          } else {
            originalPos = pos;
            var advanced = SightCalc.advancePositionByLeg(pos.lat, pos.lon, leg);
            pos = advanced;
            observationTime = leg.endPosition.time;

            // Advanced-LOP convention: "SUN 0915-1200" (same calendar day)
            // or, spanning midnight, the more explicit "SUN 15 Sep 23:40 LOP
            // advanced to 16 Sep 01:10" -- cramming two full dates into the
            // terse dash format would be unreadable, so a plainer sentence
            // is used instead specifically for that case. Both times use
            // this sight's OWN tzOffset (not the leg's) -- simplest honest
            // choice for a single label; the leg's own end time is what's
            // actually used for the math above regardless of what's shown.
            // 4-digit 24h time, no colon, throughout -- USCG convention.
            var localAdv = SightCalc.utcMsToLocalDateTime(new Date(observationTime).getTime(), record.position.tzOffset);
            transferLabel = (localObs.dateStr !== localAdv.dateStr)
              ? bodyLabelChart + ' ' + fmtDayMonth(localObs.dateStr) + ' ' + fmtHHMM(localObs.secOfDay) +
                ' LOP advanced to ' + fmtDayMonth(localAdv.dateStr) + ' ' + fmtHHMM(localAdv.secOfDay)
              : bodyLabelChart + ' ' + fmtHHMM(localObs.secOfDay) + '\u2013' + fmtHHMM(localAdv.secOfDay);

            // DR track label: "DR 0934-1834 \u00b7 135\u00b0T @ 10 kn \u00b7 90.0 NM" (same day)
            // or "DR 15 Sep 2340 \u2192 16 Sep 0110 \u00b7 135\u00b0T @ 10 kn \u00b7 15.0 NM"
            // (spanning midnight). Uses the LEG's own start/end/tzOffset --
            // this describes the leg itself, which is usually but not
            // necessarily identical to the sight's own observation instant
            // (see SightCalc.roundUpToMinuteMs: a leg started from a sight
            // rounds the start UP to the next whole minute).
            var legStart = SightCalc.utcMsToLocalDateTime(new Date(leg.startPosition.time).getTime(), leg.tzOffset);
            var legEnd = SightCalc.utcMsToLocalDateTime(new Date(leg.endPosition.time).getTime(), leg.tzOffset);
            var legTimeRange = (legStart.dateStr !== legEnd.dateStr)
              ? fmtDayMonth(legStart.dateStr) + ' ' + fmtHHMM(legStart.secOfDay) + ' \u2192 ' + fmtDayMonth(legEnd.dateStr) + ' ' + fmtHHMM(legEnd.secOfDay)
              : fmtHHMM(legStart.secOfDay) + '\u2013' + fmtHHMM(legEnd.secOfDay);
            var legCourseStr = String(Math.round(leg.courseDegTrue)).padStart(3, '0') + '\u00B0T';
            var legDistanceNM = leg.sog * leg.durationHours;
            drTrackLabel = 'DR ' + legTimeRange + ' \u00B7 ' + legCourseStr + ' @ ' + trimNum(leg.sog) + ' kn \u00B7 ' + legDistanceNM.toFixed(1) + ' NM';
          }
        }

        var labels = sightRowLabel(record);
        chartInput.push({
          id: id,
          lat: pos.lat,
          lon: pos.lon,
          originalLat: originalPos ? originalPos.lat : undefined,
          originalLon: originalPos ? originalPos.lon : undefined,
          chartLabel: chartLabel,
          transferLabel: transferLabel,
          drTrackLabel: drTrackLabel,
          zn: record.results.zn,
          interceptNM: record.results.interceptNM,
          observationTime: observationTime, // ISO UTC -- used to timestamp the Fix's cached resolvedPosition
          tzOffset: record.position.tzOffset, // carried alongside, for handoffs built from the resolved position (see onFixToSight/onFixToDrLeg)
          label: labels.title,
          color: SightCalc.paletteColor(i),
          badgeNumber: i + 1
        });
      });

      if (!chartInput.length) {
        document.getElementById('fixChartCard').style.display = 'none';
        setFixPlotStatus('None of this fix\u2019s sights have calculated results to plot. Recalculate and re-save them on the Sight Reduction page.', 'error');
        return;
      }

      lastChartInput = chartInput;

      document.getElementById('fixChartCard').style.display = 'block';
      renderCurrentPlot();

      var msg = 'Plotted ' + chartInput.length + ' of ' + currentFix.sightIds.length + ' sight' + (currentFix.sightIds.length === 1 ? '' : 's') + '.';
      var skipped = skippedMissing + skippedNoResults;
      if (skipped) {
        msg += ' Skipped ' + skipped + ' (missing or not yet calculated).';
      }
      if (skippedBrokenAdvance) {
        msg += ' ' + skippedBrokenAdvance + ' advanced sight' + (skippedBrokenAdvance === 1 ? '' : 's') + ' fell back to as-observed (the DR Leg it referenced no longer exists).';
      }
      setFixPlotStatus(msg, (skipped || skippedBrokenAdvance) ? 'error' : 'ok');
    })
    .catch(function (err) {
      console.error(err);
      document.getElementById('fixChartCard').style.display = 'none';
      setFixPlotStatus('Could not plot this fix.', 'error');
    });
}

/** 0-360 zn -> "045°" the same way chart.js's legend text does. */
function formatZnBadge(zn) {
  return String(Math.round(((zn % 360) + 360) % 360)).padStart(3, '0') + '\u00B0';
}

function formatInterceptBadge(interceptNM) {
  return Math.abs(interceptNM).toFixed(1) + ' nm ' + (interceptNM >= 0 ? 'TOWARD' : 'AWAY');
}

/**
 * Tracks the Fix's resolved position IN MEMORY on every render (so it's
 * always available to the "Use This Fix" actions below), but deliberately
 * does NOT persist it automatically -- see onSaveFixPosition(). Previously
 * FixStorage never stored a position at all (it was recomputed live on
 * every view and discarded); toggling between least-squares and bisectors
 * to compare them also shouldn't silently change what's saved, so caching
 * here is memory-only and persisting is a separate, deliberate choice of
 * which method's answer to commit to.
 *
 * Timestamped with the LATEST observation time among the actively-plotted
 * sights, matching the usual convention that a fix's time is the time of
 * its most recent constituent sight. sourceId is stamped as this Fix's own
 * id right away (unlike a DR Leg's live endPosition, a Fix always has a
 * stable id already -- FixStorage.save() assigns one the moment the fix is
 * first created, before any sights are even added), so anything that
 * later copies this position elsewhere (a new Sight's AP, a DR Leg's start)
 * can say which Fix it came from. tzOffset/method are tracked alongside,
 * not inside the Position itself (Position is intentionally tz- and
 * method-agnostic), so the handoffs below can reconstruct a local
 * date/time and the Save button can report which method was used.
 */
function cacheResolvedPosition(fixResult, activeSights) {
  document.getElementById('fixPositionCard').style.display = activeSights.length ? 'block' : 'none';

  if (!fixResult.solvable || typeof fixResult.lat !== 'number' || typeof fixResult.lon !== 'number') {
    currentFix.resolvedPosition = null;
    updateFixPositionButtons();
    return;
  }

  var latest = null;
  activeSights.forEach(function (s) {
    if (s.observationTime && (!latest || s.observationTime > latest.observationTime)) latest = s;
  });
  if (!latest) { currentFix.resolvedPosition = null; updateFixPositionButtons(); return; }

  currentFix.resolvedPosition = SightCalc.makePosition(latest.observationTime, fixResult.lat, fixResult.lon, SightCalc.POSITION_SOURCE_TYPES.FIX, currentFix.id);
  currentFix.resolvedPositionTzOffset = latest.tzOffset;
  currentFix.resolvedPositionMethod = fixResult.source; // 'bisector' | 'least-squares'
  updateFixPositionButtons();
}

function updateFixPositionButtons() {
  var ready = !!currentFix.resolvedPosition;
  document.getElementById('btnSaveFixPosition').disabled = !ready;
  document.getElementById('btnFixToSight').disabled = !ready;
  document.getElementById('btnFixToDrLeg').disabled = !ready;
}

/** Explicit, deliberate persistence of the currently-displayed resolved position -- see cacheResolvedPosition's comment on why this isn't automatic. */
function onSaveFixPosition() {
  if (!currentFix.resolvedPosition) return;
  var methodLabel = currentFix.resolvedPositionMethod === 'bisector' ? 'bisectors' : 'least-squares';
  FixStorage.save(currentFix).then(function () {
    showToast('Saved fix position (' + methodLabel + ').');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not save (storage may be full or unavailable).', true);
  });
}

function onFixToSight() {
  if (!currentFix.resolvedPosition) return;
  var handoff = { position: currentFix.resolvedPosition, tzOffset: currentFix.resolvedPositionTzOffset };
  sessionStorage.setItem('ocsrApHandoff', JSON.stringify(handoff));
  location.href = 'index.html';
}

function onFixToDrLeg() {
  if (!currentFix.resolvedPosition) return;
  var handoff = { position: currentFix.resolvedPosition, tzOffset: currentFix.resolvedPositionTzOffset, sentFrom: 'Fix' };
  sessionStorage.setItem('ocsrDrLegStartHandoff', JSON.stringify(handoff));
  location.href = 'drleg.html';
}

/**
 * Re-renders the already-fetched plot using the current toggle/method/active
 * states -- no re-fetch needed. The legend always lists every plottable
 * sight (so a deselected one can be switched back on); only the ones in
 * the active set are actually fed into the chart and the fix resolution.
 */
function renderCurrentPlot() {
  if (!lastChartInput) return;

  var activeSet = getActiveSightIds(currentFix);
  var plotInput = lastChartInput.filter(function (item) { return activeSet.has(item.id); });

  var methodBisectorsBtn = document.getElementById('methodBisectors');
  methodBisectorsBtn.disabled = plotInput.length < 3;
  if (methodBisectorsBtn.disabled && bisectorMethodSelected) setFixMethodState(false);

  // The fix marker's own label -- same "latest constituent time" convention
  // used everywhere else a fix needs one instant (see cacheResolvedPosition),
  // formatted as the bare 4-digit time standard plotting practice uses to
  // label a fix circle (e.g. "0630", or "1200 R FIX" for a running fix).
  var fixTimeLabel = null;
  var latestForLabel = null;
  plotInput.forEach(function (item) {
    if (item.observationTime && (!latestForLabel || item.observationTime > latestForLabel.observationTime)) latestForLabel = item;
  });
  if (latestForLabel) {
    var localFixTime = SightCalc.utcMsToLocalDateTime(new Date(latestForLabel.observationTime).getTime(), latestForLabel.tzOffset);
    fixTimeLabel = String(Math.floor(localFixTime.secOfDay / 3600)).padStart(2, '0') + String(Math.floor((localFixTime.secOfDay % 3600) / 60)).padStart(2, '0');
  }

  var opts = {
    showAzimuth: document.getElementById('toggleShowAzimuth').checked,
    showBisectors: bisectorMethodSelected,
    fixTimeLabel: fixTimeLabel,
    selected: currentSelection,
    fixId: currentFix.id,
    viewport: fixViewport // null until a pan/zoom gesture (or reset) has set one -- renderMultiSightChart auto-fits when this is null
  };

  var container = document.getElementById('fixChartContainer');
  var result = SightChart.renderMultiSightChart(container, plotInput, opts);
  cacheResolvedPosition(result.fix, plotInput);

  // Always synced from what was ACTUALLY just rendered (the override if one
  // was given, otherwise the fresh auto-fit) -- so chartPanZoom.js's own
  // getViewport() callback (see the wiring in DOMContentLoaded below)
  // always reflects the current state, and further gestures build on top
  // of this render rather than a stale one.
  fixViewport = { originLat: result.originLat, originLon: result.originLon, scale: result.scaleNM };
  fixAutoScaleNM = result.autoScaleNM;
  fixAutoOriginLat = result.autoOriginLat;
  fixAutoOriginLon = result.autoOriginLon;

  var legendEl = document.getElementById('fixChartLegend');
  legendEl.innerHTML = '';

  lastChartInput.forEach(function (item) {
    var isActive = activeSet.has(item.id);
    var row = document.createElement('label');
    row.className = 'chart-legend-item chart-legend-toggle';
    row.innerHTML =
      '<input type="checkbox"' + (isActive ? ' checked' : '') + '>' +
      '<span class="chart-swatch" style="border-top-color: ' + item.color + '; border-top-style: solid;"></span> ' +
      item.badgeNumber + '. ' + item.label + ' \u2014 Zn ' + formatZnBadge(item.zn) + ' (' + formatInterceptBadge(item.interceptNM) + ')' +
      (item.transferLabel ? ' \u2014 advanced ' + item.transferLabel : '');

    row.querySelector('input').addEventListener('change', function (e) {
      setSightActive(currentFix, item.id, e.target.checked);
      FixStorage.save(currentFix).then(renderCurrentPlot);
    });

    legendEl.appendChild(row);
  });

  renderFixResult(result.fix, plotInput.length, legendEl);
}

/**
 * chartInteraction.js calls this whenever the selected element changes
 * (a tap resolved to a single element, an ambiguity list got resolved, or
 * the selection was cleared) -- it doesn't know or care what changed,
 * only that it did. Re-rendering with the new selection is what lets
 * chart.js draw the newly-selected element emphasized; that's the one
 * place these two files' concerns touch.
 */
/**
 * chartPanZoom.js's own callbacks -- see its file header for the full
 * contract. getFixViewport supplies both the active viewport (wherever
 * the user has panned/zoomed to, or null before any gesture) and the
 * current auto-fit baseline (scale + true origin), kept distinct since
 * "reset to fit" needs the latter, not wherever the view currently is.
 * onFixViewportChange just re-renders at the new viewport -- the same
 * renderCurrentPlot() every other chart update already goes through, so a
 * pan/zoom step is treated identically to toggling azimuth lines or
 * switching Fix method, not a special case.
 */
function getFixViewport() {
  return {
    originLat: fixViewport ? fixViewport.originLat : fixAutoOriginLat,
    originLon: fixViewport ? fixViewport.originLon : fixAutoOriginLon,
    scale: fixViewport ? fixViewport.scale : fixAutoScaleNM,
    autoScale: fixAutoScaleNM,
    autoOriginLat: fixAutoOriginLat,
    autoOriginLon: fixAutoOriginLon
  };
}

function onFixViewportChange(viewport) {
  fixViewport = viewport;
  renderCurrentPlot();
}

function onFixSelectionChange(selection) {
  currentSelection = selection;
  renderCurrentPlot();
}

/**
 * Supplies the actual semantic content chartInteraction.js's generic
 * sheet/caption shell displays -- this is the one place that knows what
 * "lop"/"sight"/"fix" mean, deliberately kept out of both chart.js (draws
 * geometry, knows nothing about selection meaning) and chartInteraction.js
 * (owns hit-testing and presentation mechanics, also knows nothing about
 * selection meaning).
 */
function getFixSelectionDetail(candidate) {
  if (candidate.type === 'fix') {
    if (!currentFix.resolvedPosition) return null;
    return {
      title: 'Fix',
      lines: [
        (bisectorMethodSelected ? 'Bisectors' : 'Least-squares') + ' \u00B7 ' + getActiveSightIds(currentFix).size + ' active sights',
        SightCalc.formatLat(currentFix.resolvedPosition.lat) + ' ' + SightCalc.formatLon(currentFix.resolvedPosition.lon)
      ],
      // "Open" here can't mean "navigate to a different page" -- this IS
      // that fix's own page already. It means "show me the full page,"
      // i.e. exit the zoomed plot back to the normal view where the rest
      // of this fix's own details (sights list, save/export) are visible.
      openLabel: 'Open Fix',
      onOpen: function () {
        if (fixChartFullscreenApi) fixChartFullscreenApi.exit();
      }
    };
  }

  if (candidate.type === 'lop' || candidate.type === 'sight') {
    var item = (lastChartInput || []).find(function (x) { return x.id === candidate.recordId; });
    if (!item) return null;
    var lines = [formatZnBadge(item.zn) + ' \u00B7 ' + formatInterceptBadge(item.interceptNM)];
    if (item.transferLabel) lines.push('Advanced \u2014 ' + item.transferLabel);
    return {
      title: item.chartLabel || item.label,
      lines: lines,
      openLabel: 'Open Sight',
      onOpen: function () {
        sessionStorage.setItem('ocsrLoadSightId', item.id);
        location.href = 'index.html';
      }
    };
  }

  return null;
}

function fixIconSvg() {
  return '<svg width="16" height="16" viewBox="0 0 16 16" class="fix-icon" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="5" fill="none" stroke="var(--chart-fix)" stroke-width="2"/>' +
    '<line x1="1" y1="8" x2="15" y2="8" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
    '<line x1="8" y1="1" x2="8" y2="15" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
  '</svg>';
}

function renderFixResult(fix, sightCount, legendEl) {
  var caption = document.getElementById('fixResultCaption');
  caption.textContent = '';

  if (!fix.solvable) {
    setFixResultStatus('Fix: ' + fix.reason, 'error');
    return;
  }
  setFixResultStatus('', '');

  // Least-squares uses every checked/active sight; the bisector method
  // can only use exactly 3, auto-picked for widest azimuth spread when more
  // than 3 are active (see the caption below). Naming the count here makes
  // that difference visible instead of implied -- unchecking a sight that
  // ISN'T one of the bisector triple still changes the least-squares answer,
  // because it was never excluded from that one to begin with.
  var methodLabel = fix.source === 'bisector' ? 'method of bisectors' : 'least-squares';
  var scopeNote = fix.source === 'bisector'
    ? ' (3 of ' + sightCount + ' active)'
    : ' (' + sightCount + ' active sight' + (sightCount === 1 ? '' : 's') + ')';
  var item = document.createElement('div');
  item.className = 'chart-legend-item fix-legend-item';
  item.innerHTML = fixIconSvg() + ' Fix (' + methodLabel + scopeNote + '): ' + fix.positionText;
  legendEl.appendChild(item);

  // Shown whenever a 3-LOP triangle exists, regardless of which method is
  // currently displayed -- it's useful fix-quality context either way. But
  // it describes ONLY the bisector triangle, so it's worded to never look
  // like a statement about which sights the (possibly different)
  // currently-shown Fix number is based on.
  if (typeof fix.bisectorMaxSideNM === 'number') {
    var note = 'Bisector triangle (cocked hat) spread: ' + fix.bisectorMaxSideNM.toFixed(1) + ' nm';
    if (fix.bisectorBadgeNumbers && fix.bisectorBadgeNumbers.length === 3 && sightCount > 3) {
      note += ', using sights #' + fix.bisectorBadgeNumbers.join(', #') + ' (widest azimuth spread)';
    }
    caption.textContent = note;
  }
}
