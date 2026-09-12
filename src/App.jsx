import Map, { ScaleControl } from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 is ESM-only and loads its internal worker from a real URL: under
// a bundler, import.meta.url does not resolve to the worker file, so the map
// must be told where it lives. Vite's `?worker&url` emits a self-contained
// worker chunk (plain `?url` would miss the sibling shared module and the
// worker would fail on its first import). One-time call, before any Map.
import { Marker, setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(maplibreWorkerUrl);
import logo from './assets/totallogo.png';
import basketImg from './assets/basket.png';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  RainIcon, HumidityIcon, TemperatureIcon, ForestIcon, AnticlineIcon, FilterIcon, AltitudeIcon,
  Icon3D, TreasureMapIcon, BasketIcon, HiddenIcon, PickingMushroomsIcon, LegendIcon, JeepIcon, MushroomIcon, MountainIcon
} from './logic/nounIcons.jsx';
import { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { loadAvailableDays, loadSummaries } from './logic/refineData.js'
import { getDaysInRange, fmtShortCat, parseDay } from './logic/utils.js';
import './App.css'

import { computeGeoValues } from './logic/computeGeoValues.js';
import { buildFilterConfig, readSavedFilters, removeSavedFilter, sameFilterConfig, saveFilterPreset } from './logic/savedFilters.js';
import { readSavedLocations, removeSavedLocation, saveLocation } from './logic/savedLocations.js';
import { hasFilterConditions } from './logic/areaFilterMatch.js';
import { appliedFilterItems } from './logic/appliedFilters.js';
import { aggregateWindow, buildAggregateTable, DEFAULTDAYRANGE, limitsForWindow, windowToDates, TYPE_TO_VARIABLE } from './logic/filterAggregate.js';
import { scoreStations, scoreByCode } from './logic/boletEngine.js';
import { MCSC_LEGEND, MCSC_WATER_COLOR, MCSC_WATER_ENTRY } from './logic/mcscLegend.js';
import { ELEVATION_TILES, ELEVATION_ATTRIBUTION, sampleElevation } from './logic/elevation.js';
import { MCSC_ATTRIBUTION } from './logic/mcscRaw.js';
import { registerTerrainProtocol, terrainTileUrl } from './logic/terrainOverlay.js';
import { registerIsohypseProtocol, isohypsesTileUrl, CONTOUR_MIN_ZOOM } from './logic/isohypsesOverlay.js';
import { registerSeaProtocol } from './logic/seaOverlay.js';
import { CATALONIA_BOUNDS, TERRAIN_OVERLAY_BOUNDS, fitZoomForViewport } from './logic/mapFit.js';
import { pushTerrainContext } from './logic/tilePipeline.js';
import { distanceKm, nearestStations } from './logic/nearestStations.js';
import { LITHO_ATTRIBUTION, lithoLegendEntries, loadLithoGrid } from './logic/lithology.js';
import { detectWebGL2, isGPUInitializationError } from './logic/webgl2.js';
import FilterPanel from './comps/FilterPanel.jsx';
import DirectionsModal, { ROUTE_RADIUS_DEFAULT } from './comps/DirectionsModal.jsx';
import MapUnavailable from './comps/MapUnavailable.jsx';
import SavedFiltersPanel from './comps/SavedFiltersPanel.jsx';
import SavedLocationsPanel from './comps/SavedLocationsPanel.jsx';
import HeaderStatus from './comps/HeaderStatus.jsx';
import StationPanel from './comps/StationPanel.jsx';

// Catalonia — the app never leaves it. CATALONIA_BOUNDS constrains the
// camera; the minimum zoom is fitted per screen (mapFit.js) so that zooming
// fully out shows the whole region and nothing more (no more "half the
// planet" views). minZoom below is only the fallback floor.
const center = [1.9, 41.9];
const minZoom = 7; // fallback floor (used only while the viewport is unknown)
const maxZoom = 15;
// Absolute floor for the fitted minimum zoom: even a tiny viewport must not
// zoom out far enough to "browse the planet" again.
const FIT_ZOOM_FLOOR = 5.5;
// Per-screen minimum zoom: the highest zoom that still fits Catalonia in the
// current viewport with margin (see mapFit.js). Pure, shared by the map load
// and the resize handler.
const fittedMinZoom = (w, h) => {
  const fit = fitZoomForViewport({ width: w, height: h, minZoom: FIT_ZOOM_FLOOR, maxZoom });
  return fit != null ? fit : minZoom;
};

// Default display window: StationPanel chart + totals are computed over the
// last DEFAULTDAYRANGE days from the reference day (filters are independent
// — each has its own window). Station circle labels start on the SAME range
// and follow each variable's active filter when one is applied (see
// stationDayRange below) — one reference constant everywhere.

// Unit appended to each station-circle value (metres for the static
// altitude, the filter panel's units for the meteo means/totals) so the
// number on the map is never ambiguous.
const LABEL_UNIT = {
  altitud: 'm',
  precAccVal: 'mm',
  tempAvgVal: '°C',
  humAvgVal: '%'
};

// MapLibre expression for the value shown inside each station circle.
// Data-driven: reads the feature property `variable` and renders it as text
// with its unit ('123m', '4.2mm', '15.3°C', '78%').
const valueField = variable => [
  'case',
  ['==', ['get', variable], null],
  '',
  ['concat', ['to-string', ['get', variable]], LABEL_UNIT[variable] ?? '']
];

// Station-info cycle (Phase A): none (hidden) → altitude (static) → rain Σ →
// temp mean → humidity mean, then none. Each meteo value is aggregated over
// its variable's stationDayRange: default last DEFAULTDAYRANGE days, or the
// last ACTIVE filter's day range when one is applied.
const LABEL_MODES = ['none', 'altitud', 'precAcc', 'tempAvg', 'humAvg'];
const LABEL_ICONS = {
  none: HiddenIcon,
  altitud: AltitudeIcon,
  precAcc: RainIcon,
  tempAvg: TemperatureIcon,
  humAvg: HumidityIcon
};
const LABEL_CLASSES = {
  none: 'stationinfo',
  altitud: 'altitude',
  precAcc: 'rain',
  tempAvg: 'temp',
  humAvg: 'humidity'
};

// Noun Project credits — ALL bundled icons, the ones rendered in the UI and
// the ones kept for upcoming features (CC BY 3.0 requires attribution as soon
// as the files ship; full list in ATTRIBUTIONS.md at the repo root). Rendered
// as one compact HTML line inside MapLibre's attribution control
// (.maplibregl-ctrl-attrib-inner) — the same bar that credits the basemap,
// tiles and DEM, so no extra screen is needed.
const NOUN_CREDITS = [
  [8462912, 'Rain', 'Fina Uswania'],
  [1512650, 'Humidity', 'icon 54'],
  [8071262, 'Temperature', 'Liberus PJ'],
  [7835204, 'Mushroom', 'Neneng Yuliani Lestari'],
  [8180155, 'Forest', 'Ar2ar'],
  [1732297, 'Mountain', 'revo250'],
  [5399274, 'Anticline', 'M. Oki Orlando'],
  [7041032, '3D', 'Geni Alando'],
  [8434542, 'Treasure map', 'Rizsign'],
  [2204138, 'Round bottom basket', 'icon 54'],
  [5837641, 'Altitude', 'Gregor Cresnar'],
  [8351735, 'Jeep', 'Sanjaya'],
  [5741525, 'Hidden', 'iconbysonny'],
  [5741547, 'View', 'iconbysonny'],
  [6051842, 'North', 'Daniil Churakov'],
  [8192897, 'Binocular', 'Rizsign'],
  [715985, 'Search', 'Bernar Novalyi'],
  [5833149, 'Config', 'devilllorentina'],
  [8445610, 'Boots', 'Anggara Putra'],
  [78369, 'Picking mushrooms', 'Eric Milet'],
  [6490884, 'Thermometer', 'Supanut Piyakanont'],
  [7994795, 'Back', 'ICONIC'],
  [5181774, 'Manuscript', 'Lars Meiertoberens'],
  [8408218, 'Close', 'Styfico']
];
const nounCreditsHtml = () =>
  `Icons by ${NOUN_CREDITS.map(([id, name, by]) =>
    `<a href="https://thenounproject.com/icon/${id}/" title="“${name}” icon by ${by}" target="_blank" rel="noopener">${name}</a>`
  ).join(', ')} from <a href="https://thenounproject.com" target="_blank" rel="noopener">Noun Project</a>`;
const LABEL_PROP = {
  altitud: 'altitud',
  precAcc: 'precAccVal',
  tempAvg: 'tempAvgVal',
  humAvg: 'humAvgVal'
};
// labelMode → the meteo variable whose day range drives that label (and the
// StationPanel chart highlight); altitud is static so it has no window.
const LABEL_TYPE = {
  precAcc: 'rain',
  tempAvg: 'temp',
  humAvg: 'hum'
};
// Default station value window (shared initial state for the 3 variables):
// the reference day (last data day, offset 0) and DEFAULTDAYRANGE days back.
const defaultRange = () => ({ from: DEFAULTDAYRANGE, to: 0 });

// Cycle order of the bottom-left render-mode button, and the icon / button
// colour of each state: 'terrain' paints MCSC land-cover colours (green
// forest button), 'substrate' paints the geology families (brown substrat),
// 'relief' paints no palette — it shows the DEM's isohypses (contour lines,
// isohypsesOverlay.js) over the relief and tints the land pixels that pass
// every filter bright green (grey relief button) so the filter's coverage
// stays visible. The tint only renders while at least one filter condition is
// active (see hasActiveTerrainFilter); with no filter it is the plain relief
// view with contours. 'substrate' is skipped from the cycle only while the
// geology grid is still loading (substrate unavailable anyway).
const PAINT_MODES = ['terrain', 'substrate', 'relief'];
const PAINT_ICONS = {
  terrain: ForestIcon,
  substrate: AnticlineIcon,
  relief: HiddenIcon
};
const PAINT_CLASSES = {
  terrain: 'forest',
  substrate: 'substrat',
  relief: 'relief'
};

// Basemap toponym text sizes are plain pixels ('place_village' 10,
// 'place_city_large' 14, 'water_name' 12) or zoom interpolations
// ('place_country_major'). At their stock size the names read as map texture
// once an overlay palette sits underneath, so onMapLoad scales every text
// size by this factor — the plain number, and the value of each stop of an
// interpolation (the zoom ramp itself is kept, and country names stay small
// when zoomed out). Unknown shapes are returned untouched.
const TOPONYM_SCALE = 1.4;
const scaleTextSize = size => {
  const grow = v => Math.round(v * TOPONYM_SCALE);
  if (typeof size === 'number') return grow(size);
  if (Array.isArray(size) && size[0] === 'interpolate') {
    const out = size.slice(); // ['interpolate', type, ['zoom'], z0, v0, z1, v1, …]
    for (let i = 4; i < out.length; i += 2) out[i] = grow(out[i]);
    return out;
  }
  return size;
};

// Hex colour (no '#') for the open sea, matching the MCSC water class. When
// the Aigües legend entry is dimmed the sea is left TRANSPARENT (null → the
// sea overlay is off), so the bathymetric relief shows through exactly like
// dimmed land-cover classes — no grey "deselected" colour anywhere.
const seaColorHex = (offCodes) => {
  const aigues = MCSC_WATER_ENTRY;
  return aigues && offCodes.has(aigues.codes) ? null : MCSC_WATER_COLOR.slice(1);
};

// The MCSC raster is a palette map: each pixel holds an integer band value
// (the WMS exposes it as "class = '<classCode>. (<band>) <name>'", e.g.
// '342. (22) Eixample'). Bands follow MCSC class-code order, so every legend
// entry's band values are hard-coded in mcscLegend.js. The legend doubles as
// a switch panel. Terrain is painted CLIENT-SIDE by the stacked terrain
// overlay (terrainOverlay.js): every pixel carries its class colour only
// when EVERY active filter passes — a selected class AND the altitude band
// AND every meteo instance — and is transparent otherwise, so the relief
// shows through like abroad (see the terrainState memo below).
const App = ()  => {
  // Basemap style. OpenFreeMap is keyless and serves both its style JSON and
  // its tiles with `Access-Control-Allow-Origin: *`, so it works from GitHub
  // Pages. Do not go back to Stadia's alidade_smooth_dark: its tiles now
  // 401 without an API key, which leaves the map blank in production while
  // still working on localhost (Stadia exempts it) — see the style list in
  // logic/utils.js. Override with VITE_MAP_STYLE_URL (in .env) to switch
  // providers without a code change.
  const styleUrl =
    import.meta.env.VITE_MAP_STYLE_URL ||
    'https://tiles.openfreemap.org/styles/dark';
  const [selectedStation, setSelectedStation] = useState(null);
  const [days, setDays] = useState([]);           // available 'YYYY-MM-DD' days, oldest first
  const [data, setData] = useState(null);         // all daily shards (every available day)
  const [labelMode, setLabelMode] = useState('none'); // station-circle value: 'none' default (hidden) → altitud → rain Σ → temp mean → hum mean → none (each over its stationDayRange)
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const [showLegend, setShowLegend] = useState(false);           // legend panel of the ACTIVE rendering mode
  const [terrainMode, setTerrainMode] = useState('terrain');    // painted areas: 'terrain' (MCSC) | 'substrate' (geology) | 'relief' (isohypses + green filter highlight over the relief)
  const [showTerrain3D, setShowTerrain3D] = useState(true);     // 3D terrain (tilts the camera)
  const [mapReady, setMapReady] = useState(false); // true once the heavy area overlays exist (added on first idle — see onMapLoad)
  const [mapLoaded, setMapLoaded] = useState(false); // true once the map + stations source/layers exist (onMapLoad) — re-syncs the station source data
  const [mcscOff, setMcscOff] = useState(() => new Set()); // codes of dimmed legend entries
  const [geoOff, setGeoOff] = useState(() => new Set()); // keys of dimmed substrate families
  const [lithoGrid, setLithoGrid] = useState(null); // decoded substrate grid (lithology.js)
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // The map is WebGL2-only (MapLibre v6), so a browser without a usable GPU can
  // never render it. Detected up front so the blank canvas is replaced by the
  // explanatory MapUnavailable notice; `null` (no DOM — SSR / the render smoke
  // test) means "unknown" and is deliberately NOT treated as unsupported.
  const [mapUnavailable, setMapUnavailable] = useState(() => detectWebGL2() === false);
  const [mapErrorDetail, setMapErrorDetail] = useState(null); // raw GPU failure, shown collapsed
  const [clickedElevation, setClickedElevation] = useState(null); // DEM sample, m
  const [pickRoute, setPickRoute] = useState(false); // car button armed: next map click opens the directions modal
  const [routePoint, setRoutePoint] = useState(null); // picked directions point: { lat, lng, elevation, pending } | null
  const [routeRadius, setRouteRadius] = useState(ROUTE_RADIUS_DEFAULT); // area radius (m) analysed around the picked point — see directions modal
  const [showFilter, setShowFilter] = useState(false); // filter panel open state
  const [showBasket, setShowBasket] = useState(false); // saved-filter basket open state (only one top panel at a time)
  const [showLocations, setShowLocations] = useState(false); // saved-locations panel open state (same one-panel rule)
  const [savedFilters, setSavedFilters] = useState(() => readSavedFilters()); // named presets from localStorage, newest first
  const [savedLocations, setSavedLocations] = useState(() => readSavedLocations()); // saved places from localStorage, newest first
  const [reliefRange, setReliefRange] = useState(null); // applied altitude band [lo, hi]; null = off
  const [aspectSectors, setAspectSectors] = useState(null); // applied slope-aspect sectors (sorted keys) | null = off
  const [meteoFilters, setMeteoFilters] = useState([]); // [{ id, type, from, to, range }] — one per meteo filter instance
  const [nextFilterId, setNextFilterId] = useState(1);
  const [boletFilter, setBoletFilter] = useState(null); // { species, threshold } | null — mushroom rule filter (test)
  const [forestByCode, setForestByCode] = useState({});  // stationCodi → MCSC forestType from forest_types.json
  const mapRef = useRef(null);
  const dataReqRef = useRef(0);
  const selectedStationRef = useRef(null); // stale-guard for async takeElevation
  const pickRouteRef = useRef(false); // latest armed state read by the (once-registered) map handlers
  const routeReqRef = useRef(0); // stale-guard for the async route-point DEM sample
  const geoRequestedRef = useRef(false); // geolocation is asked at most once per session
  const [userLoc, setUserLoc] = useState(null); // { lat, lng } of "my location" | null when unknown
  const terrainStateRef = useRef(null); // stacked-overlay state read by the terrain:// tile protocol
  const geoWithDataRef = useRef(null); // latest features read by the terrain:// tile protocol
  const aggRef = useRef(null); // aggregate table read by the terrain:// tile protocol
  const lithoGridRef = useRef(null); // substrate grid read by the terrain:// tile protocol

  // Reference day = latest available data day; day ranges of every filter are
  // offsets back from it.
  const refDay = useMemo(() => (days.length ? parseDay(days[days.length - 1]) : null), [days]);
  const maxDays = days.length;

  // Prefix-sum aggregate table over ALL days — powers per-filter windows,
  // value-slider limits and the stacked-overlay grids.
  const agg = useMemo(() => buildAggregateTable(data ?? {}), [data]);

  // Display window (last DEFAULTDAYRANGE days from the reference day) — the
  // values shown in the StationPanel chart / totals (the chart stays on this
  // fixed window; the ACTIVE day range is highlighted inside it). Station
  // circle labels follow stationDayRange instead (see below) — area filters
  // never dim stations (Phase A).
  const displayWindow = useMemo(() => {
    if (!refDay || !data) return null;
    const from = new Date(refDay);
    from.setDate(from.getDate() - (DEFAULTDAYRANGE - 1));
    return { from, to: new Date(refDay) };
  }, [refDay, data]);

  // Station value day ranges — 3 states, one per meteo variable, initialised
  // to the default (last data day, DEFAULTDAYRANGE days back). The sync
  // effect below follows the filters: when a variable has an ACTIVE filter
  // (band narrower than its window's full span — inert "qualsevol valor"
  // instances don't filter) its state takes that filter's day range (the
  // LAST one added wins); when the filter is removed or widened back to full
  // span, the state reverts to the default.
  const [stationDayRange, setStationDayRange] = useState(() => ({
    rain: defaultRange(),
    temp: defaultRange(),
    hum: defaultRange(),
  }));
  // Day offsets can't reach back past the oldest available day — clamp the
  // reference range to maxDays − 1 at every use site (labels, values, chart).
  const effectiveRange = useCallback(r => ({
    from: r ? Math.min(r.from, Math.max(0, maxDays - 1)) : 0,
    to: r ? Math.min(r.to, Math.max(0, maxDays - 1)) : 0,
  }), [maxDays]);

  // Altitude slider limits: static station metadata (min–max altitud).
  const altLimits = useMemo(() => {
    if (!stationsGeo) return null;
    const alts = [];
    for (const f of stationsGeo.features ?? []) {
      const a = Number(f.properties?.altitud);
      if (Number.isFinite(a)) alts.push(a);
    }
    return alts.length ? [Math.min(...alts), Math.max(...alts)] : null;
  }, [stationsGeo]);

  // Substrate legend for the filter UI (family id > 0, from the grid file so
  // the UI can never drift from the data it filters). Empty until the grid
  // loads — the Substrat filter stays hidden meanwhile.
  const geoLegend = useMemo(() => lithoLegendEntries(lithoGrid), [lithoGrid]);

  // Bolet scores: every station × the selected species over the DISPLAY
  // window (the species engine takes the LAST windowDays of it). Recomputed
  // when the filter, data window or forest types change. Scores only affect
  // the optional green ramp on station circles — they never filter stations
  // (area filters never dim stations; see Phase A).
  const boletScores = useMemo(() => {
    if (!boletFilter || !data || !displayWindow) return null;
    const daysInRange = getDaysInRange(data, displayWindow.from, displayWindow.to);
    return scoreStations(data, daysInRange, boletFilter.species, forestByCode);
  }, [boletFilter, data, displayWindow, forestByCode]);

  // Stacked terrain overlay state — the rendering mode + the full set of
  // conditions every painted pixel must satisfy. The dims are
  // palette-agnostic: ONE shared AND stack gates every pixel (terrainOverlay
  // .js), and the sel button only picks which palette supplies the colour —
  // both `off` (dimmed MCSC classes) and `geoOff` (dimmed substrate
  // families) exclude a pixel in EVERY mode. The altitude band when narrowed
  // below the stations' altitud span and every ACTIVE meteo instance (band
  // narrower than its window's full span) with its concrete window dates
  // gate all modes too. Any change here regenerates the painted terrain
  // tiles.
  const terrainState = useMemo(() => {
    const off = [...mcscOff].sort();
    const altActive = !!reliefRange && !!altLimits &&
      (reliefRange[0] !== altLimits[0] || reliefRange[1] !== altLimits[1]);
    const filters = [];
    for (const f of meteoFilters) {
      const variable = TYPE_TO_VARIABLE[f.type];
      if (!variable) continue;
      const span = agg?.days.length ? limitsForWindow(agg, f.type, f.from, f.to) : null;
      const w = refDay ? windowToDates(refDay, f.from, f.to) : null;
      if (!w) continue;
      const active = span != null && (f.range[0] !== span[0] || f.range[1] !== span[1]);
      if (!active) continue;
      filters.push({ variable, from: w.from, to: w.to, band: [f.range[0], f.range[1]] });
    }
    filters.sort((a, b) =>
      (a.variable < b.variable ? -1 : a.variable > b.variable ? 1 : 0) ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.band[0] - b.band[0] ||
      a.band[1] - b.band[1]
    );
    // Both dims always travel in the overlay state — the shared AND stack
    // (the module never mixes palettes, but every palette honours every
    // dim). `off` also keeps the shared water handling working in both
    // modes. The orientation selection is inert when every sector is picked
    // (OR within the selection, AND with everything else), so all-8 collapses
    // to null (off) exactly like a full-span band.
    const aspect = aspectSectors && aspectSectors.length && aspectSectors.length < 8
      ? [...aspectSectors].sort()
      : null;
    return {
      mode: terrainMode,
      off,
      alt: altActive ? [reliefRange[0], reliefRange[1]] : null,
      aspect,
      filters,
      geoOff: [...geoOff].sort(),
    };
  }, [mcscOff, reliefRange, altLimits, meteoFilters, agg, refDay, geoOff, terrainMode, aspectSectors]);

  // Terrain tile URL — the state signature token changes whenever any filter
  // does, so setTiles() re-requests and the protocol repaints.
  const terrainTiles = useMemo(() => [terrainTileUrl(terrainState)], [terrainState]);

  // 0️⃣ Load the list of available days once
  useEffect(() => {
    let mounted = true;
    loadAvailableDays()
      .then(availableDays => {
        if (!mounted) return;
        if (!availableDays.length) throw new Error('No data available');
        setDays(availableDays);
      })
      .catch(err => {
        if (!mounted) return;
        console.error('Could not load day index:', err.message);
        setLoadError(err.message);
        setDataLoading(false);
      });
    return () => { mounted = false };
  }, []);

  // 0.5️⃣ Fetch the daily summaries for EVERY available day once — filters
  // may reference any window, and the aggregate table needs all of them.
  useEffect(() => {
    if (!days.length) return;
    const reqId = ++dataReqRef.current;
    setDataLoading(true);
    loadSummaries(days, days[0], days[days.length - 1])
      .then(summaries => {
        if (dataReqRef.current !== reqId) return; // stale response
        setData(summaries);
        setLoadError(null);
      })
      .catch(err => {
        if (dataReqRef.current !== reqId) return;
        console.error('Could not load station summaries:', err.message);
        setLoadError(err.message);
      })
      .finally(() => {
        if (dataReqRef.current === reqId) setDataLoading(false);
      });
  }, [days]);

  useEffect(() => {
    let mounted = true;
    const base = import.meta.env.BASE_URL || '/';
    const path = `${base}logic/stations.geojson`;
    console.log('fetching stations geojson from', path);
    fetch(path)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!ct.includes('application/json') && !ct.includes('geo+json') && !ct.includes('text/json')) {
          throw new Error(`Unexpected content-type: ${ct}`);
        }
        return r.json();
      })
      .then(geo => { if (mounted) setStationsGeo(geo); })
      .catch(err => { console.error('Could not load stations.geojson:', err.message); });
    return () => { mounted = false };
  }, []);

  // Substrate (geology) grid — loaded once alongside the stations; the
  // geology filter stays hidden/inert until it arrives.
  useEffect(() => {
    let mounted = true;
    const base = import.meta.env.BASE_URL || '/';
    loadLithoGrid(`${base}logic/litho_grid.json`)
      .then(grid => { if (mounted) setLithoGrid(grid); })
      .catch(err => { console.error('Could not load litho_grid.json:', err.message); });
    return () => { mounted = false };
  }, []);

  // MCSC forest type per station (forest_types.json) — powers the binary
  // forest-host gate of the bolet scoring (a species only scores on its host
  // tree; stations without a sampled forest type never match).
  useEffect(() => {
    let mounted = true;
    const base = import.meta.env.BASE_URL || '/';
    fetch(`${base}logic/forest_types.json`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(json => {
        if (!mounted) return;
        const map = {};
        for (const [code, e] of Object.entries(json ?? {})) {
          map[code] = e?.forestType ?? null;
        }
        setForestByCode(map);
      })
      .catch(err => { console.error('Could not load forest_types.json:', err.message); });
    return () => { mounted = false };
  }, []);

  const onMapLoad = async (evt) => {
    const map = evt?.target || evt?.map || evt;
    if (!map || typeof map.addSource !== 'function') return;
    mapRef.current = map;                       // <-- store map instance

    // constrain view — Catalonia only. The minimum zoom is fitted to the
    // ACTUAL screen: at max zoom-out the whole region must fit the viewport
    // (with a margin), so wide screens no longer stare at half the western
    // Mediterranean (and its tile loads) and narrow phones can finally see
    // all of Catalonia.
    const { clientWidth: vw, clientHeight: vh } = map.getCanvas();
    const floorZoom = fittedMinZoom(vw, vh);
    map.setMaxBounds(CATALONIA_BOUNDS);
    map.setMinZoom(floorZoom);
    map.setMaxZoom(maxZoom);
    map.jumpTo({ center, zoom: Math.min(floorZoom + 1, maxZoom) });

    // Icon credits (Noun Project, CC BY 3.0) into the map's attribution bar
    // (.maplibregl-ctrl-attrib-inner) — all bundled icons, used or reserved.
    if (typeof map.addAttribution === 'function') {
      map.addAttribution(nounCreditsHtml());
    }

    // ensure a 'stations' source exists immediately. Prefer the enriched
    // geoWithData (value props) when it already arrived — the enrichment
    // usually finishes BEFORE the map does (local fetches vs remote tiles),
    // and the station-source effect below re-syncs on mapLoaded anyway, so
    // the map can never be stuck on the value-less base features.
    const emptyGeo = { type: 'FeatureCollection', features: [] };
    const initialStations = geoWithDataRef.current || stationsGeo || emptyGeo;
    if (!map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: initialStations });
    } else if (initialStations) {
      map.getSource('stations').setData(initialStations);
    }

    // layers can now be safely added (source guaranteed)
    if (!map.getLayer('stations-circle')) {
      map.addLayer({
        id: 'stations-circle',
        type: 'circle',
        source: 'stations',
        paint: {
          // initial paint: will be updated by effect below
          'circle-radius': 6,
          'circle-color': '#888',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1
        }
      });
    }

    if (!map.getLayer('stations-label')) {
      map.addLayer({
        id: 'stations-label',
        type: 'symbol',
        source: 'stations',
        layout: {
          'text-field': ['coalesce', ['get', 'nom'], ['get', 'codi']],
          'text-size': 12,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
          // Must name a font the style's glyphs endpoint actually serves.
          // OpenFreeMap hosts Noto Sans only; left unset, MapLibre falls back
          // to its default 'Open Sans Regular, Arial Unicode MS Regular',
          // which 404s there and silently drops the labels.
          'text-font': ['Noto Sans Regular']
        },
        paint: { 'text-color': '#222' }
      });
    }

    // value label layer: station value inside circle (aggregated over the
    // variable's stationDayRange — default last DEFAULTDAYRANGE days, or the
    // active filter's range; hidden when labelMode is 'none'). Always
    // visible in area-filter mode — no dimming by filters.
    if (!map.getLayer('stations-value')) {
      const prop = LABEL_PROP[labelMode] ?? labelMode;
      map.addLayer({
        id: 'stations-value',
        type: 'symbol',
        source: 'stations',
        layout: {
          'text-field': valueField(prop),
          'text-size': 24,
          'text-font': ['Noto Sans Bold'], // see stations-label above
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-anchor': 'center'
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#000000',
          'text-halo-width': 1
        }
      }, 'stations-label');
    }

    // Area-overlay PROTOCOLS are registered here once (config-level, no tile
    // work yet); the sources + layers themselves are only added once the map
    // settles — see addAreaOverlays below, so the first paint is light.
    // Painting context (agg / features / lithoGrid) travels to the pipeline
    // separately — see the pushTerrainContext effect further down.
    setMapLoaded(true); // stations source/layers exist — station-source effect re-syncs now
    registerTerrainProtocol(map, () => terrainStateRef.current);
    registerIsohypseProtocol();
    registerSeaProtocol();

    map.on('click', 'stations-circle', (e) => {
      // Directions mode: a station click picks the point (opens Google Maps)
      // instead of opening the station panel — the map-level handler below
      // already fires for it, so just bail out here.
      if (pickRouteRef.current) return;
      if (!e.features || !e.features.length) return;
      const f = e.features[0];
      const coords = f.geometry.coordinates.slice();
      const code = f.properties?.codi ?? 'unknown';
      console.log('Clicked station', code, f.properties);

      setSelectedStation(code);   
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 12) });

      // Sample the DEM at the clicked point (not the nearest station's static
      // altitud); guard against a faster later click on another station.
      setClickedElevation(null);
      sampleElevation(coords[1], coords[0]).then(elev => {
        if (elev != null && selectedStationRef.current === code) {
          setClickedElevation(elev);
        }
      });
    });

    map.on('mouseenter', 'stations-circle', () => {
      map.getCanvas().style.cursor = pickRouteRef.current ? 'crosshair' : 'pointer';
    });
    map.on('mouseleave', 'stations-circle', () => {
      map.getCanvas().style.cursor = pickRouteRef.current ? 'crosshair' : '';
    });

    // Car (directions) mode: while armed, clicking anywhere on the map opens
    // the directions MODAL for that point (coordinates + DEM altitude). The
    // modal's "Com hi arribo" button is what opens the Google Maps route in a
    // new tab, so the user can review the picked point first.
    map.on('click', (e) => {
      if (!pickRouteRef.current) return;
      const { lat, lng } = e.lngLat ?? {};
      if (lat == null || lng == null) return;
      // Show the modal immediately; the DEM sample fills the altitude in later
      // (guarded so a newer pick can't be overwritten by an older response).
      const reqId = ++routeReqRef.current;
      setRoutePoint({ lat, lng, elevation: null, pending: true });
      // Every pick starts from the default disc — the radius is part of the
      // point being analysed, not a sticky setting of the previous spot.
      setRouteRadius(ROUTE_RADIUS_DEFAULT);
      sampleElevation(lng, lat).then(elev => {
        if (reqId !== routeReqRef.current) return;
        setRoutePoint(prev => (prev ? { ...prev, elevation: elev, pending: false } : prev));
      });
      // One pick per arming: disarm right after the modal opens (Esc also works).
      setPickRoute(false);
    });

    // Keep the fit-zoom floor in sync with the viewport (window resize,
    // rotation, split view): zooming fully out must keep fitting Catalonia.
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const { clientWidth, clientHeight } = map.getCanvas();
        map.setMinZoom(fittedMinZoom(clientWidth, clientHeight));
      }, 200);
    };
    map.on('resize', onResize);
    map.on('remove', () => { clearTimeout(resizeTimer); map.off('resize', onResize); });

    // Heavy area overlays — the raster sources that make the app heavy — are
    // added only after the map settles on its first paint (basemap + station
    // circles first, colours + relief a moment later). The safety timeout
    // covers the case where 'idle' never fires (e.g. the user keeps
    // interacting while the data loads). mapReady flips only here, so the
    // terrain/sea/3D effects run with their sources already present.
    const addAreaOverlays = () => {
      if (map.getSource('terrain')) return; // idempotent (timeout + idle both arm)
      // Remember the terrain URL template baked into the source (see the
      // &r repaint-token logic of the 2.7 effect below).
      if (lastTerrainUrlRef.current == null) lastTerrainUrlRef.current = terrainTiles[0];

      // Stacked terrain overlay (terrain:// protocol): the single land-cover
      // layer, below the stations and the hillshade (so the relief shading
      // stays on top). It paints the MCSC class colour client-side only
      // where EVERY active condition passes — selected class + altitude band
      // + all meteo instances — leaving failing pixels transparent. The
      // source carries a Catalonia bounds clip (TERRAIN_OVERLAY_BOUNDS):
      // tiles fully outside never reach the painting pipeline, so the map
      // doesn't fetch / paint empty terrain for the whole planet while
      // zoomed out. Inside Catalonia nothing changes — there is no data
      // outside it anyway.
      map.addSource('terrain', {
        type: 'raster',
        tiles: terrainTiles,
        tileSize: 256,
        bounds: TERRAIN_OVERLAY_BOUNDS,
        minzoom: 7,
        maxzoom: 14,
        attribution: `${MCSC_ATTRIBUTION} · ${LITHO_ATTRIBUTION}`
      });
      map.addLayer({
        id: 'terrain',
        type: 'raster',
        source: 'terrain',
        layout: { visibility: 'visible' }, // the terrain overlay is always on
        paint: { 'raster-opacity': 0.85 } // same look as the old MCSC layer
      }, 'stations-circle');

      // Continuous elevation: TWO raster-dem sources over the same terrarium
      // tiles, because one source cannot serve both consumers well. Attaching
      // 3D terrain sets `usedForTerrain` on that source's tile manager, which
      // re-tiles it onto the TERRAIN grid (tileSize ×2 = 512, roundZoom off)
      // and calls `tileManager.reload()`; a hillshade layer sharing the source
      // is then shaded from those coarser tiles, and every 3D toggle re-tiles
      // the DEM under it. Splitting keeps the hillshade on its own 256 /
      // exact-zoom grid and makes the 3D toggle touch only `terrain-dem`.
      // The cost is that both sources decode and hold their DEM tiles (two
      // grids, so not quite a duplicate pyramid) while 3D is on; the browser
      // HTTP cache absorbs most of the second download. Lowering
      // `terrain-dem`'s maxzoom would cut that further at the price of a
      // smoother mesh when zoomed in.
      //
      // Hillshade source, drawn below the stations. No bounds: it shades
      // whatever the camera can actually see (the fit-zoom floor already
      // limits how far out that can be), and clipping it would leave an ugly
      // relief edge at the bounds when panning/tilting.
      map.addSource('hillshade-dem', {
        type: 'raster-dem',
        tiles: [ELEVATION_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: ELEVATION_ATTRIBUTION
      });
      map.addLayer({
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshade-dem',
        layout: { visibility: 'visible' },
        paint: {
          'hillshade-exaggeration': 0.4,
          'hillshade-illumination-direction': 315
        }
      }, 'stations-circle');

      // Same terrarium tiles under a second id, referenced ONLY by setTerrain
      // (2.9 below). No layer draws from it, and an unused raster-dem source
      // that is not the terrain source requests no tiles (SourceCache.update:
      // `!used && !usedForTerrain` → empty ideal tile list), so it costs
      // nothing until the 3D toggle turns it on. The duplicated attribution
      // collapses: AttributionControl pushes each distinct string once.
      map.addSource('terrain-dem', {
        type: 'raster-dem',
        tiles: [ELEVATION_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: ELEVATION_ATTRIBUTION
      });

      // Sea overlay: paints the ocean (elevation <= 0, from the same DEM the
      // relief uses) with the water colour. It sits ABOVE the hillshade —
      // which would otherwise render the flat/bathy sea grey — and BELOW the
      // terrain layer, so the land-cover water class draws on top with the
      // same colour. Deliberately NOT bounds-clipped: the navy water must
      // stay seamless to the edge of the viewport, and its cost is bounded
      // by the fit-zoom floor.
      // Remember the exact URL templates put into each source, so the
      // repaint effects below only append an `&r=` token when the state
      // REALLY changed (not on the initial creation / mapReady catch-up).
      const seaInitialUrl = `sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff) ?? 'off'}`;
      map.addSource('sea', {
        type: 'raster',
        tiles: [seaInitialUrl],
        tileSize: 256,
        minzoom: 7,
        maxzoom: 15
      });
      if (lastSeaUrlRef.current == null) lastSeaUrlRef.current = seaInitialUrl;
      map.addLayer({
        id: 'sea',
        type: 'raster',
        source: 'sea',
        layout: { visibility: 'visible' },
        paint: { 'raster-opacity': 1 }
      }, 'terrain');

      // Isohypses (isohypsesOverlay.js): the DEM's elevation contours, only
      // shown in the palette-less 'relief' rendering mode (the visibility
      // effect below keeps this in sync) AND only at close zoom — the layer's
      // `minzoom` hides it in the general view, and a hidden layer makes
      // MapLibre skip loading the contour tiles entirely. It sits ABOVE the
      // hillshade so the light lines (and their elevation labels) read over
      // the relief, and below the stations. The tiles are stateless per
      // (z,x,y) — the contour interval follows the zoom — so nothing ever has
      // to regenerate them, only show / hide. The Catalonia bounds clip keeps
      // it from painting contours outside the region the app can reach.
      map.addSource('isohypses', {
        type: 'raster',
        tiles: [isohypsesTileUrl()],
        tileSize: 256,
        bounds: TERRAIN_OVERLAY_BOUNDS,
        minzoom: CONTOUR_MIN_ZOOM,
        maxzoom: 15,
        attribution: ELEVATION_ATTRIBUTION
      });
      map.addLayer({
        id: 'isohypses',
        type: 'raster',
        source: 'isohypses',
        minzoom: CONTOUR_MIN_ZOOM, // general view stays clean (see tilePaint.js)
        layout: { visibility: terrainStateRef.current?.mode === 'relief' ? 'visible' : 'none' },
        paint: { 'raster-opacity': 1 }
      }, 'stations-circle');

      // Toponyms (the basemap's place / street / water names) must stay
      // readable in EVERY render mode. Our overlays are inserted below the
      // stations, which puts them ABOVE the whole basemap — its symbol layers
      // included — so the terrain / substrate / relief rasters would bury the
      // village and town names. Hoist every text symbol to just under the
      // stations (relative order preserved) and harden its paint: the dark
      // style's mid-grey fill (rgb(101,101,101)) with a 1px softened halo all
      // but disappears over the bright terrain colours, so give it a solid
      // dark halo and a light fill. The base sizes (10px) also read as map
      // texture rather than names, so every text size is scaled up
      // (TOPONYM_SCALE) — numbers as-is, zoom interpolations stop by stop, so
      // country names keep their zoom ramp. The town / city dot (the style's
      // built-in circle sprite) is dropped: the name alone marks the place, so
      // the label is detached from any marker (icon-image null = text-only
      // symbol, the sprite / glyph never requested). Icon-only symbols
      // (one-way arrows) stay where they are, and the stations-* layers are
      // untouched.
      const hostId = map.getLayer('stations-circle') ? 'stations-circle' : undefined;
      for (const l of map.getStyle()?.layers ?? []) {
        if (l.type !== 'symbol' || !l.layout?.['text-field'] || l.id.startsWith('stations')) continue;
        map.setPaintProperty(l.id, 'text-halo-color', 'rgba(0,0,0,0.95)');
        map.setPaintProperty(l.id, 'text-halo-width', 1.8);
        map.setPaintProperty(l.id, 'text-halo-blur', 0);
        map.setPaintProperty(l.id, 'text-color', '#f2f2f2');
        map.setLayoutProperty(l.id, 'text-size', scaleTextSize(l.layout['text-size']));
        if (l.layout['icon-image']) map.setLayoutProperty(l.id, 'icon-image', null);
        map.moveLayer(l.id, hostId);
      }

      // Layers are all in place — let the terrain/sea/3D effects run now
      // (they key off mapReady and need these sources to exist).
      setMapReady(true);
    };
    map.once('idle', addAreaOverlays);
    const overlayTimer = setTimeout(addAreaOverlays, 3000);
    map.on('remove', () => clearTimeout(overlayTimer));
  };

  // The WebGL2 probe above keeps the map from being mounted when we already
  // know the context cannot be created; this catches what it cannot predict —
  // a context creation that is still refused, or one lost after a GPU-process
  // crash — and swaps the dead canvas for the explaining notice instead.
  // react-maplibre routes BOTH the constructor failure (its own .catch, so the
  // app never crashes) and later map 'error' events here, which is why the
  // error must be classified: a failed tile fetch is not a dead GPU.
  const onMapError = (e) => {
    const err = e?.error ?? e;
    if (!isGPUInitializationError(err)) return;
    setMapErrorDetail(err?.statusMessage || err?.message || null);
    setMapUnavailable(true);
  };

  // 1️⃣ Compute geoWithData over the DISPLAY window (StationPanel chart +
  // totals; filters evaluate their own windows via the aggregate table).
  // Phase A also attaches rain/temp/hum over EACH variable's stationDayRange
  // (default last DEFAULTDAYRANGE days, or the active filter's range when one
  // is applied; altitud is static) so the circle label stays readable
  // outside filtered areas and outside the display window. Re-runs when a
  // range changes — O(3 × stations) aggregate lookups, no terrain repaint.
  // No station is ever filtered.
  useEffect(() => {
    if (!stationsGeo || !data || !displayWindow) return;
    const daysInRange = getDaysInRange(data, displayWindow.from, displayWindow.to);
    const base = computeGeoValues(stationsGeo, data, daysInRange);
    if (!base || !agg || !agg.days.length) {
      setGeoWithData(base);
      return;
    }
    const eff = {
      rain: effectiveRange(stationDayRange.rain),
      temp: effectiveRange(stationDayRange.temp),
      hum: effectiveRange(stationDayRange.hum),
    };
    const enriched = {
      ...base,
      features: base.features.map(f => {
        const code = f.properties?.codi;
        const precAccVal = code ? aggregateWindow(agg, code, 'rain', eff.rain.from, eff.rain.to) : null;
        const tempAvgVal = code ? aggregateWindow(agg, code, 'temp', eff.temp.from, eff.temp.to) : null;
        const humAvgVal = code ? aggregateWindow(agg, code, 'hum', eff.hum.from, eff.hum.to) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            precAccVal: precAccVal == null ? null : Math.round(precAccVal * 10) / 10,
            tempAvgVal: tempAvgVal == null ? null : Math.round(tempAvgVal * 10) / 10,
            humAvgVal: humAvgVal == null ? null : Math.round(humAvgVal),
          },
        };
      }),
    };
    setGeoWithData(enriched);
  }, [stationsGeo, data, displayWindow, agg, stationDayRange, effectiveRange]);

  // 2.5️⃣ Keep station markers + their labels in sync with the station-info
  // toggle. Stations are NEVER dimmed — the button cycles none (hidden) →
  // altitud (static m) → rain Σ → temp mean → humidity mean → none (each
  // meteo value over its variable's stationDayRange). 'none' hides circles +
  // name labels + value layer so no floating names remain. Values come from
  // the precAccVal/tempAvgVal/humAvgVal properties (effect 1️⃣; altitud is
  // static metadata).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prop = LABEL_PROP[labelMode] ?? null;
    if (labelMode === 'none' || !prop) {
      if (map.getLayer('stations-circle')) map.setLayoutProperty('stations-circle', 'visibility', 'none');
      if (map.getLayer('stations-label')) map.setLayoutProperty('stations-label', 'visibility', 'none');
      if (map.getLayer('stations-value')) map.setLayoutProperty('stations-value', 'visibility', 'none');
    } else {
      if (map.getLayer('stations-circle')) map.setLayoutProperty('stations-circle', 'visibility', 'visible');
      if (map.getLayer('stations-label')) map.setLayoutProperty('stations-label', 'visibility', 'visible');
      if (map.getLayer('stations-value')) {
        map.setLayoutProperty('stations-value', 'visibility', 'visible');
        map.setLayoutProperty('stations-value', 'text-field', valueField(prop));
      }
    }
    // mapLoaded: re-apply once the map exists, in case the toggle was
    // clicked before the map finished loading (the layer wasn't there yet).
  }, [labelMode, mapLoaded]);

  // 2.7️⃣ Rebuild the stacked-terrain tiles when any filter changes — a
  // legend switch, the altitude band, the rendering mode, or a meteo
  // instance's window/band. Repaints are THROTTLED (see below).
  //
  // IMPORTANT — why every repaint gets a fresh `&r=<n>` token: after a few
  // mode / filter switches, MapLibre's raster tile cache can serve tiles
  // painted for an older state for a URL it has seen before, and the painted
  // layer then "stops working" (map stuck showing only relief). Appending a
  // monotonically increasing token whenever the state REALLY changed forces
  // MapLibre to discard the cached raster set and re-request the current
  // state — the URL can never repeat with different content.
  const TERRAIN_REPAINT_MS = 150;
  const lastTerrainPaintRef = useRef(0);
  const terrainPaintTimerRef = useRef(null);
  const terrainSerialRef = useRef(0);
  const lastTerrainUrlRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    terrainStateRef.current = terrainState;
    if (!map || !mapReady) return;
    const src = map.getSource('terrain');
    if (!src || typeof src.setTiles !== 'function') return;
    const paint = () => {
      lastTerrainPaintRef.current = Date.now();
      const plain = terrainTiles[0];
      let url = plain;
      if (url !== lastTerrainUrlRef.current) {
        url = `${plain}&r=${terrainSerialRef.current++}`;
        lastTerrainUrlRef.current = url;
      }
      src.setTiles([url]);
    };
    const elapsed = Date.now() - lastTerrainPaintRef.current;
    clearTimeout(terrainPaintTimerRef.current);
    if (elapsed >= TERRAIN_REPAINT_MS) {
      paint();
    } else {
      terrainPaintTimerRef.current = setTimeout(paint, TERRAIN_REPAINT_MS - elapsed);
    }
    return () => clearTimeout(terrainPaintTimerRef.current);
  }, [terrainState, terrainTiles, mapReady]);

  // 2.7.1️⃣ Keep the open sea in sync with the Aigües legend switch: blue by
  // default, fully transparent when the water class is dimmed (so the sea
  // shows the relief, exactly like a dimmed land-cover class — no grey). The
  // colour bakes into the tile URL, regenerating the overlay tiles (with the
  // same `&r=` repaint token as the terrain tiles). Depends on mapReady too:
  // the sea source is created lazily (first idle), and a dim made before
  // that must still reach the freshly-created source.
  const seaSerialRef = useRef(0);
  const lastSeaUrlRef = useRef(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getSource('sea')) return;
    const plain = `sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff) ?? 'off'}`;
    let url = plain;
    if (url !== lastSeaUrlRef.current) {
      url = `${plain}&r=${seaSerialRef.current++}`;
      lastSeaUrlRef.current = url;
    }
    map.getSource('sea').setTiles([url]);
  }, [mcscOff, mapReady]);

  // 2.7.2️⃣ Isohypses are only meaningful in the palette-less 'relief' mode
  // (they supply the ground shape there). In terrain / substrate they are
  // hidden; a hidden raster source loads no tiles, so they cost nothing until
  // the mode asks for them. Depends on mapReady because the layer is created
  // lazily on first idle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !map.getLayer('isohypses')) return;
    map.setLayoutProperty('isohypses', 'visibility', terrainMode === 'relief' ? 'visible' : 'none');
  }, [terrainMode, mapReady]);

  // keep the latest selected station in a ref so async DEM samples can check
  // they still match the station the user last clicked
  useEffect(() => { selectedStationRef.current = selectedStation; }, [selectedStation]);

  // keep the armed state in a ref so the once-registered map handlers see it
  useEffect(() => { pickRouteRef.current = pickRoute; }, [pickRoute]);

  // While the directions (car) button is armed the pointer becomes a
  // crosshair over the map so the next click is understood as "pick here";
  // Escape cancels the arming — or closes the directions modal once open.
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = pickRoute ? 'crosshair' : '';
    if (!pickRoute && !routePoint) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (routePoint) setRoutePoint(null);
      else setPickRoute(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickRoute, routePoint]);

  // "My location": asked once per session on mount, so the always-visible map
  // marker appears as soon as it is known and the directions button can show
  // the distance / seed the Google Maps `origin`. A refusal or an unavailable
  // browser simply leaves it null (no marker, destination-only route).
  useEffect(() => {
    if (geoRequestedRef.current) return;
    geoRequestedRef.current = true;
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      pos => setUserLoc({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}, // denied / timeout → keep null, no error UI
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, []);

  // "My location" marker on the map (basket.png), always visible once the
  // browser location is known. A plain MapLibre Marker avoids adding a GeoJSON
  // source/layer for a single point; unmounting removes it with the map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !userLoc) return;
    const el = document.createElement('img');
    el.src = basketImg;
    el.alt = 'La meva ubicaci\u00f3';
    el.className = 'user-location-marker';
    const marker = new Marker({ element: el, anchor: 'center' })
      .setLngLat([userLoc.lng, userLoc.lat])
      .addTo(map);
    return () => marker.remove();
  }, [userLoc, mapLoaded]);

  // Straight-line distance from "my location" to the picked point (km), or
  // null while the location is unknown.
  const routeDistanceKm = useMemo(() => {
    if (!routePoint || !userLoc) return null;
    return distanceKm(userLoc.lng, userLoc.lat, routePoint.lng, routePoint.lat);
  }, [routePoint, userLoc]);

  // The modal's Google Maps action: same "how to get there" route the car
  // button used to open directly, now reached from the reviewed point. When
  // "my location" is known it seeds `origin`, so the route starts there.
  const openRouteDirections = useCallback(() => {
    if (!routePoint) return;
    const dest = `${routePoint.lat.toFixed(5)},${routePoint.lng.toFixed(5)}`;
    const origin = userLoc
      ? `&origin=${userLoc.lat.toFixed(5)},${userLoc.lng.toFixed(5)}`
      : '';
    window.open(`https://www.google.com/maps/dir/?api=1${origin}&destination=${dest}`, '_blank');
  }, [routePoint, userLoc]);

  // Closest stations (with distance + compass direction + poble/comarca) to the
  // picked directions point — read from the station features already loaded for
  // the map, so no extra fetch. Recomputed only when the point or features change.
  const routeNearest = useMemo(() => {
    if (!routePoint) return [];
    const features = (geoWithData ?? stationsGeo)?.features;
    return nearestStations(features, routePoint.lng, routePoint.lat, 3);
  }, [routePoint, geoWithData, stationsGeo]);

  // keep the display features + aggregate table + substrate grid in refs so
  // the terrain:// tile protocol can (re)build grids for the right data, AND
  // push them to the painting worker (tilePipeline) so its per-tile builders
  // always see the current data. Refs + worker copy update together, in one
  // effect, whenever any of the three changes.
  useEffect(() => {
    geoWithDataRef.current = geoWithData;
    aggRef.current = agg;
    lithoGridRef.current = lithoGrid;
    pushTerrainContext({ agg, features: geoWithData?.features ?? [], lithoGrid });
  }, [geoWithData, agg, lithoGrid]);

  // 2.9️⃣ Toggle 3D terrain (its own raster-dem source + tilted camera).
  // `terrain-dem` exists only for this: the terrain cannot share the
  // hillshade's DEM source without dragging the hillshade onto the terrain
  // tile grid (see addAreaOverlays).
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (showTerrain3D && map.getSource('terrain-dem')) {
      map.setTerrain({ source: 'terrain-dem', exaggeration: 1.3 });
      map.easeTo({ pitch: 55, bearing: -20, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  }, [showTerrain3D, mapReady]);

  // 2️⃣ Update map once geoWithData is ready — Phase A: stations NEVER dimmed.
  // Area filters paint pixels (terrainState); stations stay fully visible so
  // values outside coloured areas remain readable. The bolet species filter
  // only tints the circle colour via the green ramp (optional signal), never
  // filters or dims stations. Circle radius/opacity are uniform.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const dataToSet = geoWithData || stationsGeo;
      if (!dataToSet) return;
      const scoreMap = boletScores ? scoreByCode(boletScores) : null;
      const features = (dataToSet.features ?? []).map(f => ({
        ...f,
        properties: {
          ...f.properties,
          // bolet score for the optional green ramp (null when species filter off)
          boletScore: scoreMap?.[f.properties?.codi] ?? null,
        },
      }));
      const featureCollection = { ...dataToSet, features };
      if (map.getSource('stations')) {
        map.getSource('stations').setData(featureCollection);
      } else {
        map.addSource('stations', { type: 'geojson', data: featureCollection });
      }
      if (map.getLayer('stations-circle')) {
        // Fixed grey when no bolet filter; green score ramp (grey=no data) when active.
        map.setPaintProperty('stations-circle', 'circle-color',
          boletScores
            ? ['interpolate', ['linear'], ['coalesce', ['get', 'boletScore'], -1],
              -1, '#9e9e9e',
              0, '#dcedc8',
              0.5, '#8bc34a',
              0.75, '#4caf50',
              1, '#1b5e20']
            : '#888');
        map.setPaintProperty('stations-circle', 'circle-opacity', 1);
        map.setPaintProperty('stations-circle', 'circle-stroke-opacity', 1);
        map.setPaintProperty('stations-circle', 'circle-radius', 6);
      }
      if (map.getLayer('stations-label')) {
        map.setPaintProperty('stations-label', 'text-color', '#222');
        map.setPaintProperty('stations-label', 'text-opacity', 1);
      }
      // value layer text-field is owned by the 2.5 effect (labelMode toggle)
    } catch (e) {
      console.warn('Error updating stations source after load', e);
    }
    // mapLoaded re-runs this effect once the map exists, so the source gets
    // the enriched (value-carrying) features even when geoWithData finished
    // before the map finished loading.
  }, [stationsGeo, geoWithData, boletScores, mapLoaded]);

  // ── Repaint input gate ────────────────────────────────────────────────
  // Applying a filter / dimming a legend entry asks the painting pipeline to
  // regenerate every visible tile. Rapid-fire applies (double taps, bursts of
  // ✓ / add / remove) queue dozens of repaints and on old devices the map
  // ends up appearing to "stop working". While a repaint is in flight
  // (repaintBusy) the FilterPanel controls are disabled, so only ONE change
  // is accepted at a time; it clears when the map finishes loading the
  // regenerated tiles ('idle') or after a safety timeout.
  const [repaintBusy, setRepaintBusy] = useState(false);
  const repaintBusyRef = useRef(false);
  const repaintTimerRef = useRef(null);
  const endRepaint = () => {
    if (!repaintBusyRef.current) return;
    repaintBusyRef.current = false;
    setRepaintBusy(false);
    clearTimeout(repaintTimerRef.current);
    repaintTimerRef.current = null;
  };
  const beginRepaint = () => {
    if (repaintBusyRef.current) return false; // a repaint is already in flight
    repaintBusyRef.current = true;
    setRepaintBusy(true);
    const map = mapRef.current;
    // Unlock once the regenerated tiles have been (re)loaded and painted…
    if (map && typeof map.once === 'function') map.once('idle', endRepaint);
    // …with a safety net for cases where no tile load ever starts (e.g. an
    // apply that changes nothing on the map) or idle never fires.
    repaintTimerRef.current = setTimeout(endRepaint, 5000);
    return true;
  };

  // Value-equality helpers: applying the SAME value must not trigger a
  // repaint cycle (and its input lock).
  const samePair = (a, b) =>
    a == null || b == null ? a === b : a[0] === b[0] && a[1] === b[1];
  const sameSet = (a, b) =>
    a === b || (a?.size === b?.size && (a?.size === 0 || [...a].every(x => b.has(x))));

  // A meteo instance only repaints the map when its band is NARROWER than the
  // full span of its window (inert = full span, "no filtering"). Adding an
  // inert instance must not lock the inputs for a repaint that never happens.
  const inertInstance = (inst) => {
    if (!inst) return true;
    const span = agg?.days.length ? limitsForWindow(agg, inst.type, inst.from, inst.to) : null;
    return !span || samePair(inst.range, span);
  };

  // Filter instance handlers (lifted to App so the map + stations share one
  // source of truth)
  const addFilter = (type) => {
    const from = maxDays > 0 ? Math.min(DEFAULTDAYRANGE, maxDays - 1) : 0;
    const span = agg?.days.length ? limitsForWindow(agg, type, from, 0) : null;
    const inst = { id: `f${nextFilterId}`, type, from, to: 0, range: span ? [span[0], span[1]] : [0, 0] };
    setMeteoFilters(prev => [...prev, inst]);
    setNextFilterId(n => n + 1);
    return inst;
  };
  const updateFilter = (id, patch) => {
    setMeteoFilters(prev => prev.map(f => (f.id === id ? { ...f, ...patch } : f)));
  };
  const removeFilter = (id) => {
    setMeteoFilters(prev => prev.filter(f => f.id !== id));
  };

  // The live filter stack in the same shape presets are stored in, so it can be
  // compared against them. Recomputed only when a filter actually changes.
  const currentFilterConfig = useMemo(() => buildFilterConfig({
    reliefRange,
    meteoFilters,
    forestOff: mcscOff,
    geoOff,
    boletFilter,
  }), [reliefRange, meteoFilters, mcscOff, geoOff, boletFilter]);

  // Named filter presets (localStorage): App owns every filter state, so the
  // snapshot is built here and only the NAME comes from the panel. Saving is
  // pure storage — it never repaints the map, so it isn't gated by busy.
  const saveCurrentFilter = useCallback((name) => {
    const next = saveFilterPreset(name, currentFilterConfig);
    setSavedFilters(next); // keep the basket list in sync without re-reading storage
    return next;
  }, [currentFilterConfig]);

  // Which saved preset the live filters match (null as soon as anything is
  // tweaked): derived, not remembered, so manual edits clear the basket mark
  // with no bookkeeping in the individual filter handlers.
  const activePresetName = useMemo(() => {
    const hit = savedFilters.find(p => sameFilterConfig(p.config, currentFilterConfig));
    return hit ? hit.name : null;
  }, [savedFilters, currentFilterConfig]);

  // The header ticker: the applied preset's name followed by one line per
  // ACTIVE condition (appliedFilters.appliedFilterItems). Derived from the
  // live filter state, so it needs no bookkeeping in the apply handlers and
  // falls back to no header at all when nothing filters.
  const headerFilterItems = useMemo(() => appliedFilterItems({
    presetName: activePresetName,
    meteoFilters,
    agg,
    reliefRange,
    altLimits,
    forestCount: mcscOff.size,
    geoCount: geoOff.size,
    boletSpecies: boletFilter?.species ?? null,
  }), [activePresetName, meteoFilters, agg, reliefRange, altLimits, mcscOff, geoOff, boletFilter]);

  // Delete a saved preset (basket row ✕). Removing a preset never touches the
  // live filters — it only shrinks the basket.
  const deleteFilterPreset = (name) => {
    setSavedFilters(removeSavedFilter(name));
  };

  // Saved locations (localStorage): the directions modal owns the name +
  // description, App owns the point and the list. Saving is pure storage, so
  // it never touches the map.
  const saveRouteLocation = useCallback((name, description) => {
    if (!routePoint) return;
    setSavedLocations(saveLocation(name, {
      lat: routePoint.lat,
      lng: routePoint.lng,
      elevation: routePoint.elevation,
      description,
    }));
  }, [routePoint]);

  // Delete a saved location (panel row ✕) — the map never moves.
  const deleteSavedLocation = (name) => {
    setSavedLocations(removeSavedLocation(name));
  };

  // Panel row button: fly the map back to the saved point and close the panel
  // so the spot is actually visible. A saved spot is a destination, so it is
  // zoomed in closer than the region overview.
  const goToSavedLocation = useCallback((location) => {
    const map = mapRef.current;
    if (map && Number.isFinite(location?.lat) && Number.isFinite(location?.lng)) {
      map.flyTo({ center: [location.lng, location.lat], zoom: Math.max(map.getZoom(), 13) });
    }
    setShowLocations(false);
  }, []);

  // Everything the directions modal's area analysis needs beyond the point
  // itself: the meteo context that rebuilds the map's own grids (aggregate
  // table + station features + reference day), the substrate grid the geology
  // filter already loaded, and the filters to measure the area against — the
  // live stack (only when it actually filters) plus every saved preset.
  const areaAnalysis = useMemo(() => ({
    agg,
    features: geoWithData?.features ?? [],
    refDay,
    lithoGrid,
    activeConfig: hasFilterConditions(currentFilterConfig) ? currentFilterConfig : null,
    savedPresets: savedFilters,
  }), [agg, geoWithData, refDay, lithoGrid, currentFilterConfig, savedFilters]);

  // Saved location matching the currently picked point (null when the modal is
  // closed or the point was never saved) — derived so the panel marks it
  // without any bookkeeping, exactly like the active filter preset.
  const activeLocationName = useMemo(() => {
    if (!routePoint) return null;
    const hit = savedLocations.find(
      l => l.lat === routePoint.lat && l.lng === routePoint.lng,
    );
    return hit ? hit.name : null;
  }, [savedLocations, routePoint]);

  // Apply a saved preset (basket button): replace the WHOLE filter stack at
  // once behind a single repaint gate — calling the individual apply handlers
  // would be refused after the first (beginRepaint locks while a repaint is in
  // flight). Instance ids are re-minted from the live counter so a loaded
  // preset can never collide with an existing instance; the basket closes so
  // the repainted map is visible.
  const applyFilterPreset = (preset) => {
    const config = preset?.config;
    if (!config) return;
    if (!beginRepaint()) return;
    // A preset may have been saved from a longer dataset: an offset can't
    // reach back past the oldest available day (same clamp as effectiveRange).
    const oldest = Math.max(0, maxDays - 1);
    const clampOffset = v => Math.min(Math.max(0, v), oldest);
    const filters = (config.meteoFilters ?? []).map((f, i) => ({
      id: `f${nextFilterId + i}`,
      type: f.type,
      from: clampOffset(f.from),
      to: clampOffset(f.to),
      range: [f.range[0], f.range[1]],
    }));
    setNextFilterId(n => n + filters.length);
    setMeteoFilters(filters);
    setReliefRange(config.reliefRange ? [config.reliefRange[0], config.reliefRange[1]] : null);
    setMcscOff(new Set(config.forestOff ?? []));
    setGeoOff(new Set(config.geoOff ?? []));
    setBoletFilter(config.boletFilter ? { ...config.boletFilter } : null);
    setShowBasket(false);
  };

  // Gated versions of every filter trigger that repaints the painted areas.
  // While beginRepaint() is locked the FilterPanel buttons are disabled
  // (busy prop) — see the block above.
  const applyReliefRange = (range) => {
    if (samePair(range, reliefRange)) return;      // nothing changes
    if (!beginRepaint()) return;
    setReliefRange(range);
  };
  const applyAspectSectors = (sectors) => {
    const next = sectors && sectors.length ? [...sectors].sort() : null;
    const cur = aspectSectors ?? null;
    const same = next === cur ||
      (next && cur && next.length === cur.length && next.every((v, i) => v === cur[i]));
    if (same) return;                              // nothing changes
    if (!beginRepaint()) return;
    setAspectSectors(next);
  };
  const applyForestCodes = (codes) => {
    if (sameSet(codes, mcscOff)) return;           // nothing changes
    if (!beginRepaint()) return;
    setMcscOff(codes);
  };
  const applyGeoFamilies = (families) => {
    if (sameSet(families, geoOff)) return;         // nothing changes
    if (!beginRepaint()) return;
    setGeoOff(families);
  };
  const applyFilterUpdate = (id, patch) => {
    const inst = meteoFilters.find(f => f.id === id);
    if (inst && patch.from === inst.from && patch.to === inst.to && samePair(patch.range, inst.range)) {
      return; // nothing changes
    }
    // Inert → inert (e.g. full-span windows) never repaint: allow freely.
    if (inertInstance(inst) && inertInstance({ ...inst, ...patch })) {
      updateFilter(id, patch);
      return;
    }
    if (!beginRepaint()) return;
    updateFilter(id, patch);
  };
  const applyRemoveFilter = (id) => {
    // Removing an inert (full-span) instance doesn't repaint the map.
    const inst = meteoFilters.find(f => f.id === id);
    if (!inertInstance(inst) && !beginRepaint()) return;
    removeFilter(id);
  };

  // Station value day ranges follow the filters: for each variable, the LAST
  // ACTIVE filter's window wins (a filter is active when its band is narrower
  // than its window's full span — inert instances don't filter); no active
  // filter → default (last DEFAULTDAYRANGE days). Updated here so every
  // add/update/remove path converges on the same rule; unchanged states keep
  // their identity (no pointless re-renders).
  useEffect(() => {
    const next = { rain: defaultRange(), temp: defaultRange(), hum: defaultRange() };
    for (const type of ['rain', 'temp', 'hum']) {
      // Active = band narrower than its window's full span (the same
      // full-span-means-off contract as inertInstance / terrainState).
      const active = meteoFilters.filter(f => {
        if (f.type !== type) return false;
        const span = agg?.days.length ? limitsForWindow(agg, f.type, f.from, f.to) : null;
        return span != null && (f.range[0] !== span[0] || f.range[1] !== span[1]);
      });
      if (active.length) {
        const last = active[active.length - 1];
        next[type] = { from: last.from, to: last.to };
      }
    }
    setStationDayRange(prev => (
      prev.rain.from === next.rain.from && prev.rain.to === next.rain.to &&
      prev.temp.from === next.temp.from && prev.temp.to === next.temp.to &&
      prev.hum.from === next.hum.from && prev.hum.to === next.hum.to
        ? prev
        : next
    ));
  }, [meteoFilters, agg]);

  // Day-range info for the span next to the station-info button: the window
  // of the value currently shown (or null for none/altitud — altitude is
  // static). The span reads the CONCRETE window — "start day – stop day"
  // (compact Catalan) — so the user sees exactly which days the circle
  // values cover; the title adds the day count + full ISO dates.
  const currentType = LABEL_TYPE[labelMode] ?? null;
  const currentRange = currentType ? effectiveRange(stationDayRange[currentType]) : null;
  const stationRangeWindow = currentRange && refDay ? windowToDates(refDay, currentRange.from, currentRange.to) : null;
  const stationRangeLabel = stationRangeWindow
    ? `${fmtShortCat(stationRangeWindow.from)} – ${fmtShortCat(stationRangeWindow.to)}`
    : null;
  // Day count = days the window covers (from − to + 1): the default
  // { from: DEFAULTDAYRANGE, to: 0 } with a 60-day dataset clamps to
  // from = maxDays − 1 = 59 for the aggregation but still covers 60 days.
  const stationRangeCount = currentRange ? `darrers ${currentRange.from - currentRange.to + 1} dies` : null;
  const stationRangeDates = stationRangeWindow ? `${stationRangeWindow.from} – ${stationRangeWindow.to}` : null;

  // Altitude has no day window (static metadata), but while the button is in
  // altitude mode a label shows the APPLIED relief band ("100m – 600m") — and
  // only when the filter really filters: narrowed below the stations' full
  // altitud span, the same full-span-means-off contract as terrainState.alt.
  const reliefApplied = reliefRange != null && altLimits != null &&
    (reliefRange[0] !== altLimits[0] || reliefRange[1] !== altLimits[1]);
  const stationAltLabel = labelMode === 'altitud' && reliefApplied
    ? `${reliefRange[0]}m – ${reliefRange[1]}m`
    : null;

  const stationObj = selectedStation
  ? geoWithData?.features?.find(f => f.properties.codi === selectedStation)
  : null;
  // Icon of the ACTIVE render mode and of the ACTIVE station-label mode —
  // components, not elements, so the JSX below picks them by key.
  const ActiveIcon = PAINT_ICONS[terrainMode] ?? ForestIcon;
  const ActiveLabelIcon = LABEL_ICONS[labelMode] ?? HiddenIcon;
  return (
    <div className={`app${mapUnavailable ? ' no-webgl' : ''}`}>
      <img className='logo' src={logo} alt="MeteoSeps" />
      {/* Header: nothing but the applied-filter ticker (HeaderStatus) — the
          preset name and each active condition, one at a time. */}
      <HeaderStatus items={headerFilterItems} />
      {data && (
        <div className="top-buttons">
          {/* Three buttons share one row (saved places, saved filters, filter);
              their panels open below, one at a time — opening one closes the
              others. */}
          <div className="top-button-row">
            <div
              className={`sel-button filter-button${showLocations ? ' on' : ''}`}
              title="Llocs desats"
              onClick={() => {
                setShowLocations(v => !v);
                setShowBasket(false);
                setShowFilter(false);
              }}
            >
              <TreasureMapIcon className="noun-icon" />
            </div>
            <div
              className={`sel-button filter-button${showBasket ? ' on' : ''}`}
              title="Filtres desats"
              onClick={() => {
                setShowBasket(v => !v);
                setShowFilter(false);
                setShowLocations(false);
              }}
            >
              <BasketIcon className="noun-icon" />
            </div>
            <div
              className={`sel-button filter-button${showFilter ? ' on' : ''}`}
              title="Filtres"
              onClick={() => {
                setShowFilter(v => !v);
                setShowBasket(false);
                setShowLocations(false);
              }}
            >
              <FilterIcon className="noun-icon" />
            </div>
          </div>
          {showLocations && (
            <SavedLocationsPanel
              locations={savedLocations}
              activeName={activeLocationName}
              onSelect={goToSavedLocation}
              onDelete={deleteSavedLocation}
              onClose={() => setShowLocations(false)}
            />
          )}
          {showBasket && (
            <SavedFiltersPanel
              presets={savedFilters}
              activeName={activePresetName}
              onApply={applyFilterPreset}
              onDelete={deleteFilterPreset}
              onClose={() => setShowBasket(false)}
            />
          )}
          {showFilter && (
            <FilterPanel
              onClose={() => setShowFilter(false)}
              reliefRange={reliefRange}
              busy={repaintBusy}
              onApplyRelief={applyReliefRange}
              aspectSectors={aspectSectors}
              onApplyAspect={applyAspectSectors}
              meteoFilters={meteoFilters}
              onAddFilter={addFilter}
              onUpdateFilter={applyFilterUpdate}
              onRemoveFilter={applyRemoveFilter}
              agg={agg}
              refDay={refDay}
              maxDays={maxDays}
              altLimits={altLimits}
              // Forest filter reuses the legend's dim state (mcscOff) — the
              // tree filter is a copy of the legend and drives the same tiles.
              filteredForestCodes={mcscOff}
              onApplyForest={applyForestCodes}
              // Geology (substrate) filter: dimmed families gate terrain
              // pixels + station dots via terrainState / filterStationCodes.
              lithoLegend={geoLegend}
              geoOff={geoOff}
              onApplyGeo={applyGeoFamilies}
              boletFilter={boletFilter}
              onApplyBolet={setBoletFilter}
              onSaveFilter={saveCurrentFilter}
            />
          )}
        </div>
      )}
      {/* Bottom-left button stack: active-layer legend, render-mode switch
          (terrain types ↔ substrate), 3D terrain, station info, directions */}
      <div className="bottom-buttons">
        {/* Legend of the ACTIVE rendering method (its content switches with
            the mode; info-only rows, dimming stays in the filter panel) */}
        <div
          className={`sel-button legend-layer${showLegend ? ' on' : ''}`}
          title="Llegenda de la capa activa"
          onClick={() => setShowLegend(!showLegend)}
        >
          <LegendIcon className="noun-icon" />
        </div>
        {/* Render-mode cycle: painted areas show terrain types (MCSC class
            colours) → substrate (geology family colours) → NONE (no palette;
            the land that passes every filter is tinted bright green over the
            relief — only while a filter is active). The icon + colour reflect
            the ACTIVE mode; substrate is skipped while the geology grid is
            still loading. While a repaint is in flight the button is locked
            (beginRepaint) so bursts of mode clicks can't overlap repaints. */}
        <div
          className={`sel-button ${PAINT_CLASSES[terrainMode] ?? 'forest'}${terrainMode !== 'terrain' ? ' on' : ''}${repaintBusy ? ' busy' : ''}`}
          title={repaintBusy
            ? 'Pintant els canvis…'
            : terrainMode === 'terrain'
              ? lithoGrid
                ? 'Veure el substrat (geologia)'
                : 'Veure el filtre en verd (relleu, sense cobertes pintades)'
              : terrainMode === 'substrate'
                ? 'Veure el filtre en verd (relleu, sense cobertes pintades)'
                : 'Veure el tipus de terreny (cobertes del sòl)'}
          onClick={() => {
            if (repaintBusy) return; // a repaint is already in flight
            const i = PAINT_MODES.indexOf(terrainMode);
            let next = PAINT_MODES[(i + 1) % PAINT_MODES.length];
            // substrate cannot paint while the geology grid is missing
            if (next === 'substrate' && !lithoGrid) {
              next = PAINT_MODES[(i + 2) % PAINT_MODES.length];
            }
            if (next === terrainMode) return;
            setTerrainMode(next);
            beginRepaint();
          }}
        >
          <ActiveIcon className="noun-icon" />
        </div>
        <div
          className={`sel-button terrain3d${showTerrain3D ? ' on' : ''}`}
          title="Terreny 3D"
          onClick={() => setShowTerrain3D(!showTerrain3D)}
        >
          <Icon3D className="noun-icon" />
        </div>
        {/* Station value: none → altitud → rain → temp → hum → none. Never
            dimmed — area filters paint pixels only. Each meteo value covers
            its variable's stationDayRange: the default (last
            DEFAULTDAYRANGE days) or the last ACTIVE filter's range; the span
            on the right says which window the numbers come from. In altitude
            mode the span shows the applied relief band instead. */}
        <div className="stationinfo-row">
          <div
            className={`sel-button ${LABEL_CLASSES[labelMode] ?? 'stationinfo'}${labelMode !== 'none' ? ' on' : ''}`}
            title={labelMode === 'none'
              ? 'Mostra altitud (m)'
              : labelMode === 'altitud'
                ? 'Mostra altitud (m)'
                : `${labelMode === 'precAcc' ? 'Pluja acumulada' : labelMode === 'tempAvg' ? 'Temperatura mitjana' : 'Humitat mitjana'} · ${stationRangeLabel ?? ''}${stationRangeCount && stationRangeDates ? ` (${stationRangeCount} · ${stationRangeDates})` : ''}`}
            onClick={() => {
              const i = LABEL_MODES.indexOf(labelMode);
              setLabelMode(LABEL_MODES[(i + 1) % LABEL_MODES.length]);
            }}
          >
            <ActiveLabelIcon className="noun-icon" />
          </div>
          {stationRangeLabel && (
            <span
              className="stationinfo-range"
              title={stationRangeCount && stationRangeDates ? `${stationRangeCount} · ${stationRangeDates}` : undefined}
            >
              {stationRangeLabel}
            </span>
          )}
          {stationAltLabel && (
            <span
              className="stationinfo-range"
              title={`Relleu aplicat: ${reliefRange[0]} – ${reliefRange[1]} m`}
            >
              {stationAltLabel}
            </span>
          )}
        </div>
        {/* Directions: arm the map so the next click picks a point and opens
            the directions modal (Esc cancels the arming). */}
        <div
          className={`sel-button directions${pickRoute ? ' on' : ''}`}
          title="Com hi arribo — tria un punt al mapa"
          onClick={() => setPickRoute(!pickRoute)}
        >
          <PickingMushroomsIcon className="noun-icon" />
        </div>
      </div>
      {/* @vis.gl/react-maplibre's Map only forwards `style` to its container
          div, never `className` — so the .map-view sizing must live on a
          wrapper element around the map, not on <Map> itself. */}
      <div className="map-view">
        {mapUnavailable ? (
          <MapUnavailable detail={mapErrorDetail} />
        ) : (
          <Map
            key={styleUrl}
            initialViewState={{
              longitude: center[0],
              latitude: center[1],
              zoom: minZoom + 1
            }}
            mapStyle={styleUrl}
            onLoad={onMapLoad}
            onError={onMapError}
          >
            {/* Live scale bar (bottom centre): MapLibre re-measures it on
                every move, so the distance it shows always matches the
                current zoom / latitude. It only accepts corner positions —
                the bottom-left slot is free (the app's own button stack is
                plain CSS, not a control) and App.css re-anchors that slot to
                the horizontal centre. */}
            <ScaleControl position="bottom-left" unit="metric" maxWidth={150} />
          </Map>
        )}
      </div>
      {dataLoading && !data && (
        <div className="app-loading">
          {loadError ? `No s'han pogut carregar les dades: ${loadError}` : 'Carregant dades…'}
        </div>
      )}
      <DirectionsModal
        point={routePoint}
        nearest={routeNearest}
        distanceKm={routeDistanceKm}
        radius={routeRadius}
        areaAnalysis={areaAnalysis}
        onRadiusChange={setRouteRadius}
        onClose={() => setRoutePoint(null)}
        onNavigate={openRouteDirections}
        onSaveLocation={saveRouteLocation}
      />
      {selectedStation && <StationPanel
        station={stationObj}
        daysRange={displayWindow}
        data={data}
        setSelectedStation={setSelectedStation}
        elevation={clickedElevation}
        boletFilter={boletFilter}
        boletScores={boletScores}
        // Highlights the active day range inside each fixed-60-day chart
        // (the window the circle values are aggregated over).
        stationDayRange={stationDayRange}
      />}
      {showLegend && (
        <div className="mcsc-legend">
          {terrainMode === 'relief' ? (
            <>
              <div className="mcsc-legend-title">Relleu · isòhipsis</div>
              <div className="mcsc-legend-label">
                Corbes de nivell del terreny (les mestres, més gruixudes, cada
                5 corbes). Sense cobertes pintades: el terreny que compleix
                tots els filtres es marca en verd.
              </div>
            </>
          ) : terrainMode === 'substrate' && lithoGrid ? (
            <>
              <div className="mcsc-legend-title">Substrat geològic (1:50.000)</div>
              {/* Info-only legend of the substrate rendering mode: dimming
                  families is done from the filter panel (Substrat), so these
                  rows are not interactive. Dimmed families show grey. */}
              {geoLegend.map(entry => {
                const off = geoOff.has(entry.key);
                return (
                  <div
                    key={entry.key}
                    className={`mcsc-legend-row info${off ? ' off' : ''}`}
                  >
                    <span className="mcsc-legend-swatch" style={{ '--swatch-color': entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </div>
                );
              })}
              <div className="mcsc-legend-footer">Mapa geològic 1:50.000 v3.0 — ICGC · CC BY 4.0</div>
            </>
          ) : (
            <>
              <div className="mcsc-legend-title">Cobertes del sòl (MCSC)</div>
              {/* Info-only legend: dimming terrain types is done from the filter
                  panel (Bosc), so these rows are not interactive. They still show
                  the current map state — dimmed classes appear as a grey swatch. */}
              {MCSC_LEGEND.map(entry => {
                const off = mcscOff.has(entry.codes);
                return (
                  <div
                    key={entry.codes}
                    className={`mcsc-legend-row info${off ? ' off' : ''}`}
                  >
                    <span className="mcsc-legend-swatch" style={{ '--swatch-color': entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </div>
                );
              })}
              <div className="mcsc-legend-footer">ICGC &amp; CREAF · CC BY 4.0</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default App;