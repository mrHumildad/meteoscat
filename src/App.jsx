import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre v6 is ESM-only and loads its internal worker from a real URL: under
// a bundler, import.meta.url does not resolve to the worker file, so the map
// must be told where it lives. Vite's `?worker&url` emits a self-contained
// worker chunk (plain `?url` would miss the sibling shared module and the
// worker would fail on its first import). One-time call, before any Map.
import { setWorkerUrl } from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
setWorkerUrl(maplibreWorkerUrl);
import logo from './assets/logo.png';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faCar, faDroplet, faFilter, faLayerGroup, faList, faMountainSun, faRulerVertical, faSeedling, faTemperatureLow, faTree } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useRef, useMemo } from 'react';
import { loadAvailableDays, loadSummaries } from './logic/refineData.js'
import { getDaysInRange, fmtDateCat, parseDay } from './logic/utils.js';
import './App.css'

import { computeGeoValues } from './logic/computeGeoValues.js';
import { aggregateWindow, buildAggregateTable, limitsForWindow, windowToDates, TYPE_TO_VARIABLE } from './logic/filterAggregate.js';
import { scoreStations, scoreByCode } from './logic/boletEngine.js';
import { MCSC_LEGEND, MCSC_GREY, MCSC_WATER_COLOR, MCSC_WATER_ENTRY } from './logic/mcscLegend.js';
import { ELEVATION_TILES, ELEVATION_ATTRIBUTION, sampleElevation } from './logic/elevation.js';
import { MCSC_ATTRIBUTION } from './logic/mcscRaw.js';
import { registerTerrainProtocol, terrainTileUrl } from './logic/terrainOverlay.js';
import { registerSeaProtocol } from './logic/seaOverlay.js';
import { CATALONIA_BOUNDS, TERRAIN_OVERLAY_BOUNDS, fitZoomForViewport } from './logic/mapFit.js';
import { pushTerrainContext } from './logic/tilePipeline.js';
import { LITHO_ATTRIBUTION, lithoLegendEntries, loadLithoGrid } from './logic/lithology.js';
import FilterPanel from './comps/FilterPanel.jsx';
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
// last DISPLAY_DAYS days from the reference day (filters are independent —
// each has its own window).
const DISPLAY_DAYS = 60;
// Station circles: area filters never dim stations (Phase A). The circle
// label shows a value over the last STATION_VALUE_DAYS days (configurable
// later); the StationPanel chart + totals still use the 60-day displayWindow.
const STATION_VALUE_DAYS = 15;

// MapLibre expression for the value shown inside each station circle.
// Data-driven: reads the feature property `variable` and renders it as text.
const valueField = variable => [
  'case',
  ['==', ['get', variable], null],
  '',
  ['to-string', ['get', variable]]
];

// Station-info cycle (Phase A): none (hidden) → altitude (static) → rain Σ →
// temp mean → humidity mean, all last 15 days (STATION_VALUE_DAYS), then none.
// Later the window becomes configurable per variable.
const LABEL_MODES = ['none', 'altitud', 'precAcc', 'tempAvg', 'humAvg'];
const LABEL_ICONS = {
  none: faBan,
  altitud: faRulerVertical,
  precAcc: faDroplet,
  tempAvg: faTemperatureLow,
  humAvg: faSeedling
};
const LABEL_CLASSES = {
  none: 'stationinfo',
  altitud: 'altitude',
  precAcc: 'rain',
  tempAvg: 'temp',
  humAvg: 'humidity'
};
const LABEL_PROP = {
  altitud: 'altitud',
  precAcc: 'precAcc15',
  tempAvg: 'tempAvg15',
  humAvg: 'humAvg15'
};

