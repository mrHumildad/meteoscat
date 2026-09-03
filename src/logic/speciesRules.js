/**
 * Species-specific mushroom scoring rules (MUSHROOM_APP_PLAN.md §3, §A.2).
 *
 * Every species gets a deterministic rule table; the engine computes a
 * boletScore ∈ [0, 1] per station × species over a window of daily
 * summaries. Weights follow §A.2 (the initial implementation):
 *
 *   score = clamp((
 *       0.45 * norm(rainTotalMm,  species.cumulativeRainMm[0], species.cumulativeRainMm[1])
 *     + 0.30 * norm(tempMeanC,    species.tempMeanC[0],        species.tempMeanC[1])
 *     + 0.15 * smoothstep(species.lagDays[0], species.lagDays[1], daysSinceBigRain)
 *     + 0.10 * (tempMinC > species.minTempC ? 1 : 0)
 *   ) * forestHostMatch, 0, 1)
 *
 * forestHostMatch is BINARY: 1 when the station's forest type (from
 * public/logic/forest_types.json) is one of species.forestHostFc, 0
 * otherwise — a station not on the species' tree host scores zero no matter
 * how good the weather is.
 *
 * All functions here are pure and unit-tested (speciesRules.test.js). The
 * numbers are the plan's DRAFT model — validation against real finds is a
 * Phase 1.5+ concern.
 */

export const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear normalisation of x onto [0, 1] over [lo, hi], clamped. */
export const norm = (x, lo, hi) => {
  if (!Number.isFinite(x)) return 0;
  if (hi <= lo) return x >= lo ? 1 : 0; // degenerate range guard
  return clamp01((x - lo) / (hi - lo));
};

