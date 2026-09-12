# App State Report — Station Filter → Area Filter (post-refactor)

> **Scope:** coding side only — no product/marketing, no deploy.
> **Instruction:** don't touch code; this file is the plan + audit.
> **Date:** 2026-09-10 · branch `main` · 18 commits since 2025-10-14
> **Related docs:** `TILE_RENDERING.md` (tile pipeline), `FILTER_REFACTOR_PLAN.md` (per-instance windows, §13 stacked overlay), `MUSHROOM_APP_PLAN.md` (bolet scoring)

> ### ✅ Status update — 2026-09-12 (read this before the body)
>
> **Implemented.** The body below is the plan *as written before coding*; the sections are in
> the present tense of the pre-refactor code, so treat §1–§3 as history.
>
> - **Phase A (stations info-only): DONE.** Stations are never dimmed; `filteredStationsCodes`
>   no longer drives the layers. `filterStationCodes` survives only as pure, tested code that
>   nothing calls (see `APP_STATE_REPORT.md` §7.5).
> - **§7 Phase A.3 (fixed rain-last-15 window): SUPERSEDED.** The station value window now
>   *follows the filters* — each variable's label aggregates over its last ACTIVE filter's day
>   range, or the 60-day default when none is active (`App.jsx` `stationDayRange`). The old
>   5-way `LABEL_MODES` cycle survived, but with filter-following windows.
> - **§6.2 / Phase B (crimson veil) : REVERTED and then replaced.** `none` now paints a green
>   highlight on the land that passes every active filter, and falls back to a zero-fetch
>   transparent tile when no filter is active (`TILE_RENDERING.md` §4.1).
> - **Phase C (palette/gate scope): DONE** — both `off` and `geoOff` gate every render mode.
> - **Test counts: this file is stale.** It lists 14 files / 196 tests; the suite is now
>   **339 tests / 24 files** (`npm test`, 2026-09-12).
>
> For the current state of everything, see `APP_STATE_REPORT.md`.

---

## 0. TL;DR — what the user just clarified

| Before | Now (desired) |
|---|---|
| Filters dimmed **stations** (grey + small + hidden value). Map was a helper. | Filters paint **pixels** (areas). Stack = AND. A pixel is coloured iff **every** active condition passes, else transparent → relief shows through. |
| `terrainMode` was a "paint mode" but still coupled to station filtering. | `terrainMode` (forest-sel button: 🌳 terrain / 🟫 substrate / 🚫 none) chooses **how** passing pixels are coloured, not *whether* they pass. |
| Stations showed values only when "in range". | Stations are **never filtered**. They always render at full style. The bottom-left cycle button only toggles **which value the circle label shows** (for now: rain summed over last 15 days; later the window becomes configurable). This lets the user read raw values *outside* the coloured areas. |
| `none` (relief) painted nothing. | `none` keeps painting nothing: the tile is **fully transparent, with zero fetches** — relief + basemap only. An interim veil over the failing pixels (`rgba(220,20,60,0.35)`) was implemented and then **removed** (2026-09-11): it read as red patches unrelated to any filter, because with no filter active the only pixels that fail are the MCSC bands with no legend entry (230–234). See §6.2. |

Example from the brief: `terrainMode = substrate`, filters = { `Bosc` class X selected, `Calcaric terrain` family selected, `rain 100+ mm day 4–8`, `temp 20–26 °C day 12–21` } → tiles are sampled in substrate colours, but only where BOTH the meteo IDW values AND alt band AND class/family gates pass. One failing condition → that pixel is relief.

---

## 1. Codebase inventory (what exists after the big refactor)

```
src/App.jsx               — single-page app: state, memos, map lifecycle, repaint gate
src/logic/tilePaint.js    — pure painters (shared main thread + worker),  must stay maplibre-free
src/logic/tilePipeline.js — main→worker facade, pending map, fallback transparent tile
src/logic/tileWorker.js   — Web Worker: queue (MAX_ACTIVE=6), cache (300), abort handling
src/logic/terrainOverlay.js — terrain:// protocol, state signature, tile URL
src/logic/seaOverlay.js     — sea:// protocol (DEM ≤0 → navy)
src/logic/elevation.js    — terrarium DEM tiles, lngLat↔tile, sampleElevation
src/logic/mcscLegend.js   — 9 MCSC entries, 41 bands, water bands, renderBandSld
src/logic/mcscRaw.js      — raw-band WMS (band → #vv0000), tileBbox3857, loadMcscBandTile
src/logic/meteoGrid.js    — IDW grid (0.01° ≈1.1km), featuresForWindow, sampleMeteoGrid, getMeteoGrid
src/logic/lithology.js    — RLE litho_grid.json decode, lithoFamilyAt, lithoLegendEntries
src/logic/filterAggregate.js — prefix sums per station/var, aggregateWindow, windowToDates, limitsForWindow
src/logic/filterStations.js  — filterStationCodes (pure AND, now: meteo+relief+geo+bolet intersect)
src/logic/computeGeoValues.js— geoWithData over displayWindow (station circle values)
src/logic/refineData.js   — loadAvailableDays + loadSummaries (all days, Promise.all shards)
src/logic/boletEngine.js + speciesRules.js — bolet scoring (5 species, windowDays, forest host gate)
src/logic/mapFit.js       — CATALONIA_BOUNDS, TERRAIN_OVERLAY_BOUNDS, fitZoomForViewport
src/logic/utils.js        — parseDay, getDaysInRange, fmt, fmtShortCat, fmtNum, …
src/comps/FilterPanel.jsx — filter UI: header anchor, Bosc/Substrat/Relleu rows, Bolets, Mètriques instances
src/comps/StationPanel.jsx— bottom sheet: station header + 3 bar charts + day strip, bolet score
src/App.css + comps/rangesliders.css — layout, busy dimming, legend styles
public/logic/daily/*.json — 60 shards (~2.1 MB), index.json, stations.geojson, forest_types.json, litho_grid.json
vite.config.js            — base /meteoscat/ in prod, ?worker&url for maplibre worker
```

