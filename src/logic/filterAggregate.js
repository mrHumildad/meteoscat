// Pure aggregation helpers for per-filter time windows (FILTER_REFACTOR_PLAN.md §4.1).
//
// The filter refactor removes the global calendar window: every meteo filter
// (rain / humidity / temperature) defines its own day range, expressed as day
// offsets back from the reference day (the latest available data day). To
// answer any window's aggregate in O(1) we precompute, once per data load,
// prefix sums per station per variable over the sorted day keys.
//
//   rain:      Σ daily precAcc over the window. Missing days contribute 0
//              (matches computeGeoValues), but a window with no present day
//              at all is "no data" → null.
//   temp:      mean of the daily tempAvg over the usable days of the window.
//   hum:       mean of the daily humAvg over the usable days, rounded to a
//              WHOLE % so the filter thresholds (value-slider limits, stored
//              bands, inert full-span checks) are integers everywhere and the
//              step-1 slider shows exactly what is applied. Deviation from
//              computeGeoValues: unusable values (null / undefined / '') are
//              *skipped*, not coerced to 0.
//
// Input shape (refineData.loadSummaries output):
//   { "<YYYY-MM-DD>": { "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg,
//     humMin, humMax, precAcc }, dayStats: {...} }, ... }
// The dayStats entry (and any non-object entry) is ignored.

import { fmt } from './utils.js';

// Filter instance type → the feature property / tile-URL variable holding it.
// Shared by the layer wiring (App), the grid builder (meteoGrid) and the
// panel (FilterPanel).
export const TYPE_TO_VARIABLE = { rain: 'precAcc', hum: 'humAvg', temp: 'tempAvg' };

const hasNumber = v =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

const RANGE = (arr, iFrom, iTo) =>
  arr[iTo] - (iFrom > 0 ? arr[iFrom - 1] : 0);

/**
 * Build the aggregate lookup table from the daily summaries.
 *
 * Returns `{ days, stations, sums, counts }`:
 *   days       — sorted 'YYYY-MM-DD' keys (ascending; last = reference day)
 *   stations   — sorted station codes present in any shard
 *   sums       — { rain, temp, hum } prefix sums per station over `days`
 *   counts     — { rain, temp, hum } prefix counts per station over `days`
 *                rain: days the station has an entry (drives the null-vs-0
 *                      decision for accumulated rain)
 *                temp/hum: days with a usable (hasNumber) value
 */
export const buildAggregateTable = data => {
  const days = Object.keys(data || {}).sort();
  const stationCodes = new Set();
  for (const day of days) {
    const shard = data[day] || {};
    for (const [code, s] of Object.entries(shard)) {
      if (code === 'dayStats' || !s || typeof s !== 'object') continue;
      stationCodes.add(code);
    }
  }
  const stations = [...stationCodes].sort();

  const sums = { rain: {}, temp: {}, hum: {} };
  const counts = { rain: {}, temp: {}, hum: {} };
  for (const type of ['rain', 'temp', 'hum']) {
    for (const code of stations) {
      sums[type][code] = new Float64Array(days.length);
      counts[type][code] = new Uint16Array(days.length);
    }
  }

  for (let i = 0; i < days.length; i++) {
    const shard = data[days[i]] || {};
    const prev = i > 0;
    for (const code of stations) {
      const s = shard[code];
      const rainVal = hasNumber(s?.precAcc) ? Number(s.precAcc) : 0;
      const tempVal = hasNumber(s?.tempAvg) ? Number(s.tempAvg) : 0;
      const humVal = hasNumber(s?.humAvg) ? Number(s.humAvg) : 0;
      sums.rain[code][i] = (prev ? sums.rain[code][i - 1] : 0) + rainVal;
      sums.temp[code][i] = (prev ? sums.temp[code][i - 1] : 0) + tempVal;
      sums.hum[code][i] = (prev ? sums.hum[code][i - 1] : 0) + humVal;
      counts.rain[code][i] =
        (prev ? counts.rain[code][i - 1] : 0) + (s ? 1 : 0);
      counts.temp[code][i] =
        (prev ? counts.temp[code][i - 1] : 0) +
        (hasNumber(s?.tempAvg) ? 1 : 0);
      counts.hum[code][i] =
        (prev ? counts.hum[code][i - 1] : 0) +
        (hasNumber(s?.humAvg) ? 1 : 0);
    }
  }

  return { days, stations, sums, counts };
};

