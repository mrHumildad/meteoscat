import { describe, it, expect } from 'vitest';
import { lngLatToTileXY } from './elevation.js';
import { TYPE_TO_VARIABLE } from './filterAggregate.js';
import {
  MATCH_ACTIVE_KEY,
  hasFilterConditions,
  normalizeFilterConfig,
  sampleMcscBand,
  matchesFilterGates,
  matchAreaFilters,
} from './areaFilterMatch.js';

const LAT = 41.9;
const LNG = 1.9;

// A stored config with nothing set — the shape buildFilterConfig produces.
const emptyConfig = () => ({
  reliefRange: null,
  meteoFilters: [],
  forestOff: [],
  geoOff: [],
  boletFilter: null,
});

const sample = (over = {}) => ({ lat: LAT, lng: LNG, elev: null, band: 0, familyKey: null, ...over });

describe('hasFilterConditions', () => {
  it('is false for an empty stack / nothing', () => {
    expect(hasFilterConditions(emptyConfig())).toBe(false);
    expect(hasFilterConditions(null)).toBe(false);
    expect(hasFilterConditions({})).toBe(false);
  });

  it('is true as soon as any area condition is set', () => {
    expect(hasFilterConditions({ ...emptyConfig(), reliefRange: [100, 200] })).toBe(true);
    expect(hasFilterConditions({ ...emptyConfig(), forestOff: ['341–355'] })).toBe(true);
    expect(hasFilterConditions({ ...emptyConfig(), geoOff: ['granit'] })).toBe(true);
    expect(hasFilterConditions({ ...emptyConfig(), meteoFilters: [{ type: 'rain' }] })).toBe(true);
  });

  it('ignores the bolet species rule (it never gates terrain)', () => {
    expect(hasFilterConditions({ ...emptyConfig(), boletFilter: { species: 'ceps' } })).toBe(false);
  });
});

describe('normalizeFilterConfig', () => {
  it('turns day offsets into concrete window dates and the type into a variable', () => {
    const config = normalizeFilterConfig({
      reliefRange: [800, 1500],
      meteoFilters: [{ type: 'rain', from: 10, to: 0, range: [1, 5] }],
      forestOff: ['341–355'],
      geoOff: ['granit'],
    }, '2026-09-11');

    expect(config.reliefRange).toEqual([800, 1500]);
    expect(config.forestOff).toEqual(['341–355']);
    expect(config.geoOff).toEqual(['granit']);
    expect(config.meteo).toEqual([{
      variable: TYPE_TO_VARIABLE.rain,
      from: '2026-09-01',
      to: '2026-09-11',
      band: [1, 5],
    }]);
  });

  it('drops meteo instances it cannot resolve instead of guessing', () => {
    expect(normalizeFilterConfig({
      ...emptyConfig(),
      meteoFilters: [{ type: 'wind', from: 5, to: 0, range: [1, 2] }],
    }, '2026-09-11').meteo).toEqual([]);

    // No reference day → no window can be dated.
    const noRef = normalizeFilterConfig({
      ...emptyConfig(),
      reliefRange: [0, 100],
      meteoFilters: [{ type: 'rain', from: 5, to: 0, range: [1, 2] }],
    }, null);
    expect(noRef.meteo).toEqual([]);
    expect(noRef.reliefRange).toEqual([0, 100]);
  });

  it('returns null for nothing and copies the arrays it reads', () => {
    expect(normalizeFilterConfig(null, '2026-09-11')).toBeNull();
    expect(normalizeFilterConfig(undefined)).toBeNull();

    const off = ['a'];
    const config = normalizeFilterConfig({ ...emptyConfig(), forestOff: off }, '2026-09-11');
    config.forestOff.push('b');
    expect(off).toEqual(['a']);
  });
});

describe('sampleMcscBand', () => {
  it('reads the band from the red channel of the tile pixel under the point', async () => {
    const width = 256;
    const height = 256;
    const data = new Uint8ClampedArray(width * height * 4);
    const { px, py } = lngLatToTileXY(LNG, LAT, 13);
    const i = (Math.floor(py) * width + Math.floor(px)) * 4;
    data[i] = 33;

    const band = await sampleMcscBand(LNG, LAT, 13, async () => ({ data, width, height }));
    expect(band).toBe(33);
    // No data (transparent pixel) reads as 0, never as NaN.
    expect(await sampleMcscBand(LNG, LAT, 13, async () => ({
      data: new Uint8ClampedArray(width * height * 4), width, height,
    }))).toBe(0);
  });
});

