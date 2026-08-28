/**
 * chart.js
 * Renders sight plots as inline SVG: a square plotting-sheet grid (like a
 * real nautical plotting sheet) with latitude/longitude reference lines
 * labeled at the edges, rather than a circular range-ring layout -- this
 * uses the available space more fully (a circle inscribed in a square
 * wastes the corners) and gives real positional context instead of just
 * relative bearings.
 *
 * Geometry math is delegated to SightCalc (computeLopGeometry /
 * computeMultiLopGeometry / chooseNiceScale, all pure); this file only
 * turns that geometry into pixels/markup and owns the DOM update.
 *
 * Shared by:
 *   - renderSightChart()      -- one sighting (index.html's Plot card)
 *   - renderMultiSightChart() -- several sightings overlaid (a Fix's plot)
 */
(function (global) {
  'use strict';

  var SIZE = 340;          // SVG viewBox size (viewBox units, not px -- actual
                            // rendered size is controlled by CSS and scales
                            // with the available card width)
  var MARGIN = 34;          // reserved for edge lat/lon labels
  var CENTER = SIZE / 2;
  var HALF = (SIZE - 2 * MARGIN) / 2;   // plot area half-width, replaces the old circular RADIUS
  var PLOT_MIN = MARGIN;
  var PLOT_MAX = SIZE - MARGIN;
  var GRID_FRACTIONS = [-1, -0.5, 0, 0.5, 1]; // as a fraction of scale; only -1/0/1 get text labels

  function pad3(n) {
    return String(Math.round(((n % 360) + 360) % 360)).padStart(3, '0');
  }

  function formatLat(latDecimal) {
    var ns = latDecimal >= 0 ? 'N' : 'S';
    return SightCalc.formatDegMin(Math.abs(latDecimal)) + ns;
  }

  function formatLon(lonDecimal) {
    var ew = lonDecimal >= 0 ? 'E' : 'W';
    return SightCalc.formatDegMin(Math.abs(lonDecimal)) + ew;
  }

  /**
   * Builds the shared square frame: border, lat/lon gridlines with edge
   * labels, and a clipPath (id clipId) other content can be clipped to.
   * Returns an SVG markup string (defs + visible frame elements).
   */
  function buildFrame(originLat, originLon, scale, clipId) {
    var pxPerNm = HALF / scale;
    var originLatRad = SightCalc.rad(originLat);
    var cosOriginLat = Math.cos(originLatRad) || 1e-9; // guard against exactly 90deg

    var svg = '<defs><clipPath id="' + clipId + '"><rect x="' + PLOT_MIN + '" y="' + PLOT_MIN + '" width="' + (PLOT_MAX - PLOT_MIN) + '" height="' + (PLOT_MAX - PLOT_MIN) + '"/></clipPath></defs>';

    svg += '<rect x="' + PLOT_MIN + '" y="' + PLOT_MIN + '" width="' + (PLOT_MAX - PLOT_MIN) + '" height="' + (PLOT_MAX - PLOT_MIN) + '" fill="none" stroke="var(--chart-grid)" stroke-width="1.5"/>';

    GRID_FRACTIONS.forEach(function (f) {
      var nm = f * scale;
      var isCenter = f === 0;
      var isEdge = Math.abs(f) === 1;
      var strokeOpacity = isCenter ? '0.55' : '0.28';
      var dash = isCenter ? '' : ' stroke-dasharray="3,4"';

      var px = CENTER + nm * pxPerNm;
      svg += '<line x1="' + px + '" y1="' + PLOT_MIN + '" x2="' + px + '" y2="' + PLOT_MAX + '" stroke="var(--chart-grid)" stroke-opacity="' + strokeOpacity + '"' + dash + '/>';

      var py = CENTER - nm * pxPerNm;
      svg += '<line x1="' + PLOT_MIN + '" y1="' + py + '" x2="' + PLOT_MAX + '" y2="' + py + '" stroke="var(--chart-grid)" stroke-opacity="' + strokeOpacity + '"' + dash + '/>';

      if (isCenter || isEdge) {
        var lonHere = originLon + nm / (60 * cosOriginLat);
        var latHere = originLat + nm / 60;

        var lonLabelY = (f === 1) ? PLOT_MAX + 13 : PLOT_MIN - 6;
        svg += '<text x="' + px + '" y="' + lonLabelY + '" text-anchor="middle" class="chart-axis-label">' + formatLon(lonHere) + '</text>';

        var latLabelX = (f === 1) ? PLOT_MIN - 4 : PLOT_MAX + 4;
        var latAnchor = (f === 1) ? 'end' : 'start';
        svg += '<text x="' + latLabelX + '" y="' + (py + 3.5) + '" text-anchor="' + latAnchor + '" class="chart-axis-label">' + formatLat(latHere) + '</text>';
      }
    });

    return svg;
  }

  function toPx(nmPoint, pxPerNm) {
    return { x: CENTER + nmPoint.x * pxPerNm, y: CENTER - nmPoint.y * pxPerNm };
  }

  /**
   * opts = {
   *   zn, interceptNM,          -- decimal degrees / signed nm
   *   apLat, apLon,             -- assumed position, signed decimal degrees
   *   apLabel, bodyLabel        -- display strings
   * }
   */
  function renderSightChart(container, opts) {
    var geo = SightCalc.computeLopGeometry(opts.zn, opts.interceptNM);
    var scale = SightCalc.chooseNiceScale(opts.interceptNM);
    var pxPerNm = HALF / scale;

    var apPx = toPx(geo.ap, pxPerNm);
    var azEndPx = toPx({ x: geo.azimuthUnit.x * scale, y: geo.azimuthUnit.y * scale }, pxPerNm);

    var lopExtendNm = scale * 2.2;
    var lopP1Px = toPx({
      x: geo.interceptPoint.x + geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y + geo.lopDirection.y * lopExtendNm
    }, pxPerNm);
    var lopP2Px = toPx({
      x: geo.interceptPoint.x - geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y - geo.lopDirection.y * lopExtendNm
    }, pxPerNm);

    var interceptPx = toPx(geo.interceptPoint, pxPerNm);
    var znLabel = pad3(opts.zn) + '\u00B0';
    var interceptAbs = Math.abs(opts.interceptNM).toFixed(1);
    var interceptDir = opts.interceptNM >= 0 ? 'TOWARD' : 'AWAY';

    var znLabelX = Math.min(Math.max(azEndPx.x, MARGIN + 22), SIZE - MARGIN - 22);
    var znLabelY = Math.min(Math.max(azEndPx.y - 8, 14), SIZE - 6);

    var clipId = 'plotClipSingle';
    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of assumed position, azimuth, and line of position">' +
        buildFrame(opts.apLat, opts.apLon, scale, clipId) +
        '<defs><marker id="azArrow" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="var(--chart-az)"/></marker></defs>' +
        '<g clip-path="url(#' + clipId + ')">' +
          '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="var(--chart-lop)" stroke-width="2.5"/>' +
          '<line x1="' + apPx.x + '" y1="' + apPx.y + '" x2="' + azEndPx.x + '" y2="' + azEndPx.y + '" stroke="var(--chart-az)" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#azArrow)"/>' +
        '</g>' +
        '<circle cx="' + interceptPx.x + '" cy="' + interceptPx.y + '" r="3.5" fill="var(--chart-lop)"/>' +
        '<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="4.5" fill="var(--text)"/>' +
        '<text x="' + (apPx.x + 8) + '" y="' + (apPx.y - 8) + '" class="chart-point-label">AP</text>' +
        '<text x="' + znLabelX + '" y="' + znLabelY + '" text-anchor="middle" class="chart-az-label">Zn ' + znLabel + '</text>' +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, znLabel: znLabel, interceptText: interceptAbs + ' nm ' + interceptDir };
  }

  /**
   * sightingsInput = [{ lat, lon, zn, interceptNM, label, color?, badgeNumber? }]
   *   color/badgeNumber optional -- default to a palette cycle / 1-based
   *   position if omitted. A caller (e.g. fixes.js) that wants a sighting's
   *   plotted color to stay stable even when other sightings are skipped
   *   should pass both explicitly, keyed off that sighting's position in
   *   its own full list rather than the filtered/plotted subset.
   *
   * Returns { scaleNM, legend: [{ index, color, label, znText, interceptText }] }
   */
  function renderMultiSightChart(container, sightingsInput, opts) {
    opts = opts || {};

    var withColor = sightingsInput.map(function (s, i) {
      var out = {};
      for (var key in s) { if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key]; }
      out.color = s.color || SightCalc.paletteColor(i);
      out.badgeNumber = (typeof s.badgeNumber === 'number') ? s.badgeNumber : (i + 1);
      return out;
    });

    var multiGeo = SightCalc.computeMultiLopGeometry(withColor);
    var scale = SightCalc.chooseNiceScale(multiGeo.maxExtentNM);
    var pxPerNm = HALF / scale;

    var clipId = 'plotClipMulti';
    var defs = '<defs>';
    var lopLines = '';
    var azimuthLines = '';
    var markers = '';
    var legend = [];

    multiGeo.sightings.forEach(function (s) {
      var idx = s.badgeNumber;
      var apPx = toPx(s.apPoint, pxPerNm);
      var azEndPx = toPx({ x: s.apPoint.x + s.azimuthUnit.x * scale, y: s.apPoint.y + s.azimuthUnit.y * scale }, pxPerNm);

      var lopExtendNm = scale * 2.2;
      var lopP1Px = toPx({
        x: s.interceptPoint.x + s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y + s.lopDirection.y * lopExtendNm
      }, pxPerNm);
      var lopP2Px = toPx({
        x: s.interceptPoint.x - s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y - s.lopDirection.y * lopExtendNm
      }, pxPerNm);

      defs += '<marker id="azArrowMulti' + idx + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
              '<path d="M0,0 L9,4.5 L0,9 Z" fill="' + s.color + '"/></marker>';

      lopLines +=
        '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="2.5"/>';

      azimuthLines +=
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
        znText: pad3(s.zn) + '\u00B0',
        interceptText: interceptAbs + ' nm ' + interceptDir
      });
    });

    // Bisector lines: best-practice cocked-hat method, generalized to any
    // number of LOPs >= 2 (see SightCalc.computeBisectors for the geometry).
    var bisectorLines = '';
    var bisectorInputs = multiGeo.sightings.map(function (s) {
      return { point: s.interceptPoint, direction: s.lopDirection };
    });
    var bisectors = SightCalc.computeBisectors(bisectorInputs);
    var bisectorExtendNm = scale * 1.1;
    bisectors.forEach(function (b) {
      var b1Px = toPx({ x: b.point.x + b.direction.x * bisectorExtendNm, y: b.point.y + b.direction.y * bisectorExtendNm }, pxPerNm);
      var b2Px = toPx({ x: b.point.x - b.direction.x * bisectorExtendNm, y: b.point.y - b.direction.y * bisectorExtendNm }, pxPerNm);
      bisectorLines += '<line x1="' + b1Px.x + '" y1="' + b1Px.y + '" x2="' + b2Px.x + '" y2="' + b2Px.y + '" stroke="var(--chart-bisector)" stroke-width="1.5" stroke-dasharray="1,3" stroke-linecap="round"/>';
    });

    defs += '</defs>';

    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of multiple lines of position">' +
        buildFrame(multiGeo.originLat, multiGeo.originLon, scale, clipId) +
        defs +
        '<g clip-path="url(#' + clipId + ')">' +
          lopLines +
          '<g class="chart-bisector-group">' + bisectorLines + '</g>' +
          '<g class="chart-azimuth-group">' + azimuthLines + '</g>' +
        '</g>' +
        markers +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, legend: legend, bisectorCount: bisectors.length };
  }

  global.SightChart = {
    renderSightChart: renderSightChart,
    renderMultiSightChart: renderMultiSightChart
  };
})(window);
