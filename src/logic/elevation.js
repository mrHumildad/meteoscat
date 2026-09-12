/**
 * Point elevation sampling from a terrarium-encoded raster-dem tile source
 * (Mapzen "Terrain Tiles" on AWS Open Data — free, no API key, CORS enabled,
 * z0–15; see https://registry.opendata.aws/terrain-tiles/).
 *
 * Independent from the map: tiles are plain PNGs fetched over CORS and decoded
 * into an offscreen canvas, so a value is available even before the relief /
 * 3D toggles are on. Elevation is bilinearly interpolated between the four
 * surrounding pixels and returned in metres.
 */

export const ELEVATION_TILES =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const ELEVATION_ATTRIBUTION =
  'Terrain: Mapzen Terrain Tiles (AWS Open Data) — SRTM & GMTED2010 courtesy ' +
  'of the U.S. Geological Survey; Europe: Copernicus EU-DEM, funded by the ' +
  'European Union — https://registry.opendata.aws/terrain-tiles/';

// Web Mercator: lng/lat → fractional tile coordinates + pixel offset inside
// the 256 px tile at zoom z (pure, unit-testable).
export const lngLatToTileXY = (lng, lat, z) => {
  const n = 2 ** z;
  const latRad = (lat * Math.PI) / 180;
  const worldX = ((lng + 180) / 360) * n;
  const worldY =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  const x = Math.floor(worldX);
  const y = Math.floor(worldY);
  return { z, x, y, px: (worldX - x) * 256, py: (worldY - y) * 256 };
};

// Web Mercator inverse: pixel coordinates inside tile (z, x, y) → lng/lat
// (inverse of lngLatToTileXY; the meteo overlay uses it to sample its
// interpolated grid at every tile pixel). Pure, unit-testable.
export const tileXYToLngLat = (z, x, y, px = 0, py = 0) => {
  const n = 2 ** z;
  const worldX = (x + px / 256) / n;
  const worldY = (y + py / 256) / n;
  const lng = worldX * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * worldY)));
  const lat = (latRad * 180) / Math.PI;
  return { lng, lat };
};

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Terrarium encoding: elevation (m) = (R * 256 + G + B / 256) - 32768
export const terrariumElevation = (r, g, b) => (r * 256 + g + b / 256) - 32768;

// ── Slope aspect (orientation filter) — pure, unit-testable ───────────────
// The Orientació filter (ORIENTATION_FILTER_PLAN.md) gates the painted
// terrain by the DEM slope ASPECT — the compass direction a slope faces — so
// "només cara nord" (*obaga*) becomes a first-class filter. Everything here
// is pure maths over elevations in metres; tilePaint.js feeds it the decoded
// terrarium values of the DEM's 3×3 neighbourhood.

// 8 sectors of 45°, centred on the cardinals: N = [337.5°, 22.5°), then every
// 45° clockwise. Only `aspectSectorOf` classifies a bearing.
export const ASPECT_SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

// Below this slope a pixel counts as FLAT and gets no sector — aspect on flat
// ground is DEM noise. The filter is exclusion-based, so flat pixels are
// excluded while it is active: plains and valley floors are deliberately not
// "cara nord".
export const ASPECT_MIN_SLOPE_DEG = 5;

