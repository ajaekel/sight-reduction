/**
 * passages.js
 * The minimum viable Passage UI: list, create, and a detail view showing
 * the derived timeline plus membership actions (assign/remove existing
 * Sight/Fix/DR Leg records). Deliberately thin -- this file resolves and
 * renders what PassageStorage/SightStorage/FixStorage/DrLegStorage already
 * compute; it doesn't maintain any membership or ordering of its own.
 *
 * Same hash-routing pattern as fixes.html/fixes.js (list vs. detail view
 * toggled by location.hash), extended with one more route for the
 * create-passage form: no hash = list, '#new' = create form,
 * '#passage=<id>' = detail.
 */

var currentPassage = null;
var passageRenderToken = 0;

function passageIdFromHash() {
  var m = /^#passage=(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function routeFromHash() {
  var id = passageIdFromHash();
  if (location.hash === '#new') {
    showNewView();
  } else if (id) {
    openPassage(id);
  } else {
    showListView();
  }
}

function showListView() {
  currentPassage = null;
  document.getElementById('passageListView').style.display = 'block';
  document.getElementById('passageNewView').style.display = 'none';
  document.getElementById('passageDetailView').style.display = 'none';
  refreshPassageList();
}

function showNewView() {
  currentPassage = null;
  document.getElementById('passageListView').style.display = 'none';
  document.getElementById('passageNewView').style.display = 'block';
  document.getElementById('passageDetailView').style.display = 'none';
}

function showDetailView() {
  document.getElementById('passageListView').style.display = 'none';
  document.getElementById('passageNewView').style.display = 'none';
  document.getElementById('passageDetailView').style.display = 'block';
}

function showToast(msg, isError) {
  var toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.toggle('error', !!isError);
  toast.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(function () { toast.classList.remove('show'); }, 2200);
}

// ---------------------------------------------------------------------
// LIST VIEW
// ---------------------------------------------------------------------

/** "9/14/2026, 2:00 PM" style, or '--' if null -- used for startedAt/endedAt, which are ISO UTC strings. */
function formatDateTimeOrDash(iso) {
  if (!iso) return '--';
  return new Date(iso).toLocaleString();
}

