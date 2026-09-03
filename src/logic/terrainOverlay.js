/**
 * Stacked terrain overlay (`terrain://` protocol).
 *
 * Replaces the remote-coloured MCSC WMS layer, the altitude-band overlay and
 * the per-instance meteo overlays with ONE client-side raster that paints
 * every pixel itself, so every filter can be ANDed per pixel:
 *
 * The overlay has two RENDERING MODES (`state.mode`), switching what the
 * painted areas show — the bottom-left tree/layers button toggles it:
 *
 *   'terrain'   (default) pixels carry their MCSC class colour (terrain
 *               types). Land is painted only when its class is SELECTED
 *               (legend entry not dimmed, not an unlisted 230–234 value);
 *               dimming the substrate families does NOT affect this mode.
 *   'substrate' pixels carry their substrate-family colour (geological
 *               map). Land is painted with its family colour whenever the
 *               grid has data there (id > 0); the MCSC class/forest dims
 *               do NOT affect this mode — each palette is filtered only by
 *               its own legend switch.
 *
 * Both modes AND, per pixel: water (inland MCSC water classes) is painted
 * with its class colour whenever Aigües is on — never gated by altitude /
 * meteo / substrate (it is not "mushroom terrain") — and the altitude band
 * AND every active meteo instance gate the land. Everything that fails — a
 * dimmed class (terrain mode), a dimmed family (substrate mode), the
 * permanently-unlisted 230–234 band values, no-data pixels — is left
 * TRANSPARENT, so the relief (the hillshade layer, which sits above this
 * one) shows through. There is no grey "deselected" colour anymore.
 *
 * To colour classes client-side the overlay needs the RAW band value per
 * pixel, not the server-coloured raster: mcscRaw.js requests the same ICGC
 * WMS with a value-encoding SLD (band v → colour rgb(v,0,0), everything else
 * transparent) and this module decodes it (red channel = band). The official
 * colour for the band is looked up in mcscLegend.js. The DEM (elevation.js)
 * is only fetched when a tile actually needs it: an active altitude band, or
 * a temperature instance (whose grid is sea-level-reduced and needs the
 * per-pixel elevation re-applied).
 *
 * Tiles are cached per (z,x,y,state signature). The full filter state — the
 * dimmed classes, the altitude band and every active instance's concrete
 * window + band — is baked into the tile URL as a signature, so the app just
 * calls `source.setTiles([...])` with the new URL to regenerate the overlay
 * when anything changes (MapLibre re-requests only when the URL differs).
 * The protocol handler reads the CURRENT state through `getState()`, exactly
 * like the `alt://` protocol reads its band through `getBand()`.
 */

import { loadTileImageData, terrariumElevation, tileXYToLngLat } from './elevation.js';
import { loadMcscBandTile } from './mcscRaw.js';
import { entryForBand, isWaterBand } from './mcscLegend.js';
import { featuresForWindow, getMeteoGrid, sampleMeteoGrid, LAPSE_RATE } from './meteoGrid.js';
import { lithoFamilyAt } from './lithology.js';
import { parseHexColor } from './seaOverlay.js';
// MapLibre v5+ registers custom protocols globally via the module-level
// `addProtocol` export — there is no `map.addProtocol` method anymore.
import { addProtocol } from 'maplibre-gl';

const TILE_SIZE = 256;

// Failing pixels are fully transparent — the relief shows through, exactly
// like abroad / areas without terrain info.
export const TERRAIN_TRANSPARENT = [0, 0, 0, 0];

// The empty filter state: terrain-type rendering, all classes selected, no
// altitude / meteo bands, no dimmed substrate family.
export const TERRAIN_STATE_EMPTY = { mode: 'terrain', off: [], alt: null, filters: [], geoOff: [] };

/** Substrate-family colour of a family id ([r,g,b,255]) or null. */
export const lithoFamilyColour = (grid, id) => {
  const e = grid?.entries?.find(x => x.id === id);
  return e && e.color ? parseHexColor(e.color.slice(1)) : null;
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
  if (familyKey && offKeys && offKeys.has(familyKey)) return TERRAIN_TRANSPARENT;
  if (altBand) {
    // Land only, inside the inclusive band (same rule as the altitude overlay).
    if (!Number.isFinite(elev) || elev <= 0) return TERRAIN_TRANSPARENT;
    if (elev < altBand[0] || elev > altBand[1]) return TERRAIN_TRANSPARENT;
  }
  for (let k = 0; k < values.length; k++) {
    const v = values[k];
    if (!Number.isFinite(v) || v < los[k] || v > his[k]) return TERRAIN_TRANSPARENT;
  }
  return colour;
};