/**
 * Aggregate a station's variable over the window `[fromOffset, toOffset]`,
 * both in days back from the reference day (last day of the table).
 * Requires `toOffset ≤ fromOffset ≤ days.length − 1`, all non-negative.
 * Returns the value (mm for rain, °C mean for temp, WHOLE % for hum) or
 * `null` when the station is unknown, the offsets are invalid, or the window
 * has no data.
 */
const aggregateByIndex = (agg, code, type, iFrom, iTo) => {
  const sumArr = agg.sums[type][code];
  const countArr = agg.counts[type][code];
  if (!sumArr || !countArr) return null; // unknown station

  const sum = RANGE(sumArr, iFrom, iTo);
  const cnt = RANGE(countArr, iFrom, iTo);
  if (cnt === 0) return null;
  // Humidity thresholds are integers (step-1 slider): round the mean so the
  // window limits, stored bands and UI labels all agree on whole %.
  if (type === 'hum') return Math.round(sum / cnt);
  return type === 'rain' ? sum : sum / cnt;
};

export const aggregateWindow = (agg, code, type, fromOffset, toOffset) => {
  if (!agg || !agg.days.length || !agg.sums[type]) return null;
  if (!Number.isInteger(fromOffset) || !Number.isInteger(toOffset)) return null;
  if (fromOffset < 0 || toOffset < 0 || fromOffset < toOffset) return null;
  const iTo = agg.days.length - 1 - toOffset;
  const iFrom = agg.days.length - 1 - fromOffset;
  if (iFrom < 0 || iTo >= agg.days.length || iFrom > iTo) return null;
  return aggregateByIndex(agg, code, type, iFrom, iTo);
};

/**
 * Same as aggregateWindow but with concrete 'YYYY-MM-DD' window bounds
 * instead of day offsets — used by the map overlay path, whose tile URLs
 * bake in the concrete window (stable grid cache keys).
 */
export const aggregateWindowByDates = (agg, code, type, fromDate, toDate) => {
  if (!agg || !agg.days.length || !agg.sums[type]) return null;
  const iFrom = agg.days.indexOf(fromDate);
  const iTo = agg.days.indexOf(toDate);
  if (iFrom < 0 || iTo < 0 || iFrom > iTo) return null;
  return aggregateByIndex(agg, code, type, iFrom, iTo);
};

/**
 * Concrete 'YYYY-MM-DD' range for a window of day offsets, given the
 * reference day (Date or 'YYYY-MM-DD' string). Used for labels, tile URLs
 * and grid cache keys.
 */
export const windowToDates = (refDay, fromOffset, toOffset) => {
  const ref = new Date(refDay);
  const from = new Date(ref);
  from.setDate(from.getDate() - fromOffset);
  const to = new Date(ref);
  to.setDate(to.getDate() - toOffset);
  return { from: fmt(from), to: fmt(to) };
};

// Value-slider limits per window (FILTER_REFACTOR_PLAN.md §4.2): the min/max
// of a variable across ALL stations over the given window. Memoized per
// aggregate table (WeakMap) with a small LRU, so re-built tables never read
// stale limits and old tables are garbage-collected.
const limitsCache = new WeakMap(); // agg -> Map<"type|from|to", [min, max] | null>

export const limitsForWindow = (agg, type, fromOffset, toOffset) => {
  if (!agg || !agg.days.length) return null;
  const key = `${type}|${fromOffset}|${toOffset}`;
  let cache = limitsCache.get(agg);
  if (!cache) {
    cache = new Map();
    limitsCache.set(agg, cache);
  }
  if (cache.has(key)) return cache.get(key);

  let lo = Infinity;
  let hi = -Infinity;
  for (const code of agg.stations) {
    const v = aggregateWindow(agg, code, type, fromOffset, toOffset);
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const result = lo === Infinity ? null : [lo, hi];
  cache.set(key, result);
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return result;
};