import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn() }));
vi.mock('./elevation.js', async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    // Fake DEM: every pixel is 100 m land except the top-left 64×64 block
    // which is sea (0 m). Terrarium encoding: 100 m → R=128, G=100, B=0;
    // 0 m → R=128, G=0, B=0.
    loadTileImageData: async () => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let i = 0; i < 256 * 256; i++) {
        data[i * 4] = 128; data[i * 4 + 1] = 100; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
      }
      for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
          const i = (y * 256 + x) * 4;
          data[i] = 128; data[i + 1] = 0; data[i + 2] = 0; data[i + 3] = 255;
        }
      }
      return { width: 256, height: 256, data };
    },
  };
});

// Capture the ImageData handed to putImageData — that is exactly the pixel
// content that gets PNG-encoded for MapLibre.
const put = [];
class FakeCtx {
  createImageData(w, h) {
    return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  }
  putImageData(img) { put.push(img); }
}
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return new FakeCtx(); }
  async convertToBlob() { return new Blob(); }
}

import { classifySea, SEA_TRANSPARENT, parseHexColor, parseSeaTileUrl } from './seaOverlay.js';

const BLUE = [0, 0, 128, 255];

describe('parseHexColor', () => {
  it('parses a 6-digit hex colour into RGBA', () => {
    expect(parseHexColor('000080')).toEqual(BLUE);
    expect(parseHexColor('8a8a8a')).toEqual([138, 138, 138, 255]);
    expect(parseHexColor('FF0000')).toEqual([255, 0, 0, 255]);
  });

  it('rejects invalid values', () => {
    expect(parseHexColor('zzzzzz')).toBeNull();
    expect(parseHexColor('00008')).toBeNull();   // too short
    expect(parseHexColor('0000800')).toBeNull(); // too long
    expect(parseHexColor(null)).toBeNull();
    expect(parseHexColor('')).toBeNull();
  });
});

describe('classifySea', () => {
  it('paints sea and below-sea-level elevations with the sea colour', () => {
    expect(classifySea(0, BLUE)).toEqual(BLUE);
    expect(classifySea(-77, BLUE)).toEqual(BLUE);
    expect(classifySea(-32768, BLUE)).toEqual(BLUE);
  });

  it('keeps land transparent', () => {
    expect(classifySea(1, BLUE)).toEqual(SEA_TRANSPARENT);
    expect(classifySea(2640, BLUE)).toEqual(SEA_TRANSPARENT);
  });

  it('keeps no-data transparent', () => {
    expect(classifySea(NaN, BLUE)).toEqual(SEA_TRANSPARENT);
    expect(classifySea(Infinity, BLUE)).toEqual(SEA_TRANSPARENT);
  });

  it('renders nothing when the colour is missing (overlay off)', () => {
    expect(classifySea(0, null)).toEqual(SEA_TRANSPARENT);
    expect(classifySea(-5, null)).toEqual(SEA_TRANSPARENT);
  });
});

describe('parseSeaTileUrl', () => {
  it('parses colour-carrying urls', () => {
    expect(parseSeaTileUrl('sea://9/260/190?c=000080')).toEqual({ z: 9, x: 260, y: 190, color: '000080' });
    // an optional repaint token is ignored by the parser (cache buster only)
    expect(parseSeaTileUrl('sea://9/260/190?c=000080&r=2')).toEqual({ z: 9, x: 260, y: 190, color: '000080' });
  });

  it('parses the off url', () => {
    expect(parseSeaTileUrl('sea://9/260/190?c=off')).toEqual({ z: 9, x: 260, y: 190, color: null });
  });

  it('rejects unrecognised urls', () => {
    expect(parseSeaTileUrl('http://example.com/9/260/190?c=000080')).toBeNull();
    expect(parseSeaTileUrl(null)).toBeNull();
    expect(parseSeaTileUrl('sea://9/260/190')).toBeNull(); // missing colour
  });
});

// Tile-level integration test: builds a real classified tile with the
// browser-only parts (canvas, tile fetch) stubbed out, mirroring
// meteoOverlay.tile.test.js.
describe('buildSeaTile', () => {
  let buildSeaTile;
  beforeEach(() => {
    put.length = 0;
    vi.stubGlobal('OffscreenCanvas', FakeCanvas);
    return import('./seaOverlay.js').then(m => { buildSeaTile = m.buildSeaTile; });
  });

  it('paints sea pixels with the colour and keeps land transparent', async () => {
    await buildSeaTile(9, 260, 190, '000080');

    expect(put).toHaveLength(1);
    const out = put[0].data;

    // Sea block (top-left 64×64 of the fake DEM) → the requested colour.
    const sea = (10 * 256 + 10) * 4;
    expect(out[sea]).toBe(0);
    expect(out[sea + 1]).toBe(0);
    expect(out[sea + 2]).toBe(128);
    expect(out[sea + 3]).toBe(255);

    // Land pixel (outside the sea block) → transparent.
    const land = ((128 * 256) + 128) * 4;
    expect(out[land]).toBe(0);
    expect(out[land + 3]).toBe(0);
  });

  it('emits a fully transparent tile when the colour is off', async () => {
    const buf = await buildSeaTile(9, 260, 190, null);
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(put).toHaveLength(0); // early return, no pixels written
  });
});