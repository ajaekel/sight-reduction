/**
 * fixApp.js
 * DOM/event layer for fixes.html, mirroring app.js's style: plain objects in
 * and out of FixStorage/SightStorage, DOM only touched here.
 *
 * A Fix = { id, name, createdAt, sightingIds: [...] }. This file never
 * duplicates sighting data into the fix -- it always looks sightings up by
 * id via SightStorage when it needs to render or plot them.
 */

var APP_VERSION = 'v1.9';
var currentFixId = null;

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;

  if (window.SightStorage && SightStorage.requestPersistence) {
    SightStorage.requestPersistence();
  }

  document.getElementById('btnNewFix').addEventListener('click', onNewFix);
  document.getElementById('btnRenameFix').addEventListener('click', onRenameFix);
  document.getElementById('btnCloseEditor').addEventListener('click', closeEditor);
  document.getElementById('btnPlotFix').addEventListener('click', onPlotFix);

  refreshFixList();
});

// ---------------------------------------------------------------------
// Small pure helpers (deliberately duplicated in miniature from app.js /
// calc.js rather than sharing a script this page has no other use for).
// ---------------------------------------------------------------------

function formatBodyLabel(body) {
  if (!body) return 'Body';
  if (body.type === 'star' || body.type === 'planet') {
    return body.name ? (body.type.charAt(0).toUpperCase() + body.type.slice(1) + ' ' + body.name) : body.type;
  }
  return body.type.charAt(0).toUpperCase() + body.type.slice(1);
}

function sightingTitle(record) {
  return record.label || (formatBodyLabel(record.body) + ' \u2014 ' + (record.date || ''));
}

/** Signed decimal {lat, lon} (N/E positive) from a stored sighting's position block. */
function signedPosition(position) {
  return {
    lat: SightCalc.signedDecimalFromDM(position.latDeg, position.latMin, position.latNS),
    lon: SightCalc.signedDecimalFromDM(position.lonDeg, position.lonMin, position.lonEW)
  };
}

function showToast(message, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

// ---------------------------------------------------------------------
// Fix list
// ---------------------------------------------------------------------

function onNewFix() {
  var suggested = 'Fix - ' + new Date().toLocaleDateString();
  var name = prompt('Name this fix:', suggested);
  if (name === null) return; // cancelled

  FixStorage.save({ name: name.trim() || suggested, sightingIds: [] }).then(function (fix) {
    refreshFixList();
    openFixEditor(fix.id);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not create fix (storage may be full or unavailable).', true);
  });
}

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

      var meta = entry.count + (entry.count === 1 ? ' sighting' : ' sightings') +
                 ' \u00B7 created ' + new Date(entry.createdAt).toLocaleString();

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
      item.querySelector('.saved-item-meta').textContent = meta;

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        openFixEditor(entry.id);
      });

      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        if (!confirm('Delete fix "' + entry.name + '"? The sightings themselves are not affected.')) return;
        FixStorage.remove(entry.id).then(function () {
          if (currentFixId === entry.id) closeEditor();
          showToast('Deleted.');
          refreshFixList();
        });
      });

      listEl.appendChild(item);
    });
  }).catch(function (err) {
    console.error(err);
  });
}

// ---------------------------------------------------------------------
// Fix editor
// ---------------------------------------------------------------------

