import { describe, it, expect } from 'vitest';
import {
  lngLatToTileXY,
  tileXYToLngLat,
  terrariumElevation,
  clamp,
  ASPECT_SECTORS,
  ASPECT_MIN_SLOPE_DEG,
  metresPerPixel,
  hornGradientFromElevations,
  slopeAspectFromElevations,
  aspectSectorOf,
  aspectSectorFromElevations,
  neighboursAt,
  terrainGradient,
  slopeAspectAt,
} from './elevation.js';

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

// ── Orientation filter: slope aspect ────────────────────────────────────
// A plane rising at `dx` m/px eastward and `dy` m/px southward, as the nine
// elevations of a 3×3 window in Horn order [NW,N,NE,W,C,E,SW,S,SE].
const plane = (dx, dy) => [
  -dx - dy, -dy, dx - dy,
  -dx, 0, dx,
  -dx + dy, dy, dx + dy,
];

describe('aspectSectorOf', () => {
  it('maps the eight compass directions to their sector', () => {
    expect(ASPECT_SECTORS).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
    expect(aspectSectorOf(0)).toBe('N');
    expect(aspectSectorOf(45)).toBe('NE');
    expect(aspectSectorOf(90)).toBe('E');
    expect(aspectSectorOf(135)).toBe('SE');
    expect(aspectSectorOf(180)).toBe('S');
    expect(aspectSectorOf(225)).toBe('SW');
    expect(aspectSectorOf(270)).toBe('W');
    expect(aspectSectorOf(315)).toBe('NW');
    expect(aspectSectorOf(360)).toBe('N');
  });

  it('uses N = [337.5, 22.5) boundaries (rounded to the nearest cardinal)', () => {
    expect(aspectSectorOf(22.4)).toBe('N');
    expect(aspectSectorOf(22.5)).toBe('NE');
    expect(aspectSectorOf(337.4)).toBe('NW');
    expect(aspectSectorOf(337.5)).toBe('N');
  });

  it('normalises negative and out-of-range bearings', () => {
    expect(aspectSectorOf(-45)).toBe('NW'); // 315°
    expect(aspectSectorOf(-90)).toBe('W');  // 270°
    expect(aspectSectorOf(405)).toBe('NE'); // 45°
  });

  it('returns null for a non-finite bearing', () => {
    expect(aspectSectorOf(NaN)).toBeNull();
    expect(aspectSectorOf(null)).toBeNull();
    expect(aspectSectorOf(undefined)).toBeNull();
  });
});

describe('metresPerPixel', () => {
  it('is the Web Mercator ground resolution at latitude (m/px)', () => {
    expect(metresPerPixel(0, 0)).toBeCloseTo(156543.03, 1);
    expect(metresPerPixel(13, 41.9)).toBeCloseTo(14.2, 0); // the DEM sampling zoom
    // poleward tiles are finer in the same zoom
    expect(metresPerPixel(13, 41.9)).toBeLessThan(metresPerPixel(13, 0));
  });
});

describe('hornGradientFromElevations', () => {
  it('returns the east/south gradient of a plane in metres per metre', () => {
    const g = hornGradientFromElevations(plane(2, 0));
    expect(g.dzdx).toBeCloseTo(2, 6);
    expect(g.dzdy).toBeCloseTo(0, 6);
    expect(hornGradientFromElevations(plane(0, -3)).dzdy).toBeCloseTo(-3, 6);
  });

  it('normalises by the cell size', () => {
    const g = hornGradientFromElevations(plane(20, 0), 10);
    expect(g.dzdx).toBeCloseTo(2, 6);
  });

  it('returns null for a missing cell, a bad window or a bad cell size', () => {
    const centreMissing = plane(1, 0);
    centreMissing[4] = NaN;
    expect(hornGradientFromElevations(centreMissing)).not.toBeNull(); // centre unused
    const edgeMissing = plane(1, 0);
    edgeMissing[1] = NaN;
    expect(hornGradientFromElevations(edgeMissing)).toBeNull();
    expect(hornGradientFromElevations([1, 2, 3])).toBeNull();
    expect(hornGradientFromElevations(null)).toBeNull();
    expect(hornGradientFromElevations(plane(1, 0), 0)).toBeNull();
  });
});

