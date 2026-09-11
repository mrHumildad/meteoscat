import { describe, it, expect } from 'vitest';
import {
  SAVED_LOCATIONS_KEY,
  SAVED_LOCATIONS_MAX,
  suggestLocationName,
  buildLocation,
  describeSavedLocation,
  readSavedLocations,
  writeSavedLocations,
  saveLocation,
  removeSavedLocation,
} from './savedLocations.js';

// Minimal in-memory Storage stand-in: the module only ever uses getItem /
// setItem, so the tests need no jsdom.
const fakeStorage = (initial) => {
  const map = new Map();
  if (initial != null) map.set(SAVED_LOCATIONS_KEY, initial);
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
    raw: () => map.get(SAVED_LOCATIONS_KEY) ?? null,
  };
};

const throwingStorage = {
  getItem: () => { throw new Error('denied'); },
  setItem: () => { throw new Error('denied'); },
};

const POINT = { lat: 41.9, lng: 1.9, elevation: 512 };

describe('suggestLocationName', () => {
  it('suggests the nearest station municipality as the toponym', () => {
    expect(suggestLocationName([
      { name: 'Vinebre', municipi: 'Vinebre', comarca: 'Ribera' },
      { name: 'Margalef', municipi: 'Margalef', comarca: 'Priorat' },
    ])).toBe('Vinebre');
  });

  it('falls back to the station name then the comarca', () => {
    expect(suggestLocationName([{ name: 'Vinebre', municipi: null }])).toBe('Vinebre');
    expect(suggestLocationName([{ name: null, municipi: '', comarca: 'Priorat' }])).toBe('Priorat');
  });

  it('is empty when there is no nearest station', () => {
    expect(suggestLocationName([])).toBe('');
    expect(suggestLocationName(null)).toBe('');
  });
});

describe('buildLocation', () => {
  it('trims the name / description and keeps the point', () => {
    expect(buildLocation({ name: '  Mas Vilar ', description: '  sota el roure ', ...POINT }))
      .toEqual({
        name: 'Mas Vilar',
        description: 'sota el roure',
        lat: 41.9,
        lng: 1.9,
        elevation: 512,
      });
  });

  it('leaves an unknown elevation null and refuses a nameless / coordless point', () => {
    expect(buildLocation({ name: 'x', lat: 1, lng: 2 }).elevation).toBeNull();
    expect(buildLocation({ name: '  ', lat: 1, lng: 2 })).toBeNull();
    expect(buildLocation({ name: 'x', lat: NaN, lng: 2 })).toBeNull();
    expect(buildLocation()).toBeNull();
  });
});

describe('describeSavedLocation', () => {
  it('renders coordinates with the altitude when known', () => {
    expect(describeSavedLocation({ lat: 41.9, lng: 1.9, elevation: 512 }))
      .toBe('41.90000, 1.90000 · 512 m');
    expect(describeSavedLocation({ lat: 41.9, lng: 1.9, elevation: null }))
      .toBe('41.90000, 1.90000');
  });

  it('is empty without usable coordinates', () => {
    expect(describeSavedLocation(null)).toBe('');
    expect(describeSavedLocation({ lat: NaN, lng: 1 })).toBe('');
  });
});

describe('readSavedLocations', () => {
  it('reads back what was written, newest first', () => {
    const store = fakeStorage();
    saveLocation('primer', POINT, store);
    const list = saveLocation('segon', { lat: 42, lng: 2 }, store);

    expect(list.map(l => l.name)).toEqual(['segon', 'primer']);
    expect(readSavedLocations(store).map(l => l.name)).toEqual(['segon', 'primer']);
    expect(typeof list[0].savedAt).toBe('number');
  });

  it('a repeated name overwrites its previous entry instead of duplicating', () => {
    const store = fakeStorage();
    saveLocation('meu', { lat: 1, lng: 1 }, store);
    saveLocation('altre', POINT, store);
    const list = saveLocation('meu', { lat: 2, lng: 2, description: 'nou' }, store);

    expect(list.map(l => l.name)).toEqual(['meu', 'altre']);
    expect(list[0].lat).toBe(2);
    expect(list[0].description).toBe('nou');
  });

  it('caps the list', () => {
    const store = fakeStorage();
    for (let i = 0; i < SAVED_LOCATIONS_MAX + 5; i++) saveLocation(`lloc-${i}`, POINT, store);
    expect(readSavedLocations(store)).toHaveLength(SAVED_LOCATIONS_MAX);
  });

  it('drops malformed payloads / entries and never throws', () => {
    expect(readSavedLocations(fakeStorage())).toEqual([]);
    expect(readSavedLocations(fakeStorage('not json {'))).toEqual([]);
    expect(readSavedLocations(fakeStorage('{"a":1}'))).toEqual([]);
    expect(readSavedLocations(fakeStorage(
      '[null, {"name":1,"lat":1,"lng":1}, {"name":"ok","lat":1,"lng":2}, {"name":"noc","lat":null,"lng":2}]',
    )).map(l => l.name)).toEqual(['ok']);
    expect(readSavedLocations(throwingStorage)).toEqual([]);
    expect(writeSavedLocations([{ name: 'x', lat: 1, lng: 1 }], throwingStorage)).toBe(false);
  });
});

describe('saveLocation', () => {
  it('trims the name and refuses a blank one', () => {
    const store = fakeStorage();
    const list = saveLocation('  bosc  ', POINT, store);
    expect(list[0].name).toBe('bosc');
    expect(saveLocation('   ', POINT, store)).toEqual(list);
    expect(saveLocation(null, POINT, store)).toEqual(list);
  });

  it('still reports the list when storage itself refuses', () => {
    const list = saveLocation('sense-storage', POINT, throwingStorage);
    expect(list.map(l => l.name)).toEqual(['sense-storage']);
    expect(readSavedLocations(throwingStorage)).toEqual([]);
  });
});

describe('removeSavedLocation', () => {
  it('removes one entry by name, leaving the rest', () => {
    const store = fakeStorage();
    saveLocation('a', POINT, store);
    saveLocation('b', { lat: 2, lng: 2 }, store);

    expect(removeSavedLocation('a', store).map(l => l.name)).toEqual(['b']);
    expect(readSavedLocations(store).map(l => l.name)).toEqual(['b']);
  });
});
