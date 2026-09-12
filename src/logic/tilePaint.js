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
 * 'substrate' paints geology-family colours, 'relief' paints the palette-less
 * bright-green HIGHLIGHT (TERRAIN_HIGHLIGHT) on the land pixels that pass
 * every active filter — a "what do my filters cover" view over the relief,
 * so the user can still SEE the filter without a palette. It only paints
 * while at least one filter condition is active (hasActiveTerrainFilter);
 * with no filter it is the same cheap relief-only transparent tile as before.
 * Failing pixels are transparent in every mode (the relief shows through).
 */

import {
  loadTileImageData,
  terrariumElevation,
  tileXYToLngLat,
  aspectSectorFromElevations,
  metresPerPixel,
} from './elevation.js';
import { loadMcscBandTile } from './mcscRaw.js';
import { entryForBand, isWaterBand } from './mcscLegend.js';
import { featuresForWindow, getMeteoGrid, sampleMeteoGrid, LAPSE_RATE } from './meteoGrid.js';
import { lithoFamilyAt } from './lithology.js';

const TILE_SIZE = 256;

// Orientation filter (slope aspect): Horn's 3×3 window reaches one pixel
// outside the tile, so the tile's outer ring needs the 8 adjacent DEM tiles.
// They are resolved into ONE padded ±1-pixel elevation grid (read as a flat
// array in the inner loop); a missing neighbour leaves NaN there and its ring
// pixels simply get no sector.
// Padded DEM grid: one ring pixel outside the tile on each side, so windows
// that read a neighbour pixel (3×3 slope aspect, marching-squares contour
// cells on the tile seam) use the adjacent tile's data instead of stopping
// at the boundary. See loadPaddedDem / buildIsohypseTile.
const PADDED_DEM_WIDTH = TILE_SIZE + 2;
const NEIGHBOUR_TILE_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];
// Shared scratch for the 9 elevations handed to aspectSectorFromElevations —
// the pixel loop is synchronous, so one buffer is safe and avoids 65k arrays
// per tile.
const aspectCells = new Float64Array(9);

// Elevation (m) of the DEM pixel at (px, py), allowing one pixel outside the
// tile: the offset selects the centre tile or one of the 8 neighbours. NaN
// when that neighbour is unavailable (fetch failure / outside the world).
const elevationNear = (src, byOffset, px, py) => {
  const dx = px < 0 ? -1 : px > TILE_SIZE - 1 ? 1 : 0;
  const dy = py < 0 ? -1 : py > TILE_SIZE - 1 ? 1 : 0;
  const img = dx === 0 && dy === 0 ? src : byOffset.get(`${dx},${dy}`);
  if (!img) return NaN;
  const x = (px + TILE_SIZE) % TILE_SIZE; // -1 → 255, TILE_SIZE → 0
  const y = (py + TILE_SIZE) % TILE_SIZE;
  const o = (y * TILE_SIZE + x) * 4;
  return terrariumElevation(img.data[o], img.data[o + 1], img.data[o + 2]);
};

/**
 * Padded ±1-pixel elevation grid of the tile at (z,x,y): the tile's own DEM
 * pixels plus the 8 neighbours' edge pixels, so windows that reach one pixel
 * outside the tile stay continuous across tile boundaries. A missing
 * neighbour leaves NaN there (its ring pixels get no value). DEM tiles are
 * cached by loadTileImageData. Browser-only.
 */
const loadPaddedDem = async (z, x, y, src) => {
  const neighbours = await Promise.all(
    NEIGHBOUR_TILE_OFFSETS.map(([dx, dy]) =>
      loadTileImageData(z, x + dx, y + dy)
        .then(img => [dx, dy, img])
        .catch(() => null)
    )
  );
  const byOffset = new Map();
  for (const n of neighbours) if (n) byOffset.set(`${n[0]},${n[1]}`, n[2]);
  const padded = new Float32Array(PADDED_DEM_WIDTH * PADDED_DEM_WIDTH);
  for (let py = -1; py <= TILE_SIZE; py++) {
    for (let px = -1; px <= TILE_SIZE; px++) {
      padded[(py + 1) * PADDED_DEM_WIDTH + (px + 1)] = elevationNear(src, byOffset, px, py);
    }
  }
  return padded;
};

// Failing pixels are fully transparent in EVERY mode — the relief shows
// through, exactly like abroad / areas without terrain info. There is no
// "deselected" or "filtered out" tint anywhere on the map.
export const TERRAIN_TRANSPARENT = [0, 0, 0, 0];

// Mode 'relief' palette: instead of painting a class/substrate colour, every
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