function refreshPassageList() {
  PassageStorage.list().then(function (entries) {
    var listEl = document.getElementById('passageList');
    var emptyEl = document.getElementById('passageListEmpty');
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    // Record counts aren't cached on the passage record (membership is
    // always a query, never stored -- see passageStorage.js), so this asks
    // for each passage's own records to count them. Fine at the scale a
    // personal logbook actually reaches.
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
        formatDateTimeOrDash(entry.startedAt) + ' \u2192 ' + formatDateTimeOrDash(entry.endedAt) + ' \u00B7 counting records\u2026';

      PassageStorage.getPassageRecords(entry.id).then(function (records) {
        var count = records.sights.length + records.fixes.length + records.drLegs.length;
        item.querySelector('.saved-item-meta').textContent =
          formatDateTimeOrDash(entry.startedAt) + ' \u2192 ' + formatDateTimeOrDash(entry.endedAt) +
          ' \u00B7 ' + count + ' record' + (count === 1 ? '' : 's');
      });

      item.querySelector('.btn-mini-load').addEventListener('click', function () {
        location.hash = 'passage=' + encodeURIComponent(entry.id);
      });
      item.querySelector('.btn-mini-del').addEventListener('click', function () {
        onDeletePassageFromList(entry.id, entry.name);
      });

      listEl.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------

/** Digit-only filtering and auto-advance -- same small helper as drleg.js/planning.js, kept page-local rather than shared (matches this codebase's existing convention). */
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

function onCreatePassage() {
  var name = document.getElementById('newPassageName').value.trim() || 'Untitled Passage';
  var notes = document.getElementById('newPassageNotes').value.trim();

  var latDegVal = document.getElementById('newPassageLatDeg').value;
  var lonDegVal = document.getElementById('newPassageLonDeg').value;
  var startingPosition = null;

  if (latDegVal !== '' || lonDegVal !== '') {
    var dateVal = document.getElementById('newPassageDate').value;
    if (!dateVal) {
      showToast('Enter a starting date, or clear the position fields to leave it unset.', true);
      return;
    }
    var latDeg = parseFloat(latDegVal), lonDeg = parseFloat(lonDegVal);
    if (isNaN(latDeg) || isNaN(lonDeg)) {
      showToast('Enter both latitude and longitude, or clear both to leave the position unset.', true);
      return;
    }
    var pos = SightCalc.signedPositionFromRecord({
      latDeg: latDeg,
      latMin: parseFloat(document.getElementById('newPassageLatMin').value) || 0,
      latNS: document.getElementById('newPassageLatNS').value,
      lonDeg: lonDeg,
      lonMin: parseFloat(document.getElementById('newPassageLonMin').value) || 0,
      lonEW: document.getElementById('newPassageLonEW').value
    });
    var tzOffset = parseFloat(document.getElementById('newPassageTz').value) || 0;
    var h = parseInt(document.getElementById('newPassageTimeH').value, 10) || 0;
    var m = parseInt(document.getElementById('newPassageTimeM').value, 10) || 0;
    var utcMs = SightCalc.localDateTimeToUtcMs(dateVal, h * 3600 + m * 60, tzOffset);
    startingPosition = SightCalc.makePosition(new Date(utcMs).toISOString(), pos.lat, pos.lon, SightCalc.POSITION_SOURCE_TYPES.KNOWN, null);
  }

  PassageStorage.save({ name: name, notes: notes, startingPosition: startingPosition, startedAt: null, endedAt: null }).then(function (saved) {
    return startingPosition ? PassageStorage.refreshDates(saved.id).then(function () { return saved; }) : saved;
  }).then(function (saved) {
    showToast('Created "' + saved.name + '".');
    location.hash = 'passage=' + encodeURIComponent(saved.id);
  }).catch(function (err) {
    console.error(err);
    showToast('Could not create passage (storage may be full or unavailable).', true);
  });
}

// ---------------------------------------------------------------------
// DETAIL VIEW
// ---------------------------------------------------------------------

function openPassage(id) {
  var myToken = ++passageRenderToken;
  PassageStorage.get(id).then(function (passage) {
    if (myToken !== passageRenderToken) return; // superseded by a newer openPassage() call
    if (!passage) {
      showToast('That passage could not be found.', true);
      location.hash = '';
      return;
    }
    currentPassage = passage;
    showDetailView();
    renderPassageDetailHeader();
    refreshPassageTimeline();
    refreshAvailableRecords();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not load that passage.', true);
  });
}

function renderPassageDetailHeader() {
  var p = currentPassage;
  document.getElementById('passageDetailName').textContent = p.name;
  document.getElementById('passageDetailMeta').textContent =
    formatDateTimeOrDash(p.startedAt) + ' \u2192 ' + formatDateTimeOrDash(p.endedAt) +
    ' \u00B7 created ' + new Date(p.createdAt).toLocaleString();
  document.getElementById('passageDetailNotes').textContent = p.notes || '';

  var posEl = document.getElementById('passageStartingPosition');
  if (p.startingPosition) {
    posEl.textContent = SightCalc.formatLat(p.startingPosition.lat) + ', ' + SightCalc.formatLon(p.startingPosition.lon) +
      ' \u00B7 ' + new Date(p.startingPosition.time).toLocaleString();
  } else {
    posEl.textContent = 'None set.';
  }
}

/** "Sun - 2026-09-14" / "star Vega - 2026-09-14" etc., same idea as fixes.js's sightingRowLabel but standalone (this page doesn't load fixes.js). */
function sightSummary(record) {
  var label = SightCalc.formatBodyLabel(record.body);
  return (record.title || label) + ' \u00B7 ' + (record.date || 'no date');
}

/**
 * Includes the resolved position's own time explicitly (not just relying on
 * the timeline row's own time label) -- makes it visible, right next to the
 * position, that this is specifically the time of the Fix's latest
 * constituent Sight, not some other notion of "when." Same reasoning
 * applies to this function's other use, the "Add an Existing Fix" picker,
 * where there's no separate time label at all otherwise.
 */
function fixSummary(record) {
  var pos = record.resolvedPosition;
  if (!pos) return record.name + ' \u00B7 not yet resolved';
  return record.name + ' \u00B7 ' + SightCalc.formatLat(pos.lat) + ', ' + SightCalc.formatLon(pos.lon) +
    ' \u00B7 as of ' + new Date(pos.time).toLocaleTimeString();
}

function drLegSummary(record, whichEnd) {
  var course = String(Math.round(record.courseDegTrue)).padStart(3, '0');
  if (whichEnd === 'start') {
    return record.name + ' begins \u00B7 ' + course + '\u00B0/' + record.sog + 'kt';
  }
  var pos = record.endPosition;
  return record.name + ' ends \u00B7 ' + SightCalc.formatLat(pos.lat) + ', ' + SightCalc.formatLon(pos.lon);
}

/** Resolves a timeline entry's underlying record through the appropriate storage module, using entry.type to pick which one -- exactly the "thin timeline entry" design in passageStorage.js. */
function resolveTimelineEntry(entry) {
  if (entry.type === 'sight') return SightStorage.get(entry.recordId).then(function (r) { return { record: r, summary: r ? sightSummary(r) : null }; });
  if (entry.type === 'fix') return FixStorage.get(entry.recordId).then(function (r) { return { record: r, summary: r ? fixSummary(r) : null }; });
  if (entry.type === 'drleg-start') return DrLegStorage.get(entry.recordId).then(function (r) { return { record: r, summary: r ? drLegSummary(r, 'start') : null }; });
  if (entry.type === 'drleg-end') return DrLegStorage.get(entry.recordId).then(function (r) { return { record: r, summary: r ? drLegSummary(r, 'end') : null }; });
  return Promise.resolve({ record: null, summary: null }); // 'position'
}

function openUnderlyingRecord(entry) {
  if (entry.type === 'sight') {
    try { sessionStorage.setItem('ocsrLoadSightingId', entry.recordId); } catch (e) {}
    location.href = 'index.html';
  } else if (entry.type === 'fix') {
    location.href = 'fixes.html#fix=' + encodeURIComponent(entry.recordId);
  } else if (entry.type === 'drleg-start' || entry.type === 'drleg-end') {
    location.href = 'drleg.html#leg=' + encodeURIComponent(entry.recordId);
  }
}

function removeFromPassage(entry) {
  var storage = entry.type === 'sight' ? SightStorage : entry.type === 'fix' ? FixStorage : DrLegStorage;
  storage.setPassageId(entry.recordId, null).then(function () {
    return PassageStorage.refreshDates(currentPassage.id);
  }).then(function (updated) {
    currentPassage = updated;
    renderPassageDetailHeader();
    refreshPassageTimeline();
    refreshAvailableRecords();
    showToast('Removed from passage.');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not remove that from the passage.', true);
  });
}

function refreshPassageTimeline() {
  var myToken = passageRenderToken;
  PassageStorage.getPassageTimeline(currentPassage.id).then(function (entries) {
    if (myToken !== passageRenderToken) return;
    var listEl = document.getElementById('passageTimelineList');
    var emptyEl = document.getElementById('passageTimelineEmpty');
    listEl.innerHTML = '';

    if (!entries.length) {
      emptyEl.style.display = 'block';
      return;
    }
    emptyEl.style.display = 'none';

    entries.forEach(function (entry) {
      var item = document.createElement('div');
      item.className = 'saved-item';

      var typeLabel = { position: 'Start', sight: 'Sight', fix: 'Fix', 'drleg-start': 'DR Leg begins', 'drleg-end': 'DR Leg ends' }[entry.type];
      var timeLabel = new Date(entry.time).toLocaleString();

      var actionsHtml = entry.type === 'position' ? '' :
        '<div class="saved-item-actions">' +
          '<button class="btn-mini btn-mini-fix">Open</button>' +
          '<button class="btn-mini btn-mini-del">Remove</button>' +
        '</div>';

      item.innerHTML =
        '<div class="saved-item-info">' +
          '<div class="saved-item-title"></div>' +
          '<div class="saved-item-meta"></div>' +
        '</div>' + actionsHtml;

      item.querySelector('.saved-item-title').textContent = typeLabel + ' \u2014 ' + timeLabel;
      item.querySelector('.saved-item-meta').textContent = 'loading\u2026';

      if (entry.type === 'position') {
        item.querySelector('.saved-item-meta').textContent = currentPassage.startingPosition
          ? SightCalc.formatLat(currentPassage.startingPosition.lat) + ', ' + SightCalc.formatLon(currentPassage.startingPosition.lon)
          : '';
      } else {
        resolveTimelineEntry(entry).then(function (resolved) {
          item.querySelector('.saved-item-meta').textContent = resolved.summary || '(could not load this record)';
        });
        item.querySelector('.btn-mini-fix').addEventListener('click', function () { openUnderlyingRecord(entry); });
        item.querySelector('.btn-mini-del').addEventListener('click', function () { removeFromPassage(entry); });
      }

      listEl.appendChild(item);
    });
  });
}

// ---------------------------------------------------------------------
// ADD EXISTING RECORDS (membership assignment)
// ---------------------------------------------------------------------

function assignToPassage(storage, recordId, label) {
  storage.setPassageId(recordId, currentPassage.id).then(function () {
    return PassageStorage.refreshDates(currentPassage.id);
  }).then(function (updated) {
    currentPassage = updated;
    renderPassageDetailHeader();
    refreshPassageTimeline();
    refreshAvailableRecords();
    showToast('Added ' + label + ' to "' + currentPassage.name + '".');
  }).catch(function (err) {
    console.error(err);
    showToast('Could not add that to the passage.', true);
  });
}

function renderAvailableList(listElId, emptyElId, records, buildLabel, onAdd) {
  var listEl = document.getElementById(listElId);
  var emptyEl = document.getElementById(emptyElId);
  listEl.innerHTML = '';

  if (!records.length) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  records.forEach(function (record) {
    var item = document.createElement('div');
    item.className = 'saved-item';
    item.innerHTML =
      '<div class="saved-item-info"><div class="saved-item-title"></div></div>' +
      '<div class="saved-item-actions"><button class="btn-mini btn-mini-load">Add</button></div>';
    item.querySelector('.saved-item-title').textContent = buildLabel(record);
    item.querySelector('.btn-mini-load').addEventListener('click', function () { onAdd(record); });
    listEl.appendChild(item);
  });
}

function refreshAvailableRecords() {
  var myToken = passageRenderToken;
  PassageStorage.getUnassignedRecords().then(function (records) {
    if (myToken !== passageRenderToken) return;

    renderAvailableList('availableSightsList', 'availableSightsEmpty', records.sights, sightSummary, function (record) {
      assignToPassage(SightStorage, record.id, 'sight');
    });
    renderAvailableList('availableFixesList', 'availableFixesEmpty', records.fixes, fixSummary, function (record) {
      assignToPassage(FixStorage, record.id, 'fix');
    });
    renderAvailableList('availableLegsList', 'availableLegsEmpty', records.drLegs, function (r) { return r.name; }, function (record) {
      assignToPassage(DrLegStorage, record.id, 'DR leg');
    });
  });
}

// ---------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------

/**
 * Deleting a Passage must not leave its members silently orphaned
 * (pointing at a passageId that no longer resolves to anything, which
 * would make them invisible to both getPassageRecords() for any real
 * passage AND getUnassignedRecords()) -- so every current member is
 * cleared back to passageId=null first, returning it to the unassigned
 * pool, before the passage record itself is removed.
 */
function clearPassageFromMembers(passageId) {
  return PassageStorage.getPassageRecords(passageId).then(function (records) {
    var clears = [];
    records.sights.forEach(function (r) { clears.push(SightStorage.setPassageId(r.id, null)); });
    records.fixes.forEach(function (r) { clears.push(FixStorage.setPassageId(r.id, null)); });
    records.drLegs.forEach(function (r) { clears.push(DrLegStorage.setPassageId(r.id, null)); });
    return Promise.all(clears);
  });
}

function onDeletePassageFromList(id, name) {
  if (!confirm('Delete the passage "' + name + '"? Its Sights/Fixes/DR Legs are not deleted, only unassigned from this passage.')) return;
  clearPassageFromMembers(id).then(function () {
    return PassageStorage.remove(id);
  }).then(function () {
    showToast('Passage deleted.');
    refreshPassageList();
  }).catch(function (err) {
    console.error(err);
    showToast('Could not delete that passage.', true);
  });
}

function onDeletePassage() {
  if (!currentPassage) return;
  if (!confirm('Delete the passage "' + currentPassage.name + '"? Its Sights/Fixes/DR Legs are not deleted, only unassigned from this passage.')) return;
  var id = currentPassage.id;
  clearPassageFromMembers(id).then(function () {
    return PassageStorage.remove(id);
  }).then(function () {
    showToast('Passage deleted.');
    location.hash = '';
  }).catch(function (err) {
    console.error(err);
    showToast('Could not delete that passage.', true);
  });
}

// ---------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('swVersion').textContent = APP_VERSION;
  initNavMenu();

  document.getElementById('btnNewPassage').addEventListener('click', function () { location.hash = 'new'; });
  document.getElementById('btnBackFromNew').addEventListener('click', function () { location.hash = ''; });
  document.getElementById('btnBackToList').addEventListener('click', function () { location.hash = ''; });
  document.getElementById('btnCreatePassage').addEventListener('click', onCreatePassage);
  document.getElementById('btnDeletePassage').addEventListener('click', onDeletePassage);

  wireDigitBox('newPassageTimeH', 2, 0, 23, 'newPassageTimeM');
  wireDigitBox('newPassageTimeM', 2, 0, 59, null);

  window.addEventListener('hashchange', routeFromHash);
  routeFromHash();
});
