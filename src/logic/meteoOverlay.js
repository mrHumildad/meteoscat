/**
 * Meteo area overlay (rain / humidity / temperature).
 *
 * The meteo sliders are *area* filters just like the altitude band: instead
 * of classifying per-pixel DEM elevation, the station point values are
 * interpolated onto a coarse IDW grid (meteoGrid.js) which this protocol
 * samples per pixel:
 *
 *   - sea / no elevation (elev <= 0)        → transparent (mask stops at the
 *                                             coast, exactly like altitude)
 *   - no data (NaN, beyond station reach)   → transparent
 *   - value inside [lo, hi]                 → transparent (the selected area
 *                                             of the mask shows the map)
 *   - value outside [lo, hi]                → MCSC_GREY ("deselected")
 *
 * Tiles are generated in the browser (DEM fetch + grid sample + classify +
 * PNG encode) and cached per (z,x,y,var,band,window). The data window and
 * the band are baked into the tile URL, so the app just calls
 * `source.setTiles([...])` with the new URL to regenerate the overlay when
 * either changes. Temperature grids are built sea-level-reduced and the DEM
 * elevation is re-applied per pixel (lapse-rate correction).
 */

import { loadTileImageData, terrariumElevation, tileXYToLngLat } from './elevation.js';
import { MCSC_GREY } from './mcscLegend.js';
import { getMeteoGrid, sampleMeteoGrid, LAPSE_RATE } from './meteoGrid.js';
// MapLibre v5+ registers custom protocols globally via the module-level
// `addProtocol` export — there is no `map.addProtocol` method anymore.
import { addProtocol } from 'maplibre-gl';

const TILE_SIZE = 256;

// In-band pixels are fully transparent so the selected area shows the map.
export const METEO_BAND_TRANSPARENT = [0, 0, 0, 0];
// Matches MCSC_GREY — same "unselected" grey as the altitude band.
export const METEO_BAND_GREY = [138, 138, 138, 255];

/**
 * Pure classification (unit-testable): inclusive bounds, 4-channel colour.
 * Non-finite (no data) values stay transparent — the sea / no-elevation rule
 * lives in buildTile, which checks the DEM directly like altitude does.
 */
export const classifyMeteoValue = (value, lo, hi) => {
  if (!Number.isFinite(value)) return METEO_BAND_TRANSPARENT;
  return value >= lo && value <= hi ? METEO_BAND_TRANSPARENT : METEO_BAND_GREY;
};

const makeCanvas = (w, h) =>
  typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });

const canvasToBlob = async canvas => {
  if (typeof canvas.convertToBlob === 'function') {
    return canvas.convertToBlob({ type: 'image/png' });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png');
  });
};

/**
 * Classified PNG tile (or a transparent one when variable/band are off).
 * `getContext()` must return `{ windowKey, features }` for the current data
 * window — the grid is built lazily per variable from those features.
 * Exported so the browser-only pipeline can be exercised under test.
 */
export async function buildMeteoTile(z, x, y, variable, band, getContext) {
  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!variable || !band) {
    return (await canvasToBlob(canvas)).arrayBuffer(); // transparent 256×256
  }
  const [lo, hi] = band;
  const { windowKey, features } = getContext() || {};
  const grid = getMeteoGrid(windowKey, variable, features || [], {
    lapseRate: variable === 'tempAvg' ? LAPSE_RATE : 0,
  });

  const src = await loadTileImageData(z, x, y);
  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const d = out.data;
  const s = src.data;
  // lng depends only on the column, lat only on the row — precompute once.
  const lngs = new Float64Array(TILE_SIZE);
  const lats = new Float64Array(TILE_SIZE);
  for (let p = 0; p < TILE_SIZE; p++) {
    lngs[p] = tileXYToLngLat(z, x, y, p, 0).lng;
    lats[p] = tileXYToLngLat(z, x, y, 0, p).lat;
  }

  for (let i = 0, o = 0; i < s.length; i += 4, o += 4) {
    const elev = terrariumElevation(s[i], s[i + 1], s[i + 2]);
    if (elev <= 0) continue; // sea / no elevation → transparent
    const px = (o >> 2) & 255;
    const py = o >> 10; // o / 4 / 256, row-major
    let value = sampleMeteoGrid(grid, lngs[px], lats[py]);
    if (Number.isFinite(value) && grid.lapseRate > 0) {
      value -= (grid.lapseRate * elev) / 1000; // re-apply the cell elevation
    }
    const c = classifyMeteoValue(value, lo, hi);
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
  }
  ctx.putImageData(out, 0, 0);
  return (await canvasToBlob(canvas)).arrayBuffer();
}

/**
 * Parse a `meteo://{z}/{x}/{y}?v=<var>&w=<window>&b=<lo>_<hi>` tile URL.
 * Band values are joined with '_' (not '-') so negative values like
 * `b=-5_10` parse unambiguously; `v=off` means the overlay is off. Returns
 * null for unrecognised URLs. Pure, unit-testable.
 */
export const parseMeteoTileUrl = url => {
  const m = /^meteo:\/\/(\d+)\/(\d+)\/(\d+)\?v=([a-zA-Z]+)(?:&w=([^&]*))?(?:&b=([\d.-]+)_([\d.-]+))?/.exec(url || '');
  if (!m) return null;
  return {
    z: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    variable: m[4] === 'off' ? null : m[4],
    windowKey: m[5] ?? '',
    band: m[6] && m[7] ? [Number(m[6]), Number(m[7])] : null,
  };
};

/**
 * Register the `meteo://{z}/{x}/{y}?v=<var>&w=<window>&b=<lo>_<hi>` protocol
 * (global in MapLibre v5+). `getContext` is called per tile and must return
 * `{ windowKey, features }`; variable, window and band are baked into the URL
 * so the app regenerates tiles with `source.setTiles([...])`. Re-registering
 * (e.g. on map remount) just overwrites the global handler; the closure reads
 * App's refs, so it stays valid.
 */
export const registerMeteoProtocol = (map, getContext) => {
  const cache = new Map(); // `${z}/${x}/${y}|var|band|window` -> Promise<{ data }>

  const handler = async params => {
    const t = parseMeteoTileUrl(params.url);
    if (!t) throw new Error(`Bad meteo tile URL: ${params.url}`);
    const key = `${t.z}/${t.x}/${t.y}|${t.variable ?? 'off'}|${t.band ? `${t.band[0]}-${t.band[1]}` : 'off'}|${t.windowKey}`;
    if (cache.has(key)) return cache.get(key);

    const promise = buildMeteoTile(t.z, t.x, t.y, t.variable, t.band, getContext).then(buf => ({ data: buf }));
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };

  try {
    addProtocol('meteo', handler);
  } catch (err) {
    console.warn('Could not register meteo:// protocol:', err?.message ?? err);
  }
};