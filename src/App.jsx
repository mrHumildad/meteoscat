import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import logo from './assets/logo.png';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faCar, faDroplet, faFilter, faMountainSun, faRulerVertical, faSeedling, faTemperatureLow, faTree } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useRef, useMemo } from 'react';
import { loadAvailableDays, loadSummaries } from './logic/refineData.js'
import { getDaysInRange, fmtDateCat, parseDay } from './logic/utils.js';
import './App.css'

import { computeGeoValues } from './logic/computeGeoValues.js';
import { filterStationCodes } from './logic/filterStations.js';
import { buildAggregateTable, limitsForWindow, windowToDates, TYPE_TO_VARIABLE } from './logic/filterAggregate.js';
import { MCSC_LEGEND, MCSC_GREY, MCSC_WATER_COLOR, MCSC_WATER_ENTRY } from './logic/mcscLegend.js';
import { ELEVATION_TILES, ELEVATION_ATTRIBUTION, sampleElevation } from './logic/elevation.js';
import { MCSC_ATTRIBUTION } from './logic/mcscRaw.js';
import { registerTerrainProtocol, terrainTileUrl } from './logic/terrainOverlay.js';
import { registerSeaProtocol } from './logic/seaOverlay.js';
import FilterPanel from './comps/FilterPanel.jsx';
import StationPanel from './comps/StationPanel.jsx';

// Catalonia bounding box (west,south) , (east,north)
const bounds = [[-1.0, 40.0], [4.0, 44.0]];
const center = [1.9, 41.9];
const minZoom = 7;
const maxZoom = 15;

// Default display window: station circles, StationPanel chart and totals are
// computed over the last DISPLAY_DAYS days from the reference day (filters
// are independent — each has its own window).
const DISPLAY_DAYS = 60;

// MapLibre expression for the value shown inside each station circle.
// Data-driven: reads the feature property `variable` and renders it as text.
const valueField = variable => [
  'case',
  ['==', ['get', variable], null],
  '',
  ['to-string', ['get', variable]]
];

// Value label expression that also hides the number on filtered-out (dimmed)
// stations: the source feature carries `inRange` = true/false.
const valueFieldDimmed = variable => [
  'case',
  ['!', ['get', 'inRange']],
  '',
  valueField(variable)
];

