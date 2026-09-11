import { describe, it, expect } from 'vitest';
import {
  SAVED_FILTERS_KEY,
  buildFilterConfig,
  describeFilterConfig,
  sameFilterConfig,
  readSavedFilters,
  writeSavedFilters,
  saveFilterPreset,
  removeSavedFilter,
} from './savedFilters.js';

// Minimal in-memory Storage stand-in: the module only ever uses getItem /
// setItem, so the tests need no jsdom.
const fakeStorage = (initial) => {
  const map = new Map();
  if (initial != null) map.set(SAVED_FILTERS_KEY, initial);
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    raw: () => map.get(SAVED_FILTERS_KEY) ?? null,
  };
};

const throwingStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

describe('buildFilterConfig', () => {
  it('snapshots the filter stack as plain sorted JSON', () => {
    const config = buildFilterConfig({
      reliefRange: [100, 600],
      meteoFilters: [
        { id: 'f7', type: 'rain', from: 10, to: 0, range: [1, 20.5] },
        { id: 'f8', type: 'hum', from: 5, to: 2, range: [40, 80] },
      ],
      forestOff: new Set(['223/227', '111–116']),
      geoOff: new Set(['volcaniques', 'carbonatades']),
      boletFilter: { species: 'ceps', threshold: 0.7 },
    });

    expect(config).toEqual({
      reliefRange: [100, 600],
      meteoFilters: [
        { type: 'rain', from: 10, to: 0, range: [1, 20.5] },
        { type: 'hum', from: 5, to: 2, range: [40, 80] },
      ],
      forestOff: ['111–116', '223/227'],
      geoOff: ['carbonatades', 'volcaniques'],
      boletFilter: { species: 'ceps', threshold: 0.7 },
    });
    // Instance ids are session counters and must not travel with the preset.
    expect(config.meteoFilters.some(f => 'id' in f)).toBe(false);
  });

  it('represents an empty / off state with nulls and empty arrays', () => {
    expect(buildFilterConfig()).toEqual({
      reliefRange: null,
      meteoFilters: [],
      forestOff: [],
      geoOff: [],
      boletFilter: null,
    });
  });
});

describe('readSavedFilters', () => {
  it('reads back what was written, newest first', () => {
    const store = fakeStorage();
    saveFilterPreset('primer', buildFilterConfig(), store);
    const list = saveFilterPreset('segon', buildFilterConfig({ reliefRange: [0, 100] }), store);

    expect(list.map(p => p.name)).toEqual(['segon', 'primer']);
    expect(readSavedFilters(store).map(p => p.name)).toEqual(['segon', 'primer']);
    expect(list[1].config).toEqual(buildFilterConfig());
    expect(typeof list[0].savedAt).toBe('number');
  });

  it('overwrites an existing name instead of duplicating it', () => {
    const store = fakeStorage();
    saveFilterPreset('meu', buildFilterConfig({ reliefRange: [10, 20] }), store);
    const list = saveFilterPreset('meu', buildFilterConfig({ reliefRange: [30, 40] }), store);

    expect(list).toHaveLength(1);
    expect(list[0].config.reliefRange).toEqual([30, 40]);
  });

  it('keeps the last preset first after an overwrite', () => {
    const store = fakeStorage();
    saveFilterPreset('a', buildFilterConfig(), store);
    saveFilterPreset('b', buildFilterConfig(), store);
    const list = saveFilterPreset('a', buildFilterConfig({ reliefRange: [1, 2] }), store);

    expect(list.map(p => p.name)).toEqual(['a', 'b']);
  });

  it('returns [] for missing, corrupt or non-array payloads', () => {
    expect(readSavedFilters(fakeStorage())).toEqual([]);
    expect(readSavedFilters(fakeStorage('not json {'))).toEqual([]);
    expect(readSavedFilters(fakeStorage('{"a":1}'))).toEqual([]);
    expect(readSavedFilters(fakeStorage('[null, {"name":1}, {"name":"ok","config":{}}]')))
      .toEqual([{ name: 'ok', config: {} }]);
  });

  it('survives storage that throws', () => {
    expect(readSavedFilters(throwingStorage)).toEqual([]);
    expect(writeSavedFilters([{ name: 'x', config: {} }], throwingStorage)).toBe(false);
  });
});

