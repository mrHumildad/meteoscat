# Spec: Orientation filter — "només cara nord" (slope aspect)

> **Status:** ✅ **Implemented — kept as the design record** (2026-09-12). Shipped exactly as
> proposed: D1 8 sectors keep-selected · D2 flat land (< 5°) excluded · D3 overlay only (no
> station dots) · D4 all-8 = off · D5 neighbour-DEM border fetch (option A) · D6 no zoom
> special case. Test suite grew from 312 to **339 tests / 24 files**. Current behaviour is
> documented in `TILE_RENDERING.md` §4.4. **The sections below describe the plan as written**;
> see the implementation notes at the end of this file for the few deviations.
> **Goal:** a new single, timeless filter **Orientació** that keeps only slopes
> facing the selected compass direction(s), e.g. "solo cara nord" / *obaga*.
> It behaves exactly like the Relleu (altitude) filter but gates on the DEM
> **slope aspect** instead of the elevation, ANDed with every other filter, on
> the painted terrain overlay. Station circles are **not** gated in v1 (D3).

---

## 0. Proposed decisions (to confirm before implementing)

| # | Decision | Proposed value | Why |
|---|---|---|---|
| D1 | Sector granularity | **8 sectors** (N / NE / E / SE / S / SW / W / NW), keep-selected | "cara nord" should mean N±22.5° at least; 8 sectors reuse the legend multi-select pattern and stay flexible (N+NE+NW ≈ obaga). |
| D2 | Flat-terrain rule | **Strict:** pixels with slope < `ASPECT_MIN_SLOPE_DEG` (5°) are excluded when the filter is active | Aspect on flats is DEM noise; consistent with every other filter = "hide what doesn't match". Permissive (flat passes) is a one-line alternative if the filter later becomes a highlight. |
| D3 | Stations | **Not gated in v1** — overlay pixels only | A station is a point; many XEMA stations sit on plains/valleys (altitud 0.5–150 m) where orientation is meaningless. |
| D4 | Inert form | No sector selected, or all 8 selected ⇒ filter off (`aspect: null`) | Mirrors "full span == off" of Relleu / meteo instances. |
| D5 | Tile borders | Fetch the **8 neighbouring DEM tiles** while the filter is active (A) | No seams; cached + shared, so traffic stays ≈ visible tiles (§4.3). |
| D6 | Zoom | No special case below z11 — the gate applies at every zoom | Behaviour stays consistent while zooming; it just degrades gracefully to a broad trend at low zoom (§7). |

---

## 1. What exists today (recap)

```
terrain:// tiles (z 7–14, 256 px) — painted per pixel by buildTerrainTile:
  band = MCSC raw band tile red channel (s[i], 0 = no data)
  colour = selected-class colour (or substrate-family colour in 'substrate')
  elev  = terrarium DEM pixel at the SAME byte index i — fetched only when
          needElev = !!st.alt || any temp grid with lapseRate
  gate  = classifyTerrainPixel(colour, isWater, elev, altBand, values, los,
          his, familyKey, offKeys) → colour or TERRAIN_TRANSPARENT
  state = { mode, off, alt, filters, geoOff } — canonical signature baked
          into the tile URL; any change ⇒ source.setTiles() repaints
```

- The overlay DEM tile and the MCSC tile share (z, x, y) and are decoded 1:1
  aligned — **the gradient between neighbouring DEM pixels is the only thing
  missing** for aspect.
- Timeless single filters today: **Bosc** (MCSC legend dims) · **Relleu**
  (altitude band via `reliefRange`) · **Substrat** (geology dims). Meteo
  filters are windowed instances (§ Mètriques).
- Pure helpers (`terrariumElevation`, `lngLatToTileXY`, …) live in
  `elevation.js`; pixel-gating lives in `terrainOverlay.js`; station gating in
  `filterStations.js`. UI legend multi-select pattern exists (forest /
  substrate editors in `FilterPanel.jsx`).

---

## 2. Orientation math & data

- **Source:** the same terrarium DEM tiles already fetched (EU-DEM 30 m via
  Mapzen/AWS — no new licence or service).
- **Aspect** = azimuth of the downhill direction of the local gradient,
  degrees clockwise from north (0/360 = N, 90 = E, 180 = S). Computed with a
  standard 3×3 (Horn) finite-difference over the decoded DEM tile, i.e.
  neighbours at byte offsets `i ± 4` and `i ± 1024` of the 256×256 RGBA
  buffer. **Slope** = `atan(√(dzdx² + dzdy²))`.
- **Sector classification:** 8 sectors of 45°, centred on the cardinals —
  `N = [337.5, 22.5)`, then every 45°. Pixels with slope < min-slope, no DEM,
  or DEM nodata have **no sector** (`null`).
