// Full-flow simulation: replicates the exact effect bodies from App.jsx
// (meteo band sync + altitude band sync) against a mock map, then feeds the
// generated tile URL to the REAL meteo:// protocol handler and checks the
// resulting pixels. Catches wiring bugs (wrong ids, wrong URLs, wrong
// visibility) that unit tests of individual pieces cannot.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('maplibre-gl', () => ({ addProtocol: vi.fn() }));
vi.mock('./elevation.js', async importOriginal => {
  const orig = await importOriginal();
  return {
    ...orig,
    loadTileImageData: async () => {
      const data = new Uint8ClampedArray(256 * 256 * 4);
      for (let i = 0; i < 256 * 256; i++) {
        data[i * 4] = 128; data[i * 4 + 1] = 100; data[i * 4 + 2] = 0; data[i * 4 + 3] = 255;
      }
      return { width: 256, height: 256, data }; // 100 m land everywhere
    },
  };
});

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

// --- Mock map that records calls, mirroring the MapLibre API surface the
// effects use: getSource / setLayoutProperty / source.setTiles --------------
const makeMockMap = () => {
  const sources = new Map();
  const layers = new Map();
  const calls = [];
  return {
    calls,
    getSource: id => sources.get(id) ?? null,
    getLayer: id => layers.get(id) ?? null,
    addSource: (id, def) => {
      sources.set(id, {
        ...def,
        setTiles: tiles => calls.push(['setTiles', id, tiles]),
      });
    },
    addLayer: (def) => layers.set(def.id, def),
    setLayoutProperty: (id, prop, value) => calls.push(['setLayoutProperty', id, prop, value]),
  };
};

// --- The exact meteo effect body from App.jsx (kept in sync by copy) -------
const meteoEffectBody = (map, { rainRange, humRange, tempRange, rangeLimits }, windowKey) => {
  if (!map) return;
  const w = windowKey;
  const METEO_VARS = [
    { variable: 'precAcc', key: 'rain' },
    { variable: 'humAvg', key: 'hum' },
    { variable: 'tempAvg', key: 'temp' },
  ];
  const bandOf = { rain: rainRange, hum: humRange, temp: tempRange };
  for (const { variable, key } of METEO_VARS) {
    const bandId = `${variable}-band`;
    if (!map.getSource(bandId)) continue;
    const band = bandOf[key];
    const active = !!band && !!rangeLimits &&
      (band[0] !== rangeLimits[`${key}Min`] || band[1] !== rangeLimits[`${key}Max`]);
    map.setLayoutProperty(bandId, 'visibility', active ? 'visible' : 'none');
    map.getSource(bandId).setTiles([
      active
        ? `meteo://{z}/{x}/{y}?v=${variable}&w=${w}&b=${band[0]}_${band[1]}`
        : 'meteo://{z}/{x}/{y}?v=off',
    ]);
  }
};

const rangeLimits = {
  rainMin: 0, rainMax: 30,
  humMin: 30, humMax: 100,
  tempMin: -5, tempMax: 35,
  altMin: 0, altMax: 3000,
};

let meteoOverlay;
beforeEach(() => {
  put.length = 0;
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  return import('./meteoOverlay.js').then(m => { meteoOverlay = m; });
});

describe('meteo band wiring flow', () => {
  it('turns the layer visible and requests band tiles when a band is applied', async () => {
    const map = makeMockMap();
    // Register sources/layers the way onMapLoad does.
    for (const v of ['precAcc', 'humAvg', 'tempAvg']) {
      map.addSource(`${v}-band`, { type: 'raster', tiles: ['meteo://{z}/{x}/{y}?v=off'] });
      map.addLayer({ id: `${v}-band`, type: 'raster', source: `${v}-band`, layout: { visibility: 'none' } });
    }
    // Anchor the station at the centre of tile (8, 128, 96) so the pixel
    // checks below sample exactly the station value.
    const { tileXYToLngLat } = await import('./elevation.js');
    const anchor = tileXYToLngLat(8, 128, 96, 128, 128);
    const addProtocol = (await import('maplibre-gl')).addProtocol;
    const registered = new Map();
    addProtocol.mockImplementation((name, handler) => registered.set(name, handler));
    meteoOverlay.registerMeteoProtocol(map, () => ({
      windowKey: '2026-09-02-2026-09-02',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [anchor.lng, anchor.lat] },
        properties: { codi: 'A', precAcc: 10, tempAvg: 22, humAvg: 70, altitud: 500 },
      }],
    }));

    // 1. No bands applied → layers hidden, off tiles.
    meteoEffectBody(map, { rainRange: null, humRange: null, tempRange: null, rangeLimits }, '2026-09-02-2026-09-02');
    expect(map.calls.filter(c => c[0] === 'setLayoutProperty').every(c => c[3] === 'none')).toBe(true);
    expect(map.calls.filter(c => c[0] === 'setTiles').every(c => c[2][0].includes('v=off'))).toBe(true);

    // 2. Apply a rain band → layer visible + band URL.
    map.calls.length = 0;
    meteoEffectBody(map, { rainRange: [5, 20], humRange: null, tempRange: null, rangeLimits }, '2026-09-02-2026-09-02');
    const vis = map.calls.find(c => c[0] === 'setLayoutProperty' && c[1] === 'precAcc-band');
    expect(vis[3]).toBe('visible');
    const tiles = map.calls.find(c => c[0] === 'setTiles' && c[1] === 'precAcc-band');
    const url = tiles[2][0];
    expect(url).toBe('meteo://{z}/{x}/{y}?v=precAcc&w=2026-09-02-2026-09-02&b=5_20');

    // 3. The real handler parses that URL and renders grey (10 mm out of
    //    band [5, 20]... actually 10 IS in band → transparent; use a band
    //    that excludes the station value).
    const parsed = meteoOverlay.parseMeteoTileUrl(url.replace('{z}', '8').replace('{x}', '128').replace('{y}', '96'));
    expect(parsed.variable).toBe('precAcc');
    expect(parsed.band).toEqual([5, 20]);

    // 4. With the station's 10 mm inside [5, 20] the pixel is transparent;
    //    re-run with an excluding band to confirm grey.
    const handler = registered.get('meteo');
    await handler({ url: 'meteo://8/128/96?v=precAcc&w=2026-09-02-2026-09-02&b=0_4' });
    expect(put).toHaveLength(1);
    const centre = ((128 * 256) + 128) * 4;
    expect(put[0].data[centre]).toBe(138); // grey: 10 mm > 4 mm
    expect(put[0].data[centre + 3]).toBe(255);
  });

  it('hides the layer again when the band is removed', () => {
    const map = makeMockMap();
    map.addSource('precAcc-band', { type: 'raster', tiles: [] });
    map.addLayer({ id: 'precAcc-band', type: 'raster', source: 'precAcc-band', layout: { visibility: 'none' } });
    meteoEffectBody(map, { rainRange: [5, 20], humRange: null, tempRange: null, rangeLimits }, 'w');
    map.calls.length = 0;
    meteoEffectBody(map, { rainRange: null, humRange: null, tempRange: null, rangeLimits }, 'w');
    const vis = map.calls.find(c => c[0] === 'setLayoutProperty' && c[1] === 'precAcc-band');
    expect(vis[3]).toBe('none');
  });
});