/**
 * Pure per-tile painters shared by the main thread and the painting Web
 * Worker (tileWorker.js). This module must stay FREE of maplibre-gl imports:
 * the worker bundles it, and maplibre must not be pulled into the worker.
 *
 * Everything here is browser-only at runtime (fetch, canvas, ImageData) but
 * has no side effects at import time, so the pure helpers (classify*, colour
 * lookups, URL parsers) are unit-testable and the painters run under tests
 * with canvas / tile fetches stubbed.
 *
 * The painters were extracted from terrainOverlay.js (land-cover +
 * substrate stacked overlay) and seaOverlay.js (DEM-based sea fill); those
 * modules now import from here and re-export the public symbols so existing
 * callers and tests are unchanged.
 *
 * Rendering modes (terrainOverlay.js): 'terrain' paints MCSC class colours,
 * 'substrate' paints geology-family colours, 'none' paints the palette-less
 * bright-green HIGHLIGHT (TERRAIN_HIGHLIGHT) on the land pixels that pass
 * every active filter — a "what do my filters cover" view over the relief,
 * so the user can still SEE the filter without a palette. It only paints
 * while at least one filter condition is active (hasActiveTerrainFilter);
 * with no filter it is the same cheap relief-only transparent tile as before.
 * Failing pixels are transparent in every mode (the relief shows through).
 */

import { loadTileImageData, terrariumElevation, tileXYToLngLat } from './elevation.js';
import { loadMcscBandTile } from './mcscRaw.js';
import { entryForBand, isWaterBand } from './mcscLegend.js';
import { featuresForWindow, getMeteoGrid, sampleMeteoGrid, LAPSE_RATE } from './meteoGrid.js';
import { lithoFamilyAt } from './lithology.js';

const TILE_SIZE = 256;

// Failing pixels are fully transparent in EVERY mode — the relief shows
// through, exactly like abroad / areas without terrain info. There is no
// "deselected" or "filtered out" tint anywhere on the map.
export const TERRAIN_TRANSPARENT = [0, 0, 0, 0];

// Mode 'none' palette: instead of painting a class/substrate colour, every
// LAND pixel that passes the full filter stack (selected class + altitude
// band + all meteo instances + undimmed substrate family) is tinted this
// bright green, so the filter's coverage stays visible over the relief. The
// alpha (~65%) lets the hillshade read through; the raster layer's own
// opacity (0.85) dims it a little further. Water is deliberately NOT
// highlighted — the land filters don't describe it, so the sea layer keeps
// its navy. Only painted while at least one filter is active
// (hasActiveTerrainFilter): with no filter it would tint the whole region.
// Tunable; the exact green/alpha is cosmetic.
export const TERRAIN_HIGHLIGHT = [0, 255, 0, 165];

export const SEA_TRANSPARENT = [0, 0, 0, 0];

// Empty filter state used as a build default: terrain-type rendering, all
// classes selected, no altitude / meteo bands, no dimmed substrate family.
export const TERRAIN_STATE_EMPTY = { mode: 'terrain', off: [], alt: null, filters: [], geoOff: [] };

/** Substrate-family colour of a family id ([r,g,b,255]) or null. */
export const lithoFamilyColour = (grid, id) => {
  const e = grid?.entries?.find(x => x.id === id);
  return e && e.color ? parseHexColor(e.color.slice(1)) : null;
};

/**
 * True when the state carries at least one ACTIVE filter condition — a
 * dimmed MCSC class (`off`), a dimmed substrate family (`geoOff`), an
 * altitude band (`alt`) or an active meteo instance (`filters`). Mode 'none'
 * is the green filter highlight, which only makes sense once something is
 * filtered: with no condition active it must stay relief-only. `alt` is only
 * ever set when narrowed and `filters` only holds active instances (see
 * terrainStateSignature / terrainState in App.jsx). Pure, unit-testable.
 */
export const hasActiveTerrainFilter = state => {
  const s = state ?? TERRAIN_STATE_EMPTY;
  return !!(
    (s.off && s.off.length) ||
    (s.geoOff && s.geoOff.length) ||
    s.alt ||
    (s.filters && s.filters.length)
  );
};

