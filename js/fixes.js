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

    document.getElementById('fixDetailName').textContent = fix.name;
    document.getElementById('fixDetailMeta').textContent =
      fix.sightingIds.length + ' sighting' + (fix.sightingIds.length === 1 ? '' : 's') +
      ' \u00B7 saved ' + new Date(fix.savedAt).toLocaleString();

    document.getElementById('fixChartCard').style.display = 'none';
    document.getElementById('fixPlotStatus').textContent = '';
    lastChartInput = null;
    setFixMethodState(false); // fresh fix: always start on least-squares

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
  var title = record.label || SightCalc.formatBodyLabel(record.body);
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

  Promise.all(idsAtRenderTime.map(function (id) { return SightStorage.get(id); }))
    .then(function (records) {
      if (token !== fixRenderToken) return; // a newer render superseded this one
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
          item.innerHTML =
            '<div class="saved-item-info">' +
              '<div class="saved-item-info-row"><span class="sighting-color-dot" style="background:' + swatchColor + '"></span>' +
              '<div><div class="saved-item-title"></div><div class="saved-item-meta"></div></div></div>' +
            '</div>' +
            '<div class="saved-item-actions"><button class="btn-mini btn-mini-del">Remove</button></div>';
          item.querySelector('.saved-item-title').textContent = labels.title;
          item.querySelector('.saved-item-meta').textContent = labels.meta;
        }

        item.querySelector('.btn-mini-del').addEventListener('click', function () {
          currentFix.sightingIds = currentFix.sightingIds.filter(function (sid) { return sid !== id; });
          if (currentFix.activeSightingIds) {
            currentFix.activeSightingIds = currentFix.activeSightingIds.filter(function (sid) { return sid !== id; });
          }
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

      item.querySelector('.saved-item-title').textContent = entry.label || entry.bodyLabel;
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
function autoPlotFix() {
  if (!currentFix || !currentFix.sightingIds.length) {
    document.getElementById('fixChartCard').style.display = 'none';
    setFixPlotStatus('Add at least one sighting to this fix to see its plot.', '');
    return;
  }

  setFixPlotStatus('Loading sightings\u2026', 'loading');

  Promise.all(currentFix.sightingIds.map(function (id) { return SightStorage.get(id); }))
    .then(function (records) {
      var skippedMissing = 0;
      var skippedNoResults = 0;
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
        var pos = SightCalc.signedPositionFromRecord(record.position);
        var labels = sightingRowLabel(record);
        chartInput.push({
          id: currentFix.sightingIds[i],
          lat: pos.lat,
          lon: pos.lon,
          zn: record.results.zn,
          interceptNM: record.results.interceptNM,
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
      if (skippedMissing || skippedNoResults) {
        msg += ' Skipped ' + (skippedMissing + skippedNoResults) + ' (missing or not yet calculated).';
      }
      setFixPlotStatus(msg, (skippedMissing || skippedNoResults) ? 'error' : 'ok');
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
