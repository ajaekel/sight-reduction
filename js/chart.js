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

  var PALETTE = ['#00bcd4', '#ff9800', '#8bc34a', '#e91e63', '#9c27b0', '#ffeb3b', '#03a9f4', '#ff5722'];

  /**
   * Renders multiple sightings' LOPs overlaid on one shared chart -- a Fix
   * plot. Each sighting gets its own color (identity), used consistently
   * for its AP marker, azimuth line (dashed), and LOP (solid). Geometry
   * comes from SightCalc.computeMultiLopGeometry (pure); this function only
   * turns it into pixels/markup.
   *
   * sightingsInput = [{ lat, lon, zn, interceptNM, label, color? }]
   *   label: short text for the legend (e.g. "Sun 16:30z"), color optional
   *   (defaults to a fixed palette cycled by index if omitted).
   *
   * Returns { scaleNM, legend: [{ index, color, label, interceptText }] }
   * so the caller can render an HTML legend beneath the chart.
   */
  function renderMultiSightChart(container, sightingsInput, opts) {
    opts = opts || {};

    var withColor = sightingsInput.map(function (s, i) {
      var out = {};
      for (var key in s) { if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key]; }
      out.color = s.color || PALETTE[i % PALETTE.length];
      return out;
    });

    var multiGeo = SightCalc.computeMultiLopGeometry(withColor);
    var scale = SightCalc.chooseNiceScale(multiGeo.maxExtentNM);
    var pxPerNm = RADIUS / scale;

    function toPx(nmPoint) {
      return { x: CENTER + nmPoint.x * pxPerNm, y: CENTER - nmPoint.y * pxPerNm };
    }

    var defs = '<defs><clipPath id="plotClipMulti"><circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '"/></clipPath>';
    var clippedLines = '';
    var markers = '';
    var legend = [];

    multiGeo.sightings.forEach(function (s, i) {
      var idx = i + 1;
      var apPx = toPx(s.apPoint);
      var azEndPx = toPx({ x: s.apPoint.x + s.azimuthUnit.x * scale, y: s.apPoint.y + s.azimuthUnit.y * scale });

      var lopExtendNm = scale * 2.2;
      var lopP1Px = toPx({
        x: s.interceptPoint.x + s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y + s.lopDirection.y * lopExtendNm
      });
      var lopP2Px = toPx({
        x: s.interceptPoint.x - s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y - s.lopDirection.y * lopExtendNm
      });

      defs += '<marker id="azArrowMulti' + idx + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
              '<path d="M0,0 L9,4.5 L0,9 Z" fill="' + s.color + '"/></marker>';

      clippedLines +=
        '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="2.5"/>' +
        '<line x1="' + apPx.x + '" y1="' + apPx.y + '" x2="' + azEndPx.x + '" y2="' + azEndPx.y + '" stroke="' + s.color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#azArrowMulti' + idx + ')"/>';

      markers +=
        '<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="9" fill="' + s.color + '" stroke="var(--bg)" stroke-width="1.5"/>' +
        '<text x="' + apPx.x + '" y="' + (apPx.y + 3.5) + '" text-anchor="middle" class="chart-badge-label">' + idx + '</text>';

      var interceptAbs = Math.abs(s.interceptNM).toFixed(1);
      var interceptDir = s.interceptNM >= 0 ? 'TOWARD' : 'AWAY';
      legend.push({
        index: idx,
        color: s.color,
        label: s.label || ('Sight ' + idx),
        interceptText: interceptAbs + ' nm ' + interceptDir
      });
    });

    defs += '</defs>';

    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of multiple lines of position">' +
        defs +
        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + RADIUS + '" fill="none" stroke="var(--chart-grid)" stroke-width="1"/>' +
        '<circle cx="' + CENTER + '" cy="' + CENTER + '" r="' + (RADIUS / 2) + '" fill="none" stroke="var(--chart-grid)" stroke-width="1" stroke-dasharray="2,4"/>' +

        '<text x="' + CENTER + '" y="' + (CENTER - RADIUS - 8) + '" text-anchor="middle" class="chart-compass-label">N</text>' +
        '<text x="' + (CENTER + RADIUS + 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">E</text>' +
        '<text x="' + CENTER + '" y="' + (CENTER + RADIUS + 18) + '" text-anchor="middle" class="chart-compass-label">S</text>' +
        '<text x="' + (CENTER - RADIUS - 12) + '" y="' + (CENTER + 4) + '" text-anchor="middle" class="chart-compass-label">W</text>' +

        '<g clip-path="url(#plotClipMulti)">' + clippedLines + '</g>' +
        markers +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, legend: legend };
  }

  global.SightChart = {
    renderSightChart: renderSightChart,
    renderMultiSightChart: renderMultiSightChart
  };
})(window);
