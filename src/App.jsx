import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import logo from './assets/logo.png';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faDroplet, faFilter, faMountainSun, faRulerVertical, faSeedling, faTemperatureLow, faTree } from '@fortawesome/free-solid-svg-icons';
import { useState, useEffect, useRef, useMemo } from 'react';
import { loadAvailableDays, loadSummaries } from './logic/refineData.js'
import { getDaysInRange, fmt, daysCount, fmtDayCat, fmtDateCat, parseDay } from './logic/utils.js';
import './App.css'

import { computeGeoValues } from './logic/computeGeoValues.js';
import { MCSC_LEGEND, MCSC_GREY, MCSC_WATER_COLOR, renderMcscSld } from './logic/mcscLegend.js';
import { ELEVATION_TILES, ELEVATION_ATTRIBUTION, sampleElevation } from './logic/elevation.js';
import { registerAltitudeProtocol } from './logic/altitudeOverlay.js';
import { registerMeteoProtocol } from './logic/meteoOverlay.js';
import { registerSeaProtocol } from './logic/seaOverlay.js';
// import Selectors from './comps/Selectors.jsx'; // commented out — kept as reference while rebuilding the filter section
import FilterPanel from './comps/FilterPanel.jsx';
import StationPanel from './comps/StationPanel.jsx';

// Catalonia bounding box (west,south) , (east,north)
const bounds = [[-1.0, 40.0], [4.0, 44.0]];
const center = [1.9, 41.9];
const minZoom = 7;
const maxZoom = 15;

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

// Hex colour (no '#') for the open sea, matching the MCSC water class — and
// greying out with it when the Aigües legend entry is dimmed, so the sea
// behaves exactly like the rest of the water terrain.
const seaColorHex = (offCodes) => {
  const aigues = MCSC_LEGEND.find(e => e.label.startsWith('Aigües'));
  return (aigues && offCodes.has(aigues.codes) ? MCSC_GREY : MCSC_WATER_COLOR).slice(1);
};

// Meteo area filters: rain/humidity/temperature station values interpolated
// onto a continuous field (meteoGrid.js) and served through the meteo://
// protocol — one raster layer per variable so active bands stack on the map.
const METEO_VARS = [
  { variable: 'precAcc', key: 'rain' },
  { variable: 'humAvg', key: 'hum' },
  { variable: 'tempAvg', key: 'temp' },
];

// ICGC/CREAF MCSC land-cover map (cobertes-sol, layer cobertes_2024), served
// as raster tiles straight to the browser (CORS enabled). CC BY 4.0 — the
// attribution below is injected into the map's attribution control via the
// raster source.
const MCSC_WMS_TILES =
  'https://geoserveis.icgc.cat/servei/catalunya/cobertes-sol/wms?' +
  'service=WMS&version=1.1.1&request=GetMap&layers=cobertes_2024&styles=&' +
  'format=image/png&transparent=true&srs=EPSG:3857&width=256&height=256&' +
  'bbox={bbox-epsg-3857}';
const MCSC_ATTRIBUTION =
  'Mapa de Cobertes del Sòl de Catalunya (MCSC) v1.0 — ICGC & CREAF, ' +
  'layer cobertes_2024 — CC BY 4.0 — http://www.icgc.cat';

