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
    chooseNiceScale: chooseNiceScale
  };
})(window);
