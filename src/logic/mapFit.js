// Pure bounds / camera-fitting helpers for the Catalonia-only map.
//
// Why a per-screen minimum zoom (B): the app is only about Catalonia, but a
// fixed floor (zoom 7) lets wide screens zoom out until half the western
// Mediterranean fills the viewport — fetching and painting DEM / MCSC tiles
// for a huge area that carries no data. Conversely the same fixed floor is
// TOO HIGH on narrow phones: the 5°-wide bounds (~455 px at z7) never fit a
// ~390 px viewport, so zooming out can't show all of Catalonia. Fitting the
// bounds to the ACTUAL viewport fixes both: max zoom-out always shows the
// region (with a small margin), nothing more.

// Catalonia bounding box used to constrain the camera ([[west, south],
// [east, north]] — the app is not meant to leave it).
export const CATALONIA_BOUNDS = [[-1.0, 40.0], [4.0, 44.0]];

// Raster-source clip box [west, south, east, north] for the custom terrain
// overlay. MCSC / lithology data only exists inside Catalonia, and painting
// tiles outside it is pure waste (the pixels are transparent there anyway),
// so MapLibre is told never to request them. A small pad keeps boundary
// tiles that INTERSECT the data area from being dropped.
export const TERRAIN_OVERLAY_BOUNDS = [-1.25, 39.75, 4.25, 44.25];

// Web-Mercator y (0..1) of a latitude — the vertical world fraction.
const mercatorY = lat => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

/**
 * Zoom at which the bounds [west..east] × [south..north] (degrees) fit inside
 * a `width`×`height` (px) viewport leaving `padding` px free on every side.
 * The more zoomed-out of the two axes wins, so the whole region always fits.
 * Pure and unit-tested (mapFit.test.js). Returns null for unusable sizes.
 *
 * @param {object} o `{ width, height, west, south, east, north, padding,
 *                    minZoom, maxZoom }` (bounds default to Catalonia).
 */
export const fitZoomForViewport = ({
  width, height,
  west = CATALONIA_BOUNDS[0][0], south = CATALONIA_BOUNDS[0][1],
  east = CATALONIA_BOUNDS[1][0], north = CATALONIA_BOUNDS[1][1],
  padding = 48, minZoom = 0, maxZoom = 22,
}) => {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;

  const availW = Math.max(1, w - 2 * padding);
  const availH = Math.max(1, h - 2 * padding);
  const lngSpan = Math.max(1e-6, east - west);
  // Horizontal: the bounds span `lngSpan/360` of a 256·2^z px world.
  const zoomW = Math.log2((availW / lngSpan) * (360 / 256));
  // Vertical: mercator y GROWS southward, so the bounds' height in world
  // fraction is y(south) − y(north); the tile-pyramid zoom is log2 of the
  // pixel height available divided by that fraction.
  const ySpan = Math.max(1e-6, mercatorY(south) - mercatorY(north));
  const zoomH = Math.log2(availH / ySpan / 256);
  const z = Math.min(zoomW, zoomH);
  if (!Number.isFinite(z)) return null;
  return Math.min(maxZoom, Math.max(minZoom, z));
};
