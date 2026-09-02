import { describe, it, expect } from 'vitest';
import { classifyElevation, ALT_BAND_HIGHLIGHT, ALT_BAND_GREY } from './altitudeOverlay.js';

describe('classifyElevation', () => {
  it('highlights elevations inside the band', () => {
    expect(classifyElevation(800, 600, 1200)).toEqual(ALT_BAND_HIGHLIGHT);
  });

  it('greys elevations outside the band', () => {
    expect(classifyElevation(100, 600, 1200)).toEqual(ALT_BAND_GREY);
    expect(classifyElevation(2000, 600, 1200)).toEqual(ALT_BAND_GREY);
  });

  it('uses inclusive lower bound', () => {
    expect(classifyElevation(600, 600, 1200)).toEqual(ALT_BAND_HIGHLIGHT);
  });

  it('uses inclusive upper bound', () => {
    expect(classifyElevation(1200, 600, 1200)).toEqual(ALT_BAND_HIGHLIGHT);
  });

  it('handles a single-height band', () => {
    expect(classifyElevation(600, 600, 600)).toEqual(ALT_BAND_HIGHLIGHT);
    expect(classifyElevation(601, 600, 600)).toEqual(ALT_BAND_GREY);
  });
});