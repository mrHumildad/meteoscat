import { describe, it, expect } from 'vitest';
import { lngLatToTileXY } from './elevation.js';
import { decodeLithoGrid } from './lithology.js';
import {
  AREA_MCSC_ZOOM,
  areaTileRange,
  countLandCover,
  countSubstrates,
  buildComposition,
} from './areaComposition.js';

const LAT = 41.9;
const LNG = 1.9;
const M_PER_DEG_LAT = 111320;

// Synthetic raw-band tile: every pixel carries `band` in its red channel, the
// way mcscRaw's decoded tiles do.
const bandTile = (band) => {
  const width = 256;
  const height = 256;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data[i * 4] = band;
  return { data, width, height };
};

// Web-Mercator metres per pixel at this latitude (the same figure the DEM
// sampler quotes: ~14 m/px at z13 over Catalonia).
const pxSizeM = z => (156543.03392804097 * Math.cos((LAT * Math.PI) / 180)) / 2 ** z;

describe('areaTileRange', () => {
  it('covers the disc bounding box, inclusive', () => {
    const radius = 2500;
    const range = areaTileRange(LAT, LNG, radius, AREA_MCSC_ZOOM);
    expect(range.z).toBe(AREA_MCSC_ZOOM);
    expect(range.x0).toBeLessThanOrEqual(range.x1);
    expect(range.y0).toBeLessThanOrEqual(range.y1);

    const dLat = radius / M_PER_DEG_LAT;
    const dLng = radius / (M_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));
    for (const lng of [LNG - dLng, LNG + dLng]) {
      for (const lat of [LAT - dLat, LAT + dLat]) {
        const t = lngLatToTileXY(lng, lat, AREA_MCSC_ZOOM);
        expect(t.x).toBeGreaterThanOrEqual(range.x0);
        expect(t.x).toBeLessThanOrEqual(range.x1);
        expect(t.y).toBeGreaterThanOrEqual(range.y0);
        expect(t.y).toBeLessThanOrEqual(range.y1);
      }
    }
  });

  it('grows with the radius and clamps to the world', () => {
    const small = areaTileRange(LAT, LNG, 500, AREA_MCSC_ZOOM);
    const big = areaTileRange(LAT, LNG, 2500, AREA_MCSC_ZOOM);
    const tiles = r => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
    expect(tiles(big)).toBeGreaterThanOrEqual(tiles(small));
    const clamped = areaTileRange(84, 0, 5000, 2);
    expect(clamped.x0).toBeGreaterThanOrEqual(0);
    expect(clamped.y1).toBeLessThanOrEqual(2 ** 2 - 1);
  });
});