// Cycle order of the bottom-left render-mode button, and the icon / button
// colour of each state: 'terrain' paints MCSC land-cover colours (green
// forest button), 'substrate' paints the geology families (brown substrat),
// 'none' paints NOTHING — only the relief (hillshade) and the basemap show
// (grey relief button). 'none' is skipped from the cycle only while the
// geology grid is still loading (substrate unavailable anyway).
const PAINT_MODES = ['terrain', 'substrate', 'none'];
const PAINT_ICONS = {
  terrain: faTree,
  substrate: faLayerGroup,
  none: faBan
};
const PAINT_CLASSES = {
  terrain: 'forest',
  substrate: 'substrat',
  none: 'relief'
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
  // Map style — Stadia free tier (no API key). PROD alternative kept:
  // 'https://demotiles.maplibre.org/style.json'   // public, no key
  const styleUrl = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';
  const [selectedStation, setSelectedStation] = useState(null);
  const [days, setDays] = useState([]);           // available 'YYYY-MM-DD' days, oldest first
  const [data, setData] = useState(null);         // all daily shards (every available day)
  const [labelMode, setLabelMode] = useState('none'); // station-circle value: 'none' default (hidden) → altitud → rain Σ 15d → temp mean 15d → hum mean 15d → none
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const [showLegend, setShowLegend] = useState(false);           // legend panel of the ACTIVE rendering mode
  const [terrainMode, setTerrainMode] = useState('terrain');    // painted areas: 'terrain' (MCSC) | 'substrate' (geology) | 'none' (relief only)
  const [showTerrain3D, setShowTerrain3D] = useState(true);     // 3D terrain (tilts the camera)
  const [mapReady, setMapReady] = useState(false); // true once the heavy area overlays exist (added on first idle — see onMapLoad)
  const [mcscOff, setMcscOff] = useState(() => new Set()); // codes of dimmed legend entries
  const [geoOff, setGeoOff] = useState(() => new Set()); // keys of dimmed substrate families
  const [lithoGrid, setLithoGrid] = useState(null); // decoded substrate grid (lithology.js)
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [clickedElevation, setClickedElevation] = useState(null); // DEM sample, m
  const [pickRoute, setPickRoute] = useState(false); // car button armed: next map click opens Google Maps directions
  const [showFilter, setShowFilter] = useState(false); // filter panel open state
  const [reliefRange, setReliefRange] = useState(null); // applied altitude band [lo, hi]; null = off
  const [meteoFilters, setMeteoFilters] = useState([]); // [{ id, type, from, to, range }] — one per meteo filter instance
  const [nextFilterId, setNextFilterId] = useState(1);
  const [boletFilter, setBoletFilter] = useState(null); // { species, threshold } | null — mushroom rule filter (test)
  const [forestByCode, setForestByCode] = useState({});  // stationCodi → MCSC forestType from forest_types.json
  const mapRef = useRef(null);
  const dataReqRef = useRef(0);
  const selectedStationRef = useRef(null); // stale-guard for async takeElevation
  const pickRouteRef = useRef(false); // latest armed state read by the (once-registered) map handlers
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

  // Display window (last DISPLAY_DAYS days from the reference day) — the
  // values shown in the StationPanel chart / totals. Station circle labels
  // use a separate window: rain Σ over last STATION_VALUE_DAYS days (see
  // labelMode below) — area filters never dim stations (Phase A).
  const displayWindow = useMemo(() => {
    if (!refDay || !data) return null;
    const from = new Date(refDay);
    from.setDate(from.getDate() - (DISPLAY_DAYS - 1));
    return { from, to: new Date(refDay) };
  }, [refDay, data]);

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
    // modes.
    return {
      mode: terrainMode,
      off,
      alt: altActive ? [reliefRange[0], reliefRange[1]] : null,
      filters,
      geoOff: [...geoOff].sort(),
    };
  }, [mcscOff, reliefRange, altLimits, meteoFilters, agg, refDay, geoOff, terrainMode]);

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

    // ensure a 'stations' source exists immediately (empty fallback)
    const emptyGeo = { type: 'FeatureCollection', features: [] };
    if (!map.getSource('stations')) {
      map.addSource('stations', { type: 'geojson', data: stationsGeo || emptyGeo });
    } else if (stationsGeo) {
      map.getSource('stations').setData(stationsGeo);
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
          'text-anchor': 'top'
        },
        paint: { 'text-color': '#222' }
      });
    }

    // value label layer: station value inside circle (rain Σ last 15 days when
    // labelMode is 'precAcc', hidden when 'none'). Always visible in area-
    // filter mode — no dimming by filters.
    if (!map.getLayer('stations-value')) {
      const prop = LABEL_PROP[labelMode] ?? labelMode;
      map.addLayer({
        id: 'stations-value',
        type: 'symbol',
        source: 'stations',
        layout: {
          'text-field': valueField(prop),
          'text-size': 24,
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
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
    registerTerrainProtocol(map, () => terrainStateRef.current);
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
    // a Google Maps "how to get there" route to that point in a new tab.
    map.on('click', (e) => {
      if (!pickRouteRef.current) return;
      const { lat, lng } = e.lngLat ?? {};
      if (lat == null || lng == null) return;
      const dest = `${lat.toFixed(5)},${lng.toFixed(5)}`;
      window.open(`https://www.google.com/maps/dir/?api=1&destination=${dest}`, '_blank');
      // One pick per arming: disarm right after the tab opens (Esc also works).
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

      // Continuous elevation: raster-dem source (terrarium) shared by the
      // hillshade overlay and 3D terrain, drawn below the stations. No
      // bounds: it shades whatever the camera can actually see (the fit-zoom
      // floor already limits how far out that can be), and clipping it would
      // leave an ugly relief edge at the bounds when panning/tilting.
      map.addSource('elevation-dem', {
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
        source: 'elevation-dem',
        layout: { visibility: 'visible' },
        paint: {
          'hillshade-exaggeration': 0.4,
          'hillshade-illumination-direction': 315
        }
      }, 'stations-circle');

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

      // Layers are all in place — let the terrain/sea/3D effects run now
      // (they key off mapReady and need these sources to exist).
      setMapReady(true);
    };
    map.once('idle', addAreaOverlays);
    const overlayTimer = setTimeout(addAreaOverlays, 3000);
    map.on('remove', () => clearTimeout(overlayTimer));
  };

  // 1️⃣ Compute geoWithData over the DISPLAY window (StationPanel chart +
  // totals; filters evaluate their own windows via the aggregate table).
  // Phase A also attaches rain/temp/hum over last STATION_VALUE_DAYS days
  // (altitud is static) so the circle label stays readable outside filtered
  // areas and outside the display window. No station is ever filtered.
  useEffect(() => {
    if (!stationsGeo || !data || !displayWindow) return;
    const daysInRange = getDaysInRange(data, displayWindow.from, displayWindow.to);
    const base = computeGeoValues(stationsGeo, data, daysInRange);
    if (!base || !agg || !agg.days.length) {
      setGeoWithData(base);
      return;
    }
    const enriched = {
      ...base,
      features: base.features.map(f => {
        const code = f.properties?.codi;
        const precAcc15 = code ? aggregateWindow(agg, code, 'rain', STATION_VALUE_DAYS - 1, 0) : null;
        const tempAvg15 = code ? aggregateWindow(agg, code, 'temp', STATION_VALUE_DAYS - 1, 0) : null;
        const humAvg15 = code ? aggregateWindow(agg, code, 'hum', STATION_VALUE_DAYS - 1, 0) : null;
        return {
          ...f,
          properties: {
            ...f.properties,
            precAcc15: precAcc15 == null ? null : Math.round(precAcc15 * 10) / 10,
            tempAvg15: tempAvg15 == null ? null : Math.round(tempAvg15 * 10) / 10,
            humAvg15: humAvg15 == null ? null : Math.round(humAvg15),
          },
        };
      }),
    };
    setGeoWithData(enriched);
  }, [stationsGeo, data, displayWindow, agg]);

  // 2.5️⃣ Keep station markers + their labels in sync with the station-info
  // toggle. Stations are NEVER dimmed — the button cycles none (hidden) →
  // altitud (static m) → rain Σ 15d → temp mean 15d → humidity mean 15d →
  // none. 'none' hides circles + name labels + value layer so no floating
  // names remain. All meteo values are over STATION_VALUE_DAYS days via
  // aggregateWindow (altitud is static metadata).
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
  }, [labelMode]);

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

  // keep the latest selected station in a ref so async DEM samples can check
  // they still match the station the user last clicked
  useEffect(() => { selectedStationRef.current = selectedStation; }, [selectedStation]);

  // keep the armed state in a ref so the once-registered map handlers see it
  useEffect(() => { pickRouteRef.current = pickRoute; }, [pickRoute]);

  // While the directions (car) button is armed the pointer becomes a
  // crosshair over the map so the next click is understood as "pick here";
  // Escape cancels the arming without opening anything.
  useEffect(() => {
    const map = mapRef.current;
    if (map) map.getCanvas().style.cursor = pickRoute ? 'crosshair' : '';
    if (!pickRoute) return;
    const onKey = (e) => { if (e.key === 'Escape') setPickRoute(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pickRoute]);

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

  // 2.9️⃣ Toggle 3D terrain (raster-dem source + tilted camera)
  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map) return;
    if (showTerrain3D && map.getSource('elevation-dem')) {
      map.setTerrain({ source: 'elevation-dem', exaggeration: 1.3 });
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
  }, [stationsGeo, geoWithData, boletScores]);

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
    const from = maxDays > 0 ? Math.min(60, maxDays - 1) : 0;
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

  // Gated versions of every filter trigger that repaints the painted areas.
  // While beginRepaint() is locked the FilterPanel buttons are disabled
  // (busy prop) — see the block above.
  const applyReliefRange = (range) => {
    if (samePair(range, reliefRange)) return;      // nothing changes
    if (!beginRepaint()) return;
    setReliefRange(range);
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

  // latest available data day (index.json is oldest-first) + staleness hint
  const latestDate = days.length ? new Date(days[days.length - 1]) : null;
  const dataStale = latestDate ? (Date.now() - latestDate.getTime()) / 86400000 > 1 : false;

  const stationObj = selectedStation
  ? geoWithData?.features?.find(f => f.properties.codi === selectedStation)
  : null;
  return (
    <div className='app'>
      <img  className='logo' src={logo} alt="MetoSeps" />
      <div className="app-header">
        <span className='header-title'>MeteoSeps</span>
        {latestDate && (
          <span
            className={`header-updated${dataStale ? ' stale' : ''}`}
            title={`Darreres dades disponibles: ${fmtDateCat(latestDate)}`}
          >
            Últimes dades: {fmtDateCat(latestDate)}
          </span>
        )}
      </div>
      {data && (
        <div className="top-buttons">
          <div
            className={`sel-button filter-button${showFilter ? ' on' : ''}`}
            title="Filtres"
            onClick={() => setShowFilter(!showFilter)}
          >
            <FontAwesomeIcon icon={faFilter} />
          </div>
          {showFilter && (
            <FilterPanel
              onClose={() => setShowFilter(false)}
              reliefRange={reliefRange}
              busy={repaintBusy}
              onApplyRelief={applyReliefRange}
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
          <FontAwesomeIcon icon={faList} />
        </div>
        {/* Render-mode cycle: painted areas show terrain types (MCSC class
            colours) → substrate (geology family colours) → NONE (nothing
            painted — only the relief shows). The icon + colour reflect the
            ACTIVE mode; substrate is skipped while the geology grid is still
            loading. While a repaint is in flight the button is locked
            (beginRepaint) so bursts of mode clicks can't overlap repaints. */}
        <div
          className={`sel-button ${PAINT_CLASSES[terrainMode] ?? 'forest'}${terrainMode !== 'terrain' ? ' on' : ''}${repaintBusy ? ' busy' : ''}`}
          title={repaintBusy
            ? 'Pintant els canvis…'
            : terrainMode === 'terrain'
              ? lithoGrid
                ? 'Veure el substrat (geologia)'
                : 'Veure només el relleu (sense cobertes pintades)'
              : terrainMode === 'substrate'
                ? 'Veure només el relleu (sense cobertes pintades)'
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
          <FontAwesomeIcon icon={PAINT_ICONS[terrainMode] ?? faTree} />
        </div>
        <div
          className={`sel-button terrain3d${showTerrain3D ? ' on' : ''}`}
          title="Terreny 3D"
          onClick={() => setShowTerrain3D(!showTerrain3D)}
        >
          <FontAwesomeIcon icon={faMountainSun} />
        </div>
        {/* Station value: none → altitud → rain 15d → temp 15d → hum 15d → none. Never dimmed — area filters paint pixels only. */}
        <div
          className={`sel-button ${LABEL_CLASSES[labelMode] ?? 'stationinfo'}${labelMode !== 'none' ? ' on' : ''}`}
          title={labelMode === 'none' ? 'Mostra altitud (m)' : labelMode === 'altitud' ? 'Mostra pluja darrers 15 dies (mm)' : labelMode === 'precAcc' ? 'Mostra temperatura mitjana darrers 15 dies (°C)' : labelMode === 'tempAvg' ? 'Mostra humitat mitjana darrers 15 dies (%)' : 'Amaga els valors de les estacions'}
          onClick={() => {
            const i = LABEL_MODES.indexOf(labelMode);
            setLabelMode(LABEL_MODES[(i + 1) % LABEL_MODES.length]);
          }}
        >
          <FontAwesomeIcon icon={LABEL_ICONS[labelMode] ?? faBan} />
        </div>
        {/* Directions: arm the map so the next click opens Google Maps routes */}
        <div
          className={`sel-button directions${pickRoute ? ' on' : ''}`}
          title="Com hi arribo — tria un punt al mapa (obre Google Maps)"
          onClick={() => setPickRoute(!pickRoute)}
        >
          <FontAwesomeIcon icon={faCar} />
        </div>
      </div>
      <Map
        key={styleUrl}
        initialViewState={{
          longitude: center[0],
          latitude: center[1],
          zoom: minZoom + 1
        }}
        style={{ width: '100%', height: '100%' }}
        mapStyle={styleUrl}
        onLoad={onMapLoad}
        
      />
      {dataLoading && !data && (
        <div className="app-loading">
          {loadError ? `No s'han pogut carregar les dades: ${loadError}` : 'Carregant dades…'}
        </div>
      )}
      {selectedStation && <StationPanel
        station={stationObj}
        daysRange={displayWindow}
        data={data}
        setSelectedStation={setSelectedStation}
        elevation={clickedElevation}
        boletFilter={boletFilter}
        boletScores={boletScores}
      />}
      {showLegend && (
        <div className="mcsc-legend">
          {terrainMode === 'none' ? (
            <>
              <div className="mcsc-legend-title">Sense cap coberta pintada</div>
              <div className="mcsc-legend-label">Només es mostra el relleu (ombrejat del terreny).</div>
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
                    <span className="mcsc-legend-swatch" style={{ backgroundColor: off ? MCSC_GREY : entry.color }} />
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
                    <span className="mcsc-legend-swatch" style={{ backgroundColor: off ? MCSC_GREY : entry.color }} />
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