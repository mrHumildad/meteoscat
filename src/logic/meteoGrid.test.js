import { describe, it, expect } from 'vitest';
import {
  buildMeteoGrid,
  sampleMeteoGrid,
  distKm,
  getMeteoGrid,
  featuresForWindow,
  GRID_BOUNDS,
} from './meteoGrid.js';
import { buildAggregateTable } from './filterAggregate.js';

// Features mirror the shape produced by computeGeoValues.js:
// geometry Point [lng, lat], properties = { codi, altitud, tempAvg, ... }
const feat = (codi, lng, lat, props = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { codi, altitud: 0, ...props },
});

describe('distKm', () => {
  it('approximates 1 degree of latitude (~111 km)', () => {
    expect(distKm(2, 42, 2, 43)).toBeCloseTo(111.19, 0);
  });

  it('handles longitude degrees at the equator', () => {
    expect(distKm(0, 0, 1, 0)).toBeCloseTo(111.19, 0);
  });

  it('is symmetric', () => {
    expect(distKm(1, 41, 2, 42)).toBeCloseTo(distKm(2, 42, 1, 41), 6);
  });
});

describe('buildMeteoGrid', () => {
  it('reproduces a single station value everywhere within reach', () => {
    const grid = buildMeteoGrid([feat('A', 2, 42, { tempAvg: 15 })], 'tempAvg');
    expect(sampleMeteoGrid(grid, 2, 42)).toBeCloseTo(15, 3);
    expect(sampleMeteoGrid(grid, 2.05, 42.03)).toBeCloseTo(15, 3);
  });

  it('weights two stations by inverse distance (midpoint = mean)', () => {
    const grid = buildMeteoGrid([
      feat('A', 2, 42, { tempAvg: 10 }),
      feat('B', 2.1, 42, { tempAvg: 30 }),
    ], 'tempAvg');
    expect(sampleMeteoGrid(grid, 2.05, 42)).toBeCloseTo(20, 3);
  });

  it('is no-data (NaN) beyond maxDistKm instead of extrapolating', () => {
    const grid = buildMeteoGrid([feat('A', 2, 42, { tempAvg: 10 })], 'tempAvg', { maxDistKm: 10 });
    expect(Number.isNaN(sampleMeteoGrid(grid, 0.5, 42))).toBe(true); // ~124 km away
    expect(Number.isNaN(sampleMeteoGrid(grid, 2.05, 42))).toBe(false); // ~5 km away
  });

  it('is no-data outside the grid bounds', () => {
    const grid = buildMeteoGrid([feat('A', 2, 42, { tempAvg: 10 })], 'tempAvg');
    expect(Number.isNaN(sampleMeteoGrid(grid, GRID_BOUNDS.west - 0.1, 42))).toBe(true);
    expect(Number.isNaN(sampleMeteoGrid(grid, 2, GRID_BOUNDS.north + 0.1))).toBe(true);
  });

  it('excludes stations without data for the variable', () => {
    const grid = buildMeteoGrid([
      feat('A', 2, 42, { tempAvg: 10 }),
      feat('B', 2.1, 42, { tempAvg: null }),  // no data → must not pull the field
      feat('C', 2.2, 42, { tempAvg: undefined }),
    ], 'tempAvg');
    expect(sampleMeteoGrid(grid, 2.05, 42)).toBeCloseTo(10, 3);
  });

  it('reduces temperatures to sea level when a lapse rate is set', () => {
    // 15 °C at 2000 m → 15 + 6.5·2 = 28 °C at sea level
    const grid = buildMeteoGrid(
      [feat('A', 2, 42, { tempAvg: 15, altitud: 2000 })],
      'tempAvg',
      { lapseRate: 6.5 }
    );
    expect(sampleMeteoGrid(grid, 2, 42)).toBeCloseTo(28, 3);
    expect(grid.lapseRate).toBe(6.5);
  });

  it('keeps raw values for stations lacking altitud even with a lapse rate', () => {
    const grid = buildMeteoGrid(
      [feat('A', 2, 42, { tempAvg: 15 })],
      'tempAvg',
      { lapseRate: 6.5 }
    );
    expect(sampleMeteoGrid(grid, 2, 42)).toBeCloseTo(15, 3);
  });

  it('produces an all-NaN grid when no station has data', () => {
    const grid = buildMeteoGrid([feat('A', 2, 42, { tempAvg: null })], 'tempAvg');
    expect(Number.isNaN(sampleMeteoGrid(grid, 2, 42))).toBe(true);
  });
});