describe('countLandCover', () => {
  it('counts the DISC, not the tiles that bound it', async () => {
    const radius = 1500;
    const stride = 2;
    const entries = await countLandCover(LAT, LNG, radius, {
      stride,
      loadTile: async () => bandTile(7), // 221/225 → aciculifolis
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: '221/225', color: '#65b965', count: expect.any(Number) });
    expect(entries[0].label).toContain('aciculifolis');

    // Independent check: a disc of this radius holds πr² m², each COUNTED
    // pixel covers (stride × pixel size)², so the count must match ±15 %.
    const perPixel = (pxSizeM(AREA_MCSC_ZOOM) * stride) ** 2;
    const expected = (Math.PI * radius ** 2) / perPixel;
    expect(entries[0].count).toBeGreaterThan(expected * 0.85);
    expect(entries[0].count).toBeLessThan(expected * 1.15);
  });

  it('groups pixels by legend entry', async () => {
    let call = 0;
    const entries = await countLandCover(LAT, LNG, 1000, {
      loadTile: async () => bandTile(call++ % 2 ? 10 : 9), // Matollar / esclerofil·les
    });
    expect(entries.map(e => e.key).sort()).toEqual(['223/227', '224']);
    const total = entries.reduce((a, e) => a + e.count, 0);
    expect(total).toBeGreaterThan(0);
    for (const e of entries) expect(e.count).toBeLessThan(total);
  });

  it('ignores no-data pixels and unlisted 230–234 bands', async () => {
    expect(await countLandCover(LAT, LNG, 1000, { loadTile: async () => bandTile(0) })).toEqual([]);
    expect(await countLandCover(LAT, LNG, 1000, { loadTile: async () => bandTile(18) })).toEqual([]);
  });

  it('keeps the tiles that did load when one fails', async () => {
    let call = 0;
    const entries = await countLandCover(LAT, LNG, 2000, {
      loadTile: async () => {
        if (call++ === 0) throw new Error('WMS 500');
        return bandTile(14); // Prats i herbassars
      },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBeGreaterThan(0);
  });

  it('refuses impossible inputs without fetching', async () => {
    let fetched = 0;
    const loadTile = async () => { fetched++; return bandTile(7); };
    expect(await countLandCover(NaN, LNG, 1000, { loadTile })).toEqual([]);
    expect(await countLandCover(LAT, LNG, 0, { loadTile })).toEqual([]);
    expect(fetched).toBe(0);
  });
});

// Small lithology grid: the west half family 1, the east half family 2.
// 8 × 4 cells of 0.02° from (1.85, 41.95) — it covers the disc used below.
const fakeGrid = () => decodeLithoGrid({
  cols: 8,
  rows: 4,
  west: 1.85,
  north: 41.95,
  step: 0.02,
  families: {
    1: { key: 'granit', label: 'Granítiques', color: '#aa0000' },
    2: { key: 'calcar', label: 'Carbonatades', color: '#00aa00' },
  },
  rle: [
    [[1, 4], [2, 4]],
    [[1, 4], [2, 4]],
    [[1, 4], [2, 4]],
    [[1, 4], [2, 4]],
  ],
});

describe('countSubstrates', () => {
  it('counts the families under the disc sample grid', () => {
    const entries = countSubstrates(fakeGrid(), LAT, LNG, 3000);
    const byKey = Object.fromEntries(entries.map(e => [e.key, e]));
    expect(Object.keys(byKey).sort()).toEqual(['calcar', 'granit']);
    expect(byKey.granit.count).toBeGreaterThan(byKey.calcar.count); // mostly west of the seam
    expect(byKey.granit.label).toBe('Granítiques');
    expect(byKey.granit.color).toBe('#aa0000');
  });

  it('skips nodata cells and a missing grid', () => {
    const empty = decodeLithoGrid({
      cols: 2, rows: 2, west: 1.85, north: 41.95, step: 0.02,
      families: { 1: { key: 'a', label: 'A', color: '#111111' } },
      rle: [[[0, 2]], [[0, 2]]],
    });
    expect(countSubstrates(empty, LAT, LNG, 1000)).toEqual([]);
    expect(countSubstrates(null, LAT, LNG, 1000)).toEqual([]);
  });
});

describe('buildComposition', () => {
  const entries = [
    { key: 'a', label: 'A', color: '#111111', count: 50 },
    { key: 'b', label: 'B', color: '#222222', count: 30 },
    { key: 'c', label: 'C', color: '#333333', count: 10 },
    { key: 'd', label: 'D', color: '#444444', count: 5 },
    { key: 'e', label: 'E', color: '#555555', count: 3 },
    { key: 'f', label: 'F', color: '#666666', count: 2 },
    { key: 'zero', label: 'Z', color: '#777777', count: 0 },
  ];

  it('orders by count and reports each share of the classified area', () => {
    const comp = buildComposition(entries);
    expect(comp.total).toBe(100);
    expect(comp.items.map(i => i.key)).toEqual(['a', 'b', 'c', 'd', 'e', '__other__']);
    expect(comp.items[0].share).toBeCloseTo(0.5, 6);
    expect(comp.items.reduce((a, i) => a + i.share, 0)).toBeCloseTo(1, 6);
  });

  it('folds the tail into one Altres bar', () => {
    const comp = buildComposition(entries);
    const other = comp.items.at(-1);
    expect(other).toMatchObject({ key: '__other__', label: 'Altres', count: 2 });
    expect(comp.items.at(-2).key).toBe('e');
    expect(buildComposition(entries, { max: 1 }).items.map(i => i.key)).toEqual(['a', '__other__']);
  });

  it('returns null when nothing is classified', () => {
    expect(buildComposition([])).toBeNull();
    expect(buildComposition(null)).toBeNull();
    expect(buildComposition([{ key: 'a', label: 'A', count: 0 }])).toBeNull();
  });
});
