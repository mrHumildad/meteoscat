# Tile Rendering – How MeteoSCat Paints the Map

> App: `meteoscat` (React + Vite + MapLibre GL JS v6).  
> Catalonia-only map. All land-cover / geology colour is **painted client-side, per-pixel, per-tile** – the server never colours anything.

Keep this doc next to `src/logic/tilePaint.js` / `tileWorker.js` / `tilePipeline.js`. If you touch any of those, re-read §10 (transfer bug) first.

---

## 1. TL;DR

```
App state (React)
  │  terrainState {mode, off, alt, filters, geoOff}  +  sea colour
  ▼
terrainTileUrl / sea URL  →  MapLibre raster source  →  custom protocol `terrain://` / `sea://`
  │                              addProtocol('terrain', handler)
  ▼
tilePipeline  ──►  tileWorker (OffscreenCanvas, 6 concurrent)  ──►  tilePaint.buildTerrainTile / buildSeaTile
  │                    ▲  context {agg, features, lithoGrid} pushed from App       │
  │                    │  fetch: MCSC band tile + DEM tile (+ meteo IDW grid)     │
  └─ fallback inline if no Worker / worker died                                    │
  ▼
256×256 PNG (ArrayBuffer) → MapLibre raster tile → hillshade / sea / terrain layers → stations on top
```

No server WMS colour, no grey mask. Failing pixels are **transparent** → relief (hillshade) shows through.

---

## 2. Layers on the map (bottom → top)

| Layer | Source id | Type | Where created | Notes |
|-------|-----------|------|---------------|-------|
| Basemap | Stadia `alidade_smooth_dark` | vector | `App.jsx: styleUrl` | Dark, no key. |
| `hillshade` | `elevation-dem` | `hillshade` | `App.jsx:onMapLoad:addAreaOverlays` | terrarium DEM, `exaggeration 0.4`. **Not bounds-clipped** (would leave edge). Shared with 3D terrain. |
| `sea` | `sea` | `raster` (`sea://`) | same | DEM `elev ≤ 0` → navy `#000080` else transparent. Sits **above** hillshade, **below** terrain so land-water class draws on top. Also not clipped. |
| `terrain` | `terrain` | `raster` (`terrain://`) | same | The stacked overlay. `TERRAIN_OVERLAY_BOUNDS = [-1.25,39.75,4.25,44.25]` – MapLibre never requests tiles fully outside. `minzoom 7 maxzoom 14 opacity 0.85`. Always visible. |
| `stations-circle/label/value` | `stations` | `circle/symbol` | `onMapLoad` | GeoJSON, dimmed when filtered (`inRange=false`). |

3D terrain (`map.setTerrain({source:'elevation-dem', exaggeration:1.3})`) reuses the same `elevation-dem` source and tilts camera. See `App.jsx:2.9`.

All heavy raster sources (`terrain`, `sea`, `elevation-dem`) are added **lazily** on first `idle` (or 3 s timeout) so first paint is fast. `mapReady` gates the effects that call `setTiles`.

---

## 3. Data sources

### 3.1 DEM – elevation (`src/logic/elevation.js`)

* URL: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (Mapzen / AWS Open Data).
* Encoding: `elev = R*256 + G + B/256 - 32768` (`terrariumElevation`).
* Decoding: `loadTileImageData(z,x,y)` fetches PNG → `createImageBitmap` → `OffscreenCanvas` → `ImageData`. Cached `Map<z/x/y, Promise<ImageData>>`. `fetchWithRetry` (1 retry, 250 ms).
* Helpers: `lngLatToTileXY`, `tileXYToLngLat` (pure, tested), `sampleElevation(lng,lat,z=13)` bilinear.
* **Only fetched when needed**: `needElev = altBand || tempFilter` (lapse). Otherwise `src=null`.

### 3.2 MCSC band tile (`src/logic/mcscRaw.js`)