// Cycle order of the bottom-left station-info button, and the icon it shows
// for each mode so the rendered info is visible at a glance.
const LABEL_MODES = ['none', 'precAcc', 'altitud', 'tempAvg', 'humAvg'];
const LABEL_ICONS = {
  none: faBan,
  precAcc: faDroplet,
  altitud: faRulerVertical,
  tempAvg: faTemperatureLow,
  humAvg: faSeedling
};
// Background colours reuse the variable buttons' classes (blue rain, green
// humidity, red temp, purple altitude); 'none' keeps the amber stationinfo.
const LABEL_CLASSES = {
  none: 'stationinfo',
  precAcc: 'rain',
  altitud: 'altitude',
  tempAvg: 'temp',
  humAvg: 'humidity'
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
  const [labelMode, setLabelMode] = useState('humAvg'); // station-circle info: 'none' | 'precAcc' | 'altitud' | 'tempAvg' | 'humAvg'
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const [showLegend, setShowLegend] = useState(false);           // MCSC legend panel (overlay is always on)
  const [showTerrain3D, setShowTerrain3D] = useState(true);     // 3D terrain (tilts the camera)
  const [mapReady, setMapReady] = useState(false); // true once onMapLoad has added every layer
  const [mcscOff, setMcscOff] = useState(() => new Set()); // codes of dimmed legend entries
  const [filteredStationsCodes, setFilteredStationsCodes] = useState([]);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [clickedElevation, setClickedElevation] = useState(null); // DEM sample, m
  const [pickRoute, setPickRoute] = useState(false); // car button armed: next map click opens Google Maps directions
  const [showFilter, setShowFilter] = useState(false); // filter panel open state
  const [reliefRange, setReliefRange] = useState(null); // applied altitude band [lo, hi]; null = off
  const [meteoFilters, setMeteoFilters] = useState([]); // [{ id, type, from, to, range }] — one per meteo filter instance
  const [nextFilterId, setNextFilterId] = useState(1);
  const mapRef = useRef(null);
  const dataReqRef = useRef(0);
  const selectedStationRef = useRef(null); // stale-guard for async takeElevation
  const pickRouteRef = useRef(false); // latest armed state read by the (once-registered) map handlers
  const terrainStateRef = useRef(null); // stacked-overlay state read by the terrain:// tile protocol
  const geoWithDataRef = useRef(null); // latest features read by the terrain:// tile protocol
  const aggRef = useRef(null); // aggregate table read by the terrain:// tile protocol

  // Reference day = latest available data day; day ranges of every filter are
  // offsets back from it.
  const refDay = useMemo(() => (days.length ? parseDay(days[days.length - 1]) : null), [days]);
  const maxDays = days.length;

  // Prefix-sum aggregate table over ALL days — powers per-filter windows,
  // value-slider limits and the stacked-overlay grids.
  const agg = useMemo(() => buildAggregateTable(data ?? {}), [data]);

  // Stable feature list for the same data window (the `?? []` fallback would
  // otherwise create a new array on every render).
  const stationsFeatures = useMemo(() => geoWithData?.features ?? [], [geoWithData]);

  // Display window (last DISPLAY_DAYS days from the reference day) — the
  // values shown in station circles and the StationPanel chart/totals.
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

  // Stacked terrain overlay state — the full set of conditions every painted
  // pixel must satisfy: the dimmed (off) legend classes, the altitude band
  // when narrowed below the stations' altitud span, and every ACTIVE meteo
  // instance (band narrower than its window's full span) with its concrete
  // window dates. Any change here regenerates the painted terrain tiles.
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
    return { off, alt: altActive ? [reliefRange[0], reliefRange[1]] : null, filters };
  }, [mcscOff, reliefRange, altLimits, meteoFilters, agg, refDay]);

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

  const onMapLoad = async (evt) => {
    const map = evt?.target || evt?.map || evt;
    if (!map || typeof map.addSource !== 'function') return;
    mapRef.current = map;                       // <-- store map instance

    // constrain view
    map.setMaxBounds(bounds);
    map.setMinZoom(minZoom);
    map.setMaxZoom(maxZoom);
    map.jumpTo({ center, zoom: minZoom + 1 });

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

    // value label layer: show avg inside circle
    if (!map.getLayer('stations-value')) {
      map.addLayer({
        id: 'stations-value',
        type: 'symbol',
        source: 'stations',
        layout: {
          // show empty string when avg is null, otherwise show avg as string
          'text-field': valueField(labelMode),
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

    // Stacked terrain overlay (terrain:// protocol): the single land-cover
    // layer, below the stations and the hillshade (so the relief shading stays
    // on top). It paints the MCSC class colour client-side only where EVERY
    // active condition passes — selected class + altitude band + all meteo
    // instances — and leaves failing pixels transparent, so unselected areas
    // show the relief exactly like abroad (no grey mask). The source is
    // always on; the filter state baked into the tile URL is refreshed by the
    // terrain-tiles effect whenever it changes.
    registerTerrainProtocol(map, () => terrainStateRef.current, () => ({
      agg: aggRef.current,
      features: geoWithDataRef.current?.features ?? [],
    }));
    if (!map.getSource('terrain')) {
      map.addSource('terrain', {
        type: 'raster',
        tiles: terrainTiles,
        tileSize: 256,
        minzoom: 7,
        maxzoom: 14,
        attribution: MCSC_ATTRIBUTION
      });
    }
    if (!map.getLayer('terrain')) {
      map.addLayer({
        id: 'terrain',
        type: 'raster',
        source: 'terrain',
        layout: { visibility: 'visible' }, // the terrain overlay is always on
        paint: { 'raster-opacity': 0.85 } // same look as the old MCSC layer
      }, 'stations-circle');
    }

    // Continuous elevation: raster-dem source (terrarium) shared by the
    // hillshade overlay and 3D terrain, drawn below the stations.
    if (!map.getSource('elevation-dem')) {
      map.addSource('elevation-dem', {
        type: 'raster-dem',
        tiles: [ELEVATION_TILES],
        tileSize: 256,
        encoding: 'terrarium',
        maxzoom: 15,
        attribution: ELEVATION_ATTRIBUTION
      });
    }
    if (!map.getLayer('hillshade')) {
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
    }

    // Sea overlay: paints the ocean (elevation <= 0, from the same DEM the
    // relief uses) with the water colour. It sits ABOVE the hillshade — which
    // would otherwise render the flat/bathy sea grey — and BELOW the terrain
    // layer, so the land-cover water class draws on top with the same colour.
    registerSeaProtocol();
    if (!map.getSource('sea')) {
      map.addSource('sea', {
        type: 'raster',
        tiles: [`sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff) ?? 'off'}`],
        tileSize: 256,
        minzoom: 7,
        maxzoom: 15
      });
    }
    if (!map.getLayer('sea')) {
      map.addLayer({
        id: 'sea',
        type: 'raster',
        source: 'sea',
        layout: { visibility: 'visible' },
        paint: { 'raster-opacity': 1 }
      }, 'terrain');
    }

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

    // layers are all in place now — let the terrain effect apply the initial
    // (default-on) 3D state, since it can't run before the map exists
    setMapReady(true);
  };

  // 1️⃣ Compute geoWithData over the DISPLAY window (labels + panel values;
  // filters evaluate their own windows via the aggregate table)
  useEffect(() => {
    if (!stationsGeo || !data || !displayWindow) return;
    const daysInRange = getDaysInRange(data, displayWindow.from, displayWindow.to);
    setGeoWithData(computeGeoValues(stationsGeo, data, daysInRange));
  }, [stationsGeo, data, displayWindow]);

  // 1.5️⃣ Station filter: every meteo instance (its own window + band) AND
  // the relief band. [] = "no filtering" → show everything.
  useEffect(() => {
    setFilteredStationsCodes(
      filterStationCodes(stationsFeatures, meteoFilters, reliefRange, agg)
    );
  }, [stationsFeatures, meteoFilters, reliefRange, agg]);

  // 2.5️⃣ Keep station markers + their labels in sync with the station-info
  // mode. 'none' hides the circles (and their name labels, which would float
  // alone) plus the value layer; any other mode restores them and sets the
  // value layer's text-field. MapLibre layout properties are baked in at layer
  // creation, so updating the layer explicitly is required — React state
  // alone doesn't do it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (labelMode === 'none') {
      if (map.getLayer('stations-circle')) map.setLayoutProperty('stations-circle', 'visibility', 'none');
      if (map.getLayer('stations-label')) map.setLayoutProperty('stations-label', 'visibility', 'none');
      if (map.getLayer('stations-value')) map.setLayoutProperty('stations-value', 'visibility', 'none');
    } else {
      if (map.getLayer('stations-circle')) map.setLayoutProperty('stations-circle', 'visibility', 'visible');
      if (map.getLayer('stations-label')) map.setLayoutProperty('stations-label', 'visibility', 'visible');
      if (map.getLayer('stations-value')) {
        map.setLayoutProperty('stations-value', 'visibility', 'visible');
        map.setLayoutProperty('stations-value', 'text-field', valueFieldDimmed(labelMode));
      }
    }
  }, [labelMode]);

  // 2.7️⃣ Rebuild the stacked-terrain tiles when any filter changes — a
  // legend switch, the altitude band, or a meteo instance's window/band. The
  // state signature in the URL differs, so setTiles re-requests and the
  // terrain:// protocol repaints with the new conditions.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    terrainStateRef.current = terrainState;
    const src = map.getSource('terrain');
    if (src && typeof src.setTiles === 'function') {
      src.setTiles(terrainTiles);
    }
  }, [terrainState, terrainTiles, mapReady]);

  // 2.7.1️⃣ Keep the open sea in sync with the Aigües legend switch: blue by
  // default, fully transparent when the water class is dimmed (so the sea
  // shows the relief, exactly like a dimmed land-cover class — no grey). The
  // colour bakes into the tile URL, regenerating the overlay tiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('sea')) return;
    map.getSource('sea').setTiles([`sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff) ?? 'off'}`]);
  }, [mcscOff]);

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

  // keep the display features + aggregate table in refs so the terrain:// tile
  // protocol can (re)build grids for the right data
  useEffect(() => { geoWithDataRef.current = geoWithData; }, [geoWithData]);
  useEffect(() => { aggRef.current = agg; }, [agg]);

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

  // 2️⃣ Update map once geoWithData is ready (and apply the filter).
  // All stations stay in the source; out-of-range ones carry inRange=false and
  // are dimmed (smaller, faded, grey) instead of being removed, so you can see
  // what's being filtered out.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      // prefer geoWithData (computed averages) when available
      const dataToSet = geoWithData || stationsGeo;
      if (!dataToSet) return;
      // filtering is active only once a filter constrains (non-empty list)
      const filteringOn = filteredStationsCodes.length > 0;
      const features = (dataToSet.features ?? []).map(f => ({
        ...f,
        properties: {
          ...f.properties,
          inRange: filteringOn ? filteredStationsCodes.includes(f.properties?.codi) : true,
        },
      }));
      const featureCollection = { ...dataToSet, features };
      if (map.getSource('stations')) {
        map.getSource('stations').setData(featureCollection);
      } else {
        map.addSource('stations', { type: 'geojson', data: featureCollection });
      }
      // Dim filtered-out stations (MCSC_GREY, lower opacity, smaller) + dim
      // their name labels; hide the value number inside their circles.
      const dim = ['!', ['get', 'inRange']];
      if (map.getLayer('stations-circle')) {
        map.setPaintProperty('stations-circle', 'circle-color',
          ['case', ['get', 'inRange'], '#888', MCSC_GREY]);
        map.setPaintProperty('stations-circle', 'circle-opacity',
          ['case', ['get', 'inRange'], 1, 0.3]);
        map.setPaintProperty('stations-circle', 'circle-stroke-opacity',
          ['case', ['get', 'inRange'], 1, 0.2]);
        map.setPaintProperty('stations-circle', 'circle-radius',
          ['case', ['get', 'inRange'], 6, 3]);
      }
      if (map.getLayer('stations-label')) {
        map.setPaintProperty('stations-label', 'text-color',
          ['case', dim, '#999', '#222']);
        map.setPaintProperty('stations-label', 'text-opacity',
          ['case', ['get', 'inRange'], 1, 0.4]);
      }
      if (map.getLayer('stations-value')) {
        map.setLayoutProperty('stations-value', 'text-field', valueFieldDimmed(labelMode));
      }
    } catch (e) {
      console.warn('Error updating stations source after load', e);
    }
  }, [stationsGeo, geoWithData, filteredStationsCodes, labelMode]);

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
              onApplyRelief={setReliefRange}
              meteoFilters={meteoFilters}
              onAddFilter={addFilter}
              onUpdateFilter={updateFilter}
              onRemoveFilter={removeFilter}
              agg={agg}
              refDay={refDay}
              maxDays={maxDays}
              altLimits={altLimits}
              // Forest filter reuses the legend's dim state (mcscOff) — the
              // tree filter is a copy of the legend and drives the same tiles.
              filteredForestCodes={mcscOff}
              onApplyForest={setMcscOff}
            />
          )}
        </div>
      )}
      {/* Bottom-left button stack: legend (forest), 3D terrain, station info,
          directions (car) */}
      <div className="bottom-buttons">
        <div
          className={`sel-button forest${showLegend ? ' on' : ''}`}
          title="Llegenda (MCSC)"
          onClick={() => setShowLegend(!showLegend)}
        >
          <FontAwesomeIcon icon={faTree} />
        </div>
        <div
          className={`sel-button terrain3d${showTerrain3D ? ' on' : ''}`}
          title="Terreny 3D"
          onClick={() => setShowTerrain3D(!showTerrain3D)}
        >
          <FontAwesomeIcon icon={faMountainSun} />
        </div>
        {/* Station-info cycle: none → rain → altitude → temp → humidity */}
        <div
          className={`sel-button ${LABEL_CLASSES[labelMode] ?? 'stationinfo'}${labelMode !== 'none' ? ' on' : ''}`}
          title="Valor a les estacions (cap / pluja / altitud / temp / humitat)"
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
      />}
      {showLegend && (
        <div className="mcsc-legend">
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
        </div>
      )}
    </div>
  );
}

export default App;