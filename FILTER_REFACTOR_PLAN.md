# Refactor: Per-Filter Time Ranges (calendar removed)

> **Status:** Planning document — no code changed.
> **Goal:** Remove the global calendar date window. Every meteo filter (rain / humidity / temperature) becomes a *filter instance* carrying its own day range + value range (two sliders each). Multiple instances of the same type are allowed. Altitude and terrain (forest) filters stay single and timeless, as today.

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
- Daily data: `public/logic/daily/<YYYY-MM-DD>.json`, each shard `{ "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg, humMin, humMax, precAcc }, dayStats }`. **60 days, ≈ 2.1 MB total** (2026-07-05 → 2026-09-02 today).
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
- **New-instance defaults:** day range `[30, 0]` (clamped to `maxDays − 1`) = "last 30 days"; value `range` = **full span of that window**, so the instance is *inert* (always passes, no map layer) until the user narrows a handle — same contract as today's "full span = no filtering". The editor opens immediately on add; ✕ Cancel removes the instance again.
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

Exports:
- `buildAggregateTable(data)` → `{ days, sumRain, sumTemp, sumHum, count, stations }` (memoized in App).
- `aggregateWindow(agg, code, type, fromOffset, toOffset)` → `value | null`
  - concrete indices: `iFrom = days.length − 1 − fromOffset`, `iTo = days.length − 1 − toOffset`
  - rain: `Σ = sumRain[iTo] − sumRain[iFrom−1]` (missing days contribute 0 — matches today)
  - temp/hum: `x̄ = (sumX[iTo] − sumX[iFrom−1]) / (count[iTo] − count[iFrom−1])`; if the denominator is 0 → `null` (no data)
- `windowToDates(refDay, fromOffset, toOffset)` → `{ from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }` for labels, tile URLs, grid keys.

Complexity: build O(vars × days × stations) ≈ 3×60×190 ≈ 34k ops once; every window query O(1).

### 4.2 Per-window value-slider limits

The value slider's `[min, max]` **depends on the filter's day window** (rain over 30 days reaches higher than rain over 1 day). Rule:

- When the day slider changes → recompute `limitsForWindow(type, from, to)` = min/max across all stations of `aggregateWindow(...)` (O(stations) ≈ 190 ops, memoized per `type|from|to` with a small LRU).
- If the current value `range` falls outside the new limits, **clamp** it into `[min, max]` before showing the editor.
- Altitude keeps its static station-metadata limits.

### 4.3 Rewrite `src/logic/filterStations.js`

New signature (pure, unit-testable, no React):

```js
filterStationCodes(features, meteoFilters, reliefRange, aggTable)
// → array of station codes passing EVERY filter (AND), or [] when no filter is active
```

- For each feature: `altitud` check (if relief active), then for each instance `aggregateWindow(agg, codi, f.type, f.from, f.to)` ∈ `f.range`.
- Station missing data for an active instance → excluded (same spirit as today).
- Empty `meteoFilters` + no relief → `[]` ("show everything").

### 4.4 `computeGeoValues.js` — display window only

With no global window, this module stops driving filters. It stays as the source of the **display values** shown in station circles (`labelMode`) and `StationPanel` totals, computed over a **default display window**:
- Default: the **last 30 days** from the reference day (`[refDay − 29, refDay]`), consistent with the new-instance day-range default; the chart shows exactly this window, so no extra capping is needed. The label-mode circle values and StationPanel totals are computed over this same display window.
- `rangeLimits` → split: `altLimits` from station metadata; meteo limits now per-window (§4.2).

---

## 5. Map overlays

### 5.1 Meteo overlays: one raster layer **per filter instance**

Today: one layer per variable, one grid per (window, variable). With per-instance windows:
- Each active instance gets its **own raster layer** `precAcc-band-<id>`, whose tile URL bakes the instance's concrete window + band:
  `meteo://{z}/{x}/{y}?v=precAcc&w=<from>_<to>&b=<lo>_<hi>&id=<f3>`