- Sign convention must be pinned by unit tests, not prose: a synthetic DEM
  whose elevation increases toward the **bottom** of the tile (higher = more
  south) is a **north-facing** slope (downhill points north ⇒ aspect ≈ 0° ⇒
  sector N). The inverse plane ⇒ sector S.

---

## 3. Target state model

`terrainState` gains one key (mirrors `alt`):

```js
// terrainState (App.jsx memo) + terrainStateSignature/TERRAIN_STATE_EMPTY
{
  mode: 'terrain' | 'substrate',
  off: [...],            // dimmed MCSC classes (unchanged)
  alt: [lo, hi] | null,  // altitude band (unchanged)
  aspect: ['N', 'NE'] | null,   // NEW — selected sector keys, sorted, or null
  filters: [...],        // meteo instances (unchanged)
  geoOff: [...],         // dimmed substrate families (unchanged)
}
```

- `null` when no sector selected **or all 8 selected** (D4 — inert).
- Canonicalisation (`terrainStateSignature`) sorts the sector array; the URL
  signature token then changes exactly when the selection does — tile
  regeneration is automatic, no new wiring.
- Sectors are **not** palette-specific: like `alt` and the meteo bands they
  gate both rendering modes equally, and never gate water.

---

## 4. Core logic changes

### 4.1 `src/logic/elevation.js` — pure aspect/slope helpers (NEW)

- `terrainGradient(data, i)` → `{ dzdx, dzdy } | null` — Horn 3×3 from the
  decoded tile; `null` on the outer ring (no in-tile neighbours) and where any
  neighbour is non-finite.
- `slopeAspectAt(data, i)` → `{ slopeDeg, aspectDeg } | null` — gradient →
  slope/aspect; null on border/no-data.
- `ASPECT_SECTORS = ['N','NE','E','SE','S','SW','W','NW']` and
  `aspectSectorOf(aspectDeg)` → sector key (null for no-data is handled by the
  caller via the slope guard, not here).
- `ASPECT_MIN_SLOPE_DEG = 5` — single constant (D2), unit-testable.

No change to existing exports; the existing tile tests that mock
`loadTileImageData` keep passing unchanged.

### 4.2 `src/logic/terrainOverlay.js` — per-pixel gate

- `TERRAIN_STATE_EMPTY` gains `aspect: null`; `terrainStateSignature` /
  `terrainStateSig` include it (sorted, `null` when empty).
- `buildTerrainTile`: `const aspectActive = (st.aspect?.length ?? 0) > 0;`
  and `needElev = aspectActive || !!st.alt || grids.some(g => g.lapseRate > 0)`
  — the DEM is fetched when an orientation filter is active even without an
  altitude band.
- In the pixel loop, for land pixels that already have a colour: when
  `aspectActive` and the DEM is present, compute `slopeAspectAt(src.data, i)`;
  sector key = `null` when slope < `ASPECT_MIN_SLOPE_DEG`, on the border ring,
  or elevation non-finite. Missing/older states (`{ aspect: undefined }` from
  direct test calls) default to inactive.
- `classifyTerrainPixel` gains two **trailing optional** params
  `aspectKey = null, aspectKeys = null` (existing call sites/tests unaffected):
  when `aspectKeys` is active, a pixel with `aspectKey` outside the set — or
  `null` — is transparent (D2 strict).

### 4.3 Tile-border policy (D5 — option A)

With Horn's 3×3 the outer ring of each painted tile needs the neighbouring
DEM tiles. While `aspectActive`:

1. In `buildTerrainTile`, additionally load the up-to-8 adjacent DEM tiles at
   (z, x±1, y±1) via the existing cached `loadTileImageData`.
2. Pixels on the ring read their missing neighbours from those buffers instead
   of being dropped.

Cost: those 8 tiles are exactly the *central* tiles of the neighbouring
painted requests, so per unique painted tile only **one** new DEM fetch
happens (the cache absorbs the rest) — same traffic as today's altitude band.
Fallback if this ever feels heavy: option B, transparent 1-px outer ring
(~3 lines, but faint hairline seams at tile borders while the filter is on).

---

## 5. UI: `FilterPanel.jsx`

New timeless single filter, placed with the others in the filter panel header
row and reusing the exact expand-in-place editor + applied-row pattern of
Bosc/Relleu/Substrat:

