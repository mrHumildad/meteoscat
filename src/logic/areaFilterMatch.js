// How much of the analysed DISC each filter covers — the "filter" tab of the
// directions modal: for the live filter stack (when it filters anything) and
// for every saved preset, the share of the disc's sample points that satisfy
// it.
//
// "Satisfies" mirrors the gate stack the map paints with (tilePaint.js /
// terrainOverlay.js), so the percentage is the share of the area the filter
// actually covers:
//   • a dimmed MCSC class excludes the point (its class must be known and
//     selected) — only when the filter dims something at all;
//   • a dimmed substrate family excludes it (points without substrate data
//     are never excluded);
//   • the altitude band must contain the point's DEM height;
//   • every active meteo instance's band must contain the point's value for
//     that instance's OWN window, interpolated exactly like the map does
//     (featuresForWindow → getMeteoGrid → sampleMeteoGrid, with the
//     elevation lapse-rate correction for temperature).
// Two deliberate deltas from the painted pixels: water is treated like any
// other class (the map lets it bypass the bands), and unsampled data counts as
// "cannot satisfy" rather than "painted transparent".
//
// The disc is sampled on the SAME grid as the altitude profile
// (areaElevation.areaSamplePoints), and each point reads the DEM, the MCSC
// band tile and the lithology grid at that spot, so all the modal's graphs
// describe one single patch.
//
// Everything but the DEM / MCSC sampling is pure and unit-tested.

import { areaSamplePoints } from './areaElevation.js';
// The land-cover count reads the same zoom, so both panels describe one patch.
import { AREA_MCSC_ZOOM } from './areaComposition.js';
import { sampleElevation, lngLatToTileXY, clamp } from './elevation.js';
import { loadMcscBandTile } from './mcscRaw.js';
import { entryForBand } from './mcscLegend.js';
import { lithoFamilyKeyAt } from './lithology.js';
import { TYPE_TO_VARIABLE, windowToDates } from './filterAggregate.js';
import {
  featuresForWindow,
  getMeteoGrid,
  sampleMeteoGrid,
  LAPSE_RATE,
} from './meteoGrid.js';

// Key of the live-filter row (preset names can't collide with it).
export const MATCH_ACTIVE_KEY = '__active__';

/**
 * Does the stored config filter anything at all? A stack of inert (full-span)
 * instances, or one with only a bolet species rule, is still "set" here — the
 * caller decides whether that is worth a row. A bolet rule has no per-point
 * meaning (it scores stations, it never gates terrain), so it is not counted.
 * Pure, unit-testable.
 */
export const hasFilterConditions = (config) => {
  if (!config) return false;
  const muted = new Set(config.muted ?? []);
  return !!(
    (config.meteoFilters ?? []).some(f => f?.enabled !== false) ||
    (config.reliefRange && !muted.has('relief')) ||
    ((config.forestOff?.length ?? 0) > 0 && !muted.has('forest')) ||
    ((config.geoOff?.length ?? 0) > 0 && !muted.has('geo'))
  );
};

/**
 * Stored filter config (savedFilters.js shape: day OFFSETS + meteo type) →
 * the evaluation shape the gates read: concrete window DATES and the meteo
 * variable name. Unknown meteo types and windows that cannot be resolved on
 * the current dataset are dropped rather than guessed. Pure, unit-testable.
 */
export const normalizeFilterConfig = (config, refDay) => {
  if (!config || typeof config !== 'object') return null;
  const muted = new Set(config.muted ?? []);
  const meteo = [];
  for (const f of config.meteoFilters ?? []) {
    const variable = TYPE_TO_VARIABLE[f?.type];
    if (!variable || f.enabled === false || !refDay || !Array.isArray(f.range)) continue;
    const w = windowToDates(refDay, f.from, f.to);
    if (!w) continue;
    meteo.push({ variable, from: w.from, to: w.to, band: [f.range[0], f.range[1]] });
  }
  return {
    // A muted single filter keeps its value in the stored config but gates
    // nothing here, exactly like the map.
    reliefRange: Array.isArray(config.reliefRange) && !muted.has('relief')
      ? [config.reliefRange[0], config.reliefRange[1]]
      : null,
    // Sets travel as arrays in the stored config; the copies keep callers from
    // mutating a stored preset.
    forestOff: muted.has('forest') ? [] : [...(config.forestOff ?? [])],
    geoOff: muted.has('geo') ? [] : [...(config.geoOff ?? [])],
    meteo,
  };
};

/**
 * One disc sample's MCSC band value (0 = no data), read from the raw-band
 * tile at z (AREA_MCSC_ZOOM by default) — nearest pixel, since a class id
 * must not be interpolated. `loadTile` is the loader seam (mcscRaw's cached
 * one by default) so this is testable with synthetic tiles.
 */
