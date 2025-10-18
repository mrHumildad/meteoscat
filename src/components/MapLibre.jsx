import * as React from 'react';
import Map from '@vis.gl/react-maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';

const MapLibre = ()  => {
  const [styleUrl, setStyleUrl] = React.useState('https://demotiles.maplibre.org/style.json');

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

  const onMapLoad = async (evt) => {
    const map = evt?.target || evt?.map || evt;
    if (!map || typeof map.addSource !== 'function') return;

    // constrain view
    map.setMaxBounds(bounds);
    map.setMinZoom(minZoom);
    map.setMaxZoom(maxZoom);
    map.jumpTo({ center, zoom: minZoom + 1 });

    // load stations GeoJSON from public/data/stations.geojson
    const geojsonPath = '/data/stations.geojson';
    console.log('Map: loading geojson', geojsonPath);
    try {
      const res = await fetch(geojsonPath);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const geo = await res.json();
      console.log('Map: geojson loaded features:', (geo.features && geo.features.length) || 0);

      if (!map.getSource('stations')) {
        map.addSource('stations', { type: 'geojson', data: geo });
      } else {
        map.getSource('stations').setData(geo);
      }

      // circle layer for points
      if (!map.getLayer('stations-circle')) {
        map.addLayer({
          id: 'stations-circle',
          type: 'circle',
          source: 'stations',
          paint: {
            'circle-radius': 6,
            'circle-color': '#1f78b4',
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1
          }
        });
      }

      // label layer using station name (nom)
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
          paint: {
            'text-color': '#222'
          }
        });
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

    } catch (err) {
      console.warn('Map: could not load stations geojson', err);
    }
  };

  return (
    <div>
      <div style={{ position: 'absolute', zIndex: 10, left: 12, top: 12, background: 'rgba(255,255,255,0.9)', padding: 8, borderRadius: 6 }}>
        <label style={{ marginRight: 8, fontSize: 12 }}>Style:</label>
        <select
          value={styleUrl}
          onChange={e => setStyleUrl(e.target.value)}
          style={{ fontSize: 12 }}
        >
          {STYLES.map(s => <option key={s.url} value={s.url}>{s.name}</option>)}
        </select>
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