describe('sampleMeteoGrid', () => {
  // Hand-built grid with known node values, so the bilinear blending itself
  // is tested independently of IDW (which is not linear between nodes):
  //   lat 40.00: [0, 10, 20]
  //   lat 40.01: [100, 110, 120]
  //   lat 40.02: [200, 210, 220]
  const grid = {
    data: new Float32Array([0, 10, 20, 100, 110, 120, 200, 210, 220]),
    width: 3, height: 3, west: 0, south: 40, step: 0.01,
  };

  it('returns the exact node value at grid nodes', () => {
    expect(sampleMeteoGrid(grid, 0.01, 40.01)).toBeCloseTo(110, 6);
  });

  it('blends the four surrounding nodes bilinearly', () => {
    // (0.005, 40.005): corners 0, 10, 100, 110 → (5 + 105) / 2 = 55
    expect(sampleMeteoGrid(grid, 0.005, 40.005)).toBeCloseTo(55, 6);
  });

  it('interpolates along the grid edge', () => {
    // (0.005, 40.00): halfway between 0 and 10
    expect(sampleMeteoGrid(grid, 0.005, 40)).toBeCloseTo(5, 6);
  });
});

describe('getMeteoGrid', () => {
  it('caches per (concrete window, variable)', () => {
    const g1 = getMeteoGrid('2026-09-01_2026-09-02', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    const g2 = getMeteoGrid('2026-09-01_2026-09-02', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    expect(g2).toBe(g1); // same window + variable → same cached grid
    const g3 = getMeteoGrid('2026-09-02_2026-09-03', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    expect(g3).not.toBe(g1); // different window → rebuilt
  });
});

describe('featuresForWindow', () => {
  const agg = buildAggregateTable({
    '2026-09-01': {
      A: { tempAvg: 10, humAvg: 60, precAcc: 5 },
      B: { tempAvg: 25, humAvg: 40, precAcc: 2 },
    },
    '2026-09-02': {
      A: { tempAvg: 12, humAvg: 70, precAcc: 3 },
      B: { tempAvg: 27, humAvg: 45, precAcc: 0 },
    },
    '2026-09-03': {
      A: { tempAvg: 11, humAvg: 65, precAcc: 1.5 },
    },
  });
  const features = [
    feat('A', 2, 42),
    feat('B', 2.1, 42),
    feat('X', 2.2, 42), // absent from the aggregate table
  ];

  it('computes each station aggregate over the window into the variable property', () => {
    const out = featuresForWindow(agg, features, 'precAcc', '2026-09-01', '2026-09-03');
    expect(out[0].properties.precAcc).toBeCloseTo(9.5, 10); // A: 5+3+1.5
    expect(out[1].properties.precAcc).toBeCloseTo(2, 10);   // B: 2+0 (09-03 missing)
    expect(out[2].properties.precAcc).toBeNull();           // X: no data
  });

  it('preserves geometry, codi and altitud', () => {
    const out = featuresForWindow(agg, features, 'tempAvg', '2026-09-01', '2026-09-03');
    expect(out[0].geometry.coordinates).toEqual([2, 42]);
    expect(out[0].properties.codi).toBe('A');
    expect(out[0].properties.altitud).toBe(0);
    expect(out[0].properties.tempAvg).toBeCloseTo(11, 10); // (10+12+11)/3
  });

  it('respects the window endpoints', () => {
    const out = featuresForWindow(agg, features, 'precAcc', '2026-09-02', '2026-09-02');
    expect(out[0].properties.precAcc).toBeCloseTo(3, 10); // A on 09-02 only
    expect(out[1].properties.precAcc).toBeCloseTo(0, 10); // B on 09-02
  });

  it('returns [] for unknown variables or no features', () => {
    expect(featuresForWindow(agg, features, 'bogus', '2026-09-01', '2026-09-03')).toEqual([]);
    expect(featuresForWindow(agg, [], 'precAcc', '2026-09-01', '2026-09-03')).toEqual([]);
  });
});