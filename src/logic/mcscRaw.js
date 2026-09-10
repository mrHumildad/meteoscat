/**
 * Raw MCSC band tiles.
 *
 * The MCSC land-cover raster is a palette map: every pixel holds an integer
 * band value (1..41) that the remote WMS normally turns into a colour
 * server-side. The stacked terrain overlay (terrainOverlay.js) paints those
 * colours itself, gated per pixel by every active filter — so it needs the
 * RAW band value per pixel instead of a colour.
 *
 * This module requests the same ICGC WMS with a value-encoding SLD (band v →
 * colour rgb(v,0,0), everything else transparent — see renderBandSld in
 * mcscLegend.js) and decodes the returned PNG in the browser, so the red
 * channel IS the band value (0 / transparent = no data). Verified against the
 * live service: bands decode exactly, no-data pixels stay transparent.
 *
 * Tiles are cached per (z,x,y) — the SLD is a constant, so a tile never
 * changes with the filter state.
 */

import { renderBandSld } from './mcscLegend.js';

const WMS_BASE =
  'https://geoserveis.icgc.cat/servei/catalunya/cobertes-sol/wms?' +
  'service=WMS&version=1.1.1&request=GetMap&layers=cobertes_2024&styles=&' +
  'format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256';

export const MCSC_ATTRIBUTION =
  'Mapa de Cobertes del Sòl de Catalunya (MCSC) v1.0 — ICGC & CREAF, ' +
  'layer cobertes_2024 — CC BY 4.0 — http://www.icgc.cat';

// Web-Mercator half-circumference (EPSG:3857), metres — world extent ±20037508.
const WORLD = 20037508.342789244;

/**
 * EPSG:3857 bounding box [west, south, east, north] (metres) of tile (z,x,y).
 * Pure, unit-testable.
 */
export const tileBbox3857 = (z, x, y) => {
  const n = 2 ** z;
  const size = (WORLD * 2) / n;
  return {
    west: x * size - WORLD,
    south: WORLD - (y + 1) * size,
    east: (x + 1) * size - WORLD,
    north: WORLD - y * size,
  };
};

// Value-encoding SLD is a constant — build the encoded URL once.
const BAND_SLD = encodeURIComponent(renderBandSld());

/** Full WMS GetMap URL returning the raw band value per pixel for tile (z,x,y). */
export const mcscBandTileUrl = (z, x, y) => {
  const { west, south, east, north } = tileBbox3857(z, x, y);
  return `${WMS_BASE}&bbox=${west},${south},${east},${north}&SLD_BODY=${BAND_SLD}`;
};

const makeCanvas = (w, h) =>
  typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });

// One quick retry: zoom bursts hit the WMS with many parallel GetMap calls,
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

const bandCache = new Map(); // `${z}/${x}/${y}` -> Promise<ImageData>

/** Fetch + decode a raw-band tile into ImageData (red channel = band value). */
export const loadMcscBandTile = async (z, x, y) => {
  const key = `${z}/${x}/${y}`;
  if (bandCache.has(key)) return bandCache.get(key);

  const promise = (async () => {
    const res = await fetchWithRetry(mcscBandTileUrl(z, x, y), key);
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    const canvas = makeCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height);
    bmp.close();
    return data;
  })().catch(err => {
    bandCache.delete(key); // don't cache failures
    throw err;
  });

  bandCache.set(key, promise);
  return promise;
};
