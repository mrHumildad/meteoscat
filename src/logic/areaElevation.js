// Altitude profile of the DISC analysed around a picked point.
//
// The directions modal reads a point as an area (the radius slider), so the
// terrain question is not "how high is this spot?" but "what altitudes does
// this patch cover?". This module answers it: it lays a regular grid of sample
// points inside the circle and asks the DEM (elevation.js) for each one, then
// orders the values low → high into the line the chart plots (altitude on the
// Y axis, the Nth lowest sampled point on the X axis).
//
// Everything except the DEM fetch is pure and DOM-free so it is unit-testable;
// the fetch itself is the cached, bilinear `sampleElevation`, so a whole disc
// costs one tile download per tile it touches (the per-tile promise is shared
// by every sample that lands on it).

import { sampleElevation } from './elevation.js';

// Grid resolution: a 32×32 lattice over the bounding square keeps the ~π/4
// points that fall inside the disc (≈800 samples). At the 2.5 km maximum that
// is a sample every ~125 m, and at the 500 m minimum every ~25 m — well inside
// the ~14 m/px DEM resolution at Catalonia's latitude, and cheap in arithmetic
// because the DEM tiles are already decoded once.
export const AREA_SAMPLE_GRID = 32;

// Breathing room above and below the line, as a share of the altitude span,
// so the two extreme samples don't sit exactly on the plot border.
const PROFILE_PAD_RATIO = 0.08;

const M_PER_DEG_LAT = 111320;

/**
 * Regular grid of lng/lat points inside the disc of `radiusM` around
 * (lat, lng). Square cells are mapped to [-1, 1] and the ones outside the
 * unit circle are dropped, so the samples fill the disc rather than the box
 * that bounds it. The local metric is treated as flat (errors are negligible
 * at a few km, and the DEM sample is approximate anyway).
 */
export const areaSamplePoints = (lat, lng, radiusM, grid = AREA_SAMPLE_GRID) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  if (!Number.isFinite(radiusM) || radiusM <= 0) return [];
  const n = Math.max(2, Math.floor(grid));
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  const points = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const u = ((i + 0.5) / n) * 2 - 1; // west (-1) → east (+1)
      const v = ((j + 0.5) / n) * 2 - 1; // north (-1) → south (+1)
      if (u * u + v * v > 1) continue;
      points.push({ lat: lat - v * dLat, lng: lng + u * dLng });
    }
  }
  return points;
};

/** Sample the DEM at every point of the disc; tiles are decoded once each. */
export const sampleAreaElevations = async (lat, lng, radiusM, grid = AREA_SAMPLE_GRID) => {
  const points = areaSamplePoints(lat, lng, radiusM, grid);
  if (!points.length) return [];
  // All samples are launched together: every point in the same DEM tile awaits
  // the same cached promise, so this resolves into one parallel fetch per tile
  // instead of a serial walk of the grid.
  const values = await Promise.all(points.map(p => sampleElevation(p.lng, p.lat)));
  return values.filter(Number.isFinite);
};

/**
 * Altitude profile of a set of sampled points (m): the values SORTED low →
 * high (that order is the chart's X axis), the summary numbers, and the padded
 * Y range the line is mapped onto. Returns null when there is nothing to plot,
 * so the caller can show "no data".
 */
export const buildElevationProfile = (values) => {
  const clean = (values ?? []).filter(Number.isFinite);
  if (!clean.length) return null;

  const asc = [...clean].sort((a, b) => a - b);
  const min = asc[0];
  const max = asc[asc.length - 1];
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
  const mid = asc.length >> 1;
  const median = asc.length % 2 ? asc[mid] : (asc[mid - 1] + asc[mid]) / 2;

  // A perfectly flat area (span 0) still needs a non-zero plot box.
  const span = max - min;
  const pad = span > 0 ? span * PROFILE_PAD_RATIO : Math.max(5, Math.abs(max) * 0.02);

  return {
    values: asc,
    count: asc.length,
    min,
    max,
    mean,
    median,
    yMin: min - pad,
    yMax: max + pad,
  };
};

/**
 * `points` attribute of the SVG polyline for a profile: X spreads the N
 * samples evenly over [0, width] (1st lowest on the left, highest on the
 * right), Y maps altitude onto [height, 0] — SVG's Y grows downwards, so the
 * highest sample ends up at the top. Pure, so the chart geometry is tested
 * instead of eyeballed. Empty string for an empty profile.
 */
export const elevationLinePoints = (profile, width = 100, height = 100) => {
  const values = profile?.values ?? [];
  if (!values.length) return '';
  const span = profile.yMax - profile.yMin || 1;
  const last = values.length - 1;
  const round2 = n => Math.round(n * 100) / 100;
  return values
    .map((v, i) => {
      // A single sample has no span to spread over: centre it.
      const x = last === 0 ? width / 2 : (i / last) * width;
      const y = height - ((v - profile.yMin) / span) * height;
      return `${round2(x)},${round2(y)}`;
    })
    .join(' ');
};
