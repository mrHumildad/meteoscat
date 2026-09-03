import { describe, it, expect } from 'vitest';
import { lngLatToTileXY, tileXYToLngLat, terrariumElevation, clamp } from './elevation.js';

describe('lngLatToTileXY', () => {
  it('maps the meridian/equator intersection onto tile (1,1) at z1, pixel origin', () => {
    const t = lngLatToTileXY(0, 0, 1);
    expect(t.z).toBe(1);
    expect(t.x).toBe(1);
    expect(t.y).toBe(1);
    expect(t.px).toBeCloseTo(0, 6);
    expect(t.py).toBeCloseTo(0, 6);
  });

  it('keeps pixel offsets inside the 256 px tile for a point in Catalonia', () => {
    const t = lngLatToTileXY(1.9, 41.9, 13);
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.px).toBeGreaterThanOrEqual(0);
    expect(t.px).toBeLessThan(256);
    expect(t.py).toBeGreaterThanOrEqual(0);
    expect(t.py).toBeLessThan(256);
  });

  it('returns finite coordinates across the app bounds', () => {
    // Catalonia bounding box corners
    for (const [lng, lat] of [[-1, 40], [4, 40], [-1, 44], [4, 44]]) {
      const t = lngLatToTileXY(lng, lat, 12);
      expect(Number.isFinite(t.x)).toBe(true);
      expect(Number.isFinite(t.y)).toBe(true);
      expect(Number.isFinite(t.px)).toBe(true);
      expect(Number.isFinite(t.py)).toBe(true);
    }
  });
});

describe('tileXYToLngLat', () => {
  it('round-trips lng/lat through tile pixel coordinates', () => {
    for (const [lng, lat] of [[0, 0], [1.9, 41.9], [-1, 40], [4, 44]]) {
      for (const z of [7, 12, 15]) {
        const t = lngLatToTileXY(lng, lat, z);
        const back = tileXYToLngLat(z, t.x, t.y, t.px, t.py);
        expect(back.lng).toBeCloseTo(lng, 5);
        expect(back.lat).toBeCloseTo(lat, 5);
      }
    }
  });

  it('maps a tile origin to the tile corner', () => {
    // z1 tile (1,1) origin = meridian/equator (lngLatToTileXY(0,0,1) lands
    // exactly on that pixel), i.e. lng 0, lat 0
    const { lng, lat } = tileXYToLngLat(1, 1, 1, 0, 0);
    expect(lng).toBeCloseTo(0, 5);
    expect(lat).toBeCloseTo(0, 5);
  });

  it('returns finite lng/lat across the app bounds at tile zoom', () => {
    for (const z of [7, 12, 15]) {
      const { lng, lat } = tileXYToLngLat(z, 0, 0, 128, 128);
      expect(Number.isFinite(lng)).toBe(true);
      expect(Number.isFinite(lat)).toBe(true);
    }
  });
});

describe('terrariumElevation', () => {
  it('decodes 0 m from the neutral grey (128, 0, 0)', () => {
    expect(terrariumElevation(128, 0, 0)).toBeCloseTo(0, 5);
  });

  it('decodes +100 m', () => {
    expect(terrariumElevation(128, 100, 0)).toBeCloseTo(100, 5);
  });

  it('decodes negative elevations (below sea level)', () => {
    expect(terrariumElevation(126, 255, 255)).toBeCloseTo(-256, 1);
  });

  it('decodes a typical mountain height (≈ 1971 m, Núria)', () => {
    // 1971.4 + 32768 = 34739.4 → R = 135, then 34739 − 135*256 = 179 → G = 179
    expect(terrariumElevation(135, 179, 0)).toBeCloseTo(1971, 0);
  });
});

describe('clamp', () => {
  it('clamps to the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });
});