// Parse a 6-digit hex colour ("000080") into [r, g, b, 255]; null if invalid.
export const parseHexColor = hex => {
  if (typeof hex !== 'string') return null;
  const m = /^([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
};

/**
 * Official [r, g, b, 255] colour of a raw band value when its class is
 * SELECTED — the entry exists in the legend and is not in `offCodes` — or
 * null when the pixel must stay transparent (no data, permanently-unlisted
 * 230–234 values, or a dimmed class). Pure, unit-testable.
 */
export const colourForBand = (band, offCodes = new Set()) => {
  const entry = entryForBand(band);
  if (!entry || offCodes.has(entry.codes)) return null;
  return parseHexColor(entry.color.slice(1)); // parseHexColor expects 6 hex chars, no '#'
};

/** Shared gate: true iff a land pixel satisfies every filter. Used by
 * classifyTerrainPixel, by the veil inversion, and by tests. Water never
 * reaches here (it returns before gating).
 */
export const passesAllGates = (elev, altBand, values, los, his, familyKey = null, offKeys = null) => {
  if (familyKey && offKeys && offKeys.has(familyKey)) return false;
  if (altBand) {
    if (!Number.isFinite(elev) || elev <= 0) return false;
    if (elev < altBand[0] || elev > altBand[1]) return false;
  }
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v) || v < los[k] || v > his[k]) return false;
  }
  return true;
};

/**
 * Pure per-pixel classification (unit-testable): returns the pixel colour to
 * paint, or TERRAIN_TRANSPARENT. `colour` is the class colour of the pixel's
 * band (see colourForBand); `values[k]` are the sampled window-aggregates of
 * the active meteo instances at the pixel, with `los[k]`/`his[k]` their
 * inclusive bands. Water classes are painted whenever selected — they are
 * never gated by altitude / meteo / geology (water is not "mushroom
 * terrain"). `familyKey` is the pixel's substrate-family key (null for no
 * data) and `offKeys` the Set of dimmed families: a land pixel whose family
 * is off is transparent (geology filter), but nodata pixels always pass.
 */
export const classifyTerrainPixel = (colour, isWater, elev, altBand, values, los, his, familyKey = null, offKeys = null) => {
  if (!colour) return TERRAIN_TRANSPARENT;
  if (isWater) return colour;
  return passesAllGates(elev, altBand, values, los, his, familyKey, offKeys) ? colour : TERRAIN_TRANSPARENT;
};

// Pure classification (unit-testable): sea (elev <= 0) → the sea colour,
// land (elev > 0) or no data → transparent; a missing colour disables the
// overlay entirely (same "off" semantics as the other area overlays).
export const classifySea = (elev, color) => {
  if (!Number.isFinite(elev) || elev > 0) return SEA_TRANSPARENT;
  return color ?? SEA_TRANSPARENT;
};

/**
 * Parse a `sea://{z}/{x}/{y}?c=<hex|off>` tile URL. An optional `&r=<n>`
 * repaint token is allowed (the app appends it so MapLibre can never serve
 * a stale cached tile after a repaint). Returns null for unrecognised URLs.
 * Pure, unit-testable.
 */
export const parseSeaTileUrl = url => {
  const m = /^sea:\/\/(\d+)\/(\d+)\/(\d+)\?c=([0-9a-fA-F]{6}|off)(?:&r=\d+)?$/.exec(url || '');
  if (!m) return null;
  return {
    z: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    color: m[4] === 'off' ? null : m[4],
  };
};

/**
 * Parse a `terrain://{z}/{x}/{y}?s=<sig>` tile URL (the token is opaque); an
 * optional `&r=<n>` repaint token is allowed, see parseSeaTileUrl.
 */
