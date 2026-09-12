/**
 * Sea overlay (`sea://` protocol).
 *
 * The always-on hillshade layer shades the whole map from the same terrarium
 * DEM used for relief, and over the ocean that DEM carries bathymetry (flat or
 * underwater elevations) — so the sea renders as a grey shaded surface instead
 * of looking like water. This overlay paints every pixel whose elevation is
 * <= 0 (sea / below sea level) with the water colour and leaves land
 * transparent, using the exact same DEM the relief uses, so the sea/coast
 * boundary is pixel-perfect with the terrain.
 *
 * The colour is baked into the tile URL (`sea://{z}/{x}/{y}?c=2a2ab7` or
 * `c=off`), so the app just calls `source.setTiles([...])` with a new URL to
 * recolor the sea — e.g. to hide it (fully transparent → relief shows)
 * together with the Aigües class when that legend entry is dimmed. Tiles are
 * generated in the browser (fetch + decode + classify + PNG encode) and
 * cached per (z,x,y,colour). Painting itself lives in tilePaint.js (shared
 * with the Web Worker — see tilePipeline.js), which keeps the main thread
 * free on old devices.
 */

import { addProtocol } from 'maplibre-gl';
import { parseSeaTileUrl } from './tilePaint.js';
import * as tilePipeline from './tilePipeline.js';

// Pure painters + helpers now live in tilePaint.js; re-exported here so
// existing callers and tests are unchanged.
export {
  SEA_TRANSPARENT,
  parseHexColor,
  classifySea,
  parseSeaTileUrl,
  buildSeaTile,
} from './tilePaint.js';

/**
 * Register the `sea://` protocol (global in MapLibre v5+). The colour is baked
 * into the URL, so the app regenerates tiles with `source.setTiles([...])`
 * whenever the water colour changes. Re-registering (e.g. on map remount)
 * just overwrites the global handler.
 *
 * When a painting worker is available the per-tile work runs off the main
 * thread; otherwise tiles are painted inline, exactly as before. Both
 * handlers NEVER reject: a failed paint (e.g. the DEM host hiccuping) comes
 * back as a valid transparent tile, so this raster source can never hold an
 * errored tile — MapLibre < 6.1 crashes its renderer when setTiles()
 * reloads an errored tile (maplibre-gl-js #7775).
 */
export const registerSeaProtocol = () => {
  tilePipeline.ensureWorker();

  // Main-thread fallback handler — the historical implementation.
  const mainThreadHandler = async (params, abortController) => {
    const t = parseSeaTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult(); // never reject — see above
    const key = `${t.z}/${t.x}/${t.y}|${t.color ?? 'off'}`;
    if (cache.has(key)) return cache.get(key);

    const promise = tilePipeline.paintSeaTile(t.z, t.x, t.y, t.color, abortController?.signal);
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };
  const cache = new Map(); // `${z}/${x}/${y}|<colour>` -> Promise<{ data }>

  // Worker handler: parse on the main thread, paint in the worker. The abort
  // controller (MapLibre cancels tiles that leave the viewport while zooming
  // / panning) is passed through so stale paints are dropped instead of
  // queueing up behind the visible tiles.
  const workerHandler = async (params, abortController) => {
    const t = parseSeaTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult();
    return tilePipeline.paintSeaTile(t.z, t.x, t.y, t.color, abortController?.signal);
  };

  try {
    addProtocol('sea', tilePipeline.isWorkerMode() ? workerHandler : mainThreadHandler);
  } catch (err) {
    console.warn('Could not register sea:// protocol:', err?.message ?? err);
  }
};
