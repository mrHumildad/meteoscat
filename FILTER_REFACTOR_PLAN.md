# Refactor: Per-Filter Time Ranges (calendar removed)

> **Status:** ✅ **Implemented — kept as the design record.** Verified against the code on
> 2026-09-12. The sections below are written in the present tense of the *pre-refactor* code,
> so read them as history, not as a description of today's app: the refactor shipped, and §5
> was itself later superseded by the single client-side `terrain://` composite (§13). The one
> genuinely historical piece is §5 (see its banner). Current test suite: **339 tests / 24 files**
> (this file says 125/10 and 126/196-era numbers). For today's architecture read
> `TILE_RENDERING.md`; for the full state see `APP_STATE_REPORT.md`.
> **Goal (achieved):** Remove the global calendar date window. Every meteo filter (rain / humidity / temperature) becomes a *filter instance* carrying its own day range + value range (two sliders each). Multiple instances of the same type are allowed. Altitude and terrain (forest) filters stay single and timeless, as today.

---

## 0. Decisions confirmed with the user

| # | Decision | Value |
|---|---|---|
| D1 | Day-range control per filter | **Two-handle slider: start day + end day.** No more global day range anywhere. |
| D2 | Combination of multiple same-type filters | **AND** — a station must match *every* applied filter (same-type instances AND together, exactly like today's cross-type AND). |
| D3 | Value control | **Range `[min, max]` (two handles)** — same control as today; a "≥ 5 °C" threshold is just `[5, max]`. |
| D4 | Window reference point | **Latest available data day** (`index.json` last entry). Shown as a visible anchor in the filter panel ("fins a les dades del 02 set") so "fa X dies" is always interpretable. Windows are day *offsets* from it, labelled with concrete dates. Deterministic between refreshes. |

---

## 1. Current architecture (what exists today)

```
App.jsx
 ├─ daysRange (calendar window, from DayPicker)  ──► loadSummaries(days, from, to)  ──► data (per-day shards)
 ├─ daysRange ──► computeGeoValues(stationsGeo, data, window)  ──► geoWithData
 │     each feature gets precAcc (Σ), tempAvg (x̄), humAvg (x̄) over the GLOBAL window
 ├─ rangeLimits (tempMin..altMax) derived from geoWithData features
 ├─ rainRange / humRange / tempRange (applied bands, null = off) — via FilterPanel
 ├─ reliefRange (altitude band)   ·   mcscOff (dimmed forest codes)
 ├─ filteredStationsCodes — recomputed in FilterPanel's useEffect:
 │     filterStationCodes(stations, rainRange, humRange, tempRange, altRange, rangeLimits)
 │     → list of codes passing ALL bands (AND); [] = "show everything"
 └─ map overlays
      alt://  …  per-pixel DEM band classification (single layer, static altitud)
      meteo:// …  per-variable IDW grid over the GLOBAL window + band
                   (one raster layer per variable: precAcc-band, humAvg-band, tempAvg-band)
```

- `Selectors.jsx` (calendar + 4 sliders) is **already commented out** in App — the rebuilt `FilterPanel.jsx` is the live filter UI.
- `FilterPanel.jsx` today: buttons per filter key (`relief/rain/hum/temp`) + forest; one editor open at a time (single RangeSlider per key); applied ranges collapse into rows with a remove ✕.
- Daily data: `public/logic/daily/<YYYY-MM-DD>.json`, each shard `{ "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg, humMin, humMax, precAcc }, dayStats }`. **60 days, ≈ 2.1 MB total** (2026-07-05 → 2026-09-02 — as of the time of writing).
- `filterStations.js` / `computeGeoValues.js` / `meteoGrid.js` / `meteoOverlay.js` all key off the **single global window**.

**The core problem:** values (precAcc, tempAvg, humAvg) are computed once over the global window and shared by everything — filters, slider limits, station circles, the map grid. Removing the global window means each filter needs its **own** aggregation over its **own** window.

---

## 2. Target data model

### 2.1 Filter instance

```js
// Meteo filter instance (rain | hum | temp), stored in App state:
{
  id: 'f3',                 // stable per instance (counter)
  type: 'rain',             // 'rain' | 'hum' | 'temp'
  from: 14,                 // day offset: window starts 14 days before refDay
  to: 7,                    // day offset: window ends 7 days before refDay
  range: [0, 120]           // value band [min, max] in the variable's unit
}
```

- Day offsets are **days back from the reference day**: `from ≥ to ≥ 0`.
  `from = 14, to = 7` → concrete window `[refDay − 14, refDay − 7]` ("de fa 14 dies a fa 7 dies").
  `from = to = 0` → just the reference day.
  The day-range slider is drawn on a **day-index axis** (0 = oldest day … maxDays−1 = reference day, rightmost): left handle = window start (older), right handle = window end (newer). Stored offsets map to slider values via `[maxDays−1−from, maxDays−1−to]` (the slider lib requires `min < max`).
- **Unit conversions for the value band:** rain in mm, humidity in %, temperature in °C.
- **New-instance defaults:** day range `[60, 0]` (clamped to `maxDays − 1`) = "last 60 days"; value `range` = **full span of that window**, so the instance is *inert* (always passes, no map layer) until the user narrows a handle — same contract as today's "full span = no filtering". The editor opens immediately on add; ✕ Cancel removes the instance again.
- Altitude and terrain are **not** instances — they keep today's single `reliefRange` (`[lo, hi] | null`) and `mcscOff` (`Set`).

### 2.2 Per-instance aggregation (what "the value" means)

For the window `[refDay − from, refDay − to]` (concrete `YYYY-MM-DD` keys), using the existing per-day shard fields:

| type | aggregate over window | matches computeGeoValues today |
|---|---|---|
| `rain` | **Σ** of daily `precAcc` | yes (precAcc sums) |
| `hum`  | **x̄** of daily `humAvg`  | yes (safeAvg) |
| `temp` | **x̄** of daily `tempAvg` | yes (safeAvg) |

Missing days are skipped (rain missing-day contributes 0, temp/hum average only present days — identical to current `computeGeoValues`). A station with **no** data at all inside the window is "no data" for that instance.

### 2.3 Combination semantics (AND everywhere)

A station passes when **all** of the following hold:

1. For **every** meteo filter instance `f`: aggregate(value, window(f)) ∈ f.range  *(instances of the same type AND together too — D2)*
2. `altitud ∈ reliefRange` if reliefRange is active
3. Terrain not dimmed (unchanged, handled by the MCSC SLD / legend state)
4. Instances whose value band equals the window's **full span** are inert — they always pass and create no map layer (mirrors today's "full span = no filtering").