/** GLSL-style smoothstep: 0 below e0, 1 at/above e1, smooth in between. */
export const smoothstep = (e0, e1, x) => {
  if (!Number.isFinite(x)) return 0;
  if (e1 <= e0) return x >= e0 ? 1 : 0;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

// Single-day rain event (mm) that counts as the "big rain" flush trigger —
// the plan (§A.2) fixes it at 15 mm for every species. Rovellons additionally
// require such an event in the window (their table row says "with ≥ 1 event
// ≥ 15 mm"); the lag term uses it for every species.
export const BIG_RAIN_EVENT_MM = 15;

/**
 * The five species covering ~95 % of Catalan forager interest (plan §3).
 * Field meanings:
 *   windowDays         — look-back window length for the weather terms
 *   lagDays            — [lo, hi] days after the big rain when the flush
 *                        happens; smoothstep ramps 0→1 across it
 *   cumulativeRainMm   — [minScore, maxScore] for rain normalisation
 *                        (minScore = the table's trigger threshold)
 *   tempMeanC          — [lo, hi] daily-mean temperature band
 *   minTempC           — below this daily minimum, the frost term is 0
 *   forestHostFc       — MCSC forest types that host the species
 *                        (forest_types.json `forestType` values)
 */
export const SPECIES = {
  rovellons: {
    key: 'rovellons',
    name: 'Rovellons',
    latin: 'Lactarius deliciosus gr.',
    windowDays: 21,
    lagDays: [15, 21],
    cumulativeRainMm: [40, 200],
    tempMeanC: [6, 16],
    minTempC: 0,
    forestHostFc: ['forest_conif'],
  },
  ceps: {
    key: 'ceps',
    name: 'Ceps / Surenys',
    latin: 'Boletus edulis, B. aereus, B. reticulatus',
    windowDays: 15,
    lagDays: [10, 15],
    cumulativeRainMm: [60, 200],
    tempMeanC: [10, 18],
    minTempC: -100, // no frost gate in the plan's table for ceps
    forestHostFc: ['forest_decid', 'forest_mixed'],
  },
  llenegues: {
    key: 'llenegues',
    name: 'Llenegues',
    latin: 'Hygrophorus latitabundus, H. eburneus',
    windowDays: 30,
    lagDays: [20, 30],
    cumulativeRainMm: [80, 200],
    tempMeanC: [2, 10],
    minTempC: -100,
    forestHostFc: ['forest_sclerophyll'],
  },
  murgoles: {
    key: 'murgoles',
    name: 'Múrgoles',
    latin: 'Morchella esculenta gr.',
    windowDays: 14,
    lagDays: [7, 14],
    cumulativeRainMm: [30, 200],
    tempMeanC: [8, 14],
    minTempC: -100,
    // Riparian / deciduous (plan: forest_decid near streams OR burned areas;
    // the burned-area cross-check with Pla Alfa is a future step).
    forestHostFc: ['forest_decid'],
  },
  rossinyols: {
    key: 'rossinyols',
    name: 'Rossinyols',
    latin: 'Cantharellus cibarius',
    windowDays: 21,
    lagDays: [15, 21],
    cumulativeRainMm: [35, 200],
    tempMeanC: [10, 20],
    minTempC: -100,
    forestHostFc: ['forest_decid', 'forest_conif'],
  },
};

/** Species list in UI order (keys of SPECIES). */
export const SPECIES_KEYS = Object.keys(SPECIES);

/**
 * Reduce a station's window entries (oldest first, one per day) to the
 * weather stats the score formula consumes. Follows the filterAggregate
 * conventions: rain sums over present days (missing contributes 0); temp
 * means skip unusable values.
 *
 * @param {Array} entries  Daily records `{ tempAvg, tempMin, precAcc }`
 * @returns {object|null}  `{ rainTotalMm, tempMeanC, tempMinC, daysSinceBigRain }`
 *                         or null when the window has no usable record at all.
 *   daysSinceBigRain — days since the MOST RECENT single-day rain ≥
 *   BIG_RAIN_EVENT_MM, capped to [0, 30]; null when no such event (no flush
 *   trigger ⇒ lag term 0).
 */
export const speciesWindowStats = entries => {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const hasNumber = v =>
    v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

  let rainTotal = 0;
  let present = 0;
  let tempSum = 0;
  let tempUsable = 0;
  let tempMin = Infinity;
  let minUsable = 0;
  let eventIdx = -1;

  entries.forEach((e, i) => {
    if (!e || typeof e !== 'object') return;
    present++;
    if (hasNumber(e.precAcc)) rainTotal += Number(e.precAcc);
    if (hasNumber(e.tempAvg)) {
      tempSum += Number(e.tempAvg);
      tempUsable++;
    }
    if (hasNumber(e.tempMin)) {
      tempMin = Math.min(tempMin, Number(e.tempMin));
      minUsable++;
    }
    if (hasNumber(e.precAcc) && Number(e.precAcc) >= BIG_RAIN_EVENT_MM) {
      eventIdx = i;
    }
  });

  if (present === 0 && tempUsable === 0) return null;

  const daysSinceBigRain =
    eventIdx < 0
      ? null
      : Math.min(Math.max(entries.length - 1 - eventIdx, 0), 30);

  return {
    rainTotalMm: Math.round(rainTotal * 10) / 10,
    tempMeanC: tempUsable ? Math.round((tempSum / tempUsable) * 10) / 10 : null,
    tempMinC: minUsable ? Math.round(tempMin * 10) / 10 : null,
    daysSinceBigRain,
  };
};

/**
 * The bolet score formula (§A.2).
 *
 * @param {object|null} stats      From speciesWindowStats (null ⇒ null).
 * @param {string} speciesKey      Key into SPECIES.
 * @param {string|null} forestType Station forest type (forest_types.json),
 *                                 null when unknown (⇒ no host match).
 * @returns {number|null}          0..1, or null when stats are missing.
 */
export const scoreSpecies = (stats, speciesKey, forestType) => {
  const species = SPECIES[speciesKey];
  if (!species || !stats) return null;

  const rainTerm = norm(stats.rainTotalMm ?? 0,
    species.cumulativeRainMm[0], species.cumulativeRainMm[1]);
  const tempTerm = stats.tempMeanC == null
    ? 0
    : norm(stats.tempMeanC, species.tempMeanC[0], species.tempMeanC[1]);
  const lagTerm = stats.daysSinceBigRain == null
    ? 0
    : smoothstep(species.lagDays[0], species.lagDays[1], stats.daysSinceBigRain);
  const frostTerm = stats.tempMinC == null
    ? 0
    : stats.tempMinC > species.minTempC ? 1 : 0;
  const forestMatch = species.forestHostFc.includes(forestType) ? 1 : 0;

  const raw = 0.45 * rainTerm + 0.30 * tempTerm + 0.15 * lagTerm + 0.10 * frostTerm;
  return Math.round(clamp01(raw * forestMatch) * 1000) / 1000;
};