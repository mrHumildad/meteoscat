# MeteoSeps / meteoscat — State of the App (detailed audit + proposals)

> **Date:** 2026-09-12 · **Scope:** the whole project (client + server) · **Branch:** `main`
> **Purpose:** one authoritative snapshot of what the app actually is today, what the
> existing plan documents say, how far each plan has been executed, what is broken or
> drifting, and what to do next.
> **This report changes no code.** All numbers below were produced by running the
> project's own commands (see §5) and reading the source, not from the docs.

---

## 0. TL;DR

| Area | State |
|---|---|
| **Product** | Far beyond a weather viewer: a Catalonia-wide, client-side per-pixel area filter engine with a stacked "all conditions must pass" painter, station info readout, directions/area-analysis modal, saved filters and saved places, and an implemented mushroom (bolet) scoring engine — 5 species. Brand is still half-way (`meteoscat` repo / `MeteoSeps` UI / `meteoscat` deploy path). |
| **Health** | `npm test` **green: 339 tests / 24 files**. `npm run build` **green**. `npm run lint` **RED — 1 error** (unused variable). |
| **Bundle** | Main JS **1.49 MB raw / 426 kB gzip** (plan budget was ≤200 kB gz). Assets not optimised (one 584 kB PNG). |
| **Docs** | 6 tracked plan/report docs + 1 gitignored strategic plan. **Test counts and superseded-section banners were refreshed across all of them on 2026-09-12** (they now state 339 tests / 24 files); one README claim still does not match the committed data (§4.2, §8 P0.3). |
| **Data pipeline** | Server repo split works and is well documented, **but the committed `index.json` lists 60 days while 76 shards are committed on disk** — the next cron run will silently widen the dataset from 60 to 76 days. |
| **Top risks** | (1) uncommitted work in the tree, (2) the index/shard mismatch, (3) doc drift that will mislead the next session, (4) lint red, (5) dead code + dead dependencies. |
| **Biggest untapped plan** | `ORIENTATION_FILTER_PLAN.md` is **entirely unimplemented**; `MUSHROOM_APP_PLAN.md` is implemented only down to the code/UX level (no backend, no payments, no PWA, no i18n). |

---

## 1. What the app is today

### 1.1 One-paragraph description

A single-page React app that shows Catalonia on a MapLibre map and lets the user build a
**stack of area filters** — land-cover classes (MCSC), geology/substrate families,
altitude band, per-variable meteorology windows (rain sum / temperature mean / humidity
mean, each with its *own* day range) and a mushroom species threshold. The map paints
land **pixel by pixel, client-side, in a Web Worker**: a pixel is coloured only if
**every** active condition passes, otherwise it is transparent and the hillshade shows
through. Weather stations are *never* filtered — they are info markers whose circle text
cycles through altitude / rain / temp / humidity values. A directions modal lets the user
pick a point on the map and reports distance, nearest stations, area altitude profile,
land-cover/substrate composition, and how much of that disc satisfies the live filters or
any saved preset. Filters and places can be saved to `localStorage`.

### 1.2 Two-repo split

```
meteoSCat/                      (this workspace)
├── client/   React + Vite + MapLibre app  →  GitHub Pages  (base /meteoscat/)
└── server/   Python scrapers + daily data →  GitHub Pages data site (mrHumildad/cepdata)
```

The split is deliberate and documented: the server commits data daily, so the client's
git history and Pages deploys are not touched by data churn. The client fetches shards at
runtime from `VITE_DATA_BASE_URL` (`.env`), not from the bundle.

### 1.3 Runtime data flow

```
Meteocat XEMA (daily page, rolling 60-day window)
  └─ server/meteokat/scrapeMap.py ──▶ full_dades.json (gitignored, ~tens of MB)
        └─ server/meteokat/aggregate.py ──▶ server/data/daily/YYYY-MM-DD.json
                                              + index.json   (committed by CI, then
                                                              published to Pages)
                                                            │
                       client runtime fetch (index + all shards, Promise.all)
                                                            ▼
  buildAggregateTable()  →  prefix sums per station × variable (O(1) window queries)
       ├─ area filters        → terrainState → terrain:// raster (per-pixel AND, in worker)
       ├─ station labels      → stationDayRange (default last 60 days, or the last
       │                        ACTIVE filter's window for that variable)
       ├─ bolet scorer        → speciesRules over the last windowDays → circle ramp
       └─ directions modal    → area elevation / composition / filter-match percentages
```

