/**
 * Substrate (lithology-family) grid — the data behind the geology filter.
 *
 * The grid file (public/logic/litho_grid.json, built by
 * meteokat/build_lithology.py from the ICGC "Mapa geològic de Catalunya
 * 1:50.000 v3.0" GeoPackage) is a uniform lon/lat raster where every cell
 * holds ONE substrate-family id:
 *
 *     0 = nodata (no substrate info: sea, reservoirs, areas outside the
 *         geological map, or unclassified fault lines) — never filtered
 *     1..N = the lithology families, with their Catalan label + colour
 *            embedded in the file so the UI legend can never drift from the
 *            data it filters.
 *
 * Rows are run-length encoded ([value, runLength] pairs, north → south) to
 * keep the file small; this module decodes them into a flat Uint8Array and
 * exposes O(1) sampling by (lng, lat). Decoding is pure and unit-tested; the
 * loader is a thin fetch wrapper.
 *
 * Filter semantics (shared with the terrain overlay and the station filter):
 * a family is "off" when the user dims it; a pixel/station whose family is
 * off is transparent/excluded. Family 0 (nodata) is NEVER gated — missing
 * substrate info is not a reason to hide anything.
 */

// Attribution required under CC BY 4.0 (the grid embeds ICGC geological data).
export const LITHO_ATTRIBUTION =
  'Mapa geològic de Catalunya 1:50.000 v3.0 — ICGC — CC BY 4.0 — http://www.icgc.cat';

// nodata cell value (kept in sync with build_lithology.py).
export const LITHO_NODATA = 0;

/**
 * Decode a grid JSON payload into a sampleable structure.
 *
 * @param {object} json  `{ cols, rows, west, north, step, families, rle, meta }`
 *                       exactly as written by meteokat/build_lithology.py.
 * @returns {object} `{ cols, rows, west, north, step, cells, entries, keyById }`
 *   - `cells`: Uint8Array row-major (row 0 = north), one family id per cell.
 *   - `entries`: legend rows `[{ id, key, label, color }]` sorted by id,
 *     INCLUDING id 0 — callers that want selectable families filter id > 0.
 *   - `keyById`: `keyById[familyId]` → family key (for the id-0 case too).
 */
export const decodeLithoGrid = json => {
  if (!json || !Number.isFinite(json.cols) || !Number.isFinite(json.rows) ||
      !Number.isFinite(json.west) || !Number.isFinite(json.north) ||
      !Number.isFinite(json.step) || !Array.isArray(json.rle)) {
    throw new TypeError('Malformed lithology grid payload');
  }
  const { cols, rows, west, north, step } = json;

  const families = Object.entries(json.families ?? {})
    .map(([id, e]) => ({
      id: Number(id),
      key: e?.key ?? '',
      label: e?.label ?? '',
      color: e?.color ?? null,
    }))
    .sort((a, b) => a.id - b.id);
  if (!families.length) throw new TypeError('Lithology grid has no families');

  const keyById = [];
  for (const e of families) keyById[e.id] = e.key;

  const cells = new Uint8Array(cols * rows);
  const rle = json.rle;
  if (rle.length !== rows) {
    throw new TypeError(`Lithology grid row count mismatch: ${rle.length} != ${rows}`);
  }
  let o = 0;
  for (let r = 0; r < rows; r++) {
    const row = rle[r];
    if (!Array.isArray(row)) throw new TypeError('Lithology grid RLE row is not an array');
    for (const [v, n] of row) {
      if (!Number.isFinite(n) || o + n > cells.length) {
        throw new TypeError('Lithology grid RLE overruns the cell array');
      }
      cells.fill(v & 0xff, o, o + n);
      o += n;
    }
    if (o !== (r + 1) * cols) {
      throw new TypeError(`Lithology grid row ${r} does not sum to ${cols} cells`);
    }
  }
  return { cols, rows, west, north, step, cells, entries: families, keyById };
};

/**
 * Family id at (lng, lat), 0 when outside the grid or without data. O(1).
 * Pure, unit-testable.
 */
export const lithoFamilyAt = (grid, lng, lat) => {
  if (!grid) return LITHO_NODATA;
  const c = Math.floor((lng - grid.west) / grid.step);
  const r = Math.floor((grid.north - lat) / grid.step);
  if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) return LITHO_NODATA;
  return grid.cells[r * grid.cols + c];
};

/**
 * Family KEY at (lng, lat) — null outside / nodata / unknown grid. Keys are
 * the stable identifiers the filter state stores (Set of keys).
 */
export const lithoFamilyKeyAt = (grid, lng, lat) => {
  const id = lithoFamilyAt(grid, lng, lat);
  if (!grid || id === LITHO_NODATA) return null;
  return grid.keyById[id] ?? null;
};

/** Selectable legend rows (family id > 0, sorted by id) for the filter UI. */
export const lithoLegendEntries = grid => (grid?.entries ?? []).filter(e => e.id > 0);

/** Fetch + decode the grid JSON from the app's base path. */
export const loadLithoGrid = async (path) => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct.includes('application/json') && !ct.includes('text/json') && !ct.includes('application/geo')) {
    throw new Error(`Unexpected content-type: ${ct}`);
  }
  return decodeLithoGrid(await res.json());
};
