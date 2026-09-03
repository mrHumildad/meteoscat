import { describe, it, expect } from 'vitest';
import { filterStationCodes } from './filterStations.js';
import { buildAggregateTable } from './filterAggregate.js';
import { decodeLithoGrid } from './lithology.js';

// Daily summaries: values are constant per variable so the [2,0] window
// aggregates are easy to reason about. Reference day = 2026-08-03.
//   A: rain Σ = 20 mm, temp 10 °C, hum 60 %  (mid-mountain, 800 m)
//   B: rain Σ = 5 mm,  temp 25 °C, hum 40 %  (coastal, 100 m)
//   C: rain Σ = 48 mm, temp 15 °C, hum 80 %  (wet, 500 m)
const data = {
  '2026-08-01': {
    A: { tempAvg: 10, humAvg: 60, precAcc: 5 },
    B: { tempAvg: 25, humAvg: 40, precAcc: 2 },
    C: { tempAvg: 15, humAvg: 80, precAcc: 30 },
    dayStats: {},
  },
  '2026-08-02': {
    A: { tempAvg: 10, humAvg: 60, precAcc: 10 },
    B: { tempAvg: 25, humAvg: 40, precAcc: 2 },
    C: { tempAvg: 15, humAvg: 80, precAcc: 8 },
    dayStats: {},
  },
  '2026-08-03': {
    A: { tempAvg: 10, humAvg: 60, precAcc: 5 },
    B: { tempAvg: 25, humAvg: 40, precAcc: 1 },
    C: { tempAvg: 15, humAvg: 80, precAcc: 10 },
    dayStats: {},
  },
};

const agg = buildAggregateTable(data);

// Features mirror computeGeoValues output: `codi` + static `altitud`.
// D/E have no entry in the aggregate table; F has no `codi` at all.
const features = [
  { properties: { codi: 'A', altitud: 800 } },
  { properties: { codi: 'B', altitud: 100 } },
  { properties: { codi: 'C', altitud: 500 } },
  { properties: { codi: 'D', altitud: null } },
  { properties: { codi: 'E' } },
  { properties: { altitud: 300 } },
];

const rain = (from, to, range) => ({ id: 'r', type: 'rain', from, to, range });
const temp = (from, to, range) => ({ id: 't', type: 'temp', from, to, range });

describe('filterStationCodes', () => {
  it('returns [] when there are no filters at all', () => {
    expect(filterStationCodes(features, [], null, agg)).toEqual([]);
    expect(filterStationCodes(features, undefined, null, agg)).toEqual([]);
  });

  it('returns [] for an empty station list', () => {
    expect(filterStationCodes([], [rain(2, 0, [10, 60])], null, agg)).toEqual([]);
  });

  it('treats an instance at its window full span as inert (no filtering)', () => {
    // rain [2,0] full span across stations = [5, 48]
    expect(filterStationCodes(features, [rain(2, 0, [5, 48])], null, agg)).toEqual([]);
  });

  it('treats malformed instances (no range) as inert', () => {
    expect(filterStationCodes(features, [{ type: 'rain', from: 2, to: 0 }], null, agg)).toEqual([]);
  });

  it('keeps only stations inside the narrowed rain band', () => {
    expect(filterStationCodes(features, [rain(2, 0, [10, 60])], null, agg)).toEqual(['A', 'C']);
  });

  it('keeps only stations inside the narrowed temperature band', () => {
    expect(filterStationCodes(features, [temp(2, 0, [12, 16])], null, agg)).toEqual(['C']);
  });

  it('uses inclusive value bounds (>= min, <= max)', () => {
    expect(filterStationCodes(features, [temp(2, 0, [10, 15])], null, agg)).toEqual(['A', 'C']);
  });

  it('ANDs different filter types together', () => {
    // rain [10,60] AND temp [12,16]: only C passes both
    expect(filterStationCodes(features, [rain(2, 0, [10, 60]), temp(2, 0, [12, 16])], null, agg)).toEqual(['C']);
  });

  it('ANDs multiple instances of the same type together', () => {
    // rain [10,60] AND rain [5,30]: A (20) passes both; C (48) fails the second
    expect(filterStationCodes(features, [rain(2, 0, [10, 60]), rain(2, 0, [5, 30])], null, agg)).toEqual(['A']);
  });

  it('evaluates each instance over its own window', () => {
    // Single day 08-02: A rain = 10, B = 2, C = 8
    expect(filterStationCodes(features, [rain(1, 1, [9, 11])], null, agg)).toEqual(['A']);
  });

  it('applies the relief band on top of the meteo filters', () => {
    expect(filterStationCodes(features, [rain(2, 0, [10, 60])], [600, 900], agg)).toEqual(['A']);
  });

  it('treats a relief band at the stations altitud span as off', () => {
    expect(filterStationCodes(features, [], [100, 800], agg)).toEqual([]);
  });

  it('keeps only stations inside the narrowed altitude range (metres)', () => {
    expect(filterStationCodes(features, [], [600, 900], agg)).toEqual(['A']);
    expect(filterStationCodes(features, [], [0, 300], agg)).toEqual(['B']);
  });

  it('excludes stations without data when filtering is active', () => {
    // D/E are absent from the aggregate table → no data → excluded; F has no codi
    expect(filterStationCodes(features, [rain(2, 0, [0, 100])], null, agg)).toEqual(['A', 'B', 'C']);
  });

  it('excludes stations lacking altitud when relief is active', () => {
    expect(filterStationCodes(features, [], [0, 300], agg)).not.toContain('D');
    expect(filterStationCodes(features, [], [0, 300], agg)).not.toContain('E');
  });

  it('returns [] when no station matches', () => {
    expect(filterStationCodes(features, [temp(2, 0, [30, 40])], null, agg)).toEqual([]);
  });
});

