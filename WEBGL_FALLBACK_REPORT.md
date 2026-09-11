# WebGL / hardware-acceleration failure in Brave — diagnosis & workaround report

Status: **investigation only, no code changed.** Nothing in `src/` was modified.

## 1. Why the app breaks

The map is **MapLibre GL JS v6** (`maplibre-gl ^6.7.0`, mounted via
`@vis.gl/react-maplibre ^8.1.3`, see `src/App.jsx`). Two independent changes
collide here:

- **MapLibre v6 requires WebGL2.** WebGL1 support was removed in v6 (v5→v6
  migration guide: *"A browser or device that does not support WebGL2 will fail
  to render a map under v6"*). `webgl2` is non-negotiable.
- **Chromium removed the software-WebGL fallback.** Auto-falling back to
  SwiftShader when there is no usable GPU was deprecated
  (`chromestatus.com/feature/5166674414927872`) and is now off unless the
  `--enable-unsafe-swiftshader` switch / `EnableUnsafeSwiftShader` policy is set.

So: hardware acceleration off (or GPU blocklisted / driverless / GPU-process
crash) ⇒ **no WebGL2 context at all** ⇒ MapLibre throws during construction and
the map never renders. Brave is Chromium, and recently had its own regression
where WebGL *and* hw-accel turned off after an update (brave-browser issue
#52749, Chromium 144 on Linux Mint) — worth checking first if this started
right after a Brave update.

Expected console signatures: `Failed to initialize WebGL`,
`Error creating WebGL context`, and `brave://gpu` showing
`WebGL: Disabled` / `WebGL2: Disabled`.

## 2. What exactly stops working

`onMapLoad` (`src/App.jsx`) is the single entry point for everything
map-related, and it never fires without WebGL:

- `<Map>` canvas — blank, no vector basemap.
- Station layers `stations-circle` / `stations-label` / `stations-value`,
  their click handler, and the fly-to / elevation sampling.
- `registerTerrainProtocol(map, …)` and `registerSeaProtocol()` are **inside**
  `onMapLoad`, so the entire stacked overlay stack (terrain / substrate / sea
  raster) is never registered. `registerSeaProtocol()` needs no map, but it
  only runs here too.
- `mapLoaded` / `mapReady` stay `false`, so the overlay-add and station-source
  re-sync effects never run.
- 3D terrain (`showTerrain3D`) has no non-GL path at all.

**Still fine (no WebGL involved):** all data fetches, the HTML/CSS UI
(FilterPanel, StationPanel, legend), and the whole tile-paint pipeline —
`tileWorker.js`/`tilePaint.js` use `OffscreenCanvas` + 2D contexts, and
`elevation.js` / `mcscRaw.js` use canvas-2D `getContext('2d',
{ willReadFrequently: true })`. The tiles would still be painted; nothing can
display them.

## 3. Workarounds — user side (no code change, fastest)

1. **Turn hardware acceleration back on**: `brave://settings/system` →
   *Use graphics acceleration when available* → ON → relaunch. Verify in
   `brave://gpu` that *WebGL* and *WebGL2* both read
   `Hardware accelerated` (not `Disabled`).
2. **Override a GPU blocklist**: `brave://flags/#ignore-gpu-blocklist` →
   *Enabled*, relaunch. Good when the GPU is fine but the driver version is
   blocklisted. On Linux, also make sure Mesa/Vulkan drivers are installed.
3. **Re-enable software WebGL** (explicitly opt in, since it is now off by
   default): `brave://flags/#enable-unsafe-swiftshader` → *Enabled*, or launch
   `brave --enable-unsafe-swiftshader`. This trades security/performance for a
   working map and is the only in-Brave option on a machine with no usable GPU.
4. **Loosen Shields if set to Strict**: per-site Shields → *Fingerprinting* →
   *Standard* (Strict/aggressive fingerprint blocking can suppress WebGL).
5. **Different browser as a stopgap**: Firefox still ships its own software
   WebGL fallback (llvmpipe/software WebRender), so the map renders without a
   GPU where Brave now refuses to.
6. **Wayland/Linux only**: launching with `--ozone-platform=x11` has restored
   GPU acceleration for several affected Brave users.

If none of 1–6 work, the machine genuinely cannot create a WebGL2 context and
no amount of configuration will help — see §4.

## 4. Workarounds — code side (options, not implemented)

Ordered by effort:

- **A. Capability detection + explicit message — ✅ IMPLEMENTED.**
  `src/logic/webgl2.js` probes `document.createElement('canvas')
  .getContext('webgl2')` before `<Map>` is mounted, and
  `src/comps/MapUnavailable.jsx` renders the explanation + fix steps (§3) in
  place of the blank canvas. A runtime failure is caught too, via the map's
  `onError` prop, which react-maplibre also uses for constructor failures —
  classified by `isGPUInitializationError()` so a failed tile fetch does not
  tear down a working map. (`failIfMajorPerformanceCaveat` is left at its
  default `false`, so a software renderer is accepted where one exists.)
- **B. Non-WebGL fallback map (the only true no-GPU path).** Fully evaluated
  in **§6** below — headline cost ≈ 8.5–14 developer-days, and 3D terrain plus
  the client-side hillshade cannot be carried over.
- **C. Downgrade to MapLibre v5 — not a fix.** v5 accepts WebGL1, but with
  Chromium's software fallback gone, a no-GPU machine still fails to create
  even a WebGL1 context. It only helps hardware with WebGL1-but-not-WebGL2.

## 5. Recommendation

1. Confirm the cause in `brave://gpu` (WebGL2 Disabled?).
2. Apply §3.1 → §3.2 → §3.3 in order; that resolves the large majority of
   cases without any code change.
3. If users on GPU-less machines must be supported, add **A** (graceful
   detection + message) now, and decide **B** against the costings in §6 —
   the static-snapshot option there is ~4× cheaper than a full Leaflet backend.

## 6. Leaflet fallback — cost evaluation

Scope: keep the app usable with **no WebGL2 available at all**, by rendering the
map with Leaflet's DOM/canvas stack while MapLibre keeps serving capable
browsers. This is the honest cost of option B, derived from the current
`src/App.jsx` (1267 lines) and the `src/logic/*` overlay modules.

### 6.1 Capability-by-capability port map

| # | Capability (where) | MapLibre mechanism | Leaflet equivalent | Verdict |
| :-- | :-- | :-- | :-- | :-- |
| 1 | Dark basemap (`styleUrl`) | Vector style JSON, Stadia `alidade_smooth_dark` | Stadia **raster** tiles (`docs.stadiamaps.com/raster/`) | Portable; look changes (no runtime restyling), same domain-auth/API-key requirement already in force |
| 2 | Station circles | `circle` layer, data-driven `circle-color` bolet ramp (`interpolate`+`coalesce`), radius 6, white stroke | `L.geoJSON` + `L.circleMarker` with a style function | Portable |
| 3 | Station name labels | `symbol` layer, `coalesce(nom, codi)`, offset/anchor | permanent `L.tooltip` or `L.divIcon` | Portable |
| 4 | Value labels inside circles | `symbol` layer, size 24, halo, `text-allow-overlap` + `text-ignore-placement`, `text-field` swapped per `labelMode` | `L.divIcon` with HTML + CSS (`text-shadow` for the halo) | Portable, arguably simpler |
| 5 | Label decluttering | MapLibre hides colliding labels | Leaflet divIcons never collide-check | Behaviour change: denser labels |
| 6 | `terrain://` overlay | Custom `addProtocol` raster source; filter state baked into the tile URL; `setTiles()` to regenerate | Custom `L.TileLayer.createTile()` calling the **same** `buildTerrainTile` | Portable; needs new tile-layer code |
| 7 | `sea://` overlay | Same protocol mechanism | Same `createTile()` approach | Portable; needs new tile-layer code |
| 8 | `&r=` monotonic repaint token | Workaround for MapLibre's raster tile cache serving stale states | Not needed — `redraw()` / layer recreation | Simplifies |
| 9 | DEM tiles (terrarium) | `raster-dem` source | No DEM source in Leaflet | DEM fetch/decode in `elevation.js` / `seaOverlay` is canvas-2D and **reusable**; the source abstraction is not |
| 10 | Hillshade (`hillshade` layer) | GPU-computed from the DEM | No equivalent | **Must swap to hosted raster hillshade tiles or drop.** Dropping it guts the `'none'` (relief) mode, which works precisely by leaving failing land transparent so the hillshade shows through |
| 11 | 3D terrain | `setTerrain({ exaggeration: 1.3 })`, `easeTo({ pitch: 55, bearing: -20 })` | None | **Not portable.** Any GL plugin defeats the purpose → drop the feature and gate/hide the 3D button |
| 12 | Camera constraints | `setMaxBounds`, `setMinZoom(fitted)`, `setMaxZoom`, `jumpTo` | `maxBounds`, `minZoom`, `setView` | Portable; `fitZoomForViewport` (`mapFit.js`) is pure math → **reused unchanged** |
| 13 | Fly-to station, ease-to 3D | `flyTo`, `easeTo` | `flyTo` / `setView` | Portable minus the pitch/bearing half |
| 14 | Cursor over stations | `map.getCanvas().style.cursor` | `map.getContainer()` | ~6 small call-site edits |
| 15 | Station/map click (+ directions mode) | `map.on('click', 'stations-circle')`, map-level click | `layer.on('click')`, `map.on('click')` | Portable |
| 16 | `map.once('idle')` | Lazily add heavy overlays; unlock the FilterPanel repaint gate | **No `idle` event** | Either rely on the existing 3 s / 5 s safety timeouts (inputs locked up to 5 s per filter apply — UX regression) or hand-roll a tile-load counter |
| 17 | Source attributions | per-source `attribution` | `L.control.attribution` | Portable |
| 18 | Style remount via `key={styleUrl}` | React remount | Recreate the tile layer | Portable |

### 6.2 What is reusable

The map coupling is concentrated: **only `src/App.jsx` and the two
protocol-registration modules** (`terrainOverlay.js`, `seaOverlay.js`) talk to
MapLibre. Everything below survives untouched because it is framework-agnostic
or pure:

- `tilePaint.js` — the per-pixel terrain/sea painters (return PNG buffers).
- `tilePipeline.js` + `tileWorker.js` — worker dispatch, request queue, bounded
  caches, abort handling. Only its `transparentResult()` shape is MapLibre-ish
  (`{ data }`), trivially adapted.
- `mapFit.js` (bounds + fit-zoom math), `filterAggregate.js`, `boletEngine.js`,
  `computeGeoValues.js`, `elevation.js`, `mcscRaw.js`, `lithology.js`,
  `refineData.js`, `geojsonCreator.js`, `mcscLegend.js`, `utils.js`.
- Their unit tests keep passing. The `terrainOverlay`/`seaOverlay` protocol
  registration becomes the GL-only branch; their tile tests stay valid.

This is the main reason the estimate is two weeks rather than two months: the
hard part (client-side per-pixel raster production) is already independent of
the map library. Leaflet's `createTile()` is a viable consumer of it.

### 6.3 Effort estimate

| Phase | Work | Days |
| :-- | :-- | :-- |
| P0 | WebGL2 detection + route selection, feature gating | 0.5–1 |
| P1 | Leaflet map shell: init, bounds/min-zoom/max-zoom, resize refit, cursor, attribution | 1.5–2.5 |
| P2 | Stations: circle markers, name + value divIcons, bolet ramp, click/hover, source re-sync | 1–2 |
| P3 | Custom `L.TileLayer`s for `terrain://` and `sea://`, state-change redraw, cache keys | 2–3 |
| P4 | Raster basemap swap; hillshade replacement; relief-mode semantics; 3D button gating | 1–2 |
| P5 | Repaint busy-lock without `idle` (tile-load counting) | 0.5–1 |
| P6 | Tests: new map-component/integration coverage, dual-backend regression pass | 1.5–2 |
| P7 | Lazy bundling (Leaflet ≈ 42 KB gz + CSS, code-split so WebGL users never download it) | 0.5 |
| | **Total** | **8.5–14 days** |

Ongoing cost (the part estimates usually miss): two map backends to maintain,
two visual baselines to check, and a parity decision on every future
map-facing feature. Two behaviours diverge by design from day one — no 3D
terrain, no MapLibre hillshade — so the Leaflet path is a *reduced* product,
not a like-for-like clone.

New dependency: `leaflet` (^1.9.x) + its CSS, neither currently in
`package.json`. Plain imperative Leaflet fits this codebase better than
`react-leaflet`: the app already drives the map through refs
(`mapRef`, `terrainStateRef`, …), and react-leaflet would add a second
abstraction over an imperative API for little gain.

### 6.4 Cheaper alternatives, and one worth a spike

- **Detection + clear message only (0.5–1 day, = option A).** No fallback map,
  but no silent blank canvas either. Cheap and useful no matter what.
- **Static snapshot mode (2–4 days).** Render the current filter state once at a
  fixed extent as a single PNG, no pan/zoom. Reuses the painters and grid math
  only; loses pan, zoom, fly-to and station click-to-zoom. ~4× cheaper than the
  full backend and covers "let me see the map" without promising interaction.
- **OpenLayers instead of Leaflet.** OL still ships a **2D canvas** vector
  renderer (present in the v10.9 API docs), and its `TileImage` sources take a
  custom `tileLoadFunction`, which suits client-side painters about as well as
  Leaflet's `createTile`, with stronger tile/projection control. Heavier bundle
  and API; effort roughly comparable. Worth a 1-day spike only if the app's
  tile/layer needs grow.

### 6.5 Recommendation

Ordered by cost/benefit:

1. ~~**Do P0 (detection + message)**~~ — **done** (see §4.A).
2. **Add static snapshot mode** if GPU-less users must at least see data.
3. **Only build the full Leaflet backend** if you accept ~2 weeks, permanent
   dual maintenance, and the loss of 3D terrain and the DEM hillshade. If you do,
   P3 is the critical path — prove early that a custom `L.TileLayer`
   `createTile()` can consume `buildTerrainTile`/`buildSeaTile` output at
   acceptable pan/zoom performance, because everything else is comparatively
   mechanical.

## Caveat

This was a static-source + upstream-docs investigation. There is no Chrome/Brave
in this environment, so the failure was **not** reproduced live; the
`brave://gpu` / console checks in §1 are what to run to confirm on the affected
machine. §6 is a code-derived estimate — no Leaflet prototype was written or
benchmarked, and P3's performance is the estimate's largest unknown.