* WMS: `https://geoserveis.icgc.cat/servei/catalunya/cobertes-sol/wms? … layers=cobertes_2024`
* Trick: constant SLD `renderBandSld()` (in `mcscLegend.js`) maps `band v → #vv0000` (`<ColorMapEntry quantity=v color="#vv0000">`). So red channel **is** band `0..41` (0 = no data / sea abroad). `BAND_SLD` is `encodeURIComponent`-once.
* `tileBbox3857(z,x,y)` → EPSG:3857 bbox → `mcscBandTileUrl`.
* `loadMcscBandTile` same decode path as DEM, cache `bandCache`. Retry.

### 3.3 MCSC legend (`src/logic/mcscLegend.js`)

* `MCSC_LEGEND` 9 entries, each `{color, label, codes, values: [band,…]}`. Bands 1..41 follow class-code order (see file header). Water bands `36..41` (`MCSC_WATER_VALUES`).
* `entryForBand`, `isWaterBand`, `renderBandSld`, constants `MCSC_WATER_COLOR #000080`, `MCSC_GREY`, `MCSC_EXTRA_VALUES [16..20]` (230–234, never selectable → always transparent).

### 3.4 Meteo grid (`src/logic/meteoGrid.js`)

* Why: meteo has only ~190 points, not a raster. Build IDW grid once per **window** (`from/to` dates), then sample per pixel.
* `GRID_STEP = 0.01° ≈ 1.1 km`, `GRID_BOUNDS {w-1,s40,e4,n44}`, `DEFAULT_MAX_DIST_KM=50`, `LAPSE_RATE=6.5 °C/km`.
* `featuresForWindow(agg, features, variable, from, to)` – projects `agg` (prefix sums, `filterAggregate.js`) onto base features: `properties[variable]=aggregateWindowByDates(...)`. Stations missing data → `null` → skipped.
* `buildMeteoGrid(features, variable, {lapseRate})` – IDW `w=1/d²`, exact hit short-circuit, `nearestD2*KM_PER_DEG > 50 → NaN`. Temp: `value = raw + lapse*alt/1000` (sea-level reduction). Returns `{data:Float32Array, width,height,west,south,step,lapseRate}`.
* `sampleMeteoGrid(grid,lng,lat)` bilinear. `getMeteoGrid(windowKey,variable,features,opts)` cached `Map<windowKey|variable, grid>` (30 entries).

### 3.5 Lithology grid (`src/logic/lithology.js`)

* File: `public/logic/litho_grid.json` (built by `meteokat/build_lithology.py` from ICGC 1:50 000). Uniform lon/lat grid, RLE per row, north→south.
* `decodeLithoGrid(json)` → `{cols,rows,west,north,step,cells:Uint8Array, entries:[{id,key,label,color}], keyById}`. `LITHO_NODATA=0` (sea/outside/fault) never filtered.
* `lithoFamilyAt(grid,lng,lat)` O(1), `lithoFamilyKeyAt`, `lithoLegendEntries` (id>0), `loadLithoGrid(path)` (fetch+json). CC BY 4.0.

### 3.6 Stations (`public/logic/stations.geojson` + `refineData.js` + `filterAggregate.js`)

* `agg = buildAggregateTable(data)` – prefix sums over all days. `limitsForWindow`, `windowToDates` power slider limits and grid windows. `DISPLAY_DAYS=60` for circles/chart; filters have independent windows.

---

## 4. Terrain overlay – what a pixel shows

**File:** `src/logic/tilePaint.js` + `src/logic/terrainOverlay.js`

### 4.1 Modes (`terrainState.mode`)

* `terrain` (default, 🌳) – land pixel colour = `colourForBand(band, off)` (null → transparent: unlisted 230–234 or dimmed class).
* `substrate` (🟫, needs `lithoGrid`) – land colour = `lithoFamilyColour(grid, lithoFamilyAt(...))` else transparent (nodata). Falls back to terrain rendering if grid missing.
* `none` (🚫) – `buildTerrainTile` early-returns transparent PNG, no fetches.

Water pixels keep **class colour** in both modes (shared `Aigües` switch), never gated.

### 4.2 Per-pixel gate (`classifyTerrainPixel`)

