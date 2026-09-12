# meteoscat — client

This is a **Lightweight Weather Visualization Application** that displays
meteorological station averages on a map.

It is the front-end half of meteoscat. The scrapers, the daily aggregation and
the daily shards live in the separate **server** repo
([`mrHumildad/cepdata`](https://github.com/mrHumildad/cepdata)),
which commits every morning — keeping data churn out of this repo's history.

## 💻 Tech Stack

| Category | Technology | Description |
| :--- | :--- | :--- |
| **Frontend Framework** | **React** | For building the user interface. |
| **Map Library** | **MapLibre GL JS** | For rendering the interactive map and visualizing geospatial data. |
| **Build Tool** | **Vite** | Used for the modern development setup and application bundling. |
| **Programming Languages** | **JavaScript, CSS** | The app itself; the Python data pipeline is in the server repo. |
| **Data Format** | **GeoJSON, JSON** | Static app data (`public/logic/`) plus daily observations fetched at runtime. |

## Where the data comes from

| Data | Where it lives | How the app gets it |
| :--- | :--- | :--- |
| Daily per-station summaries | **server repo** → `data/daily/*.json`, published to GitHub Pages | Fetched at runtime from `VITE_DATA_BASE_URL` (`src/logic/refineData.js`) |
| `stations.geojson`, `litho_grid.json`, `forest_types.json` | This repo, `public/logic/` | Same-origin fetch, bundled with the deploy |

`VITE_DATA_BASE_URL` is set in [`.env`](./.env). The server repo publishes its
`data/` directory as a Pages site, so shards resolve as
`<VITE_DATA_BASE_URL>/daily/index.json` and `.../daily/YYYY-MM-DD.json`. Pages
serves them with `Access-Control-Allow-Origin: *`, so the cross-origin fetch
needs no proxy.

To work **offline**, leave `VITE_DATA_BASE_URL` empty (it then falls back to a
same-origin `logic/` directory) and copy the shards in:

```bash
cp -r ../cepdata/data/daily public/logic/daily
```

`public/logic/daily/` is gitignored — that copy is a local cache, never a
commit.

## Basemap

The map style comes from `VITE_MAP_STYLE_URL` (`.env`, default
`https://tiles.openfreemap.org/styles/dark`). OpenFreeMap requires no API key
and serves its style, tiles and glyphs with `Access-Control-Allow-Origin: *`.

Two gotchas, both learned the hard way:

1. **Do not switch back to Stadia's `alidade_smooth_dark`.** Its tiles return
   `401` without an API key, so the map renders blank on GitHub Pages while
   still working on localhost (Stadia exempts it).
2. **Symbol layers must name a font the style's glyphs endpoint serves.**
   OpenFreeMap hosts `Noto Sans` only, while MapLibre's default stack is
   `Open Sans Regular, Arial Unicode MS Regular`; leaving `text-font` unset
   makes those labels 404 and vanish silently.

## Rendering modes

The bottom-left aspect button cycles the area rendering mode:

| Mode | Shows |
| :--- | :--- |
| `terrain` | MCSC land-cover class colours |
| `substrate` | Geological-family colours |
| `relief` | No palette: the DEM's **isohypses** (elevation contour lines) over the relief, plus a green highlight on the land that passes every active filter |

Isohypses are painted client-side from the same terrarium DEM as the hillshade
(`src/logic/isohypsesOverlay.js` + `buildIsohypseTile` in `tilePaint.js`,
marching squares over a ±1-pixel padded DEM so lines stay continuous across
tile seams). Contours step every 50 m, every 5th line is a thicker **master**
contour carrying its elevation as a label, and nothing is drawn at or below
sea level.

They only appear at **close zoom** (`CONTOUR_MIN_ZOOM = 11`): the layer's
style `minzoom` hides it in the general view, and a hidden MapLibre layer
marks its source unused, so the contour tiles are not even requested there.
The layer is also only visible in `relief` mode.

## Icon attributions

UI icons come from [Noun Project](https://thenounproject.com) under CC BY 3.0 —
the per-icon creator credits (mandatory attribution) live in
[`ATTRIBUTIONS.md`](./ATTRIBUTIONS.md). The replacement of the previous Font
Awesome icons is tracked in [`ICON_MIGRATION_PLAN.md`](../ICON_MIGRATION_PLAN.md).

## Development

```bash
npm install
npm run dev      # Vite dev server
npm test         # vitest
npm run lint     # eslint
npm run build    # production bundle → dist/
```

Deployment is automatic: pushing to `main` builds and publishes to GitHub
Pages via `.github/workflows/deploy-pages.yml`. Data refreshes in the server
repo do **not** trigger this — if you need to point the app somewhere else,
edit `VITE_DATA_BASE_URL` in `.env` and push.

> **Don't** set `VITE_DATA_BASE_URL` via the workflow's `env:`. An undefined
> repo variable expands to an empty string, which overrides `.env` and makes
> the build fall back to same-origin `/logic/daily/` — a path this repo no
> longer has, so the deployed app 404s on every data request.