No filters active → **no filtering** → return `[]` ("show everything"), same contract as today.

---

## 3. State model (App.jsx before → after)

| Today | After | Notes |
|---|---|---|
| `daysRange` (calendar) | **removed** | replaced by per-filter windows |
| `showCalendar`, `handleSelect`, `minDate`, `maxDate` | **removed** | DayPicker gone; keep `days` list + derive `refDay` |
| `rainRange`, `humRange`, `tempRange` (3 bands) | `meteoFilters: FilterInstance[]` | single source of truth for all meteo filters |
| `reliefRange` | `reliefRange` (unchanged) | single, timeless |
| `mcscOff` | `mcscOff` (unchanged) | single, timeless |
| `filteredStationsCodes` | `filteredStationsCodes` (same, new computation) | |
| `rangeLimits` (from geoWithData) | `altLimits` (from station metadata) + per-window value limits (§5.2) | value limits are no longer global |

New App state:
- `refDay` — latest data day (`Date` from `days[days.length - 1]`, already loaded).
- `maxDays` — `days.length` (60 today); caps the day-offset sliders.
- `nextFilterId` counter for stable instance ids.

New App handlers:
- `addFilter(type)` → append `{ id, type, from, to, range }` with the §2.1 defaults.
- `updateFilter(id, patch)` → edit `from/to` or `range`.
- `removeFilter(id)`.

---

## 4. Core logic changes