// ── Isohypses (elevation contour lines — rendering mode 'relief') ─────────
// In the palette-less 'relief' mode the terrain overlay itself paints nothing
// (or only the filter HIGHLIGHT), so the SHAPE of the ground comes from a
// dedicated isohypse raster built by this module: the DEM's elevation
// contours, drawn as thin light lines over the relief. Levels step by
// contourIntervalForZoom(z) metres, and every CONTOUR_INDEX_EVERY-th level (a
// "master" contour) is brighter and thicker the way a topographic sheet
// reads. Sea level and below are skipped, so no lines are drawn over the
// open sea. See buildIsohypseTile / contourCellSegments.
export const CONTOUR_INDEX_EVERY = 5;
export const CONTOUR_COLOR = [255, 255, 255];
export const CONTOUR_MINOR_ALPHA = 0.3;
export const CONTOUR_INDEX_ALPHA = 0.62;
export const CONTOUR_MINOR_WIDTH = 1;
export const CONTOUR_INDEX_WIDTH = 1.8;

// Contour interval (m) per zoom: [maxZoom, intervalM]. The DEM resolves finer
// shape zoomed in, so the lines step more finely too.
const CONTOUR_INTERVALS = [[8, 200], [10, 100], [Infinity, 50]];

/** Contour interval (m) at zoom `z`. Pure, unit-testable. */
export const contourIntervalForZoom = z => {
  const row = CONTOUR_INTERVALS.find(([max]) => z <= max);
  return (row ?? CONTOUR_INTERVALS[CONTOUR_INTERVALS.length - 1])[1];
};

// Isohypses only make sense at CLOSE zoom, where the DEM resolves enough real
// shape; from a general view the lines are dense, aliased and just clutter the
// map. The overlay's LAYER carries this as its style `minzoom`, which makes
// MapLibre both skip rendering AND skip loading the tiles below it
// (StyleLayer.isHidden → the source is marked unused → no ideal tiles), so the
// painter also bails out cheaply below the threshold. Zoom is half-open there:
// hidden for `zoom < minzoom`.
export const CONTOUR_MIN_ZOOM = 11;

// Master-contour elevation labels. The contour tiles are painted client-side,
// so a label is simply canvas text baked into the tile — no glyphs endpoint, no
// symbol layer, no extra source, no glyph-fetch failures in the field. Labels
// sit on the MASTER lines only; selectContourLabels thins them so at most one
// falls in any CONTOUR_LABEL_MIN_SPACING-pixel neighbourhood, then the painter
// rotates each to its line's local direction (flipped when that would put the
// text upside down). A dark halo keeps the white text legible over the relief.
export const CONTOUR_LABEL_MIN_SPACING = 90;  // px between labels in a tile
export const CONTOUR_LABEL_EDGE_MARGIN = 26;  // px: keep labels off the seams
export const CONTOUR_LABEL_FONT_SIZE = 11;    // px
export const CONTOUR_LABEL_COLOR = 'rgba(255, 255, 255, 0.95)';
export const CONTOUR_LABEL_HALO_COLOR = 'rgba(18, 22, 28, 0.85)';
export const CONTOUR_LABEL_HALO_WIDTH = 3;

/**
 * Marching-squares contour of ONE cell for a single level: the segment(s) of
 * the `level` isohypse crossing the cell, in cell-local coordinates
 * ([0,1] × [0,1]; x right, y down; corners tl=(0,0), tr=(1,0), br=(1,1),
 * bl=(0,1)). Returns an array of `[x1,y1,x2,y2]` — 0, 1 or 2 segments (a
 * saddle cell yields two). Non-finite corners (DEM no-data) yield none.
 * Pure, unit-testable.
 */
export const contourCellSegments = (tl, tr, br, bl, level) => {
  if (!Number.isFinite(tl) || !Number.isFinite(tr) || !Number.isFinite(br) || !Number.isFinite(bl)) return [];
  // Edge crossings, in the fixed order top, right, bottom, left.
  const cross = [];
  if ((tl < level) !== (tr < level)) cross.push([(level - tl) / (tr - tl), 0]);
  if ((tr < level) !== (br < level)) cross.push([1, (level - tr) / (br - tr)]);
  if ((bl < level) !== (br < level)) cross.push([(level - bl) / (br - bl), 1]);
  if ((tl < level) !== (bl < level)) cross.push([0, (level - tl) / (bl - tl)]);
  const seg = (a, b) => [a[0], a[1], b[0], b[1]];
  if (cross.length === 2) return [seg(cross[0], cross[1])];
  if (cross.length === 4) {
    // Saddle: the corner average decides which way the two lines connect.
    const centre = (tl + tr + br + bl) / 4;
    const diagonalHigh = (tl >= level) === (br >= level); // tl/br on one side
    const lowCentre = centre < level;
    return diagonalHigh === lowCentre
      ? [seg(cross[0], cross[1]), seg(cross[2], cross[3])] // top-right, bottom-left
      : [seg(cross[0], cross[3]), seg(cross[1], cross[2])]; // top-left, right-bottom
  }
  return [];
};