// ── Geology (substrate) gate ───────────────────────────────────────────────
// 4 cols × 3 rows @ 1° cells, west = 0, north = 3:
//   row 0 (y∈[2,3)): 1 1 2 2   row 1 (y∈[1,2)): 3 0 0 0   row 2: all nodata
const geoGridJson = {
  cols: 4,
  rows: 3,
  west: 0,
  north: 3,
  step: 1,
  families: {
    '0': { key: 'nodata', label: 'Sense dades', color: null },
    '1': { key: 'carbonatades', label: 'Calcàries', color: '#6a93cf' },
    '2': { key: 'volcaniques', label: 'Volcàniques', color: '#8f4fc0' },
    '3': { key: 'gresos', label: 'Gresos', color: '#bf8a4e' },
  },
  rle: [[[1, 2], [2, 2]], [[3, 1], [0, 3]], [[0, 4]]],
};
const geoGrid = decodeLithoGrid(geoGridJson);

// A on carbonatades, B on volcaniques, C on gresos, D on nodata (no
// substrate), E without geometry at all.
const geoFeatures = [
  { properties: { codi: 'A' }, geometry: { type: 'Point', coordinates: [0.5, 2.5] } },
  { properties: { codi: 'B' }, geometry: { type: 'Point', coordinates: [2.5, 2.5] } },
  { properties: { codi: 'C' }, geometry: { type: 'Point', coordinates: [0.5, 1.5] } },
  { properties: { codi: 'D' }, geometry: { type: 'Point', coordinates: [1.5, 1.5] } },
  { properties: { codi: 'E' } },
];

describe('filterStationCodes — geology (substrate) gate', () => {
  const geo = off => ({ off, grid: geoGrid });

  it('is inert when no family is dimmed (even with the grid loaded)', () => {
    expect(filterStationCodes(geoFeatures, [], null, agg, geo(new Set()))).toEqual([]);
  });

  it('excludes stations on dimmed families; nodata and no-geometry stations pass', () => {
    expect(filterStationCodes(geoFeatures, [], null, agg, geo(new Set(['carbonatades']))))
      .toEqual(['B', 'C', 'D', 'E']);
    expect(filterStationCodes(geoFeatures, [], null, agg, geo(new Set(['volcaniques']))))
      .toEqual(['A', 'C', 'D', 'E']);
    expect(filterStationCodes(geoFeatures, [], null, agg, geo(new Set(['gresos', 'volcaniques']))))
      .toEqual(['A', 'D', 'E']);
  });

  it('ANDs the geology gate with the meteo filters', () => {
    // rain [2,0] band [10,60] keeps A (20) and C (48); dimming carbonatades
    // removes A, and D/E have no data → only C passes.
    const r = rain(2, 0, [10, 60]);
    expect(filterStationCodes(geoFeatures, [r], null, agg, geo(new Set(['carbonatades']))))
      .toEqual(['C']);
    // without the geology gate the same meteo filter keeps A + C
    expect(filterStationCodes(geoFeatures, [r], null, agg)).toEqual(['A', 'C']);
  });

  it('requires the grid: a dimmed set without a loaded grid constrains nothing', () => {
    expect(filterStationCodes(geoFeatures, [], null, agg,
      { off: new Set(['carbonatades']), grid: null })).toEqual([]);
    expect(filterStationCodes(geoFeatures, [], null, agg, undefined)).toEqual([]);
  });
});