### 1.4 Map layer stack (bottom → top)

| # | Layer | Mechanism |
|---|---|---|
| 1 | OpenFreeMap `dark` vector basemap | keyless; `styleUrl` overridable via `VITE_MAP_STYLE_URL` |
| 2 | `hillshade` (DEM, terrarium) | GPU hillshade, exaggeration 0.4, its own `raster-dem` source |
| 3 | `sea` raster (`sea://`) | DEM `elev ≤ 0` → navy; transparent when the Aigües legend entry is dimmed |
| 4 | `terrain` raster (`terrain://`) | **the stacked overlay** — per-pixel AND of every active condition, painted in a Web Worker; clipped to `TERRAIN_OVERLAY_BOUNDS` |
| 5 | stations `circle` / `label` / `value` | never dimmed; value text cycles `none → altitud → precRain → tempAvg → humAvg` |
| — | 3D terrain | a **second** `raster-dem` source (`terrain-dem`) so the 3D toggle cannot re-tile the hillshade |

---

## 2. Feature inventory (what works, with code pointers)

| Feature | Status | Where |
|---|---|---|
| Bounded Catalonia map, per-viewport fitted min-zoom | ✅ | `App.jsx`, `logic/mapFit.js` |
| OpenFreeMap keyless basemap, env-overridable | ✅ | `App.jsx:styleUrl`, `.env` |
| Hillshade + 3D terrain toggle | ✅ | `App.jsx` `addAreaOverlays`, 2.9 effect |
| Sea overlay, off when Aigües dimmed | ✅ | `logic/seaOverlay.js`, `logic/tilePaint.js:buildSeaTile` |
| Per-pixel stacked area painter (worker + OffscreenCanvas, 6 concurrent, abortable, never-rejecting) | ✅ | `logic/tilePaint.js`, `tileWorker.js`, `tilePipeline.js` |
| MCSC land-cover legend + dimming filter | ✅ | `logic/mcscLegend.js`, `logic/mcscRaw.js`, `FilterPanel.jsx` |
| Geology/substrate overlay (RLE grid, 1.16 MB) + family dimming | ✅ | `logic/lithology.js`, `litho_grid.json` |
| Altitude band filter | ✅ | `reliefRange` + `terrainState.alt` |
| Per-instance meteo windows (rain Σ / temp x̄ / hum x̄), two-handle day slider + value slider, max 5 per type, AND semantics, inert = full span | ✅ | `logic/filterAggregate.js`, `logic/filterStations.js` (logic only), `FilterPanel.jsx` |
| Three render modes: terrain / substrate / green "filter coverage" highlight over relief | ✅ | `PAINT_MODES`, `TILE_RENDERING.md §4.1` |
| Station value cycle (alt / rain / temp / hum) over a filter-following day range | ✅ | `APP:LABEL_MODES`, `stationDayRange` |
| Bolet species filter (5 species, forest-host gate, green ramp on circles, species row in `StationPanel`) | ✅ logic | `logic/speciesRules.js`, `logic/boletEngine.js` |
| Directions modal: pick point, straight-line distance, 3 nearest stations, radius control, altitude profile, land-cover + substrate composition, per-filter/per-preset coverage % | ✅ | `comps/DirectionsModal.jsx`, `logic/areaElevation.js`, `areaComposition.js`, `areaFilterMatch.js`, `nearestStations.js` |
| Saved filter presets + saved locations (localStorage, defensive, capped) | ✅ | `logic/savedFilters.js`, `savedLocations.js`, `comps/SavedFiltersPanel.jsx`, `SavedLocationsPanel.jsx` |
| "My location" marker + Google Maps routing | ✅ | `App.jsx` geolocation effect, `DirectionsModal` |
| WebGL2 capability detection + explanatory fallback screen | ✅ | `logic/webgl2.js`, `comps/MapUnavailable.jsx` |
| Repaint input gate (one filter change at a time on slow devices) | ✅ | `App.jsx` `beginRepaint` / `endRepaint` |
| **Orientation / slope-aspect filter** | ✅ | `elevation.js` aspect helpers, `terrainState.aspect`, `FilterPanel` compass chips, `tilePaint` per-pixel gate + neighbour-DEM borders (`TILE_RENDERING.md` §4.4) |
| Bolet as an **area** raster (species score per pixel) | ❌ | plan only (`AREA_FILTER_REPORT.md §6.4`) |
| Backend, auth, payments, push, PWA, i18n | ❌ | `MUSHROOM_APP_PLAN.md` Phases 1.5–5 |

