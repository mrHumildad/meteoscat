/**
 * Stacked terrain overlay (`terrain://` protocol).
 *
 * Replaces the remote-coloured MCSC WMS layer, the altitude-band overlay and
 * the per-instance meteo overlays with ONE client-side raster that paints
 * every pixel itself, so every filter can be ANDed per pixel:
 *
 * The overlay has RENDERING MODES (`state.mode`), switching what the
 * painted areas show — the bottom-left tree/layers button cycles them:
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
 *   'relief'    palette-less: paints the bright-green highlight on the land
 *               pixels that pass EVERY filter (the same AND stack as the two
 *               painted modes) so the filter's coverage stays visible over
 *               the relief. Only while at least one filter condition is
 *               active (hasActiveTerrainFilter) — with no filter it stays the
 *               cheap relief-only transparent tile, otherwise the whole
 *               region would light up green. Water is NOT highlighted (the
 *               land filters don't describe it) and keeps the sea layer's
 *               navy. While a filter IS active it fetches the MCSC / DEM /
 *               meteo grids, because knowing which pixels pass needs them.
 *               The GROUND SHAPE in this mode comes from a separate isohypse
 *               raster (isohypsesOverlay.js) drawn on top of the hillshade:
 *               the DEM's elevation contours, independent of this filter
 *               state, so this overlay itself stays transparent with no
 *               filter.
 *
 * All modes AND, per pixel: in the painted modes water (inland MCSC water
 * classes) is painted with its class colour whenever Aigües is on — never
 * gated by altitude / meteo / substrate (it is not "mushroom terrain") — and
 * the altitude band AND every active meteo instance gate the land. Everything
 * that fails — a dimmed class, a dimmed substrate family, the
 * permanently-unlisted 230–234 band values, no-data pixels — is left
 * TRANSPARENT, so the relief (the hillshade layer, which sits above this
 * one) shows through. There is no grey "deselected" colour anymore.
 *
 * The actual per-tile painting lives in tilePaint.js (shared with the Web
 * Worker that does it off the main thread — see tilePipeline.js); this
 * module owns the protocol registration and the state signature, which stay
 * main-thread.
 *
 * Tiles are cached per (z,x,y,state signature). The full filter state — the
 * dimmed classes, the altitude band and every active instance's concrete
 * window + band — is baked into the tile URL as a signature, so the app just
 * calls `source.setTiles([...])` with the new URL to regenerate the overlay
 * when anything changes (MapLibre re-requests only when the URL differs).
 * The protocol handler reads the CURRENT state through `getState()`.
 */

import { addProtocol } from 'maplibre-gl';
import { TERRAIN_STATE_EMPTY, parseTerrainTileUrl } from './tilePaint.js';
import * as tilePipeline from './tilePipeline.js';

// Pure painters + helpers now live in tilePaint.js (shared with the painting
// worker); re-exported here so existing callers and tests are unchanged.
export {
  TERRAIN_TRANSPARENT,
  TERRAIN_HIGHLIGHT,
  TERRAIN_STATE_EMPTY,
  lithoFamilyColour,
  colourForBand,
  hasActiveTerrainFilter,
  classifyTerrainPixel,
  passesAllGates,
  parseTerrainTileUrl,
  buildTerrainTile,
} from './tilePaint.js';

/**
 * Deterministic signature of a filter state (used as the tile-URL token and
 * the cache key). The state must already be canonicalised (sorted `off`
 * codes and sorted `filters` — see terrainStateSignature).
 */
export const terrainStateSig = state => JSON.stringify(state ?? TERRAIN_STATE_EMPTY);

/** Canonical form: sorted dimmed codes + families, filters ordered for stable
 * signatures. `mode` (terrain/substrate) is part of the state so switching
 * the rendering mode forces the tiles to repaint. */
export const terrainStateSignature = state => {
  const s = state ?? TERRAIN_STATE_EMPTY;
  return {
    // 'relief' (isohypses + bright-green filter highlight over the relief)
    // survives; the legacy 'none' spelling maps to it too, and anything
    // unknown falls back to the default 'terrain' so old URLs/states stay
    // valid.
    mode: s.mode === 'relief' || s.mode === 'none' ? 'relief' : s.mode === 'substrate' ? 'substrate' : 'terrain',
    off: [...(s.off || [])].sort(),
    alt: s.alt ? [s.alt[0], s.alt[1]] : null,
    // Orientation (slope aspect): selected sector keys, sorted; null when no
    // sector is selected (the app also normalises "all 8" to null — off).
    aspect: s.aspect && s.aspect.length ? [...s.aspect].sort() : null,
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

/**
 * Register the `terrain://{z}/{x}/{y}?s=<sig>` protocol (global in MapLibre
 * v5+). `getState` is called per tile and must return `{ mode, off, alt,
 * filters, geoOff }` (canonicalised — see terrainStateSignature). The
 * painting context `{ agg, features, lithoGrid }` is NOT read here anymore:
 * it lives in tilePipeline (pushed by the app via pushTerrainContext), which
 * both the worker and the inline fallback read. The state signature is
 * baked into the URL so the app regenerates tiles with `source.setTiles([...])`;
 * re-registering (e.g. on map remount) just overwrites the global handler,
 * and the closures read App's refs so they stay valid.
 *
 * When a painting worker is available (tilePipeline) the per-tile work runs
 * off the main thread; otherwise tiles are painted inline by the same
 * builders, exactly as before. Both handlers NEVER reject: paint failures
 * (MCSC / DEM host hiccup, worker crash) come back as valid transparent
 * tiles, so this raster source can never hold an errored tile — MapLibre
 * < 6.1 crashes its renderer when setTiles() reloads an errored tile
 * (maplibre-gl-js #7775).
 */
export const registerTerrainProtocol = (map, getState) => {
  tilePipeline.ensureWorker();

  // Main-thread fallback handler — the historical implementation: cache the
  // painted tile per (z,x,y,state). A failed paint caches its transparent
  // fallback too, so a sick host isn't re-hit on every identical request.
  const mainThreadHandler = async (params, abortController) => {
    const t = parseTerrainTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult(); // never reject — see above
    const state = terrainStateSignature(getState?.() ?? TERRAIN_STATE_EMPTY);
    const key = `${t.z}/${t.x}/${t.y}|${terrainStateSig(state)}`;
    if (cache.has(key)) return cache.get(key);

    const promise = tilePipeline.paintTerrainTile(t.z, t.x, t.y, state, abortController?.signal);
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };
  const cache = new Map(); // `${z}/${x}/${y}|<state sig>` -> Promise<{ data }>

  // Worker handler: parse + canonicalise on the main thread, paint in the
  // worker (paintTerrainTile falls back inline if the worker ever dies, and
  // resolves transparent on failure). The abort controller (MapLibre cancels
  // tiles that leave the viewport while zooming / panning) is passed through
  // so stale paints are dropped instead of queueing up behind the visible
  // tiles.
  const workerHandler = async (params, abortController) => {
    const t = parseTerrainTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult();
    const state = terrainStateSignature(getState?.() ?? TERRAIN_STATE_EMPTY);
    return tilePipeline.paintTerrainTile(t.z, t.x, t.y, state, abortController?.signal);
  };

  try {
    addProtocol('terrain', tilePipeline.isWorkerMode() ? workerHandler : mainThreadHandler);
  } catch (err) {
    console.warn('Could not register terrain:// protocol:', err?.message ?? err);
  }
};
