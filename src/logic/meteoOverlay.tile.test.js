// Integration test for the meteo:// tile pipeline: builds a real classified
// tile (IDW grid + DEM sea mask + band classification) with the browser-only
// parts (canvas, tile fetch) stubbed out, then asserts on the pixels that
// would be PNG-encoded.
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

let buildMeteoTile;
beforeEach(() => {
  put.length = 0;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  return import('./meteoOverlay.js').then(m => { buildMeteoTile = m.buildMeteoTile; });
});

// A single station with precAcc 10 anchored at the tile centre → the IDW
// field is 10 everywhere within 50 km, so a band of [0, 5] must grey out
// reachable land pixels and a band of [10, 10] must keep them transparent.
const makeContext = async () => {
  const { lngLatToTileXY, tileXYToLngLat } = await import('./elevation.js');
  const t = lngLatToTileXY(0, 40.01, 8);
  const centre = tileXYToLngLat(t.z, t.x, t.y, 128, 128);
  return {
    tile: t,
    context: () => ({
      windowKey: 'w1',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [centre.lng, centre.lat] },
        properties: { codi: 'A', precAcc: 10, altitud: 0 },
      }],
    }),
  };
};

describe('buildMeteoTile', () => {
  it('greys land pixels whose value is out of band and keeps sea transparent', async () => {
    const { tile: t, context } = await makeContext();
    await buildMeteoTile(t.z, t.x, t.y, 'precAcc', [0, 5], context);

    expect(put).toHaveLength(1);
    const out = put[0].data;

    // Centre pixel ≈ the station: value 10, out of band [0, 5] → MCSC_GREY.
    const centre = ((128 * 256) + 128) * 4;
    expect(out[centre]).toBe(138);      // R
    expect(out[centre + 1]).toBe(138);  // G
    expect(out[centre + 2]).toBe(138);  // B
    expect(out[centre + 3]).toBe(255);  // opaque

    // Sea block (top-left 64×64 of the fake DEM) → transparent.
    const sea = (10 * 256 + 10) * 4;
    expect(out[sea]).toBe(0);
    expect(out[sea + 3]).toBe(0);
  });

  it('keeps in-band values transparent', async () => {
    const { tile: t, context } = await makeContext();
    await buildMeteoTile(t.z, t.x, t.y, 'precAcc', [10, 10], context);

    const centre = ((128 * 256) + 128) * 4;
    expect(put[0].data[centre]).toBe(0);
    expect(put[0].data[centre + 3]).toBe(0);
  });

  it('emits a fully transparent tile when the band is off', async () => {
    const buf = await buildMeteoTile(8, 128, 96, null, null, () => ({ windowKey: 'w1', features: [] }));
    expect(buf).toBeInstanceOf(ArrayBuffer);
    expect(put).toHaveLength(0); // early return, no pixels written
  });
});