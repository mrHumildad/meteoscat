// What the app header ticker shows: the applied filter preset's name (when
// the live stack exactly matches a saved one) followed by ONE line per ACTIVE
// condition — every meteo instance that actually narrows its window, the
// relief band, the dimmed forest classes, the dimmed substrate families and
// the bolet species. Purely descriptive: the header reads it, nothing
// recomputes the map from it.
//
// "Active" follows the rest of the app's full-span-means-off contract: an
// instance only counts when its band is narrower than the full span its
// window can produce (filterStationCodes / terrainState), a relief band only
// when narrowed below the stations' altitud span. Inert entries are skipped
// so the ticker never advertises a filter that isn't filtering.

import { dayRangeLabel, limitsForWindow } from './filterAggregate.js';
import { fmtNum } from './utils.js';

// Same wording as the filter panel (FilterPanel.METEO_DEFS) and the preset
// descriptions (savedFilters.describeFilterConfig).
const TYPE_LABEL = { rain: 'Pluja', hum: 'Humitat', temp: 'Temperatura' };
const TYPE_UNIT = { rain: 'mm', hum: '%', temp: '°C' };
const TYPE_DECIMALS = { rain: 1, hum: 0, temp: 1 };

// An instance constrains only when its band is narrower than its window's
// full span across all stations.
const isActive = (agg, f) => {
  if (!f || !TYPE_LABEL[f.type] || !Array.isArray(f.range)) return false;
  const span = agg?.days?.length ? limitsForWindow(agg, f.type, f.from, f.to) : null;
  return span != null && (f.range[0] !== span[0] || f.range[1] !== span[1]);
};

/**
 * Ordered ticker items: [preset name (if any), condition, condition, …].
 * Returns [] when nothing filters, so the header can render nothing at all.
 *
 * @param {object}   state
 * @param {string}   [state.presetName]  Name of the matching saved preset, or null.
 * @param {Array}    [state.meteoFilters] Live instances `{ type, from, to, range }`.
 * @param {object}   [state.agg]          Aggregate table (window limits).
 * @param {Array}    [state.reliefRange]  Applied altitude band, or null.
 * @param {Array}    [state.altLimits]    Stations' full altitud span, or null.
 * @param {number}   [state.forestCount]  Dimmed MCSC classes.
 * @param {number}   [state.geoCount]     Dimmed substrate families.
 * @param {string}   [state.boletSpecies] Selected mushroom species, or null.
 * @returns {string[]}
 */
export const appliedFilterItems = ({
  presetName = null,
  meteoFilters = [],
  agg = null,
  reliefRange = null,
  altLimits = null,
  forestCount = 0,
  geoCount = 0,
  boletSpecies = null,
} = {}) => {
  const items = [];
  if (presetName) items.push(presetName);

  const instances = Array.isArray(meteoFilters) ? meteoFilters : [];
  for (const f of instances) {
    if (!isActive(agg, f)) continue;
    const dec = TYPE_DECIMALS[f.type];
    items.push(
      `${TYPE_LABEL[f.type]} ${fmtNum(f.range[0], dec)}–${fmtNum(f.range[1], dec)} ${TYPE_UNIT[f.type]} · ${dayRangeLabel(f.from, f.to)}`,
    );
  }

  // The relief band constrains only when narrowed below the altitud span
  // (full span == off, same contract as terrainState.alt).
  const reliefApplied = reliefRange != null && altLimits != null &&
    (reliefRange[0] !== altLimits[0] || reliefRange[1] !== altLimits[1]);
  if (reliefApplied) items.push(`Relleu ${reliefRange[0]}–${reliefRange[1]} m`);

  if (forestCount > 0) items.push(forestCount > 1 ? `Bosc (${forestCount})` : 'Bosc');
  if (geoCount > 0) items.push(geoCount > 1 ? `Substrat (${geoCount})` : 'Substrat');
  if (boletSpecies) items.push(`Bolets ${boletSpecies}`);

  return items;
};