// The MCSC raster is a palette map: each pixel holds an integer band value
// (the WMS exposes it as "class = '<classCode>. (<band>) <name>'", e.g.
// '342. (22) Eixample'). Bands follow MCSC class-code order, so every legend
// entry's band values are hard-coded in mcscLegend.js. The legend doubles as
// a switch panel: the layer's SLD is rebuilt on every toggle, colouring the
// selected classes with their official colours and the dimmed ones (plus band
// values with no legend entry) with a single shared grey.
const App = ()  => {
  // Map style — Stadia free tier (no API key). PROD alternative kept:
  // 'https://demotiles.maplibre.org/style.json'   // public, no key
  const styleUrl = 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json';
  const [selectedStation, setSelectedStation] = useState(null);
  const [days, setDays] = useState([]);
  const [data, setData] = useState(null);
  const [minDate, setMinDate] = useState(null);
  const [maxDate, setMaxDate] = useState(null);
  const [daysRange, setDaysRange] = useState(null);
  const [labelMode, setLabelMode] = useState('humAvg'); // station-circle info: 'none' | 'precAcc' | 'altitud' | 'tempAvg' | 'humAvg'
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showLegend, setShowLegend] = useState(false);           // MCSC legend panel (overlay is always on)
  const [showTerrain3D, setShowTerrain3D] = useState(true);     // 3D terrain (tilts the camera)
  const [mapReady, setMapReady] = useState(false); // true once onMapLoad has added every layer
  const [mcscOff, setMcscOff] = useState(() => new Set()); // codes of dimmed legend entries
  const [filteredStationsCodes, setFilteredStationsCodes] = useState([]);
  const [rangeLimits, setRangeLimits] = useState(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [clickedElevation, setClickedElevation] = useState(null); // DEM sample, m
  const [showFilter, setShowFilter] = useState(false); // rebuilt filter panel open state
  const [reliefRange, setReliefRange] = useState(null); // applied altitude filter [lo, hi]; null = off
  const [rainRange, setRainRange] = useState(null);     // applied rain band [lo, hi]; null = off
  const [humRange, setHumRange] = useState(null);       // applied humidity band [lo, hi]; null = off
  const [tempRange, setTempRange] = useState(null);     // applied temperature band [lo, hi]; null = off
  // The altitude-band overlay state is derived from the applied relief range.
  const altBand = reliefRange;
  const mapRef = useRef(null);
  const dataReqRef = useRef(0);
  const selectedStationRef = useRef(null); // stale-guard for async takeElevation
  const altBandRef = useRef(null); // band read by the alt:// tile protocol
  const windowKeyRef = useRef(''); // data-window key read by the meteo:// tile protocol
  const geoWithDataRef = useRef(null); // latest features read by the meteo:// tile protocol

  // SLD-classified tile URL for the MCSC raster, rebuilt whenever a legend
  // switch dims / restores a class (unselected and unlisted band values grey).
  const mcscTiles = useMemo(() => {
    const sld = renderMcscSld(MCSC_LEGEND, mcscOff);
    return `${MCSC_WMS_TILES}&SLD_BODY=${encodeURIComponent(sld)}`;
  }, [mcscOff]);

  // Applied area filters, memoized so FilterPanel's sync effect doesn't
  // re-run on every App render (object identity is part of its deps).
  const areaRanges = useMemo(
    () => ({ relief: reliefRange, rain: rainRange, hum: humRange, temp: tempRange }),
    [reliefRange, rainRange, humRange, tempRange]
  );
  // Stable feature list for the same data window (the `?? []` fallback would
  // otherwise create a new array on every render).
  const stationsFeatures = useMemo(() => geoWithData?.features ?? [], [geoWithData]);

  // 0️⃣ Load the list of available days once, then open on the first day
  useEffect(() => {
    let mounted = true;
    loadAvailableDays()
      .then(availableDays => {
        if (!mounted) return;
        if (!availableDays.length) throw new Error('No data available');
        setDays(availableDays);
        // index.json is oldest-first: minDate = first, maxDate = last
        // parseDay → local midnight, so calendar cells and disabled checks agree
        setMinDate(parseDay(availableDays[0]));
        setMaxDate(parseDay(availableDays[availableDays.length - 1]));
        setDaysRange({ from: parseDay(availableDays[0]) });
      })
      .catch(err => {
        if (!mounted) return;
        console.error('Could not load day index:', err.message);
        setLoadError(err.message);
        setDataLoading(false);
      });
    return () => { mounted = false };
  }, []);

  // 0.5️⃣ Fetch daily summaries for the visible window whenever it changes
  useEffect(() => {
    if (!days.length || !daysRange?.from) return;
    const from = new Date(daysRange.from); from.setHours(0, 0, 0, 0);
    const to = daysRange.to ? new Date(daysRange.to) : from; to.setHours(0, 0, 0, 0);
    const reqId = ++dataReqRef.current;
    console.log(`Fetching summaries for ${fmt(from)} -> ${fmt(to)}`);
    setDataLoading(true);
    loadSummaries(days, fmt(from), fmt(to))
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
  }, [days, daysRange, minDate, maxDate]);

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

    // MCSC land-cover overlay, below the stations: a single SLD-classified
    // raster where selected classes render in their official colours and
    // dimmed ones (plus unlisted band values) render in a shared grey.
    const addMcscLayer = (tiles) => {
      if (!map.getSource('mcsc')) {
        map.addSource('mcsc', {
          type: 'raster',
          tiles: [tiles],
          tileSize: 256,
          minzoom: 7,
          maxzoom: 14,
          attribution: MCSC_ATTRIBUTION
        });
      }
      if (!map.getLayer('mcsc')) {
        map.addLayer({
          id: 'mcsc',
          type: 'raster',
          source: 'mcsc',
          layout: { visibility: 'visible' }, // the MCSC overlay is always on
          paint: { 'raster-opacity': 0.85 }
        }, 'stations-circle');
      }
    };
    addMcscLayer(mcscTiles);

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

    // Altitude-band area overlay: client-classified terrarium tiles served
    // through the custom `alt://` protocol. In-band ⟶ transparent (the map
    // shows through), out-of-band ⟶ the same grey as unselected MCSC classes;
    // the band comes from the relief slider via altBandRef so tiles
    // regenerate only on band change.
    registerAltitudeProtocol(map, () => altBandRef.current);
    if (!map.getSource('altitude-band')) {
      map.addSource('altitude-band', {
        type: 'raster',
        tiles: ['alt://{z}/{x}/{y}?b=off'],
        tileSize: 256,
        minzoom: 7,
        maxzoom: 15
      });
    }
    if (!map.getLayer('altitude-band')) {
      // Inserted BELOW the hillshade so the grey mask keeps the relief shading
      // on top — exactly how dimmed MCSC legend classes look (grey + relief).
      map.addLayer({
        id: 'altitude-band',
        type: 'raster',
        source: 'altitude-band',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.85 } // transparent in-band pixels + grey mask
      }, 'hillshade');
    }

    // Meteo area overlays (rain/humidity/temp): station values interpolated
    // per pixel through the custom `meteo://` protocol, one raster layer per
    // variable so active bands stack. Same mask semantics as the altitude
    // band (in-band transparent, out-of-band grey, sea transparent); the
    // variable, data window and band come from the tile URL, so tiles
    // regenerate only when a band or the data window changes.
    registerMeteoProtocol(map, () => ({
      windowKey: windowKeyRef.current,
      features: geoWithDataRef.current?.features ?? [],
    }));
    METEO_VARS.forEach(({ variable }) => {
      const bandId = `${variable}-band`;
      if (!map.getSource(bandId)) {
        map.addSource(bandId, {
          type: 'raster',
          tiles: ['meteo://{z}/{x}/{y}?v=off'],
          tileSize: 256,
          minzoom: 7,
          maxzoom: 15
        });
      }
      if (!map.getLayer(bandId)) {
        // Inserted BELOW the hillshade, like the altitude band, so the grey
        // mask keeps the relief shading on top.
        map.addLayer({
          id: bandId,
          type: 'raster',
          source: bandId,
          layout: { visibility: 'none' },
          paint: { 'raster-opacity': 0.85 }
        }, 'hillshade');
      }
    });

    // Sea overlay: paints the ocean (elevation <= 0, from the same DEM the
    // relief uses) with the water colour. It sits ABOVE the hillshade — which
    // would otherwise render the flat/bathy sea grey — and BELOW the MCSC
    // layer, so the land-cover water class draws on top with the same colour.
    registerSeaProtocol();
    if (!map.getSource('sea')) {
      map.addSource('sea', {
        type: 'raster',
        tiles: [`sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff)}`],
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
      }, 'mcsc');
    }

    map.on('click', 'stations-circle', (e) => {
      if (!e.features || !e.features.length) return;
      const f = e.features[0];
      const coords = f.geometry.coordinates.slice();
      const code = f.properties?.codi ?? 'unknown';
      console.log('Clicked station', code, f.properties);
      //console.log({...stationsGeo.features.find(s => s.properties?.codi === code), data: Object.keys(data).map(day => data[day]?.[code] || null)});   
      //console.log(geoWithData)

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

    map.on('mouseenter', 'stations-circle', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'stations-circle', () => map.getCanvas().style.cursor = '');

    // layers are all in place now — let the terrain effect apply the initial
    // (default-on) 3D state, since it can't run before the map exists
    setMapReady(true);
  };

  // 1️⃣ Compute geoWithData
  useEffect(() => {
    if (!stationsGeo || !data) return;
    const from = daysRange?.from ?? null;
    const to = daysRange?.to ?? from;
    const daysInRange = getDaysInRange(data, from, to);
    const computed = computeGeoValues(stationsGeo, data, daysInRange);
    setGeoWithData(computed);
    const allTemps = [];
    const allRains = [];
    const allHums = [];
    const allAlts = [];
    computed.features.forEach(f => {
      const temp = Number(f.properties?.tempAvg);
      const rain = Number(f.properties?.precAcc);
      const hum  = Number(f.properties?.humAvg);
      const alt  = Number(f.properties?.altitud);
          
      if (!isNaN(temp) && temp !== 0) allTemps.push(temp);
      if (!isNaN(rain)) allRains.push(rain);
      if (!isNaN(hum) && hum !== 0) allHums.push(hum);
      if (Number.isFinite(alt)) allAlts.push(alt);
    });

    setRangeLimits({
      tempMin: Math.min(...allTemps),
      tempMax: Math.max(...allTemps),
      rainMin: Math.min(...allRains),
      rainMax: Math.max(...allRains),
      humMin: Math.min(...allHums),
      humMax: Math.max(...allHums),
      altMin: Math.min(...allAlts),
      altMax: Math.max(...allAlts),
    });
  }, [daysRange, stationsGeo, data]);

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

  // 2.7️⃣ Rebuild the MCSC raster tiles when a legend switch dims / restores a
  // class (each switch state produces a different SLD_BODY URL).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('mcsc');
    if (src && typeof src.setTiles === 'function') {
      src.setTiles([mcscTiles]);
    }
  }, [mcscTiles]);

  // 2.7.1️⃣ Keep the open sea in sync with the Aigües legend switch: blue by
  // default, grey when the water class is dimmed (so the sea behaves exactly
  // like the rest of the water terrain). The colour bakes into the tile URL,
  // regenerating the overlay tiles on each change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('sea')) return;
    map.getSource('sea').setTiles([`sea://{z}/{x}/{y}?c=${seaColorHex(mcscOff)}`]);
  }, [mcscOff]);

  // keep the latest selected station in a ref so async DEM samples can check
  // they still match the station the user last clicked
  useEffect(() => { selectedStationRef.current = selectedStation; }, [selectedStation]);

  // keep the altitude band in a ref so the alt:// tile protocol can read it
  useEffect(() => { altBandRef.current = altBand; }, [altBand]);

  // keep the current data window + features in refs so the meteo:// tile
  // protocol can (re)build its interpolation grid for the right window
  useEffect(() => {
    windowKeyRef.current = daysRange?.from
      ? `${fmt(daysRange.from)}-${fmt(daysRange.to ?? daysRange.from)}`
      : '';
  }, [daysRange]);
  useEffect(() => { geoWithDataRef.current = geoWithData; }, [geoWithData]);

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

  // 2.10️⃣ Altitude-band overlay: visible only while the altitude slider is
  // narrowed below its full span; the band bakes into the tile URL so each
  // change regenerates the classified tiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getSource('altitude-band')) return;
    const active = !!altBand && !!rangeLimits &&
      (altBand[0] !== rangeLimits.altMin || altBand[1] !== rangeLimits.altMax);
    map.setLayoutProperty('altitude-band', 'visibility', active ? 'visible' : 'none');
    map.getSource('altitude-band').setTiles([
      active ? `alt://{z}/{x}/{y}?b=${altBand[0]}-${altBand[1]}` : 'alt://{z}/{x}/{y}?b=off'
    ]);
  }, [altBand, rangeLimits]);

  // 2.11️⃣ Meteo bands: one raster layer per variable, visible only while its
  // slider is narrowed below the full span. Variable, data window and band
  // bake into the tile URL so each change regenerates the classified tiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const w = windowKeyRef.current;
    const bandOf = { rain: rainRange, hum: humRange, temp: tempRange };
    for (const { variable, key } of METEO_VARS) {
      const bandId = `${variable}-band`;
      if (!map.getSource(bandId)) continue;
      const band = bandOf[key];
      const active = !!band && !!rangeLimits &&
        (band[0] !== rangeLimits[`${key}Min`] || band[1] !== rangeLimits[`${key}Max`]);
      map.setLayoutProperty(bandId, 'visibility', active ? 'visible' : 'none');
      map.getSource(bandId).setTiles([
        active
          ? `meteo://{z}/{x}/{y}?v=${variable}&w=${w}&b=${band[0]}_${band[1]}`
          : 'meteo://{z}/{x}/{y}?v=off'
      ]);
    }
  }, [rainRange, humRange, tempRange, rangeLimits, daysRange]);

  // 2️⃣ Update map once geoWithData is ready (and apply the slider filter).
  // All stations stay in the source; out-of-range ones carry inRange=false and
  // are dimmed to MCSC_GREY (same grey as deselected terrain classes) instead
  // of being removed, so you can see what's being filtered out.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      // prefer geoWithData (computed averages) when available
      const dataToSet = geoWithData || stationsGeo;
      if (!dataToSet) return;
      // filtering is active only once a slider has been narrowed (non-empty list)
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

  //const daysNum = daysCount(daysRange);
  let headerdays = fmtDayCat(daysRange?.from)
  if (daysRange?.to && daysRange.to.getTime() !== daysRange.from.getTime()) {
    headerdays += ` - ${fmtDayCat(daysRange?.to)}`;
  }
  const headerDayCount = daysCount(daysRange) > 1 ? ` (${daysCount(daysRange)} dies)` : '';
  // latest available data day (index.json is oldest-first) + staleness hint
  const latestDate = days.length ? new Date(days[days.length - 1]) : null;
  const dataStale = latestDate ? (Date.now() - latestDate.getTime()) / 86400000 > 1 : false;

  //console.log(geoWithData)

  const handleSelect = (range) => {
    if (!range) { setDaysRange(null); return; }
    let from = range.from ? new Date(range.from) : null;
    let to = range.to ? new Date(range.to) : from;
    if (minDate && from && from < minDate) from = minDate;
    if (maxDate && to && to > maxDate) to = maxDate;
    if (!to || from?.getTime() === to?.getTime()) {
      setDaysRange(from ? { from } : null);
    } else {
      setDaysRange({ from, to });
    }
  };
  const stationObj = selectedStation
  ? geoWithData?.features?.find(f => f.properties.codi === selectedStation)
  : null;
  const applyAreaRange = (key, range) => {
    if (key === 'relief') setReliefRange(range);
    else if (key === 'rain') setRainRange(range);
    else if (key === 'hum') setHumRange(range);
    else if (key === 'temp') setTempRange(range);
  };
  //console.log(rangeLimits)
  return (
    <div className='app'>
      <img  className='logo' src={logo} alt="MetoSeps" />
      {!showCalendar && <div className="app-header">
        <span className='header-title'>MeteoSeps</span>
        <span className='header-days'>{headerdays}</span>
        <span className='header-count'>{headerDayCount}</span>
        {latestDate && (
          <span
            className={`header-updated${dataStale ? ' stale' : ''}`}
            title={`Darreres dades disponibles: ${fmtDateCat(latestDate)}`}
          >
            Últimes dades: {fmtDateCat(latestDate)}
          </span>
        )}
      </div>}
      {/* {log} */}
      {/* Rebuilt filter section: single button toggling the panel */}
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
              onApply={() => setShowFilter(false)}
              rangeLimits={rangeLimits}
              stations={stationsFeatures}
              areaRanges={areaRanges}
              onApplyAreaRange={applyAreaRange}
              // Forest filter reuses the legend's dim state (mcscOff) — the
              // tree filter is a copy of the legend and drives the same tiles.
              filteredForestCodes={mcscOff}
              onApplyForest={setMcscOff}
              setFilteredStationsCodes={setFilteredStationsCodes}
            />
          )}
        </div>
      )}
      {/* Selectors kept as reference while rebuilding the filter section */}
      {/*
      {data && rangeLimits && minDate && maxDate && (
        <Selectors
          setLabelMode={setLabelMode}
          stations={geoWithData?.features ?? []}
          daysRange={daysRange}
          handleSelect={handleSelect}
          minDate={minDate}
          maxDate={maxDate}
          showCalendar={showCalendar} 
          setShowCalendar={setShowCalendar}
          setAltBand={setAltBand}
          rangeLimits={rangeLimits}
          filteredStationsCodes={filteredStationsCodes}
          setFilteredStationsCodes={setFilteredStationsCodes}
        /> 
      )}
      */}
      {/* Bottom-left button stack: legend (forest), 3D terrain, station info */}
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
        daysRange={daysRange}
        data={data}
        setSelectedStation={setSelectedStation}
        elevation={clickedElevation}
      />}
      {showLegend && (
        <div className="mcsc-legend">
          <div className="mcsc-legend-title">Cobertes del sòl (MCSC)</div>
          {/* Info-only legend: dimming terrain types is done from the filter
              panel (Bosc), so these rows are not interactive. They still show
              the current map state — dimmed classes appear grey. */}
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
