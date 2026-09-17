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
 *   - renderSightChart()      -- one sight (index.html's Plot card)
 *   - renderMultiSightChart() -- several sights overlaid (a Fix's plot)
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

    // opts.viewport = {originLat, originLon, scale} (optional, semantic
    // zoom/pan -- see chartPanZoom.js and the matching comment in
    // renderMultiSightChart): when given, used instead of always
    // auto-centering on the AP itself. geo's own points are relative to
    // the AP (geo.ap is always {0,0}), so re-expressing them relative to a
    // DIFFERENT origin just means adding the AP's own offset from that
    // origin to each of them first.
    var autoScale = SightCalc.chooseNiceScale(opts.interceptNM);
    var originLat = opts.viewport ? opts.viewport.originLat : opts.apLat;
    var originLon = opts.viewport ? opts.viewport.originLon : opts.apLon;
    var scale = opts.viewport ? opts.viewport.scale : autoScale;
    var pxPerNm = HALF / scale;

    var apOffsetFromOrigin = SightCalc.offsetFromPosition(originLat, originLon, opts.apLat, opts.apLon);
    function reexpress(nmPoint) {
      return { x: nmPoint.x + apOffsetFromOrigin.x, y: nmPoint.y + apOffsetFromOrigin.y };
    }

    var apPx = toPx(reexpress(geo.ap), pxPerNm);
    var azEndPx = toPx(reexpress({ x: geo.azimuthUnit.x * scale, y: geo.azimuthUnit.y * scale }), pxPerNm);

    var lopExtendNm = scale * 2.2;
    var lopP1Px = toPx(reexpress({
      x: geo.interceptPoint.x + geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y + geo.lopDirection.y * lopExtendNm
    }), pxPerNm);
    var lopP2Px = toPx(reexpress({
      x: geo.interceptPoint.x - geo.lopDirection.x * lopExtendNm,
      y: geo.interceptPoint.y - geo.lopDirection.y * lopExtendNm
    }), pxPerNm);

    var interceptPx = toPx(reexpress(geo.interceptPoint), pxPerNm);
    var znLabel = pad3(opts.zn) + '\u00B0';
    var interceptAbs = Math.abs(opts.interceptNM).toFixed(1);
    var interceptDir = opts.interceptNM >= 0 ? 'TOWARD' : 'AWAY';

    var znLabelX = Math.min(Math.max(azEndPx.x, PLOT_MIN + 22), PLOT_MAX - 22);
    var znLabelY = Math.min(Math.max(azEndPx.y - 8, 14), SIZE - 6);

    var clipId = 'plotClipSingle';
    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of assumed position, azimuth, and line of position">' +
        buildFrame(originLat, originLon, scale, clipId) +
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

    return {
      scaleNM: scale, autoScaleNM: autoScale,
      originLat: originLat, originLon: originLon,
      autoOriginLat: opts.apLat, autoOriginLon: opts.apLon,
      znLabel: znLabel, interceptText: interceptAbs + ' nm ' + interceptDir
    };
  }

  /**
   * sightsInput = [{ lat, lon, zn, interceptNM, label, color?, badgeNumber?,
   *   chartLabel?, transferLabel?, drTrackLabel?, originalLat?, originalLon? }]
   *   color/badgeNumber optional -- default to a palette cycle / 1-based
   *   position if omitted. A caller (e.g. fixes.js) that wants a sight's
   *   plotted color to stay stable even when other sights are skipped
   *   should pass both explicitly, keyed off that sight's position in
   *   its own full list rather than the filtered/plotted subset.
   *   chartLabel/transferLabel/drTrackLabel are pre-formatted strings (this
   *   file only renders labels, never formats body names or times --
   *   fixes.js does that, per standard USCG/commercial celestial-LOP
   *   plotting convention: chartLabel for an ordinary LOP is "SUN 0915";
   *   transferLabel for an advanced/running-fix LOP is "SUN 0915-1200").
   *
   * opts = {
   *   showAzimuth: boolean (default true)   -- dashed azimuth-to-body lines
   *   showBisectors: boolean (default false) -- dotted "method of bisectors"
   *     construction lines (see SightCalc.resolveCockedHatBisectors). Also
   *     decides which candidate point is drawn/reported as "the Fix": the
   *     bisector incenter when true and resolvable, otherwise the
   *     least-squares point.
   *   fixTimeLabel: string|null -- pre-formatted 4-digit time (e.g. "0630")
   *     for the fix marker's own label, per convention. Omit/null to leave
   *     the fix circle unlabeled.
   * }
   *
   * Returns {
   *   scaleNM,
   *   legend: [{ index, color, label, znText, interceptText, advanced }],
   *   fix: { solvable: false, reason } | {
   *     solvable: true, source: 'bisector'|'least-squares', positionText,
   *     lat, lon, isRunningFix, bisectorMaxSideNM?, bisectorBadgeNumbers?
   *   }
   * }
   */
  /**
   * Standard plotting convention: labels stay horizontal (never rotated to
   * match a line's angle) and connect back to the point they describe with
   * a short leader line.
   *
   * normalUnitNm MUST be the true perpendicular of whatever's being
   * labeled (an LOP's is exactly s.azimuthUnit, since an LOP is
   * perpendicular to its azimuth by definition -- not derived from some
   * other nearby point, which was the earlier bug: offsetting away from
   * the AP isn't the same as offsetting away from the LINE, and for a
   * large intercept those two directions can end up nowhere near
   * perpendicular to each other).
   *
   * The offset itself is computed in PIXEL space with a fixed floor and
   * cap, scaled up by the label's own text length in between -- also
   * earlier bugs: an nm-space offset shrinks along with the chart's
   * scale/zoom instead of staying a legible fixed size, and a
   * fixed-but-small offset clears a line fine for a short label but not
   * a long one, since text-anchor="middle" text extends in BOTH
   * directions from the offset point regardless of which way the line
   * runs -- a long label needs more clearance than a short one to avoid
   * its own far edge swinging back across the line, especially for a
   * steep/near-vertical line where the perpendicular offset is mostly
   * horizontal, the same direction the text extends in. The cap plus the
   * position clamp below exist because scaling the offset with text
   * length alone isn't enough on its own: a long enough label (e.g. a
   * midnight-spanning advanced-LOP caption) can end up offset clear
   * outside the chart's fixed viewBox if an anchor point happens to sit
   * near an edge already.
   *
   * Module-level (not local to one render function) since any chart type
   * needs the same treatment -- pxPerNm is passed explicitly rather than
   * captured from a closure, since it's a different value per render call.
   */
  function placeLabel(anchorNm, normalUnitNm, text, colorHex, cssClass, pxPerNm) {
    var estimatedHalfWidthPx = text.length * 3; // ~9px bold sans average char width / 2, plus margin folded in below
    var offsetPx = Math.min(70, Math.max(18, estimatedHalfWidthPx + 8));

    var anchorPx = toPx(anchorNm, pxPerNm);
    // toPx flips y (north-up nm space -> screen-down px space), so the
    // direction vector needs the same flip to point the same way on screen.
    var dirPx = { x: normalUnitNm.x, y: -normalUnitNm.y };
    var dirLen = Math.hypot(dirPx.x, dirPx.y) || 1;
    dirPx = { x: dirPx.x / dirLen, y: dirPx.y / dirLen };

    var labelPx = { x: anchorPx.x + dirPx.x * offsetPx, y: anchorPx.y + dirPx.y * offsetPx };

    // Clamp the label itself (not the leader line's start, which stays
    // pinned to the true anchor on the line) to stay fully inside the
    // viewBox -- text-anchor="middle" means the text extends roughly
    // estimatedHalfWidthPx in BOTH x directions from labelPx.x, so the
    // clamp margin has to account for that, not just pull labelPx.x
    // itself inside the box.
    var xMargin = Math.min(estimatedHalfWidthPx + 4, SIZE / 2 - 2);
    labelPx.x = Math.max(xMargin, Math.min(SIZE - xMargin, labelPx.x));
    labelPx.y = Math.max(14, Math.min(SIZE - 6, labelPx.y));

    return (
      '<line x1="' + anchorPx.x + '" y1="' + anchorPx.y + '" x2="' + labelPx.x + '" y2="' + labelPx.y + '" stroke="' + colorHex + '" stroke-width="1"/>' +
      '<text x="' + labelPx.x + '" y="' + (labelPx.y - 4) + '" text-anchor="middle" class="' + cssClass + '" fill="' + colorHex + '">' + text + '</text>'
    );
  }

  /**
   * Selection support (chartInteraction.js): every selectable plotted
   * element carries data-select-type/id/part so a generic, chart-agnostic
   * hit-tester (document.elementsFromPoint) can identify what was tapped
   * without this file or that one needing to know what the other means by
   * a "sight" or a "fix" -- chart.js only stamps identity, chartInteraction.js
   * only reports it, and the calling page supplies what it actually means.
   *
   * data-select-label is a display FALLBACK for the generic disambiguation
   * list only (e.g. "AP -- Sight 2") -- not authoritative content. Once a
   * single selection resolves, the calling page supplies the real detail
   * via its own getDetail callback; this file has no opinion on that.
   *
   * Each selectable line also gets a second, much wider, fully transparent
   * stroke layered in the same place purely as a hit target -- thin LOP
   * strokes (2.5px) are hard to tap precisely on a phone; pointer-events
   * is set explicitly to "stroke" so the transparent stroke is still
   * hit-testable (an SVG shape with no visible paint is otherwise not
   * guaranteed hit-testable by default in every browser).
   */
  function selectAttrs(type, recordId, part, label) {
    var esc = function (s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;'); };
    return 'data-select-type="' + esc(type) + '" data-select-id="' + esc(recordId) + '"' +
      (part ? ' data-select-part="' + esc(part) + '"' : '') +
      (label ? ' data-select-label="' + esc(label) + '"' : '');
  }
  function isSelected(selected, type, recordId, part) {
    return !!selected && selected.type === type && String(selected.recordId) === String(recordId) &&
      (selected.part || undefined) === (part || undefined);
  }
  function hitLine(x1, y1, x2, y2, attrsStr) {
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
      '" stroke="transparent" stroke-width="16" pointer-events="stroke" style="cursor:pointer" ' + attrsStr + '/>';
  }

  function renderMultiSightChart(container, sightsInput, opts) {
    opts = opts || {};
    var showAzimuth = opts.showAzimuth !== false;
    var showBisectors = !!opts.showBisectors;
    var selected = opts.selected || null;

    var withColor = sightsInput.map(function (s, i) {
      var out = {};
      for (var key in s) { if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key]; }
      out.color = s.color || SightCalc.paletteColor(i);
      out.badgeNumber = (typeof s.badgeNumber === 'number') ? s.badgeNumber : (i + 1);
      return out;
    });

    // The TRUE auto-fit origin -- the average of the sights' own positions,
    // matching what computeMultiLopGeometry computes internally when no
    // origin override is given. Computed directly here (not by calling
    // computeMultiLopGeometry a second time without the override, which
    // would needlessly redo all the per-sight geometry) specifically so
    // "reset to fit" has a real origin to reset TO, even while a viewport
    // override is currently active -- multiGeo.originLat/Lon below reflects
    // whichever origin is actually in effect, which is the override once
    // one exists, not the auto-fit position.
    var autoOriginLat = withColor.length ? withColor.reduce(function (sum, s) { return sum + s.lat; }, 0) / withColor.length : 0;
    var autoOriginLon = withColor.length ? withColor.reduce(function (sum, s) { return sum + s.lon; }, 0) / withColor.length : 0;

    // opts.viewport = {originLat, originLon, scale} (all optional, semantic
    // zoom/pan -- see chartPanZoom.js): when given, this render uses THAT
    // geographic viewport instead of always auto-fitting to the data. Every
    // point below is computed relative to whichever origin is actually in
    // effect, so panning/zooming genuinely re-derives positions rather than
    // visually stretching a fixed-scale render -- which is what actually
    // lets two close-but-distinct points resolve into visually separate
    // ones as you zoom in, since their pixel separation grows with pxPerNm
    // while marker/stroke sizes stay fixed pixel values, unlike a CSS
    // transform (where separation and marker size scale together and stay
    // in the same proportion at any zoom level).
    var originOverride = opts.viewport ? { lat: opts.viewport.originLat, lon: opts.viewport.originLon } : null;
    var multiGeo = SightCalc.computeMultiLopGeometry(withColor, originOverride);
    var fixResult = SightCalc.resolveMultiLopFix(multiGeo.sights);

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

    // The auto-fit scale is always computed (even under a viewport
    // override) so it can be handed back to the caller as the "reset to
    // fit" baseline -- see the returned autoFit below.
    var autoScale = SightCalc.chooseNiceScale(maxExtentNM);
    var scale = opts.viewport ? opts.viewport.scale : autoScale;
    var pxPerNm = HALF / scale;

    var clipId = 'plotClipMulti';
    var defs = '<defs>';
    var clippedLines = '';
    var markers = '';
    var legend = [];

    multiGeo.sights.forEach(function (s) {
      var idx = s.badgeNumber;
      var apPx = toPx(s.apPoint, pxPerNm);
      var isAdvanced = !!s.originalApPoint;
      var lopExtendNm = scale * 2.2;
      var labelAnchorNm = { x: s.interceptPoint.x + s.lopDirection.x * (scale * 0.55), y: s.interceptPoint.y + s.lopDirection.y * (scale * 0.55) };

      // The main LOP line -- as-observed if this sight hasn't been
      // advanced, or the transferred/advanced LOP if it has (s.interceptPoint
      // is already anchored at the advanced AP either way -- see
      // computeMultiLopGeometry). Convention (per USCG/RYA piloting
      // practice): a transferred LOP is drawn parallel to the original,
      // marked with double arrowheads at each end, and labeled with both
      // times it spans -- distinct from an ordinary LOP's single
      // end-of-line arrow.
      var lopP1Px = toPx({
        x: s.interceptPoint.x + s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y + s.lopDirection.y * lopExtendNm
      }, pxPerNm);
      var lopP2Px = toPx({
        x: s.interceptPoint.x - s.lopDirection.x * lopExtendNm,
        y: s.interceptPoint.y - s.lopDirection.y * lopExtendNm
      }, pxPerNm);

      if (isAdvanced) {
        defs += '<marker id="transferArrow' + idx + '" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto">' +
                '<path d="M0,0 L8,4 L0,8 Z" fill="' + s.color + '"/></marker>';
        var advSelected = isSelected(selected, 'lop', s.id, 'advanced');
        clippedLines +=
          (advSelected ? '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="7" stroke-opacity="0.35"/>' : '') +
          hitLine(lopP1Px.x, lopP1Px.y, lopP2Px.x, lopP2Px.y, selectAttrs('lop', s.id, 'advanced', (s.label || 'Sight ' + idx) + ' \u2014 advanced LOP')) +
          '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y +
          '" stroke="' + s.color + '" stroke-width="2.5" stroke-dasharray="7,5" ' +
          'marker-start="url(#transferArrow' + idx + ')" marker-end="url(#transferArrow' + idx + ')"/>';

        // The original, as-observed LOP -- solid, same as any ordinary LOP,
        // through the ORIGINAL AP's intercept offset (same lopDirection:
        // advancing is a pure parallel translation, so both lines are
        // parallel by construction).
        var origLopP1Px = toPx({
          x: s.originalInterceptPoint.x + s.lopDirection.x * lopExtendNm,
          y: s.originalInterceptPoint.y + s.lopDirection.y * lopExtendNm
        }, pxPerNm);
        var origLopP2Px = toPx({
          x: s.originalInterceptPoint.x - s.lopDirection.x * lopExtendNm,
          y: s.originalInterceptPoint.y - s.lopDirection.y * lopExtendNm
        }, pxPerNm);
        var origSelected = isSelected(selected, 'lop', s.id, 'original');
        clippedLines +=
          (origSelected ? '<line x1="' + origLopP1Px.x + '" y1="' + origLopP1Px.y + '" x2="' + origLopP2Px.x + '" y2="' + origLopP2Px.y + '" stroke="' + s.color + '" stroke-width="7" stroke-opacity="0.35"/>' : '') +
          hitLine(origLopP1Px.x, origLopP1Px.y, origLopP2Px.x, origLopP2Px.y, selectAttrs('lop', s.id, 'original', (s.label || 'Sight ' + idx) + ' \u2014 original LOP')) +
          '<line x1="' + origLopP1Px.x + '" y1="' + origLopP1Px.y + '" x2="' + origLopP2Px.x + '" y2="' + origLopP2Px.y +
          '" stroke="' + s.color + '" stroke-width="2.5"/>';

        // The DR track connecting the original AP to the advanced AP --
        // same dashed-with-single-arrow style as an azimuth line (a DR
        // track and an azimuth line are visually the same kind of thing:
        // a directional dashed line with one arrowhead at the destination),
        // but along the actual course run rather than toward the body.
        var origApPx = toPx(s.originalApPoint, pxPerNm);
        defs += '<marker id="drTrackArrow' + idx + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
                '<path d="M0,0 L9,4.5 L0,9 Z" fill="' + s.color + '"/></marker>';
        clippedLines +=
          '<line x1="' + origApPx.x + '" y1="' + origApPx.y + '" x2="' + apPx.x + '" y2="' + apPx.y +
          '" stroke="' + s.color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#drTrackArrow' + idx + ')"/>';

        // Original AP: a small hollow circle (not the filled badge -- the
        // badge belongs at the position this sight actually contributes
        // to the fix, i.e. the advanced one).
        var origApSelected = isSelected(selected, 'sight', s.id, 'originalAp');
        markers +=
          (origApSelected ? '<circle cx="' + origApPx.x + '" cy="' + origApPx.y + '" r="9" fill="' + s.color + '" fill-opacity="0.3"/>' : '') +
          '<circle cx="' + origApPx.x + '" cy="' + origApPx.y + '" r="9" fill="transparent" pointer-events="fill" style="cursor:pointer" ' +
            selectAttrs('sight', s.id, 'originalAp', (s.label || 'Sight ' + idx) + ' \u2014 original AP') + '/>' +
          '<circle cx="' + origApPx.x + '" cy="' + origApPx.y + '" r="5" fill="none" stroke="' + s.color + '" stroke-width="2"/>';

        // Labels: the transferred LOP is labeled per convention (body name,
        // original time, en dash, advanced time -- e.g. "SUN 0915-1200"),
        // offset along the LOP's own normal (=azimuthUnit, guaranteed
        // perpendicular to the line -- see placeLabel), away from the body
        // direction so it doesn't collide with the azimuth arrow. The DR
        // track gets its own caption from fixes.js, offset along the
        // track's own normal instead, since the track isn't an LOP and has
        // no azimuthUnit of its own.
        if (s.transferLabel) {
          var lopNormal = { x: -s.azimuthUnit.x, y: -s.azimuthUnit.y };
          clippedLines += placeLabel(labelAnchorNm, lopNormal, s.transferLabel, s.color, 'chart-transfer-label', pxPerNm);
        }
        if (s.drTrackLabel) {
          var midDrNm = { x: (s.originalApPoint.x + s.apPoint.x) / 2, y: (s.originalApPoint.y + s.apPoint.y) / 2 };
          var trackDx = s.apPoint.x - s.originalApPoint.x, trackDy = s.apPoint.y - s.originalApPoint.y;
          var trackLen = Math.hypot(trackDx, trackDy) || 1;
          var trackNormal = { x: -trackDy / trackLen, y: trackDx / trackLen };
          clippedLines += placeLabel(midDrNm, trackNormal, s.drTrackLabel, s.color, 'chart-transfer-label', pxPerNm);
        }
      } else {
        var ordSelected = isSelected(selected, 'lop', s.id, undefined);
        clippedLines +=
          (ordSelected ? '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="7" stroke-opacity="0.35"/>' : '') +
          hitLine(lopP1Px.x, lopP1Px.y, lopP2Px.x, lopP2Px.y, selectAttrs('lop', s.id, undefined, s.label || ('Sight ' + idx))) +
          '<line x1="' + lopP1Px.x + '" y1="' + lopP1Px.y + '" x2="' + lopP2Px.x + '" y2="' + lopP2Px.y + '" stroke="' + s.color + '" stroke-width="2.5"/>';

        // Standard celestial-LOP label -- body name plus 4-digit time (e.g.
        // "SUN 0915") -- never the time alone, so a multi-body fix stays
        // legible. Offset along the LOP's own normal, away from the body
        // direction, same reasoning as the advanced case above.
        if (s.chartLabel) {
          var ordinaryNormal = { x: -s.azimuthUnit.x, y: -s.azimuthUnit.y };
          clippedLines += placeLabel(labelAnchorNm, ordinaryNormal, s.chartLabel, s.color, 'chart-lop-label', pxPerNm);
        }
      }

      if (showAzimuth) {
        var azEndPx = toPx({ x: s.apPoint.x + s.azimuthUnit.x * scale, y: s.apPoint.y + s.azimuthUnit.y * scale }, pxPerNm);
        defs += '<marker id="azArrowMulti' + idx + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto">' +
                '<path d="M0,0 L9,4.5 L0,9 Z" fill="' + s.color + '"/></marker>';
        clippedLines +=
          '<line x1="' + apPx.x + '" y1="' + apPx.y + '" x2="' + azEndPx.x + '" y2="' + azEndPx.y + '" stroke="' + s.color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#azArrowMulti' + idx + ')"/>';
      }

      var apSelected = isSelected(selected, 'sight', s.id, 'ap');
      markers +=
        (apSelected ? '<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="13" fill="' + s.color + '" fill-opacity="0.3"/>' : '') +
        '<circle cx="' + apPx.x + '" cy="' + apPx.y + '" r="9" fill="' + s.color + '" stroke="var(--bg)" stroke-width="1.5" pointer-events="fill" style="cursor:pointer" ' +
          selectAttrs('sight', s.id, 'ap', (s.label || 'Sight ' + idx) + (isAdvanced ? ' \u2014 advanced AP' : ' \u2014 AP')) + '/>' +
        '<text x="' + apPx.x + '" y="' + (apPx.y + 3.5) + '" text-anchor="middle" class="chart-badge-label">' + idx + '</text>';

      var interceptAbs = Math.abs(s.interceptNM).toFixed(1);
      var interceptDir = s.interceptNM >= 0 ? 'TOWARD' : 'AWAY';
      legend.push({
        index: idx,
        color: s.color,
        label: s.label || ('Sight ' + idx),
        znText: pad3(s.zn) + '\u00B0',
        interceptText: interceptAbs + ' nm ' + interceptDir,
        advanced: isAdvanced
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
      // Standard convention: circle the fix, label it horizontally with the
      // time -- plus "R FIX" when it's a running fix (i.e. any plotted
      // sight was advanced), distinguishing it from a simultaneous fix at a
      // glance the same way a paper chart would.
      var isRunningFix = multiGeo.sights.some(function (s) { return !!s.originalApPoint; });
      var fixLabelText = opts.fixTimeLabel ? (opts.fixTimeLabel + (isRunningFix ? ' R FIX' : '')) : '';
      var fixSelected = opts.fixId && isSelected(selected, 'fix', opts.fixId, 'marker');
      fixMarkup =
        '<g>' +
          (fixSelected ? '<circle cx="' + fixPx.x + '" cy="' + fixPx.y + '" r="13" fill="var(--chart-fix)" fill-opacity="0.25"/>' : '') +
          (opts.fixId ? '<circle cx="' + fixPx.x + '" cy="' + fixPx.y + '" r="10" fill="transparent" pointer-events="fill" style="cursor:pointer" ' +
            selectAttrs('fix', opts.fixId, 'marker', 'Fix' + (fixLabelText ? ' \u2014 ' + fixLabelText : '')) + '/>' : '') +
          '<circle cx="' + fixPx.x + '" cy="' + fixPx.y + '" r="6" fill="none" stroke="var(--chart-fix)" stroke-width="2"/>' +
          '<line x1="' + (fixPx.x - 9) + '" y1="' + fixPx.y + '" x2="' + (fixPx.x + 9) + '" y2="' + fixPx.y + '" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
          '<line x1="' + fixPx.x + '" y1="' + (fixPx.y - 9) + '" x2="' + fixPx.x + '" y2="' + (fixPx.y + 9) + '" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
          (fixLabelText ? '<text x="' + (fixPx.x + 14) + '" y="' + (fixPx.y + 4) + '" text-anchor="start" class="chart-fix-label">' + fixLabelText + '</text>' : '') +
        '</g>';

      var pos = SightCalc.positionFromOffset(multiGeo.originLat, multiGeo.originLon, activeFixPoint);
      fix.source = bisectorGeom ? 'bisector' : 'least-squares';
      fix.lat = pos.lat;
      fix.lon = pos.lon;
      fix.positionText = formatLat(pos.lat) + ' ' + formatLon(pos.lon);
      fix.isRunningFix = isRunningFix;
    }

    // Reported regardless of the toggle, if a triangle exists, so the caller
    // can always show fix quality/selection context -- not just when the
    // bisector lines happen to be visible.
    if (fixResult.bisector) {
      fix.bisectorMaxSideNM = fixResult.bisector.maxSideNM;
      fix.bisectorBadgeNumbers = fixResult.bisector.tripleIndices.map(function (idx) {
        return multiGeo.sights[idx].badgeNumber;
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

    return { scaleNM: scale, autoScaleNM: autoScale, autoOriginLat: autoOriginLat, autoOriginLon: autoOriginLon, originLat: multiGeo.originLat, originLon: multiGeo.originLon, legend: legend, fix: fix };
  }

  /**
   * Builds a filled semicircle path: flat diameter perpendicular to
   * dirAngleRad (straddling a course line at that angle), dome bulging out
   * in the +dirAngleRad direction. Approximated with line segments rather
   * than an SVG arc command specifically to avoid reasoning about arc
   * sweep-flag direction analytically (easy to get backwards without
   * visual feedback to check it against); a 10-segment approximation is
   * visually indistinguishable from a true arc at this size.
   */
  function semicirclePath(cx, cy, r, dirAngleRad) {
    var steps = 10;
    var d = '';
    for (var i = 0; i <= steps; i++) {
      var t = (i / steps) * Math.PI - Math.PI / 2; // -90deg..+90deg relative to dirAngleRad
      var angle = dirAngleRad + t;
      var x = cx + r * Math.cos(angle), y = cy + r * Math.sin(angle);
      d += (i === 0 ? 'M ' : 'L ') + x + ',' + y + ' ';
    }
    return d + 'Z';
  }

  /**
   * opts = {
   *   startLat, startLon, endLat, endLon,   -- signed decimal degrees
   *   startSourceType,                       -- 'FIX' | 'KNOWN' | 'DR' --
   *     drives which symbol marks the start: a departure/known position or
   *     an actual Fix is marked the same way Bowditch marks a fix (circle,
   *     horizontal time label); a start chained from an earlier DR leg is
   *     itself a DR position (semicircle, diagonal time label). The
   *     endpoint this leg computes is always a DR position by definition.
   *   startTimeLabel, endTimeLabel            -- pre-formatted 4-digit
   *     24h time strings (no colon), per USCG convention -- caller's job
   *     to format, same division of labor as the caption text
   * }
   * A DR leg standing alone (not part of a Fix): a start point, an end
   * point, and the dashed single-arrow track between them, using the same
   * plotting symbols Bowditch specifies -- a circle for a fix/departure
   * position labeled horizontally with its time, a semicircle straddling
   * the course line for a DR position labeled diagonally with its time --
   * rather than plain circles captioned with the words "Start"/"DR".
   * Centered on the track's own midpoint rather than the start position,
   * so the track uses the full grid in both directions instead of being
   * confined to whichever single quadrant the course happens to point
   * into.
   */
  function renderDrLegChart(container, opts) {
    var startOffset = SightCalc.offsetFromPosition(opts.startLat, opts.startLon, opts.startLat, opts.startLon); // {0,0}, kept explicit for clarity
    var endOffsetFromStart = SightCalc.offsetFromPosition(opts.startLat, opts.startLon, opts.endLat, opts.endLon);
    var midOffsetFromStart = { x: (startOffset.x + endOffsetFromStart.x) / 2, y: (startOffset.y + endOffsetFromStart.y) / 2 };
    var autoOriginPos = SightCalc.positionFromOffset(opts.startLat, opts.startLon, midOffsetFromStart);

    // opts.viewport = {originLat, originLon, scale} (optional, semantic
    // zoom/pan -- see chartPanZoom.js and the matching comment in
    // renderMultiSightChart): when given, used instead of always
    // auto-centering on the track's own midpoint.
    var originPos = opts.viewport ? { lat: opts.viewport.originLat, lon: opts.viewport.originLon } : autoOriginPos;
    var originOffsetFromStart = SightCalc.offsetFromPosition(opts.startLat, opts.startLon, originPos.lat, originPos.lon);

    // Re-expressed relative to whichever origin is actually in effect, not
    // always the midpoint.
    var startNm = { x: startOffset.x - originOffsetFromStart.x, y: startOffset.y - originOffsetFromStart.y };
    var endNm = { x: endOffsetFromStart.x - originOffsetFromStart.x, y: endOffsetFromStart.y - originOffsetFromStart.y };

    // Auto-fit scale is always computed (even under a viewport override) so
    // it's available as the "reset to fit" baseline via the return value.
    var autoScale = SightCalc.chooseNiceScale(Math.hypot(startOffset.x - midOffsetFromStart.x, startOffset.y - midOffsetFromStart.y));
    var scale = opts.viewport ? opts.viewport.scale : autoScale;
    var pxPerNm = HALF / scale;

    var startPx = toPx(startNm, pxPerNm);
    var endPx = toPx(endNm, pxPerNm);

    var clipId = 'plotClipDrLeg';
    var color = 'var(--chart-dr)';

    // Course direction in PIXEL space (toPx flips y), used to orient the
    // semicircle(s) so their flat edge crosses the course line itself
    // rather than sitting at an arbitrary angle.
    var dirAngleRad = Math.atan2(endPx.y - startPx.y, endPx.x - startPx.x);

    var startIsDr = opts.startSourceType === 'DR';
    var startMarkup = startIsDr
      ? '<path d="' + semicirclePath(startPx.x, startPx.y, 6, dirAngleRad + Math.PI) + '" fill="var(--text)"/>' +
        '<text x="' + (startPx.x + 9) + '" y="' + (startPx.y - 9) + '" text-anchor="start" class="chart-point-label" style="font-style: italic;">' + (opts.startTimeLabel || '') + '</text>'
      : '<circle cx="' + startPx.x + '" cy="' + startPx.y + '" r="4.5" fill="var(--text)"/>' +
        '<text x="' + (startPx.x + 8) + '" y="' + (startPx.y - 8) + '" class="chart-point-label">' + (opts.startTimeLabel || '') + '</text>';

    // The DR annotation ("DR 0934-1834 · 135°T @ 10 kn · 90.0 NM", or
    // longer still spanning midnight) runs 40-55+ characters -- on a chart
    // this size and this simple (one track, nothing else competing for
    // space), that's often close to the chart's own pixel width. Trying to
    // fit it INSIDE the plot area with a leader line (as placeLabel does
    // for the much shorter per-LOP captions on the Fix page's chart) means
    // its own edge-clamping has nowhere to put it but the center, which can
    // land it squarely on top of the Start/DR point labels regardless of
    // the leg's actual course -- confirmed, not guessed: dumping the raw
    // SVG for a 135°/5kn/6h leg showed the caption's clamped x landing at
    // 177, right on top of the Start point at x=170. So it's not drawn
    // inside this SVG at all; the caller displays it as a caption below the
    // chart instead.
    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of dead reckoning track">' +
        buildFrame(originPos.lat, originPos.lon, scale, clipId) +
        '<defs><marker id="drLegArrow" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="' + color + '"/></marker></defs>' +
        '<g clip-path="url(#' + clipId + ')">' +
          '<line x1="' + startPx.x + '" y1="' + startPx.y + '" x2="' + endPx.x + '" y2="' + endPx.y +
          '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#drLegArrow)"/>' +
        '</g>' +
        startMarkup +
        // The endpoint this leg computes is always a DR position -- always
        // a semicircle, always a diagonal (italic) time label, per Bowditch's
        // "labels the fix time horizontally and the DR time diagonally".
        '<path d="' + semicirclePath(endPx.x, endPx.y, 6, dirAngleRad) + '" fill="' + color + '" stroke="var(--bg)" stroke-width="1"/>' +
        '<text x="' + (endPx.x + 9) + '" y="' + (endPx.y - 9) + '" text-anchor="start" class="chart-point-label" style="font-style: italic;">' + (opts.endTimeLabel || '') + '</text>' +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, autoScaleNM: autoScale, autoOriginLat: autoOriginPos.lat, autoOriginLon: autoOriginPos.lon, originLat: originPos.lat, originLon: originPos.lon };
  }

  /**
   * records = { sights, fixes, drLegs } (full records, e.g. from
   * passageStorage.js's getPassageRecords) -- everything belonging to one
   * Passage, plotted together as a single navigation track rather than
   * three separate charts. This is the first chart type built on top of
   * the selection contract (chart.js stamps identity, chartInteraction.js
   * reports it, the calling page supplies meaning) with THREE distinct
   * selectable record types sharing one plot, which is exactly the
   * "records <-> Navigation Plot" idea discussed for this page: each DR
   * leg, each resolved Fix, and each Sight not yet part of any Fix is
   * independently selectable, using the same generic hit-testing/
   * highlighting/detail-panel machinery already proven on the Fix page --
   * this file still has no idea what "Open DR Leg" means, only that
   * something with type "drleg" was tapped.
   *
   * A Sight already claimed by one of this passage's own Fixes is drawn as
   * part of that Fix instead (just the resolved point, not each
   * constituent LOP -- showing every LOP for every Fix across a multi-day
   * passage would be unreadable clutter, and the Fix page already exists
   * for that level of detail). Only a Sight NOT in any of this passage's
   * fixes gets its own marker here, at its AP alone (not its LOP line, for
   * the same decluttering reason) -- it represents "an observation taken
   * here, not yet resolved into a fix."
   *
   * opts = {
   *   startingPosition: {lat, lon} | null -- the Passage's own departure
   *     point, if set; drawn as a plain circle (a known/departure position,
   *     same convention as a DR leg's own start when it's not itself
   *     chained from an earlier DR position -- see renderDrLegChart).
   *   viewport, selected -- same contract as every other chart here.
   * }
   */
  function renderPassageChart(container, records, opts) {
    opts = opts || {};
    var selected = opts.selected || null;
    var drLegs = records.drLegs || [];
    var fixes = (records.fixes || []).filter(function (f) { return !!f.resolvedPosition; });
    var fixedSightIds = {};
    fixes.forEach(function (f) { (f.sightIds || []).forEach(function (id) { fixedSightIds[id] = true; }); });
    var unfixedSights = (records.sights || []).filter(function (s) { return !fixedSightIds[s.id]; });

    var points = [];
    drLegs.forEach(function (leg) {
      points.push({ lat: leg.startPosition.lat, lon: leg.startPosition.lon });
      points.push({ lat: leg.endPosition.lat, lon: leg.endPosition.lon });
    });
    fixes.forEach(function (f) { points.push({ lat: f.resolvedPosition.lat, lon: f.resolvedPosition.lon }); });
    unfixedSights.forEach(function (s) {
      var pos = SightCalc.signedPositionFromRecord(s.position);
      points.push({ lat: pos.lat, lon: pos.lon });
    });
    if (opts.startingPosition) points.push({ lat: opts.startingPosition.lat, lon: opts.startingPosition.lon });

    var clipId = 'plotClipPassage';
    if (points.length === 0) {
      container.innerHTML =
        '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Empty passage plot">' +
          buildFrame(0, 0, 10, clipId) +
        '</svg>';
      return { scaleNM: 10, autoScaleNM: 10, originLat: 0, originLon: 0, autoOriginLat: 0, autoOriginLon: 0 };
    }

    var autoOriginLat = points.reduce(function (sum, p) { return sum + p.lat; }, 0) / points.length;
    var autoOriginLon = points.reduce(function (sum, p) { return sum + p.lon; }, 0) / points.length;

    var maxExtentNM = 0;
    points.forEach(function (p) {
      var off = SightCalc.offsetFromPosition(autoOriginLat, autoOriginLon, p.lat, p.lon);
      maxExtentNM = Math.max(maxExtentNM, Math.hypot(off.x, off.y));
    });
    var autoScale = SightCalc.chooseNiceScale(maxExtentNM);

    var originLat = opts.viewport ? opts.viewport.originLat : autoOriginLat;
    var originLon = opts.viewport ? opts.viewport.originLon : autoOriginLon;
    var scale = opts.viewport ? opts.viewport.scale : autoScale;
    var pxPerNm = HALF / scale;

    function pxFromLatLon(lat, lon) {
      return toPx(SightCalc.offsetFromPosition(originLat, originLon, lat, lon), pxPerNm);
    }

    var defs = '<defs>';
    var content = '';
    var markers = '';

    if (opts.startingPosition) {
      var spPx = pxFromLatLon(opts.startingPosition.lat, opts.startingPosition.lon);
      var spSelected = isSelected(selected, 'passage-start', 'start', undefined);
      markers +=
        (spSelected ? '<circle cx="' + spPx.x + '" cy="' + spPx.y + '" r="13" fill="var(--text)" fill-opacity="0.3"/>' : '') +
        '<circle cx="' + spPx.x + '" cy="' + spPx.y + '" r="9" fill="transparent" pointer-events="fill" style="cursor:pointer" ' +
          selectAttrs('passage-start', 'start', undefined, 'Starting position') + '/>' +
        '<circle cx="' + spPx.x + '" cy="' + spPx.y + '" r="4.5" fill="var(--text)"/>' +
        '<text x="' + (spPx.x + 8) + '" y="' + (spPx.y - 8) + '" class="chart-point-label">Start</text>';
    }

    drLegs.forEach(function (leg, i) {
      var startPx = pxFromLatLon(leg.startPosition.lat, leg.startPosition.lon);
      var endPx = pxFromLatLon(leg.endPosition.lat, leg.endPosition.lon);
      var dirAngleRad = Math.atan2(endPx.y - startPx.y, endPx.x - startPx.x);
      var color = 'var(--chart-dr)';
      var markerId = 'passageDrArrow' + i;
      defs += '<marker id="' + markerId + '" markerWidth="9" markerHeight="9" refX="6" refY="4.5" orient="auto"><path d="M0,0 L9,4.5 L0,9 Z" fill="' + color + '"/></marker>';

      var segSelected = isSelected(selected, 'drleg', leg.id, 'segment');
      content +=
        (segSelected ? '<line x1="' + startPx.x + '" y1="' + startPx.y + '" x2="' + endPx.x + '" y2="' + endPx.y + '" stroke="' + color + '" stroke-width="7" stroke-opacity="0.35"/>' : '') +
        hitLine(startPx.x, startPx.y, endPx.x, endPx.y, selectAttrs('drleg', leg.id, 'segment', leg.name)) +
        '<line x1="' + startPx.x + '" y1="' + startPx.y + '" x2="' + endPx.x + '" y2="' + endPx.y +
        '" stroke="' + color + '" stroke-width="1.5" stroke-dasharray="5,4" marker-end="url(#' + markerId + ')"/>';

      // The endpoint is always a DR position by definition -- always a
      // semicircle, matching renderDrLegChart's own Bowditch-derived
      // convention (see that function's header for the citations). The
      // start end only gets one too if it's ITSELF a DR position (chained
      // from an earlier leg in this same passage); otherwise a plain
      // circle, matching a fix/departure position.
      var startIsDr = leg.startPosition.sourceType === 'DR';
      markers += startIsDr
        ? '<path d="' + semicirclePath(startPx.x, startPx.y, 6, dirAngleRad + Math.PI) + '" fill="var(--text)"/>'
        : '';
      markers += '<path d="' + semicirclePath(endPx.x, endPx.y, 6, dirAngleRad) + '" fill="' + color + '" stroke="var(--bg)" stroke-width="1"/>';
    });

    fixes.forEach(function (f) {
      var fPx = pxFromLatLon(f.resolvedPosition.lat, f.resolvedPosition.lon);
      var fSelected = isSelected(selected, 'fix', f.id, 'marker');
      markers +=
        (fSelected ? '<circle cx="' + fPx.x + '" cy="' + fPx.y + '" r="13" fill="var(--chart-fix)" fill-opacity="0.25"/>' : '') +
        '<circle cx="' + fPx.x + '" cy="' + fPx.y + '" r="10" fill="transparent" pointer-events="fill" style="cursor:pointer" ' +
          selectAttrs('fix', f.id, 'marker', f.name) + '/>' +
        '<circle cx="' + fPx.x + '" cy="' + fPx.y + '" r="6" fill="none" stroke="var(--chart-fix)" stroke-width="2"/>' +
        '<line x1="' + (fPx.x - 9) + '" y1="' + fPx.y + '" x2="' + (fPx.x + 9) + '" y2="' + fPx.y + '" stroke="var(--chart-fix)" stroke-width="1.5"/>' +
        '<line x1="' + fPx.x + '" y1="' + (fPx.y - 9) + '" x2="' + fPx.x + '" y2="' + (fPx.y + 9) + '" stroke="var(--chart-fix)" stroke-width="1.5"/>';
    });

    unfixedSights.forEach(function (s) {
      var pos = SightCalc.signedPositionFromRecord(s.position);
      var sPx = pxFromLatLon(pos.lat, pos.lon);
      var sSelected = isSelected(selected, 'sight', s.id, 'ap');
      markers +=
        (sSelected ? '<circle cx="' + sPx.x + '" cy="' + sPx.y + '" r="10" fill="var(--chart-az)" fill-opacity="0.3"/>' : '') +
        '<circle cx="' + sPx.x + '" cy="' + sPx.y + '" r="6" fill="transparent" pointer-events="fill" style="cursor:pointer" ' +
          selectAttrs('sight', s.id, 'ap', SightCalc.formatBodyLabel(s.body) + ' sight (unresolved)') + '/>' +
        '<circle cx="' + sPx.x + '" cy="' + sPx.y + '" r="3.5" fill="var(--chart-az)"/>';
    });

    defs += '</defs>';
    var svg =
      '<svg viewBox="0 0 ' + SIZE + ' ' + SIZE + '" xmlns="http://www.w3.org/2000/svg" class="chart-svg" role="img" aria-label="Plot of passage track">' +
        buildFrame(originLat, originLon, scale, clipId) +
        defs +
        '<g clip-path="url(#' + clipId + ')">' + content + '</g>' +
        markers +
      '</svg>';

    container.innerHTML = svg;

    return { scaleNM: scale, autoScaleNM: autoScale, originLat: originLat, originLon: originLon, autoOriginLat: autoOriginLat, autoOriginLon: autoOriginLon };
  }

  global.SightChart = {
    renderSightChart: renderSightChart,
    renderMultiSightChart: renderMultiSightChart,
    renderDrLegChart: renderDrLegChart,
    renderPassageChart: renderPassageChart,
    VIEWBOX_SIZE: SIZE, // exposed so chartPanZoom.js can map screen px <-> viewBox px without duplicating this constant
    pxPerNmForScale: function (scale) { return HALF / scale; } // the same conversion chart.js's own renders use internally, exposed so chartPanZoom.js can convert a screen-space gesture delta into an nm delta without duplicating HALF/EDGE
  };
})(window);
