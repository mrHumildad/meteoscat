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

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Terrarium encoding: elevation (m) = (R * 256 + G + B / 256) - 32768
export const terrariumElevation = (r, g, b) => (r * 256 + g + b / 256) - 32768;

// Browser-side tile decoding -------------------------------------------------

const tileCache = new Map(); // `${z}/${x}/${y}` -> Promise<ImageData>

export const loadTileImageData = async (z, x, y) => {
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);

  const promise = (async () => {
    const url = ELEVATION_TILES
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${key}`);
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