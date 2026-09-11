import { describe, it, expect } from 'vitest';
import {
  bearingDeg,
  compassDirection,
  distanceKm,
  nearestStations,
} from './nearestStations.js';

const station = (codi, nom, lng, lat, extra = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { codi, nom, ...extra },
});

describe('distanceKm', () => {
  it('is zero for the same point', () => {
    expect(distanceKm(1.9, 41.9, 1.9, 41.9)).toBe(0);
  });

  it('matches the ~111 km degree of latitude', () => {
    expect(distanceKm(0, 0, 0, 1)).toBeCloseTo(111.19, 1);
  });

  it('shrinks an east–west degree by cos(latitude)', () => {
    expect(distanceKm(0, 60, 1, 60)).toBeCloseTo(55.6, 1);
  });
});

describe('bearingDeg', () => {
  it('reads the four cardinals clockwise from north', () => {
    expect(bearingDeg(0, 0, 0, 1)).toBeCloseTo(0, 5);    // north
    expect(bearingDeg(0, 0, 1, 0)).toBeCloseTo(90, 5);   // east
    expect(bearingDeg(0, 1, 0, 0)).toBeCloseTo(180, 5);  // south
    expect(bearingDeg(1, 0, 0, 0)).toBeCloseTo(270, 5);  // west
  });
});

describe('compassDirection', () => {
  it('maps bearings to the 8 Catalan sectors, centred on the cardinals', () => {
    expect(compassDirection(0)).toBe('N');
    expect(compassDirection(350)).toBe('N');
    expect(compassDirection(45)).toBe('NE');
    expect(compassDirection(90)).toBe('E');
    expect(compassDirection(135)).toBe('SE');
    expect(compassDirection(180)).toBe('S');
    expect(compassDirection(225)).toBe('SO');
    expect(compassDirection(270)).toBe('O');
    expect(compassDirection(315)).toBe('NO');
    expect(compassDirection(NaN)).toBe(null);
  });
});

describe('nearestStations', () => {
  const features = [
    station('A', 'Alpha', 0.01, 0, { municipi: 'Poble A', comarca: 'Comarca A' }),
    station('B', 'Beta', 0, 0.02, { municipi: 'Poble B', comarca: 'Comarca B' }),
    station('C', 'Gamma', -0.03, 0, { municipi: 'Poble C', comarca: 'Comarca C' }),
  ];

  it('sorts nearest first and carries distance, direction, poble and comarca', () => {
    const [a, b, c] = nearestStations(features, 0, 0, 3);
    expect(a.code).toBe('A');
    expect(a.direction).toBe('E');
    expect(a.municipi).toBe('Poble A');
    expect(a.comarca).toBe('Comarca A');
    expect(a.distanceKm).toBeLessThan(b.distanceKm);
    expect(b.code).toBe('B');
    expect(b.direction).toBe('N');
    expect(c.code).toBe('C');
    expect(c.direction).toBe('O');
  });

  it('honours the limit', () => {
    expect(nearestStations(features, 0, 0, 2).map(s => s.code)).toEqual(['A', 'B']);
  });

  it('skips features without usable coordinates', () => {
    const dirty = [
      station('X', 'Bad', null, null),
      { type: 'Feature', geometry: null, properties: { codi: 'Y' } },
      ...features,
    ];
    expect(nearestStations(dirty, 0, 0, 5).map(s => s.code)).toEqual(['A', 'B', 'C']);
  });

  it('returns an empty list for missing input', () => {
    expect(nearestStations(null, 0, 0)).toEqual([]);
    expect(nearestStations(features, NaN, 0)).toEqual([]);
    expect(nearestStations(features, 0, 0, 0)).toEqual([]);
  });
});
