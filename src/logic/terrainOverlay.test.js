// Pure + integration tests for the stacked terrain overlay (terrain://):
// class colours are painted only where EVERY active condition passes — a
// selected MCSC class AND the altitude band AND every meteo instance — with
// failing pixels transparent so the relief shows through. Water classes are
// never gated (water is not "mushroom terrain").
import { describe, it, expect } from 'vitest';
import {
  TERRAIN_TRANSPARENT,
  colourForBand,
  classifyTerrainPixel,
  terrainStateSig,
  terrainStateSignature,
  terrainTileUrl,
  parseTerrainTileUrl,
} from './terrainOverlay.js';

describe('colourForBand', () => {
  it('returns the official class colour when the band is selected', () => {
    expect(colourForBand(7)).toEqual([51, 204, 51, 255]);    // aciculifolis '#33cc33'
    expect(colourForBand(36)).toEqual([0, 0, 128, 255]);     // aigües '#000080'
    expect(colourForBand(41)).toEqual([0, 0, 128, 255]);     // aigües (466)
  });

  it('returns null for no data and permanently-unlisted 230–234 values', () => {
    expect(colourForBand(0)).toBeNull();
    expect(colourForBand(16)).toBeNull(); // 230 sòl nu forestal
    expect(colourForBand(18)).toBeNull(); // 232 roquissars
    expect(colourForBand(20)).toBeNull(); // 234 zones humides
  });

  it('returns null for a dimmed class (its legend entry is off)', () => {
    const off = new Set(['221/225', '461–466']);
    expect(colourForBand(7, off)).toBeNull();   // aciculifolis
    expect(colourForBand(11, off)).toBeNull();  // aciculifolis (clar)
    expect(colourForBand(36, off)).toBeNull();  // aigües
    expect(colourForBand(8)).toEqual([102, 255, 51, 255]); // caducifolis stays on
  });
});

describe('classifyTerrainPixel', () => {
  const green = [51, 204, 51, 255];
  const water = [0, 0, 128, 255];

  it('stays transparent when the class is not selected (no colour)', () => {
    expect(classifyTerrainPixel(null, false, 100, null, [], [], [])).toEqual(TERRAIN_TRANSPARENT);
    expect(classifyTerrainPixel(null, true, 100, null, [], [], [])).toEqual(TERRAIN_TRANSPARENT);
  });

  it('paints a selected land class when nothing constrains', () => {
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [])).toEqual(green);
  });

  it('paints water whenever its class is selected, regardless of every filter', () => {
    // water + failing altitude band + failing meteo instance → still painted
    expect(classifyTerrainPixel(water, true, 0, [500, 800], [5], [10], [20])).toEqual(water);
    expect(classifyTerrainPixel(water, true, NaN, [500, 800], [NaN], [10], [20])).toEqual(water);
  });

  it('gates land by the inclusive altitude band (sea / no-data excluded)', () => {
    expect(classifyTerrainPixel(green, false, 700, [500, 800], [], [], [])).toEqual(green);
    expect(classifyTerrainPixel(green, false, 700, [500, 800], [700], [500], [800])).toEqual(green);
    expect(classifyTerrainPixel(green, false, 900, [500, 800], [], [], [])).toEqual(TERRAIN_TRANSPARENT);
    expect(classifyTerrainPixel(green, false, 0, [500, 800], [], [], [])).toEqual(TERRAIN_TRANSPARENT); // sea
    expect(classifyTerrainPixel(green, false, NaN, [500, 800], [], [], [])).toEqual(TERRAIN_TRANSPARENT);
    expect(classifyTerrainPixel(green, false, -12, [500, 800], [], [], [])).toEqual(TERRAIN_TRANSPARENT);
    // inclusive lower bound
    expect(classifyTerrainPixel(green, false, 500, [500, 800], [], [], [])).toEqual(green);
  });

  it('gates land by every meteo instance band (AND), inclusive', () => {
    // two instances: bands [0, 20] and [50, 60]  →  los = [0, 50], his = [20, 60]
    // all inside → painted
    expect(classifyTerrainPixel(green, false, 100, null, [10, 55], [0, 50], [20, 60])).toEqual(green);
    // one outside → transparent
    expect(classifyTerrainPixel(green, false, 100, null, [10, 61], [0, 50], [20, 60])).toEqual(TERRAIN_TRANSPARENT);
    expect(classifyTerrainPixel(green, false, 100, null, [10, 49], [0, 50], [20, 60])).toEqual(TERRAIN_TRANSPARENT);
    // no data (NaN) → transparent
    expect(classifyTerrainPixel(green, false, 100, null, [NaN], [0], [20])).toEqual(TERRAIN_TRANSPARENT);
    // exact bounds pass
    expect(classifyTerrainPixel(green, false, 100, null, [0, 50], [0, 50], [20, 60])).toEqual(green);
    expect(classifyTerrainPixel(green, false, 100, null, [20, 60], [0, 50], [20, 60])).toEqual(green);
  });

  it('requires ALL conditions together (altitude AND meteo)', () => {
    const all = classifyTerrainPixel(green, false, 700, [500, 800], [10], [0], [20]);
    expect(all).toEqual(green);
    // altitude fails while meteo passes
    expect(classifyTerrainPixel(green, false, 900, [500, 800], [10], [0], [20])).toEqual(TERRAIN_TRANSPARENT);
    // meteo fails while altitude passes
    expect(classifyTerrainPixel(green, false, 700, [500, 800], [30], [0], [20])).toEqual(TERRAIN_TRANSPARENT);
  });

  it('gates land by the geology family (dimmed keys), nodata never gated', () => {
    const offCarbons = new Set(['carbonatades']);
    // pixel on a dimmed family → transparent (same contract as a dimmed class)
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [], 'carbonatades', offCarbons))
      .toEqual(TERRAIN_TRANSPARENT);
    // a different family, or no family at all (nodata) → passes
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [], 'volcaniques', offCarbons))
      .toEqual(green);
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [], null, offCarbons))
      .toEqual(green);
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [], undefined, offCarbons))
      .toEqual(green);
    // no dimmed families at all → passes
    expect(classifyTerrainPixel(green, false, 100, null, [], [], [], 'carbonatades', new Set()))
      .toEqual(green);
    // water is NEVER gated by the geology filter
    expect(classifyTerrainPixel(water, true, 100, null, [], [], [], 'carbonatades', offCarbons))
      .toEqual(water);
  });

  it('requires the geology family AND altitude AND meteo all together', () => {
    const offCarbons = new Set(['carbonatades']);
    expect(classifyTerrainPixel(green, false, 700, [500, 800], [10], [0], [20], 'volcaniques', offCarbons))
      .toEqual(green);
    // family off while everything else passes
    expect(classifyTerrainPixel(green, false, 700, [500, 800], [10], [0], [20], 'carbonatades', offCarbons))
      .toEqual(TERRAIN_TRANSPARENT);
    // family on but altitude fails
    expect(classifyTerrainPixel(green, false, 900, [500, 800], [10], [0], [20], 'volcaniques', offCarbons))
      .toEqual(TERRAIN_TRANSPARENT);
  });
});