```js
colourForBand → null? → [0,0,0,0]
isWater? → paint (no gates)
familyKey ∈ offKeys? → transparent          // geology
altBand && (elev≤0 || elev∉alt)? → transparent
for each meteo instance: sampledValue ∉ [lo,hi]? → transparent
else → paint
```

`altBand` is inclusive; sea/no-data fails altitude. `values/his/los` are per-pixel arrays; missing value (`NaN`) fails.

### 4.3 Build steps (`buildTerrainTile(z,x,y,state,getContext)`)

1. `st.mode==='none'` → transparent PNG.
2. `off=new Set(st.off)`, `offGeo=new Set(st.geoOff)`.
3. Precompute `bandColours[0..41]` + `bandIsWater`.
4. `getContext() → {agg, features, lithoGrid}` → build `grids/los/his` for each `st.filters` (only **active** instances: band narrower than span). `featuresForWindow` + `getMeteoGrid` (temp uses `LAPSE_RATE`).
5. `needElev = alt || grids.some(lapseRate>0)`.
6. `await loadMcscBandTile`, `await loadTileImageData` if needed.
7. `ImageData` loop 65k pixels: read `band=s[i]` (red), `px/py`, `isWater`, pick `colour` by mode, sample `elev`, sample each `meteoGrid` (+ lapse re-apply `value -= lapse*elev/1000`), `classifyTerrainPixel`, write `out`.
8. `putImageData` → `canvasToBlob` → `ArrayBuffer`.

`TILE_SIZE=256`. `lngs[]`/`lats[]` precomputed per column/row via `tileXYToLngLat`. Reused `Float64Array values`.

`classifySea` (for `buildSeaTile`) is simpler: `elev>0 || NaN → transparent` else `color`.

Pure helpers are unit-testable (see `terrainOverlay.test.js`, `terrainOverlay.tile.test.js` with stubbed fetches/canvas).

---

## 5. Sea overlay

**Files:** `src/logic/tilePaint.js` (`buildSeaTile`, `classifySea`, `parseSeaTileUrl`), `src/logic/seaOverlay.js` (protocol wrapper).

`buildSeaTile(z,x,y,colorHex)`:
* `color=null` → transparent (overlay off, when Aigües dimmed).
* Else `loadTileImageData` → `classifySea(elev,color)` per pixel.

URL: `sea://{z}/{x}/{y}?c=<hex|off>(&r=N)` – colour baked, `off` = transparent.

---

## 6. TilePipeline – Worker vs main thread

### 6.1 `tilePaint.js` – must stay `maplibre-gl` free

Exports pure helpers + painters + `transparentTilePng`. Browser-only at runtime but import-safe in Node tests (stubs mock canvas/fetches). `makeCanvas` uses `OffscreenCanvas` if present else `document.createElement('canvas')`.

`transparentTilePng` – the fallback:
```js
let transparentPngPromise = null;
const getTransparentPngBuffer = () => {
  if (!transparentPngPromise)
    transparentPngPromise = (async()=>{
      const c=makeCanvas(256,256); c.getContext('2d'); // OffscreenCanvas needs context!
      return (await canvasToBlob(c)).arrayBuffer();
    })().catch(e=>{transparentPngPromise=null; throw e});
  return transparentPngPromise;
};
export const transparentTilePng = async () => (await getTransparentPngBuffer()).slice(0);
```
Every caller gets `slice(0)` copy – see §10.

### 6.2 `tileWorker.js` – the painting worker

* Imported via `new Worker(new URL('./tileWorker.js', import.meta.url), {type:'module'})`.
* State: `context={}` (latest push), `cache Map<key,Promise<ArrayBuffer>>` (300), `queue []`, `MAX_ACTIVE=6`.
* Protocol: `ctx` (context), `tile {id,kind,payload}`, `abort {id}` → `tile {id,ok,buf|error}` (transferable).
* `cached(key,build)` deduplicates in-flight, evicts oldest, deletes on failure.
* `terrainTile` key `terrain|z/x/y|JSON(state)`, `seaTile` key `sea|z/x/y|color`.
* `run(job)`:
  ```js
  const raw = await (kind==='sea'? seaTile(payload): terrainTile(payload));
  const buf = raw.slice(0); // copy! cache keeps original
  self.postMessage({type:'tile',id,ok:true,buf}, [buf]);
  ```
  **Without `slice` the second hit would transfer a detached buffer** (see §10).