### 4.1 New module: `src/logic/filterAggregate.js` (prefix-sum lookups)

The heart of the refactor. Once per data load, build **prefix sums per station per variable**, so any window's aggregate is O(1):

```js
// For each station code and variable, cumulative arrays over sorted day keys:
//   sumRain[code][k]  = Σ precAcc over days[0..k]
//   sumTemp[code][k]  = Σ tempAvg over days[0..k]   (divide by count for mean)
//   sumHum[code][k]   = Σ humAvg  over days[0..k]
//   count[code][k]    = number of days with data for that station up to k
```

Exports (implemented, `filterAggregate.js`):
- `buildAggregateTable(data)` → `{ days, stations, sums, counts }` with `days` (sorted ascending) and prefix arrays per station per variable: `sums[type][code]`, `counts[type][code]` (`type ∈ rain|temp|hum`). `counts.rain` = days the station has an entry (drives the null-vs-0 decision); `counts.temp/hum` = days with a *usable* (`hasNumber`) value. Memoized in App.
- `aggregateWindow(agg, code, type, fromOffset, toOffset)` → `value | null`
  - concrete indices: `iFrom = days.length − 1 − fromOffset`, `iTo = days.length − 1 − toOffset`; requires `toOffset ≤ fromOffset ≤ days.length − 1` (else `null`)
  - rain: `Σ` over present days (missing days contribute 0 — matches today); `null` when the window has no present day
  - temp/hum: `x̄` over usable days; `null` when none (deviation from computeGeoValues: unusable values are skipped, not coerced to 0)
- `windowToDates(refDay, fromOffset, toOffset)` → `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }` for labels, tile URLs, grid keys.
- `limitsForWindow(agg, type, fromOffset, toOffset)` → `[min, max] | null` across all stations, memoized per aggregate table via a `WeakMap` (small LRU) so re-built tables never read stale limits.

Complexity: build O(vars × days × stations) ≈ 3×60×190 ≈ 34k ops once; every window query O(1).

### 4.2 Per-window value-slider limits

The value slider's `[min, max]` **depends on the filter's day window** (rain over 30 days reaches higher than rain over 1 day). Rule:

- When the day slider changes → recompute `limitsForWindow(agg, type, from, to)` = min/max across all stations of `aggregateWindow(...)` (O(stations) ≈ 190 ops; implemented in `filterAggregate.js`, memoized per table via `WeakMap`).
- If the current value `range` falls outside the new limits, **clamp** it into `[min, max]` before showing the editor.
- Altitude keeps its static station-metadata limits.

### 4.3 Rewrite `src/logic/filterStations.js` — **done**

New signature (pure, unit-testable, no React), implemented:

```js
filterStationCodes(features, meteoFilters, reliefRange, aggTable)
// → array of station codes passing EVERY filter (AND), or [] when no filter is active
```

- For each feature: `altitud` check (if relief active), then for each instance `aggregateWindow(agg, codi, f.type, f.from, f.to)` ∈ `f.range`.
- Station missing data for an active instance → excluded (same spirit as today).
- Empty `meteoFilters` + no relief → `[]` ("show everything").
- Inert detection: an instance constrains only when its band is narrower than `limitsForWindow(agg, type, from, to)` (full span == off); malformed instances (no usable `range`) are treated as inert. The relief band is inactive when it spans the stations' altitud min–max (raw-`hasNumber` guard, so `null` altitud is never coerced to 0).

### 4.4 `computeGeoValues.js` — display window only

With no global window, this module stops driving filters. It stays as the source of the **display values** shown in station circles (`labelMode`) and `StationPanel` totals, computed over a **default display window**:
- Default: the **last 60 days** from the reference day (`[refDay − 59, refDay]`), consistent with the new-instance day-range default; the chart shows exactly this window, so no extra capping is needed. The label-mode circle values and StationPanel totals are computed over this same display window.
- `rangeLimits` → split: `altLimits` from station metadata; meteo limits now per-window (§4.2).

---

## 5. Map overlays

