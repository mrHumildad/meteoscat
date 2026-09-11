// What the analysed DISC is made of — land cover (the "forest" graph) and
// substrate (the "geo" graph) of the directions modal.
//
// Two very different data sources, one output shape (`[{ key, label, color,
// count }]`, folded by buildComposition into shares):
//
//   • land cover — the MCSC palette raster, the same raw-band tiles the map
//     overlay paints (mcscRaw.js): one WMS tile per tile the disc touches, its
//     red channel holding the class band value. Pixels are counted on the
//     disc, never the bounding box, and every band is labelled with its legend
//     entry (mcscLegend.js) so the graph can never drift from the map.
//   • substrate — the lithology grid the geology filter already loads
//     (lithology.js): sampled at the SAME disc grid as the altitude profile
//     (areaElevation.js), so the three graphs describe identical patches.
//
// Only the MCSC fetch is browser-bound; the tile range, the substrate counts
// and the composition folding are pure and unit-tested.

import { lngLatToTileXY, tileXYToLngLat } from './elevation.js';
import { loadMcscBandTile } from './mcscRaw.js';
import { entryForBand, MCSC_GREY } from './mcscLegend.js';
import { lithoFamilyAt } from './lithology.js';
import { areaSamplePoints } from './areaElevation.js';

// z13 ≈ 14 m/px at Catalonia's latitude — the zoom the DEM/profile uses, so a
// 2.5 km disc covers the same detail in every graph. A tile is ~3.6 km wide
// there, so even the widest disc only touches a few tiles (all cached).
export const AREA_MCSC_ZOOM = 13;

// Count every 2nd pixel of a tile: composition shares don't need every pixel,
// and this quarters the loop (still ~900 samples inside the 500 m disc).
export const AREA_PIXEL_STRIDE = 2;

// Bars shown before the tail is folded into a single "Altres" bar.
export const AREA_COMPOSITION_TOP = 5;

const M_PER_DEG_LAT = 111320;
const cosLatOf = lat => Math.cos((lat * Math.PI) / 180);

/**
 * Tile range (inclusive) covering the disc's bounding box at zoom `z`, clamped
 * to the world. Pure, unit-testable — the mesh of tiles the land-cover count
 * has to fetch.
 */
export const areaTileRange = (lat, lng, radiusM, z = AREA_MCSC_ZOOM) => {
  const dLat = radiusM / M_PER_DEG_LAT;
  const dLng = radiusM / (M_PER_DEG_LAT * Math.max(0.01, cosLatOf(lat)));
  const nw = lngLatToTileXY(lng - dLng, lat + dLat, z);
  const se = lngLatToTileXY(lng + dLng, lat - dLat, z);
  const last = 2 ** z - 1;
  const clamp = v => Math.min(last, Math.max(0, v));
  return {
    z,
    x0: clamp(Math.min(nw.x, se.x)),
    x1: clamp(Math.max(nw.x, se.x)),
    y0: clamp(Math.min(nw.y, se.y)),
    y1: clamp(Math.max(nw.y, se.y)),
  };
};

/**
 * Share of every MCSC legend entry inside the disc: `[{ key, label, color,
 * count }]`, unordered (buildComposition sorts / folds it). Tiles are fetched
 * in parallel and failures are skipped, so a partial answer is still a useful
 * graph. Reads `count` pixels of the disc; pixels with no data (0) and the
 * unlisted 230–234 bands are ignored rather than guessed.
 *
 * `loadTile` is the tile loader seam (mcscRaw's cached one by default) so the
 * pixel loop can be unit-tested with synthetic tiles.
 */
export const countLandCover = async (
  lat,
  lng,
  radiusM,
  { z = AREA_MCSC_ZOOM, stride = AREA_PIXEL_STRIDE, loadTile = loadMcscBandTile } = {},
) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radiusM > 0)) return [];
  const step = Math.max(1, Math.floor(stride));
  const { x0, x1, y0, y1 } = areaTileRange(lat, lng, radiusM, z);

  const wanted = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) wanted.push({ x, y });
  }
  const tiles = await Promise.all(wanted.map(t =>
    loadTile(z, t.x, t.y).then(data => ({ ...t, data })).catch(() => null),
  ));

  const cosLat = cosLatOf(lat);
  const r2 = radiusM * radiusM;
  const counts = new Map(); // legend entry code -> { key, label, color, count }

  for (const tile of tiles) {
    if (!tile) continue;
    const { data, width, height } = tile.data;
    // lng depends only on the column and lat only on the row (Mercator), so
    // both are precomputed once per tile instead of per pixel.
    const lngs = new Float64Array(width);
    const lats = new Float64Array(height);
    for (let p = 0; p < width; p++) lngs[p] = tileXYToLngLat(z, tile.x, tile.y, p, 0).lng;
    for (let p = 0; p < height; p++) lats[p] = tileXYToLngLat(z, tile.x, tile.y, 0, p).lat;

    for (let py = 0; py < height; py += step) {
      const dy = (lats[py] - lat) * M_PER_DEG_LAT;
      for (let px = 0; px < width; px += step) {
        const dx = (lngs[px] - lng) * M_PER_DEG_LAT * cosLat;
        if (dx * dx + dy * dy > r2) continue; // bounding box ≠ disc
        const band = data[(py * width + px) * 4];
        if (!band) continue; // no MCSC data there
        const entry = entryForBand(band);
        if (!entry) continue; // unlisted band (230–234) — not a land-cover class
        const hit = counts.get(entry.codes);
        if (hit) hit.count++;
        else counts.set(entry.codes, { key: entry.codes, label: entry.label, color: entry.color, count: 1 });
      }
    }
  }

  return [...counts.values()];
};

/**
 * Substrate families inside the disc, counted on the SAME sample grid as the
 * altitude profile. Family 0 (no substrate info: sea, outside the geological
 * map) is skipped rather than reported as a family. Pure, unit-testable.
 */
export const countSubstrates = (grid, lat, lng, radiusM) => {
  const points = areaSamplePoints(lat, lng, radiusM);
  if (!grid || !points.length) return [];
  const counts = new Map(); // family id -> count
  for (const p of points) {
    const id = lithoFamilyAt(grid, p.lng, p.lat);
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const entries = [];
  for (const [id, count] of counts) {
    const family = grid.entries.find(e => e.id === id);
    if (family) entries.push({ key: family.key, label: family.label, color: family.color, count });
  }
  return entries;
};

/**
 * Fold counted entries into the bars of a composition graph: biggest first,
 * with the tail beyond `max` merged into one "Altres" bar. `share` is the
 * fraction of the classified area each bar covers. Returns null when there is
 * nothing classified, so the caller can show "no data" instead of an empty
 * chart. Pure, unit-testable.
 */
export const buildComposition = (
  entries,
  { max = AREA_COMPOSITION_TOP, otherLabel = 'Altres', otherColor = MCSC_GREY } = {},
) => {
  const counted = (entries ?? []).filter(e => e && e.count > 0).sort((a, b) => b.count - a.count);
  const total = counted.reduce((a, e) => a + e.count, 0);
  if (!total) return null;

  const keep = Math.max(1, Math.floor(max));
  const items = counted.slice(0, keep).map(e => ({ ...e, share: e.count / total }));
  const tail = counted.slice(keep);
  if (tail.length) {
    const count = tail.reduce((a, e) => a + e.count, 0);
    items.push({
      key: '__other__',
      label: otherLabel,
      color: otherColor,
      count,
      share: count / total,
    });
  }
  return { items, total };
};