describe('slopeAspectFromElevations (sign convention)', () => {
  it('a plane rising toward the SOUTH is north-facing (aspect ≈ 0°)', () => {
    const sa = slopeAspectFromElevations(plane(0, 2), 1);
    expect(sa.aspectDeg).toBeCloseTo(0, 6);
    expect(sa.slopeDeg).toBeCloseTo((Math.atan(2) * 180) / Math.PI, 6);
  });

  it('a plane rising toward the NORTH is south-facing (aspect ≈ 180°)', () => {
    expect(slopeAspectFromElevations(plane(0, -2), 1).aspectDeg).toBeCloseTo(180, 6);
  });

  it('a plane rising toward the EAST faces WEST (aspect ≈ 270°), and vice versa', () => {
    expect(slopeAspectFromElevations(plane(2, 0), 1).aspectDeg).toBeCloseTo(270, 6);
    expect(slopeAspectFromElevations(plane(-2, 0), 1).aspectDeg).toBeCloseTo(90, 6);
  });

  it('is null when a window cell is missing', () => {
    const cells = plane(0, 2);
    cells[8] = NaN;
    expect(slopeAspectFromElevations(cells)).toBeNull();
  });
});

describe('aspectSectorFromElevations (flat guard)', () => {
  it('returns the sector of a sufficiently steep slope', () => {
    expect(aspectSectorFromElevations(plane(0, 2), 1)).toBe('N');  // atan(2) = 63°
    expect(aspectSectorFromElevations(plane(2, 0), 1)).toBe('W');
    expect(aspectSectorFromElevations(plane(0, -2), 1)).toBe('S');
  });

  it('returns null for flat land (no sector → excluded while the filter is on)', () => {
    expect(aspectSectorFromElevations(plane(0, 0), 1)).toBeNull();
    expect(aspectSectorFromElevations(plane(0, 0.05), 1)).toBeNull(); // 2.9° < 5°
    expect(aspectSectorFromElevations(plane(0, 1), 1)).toBe('N');     // 45° ≥ 5°
  });

  it('honours a custom minimum slope', () => {
    expect(aspectSectorFromElevations(plane(0, 0.1), 1)).toBe('N');        // 5.7°
    expect(aspectSectorFromElevations(plane(0, 0.1), 1, 10)).toBeNull();   // < 10°
  });

  it('exposes the 5° flat threshold as a constant', () => {
    expect(ASPECT_MIN_SLOPE_DEG).toBe(5);
  });
});

describe('aspect helpers over a decoded 256×256 DEM tile', () => {
  // Terrarium-encode an elevation function into an RGBA tile.
  const demTile = elevAt => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 256; x++) {
        const i = (y * 256 + x) * 4;
        const v = Math.round(elevAt(x, y)) + 32768;
        data[i] = (v >> 8) & 255;
        data[i + 1] = v & 255;
        data[i + 2] = 0;
        data[i + 3] = 255;
      }
    }
    return data;
  };
  const offset = (x, y) => (y * 256 + x) * 4;

  it('reads the gradient + aspect of an interior pixel', () => {
    const data = demTile((x, y) => y * 2); // rises 2 m/px southward
    const g = terrainGradient(data, offset(128, 128));
    expect(g.dzdx).toBeCloseTo(0, 6);
    expect(g.dzdy).toBeCloseTo(2, 6);
    const sa = slopeAspectAt(data, offset(128, 128), 1);
    expect(sa.aspectDeg).toBeCloseTo(0, 6);
    expect(aspectSectorOf(sa.aspectDeg)).toBe('N');
  });

  it('decodes the nine neighbours in Horn order', () => {
    const data = demTile((x, y) => x + y * 100);
    const cells = neighboursAt(data, offset(128, 128));
    expect(cells[0]).toBeCloseTo(127 + 127 * 100, 3); // NW
    expect(cells[1]).toBeCloseTo(128 + 127 * 100, 3); // N (one row up)
    expect(cells[7]).toBeCloseTo(128 + 129 * 100, 3); // S (one row down)
    expect(cells[8]).toBeCloseTo(129 + 129 * 100, 3); // SE
  });

  it('returns null on the outer ring (that window needs the adjacent tile)', () => {
    const data = demTile(() => 100);
    for (const [x, y] of [[0, 128], [255, 128], [128, 0], [128, 255], [0, 0], [255, 255]]) {
      expect(neighboursAt(data, offset(x, y))).toBeNull();
      expect(terrainGradient(data, offset(x, y))).toBeNull();
      expect(slopeAspectAt(data, offset(x, y), 1)).toBeNull();
    }
    expect(neighboursAt(data, offset(1, 1))).toHaveLength(9);
  });
});