**Verdict:** the engineering ambition of the docs has largely been achieved for the *map
filtering* core. The unimplemented half is the *commercial product* half (backend,
accounts, payments, installability, localisation).

---

## 3. Code inventory

### 3.1 Client (`client/`)

| File | Lines | Role |
|---|---|---|
| `src/App.jsx` | **1632** | all state, memos, map lifecycle, UI shell, repaint gate |
| `src/comps/FilterPanel.jsx` | **738** | filter UI (single filters + meteo instances + bolet) |
| `src/logic/terrainOverlay.tile.test.js` | 484 | integration test of the painted tile |
| `src/logic/tilePaint.js` | 384 | pure per-pixel painters (kept maplibre-free for the worker) |
| `src/comps/DirectionsModal.jsx` | 359 | directions + area analysis |
| `src/comps/StationPanel.jsx` | 240 | station bottom sheet, 3 charts + day strip |
| `src/logic/*` (44 files) | ~4 700 | aggregation, filters, grids, overlays, saved state, species |
| `src/comps/*` (11 files) | ~2 000 | panels, charts, blocks, rangesliders.css |
| Docs | ~2 300 | 6 tracked markdown files |

**Largest gaps in cohesion:** `App.jsx` at 1632 lines holds state, memos, map lifecycle,
direction routing, geolocation, saved-state persistence wiring and full JSX. It is the
single biggest refactor opportunity (see §8, P1).

### 3.2 Server (`server/`)

| File | Role |
|---|---|
| `meteokat/scrapeMap.py` | rolling-window scraper → `full_dades.json` (gitignored) |
| `meteokat/aggregate.py` | raw → `data/daily/*.json` + `index.json`; mirrors the old client aggregation |
| `meteokat/build_lithology.py`, `mcsc_sample.py` | one-off builders for `litho_grid.json`, `forest_types.json` |
| `config/stations.json` | server-local copy of the client station seed list |
| `.github/workflows/daily-data.yml` | 06:30 UTC cron; scrape → aggregate → commit → dispatch deploy |
| `.github/workflows/deploy-data.yml` | publishes `data/` to Pages |
| `data/daily/` | **76 shards committed**, 2.4 MB, disk range 2025-11-10 → 2026-09-12 |

---

## 4. Data pipeline — findings

### 4.1 ✅ The repo split and CI are correct and well reasoned

The `daily-data.yml` header explains the non-obvious details (rolling 60-day window for
self-healing; a `GITHUB_TOKEN` push raises no workflow events so the deploy is
**dispatched explicitly**, hence `actions: write`). This is exactly the kind of thing that
would otherwise be re-discovered painfully. Keep it.

### 4.2 ⚠️ `index.json` disagrees with the shards on disk

| Measure | Value |
|---|---|
| Shard files on disk / tracked in git | **76** |
| Days listed in committed `index.json` | **60** (2026-07-15 → 2026-09-12) |
| Shard date range on disk | 2025-11-10 → 2026-09-12 |

`aggregate.py` deliberately rebuilds the index from **every shard on disk**
(`days_on_disk | raw_days`, line ~240), and the server README states the app "keeps
offering every day ever published". But the committed index only lists the current
rolling window. So the committed artifact contradicts both its own generator and its own
README.

