/**
 * chartFullscreen.js
 * Adds a full-screen toggle to a chart's outer wrapper -- an unobtrusive
 * expand button in the corner, a full-viewport overlay while active,
 * Escape or a backdrop click to exit, and (when a panZoomApi is given)
 * enabling/disabling pan/zoom and wiring its reset button, active only
 * while fullscreen.
 *
 * Deliberately a pure presentation layer, wired onto the OUTER wrapper
 * (e.g. "fixChartWrap"), never the inner element chart.js actually
 * overwrites (e.g. "fixChartContainer") -- chart.js does
 * `container.innerHTML = svg` on every re-render (toggling azimuth lines,
 * switching Fix method, any live recompute), which would wipe out a
 * button appended directly inside that same element. Wiring one level up
 * means the chart underneath can re-render freely, as often as it likes,
 * without ever touching this file or losing the toggle. This is also why
 * it works identically for any chart type (single-sight, multi-sight Fix,
 * DR leg) without knowing anything about which one it's showing: it never
 * looks at what's inside the wrapper, only resizes/repositions the
 * wrapper itself.
 *
 * Usage: wireChartFullscreen(wrapId, contentId, panZoomApi) -- contentId
 * is currently unused by this file directly (kept for callers/backward
 * compatibility) but panZoomApi is where pan/zoom integration actually
 * happens: pass the object ChartPanZoom.wire(...) already returned (wired
 * separately by the calling page, since chartPanZoom.js now needs
 * page-specific getViewport/onViewportChange callbacks to genuinely
 * re-render the chart -- it can no longer wire itself generically the way
 * a CSS-transform-based version could). This file just calls
 * panZoomApi.setEnabled()/reset() at the right moments; it doesn't need
 * to know how the callbacks were configured. Safe to call more than once
 * on the same id (idempotent) in case a page's init path could run twice.
 */
(function (global) {
  'use strict';

  function wireChartFullscreen(wrapId, contentId, panZoomApi) {
    var wrap = document.getElementById(wrapId);
    if (!wrap) return null;
    if (wrap.dataset.fullscreenWired) return wrap._fullscreenApi || null;
    wrap.dataset.fullscreenWired = 'true';

    wrap.classList.add('chart-wrap-fs-host');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chart-fs-toggle';
    btn.setAttribute('aria-label', 'Expand chart to full screen');
    btn.textContent = '\u26F6';
    wrap.appendChild(btn);

    var resetBtn = null;
    if (panZoomApi) {
      resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'chart-fs-reset';
      resetBtn.setAttribute('aria-label', 'Reset zoom and pan');
      resetBtn.textContent = '\u21BA';
      resetBtn.style.display = 'none';
      resetBtn.addEventListener('click', function (e) {
        e.stopPropagation(); // don't let this also register as a backdrop click and exit fullscreen
        panZoomApi.reset();
      });
      wrap.appendChild(resetBtn);
    }

    function setFullscreen(on) {
      wrap.classList.toggle('chart-wrap-fullscreen', on);
      btn.textContent = on ? '\u2715' : '\u26F6';
      btn.setAttribute('aria-label', on ? 'Exit full screen' : 'Expand chart to full screen');
      // Prevents the page underneath from scrolling while the overlay is open.
      document.body.classList.toggle('chart-fs-open', on);
      if (panZoomApi) {
        panZoomApi.setEnabled(on); // also resets the view when turned on, so entering always starts from the fit view
        if (resetBtn) resetBtn.style.display = on ? '' : 'none';
      }
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setFullscreen(!wrap.classList.contains('chart-wrap-fullscreen'));
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && wrap.classList.contains('chart-wrap-fullscreen')) {
        setFullscreen(false);
      }
    });

    // Clicking the empty backdrop area (not the chart itself, not either
    // button) also exits, matching conventional lightbox/modal behavior.
    // Only when not currently mid-drag/pinch -- chartPanZoom's own
    // mousedown/touchstart handlers are what actually judge that; a plain
    // click here only ever fires for a genuine tap/click, not a drag, so
    // no extra coordination is needed between the two files for this.
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap && wrap.classList.contains('chart-wrap-fullscreen')) {
        setFullscreen(false);
      }
    });

    // Exposed so a caller can exit programmatically -- e.g. a selected
    // element's own "Open" action (chartInteraction.js's getDetail),
    // where "open the thing I'm already looking at" reasonably means
    // "show me the full page, not just the zoomed plot."
    var api = { exit: function () { setFullscreen(false); }, isFullscreen: function () { return wrap.classList.contains('chart-wrap-fullscreen'); } };
    wrap._fullscreenApi = api;
    return api;
  }

  global.ChartFullscreen = { wire: wireChartFullscreen };
})(window);