export const parseTerrainTileUrl = url => {
  const m = /^terrain:\/\/(\d+)\/(\d+)\/(\d+)(?:\?s=[^&]*(?:&r=\d+)?)?$/.exec(url || '');
  if (!m) return null;
  return { z: Number(m[1]), x: Number(m[2]), y: Number(m[3]) };
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

// A fully transparent 256×256 PNG, produced once and reused. It is the
// fallback whenever a tile cannot be painted (MCSC / DEM host hiccup, worker
// failure): serving a VALID transparent tile instead of rejecting keeps the
// raster sources free of errored tiles — MapLibre < 6.1 crashes its renderer
// when setTiles() reloads an errored tile (maplibre-gl-js #7775), and a
// failed tile would otherwise wedge the painted layer forever.
//
// The PNG is cached as an ArrayBuffer, but a TRANSFERRED ArrayBuffer is
// detached. The worker transfers the buffer (postMessage(..., [buf])) and
// MapLibre may also detach, so returning the SAME buffer for two tiles
// (“ArrayBuffer already detached”) or for a cache hit (“none” → forest
// cycle) would wedge the layer. Every caller gets a COPY.
// OffscreenCanvas.convertToBlob requires a rendering context.
let transparentPngPromise = null;
const getTransparentPngBuffer = () => {
  if (!transparentPngPromise) {
    transparentPngPromise = (async () => {
      const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
      // Ensure a context exists — OffscreenCanvas has none until getContext
      canvas.getContext('2d');
      return (await canvasToBlob(canvas)).arrayBuffer();
    })().catch(err => {
      transparentPngPromise = null;
      throw err;
    });
  }
  return transparentPngPromise;
};
export const transparentTilePng = async () => {
  const buf = await getTransparentPngBuffer();
  // Never hand out the cached buffer itself — the caller will transfer it.
  return buf.slice(0);
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
 * Painted PNG tile for one (z, x, y): every pixel carries the colour of the
 * ACTIVE rendering mode (MCSC class in 'terrain', substrate family in
 * 'substrate') when every SHARED gate passes — MCSC class selected (`off`),
 * substrate family on (`geoOff`), altitude + meteo bands — else transparent
 * (relief); the sel button only picks which palette supplies the colour.
 * `state` = `{ mode, off, alt, filters, geoOff }` (see
 * terrainStateSignature in terrainOverlay.js) with only ACTIVE meteo
 * instances; `getContext()` returns `{ agg, features, lithoGrid }`.
 *
 * Mode 'none' runs the SAME pipeline but paints the palette-less
 * TERRAIN_HIGHLIGHT on the passing land pixels instead of a class/family
 * colour, so the filter's coverage is visible over the relief — water stays
 * transparent (see TERRAIN_HIGHLIGHT). Knowing which pixels pass needs the
 * same MCSC / DEM / meteo sampling as the painted modes. With NO filter
 * active the highlight would just tint the whole region, so the mode falls
 * back to the old zero-fetch transparent tile. Exported so the browser-only
 * pipeline can be exercised under test.
 */
export async function buildTerrainTile(z, x, y, state, getContext) {
  const st = state ?? TERRAIN_STATE_EMPTY;
  // 'none' with no active filter → relief only: nothing to highlight, and
  // the whole region would turn green if we did. Keep it the cheap
  // transparent tile (no MCSC, no DEM, no grids, no pixel loop).
  if (st.mode === 'none' && !hasActiveTerrainFilter(st)) return transparentTilePng();
  // 'none' with a filter: no palette, so replace the class/substrate colour
  // with the bright-green highlight. The gate stack below is otherwise
  // identical.
  const highlight = st.mode === 'none';

  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const off = new Set(st.off || []);
  const offGeo = new Set(st.geoOff || []);

  // Precompute the selected colour of every band once (band → rgba or null).
  const bandColours = [];
  const bandIsWater = [];
  for (let b = 0; b <= 41; b++) {
    bandColours[b] = colourForBand(b, off);
    bandIsWater[b] = isWaterBand(b);
  }

  // IDW grid per ACTIVE meteo instance (its own concrete window). Temperature
  // grids are sea-level-reduced and need the per-pixel elevation re-applied.
  const { agg, features, lithoGrid } = getContext?.() || {};
  // Substrate mode paints the family colour per land pixel; it needs the
  // grid (falls back to terrain rendering while it is unavailable). In
  // terrain mode the grid is never sampled.
  const substrate = st.mode === 'substrate' && !!lithoGrid;
  const substrateColours = [];
  if (lithoGrid) {
    for (const e of lithoGrid.entries) {
      if (e.id > 0) substrateColours[e.id] = lithoFamilyColour(lithoGrid, e.id);
    }
  }
  const grids = [];
  const los = [];
  const his = [];
  for (const f of st.filters || []) {
    const windowFeatures = featuresForWindow(agg, features || [], f.variable, f.from, f.to);
    const grid = getMeteoGrid(`${f.from}_${f.to}`, f.variable, windowFeatures, {
      lapseRate: f.variable === 'tempAvg' ? LAPSE_RATE : 0,
    });
    grids.push(grid);
    los.push(f.band[0]);
    his.push(f.band[1]);
  }
  // The DEM is only needed for the altitude band or temperature (lapse rate).
  const needElev = !!st.alt || grids.some(g => g.lapseRate > 0);

  const bandImg = await loadMcscBandTile(z, x, y);
  const src = needElev ? await loadTileImageData(z, x, y) : null;

  const out = ctx.createImageData(TILE_SIZE, TILE_SIZE);
  const d = out.data;
  const s = bandImg.data;

  // lng depends only on the column, lat only on the row — precompute once.
  const lngs = new Float64Array(TILE_SIZE);
  const lats = new Float64Array(TILE_SIZE);
  for (let p = 0; p < TILE_SIZE; p++) {
    lngs[p] = tileXYToLngLat(z, x, y, p, 0).lng;
    lats[p] = tileXYToLngLat(z, x, y, 0, p).lat;
  }
  const values = new Float64Array(grids.length); // reused per pixel

  for (let i = 0, o = 0; i < s.length; i += 4, o += 4) {
    const band = s[i]; // raw value encoded in the red channel (0 = no data)
    if (!band) continue; // no MCSC data at all → transparent (abroad / sea)
    const px = (o >> 2) & 255;
    const py = o >> 10; // o / 4 / 256, row-major
    const isWater = bandIsWater[band];

    // Base colour of the pixel, by rendering mode. Water keeps its class
    // colour (Aigües switch) in BOTH modes — it is shared, not part of
    // either palette's dimming set. Land pixels share ONE gate stack in
    // every mode: the MCSC class must be SELECTED (a dimmed class or the
    // permanently-unlisted 230–234 bands are transparent in ANY mode) and,
    // whenever the lithology grid is available, the pixel's family key is
    // sampled so the substrate dims (`geoOff`) gate every mode too — the
    // sel button only picks which palette supplies the colour.
    let colour = null;
    let familyKey = null;
    let fid = 0;
    if (!isWater && lithoGrid) {
      fid = lithoFamilyAt(lithoGrid, lngs[px], lats[py]);
      if (fid > 0) familyKey = lithoGrid.keyById[fid] ?? null;
    }
    if (highlight) {
      // 'none': highlight the passing LAND in green. A dimmed / unlisted
      // class is null → transparent; water is never highlighted (the land
      // filters don't describe it) and keeps the sea layer's navy.
      colour = isWater ? null : (bandColours[band] ? TERRAIN_HIGHLIGHT : null);
    } else if (isWater) {
      colour = bandColours[band];
    } else if (bandColours[band]) {
      colour = substrate ? (fid > 0 ? (substrateColours[fid] ?? null) : null) : bandColours[band];
    } // else null: dimmed class / unlisted 230–234 → transparent in every mode

    const elev = needElev
      ? terrariumElevation(src.data[i], src.data[i + 1], src.data[i + 2])
      : NaN;

    if (!isWater && grids.length) {
      for (let k = 0; k < grids.length; k++) {
        let value = sampleMeteoGrid(grids[k], lngs[px], lats[py]);
        if (grids[k].lapseRate > 0 && Number.isFinite(value)) {
          value -= (grids[k].lapseRate * elev) / 1000; // re-apply cell elevation
        }
        values[k] = value;
      }
    }
    const c = classifyTerrainPixel(colour, isWater, elev, st.alt, values, los, his, familyKey, offGeo);
    if (c !== TERRAIN_TRANSPARENT) {
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
    }
  }
  ctx.putImageData(out, 0, 0);
  return (await canvasToBlob(canvas)).arrayBuffer();
}
