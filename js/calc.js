/**
 * calc.js
 * Pure sight-reduction math. No DOM access anywhere in this file.
 * Everything here takes plain numbers/objects in and returns plain numbers/objects out,
 * so it can be unit-tested, reused for charting/exports, and reasoned about in isolation
 * from the UI layer (app.js).
 *
 * Angle convention: all degree values are decimal degrees. Latitude and Declination
 * are SIGNED (positive = N, negative = S). Longitude is UNSIGNED with a separate
 * 'E'/'W' indicator, matching how it's read off a chart / almanac.
 */
(function (global) {
  'use strict';

  function rad(d) { return d * (Math.PI / 180); }
  function deg(r) { return r * (180 / Math.PI); }

  /** Combine degrees + minutes into decimal degrees (unsigned). */
  function dmToDecimal(d, m) {
    return (d || 0) + (m || 0) / 60;
  }

  /** Format decimal degrees as "D° MM.M'" */
  function formatDegMin(decimalDeg) {
    var totalMin = Math.round(decimalDeg * 60 * 10) / 10;
    var d = Math.floor(totalMin / 60);
    var m = (totalMin % 60).toFixed(1);
    return d + '\u00B0 ' + m + "'";
  }

  /**
   * Format seconds-of-day as HH:MM:SS, wrapping into [0, 86400).
   * Rounds to the nearest whole second FIRST, then decomposes into H/M/S,
   * so a value like 59.6s correctly carries into the next minute (":60"
   * never appears). This is purely a display concern -- the underlying
   * unrounded seconds value passed in is never mutated, so callers doing
   * further math (e.g. interpolation fraction-of-hour) keep full precision.
   */
  function secondsToTimeString(sec) {
    var totalSec = Math.round(sec);
    totalSec = ((totalSec % 86400) + 86400) % 86400;
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  /**
   * observations: [{ h, m, s, heightDeg, heightMin }, ...]
   * Returns { avgLocalSec, avgHsDeg } or null if no observations.
   */
  function averageObservations(observations) {
    if (!observations || observations.length === 0) return null;
    var totalSec = 0;
    var totalHs = 0;
    observations.forEach(function (o) {
      var sec = (o.h || 0) * 3600 + (o.m || 0) * 60 + (o.s || 0);
      totalSec += sec;
      totalHs += dmToDecimal(o.heightDeg, o.heightMin);
    });
    var n = observations.length;
    return { avgLocalSec: totalSec / n, avgHsDeg: totalHs / n };
  }

  /**
   * corrections: {
   *   ieMin, ieSign ('on'|'off'),
   *   dipMin,
   *   altCorrMin, altCorrSign ('+'|'-'),
   *   addAltCorrMin, addAltCorrSign ('+'|'-')
   * }
   * Returns Ha (Apparent Altitude) in decimal degrees: Hs corrected for
   * Index Error and Dip only. This is the value used to look up the
   * Altitude Correction (refraction/SD/PA) tables in the Nautical Almanac.
   */
  function computeHa(avgHsDeg, corrections) {
    var c = corrections || {};
    var ie = c.ieMin || 0;
    var ieCorr = c.ieSign === 'on' ? -ie : ie;

    var dipCorr = -(c.dipMin || 0);

    return avgHsDeg + (ieCorr + dipCorr) / 60;
  }

  /**
   * Returns Ho (Observed Altitude) in decimal degrees: Ha further corrected
   * for refraction/semidiameter/parallax (the Altitude Correction and
   * Additional Altitude Correction read from the almanac).
   */
  function computeHo(avgHsDeg, corrections) {
    var c = corrections || {};
    var ha = computeHa(avgHsDeg, corrections);

    var alt = c.altCorrMin || 0;
    var altCorr = c.altCorrSign === '-' ? -alt : alt;

    var addAlt = c.addAltCorrMin || 0;
    var addAltCorr = c.addAltCorrSign === '-' ? -addAlt : addAlt;

    return ha + (altCorr + addAltCorr) / 60;
  }

  /** Local seconds-of-day -> UTC seconds-of-day, wrapped into [0, 86400). */
  function utcSecondsFromLocal(avgLocalSec, tzOffsetHours) {
    return ((avgLocalSec - (tzOffsetHours || 0) * 3600) % 86400 + 86400) % 86400;
  }

  /**
   * Interpolate a GHA-like value (0-360, wraps at the hour boundary) across the
   * fraction of the hour that has elapsed.
   */
  function interpolateGha(baseDeg, nextDeg, fraction) {
    var b = baseDeg;
    var n = nextDeg;
    if (n < b) n += 360;
    return (b + (n - b) * fraction) % 360;
  }

  /** Plain linear interpolation, for values that don't wrap (e.g. Declination). */
  function interpolateLinear(base, next, fraction) {
    return base + (next - base) * fraction;
  }

  /**
   * Core sight reduction calculation.
   *
   * input = {
   *   bodyType: 'sun' | 'moon' | 'planet' | 'star',
   *   lat: signed decimal degrees (N positive),
   *   lon: unsigned decimal degrees,
   *   lonEW: 'E' | 'W',
   *   utcFractionOfHour: 0..1 (how far through the almanac hour the avg UTC time falls),
   *   star: { ghaAriesBase, ghaAriesNext, sha, dec } -- required if bodyType === 'star'
   *   nonStar: { ghaBase, ghaNext, decBase, decNext } -- required otherwise
   *   ho: decimal degrees, already-corrected Observed Altitude
   * }
   *
   * Returns {
   *   interpolatedGha, interpolatedDec, lha, hc, zn, interceptNM, interceptDirection
   * }
   */
  function reduceSight(input) {
    var interpolatedGha, interpolatedDec;

    if (input.bodyType === 'star') {
      var s = input.star;
      var ghaAriesInterp = interpolateGha(s.ghaAriesBase, s.ghaAriesNext, input.utcFractionOfHour);
      interpolatedGha = (ghaAriesInterp + s.sha) % 360;
      interpolatedDec = s.dec;
    } else {
      var ns = input.nonStar;
      interpolatedGha = interpolateGha(ns.ghaBase, ns.ghaNext, input.utcFractionOfHour);
      interpolatedDec = interpolateLinear(ns.decBase, ns.decNext, input.utcFractionOfHour);
    }

    var lat = input.lat;
    var lon = input.lon;

    var lha = (input.lonEW === 'W') ? (interpolatedGha - lon) : (interpolatedGha + lon);
    lha = (lha % 360 + 360) % 360;

    var sinHc = (Math.sin(rad(lat)) * Math.sin(rad(interpolatedDec))) +
                (Math.cos(rad(lat)) * Math.cos(rad(interpolatedDec)) * Math.cos(rad(lha)));
    var hcRad = Math.asin(sinHc);
    var hcDeg = deg(hcRad);

    var numX = (Math.sin(rad(interpolatedDec)) * Math.cos(rad(lat))) -
               (Math.cos(rad(interpolatedDec)) * Math.cos(rad(lha)) * Math.sin(rad(lat)));
    var X = numX / Math.cos(hcRad);
    if (X > 1) X = 1;
    if (X < -1) X = -1;

    var Z = deg(Math.acos(X));
    var Zn = (lha > 180) ? Z : (360 - Z);

    var interceptNM = (input.ho - hcDeg) * 60;

    return {
      interpolatedGha: interpolatedGha,
      interpolatedDec: interpolatedDec,
      lha: lha,
      hc: hcDeg,
      zn: Zn,
      interceptNM: interceptNM,
      interceptDirection: interceptNM >= 0 ? 'TOWARD' : 'AWAY'
    };
  }

  /**
   * Pure geometry for plotting a single sight: AP, the azimuth line toward the
   * body's GP, and the resulting Line of Position (LOP). Everything is returned
   * in nautical miles on a North-up, East-positive/North-positive plane centered
   * on AP (AP is always the origin). Rendering (pixels, SVG) is chart.js's job.
   *
   * zn: true azimuth in decimal degrees (0-360, from North, clockwise)
   * interceptNM: signed nm (positive = TOWARD the body's GP, negative = AWAY)
   */
  function computeLopGeometry(zn, interceptNM) {
    var znRad = rad(zn);
    var azUnit = { x: Math.sin(znRad), y: Math.cos(znRad) }; // x=East, y=North

    var interceptPoint = { x: azUnit.x * interceptNM, y: azUnit.y * interceptNM };

    // LOP is perpendicular to the azimuth line, passing through interceptPoint.
    var lopDirection = { x: -azUnit.y, y: azUnit.x };

    return {
      ap: { x: 0, y: 0 },
      azimuthUnit: azUnit,
      interceptPoint: interceptPoint,
      lopDirection: lopDirection
    };
  }

  /**
   * Chooses a "nice" round nm value (for a range ring / chart scale) that
   * comfortably contains maxExtentNM with some padding.
   */
  function chooseNiceScale(maxExtentNM) {
    var niceSteps = [0.5, 1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 1000, 2000, 5000, 10000];
    var target = Math.max(Math.abs(maxExtentNM), 0.25) * 1.35;
    for (var i = 0; i < niceSteps.length; i++) {
      if (niceSteps[i] >= target) return niceSteps[i];
    }
    return niceSteps[niceSteps.length - 1];
  }

  /**
   * Splits unsigned decimal degrees into {deg, min} (minutes to 1 decimal).
   * Rounds total minutes first, then floors into whole degrees, so a value
   * like 14.999...deg correctly becomes {deg:15, min:0.0} rather than
   * {deg:14, min:60.0}.
   */
  function decimalToDM(decimalDeg) {
    var totalMinTenths = Math.round(Math.abs(decimalDeg) * 600);
    var d = Math.floor(totalMinTenths / 600);
    var m = (totalMinTenths - d * 600) / 10;
    return { deg: d, min: m };
  }

  /**
   * Pure: given a stored sighting's "position" sub-object (the shape
   * collectFormState() produces: latDeg/latMin/latNS/lonDeg/lonMin/lonEW),
   * returns signed decimal degrees (S/W negative). This is the non-DOM
   * counterpart to app.js's getAssumedPositionSigned() -- used when reading
   * a saved sighting record directly (e.g. for a Fix plot) rather than
   * live form fields.
   */
  function signedPositionFromRecord(position) {
    var p = position || {};
    var latTotal = dmToDecimal(p.latDeg, p.latMin);
    var lonTotal = dmToDecimal(p.lonDeg, p.lonMin);
    return {
      lat: p.latNS === 'S' ? -latTotal : latTotal,
      lon: p.lonEW === 'W' ? -lonTotal : lonTotal
    };
  }

  /**
   * Pure: lays out multiple sightings' AP + LOP geometry in one shared
   * North-up, nm-based plane, so they can be overlaid on a single chart.
   *
   * Each sighting's AP may differ slightly (e.g. a 3-star fix taken over a
   * few minutes, or genuinely different APs) -- the shared origin is the
   * centroid of all APs, and each sighting's own AP is placed at its offset
   * from that centroid (flat-earth approximation: dx = dLon*60*cos(refLat),
   * dy = dLat*60, both in nm -- entirely adequate at chart-plotting scale).
   * A sighting's own LOP geometry (computeLopGeometry, relative to ITS OWN
   * AP) is then translated by that same offset into the shared frame.
   *
   * sightings: [{ lat, lon, zn, interceptNM, ...anything else the caller
   *               wants carried through untouched, e.g. label/color/id }]
   *
   * Returns {
   *   originLat, originLon,          -- the centroid AP (decimal degrees)
   *   maxExtentNM,                    -- farthest point from origin, for scale selection
   *   sightings: [{
   *     ...all original fields carried through,
   *     apPoint, azimuthUnit, interceptPoint, lopDirection   -- all in shared nm frame
   *   }]
   * }
   */
  function computeMultiLopGeometry(sightings) {
    if (!sightings || sightings.length === 0) {
      return { originLat: 0, originLon: 0, maxExtentNM: 0, sightings: [] };
    }

    var n = sightings.length;
    var originLat = sightings.reduce(function (sum, s) { return sum + s.lat; }, 0) / n;
    var originLon = sightings.reduce(function (sum, s) { return sum + s.lon; }, 0) / n;
    var originLatRad = rad(originLat);
    var cosOriginLat = Math.cos(originLatRad);

    var maxExtentNM = 0;
    var results = sightings.map(function (s) {
      var dLat = s.lat - originLat;
      var dLon = s.lon - originLon;
      var apPoint = {
        x: dLon * 60 * cosOriginLat, // East nm
        y: dLat * 60                // North nm
      };

      var localGeo = computeLopGeometry(s.zn, s.interceptNM); // relative to this sighting's own AP
      var interceptPoint = {
        x: apPoint.x + localGeo.interceptPoint.x,
        y: apPoint.y + localGeo.interceptPoint.y
      };

      maxExtentNM = Math.max(maxExtentNM, Math.hypot(apPoint.x, apPoint.y), Math.hypot(interceptPoint.x, interceptPoint.y));

      var out = {};
      for (var key in s) { if (Object.prototype.hasOwnProperty.call(s, key)) out[key] = s[key]; }
      out.apPoint = apPoint;
      out.azimuthUnit = localGeo.azimuthUnit;
      out.interceptPoint = interceptPoint;
      out.lopDirection = localGeo.lopDirection;
      return out;
    });

    return { originLat: originLat, originLon: originLon, maxExtentNM: maxExtentNM, sightings: results };
  }

  /** Pure: {type, name} -> display label, e.g. "Sun", "Star Aldebaran", "Planet Jupiter". */
  function formatBodyLabel(body) {
    if (!body) return 'Body';
    if (body.type === 'star' || body.type === 'planet') {
      return body.name ? (body.type.charAt(0).toUpperCase() + body.type.slice(1) + ' ' + body.name) : body.type;
    }
    return body.type.charAt(0).toUpperCase() + body.type.slice(1);
  }

  var CHART_PALETTE = ['#00bcd4', '#ff9800', '#8bc34a', '#e91e63', '#9c27b0', '#ffeb3b', '#03a9f4', '#ff5722'];

  /** Stable color for a given sighting index, cycling through CHART_PALETTE. Single source of truth so a sighting's color is identical everywhere it's shown (a fix's sighting list, its plot, its legend). */
  function paletteColor(index) {
    var i = ((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length;
    return CHART_PALETTE[i];
  }

  function normalizeVec(v) {
    var len = Math.hypot(v.x, v.y);
    if (len < 1e-9) return null;
    return { x: v.x / len, y: v.y / len };
  }

  /**
   * Intersection of two infinite lines, each given as a point + direction
   * vector. Returns {x,y}, or null if the lines are parallel (within a
   * small tolerance).
   */
  function lineLineIntersection(p1, dir1, p2, dir2) {
    var denom = dir1.x * dir2.y - dir1.y * dir2.x;
    if (Math.abs(denom) < 1e-9) return null; // parallel (or nearly so)

    var diffX = p2.x - p1.x;
    var diffY = p2.y - p1.y;
    var t = (diffX * dir2.y - diffY * dir2.x) / denom;

    return { x: p1.x + t * dir1.x, y: p1.y + t * dir1.y };
  }

  /**
   * Best-practice bisector-method geometry for resolving multiple LOPs into
   * a refined estimated position (the classic "cocked hat" technique,
   * generalized to any number of LOPs >= 2).
   *
   * lopLines: [{ point, direction }] -- one entry per LOP, point = any point
   * on that LOP (e.g. its intercept point), direction = its unit direction
   * vector (e.g. lopDirection from computeLopGeometry/computeMultiLopGeometry).
   *
   * For the classic 3-LOP cocked hat: each pair of LOPs crosses at a vertex
   * of the triangle; the internal angle bisector at each vertex points
   * toward the OTHER two vertices (one on each of the two lines meeting
   * there). This generalizes cleanly to N LOPs: at the intersection of
   * lines i and j, orient line i's local direction toward the centroid of
   * ALL of line i's intersections with every line other than j (not just a
   * single "other" line), and likewise for line j; the bisector direction
   * is the normalized sum of those two oriented directions. For exactly 2
   * LOPs there are no "other" intersections to orient toward, so that
   * line's own fixed direction convention is used directly -- a reasonable,
   * deterministic choice, though for N=2 the bisector is more an
   * illustrative construct than a position refinement (2 LOPs already
   * define an unambiguous single fix at their crossing).
   *
   * Returns [{ i, j, point, direction }] -- one entry per non-parallel pair
   * of input lines (skips pairs that are parallel; there is no
   * intersection to bisect).
   */
  function computeBisectors(lopLines) {
    var n = lopLines.length;
    var intersections = {}; // "i_j" (i<j) -> {x,y}

    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var inter = lineLineIntersection(lopLines[i].point, lopLines[i].direction, lopLines[j].point, lopLines[j].direction);
        if (inter) intersections[i + '_' + j] = inter;
      }
    }

    function otherIntersectionsForLine(lineIdx, excludeIdx) {
      var pts = [];
      for (var k = 0; k < n; k++) {
        if (k === lineIdx || k === excludeIdx) continue;
        var key = lineIdx < k ? (lineIdx + '_' + k) : (k + '_' + lineIdx);
        if (intersections[key]) pts.push(intersections[key]);
      }
      return pts;
    }

    function centroidOf(pts) {
      var sx = 0, sy = 0;
      pts.forEach(function (p) { sx += p.x; sy += p.y; });
      return { x: sx / pts.length, y: sy / pts.length };
    }

    var results = [];
    for (var a = 0; a < n; a++) {
      for (var b = a + 1; b < n; b++) {
        var P = intersections[a + '_' + b];
        if (!P) continue; // parallel lines -- no intersection to bisect

        var othersA = otherIntersectionsForLine(a, b);
        var othersB = otherIntersectionsForLine(b, a);

        var dirA = othersA.length
          ? normalizeVec({ x: centroidOf(othersA).x - P.x, y: centroidOf(othersA).y - P.y })
          : lopLines[a].direction;
        var dirB = othersB.length
          ? normalizeVec({ x: centroidOf(othersB).x - P.x, y: centroidOf(othersB).y - P.y })
          : lopLines[b].direction;

        if (!dirA) dirA = lopLines[a].direction;
        if (!dirB) dirB = lopLines[b].direction;

        var bisectorDir = normalizeVec({ x: dirA.x + dirB.x, y: dirA.y + dirB.y });
        if (!bisectorDir) {
          // dirA and dirB exactly cancel (rare, near-opposite orientation) --
          // fall back to a perpendicular of dirA as an arbitrary but
          // well-defined and deterministic choice.
          bisectorDir = { x: -dirA.y, y: dirA.x };
        }

        results.push({ i: a, j: b, point: P, direction: bisectorDir });
      }
    }

    return results;
  }

  /**
   * Inverse of the flat-earth projection used in computeMultiLopGeometry:
   * converts a point in the shared nm-plane (origin at originLat/originLon)
   * back into decimal-degree lat/lon.
   */
  function nmPointToLatLon(originLat, originLon, point) {
    var cosOriginLat = Math.cos(rad(originLat)) || 1e-9;
    return {
      lat: originLat + point.y / 60,
      lon: originLon + point.x / (60 * cosOriginLat)
    };
  }

  /**
   * Estimates where a set of bisector lines converge (the refined "most
   * probable position" from the cocked-hat method), in the same nm-plane
   * the bisectors are expressed in.
   *
   * For the classic N=3 case (3 bisectors from 3 LOPs) the three lines are
   * mathematically concurrent at the triangle's incenter, so every pairwise
   * intersection among them coincides there exactly -- the centroid below
   * reduces to that exact point. For more than 3 LOPs there is no single
   * point of exact concurrency in general, so this returns the centroid of
   * all pairwise bisector-line intersections as a reasonable estimate,
   * after discarding intersections from near-parallel bisector pairs
   * (optional maxDistance, in the same nm units, guards against those
   * shooting off to unreliable extremes and skewing the average).
   *
   * Returns null if fewer than 2 bisector lines are given (no intersection
   * exists yet) or if every pair happens to be parallel.
   */
  function computeBisectorFix(bisectors, maxDistance) {
    if (!bisectors || bisectors.length < 2) return null;

    var pts = [];
    for (var i = 0; i < bisectors.length; i++) {
      for (var j = i + 1; j < bisectors.length; j++) {
        var inter = lineLineIntersection(bisectors[i].point, bisectors[i].direction, bisectors[j].point, bisectors[j].direction);
        if (inter) pts.push(inter);
      }
    }
    if (!pts.length) return null;

    if (typeof maxDistance === 'number' && pts.length > 1) {
      var cx = 0, cy = 0;
      pts.forEach(function (p) { cx += p.x; cy += p.y; });
      cx /= pts.length; cy /= pts.length;
      var filtered = pts.filter(function (p) { return Math.hypot(p.x - cx, p.y - cy) <= maxDistance; });
      if (filtered.length) pts = filtered;
    }

    var sx = 0, sy = 0;
    pts.forEach(function (p) { sx += p.x; sy += p.y; });
    return { x: sx / pts.length, y: sy / pts.length };
  }

  /** Pure: signed lat/lon decimal degrees -> "40° 32.1'N 73° 55.8'W". */
  function formatLatLon(lat, lon) {
    var latStr = formatDegMin(Math.abs(lat)) + (lat >= 0 ? 'N' : 'S');
    var lonStr = formatDegMin(Math.abs(lon)) + (lon >= 0 ? 'E' : 'W');
    return latStr + ' ' + lonStr;
  }

  global.SightCalc = {
    rad: rad,
    deg: deg,
    dmToDecimal: dmToDecimal,
    formatDegMin: formatDegMin,
    secondsToTimeString: secondsToTimeString,
    averageObservations: averageObservations,
    computeHa: computeHa,
    computeHo: computeHo,
    utcSecondsFromLocal: utcSecondsFromLocal,
    interpolateGha: interpolateGha,
    interpolateLinear: interpolateLinear,
    reduceSight: reduceSight,
    computeLopGeometry: computeLopGeometry,
    chooseNiceScale: chooseNiceScale,
    decimalToDM: decimalToDM,
    signedPositionFromRecord: signedPositionFromRecord,
    computeMultiLopGeometry: computeMultiLopGeometry,
    formatBodyLabel: formatBodyLabel,
    paletteColor: paletteColor,
    lineLineIntersection: lineLineIntersection,
    computeBisectors: computeBisectors,
    nmPointToLatLon: nmPointToLatLon,
    computeBisectorFix: computeBisectorFix,
    formatLatLon: formatLatLon
  };
})(window);