// Ground resolution of a Web Mercator DEM pixel at latitude `lat` (m/px).
// Turns the per-pixel gradient into a real slope in degrees, so the flat
// threshold above is a physical angle rather than pixels of rise.
export const metresPerPixel = (z, lat) =>
  (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/**
 * Horn (1981) 3×3 finite difference over nine elevations in the layout
 *
 *     NW  N  NE
 *     W   C  E
 *     SW  S  SE
 *
 * (`cells` order matters; the centre is unused). Returns the gradient in
 * metres per metre — `dzdx` positive to the EAST, `dzdy` positive to the
 * SOUTH (rows grow downward, matching the pixel buffer) — or null when any
 * cell is not finite (DEM no-data / a missing neighbour tile) or the cell
 * size is not positive. Pure, unit-testable.
 */
export const hornGradientFromElevations = (cells, cellSizeM = 1) => {
  if (!cells || cells.length !== 9 || !(cellSizeM > 0)) return null;
  // The centre (index 4) is not part of Horn's differences, so only the eight
  // neighbours must be finite — a missing neighbour tile leaves NaN there and
  // invalidates the window.
  for (let k = 0; k < 9; k++) if (k !== 4 && !Number.isFinite(cells[k])) return null;
  const nw = cells[0], n = cells[1], ne = cells[2];
  const w = cells[3], e = cells[5];
  const sw = cells[6], s = cells[7], se = cells[8];
  const eight = 8 * cellSizeM;
  return {
    dzdx: ((ne + 2 * e + se) - (nw + 2 * w + sw)) / eight,
    dzdy: ((sw + 2 * s + se) - (nw + 2 * n + ne)) / eight,
  };
};

/**
 * Slope (degrees) and aspect (compass bearing of the DOWNSLOPE direction,
 * degrees clockwise from north, 0/360 = N) of a 3×3 elevation window, or null
 * when the window is unusable (see hornGradientFromElevations).
 *
 * Downslope is the negated gradient; with east/north components
 * `(dzdx, −dzdy)` the bearing is `atan2(−dzdx, dzdy)`. That is the sign
 * convention the tests pin: a plane whose elevation RISES toward the south
 * (`dzdy > 0`, `dzdx = 0`) is a NORTH-facing slope (aspect ≈ 0°).
 */
export const slopeAspectFromElevations = (cells, cellSizeM = 1) => {
  const g = hornGradientFromElevations(cells, cellSizeM);
  if (!g) return null;
  const slopeDeg = (Math.atan(Math.hypot(g.dzdx, g.dzdy)) * 180) / Math.PI;
  let aspectDeg = (Math.atan2(-g.dzdx, g.dzdy) * 180) / Math.PI;
  if (aspectDeg < 0) aspectDeg += 360;
  return { slopeDeg, aspectDeg };
};

/** Sector key of an aspect bearing (N = [337.5, 22.5), then every 45°), or
 * null for a non-finite bearing. Pure, unit-testable. */
export const aspectSectorOf = aspectDeg => {
  if (!Number.isFinite(aspectDeg)) return null;
  let d = aspectDeg % 360;
  if (d < 0) d += 360;
  return ASPECT_SECTORS[Math.round(d / 45) % 8];
};

/**
 * Sector of a 3×3 elevation window, or null when the window is unusable OR
 * its slope is below `minSlopeDeg` (flat land gets no sector). This is what
 * the tile painter calls per pixel. Pure, unit-testable.
 */
export const aspectSectorFromElevations = (
  cells,
  cellSizeM = 1,
  minSlopeDeg = ASPECT_MIN_SLOPE_DEG
) => {
  const sa = slopeAspectFromElevations(cells, cellSizeM);
  if (!sa || sa.slopeDeg < minSlopeDeg) return null;
  return aspectSectorOf(sa.aspectDeg);
};

// 3×3 byte offsets inside a 256 px-wide RGBA DEM tile (x ± 1 → ± 4 bytes,
// y ± 1 → ± 1024 bytes), in the same order as hornGradientFromElevations.
const TILE_W = 256;
const NEIGHBOUR_BYTE_OFFSETS = [
  -TILE_W * 4 - 4, -TILE_W * 4, -TILE_W * 4 + 4,
  -4, 0, 4,
  TILE_W * 4 - 4, TILE_W * 4, TILE_W * 4 + 4,
];

// Terrarium elevation (m) of the RGBA pixel at byte offset `i`.
export const elevationAtOffset = (data, i) =>
  terrariumElevation(data[i], data[i + 1], data[i + 2]);

// True when byte offset `i` is on the tile's outer ring: the 3×3 window needs
// the neighbouring tile there, which these offset-only helpers cannot reach
// (tilePaint.js resolves the ring across the 8 adjacent DEM tiles itself).
const onTileRing = i => {
  const px = (i >> 2) & 255;
  const py = i >> 10;
  return px === 0 || px === 255 || py === 0 || py === 255;
};

/**
 * Nine elevations (m) around byte offset `i` of a 256 px-wide RGBA DEM tile,
 * or null on the outer ring. Convenience for callers/tests holding a single
 * tile; the tile painter builds a padded grid so the ring is covered too.
 */
export const neighboursAt = (data, i) => {
  if (onTileRing(i)) return null;
  const cells = new Array(9);
  for (let k = 0; k < 9; k++) cells[k] = elevationAtOffset(data, i + NEIGHBOUR_BYTE_OFFSETS[k]);
  return cells;
};

/** Horn gradient at byte offset `i` of a 256 px-wide RGBA DEM tile; null on
 * the outer ring (see neighboursAt). Pure, unit-testable. */
export const terrainGradient = (data, i) => {
  const cells = neighboursAt(data, i);
  return cells ? hornGradientFromElevations(cells, 1) : null;
};

/** Slope + aspect at byte offset `i` of a 256 px-wide RGBA DEM tile, or null
 * on the outer ring. `cellSizeM` turns the per-pixel gradient into real
 * degrees (default 1 → the raw metres-per-pixel gradient). Pure. */
export const slopeAspectAt = (data, i, cellSizeM = 1) => {
  const cells = neighboursAt(data, i);
  return cells ? slopeAspectFromElevations(cells, cellSizeM) : null;
};

// Browser-side tile decoding -------------------------------------------------

const tileCache = new Map(); // `${z}/${x}/${y}` -> Promise<ImageData>

// One quick retry: zoom bursts hit the DEM host with many parallel fetches,
// and a single flaky response must not become a permanently blank tile.
const fetchWithRetry = async (url, label) => {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 250));
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${label}`);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
};

export const loadTileImageData = async (z, x, y) => {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const promise = (async () => {
    const url = ELEVATION_TILES
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const res = await fetchWithRetry(url, key);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(bmp.width, bmp.height)
      : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return data;
  })().catch(err => {
    tileCache.delete(key); // don't cache failures
    throw err;
  });

  tileCache.set(key, promise);
  return promise;
};

/**
 * Sample elevation (m) at a lng/lat point. Bilinear interpolation between the
 * four surrounding DEM pixels. z13 ≈ 15 m/px at Catalonia's latitude — just
 * above the 30 m native DEM resolution. Resolves to null when sampling fails.
 */
export const sampleElevation = async (lng, lat, z = 13) => {
  try {
    const { x, y, px, py } = lngLatToTileXY(lng, lat, z);
    const data = await loadTileImageData(z, x, y);
    const w = data.width;
    const h = data.height;
    const x0 = clamp(Math.floor(px), 0, w - 1);
    const y0 = clamp(Math.floor(py), 0, h - 1);
    const x1 = Math.min(x0 + 1, w - 1);
    const y1 = Math.min(y0 + 1, h - 1);
    const fx = px - x0; // 0..1 offsets inside the pixel
    const fy = py - y0;
    const at = (ix, iy) => {
      const o = (iy * w + ix) * 4;
      return terrariumElevation(data.data[o], data.data[o + 1], data.data[o + 2]);
    };
    const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
    const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
    return Math.round(top + (bottom - top) * fy);
  } catch (err) {
    console.warn('Could not sample terrain elevation:', err?.message ?? err);
    return null;
  }
};