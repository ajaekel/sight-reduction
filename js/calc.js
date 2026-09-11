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

  /**
   * Pure: bearing (0-360, clockwise from North) that a given azimuthUnit {x,y} points along.
   */
  function azimuthDegFromUnit(u) {
    return (deg(Math.atan2(u.x, u.y)) + 360) % 360;
  }

  /**
   * Pure: out of 3+ sightings, picks the 3 whose azimuths are most evenly
   * spread around the compass -- specifically, the triple that maximizes the
   * smallest of the three gaps between them. A narrow gap between any two
   * means those two LOPs cross at a shallow angle, which is exactly what
   * makes both a plain intersection AND the bisector construction below
   * unreliable (small altitude errors swing the crossing point a long way).
   * Returns [i, j, k] (indices into `sightings`), or null if fewer than 3.
   */
  function selectWidestAzimuthSpreadTriple(sightings) {
    if (!sightings || sightings.length < 3) return null;

    var azimuths = sightings.map(function (s) { return azimuthDegFromUnit(s.azimuthUnit); });
    var best = null;
    var bestScore = -1;

    for (var i = 0; i < sightings.length; i++) {
      for (var j = i + 1; j < sightings.length; j++) {
        for (var k = j + 1; k < sightings.length; k++) {
          var sorted = [azimuths[i], azimuths[j], azimuths[k]].sort(function (a, b) { return a - b; });
          var gapA = sorted[1] - sorted[0];
          var gapB = sorted[2] - sorted[1];
          var gapC = 360 - sorted[2] + sorted[0];
          var minGap = Math.min(gapA, gapB, gapC);
          if (minGap > bestScore) {
            bestScore = minGap;
            best = [i, j, k];
          }
        }
      }
    }

    return best;
  }

  /**
   * Pure: intersection of two LOPs, each given as a point + its normal
   * (a LOP's normal is exactly its sighting's azimuthUnit -- the LOP is
   * defined by azimuthUnit . (P - interceptPoint) = 0). Returns null if the
   * two azimuths are too nearly parallel to intersect reliably.
   */
  function intersectTwoLops(s1, s2) {
    var a1 = s1.azimuthUnit.x, b1 = s1.azimuthUnit.y;
    var a2 = s2.azimuthUnit.x, b2 = s2.azimuthUnit.y;
    var c1 = a1 * s1.interceptPoint.x + b1 * s1.interceptPoint.y;
    var c2 = a2 * s2.interceptPoint.x + b2 * s2.interceptPoint.y;

    var det = a1 * b2 - a2 * b1;
    if (Math.abs(det) < 1e-9) return null;

    return {
      x: (c1 * b2 - c2 * b1) / det,
      y: (a1 * c2 - a2 * c1) / det
    };
  }

  /**
   * Pure: the classical "method of bisectors" for a cocked hat -- the
   * triangle formed by exactly 3 LOPs (Bini 1955, Davies 1956; still cited
   * in modern nav references). At each vertex, the internal angle bisector
   * of the two LOPs crossing there passes through the triangle's incenter (a
   * basic concurrency result), so rather than compute bisector directions
   * directly, this finds the 3 vertices and the incenter via the standard
   * "weighted by opposite side length" formula. Callers draw each bisector
   * as the segment from its vertex to the incenter.
   *
   * This method is best-justified when the 3 LOPs are trusted equally; if
   * one sight is known to be better than the others, the incenter has no
   * way to reflect that and should be treated skeptically.
   *
   * triple: exactly 3 sightings, each { azimuthUnit: {x,y}, interceptPoint: {x,y} }
   * Returns { vertices: [v0, v1, v2], incenter: {x,y}, maxSideNM } or null if
   * any pair is too nearly parallel, or the "triangle" has ~zero perimeter.
   * vertices[0] = LOP1 x LOP2 (opposite LOP0), and so on -- standard
   * "vertex opposite its non-participating LOP" triangle labeling.
   */
  function resolveCockedHatBisectors(triple) {
    var v0 = intersectTwoLops(triple[1], triple[2]);
    var v1 = intersectTwoLops(triple[0], triple[2]);
    var v2 = intersectTwoLops(triple[0], triple[1]);
    if (!v0 || !v1 || !v2) return null;

    var sideOpp0 = Math.hypot(v1.x - v2.x, v1.y - v2.y);
    var sideOpp1 = Math.hypot(v0.x - v2.x, v0.y - v2.y);
    var sideOpp2 = Math.hypot(v0.x - v1.x, v0.y - v1.y);
    var perimeter = sideOpp0 + sideOpp1 + sideOpp2;
    if (perimeter < 1e-9) return null;

    var incenter = {
      x: (sideOpp0 * v0.x + sideOpp1 * v1.x + sideOpp2 * v2.x) / perimeter,
      y: (sideOpp0 * v0.y + sideOpp1 * v1.y + sideOpp2 * v2.y) / perimeter
    };

    return {
      vertices: [v0, v1, v2],
      incenter: incenter,
      maxSideNM: Math.max(sideOpp0, sideOpp1, sideOpp2)
    };
  }

  /**
   * Pure: resolves a fix from 2+ LOPs already laid out in one shared plane
   * by computeMultiLopGeometry. Returns up to two independent candidate
   * points -- the caller (chart.js, driven by the bisector show/hide toggle)
   * decides which one is presented as "the Fix":
   *
   *  - leastSquaresPoint: least-squares solution of the overdetermined
   *    system formed by each LOP's equation azimuthUnit_i . P =
   *    azimuthUnit_i . interceptPoint_i. Works for any N >= 2, and for
   *    exactly 2 LOPs is an exactly-determined 2x2 system -- i.e. their
   *    literal intersection -- so "2-LOP fix" and "3+ LOP most probable
   *    position" fall out of the same formula with no special case. (For 3
   *    equal-weight LOPs this point is the triangle's symmedian point -- a
   *    better-justified "center" than the incenter below when no LOP is
   *    known to be more trustworthy than the others.)
   *
   *  - bisector: the classical "method of bisectors" result (see
   *    resolveCockedHatBisectors) -- only present when 3+ LOPs are given.
   *    With exactly 3, bisects that triangle directly. With 4+, first picks
   *    the 3 LOPs with the widest mutual azimuth spread (see
   *    selectWidestAzimuthSpreadTriple), since the bisector construction
   *    degrades the same way a plain intersection does when LOPs cross at a
   *    shallow angle.
   *
   * sightings: [{ azimuthUnit: {x,y}, interceptPoint: {x,y} }, ...]
   *
   * Returns { solvable: false, reason } or
   *         { solvable: true, leastSquaresPoint: {x,y}, bisector?: {...} }
   */
  function resolveMultiLopFix(sightings) {
    if (!sightings || sightings.length < 2) {
      return { solvable: false, reason: 'Need at least 2 plotted LOPs to resolve a fix.' };
    }

    var Sxx = 0, Sxy = 0, Syy = 0, Sxc = 0, Syc = 0;
    sightings.forEach(function (s) {
      var a = s.azimuthUnit.x, b = s.azimuthUnit.y;
      var c = a * s.interceptPoint.x + b * s.interceptPoint.y;
      Sxx += a * a; Sxy += a * b; Syy += b * b;
      Sxc += a * c; Syc += b * c;
    });

    var det = Sxx * Syy - Sxy * Sxy;
    if (Math.abs(det) < 1e-9) {
      return { solvable: false, reason: 'These LOPs are too nearly parallel to resolve a reliable fix.' };
    }

    var result = {
      solvable: true,
      leastSquaresPoint: {
        x: (Syy * Sxc - Sxy * Syc) / det,
        y: (Sxx * Syc - Sxy * Sxc) / det
      }
    };

    if (sightings.length >= 3) {
      var tripleIndices = sightings.length === 3 ? [0, 1, 2] : selectWidestAzimuthSpreadTriple(sightings);
      var triple = tripleIndices.map(function (idx) { return sightings[idx]; });
      var bisectors = resolveCockedHatBisectors(triple);
      if (bisectors) {
        result.bisector = {
          incenter: bisectors.incenter,
          vertices: bisectors.vertices,
          maxSideNM: bisectors.maxSideNM,
          tripleIndices: tripleIndices
        };
      }
    }

    return result;
  }

  /**
   * Pure: inverse of the flat-earth nm offset used throughout this file --
   * turns a {x,y} nm offset from (originLat, originLon) back into signed
   * decimal degrees. Shared by chart.js (axis labels) and the fix-resolution
   * path (turning the resolved point back into a position).
   */
  function positionFromOffset(originLat, originLon, offsetNM) {
    var cosOriginLat = Math.cos(rad(originLat)) || 1e-9; // guard against exactly 90deg
    return {
      lat: originLat + offsetNM.y / 60,
      lon: originLon + offsetNM.x / (60 * cosOriginLat)
    };
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
    azimuthDegFromUnit: azimuthDegFromUnit,
    selectWidestAzimuthSpreadTriple: selectWidestAzimuthSpreadTriple,
    intersectTwoLops: intersectTwoLops,
    resolveCockedHatBisectors: resolveCockedHatBisectors,
    resolveMultiLopFix: resolveMultiLopFix,
    positionFromOffset: positionFromOffset,
    formatBodyLabel: formatBodyLabel,
    paletteColor: paletteColor
  };
})(window);
