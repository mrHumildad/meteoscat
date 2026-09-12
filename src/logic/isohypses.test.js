// Isohypse (contour) logic: the pure interval / marching-squares helpers and
// the browser-only tile painter (DEM + canvas stubbed). The painter must draw
// light contour lines from the DEM, skip sea-level / below, and split the
// levels into minor vs master (index) lines.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake DEM plane, settable per test: elevation (m) as a function of pixel x/y.
// Reset after every test via `mockDemElev = null`.
let mockDemElev = null;
vi.mock('./elevation.js', async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadTileImageData: vi.fn(async () => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const o = (y * 256 + x) * 4;
          const v = Math.round(mockDemElev ? mockDemElev(x, y) : 0) + 32768;
          data[o] = (v >> 8) & 255;
          data[o + 1] = v & 255;
          data[o + 2] = 0;
          data[o + 3] = 255;
        }
      }
      return { width: 256, height: 256, data };
    }),
  };
});

let contourIntervalForZoom;
let contourCellSegments;
let selectContourLabels;
let parseIsohypseTileUrl;
let buildIsohypseTile;
let loadDemMock;
let CONST;
let lastCtx = null;

class FakeCtx {
  constructor() {
    this.strokes = [];
    this.texts = [];
    this._path = null;
    this.strokeStyle = '';
    this.lineWidth = 0;
    this.lineJoin = '';
    this.font = '';
    this.textAlign = '';
    this.textBaseline = '';
  }
  beginPath() { this._path = []; }
  moveTo(x, y) { this._path.push([x, y]); }
  lineTo(x, y) { this._path.push([x, y]); }
  stroke() { this.strokes.push({ style: this.strokeStyle, width: this.lineWidth, path: this._path }); }
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  strokeText(text) { this.texts.push({ kind: 'stroke', text, font: this.font }); }
  fillText(text) { this.texts.push({ kind: 'fill', text, font: this.font }); }
}
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.ctx = new FakeCtx(); lastCtx = this.ctx; }
  getContext() { return this.ctx; }
  async convertToBlob() { return new Blob(); }
}

beforeEach(async () => {
  mockDemElev = null;
  lastCtx = null;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  const m = await import('./tilePaint.js');
  contourIntervalForZoom = m.contourIntervalForZoom;
  contourCellSegments = m.contourCellSegments;
  selectContourLabels = m.selectContourLabels;
  parseIsohypseTileUrl = m.parseIsohypseTileUrl;
  buildIsohypseTile = m.buildIsohypseTile;
  loadDemMock = (await import('./elevation.js')).loadTileImageData;
  loadDemMock.mockClear();
  CONST = {
    INDEX_EVERY: m.CONTOUR_INDEX_EVERY,
    MINOR_ALPHA: m.CONTOUR_MINOR_ALPHA,
    INDEX_ALPHA: m.CONTOUR_INDEX_ALPHA,
    MINOR_WIDTH: m.CONTOUR_MINOR_WIDTH,
    INDEX_WIDTH: m.CONTOUR_INDEX_WIDTH,
    MIN_ZOOM: m.CONTOUR_MIN_ZOOM,
    LABEL_FONT_SIZE: m.CONTOUR_LABEL_FONT_SIZE,
  };
});

describe('contourIntervalForZoom', () => {
  it('steps the interval down as the DEM resolves finer shape', () => {
    expect(contourIntervalForZoom(7)).toBe(200);
    expect(contourIntervalForZoom(8)).toBe(200);
    expect(contourIntervalForZoom(9)).toBe(100);
    expect(contourIntervalForZoom(10)).toBe(100);
    expect(contourIntervalForZoom(11)).toBe(50);
    expect(contourIntervalForZoom(15)).toBe(50);
  });
});

describe('contourCellSegments', () => {
  it('returns nothing when the whole cell is on one side of the level', () => {
    expect(contourCellSegments(10, 20, 20, 10, 5)).toEqual([]); // all above
    expect(contourCellSegments(1, 2, 2, 1, 5)).toEqual([]);    // all below
  });

  it('returns nothing for a non-finite (no-data) cell', () => {
    expect(contourCellSegments(NaN, 20, 20, 10, 15)).toEqual([]);
  });

  it('connects the two crossed edges of a simple cell', () => {
    // tl/bl at 0, tr/br at 10 → the level-5 line runs vertically at x = 0.5.
    expect(contourCellSegments(0, 10, 10, 0, 5)).toEqual([[0.5, 0, 0.5, 1]]);
  });

  it('returns two segments for a saddle cell', () => {
    const segs = contourCellSegments(10, 0, 10, 0, 5); // tl/br high, tr/bl low
    expect(segs).toHaveLength(2);
    for (const s of segs) {
      expect(s).toHaveLength(4);
      for (const c of s) expect(c).toBeGreaterThanOrEqual(0);
      for (const c of s) expect(c).toBeLessThanOrEqual(1);
    }
  });
});

