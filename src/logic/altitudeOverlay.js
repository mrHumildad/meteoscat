/**
 * Altitude-band area overlay.
 *
 * Turns the altitude slider into a *map* filter, not just a station filter:
 * a custom MapLibre tile protocol (`alt://`) classifies the same terrarium
 * DEM tiles the relief/3D terrain use, per pixel:
 *
 *   - inside [lo, hi]  → transparent (the real map shows through, so the
 *                        band reads as the "selected" area of a mask)
 *   - outside [lo, hi] → the same grey as unselected MCSC legend classes
 *                        (MCSC_GREY, so it reads as "deselected" alongside
 *                        the land-cover overlay)
 *
 * Tiles are generated in the browser (fetch + decode + classify + PNG encode)
 * and cached per (z,x,y,band), so panning reuses tiles and only a band change
 * regenerates them. No elevation data leaves the client; the s3 fetch is the
 * same CORS-enabled public bucket used everywhere else.
 */

import { loadTileImageData, terrariumElevation } from './elevation.js';
import { MCSC_GREY } from './mcscLegend.js';
// MapLibre v5+ registers custom protocols globally via the module-level
// `addProtocol` export (config.REGISTERED_PROTOCOLS) — there is no
// `map.addProtocol` method anymore.
import { addProtocol } from 'maplibre-gl';

const TILE_SIZE = 256;

// In-band pixels are fully transparent ([r, g, b, a]) so the selected area of
// the mask shows the real map underneath.
export const ALT_BAND_TRANSPARENT = [0, 0, 0, 0];
// Matches MCSC_GREY ('#8a8a8a') so out-of-band areas look "unselected" — the
// same grey as a dimmed terrain-type class.
export const ALT_BAND_GREY = [138, 138, 138, 255];

// Pure classification (unit-testable): inclusive bounds. Returns a 4-channel
// colour:
//   - sea / no-data (elev <= 0) → transparent, so the mask stops at the coast
//     exactly like the MCSC overlay (no grey over the sea)
//   - land inside the band  → transparent (the selected area shows the map)
//   - land outside the band → grey, styled like an unselected terrain class
export const classifyElevation = (elev, lo, hi) => {
  if (!Number.isFinite(elev) || elev <= 0) return ALT_BAND_TRANSPARENT;
  return elev >= lo && elev <= hi ? ALT_BAND_TRANSPARENT : ALT_BAND_GREY;
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

/** Classified PNG (or a transparent one when `band` is null → overlay off). */
async function buildTile(z, x, y, band) {
  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  if (!band) {
    return (await canvasToBlob(canvas)).arrayBuffer(); // transparent 256×256
  }
  const [lo, hi] = band;
  const src = await loadTileImageData(z, x, y);
  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const d = out.data;
  const s = src.data;
  for (let i = 0, o = 0; i < s.length; i += 4, o += 4) {
    const elev = terrariumElevation(s[i], s[i + 1], s[i + 2]);
    const c = classifyElevation(elev, lo, hi);
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
  }
  ctx.putImageData(out, 0, 0);
  return (await canvasToBlob(canvas)).arrayBuffer();
}

/**
 * Register the `alt://{z}/{x}/{y}?b=lo-hi` protocol (global in MapLibre v5+).
 * `getBand` is called per tile and must return [lo, hi] or null (off).
 * The band is also baked into the tile URL, so the app just calls
 * `source.setTiles([...])` with the new URL to regenerate an overlay.
 * Re-registering (e.g. on map remount) just overwrites the global handler;
 * the `getBand` closure reads App's stable altBandRef, so it stays valid.
 */
export const registerAltitudeProtocol = (map, getBand) => {
  const cache = new Map(); // `${z}/${x}/${y}|<band>` -> Promise<{ data }>

  const handler = async params => {
    const m = /^alt:\/\/(\d+)\/(\d+)\/(\d+)(?:\?.*)?$/.exec(params.url || '');
    if (!m) throw new Error(`Bad altitude tile URL: ${params.url}`);
    const z = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const band = getBand();
    const key = `${z}/${x}/${y}|${band ? `${band[0]}-${band[1]}` : 'off'}`;
    if (cache.has(key)) return cache.get(key);

    const promise = buildTile(z, x, y, band).then(buf => ({ data: buf }));
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };

  try {
    addProtocol('alt', handler);
  } catch (err) {
    console.warn('Could not register alt:// protocol:', err?.message ?? err);
  }
};