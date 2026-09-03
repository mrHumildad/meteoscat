/**
 * Sea overlay.
 *
 * The always-on hillshade layer shades the whole map from the same terrarium
 * DEM used for relief, and over the ocean that DEM carries bathymetry (flat or
 * underwater elevations) — so the sea renders as a grey shaded surface instead
 * of looking like water. This overlay paints every pixel whose elevation is
 * <= 0 (sea / below sea level) with the water colour and leaves land
 * transparent, using the exact same DEM the relief uses, so the sea/coast
 * boundary is pixel-perfect with the terrain.
 *
 * The colour is baked into the tile URL (`sea://{z}/{x}/{y}?c=000080`), so the
 * app just calls `source.setTiles([...])` with a new URL to recolor the sea —
 * e.g. to grey it together with the Aigües class when that legend entry is
 * dimmed. Tiles are generated in the browser (fetch + decode + classify +
 * PNG encode) and cached per (z,x,y,colour).
 */

import { loadTileImageData, terrariumElevation } from './elevation.js';
// MapLibre v5+ registers custom protocols globally via the module-level
// `addProtocol` export (config.REGISTERED_PROTOCOLS) — there is no
// `map.addProtocol` method anymore.
import { addProtocol } from 'maplibre-gl';

const TILE_SIZE = 256;

export const SEA_TRANSPARENT = [0, 0, 0, 0];

// Parse a 6-digit hex colour ("000080") into [r, g, b, 255]; null if invalid.
export const parseHexColor = hex => {
  if (typeof hex !== 'string') return null;
  const m = /^([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};

// Pure classification (unit-testable): sea (elev <= 0) → the sea colour,
// land (elev > 0) or no data → transparent; a missing colour disables the
// overlay entirely (same "off" semantics as the other area overlays).
export const classifySea = (elev, color) => {
  if (!Number.isFinite(elev) || elev > 0) return SEA_TRANSPARENT;
  return color ?? SEA_TRANSPARENT;
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
 * Classified PNG tile: sea pixels painted with the colour, land transparent
 * (or a fully transparent tile when `colorHex` is null → overlay off).
 * Exported so the browser-only pipeline can be exercised under test.
 */
export async function buildSeaTile(z, x, y, colorHex) {
  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const color = parseHexColor(colorHex);
  if (!color) {
    return (await canvasToBlob(canvas)).arrayBuffer(); // transparent → off
  }
  const src = await loadTileImageData(z, x, y);
  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const d = out.data;
  const s = src.data;
  for (let i = 0, o = 0; i < s.length; i += 4, o += 4) {
    const c = classifySea(terrariumElevation(s[i], s[i + 1], s[i + 2]), color);
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
  }
  ctx.putImageData(out, 0, 0);
  return (await canvasToBlob(canvas)).arrayBuffer();
}

/**
 * Parse a `sea://{z}/{x}/{y}?c=<hex|off>` tile URL. Returns null for
 * unrecognised URLs. Pure, unit-testable.
 */
export const parseSeaTileUrl = url => {
  const m = /^sea:\/\/(\d+)\/(\d+)\/(\d+)\?c=([0-9a-fA-F]{6}|off)/.exec(url || '');
  if (!m) return null;
  return {
    z: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    color: m[4] === 'off' ? null : m[4],
  };
};

/**
 * Register the `sea://` protocol (global in MapLibre v5+). The colour is baked
 * into the URL, so the app regenerates tiles with `source.setTiles([...])`
 * whenever the water colour changes. Re-registering (e.g. on map remount)
 * just overwrites the global handler.
 */
export const registerSeaProtocol = () => {
  const cache = new Map(); // `${z}/${x}/${y}|<colour>` -> Promise<{ data }>

  const handler = async params => {
    const t = parseSeaTileUrl(params.url);
    if (!t) throw new Error(`Bad sea tile URL: ${params.url}`);
    const key = `${t.z}/${t.x}/${t.y}|${t.color ?? 'off'}`;
    if (cache.has(key)) return cache.get(key);

    const promise = buildSeaTile(t.z, t.x, t.y, t.color).then(buf => ({ data: buf }));
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };

  try {
    addProtocol('sea', handler);
  } catch (err) {
    console.warn('Could not register sea:// protocol:', err?.message ?? err);
  }
};