describe('selectContourLabels', () => {
  it('thins candidates so one label lands per spacing-sized neighbourhood', () => {
    const labels = selectContourLabels([
      [40, 40, 50, 50, 100],   // midpoint (45,45) — kept
      [42, 42, 52, 52, 100],   // midpoint (47,47) — same neighbourhood → dropped
      [220, 220, 230, 230, 200], // midpoint (225,225) — far → kept
    ], 90, 26);
    expect(labels.map(l => l.level).sort()).toEqual([100, 200]);
  });

  it('drops candidates too close to a tile seam', () => {
    expect(selectContourLabels([[5, 128, 15, 128, 100]], 90, 26)).toEqual([]);
  });

  it('flips the label angle so text is never upside down', () => {
    const [l] = selectContourLabels([[200, 128, 100, 128, 100]], 90, 26);
    expect(l).toBeDefined();
    expect(Math.abs(l.angle)).toBeLessThanOrEqual(Math.PI / 2);
  });
});

describe('parseIsohypseTileUrl', () => {
  it('parses a stateless isohypses URL and rejects others', () => {
    expect(parseIsohypseTileUrl('isohypses://11/1024/768')).toEqual({ z: 11, x: 1024, y: 768 });
    expect(parseIsohypseTileUrl('isohypses://11/1024/768?x=1')).toBeNull();
    expect(parseIsohypseTileUrl('sea://11/1024/768?c=off')).toBeNull();
    expect(parseIsohypseTileUrl('')).toBeNull();
  });
});

describe('buildIsohypseTile', () => {
  it('draws minor + master contour lines from a sloped DEM', async () => {
    mockDemElev = (x) => 100 + x * 2; // 100..610 m west→east at z11, 50 m step
    const buf = await buildIsohypseTile(11, 1024, 768);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(lastCtx.strokes).toHaveLength(2); // one minor path + one master path

    const [minor, index] = lastCtx.strokes;
    expect(minor.style).toBe(`rgba(255, 255, 255, ${CONST.MINOR_ALPHA})`);
    expect(minor.width).toBe(CONST.MINOR_WIDTH);
    expect(index.style).toBe(`rgba(255, 255, 255, ${CONST.INDEX_ALPHA})`);
    expect(index.width).toBe(CONST.INDEX_WIDTH);

    for (const st of [minor, index]) {
      expect(st.path.length).toBeGreaterThanOrEqual(4);
      expect(st.path.length % 2).toBe(0); // moveTo/lineTo pairs
      for (const [x, y] of st.path) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(256);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(256);
      }
    }
  });

  it('labels the master contours with their elevation', async () => {
    mockDemElev = (x) => 100 + x * 2; // masters at 250 m and 500 m
    await buildIsohypseTile(11, 1024, 768);
    const texts = lastCtx.texts.filter(t => t.kind === 'fill').map(t => t.text);
    expect(texts).toContain('250');
    expect(texts).toContain('500');
    // every label is drawn with the font the painter set
    for (const t of lastCtx.texts) expect(t.font).toContain(`${CONST.LABEL_FONT_SIZE}px`);
  });

  it('draws nothing at or below sea level (flat 0 m tile)', async () => {
    mockDemElev = () => 0;
    await buildIsohypseTile(11, 1024, 768);
    expect(lastCtx.strokes).toHaveLength(0);
    expect(lastCtx.texts).toHaveLength(0);
  });

  it('is a no-op (no DEM fetch, no paint) below the close-zoom threshold', async () => {
    mockDemElev = (x) => 100 + x * 2;
    const buf = await buildIsohypseTile(CONST.MIN_ZOOM - 1, 512, 384);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(loadDemMock).not.toHaveBeenCalled();
    expect(lastCtx.strokes).toHaveLength(0);
    expect(lastCtx.texts).toHaveLength(0);
  });
});
