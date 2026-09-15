/**
 * fixes.js
 * Page logic for fixes.html. A Fix is a named collection of saved Sighting
 * ids (FixStorage); this file wires up create/list/delete, add/remove
 * sightings, and plotting the Fix as a multi-LOP chart (SightChart /
 * SightCalc do the actual geometry -- this file is DOM glue only, same
 * separation of concerns as app.js).
 */

var currentFix = null;
var fixRenderToken = 0;
var lastChartInput = null; // cached so toggling azimuth/bisectors doesn't need to re-fetch sightings
var bisectorMethodSelected = false; // false = least-squares, true = method of bisectors

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('btnNewFix').addEventListener('click', onNewFixClick);
  document.getElementById('btnBackToList').addEventListener('click', function () {
    location.hash = '';
  });
  document.getElementById('btnDeleteFix').addEventListener('click', onDeleteFix);
  document.getElementById('toggleShowAzimuth').addEventListener('change', renderCurrentPlot);
  document.getElementById('methodLeastSquares').addEventListener('click', function () { setFixMethod(false); });
  document.getElementById('methodBisectors').addEventListener('click', function () { setFixMethod(true); });
  document.getElementById('btnSaveFixPosition').addEventListener('click', onSaveFixPosition);
  document.getElementById('btnFixToSighting').addEventListener('click', onFixToSighting);
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
        entry.sightingCount + ' sighting' + (entry.sightingCount === 1 ? '' : 's') +
        ' \u00B7 saved ' + new Date(entry.savedAt).toLocaleString();

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        location.hash = 'fix=' + encodeURIComponent(entry.id);
      });

      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        if (!confirm('Delete the fix "' + entry.name + '"? Its sightings are not affected, only the fix itself.')) return;
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

  FixStorage.save({ name: name, sightingIds: [] }).then(function (saved) {
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
    document.getElementById('fixDetailMeta').textContent =
      fix.sightingIds.length + ' sighting' + (fix.sightingIds.length === 1 ? '' : 's') +
      ' \u00B7 saved ' + new Date(fix.savedAt).toLocaleString();

    document.getElementById('fixChartCard').style.display = 'none';
    document.getElementById('fixPlotStatus').textContent = '';
    lastChartInput = null;
    // Reflect whatever was last saved (if anything) immediately, before the
    // plot even loads -- renderCurrentPlot() below will refresh this to the
    // live-computed value once sightings are fetched, which may differ if
    // anything's changed since the last Save.
    document.getElementById('fixPositionCard').style.display = fix.sightingIds.length ? 'block' : 'none';
    updateFixPositionButtons();
    // Reflect whichever method was actually saved (if any) -- not just
    // always defaulting to least-squares. renderCurrentPlot() below will
    // fall back to least-squares on its own if this fix no longer has
    // enough active sightings to support bisectors (see its own guard),
    // so this only needs to express what was last explicitly saved, not
    // re-validate it.
    setFixMethodState(fix.resolvedPositionMethod === 'bisector');

    renderFixSightings(myToken);
    renderAvailableSightings(myToken);
    autoPlotFix();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that fix.', true);
  });
}

/**
 * A sighting is "active" (used in the plot and fed into fix resolution) by
 * default -- activeSightingIds only gets materialized the first time
 * someone deselects one, so old fixes (and new ones nobody's touched yet)
 * correctly treat every member as active without needing a migration.
 */
function getActiveSightingIds(fix) {
  return new Set(fix.activeSightingIds || fix.sightingIds);
}

function setSightingActive(fix, id, isActive) {
  var current = fix.activeSightingIds ? fix.activeSightingIds.slice() : fix.sightingIds.slice();
  var idx = current.indexOf(id);
  if (isActive && idx === -1) current.push(id);
  if (!isActive && idx !== -1) current.splice(idx, 1);
  fix.activeSightingIds = current;
}

function sightingRowLabel(record) {
  var title = record.title || SightCalc.formatBodyLabel(record.body);
  var meta = SightCalc.formatBodyLabel(record.body) + ' \u00B7 ' + (record.date || 'no date');
  if (record.results && record.results.observationTime) {
    var d = new Date(record.results.observationTime);
    meta += ' \u00B7 ' + String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + 'z';
  }
  return { title: title, meta: meta };
}