* `pump()` respects `MAX_ACTIVE`; `queue` is FIFO; `abort` removes queued not yet started.

Bundled by Vite as `assets/tileWorker-*.js` (separate chunk). Needs `OffscreenCanvas` + `Worker`.

### 6.3 `tilePipeline.js` – main-thread facade

* `workerPossible() = Worker && OffscreenCanvas`. Lazy so tests can import.
* `ensureWorker()` – once, posts current `context`. `isWorkerMode()`, `pushTerrainContext(next)` (app effect pushes `{agg, features, lithoGrid}` on every change; replays if worker started late).
* `requestInWorker(kind,payload,signal)` – `pending Map<id,{resolve,reject}>`, `signal('abort')` → `worker.postMessage({abort,id})` + `resolve(transparentResult())`.
* `transparentResult()` / `fallbackTransparent()` – both call `transparentTilePng` (copy). Fallback adds `cacheControl:'max-age=10'` so transient failures self-heal (MapLibre re-requests).
* `paintTerrainTile(z,x,y,state,signal)` / `paintSeaTile(z,x,y,color,signal)` – `isWorkerMode()? requestInWorker : (signal.aborted? transparentResult : buildXxx(...))` then `.catch(e=>fallbackTransparent())`. **Never rejects** – errored raster sources wedge MapLibre <6.1 (see `maplibre-gl-js#7775`).

### 6.4 `terrainOverlay.js` / `seaOverlay.js` – protocol glue

* Re-export pure symbols from `tilePaint` so tests importing `terrainOverlay` keep working.
* `terrainStateSignature(state)` canonicalises (`mode` → `terrain|substrate|none`, sorted `off/geoOff/filters`). `terrainStateSig = JSON.stringify`. `terrainTileUrl(state)` → `terrain://{z}/{x}/{y}?s=<encodedSig>`.
* `registerTerrainProtocol(map,getState)` / `registerSeaProtocol()` call `ensureWorker()` then `addProtocol('terrain', handler)` (global in MapLibre v5+).
  * `mainThreadHandler` – parses URL, canonicalises state, caches `Map<z/x/y|sig, Promise<{data}>>` (300), calls `tilePipeline.paintXxx(…, abortSignal)`.
  * `workerHandler` – same but no own cache (worker caches). Both never reject (`transparentResult` on bad URL).
  * `isWorkerMode()` picks handler at registration time.

---

## 7. MapLibre wiring (`App.jsx`)

### 7.1 `terrainState` memo (the “everything that repaints”)

```js
off = [...mcscOff].sort()
altActive = reliefRange && altLimits && reliefRange !== altLimits
filters = meteoFilters.map(f=>{ variable=TYPE_TO_VARIABLE[f.type]; span=limitsForWindow(agg,…); w=windowToDates(refDay,…); active = span && range!==span; if(active) push({variable,from:w.from,to:w.to,band:range}) })
terrainState = {mode:terrainMode, off, alt: altActive? reliefRange:null, filters: sorted, geoOff: mode==='substrate'? [...geoOff].sort():[]}
terrainTiles = [terrainTileUrl(terrainState)]
```

Each palette filtered by **own** switch only (`geoOff` only in `substrate`). `mode` is part of signature.

### 7.2 URL → repaint

```js
// App.jsx effect 2.7
terrainStateRef.current = terrainState; // protocol reads it
if(!mapReady) return;
const plain = terrainTiles[0]; // terrain://{z}/{x}/{y}?s=…
let url = plain;
if(url !== lastTerrainUrlRef.current){ url = `${plain}&r=${serial++}`; lastTerrainUrlRef.current=url; }
src.setTiles([url]); // MapLibre re-requests
```
Throttled `TERRAIN_REPAINT_MS=150`. Same for sea (`sea://{z}/{x}/{y}?c=…&r=N`, `seaSerialRef`). The `&r` **cache-buster** prevents MapLibre serving stale raster for a seen URL.