**Consequences:**
- Today the app loads 60 days → `maxDays = 60`; the oldest 16 committed shards are dead weight.
- **The next cron run will change this**: CI checks out all 76 shards, `glob` finds them,
  and `index.json` jumps to ≥76 entries. `maxDays` becomes 76, so every default window
  (`DEFAULTDAYRANGE`), day-slider span, and station label window silently re-scales, and
  the app starts surfacing winter-2025 data that has not been re-verified for ~9 months.
- Whichever way you want it, the repo must be made self-consistent: either regenerate
  `index.json` from disk now (and accept a 76-day dataset), or delete the pre-window
  shards so on-disk == index.

### 4.3 Other pipeline notes

- A rolling 60-day re-scrape means days older than the window are **frozen** (no further
  Meteocat corrections) but still served. No UI marks a day as "frozen vs corrected".
- The scraper is a scraper, not the official Meteocat API. `MUSHROOM_APP_PLAN.md §7.4`
  already flags the licensing/TOS risk the moment the app is monetised. Nothing has
  changed on that front.
- `aggregate.py`'s docstring and the client README reference `client/.env.production`,
  which does not exist (only `.env`, which *is* committed). Minor, but it is exactly the
  kind of detail that costs an hour.

---

## 5. Verification results (run on 2026-09-12)

| Command | Result | Evidence |
|---|---|---|
| `npm test` | ✅ **24 files / 339 tests passed** | includes `terrainOverlay.tile.test.js` (21), `filterAggregate` (25), `speciesRules` (22), `areaFilterMatch` (15), `savedFilters` (15), `savedLocations` (14), `DirectionsModal` (13) |
| `npm run build` | ✅ built in 4.0 s | `index-BPks50Xq.js` **1 492.91 kB / 426.20 kB gz**; `index.css` 106.41 kB / 15.31 gz; `maplibre-gl-worker` 505.84 kB; `tileWorker` 10.12 kB; `basket.png` 229.76 kB; `logo.png` 353.31 kB |
| `npm run lint` | ❌ **1 error** | `src/logic/areaFilterMatch.js:171:54 — 'refDay' is assigned a value but never used (no-unused-vars)` |

Working tree is **dirty**: `src/App.jsx` and `src/App.css` modified, `src/assets/totallogo.jpg`
and `src/assets/totallogo.png` untracked. `main` is **1 commit ahead** of `origin/main`
(`1ad717b env: expose the basemap style override`).

The `refDay` in `matchAreaFilters(samples, configs, { refDay, agg, features })` is
destructured but never read — the windows arrive already resolved as `from`/`to` dates in
the config rows, so the fix is to drop it from the signature (or use it). It is a
one-line fix, but it means **lint is not a usable gate right now**.

---

## 6. Documentation audit — plan vs. code