**Test files (24, 339 tests)** — counted 2026-09-12, so longer than the 14 this report was written against: `elevation.test.js` (30, incl. the slope-aspect helpers), `filterAggregate.test.js` (25), `terrainOverlay.tile.test.js` (24), `terrainOverlay.test.js` (24), `utils.test.js` (22), `speciesRules.test.js` (22), `filterStations.test.js` (20, now guards unused code), `meteoGrid.test.js` (19), `savedFilters.test.js` (15), `areaFilterMatch.test.js` (15), `savedLocations.test.js` (14), `DirectionsModal.test.jsx` (13), `areaElevation.test.js` (12), `areaComposition.test.js` (12), `webgl2.test.js` (11), `seaOverlay.test.js` (11), `nearestStations.test.js` (9), `mcscLegend.test.js` (8), `mapFit.test.js` (8), `lithology.test.js` (8), `boletEngine.test.js` (7), `refineData.test.js` (6), `FilterPanel.render.test.jsx` (2), `App.render.test.jsx` (2).

---

## 2. Current data flow & state model

### 2.1 React state in `App.jsx`

```js
days: string[]                         // index.json, oldest first
data: { [YYYY-MM-DD]: { [codi]: {tempAvg,humAvg,precAcc,…}, dayStats } }
stationsGeo: FeatureCollection         // static metadata (nom, comarca, altitud, geom)
geoWithData: FeatureCollection         // stationsGeo ⊕ displayWindow aggregates (precAcc/tempAvg/humAvg)
lithoGrid: decoded grid | null
forestByCode: { [codi]: forestType }  // from forest_types.json

// filters (the stack)
reliefRange: [lo,hi] | null            // altitude band (m), null = off (full span)
mcscOff: Set<codes>                     // dimmed MCSC legend entries
geoOff: Set<familyKey>                 // dimmed lithology families
meteoFilters: { id, type: rain|hum|temp, from, to, range:[lo,hi] }[] // per-instance windows
nextFilterId: number
boletFilter: { species, threshold } | null

// rendering + UI
terrainMode: 'terrain'|'substrate'|'none'   // 🌳 / 🟫 / 🚫
labelMode: 'none'|'precAcc'|'altitud'|'tempAvg'|'humAvg' // station circle text
showLegend, showFilter, showTerrain3D, mapReady, repaintBusy, …
filteredStationsCodes: string[]        // derived (see §2.3)
```

### 2.2 Derived memos

- `refDay = parseDay(days[days.length-1])`, `maxDays = days.length`
- `agg = buildAggregateTable(data)` — prefix sums for every (station, var) over sorted days. O(vars×days×stations) ≈ 34k ops once.
- `altLimits = [minAlt, maxAlt]` from `stationsGeo` metadata (static)
- `geoLegend = lithoLegendEntries(lithoGrid)` — selectable families (id>0)
- `displayWindow = [refDay-59, refDay]` (`DISPLAY_DAYS=60`) — drives `geoWithData` and `StationPanel`/`labelMode` values (not filters).
- `boletScores = scoreStations(data, last windowDays of displayWindow, species, forestByCode)` + `boletPassing = Set(codes ≥ threshold)`
- `terrainState = { mode, off: sorted(mcscOff), alt: reliefRange if narrowed, filters: active instances sorted, geoOff: sorted(geoOff) if substrate else [] }`
- `terrainTiles = [terrainTileUrl(terrainState)]` — `terrain://{z}/{x}/{y}?s=<sig>` with `&r` cache buster on change.
- `seaColorHex = mcscOff has Aigües ? null : '2a2ab7'`

### 2.3 Station filtering (today — contradicts desired)

`filterStationCodes(stationsFeatures, meteoFilters, reliefRange, agg, {off:geoOff, grid:lithoGrid})` → `filteredStationsCodes` is then intersected with `boletPassing` if a bolet filter is on. Active check: an instance constrains only if `range !== limitsForWindow(type, from, to)` (full span = inert). Relief active only if narrowed below `altLimits`. Geo active only if grid loaded + set non-empty. Returns `[]` when nothing constrains → caller treats as "show everything". Stations with `inRange=false` are rendered dimmed (smaller, faded, grey, value hidden via `valueFieldDimmed`).

> **Gap vs desired:** stations must stop being filtered at all. The entire `filteredStationsCodes` pipeline and its visual dimming need to be retired (or kept only as an optional debug overlay). See §6.
>
> **✅ Resolved (Phase A):** this effect and the dimmed circle/label paint are gone. Stations always render at full style. `filterStations.js` is kept only as pure, tested code with no caller.

