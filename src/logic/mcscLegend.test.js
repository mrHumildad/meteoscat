import { describe, it, expect } from 'vitest';
import { MCSC_LEGEND, MCSC_GREY, MCSC_EXTRA_VALUES, renderMcscSld } from './mcscLegend.js';

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

  it('uses valid 6-digit hex colours, including the shared dim grey', () => {
    for (const e of MCSC_LEGEND) {
      expect(e.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
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

describe('renderMcscSld', () => {
  it('renders every legend class in its official colour when nothing is dimmed', () => {
    const sld = renderMcscSld();
    for (const e of MCSC_LEGEND) {
      for (const v of e.values) {
        expect(sld).toContain(`color="${e.color}" quantity="${v}"`);
      }
    }
  });

  it('renders unlisted raster values in grey regardless of the switches', () => {
    const sld = renderMcscSld();
    for (const v of MCSC_EXTRA_VALUES) {
      expect(sld).toContain(`color="${MCSC_GREY}" quantity="${v}"`);
    }
  });

  it('dims a toggled-off class to the shared grey, keeping the others coloured', () => {
    const off = new Set(['221/225']);
    const sld = renderMcscSld(MCSC_LEGEND, off);
    expect(sld).toContain(`color="${MCSC_GREY}" quantity="7"`);
    expect(sld).toContain(`color="${MCSC_GREY}" quantity="11"`);
    expect(sld).toContain(`color="${MCSC_LEGEND[1].color}" quantity="8"`);   // caducifolis stays on
    expect(sld).toContain(`color="${MCSC_LEGEND[8].color}" quantity="36"`);  // aigües stays on
  });

  it('restores the official colour when a dimmed class is switched back on', () => {
    const sld = renderMcscSld(MCSC_LEGEND, new Set());
    expect(sld).toContain(`color="${MCSC_LEGEND[4].color}" quantity="10"`); // matollar
    expect(sld).not.toContain(`color="${MCSC_GREY}" quantity="10"`);
  });
});