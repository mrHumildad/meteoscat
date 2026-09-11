// Directions modal: pick a map point with the car button armed → an area
// analysis card split over tabs (info / stations), with the point actions
// (close, Google Maps, save) always visible.
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import DirectionsModal from './DirectionsModal.jsx';

describe('DirectionsModal', () => {
  it('renders nothing without a picked point', () => {
    expect(renderToString(React.createElement(DirectionsModal, { point: null }))).toBe('');
  });

  it('shows the picked coordinates, altitude and both actions', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
    }));
    expect(html).toContain('41.90000');
    expect(html).toContain('1.90000');
    expect(html).toContain('512 m');
    expect(html).toContain('Com hi arribo (Google Maps)');
    expect(html).toContain('Tanca');
  });

  it('shows a placeholder while the DEM sample is still pending', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: null, pending: true },
    }));
    expect(html).toContain('…');
    expect(html).not.toContain('512 m');
  });

  it('shows the km from my location on the Google Maps button', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 300, pending: false },
      distanceKm: 12.34,
    }));
    expect(html).toContain('Com hi arribo · 12.3 km');
  });

  it('opens on the info tab and offers a tab per panel', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
    }));
    expect(html).toContain('directions-tabs');
    expect(html).toContain('role="tab"');
    // Three tabs (info, filters, stations); only the first one is selected.
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    // Both tab buttons carry their label as a tooltip; React escapes the
    // apostrophe in the info one, so the stations title is the stable check.
    expect(html).toContain('Estacions i pobles més propers');      // The stations PANEL is not rendered until its tab is picked.
    expect(html).not.toContain('directions-station');
  });

  it('measures the area against the active filter and the saved presets', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      initialTab: 'filters',
      areaAnalysis: {
        activeConfig: { reliefRange: [800, 1500], meteoFilters: [], forestOff: [], geoOff: [] },
        savedPresets: [{
          name: 'Bolets alts',
          config: { reliefRange: [1000, 2000], meteoFilters: [], forestOff: [], geoOff: [] },
        }],
      },
    }));
    // React escapes the apostrophe in text, so the stable part is asserted.
    expect(html).toContain('que compleixen cada filtre');
    // The disc is sampled in an effect, so SSR shows its first frame.
    expect(html).toContain('Comprovant els filtres…');
  });

  it('offers the filter tab even when there is nothing to match against', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      initialTab: 'filters',
    }));
    expect(html).toContain('Cap filtre aplicat ni desat.');
  });

  it('lists the nearest stations with distance, direction, poble and comarca', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 300, pending: false },
      initialTab: 'stations',
      nearest: [
        { code: 'D7', name: 'Vinebre', municipi: 'Vinebre', comarca: 'Ribera', distanceKm: 0.82, direction: 'NE' },
        { code: 'D1', name: 'Margalef', municipi: 'Margalef', comarca: 'Priorat', distanceKm: 3.4, direction: 'O' },
      ],
    }));
    expect(html).toContain('Estacions i pobles més propers');
    expect(html).toContain('Vinebre');
    // React separates text nodes with a comment, so ``0.8<!-- --> km``.
    expect(html).toContain('0.8<!-- --> km');
    expect(html).toContain('NE');
    expect(html).toContain('Ribera');
    expect(html).toContain('3.4<!-- --> km');
    expect(html).toContain('Priorat');
    // The stations tab replaces the area panels rather than adding to them.
    expect(html).not.toContain('directions-radius-slider');
  });

  it('says so when no station is anywhere near', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 300, pending: false },
      initialTab: 'stations',
    }));
    expect(html).toContain('Cap estació a prop.');
  });

  it('analyses the point as an area: single-value radius slider (500 m – 2.5 km, 100 m steps)', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      radius: 1500,
    }));
    expect(html).toContain('directions-radius-slider');
    expect(html).toContain('min="500"');
    expect(html).toContain('max="2500"');
    expect(html).toContain('step="100"');
    expect(html).toContain('value="1500"');
    // 500 m – 2.5 km shown in km, one decimal max. React separates the text
    // nodes with a comment, so ``1.5<!-- --> km``.
    expect(html).toContain('1.5<!-- --> km');
  });

  it('puts the altitude profile of the surrounding area under the radius', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      radius: 1000,
    }));
    // The profile samples the DEM in an effect, so SSR shows its first frame.
    expect(html).toContain('Altituds dins del radi');
    expect(html).toContain('Mostrejant el terreny');
  });

  it('breaks the area down into substrate and land-cover blocks', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      radius: 1000,
    }));
    // Same block shape as the station panel (icon + value + bars chart).
    expect(html).toContain('st-block');
    expect(html).toContain('Substrat');
    expect(html).toContain('Cobertes del sòl');
    // Without the geology grid and before the MCSC tiles arrive, both blocks
    // say so instead of drawing an empty chart.
    expect(html).toContain('Mapa geològic no disponible');
  });

  it('offers saving the picked point as a named location', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 512, pending: false },
      nearest: [{ code: 'D7', name: 'Vinebre', municipi: 'Vinebre', distanceKm: 0.82 }],
      onSaveLocation: () => {},
    }));
    expect(html).toContain('Desa aquest lloc');
  });
});
