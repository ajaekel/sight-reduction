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

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('btnNewFix').addEventListener('click', onNewFixClick);
  document.getElementById('btnBackToList').addEventListener('click', function () {
    location.hash = '';
  });
  document.getElementById('btnDeleteFix').addEventListener('click', onDeleteFix);
  document.getElementById('btnPlotFix').addEventListener('click', onPlotFix);
  document.getElementById('toggleAzimuth').addEventListener('change', applyChartToggleClasses);
  document.getElementById('toggleBisectors').addEventListener('change', applyChartToggleClasses);

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

    renderFixSightings(myToken);
    renderAvailableSightings(myToken);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that fix.', true);
  });
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

/** Toggles the azimuth/bisector line groups' visibility via CSS classes -- no re-render needed. */
function applyChartToggleClasses() {
  var container = document.getElementById('fixChartContainer');
  container.classList.toggle('hide-azimuth', !document.getElementById('toggleAzimuth').checked);
  container.classList.toggle('hide-bisectors', !document.getElementById('toggleBisectors').checked);
}

function onPlotFix() {
  if (!currentFix || !currentFix.sightingIds.length) {
    setFixPlotStatus('Add at least one sighting to this fix first.', 'error');
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
        setFixPlotStatus('None of this fix\u2019s sightings have calculated results to plot. Recalculate and re-save them on the Sight Reduction page.', 'error');
        return;
      }

      var container = document.getElementById('fixChartContainer');
      var result = SightChart.renderMultiSightChart(container, chartInput);
      applyChartToggleClasses();

      var legendEl = document.getElementById('fixChartLegend');
      legendEl.innerHTML = '';
      result.legend.forEach(function (entry) {
        var item = document.createElement('div');
        item.className = 'chart-legend-item';
        item.innerHTML =
          '<span class="chart-swatch" style="border-top-color: ' + entry.color + '; border-top-style: solid;"></span> ' +
          entry.index + '. ' + entry.label + ' \u2014 Zn ' + entry.znText + ' (' + entry.interceptText + ')';
        legendEl.appendChild(item);
      });

      document.getElementById('fixChartCard').style.display = 'block';

      var msg = 'Plotted ' + chartInput.length + ' of ' + currentFix.sightingIds.length + ' sighting' + (currentFix.sightingIds.length === 1 ? '' : 's') +
                ' (grid edge = ' + result.scaleNM + ' nm' +
                (result.bisectorCount ? ', ' + result.bisectorCount + ' bisector line' + (result.bisectorCount === 1 ? '' : 's') : '') +
                ').';
      if (skippedMissing || skippedNoResults) {
        msg += ' Skipped ' + (skippedMissing + skippedNoResults) + ' (missing or not yet calculated).';
      }
      setFixPlotStatus(msg, (skippedMissing || skippedNoResults) ? 'error' : 'ok');
    })
    .catch(function (err) {
      console.error(err);
      setFixPlotStatus('Could not plot this fix.', 'error');
    });
}
