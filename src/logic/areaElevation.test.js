import { describe, it, expect } from 'vitest';
import {
  AREA_SAMPLE_GRID,
  areaSamplePoints,
  buildElevationProfile,
  elevationLinePoints,
} from './areaElevation.js';

const LAT = 41.9;
const LNG = 1.9;
const M_PER_DEG_LAT = 111320;

// Flat-earth distance in metres to a sample point around (LAT, LNG) — the same
// local approximation the sampler itself uses.
const offsetM = (p) => {
  const dy = (p.lat - LAT) * M_PER_DEG_LAT;
  const dx = (p.lng - LNG) * M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180);
  return Math.hypot(dx, dy);
};

describe('areaSamplePoints', () => {
  it('fills the disc, never the bounding square', () => {
    const radius = 1000;
    const points = areaSamplePoints(LAT, LNG, radius);
    expect(points.length).toBeGreaterThan(0.7 * AREA_SAMPLE_GRID ** 2);
    expect(points.length).toBeLessThan(0.85 * AREA_SAMPLE_GRID ** 2);
    for (const p of points) expect(offsetM(p)).toBeLessThanOrEqual(radius + 1e-6);
  });

  it('is symmetric around the centre and reaches every quadrant', () => {
    const points = areaSamplePoints(LAT, LNG, 1000);
    const east = points.filter(p => p.lng > LNG).length;
    const west = points.filter(p => p.lng < LNG).length;
    const north = points.filter(p => p.lat > LAT).length;
    const south = points.filter(p => p.lat < LAT).length;
    expect(east).toBe(west);
    expect(north).toBe(south);
  });

  it('scales with the radius and the grid resolution', () => {
    const small = areaSamplePoints(LAT, LNG, 500, 8);
    const big = areaSamplePoints(LAT, LNG, 1000, 8);
    expect(big.length).toBe(small.length); // same lattice, wider ring
    expect(Math.max(...big.map(offsetM))).toBeGreaterThan(Math.max(...small.map(offsetM)));
    expect(areaSamplePoints(LAT, LNG, 1000, 2)).toHaveLength(4);
  });

  it('refuses impossible inputs', () => {
    expect(areaSamplePoints(LAT, LNG, 0)).toEqual([]);
    expect(areaSamplePoints(LAT, LNG, -100)).toEqual([]);
    expect(areaSamplePoints(NaN, LNG, 1000)).toEqual([]);
    expect(areaSamplePoints(LAT, undefined, 1000)).toEqual([]);
  });
});

describe('buildElevationProfile', () => {
  it('orders the samples low → high and reports the summary', () => {
    const p = buildElevationProfile([810, 700, 730, 720]);
    expect(p.values).toEqual([700, 720, 730, 810]);
    expect(p).toMatchObject({ count: 4, min: 700, max: 810, mean: 740, median: 725 });
  });

  it('pads the Y range so the extremes are not on the border', () => {
    const p = buildElevationProfile([700, 800]);
    // span 100 → 8 % pad on each side
    expect(p.yMin).toBeCloseTo(692, 6);
    expect(p.yMax).toBeCloseTo(808, 6);
  });

  it('gives a flat area a real plot box', () => {
    const flat = buildElevationProfile([500, 500, 500]);
    expect(flat.min).toBe(500);
    expect(flat.max).toBe(500);
    expect(flat.yMin).toBeCloseTo(490, 6); // span 0 → 5 m floor
    expect(flat.yMax).toBeCloseTo(510, 6);

    const single = buildElevationProfile([1234]);
    expect(single.count).toBe(1);
    // 2 % of the altitude when the span gives no scale to work with
    expect(single.yMin).toBeCloseTo(1234 - 24.68, 6);
  });

  it('ignores non-finite samples and refuses an empty set', () => {
    expect(buildElevationProfile([])).toBeNull();
    expect(buildElevationProfile(null)).toBeNull();
    expect(buildElevationProfile([NaN, Infinity, null])).toBeNull();
    expect(buildElevationProfile([NaN, 320, 300, undefined]).values).toEqual([300, 320]);
  });
});

describe('elevationLinePoints', () => {
  it('maps the lowest sample to the bottom axis and the highest to the top', () => {
    // [0, 100] → span 100, pad 8 → Y range [-8, 108]
    expect(elevationLinePoints(buildElevationProfile([100, 0])))
      .toBe('0,93.1 100,6.9');
  });

  it('rises monotonically in altitude (and never leaves the box)', () => {
    const points = elevationLinePoints(buildElevationProfile([300, 310, 380, 900, 1200]))
      .split(' ')
      .map(pair => pair.split(',').map(Number));
    expect(points).toHaveLength(5);
    for (let i = 1; i < points.length; i++) {
      expect(points[i][1]).toBeLessThan(points[i - 1][1]); // SVG Y grows down
      expect(points[i][0]).toBeGreaterThan(points[i - 1][0]);
    }
    for (const [, y] of points) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(100);
    }
  });

  it('centres a single sample and spreads the rest evenly on X', () => {
    expect(elevationLinePoints(buildElevationProfile([500]))).toBe('50,50');
    const xs = elevationLinePoints(buildElevationProfile([1, 2, 3]), 90, 100)
      .split(' ').map(pair => Number(pair.split(',')[0]));
    expect(xs).toEqual([0, 45, 90]);
  });

  it('returns no points for an empty profile', () => {
    expect(elevationLinePoints(null)).toBe('');
    expect(elevationLinePoints({ values: [] })).toBe('');
  });
});
