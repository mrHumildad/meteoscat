import { describe, it, expect } from 'vitest';
import { classifyElevation, ALT_BAND_TRANSPARENT, ALT_BAND_GREY } from './altitudeOverlay.js';

describe('classifyElevation', () => {
  it('keeps elevations inside the band transparent (area selector mask)', () => {
    expect(classifyElevation(800, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
  });

  it('greys land elevations outside the band', () => {
    expect(classifyElevation(100, 600, 1200)).toEqual(ALT_BAND_GREY);
    expect(classifyElevation(2000, 600, 1200)).toEqual(ALT_BAND_GREY);
  });

  it('uses inclusive lower bound', () => {
    expect(classifyElevation(600, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
  });

  it('uses inclusive upper bound', () => {
    expect(classifyElevation(1200, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
  });

  it('handles a single-height band', () => {
    expect(classifyElevation(600, 600, 600)).toEqual(ALT_BAND_TRANSPARENT);
    expect(classifyElevation(601, 600, 600)).toEqual(ALT_BAND_GREY);
  });

  it('never greys the sea: elevations <= 0 stay transparent', () => {
    expect(classifyElevation(0, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
    expect(classifyElevation(-77, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
    expect(classifyElevation(-32768, 600, 1200)).toEqual(ALT_BAND_TRANSPARENT);
  });
});