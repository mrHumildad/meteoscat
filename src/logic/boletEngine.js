/**
 * Bolet engine — scores every station × species over the daily summaries
 * (MUSHROOM_APP_PLAN.md Phase 1 §7.1.1–7.1.2).
 *
 * Consumes the same daily-summaries shape the rest of the app uses
 * (refineData.loadSummaries output):
 *
 *   { "YYYY-MM-DD": { "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg,
 *     humMin, humMax, precAcc }, dayStats: {...} }, ... }
 *
 * The species look-back window is the LAST `species.windowDays` days of the
 * requested range (the plan's rules are retrospective: rain/temp over the
 * window, flush lag counted from the most recent big-rain day). Pure and
 * unit-tested (boletEngine.test.js).
 */

import { SPECIES, speciesWindowStats, scoreSpecies } from './speciesRules.js';

/**
 * Score every station that has data in the window.
 *
 * @param {object} data         Daily summaries (shape above).
 * @param {string[]} daysRange  Sorted 'YYYY-MM-DD' days to score over
 *                              (oldest first; the species window takes the
 *                              LAST windowDays of it).
 * @param {string} speciesKey   Key into SPECIES ('rovellons', 'ceps', …).
 * @param {object} [forestByCode]  `{ stationCodi: forestType|null }` from
 *                              public/logic/forest_types.json; stations
 *                              absent from it have no host match (score 0).
 * @returns {Array} Sorted by score desc:
 *   `[{ code, score, stats, forestType }]` with `score` 0..1 or null when
 *   the station has no usable data in the window, `stats` from
 *   speciesWindowStats (null likewise), `forestType` the station's type.
 */
export const scoreStations = (data, daysRange, speciesKey, forestByCode = {}) => {
  const species = SPECIES[speciesKey];
  if (!species || !data || !Array.isArray(daysRange) || daysRange.length === 0) {
    return [];
  }

  const windowDays = daysRange.slice(-species.windowDays);
  const stationCodes = new Set();
  for (const day of windowDays) {
    const shard = data[day] || {};
    for (const [code, s] of Object.entries(shard)) {
      if (code !== 'dayStats' && s && typeof s === 'object') stationCodes.add(code);
    }
  }

  const out = [];
  for (const code of stationCodes) {
    const entries = windowDays.map(d => data[d]?.[code] ?? null);
    const stats = speciesWindowStats(entries);
    const forestType = forestByCode[code] ?? null;
    const score = scoreSpecies(stats, speciesKey, forestType);
    out.push({ code, score, stats, forestType });
  }

  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
};

/**
 * Station codes whose score meets a threshold (for gating the station
 * circles). Stations without data (score null) never pass. `[]` when the
 * input list is empty — matching the rest of the app's "empty = no
 * filtering" contract only when the caller treats it so; the caller decides.
 *
 * @param {Array} scores  Output of scoreStations.
 * @param {number} threshold  Score in [0, 1] to pass.
 * @returns {string[]} Passing station codes.
 */
export const codesAboveThreshold = (scores, threshold) =>
  scores
    .filter(s => s.score != null && s.score >= threshold)
    .map(s => s.code);

/**
 * Score lookup by station code for the map layer expressions: `{ code: score
 * | null }`. `null` for stations absent from the scores list (no data).
 */
export const scoreByCode = scores => {
  const map = {};
  for (const s of scores) map[s.code] = s.score ?? null;
  return map;
};