> **SUPERSEDED after implementation** — the grey-mask overlay architecture
> below (§5.1–5.3, per-layer `meteo://`/`alt://` grey masks + remote-coloured
> MCSC WMS) was replaced by ONE client-side stacked terrain overlay
> (`terrain://`, §13): terrain is painted only where EVERY condition holds and
> failing pixels are transparent (relief), no grey anywhere. §5 remains for
> the record; §10/§11 are updated.

### 5.1 Meteo overlays: one raster layer **per filter instance** (superseded)

Today: one layer per variable, one grid per (window, variable). With per-instance windows:
- Each active instance gets its **own raster layer** `precAcc-band-<id>`, whose tile URL bakes the instance's concrete window + band:
  `meteo://{z}/{x}/{y}?v=precAcc&w=<from>_<to>&b=<lo>_<hi>&id=<f3>`
- Layers are added when an instance is created and removed when it's removed (`map.addLayer` / `map.removeLayer` dynamically — replaces today's static one-per-variable creation in `onMapLoad`).
- **AND semantics fall out of stacking:** each layer greys pixels whose window-value is *outside* its band; a pixel is grey if **any** layer greys it = every instance must pass. Identical to how today's variable layers stack.
- Grid cache key becomes the **concrete window** (`precAcc|2026-08-19_2026-09-02` instead of the old `windowKey`), so two instances sharing a window reuse the same IDW grid. (Note: with AND semantics, per-instance layers work; if we ever switch to OR within a type we'd merge layers back to one per variable with a combined classifier — noted, not needed now.)

### 5.2 `meteoOverlay.js` / `meteoGrid.js` changes — done, then **superseded**

- `parseMeteoTileUrl`: parses `w=<from>_<to>` (two YYYY-MM-DD dates — `w` now carries the CONCRETE window, not the old window key) + `id`; keeps `b=<lo>_<hi>` (`_` separator already handles negatives). Regex is end-anchored, so legacy and malformed URLs reject (tested).
- `getContext` returns `{ agg, features }` (aggregate table + base station features); `buildMeteoTile` computes the window features on the fly via `featuresForWindow(agg, features, variable, from, to)` — implemented in `meteoGrid.js`, mapping variable → type and using the new `aggregateWindowByDates` in `filterAggregate.js` — and passes them to the existing `buildMeteoGrid`.
- Grid cache key = `${from}_${to}|${variable}` (concrete dates passed as the `windowKey` param) — two instances sharing a window reuse one IDW grid.
- Lapse-rate correction for temp grids: unchanged.
- The effect that regenerates tiles is rewritten to iterate `meteoFilters` and `setTiles` per instance layer (`${variable}-band-${id}`); removed instances have their layer + source removed. The flow test now embeds the v2 effect body (with `limitsForWindow`-based inert detection) as the canonical copy step 4 must implement in App.jsx.

### 5.3 Altitude band & terrain — unchanged (superseded)

- Old design: `alt://` protocol, `altitude-band` layer, `altBandRef`; forest filter (`mcscOff` + remote MCSC SLD rebuild). Both replaced by the stacked overlay (§13) — altitud is still static per station; the band is now one of the stacked conditions.

---

## 6. UI: `FilterPanel.jsx` redesign

### 6.1 Panel layout — three zones

1. **Header** — title + the reference-day anchor ("fins a les dades del 02 set") + a single **✕ Tanca**. The old ✓ "Aplicar" button is **removed**: every change already applies instantly (state-driven), so it was a redundant "close".
2. **Single filters** (unchanged behaviour): **Terreny (bosc)** and **Relleu** keep today's button → editor → applied-row pattern (e.g. applied "⛰ Relleu · 0 – 3000 m" + ✕).
3. **Mètriques section** — the new instance area: an add-buttons row + the stacked list of instance rows.

```
┌─ Filtres ──────────────── fins a les dades del 02 set ─ [✕] ┐
│                                                              │
│  🌲 Terreny (bosc)                                  [edita] │   ← single & timeless
│  ⛰  Relleu · 0 – 3000 m                               [✕]   │
│                                                              │
│  ── Mètriques (cada filtre amb el seu període) ───────────── │
│  [+ 💧 Pluja] [+ 🌿 Humitat] [+ 🌡 Temperatura]              │
│                                                              │
│  💧 Pluja · 19 ago – 02 set (darrers 14 dies)                │
│     qualsevol valor · inactiu                       [✕]     │   ← inert instance
│  💧 Pluja · 19 ago – 02 set · 50 – 120 mm            [✕]     │   ← applied instance
│  🌡 Temperatura · 29 ago – 02 set · 5 – 30 °C        [✕]     │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 The two-slider editor (expands in place)

Clicking an applied row (or a freshly added instance) expands it **in place**; the other applied rows stay visible below, collapsed — an improvement over today's "editor replaces the list". One editor open at a time (existing pattern).

```
│  💧 Pluja (editant)                                   [✓][✕] │
│     del 19 ago al 02 set   ·   darrers 14 dies               │
│     ██████████████░░░░░░░░░░░░░░░░  day-range slider         │
│     valor: 50 – 120 mm   (0 – 150 mm disponibles)            │
│     ████████░░░░░░░░░░░░░░░░░░░░░░  value slider             │
```

- **Day-range slider** — axis in **day indices**: `min = 0` (oldest day) → `max = maxDays − 1` (reference day, rightmost). Two handles = window *start* (left, older) and *end* (right, newer). Internally the instance stores day *offsets* (`from`/`to`, `from ≥ to`); the slider value maps to indices via `[maxDays−1−from, maxDays−1−to]` — the lib requires `min < max` (verified against `react-range-slider-input` types), so no inverted axis.
  - **Primary label:** concrete dates — `19 ago – 02 set` (compact Catalan via a new tiny `fmtShortCat` helper in `utils.js`; `fmtDateCat` with its weekday is too long for a row).
  - **Secondary label**, human-readable: `to === 0` → "darrers 14 dies"; `from === to` → "fa 14 dies" (single day); otherwise → "fa 14 → fa 7 dies".
- **Value slider** — `min/max` from `limitsForWindow(type, from, to)` (§4.2), recomputed live as the day handles move; the value band **clamps** into the new limits. Label: `50 – 120 mm` (mm / % / °C per type); full span renders as "qualsevol valor".
- **✓ D'acord** collapses the row with the new values. **✕ Cancel·la** discards: reverts an edited instance to its saved values, or removes an instance that was just added and never applied.

### 6.3 Flows (walk-through)

- **Add (Flow A):** click `+ 💧 Pluja` → instance created with §2.1 defaults (`[30, 0]` + full value span) → editor opens immediately on the new row. Drag the day and value handles (labels update live), then ✓. Until the value band is narrowed below the window's full span the instance is **inert**: dimmed row with "qualsevol valor · inactiu", no map layer, no filtering effect — the "full span = no filtering" contract, now visible instead of implicit.
- **Second instance of the same type (Flow B):** rows stack; AND semantics mean the grey mask now requires *both* bands — stricter filtering. This is the visible consequence of D2.
- **Edit (Flow C):** click the row body → expands in place with its current values → adjust → ✓ / ✕.
- **Remove (Flow D):** ✕ on a collapsed row → instance removed instantly; its map layer + source removed; stations re-filtered (same immediacy as today).
- **Cap (Flow E):** at 5 instances of a type, its `+` button disables with tooltip "Màxim 5 filtres de pluja".
- **Single filters (Flow F):** Terreny / Relleu keep today's editor pattern. The visual inconsistency with the in-place instance rows is accepted — they are single, timeless filters.

### Files that go away
- `Selectors.jsx` — **delete** (calendar + old sliders; already unused, kept as reference).
- `react-day-picker` dependency — **remove** from `package.json` (only used by Selectors).

### Header / StationPanel
- Header: replace the `headerdays` range with the existing "Últimes dades: …" indicator (already present); no day-range text.
- `StationPanel.jsx`: replace `daysRange` with the default display window (last 60 days) for its chart and totals. `globalStats` already derives from `data` — unaffected once all days are loaded.

---

## 7. Data loading change

| Today | After |
|---|---|
| `loadSummaries(days, from, to)` — only the calendar window | `loadSummaries(days, days[0], days[last])` — **all available days**, once |

- Rationale: any filter may reference any window; prefix-sum aggregation needs every day; StationPanel needs full history too.
- Cost: 60 shards ≈ 2.1 MB today, fetched in parallel (`Promise.all`, already implemented). Grows ~1 shard/day.
- Future (if payload becomes an issue): add a combined `all_days.json` bundle server-side in `meteokat/` and fetch one file — out of scope now, noted in §10.

---

## 8. Edge cases

1. **`from === to`** — single-day window; allowed (e.g. "50 mm on that one day 2 weeks ago").
2. **Station with no data in the window** → instance fails → station excluded while that filter is active (consistent with today's no-data exclusion).
3. **Reference-day staleness** — if `index.json` lags, offsets stay stable and labels show the true concrete dates; nothing breaks.
4. **Value range out of new limits after day-slider move** → clamp into `[min, max]` before applying.
5. **Adding an instance while another editor is open** → close the previous editor first (existing single-editor pattern).
6. **No filters at all** → `[]` → all stations shown, no meteo layers created.
7. **maxDays = 1** (pathological) → day slider collapses to a single position; code must tolerate `[0, 0]`.

---

## 9. Test plan

| File | Tests |
|---|---|
| **new** `filterAggregate.test.js` — **done** | rain Σ incl. missing-day-as-0 + null-window; temp/hum means over usable days; `from/to` offsets → correct concrete window; O(1) vs naive re-summation; `limitsForWindow` incl. no-data + per-table cache |
| **rewrite** `filterStations.test.js` — **done** | AND across types; AND across same-type instances; per-instance windows; relief ANDed in + full-span-off; no-data / no-codi exclusion; no filters → `[]`; inclusive value bounds; inert + malformed instances |
| **update** `meteoGrid.test.js` — **done** | grid cache key uses concrete window dates; `featuresForWindow` (window aggregates into feature properties, endpoint respect, unknown variable/empty → `[]`) |
| **update** `meteoOverlay.tile/flow.test.js` — done, then **deleted with the module** (§13 supersedes the per-layer grey masks) |
| **keep** `App.render.test.jsx` | still renders (new state defaults) |
| **new** `terrainOverlay.test.js` — **done** | `colourForBand` (official colour / null for no-data, unlisted 230–234, dimmed); `classifyTerrainPixel` (all-conditions AND, water never gated, inclusive bounds, sea/no-data excluded); state signature + tile URL (order-insensitive, changes with filters, parse round-trip) |
| **new** `terrainOverlay.tile.test.js` — **done** | painted tile end-to-end: class colour with no filters; dimmed class transparent + water painted (no grey); altitude gates land but never water (DEM only fetched when needed); meteo band gates land; ALL conditions together + temperature lapse re-application |
| **update** `mcscLegend.test.js` — **done** | new lookups (`entryForBand`, `isWaterBand`, water values) + `renderBandSld` (every band 1–41 → `rgb(v,0,0)`, no legend colours / no grey server-side) |

---

## 10. File-by-file change list

| File | Change |
|---|---|
| `src/logic/filterAggregate.js` | **NEW (done)** — prefix-sum aggregate table, `aggregateWindow` + `aggregateWindowByDates`, `windowToDates`, `limitsForWindow` (§4.1–4.2) |
| `src/logic/filterAggregate.test.js` | **NEW (done)** — 25 tests (was 20; the suite grew): rain Σ / missing-day-as-0 / null-window, temp+hum means over usable days, offset→concrete window, naive cross-check, limits incl. no-data + cache (§9) |
| `src/logic/filterStations.js` | **REWRITE (done)** — instance-list + relief signature, AND semantics on the aggregate table (§4.3) |
| `src/logic/filterStations.test.js` | **REWRITE (done)** — 20 tests (was 16). ⚠️ The module this tests is now **unused** — `App` no longer calls `filterStationCodes` (stations are never filtered); see `APP_STATE_REPORT.md` §7.5. no-filters → `[]`, inert/malformed instances, AND across types + same-type, per-instance windows, relief ANDed in + full-span-off, no-data/no-codi exclusion, inclusive bounds (§9) |
| `src/comps/FilterPanel.jsx` | **DONE** — header anchor + single ✕ (✓ dropped), add-type buttons (5-per-type cap), in-place two-slider editors, inert rows, relief/forest unchanged (§6) |
| `src/logic/utils.js` | **DONE** — `fmtShortCat` compact date helper + tests (§6.2) |
| `src/App.jsx` | **DONE** — state model (§3), all-days loading (§7), refDay/maxDays, add/update/remove handlers, `terrainState` memo (§13) + single always-on `terrain` source/layer replacing remote MCSC + altitude + per-instance meteo layers, sea transparent when Aigües off, display window, header without day range (§6) |
| `src/logic/meteoOverlay.js` | done (§5.2), then **DELETED** — superseded by `terrainOverlay.js` (§13); its tests deleted with it |
| `src/logic/altitudeOverlay.js` | **DELETED** — the `alt://` grey mask is folded into `terrainOverlay.js` (§13); its test deleted with it |
| `src/logic/mcscLegend.js` | **REWORKED (done)** — band lookups (`entryForBand`, `isWaterBand`, `MCSC_WATER_ENTRY/VALUES`) + `renderBandSld` (raw band value → `rgb(v,0,0)`); `renderMcscSld` (server colouring / grey dimming) removed — the map never greys anymore |
| `src/logic/mcscRaw.js` | **NEW (done)** — raw-band WMS tile URL + browser loader (band-encoded SLD, decode red channel, cached per z/x/y) |
| `src/logic/terrainOverlay.js` | **NEW (done)** — `terrain://` protocol: per-pixel AND (selected class + altitude band + every meteo instance) paints the MCSC colour, else transparent (relief); water never gated; state-signature tile URL; DEM fetched only when needed (§13) |
| `src/logic/meteoGrid.js` | **DONE** — `featuresForWindow` helper over the aggregate table; cache keyed by concrete window dates (§5.2) — now sampled by `terrainOverlay.js` |
| `src/logic/computeGeoValues.js` | unchanged — called over the display window (last 60 days) from App (§4.4) |
| `src/comps/StationPanel.jsx` | unchanged — receives the display window via the `daysRange` prop (§6) |
| `src/comps/Selectors.jsx` | **DELETED** (calendar) |
| `package.json` | react-day-picker removed (lockfile updated via `npm install`) |
| tests (`filterAggregate`, `filterStations`, `meteoGrid`, `terrainOverlay*`, `mcscLegend`, `utils`, …) | **DONE** — 125 tests / 10 files *at the time of this refactor*; the suite has since grown to **339 tests / 24 files** (`npm test`, 2026-09-12) |

---

## 11. Implementation checklist (suggested order)

1. ~~**`filterAggregate.js`** + tests — done~~ — pure logic first (prefix sums, window helpers, limits lookup).
2. ~~**`filterStations.js`** rewrite + tests — done~~ — instance-list AND filtering on the aggregate table.
3. ~~**`meteoGrid.js` / `meteoOverlay.js`** — done~~ — concrete-window cache key, URL `w`/`id`, context via aggregate table; update overlay tests.
4. ~~**`App.jsx`** — done~~ — new state model, all-days load, refDay, add/update/remove handlers, dynamic meteo layers, display window for `computeGeoValues`/`StationPanel`, header.
5. ~~**`FilterPanel.jsx`** — done~~ — new UI (add buttons, two-slider editor, applied rows, remove). Implemented together with step 4 (the old panel called the old `filterStationCodes` signature, so the two are coupled).
6. ~~**Cleanup** — done~~ — `Selectors.jsx` deleted, `react-day-picker` dropped, `npm test` (126 at the time; now 339) + `npm run build` + `npm run lint` all green.
7. ~~**Stacked terrain overlay** — done~~ — replace the grey-mask architecture (§5) with one client-side `terrain://` composite (§13): legend rework + `mcscRaw` + `terrainOverlay` + App rewire + retire `altitudeOverlay`/`meteoOverlay`; 125 tests / 10 files at the time (now 339 / 24), lint + build green.

---

## 12. Decisions recorded / open questions

**Decided (all defaults fixed):** D1 two-handle day slider per filter · D2 AND across all filters incl. same-type · D3 range value slider · D4 reference = latest data day (anchor shown in UI) · new-instance defaults `[60, 0]` + full value span (inert until narrowed) · 5-instance-per-type cap · display window = last 60 days.

**Deferred / future (not blockers):**
- Switch the reference to "today" (device clock): one-line change (`refDay = new Date()`); the offsets design already supports it.

---

## 13. Stacked terrain overlay (implemented)

**Request:** no more grey "deselected" areas — unselected map areas must show
just the relief, exactly like territories abroad / areas without terrain info;
and all filters must STACK: paint terrain only where every condition is true,
else transparent.

**Why it had to move client-side:** the old MCSC layer was a remote WMS image
coloured server-side (SLD) and the altitude/meteo filters were separate grey
masks stacked on top. You cannot mask a server-coloured raster with client
conditions — so the terrain colouring decision moved into ONE browser-side
raster that evaluates every condition per pixel (see the earlier analysis:
"why it can't be done by stacking the current layers").

**Mechanism (verified against the live ICGC WMS):**
- `mcscLegend.js` now exports band lookups + `renderBandSld()`, an SLD that
  makes the MCSC WMS return the RAW palette band value per pixel encoded as
  its red channel (`band v → colour rgb(v,0,0)`), everything else transparent.
- `mcscRaw.js` requests those tiles (`mcscBandTileUrl`) and decodes them in
  the browser (`loadMcscBandTile`, cached per z/x/y).
- `terrainOverlay.js` paints, per pixel: the pixel's MCSC class colour iff
  - the band has a legend entry whose class is **selected** (not dimmed, not
    a permanently-unlisted 230–234 value) AND
  - (it is **water** — painted whenever Aigües is on, never gated: water is
    not "mushroom terrain") OR the **altitude band** accepts the DEM elevation
    AND every **active meteo instance**'s window aggregate at the pixel is
    inside its band (sampled from its own IDW grid, §5.2).
  - failing pixels → transparent → the hillshade/relief shows through.
- Per-instance state is baked into the tile URL as a signature
  (`terrain://{z}/{x}/{y}?s=<sig>`); the protocol reads the CURRENT state via
  `getState()`, cache keyed per (z,x,y,state). `App.jsx` keeps one memoised
  `terrainState` (dimmed codes + narrowed alt band + active instances with
  concrete windows) and `setTiles` on any change.
- The DEM is fetched per tile only when a tile needs it: an active altitude
  band or a temperature instance (sea-level-reduced grid re-applied per
  pixel, same lapse rate as before).

**Layer stack (was 5 layers, now 3):** `sea` (water colour; transparent when
Aigües dimmed → relief) → `terrain` (the composite, always on, opacity 0.85)
→ `hillshade` (relief on top, unchanged) → stations. `mcsc` (remote WMS),
`altitude-band` and the per-instance meteo raster layers are gone.

**Retired:** `meteoOverlay.js`, `altitudeOverlay.js` and their tests. Kept:
`meteoGrid.js` (grids, sampled per pixel by the composite) and
`seaOverlay.js` (`c=off` semantics instead of grey). MCSC_GREY survives only
as the legend-UI swatch for a dimmed entry.

**Tests:** `terrainOverlay.test.js` (pure classification + URL/state) and
`terrainOverlay.tile.test.js` (painted-tile integration with stubbed
band/DEM/canvas) — all-conditions AND, relief-on-fail, water/sea never gated,
no grey anywhere. 125 tests / 10 files at the time of the overlay work (now 339 tests / 24 files), lint + build green.