### 2.4 Map lifecycle (`onMapLoad`)

1. Fit & clamp camera (`fittedMinZoom` via `fitZoomForViewport`), `jumpTo(center, minZoom+1)`.
2. Ensure `stations` source + `stations-circle` / `stations-label` / `stations-value` layers (value layer `text-field = valueField(labelMode)`).
3. `registerTerrainProtocol(map, () => terrainStateRef.current)` + `registerSeaProtocol()` — no tiles yet.
4. Click/hover handlers (station panel + directions `window.open(google maps)`), resize listener (`setMinZoom(fittedMinZoom(w,h))` debounced 200ms).
5. Lazy `addAreaOverlays` on first `idle` or 3 s timeout → adds `terrain` raster (`terrain://`, bounds `TERRAIN_OVERLAY_BOUNDS [-1.25,39.75,4.25,44.25]`, z7–14, opacity 0.85, below stations), `hillshade-dem` raster-dem (terrarium, z15) plus a second `terrain-dem` raster-dem over the same tiles for `setTerrain` only (kept split so the 3D toggle can't drag the hillshade onto the terrain tile grid), `hillshade` (exaggeration 0.4, below stations, not clipped), `sea` raster (`sea://`, z7–15, between hillshade and terrain), then `setMapReady(true)`.

Effects after `mapReady`: terrain repaint (throttled 150 ms, `&r` token), sea repaint, 3D toggle, `pushTerrainContext({agg, features, lithoGrid})` to worker, station source sync (`setData` + `setPaintProperty` for dimming / bolet ramp).

---

## 3. Tile rendering pipeline (today)

### 3.1 Stacked terrain overlay — per-pixel AND

`tilePaint.buildTerrainTile(z,x,y, state, getContext)` — the heart. Falls through to transparent early if `mode==='none'`.

```
off = Set(state.off), offGeo = Set(state.geoOff)
bandColours[0..41] = colourForBand(b)                 // null = dimmed / 230–234 / no data
substrateColours[id] = lithoFamilyColour(grid, id)   // if lithoGrid present
for each active filter f in state.filters:
  windowFeatures = featuresForWindow(agg, features, f.variable, f.from, f.to)
  grid = getMeteoGrid("from_to", variable, windowFeatures, { lapseRate: 6.5 if temp })
  los/his = f.band
needElev = altBand || any grid.lapseRate>0
bandImg = await loadMcscBandTile(z,x,y)             // WMS band→red, cached per z/x/y, retry 1×250ms
src = needElev ? await loadTileImageData(z,x,y) : null  // DEM ImageData, cached per z/x/y, retry

for each of 65k pixels (row-major, lngs/lats precomputed per col/row):
  band = s[i] (red)
  if !band → transparent
  isWater = isWaterBand(band)
  colour =
    isWater ? bandColours[band]                     // shared water, never gated
    : substrate ? substrateColours[lithoFamilyAt(grid,lng,lat)] // id>0 else transparent
    : bandColours[band]
  if !colour → transparent
  elev = needElev ? terrariumElevation(src.data…) : NaN
  if !isWater && grids.length: values[k] = sampleMeteoGrid(grid,lng,lat) [- lapse*elev/1000 if temp]
  c = classifyTerrainPixel(colour, isWater, elev, altBand, values, los, his, familyKey, offGeo)
  if c !== transparent → write RGBA
putImageData → canvasToBlob → ArrayBuffer
```

`classifyTerrainPixel` (pure):

```
!colour → transparent
isWater → colour (no gates)
familyKey ∈ offKeys → transparent              // geology
altBand && (elev≤0||!finite||outside) → transparent
any value ∉ [lo,hi] or NaN → transparent
else colour
```

Water is never gated. Nodata litho (family 0) never gated. Inclusive bounds. Failing pixels are `[0,0,0,0]` → hillshade shows through. `substrate` falls back to terrain colours if grid missing. `none` short-circuits with zero fetches.

### 3.2 Sea overlay

`buildSeaTile(z,x,y, colorHex)` — `null` → transparent tile (overlay off when Aigües dimmed). Else `loadTileImageData` → per-pixel `classifySea(elev,color)` (`elev>0 || NaN → transparent` else navy). Same retry/cache as terrain DEM.

### 3.3 Worker vs main thread

- `tilePaint.js` is maplibre-free (import-safe in Node tests); `makeCanvas` → `OffscreenCanvas` if present else `document.createElement('canvas')`.
- `tileWorker.js` — `context={}` (latest push), `cache Map<key,Promise<ArrayBuffer>>` (300, evict oldest, delete on failure), `queue[]` FIFO, `MAX_ACTIVE=6` (browser per-host budget). `cached(key,build)` dedupes in-flight. Messages: `ctx`, `tile {id,kind,payload}`, `abort {id}` → `tile {id,ok,buf|error}` (transferable). `run` does `raw.slice(0)` before `postMessage([buf])` — cache keeps original.
- `tilePipeline.js` — `workerPossible = Worker && OffscreenCanvas` (lazy), `ensureWorker()` once (posts context), `pushTerrainContext(next)` (replays if worker started late), `requestInWorker(kind,payload,signal)` with `pending Map` and `signal abort → postMessage abort + resolve(transparentResult())`, `paintTerrainTile` / `paintSeaTile` never reject (fallback `transparentResult` or `fallbackTransparent` with `cacheControl:'max-age=10'`), abort-aware.
- `terrainOverlay.js` / `seaOverlay.js` — state signature (`terrainStateSignature` canonicalises sorted off/geoOff/filters, mode→terrain|substrate|none), `terrainTileUrl`, `parseTerrainTileUrl/parseSeaTileUrl` (allow `&r` token), `registerTerrainProtocol`/`registerSeaProtocol` pick workerHandler vs mainThreadHandler (`Map<z/x/y|sig,Promise>` 300) at registration time via `isWorkerMode()`. Both handlers `transparentResult()` on bad URL, never reject.

### 3.4 Known bug & fix (2026-09, §8 of TILE_RENDERING.md)

Detached `ArrayBuffer` on transfer: `transparentPng` and worker `run` now always `slice(0)` before transfer; `OffscreenCanvas` now `getContext('2d')` before `convertToBlob`. Without this, toggling `none→terrain` after 2 cycles wedged the layer (DataCloneError → fallback transparent stuck, zoom recovered patchily). Playwright 10-click repro + the unit suite guard it (196 at the time; **339 tests / 24 files** today). **Keep the `slice(0)`.**

---

## 4. Filter panel today (`FilterPanel.jsx`)

- **Header:** `Filtres — fins a les dades del 02 set — [✕]`. No global calendar.
- **Single timeless filters (buttons → editor → applied row):**
  - 🌳 **Bosc** (terrain classes) — toggles `mcscOff` (Set of `codes`), single `Set` for whole app
  - ⛰ **Relleu** (altitude) — `RangeSlider [minAlt,maxAlt]` step 10 m
  - 🟫 **Substrat** (lithology families) — toggles `geoOff` (Set of family keys), hidden until `lithoGrid` loads, nodata never listed
  - 🥕 **Bolets** (experimental) — species picker + threshold slider 0–1, drives `boletFilter`
- **Mètriques** section — per-instance meteo filters:
  - Add row: `+ Pluja / + Humitat / + Temperatura` (MAX_PER_TYPE=5 per type, cap disables button)
  - Instance row collapsed: `Pluja · 19 ago – 02 set (darrers 14 dies) · 50–120 mm [✕]` or `qualsevol valor · inactiu` (inert = band==full span, dashed outline, italic)
  - Instance editor (expands in place, one at a time, `draft={from,to,range}`, `pendingId` for just-added): day-range slider on **day-index axis** `0..maxDays-1` (oldest→newest, stored as offsets `from≥to`), value slider with `min/max = limitsForWindow(type,from,to)`, clamping on day change, `✓/✕` (apply/cancel; cancel on pending removes instance)
  - Inert instances create no tile-layer and no station filtering (contract: full span = off).

All changes are **instant** (state-driven). No "Aplicar" — the old ✓ was just "close".

---

## 5. Performance audit

### 5.1 What is already optimised

| Concern | Current mitigation | Verdict |
|---|---|---|
| **DEM + MCSC fetches** | `tileCache` / `bandCache` per `z/x/y` (permanent, delete on failure), `fetchWithRetry` 1×250 ms, per-tile only when needed (`needElev = altBand || tempFilter`), `TERRAIN_OVERLAY_BOUNDS` clip so tiles outside Catalonia never requested | Good. Keep. |
| **IDW grids** | `getMeteoGrid` cache 30 entries keyed `from_to|variable`, `buildMeteoGrid` once per (window,variable), stations with `null` skipped, exact-hit short-circuit, `maxDistKm=50` → NaN outside, `GRID_STEP 0.01°` (200k cells), lapse pre-reduction | Good — but see §5.2 for cost. |
| **Aggregate table** | Prefix sums O(1) per window, `limitsForWindow` memoised per table via `WeakMap` (200 entries LRU), `hasNumber` guards, hum rounded to whole % | Good. |
| **Tile painting** | Worker + `OffscreenCanvas` with 6-way concurrency, 300-entry tile cache (deduped in-flight), `queue` FIFO + `abort` for zoom bursts, `pump()` respects cap, never-reject + `max-age:10` fallback, throttled repaint 150 ms + input gate (`repaintBusy` 5 s timeout, `samePair/sameSet/inertInstance` no-ops) | Good. The gate prevents "map stops working" bursts on old phones. |
| **Viewport** | `fittedMinZoom` per screen (48 px padding, floor 5.5) + `CATALONIA_BOUNDS` maxBounds + resize debounced 200 ms | Good — wide screens no longer fetch Mediterranean tiles; phones finally fit Catalonia. |
| **Data loading** | All 60 shards fetched in parallel (`Promise.all`), ~2.1 MB, aggregate table after | Acceptable at 60 days; grows ~1 shard/day. |

### 5.2 Remaining hot spots / risks

1. **Per-pixel meteo sampling is the tile cost.** For each passing land pixel, `sampleMeteoGrid` (bilinear) runs `N = #active instances` times. With 3 temps + alt + 2 litho families the loop is ~5 samples × 65k pixels ≈ 325k bilinear ops per tile. Add `lithoFamilyAt` (array index) — cheap. IDW grid *build* is the real wall: ~200k cells × 190 stations = **~38 M distance calcs per grid**, ~0.1–0.3 s on desktop, >1 s on old Android. This happens once per (window,variable) and is cached, but adding a 4th instance with a new window still pays it. **Cap 5 per type already bounds worst case (15 grids = ~570 M ops if all distinct windows) — keep the cap, and consider building grids off the main thread (inside `tileWorker`) if jank appears.**
2. **`none` is the cheapest mode, not a same-cost recolour.** It returns the shared transparent tile *before* `needElev`, the MCSC fetch, the IDW grids and the 65k-pixel loop — zero fetch, zero per-pixel work per tile. (The interim veil made it cost the same as `terrain`; a red border would have cost ~1.5–1.6× + a 64 KB `pass` buffer — both rejected, see §6.2.)
3. **Canvas churn.** `buildTerrainTile` allocates a fresh 256² `ImageData` + `Float64Array` lngs/lats + `values` per tile. At 6 tiles in flight that's ~ (65k×4 ≈ 256 KB) ×6 ≈ 1.5 MB plus grid memory — fine. `none` allocates no canvas at all (it returns the cached transparent PNG). Avoid per-pixel `new Set` / string allocs.
4. **Tile cache key size.** `terrain|z/x/y|JSON(state)` embeds the full filter JSON (dates + bands) per tile. With 3 instances the JSON is ~300 chars, ×300 cached tiles ≈ 90 KB of keys — negligible. The `&r` serial is not part of the worker key (it lives only in the MapLibre URL cache bust), so worker cache hits survive mode cycles — correct.
5. **React memo churn.** `terrainState` rebuilds on every filter change (expected). `geoWithData` recomputes on every `displayWindow` change (60-day chart). Both are `useMemo`-guarded; `stationsFeatures` is stabilised via `geoWithData?.features ?? []` fallback — correct. Avoid adding `filteredStationsCodes` back into `terrainState` deps if stations become unfiltered.
6. **Shard growth.** 60 × ~35 KB = 2.1 MB today, `loadSummaries` fetches all via `Promise.all` (60 parallel fetches). At 365 days that's ~13 MB / 365 parallel requests — will need a bundled `all_days.json` or chunked fetch. Not blocking now, but track.
7. **Memory on litho grid.** `decodeLithoGrid` produces `Uint8Array(cols×rows)` + `cells` plus `entries` + `keyById`. At 0.01°-ish step over Catalonia this is a few MB — fine. The file is fetched once.
8. **Sea + terrain double DEM fetch.** Tiles that need elevation for both layers could share the same `loadTileImageData` promise (they already do via the same `tileCache` key) — no duplicate fetch, but two `ImageData` references are held transiently. Fine.

### 5.3 Perf invariants to preserve

- Never `await` inside the pixel loop except for the two tile fetches *before* the loop.
- Keep `tilePaint.js` free of `maplibre-gl` so it stays worker-bundleable.
- Keep `MAX_ACTIVE=6` (≈ per-host HTTP budget); raising it melts the ICGC WMS.
- Keep `TERRAIN_OVERLAY_BOUNDS` and `fittedMinZoom` — without them a zoomed-out view requests dozens of empty ocean tiles and the worker queue backs up.
- Keep the `slice(0)` clone before every `postMessage` transfer.

---

## 6. Gaps vs desired spec (coding side)

### 6.1 Stations must become info-only

**Today:** `filterStationCodes` + `filteredStationsCodes` + `boletPassing` gate dimming; `stations-circle` paint switches on `inRange` (`#888` vs `MCSC_GREY`, opacity 1→0.3, radius 6→3), `stations-label` faded, `stations-value` hidden via `valueFieldDimmed`.

**Desired:** remove that entire gate. Stations render identically regardless of area filters. The only dynamic on stations is the **value label** (which variable/window the circle shows). That means:

- Delete or bypass the `filterStationCodes` → `filteredStationsCodes` effect as a map concern (keep the module pure for tests, but don't wire it to `setData` / `setPaintProperty`).
- Remove `inRange` from feature properties and the `valueFieldDimmed` wrapper; restore `valueField(labelMode)` unconditionally.
- Remove the dimmed circle/label paint overrides. The bolet ramp can stay as an *optional* colour-by-score mode, but must not be conflated with "filter pass/fail".
- `labelMode` cycle currently is `none→precAcc→altitud→tempAvg→humAvg` over the 60-day `displayWindow`. Desired for now: a single toggle showing rain over the **last 15 days** (fixed window), later made configurable. The panel spec will decide whether the toggle cycles rain/hum/temp windows or switches to a configurable "station info window" slider.

**Why it matters:** users need to read a station's numbers *outside* the coloured area to reason ("this station got 20 mm but the surrounding pixel is uncoloured because the calcaric gate failed"). Dimming hides that.

### 6.2 Render mode `none` → green filter highlight (veil removed, then replaced 2026-09-11)

**Update (2026-09-11, later the same day):** the relief-only `none` mode was changed again — it now **tints the PASSING land bright green** (`TERRAIN_HIGHLIGHT = [0,255,0,165]`) instead of painting nothing, so the user can still see where the active filters apply without a class/family palette. The tint only renders while at least one filter condition is active (`hasActiveTerrainFilter`); with no filter it stays the cheap relief-only transparent tile. While a filter is active it runs the full pipeline (MCSC + DEM + meteo sampling), water is left transparent, and failing land stays transparent. This is the inverse of the crimson veil below: the veil marked what was EXCLUDED, the highlight marks what is INCLUDED. See `TILE_RENDERING.md` §4.1. The paragraphs below are kept for the decision history.

**Previous behaviour:** `buildTerrainTile` early-returned a fully transparent PNG for `mode==='none'` — zero fetches, zero per-pixel work, no canvas. Relief + basemap only.

**Decision history.** An interim review chose the opposite — a semitransparent veil over the failing pixels (`VEIL=[220,20,60,90]`) — and Phase B implemented it. It is now **reverted**: nothing is tinted in `none` mode.

**Why it was removed:** the veil read as red patches on a map that is otherwise relief + dark basemap. With no filter active the only pixels that fail are the MCSC bands with **no legend entry** (values 16–20 → codes 230–234: sòl nu forestal, zones cremades, roquissars, platges, zones humides), which `mcscLegend.js` already treats as no-terrain-info — so the mode showed stray crimson blobs that had nothing to do with any filter. `none` is the neutral, relief-only view; it is not a "what did the filters exclude" view.

**Superseded implementation (kept for the record — none of this is in the code):**

```
const VEIL = [220, 20, 60, 90]; // crimson ~35% — legible over relief + dark basemap; alpha 70–110 tunable
for each pixel i (single pass — no pass buffer, no neighbour scan):
  band = red[i]; if !band → transparent (MCSC nodata abroad stays transparent — don't veil the void)
  isWater = isWaterBand(band)
  colour = isWater ? bandColours[band] : substrate? substrateColours[lithoFamilyAt(...)] : bandColours[band]
  if !colour → write VEIL (dimmed class / 230–234 / substrate nodata = failing → veil)
  else {
    elev = needElev ? terrariumElevation(...) : NaN
    passing = isWater || (family not dimmed && alt in band && every value in band)
    // same gates as classifyTerrainPixel — share a passesAllGates helper
    if passing → transparent else write VEIL
  }
putImageData → canvasToBlob
```

- Elevation still needed for `alt` and temp lapse, so `needElev` must be computed even in `none` mode (today it's skipped).
- MCSC nodata (`band==0`, abroad/sea) stays transparent in veil mode too — don't veil the ocean/outside-Catalonia void, same as `terrain` never paints it.
- Water pixels: never veiled (water is already navy via sea layer + MCSC water class; veiling it would tint the navy). So `isWater && colour → transparent` in veil mode, same as the other modes are never gated by water.
- Performance: **one pass**, no `Uint8Array pass[65536]`, no neighbour reads — identical to `terrain` cost. Border alternative rejected: 2 passes + 4–8 neighbour checks ≈ 1.5–1.6× pixel cost (~260k extra reads/tile × ~20 tiles = 6–10 ms jank on Moto G).
- Veil vs border UX: veil tints the failing *mass* (readable at low zoom), border outlines shape precisely. Veil strictly cheaper; switching to border later is a localized `tilePaint` change if product prefers outlines.

### 6.3 Forest-sel button semantics need a one-line doc

**Today:** `PAINT_MODES = ['terrain','substrate','none']` cycle, substrate skipped while `lithoGrid` missing, `terrainState` carries `off` only for the active palette (`geoOff` only in substrate), water shared. `FilterPanel` still shows *both* Bosc and Substrat sections regardless of mode.

**Desired (from the brief):** "filter now works like a stack ... how depends on the forest sel button ... if forest sel is set to geology, filter has only 'bosque...', only 'calcaric terrain' ... it will render in geo colours ... only pixels that satisfy them all."

Interpretation: the stack is always the same set of conditions, but the **palette** that colours passing pixels switches with the button. In `terrain` mode a passing pixel is coloured by its MCSC class (`colourForBand`); in `substrate` mode the same passing pixel is coloured by its litho family (`lithoFamilyColour`). Both modes share the *filter* gates: a dimmed Bosc class still excludes that pixel in substrate mode, and a dimmed Substrat family still excludes in terrain mode — unless the product decides palettes should only be gated by their own legend (today's code does the latter: `off` travels in both modes, `geoOff` only in substrate; `classifyTerrainPixel` gates land by family regardless of mode via `offKeys`, but `terrainState.geoOff` is empty in terrain mode so the gate is inert).

**Decision needed (§8.1):** should `geoOff` gate in *both* palettes, or only in substrate? And should `mcscOff` gate in both? The current behaviour (geology only gates substrate) is defensible ("substrate is a *render* switch, not a filter switch"), but the brief's example lists "only 'bosque...', only 'calcaric terrain'" together as one stack, implying both gate in both modes. This doc keeps the current code's choice but flags it.

### 6.4 Bolet filter overlap

`boletFilter` currently participates in station filtering (intersect) and colours station circles via a green ramp plus `StationPanel` bolet row. It does **not** gate terrain pixels (terrainState has no bolet field). If bolets become area filters (the `MUSHROOM_APP_PLAN` Phase 1 intent), they'll need a raster too (species score per grid) — out of scope for this report, but keep the engine pure (`scoreStations`/`scoreSpecies` are test-covered) and don't couple it to `terrainState` until the spec firms.

---

## 7. Plan — phased, no code yet

### Phase A — Clarify & decouple (1–2 days, low risk)

1. **Freeze the contract in prose** (this file) — get sign-off on §6.1/6.2/6.3 decisions before coding.
2. **Decouple stations from area filters** (`App.jsx`): remove the `filteredStationsCodes` → `setData`/`setPaintProperty` effect (or gate it behind a `STATION_FILTERING_ENABLED=false` flag for easy revert). Keep `filterStationCodes` and its tests — they're still the spec for "which stations *would* pass" if we ever need a list view.
3. **Redefine the station info toggle:** change `LABEL_MODES` to a single rain-last-15 mode for now:
   ```js
   // proposal (not yet coded):
   const DISPLAY_DAYS = 60; // chart stays 60
   const STATION_VALUE_DAYS = 15; // value label window
   const labelMode = 'rain15' | 'none' | … // For now: rain15 ↔ none, later rain/hum/temp
   ```
   Compute the label value via `aggregateWindow(agg, codi, 'rain', 15, 0)` per station (or `computeGeoValues` over `[refDay-14, refDay]`), not the displayWindow. Keep `valueField` + hide on `none` only. Add a follow-up ticket: make the station window configurable in `FilterPanel` (small "Station info" row).

### Phase B — Semitransparent veil for `none` (⛔ HISTORY: implemented, reverted, later replaced by a green highlight — see §6.2 and `TILE_RENDERING.md` §4.1)

4. **Extend `tilePaint.buildTerrainTile` for `mode==='none'`:** stop early-returning transparent; instead run the single-pass veil of §6.2 (`passing ? transparent : VEIL`). Extract the AND into a shared `passesAllGates(colour,isWater,elev,altBand,values,…,familyKey,offGeo)` helper so `terrain`/`substrate` (write `c` if passes) and `none` (write `VEIL` if !passes) share the same gate logic — no divergence.
5. **Veil appearance:** one signal colour `VEIL=[220,20,60,90]` (crimson ~35% — legible over both hillshade and dark basemap; alpha 70–110 tunable). Passing → transparent (relief), failing (dimmed/230–234/nodata-gated/alt/meteo) → veil, MCSC `band==0` stays transparent, water never veiled. No palette-coloured veil, no halo needed.
6. **Perf budget:** veil is `1.0×` `terrain` pixel cost (no extra alloc/scan) — no jank budget needed. Still benchmark one tile with 3 active instances on a low-end device to confirm `buildTerrainTile` `none` ≈ `terrain` within 5%.
7. **Tests:** extend `terrainOverlay.test.js` with `passesAllGates` / `veilForPixel` pure helper, and `terrainOverlay.tile.test.js` with a stubbed 4×4 tile asserting passing block transparent and surrounding failing pixels `VEIL` (and water/abroad still transparent, never veiled). Add Playwright 10-toggle `none` repro (no detached errors, sample veil RGBA via canvas).

### Phase C — Palette/filter separation polish (1 day)

8. **Decide `geoOff` gating scope** (§8.1) and align `terrainState` accordingly. If both gates should apply in both palettes, change `geoOff: [...geoOff].sort()` to be unconditional (remove `terrainMode==='substrate'` guard) and update `classifyTerrainPixel` call site (today it always receives `familyKey/offGeo`, but the state's `offGeo` is empty in terrain mode — making it unconditional is a one-line change). If the current scope is kept, document it in `TILE_RENDERING.md`.
9. **FilterPanel affordance:** when the forest-sel button switches palette, the `FilterPanel` header could hint which palette is active ("Pintant en: Substrat") — cosmetic, not blocking. Keep both Bosc/Substrat editors always accessible (don't hide one when the other palette is active) so the user can build the full stack without switching.

### Phase D — Perf follow-ups (if needed, 0.5–1 day each)

10. **Grid offloading:** if border mode janks on old devices, move `buildMeteoGrid` into `tileWorker` (it already has `agg` + `features` via `pushTerrainContext`; add a `gridCache` there). The main thread would then only do `sampleMeteoGrid`.
11. **Shard bundling:** if daily shards exceed ~100, add `public/logic/daily/all_days.json` (one fetch) with a fallback to per-day `index.json` for freshness.
12. **Station value recompute batching:** computing the label value per station via `aggregateWindow` for every render is O(stations) ≈ 190 per mode switch — trivial. No optimisation needed until the station window becomes per-filter.

### Non-goals (explicitly deferred)

- No change to `sea` layer (still DEM ≤0 → navy, transparent when Aigües off).
- No change to `hillshade` / 3D terrain wiring.
- No change to bolet area rendering (still station-only).
- No server/WMS change (I may still use `mcscRaw` band tiles + DEM; no new raster source).

---

## 8. Decisions needed before coding

1. **Veil colour/alpha:** semitransparent signal on failing pixels. Proposal `VEIL=[220,20,60,90]` (≈35% crimson, visible over dark basemap + hillshade) vs dark veil `rgba(0,0,0,0.35)` — crimson wins for "filtered out" affordance. Alpha 90/255 is the default; tune 70–110 after manual check. Always same AND as the other modes, inverted output. **Resolved 2026-09-11:** neither — the veil was removed outright and `none` paints nothing (§6.2).
2. **Family/class gate scope:** does a dimmed Bosc class exclude a pixel even when painting in substrate colours, and vice-versa? Brief implies yes (one stack gates every pixel). Current code gates only substrate in substrate mode. Pick one and lock it.
3. **Station value window:** fix to rain last 15 days (spec: "for now rain value of last 15 days") — confirm that the label should show `Σ precAcc` over `[refDay-14, refDay]` rounded to 1 dec, and that the bottom button cycles `none → rain15 → none` for v1 (not the old 5-way cycle). Later: configurable window per variable.
4. **Stations visibility:** confirm "no filtering" means *never dimmed, never hidden* — even when bolet filter is on? Or does bolet stay as an exception (its own dimming/ramp)? Proposal: bolet stays as a separate station-only signal (ramp), not a terrain gate, and its dimming becomes opt-in.
5. **Water veil:** should inland water (`isWater`) ever be veiled in `none` mode? Proposal: no — water stays as today (navy via sea + MCSC water class, never gated, never veiled — same as from gating). Veiling water would tint the navy. **Moot:** there is no veil anymore (§6.2).

---

## 9. Risks & invariants

- **Detached ArrayBuffer** regression: any new code that caches a tile `ArrayBuffer` and transfers it must `slice(0)` — keep the fix in `tilePaint.getTransparentPngBuffer` + `tileWorker.run`.
- **MapLibre raster cache:** the `&r=` token in `terrainTileUrl` must survive — `none` tiles are transparent and cached like any other, so toggling `none`→`terrain` must never serve a stale transparent tile (`mode` is part of the state signature that bakes into the URL).
- **Abort handling:** `none` / transparent tiles are just as abortable as filled ones — respect `signal.aborted` in the `paintTerrainTile` worker path.
- **Bounds clip:** don't clip `sea`/`hillshade`; `terrain` stays clipped to `TERRAIN_OVERLAY_BOUNDS`.
- **Don't push `maplibre-gl` into the worker bundle** — keep `tilePaint.js` maplibre-free.

---

## 10. File-by-file touch list (when coding resumes)

| File | Change (planned) | Risk |
|---|---|---|
| `src/logic/tilePaint.js` | `passesAllGates` helper added (shared gates); the `none` veil was implemented and **reverted** — `buildTerrainTile` again early-returns transparent for `mode==='none'` (zero fetches), `TERRAIN_VEIL` / `veilForFailingPixel` deleted | Low — `none` skips the pipeline entirely |
| `src/logic/terrainOverlay.js` | no change except docs; `mode==='none'` stays valid in signature | Low |
| `src/App.jsx` | remove station dimming effect, redefine `labelMode` / `valueField` wiring, make `terrainState` doc explicit about palettes; keep `repaintBusy` gate | Low–Medium |
| `src/comps/FilterPanel.jsx` | no change for border feature; later: station-info window control | Low |
| `src/comps/StationPanel.jsx` | no change for border; later: show station value window label | Low |
| `src/logic/filterStations.js` | keep pure, no wiring change (or flag-gate the effect that calls it) | None |
| `TILE_RENDERING.md` + this file | update §4 modes + §10 transfer bug note with veil semantics | Doc |

---

## 11. How to verify (manual + automated)

- **Unit:** `terrainOverlay.tile.test.js` stubs `loadMcscBandTile`/`loadTileImageData`/`FakeCanvas` and feeds a 256×256 band image (water block / nodata block / forest elsewhere): in `terrain`/`substrate` mode only land passing every gate is painted, water keeps its class colour and failing land stays transparent; in `none` mode the tile is transparent with **no MCSC / DEM fetch and no pixel loop at all**.
- **Integration:** `npm test` (all 24 files / 339 tests today; 14 files when written), `npm run build`, `npm run lint`.
- **Manual:** dev server, add `rain 100 mm day 4–8` + `temp 20–26 day 12–21` + `geoOff=calcaric` + `mcscOff=one class`, cycle `terrain→substrate→none` 10×, check: terrain/substrate show filled areas only where all pass; `none` shows relief + basemap with **no tint anywhere** (no red patches, in particular none over the 230–234 no-data bands, even with no filter active); pan/zoom burst doesn't wedge; stations stay full opacity and their labels keep their rain15 values.

---

## 12. Appendix — constants to keep in mind

- `TILE_SIZE 256`, `TERRAIN_OVERLAY_BOUNDS [-1.25,39.75,4.25,44.25]`, `CATALONIA_BOUNDS [[-1,40],[4,44]]`, `FIT_ZOOM_FLOOR 5.5`
- `GRID_STEP 0.01°`, `GRID_BOUNDS {w-1,s40,e4,n44}`, `DEFAULT_MAX_DIST_KM 50`, `LAPSE_RATE 6.5`
- `TERRAIN_REPAINT_MS 150`, `repaintBusy` timeout 5000 ms, `MAX_ACTIVE 6`, tile caches 300, grid cache 30, `limitsCache` WeakMap 200
- `DISPLAY_DAYS 60` (chart), `MAX_PER_TYPE 5` — and **`STATION_VALUE_DAYS 15` was not adopted**: the label window now follows the active filters (default 60 days); see the status banner above.
- DEM `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, WMS `cobertes_2024` with `renderBandSld` `band→#vv0000`

---

*This report was written before implementation (no code was changed to produce it). Phases A and C have since shipped; the §6.2/Phase B crimson veil was implemented, reverted, and replaced by the green highlight of `TILE_RENDERING.md` §4.1. Decisions §8.1 and §8.5 are moot (there is no veil); §8.2–§8.4 were resolved by the implementation. See the status banner at the top and `APP_STATE_REPORT.md`.*
