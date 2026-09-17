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
   * UTC seconds-of-day -> local (zone) seconds-of-day. Also returns how many
   * calendar days the conversion crossed (-1, 0, or +1) relative to the UTC
   * date, since a local time can land on the day before or after.
   */
  function localFromUtcSeconds(utcSec, tzOffsetHours) {
    var raw = utcSec + (tzOffsetHours || 0) * 3600;
    return { sec: ((raw % 86400) + 86400) % 86400, dayOffset: Math.floor(raw / 86400) };
  }

  /**
   * Interpolates a rise/set/transit time between two latitude bands, the way
   * a Nautical Almanac's tables are read: given the tabulated time at a
   * latitude below the AP and one above it (signed decimal degrees, either
   * order), linearly interpolate for the AP's actual latitude. Times are
   * seconds-of-day (LMT, as tabulated); the result is not wrapped, since
   * that's handled consistently later by utcFromLmtSeconds/localFromUtcSeconds.
   */
  function interpolateByLatitude(latBelow, timeBelowSec, latAbove, timeAboveSec, apLat) {
    if (latAbove === latBelow) return timeBelowSec; // degenerate: nothing to interpolate
    var fraction = (apLat - latBelow) / (latAbove - latBelow);
    return timeBelowSec + fraction * (timeAboveSec - timeBelowSec);
  }

  /**
   * Converts a Local Mean Time (as tabulated in a Nautical Almanac -- local
   * to the observer's OWN meridian) to UTC, via the standard longitude/15
   * conversion (East longitude positive). This is a distinct step from
   * converting UTC to the observer's zone/clock time: LMT tracks true
   * longitude continuously, while zone time is a discrete administrative
   * offset (tzOffset) that may not exactly match it. Deliberately does not
   * apply the day-to-day-drift refinement some almanacs' explanatory notes
   * describe -- for rise/set/transit timing this is normally well under a
   * minute of additional error.
   */
  function utcFromLmtSeconds(lmtSec, lonSignedDecimal) {
    var raw = lmtSec - (lonSignedDecimal / 15) * 3600;
    return { sec: ((raw % 86400) + 86400) % 86400, dayOffset: Math.floor(raw / 86400) };
  }

  /**
   * Full manual-mode pipeline for one rise/set/transit event: LMT (already
   * latitude-interpolated, or read directly off the almanac for transit,
   * which doesn't depend on latitude) -> UTC -> the observer's zone time.
   * dayOffset is the zone-time date's offset (in days) from the nominal
   * date the LMT was tabulated for -- e.g. a moonrise just after midnight
   * zone time, tabulated for the evening before.
   */
  function manualEventToZoneTime(lmtSec, lonSignedDecimal, tzOffsetHours) {
    var utc = utcFromLmtSeconds(lmtSec, lonSignedDecimal);
    var zone = localFromUtcSeconds(utc.sec, tzOffsetHours);
    return { zoneSec: zone.sec, dayOffset: utc.dayOffset + zone.dayOffset };
  }

  /**
   * Nautical Almanac "Table II" longitude correction for Moonrise, Moonset,
   * and Moon Meridian Passage. Unlike the Sun (which drifts under a minute a
   * day and is fine to ignore), the Moon's rise/set/transit LMT drifts by an
   * average of ~50 minutes a day, so an observer far from Greenwich needs to
   * interpolate between the tabulated LMT for their own date and the LMT for
   * the adjacent Greenwich date -- the FOLLOWING date if in west longitude,
   * or the PRECEDING date if in east longitude (see Bowditch/American
   * Practical Navigator Vol. 1, Ch. 19, "Longitude Correction", and the
   * Nautical Almanac's own "Tables for Interpolating Sunrise, Moonrise,
   * etc.", Table II). This function is agnostic to which calendar day
   * adjacentLmtSec actually represents -- the caller must supply the correct
   * one for the observer's hemisphere; only the sign of lonSignedDecimal
   * determines whether the correction is added (west) or subtracted (east),
   * matching the almanac's own sign convention.
   *
   * todayLmtSec should already be latitude-interpolated for rise/set (via
   * interpolateByLatitude), or the transit LMT directly (no latitude
   * dependence there); adjacentLmtSec is the equivalent quantity for the
   * adjacent date. Returns todayLmtSec unchanged if adjacentLmtSec is not
   * supplied, so the correction is opt-in.
   */
  function applyMoonLongitudeCorrection(lonSignedDecimal, todayLmtSec, adjacentLmtSec) {
    if (adjacentLmtSec === null || adjacentLmtSec === undefined || isNaN(adjacentLmtSec)) return todayLmtSec;
    var diff = adjacentLmtSec - todayLmtSec;
    // The daily drift is well under an hour, so a raw difference bigger than
    // half a day means the two tabulated times straddle midnight (e.g. today
    // at 23:52, adjacent day at 00:41) rather than a real ~24h jump.
    if (diff > 12 * 3600) diff -= 24 * 3600;
    if (diff < -12 * 3600) diff += 24 * 3600;
    var fraction = Math.abs(lonSignedDecimal) / 360;
    var corr = fraction * diff;
    return todayLmtSec + (lonSignedDecimal < 0 ? corr : -corr);
  }

  /** Standard altitudes (decimal degrees) that define each event, center of body. */
  var STANDARD_ALTITUDE_DEG = {
    sunRiseSet: -50 / 60,     // -0.8333 deg: -34' refraction, -16' semidiameter
    civilTwilight: -6,
    nauticalTwilight: -12
  };

  /**
   * Derives the Sun's declination (signed decimal degrees) implied by a known
   * Sunrise or Sunset time relative to Meridian Passage, at a known latitude
   * -- by inverting the standard altitude formula
   *   sin(h) = sin(lat)*sin(dec) + cos(lat)*cos(dec)*cos(H)
   * for h = the standard rise/set altitude and H = the hour angle implied by
   * the time gap from transit. transitSec and riseOrSetSec must be on the
   * same time base (both LMT, or both zone time, or both UTC -- doesn't
   * matter which, since only their difference is used), and can cross
   * midnight (the gap is normalized to under 12h either way).
   *
   * This lets twilight be computed directly from data already on screen
   * (Sunrise/Sunset/Meridian Passage) instead of requiring a separate
   * almanac lookup. Returns null if the geometry doesn't resolve to a real
   * declination (shouldn't happen for real sun data, but guards against
   * bad/inconsistent input).
   */
  function deriveSunDeclination(apLatDeg, transitSec, riseOrSetSec) {
    var gap = riseOrSetSec - transitSec;
    if (gap > 12 * 3600) gap -= 24 * 3600;
    if (gap < -12 * 3600) gap += 24 * 3600;
    if (gap === 0) return null;

    var H = rad(Math.abs(gap) / 3600 * 15);
    var lat = rad(apLatDeg);
    var h0 = rad(STANDARD_ALTITUDE_DEG.sunRiseSet);

    var P = Math.sin(lat);
    var Q = Math.cos(lat) * Math.cos(H);
    var R = Math.sqrt(P * P + Q * Q);
    if (R === 0) return null;
    var ratio = Math.sin(h0) / R;
    if (ratio < -1 || ratio > 1) return null;
    var phi = Math.atan2(Q, P);
    return deg(Math.asin(ratio) - phi);
  }

  /**
   * Hour angle (seconds, always non-negative) at which the Sun reaches the
   * given altitude, for a known latitude/declination. Returns null if the
   * Sun never reaches that altitude that day (continuous daylight/twilight/
   * darkness, which happens at high latitude depending on season).
   */
  function sunHourAngleForAltitude(apLatDeg, decDeg, altitudeDeg) {
    var lat = rad(apLatDeg);
    var dec = rad(decDeg);
    var h = rad(altitudeDeg);
    var cosH = (Math.sin(h) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec));
    if (cosH < -1 || cosH > 1) return null;
    return Math.acos(cosH) * (180 / Math.PI) / 15 * 3600;
  }

  /**
   * Computes Civil and Nautical Twilight (begin/end) from the Sun's already-
   * known Meridian Passage time plus at least one of Sunrise/Sunset -- no
   * separate twilight almanac entry needed. transitSec/sunriseSec/sunsetSec
   * must all be on the same time base (see deriveSunDeclination); the
   * returned civil/nautical values are on that same base, ready to run
   * through whatever conversion the caller already applies to transit.
   *
   * If both sunrise and sunset are supplied, their implied declinations are
   * averaged for a little extra robustness against rounding in the source
   * data. Pass null for whichever of sunriseSec/sunsetSec isn't available.
   * Returns null only if neither is available; individual civil/nautical
   * fields are null if the Sun doesn't reach that altitude that day.
   */
  function computeTwilightTimes(apLatDeg, transitSec, sunriseSec, sunsetSec) {
    var decs = [];
    if (sunriseSec !== null && sunriseSec !== undefined) {
      var d1 = deriveSunDeclination(apLatDeg, transitSec, sunriseSec);
      if (d1 !== null) decs.push(d1);
    }
    if (sunsetSec !== null && sunsetSec !== undefined) {
      var d2 = deriveSunDeclination(apLatDeg, transitSec, sunsetSec);
      if (d2 !== null) decs.push(d2);
    }
    if (decs.length === 0) return null;
    var dec = decs.reduce(function (a, b) { return a + b; }, 0) / decs.length;

    var civilH = sunHourAngleForAltitude(apLatDeg, dec, STANDARD_ALTITUDE_DEG.civilTwilight);
    var nauticalH = sunHourAngleForAltitude(apLatDeg, dec, STANDARD_ALTITUDE_DEG.nauticalTwilight);

    return {
      civilAM: civilH === null ? null : transitSec - civilH,
      civilPM: civilH === null ? null : transitSec + civilH,
      nauticalAM: nauticalH === null ? null : transitSec - nauticalH,
      nauticalPM: nauticalH === null ? null : transitSec + nauticalH
    };
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
   * Pure: given a stored sight's "position" sub-object (the shape
   * collectFormState() produces: latDeg/latMin/latNS/lonDeg/lonMin/lonEW),
   * returns signed decimal degrees (S/W negative). This is the non-DOM
   * counterpart to app.js's getAssumedPositionSigned() -- used when reading
   * a saved sight record directly (e.g. for a Fix plot) rather than
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
   * Pure: lays out multiple sights' AP + LOP geometry in one shared
   * North-up, nm-based plane, so they can be overlaid on a single chart.
   *
   * Each sight's AP may differ slightly (e.g. a 3-star fix taken over a
   * few minutes, or genuinely different APs) -- the shared origin is the
   * centroid of all APs, and each sight's own AP is placed at its offset
   * from that centroid (flat-earth approximation: dx = dLon*60*cos(refLat),
   * dy = dLat*60, both in nm -- entirely adequate at chart-plotting scale).
   * A sight's own LOP geometry (computeLopGeometry, relative to ITS OWN
   * AP) is then translated by that same offset into the shared frame.
   *
   * sights: [{ lat, lon, zn, interceptNM, ...anything else the caller
   *               wants carried through untouched, e.g. label/color/id }]
   *
   * A sight that's been advanced for a Running Fix (see fixes.js) may
   * also carry originalLat/originalLon -- its own as-observed AP, before
   * the DR-Leg shift. When present, this also computes originalApPoint and
   * originalInterceptPoint in the SAME shared frame, using the SAME
   * lopDirection/azimuthUnit -- correct because advancing an LOP is a pure
   * translation (see SightCalc.advancePositionByLeg's own comment), so the
   * original and advanced LOPs are just two parallel lines through the same
   * relative intercept offset, anchored at two different APs.
   *
   * Returns {
   *   originLat, originLon,          -- the centroid AP (decimal degrees)
   *   maxExtentNM,                    -- farthest point from origin, for scale selection
   *   sights: [{
   *     ...all original fields carried through,
   *     apPoint, azimuthUnit, interceptPoint, lopDirection,   -- all in shared nm frame
   *     originalApPoint?, originalInterceptPoint?              -- only if originalLat/originalLon given
   *   }]
   * }
   */
  /**
   * originOverride (optional): {lat, lon} to use as the origin instead of
   * the average of the input sights' own positions. Needed for semantic
   * zoom/pan -- re-deriving every point's pixel position from a
   * caller-chosen geographic viewport, rather than always the best-fit
   * origin computed from the data -- since without this, every render
   * would recenter itself on the data's own average regardless of where
   * the user had panned to, undoing the pan on every redraw.
   */
  function computeMultiLopGeometry(sights, originOverride) {
    if (!sights || sights.length === 0) {
      return { originLat: 0, originLon: 0, maxExtentNM: 0, sights: [] };
    }

    var n = sights.length;
    var originLat = originOverride ? originOverride.lat : (sights.reduce(function (sum, s) { return sum + s.lat; }, 0) / n);
    var originLon = originOverride ? originOverride.lon : (sights.reduce(function (sum, s) { return sum + s.lon; }, 0) / n);
    var originLatRad = rad(originLat);
    var cosOriginLat = Math.cos(originLatRad);

    var maxExtentNM = 0;
    var results = sights.map(function (s) {
      var dLat = s.lat - originLat;
      var dLon = s.lon - originLon;
      var apPoint = {
        x: dLon * 60 * cosOriginLat, // East nm
        y: dLat * 60                // North nm
      };

      var localGeo = computeLopGeometry(s.zn, s.interceptNM); // relative to this sight's own AP
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

      if (typeof s.originalLat === 'number' && typeof s.originalLon === 'number') {
        var originalApPoint = {
          x: (s.originalLon - originLon) * 60 * cosOriginLat,
          y: (s.originalLat - originLat) * 60
        };
        var originalInterceptPoint = {
          x: originalApPoint.x + localGeo.interceptPoint.x,
          y: originalApPoint.y + localGeo.interceptPoint.y
        };
        maxExtentNM = Math.max(maxExtentNM, Math.hypot(originalApPoint.x, originalApPoint.y), Math.hypot(originalInterceptPoint.x, originalInterceptPoint.y));
        out.originalApPoint = originalApPoint;
        out.originalInterceptPoint = originalInterceptPoint;
      }

      return out;
    });

    return { originLat: originLat, originLon: originLon, maxExtentNM: maxExtentNM, sights: results };
  }

  /**
   * Pure: bearing (0-360, clockwise from North) that a given azimuthUnit {x,y} points along.
   */
  function azimuthDegFromUnit(u) {
    return (deg(Math.atan2(u.x, u.y)) + 360) % 360;
  }

  /**
   * Pure: out of 3+ sights, picks the 3 whose azimuths are most evenly
   * spread around the compass -- specifically, the triple that maximizes the
   * smallest of the three gaps between them. A narrow gap between any two
   * means those two LOPs cross at a shallow angle, which is exactly what
   * makes both a plain intersection AND the bisector construction below
   * unreliable (small altitude errors swing the crossing point a long way).
   * Returns [i, j, k] (indices into `sights`), or null if fewer than 3.
   */
  function selectWidestAzimuthSpreadTriple(sights) {
    if (!sights || sights.length < 3) return null;

    var azimuths = sights.map(function (s) { return azimuthDegFromUnit(s.azimuthUnit); });
    var best = null;
    var bestScore = -1;

    for (var i = 0; i < sights.length; i++) {
      for (var j = i + 1; j < sights.length; j++) {
        for (var k = j + 1; k < sights.length; k++) {
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
   * (a LOP's normal is exactly its sight's azimuthUnit -- the LOP is
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
   * triple: exactly 3 sights, each { azimuthUnit: {x,y}, interceptPoint: {x,y} }
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
   * sights: [{ azimuthUnit: {x,y}, interceptPoint: {x,y} }, ...]
   *
   * Returns { solvable: false, reason } or
   *         { solvable: true, leastSquaresPoint: {x,y}, bisector?: {...} }
   */
  function resolveMultiLopFix(sights) {
    if (!sights || sights.length < 2) {
      return { solvable: false, reason: 'Need at least 2 plotted LOPs to resolve a fix.' };
    }

    var Sxx = 0, Sxy = 0, Syy = 0, Sxc = 0, Syc = 0;
    sights.forEach(function (s) {
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

    if (sights.length >= 3) {
      var tripleIndices = sights.length === 3 ? [0, 1, 2] : selectWidestAzimuthSpreadTriple(sights);
      var triple = tripleIndices.map(function (idx) { return sights[idx]; });
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

  /**
   * Inverse of positionFromOffset: given an origin and a second point (both
   * signed decimal degrees), returns the second point's {x, y} nm-offset
   * from the origin in the same local-flat approximation used throughout
   * this file's chart geometry (x=East, y=North). Needed for any chart that
   * plots two real lat/lon positions relative to each other rather than
   * starting from an intercept/azimuth (e.g. a DR leg's start and end).
   */
  function offsetFromPosition(originLat, originLon, lat, lon) {
    var cosOriginLat = Math.cos(rad(originLat)) || 1e-9;
    return {
      x: (lon - originLon) * 60 * cosOriginLat,
      y: (lat - originLat) * 60
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

  /**
   * Terse, uppercase body name for celestial LOP chart labels specifically
   * -- "SUN", "MOON", "VEGA", "JUPITER" -- matching standard USCG/commercial
   * plotting convention (a celestial LOP is labeled with the body's name
   * plus the observation time, e.g. "SUN 0915"; a star or planet is
   * labeled by its own name, not "Star Vega"). Distinct from
   * formatBodyLabel(), which is for UI text (sight lists, legends) where
   * the fuller "Star Vega" phrasing reads better.
   */
  function formatBodyLabelChart(body) {
    if (!body) return 'BODY';
    if ((body.type === 'star' || body.type === 'planet') && body.name) {
      return body.name.toUpperCase();
    }
    return body.type.toUpperCase();
  }

  /**
   * Pure: derives a default name for a Sight record from its own data --
   * "yyyy-mm-dd HH.mm.ss Type Name" -- using the clock-error-corrected
   * average local time of its observations. Used as the default text
   * offered in the Save/Export prompts on the New Sight page, and as the
   * title assigned automatically when a sight is imported directly (the
   * Sights page's Import button saves straight to storage with no naming
   * prompt) -- since a Sight's own JSON export never carries a title at
   * all (title is storage metadata, attached only at SightStorage.save()
   * time, not part of the record's own data), every import needs this
   * computed fresh rather than ever finding one already present.
   *
   * Moved here from app.js (previously index.html-only) because it's a
   * pure function of the state object it's given -- no DOM access -- and
   * needed to be callable from sights.js too, which doesn't load app.js.
   *
   * state: a Sight-shaped object -- { date, observations, corrections,
   *   body: { type, name } }. Same shape collectFormState() produces on
   *   the New Sight page, and the same shape a parsed import file already
   *   has, so both callers can pass their object straight through.
   */
  function computeAutoName(state) {
    var pad2 = function (n) { return String(n).padStart(2, '0'); };
    var now = new Date();

    var dateStr = state.date || now.toISOString().split('T')[0];

    var avg = averageObservations(state.observations);
    var timeStr;
    if (avg) {
      var corr = state.corrections || {};
      var sign = (corr.clockErrorDirection === 'fast') ? -1 : 1;
      var correctedSec = ((avg.avgLocalSec + sign * (corr.clockErrorSec || 0)) % 86400 + 86400) % 86400;
      var h = Math.floor(correctedSec / 3600);
      var m = Math.floor((correctedSec % 3600) / 60);
      var s = Math.floor(correctedSec % 60);
      timeStr = pad2(h) + '.' + pad2(m) + '.' + pad2(s);
    } else {
      timeStr = pad2(now.getHours()) + '.' + pad2(now.getMinutes()) + '.' + pad2(now.getSeconds());
    }

    // Sun/Moon are themselves proper nouns and get capitalized; "star"/"planet"
    // are just category words, so they stay lowercase -- only the actual name
    // that follows (Arcturus, Venus, etc.) is the proper noun there.
    var rawType = (state.body && state.body.type) || 'sight';
    var properTypeNames = { sun: 'Sun', moon: 'Moon' };
    var typeStr = properTypeNames[rawType] || rawType;
    var nameStr = ((state.body && state.body.name) || '').trim();

    var parts = [dateStr, timeStr, typeStr];
    if (nameStr) parts.push(nameStr);

    // Strip characters that are illegal (or awkward) in filenames on common filesystems.
    return parts.join(' ').replace(/[\\/:*?"<>|]/g, '_');
  }

  var CHART_PALETTE = ['#00bcd4', '#ff9800', '#8bc34a', '#e91e63', '#9c27b0', '#ffeb3b', '#03a9f4', '#ff5722'];

  /** Stable color for a given sight index, cycling through CHART_PALETTE. Single source of truth so a sight's color is identical everywhere it's shown (a fix's sight list, its plot, its legend). */
  function paletteColor(index) {
    var i = ((index % CHART_PALETTE.length) + CHART_PALETTE.length) % CHART_PALETTE.length;
    return CHART_PALETTE[i];
  }

  /** Format signed decimal latitude as "D° MM.M' N" (or S). */
  function formatLat(signedDeg) {
    return formatDegMin(Math.abs(signedDeg)) + ' ' + (signedDeg < 0 ? 'S' : 'N');
  }

  /** Format signed decimal longitude as "D° MM.M' E" (or W). */
  function formatLon(signedDeg) {
    return formatDegMin(Math.abs(signedDeg)) + ' ' + (signedDeg < 0 ? 'W' : 'E');
  }

  /**
   * Combines a local calendar date ("yyyy-mm-dd"), a local time-of-day
   * (seconds since local midnight), and a UTC offset (hours, e.g. -4 for
   * EDT) into the true UTC instant, in milliseconds since the epoch.
   *
   * This is genuine multi-day date arithmetic using a real JS Date -- unlike
   * the Sun/Moon rise-set helpers above (which only ever need to reason
   * about a single calendar day and wrap seconds-of-day into [0, 86400)),
   * DR Leg runs can span many hours or cross into following days, so the
   * calendar date itself has to move, not just wrap.
   */
  function localDateTimeToUtcMs(dateStr, localSecOfDay, tzOffsetHours) {
    var p = dateStr.split('-');
    var y = parseInt(p[0], 10), mo = parseInt(p[1], 10) - 1, d = parseInt(p[2], 10);
    var localMs = Date.UTC(y, mo, d, 0, 0, 0) + localSecOfDay * 1000;
    return localMs - tzOffsetHours * 3600 * 1000;
  }

  /**
   * Inverse of localDateTimeToUtcMs: given a true UTC instant (ms since
   * epoch) and a UTC offset, returns the local calendar date + time of day
   * it corresponds to.
   */
  function utcMsToLocalDateTime(utcMs, tzOffsetHours) {
    var localMs = utcMs + tzOffsetHours * 3600 * 1000;
    var d = new Date(localMs);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return {
      dateStr: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
      secOfDay: d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds()
    };
  }

  /**
   * Rounds a UTC instant (ms since epoch) UP to the next whole minute --
   * a no-op if it's already exact. For writing a precise instant (which may
   * carry seconds, e.g. a Fix's resolvedPosition.time, timestamped from a
   * Sight's own observation seconds) into a field that can only represent
   * whole minutes (DR Leg's start time has no seconds input, matching how a
   * DR leg is actually logged in practice). Rounds UP, deliberately never
   * down: flooring would make the derived time appear to precede the exact
   * instant it was derived from -- e.g. a Fix resolved at 21:17:40 flooring
   * to a DR Leg start of 21:17 would make the leg look like it began before
   * the very fix that established its starting position, which can't be
   * right. Operates on milliseconds (not a local date/secOfDay pair) so a
   * rollover into the next minute, hour, day, or even month/year is just
   * ordinary arithmetic -- no calendar logic needed here at all.
   */
  function roundUpToMinuteMs(utcMs) {
    var minuteMs = 60000;
    return Math.ceil(utcMs / minuteMs) * minuteMs;
  }

  /**
   * Position { time, lat, lon, sourceType, sourceId } -- the one shared shape
   * for "a place at a moment, and how we know it" used across DR Leg, Fix,
   * Passage, and the handoffs between pages. Before this existed as one
   * type, the same concept was scattered in three incompatible partial
   * forms: a Sight's AP had no time attached to it at all, a Fix's resolved
   * point had neither a stored time nor a persisted value in the first
   * place (recomputed live and thrown away), and a DR Leg's result had a
   * time but no record of where it came from.
   *
   * time: ISO 8601 UTC string, or null if only a date (no specific instant)
   *       is meaningful -- e.g. Planning's AP isn't tied to one instant.
   * lat/lon: signed decimal degrees (N/E positive).
   * sourceType: one of POSITION_SOURCE_TYPES -- how much to trust this
   *       position. KNOWN is exact (GPS, a charted mark, hand-verified);
   *       FIX is the best current celestial/other estimate; DR is
   *       provisional and accumulates uncertainty the longer it's been
   *       projected without a new fix.
   * sourceId: the id of the specific record this position came from (a Fix
   *       id, a DR Leg id), or null if it isn't backed by one -- e.g. a
   *       hand-typed KNOWN position, or a DR Leg's own live result before
   *       it's been saved (it can't reference a record that doesn't exist
   *       yet). This is what lets a UI eventually say "current position:
   *       DR, derived from DR Leg #7" instead of just "DR" with no way to
   *       go look at the leg that produced it. Set by whichever code is
   *       handing this position to another record, at the moment of
   *       handoff -- not necessarily by whoever first computed it (e.g. a
   *       Fix's resolvedPosition gets its own id stamped on save, but a
   *       live/unsaved DR Leg's endPosition stays null until that leg is
   *       actually saved, since only then does it have a stable id to
   *       point back to).
   */
  var POSITION_SOURCE_TYPES = { KNOWN: 'KNOWN', FIX: 'FIX', DR: 'DR' };

  function makePosition(time, lat, lon, sourceType, sourceId) {
    return { time: time || null, lat: lat, lon: lon, sourceType: sourceType, sourceId: sourceId || null };
  }

  /**
   * Dead Reckoning position via Mid-Latitude Sailing (Bowditch/Dutton's
   * standard method for exactly this: given a start position, a true
   * course, and a distance run, find the resulting position). Accurate for
   * the leg lengths DR is normally used for; a genuinely long leg (ocean-
   * crossing scale) would call for full Mercator or great-circle sailing,
   * but mid-latitude sailing is what's conventionally used for DR between
   * fixes.
   *
   * startLatDeg/startLonDeg: signed decimal degrees (N/E positive).
   * courseDegTrue: true course, 0-360 (0 = North, 90 = East, measured clockwise).
   * distanceNM: nautical miles run (1 NM = 1 minute of latitude, by definition).
   *
   * Returns signed decimal degrees, longitude normalized into (-180, 180],
   * plus the intermediate departure (east-west distance run, NM) since
   * that's often worth showing alongside the result.
   */
  function drPosition(startLatDeg, startLonDeg, courseDegTrue, distanceNM) {
    var C = rad(courseDegTrue);
    var dLatMin = distanceNM * Math.cos(C);
    var newLatDeg = startLatDeg + dLatMin / 60;

    var meanLatDeg = (startLatDeg + newLatDeg) / 2;
    var cosMeanLat = Math.cos(rad(meanLatDeg));
    var departureNM = distanceNM * Math.sin(C);

    // A course running due north/south right at the pole has no meaningful
    // departure/longitude-change -- there's no real DR leg this applies to,
    // but guard the division rather than blow up on it.
    var dLonDeg = (Math.abs(cosMeanLat) < 1e-9) ? 0 : (departureNM / 60) / cosMeanLat;
    var newLonDeg = startLonDeg + dLonDeg;
    while (newLonDeg > 180) newLonDeg -= 360;
    while (newLonDeg <= -180) newLonDeg += 360;

    return { latDeg: newLatDeg, lonDeg: newLonDeg, departureNM: departureNM };
  }

  /**
   * A full DR leg: start position + instant, course, speed, and EITHER a
   * duration or an end instant (pass exactly one of durationHours/endUtcMs
   * as a number; leave the other null/undefined -- it's the one being
   * solved for). Returns the DR position plus both the duration and end
   * instant either way, so the caller never has to branch on which one was
   * the input.
   */
  function computeDrLeg(input) {
    var durationHours = input.durationHours;
    var endUtcMs = input.endUtcMs;

    if (durationHours === null || durationHours === undefined) {
      durationHours = (endUtcMs - input.startUtcMs) / 3600000;
    } else {
      endUtcMs = input.startUtcMs + durationHours * 3600000;
    }

    var distanceNM = input.sog * durationHours;
    var pos = drPosition(input.startLatDeg, input.startLonDeg, input.courseDegTrue, distanceNM);

    return {
      latDeg: pos.latDeg,
      lonDeg: pos.lonDeg,
      departureNM: pos.departureNM,
      distanceNM: distanceNM,
      durationHours: durationHours,
      endUtcMs: endUtcMs
    };
  }

  /**
   * Advances a point by a DR Leg's course and distance -- the core geometry
   * of a Running Fix, and deliberately just this: given an assumed position
   * (usually a Sight's own AP) and a saved DrLeg record, returns where that
   * point ends up after the SAME run the leg represents.
   *
   * Why this is all a Running Fix actually needs: an LOP is a line through
   * (AP, offset by intercept along Zn). Advancing that LOP by a DR run is a
   * pure parallel translation of the whole line -- which is exactly the
   * same as leaving Zn and intercept untouched and moving the AP itself by
   * the run's vector. So "advance this LOP" reduces to "advance this AP,"
   * and the result feeds into the EXACT SAME multi-LOP solver
   * (resolveMultiLopFix, in chart.js) used for any ordinary fix -- it
   * already tolerates each LOP having its own AP, which was the whole
   * reason a Running Fix doesn't need its own separate geometry solver.
   *
   * Uses the leg's course and (sog * durationHours) distance -- not its
   * own recorded start/end lat/lon -- so this works correctly even when
   * the leg's start position doesn't exactly match the AP being advanced
   * (e.g. rounding differences between how the AP and the leg were each
   * entered); real running fixes are worked the same way, by applying
   * course and distance run, not by requiring two positions to coincide
   * exactly.
   */
  function advancePositionByLeg(latDeg, lonDeg, leg) {
    var distanceNM = leg.sog * leg.durationHours;
    var pos = drPosition(latDeg, lonDeg, leg.courseDegTrue, distanceNM);
    return { lat: pos.latDeg, lon: pos.lonDeg };
  }

  global.SightCalc = {
    rad: rad,
    deg: deg,
    dmToDecimal: dmToDecimal,
    formatDegMin: formatDegMin,
    formatLat: formatLat,
    formatLon: formatLon,
    secondsToTimeString: secondsToTimeString,
    averageObservations: averageObservations,
    computeHa: computeHa,
    computeHo: computeHo,
    utcSecondsFromLocal: utcSecondsFromLocal,
    localFromUtcSeconds: localFromUtcSeconds,
    interpolateByLatitude: interpolateByLatitude,
    utcFromLmtSeconds: utcFromLmtSeconds,
    manualEventToZoneTime: manualEventToZoneTime,
    applyMoonLongitudeCorrection: applyMoonLongitudeCorrection,
    deriveSunDeclination: deriveSunDeclination,
    sunHourAngleForAltitude: sunHourAngleForAltitude,
    computeTwilightTimes: computeTwilightTimes,
    localDateTimeToUtcMs: localDateTimeToUtcMs,
    utcMsToLocalDateTime: utcMsToLocalDateTime,
    roundUpToMinuteMs: roundUpToMinuteMs,
    POSITION_SOURCE_TYPES: POSITION_SOURCE_TYPES,
    makePosition: makePosition,
    drPosition: drPosition,
    computeDrLeg: computeDrLeg,
    advancePositionByLeg: advancePositionByLeg,
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
    offsetFromPosition: offsetFromPosition,
    formatBodyLabel: formatBodyLabel,
    formatBodyLabelChart: formatBodyLabelChart,
    computeAutoName: computeAutoName,
    paletteColor: paletteColor
  };
})(window);
