import { describe, it, expect } from 'vitest';
import {
  MCSC_LEGEND,
  MCSC_GREY,
  MCSC_EXTRA_VALUES,
  MCSC_BAND_MIN,
  MCSC_BAND_MAX,
  MCSC_WATER_VALUES,
  entryForBand,
  isWaterBand,
  renderBandSld,
} from './mcscLegend.js';

describe('MCSC_LEGEND', () => {
  it('covers the three mushroom-relevant forest types plus key non-forest covers', () => {
    const labels = MCSC_LEGEND.map(e => e.label).join(' ');
    expect(labels).toContain('aciculifolis');     // pines / firs
    expect(labels).toContain('caducifolis');      // oaks / beech
    expect(labels).toContain('esclerofil');       // holm oak / cork oak
    expect(labels).toContain('ribera');           // riparian
    expect(labels).toContain('Matollar');
    expect(labels).toContain('Prats');
    expect(labels).toContain('Conreus');
    expect(labels).toContain('urbanes');
    expect(labels).toContain('Aigües');
  });

  it('uses valid 6-digit hex colours, including the shared legend-switch grey', () => {
    for (const e of MCSC_LEGEND) {
      expect(e.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // MCSC_GREY is now only the legend-UI swatch for a dimmed class — the MAP
    // paints dimmed classes transparent (see renderBandSld / terrainOverlay).
    expect(MCSC_GREY).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('has a unique label per entry', () => {
    const labels = MCSC_LEGEND.map(e => e.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(MCSC_LEGEND.length).toBe(9);
  });

  it('maps every entry to its MCSC raster band values (palette order)', () => {
    const byCodes = Object.fromEntries(MCSC_LEGEND.map(e => [e.codes, e.values]));
    expect(byCodes['221/225']).toEqual([7, 11]);            // aciculifolis (dens / clar)
    expect(byCodes['222/226']).toEqual([8, 12]);            // caducifolis
    expect(byCodes['223/227']).toEqual([9, 13]);            // esclerofil·les
    expect(byCodes['229']).toEqual([15]);                   // bosc de ribera
    expect(byCodes['224']).toEqual([10]);                   // matollar
    expect(byCodes['228']).toEqual([14]);                   // prats i herbassars
    expect(byCodes['111–116']).toEqual([1, 2, 3, 4, 5, 6]); // conreus
    expect(byCodes['341–355']).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35]);
    expect(byCodes['461–466']).toEqual([36, 37, 38, 39, 40, 41]);
  });
});

describe('band lookups', () => {
  it('entryForBand resolves legend bands to their entry and extras to null', () => {
    expect(entryForBand(7).codes).toBe('221/225');     // aciculifolis
    expect(entryForBand(36).codes).toBe('461–466');    // aigües
    for (const v of MCSC_EXTRA_VALUES) {
      expect(entryForBand(v)).toBeNull();              // 230–234: no legend entry
    }
    expect(entryForBand(0)).toBeNull();
    expect(entryForBand(MCSC_BAND_MAX + 1)).toBeNull();
  });

  it('isWaterBand is true exactly for the Aigües entry bands', () => {
    for (const v of MCSC_WATER_VALUES) expect(isWaterBand(v)).toBe(true);
    expect(isWaterBand(7)).toBe(false);   // forest
    expect(isWaterBand(0)).toBe(false);
    expect(MCSC_WATER_VALUES).toEqual([36, 37, 38, 39, 40, 41]);
  });
});

describe('renderBandSld', () => {
  it('encodes every raster band value as its own red-channel colour (rgb(v,0,0))', () => {
    const sld = renderBandSld();
    for (let v = MCSC_BAND_MIN; v <= MCSC_BAND_MAX; v++) {
      const hex = v.toString(16).padStart(2, '0');
      expect(sld).toContain(`color="#${hex}0000" quantity="${v}"`);
    }
  });

  it('contains no legend colours and no grey — the server never colours pixels', () => {
    const sld = renderBandSld();
    for (const e of MCSC_LEGEND) {
      expect(sld).not.toContain(`color="${e.color}"`);
    }
    expect(sld).not.toContain(`color="${MCSC_GREY}"`);
  });
});
