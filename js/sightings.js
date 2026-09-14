/**
 * sightings.js
 * Standalone "Saved Sightings (this device)" browser -- the list that used to
 * render at the bottom of index.html now lives on its own page. Reads/writes
 * go straight through storage.js (window.SightStorage); this file only
 * touches the DOM.
 *
 * "Load" can't apply a record directly (this page has no sight reduction
 * form), so it hands the record id off via sessionStorage and navigates to
 * index.html, which consumes it in applyPendingSightingLoad() (see app.js).
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

function onLoadSighting(entryId) {
  try {
    sessionStorage.setItem('ocsrLoadSightingId', entryId);
  } catch (e) {
    showToast('Could not hand off to New Sighting (storage unavailable).', true);
    return;
  }
  location.href = 'index.html';
}

function onDeleteSighting(entryId) {
  if (!confirm('Delete this saved sight? This cannot be undone.')) return;
  SightStorage.remove(entryId).then(function () {
    showToast('Deleted.');
    refreshSavedList();
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
          '<button class="btn-mini btn-mini-del">Delete</button>' +
        '</div>';

      item.querySelector('.saved-item-title').textContent = title;
      item.querySelector('.saved-item-meta').textContent = meta;
      item.querySelector('.btn-mini-load').addEventListener('click', function () { onLoadSighting(entry.id); });
      item.querySelector('.btn-mini-del').addEventListener('click', function () { onDeleteSighting(entry.id); });

      listEl.appendChild(item);
    });
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load saved sightings.', true);
  });
}
