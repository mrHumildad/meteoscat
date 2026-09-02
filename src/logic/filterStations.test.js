import { describe, it, expect } from 'vitest';
import { filterStationCodes } from './filterStations.js';

// Stations mirror the shape produced by computeGeoValues.js:
// properties = { codi, tempAvg, humAvg, precAcc, altitud, ... }
const stations = [
  { properties: { codi: 'A', tempAvg: 10, humAvg: 60, precAcc: 20, altitud: 800 } },  // cool, mid-mountain
  { properties: { codi: 'B', tempAvg: 25, humAvg: 40, precAcc: 5, altitud: 100 } },   // hot, coastal
  { properties: { codi: 'C', tempAvg: 15, humAvg: 80, precAcc: 50, altitud: 500 } },  // wet & juicy
  { properties: { codi: 'D' } },                                                      // no data at all
  { properties: { codi: 'E', tempAvg: null, humAvg: null, precAcc: null, altitud: null } }, // explicit nulls
];

const limits = {
  tempMin: -5, tempMax: 30,
  humMin: 10, humMax: 90,
  rainMin: 0, rainMax: 100,
  altMin: 0, altMax: 2000
};
const fullRain = [limits.rainMin, limits.rainMax];
const fullHum = [limits.humMin, limits.humMax];
const fullTemp = [limits.tempMin, limits.tempMax];
const fullAlt = [limits.altMin, limits.altMax];

describe('filterStationCodes', () => {
  it('returns [] (no filtering) when every slider is at its full span', () => {
    expect(filterStationCodes(stations, fullRain, fullHum, fullTemp, fullAlt, limits)).toEqual([]);
  });

  it('returns [] for an empty station list', () => {
    expect(filterStationCodes([], [0, 50], [10, 90], [10, 20], fullAlt, limits)).toEqual([]);
  });

  it('matches station codes via the `codi` property (not `code`)', () => {
    const renamed = [
      ...stations,
      { properties: { code: 'F', tempAvg: 12, humAvg: 50, precAcc: 10, altitud: 300 } }
    ];
    const codes = filterStationCodes(renamed, [0, 30], [30, 90], [8, 14], fullAlt, limits);
    expect(codes).not.toContain('F'); // a feature with only `code` must be ignored
    expect(codes).toContain('A');     // matched via `codi`
  });

  it('keeps only stations inside the narrowed temperature range', () => {
    expect(filterStationCodes(stations, fullRain, fullHum, [12, 16], fullAlt, limits)).toEqual(['C']);
  });

  it('uses inclusive bounds (>= min, <= max)', () => {
    expect(filterStationCodes(stations, fullRain, fullHum, [10, 15], fullAlt, limits)).toEqual(['A', 'C']);
  });

  it('applies rain and humidity criteria together', () => {
    // rain >= 30 AND hum >= 70 => only C (50 mm, 80 %)
    expect(filterStationCodes(stations, [30, 100], [70, 90], fullTemp, fullAlt, limits)).toEqual(['C']);
  });

  it('excludes stations without data when filtering is active', () => {
    const codes = filterStationCodes(stations, [0, 60], fullHum, fullTemp, fullAlt, limits);
    expect(codes).toEqual(['A', 'B', 'C']);
    expect(codes).not.toContain('D');
    expect(codes).not.toContain('E');
  });

  it('returns [] when no station matches', () => {
    expect(filterStationCodes(stations, [0, 1], [10, 90], [10, 20], fullAlt, limits)).toEqual([]);
  });

  it('keeps only stations inside the narrowed altitude range (metres)', () => {
    // 600–900 m => only A (800 m); C (500 m) and B (100 m) are excluded
    expect(filterStationCodes(stations, fullRain, fullHum, fullTemp, [600, 900], limits)).toEqual(['A']);
  });

  it('applies altitude together with temperature', () => {
    // temp 10–15 °C AND 600–900 m => only A (10 °C, 800 m)
    expect(filterStationCodes(stations, fullRain, fullHum, [10, 15], [600, 900], limits)).toEqual(['A']);
  });

  it('uses inclusive altitude bounds (>= min, <= max)', () => {
    expect(filterStationCodes(stations, fullRain, fullHum, fullTemp, [100, 500], limits)).toEqual(['B', 'C']);
  });

  it('excludes stations lacking altitud when filtering is active', () => {
    const noAlt = [
      ...stations,
      { properties: { codi: 'G', tempAvg: 12, humAvg: 50, precAcc: 10 } } // no altitud
    ];
    const codes = filterStationCodes(noAlt, fullRain, fullHum, fullTemp, [0, 300], limits);
    expect(codes).toEqual(['B']);
    expect(codes).not.toContain('G');
  });
});