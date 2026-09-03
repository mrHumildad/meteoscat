import { describe, it, expect } from 'vitest';
import { classifyMeteoValue, parseMeteoTileUrl, METEO_BAND_TRANSPARENT, METEO_BAND_GREY } from './meteoOverlay.js';

describe('parseMeteoTileUrl', () => {
  it('parses variable, window and band from the tile URL', () => {
    expect(parseMeteoTileUrl('meteo://5/10/20?v=precAcc&w=2026-09-01-2026-09-02&b=5.5_20.3')).toEqual({
      z: 5, x: 10, y: 20,
      variable: 'precAcc',
      windowKey: '2026-09-01-2026-09-02',
      band: [5.5, 20.3],
    });
  });

  it('parses negative band values unambiguously (winter temperatures)', () => {
    expect(parseMeteoTileUrl('meteo://8/3/9?v=tempAvg&w=w&b=-5_10').band).toEqual([-5, 10]);
  });

  it('treats v=off as no variable and no band', () => {
    expect(parseMeteoTileUrl('meteo://8/3/9?v=off')).toEqual({
      z: 8, x: 3, y: 9,
      variable: null,
      windowKey: '',
      band: null,
    });
  });

  it('rejects unrecognised URLs', () => {
    expect(parseMeteoTileUrl('alt://8/3/9?b=1-2')).toBeNull();
    expect(parseMeteoTileUrl('')).toBeNull();
  });
});

describe('classifyMeteoValue', () => {
  it('keeps values inside the band transparent (area selector mask)', () => {
    expect(classifyMeteoValue(15, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
  });

  it('greys values outside the band', () => {
    expect(classifyMeteoValue(5, 10, 20)).toEqual(METEO_BAND_GREY);
    expect(classifyMeteoValue(25, 10, 20)).toEqual(METEO_BAND_GREY);
  });

  it('uses inclusive bounds', () => {
    expect(classifyMeteoValue(10, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
    expect(classifyMeteoValue(20, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
  });

  it('handles a single-value band', () => {
    expect(classifyMeteoValue(15, 15, 15)).toEqual(METEO_BAND_TRANSPARENT);
    expect(classifyMeteoValue(15.1, 15, 15)).toEqual(METEO_BAND_GREY);
  });

  it('keeps no-data (NaN) values transparent, like sea / beyond-station-reach', () => {
    expect(classifyMeteoValue(NaN, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
    expect(classifyMeteoValue(Infinity, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
    expect(classifyMeteoValue(-Infinity, 10, 20)).toEqual(METEO_BAND_TRANSPARENT);
  });
});