/**
 * Choose the master-contour label positions of a tile: one label per
 * CONTOUR_LABEL_MIN_SPACING-pixel neighbourhood, never within
 * CONTOUR_LABEL_EDGE_MARGIN of a tile seam (so no label is cut in half across
 * tiles), each rotated to its line's direction and flipped to stay upright.
 *
 * `candidates` are `[x1, y1, x2, y2, level]` segments in tile pixels (the
 * master-contour pieces emitted by buildIsohypseTile). Returns
 * `[{ x, y, angle, level }]` with x/y the segment midpoint. Pure, unit-testable
 * — the spatial thinning uses a spacing-sized hash grid, so it stays linear.
 */
export const selectContourLabels = (
  candidates,
  spacing = CONTOUR_LABEL_MIN_SPACING,
  margin = CONTOUR_LABEL_EDGE_MARGIN
) => {
  const cell = Math.max(1, spacing);
  const grid = new Set();
  const labels = [];
  for (const [x1, y1, x2, y2, level] of candidates) {
    const x = (x1 + x2) / 2;
    const y = (y1 + y2) / 2;
    if (x < margin || x > TILE_SIZE - margin || y < margin || y > TILE_SIZE - margin) continue;
    const gx = Math.floor(x / cell);
    const gy = Math.floor(y / cell);
    let clash = false;
    for (let dy = -1; dy <= 1 && !clash; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (grid.has(`${gx + dx},${gy + dy}`)) { clash = true; break; }
      }
    }
    if (clash) continue;
    grid.add(`${gx},${gy}`);
    let angle = Math.atan2(y2 - y1, x2 - x1);
    if (angle > Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;
    labels.push({ x, y, angle, level });
  }
  return labels;
};

// Empty filter state used as a build default: terrain-type rendering, all
// classes selected, no altitude / meteo bands, no dimmed substrate family,
// no orientation sectors.
export const TERRAIN_STATE_EMPTY = { mode: 'terrain', off: [], alt: null, aspect: null, filters: [], geoOff: [] };

/** Substrate-family colour of a family id ([r,g,b,255]) or null. */
export const lithoFamilyColour = (grid, id) => {
  const e = grid?.entries?.find(x => x.id === id);
  return e && e.color ? parseHexColor(e.color.slice(1)) : null;
};

/**
 * True when the state carries at least one ACTIVE filter condition — a
 * dimmed MCSC class (`off`), a dimmed substrate family (`geoOff`), an
 * altitude band (`alt`), an orientation selection (`aspect`) or an active
 * meteo instance (`filters`). Mode 'relief' is the green filter highlight,
 * which only makes sense once something is filtered: with no condition
 * active it must stay relief-only. `alt` is only ever set when narrowed,
 * `aspect` only for a partial sector selection and `filters` only holds
 * active instances (see terrainStateSignature / terrainState in App.jsx).
 * Pure, unit-testable.
 */
