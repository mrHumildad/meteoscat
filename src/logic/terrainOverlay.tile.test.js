// Integration test for the stacked terrain:// tile pipeline: builds a real
// painted tile (raw MCSC band decode + IDW grid + altitude + per-pixel AND)
// with the browser-only parts (canvas, tile fetches) stubbed out, then
// asserts on the pixels that would be PNG-encoded: a class colour is painted
// only where EVERY active condition passes, and failing pixels are
// transparent (relief shows through) — no grey anywhere.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAggregateTable } from './filterAggregate.js';
import { decodeLithoGrid } from './lithology.js';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn() }));

// Fake DEM: every pixel is 100 m land (terrarium: R=128, G=100, B=0), so an
// altitude band around 100 m passes and a band above it fails everywhere.
vi.mock('./elevation.js', async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadTileImageData: vi.fn(async () => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let i = 0; i < 256 * 256; i++) {
        data[i * 4] = 128; data[i * 4 + 1] = 100; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
      }
      return { width: 256, height: 256, data };
    }),
  };
});

// Fake raw MCSC band tile: the red channel IS the band value (band v →
// rgb(v,0,0)). Layout of the 256×256 tile:
//   - top-left 32×32       → band 36 (aigües / water, never gated)
//   - bottom-right 32×32   → band 0 (no data → transparent, like abroad)
//   - everywhere else      → band 7 (aciculifolis, official colour #33cc33)
vi.mock('./mcscRaw.js', async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadMcscBandTile: vi.fn(async () => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const o = (y * 256 + x) * 4;
          let band = 7;
          if (x < 32 && y < 32) band = 36; // water block
          else if (x >= 224 && y >= 224) band = 0; // no-data block
          if (band === 0) { data[o + 3] = 0; continue; }
          data[o] = band; data[o + 3] = 255;
        }
      }
      return { width: 256, height: 256, data };
    }),
  };
});

// Capture the ImageData handed to putImageData — that is exactly the pixel
// content that gets PNG-encoded for MapLibre.
const put = [];
class FakeCtx {
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img) { put.push(img); }
}
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return new FakeCtx(); }
  async convertToBlob() { return new Blob(); }
}

let buildTerrainTile;
let HIGHLIGHT;
let loadBandMock;
let loadDemMock;
beforeEach(() => {
  put.length = 0;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  return import('./terrainOverlay.js').then(async m => {
    buildTerrainTile = m.buildTerrainTile;
    HIGHLIGHT = m.TERRAIN_HIGHLIGHT;
    loadBandMock = (await import('./mcscRaw.js')).loadMcscBandTile;
    loadDemMock = (await import('./elevation.js')).loadTileImageData;
    loadBandMock.mockClear();
    loadDemMock.mockClear();
  });
});

// A single station (precAcc 10 / tempAvg 22 / humAvg 70 at 0 m) anchored at
// the tile centre → the per-window feature is that value everywhere within
// reach, so a band around it must keep pixels painted and away-from-it bands
// must turn the forest transparent. The 0 m altitud lets the temperature
// lapse test reason cleanly: sea-level grid value 22, re-corrected to 21.35
// at the fake tile's 100 m pixels (22 − 6.5·100/1000).
const makeContext = async () => {
  const { lngLatToTileXY, tileXYToLngLat } = await import('./elevation.js');
  const t = lngLatToTileXY(0, 40.01, 8);
  const centre = tileXYToLngLat(t.z, t.x, t.y, 128, 128);
  const agg = buildAggregateTable({
    '2026-09-02': { A: { tempAvg: 22, humAvg: 70, precAcc: 10 }, dayStats: {} },
  });
  return {
    tile: t,
    window: ['2026-09-02', '2026-09-02'],
    context: () => ({
      agg,
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [centre.lng, centre.lat] },
        properties: { codi: 'A', altitud: 0 },
      }],
    }),
  };
};

const forest = (128 * 256 + 128) * 4;  // centre pixel (band 7 land)
const water = (16 * 256 + 16) * 4;     // water block (band 36)
const abroad = (240 * 256 + 240) * 4;  // no-data block (band 0)
const landLeft = (80 * 256 + 80) * 4;    // forest land, west half of the tile
const landRight = (200 * 256 + 128) * 4; // forest land, east half of the tile

