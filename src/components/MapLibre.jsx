import * as React from 'react';
import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';
import { useState, useEffect, useRef } from 'react';

const MapLibre = ({data})  => {
  const days = Object.keys(data);
  const stationsCodes = Object.keys(data[days[0]] || {})
  const maxDate = days.length ? new Date(days[0]) : null;
  const minDate = days.length ? new Date(days[days.length - 1]) : null;
  const [styleUrl, setStyleUrl] = React.useState('https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json');
  const [selectedStation, setSelectedStation] = useState(null);
  // start with first day selected (range.from). set to null if you want none selected initially
  const [daysRange, setDaysRange] = useState(minDate ? { from: minDate } : null);
  const [selectedVariable, setSelectedVariable] = useState('temperature');
  const mapRef = useRef(null);                // <-- add map ref
  const [stationsGeo, setStationsGeo] = useState(null);

  const STYLES = [
    { name: 'Default (MapLibre demo)', url: 'https://demotiles.maplibre.org/style.json' },
    { name: 'CARTO Dark Matter', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
    { name: 'Stadia Dark', url: 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json' },
    { name: 'CARTO Positron (light)', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' }
  ];

  // Catalonia bounding box (west,south) , (east,north)
  const bounds = [[-1.0, 40.0], [4.0, 44.0]];
  const center = [1.9, 41.9];
  const minZoom = 7;
  const maxZoom = 15;

  // load stations geojson (existing useEffect) ...
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
          'text-field': ['case', ['==', ['get', 'avg'], null], '', ['to-string', ['get', 'avg']]],
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
      }, 'stations-label'); // insert before labels so it appears above circles but below top labels
    }

    // optional: click handler to zoom to station
    map.on('click', 'stations-circle', (e) => {
      if (!e.features || !e.features.length) return;
      const f = e.features[0];
      const coords = f.geometry.coordinates.slice();
      const code = f.properties?.codi ?? 'unknown';
      console.log('Clicked station', code, f.properties);
      map.flyTo({ center: coords, zoom: Math.max(map.getZoom(), 12) });
    });

    // change cursor on hover
    map.on('mouseenter', 'stations-circle', () => map.getCanvas().style.cursor = 'pointer');
    map.on('mouseleave', 'stations-circle', () => map.getCanvas().style.cursor = '');

  };

  // helper: get date keys (strings in data) inside range inclusive
  const getDaysInRange = (from, to) => {
    if (!from) return [];
    const all = Object.keys(data).sort(); // assume YYYY-MM-DD keys
    const f = new Date(from); f.setHours(0,0,0,0);
    const t = to ? new Date(to) : f; t.setHours(0,0,0,0);
    return all.filter(k => {
      const d = new Date(k);
      d.setHours(0,0,0,0);
      return d >= f && d <= t;
    });
  };

  const safeAvg = arr => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const nums = arr.map(n => Number(n)).filter(Number.isFinite);
    if (!nums.length) return null;
    return nums.reduce((a,b) => a+b,0) / nums.length;
  };

  // build a geojson clone with properties.avg for selected variable & range
  const computeGeoWithAverages = (variable, daysInRange) => {
    if (!stationsGeo || !Array.isArray(stationsGeo.features)) return null;
    const features = stationsGeo.features.map(f => {
      const code = f.properties?.codi;
      let allVals = [];
      if (code && daysInRange.length) {
        for (const dayKey of daysInRange) {
          const stationObj = data[dayKey] && data[dayKey][code];
          if (stationObj && Array.isArray(stationObj[variable])) {
            allVals = allVals.concat(stationObj[variable].map(v => (v === null ? NaN : Number(v))));
          }
        }
      }
      const avg = safeAvg(allVals);
      // clone feature and attach avg (rounded to 1 decimal or null)
      return {
        ...f,
        properties: {
          ...f.properties,
          avg: avg === null ? null : Math.round(avg*10)/10
        }
      };
    });
    return { type: 'FeatureCollection', features };
  };

  // update map source and style when daysRange/selectedVariable/stationsGeo change
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !stationsGeo) return;
    const from = daysRange?.from ?? null;
    const to = daysRange?.to ?? from;
    const daysInRange = getDaysInRange(from, to);
    const geoWithAvg = computeGeoWithAverages(selectedVariable, daysInRange);

    // update source data
    try {
      if (map.getSource('stations')) {
        map.getSource('stations').setData(geoWithAvg || stationsGeo);
      } else if (geoWithAvg) {
        map.addSource('stations', { type: 'geojson', data: geoWithAvg });
      }
    } catch (e) {
      console.warn('Error updating stations source data', e);
    }

    // compute min/max of avg for scale (ignore nulls)
    const avgs = (geoWithAvg?.features || []).map(f => f.properties?.avg).filter(v => v !== null && typeof v === 'number');
    const min = avgs.length ? Math.min(...avgs) : 0;
    const max = avgs.length ? Math.max(...avgs) : 1;

    // build color/radius expressions using MapLibre style expressions
    // color: gray for null, otherwise interpolate between green->yellow->red
    const colorExpr = [
      'case',
      ['==', ['get', 'avg'], null], '#999',
      ['interpolate', ['linear'], ['get', 'avg'],
        min, '#2ca02c',
        (min+max)/2, '#ffcc00',
        max, '#d62728'
      ]
    ];
    // radius: null -> 4, otherwise map avg to [4..12]
    const radiusExpr = [
      'case',
      ['==', ['get', 'avg'], null], 4,
      ['interpolate', ['linear'], ['get', 'avg'],
        min, 4,
        max, 12
      ]
    ];

    // set paint properties (layer must exist)
    if (map.getLayer('stations-circle')) {
      try {
        map.setPaintProperty('stations-circle', 'circle-color', colorExpr);
        map.setPaintProperty('stations-circle', 'circle-radius', radiusExpr);
      } catch (e) {
        console.warn('Could not set paint properties', e);
      }
    }
  }, [daysRange, selectedVariable, stationsGeo, mapRef.current]);

  const fmt = d => d ? new Date(d).toISOString().slice(0,10) : '-';

  const daysCount = (() => {
    if (!daysRange || !daysRange.from) return 0;
    const from = new Date(daysRange.from);
    const to = daysRange.to ? new Date(daysRange.to) : from;
    const diffDays = Math.floor((to - from) / (1000 * 60 * 60 * 24)) + 1;
    return diffDays > 0 ? diffDays : 1;
  })();

  const log = `dades de ${daysCount} dies i ${stationsCodes.length} estacions loaded. Variable mostrada: ${selectedVariable}. Selected: ${fmt(daysRange?.from)} -> ${fmt(daysRange?.to)}`;

  // clamp selection to min/max
  const handleSelect = (range) => {
    if (!range) { setDaysRange(null); return; }
    let from = range.from ? new Date(range.from) : null;
    let to = range.to ? new Date(range.to) : from;
    if (minDate && from && from < minDate) from = minDate;
    if (maxDate && to && to > maxDate) to = maxDate;
    // if single day selection, keep only from
    if (!to || from?.getTime() === to?.getTime()) {
      setDaysRange(from ? { from } : null);
    } else {
      setDaysRange({ from, to });
    }
  };

  return (
    <div>
      {log}
      <DayPicker
        mode="range"
        selected={daysRange}
        onSelect={handleSelect}
        showOutsideDays
        modifiers={{ start: daysRange?.from, end: daysRange?.to }}
        disabled={{ before: minDate, after: maxDate }}
      />
      <div >
        <button onClick={() => setSelectedVariable('temperatura')}>Temperatura</button>
        <button onClick={() => setSelectedVariable('precipitacio')}>Precipitació</button>
        <button onClick={() => setSelectedVariable('humitat')}>Humitat</button>
      </div>
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
    </div>
  );
}

export default MapLibre;