- Layers are added when an instance is created and removed when it's removed (`map.addLayer` / `map.removeLayer` dynamically — replaces today's static one-per-variable creation in `onMapLoad`).
- **AND semantics fall out of stacking:** each layer greys pixels whose window-value is *outside* its band; a pixel is grey if **any** layer greys it = every instance must pass. Identical to how today's variable layers stack.
- Grid cache key becomes the **concrete window** (`precAcc|2026-08-19_2026-09-02` instead of the old `windowKey`), so two instances sharing a window reuse the same IDW grid. (Note: with AND semantics, per-instance layers work; if we ever switch to OR within a type we'd merge layers back to one per variable with a combined classifier — noted, not needed now.)

### 5.2 `meteoOverlay.js` / `meteoGrid.js` changes

- `parseMeteoTileUrl`: parse `w=<from>_<to>` + `id`; keep `b=<lo>_<hi>` (`_` separator already handles negatives).
- `getContext` now returns `{ data /* all daily shards */, features /* station coords + altitud */, aggTable }` instead of window features; `buildMeteoTile` computes the window features on the fly via `aggregateWindow` (or a `featuresForWindow(agg, features, from, to)` helper) and passes them to the existing `buildMeteoGrid`.
- Lapse-rate correction for temp grids: unchanged.
- The effect that regenerates tiles (currently keyed on `rainRange/humRange/tempRange`) is rewritten to iterate `meteoFilters` and `setTiles` per instance layer; removed instances have their layer + source removed.

### 5.3 Altitude band & terrain — unchanged

- `alt://` protocol, `altitude-band` layer, `altBandRef`: untouched (altitud is static per station, no time dimension).
- Forest filter (`mcscOff` + MCSC SLD rebuild): untouched.

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
- `StationPanel.jsx`: replace `daysRange` with the default display window (last 30 days) for its chart and totals. `globalStats` already derives from `data` — unaffected once all days are loaded.

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
| **new** `filterAggregate.test.js` | rain Σ over window incl. missing-day-as-0; temp/hum mean over present days; `from/to` offsets → correct concrete window; O(1) results match naive re-summation; `null` when no data in window |
| **rewrite** `filterStations.test.js` | AND across types; AND across same-type instances; relief ANDed in; no-data station excluded; no filters → `[]`; inclusive value bounds |
| **update** `meteoGrid.test.js` | grid cache key uses concrete window dates (two instances, same window → one grid) |
| **update** `meteoOverlay.tile/flow.test.js` | URL parsing with `w=<from>_<to>` + `id`; classify per-instance (AND stacking); off/no-band → transparent |
| **keep** `App.render.test.jsx` | still renders (new state defaults) |

---

## 10. File-by-file change list

| File | Change |
|---|---|
| `src/logic/filterAggregate.js` | **NEW** — prefix-sum aggregate table + window helpers (§4.1) |
| `src/logic/filterStations.js` | **REWRITE** — instance-list + relief signature, AND semantics (§4.3) |
| `src/comps/FilterPanel.jsx` | **REWRITE** — header anchor + single ✕ (drop ✓), add-type buttons, in-place two-slider editor, applied rows (§6) |
| `src/logic/utils.js` | add compact `fmtShortCat` date helper for row labels (§6.2) |
| `src/App.jsx` | state model (§3), all-days loading (§7), refDay/maxDays, add/update/remove handlers, dynamic meteo layers (§5.1), header/display window (§6) |
| `src/logic/meteoOverlay.js` | URL with window+id, context returns `{ data, features, aggTable }`, per-instance classify (§5.2) |
| `src/logic/meteoGrid.js` | cache key = concrete window dates; window-features helper (§5.2) |
| `src/logic/computeGeoValues.js` | display window only (last 30 days default) (§4.4) |
| `src/comps/StationPanel.jsx` | `daysRange` → default display window (§6) |
| `src/comps/Selectors.jsx` | **DELETE** (calendar) |
| `package.json` | remove `react-day-picker` |
| `src/logic/filterStations.test.js`, `meteoGrid.test.js`, `meteoOverlay.*.test.js` | update; add `filterAggregate.test.js` |

---

## 11. Implementation checklist (suggested order)

1. **`filterAggregate.js`** + tests — pure logic first (prefix sums, window helpers, limits lookup).
2. **`filterStations.js`** rewrite + tests — instance-list AND filtering on the aggregate table.
3. **`meteoGrid.js` / `meteoOverlay.js`** — concrete-window cache key, URL `w`/`id`, context via aggregate table; update overlay tests.
4. **`App.jsx`** — new state model, all-days load, refDay, add/update/remove handlers, dynamic meteo layers, display window for `computeGeoValues`/`StationPanel`, header.
5. **`FilterPanel.jsx`** — new UI (add buttons, two-slider editor, applied rows, remove).
6. **Cleanup** — delete `Selectors.jsx`, drop `react-day-picker`, run `npm test` + `npm run build` + `npm run lint`.

---

## 12. Decisions recorded / open questions

**Decided (all defaults fixed):** D1 two-handle day slider per filter · D2 AND across all filters incl. same-type · D3 range value slider · D4 reference = latest data day (anchor shown in UI) · new-instance defaults `[30, 0]` + full value span (inert until narrowed) · 5-instance-per-type cap · display window = last 30 days.

**Deferred / future (not blockers):**
- Switch the reference to "today" (device clock): one-line change (`refDay = new Date()`); the offsets design already supports it.