describe('buildTerrainTile', () => {
  it("'none' mode with NO filter paints nothing: transparent tile, zero fetches (no green wash over the whole region)", async () => {
    const { tile: t, context } = await makeContext();
    const buf = await buildTerrainTile(t.z, t.x, t.y, {
      mode: 'none',
      off: [],
      alt: null,
      filters: [],
      geoOff: [],
    }, context);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(loadBandMock).not.toHaveBeenCalled(); // no MCSC band tile
    expect(loadDemMock).not.toHaveBeenCalled();  // no DEM
    expect(put).toHaveLength(0);                 // no pixel loop at all
  });

  it("'none' mode tints the land that passes every filter bright green (water + no-data stay transparent)", async () => {
    const { tile: t, window: [from, to], context } = await makeContext();
    // Full stack that would paint in terrain mode: an altitude band around the
    // fake 100 m DEM plus a temperature band around the lapse-corrected value
    // (sea-level 22 → 21.35 at 100 m). In 'none' mode the passing land carries
    // the palette-less green highlight instead of a class colour.
    await buildTerrainTile(t.z, t.x, t.y, {
      mode: 'none',
      off: [],
      alt: [50, 150],
      filters: [{ variable: 'tempAvg', from, to, band: [21.3, 21.4] }],
      geoOff: [],
    }, context);

    // The highlight still SAMPLE the tile / DEM (unlike the old relief-only
    // mode) — that is what tells it which pixels pass.
    expect(loadBandMock).toHaveBeenCalled();
    expect(loadDemMock).toHaveBeenCalled();
    for (const px of [forest, landLeft, landRight]) {
      expect(put[0].data[px]).toBe(HIGHLIGHT[0]);
      expect(put[0].data[px + 1]).toBe(HIGHLIGHT[1]);
      expect(put[0].data[px + 2]).toBe(HIGHLIGHT[2]);
      expect(put[0].data[px + 3]).toBe(HIGHLIGHT[3]);
    }
    // Water is never highlighted (the land filters don't describe it) and
    // no-data (abroad) stays transparent.
    expect(put[0].data[water + 3]).toBe(0);
    expect(put[0].data[abroad + 3]).toBe(0);
  });

  it("'none' mode leaves the land transparent when a filter gate fails", async () => {
    const { tile: t, context } = await makeContext();
    // The fake DEM is 100 m → the band [500, 800] excludes the whole land tile.
    await buildTerrainTile(t.z, t.x, t.y, {
      mode: 'none',
      off: [],
      alt: [500, 800],
      filters: [],
      geoOff: [],
    }, context);
    expect(loadDemMock).toHaveBeenCalled();
    expect(put[0].data[forest + 3]).toBe(0);
    expect(put[0].data[landLeft + 3]).toBe(0);
  });

  it("'none' mode is gated by the class and substrate dims too (one shared AND stack)", async () => {
    const { t, ctx } = await makeGeoContext();
    // Dimmed MCSC class → nothing is highlighted in 'none' mode either.
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'none', off: ['221/225'], alt: null, filters: [], geoOff: [] }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);
    expect(put[0].data[landRight + 3]).toBe(0);

    // Class fine but the substrate family dimmed → the west half is excluded,
    // while the nodata-family half (no family key → not gated) stays green.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'none', off: [], alt: null, filters: [], geoOff: ['quaternary'] }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);
    expect(put[0].data[landRight]).toBe(HIGHLIGHT[0]);
    expect(put[0].data[landRight + 1]).toBe(HIGHLIGHT[1]);
    expect(put[0].data[landRight + 3]).toBe(HIGHLIGHT[3]);
  });

  it('paints the class colour with no filters, keeps water + no-data blocks distinct', async () => {
    const { tile: t, context } = await makeContext();
    await buildTerrainTile(t.z, t.x, t.y, { off: [], alt: null, filters: [] }, context);

    // Forest green #33cc33 → rgb(51, 204, 51)
    expect(put[0].data[forest]).toBe(51);
    expect(put[0].data[forest + 1]).toBe(204);
    expect(put[0].data[forest + 2]).toBe(51);
    expect(put[0].data[forest + 3]).toBe(255);
    // Water blue #000080, painted even though nothing constrains
    expect(put[0].data[water + 2]).toBe(128);
    expect(put[0].data[water + 3]).toBe(255);
    // No-data stays transparent (relief / abroad)
    expect(put[0].data[abroad + 3]).toBe(0);
    // DEM not needed when no altitude band and no temperature grid
    expect(loadDemMock).not.toHaveBeenCalled();
  });

  it('leaves a dimmed class transparent and keeps water painted (no grey)', async () => {
    const { tile: t, context } = await makeContext();
    await buildTerrainTile(t.z, t.x, t.y, { off: ['221/225'], alt: null, filters: [] }, context);

    expect(put[0].data[forest + 3]).toBe(0);            // aciculifolis dimmed → transparent
    expect(put[0].data[water + 3]).toBe(255);           // aigües still on → painted
    expect(put[0].data[water + 2]).toBe(128);
  });

  it('gates land by the altitude band (transparent when out), never gates water', async () => {
    const { tile: t, context } = await makeContext();

    // DEM is 100 m → band [500, 800] excludes the whole land tile.
    await buildTerrainTile(t.z, t.x, t.y, { off: [], alt: [500, 800], filters: [] }, context);
    expect(put[0].data[forest + 3]).toBe(0);            // out of band → transparent
    expect(put[0].data[water + 3]).toBe(255);           // water not gated by altitude
    expect(loadDemMock).toHaveBeenCalled();

    // Band around 100 m keeps the forest.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y, { off: [], alt: [50, 150], filters: [] }, context);
    expect(put[0].data[forest + 3]).toBe(255);
    expect(put[0].data[forest]).toBe(51);
  });

  it('gates land by a meteo instance band over its own window (AND)', async () => {
    const { tile: t, window: [from, to], context } = await makeContext();

    // Station precAcc = 10 → band [0, 5] excludes it.
    await buildTerrainTile(t.z, t.x, t.y, {
      off: [],
      alt: null,
      filters: [{ variable: 'precAcc', from, to, band: [0, 5] }],
    }, context);
    expect(put[0].data[forest + 3]).toBe(0);            // 10 outside [0,5] → transparent
    expect(put[0].data[water + 3]).toBe(255);           // water never gated by meteo
    expect(loadDemMock).not.toHaveBeenCalled();         // precAcc needs no DEM

    // Band around the value keeps it painted.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y, {
      off: [],
      alt: null,
      filters: [{ variable: 'precAcc', from, to, band: [10, 10] }],
    }, context);
    expect(put[0].data[forest + 3]).toBe(255);
    expect(put[0].data[forest]).toBe(51);
  });

  // A substrate grid over the WHOLE tile: family 1 (quaternary, #e3d47f) on
  // the west half, nodata (id 0) on the east half. Context carries it; base
  // (makeContext) has no grid.
  const makeGeoContext = async () => {
    const { tileXYToLngLat } = await import('./elevation.js');
    const base = await makeContext();
    const t = base.tile;
    const lon0 = tileXYToLngLat(t.z, t.x, t.y, 0, 0).lng;
    const lon1 = tileXYToLngLat(t.z, t.x, t.y, 256, 0).lng;
    const latN = tileXYToLngLat(t.z, t.x, t.y, 0, 0).lat;
    const latS = tileXYToLngLat(t.z, t.x, t.y, 0, 256).lat;
    const cols = 8;
    const step = (lon1 - lon0) / cols;
    const rows = Math.ceil((latN - latS) / step) + 1;
    const lithoGrid = decodeLithoGrid({
      cols,
      rows,
      west: lon0,
      north: latN,
      step,
      families: {
        '0': { key: 'nodata', label: 'Sense dades', color: null },
        '1': { key: 'quaternary', label: 'Dipòsits no consolidats', color: '#e3d47f' },
      },
      rle: Array.from({ length: rows }, () => [[1, 4], [0, 4]]),
    });
    return {
      t,
      ctx: { ...base, context: () => ({ ...base.context(), lithoGrid }) },
      baseCtx: base,
    };
  };

  it('terrain mode is gated by the substrate dims too (one shared AND stack; the sel button only picks the palette)', async () => {
    const { t, ctx } = await makeGeoContext();
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'terrain', off: [], alt: null, filters: [], geoOff: ['quaternary'] }, ctx.context);
    // Dimmed substrate family → transparent even in terrain mode
    expect(put[0].data[landLeft + 3]).toBe(0);
    // …while the nodata-family half has no key → still painted with the class colour
    expect(put[0].data[landRight + 3]).toBe(255);
    expect(put[0].data[landRight]).toBe(51);
    expect(put[0].data[water + 3]).toBe(255);
  });

  it('substrate mode paints the family colour (nodata land transparent), water unchanged', async () => {
    const { t, ctx } = await makeGeoContext();
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'substrate', off: [], alt: null, filters: [], geoOff: [] }, ctx.context);
    // quaternary #e3d47f on the west half
    expect(put[0].data[landLeft]).toBe(227);
    expect(put[0].data[landLeft + 1]).toBe(212);
    expect(put[0].data[landLeft + 2]).toBe(127);
    expect(put[0].data[landLeft + 3]).toBe(255);
    // east half has no substrate data → transparent, even though the MCSC
    // forest class under it is fine
    expect(put[0].data[landRight + 3]).toBe(0);
    expect(put[0].data[water + 2]).toBe(128); // water keeps its class colour
    expect(put[0].data[water + 3]).toBe(255);
    expect(loadDemMock).not.toHaveBeenCalled();
  });

  it('substrate mode gates land by the MCSC class dims AND the family dims (one shared AND stack)', async () => {
    const { t, ctx } = await makeGeoContext();
    // Dimming the MCSC class (band 7 aciculifolis via '221/225') makes
    // substrate-mode land transparent too — the class gate is shared.
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'substrate', off: ['221/225'], alt: null, filters: [], geoOff: [] }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);

    // …and dimming the family itself is transparent as before.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'substrate', off: [], alt: null, filters: [], geoOff: ['quaternary'] }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);
    // water is still painted through both dims
    expect(put[0].data[water + 3]).toBe(255);
  });

  it('the shared stack gates identically in both modes (dimmed class + dimmed family → transparent everywhere)', async () => {
    const { t, ctx } = await makeGeoContext();
    const state = { off: ['221/225'], alt: null, filters: [], geoOff: ['quaternary'] };
    await buildTerrainTile(t.z, t.x, t.y, { mode: 'terrain', ...state }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);  // dimmed class + family → transparent
    expect(put[0].data[landRight + 3]).toBe(0); // dimmed class alone (nodata family) → transparent
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y, { mode: 'substrate', ...state }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);
    expect(put[0].data[landRight + 3]).toBe(0);
    expect(put[0].data[water + 3]).toBe(255);   // water never gated by either dim
  });

  it('substrate mode still applies the altitude + meteo gates, and falls back to terrain rendering without the grid', async () => {
    const { t, ctx, baseCtx } = await makeGeoContext();
    // DEM is 100 m → band [500, 800] excludes every land pixel.
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'substrate', off: [], alt: [500, 800], filters: [], geoOff: [] }, ctx.context);
    expect(put[0].data[landLeft + 3]).toBe(0);
    expect(put[0].data[water + 3]).toBe(255); // water never gated by altitude
    expect(loadDemMock).toHaveBeenCalled();

    // Without a grid in context the overlay degrades to terrain rendering.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y,
      { mode: 'substrate', off: [], alt: null, filters: [], geoOff: [] }, baseCtx.context);
    expect(put[0].data[landLeft]).toBe(51); // MCSC green, not family colour
    expect(put[0].data[landLeft + 3]).toBe(255);
  });

  it('requires ALL conditions together and re-applies the temperature lapse rate', async () => {
    const { tile: t, window: [from, to], context } = await makeContext();

    // Station tempAvg 22 at 0 m → sea-level grid value 22, re-corrected to
    // 21.35 at the 100 m pixels (22 − 6.5·100/1000). A band around 21.35 must
    // pass — and prove the lapse re-application happened (22 would fail it).
    const state = {
      off: [],
      alt: [50, 150], // passes at 100 m
      filters: [{ variable: 'tempAvg', from, to, band: [21.3, 21.4] }],
    };
    await buildTerrainTile(t.z, t.x, t.y, state, context);
    expect(put[0].data[forest + 3]).toBe(255);          // all conditions pass → painted
    expect(loadDemMock).toHaveBeenCalled();             // tempAvg needs the DEM

    // Same temperature band but altitude out of range → transparent.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y, {
      ...state,
      alt: [500, 800],
    }, context);
    expect(put[0].data[forest + 3]).toBe(0);

    // Altitude passes but temperature outside the band → transparent.
    put.length = 0;
    await buildTerrainTile(t.z, t.x, t.y, {
      ...state,
      filters: [{ variable: 'tempAvg', from, to, band: [5, 5] }],
    }, context);
    expect(put[0].data[forest + 3]).toBe(0);

    // Water is painted through every stacked combination.
    expect(put[0].data[water + 3]).toBe(255);
  });
});

