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
  var EDGE = 6;             // tiny inset so the 1.5px border stroke isn't clipped by the viewBox edge
  var CENTER = SIZE / 2;
  var HALF = SIZE / 2 - EDGE;   // plot area half-width -- nearly the full viewBox now that
                                 // lat/lon labels render inside the grid instead of in a margin
  var PLOT_MIN = EDGE;
  var PLOT_MAX = SIZE - EDGE;
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
   * Builds the shared square frame: border, lat/lon gridlines, and a
   * clipPath (id clipId) other content can be clipped to. Edge/center
   * lat/lon values are labeled INSIDE the grid (longitude along the top,
   * latitude along the left) rather than in an outer margin, so the grid
   * itself can use nearly the entire viewBox -- .chart-axis-label carries a
   * card-colored text stroke (a "halo") so the labels stay legible sitting
   * on top of gridlines or plotted content. Returns an SVG markup string.
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

        // Longitude labels: always along the top inside edge, one row.
        // West/east are anchored away from their corner so they can't run
        // off the grid; center is anchored on it.
        var lonAnchor = (f === -1) ? 'start' : (f === 1 ? 'end' : 'middle');
        var lonX = (f === -1) ? PLOT_MIN + 4 : (f === 1 ? PLOT_MAX - 4 : px);
        svg += '<text x="' + lonX + '" y="' + (PLOT_MIN + 13) + '" text-anchor="' + lonAnchor + '" class="chart-axis-label">' + formatLon(lonHere) + '</text>';

        // Latitude labels: always along the left inside edge, one column.
        // The north (f=1) label sits a line below the top row so it doesn't
        // collide with the west longitude label sharing that corner.
        var latY = (f === 1) ? (PLOT_MIN + 28) : (f === -1 ? PLOT_MAX - 6 : py + 3.5);
        svg += '<text x="' + (PLOT_MIN + 4) + '" y="' + latY + '" text-anchor="start" class="chart-axis-label">' + formatLat(latHere) + '</text>';
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

    var znLabelX = Math.min(Math.max(azEndPx.x, PLOT_MIN + 22), PLOT_MAX - 22);
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
   * opts = {
   *   showAzimuth: boolean (default true)   -- dashed azimuth-to-body lines
   *   showBisectors: boolean (default false) -- dotted "method of bisectors"
   *     construction lines (see SightCalc.resolveCockedHatBisectors). Also
   *     decides which candidate point is drawn/reported as "the Fix": the
   *     bisector incenter when true and resolvable, otherwise the
   *     least-squares point.
   * }
   *
   * Returns {
   *   scaleNM,
   *   legend: [{ index, color, label, znText, interceptText }],
   *   fix: { solvable: false, reason } | {
   *     solvable: true, source: 'bisector'|'least-squares', positionText,
   *     lat, lon, bisectorMaxSideNM?, bisectorBadgeNumbers?
   *   }
   * }
   */
  function renderMultiSightChart(container, sightingsInput, opts) {
    opts = opts || {};
    var showAzimuth = opts.showAzimuth !== false;
    var showBisectors = !!opts.showBisectors;

    var withColor = sightingsInput.map(function (s, i) {
      var out = {};
      for (var key in s) { if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key]; }
      out.color = s.color || SightCalc.paletteColor(i);
      out.badgeNumber = (typeof s.badgeNumber === 'number') ? s.badgeNumber : (i + 1);
      return out;
    });

    var multiGeo = SightCalc.computeMultiLopGeometry(withColor);
    var fixResult = SightCalc.resolveMultiLopFix(multiGeo.sightings);

    // Which point (if any) is actually drawn/reported as "the Fix" is
    // entirely driven by the bisector toggle: bisector incenter when on (and
    // resolvable), otherwise the least-squares point.
    var activeFixPoint = null;
    var bisectorGeom = null; // { vertices, incenter, maxSideNM, tripleIndices } when shown
    if (fixResult.solvable) {
      if (showBisectors && fixResult.bisector) {
        activeFixPoint = fixResult.bisector.incenter;
        bisectorGeom = fixResult.bisector;
      } else {
        activeFixPoint = fixResult.leastSquaresPoint;
      }
    }

    var maxExtentNM = multiGeo.maxExtentNM;
    if (activeFixPoint) maxExtentNM = Math.max(maxExtentNM, Math.hypot(activeFixPoint.x, activeFixPoint.y));
    if (bisectorGeom) {
      bisectorGeom.vertices.forEach(function (v) {
        maxExtentNM = Math.max(maxExtentNM, Math.hypot(v.x, v.y));
      });
    }

    var scale = SightCalc.chooseNiceScale(maxExtentNM);
    var pxPerNm = HALF / scale;

    var clipId = 'plotClipMulti';
    var defs = '<defs>';
    var clippedLines = '';
    var markers = '';
    var legend = [];

    multiGeo.sightings.forEach(function (s) {
      var idx = s.badgeNumber;
      var apPx = toPx(s.apPoint, pxPerNm);

      var lopExtendNm = scale * 2.2;
      var lopP1Px = toPx({
        x: s.interceptPoint.x + s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y + s.lopDirection.y * lopExtendNm
      }, pxPerNm);
      var lopP2Px = toPx({
        x: s.interceptPoint.x - s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y - s.lopDirection.y * lopExtendNm
      }, pxPerNm);

      clippedLines +=
        '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="2.5"/>';

      if (showAzimuth) {
        var azEndPx = toPx({ x: s.apPoint.x + s.azimuthUnit.x * scale, y: s.apPoint.y + s.azimuthUnit.y * scale }, pxPerNm);
        defs += '<marker id="azArrowMulti' + idx + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
                '<path d="M0,0 L9,4.5 L0,9 Z" fill="' + s.color + '"/></marker>';
        clippedLines +=
          '<line x1="' + apPx.x + '" y1="' + apPx.y + '" x2="' + azEndPx.x + '" y2="' + azEndPx.y + '" stroke="' + s.color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#azArrowMulti' + idx + ')"/>';
      }

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

    if (bisectorGeom) {
      var incenterPx = toPx(bisectorGeom.incenter, pxPerNm);
      bisectorGeom.vertices.forEach(function (v) {
        var vPx = toPx(v, pxPerNm);
        clippedLines += '<line x1="' + vPx.x + '" y1="' + vPx.y + '" x2="' + incenterPx.x + '" y2="' + incenterPx.y +
          '" stroke="var(--chart-bisector)" stroke-width="1.5" stroke-dasharray="1,3" stroke-linecap="round"/>';
      });
    }

    var fixMarkup = '';
    var fix = fixResult.solvable ? { solvable: true } : { solvable: false, reason: fixResult.reason };

    if (activeFixPoint) {
      var fixPx = toPx(activeFixPoint, pxPerNm);
      fixMarkup =
        '<g>' +
          '<circle cx="' + fixPx.x + '" cy="' + fixPx.y + '" r="6" fill="none" stroke="var(--chart-fix)" stroke-width="2"/>' +
          '<line x1="' + (fixPx.x - 9) + '" y1="' + fixPx.y + '" x2="' + (fixPx.x + 9) + '" y2="' + fixPx.y + '" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
          '<line x1="' + fixPx.x + '" y1="' + (fixPx.y - 9) + '" x2="' + fixPx.x + '" y2="' + (fixPx.y + 9) + '" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
        '</g>';

      var pos = SightCalc.positionFromOffset(multiGeo.originLat, multiGeo.originLon, activeFixPoint);
      fix.source = bisectorGeom ? 'bisector' : 'least-squares';
      fix.lat = pos.lat;
      fix.lon = pos.lon;
      fix.positionText = formatLat(pos.lat) + ' ' + formatLon(pos.lon);
    }

    // Reported regardless of the toggle, if a triangle exists, so the caller
    // can always show fix quality/selection context -- not just when the
    // bisector lines happen to be visible.
    if (fixResult.bisector) {
      fix.bisectorMaxSideNM = fixResult.bisector.maxSideNM;
      fix.bisectorBadgeNumbers = fixResult.bisector.tripleIndices.map(function (idx) {
        return multiGeo.sightings[idx].badgeNumber;
      });
    }

    defs += '</defs>';

    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of multiple lines of position">' +
        buildFrame(multiGeo.originLat, multiGeo.originLon, scale, clipId) +
        defs +
        '<g clip-path="url(#' + clipId + ')">' + clippedLines + '</g>' +
        markers +
        fixMarkup +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, legend: legend, fix: fix };
  }

  global.SightChart = {
    renderSightChart: renderSightChart,
    renderMultiSightChart: renderMultiSightChart
  };
})(window);
