import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import logo from './assets/logo.png';
import { useState, useEffect, useRef, useMemo } from 'react';
import { loadAvailableDays, loadSummaries } from './logic/refineData.js'
import { getDaysInRange, fmt, daysCount, fmtDayCat, fmtDateCat, parseDay } from './logic/utils.js';
import './App.css'

import { computeGeoValues } from './logic/computeGeoValues.js';
import { MCSC_LEGEND, MCSC_GREY, renderMcscSld } from './logic/mcscLegend.js';
import { ELEVATION_TILES, ELEVATION_ATTRIBUTION, sampleElevation } from './logic/elevation.js';
import { registerAltitudeProtocol } from './logic/altitudeOverlay.js';
import Selectors from './comps/Selectors.jsx';
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
  const [selectedVariable, setSelectedVariable] = useState('humAvg');
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const [showCalendar, setShowCalendar] = useState(false);
  const [showForestOverlay, setShowForestOverlay] = useState(false);
  const [showRelief, setShowRelief] = useState(false);          // flat hillshade
  const [showTerrain3D, setShowTerrain3D] = useState(false);    // 3D terrain
  const [mcscOff, setMcscOff] = useState(() => new Set()); // codes of dimmed legend entries
  const [filteredStationsCodes, setFilteredStationsCodes] = useState([]);
  const [rangeLimits, setRangeLimits] = useState(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [clickedElevation, setClickedElevation] = useState(null); // DEM sample, m
  const [altBand, setAltBand] = useState(null); // [lo, hi] from the altitude slider; null = off
  const mapRef = useRef(null);
  const dataReqRef = useRef(0);
  const selectedStationRef = useRef(null); // stale-guard for async takeElevation
  const altBandRef = useRef(null); // band read by the alt:// tile protocol

  // SLD-classified tile URL for the MCSC raster, rebuilt whenever a legend
  // switch dims / restores a class (unselected and unlisted band values grey).
  const mcscTiles = useMemo(() => {
    const sld = renderMcscSld(MCSC_LEGEND, mcscOff);
    return `${MCSC_WMS_TILES}&SLD_BODY=${encodeURIComponent(sld)}`;
  }, [mcscOff]);

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
          'text-field': valueField(selectedVariable),
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
          layout: { visibility: showForestOverlay ? 'visible' : 'none' },
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
        layout: { visibility: showRelief ? 'visible' : 'none' },
        paint: {
          'hillshade-exaggeration': 0.4,
          'hillshade-illumination-direction': 315
        }
      }, 'stations-circle');
    }

    // Altitude-band area overlay: client-classified terrarium tiles served
    // through the custom `alt://` protocol. In-band ⟶ amber, out-of-band ⟶
    // the same grey as unselected MCSC classes; the band comes from the
    // altitude slider via altBandRef so tiles regenerate only on band change.
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
      map.addLayer({
        id: 'altitude-band',
        type: 'raster',
        source: 'altitude-band',
        layout: { visibility: 'none' },
        paint: { 'raster-opacity': 0.85 }
      }, 'stations-circle');
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
  }, [daysRange, stationsGeo, selectedVariable, data]);

  // 2.5️⃣ Keep the on-circle value labels in sync with the selected variable.
  // MapLibre layout properties are baked in at layer creation, so clicking a
  // variable button must update the layer explicitly — React state alone doesn't.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('stations-value')) return;
    map.setLayoutProperty('stations-value', 'text-field', valueField(selectedVariable));
  }, [selectedVariable]);

  // 2.6️⃣ Toggle the MCSC land-cover overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('mcsc')) return;
    map.setLayoutProperty('mcsc', 'visibility', showForestOverlay ? 'visible' : 'none');
  }, [showForestOverlay]);

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

  // keep the latest selected station in a ref so async DEM samples can check
  // they still match the station the user last clicked
  useEffect(() => { selectedStationRef.current = selectedStation; }, [selectedStation]);

  // keep the altitude band in a ref so the alt:// tile protocol can read it
  useEffect(() => { altBandRef.current = altBand; }, [altBand]);

  // 2.8️⃣ Toggle the hillshade (relief) overlay
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer('hillshade')) return;
    map.setLayoutProperty('hillshade', 'visibility', showRelief ? 'visible' : 'none');
  }, [showRelief]);

  // 2.9️⃣ Toggle 3D terrain (raster-dem source + tilted camera)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (showTerrain3D && map.getSource('elevation-dem')) {
      map.setTerrain({ source: 'elevation-dem', exaggeration: 1.3 });
      map.easeTo({ pitch: 55, bearing: -20, duration: 800 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
    }
  }, [showTerrain3D]);

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

  // 2️⃣ Update map once geoWithData is ready (and apply the slider filter)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    try {
      // prefer geoWithData (computed averages) when available
      const dataToSet = geoWithData || stationsGeo;
      if (!dataToSet) return;
      // only filter once the user narrows a slider (non-empty code list)
      const featureCollection = filteredStationsCodes.length && geoWithData
        ? { ...geoWithData, features: geoWithData.features.filter(f => filteredStationsCodes.includes(f.properties?.codi)) }
        : dataToSet;
      if (map.getSource('stations')) {
        map.getSource('stations').setData(featureCollection);
      } else {
        map.addSource('stations', { type: 'geojson', data: featureCollection });
      }
    } catch (e) {
      console.warn('Error updating stations source after load', e);
    }
  }, [stationsGeo, geoWithData, filteredStationsCodes]);

  //const daysNum = daysCount(daysRange);
  //const log = `dades de ${daysNum} dies i ${stationsCodes.length} estacions loaded. Variable mostrada: ${selectedVariable}. Selected: ${fmtDayCat(daysRange?.from)} -> ${fmtDayCat(daysRange?.to)}`;
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
      {data && rangeLimits && minDate && maxDate && (
        <Selectors
          selectedVariable={selectedVariable}
          setSelectedVariable={setSelectedVariable}
          stations={geoWithData?.features ?? []}
          daysRange={daysRange}
          handleSelect={handleSelect}
          minDate={minDate}
          maxDate={maxDate}
          showCalendar={showCalendar} 
          setShowCalendar={setShowCalendar}
          showForestOverlay={showForestOverlay}
          setShowForestOverlay={setShowForestOverlay}
          showRelief={showRelief}
          setShowRelief={setShowRelief}
          showTerrain3D={showTerrain3D}
          setShowTerrain3D={setShowTerrain3D}
          setAltBand={setAltBand}
          rangeLimits={rangeLimits}
          filteredStationsCodes={filteredStationsCodes}
          setFilteredStationsCodes={setFilteredStationsCodes}
        /> 
      )}
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
      {showForestOverlay && (
        <div className="mcsc-legend">
          <div className="mcsc-legend-title">Cobertes del sòl (MCSC)</div>
          {MCSC_LEGEND.map(entry => {
            const off = mcscOff.has(entry.codes);
            return (
              <button
                type="button"
                key={entry.codes}
                className={`mcsc-legend-row${off ? ' off' : ''}`}
                title={off ? 'Ressaltar' : 'Atenuar'}
                onClick={() => setMcscOff(prev => {
                  const next = new Set(prev);
                  if (next.has(entry.codes)) next.delete(entry.codes);
                  else next.add(entry.codes);
                  return next;
                })}
              >
                <span className="mcsc-legend-swatch" style={{ backgroundColor: off ? MCSC_GREY : entry.color }} />
                <span className="mcsc-legend-label">{entry.label}</span>
              </button>
            );
          })}
          <div className="mcsc-legend-footer">Cliqueu una classe per ressaltar-la o atenuar-la (gris) · ICGC &amp; CREAF · CC BY 4.0</div>
        </div>
      )}
    </div>
  );
}

export default App;
