// Unit tests for the per-screen Catalonia fit (mapFit.js): the minimum zoom
// must be the highest zoom that still fits the whole bounds in the viewport
// with padding — so zooming fully out shows exactly the region (plus margin),
// never half the planet on wide screens, and still all of it on phones.
import { describe, it, expect } from 'vitest';
import { CATALONIA_BOUNDS, TERRAIN_OVERLAY_BOUNDS, fitZoomForViewport } from './mapFit.js';

const [sw, ne] = CATALONIA_BOUNDS;
const [west, south, east, north] = [sw[0], sw[1], ne[0], ne[1]];

// Web-Mercator y of a latitude (independent copy of the implementation, used
// to double-check the fit actually fits).
const mercY = lat => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

const ySpan = mercY(south) - mercY(north); // mercator y grows southward

// True when the bounds fit the viewport at zoom z (px sizes, 1px slack for
// float rounding).
const fitsAt = (width, height, padding, z) => {
  const world = 256 * 2 ** z;
  const lonPx = ((east - west) / 360) * world;
  const latPx = ySpan * world;
  return lonPx <= width - 2 * padding + 1 && latPx <= height - 2 * padding + 1;
};

describe('fitZoomForViewport', () => {
  it('returns null for unusable viewport sizes', () => {
    expect(fitZoomForViewport({ width: 0, height: 900 })).toBeNull();
    expect(fitZoomForViewport({ width: 390, height: 0 })).toBeNull();
    expect(fitZoomForViewport({ width: -10, height: 900 })).toBeNull();
    expect(fitZoomForViewport({})).toBeNull();
  });

  it('lets a phone viewport zoom out far enough to fit Catalonia', () => {
    // 390×844 is narrower than Catalonia at the old fixed floor (zoom 7),
    // which is exactly why the fixed floor felt "broken" on phones.
    const z = fitZoomForViewport({ width: 390, height: 844 });
    expect(z).toBeGreaterThanOrEqual(6.0);
    expect(z).toBeLessThan(7.0);
    expect(fitsAt(390, 844, 48, z)).toBe(true);
  });

  it('keeps wide screens from seeing far beyond Catalonia at max zoom-out', () => {
    const phone = fitZoomForViewport({ width: 390, height: 844 });
    const desktop = fitZoomForViewport({ width: 1600, height: 900 });
    expect(desktop).toBeGreaterThan(phone); // more room ⇒ higher floor
    expect(desktop).toBeGreaterThanOrEqual(7.4);
    expect(desktop).toBeLessThanOrEqual(8.1);
    expect(fitsAt(1600, 900, 48, desktop)).toBe(true);
  });

  it('raises the floor further on very large screens', () => {
    const z = fitZoomForViewport({ width: 2560, height: 1440 });
    expect(z).toBeGreaterThan(8.1);
    expect(fitsAt(2560, 1440, 48, z)).toBe(true);
  });

  it('is monotone in padding (more padding ⇒ smaller zoom that still fits)', () => {
    const tight = fitZoomForViewport({ width: 1600, height: 900, padding: 16 });
    const padded = fitZoomForViewport({ width: 1600, height: 900, padding: 160 });
    expect(padded).toBeLessThan(tight);
    expect(fitsAt(1600, 900, 160, padded)).toBe(true);
  });

  it('honours minZoom / maxZoom clamps', () => {
    expect(fitZoomForViewport({ width: 390, height: 844, minZoom: 9 })).toBe(9);
    expect(fitZoomForViewport({ width: 2560, height: 1440, maxZoom: 7 })).toBe(7);
  });
});

describe('bounds constants', () => {
  it('CATALONIA_BOUNDS is a [[w,s],[e,n]] box with east>west, north>south', () => {
    expect(CATALONIA_BOUNDS).toEqual([[-1.0, 40.0], [4.0, 44.0]]);
    expect(ne[0]).toBeGreaterThan(sw[0]);
    expect(ne[1]).toBeGreaterThan(sw[1]);
  });

  it('TERRAIN_OVERLAY_BOUNDS pads Catalonia slightly (raster clip box)', () => {
    const [w, s, e, n] = TERRAIN_OVERLAY_BOUNDS;
    expect(w).toBeLessThan(sw[0]);
    expect(s).toBeLessThan(sw[1]);
    expect(e).toBeGreaterThan(ne[0]);
    expect(n).toBeGreaterThan(ne[1]);
  });
});
