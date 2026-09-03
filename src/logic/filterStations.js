// Pure station-filtering logic for the per-filter time-range refactor
// (FILTER_REFACTOR_PLAN.md §4.3).
//
// Evaluates the AND of every active filter against the prefix-sum aggregate
// table (filterAggregate.js): a station passes when
//   - its per-window aggregate lies inside every meteo instance's value band,
//   - its altitud lies inside the relief band (when active), and
//   - it has usable data for every active instance.
//
// Contract (unchanged from before): an EMPTY result list means "no
// filtering" — the caller shows everything. So when nothing constrains
// (no instance narrowed below its window's full span, no active relief band)
// this returns []. Inert instances (band == full span of their window,
// plan §2.3) always pass and never count as constraining.
//
// Known quirk carried over from the old sliders: a combination that matches
// no station also yields [], which the caller reads as "show everything".
// Distinguishing "no match" from "no filter" is out of scope for this step.

import { aggregateWindow, limitsForWindow } from './filterAggregate.js';

const hasNumber = v =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// An instance constrains only when its band is narrower than the full span
// its window can produce across all stations.
const usableRange = f =>
  Array.isArray(f.range) &&
  f.range.length === 2 &&
  Number.isFinite(f.range[0]) &&
  Number.isFinite(f.range[1]);

const sameBand = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1];

/**
 * Station codes that pass every active filter.
 *
 * @param {Array} stations     GeoJSON features with `properties.codi` and
 *                             `properties.altitud` (static metadata).
 * @param {Array} meteoFilters Filter instances `{ id, type, from, to, range }`
 *                             (type ∈ rain|hum|temp, offsets days back from
 *                             the reference day).
 * @param {[number, number] | null} reliefRange Applied altitude band, or null.
 * @param {object} agg         Aggregate table from buildAggregateTable.
 * @returns {string[]}         Station codes passing every filter, or [] when
 *                             no filter constrains anything.
 */
export const filterStationCodes = (stations, meteoFilters, reliefRange, agg) => {
  if (!Array.isArray(stations) || stations.length === 0) return [];

  const filters = Array.isArray(meteoFilters) ? meteoFilters : [];
  const active = filters.filter(f => {
    if (!usableRange(f)) return false;
    const span = limitsForWindow(agg, f.type, f.from, f.to);
    return span != null && !sameBand(f.range, span);
  });

  // The relief band constrains only when narrowed below the stations'
  // altitud span (full span == off, same contract as the old slider).
  const alts = [];
  for (const st of stations) {
    const raw = st.properties?.altitud;
    if (hasNumber(raw)) alts.push(Number(raw));
  }
  const altFull = alts.length ? [Math.min(...alts), Math.max(...alts)] : null;
  const reliefActive =
    reliefRange != null &&
    altFull != null &&
    (reliefRange[0] !== altFull[0] || reliefRange[1] !== altFull[1]);

  if (active.length === 0 && !reliefActive) return [];

  const codes = [];
  for (const st of stations) {
    const p = st.properties || {};
    const code = p.codi;
    if (!code) continue;

    if (reliefActive) {
      if (!hasNumber(p.altitud)) continue;
      const a = Number(p.altitud);
      if (a < reliefRange[0] || a > reliefRange[1]) continue;
    }

    let ok = true;
    for (const f of active) {
      const v = aggregateWindow(agg, code, f.type, f.from, f.to);
      if (v == null || v < f.range[0] || v > f.range[1]) {
        ok = false;
        break;
      }
    }
    if (ok) codes.push(code);
  }
  return codes;
};