export const sampleMcscBand = async (lng, lat, z = AREA_MCSC_ZOOM, loadTile = loadMcscBandTile) => {
  const { x, y, px, py } = lngLatToTileXY(lng, lat, z);
  const image = await loadTile(z, x, y);
  const ix = clamp(Math.floor(px), 0, image.width - 1);
  const iy = clamp(Math.floor(py), 0, image.height - 1);
  return image.data[(iy * image.width + ix) * 4] || 0; // red channel = band
};

/**
 * The disc's sample points, each carrying every input the gates need: DEM
 * elevation (null when unsampled), MCSC band, substrate family key (null when
 * there is no grid or no data). Meteo values are added by matchAreaFilters,
 * because they depend on each filter's window.
 */
export const sampleDiscPoints = async (
  lat,
  lng,
  radiusM,
  { lithoGrid = null, z = AREA_MCSC_ZOOM, loadTile } = {},
) => {
  const points = areaSamplePoints(lat, lng, radiusM);
  if (!points.length) return [];
  const [elevations, bands] = await Promise.all([
    Promise.all(points.map(p => sampleElevation(p.lng, p.lat))),
    Promise.all(points.map(p => sampleMcscBand(p.lng, p.lat, z, loadTile))),
  ]);
  return points.map((p, i) => ({
    lat: p.lat,
    lng: p.lng,
    elev: elevations[i],
    band: bands[i],
    familyKey: lithoGrid ? lithoFamilyKeyAt(lithoGrid, p.lng, p.lat) : null,
  }));
};

/**
 * Does one sample satisfy the (normalised) filter? `meteoValues` are the
 * sampled values of `config.meteo`, in the same order. Pure, unit-testable.
 */
export const matchesFilterGates = (sample, config, meteoValues = []) => {
  if (!sample || !config) return false;
  const off = config.forestOff ?? [];
  const offGeo = config.geoOff ?? [];
  const meteo = config.meteo ?? [];

  // Land-cover condition: the class must be known and selected. With nothing
  // dimmed there is no class condition to apply at all.
  if (off.length) {
    const entry = entryForBand(sample.band);
    if (!entry || off.includes(entry.codes)) return false;
  }
  // Substrate condition: only points WITH a family can fail it.
  if (offGeo.length && sample.familyKey && offGeo.includes(sample.familyKey)) return false;
  // Altitude band: land only, and the DEM must have answered.
  if (config.reliefRange) {
    const [lo, hi] = config.reliefRange;
    const e = sample.elev;
    if (!Number.isFinite(e) || e <= 0 || e < lo || e > hi) return false;
  }
  // Every meteo instance must contain the point (AND semantics).
  for (let k = 0; k < meteo.length; k++) {
    const v = meteoValues[k];
    const [lo, hi] = meteo[k].band;
    if (!Number.isFinite(v) || v < lo || v > hi) return false;
  }
  return true;
};

/**
 * Share of `samples` each config covers: `[{ ...config row, count, total,
 * share }]` in the given order. Meteo grids are built once per distinct
 * window (featuresForWindow + getMeteoGrid, both cached) and sampled per
 * point exactly like the terrain overlay does.
 */
export const matchAreaFilters = (samples, configs, { agg, features } = {}) => {
  const list = samples ?? [];
  const windows = new Map(); // `variable|from|to` -> { variable, from, to }
  for (const row of configs ?? []) {
    for (const m of row.config?.meteo ?? []) {
      windows.set(`${m.variable}|${m.from}|${m.to}`, m);
    }
  }

  const valuesByWindow = new Map();
  for (const [key, m] of windows) {
    const windowFeatures = featuresForWindow(agg, features, m.variable, m.from, m.to);
    const grid = getMeteoGrid(`${m.from}_${m.to}`, m.variable, windowFeatures, {
      lapseRate: m.variable === 'tempAvg' ? LAPSE_RATE : 0,
    });
    const values = new Float64Array(list.length);
    list.forEach((s, i) => {
      let v = sampleMeteoGrid(grid, s.lng, s.lat);
      // Temperature is interpolated sea-level-reduced; the point's own
      // elevation is re-applied here, like the map does per pixel.
      if (grid.lapseRate > 0 && Number.isFinite(v) && Number.isFinite(s.elev)) {
        v -= (grid.lapseRate * s.elev) / 1000;
      }
      values[i] = v;
    });
    valuesByWindow.set(key, values);
  }

  return (configs ?? []).map(row => {
    const meteo = row.config?.meteo ?? [];
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      const values = meteo.map(m => valuesByWindow.get(`${m.variable}|${m.from}|${m.to}`)[i]);
      if (matchesFilterGates(list[i], row.config, values)) count++;
    }
    return {
      ...row,
      count,
      total: list.length,
      share: list.length ? count / list.length : 0,
    };
  });
};