describe('saveFilterPreset', () => {
  it('trims the name and ignores a blank one', () => {
    const store = fakeStorage();
    const list = saveFilterPreset('  bosc  ', buildFilterConfig(), store);
    expect(list[0].name).toBe('bosc');

    expect(saveFilterPreset('   ', buildFilterConfig(), store)).toEqual(list);
    expect(saveFilterPreset(null, buildFilterConfig(), store)).toEqual(list);
  });

  it('still returns the in-memory list when persistence is refused', () => {
    const list = saveFilterPreset('sense-storage', buildFilterConfig(), throwingStorage);
    expect(list.map(p => p.name)).toEqual(['sense-storage']);
  });
});

describe('removeSavedFilter', () => {
  it('removes one preset by name and leaves the rest', () => {
    const store = fakeStorage();
    saveFilterPreset('a', buildFilterConfig(), store);
    saveFilterPreset('b', buildFilterConfig(), store);

    expect(removeSavedFilter('a', store).map(p => p.name)).toEqual(['b']);
    expect(readSavedFilters(store).map(p => p.name)).toEqual(['b']);
  });
});

describe('sameFilterConfig', () => {
  const base = buildFilterConfig({
    reliefRange: [100, 600],
    meteoFilters: [{ id: 'f1', type: 'rain', from: 10, to: 0, range: [1, 5] }],
    forestOff: new Set(['221/225', '222/226']),
    geoOff: new Set(['carbonatades']),
    boletFilter: { species: 'ceps', threshold: 0.5 },
  });

  it('matches an equivalent snapshot (id-free, sorted sets)', () => {
    const same = buildFilterConfig({
      reliefRange: [100, 600],
      meteoFilters: [{ type: 'rain', from: 10, to: 0, range: [1, 5] }],
      forestOff: new Set(['222/226', '221/225']),
      geoOff: new Set(['carbonatades']),
      boletFilter: { species: 'ceps', threshold: 0.5 },
    });
    expect(sameFilterConfig(base, same)).toBe(true);
  });

  it('detects a changed value band, window, dim list or species', () => {
    const tweak = patch => ({ ...base, ...patch });
    expect(sameFilterConfig(base, tweak({
      meteoFilters: [{ type: 'rain', from: 10, to: 0, range: [1, 6] }],
    }))).toBe(false);
    expect(sameFilterConfig(base, tweak({
      meteoFilters: [{ type: 'rain', from: 9, to: 0, range: [1, 5] }],
    }))).toBe(false);
    expect(sameFilterConfig(base, tweak({ meteoFilters: [] }))).toBe(false);
    expect(sameFilterConfig(base, tweak({ reliefRange: null }))).toBe(false);
    expect(sameFilterConfig(base, tweak({ forestOff: ['221/225'] }))).toBe(false);
    expect(sameFilterConfig(base, tweak({ geoOff: [] }))).toBe(false);
    expect(sameFilterConfig(base, tweak({ boletFilter: { species: 'ceps', threshold: 0.6 } }))).toBe(false);
  });

  it('treats a missing side as unequal and two empties as equal', () => {
    expect(sameFilterConfig(base, null)).toBe(false);
    expect(sameFilterConfig(null, base)).toBe(false);
    expect(sameFilterConfig(buildFilterConfig(), buildFilterConfig())).toBe(true);
  });
});

describe('describeFilterConfig', () => {
  it('summarises each part of the stack in panel wording', () => {
    const config = buildFilterConfig({
      reliefRange: [100, 600],
      meteoFilters: [
        { id: 'f1', type: 'rain', from: 10, to: 0, range: [0, 5] },
        { id: 'f2', type: 'rain', from: 5, to: 0, range: [1, 2] },
        { id: 'f3', type: 'temp', from: 3, to: 0, range: [5, 9] },
      ],
      forestOff: new Set(['221/225', '222/226']),
      geoOff: new Set(['carbonatades']),
      boletFilter: { species: 'ceps', threshold: 0.5 },
    });

    expect(describeFilterConfig(config)).toBe(
      '2× Pluja · Temperatura · Relleu 100–600 m · Bosc (2) · Substrat · Bolets ceps',
    );
  });

  it('says "Sense filtres" for an empty preset and tolerates junk', () => {
    expect(describeFilterConfig(buildFilterConfig())).toBe('Sense filtres');
    expect(describeFilterConfig(null)).toBe('');
    expect(describeFilterConfig({ meteoFilters: [{ type: 'unknown' }] })).toBe('Sense filtres');
  });
});
