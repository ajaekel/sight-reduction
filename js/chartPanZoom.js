/**
 * chartPanZoom.js
 * Adds click-and-drag panning and pinch/wheel/double-click zooming to a
 * chart -- SEMANTIC zoom, not a CSS transform. This is a deliberate,
 * significant departure from this file's original design, worth
 * explaining plainly:
 *
 * A CSS transform (the previous approach) visually magnifies a fixed
 * render. That preserves every proportion in it, including the ratio
 * between two markers' own size and their separation -- so two
 * close-but-distinct points that overlap at the auto-fit scale stay
 * exactly as overlapped at any zoom level, since both their gap AND their
 * own radius grow by the same factor. It also scales the frame (the
 * lat/lon grid) along with everything else, so zooming in pushes the
 * grid's edges, and the orientation they provide, off-screen.
 *
 * This file instead tracks a GEOGRAPHIC viewport -- {originLat, originLon,
 * scale}, where scale is nm-per-half-width, matching chart.js's own
 * internal convention -- and asks the calling page to genuinely RE-RENDER
 * the chart at that viewport on every pan/zoom step, via
 * opts.onViewportChange. Because chart.js's marker/stroke sizes are fixed
 * pixel values (a badge circle is always r="9", regardless of scale) while
 * positions are re-derived from actual lat/lon at the new, finer
 * nm-per-pixel ratio, two nearby points' separation grows with zoom while
 * their own size doesn't -- which is what actually lets them resolve into
 * visually distinct markers, and it's not achievable with a transform.
 * The frame is rebuilt at each viewport too (buildFrame() was already
 * fully parameterized by origin/scale with no auto-fit logic of its own),
 * so grid lines and lat/lon labels always reflect what's actually on
 * screen rather than scaling away from it.
 *
 * Usage: wireChartPanZoom(hostId, opts) where opts = {
 *   getViewport() -> {originLat, originLon, scale, autoScale, autoOriginLat,
 *     autoOriginLon} -- the CURRENT viewport, PLUS the current auto-fit
 *     baseline (autoScale/autoOriginLat/autoOriginLon) -- kept distinct
 *     from the active origin/scale since those reflect wherever the user
 *     has since panned/zoomed to, not what "reset to fit" should return
 *     to. Both read fresh on every gesture/reset rather than cached,
 *     since the underlying data (and so the natural fit) can change
 *     between gestures, e.g. toggling which sights are active.
 *   onViewportChange(viewport) -- called with a new {originLat, originLon,
 *     scale} during/after a gesture; the caller re-renders the chart at
 *     this viewport. Throttled to at most once per animation frame during
 *     a continuous drag/pinch, since re-rendering a full SVG string on
 *     every pointermove would be wasted work between frames -- cheap
 *     enough per call (regenerating an in-memory string, not fetching
 *     anything over the network) that frame-throttling alone is enough
 *     for smooth interaction, with no need for a separate
 *     approximate-during-gesture/precise-on-release split.
 * }
 * Returns {reset, setEnabled, getViewport}.
 */
