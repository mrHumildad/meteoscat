// Directions modal: pick a map point with the car button armed → info card
// with the coordinates / DEM altitude and the two actions (close, Google Maps).
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

  it('lists the nearest stations with distance, direction, poble and comarca', () => {
    const html = renderToString(React.createElement(DirectionsModal, {
      point: { lat: 41.9, lng: 1.9, elevation: 300, pending: false },
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
  });
});