function openFixEditor(id) {
  FixStorage.get(id).then(function (fix) {
    if (!fix) { showToast('Could not find that fix.', true); return; }
    currentFixId = fix.id;
    document.getElementById('fixEditorTitle').textContent = fix.name;
    document.getElementById('fixEditorCard').style.display = 'block';
    document.getElementById('fixChartCard').style.display = 'none';
    renderFixEditorLists(fix);
    document.getElementById('fixEditorCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function closeEditor() {
  currentFixId = null;
  document.getElementById('fixEditorCard').style.display = 'none';
  document.getElementById('fixChartCard').style.display = 'none';
}

function onRenameFix() {
  if (!currentFixId) return;
  FixStorage.get(currentFixId).then(function (fix) {
    var name = prompt('Rename this fix:', fix.name);
    if (name === null) return;
    fix.name = name.trim() || fix.name;
    FixStorage.save(fix).then(function () {
      document.getElementById('fixEditorTitle').textContent = fix.name;
      refreshFixList();
    });
  });
}

/** Re-render both lists in the editor from the fix's current sightingIds. */
function renderFixEditorLists(fix) {
  SightStorage.list().then(function (allEntries) {
    var byId = {};
    allEntries.forEach(function (e) { byId[e.id] = e; });

    renderFixSightingList(fix, byId);
    renderAvailableSightingList(fix, allEntries);
  });
}

function renderFixSightingList(fix, byId) {
  var listEl = document.getElementById('fixSightingList');
  var emptyEl = document.getElementById('fixSightingListEmpty');
  listEl.innerHTML = '';

  if (!fix.sightingIds.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  fix.sightingIds.forEach(function (sightingId, index) {
    var entry = byId[sightingId];
    var item = document.createElement('div');
    item.className = 'saved-item';

    var swatch = '<span class="fix-legend-swatch" style="background:' + FixStorage.colorForIndex(index) + '"></span>';

    if (!entry) {
      // Referenced but no longer present (e.g. removed outside the normal
      // delete-block flow) -- still removable, just nothing else to show.
      item.innerHTML =
        '<div class="saved-item-info">' + swatch +
          '<span class="saved-item-title">Missing sighting (removed)</span>' +
        '</div>' +
        '<div class="saved-item-actions"><button class="btn-mini btn-mini-del">Remove</button></div>';
    } else {
      var meta = entry.bodyLabel + ' \u2014 ' + (entry.date || 'no date');
      item.innerHTML =
        '<div class="saved-item-info">' +
          '<div class="saved-item-title">' + swatch + '</div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' +
        '<div class="saved-item-actions"><button class="btn-mini btn-mini-del">Remove</button></div>';
      item.querySelector('.saved-item-title').appendChild(document.createTextNode(entry.label ? entry.label : (entry.bodyLabel + ' \u2014 ' + (entry.date || ''))));
      item.querySelector('.saved-item-meta').textContent = meta;
    }

    item.querySelector('.btn-mini-del').addEventListener('click', function () {
      fix.sightingIds.splice(fix.sightingIds.indexOf(sightingId), 1);
      FixStorage.save(fix).then(function () {
        refreshFixList();
        renderFixEditorLists(fix);
        document.getElementById('fixChartCard').style.display = 'none';
      });
    });

    listEl.appendChild(item);
  });
}

function renderAvailableSightingList(fix, allEntries) {
  var listEl = document.getElementById('availableSightingList');
  var emptyEl = document.getElementById('availableSightingListEmpty');
  listEl.innerHTML = '';

  var available = allEntries.filter(function (e) { return fix.sightingIds.indexOf(e.id) === -1; });

  if (!available.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  available.forEach(function (entry) {
    var item = document.createElement('div');
    item.className = 'saved-item';

    var title = entry.label ? entry.label : (entry.bodyLabel + ' \u2014 ' + (entry.date || ''));
    var meta = entry.bodyLabel + ' \u2014 ' + (entry.date || 'no date');

    item.innerHTML =
      '<div class="saved-item-info">' +
        '<div class="saved-item-title"></div>' +
        '<div class="saved-item-meta"></div>' +
      '</div>' +
      '<div class="saved-item-actions"><button class="btn-mini btn-mini-load">Add</button></div>';

    item.querySelector('.saved-item-title').textContent = title;
    item.querySelector('.saved-item-meta').textContent = meta;

    item.querySelector('.btn-mini-load').addEventListener('click', function () {
      fix.sightingIds.push(entry.id);
      FixStorage.save(fix).then(function () {
        refreshFixList();
        renderFixEditorLists(fix);
      });
    });

    listEl.appendChild(item);
  });
}

// ---------------------------------------------------------------------
// Plot
// ---------------------------------------------------------------------

function onPlotFix() {
  if (!currentFixId) return;

  FixStorage.get(currentFixId).then(function (fix) {
    if (!fix.sightingIds.length) {
      showToast('Add at least one sighting to this fix first.', true);
      return;
    }

    Promise.all(fix.sightingIds.map(function (id) { return SightStorage.get(id); })).then(function (records) {
      // Keep original fix-order indices for stable per-sighting colors, even
      // though we filter down to only the plottable ones below.
      var usable = [];
      var skipped = 0;

      records.forEach(function (record, index) {
        var hasResult = record && record.results &&
          typeof record.results.zn === 'number' && typeof record.results.interceptNM === 'number';
        if (hasResult) {
          usable.push({ record: record, colorIndex: index });
        } else {
          skipped++;
        }
      });

      if (!usable.length) {
        showToast('None of the sightings in this fix have a calculated result yet.', true);
        return;
      }

      // Reference AP: the earliest-observed usable sighting. Every other
      // sighting's AP is translated relative to this one (see
      // SightCalc.nmOffsetFromRef) so all the LOPs land on one shared plot.
      var byTime = usable.slice().sort(function (a, b) {
        var ta = a.record.results.observationTime || '';
        var tb = b.record.results.observationTime || '';
        return ta < tb ? -1 : (ta > tb ? 1 : 0);
      });
      var refPos = signedPosition(byTime[0].record.position);

      var items = usable.map(function (u) {
        var pos = signedPosition(u.record.position);
        return {
          color: FixStorage.colorForIndex(u.colorIndex),
          label: sightingTitle(u.record),
          zn: u.record.results.zn,
          interceptNM: u.record.results.interceptNM,
          offset: SightCalc.nmOffsetFromRef(refPos.lat, refPos.lon, pos.lat, pos.lon)
        };
      });

      var chartCard = document.getElementById('fixChartCard');
      chartCard.style.display = 'block';
      SightChart.renderFixChart(document.getElementById('fixChartContainer'), items);

      var caption = usable.length + ' of ' + fix.sightingIds.length + ' sighting(s) plotted, positioned relative to "' +
        sightingTitle(byTime[0].record) + '"\u2019s AP.';
      if (skipped) caption += ' ' + skipped + ' skipped (no calculated result saved for ' + (skipped === 1 ? 'it' : 'them') + ' yet).';
      document.getElementById('fixChartCaption').textContent = caption;

      chartCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}