describe('protocol resilience (painters never reject → no errored tiles in the raster source)', () => {
  // MapLibre < 6.1 crashes its renderer when setTiles() reloads a raster
  // source that holds errored tiles (maplibre-gl-js #7775) — and errored
  // tiles are created exactly when a tile request rejects. These tests pin
  // the pipeline contract: a failed paint resolves to a valid transparent
  // tile instead of rejecting, while successful paints still resolve normally.
  let paintTerrainTile;
  let paintSeaTile;

  beforeEach(async () => {
    const pipeline = await import('./tilePipeline.js');
    paintTerrainTile = pipeline.paintTerrainTile;
    paintSeaTile = pipeline.paintSeaTile;
  });

  it('terrain: a failed MCSC fetch resolves to a transparent tile, not a rejection', async () => {
    const { tile: t } = await makeContext();
    loadBandMock.mockRejectedValueOnce(new Error('MCSC WMS 500'));
    const res = await paintTerrainTile(t.z, t.x, t.y, { mode: 'terrain', off: [], alt: null, filters: [] });
    expect(res).toHaveProperty('data');
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(loadBandMock).toHaveBeenCalledTimes(1);
  });

  it('terrain: a failed DEM fetch (altitude band on) resolves transparent too', async () => {
    const { tile: t } = await makeContext();
    loadDemMock.mockRejectedValueOnce(new Error('DEM 503'));
    const res = await paintTerrainTile(t.z, t.x, t.y, { mode: 'terrain', off: [], alt: [50, 150], filters: [] });
    expect(res.data).toBeInstanceOf(ArrayBuffer);
  });

  it('terrain: a healthy paint still resolves normally', async () => {
    const { tile: t } = await makeContext();
    const res = await paintTerrainTile(t.z, t.x, t.y, { mode: 'terrain', off: [], alt: null, filters: [] });
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(put).toHaveLength(1); // real painting happened (not the transparent fallback)
    expect(put[0].data[forest + 3]).toBe(255);
  });

  it('sea: a failed DEM fetch resolves to a transparent tile, not a rejection', async () => {
    const { tile: t } = await makeContext();
    loadDemMock.mockRejectedValueOnce(new Error('DEM 503'));
    const res = await paintSeaTile(t.z, t.x, t.y, '000080');
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(loadDemMock).toHaveBeenCalled();
  });

  it('sea: a healthy paint still resolves normally', async () => {
    const { tile: t } = await makeContext();
    const res = await paintSeaTile(t.z, t.x, t.y, '000080');
    expect(res.data).toBeInstanceOf(ArrayBuffer);
  });

  it('a failure fallback is marked short-lived so MapLibre re-requests it later (no permanent blank tiles)', async () => {
    const { tile: t } = await makeContext();
    loadBandMock.mockRejectedValueOnce(new Error('MCSC WMS 500'));
    const res = await paintTerrainTile(t.z, t.x, t.y, { mode: 'terrain', off: [], alt: null, filters: [] });
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(res.cacheControl).toBe('max-age=10');
  });

  it('an already-aborted request (tile left the viewport mid-zoom) resolves without painting', async () => {
    const { tile: t } = await makeContext();
    const ac = new AbortController();
    ac.abort();
    loadBandMock.mockClear();
    const res = await paintTerrainTile(t.z, t.x, t.y,
      { mode: 'terrain', off: [], alt: null, filters: [] }, ac.signal);
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(loadBandMock).not.toHaveBeenCalled(); // stale tile never painted
    expect(put).toHaveLength(0);
  });
});