### 7.3 Lifecycle

* `onMapLoad` → `registerTerrainProtocol(map, ()=>terrainStateRef.current)` + `registerSeaProtocol()` (once). Stores `mapRef`.
* `addAreaOverlays` on `idle` or 3 s timeout → `addSource('terrain'| 'sea' | 'elevation-dem')` + `addLayer`. Sets `lastTerrainUrlRef` / `lastSeaUrlRef` to initial tile, `setMapReady(true)` lets effects run.
* Push context: `useEffect([geoWithData,agg,lithoGrid]) → pushTerrainContext({agg, features: geoWithData.features, lithoGrid})` + refs.
* Repaint gate: `beginRepaint()/endRepaint()` + `repaintBusy`. While `repaintBusy` the filter panel is `.busy` and forest button shows `Pintant…` and is disabled. `map.once('idle', endRepaint)` + 5 s safety timeout. `samePair/sameSet/inertInstance` skip no-ops (full-span meteo bands).
* Viewport fit: `fittedMinZoom(w,h)` → `fitZoomForViewport({width,height,minZoom:FIT_ZOOM_FLOOR,maxZoom})` (see `mapFit.js`), `CATALONIA_BOUNDS`, `TERRAIN_OVERLAY_BOUNDS`. `minZoom` updated on `resize`.

### 7.4 Worker base URL

`setWorkerUrl(import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')` – required for Vite ESM (`?worker&url` emits self-contained worker chunk).

---

## 8. Known bug & fix (2026-09 – forest button stuck)

**Symptom:** 2 full cycles `terrain→substrate→none` (6 clicks) ok, 7th `none→terrain` stayed transparent; zoom recovered patchily.

**Cause:**

* `tileWorker` cached `ArrayBuffer` and transferred it (`postMessage(...,[buf])`). Transfers **detach**. Cache hit (same `terrain` state after 3 clicks, or parallel duplicate tiles before build finished) tried to transfer already-detached buffer → `DataCloneError: ArrayBuffer already detached` → `paintTerrainTile` fell back to `transparentTilePng`.
* `transparentTilePng` cached one `ArrayBuffer` and handed same object to every caller, plus `OffscreenCanvas` without `getContext('2d')` → `InvalidStateError: convertToBlob … has no rendering context`. Every fallback failed → MapLibre kept previous (transparent) raster, layer stuck. Zoom `z` changed → new key → miss → fresh buffer → patch.

**Fix:**

* `tilePaint.js:getTransparentPngBuffer()` ensures `c.getContext('2d')` before `convertToBlob`, resets promise on throw, and **every** `transparentTilePng()` returns `buf.slice(0)` (copy).
* `tileWorker.js:run()` does `const buf = (await cachedTile()).slice(0); postMessage(...,[buf])`. Cache keeps original, each reply gets a clone.

**Test:** Playwright 10 clicks dev server (`http://127.0.0.1:5173/`) 0 detached errors; unit tests 196/196. Keep the `slice(0)` – removing it reintroduces the bug.

---

## 9. Caching layers (all bounded ~300)

| Cache | Key | Value | Eviction |
|-------|-----|-------|----------|
| `elevation.js:tileCache` | `z/x/y` | `Promise<ImageData>` | none (permanent) – delete on failure |
| `mcscRaw.js:bandCache` | `z/x/y` | `Promise<ImageData>` | same |
| `meteoGrid.js:gridCache` | `windowKey|variable` | `grid` | 30 |
| `tileWorker.js:cache` | `terrain|z/x/y|JSON(state)` / `sea|z/x/y|color` | `Promise<ArrayBuffer>` | 300 (oldest) |
| `terrainOverlay.js:mainThreadHandler cache` | `z/x/y|sig` | `Promise<{data}>` | 300 |
| `seaOverlay.js:mainThreadHandler cache` | `z/x/y|color` | same | 300 |
| MapLibre raster cache | tile URL | PNG | internal, busted via `&r` |