/**
 * Deterministic signature of a filter state (used as the tile-URL token and
 * the protocol cache key). The state must already be canonicalised (sorted
 * `off` codes and sorted `filters` — see terrainStateSignature).
 */
export const terrainStateSig = state => JSON.stringify(state ?? TERRAIN_STATE_EMPTY);

/** Canonical form: sorted dimmed codes + families, filters ordered for stable
 * signatures. `mode` (terrain/substrate) is part of the state so switching
 * the rendering mode forces the tiles to repaint. */
export const terrainStateSignature = state => {
  const s = state ?? TERRAIN_STATE_EMPTY;
  return {
    mode: s.mode === 'substrate' ? 'substrate' : 'terrain',
    off: [...(s.off || [])].sort(),
    alt: s.alt ? [s.alt[0], s.alt[1]] : null,
    geoOff: [...(s.geoOff || [])].sort(),
    filters: [...(s.filters || [])].sort(
      (a, b) =>
        (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0) ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to) ||
        a.band[0] - b.band[0] ||
        a.band[1] - b.band[1]
    ),
  };
};

/** Tile URL for a filter state — the signature token forces re-requests. */
export const terrainTileUrl = state =>
  `terrain://{z}/{x}/{y}?s=${encodeURIComponent(terrainStateSig(terrainStateSignature(state)))}`;

/** Parse a `terrain://{z}/{x}/{y}?s=<sig>` tile URL (the token is opaque). */
export const parseTerrainTileUrl = url => {
  const m = /^terrain:\/\/(\d+)\/(\d+)\/(\d+)(?:\?s=[^&]*)?$/.exec(url || '');
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

/**
 * Painted PNG tile for one (z, x, y): every pixel carries the colour of the
 * ACTIVE rendering mode (MCSC class in 'terrain', substrate family in
 * 'substrate') when all of that mode's conditions pass, else it is
 * transparent (relief). `state` = `{ mode, off, alt, filters, geoOff }`
 * (see terrainStateSignature) with only ACTIVE meteo instances;
 * `getContext()` returns `{ agg, features, lithoGrid }` — the aggregate
 * table plus the base station features (from which each instance's
 * per-window feature values are computed on the fly, featuresForWindow) and
 * the decoded substrate grid (lithology.js). Exported so the browser-only
 * pipeline can be exercised under test.
 */
export async function buildTerrainTile(z, x, y, state, getContext) {
  const canvas = makeCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext('2d');
  const st = state ?? TERRAIN_STATE_EMPTY;
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
    // either palette's dimming set.
    let colour = null;
    let familyKey = null;
    if (isWater) {
      colour = bandColours[band];
    } else if (substrate) {
      const fid = lithoFamilyAt(lithoGrid, lngs[px], lats[py]);
      if (fid > 0) {
        colour = substrateColours[fid] ?? null;
        familyKey = lithoGrid.keyById[fid] ?? null;
      }
    } else {
      colour = bandColours[band]; // null = unlisted 230–234 / dimmed class
    }
    if (!colour) continue; // transparent

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

/**
 * Register the `terrain://{z}/{x}/{y}?s=<sig>` protocol (global in MapLibre
 * v5+). `getState` is called per tile and must return `{ mode, off, alt,
 * filters, geoOff }` (canonicalised — see terrainStateSignature);
 * `getContext` returns `{ agg, features, lithoGrid }`. The state signature
 * is baked into the URL so the app regenerates tiles with
 * `source.setTiles([...])`; re-registering (e.g. on map remount) just
 * overwrites the global handler, and the closures read App's refs so they
 * stay valid.
 */
export const registerTerrainProtocol = (map, getState, getContext) => {
  const cache = new Map(); // `${z}/${x}/${y}|<state sig>` -> Promise<{ data }>

  const handler = async params => {
    const t = parseTerrainTileUrl(params.url);
    if (!t) throw new Error(`Bad terrain tile URL: ${params.url}`);
    const state = terrainStateSignature(getState?.() ?? TERRAIN_STATE_EMPTY);
    const key = `${t.z}/${t.x}/${t.y}|${terrainStateSig(state)}`;
    if (cache.has(key)) return cache.get(key);

    const promise = buildTerrainTile(t.z, t.x, t.y, state, getContext).then(buf => ({ data: buf }));
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };

  try {
    addProtocol('terrain', handler);
  } catch (err) {
    console.warn('Could not register terrain:// protocol:', err?.message ?? err);
  }
};
