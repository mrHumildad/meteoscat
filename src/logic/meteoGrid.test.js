import { describe, it, expect } from 'vitest';
import {
  buildMeteoGrid,
  sampleMeteoGrid,
  distKm,
  getMeteoGrid,
  GRID_BOUNDS,
} from './meteoGrid.js';

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
  it('caches per (windowKey, variable)', () => {
    const g1 = getMeteoGrid('w1', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    const g2 = getMeteoGrid('w1', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    expect(g2).toBe(g1); // same window + variable → same cached grid
    const g3 = getMeteoGrid('w2', 'tempAvg', [feat('A', 2, 42, { tempAvg: 10 })]);
    expect(g3).not.toBe(g1); // different window → rebuilt
  });
});