```
┌─ Filtres ──────────────── fins a les dades del 02 set ─ [✕] ┐
│  🌲 Terreny (bosc)                                  [edita] │
│  ⛰  Relleu · 0 – 3000 m                               [✕]   │
│  🧭 Orientació · només N · NE                        [✕]   │   ← applied row
│  ── Mètriques (cada filtre amb el seu període) ───────────── │
│  [+ 💧 Pluja] [+ 🌿 Humitat] [+ 🌡 Temperatura]              │
└──────────────────────────────────────────────────────────────┘

│  🧭 Orientació (editant)                            [✓][✕] │
│     [ N ] [ NE ] [ E ] [ SE ] [ S ] [ SW ] [ W ] [ NW ]     │
│     quina cara de la muntanya conservar (pendent mínim 5°)  │
```

- **Editor:** 8 sector chips/buttons (faCompass icon on the row button;
  `aria-pressed` on chips). Toggling a selected chip off → "Ressaltar",
  on → "Atenuar" vocabulary matches the forest legend but keep-selected
  semantics, so the ✓ label reads e.g. *només N · NE*. Zero selected ⇒ ✓
  removes the filter (`onApplyAspect(null)`).
- **Applied row:** `Orientació · només {sectors}` (+ tooltip noting the
  ≥ 5° slope rule and that flat terrain / valley floors are excluded — D2).
- New props: `aspectSectors` (sorted array | null) + `onApplyAspect` — same
  shape as `reliefRange`/`onApplyRelief`.

---

## 6. `App.jsx` plumbing

- New state `aspectSectors` (`null` | sorted array of sector keys).
- `terrainState` memo: `aspect: aspectSectors?.length === 8 ? null : aspectSectors`
  (D4) — the rest of the memo, the `terrainTiles` URL memo and the existing
  `setTiles` effect need **no change** (they key off `terrainState`).
- Pass `aspectSectors` / `onApplyAspect` to `FilterPanel`.
- `filterStationCodes` untouched (D3) — dots stay visible while painted areas
  narrow, exactly the altitude/dot relationship users already know.

---

## 7. Edge cases & caveats

| Case | Behaviour |
|---|---|
| No DEM (sea, abroad, fetch failure) | Land pixels have no sector ⇒ transparent while the filter is on — same "no info = not shown" contract as the altitude gate (`elev <= 0`). Water is never gated (unchanged). |
| Flat pixels / plains | Slope < 5° ⇒ no sector ⇒ excluded (D2). This hides valley floors — intended for "només cara nord". |
| Low zoom (z7–10) | One pixel ≫ DEM cell (~115 m/px at z10); aspect becomes a broad regional trend. Acceptable; no zoom special case (D6). |
| DEM vs reality | Aspect is the macro fall-line, not insolation — canopy and surrounding ridges dominate micro-shade. Meaningful for *obaga/solana* at mountain scale (hundreds of m), unreliable inside gorges/10–100 m relief. |
| All 8 sectors selected | Treated as filter off (D4) — no pointless repaint. |
| Interaction with Relleu | ANDed: altitude band + orientation both gate each pixel (they share one DEM fetch). |

---

## 8. Test plan

| File | Cases |
|---|---|
| `elevation.test.js` | Synthetic 256×256 planes: gradient rising southward ⇒ aspect ≈ 0 ⇒ sector `N`; eastward rise ⇒ `W`, etc. `aspectSectorOf` boundaries (337.5° wraps to N). Slope guard: `slopeDeg < ASPECT_MIN_SLOPE_DEG` ⇒ no sector. Outer ring returns `null`. |
| `terrainOverlay.test.js` | `classifyTerrainPixel` with `aspectKeys`: matching sector keeps the colour, non-matching is transparent, `aspectKey = null` is transparent, filter off (old args) unchanged — existing tests untouched. |
| `terrainOverlay.tile.test.js` | New integration test mirroring the current altitude-band one: DEM mock becomes a **sloped plane** (flat 100 m → 100 + row index, i.e. north-facing); state `{ aspect: ['N'] }` keeps forest painted and `{ aspect: ['S'] }` turns it transparent; water unaffected; `loadDemMock` called even with no `alt`. |
| `filterStations.test.js` | Unchanged (stations not gated). |

---

## 9. File-by-file change list

| File | Change |
|---|---|
| `src/logic/elevation.js` | **ADD** pure `terrainGradient`, `slopeAspectAt`, `aspectSectorOf`, `ASPECT_SECTORS`, `ASPECT_MIN_SLOPE_DEG` (§4.1) |
| `src/logic/terrainOverlay.js` | **EDIT** — state default/signature gains `aspect`; `needElev` includes aspect; pixel loop computes sector key; `classifyTerrainPixel` trailing `aspectKey`/`aspectKeys` gate; neighbour-DEM fetch for the ring (§4.2–4.3) |
| `src/comps/FilterPanel.jsx` | **EDIT** — Orientació row button (faCompass), 8-chip editor, applied row, new `aspectSectors`/`onApplyAspect` props (§5) |
| `src/App.jsx` | **EDIT** — `aspectSectors` state + handler, `terrainState.aspect` (D4), prop pass-through (§6) |
| `src/logic/elevation.test.js` | **EDIT** — aspect/slope/sector unit tests (§8) |
| `src/logic/terrainOverlay.test.js` / `terrainOverlay.tile.test.js` | **EDIT** — gate + integration tests with a sloped DEM mock (§8) |