| Doc | Tracked? | Status vs. code |
|---|---|---|
| `client/MUSHROOM_APP_PLAN.md` | ❌ **gitignored** (`.gitignore` lists it under "Scratch / local notes") | Strategic. §6.1 (bundling bottleneck) **DONE and exceeded** — aggregation moved to the server and shards fetched. Repo split **done**. The species engine (its Phase 1) is **implemented**. Phases 1.5–5 (backend/auth/payments/PWA/i18n/monetisation) **not started**. Its market/pricing/safety claims are research-grade and explicitly self-labelled unvalidated. **Refreshed 2026-09-12:** a status banner lists what is done vs. not. **Problem: the single most strategic document is still not versioned (P0.4).** |
| `client/FILTER_REFACTOR_PLAN.md` | ✅ | **Implemented end-to-end** (per-instance windows, prefix sums, two-slider editor, `Selectors.jsx` deleted, `react-day-picker` dropped, stacked `terrain://` overlay §13). **Refreshed 2026-09-12:** status banner says implemented, counts corrected (was "125 tests / 10 files", now 339/24), and the now-unused `filterStations.js` is flagged. §5 keeps its own SUPERSEDED banner. |
| `client/AREA_FILTER_REPORT.md` | ✅ | **Largely implemented**: stations info-only (Phase A) ✅, `none` green highlight ✅ (its recommended crimson veil was reverted), `geoOff`/`mcscOff` both gate every mode ✅. **Refreshed 2026-09-12:** a status banner marks Phases A/B/C as history, the test list was rewritten to the then-current 24 files / 339 tests, and the superseded `STATION_VALUE_DAYS 15` proposal is flagged. |
| `client/TILE_RENDERING.md` | ✅ | **Accurate and the best-maintained doc.** §4.1 correctly describes the current green-highlight `none` mode; §8 correctly documents the `slice(0)` detached-buffer bug. **Refreshed 2026-09-12:** its test counts now read 339/24, and §4.4 documents the orientation filter. |
| `client/WEBGL_FALLBACK_REPORT.md` | ✅ | Option A (detection + message) **implemented** (`webgl2.js`, `MapUnavailable.jsx`). Options B/C remain evaluated-not-built, as documented. **Refreshed 2026-09-12:** the `App.jsx` line count is corrected to 1632 and the header no longer claims "no code changed". |
| `client/ORIENTATION_FILTER_PLAN.md` | ✅ | **✅ IMPLEMENTED 2026-09-12** — all six decisions (D1–D6) adopted; §12 records the deviations. **Refreshed:** status banner now says implemented, counts updated. |
| `client/README.md`, `server/README.md` | ✅ | Both genuinely good and unusually honest (the data-source/offline instructions and the `VITE_DATA_BASE_URL`-via-`env:` footgun are excellent). README drift: client test counts, server's "every day ever published" claim (§4.2), `env.production` mention. |

**Overall:** the docs are far above average in *quality* and below average in *currency*.
The recurring failure mode is a plan being written, implemented, and then left in a state
where its "current architecture" sections describe the architecture it replaced.

---

## 7. Findings & risks, severity-ranked

### P0 — fix before anything else

1. **Dirty working tree with untracked brand assets.** `App.jsx`/`App.css` modified,
   `totallogo.{jpg,png}` untracked, branch 1 ahead of origin. Any session cut short loses it.
   *Action: review, then commit or stash.*
2. **`index.json` / shard mismatch** (§4.2). The next cron run changes the app's dataset
   from 60 to 76 days with no code change and no announcement. *Action: decide the policy
   and make the committed artifact match it.*
3. **Lint is red** (`areaFilterMatch.js` unused `refDay`). Lint cannot be used as a gate
   until fixed, and it is unclear whether CI runs it at all — `deploy-pages.yml` only runs
   `npm ci` + `npm run build`, so **neither tests nor lint gate a deploy**. *Action: fix the
   error and add `npm test` + `npm run lint` to `deploy-pages.yml`.*
4. **The strategic plan is gitignored.** `MUSHROOM_APP_PLAN.md` is excluded as "scratch".
   It is the roadmap for the product pivot. *Action: track it (it is already written; there
   is no secret in it).*

### P1 — engineering debt

5. **Dead code and dead dependencies.**
   - `src/logic/filterStations.js` + its 20-test file: no longer imported by `App.jsx`
     (`grep` finds only the test file and one stale comment in `FilterPanel.jsx`). The
     `AREA_FILTER_REPORT.md` explicitly retired station filtering.
   - `react-map-gl@8.1.0` is a **direct dependency with 0 imports**.
   - `recharts@^3.3.0` is a **direct dependency with 0 imports** (charts are hand-rolled).
   - `playwright@^1.63.0` is a devDependency with **no committed e2e spec** (the docs
     describe an uncommitted manual repro).
   *Action: delete the module + tests, drop the three unused deps; if e2e is wanted, commit
   one smoke spec instead of leaving the dep as decoration.*
6. **Bundle and asset weight.** 426 kB gz JS against the plan's ≤200 kB budget, and
   `maplibre-gl-worker` is another 506 kB raw. Images are unoptimised: `totallogo.png`
   584 kB, `logo.png` 353 kB, `basket.png` 230 kB, plus JPG twins of the same art, plus an
   `oldlogo.png` and `wordmark.*` that no code imports. External Google Fonts (Audiowide +
   Chivo Mono) add two blocking origins. *Action: convert to WebP/AVIF at display size,
   delete unused art, code-split the map, self-host or drop the display font, and set a
   chunk-size budget that CI enforces.*
