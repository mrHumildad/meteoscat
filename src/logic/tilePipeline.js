/**
 * Main-thread facade over the painting pipeline: whenever a Web Worker with
 * OffscreenCanvas is available, per-pixel terrain/sea tiles are painted in
 * tileWorker.js and only the finished PNG buffers cross back to the main
 * thread. Otherwise (old Safari, worker-less embeds) tiles are painted
 * inline with the very same builders — behaviour is identical, only the
 * thread differs.
 *
 * The app pushes the shared painting context (aggregate table + station
 * features + substrate grid) via pushTerrainContext whenever it changes; the
 * per-request filter state always travels with the request itself.
 */

import { buildTerrainTile, buildSeaTile, transparentTilePng } from './tilePaint.js';

// Painting needs both Worker and OffscreenCanvas. Detection is lazy (module
// import must stay side-effect free so unit tests can import this in node).
const workerPossible = () =>
  typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';

let worker = null;
let broken = false;
let context = {}; // latest { agg, features, lithoGrid } — used by the inline fallback

const pending = new Map(); // id -> { resolve, reject }
let nextId = 1;

const onWorkerMessage = e => {
  const m = e.data;
  const p = pending.get(m?.id);
  if (!p) return;
  pending.delete(m.id);
  if (m.ok) p.resolve({ data: m.buf });
  else p.reject(new Error(m.error || 'tile worker error'));
};

const onWorkerError = ev => {
  // Any unexpected worker death switches the pipeline to inline painting:
  // reject what is in flight (MapLibre will warn) and serve later tiles from
  // the main thread so the map keeps working.
  broken = true;
  const err = new Error('tile worker failed: ' + (ev?.message || 'unknown'));
  for (const p of pending.values()) p.reject(err);
  pending.clear();
  console.warn('Tile painting worker failed — falling back to main thread.', ev?.message ?? ev);
};

/** Spin up the worker once (if supported). Safe to call repeatedly. */
export const ensureWorker = () => {
  if (!workerPossible() || worker || broken) return;
  try {
    worker = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = onWorkerMessage;
    worker.onerror = onWorkerError;
    // Replay the latest context: the app may have pushed it (lithology grid,
    // aggregate table, features) BEFORE the worker existed — e.g. data that
    // finished loading while the map was still starting — and the worker
    // would otherwise paint substrate / filtered tiles without it.
    worker.postMessage({ type: 'ctx', context });
  } catch (err) {
    console.warn('Could not start tile painting worker — painting on the main thread.', err?.message ?? err);
    worker = null;
    broken = true;
  }
};

/** True once a healthy worker is running (call ensureWorker first). */
export const isWorkerMode = () => workerPossible() && !!worker && !broken;

/** Keep the worker's painting context in sync (agg, features, lithoGrid). */
export const pushTerrainContext = next => {
  context = next ?? context;
  if (worker && !broken) {
    worker.postMessage({ type: 'ctx', context });
  }
};

const requestInWorker = (kind, payload, signal) => {
  if (signal?.aborted) return transparentResult(); // tile already left the viewport
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (signal) {
      // Zooming / panning: MapLibre aborts tile loads that leave the
      // viewport. Drop the queued worker job (see the worker's 'abort'
      // message) so a zoom burst can't bury the tiles that ARE visible
      // behind a backlog of stale intermediate-zoom paints.
      signal.addEventListener('abort', () => {
        if (!pending.has(id)) return;
        pending.delete(id);
        worker.postMessage({ type: 'abort', id });
        resolve(transparentResult()); // nobody waits, but settle cleanly
      }, { once: true });
    }
    worker.postMessage({ type: 'tile', id, kind, payload });
  });
};

/** Resolve with a valid fully-transparent tile (never rejects in practice). */
export const transparentResult = () => transparentTilePng().then(buf => ({ data: buf }));

/**
 * The failure fallback. Same transparent tile as transparentResult, but with
 * a short lifetime (max-age=10): MapLibre treats the tile as expired shortly
 * after and re-requests it on the next visit, so a TRANSIENT failure (one
 * flaky DEM / WMS response during a zoom burst) self-heals instead of
 * leaving a permanently blank tile.
 */
const fallbackTransparent = async () => ({
  data: await transparentTilePng(),
  cacheControl: 'max-age=10',
});

/**
 * Paint one terrain tile (canonical `state`); resolves to `{ data }`. NEVER
 * rejects: a paint failure (MCSC / DEM fetch error, worker crash) resolves
 * to a self-healing transparent tile instead, so MapLibre's raster source
 * never holds an errored tile — errored tiles crash the renderer when a
 * later setTiles() reloads them (maplibre-gl-js #7775, fixed upstream in
 * v6.1.0). `signal` (the protocol abort controller's signal) lets a zoom /
 * pan drop stale tile paints before they waste the worker.
 */
export const paintTerrainTile = (z, x, y, state, signal) => {
  const paint = isWorkerMode()
    ? requestInWorker('terrain', { z, x, y, state }, signal)
    : (signal?.aborted
        ? transparentResult()
        : buildTerrainTile(z, x, y, state, () => context).then(buf => ({ data: buf })));
  return paint.catch(err => {
    console.warn('Terrain tile paint failed — serving a transparent tile:', err?.message ?? err);
    return fallbackTransparent();
  });
};

/**
 * Paint one sea tile (`color` hex string or null = off); resolves `{ data }`.
 * Never rejects — see paintTerrainTile.
 */
export const paintSeaTile = (z, x, y, color, signal) => {
  const paint = isWorkerMode()
    ? requestInWorker('sea', { z, x, y, color }, signal)
    : (signal?.aborted
        ? transparentResult()
        : buildSeaTile(z, x, y, color).then(buf => ({ data: buf })));
  return paint.catch(err => {
    console.warn('Sea tile paint failed — serving a transparent tile:', err?.message ?? err);
    return fallbackTransparent();
  });
};
