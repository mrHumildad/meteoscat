// Tests for the substrate-grid module: RLE decode, O(1) (lng, lat) sampling,
// nodata semantics and the legend helpers — pure functions only (the loader
// is a thin fetch wrapper, exercised via the App smoke test).
import { describe, it, expect } from 'vitest';
import {
  LITHO_NODATA,
  decodeLithoGrid,
  lithoFamilyAt,
  lithoFamilyKeyAt,
  lithoLegendEntries,
} from './lithology.js';

// 4 cols × 3 rows @ 1° cells, west = 0, north = 3:
//   row 0 (y∈[2,3)): 1 1 2 2     (carbonatades, carbonatades, volcaniques ×2)
//   row 1 (y∈[1,2)): 3 0 0 0     (gresos, then nodata)
//   row 2 (y∈[0,1)): 0 0 0 0     (all nodata)
const gridJson = {
  cols: 4,
  rows: 3,
  west: 0,
  north: 3,
  step: 1,
  families: {
    '0': { key: 'nodata', label: 'Sense dades', color: null },
    '1': { key: 'carbonatades', label: 'Calcàries, dolomies i margues', color: '#6a93cf' },
    '2': { key: 'volcaniques', label: 'Volcàniques', color: '#8f4fc0' },
    '3': { key: 'gresos', label: 'Gresos i arenites', color: '#bf8a4e' },
  },
  rle: [
    [[1, 2], [2, 2]],
    [[3, 1], [0, 3]],
    [[0, 4]],
  ],
};

describe('decodeLithoGrid', () => {
  it('decodes RLE rows into a flat row-major cell array', () => {
    const g = decodeLithoGrid(gridJson);
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(3);
    expect(Array.from(g.cells)).toEqual([1, 1, 2, 2, 3, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('exposes the legend entries sorted by id, including id 0', () => {
    const g = decodeLithoGrid(gridJson);
    expect(g.entries.map(e => e.id)).toEqual([0, 1, 2, 3]);
    expect(g.entries[0]).toMatchObject({ key: 'nodata', color: null });
  });

  it('rejects malformed payloads', () => {
    expect(() => decodeLithoGrid(null)).toThrow();
    expect(() => decodeLithoGrid({})).toThrow();
    expect(() => decodeLithoGrid({ ...gridJson, rle: [[[0, 4]]] })).toThrow(); // row count
    expect(() => decodeLithoGrid({ ...gridJson, rle: [[[1, 99]], [[1, 4]], [[0, 4]]] })).toThrow(); // overrun
    expect(() => decodeLithoGrid({ ...gridJson, families: {} })).toThrow();
  });
});

describe('lithoFamilyAt / lithoFamilyKeyAt', () => {
  const g = decodeLithoGrid(gridJson);

  it('returns the family at a cell (row 0 = north)', () => {
    expect(lithoFamilyAt(g, 0.5, 2.5)).toBe(1);  // carbonatades
    expect(lithoFamilyAt(g, 2.5, 2.5)).toBe(2);  // volcaniques
    expect(lithoFamilyAt(g, 0.5, 1.5)).toBe(3);  // gresos
    expect(lithoFamilyAt(g, 1.5, 1.5)).toBe(LITHO_NODATA);
    expect(lithoFamilyAt(g, 0.5, 0.5)).toBe(LITHO_NODATA);
    expect(lithoFamilyAt(g, 3.999, 0.1)).toBe(LITHO_NODATA);
  });

  it('is exact on the grid edges and tolerant of float jitter', () => {
    expect(lithoFamilyAt(g, 0, 3)).toBe(1);           // north-west corner cell
    expect(lithoFamilyAt(g, 3.99999, 2.00001)).toBe(2);
    expect(lithoFamilyAt(g, 4, 2.5)).toBe(LITHO_NODATA); // just east of the grid
    expect(lithoFamilyAt(g, 0.5, 3.1)).toBe(LITHO_NODATA); // just north of the grid
  });

  it('maps ids to keys and nodata to null (the gate always passes it)', () => {
    expect(lithoFamilyKeyAt(g, 0.5, 2.5)).toBe('carbonatades');
    expect(lithoFamilyKeyAt(g, 0.5, 1.5)).toBe('gresos');
    expect(lithoFamilyKeyAt(g, 1.5, 1.5)).toBeNull();  // nodata
    expect(lithoFamilyKeyAt(g, 9, 9)).toBeNull();      // outside
    expect(lithoFamilyKeyAt(null, 0.5, 2.5)).toBeNull();
  });
});

describe('lithoLegendEntries', () => {
  it('lists only selectable families (id > 0), in id order', () => {
    const entries = lithoLegendEntries(decodeLithoGrid(gridJson));
    expect(entries.map(e => e.key)).toEqual(['carbonatades', 'volcaniques', 'gresos']);
    expect(entries.map(e => e.id)).toEqual([1, 2, 3]);
  });

  it('returns [] before the grid is loaded', () => {
    expect(lithoLegendEntries(null)).toEqual([]);
  });
});