export const hasActiveTerrainFilter = state => {
  const s = state ?? TERRAIN_STATE_EMPTY;
  return !!(
    (s.off && s.off.length) ||
    (s.geoOff && s.geoOff.length) ||
    s.alt ||
    (s.aspect && s.aspect.length) ||
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
 * classifyTerrainPixel and by tests. Water never reaches here (it returns
 * before gating). `aspectKey` is the pixel's slope-aspect sector (null when
 * flat / no DEM) and `aspectKeys` the selected sectors: when the orientation
 * filter is active, a pixel with no sector or a sector outside the set is
 * excluded (OR within the selection, AND with every other condition).
 */
export const passesAllGates = (elev, altBand, values, los, his, familyKey = null, offKeys = null, aspectKey = null, aspectKeys = null) => {
  if (familyKey && offKeys && offKeys.has(familyKey)) return false;
  if (aspectKeys && aspectKeys.length) {
    if (!aspectKey || !aspectKeys.includes(aspectKey)) return false;
  }
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
 *
 * The two trailing optional params are the orientation filter: `aspectKey`
 * is the pixel's slope-aspect sector (null when flat / no DEM data) and
 * `aspectKeys` the selected sectors — when non-empty, a pixel whose sector is
 * missing or not selected is transparent (flat land is excluded by design).
 * Existing call sites/tests are unaffected, and water is never gated.
 */
export const classifyTerrainPixel = (colour, isWater, elev, altBand, values, los, his, familyKey = null, offKeys = null, aspectKey = null, aspectKeys = null) => {
  if (!colour) return TERRAIN_TRANSPARENT;
  if (isWater) return colour;
  return passesAllGates(elev, altBand, values, los, his, familyKey, offKeys, aspectKey, aspectKeys)
    ? colour
    : TERRAIN_TRANSPARENT;
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

/**
 * Parse an `isohypses://{z}/{x}/{y}` tile URL. The contour interval is a pure
 * function of z (contourIntervalForZoom), so the URL carries no state and
 * never has to be regenerated. Returns null for unrecognised URLs.
 * Pure, unit-testable.
 */
export const parseIsohypseTileUrl = url => {
  const m = /^isohypses:\/\/(\d+)\/(\d+)\/(\d+)$/.exec(url || '');
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
// (“ArrayBuffer already detached”) or for a cache hit (“relief” → forest
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
 * Mode 'relief' runs the SAME pipeline but paints the palette-less
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
  // 'relief' with no active filter → relief only: nothing to highlight, and
  // the whole region would turn green if we did. Keep it the cheap
  // transparent tile (no MCSC, no DEM, no grids, no pixel loop).
  if (st.mode === 'relief' && !hasActiveTerrainFilter(st)) return transparentTilePng();
  // 'relief' with a filter: no palette, so replace the class/substrate colour
  // with the bright-green highlight. The gate stack below is otherwise
  // identical.
  const highlight = st.mode === 'relief';

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
  // Orientation filter: selected slope-aspect sectors (null/empty = off).
  const aspectKeys = st.aspect && st.aspect.length ? st.aspect : null;
  // The DEM is needed for the altitude band, temperature (lapse rate) or the
  // orientation filter (aspect is read from the DEM's 3×3 neighbourhood).
  const needElev = !!aspectKeys || !!st.alt || grids.some(g => g.lapseRate > 0);

  const bandImg = await loadMcscBandTile(z, x, y);
  const src = needElev ? await loadTileImageData(z, x, y) : null;

  // Orientation: Horn's 3×3 needs the neighbouring pixel, so the tile's outer
  // ring needs the 8 adjacent DEM tiles (cached — they are the centre tiles
  // of their own paints). Resolve them into ONE padded ±1-pixel elevation
  // grid so the inner loop stays a flat array read; a missing neighbour
  // leaves NaN there and its ring pixels get no sector (unpainted while the
  // filter is active — "no info = not shown", same as the altitude gate).
  let padded = null;
  let cellSizeM = 1;
  if (aspectKeys && src) {
    padded = await loadPaddedDem(z, x, y, src);
    // Ground size of one DEM pixel at this tile's latitude — the ≥5° flat
    // guard is a physical angle, not a pixel count.
    const centre = tileXYToLngLat(z, x, y, TILE_SIZE / 2, TILE_SIZE / 2);
    cellSizeM = metresPerPixel(z, centre.lat);
  }

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
      // 'relief': highlight the passing LAND in green. A dimmed / unlisted
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
    // Orientation: the pixel's slope-aspect sector from the padded DEM grid
    // (its own 3×3 window, so the tile ring is covered by the neighbours).
    let aspectKey = null;
    if (padded && !isWater) {
      const bx = px + 1;
      const by = py + 1;
      aspectCells[0] = padded[(by - 1) * PADDED_DEM_WIDTH + (bx - 1)];
      aspectCells[1] = padded[(by - 1) * PADDED_DEM_WIDTH + bx];
      aspectCells[2] = padded[(by - 1) * PADDED_DEM_WIDTH + (bx + 1)];
      aspectCells[3] = padded[by * PADDED_DEM_WIDTH + (bx - 1)];
      aspectCells[4] = padded[by * PADDED_DEM_WIDTH + bx];
      aspectCells[5] = padded[by * PADDED_DEM_WIDTH + (bx + 1)];
      aspectCells[6] = padded[(by + 1) * PADDED_DEM_WIDTH + (bx - 1)];
      aspectCells[7] = padded[(by + 1) * PADDED_DEM_WIDTH + bx];
      aspectCells[8] = padded[(by + 1) * PADDED_DEM_WIDTH + (bx + 1)];
      aspectKey = aspectSectorFromElevations(aspectCells, cellSizeM);
    }
    const c = classifyTerrainPixel(colour, isWater, elev, st.alt, values, los, his, familyKey, offGeo, aspectKey, aspectKeys);
    if (c !== TERRAIN_TRANSPARENT) {
      d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = c[3];
    }
  }
  ctx.putImageData(out, 0, 0);
  return (await canvasToBlob(canvas)).arrayBuffer();
}

/**
 * Draw the master-contour elevation labels onto the tile canvas: each is
 * rotated to its line's direction and painted with a dark halo behind white
 * text so it stays legible over the relief. `labels` come from
 * selectContourLabels. Browser-only.
 */
const drawContourLabels = (ctx, labels) => {
  if (!labels.length) return;
  ctx.font = `${CONTOUR_LABEL_FONT_SIZE}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const { x, y, angle, level } of labels) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const text = String(level);
    ctx.strokeStyle = CONTOUR_LABEL_HALO_COLOR;
    ctx.lineWidth = CONTOUR_LABEL_HALO_WIDTH;
    ctx.strokeText(text, 0, 0);
    ctx.fillStyle = CONTOUR_LABEL_COLOR;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
};

/**
 * Isohypse (contour-line) PNG tile: the DEM's elevation contours drawn as
 * thin light lines on a transparent background, so they read over the relief
 * in rendering mode 'relief'. Levels step every contourIntervalForZoom(z)
 * metres; every CONTOUR_INDEX_EVERY-th level (a master contour) is drawn
 * brighter / thicker AND carries its elevation as a label (drawContourLabels),
 * so the height of a line is readable without a legend. Sea level and below are
 * skipped (no lines over the open sea). Contours are found per cell with
 * marching squares over a ±1-pixel padded DEM grid (loadPaddedDem), so lines
 * stay continuous across tile seams. Only called at/above CONTOUR_MIN_ZOOM and
 * exported so the browser-only pipeline can be exercised under test.
 */
export async function buildIsohypseTile(z, x, y) {
  // Below the draw threshold the layer is hidden (its minzoom), so MapLibre
  // never requests these tiles — stay a cheap no-op if it ever does.
  if (z < CONTOUR_MIN_ZOOM) return transparentTilePng();
  const src = await loadTileImageData(z, x, y);
  const padded = await loadPaddedDem(z, x, y, src);
  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const interval = contourIntervalForZoom(z);
  // Flat [x1,y1,x2,y2, …] pixel-coordinate buffers, one per line class,
  // stroked as a single path at the end (far cheaper than per-segment state).
  const minor = [];
  const index = [];
  const labelCandidates = [];
  const W = PADDED_DEM_WIDTH;
  for (let py = 0; py < TILE_SIZE; py++) {
    const by = py + 1; // padded index of the cell's top row (pixel py)
    for (let px = 0; px < TILE_SIZE; px++) {
      const bx = px + 1;
      const tl = padded[by * W + bx];
      const tr = padded[by * W + bx + 1];
      const br = padded[(by + 1) * W + bx + 1];
      const bl = padded[(by + 1) * W + bx];
      if (!Number.isFinite(tl) || !Number.isFinite(tr) || !Number.isFinite(br) || !Number.isFinite(bl)) continue;
      const lo = Math.min(tl, tr, br, bl);
      const hi = Math.max(tl, tr, br, bl);
      let level = Math.ceil(lo / interval) * interval; // first multiple ≥ lo
      if (level <= 0) level = interval; // skip sea level / bathymetry lines
      for (; level <= hi; level += interval) {
        const segs = contourCellSegments(tl, tr, br, bl, level);
        if (!segs.length) continue;
        const isIndex = Math.round(level / interval) % CONTOUR_INDEX_EVERY === 0;
        const bucket = isIndex ? index : minor;
        for (const s of segs) {
          const x1 = px + s[0];
          const y1 = py + s[1];
          const x2 = px + s[2];
          const y2 = py + s[3];
          bucket.push(x1, y1, x2, y2);
          if (isIndex) labelCandidates.push([x1, y1, x2, y2, level]);
        }
      }
    }
  }
  const [cr, cg, cb] = CONTOUR_COLOR;
  const stroke = (flat, alpha, width) => {
    if (!flat.length) return;
    ctx.beginPath();
    for (let k = 0; k < flat.length; k += 4) {
      ctx.moveTo(flat[k], flat[k + 1]);
      ctx.lineTo(flat[k + 2], flat[k + 3]);
    }
    ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  stroke(minor, CONTOUR_MINOR_ALPHA, CONTOUR_MINOR_WIDTH);
  stroke(index, CONTOUR_INDEX_ALPHA, CONTOUR_INDEX_WIDTH);
  drawContourLabels(ctx, selectContourLabels(labelCandidates));
  return (await canvasToBlob(canvas)).arrayBuffer();
}
