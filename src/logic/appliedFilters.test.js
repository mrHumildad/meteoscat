import { describe, it, expect } from 'vitest';
import { buildAggregateTable } from './filterAggregate.js';
import { appliedFilterItems } from './appliedFilters.js';

// Two days × two stations: window from=1 → to=0 covers both days, so the
// full spans are rain [3, 13], temp [11, 21] (means) and hum [53, 73]
// (means rounded to whole %). A band equal to the span is inert.
const agg = buildAggregateTable({
  '2026-09-10': {
    S1: { precAcc: 1, tempAvg: 10, humAvg: 50 },
    S2: { precAcc: 5, tempAvg: 20, humAvg: 70 },
  },
  '2026-09-11': {
    S1: { precAcc: 2, tempAvg: 12, humAvg: 55 },
    S2: { precAcc: 8, tempAvg: 22, humAvg: 75 },
  },
});

describe('appliedFilterItems', () => {
  it('is empty when nothing filters', () => {
    expect(appliedFilterItems()).toEqual([]);
    expect(appliedFilterItems({
      agg,
      meteoFilters: [{ type: 'rain', from: 1, to: 0, range: [3, 13] }],
    })).toEqual([]);
  });

  it('puts the applied preset name first, then one line per active condition', () => {
    const items = appliedFilterItems({
      presetName: 'Fred i pluja',
      meteoFilters: [
        { id: 'f1', type: 'rain', from: 1, to: 0, range: [4, 10] },
        { id: 'f2', type: 'hum', from: 1, to: 0, range: [53, 73] }, // full span → inert
        { id: 'f3', type: 'temp', from: 1, to: 0, range: [12, 20] },
      ],
      agg,
      reliefRange: [100, 600],
      altLimits: [0, 2000],
      forestCount: 2,
      geoCount: 1,
      boletSpecies: 'ceps',
    });

    expect(items).toEqual([
      'Fred i pluja',
      'Pluja 4–10 mm · darrers 1 dies',
      'Temperatura 12–20 °C · darrers 1 dies',
      'Relleu 100–600 m',
      'Bosc (2)',
      'Substrat',
      'Bolets ceps',
    ]);
  });

  it('omits the preset name and the full-span relief band', () => {
    expect(appliedFilterItems({
      agg,
      meteoFilters: [{ type: 'rain', from: 1, to: 0, range: [4, 10] }],
      reliefRange: [0, 2000], // stations' whole altitud span → off
      altLimits: [0, 2000],
      forestCount: 1,
    })).toEqual([
      'Pluja 4–10 mm · darrers 1 dies',
      'Bosc',
    ]);
  });

  it('skips unknown types and unusable bands', () => {
    expect(appliedFilterItems({
      agg,
      meteoFilters: [
        { type: 'snow', from: 1, to: 0, range: [1, 2] },
        { type: 'rain', from: 1, to: 0, range: null },
      ],
    })).toEqual([]);
  });
});
