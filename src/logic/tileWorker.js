/**
 * Painting Web Worker — the per-pixel terrain / sea tile builders run here so
 * old devices stop freezing on the main thread while tiles are painted.
 *
 * Protocol (all messages plain objects; replies transfer the ArrayBuffer):
 *   main → worker  { type: 'ctx',    context: { agg, features, lithoGrid } }
 *   main → worker  { type: 'tile',   id, kind: 'terrain'|'sea'|'isohypses',
 *                    payload: { z, x, y, state } | { z, x, y, color } |
 *                             { z, x, y } }
 *   main → worker  { type: 'abort',  id }  // drop if still queued (zoom burst)
 *   worker → main  { type: 'tile', id, ok: true,  buf: ArrayBuffer }
 *   worker → main  { type: 'tile', id, ok: false, error: string }
 *
 * The context is pushed by the app whenever the aggregate table, the station
 * features or the substrate grid change (tilePipeline.pushContext) — it is
 * read fresh per build via the getContext() closure the painters expect. The
 * filter state needs no push: it is part of every request (the canonical
 * state for terrain tiles, the colour in the URL for sea tiles).
 *
 * Painted tiles are cached per key (z/x/y + state signature / colour) with
 * the same ~300-entry bound the old main-thread handlers used, and duplicate
 * in-flight requests share the same promise. Requests are processed with a
 * small concurrency cap so a zoom burst can't melt down the WMS / DEM hosts.
 */

import { buildTerrainTile, buildSeaTile, buildIsohypseTile } from './tilePaint.js';

let context = {}; // latest { agg, features, lithoGrid }

const cache = new Map(); // key -> Promise<ArrayBuffer>
const CACHE_MAX = 300;

const queue = [];
const MAX_ACTIVE = 6; // ≈ the browser's per-host connection budget
let active = 0;

const cached = (key, build) => {
  let p = cache.get(key);
  if (!p) {
    p = build().catch(err => {
      cache.delete(key); // don't cache failures
      throw err;
    });
    cache.set(key, p);
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value); // evict oldest
    }
  }
  return p;
};

const terrainTile = ({ z, x, y, state }) => {
  const key = `terrain|${z}/${x}/${y}|${JSON.stringify(state ?? {})}`;
  return cached(key, () => buildTerrainTile(z, x, y, state, () => context));
};

const seaTile = ({ z, x, y, color }) => {
  const key = `sea|${z}/${x}/${y}|${color ?? 'off'}`;
  return cached(key, () => buildSeaTile(z, x, y, color));
};

// Isohypse tiles are stateless per (z,x,y): the contour interval follows the
// zoom, so there is nothing else in the key.
const isohypseTile = ({ z, x, y }) =>
  cached(`isohypses|${z}/${x}/${y}`, () => buildIsohypseTile(z, x, y));

const run = async job => {
  try {
    const raw = job.kind === 'sea'
      ? await seaTile(job.payload)
      : job.kind === 'isohypses'
        ? await isohypseTile(job.payload)
        : await terrainTile(job.payload);
    // ArrayBuffers are transferable and become detached after postMessage.
    // The cache holds the original buffer; every reply must get a COPY so
    // cache hits (e.g. toggling 'relief' → 'terrain' where the state repeats
    // after 3 clicks, i.e. 6 clicks = 2 full cycles, and parallel duplicate
    // requests for the same tile) do not hit "ArrayBuffer already detached".
    const buf = raw.slice(0);
    self.postMessage({ type: 'tile', id: job.id, ok: true, buf }, [buf]);
  } catch (err) {
    self.postMessage({ type: 'tile', id: job.id, ok: false, error: String(err?.message ?? err) });
  }
};

const pump = () => {
  while (active < MAX_ACTIVE && queue.length) {
    const job = queue.shift();
    active++;
    run(job).finally(() => { active--; pump(); });
  }
};

self.onmessage = e => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'ctx') {
    context = m.context || {};
    return;
  }
  if (m.type === 'tile') {
    // Strict FIFO for the tiles that are actually wanted: every request that
    // reaches the queue gets answered (MapLibre holds a promise per request).
    // The main thread aborts stale jobs (zoom / pan bursts) BEFORE they are
    // posted — see tilePipeline's 'abort' below — so the queue stays short.
    queue.push(m);
    pump();
  }
  if (m.type === 'abort') {
    // A queued (not yet started) tile is no longer wanted — the map moved
    // on. Drop it so a zoom burst can't starve the visible tiles behind a
    // backlog of stale intermediate-zoom paints. Already-running jobs finish
    // (their reply is ignored by the main thread, which removed the request).
    const idx = queue.findIndex(j => j.id === m.id);
    if (idx >= 0) queue.splice(idx, 1);
  }
};
