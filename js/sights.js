/**
 * sights.js
 * Standalone "Saved Sights (this device)" browser -- the list that used to
 * render at the bottom of index.html now lives on its own page. Reads/writes
 * go straight through storage.js (window.SightStorage); this file only
 * touches the DOM.
 *
 * "Load" can't apply a record directly (this page has no sight reduction
 * form), so it hands the record id off via sessionStorage and navigates to
 * index.html, which consumes it in applyPendingSightLoad() (see app.js).
 * "Delete" is fully local to this page -- no handoff needed.
 */

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();
  refreshSavedList();

  document.getElementById('btnImport').addEventListener('click', function () {
    document.getElementById('fileImportJson').click();
  });
  document.getElementById('fileImportJson').addEventListener('change', onImportJson);
  document.getElementById('addToFixSelect').addEventListener('change', updateAddToFixPanel);
  document.getElementById('btnConfirmAddToFix').addEventListener('click', onConfirmAddToFix);
  document.getElementById('btnCancelAddToFix').addEventListener('click', closeAddToFixPanel);
});

/**
 * Imports a previously-exported JSON file straight into device storage --
 * this page has no sight-reduction form to load it into, so unlike index.html's
 * import (which fills the form for further editing), this one saves it right
 * away and refreshes the list. Always saved as a NEW record (any id in the
 * file itself is dropped first): re-importing a file that happens to still
 * carry an old id from this same device shouldn't silently overwrite
 * whatever's already saved under that id.
 */
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
      parsed.id = null;
      // title is storage metadata (attached only at SightStorage.save()
      // time), never part of a Sight's own data -- a JSON export can't
      // carry one, so every import needs it computed fresh, always, not
      // just when a title "happens" to be missing (see SightCalc.computeAutoName).
      // This path saves straight to storage with no naming prompt, unlike
      // the New Sight page's Save button, so it's set automatically here.
      parsed.title = SightCalc.computeAutoName(parsed);
      SightStorage.save(parsed).then(function () {
        showToast('Imported sight from ' + file.name);
        refreshSavedList();
      }).catch(function (err) {
        console.error(err);
        showToast('Could not save the imported sight.', true);
      });
    } catch (err) {
      console.error(err);
      showToast('Could not import file: not a valid sight JSON.', true);
    } finally {
      evt.target.value = '';
    }
  };
  reader.onerror = function () {
    showToast('Could not read that file.', true);
    evt.target.value = '';
  };
  reader.readAsText(file);
}

function showToast(msg, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

function onLoadSight(entryId) {
  try {
    sessionStorage.setItem('ocsrLoadSightId', entryId);
  } catch (e) {
    showToast('Could not hand off to New Sight (storage unavailable).', true);
    return;
  }
  location.href = 'index.html';
}

function onDeleteSight(entryId) {
  if (!confirm('Delete this saved sight? This cannot be undone.')) return;
  SightStorage.remove(entryId).then(function () {
    showToast('Deleted.');
    refreshSavedList();
  });
}

/**
 * Sends a saved sight's own position and observation time to DR Leg as its
 * start -- see app.js's onSendToDrLeg for the full reasoning (same
 * function, just working from a saved record's id here instead of the
 * live form on index.html).
 */
function onSendToDrLeg(sightId) {
  SightStorage.get(sightId).then(function (record) {
    if (!record || !record.results || !record.results.observationTime) {
      showToast('This sight has no calculated observation time yet.', true);
      return;
    }
    var pos = SightCalc.signedPositionFromRecord(record.position);
    var position = SightCalc.makePosition(record.results.observationTime, pos.lat, pos.lon, SightCalc.POSITION_SOURCE_TYPES.KNOWN, record.id);
    sessionStorage.setItem('ocsrDrLegStartHandoff', JSON.stringify({ position: position, tzOffset: record.position.tzOffset, sentFrom: 'Sight' }));
    location.href = 'drleg.html';
  }).catch(function (err) {
    console.error(err);
    showToast('Could not send this sight to DR Leg.', true);
  });
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

      var title = entry.title ? entry.title : (entry.bodyLabel + ' \u2014 ' + (entry.date || ''));
      var meta = entry.bodyLabel + ' \u2014 ' + (entry.date || 'no date') +
                 ' \u00B7 saved ' + new Date(entry.savedAt).toLocaleString();

      item.innerHTML =
        '<div class="saved-item-info">' +
          '<div class="saved-item-title"></div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' +
        '<div class="saved-item-actions">' +
          '<button class="btn-mini btn-mini-load">Load</button>' +
          '<button class="btn-mini btn-mini-fix">Add to Fix</button>' +
          '<button class="btn-mini btn-mini-drleg">Send to DR Leg</button>' +
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = title;
      item.querySelector('.saved-item-meta').textContent = meta;
      item.querySelector('.btn-mini-load').addEventListener('click', function () { onLoadSight(entry.id); });
      item.querySelector('.btn-mini-fix').addEventListener('click', function () { openAddToFixPanel(entry.id); });
      item.querySelector('.btn-mini-drleg').addEventListener('click', function () { onSendToDrLeg(entry.id); });
      item.querySelector('.btn-mini-del').addEventListener('click', function () { onDeleteSight(entry.id); });

      listEl.appendChild(item);
    });
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load saved sights.', true);
  });
}

/**
 * "Add to a Fix" for a specific saved sight (per-row, this page). Same
 * shared inline-panel pattern as index.html's version (see app.js), just
 * tracking WHICH sight the panel currently targets, since this page
 * lists many.
 */
var _addToFixTargetId = null;

function openAddToFixPanel(sightId) {
  _addToFixTargetId = sightId;

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
  _addToFixTargetId = null;
}

function onConfirmAddToFix() {
  var select = document.getElementById('addToFixSelect');
  var sightId = _addToFixTargetId;
  if (!sightId) { closeAddToFixPanel(); return; }

  var fixPromise;
  if (select.value === '__new__') {
    var name = document.getElementById('newFixNameInput').value.trim() || 'Untitled Fix';
    fixPromise = FixStorage.save({ name: name, sightIds: [] });
  } else {
    fixPromise = FixStorage.get(select.value);
  }

  fixPromise.then(function (fix) {
    if (!fix) throw new Error('Fix not found');
    if (fix.sightIds.indexOf(sightId) === -1) fix.sightIds.push(sightId);
    if (fix.activeSightIds && fix.activeSightIds.indexOf(sightId) === -1) fix.activeSightIds.push(sightId);
    return FixStorage.save(fix);
  }).then(function (fix) {
    showToast('Added to "' + fix.name + '".');
    closeAddToFixPanel();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not add to that fix.', true);
  });
}