7. **`console.log` in production paths** — 20 occurrences in `src/`. The plan's Phase 0
   item ("gate behind `import.meta.env.DEV`") is still open. (Note: the `console.warn` /
   `console.error` calls in the tile pipeline are intentional diagnostics and should stay.)
8. **No error monitoring, no analytics, no error boundary.** A user's blank failed tile is
   invisible to you; there is no crash boundary around the app shell. The plan picks
   Sentry + Plausible; neither is wired.
9. **Test coverage shape is inverted.** The pure logic is exceptionally well covered
   (339 tests), but there is **no test for `tilePipeline.js`, `tileWorker.js`, `App.jsx`
   behaviour beyond a 2-test render smoke**, and the worker-transfer bug class that already
   bit once (`TILE_RENDERING.md §8`) is guarded only by an uncommitted Playwright repro.
10. **`App.jsx` monolith (1632 lines).** State, memos, map lifecycle, geolocation, routing,
    persistence wiring and JSX in one component. Every feature added has raised the risk of
    the whole thing. *Action: extract `useFilterState`, `useMapLifecycle`, `useSavedState`
    and the header/button stack into components — mechanically, one at a time, under the
    existing tests.*
11. **Brand and metadata fragmentation.** Repo `meteoSCat`, package `meteoscat`, deploy base
    `/meteoscat/`, UI header `MeteoSeps`, logo alt `MetoSeps`, index.html `<title>MeteoSeps</title>`,
    server README calls the client repo `cepdata`. `index.html` is `lang="en"`, has no
    description/OG/Twitter card, and no manifest or service worker (so no PWA install in a
    signal-less forest — the plan's explicit Phase 0 quick win).

### P2 — product gaps

12. ~~**Orientation filter not implemented**~~ — ✅ **implemented 2026-09-12** (8 sectors, Horn
    3×3 aspect from the DEM already fetched, physical ≥5° flat guard, neighbour-tile borders,
    no station gating in v1). See `TILE_RENDERING.md` §4.4. The remaining gap: the orientation
    selection is **not** included in saved filter presets.
13. **Bolet scoring is station-only, not area-level.** The engine is pure and tested, but
    the species score never reaches the painted raster. A `boletFilter` cannot answer "which
    *areas* are likely?" — which is the actual product question in `MUSHROOM_APP_PLAN.md`.
14. **No backend at all.** GitHub Pages only. Payments, accounts, push alerts, personal
    data, and the Meteocat licensing agreement are all prerequisites of charging money and
    none are started.
15. **Seasonality and catalogue gaps** from the mushroom plan remain as written: no MCSC /
    Pla Alfa / GBIF / iNaturalist overlays, no coto/permit boundaries, no Catalan locale
    beyond hand-rolled `fmtDateCat`, no i18n framework, no safety disclaimer screen.

---

## 8. Proposals

### P0 — this week (target: a clean, honest, committable baseline)

1. **Commit or stash the working tree** and decide the fate of `totallogo.*`.
2. **Fix the lint error** (`areaFilterMatch.js` unused `refDay`) and add `npm test` +
   `npm run lint` steps to `.github/workflows/deploy-pages.yml` so a red tree cannot deploy.
3. **Resolve the index/shard question** (§4.2) and document the chosen policy in
   `server/README.md`. Recommended: keep the long history *but* regenerate `index.json`
   from disk now and have the client label the dataset span, so `maxDays` changing is
   expected rather than surprising. If instead you want a strict 60-day product, delete the
   pre-window shards.
4. **Track `MUSHROOM_APP_PLAN.md`** and delete the other gitignore lines that hide planning
   material (`basura` can stay ignored).
5. **~~Update the stale numbers in every doc~~ — ✅ DONE (2026-09-12).** All seven markdown
   docs now state the current **339 tests / 24 files**, and the historical sections of
   `FILTER_REFACTOR_PLAN.md` (§1, §5), `AREA_FILTER_REPORT.md` (§2.3, §6.2, §7 Phase B),
   `WEBGL_FALLBACK_REPORT.md` (§4/§5 header) and `MUSHROOM_APP_PLAN.md` (Phase 0/1) carry a
   status banner. The only remaining doc staleness is the `server/README.md` index claim (P0.3).

### P1 — next 1–2 weeks (debt that compounds)

6. **Delete dead weight:** `filterStations.js` + tests, `react-map-gl`, `recharts`,
   `playwright` (or replace `playwright` with one committed smoke spec), unused
   `assets/oldlogo.png`, `wordmark.*`, `station.png` (confirmed: no imports) and redundant
   JPG/PNG twins.
7. **Cut the payload:** WebP/AVIF images at display size; code-split the map; decide on the
   display font. Add a bundle-size budget to CI (the build already prints the numbers you
   need).
8. **Observability:** an error boundary around the app, Sentry for exceptions, Plausible (or
   equivalent) for the funnel events the plan lists in Appendix A.3 (install rate, session
   duration, "Obrir a Google Maps" CTR).
9. **Gate dev logging** behind `import.meta.env.DEV`; keep the pipeline `warn`/`error` calls.
10. **Break up `App.jsx`** into focused hooks/components, one extraction per commit, with the
    339 tests as the safety net. This is the highest-leverage maintainability change in the
    repo.
11. **Consolidate the docs:** keep `TILE_RENDERING.md` as the canonical map-engine reference,
    fold the finished plans into a short `STATUS.md` / `CHANGELOG.md`, and reserve new plan
    files for work that is actually pending. A doc that describes a replaced architecture is
    worse than no doc.
12. **Metadata + installability:** `lang="ca"`, description/OG/Twitter card, web app manifest
    and service worker (offline shard cache is already feasible — the aggregate table is
    built from plain JSON), and a one-line Catalan safety disclaimer on first load.

### P2 — features worth doing next

13. ~~**Implement the orientation filter**~~ — ✅ **done 2026-09-12**, exactly as specced
    (`ORIENTATION_FILTER_PLAN.md` §12 has the notes). Add it to saved presets and to the
    directions-modal area analysis if the filter should be snapshot-able.
14. **Promote the bolet score to the raster** so the species filter can paint areas. The
    grid machinery is already there (`meteoGrid.js` samples per pixel); a species score
    grid would follow the same cached-per-window pattern, and it is the difference between
    "a weather map with mushrooms" and the product in the plan.
15. **Make the station-info window configurable** in the panel (today it silently follows the
    last active filter for that variable — powerful, but invisible to the user).
16. **Reuse the area-analysis stack more broadly:** the directions modal already computes
    elevation, composition and filter coverage for a disc. The same three modules would give
    the bolet engine an area-level confidence readout.

### P3 — product path (from the strategic plan; unchanged and still unvalidated)

17. **Decide fork vs. branch** and freeze the brand (`BoletsCat` / `Onada` / `Rovello` /
    keep `MeteoSeps`) before adding backend code — every later artifact inherits it.
18. **Stand up the paid-product baseline: Vercel + Supabase (Auth/Postgres+PostGIS) +
    Stripe**, and **migrate ingestion to the official Meteocat open-data API** before
    charging (the plan's §7.4 licensing risk). The scraper should remain a local seeding
    tool.
19. **Validate before building:** the plan's own Phase 1.2 gate ("≥3/5 beta foragers say
    they'd open it every morning") has not been run. Do that before spending weeks on
    payments.
20. **Treat the safety rules as non-negotiable:** no photo ID feature, a Catalan disclaimer
    at launch and on every species view, and never reveal exact spots — aggregate at
    10 km grid or comarca level (the plan's §7.1–7.2; the current station-level bolet ramp
    is already the right *shape* of signal for this).

---

## 9. Open questions (need a decision, not more code)

1. **Dataset policy** — should the app offer every published day (76+ and growing) or a
   strict rolling 60? This determines the `index.json` fix and the meaning of `maxDays`.
2. **Does CI gate on tests/lint?** Today it does not. Should a red lint block a Pages deploy?
3. **Is `MUSHROOM_APP_PLAN.md` tracked or truly scratch?** The answer decides whether the
   product roadmap survives a machine loss.
4. **Brand** — `meteoscat` everywhere (repo, package, path) with `MeteoSeps` only in the UI is
   an accident waiting to be shipped. Pick one.
5. **Fork or branch** for the mushroom product, and does the species engine stay open (MIT)
   per the plan's §9.6?
6. ~~Which plan is authoritative for the next iteration~~ — **answered 2026-09-12: the
   orientation filter shipped.** Next candidate: the bolet-raster (species score as an area
   signal), which is closer to the product thesis.

---

## 10. Appendix

### A. Verified commands

```bash
cd client
npm test        # 339 tests / 24 files — green
npm run lint    # 1 error (areaFilterMatch.js:171 unused refDay)
npm run build   # green; index JS 1,492.91 kB / 426.20 kB gz

cd ../server
python3 - <<'PY'           # index vs disk
import json; d=json.load(open('data/daily/index.json')); print(len(d), d[0], d[-1])
PY
ls data/daily/*.json | grep -v index.json | wc -l   # 76
```

### B. Constants worth knowing

| Constant | Value | Where |
|---|---|---|
| `DEFAULTDAYRANGE` | 60 (default window / chart) | `filterAggregate.js` |
| `MAX_PER_TYPE` | 5 meteo instances per type | `FilterPanel.jsx` |
| `GRID_STEP` / `GRID_BOUNDS` | 0.01° ≈ 1.1 km; `{w -1, s 40, e 4, n 44}` | `meteoGrid.js` |
| `DEFAULT_MAX_DIST_KM` / `LAPSE_RATE` | 50 km; 6.5 °C/km | `meteoGrid.js` |
| `TERRAIN_OVERLAY_BOUNDS` | `[-1.25, 39.75, 4.25, 44.25]` | `mapFit.js` |
| `FIT_ZOOM_FLOOR` | 5.5 | `App.jsx` / `mapFit.js` |
| `MAX_ACTIVE` / tile caches | 6; 300 entries | `tileWorker.js`, overlays |
| `TERRAIN_REPAINT_MS` / busy timeout | 150 ms; 5 000 ms | `App.jsx` |
| DEP/legend | terrarium DEM (AWS/Mapzen); ICGC WMS `cobertes_2024`; ICGC geology 1:50 000 | `elevation.js`, `mcscRaw.js`, `lithology.js` |

### C. Doc freshness summary

| Doc | Fresh | Superseded sections present |
|---|---|---|
| `TILE_RENDERING.md` | ✅ | ✅ refreshed 2026-09-12 (339/24) + orientation filter §4.4 |
| `FILTER_REFACTOR_PLAN.md` | ✅ | ✅ refreshed 2026-09-12 (implemented banner + counts; §5 keeps its SUPERSEDED banner) |
| `AREA_FILTER_REPORT.md` | ✅ | ✅ refreshed 2026-09-12 (status banner + 23-file test list + superseded §7 Phase B) |
| `MUSHROOM_APP_PLAN.md` | ✅ | ✅ refreshed 2026-09-12 (Phase 0/1 status banner); ⚠️ still gitignored |
| `ORIENTATION_FILTER_PLAN.md` | ✅ (unimplemented) | ✅ refreshed 2026-09-12 ("not implemented, re-verified") |
| `WEBGL_FALLBACK_REPORT.md` | ✅ | ✅ refreshed 2026-09-12 (option A implemented; 1632 lines) |
| `client/README.md` / `server/README.md` | ✅ | clean (no stale counts) |

---

*This report describes the code as of 2026-09-12; the same day's later commit added the
orientation filter (§2, §8 P2.12/13, §9.6 are updated for it). §8 P0.5 (the doc refresh) is
done. Next recommended action: §8 P0 items 1–4, then the bolet-raster (§8 P2.14).*
