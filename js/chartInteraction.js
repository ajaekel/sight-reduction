/**
 * chartInteraction.js
 * Adds tap/click selection to a chart: hit-testing, selection state, and
 * a generic presentation shell (a lightweight caption inline, a bottom
 * sheet in full screen, and a disambiguation list when a tap hits more
 * than one selectable element at once).
 *
 * This file knows nothing about sights, fixes, DR legs, or any other
 * navigation concept -- it only ever sees {type, recordId, part}, string
 * identifiers chart.js stamped onto whatever it drew (see chart.js's own
 * comment on data-select-* for that half of the contract). What a
 * selection actually MEANS -- what to show, what "Open" does -- is
 * supplied entirely by the calling page through opts.getDetail. That's
 * the same separation chartFullscreen.js already established for "where
 * the chart displays" and chartPanZoom.js established for "how you
 * navigate the viewport": this file owns "what did the user select and
 * how do we show that," nothing about what it means.
 *
 * Hit-testing uses document.elementsFromPoint(x, y) -- the plural form,
 * which returns every element stacked at that screen point in z-order.
 * That's what makes ambiguous hits (an AP marker sitting on top of a Fix
 * marker, both real, both selectable) a first-class case rather than a
 * hard problem: elementsFromPoint already returns all of them, so this
 * file just filters for data-select-type/id and de-duplicates (chart.js's
 * wider invisible hit-stroke and the visible line it sits on both use the
 * same coordinates and would otherwise show up as two hits for one
 * element). It also composes for free with chartPanZoom.js's transform,
 * since elementsFromPoint reports what's visually at a screen point
 * AFTER any CSS transform is applied -- neither file needs to know the
 * other exists.
 *
 * Selection is deliberately independent of pan/zoom/fullscreen state:
 * selecting something never moves the viewport, and resetting the
 * viewport (chartPanZoom's reset) never clears a selection. Opening a
 * record is a separate, explicit action (the detail's own onOpen
 * callback) -- selecting is "inspect," never "navigate away."
 *
 * Usage: wireChartInteraction(wrapId, opts) where opts = {
 *   getDetail(candidate) -> {title, lines: [string], openLabel, onOpen} | null
 *     -- called once a single selection is resolved (directly, or after
 *     the user picks one from an ambiguity list). Returning null shows no
 *     detail (chart.js stamped something this page doesn't recognize --
 *     unlikely if the two files stay in sync, but harmless if it happens).
 *   onSelectionChange(selection) -- called with the current single
 *     selection ({type, recordId, part} or null) any time it changes,
 *     INCLUDING while an ambiguity list is showing (selection is null
 *     until one candidate is chosen). This is how the calling page knows
 *     to re-render its chart with a highlightId so chart.js can draw the
 *     selected element emphasized -- chartInteraction.js never touches
 *     chart.js directly.
 * }
 * Returns {clearSelection, getSelection}.
 */
(function (global) {
  'use strict';

  function wireChartInteraction(wrapId, opts) {
    opts = opts || {};
    var wrap = document.getElementById(wrapId);
    if (!wrap) return null;
    if (wrap.dataset.interactionWired) return wrap._interactionApi || null;
    wrap.dataset.interactionWired = 'true';

    var selection = null;

    var caption = document.createElement('div');
    caption.className = 'chart-select-caption';
    caption.style.display = 'none';
    wrap.appendChild(caption);

    var sheet = document.createElement('div');
    sheet.className = 'chart-select-sheet';
    sheet.style.display = 'none';
    wrap.appendChild(sheet);

    var picker = document.createElement('div');
    picker.className = 'chart-select-picker';
    picker.style.display = 'none';
    wrap.appendChild(picker);

    function isFullscreen() {
      return wrap.classList.contains('chart-wrap-fullscreen');
    }

    function hideAll() {
      caption.style.display = 'none';
      sheet.style.display = 'none';
      picker.style.display = 'none';
    }

    function notify() {
      if (opts.onSelectionChange) opts.onSelectionChange(selection);
    }

    function clearSelection() {
      selection = null;
      hideAll();
      notify();
    }

    function showDetailFor(candidate) {
      selection = candidate;
      notify(); // lets the calling page re-render with this element highlighted, before we ask it for detail content
      hideAll();

      var detail = opts.getDetail ? opts.getDetail(candidate) : null;
      if (!detail) return;

      if (isFullscreen()) {
        sheet.innerHTML = '';
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'chart-select-close';
        closeBtn.setAttribute('aria-label', 'Close');
        closeBtn.textContent = '\u2715';
        closeBtn.addEventListener('click', function (e) { e.stopPropagation(); clearSelection(); });
        sheet.appendChild(closeBtn);

        var title = document.createElement('div');
        title.className = 'chart-select-title';
        title.textContent = detail.title || '';
        sheet.appendChild(title);

        (detail.lines || []).forEach(function (line) {
          var p = document.createElement('div');
          p.className = 'chart-select-line';
          p.textContent = line;
          sheet.appendChild(p);
        });

        if (detail.onOpen) {
          var openBtn = document.createElement('button');
          openBtn.type = 'button';
          openBtn.className = 'chart-select-open';
          openBtn.textContent = detail.openLabel || 'Open';
          openBtn.addEventListener('click', function (e) { e.stopPropagation(); detail.onOpen(); });
          sheet.appendChild(openBtn);
        }
        sheet.style.display = 'block';
      } else {
        // Inline: one lightweight line, never the full sheet -- a bottom
        // sheet would overwhelm a chart that's only a few inches tall in
        // a card.
        var summary = detail.title || '';
        if (detail.lines && detail.lines[0]) summary += ' \u00B7 ' + detail.lines[0];
        caption.textContent = summary;
        caption.style.display = 'block';
      }
    }

    function showPicker(candidates) {
      selection = null;
      notify();
      hideAll();

      picker.innerHTML = '';
      var title = document.createElement('div');
      title.className = 'chart-select-picker-title';
      title.textContent = candidates.length + ' navigation elements here';
      picker.appendChild(title);

      candidates.forEach(function (c) {
        var row = document.createElement('button');
        row.type = 'button';
        row.className = 'chart-select-picker-row';
        row.textContent = c.label || (c.type + ' ' + c.recordId);
        row.addEventListener('click', function (e) {
          e.stopPropagation();
          showDetailFor(c);
        });
        picker.appendChild(row);
      });
      picker.style.display = 'block';
    }

    wrap.addEventListener('click', function (e) {
      if (caption.contains(e.target) || sheet.contains(e.target) || picker.contains(e.target)) return;

      var hits = document.elementsFromPoint(e.clientX, e.clientY).filter(function (el) {
        return el.dataset && el.dataset.selectType && el.dataset.selectId;
      });

      var seen = {};
      var candidates = [];
      hits.forEach(function (el) {
        var key = el.dataset.selectType + '|' + el.dataset.selectId + '|' + (el.dataset.selectPart || '');
        if (seen[key]) return;
        seen[key] = true;
        candidates.push({
          type: el.dataset.selectType,
          recordId: el.dataset.selectId,
          part: el.dataset.selectPart || undefined,
          label: el.dataset.selectLabel || undefined
        });
      });

      if (candidates.length === 0) clearSelection();
      else if (candidates.length === 1) showDetailFor(candidates[0]);
      else showPicker(candidates);
    });

    var api = { clearSelection: clearSelection, getSelection: function () { return selection; } };
    wrap._interactionApi = api;
    return api;
  }

  global.ChartInteraction = { wire: wireChartInteraction };
})(window);
