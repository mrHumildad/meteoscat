/**
 * Isohypses overlay (`isohypses://` protocol) — elevation contour lines.
 *
 * The rendering mode 'relief' (the bottom-left sel button cycle:
 * terrain → substrate → relief) paints no palette, so the shape of the
 * ground would otherwise come only from the hillshade. This overlay adds the
 * classic topographic read: the DEM's elevation contours, drawn as thin light
 * lines over the relief, with every 5th ("master") contour brighter and
 * thicker and carrying its elevation as a label. Contours stop at sea level,
 * so nothing is drawn over the open sea, and they only appear at CLOSE zoom
 * (CONTOUR_MIN_ZOOM — the general view stays clean): the layer's style
 * `minzoom` hides it, and a hidden layer's source loads no tiles at all.
 *
 * Unlike the terrain / sea overlays this one carries NO state in its URL: the
 * contour interval is a pure function of the zoom (contourIntervalForZoom in
 * tilePaint.js), so the tiles are immutable per (z,x,y) and the app never has
 * to regenerate them — it only toggles the layer's visibility with the
 * rendering mode (only mode 'relief' shows isohypses).
 *
 * The actual per-tile painting lives in tilePaint.js (buildIsohypseTile,
 * shared with the Web Worker that does it off the main thread — see
 * tilePipeline.js); this module owns the protocol registration.
 *
 * As with the other client-painted rasters, the handlers NEVER reject: a
 * paint failure (DEM host hiccup, worker crash) comes back as a valid
 * transparent tile, so this raster source can never hold an errored tile —
 * MapLibre < 6.1 crashes its renderer when setTiles() reloads an errored
 * tile (maplibre-gl-js #7775).
 */

import { addProtocol } from 'maplibre-gl';
import { parseIsohypseTileUrl } from './tilePaint.js';
import * as tilePipeline from './tilePipeline.js';

// Pure painters + helpers live in tilePaint.js; re-exported here so callers
// (and tests) that think in overlays don't need to reach into tilePaint.
export {
  CONTOUR_INDEX_EVERY,
  CONTOUR_MIN_ZOOM,
  CONTOUR_COLOR,
  CONTOUR_MINOR_ALPHA,
  CONTOUR_INDEX_ALPHA,
  CONTOUR_MINOR_WIDTH,
  CONTOUR_INDEX_WIDTH,
  CONTOUR_LABEL_MIN_SPACING,
  CONTOUR_LABEL_EDGE_MARGIN,
  CONTOUR_LABEL_FONT_SIZE,
  contourIntervalForZoom,
  contourCellSegments,
  selectContourLabels,
  parseIsohypseTileUrl,
  buildIsohypseTile,
} from './tilePaint.js';

/** Tile URL template of the isohypses source (stateless — see above). */
export const isohypsesTileUrl = () => 'isohypses://{z}/{x}/{y}';

/**
 * Register the `isohypses://{z}/{x}/{y}` protocol (global in MapLibre v5+).
 * Re-registering (e.g. on map remount) just overwrites the global handler.
 * When a painting worker is available the per-tile work runs off the main
 * thread; otherwise tiles are painted inline with the same builder. Both
 * handlers never reject — see the module header.
 */
export const registerIsohypseProtocol = () => {
  tilePipeline.ensureWorker();

  // Main-thread fallback handler — caches the painted tile per (z,x,y).
  const mainThreadHandler = async (params, abortController) => {
    const t = parseIsohypseTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult(); // never reject — see above
    const key = `${t.z}/${t.x}/${t.y}`;
    if (cache.has(key)) return cache.get(key);

    const promise = tilePipeline.paintIsohypseTile(t.z, t.x, t.y, abortController?.signal);
    cache.set(key, promise);
    if (cache.size > 300) cache.delete(cache.keys().next().value); // bound memory
    return promise;
  };
  const cache = new Map(); // `z/x/y` -> Promise<{ data }>

  // Worker handler: parse on the main thread, paint in the worker.
  const workerHandler = async (params, abortController) => {
    const t = parseIsohypseTileUrl(params.url);
    if (!t) return tilePipeline.transparentResult();
    return tilePipeline.paintIsohypseTile(t.z, t.x, t.y, abortController?.signal);
  };

  try {
    addProtocol('isohypses', tilePipeline.isWorkerMode() ? workerHandler : mainThreadHandler);
  } catch (err) {
    console.warn('Could not register isohypses:// protocol:', err?.message ?? err);
  }
};