(function (global) {
  'use strict';

  var MIN_SCALE_FRACTION = 0.001; // most zoomed in: scale can shrink to 1/1000 of the auto-fit value.
  // Deliberately generous, not a cautious default: this is vector SVG, not
  // raster tiles, so there's no pixelation floor to respect the way a map
  // built on image tiles would need. The whole point of semantic zoom (see
  // this file's own header) is resolving points that are very close
  // together into visually distinct markers -- an 8x cap (an earlier,
  // more conservative choice here) turned out nowhere near enough for
  // that in practice: two sights ~0.3nm apart, a routine distance for a
  // running fix, projected about 0.4px apart at a typical auto-fit scale,
  // needing on the order of 40-50x zoom to actually separate past the
  // ~18px a badge marker's own diameter takes up -- confirmed by test,
  // not assumed.
  var CENTER = SightChart.VIEWBOX_SIZE / 2;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function wireChartPanZoom(hostId, opts) {
    opts = opts || {};
    var host = document.getElementById(hostId);
    if (!host) return null;
    if (host.dataset.panZoomWired) return host._panZoomApi || null;
    host.dataset.panZoomWired = 'true';

    var enabled = false;
    var viewport = null; // {originLat, originLon, scale} -- null until enabled/reset first pulls one from opts.getViewport()

    function svgRect() {
      var svg = host.querySelector('svg.chart-svg');
      return svg ? svg.getBoundingClientRect() : null;
    }

    var pendingFrame = null;
    function scheduleChange() {
      if (pendingFrame) return;
      pendingFrame = requestAnimationFrame(function () {
        pendingFrame = null;
        if (opts.onViewportChange) opts.onViewportChange(viewport);
      });
    }

    function reset() {
      var v = opts.getViewport ? opts.getViewport() : null;
      if (!v) return;
      // Resets to the TRUE auto-fit origin, not wherever the viewport
      // happens to currently be -- v.originLat/originLon reflect the
      // active (possibly panned) viewport; v.autoOriginLat/autoOriginLon
      // are what "fit" actually means right now.
      viewport = { originLat: v.autoOriginLat, originLon: v.autoOriginLon, scale: v.autoScale };
      if (opts.onViewportChange) opts.onViewportChange(viewport); // immediate, not throttled -- reset is a single discrete action, not a gesture stream
    }

    // Converts a screen-space point into its current nm-offset-from-origin,
    // using the viewport in effect right now.
    function screenToNm(clientX, clientY) {
      var rect = svgRect();
      if (!rect) return null;
      var vbX = (clientX - rect.left) / rect.width * SightChart.VIEWBOX_SIZE;
      var vbY = (clientY - rect.top) / rect.height * SightChart.VIEWBOX_SIZE;
      var pxPerNm = SightChart.pxPerNmForScale(viewport.scale);
      return { x: (vbX - CENTER) / pxPerNm, y: -(vbY - CENTER) / pxPerNm, vbX: vbX, vbY: vbY };
    }

    function panByScreenDelta(dxPx, dyPx) {
      var rect = svgRect();
      if (!rect) return;
      var pxPerNm = SightChart.pxPerNmForScale(viewport.scale);
      var screenPxPerNm = pxPerNm * (rect.width / SightChart.VIEWBOX_SIZE);
      var nmDx = dxPx / screenPxPerNm;
      var nmDy = -dyPx / screenPxPerNm; // screen-y grows downward; nm-y (north) grows upward
      // Moving the origin is the OPPOSITE of how the content should appear
      // to move: dragging right should reveal content from the west, i.e.
      // shift the origin west, so the same fixed point's offset (and so
      // its screen position) increases/moves right.
      var newOrigin = SightCalc.positionFromOffset(viewport.originLat, viewport.originLon, { x: -nmDx, y: -nmDy });
      viewport = { originLat: newOrigin.lat, originLon: newOrigin.lon, scale: viewport.scale };
      scheduleChange();
    }

    // Zoom anchored at a screen point, so that point stays visually
    // stationary as scale changes -- matching how a pinch or scroll zoom
    // is expected to feel. Derivation: find the geographic position the
    // gesture point currently represents, compute where a point needs to
    // sit (in nm, relative to a new origin) to land on that same screen
    // pixel under the NEW scale, then solve for the origin that puts the
    // gesture's actual geographic position at that offset -- which is
    // exactly positionFromOffset() run in reverse (negate the desired
    // offset and treat the gesture's own position as the reference point).
    function zoomAt(clientX, clientY, factor) {
      var rect = svgRect();
      if (!rect) return;
      var here = screenToNm(clientX, clientY);
      if (!here) return;
      var gesturePos = SightCalc.positionFromOffset(viewport.originLat, viewport.originLon, here);

      var bounds = opts.getViewport ? opts.getViewport() : null;
      var autoScale = (bounds && bounds.autoScale) || viewport.scale;
      var newScale = clamp(viewport.scale / factor, autoScale * MIN_SCALE_FRACTION, autoScale);

      var newPxPerNm = SightChart.pxPerNmForScale(newScale);
      var desired = { x: (here.vbX - CENTER) / newPxPerNm, y: -(here.vbY - CENTER) / newPxPerNm };
      var newOrigin = SightCalc.positionFromOffset(gesturePos.lat, gesturePos.lon, { x: -desired.x, y: -desired.y });

      viewport = { originLat: newOrigin.lat, originLon: newOrigin.lon, scale: newScale };
      scheduleChange();
    }

    // ---- Mouse: drag to pan, wheel to zoom, double-click to zoom in ----
    var dragging = false, lastX = 0, lastY = 0;
    host.addEventListener('mousedown', function (e) {
      if (!enabled) return;
      dragging = true;
      lastX = e.clientX; lastY = e.clientY;
      host.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      panByScreenDelta(e.clientX - lastX, e.clientY - lastY);
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('mouseup', function () {
      if (dragging) { dragging = false; host.style.cursor = 'grab'; }
    });
    host.addEventListener('wheel', function (e) {
      if (!enabled) return;
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    }, { passive: false });
    host.addEventListener('dblclick', function (e) {
      if (!enabled) return;
      zoomAt(e.clientX, e.clientY, 1.6);
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
        pinchStartScale = viewport.scale;
      }
    }, { passive: true });

    host.addEventListener('touchmove', function (e) {
      if (!enabled) return;
      if (e.touches.length === 1) {
        e.preventDefault();
        panByScreenDelta(e.touches[0].clientX - touchLastX, e.touches[0].clientY - touchLastY);
        touchLastX = e.touches[0].clientX;
        touchLastY = e.touches[0].clientY;
      } else if (e.touches.length === 2 && pinchStartDist > 0) {
        e.preventDefault();
        var dist = touchDist(e.touches[0], e.touches[1]);
        var mid = touchMid(e.touches[0], e.touches[1]);
        var targetScale = pinchStartScale * (pinchStartDist / dist); // inverted vs. CSS-scale pinch: THIS scale shrinks to zoom in
        zoomAt(mid.x, mid.y, viewport.scale / targetScale);
      }
    }, { passive: false });

    var api = {
      reset: reset,
      setEnabled: function (on) {
        enabled = on;
        if (on) { reset(); host.style.cursor = 'grab'; }
        else { host.style.cursor = ''; }
      },
      getViewport: function () { return viewport; }
    };
    host._panZoomApi = api;
    return api;
  }

  global.ChartPanZoom = { wire: wireChartPanZoom };
})(window);
