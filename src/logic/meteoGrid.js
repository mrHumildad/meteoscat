/**
 * Interpolated meteo field (rain / humidity / temperature) built from station
 * point values.
 *
 * The altitude filter works because every map pixel already has an elevation
 * from the DEM. Meteo variables have no raster: only ~190 station points. So
 * we interpolate the station values onto a coarse grid (inverse distance
 * weighting, IDW) once per data window, then the meteo:// tile protocol
 * samples that grid per pixel — turning the rain/humidity/temperature sliders
 * into *area* filters with exactly the same mask semantics as the altitude
 * band (in-band transparent, out-of-band grey).
 *
 * Grid resolution is GRID_STEP (≈ 1.1 km) over the app bounds — fine enough
 * for a smooth-looking mask, cheap enough to rebuild lazily per variable
 * (200k cells × ~190 stations ≈ a tenth of a second, never per pan/zoom).
 *
 * Temperature with `lapseRate` set: station values are first reduced to sea
 * level (temp + lapseRate·altitud/1000) so the IDW field varies smoothly,
 * then the overlay re-applies the cell elevation per pixel (subtracting
 * lapseRate·elev/1000). The other variables interpolate raw values.
 */

// ≈ 1.1 km at Catalonia's latitude — grid cells per degree.
export const GRID_STEP = 0.01;
// Cells whose nearest station is farther than this are no-data (NaN) instead
// of extrapolated — avoids IDW blow-ups far from any station.
export const DEFAULT_MAX_DIST_KM = 50;
// Standard free-air lapse rate used to correct temperature by elevation.
export const LAPSE_RATE = 6.5; // °C per 1000 m

// Same bounding box as App.jsx (Catalonia).
export const GRID_BOUNDS = { west: -1, south: 40, east: 4, north: 44 };

const EARTH_RADIUS_KM = 6371;
const KM_PER_DEG = (EARTH_RADIUS_KM * Math.PI) / 180; // ≈ 111.19 km per degree

/** Equirectangular distance between two lng/lat points, in km. */
export const distKm = (lng1, lat1, lng2, lat2) => {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const latMid = (((lat1 + lat2) / 2) * Math.PI) / 180;
  return EARTH_RADIUS_KM * Math.hypot(dLng * Math.cos(latMid), dLat);
};

// Same "is it a usable number?" guard as filterStations.js: explicit nulls,
// undefined and empty strings are no-data, not zero.
const hasNumber = v =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Build the IDW grid for one variable from GeoJSON station features
 * (properties carry the computed averages: precAcc / humAvg / tempAvg, plus
 * the static altitud in metres).
 *
 * Returns `{ data: Float32Array (row-major, NaN = no data), width, height,
 * west, south, step, lapseRate }`.
 */
export const buildMeteoGrid = (features, variable, options = {}) => {
  const { lapseRate = 0, maxDistKm = DEFAULT_MAX_DIST_KM } = options;

  const stations = [];
  for (const f of features || []) {
    const p = f?.properties || {};
    if (!hasNumber(p[variable])) continue;
    const coords = f?.geometry?.coordinates || [];
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const raw = Number(p[variable]);
    const alt = Number(p.altitud);
    // Reduce to sea level so the lapse rate can be re-applied per pixel;
    // stations without altitud fall back to their raw value.
    const value =
      lapseRate > 0 && Number.isFinite(alt)
        ? raw + (lapseRate * alt) / 1000
        : raw;
    stations.push({ lng, lat, value });
  }

  const { west, south, east, north } = GRID_BOUNDS;
  const width = Math.max(1, Math.round((east - west) / GRID_STEP) + 1);
  const height = Math.max(1, Math.round((north - south) / GRID_STEP) + 1);
  const data = new Float32Array(width * height);

  // Distance in a locally flat plane: per cell, one cos(lat) scales the
  // longitude axis; per station it is then just squared-degree arithmetic
  // (≈ 4× faster than the spherical distKm per pair). A consistent scaling
  // cancels out in the IDW weights; only the no-data cutoff needs km.
  for (let iy = 0; iy < height; iy++) {
    const lat = south + iy * GRID_STEP;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (let ix = 0; ix < width; ix++) {
      const lng = west + ix * GRID_STEP;
      let num = 0;
      let den = 0;
      let nearestD2 = Infinity;
      let exact = null;
      for (const s of stations) {
        const dx = (lng - s.lng) * cosLat;
        const dy = lat - s.lat;
        const d2 = dx * dx + dy * dy;
        if (d2 < nearestD2) nearestD2 = d2;
        if (d2 === 0) { exact = s.value; break; }
        const w = 1 / d2;
        num += w * s.value;
        den += w;
      }
      let value;
      if (exact !== null) value = exact;
      else if (Math.sqrt(nearestD2) * KM_PER_DEG > maxDistKm || den === 0) value = NaN;
      else value = num / den;
      data[iy * width + ix] = value;
    }
  }

  return { data, width, height, west, south, step: GRID_STEP, lapseRate };
};

/**
 * Bilinear sample of the grid at a lng/lat point. Any no-data (NaN) corner
 * propagates → NaN, which callers treat as transparent (no data there).
 * Points outside the grid bounds are NaN too.
 */
export const sampleMeteoGrid = (grid, lng, lat) => {
  const { west, south, step, width, height } = grid;
  const fx = (lng - west) / step;
  const fy = (lat - south) / step;
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return NaN;
  if (fx < 0 || fy < 0 || fx > width - 1 || fy > height - 1) return NaN;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const t = fx - x0;
  const u = fy - y0;
  const at = (ix, iy) => grid.data[iy * width + ix];
  const top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * t;
  const bottom = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * t;
  const v = top + (bottom - top) * u;
  return Number.isFinite(v) ? v : NaN;
};

// Grids are rebuilt only when the data window changes (keyed by windowKey),
// and lazily — a variable's grid appears the first time its filter is used.
const gridCache = new Map(); // `${windowKey}|${variable}` -> grid

/**
 * Cached grid accessor. `windowKey` identifies the current data window (from
 * the day-range selector); pass the same features for the same window. The
 * cache is bounded so long browsing sessions don't grow without limit.
 */
export const getMeteoGrid = (windowKey, variable, features, options = {}) => {
  const key = `${windowKey || 'default'}|${variable}`;
  if (gridCache.has(key)) return gridCache.get(key);
  const grid = buildMeteoGrid(features, variable, options);
  gridCache.set(key, grid);
  if (gridCache.size > 30) gridCache.delete(gridCache.keys().next().value);
  return grid;
};