No new dependencies. No `filterStations.js` / map-stack changes (the
`terrain://` single layer already carries the gate).

---

## 10. Implementation checklist (suggested order)

1. `elevation.js` pure helpers + unit tests (§4.1).
2. `terrainOverlay.js` state/signature/`needElev` + classify gate (§4.2).
3. Tile integration test with a sloped DEM mock (§8).
4. Border policy A (neighbour tiles) — optional first pass with the flat DEM
   mock already in place (§4.3).
5. `App.jsx` state plumbing + `FilterPanel.jsx` Orientació UI (§5–6).
6. `npm test` (all suites), `npm run build`, `npm run lint`, then manual map
   check: filter N over a known obaga (e.g. northern Berguedà), zoom 7→14.

Rough effort: ~2.5–3.5 focused days including tests (helpers 0.5 · overlay
gate + borders 0.5–1 · UI 0.5–1 · plumbing + integration 0.5 · manual QA 0.5).

---

## 11. Decisions recorded / open questions**Proposed (confirm before coding):** D1 8 sectors keep-selected · D2 flat
  excluded, min slope 5° · D3 overlay only (no station dots) in v1 · D4 all-8
  = off · D5 neighbour-DEM border fetch · D6 no zoom special case.
  **✅ All six adopted and implemented (2026-09-12).**

**Open / future:**
- Gate station dots by aspect in v2 — mechanism exists (Substrat gates by
  point sampling; `StationPanel` already samples DEM elevation at the point),
  but it needs per-station DEM sampling at filter time or a `meteokat`
  precompute (stations-aspect JSON) since the DEM isn't a loaded grid.
- Presets ("Obaga" = N+NE+NW, "Solana" = S+SE+SW) as one-click chips.
- Wiring aspect into the mushroom species engine (e.g. humidity-retention
  bonus for N-facing forest) belongs to `MUSHROOM_APP_PLAN.md` Phase 1+, not
  this filter.
- Permissive flat rule (flats pass) if the filter is ever reused as a
  highlight instead of an exclusion — one-line flip of the D2 guard.

---

## 12. Implementation notes (2026-09-12)

Shipped as specced. Where the code differs from or extends the plan:

- **Pure helpers landed in `elevation.js`** with slightly different names than
  §4.1, because the border policy needs the maths without a single tile buffer:
  `hornGradientFromElevations(cells, cellSizeM)`, `slopeAspectFromElevations`,
  `aspectSectorFromElevations(cells, cellSizeM, minSlopeDeg)` and the constant
  `metresPerPixel(z, lat)`. The byte-offset conveniences §4.1 named are also
  there for a single 256 px tile: `neighboursAt(data, i)`, `terrainGradient(data, i)`,
  `slopeAspectAt(data, i, cellSizeM)` — they return `null` on the outer ring.
- **Sign convention** as pinned: `dzdy` is the *southward* gradient and the
  bearing is `atan2(−dzdx, dzdy)`, so a plane rising toward the south is
  north-facing (0°). `N = [337.5, 22.5)`.
- **Slope is physical.** `cellSizeM = metresPerPixel(z, tile-centre latitude)` is
  passed to the classifier, so the ≥5° flat guard is a real angle (a 2 m/px rise
  is 12° at z13 in Catalonia but 0.7° at z8).
- **Border policy A** is implemented by padding the DEM into a ±1-pixel grid
  (`ASPECT_PAD = 258`) built from the 8 adjacent tiles, then reading each pixel's
  3×3 straight out of a flat `Float32Array` — the pixel loop has no per-pixel
  awaits or Map lookups. A missing neighbour → `NaN` → no sector → unpainted.
- **Deliberately out of scope** (as the plan said): station dots are not gated,
  and the orientation selection is **not** snapshot into saved filter presets
  (`savedFilters.js`) — saving a preset while Orientació is active drops it.
- **Tests:** pure sign/edge/threshold cases in `elevation.test.js`; the
  `classifyTerrainPixel` gate in `terrainOverlay.test.js`; a sloped-DEM tile
  integration (including flat-land exclusion and the `none`-mode highlight) in
  `terrainOverlay.tile.test.js`.
