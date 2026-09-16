/**
 * chartPanZoom.js
 * Adds click-and-drag panning, pinch/wheel/double-click zooming, and a
 * reset-view control to a chart's content element.
 *
 * Applies a CSS transform (translate + scale) to contentId, NOT to the
 * <svg> chart.js actually draws -- the same lesson chartFullscreen.js
 * already had to learn: chart.js replaces contentId's innerHTML wholesale
 * on every re-render (toggling azimuth lines, switching Fix method, any
 * live recompute), which would silently reset a transform applied to the
 * <svg> element itself the next time anything redraws. contentId is the
 * element ABOVE that (chart.js's actual render target, or a wrapper
 * around it) -- it's never replaced, only its children are, so a
 * transform applied here survives any number of re-renders untouched.
 *
 * View state is tracked as {scale, tx, ty} in PIXEL space, not in the
 * chart's own nm/geographic coordinate space -- deliberately, for now:
 * this file only needs to move pixels around convincingly, and pixel
 * space is the simplest place to do that. If a future geographic layer
 * (map/satellite tiles under the plot) needs to know what geographic area
 * is currently in view, that conversion belongs at the call site, which
 * already has the chart's origin lat/lon and nm-per-pixel scale from
 * whatever it passed to chart.js to render the current content --
 * converting the CURRENT {scale, tx, ty} plus the viewport's own pixel
 * size back into an nm offset (divide by pxPerNm) and then into a lat/lon
 * (SightCalc.positionFromOffset) is a small, well-contained conversion,
 * not something this file needs to anticipate or couple itself to today.
 *
 * Usage: wireChartPanZoom(hostId, contentId) -- hostId receives pointer
 * events (typically the chart's outer, fullscreen-toggled wrapper);
 * contentId is what actually gets transformed (see above). Returns
 * {reset, setEnabled} so a caller (chartFullscreen.js) can reset the view
 * and gate interaction to only-while-fullscreen.
 */
(function (global) {
  'use strict';

  var MIN_SCALE = 1;
  var MAX_SCALE = 8;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function wireChartPanZoom(hostId, contentId) {
    var host = document.getElementById(hostId);
    var content = document.getElementById(contentId);
    if (!host || !content) return null;
    if (host.dataset.panZoomWired) return host._panZoomApi || null;
    host.dataset.panZoomWired = 'true';

    var state = { scale: 1, tx: 0, ty: 0 };
    var enabled = false; // gated: inert until the caller turns it on (e.g. only while fullscreen)

    function apply() {
      content.style.transform = 'translate(' + state.tx + 'px, ' + state.ty + 'px) scale(' + state.scale + ')';
    }

    // Smooths discrete jumps (wheel step, double-click, reset) without
    // making a live drag/pinch feel laggy -- the transition is switched
    // off for the duration of any continuous gesture and back on around
    // single-step changes only.
    function withTransition(fn) {
      content.style.transition = 'transform 0.15s ease';
      fn();
      window.setTimeout(function () { content.style.transition = ''; }, 160);
    }

    function reset() {
      state = { scale: 1, tx: 0, ty: 0 };
      withTransition(apply);
    }

    // Zoom anchored at a specific viewport point so that point stays
    // visually stationary as scale changes, matching how pinch/scroll
    // zoom is expected to feel (zoom toward where the gesture is, not
    // always toward center).
    function zoomAt(clientX, clientY, factor, animated) {
      var rect = host.getBoundingClientRect();
      var originX = clientX - rect.left - rect.width / 2;
      var originY = clientY - rect.top - rect.height / 2;
      var newScale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);
      var appliedFactor = newScale / state.scale;
      state.tx = originX - (originX - state.tx) * appliedFactor;
      state.ty = originY - (originY - state.ty) * appliedFactor;
      state.scale = newScale;
      if (animated) withTransition(apply); else apply();
    }

    // ---- Mouse: drag to pan, wheel to zoom, double-click to zoom in ----
    var dragging = false, lastX = 0, lastY = 0;
    host.addEventListener('mousedown', function (e) {
      if (!enabled || state.scale <= MIN_SCALE) return; // nothing to pan at the default fit scale
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      host.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      state.tx += e.clientX - lastX;
      state.ty += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      apply();
    });
    window.addEventListener('mouseup', function () {
      if (dragging) { dragging = false; host.style.cursor = ''; }
    });
    host.addEventListener('wheel', function (e) {
      if (!enabled) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15, false);
    }, { passive: false });
    host.addEventListener('dblclick', function (e) {
      if (!enabled) return;
      zoomAt(e.clientX, e.clientY, 1.6, true);
    });

    // ---- Touch: one-finger drag to pan, two-finger pinch to zoom ----
    var touchLastX = 0, touchLastY = 0, pinchStartDist = 0, pinchStartScale = 1;
    function touchDist(t0, t1) { return Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY); }
    function touchMid(t0, t1) { return { x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 }; }

    host.addEventListener('touchstart', function (e) {
      if (!enabled) return;
      if (e.touches.length === 1) {
        touchLastX = e.touches[0].clientX;
        touchLastY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        pinchStartDist = touchDist(e.touches[0], e.touches[1]);
        pinchStartScale = state.scale;
      }
    }, { passive: true });

    host.addEventListener('touchmove', function (e) {
      if (!enabled) return;
      if (e.touches.length === 1 && state.scale > MIN_SCALE) {
        e.preventDefault();
        var dx = e.touches[0].clientX - touchLastX;
        var dy = e.touches[0].clientY - touchLastY;
        state.tx += dx; state.ty += dy;
        touchLastX = e.touches[0].clientX;
        touchLastY = e.touches[0].clientY;
        apply();
      } else if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        var dist = touchDist(e.touches[0], e.touches[1]);
        var mid = touchMid(e.touches[0], e.touches[1]);
        var targetScale = clamp(pinchStartScale * (dist / pinchStartDist), MIN_SCALE, MAX_SCALE);
        zoomAt(mid.x, mid.y, targetScale / state.scale, false);
      }
    }, { passive: false });

    var api = {
      reset: reset,
      setEnabled: function (on) {
        enabled = on;
        if (!on) reset();
        host.style.cursor = on ? 'grab' : '';
      },
      getState: function () { return { scale: state.scale, tx: state.tx, ty: state.ty }; }
    };
    host._panZoomApi = api;
    return api;
  }

  global.ChartPanZoom = { wire: wireChartPanZoom };
})(window);