Transient paint failures produce `max-age=10` tiles so MapLibre re-requests soon.

---

## 10. Testing

* Pure: `terrainOverlay.test.js` (`colourForBand`, `classifyTerrainPixel`, `terrainStateSig`), `seaOverlay.test.js` (`classifySea`, `parseSeaTileUrl`), `mapFit.test.js`, `meteoGrid.test.js`, `lithology.test.js`, `mcscLegend.test.js`, `elevation.test.js`.
* Integration: `terrainOverlay.tile.test.js` – stubs `elevation.js`/`mcscRaw.js` + `FakeCanvas`/`FakeCtx`, captures `putImageData` pixels, asserts water vs land vs abroad, dimmed, altitude/meteo gates, substrate modes, **and** protocol resilience (`paintTerrainTile` never rejects, `abort` → transparent, `cacheControl max-age=10`).
* Playwright repro (not committed): click forest button 10× with `repaintBusy` wait, assert no `detached` logs.

Run `npm test`, `npm run build` after touching pipeline.

---

## 11. How to modify safely

* **New filter** → add to `terrainState` memo + `terrainStateSignature` + `classifyTerrainPixel` or `buildTerrainTile` sampling. Ensure `off/alt/filters` canonical sorting, or `terrainTileUrl` won't bust cache.
* **New mode** → extend `PAINT_MODES`, `terrainStateSignature.mode` mapping, `buildTerrainTile` branch, legend.
* **Keep `tilePaint.js` free of `maplibre-gl`** – it runs in worker (no DOM).
* **Never return same `ArrayBuffer` twice** – always `slice(0)` before `postMessage` / handing to MapLibre. Same for `transparentTilePng`.
* **Never reject** from protocol handlers – return transparent tile with short TTL.
* Respect `abort` signal: `paintTerrainTile(…,signal)` early-returns transparent if aborted, `tilePipeline` posts `abort` to worker.
* Bounds: only `terrain` is clipped; `sea`/`hillshade` stay global for seamless edges.

---

## 12. File map

```
src/App.jsx                 ─ terrainState memo, terrainTiles, onMapLoad, addAreaOverlays, repaint gate, pushTerrainContext
src/logic/tilePaint.js      ─ pure painters & helpers, buildSeaTile, buildTerrainTile, transparentTilePng (shared main+worker)
src/logic/tileWorker.js     ─ Web Worker queue, cache, postMessage (transfer)
src/logic/tilePipeline.js   ─ main→worker facade, ensureWorker, pending, fallback, paintTerrainTile/SeaTile
src/logic/terrainOverlay.js ─ terrain:// protocol, terrainStateSig/signature/tileUrl, registerTerrainProtocol
src/logic/seaOverlay.js     ─ sea:// protocol, registerSeaProtocol (re-exports from tilePaint)
src/logic/elevation.js      ─ DEM tiles, terrariumElevation, lngLat↔tile, loadTileImageData
src/logic/mcscRaw.js        ─ WMS band tiles, tileBbox3857, mcscBandTileUrl, loadMcscBandTile
src/logic/mcscLegend.js     ─ colours, values, entryForBand, isWaterBand, renderBandSld
src/logic/meteoGrid.js      ─ IDW grid, featuresForWindow, sampleMeteoGrid, getMeteoGrid
src/logic/lithology.js      ─ RLE decode, lithoFamilyAt, loadLithoGrid
src/logic/mapFit.js         ─ CATALONIA_BOUNDS, TERRAIN_OVERLAY_BOUNDS, fitZoomForViewport
src/logic/filterAggregate.js─ buildAggregateTable, limitsForWindow, windowToDates (powers grids & sliders)
vite.config.js              ─ base: /meteoscat/ (prod)
```

---

*Last bug: 2026-09-10 – worker detached buffer (see §8). Future change that adds caching should clone before transfer.*