describe('terrain state signature & tile URL', () => {
  it('produces a stable signature for an empty state', () => {
    expect(terrainStateSig(terrainStateSignature())).toBe(
      terrainStateSig(terrainStateSignature({ off: [], alt: null, filters: [], geoOff: [] }))
    );
  });

  it('is insensitive to ordering (sorted codes / filters)', () => {
    const a = terrainStateSig(terrainStateSignature({
      off: ['b', 'a'],
      alt: [100, 500],
      filters: [
        { variable: 'precAcc', from: '2026-08-01', to: '2026-09-01', band: [10, 20] },
        { variable: 'tempAvg', from: '2026-08-15', to: '2026-09-01', band: [-5, 5] },
      ],
    }));
    const b = terrainStateSig(terrainStateSignature({
      off: ['a', 'b'],
      alt: [100, 500],
      filters: [
        { variable: 'tempAvg', from: '2026-08-15', to: '2026-09-01', band: [-5, 5] },
        { variable: 'precAcc', from: '2026-08-01', to: '2026-09-01', band: [10, 20] },
      ],
    }));
    expect(a).toBe(b);
  });

  it('changes when the filters change', () => {
    const base = { off: [], alt: null, filters: [], geoOff: [] };
    expect(terrainTileUrl(base)).not.toBe(terrainTileUrl({
      off: [], alt: [0, 100], geoOff: [], filters: [{ variable: 'precAcc', from: '2026-08-01', to: '2026-09-01', band: [10, 20] }],
    }));
  });

  it('changes when the dimmed geology families change (and is order-insensitive)', () => {
    const a = terrainTileUrl({ mode: 'substrate', off: [], alt: null, geoOff: ['gresos', 'carbonatades'], filters: [] });
    const b = terrainTileUrl({ mode: 'substrate', off: [], alt: null, geoOff: ['carbonatades', 'gresos'], filters: [] });
    const c = terrainTileUrl({ mode: 'substrate', off: [], alt: null, geoOff: ['gresos'], filters: [] });
    expect(a).toBe(b); // same dimmed set, different order
    expect(a).not.toBe(c);
    expect(a).not.toBe(terrainTileUrl({ mode: 'substrate', off: [], alt: null, geoOff: [], filters: [] }));
  });

  it('changes when the rendering mode changes (terrain vs substrate)', () => {
    const base = { mode: 'terrain', off: [], alt: null, filters: [], geoOff: [] };
    expect(terrainTileUrl(base)).not.toBe(terrainTileUrl({ ...base, mode: 'substrate' }));
    // an absent mode canonicalises to 'terrain'
    expect(terrainStateSig(terrainStateSignature(base))).toBe(
      terrainStateSig(terrainStateSignature({ off: [], alt: null, filters: [] }))
    );
  });

  it('embeds an encoded state token and parses it back', () => {
    const url = terrainTileUrl({ off: ['221/225'], alt: [100, 500], filters: [] });
    expect(url).toMatch(/^terrain:\/\/\{z\}\/\{x\}\/\{y\}\?s=/);
    expect(parseTerrainTileUrl('terrain://5/10/20?s=abc%7B%7D')).toEqual({ z: 5, x: 10, y: 20 });
    expect(parseTerrainTileUrl('terrain://5/10/20')).toEqual({ z: 5, x: 10, y: 20 });
  });

  it('rejects malformed and non-terrain URLs', () => {
    expect(parseTerrainTileUrl('alt://8/3/9?b=1-2')).toBeNull();
    expect(parseTerrainTileUrl('terrain://8/3')).toBeNull();
    expect(parseTerrainTileUrl('')).toBeNull();
    expect(parseTerrainTileUrl('terrain://8/3/9?s=a&x=1')).toBeNull();
  });
});
