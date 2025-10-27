import * as React from 'react';
import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useState, useEffect, useRef } from 'react';
import { refineData } from './logic/refineData.js'
import { getDaysInRange, fmt, daysCount} from './logic/utils.js';
import './App.css'
import { computeGeoValues } from './logic/computeGeoValues.js';
import Selectors from './comps/Selectors.jsx';
import StationPanel from './comps/StationPanel.jsx';
const data = refineData()
const days = Object.keys(data);
const stationsCodes = Object.keys(data[days[0]] || {})
const maxDate = days.length ? new Date(days[0]) : null;
const minDate = days.length ? new Date(days[days.length - 1]) : null;

// Catalonia bounding box (west,south) , (east,north)
const bounds = [[-1.0, 40.0], [4.0, 44.0]];
const center = [1.9, 41.9];
const minZoom = 7;
const maxZoom = 15;
const App = ()  => {
  const [styleUrl, setStyleUrl] = React.useState('https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json');
  const [selectedStation, setSelectedStation] = useState(null);
  const [daysRange, setDaysRange] = useState(minDate ? { from: minDate } : null);
  const [selectedVariable, setSelectedVariable] = useState('precAcc');
  const [stationsGeo, setStationsGeo] = useState(null);
  const [geoWithData, setGeoWithData] = useState(null);
  const mapRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    const path = '/data/stations.geojson';
    fetch(path)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(geo => { if (mounted) setStationsGeo(geo); })
      .catch(err => { console.warn('Could not load stations.geojson', err); });
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

    // add source & layers but don't rely on avg yet
    if (stationsGeo) {
      if (!map.getSource('stations')) {
        map.addSource('stations', { type: 'geojson', data: stationsGeo });
      } else {
        map.getSource('stations').setData(stationsGeo);
      }
    }

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
          'text-field': [
            'case',
            ['==', ['get', selectedVariable], null],
            '',
            ['to-string', ['get', selectedVariable]]
          ],
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
    });

    map.on('mouseenter', 'stations-circle', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'stations-circle', () => map.getCanvas().style.cursor = '');
  };

  // 1️⃣ Compute geoWithData
  useEffect(() => {
    if (!stationsGeo) return;
    const from = daysRange?.from ?? null;
    const to = daysRange?.to ?? from;
    const daysInRange = getDaysInRange(data, from, to);
    const computed = computeGeoValues(stationsGeo, data, daysInRange);
    setGeoWithData(computed);
  }, [daysRange, stationsGeo, selectedVariable]);

  // 2️⃣ Update map once geoWithData is ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geoWithData) return;

    try {
      if (map.getSource('stations')) {
        map.getSource('stations').setData(geoWithData);
      } else {
        map.addSource('stations', { type: 'geojson', data: geoWithData });
      }
    } catch (e) {
      console.warn('Error updating stations source data', e);
    }

    const values = (geoWithData?.features || [])
      .map(f => f.properties?.[selectedVariable])
      .filter(v => v !== null && typeof v === 'number');

    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;

    const colorExpr = [
      'case',
      ['==', ['get', selectedVariable], null], '#999',
      ['interpolate', ['linear'], ['get', selectedVariable],
        min, '#2ca02c',
        (min + max) / 2, '#ffcc00',
        max, '#d62728'
      ]
    ];

    const radiusExpr = [
      'case',
      ['==', ['get', selectedVariable], null], 4,
      ['interpolate', ['linear'], ['get', selectedVariable],
        min, 4,
        max, 12
      ]
    ];

    if (map.getLayer('stations-value')) {
      try {
        map.setLayoutProperty('stations-value', 'text-field', [
          'case',
          ['==', ['get', selectedVariable], null],
          '',
          ['to-string', ['get', selectedVariable]]
        ]);
      } catch (e) {
        console.warn('Could not update text-field for stations-value', e);
      }
    }

    if (map.getLayer('stations-circle')) {
      try {
        map.setPaintProperty('stations-circle', 'circle-color', colorExpr);
        map.setPaintProperty('stations-circle', 'circle-radius', radiusExpr);
      } catch (e) {
        console.warn('Could not set paint properties', e);
      }
    }
  }, [geoWithData, selectedVariable]);

  const daysNum = daysCount(daysRange);
  const log = `dades de ${daysNum} dies i ${stationsCodes.length} estacions loaded. Variable mostrada: ${selectedVariable}. Selected: ${fmt(daysRange?.from)} -> ${fmt(daysRange?.to)}`;
  console.log(geoWithData)

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

  return (
    <div>
      {log}
      <Selectors
        styleUrl={styleUrl}
        setStyleUrl={setStyleUrl}
        selectedVariable={selectedVariable}
        setSelectedVariable={setSelectedVariable}
        daysRange={daysRange}
        handleSelect={handleSelect}
        minDate={minDate}
        maxDate={maxDate}
      />  
      <Map
        key={styleUrl}
        initialViewState={{
          longitude: center[0],
          latitude: center[1],
          zoom: minZoom + 1
        }}
        style={{ width: '90vw', height: '80vh' }}
        mapStyle={styleUrl}
        onLoad={onMapLoad}
      />
      <StationPanel
        station={stationObj}
        daysRange={daysRange}
        data={data}
      />
    </div>
  );
}

export default App;
