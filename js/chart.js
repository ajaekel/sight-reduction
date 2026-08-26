/**
 * chart.js
 * Renders the single-sight plot (Assumed Position, azimuth to the body, and
 * the resulting Line of Position) as inline SVG. Geometry math is delegated
 * to SightCalc.computeLopGeometry / chooseNiceScale (calc.js, pure); this file
 * only turns that geometry into pixels and markup, and owns the DOM update.
 */
(function (global) {
  'use strict';

  var SIZE = 340;
  var CENTER = SIZE / 2;
  var RADIUS = 120; // px, represents "scale" nm from AP to the outer ring

  function pad3(n) {
    return String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');
  }

  /**
   * opts = {
   *   zn: decimal degrees,
   *   interceptNM: signed nm,
   *   apLabel: string (e.g. "35° 15.0'N 15° 33.0'W"),
   *   bodyLabel: string (e.g. "Sun", "Star ALDEBARAN")
   * }
   */
  function renderSightChart(container, opts) {
    var geo = SightCalc.computeLopGeometry(opts.zn, opts.interceptNM);
    var scale = SightCalc.chooseNiceScale(opts.interceptNM);
    var pxPerNm = RADIUS / scale;

    function toPx(nmPoint) {
      return { x: CENTER + nmPoint.x * pxPerNm, y: CENTER - nmPoint.y * pxPerNm };
    }

    var apPx = toPx(geo.ap);
    var azEndPx = toPx({ x: geo.azimuthUnit.x * scale, y: geo.azimuthUnit.y * scale });
    var interceptPx = toPx(geo.interceptPoint);

    var lopExtendNm = scale * 2.2;
    var lopP1Px = toPx({
      x: geo.interceptPoint.x + geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y + geo.lopDirection.y * lopExtendNm
    });
    var lopP2Px = toPx({
      x: geo.interceptPoint.x - geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y - geo.lopDirection.y * lopExtendNm
    });

    var znLabel = pad3(opts.zn) + '\u00B0';
    var interceptAbs = Math.abs(opts.interceptNM).toFixed(1);
    var interceptDir = opts.interceptNM >= 0 ? 'TOWARD' : 'AWAY';

    // Keep the Zn label from drifting off-canvas near the edges by clamping
    // its x position slightly inward from the arrow tip.
    var znLabelX = Math.min(Math.max(azEndPx.x, 28), SIZE - 28);
    var znLabelY = Math.min(Math.max(azEndPx.y - 8, 14), SIZE - 6);

    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of assumed position, azimuth, and line of position">' +
        '<defs>' +
          '<clipPath id="plotClip"><circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '"/></clipPath>' +
          '<marker id="azArrow" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
            '<path d="M0,0 L9,4.5 L0,9 Z" fill="var(--chart-az)"/>' +
          '</marker>' +
        '</defs>' +

        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '" fill="none" stroke="var(--chart-grid)" stroke-width="1"/>' +
        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + (RADIUS / 2) + '" fill="none" stroke="var(--chart-grid)" stroke-width="1" stroke-dasharray="2,4"/>' +

        '<text x="' + CENTER + '" y="' + (CENTER - RADIUS - 8) + '" text-anchor="middle" class="chart-compass-label">N</text>' +
        '<text x="' + (CENTER + RADIUS + 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">E</text>' +
        '<text x="' + CENTER + '" y="' + (CENTER + RADIUS + 18) + '" text-anchor="middle" class="chart-compass-label">S</text>' +
        '<text x="' + (CENTER - RADIUS - 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">W</text>' +

        '<g clip-path="url(#plotClip)">' +
          '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="var(--chart-lop)" stroke-width="2.5"/>' +
          '<line x1="' + apPx.x + '" y1="' + apPx.y + '" x2="' + azEndPx.x + '" y2="' + azEndPx.y + '" stroke="var(--chart-az)" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#azArrow)"/>' +
        '</g>' +

        '<circle cx="' + interceptPx.x + '" cy="' + interceptPx.y + '" r="3.5" fill="var(--chart-lop)"/>' +

        '<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="4.5" fill="var(--text)"/>' +
        '<text x="' + (apPx.x + 8) + '" y="' + (apPx.y - 8) + '" class="chart-point-label">AP</text>' +

        '<text x="' + znLabelX + '" y="' + znLabelY + '" text-anchor="middle" class="chart-az-label">Zn ' + znLabel + '</text>' +
      '</svg>';

    container.innerHTML = svg;

    return {
      scaleNM: scale,
      znLabel: znLabel,
      interceptText: interceptAbs + ' nm ' + interceptDir
    };
  }

  /**
   * Renders multiple LOPs (a Fix) on one shared plot. Each sighting keeps
   * its own AP -- callers translate each into a common frame first (see
   * SightCalc.nmOffsetFromRef) and pass that translation in as `offset`.
   *
   * items = [{
   *   color: CSS color string,
   *   label: string (shown in the legend),
   *   zn: decimal degrees,
   *   interceptNM: signed nm,
   *   offset: { x, y } nm from the fix's reference AP (0,0 for the reference itself)
   * }, ...]
   */
  function renderFixChart(container, items) {
    if (!items || !items.length) {
      container.innerHTML = '<div class="empty-note">Add at least one calculated sighting to plot this fix.</div>';
      return { scaleNM: 0 };
    }

    // Local geometry (AP-at-origin) per sighting, shifted into the shared frame.
    var geos = items.map(function (item) {
      var geo = SightCalc.computeLopGeometry(item.zn, item.interceptNM);
      var off = item.offset || { x: 0, y: 0 };
      return {
        item: item,
        ap: { x: geo.ap.x + off.x, y: geo.ap.y + off.y },
        interceptPoint: { x: geo.interceptPoint.x + off.x, y: geo.interceptPoint.y + off.y },
        lopDirection: geo.lopDirection // a direction vector; translation doesn't affect it
      };
    });

    // The shared scale has to contain every translated AP and intercept
    // point, not just one sighting's -- otherwise an offset sighting can
    // render off-canvas.
    var maxExtent = 0;
    geos.forEach(function (g) {
      maxExtent = Math.max(maxExtent, Math.hypot(g.ap.x, g.ap.y), Math.hypot(g.interceptPoint.x, g.interceptPoint.y));
    });
    var scale = SightCalc.chooseNiceScale(maxExtent);
    var pxPerNm = RADIUS / scale;

    function toPx(nmPoint) {
      return { x: CENTER + nmPoint.x * pxPerNm, y: CENTER - nmPoint.y * pxPerNm };
    }

    var lopExtendNm = scale * 2.2;

    var parts = [];
    parts.push(
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of multiple lines of position for this fix">' +
        '<defs><clipPath id="fixPlotClip"><circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '"/></clipPath></defs>' +
        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '" fill="none" stroke="var(--chart-grid)" stroke-width="1"/>' +
        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + (RADIUS / 2) + '" fill="none" stroke="var(--chart-grid)" stroke-width="1" stroke-dasharray="2,4"/>' +
        '<text x="' + CENTER + '" y="' + (CENTER - RADIUS - 8) + '" text-anchor="middle" class="chart-compass-label">N</text>' +
        '<text x="' + (CENTER + RADIUS + 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">E</text>' +
        '<text x="' + CENTER + '" y="' + (CENTER + RADIUS + 18) + '" text-anchor="middle" class="chart-compass-label">S</text>' +
        '<text x="' + (CENTER - RADIUS - 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">W</text>' +
        '<g clip-path="url(#fixPlotClip)">'
    );

    geos.forEach(function (g) {
      var p1 = toPx({
        x: g.interceptPoint.x + g.lopDirection.x * lopExtendNm,
        y: g.interceptPoint.y + g.lopDirection.y * lopExtendNm
      });
      var p2 = toPx({
        x: g.interceptPoint.x - g.lopDirection.x * lopExtendNm,
        y: g.interceptPoint.y - g.lopDirection.y * lopExtendNm
      });
      parts.push('<line x1="' + p1.x + '" y1="' + p1.y + '" x2="' + p2.x + '" y2="' + p2.y + '" stroke="' + g.item.color + '" stroke-width="2.5"/>');
    });

    parts.push('</g>');

    geos.forEach(function (g) {
      var apPx = toPx(g.ap);
      var ip = toPx(g.interceptPoint);
      parts.push('<circle cx="' + ip.x + '" cy="' + ip.y + '" r="3.5" fill="' + g.item.color + '"/>');
      parts.push('<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="4.5" fill="' + g.item.color + '" stroke="var(--bg)" stroke-width="1.5"/>');
    });

    parts.push('</svg>');

    var legend = '<div class="fix-legend">' + geos.map(function (g) {
      return '<div class="fix-legend-item"><span class="fix-legend-swatch" style="background:' + g.item.color + '"></span>' + g.item.label + '</div>';
    }).join('') + '</div>';

    container.innerHTML = parts.join('') + legend;

    return { scaleNM: scale };
  }

  global.SightChart = {
    renderSightChart: renderSightChart,
    renderFixChart: renderFixChart
  };
})(window);