describe('matchesFilterGates', () => {
  const noConditions = { reliefRange: null, forestOff: [], geoOff: [], meteo: [] };

  it('lets every point through a filter with no conditions', () => {
    expect(matchesFilterGates(sample(), noConditions)).toBe(true);
    expect(matchesFilterGates({}, noConditions)).toBe(true);
  });

  it('requires a known, undimmed land-cover class when classes are dimmed', () => {
    const config = { ...noConditions, forestOff: ['341–355'] };
    expect(matchesFilterGates(sample({ band: 7 }), config)).toBe(true); // aciculifolis
    expect(matchesFilterGates(sample({ band: 22 }), config)).toBe(false); // zones urbanes
    expect(matchesFilterGates(sample({ band: 18 }), config)).toBe(false); // unlisted 230–234
    expect(matchesFilterGates(sample({ band: 0 }), config)).toBe(false); // no data
  });

  it('only excludes a dimmed substrate family when the point has one', () => {
    const config = { ...noConditions, geoOff: ['granit'] };
    expect(matchesFilterGates(sample({ familyKey: 'granit' }), config)).toBe(false);
    expect(matchesFilterGates(sample({ familyKey: 'calcar' }), config)).toBe(true);
    expect(matchesFilterGates(sample({ familyKey: null }), config)).toBe(true);
    // Nothing dimmed → family doesn't matter.
    expect(matchesFilterGates(sample({ familyKey: 'granit' }), noConditions)).toBe(true);
  });

  it('applies the altitude band to the point’s own DEM height', () => {
    const config = { ...noConditions, reliefRange: [800, 1500] };
    expect(matchesFilterGates(sample({ elev: 1200 }), config)).toBe(true);
    expect(matchesFilterGates(sample({ elev: 800 }), config)).toBe(true);
    expect(matchesFilterGates(sample({ elev: 700 }), config)).toBe(false);
    expect(matchesFilterGates(sample({ elev: null }), config)).toBe(false);
    expect(matchesFilterGates(sample({ elev: 0 }), config)).toBe(false); // sea level is not land
  });

  it('ANDs every meteo instance, and treats missing values as no match', () => {
    const config = {
      ...noConditions,
      meteo: [
        { variable: 'precAcc', from: 'a', to: 'b', band: [0, 20] },
        { variable: 'tempAvg', from: 'a', to: 'b', band: [10, 25] },
      ],
    };
    expect(matchesFilterGates(sample(), config, [10, 18])).toBe(true);
    expect(matchesFilterGates(sample(), config, [30, 18])).toBe(false);
    expect(matchesFilterGates(sample(), config, [10, 5])).toBe(false);
    expect(matchesFilterGates(sample(), config, [NaN, 18])).toBe(false);
    expect(matchesFilterGates(sample(), config, [10, undefined])).toBe(false);
    expect(matchesFilterGates(sample(), config, [])).toBe(false); // value never sampled
  });
});

describe('matchAreaFilters', () => {
  const samples = [
    sample({ elev: 900, band: 7, familyKey: 'granit' }),
    sample({ elev: 1600, band: 14, familyKey: null }),
    sample({ elev: null, band: 0, familyKey: null }),
  ];

  it('reports the share of points each filter covers, in the given order', () => {
    const rows = matchAreaFilters(samples, [
      { key: MATCH_ACTIVE_KEY, label: 'Filtre actiu', config: { reliefRange: [800, 1200], forestOff: [], geoOff: [], meteo: [] } },
      { key: 'Bolets alts', label: 'Bolets alts', config: { reliefRange: null, forestOff: [], geoOff: [], meteo: [] } },
    ], {});

    expect(rows.map(r => r.label)).toEqual(['Filtre actiu', 'Bolets alts']);
    // Only the 900 m sample is inside the band…
    expect(rows[0]).toMatchObject({ key: MATCH_ACTIVE_KEY, count: 1, total: 3 });
    expect(rows[0].share).toBeCloseTo(1 / 3, 6);
    // …while a filter with no conditions constrains nothing.
    expect(rows[1]).toMatchObject({ count: 3, total: 3 });
    expect(rows[1].share).toBe(1);
  });

  it('counts no point when the meteo data cannot be built', () => {
    const rows = matchAreaFilters(samples, [{
      key: 'pluja',
      label: 'pluja',
      config: {
        reliefRange: null,
        forestOff: [],
        geoOff: [],
        meteo: [{ variable: 'precAcc', from: '2026-09-01', to: '2026-09-11', band: [0, 100] }],
      },
    }], { agg: null, features: [] });
    expect(rows[0]).toMatchObject({ count: 0, total: 3, share: 0 });
  });

  it('handles an empty disc / no filters', () => {
    expect(matchAreaFilters([], [{ key: 'a', label: 'A', config: null }], {})[0].share).toBe(0);
    expect(matchAreaFilters(samples, [], {})).toEqual([]);
  });
});