function renderFixSightings(token) {
  var listEl = document.getElementById('fixSightingsList');
  var emptyEl = document.getElementById('fixSightingsEmpty');
  listEl.innerHTML = '';

  if (!currentFix.sightingIds.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  var idsAtRenderTime = currentFix.sightingIds.slice();
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
              '<div class="saved-item-info-row"><span class="sighting-color-dot" style="background:' + swatchColor + '"></span>' +
              '<div class="saved-item-title">(sighting no longer exists)</div></div>' +
            '</div>' +
            '<div class="saved-item-actions"><button class="btn-mini btn-mini-del">Remove</button></div>';
        } else {
          var labels = sightingRowLabel(record);
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
              '<div class="saved-item-info-row"><span class="sighting-color-dot" style="background:' + swatchColor + '"></span>' +
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
          currentFix.sightingIds = currentFix.sightingIds.filter(function (sid) { return sid !== id; });
          if (currentFix.activeSightingIds) {
            currentFix.activeSightingIds = currentFix.activeSightingIds.filter(function (sid) { return sid !== id; });
          }
          if (currentFix.advances) delete currentFix.advances[id]; // don't leave a stale advance pointing at a sighting no longer in this fix
          FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
        });

        listEl.appendChild(item);
      });
    });
}

function renderAvailableSightings(token) {
  var listEl = document.getElementById('availableSightingsList');
  var emptyEl = document.getElementById('availableSightingsEmpty');
  listEl.innerHTML = '';

  SightStorage.list().then(function (entries) {
    if (token !== fixRenderToken) return; // a newer render superseded this one

    var available = entries.filter(function (e) { return currentFix.sightingIds.indexOf(e.id) === -1; });

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
        currentFix.sightingIds.push(entry.id);
        // New members default to active -- only append here if activeSightingIds
        // has already been materialized (an untouched fix's fallback already
        // includes everyone via getActiveSightingIds()).
        if (currentFix.activeSightingIds) currentFix.activeSightingIds.push(entry.id);
        FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
      });

      listEl.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------------
// RUNNING FIX: advancing a sighting's LOP via a saved DR Leg
// ---------------------------------------------------------------------

var _advanceTargetId = null;

/**
 * Opens the shared "Advance via DR Leg" panel for one sighting. Lists every
 * saved DR Leg (not filtered by proximity to this sighting's own time --
 * simplest correct behavior for now: the person can see each leg's own
 * start/end times right in the list and judge for themselves which one
 * applies, rather than the app guessing at a "close enough" heuristic).
 */
function openAdvancePanel(sightingId, sightRecord) {
  _advanceTargetId = sightingId;

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

    document.getElementById('advanceLegTargetLabel').textContent = sightingRowLabel(sightRecord).title;
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

function onClearAdvance(sightingId) {
  if (currentFix.advances) delete currentFix.advances[sightingId];
  FixStorage.save(currentFix).then(function () { openFix(currentFix.id); });
}

function onDeleteFix() {
  if (!currentFix) return;
  if (!confirm('Delete the fix "' + currentFix.name + '"? Its sightings are not affected, only the fix itself.')) return;
  FixStorage.remove(currentFix.id).then(function () {
    showToast('Fix deleted.');
    location.hash = '';
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

/** Plots automatically whenever the fix's sightings change -- called from openFix(). */
/**
 * A Running Fix isn't a different kind of Fix -- it's this same function,
 * given a sighting that has an entry in currentFix.advances. For those,
 * the AP fed into the solver is shifted by the referenced DR Leg
 * (SightCalc.advancePositionByLeg -- see its own comment for why this is
 * ALL a Running Fix needs: Zn/interceptNM stay exactly as observed, only
 * the AP moves, and resolveMultiLopFix already handles a mix of APs across
 * LOPs). The "time" contributed for cacheResolvedPosition's latest-time
 * calc is likewise the leg's endPosition.time, not the sighting's own
 * observation time -- an advanced LOP is being treated as current as of
 * when it was advanced TO, not when it was actually observed.
 */
function autoPlotFix() {
  if (!currentFix || !currentFix.sightingIds.length) {
    document.getElementById('fixChartCard').style.display = 'none';
    setFixPlotStatus('Add at least one sighting to this fix to see its plot.', '');
    return;
  }

  setFixPlotStatus('Loading sightings\u2026', 'loading');

  var advances = currentFix.advances || {};
  var legIdsNeeded = currentFix.sightingIds
    .map(function (id) { return advances[id]; })
    .filter(function (legId) { return !!legId; });

  Promise.all([
    Promise.all(currentFix.sightingIds.map(function (id) { return SightStorage.get(id); })),
    Promise.all(legIdsNeeded.map(function (legId) { return DrLegStorage.get(legId); }))
  ]).then(function (results) {
      var records = results[0];
      var legsById = {};
      legIdsNeeded.forEach(function (legId, i) { legsById[legId] = results[1][i]; });

      var skippedMissing = 0;
      var skippedNoResults = 0;
      var skippedBrokenAdvance = 0;
      var chartInput = [];

      // Color and badge number are keyed to each sighting's position in the
      // FULL fix list (not the filtered/plottable subset), so a sighting's
      // color always matches its swatch in the "Sightings in this Fix" list
      // above -- even when an earlier sighting gets skipped from the plot.
      records.forEach(function (record, i) {
        if (!record) { skippedMissing++; return; }
        if (!record.results || typeof record.results.zn !== 'number' || typeof record.results.interceptNM !== 'number') {
          skippedNoResults++;
          return;
        }
        var id = currentFix.sightingIds[i];
        var pos = SightCalc.signedPositionFromRecord(record.position);
        var observationTime = record.results.observationTime;

        var legId = advances[id];
        if (legId) {
          var leg = legsById[legId];
          if (!leg) {
            // The referenced leg was deleted out from under this advance --
            // fail safe to the as-observed LOP rather than silently
            // dropping the sighting or crashing the plot; renderFixSightings()
            // surfaces this same brokenness so it's not silent.
            skippedBrokenAdvance++;
          } else {
            var advanced = SightCalc.advancePositionByLeg(pos.lat, pos.lon, leg);
            pos = advanced;
            observationTime = leg.endPosition.time;
          }
        }

        var labels = sightingRowLabel(record);
        chartInput.push({
          id: id,
          lat: pos.lat,
          lon: pos.lon,
          zn: record.results.zn,
          interceptNM: record.results.interceptNM,
          observationTime: observationTime, // ISO UTC -- used to timestamp the Fix's cached resolvedPosition
          tzOffset: record.position.tzOffset, // carried alongside, for handoffs built from the resolved position (see onFixToSighting/onFixToDrLeg)
          label: labels.title,
          color: SightCalc.paletteColor(i),
          badgeNumber: i + 1
        });
      });

      if (!chartInput.length) {
        document.getElementById('fixChartCard').style.display = 'none';
        setFixPlotStatus('None of this fix\u2019s sightings have calculated results to plot. Recalculate and re-save them on the Sight Reduction page.', 'error');
        return;
      }

      lastChartInput = chartInput;

      document.getElementById('fixChartCard').style.display = 'block';
      renderCurrentPlot();

      var msg = 'Plotted ' + chartInput.length + ' of ' + currentFix.sightingIds.length + ' sighting' + (currentFix.sightingIds.length === 1 ? '' : 's') + '.';
      var skipped = skippedMissing + skippedNoResults;
      if (skipped) {
        msg += ' Skipped ' + skipped + ' (missing or not yet calculated).';
      }
      if (skippedBrokenAdvance) {
        msg += ' ' + skippedBrokenAdvance + ' advanced sighting' + (skippedBrokenAdvance === 1 ? '' : 's') + ' fell back to as-observed (the DR Leg it referenced no longer exists).';
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
 * sightings, matching the usual convention that a fix's time is the time of
 * its most recent constituent sight. sourceId is stamped as this Fix's own
 * id right away (unlike a DR Leg's live endPosition, a Fix always has a
 * stable id already -- FixStorage.save() assigns one the moment the fix is
 * first created, before any sightings are even added), so anything that
 * later copies this position elsewhere (a new Sight's AP, a DR Leg's start)
 * can say which Fix it came from. tzOffset/method are tracked alongside,
 * not inside the Position itself (Position is intentionally tz- and
 * method-agnostic), so the handoffs below can reconstruct a local
 * date/time and the Save button can report which method was used.
 */
function cacheResolvedPosition(fixResult, activeSightings) {
  document.getElementById('fixPositionCard').style.display = activeSightings.length ? 'block' : 'none';

  if (!fixResult.solvable || typeof fixResult.lat !== 'number' || typeof fixResult.lon !== 'number') {
    currentFix.resolvedPosition = null;
    updateFixPositionButtons();
    return;
  }

  var latest = null;
  activeSightings.forEach(function (s) {
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
  document.getElementById('btnFixToSighting').disabled = !ready;
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

function onFixToSighting() {
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
 * sighting (so a deselected one can be switched back on); only the ones in
 * the active set are actually fed into the chart and the fix resolution.
 */
function renderCurrentPlot() {
  if (!lastChartInput) return;

  var activeSet = getActiveSightingIds(currentFix);
  var plotInput = lastChartInput.filter(function (item) { return activeSet.has(item.id); });

  var methodBisectorsBtn = document.getElementById('methodBisectors');
  methodBisectorsBtn.disabled = plotInput.length < 3;
  if (methodBisectorsBtn.disabled && bisectorMethodSelected) setFixMethodState(false);

  var opts = {
    showAzimuth: document.getElementById('toggleShowAzimuth').checked,
    showBisectors: bisectorMethodSelected
  };

  var container = document.getElementById('fixChartContainer');
  var result = SightChart.renderMultiSightChart(container, plotInput, opts);
  cacheResolvedPosition(result.fix, plotInput);

  var legendEl = document.getElementById('fixChartLegend');
  legendEl.innerHTML = '';

  lastChartInput.forEach(function (item) {
    var isActive = activeSet.has(item.id);
    var row = document.createElement('label');
    row.className = 'chart-legend-item chart-legend-toggle';
    row.innerHTML =
      '<input type="checkbox"' + (isActive ? ' checked' : '') + '>' +
      '<span class="chart-swatch" style="border-top-color: ' + item.color + '; border-top-style: solid;"></span> ' +
      item.badgeNumber + '. ' + item.label + ' \u2014 Zn ' + formatZnBadge(item.zn) + ' (' + formatInterceptBadge(item.interceptNM) + ')';

    row.querySelector('input').addEventListener('change', function (e) {
      setSightingActive(currentFix, item.id, e.target.checked);
      FixStorage.save(currentFix).then(renderCurrentPlot);
    });

    legendEl.appendChild(row);
  });

  renderFixResult(result.fix, plotInput.length, legendEl);
}

function fixIconSvg() {
  return '<svg width="16" height="16" viewBox="0 0 16 16" class="fix-icon" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="5" fill="none" stroke="var(--chart-fix)" stroke-width="2"/>' +
    '<line x1="1" y1="8" x2="15" y2="8" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
    '<line x1="8" y1="1" x2="8" y2="15" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
  '</svg>';
}

function renderFixResult(fix, sightingCount, legendEl) {
  var caption = document.getElementById('fixResultCaption');
  caption.textContent = '';

  if (!fix.solvable) {
    setFixResultStatus('Fix: ' + fix.reason, 'error');
    return;
  }
  setFixResultStatus('', '');

  // Least-squares uses every checked/active sighting; the bisector method
  // can only use exactly 3, auto-picked for widest azimuth spread when more
  // than 3 are active (see the caption below). Naming the count here makes
  // that difference visible instead of implied -- unchecking a sighting that
  // ISN'T one of the bisector triple still changes the least-squares answer,
  // because it was never excluded from that one to begin with.
  var methodLabel = fix.source === 'bisector' ? 'method of bisectors' : 'least-squares';
  var scopeNote = fix.source === 'bisector'
    ? ' (3 of ' + sightingCount + ' active)'
    : ' (' + sightingCount + ' active sighting' + (sightingCount === 1 ? '' : 's') + ')';
  var item = document.createElement('div');
  item.className = 'chart-legend-item fix-legend-item';
  item.innerHTML = fixIconSvg() + ' Fix (' + methodLabel + scopeNote + '): ' + fix.positionText;
  legendEl.appendChild(item);

  // Shown whenever a 3-LOP triangle exists, regardless of which method is
  // currently displayed -- it's useful fix-quality context either way. But
  // it describes ONLY the bisector triangle, so it's worded to never look
  // like a statement about which sightings the (possibly different)
  // currently-shown Fix number is based on.
  if (typeof fix.bisectorMaxSideNM === 'number') {
    var note = 'Bisector triangle (cocked hat) spread: ' + fix.bisectorMaxSideNM.toFixed(1) + ' nm';
    if (fix.bisectorBadgeNumbers && fix.bisectorBadgeNumbers.length === 3 && sightingCount > 3) {
      note += ', using sightings #' + fix.bisectorBadgeNumbers.join(', #') + ' (widest azimuth spread)';
    }
    caption.textContent = note;
  }
}
