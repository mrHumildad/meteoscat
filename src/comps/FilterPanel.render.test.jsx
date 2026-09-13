// Smoke test: the Orientació (slope aspect) filter surfaces in the panel.
// renderToString catches render-time ReferenceErrors / bad JSX in the new
// block without needing a DOM; the interactive editor opens on a click and is
// therefore out of reach here (no jsdom in this project).
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import FilterPanel from './FilterPanel.jsx';

// The panel takes a lot of props; only the orientation ones matter here, the
// rest stay inert so the render exercises the header + filter row list.
const baseProps = {
  onClose: () => {},
  reliefRange: null,
  onApplyRelief: () => {},
  aspectSectors: null,
  onApplyAspect: () => {},
  meteoFilters: [],
  onAddFilter: () => {},
  onUpdateFilter: () => {},
  onRemoveFilter: () => {},
  agg: null,
  refDay: null,
  maxDays: 0,
  altLimits: null,
  filteredForestCodes: new Set(),
  onApplyForest: () => {},
  lithoLegend: [],
  geoOff: new Set(),
  onApplyGeo: () => {},
  boletFilter: null,
  onApplyBolet: () => {},
  onSaveFilter: () => {},
};

describe('FilterPanel — Orientació', () => {
  it('renders the applied orientation selection as a tiny graphic disc', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      aspectSectors: ['N', 'NE'],
    }));
    expect(html).toContain('Orientació');
    // The selection is drawn, not spelled out: no letter summary, and exactly
    // two of the eight mini wedges are picked (N, NE).
    expect(html).not.toContain('només N');
    expect(html).toContain('aspect-mini');
    expect(html.match(/aspect-mini-wedge on/g)).toHaveLength(2);
  });

  it('renders with no orientation filter', () => {
    const html = renderToString(React.createElement(FilterPanel, baseProps));
    expect(html).toContain('Filtres');
    expect(html).not.toContain('Orientació');
  });

  it('renders a meteo instance with its type icon and mute toggle', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      meteoFilters: [{ id: 'f1', type: 'rain', from: 10, to: 0, range: [1, 5], enabled: true }],
    }));
    const text = html.replace(/<!-- -->/g, '');
    // The variable NAME is replaced by its icon, so no "Pluja" label remains.
    expect(text).not.toContain('Pluja');
    expect(html).toContain('noun-icon');
    expect(html).toContain('filter-instance-toggle');
    expect(html).toContain('Desactiva el filtre');
  });

  it('marks a muted instance with the hidden icon', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      meteoFilters: [{ id: 'f1', type: 'rain', from: 10, to: 0, range: [1, 5], enabled: false }],
    }));
    expect(html).toContain('filter-row muted');
    expect(html).toContain('filter-instance-toggle off');
    expect(html).toContain('Activa el filtre');
  });

  it('renders the newest meteo filter first (editor always at the top)', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      meteoFilters: [
        { id: 'f1', type: 'rain', from: 10, to: 0, range: [1, 5], enabled: true },
        { id: 'f2', type: 'temp', from: 10, to: 0, range: [10, 20], enabled: true },
      ],
    }));
    const iTemp = html.indexOf('filter-instance-icon temp');
    const iRain = html.indexOf('filter-instance-icon rain');
    expect(iTemp).toBeGreaterThan(-1);
    expect(iRain).toBeGreaterThan(-1);
    expect(iTemp).toBeLessThan(iRain); // last added (temp) renders on top
  });

  it('renders every applied filter with the shared row schema', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      reliefRange: [100, 600],
      aspectSectors: ['N'],
      filteredForestCodes: new Set(),
      geoOff: new Set(),
      boletFilter: { species: 'ceps', threshold: 0.5 },
    }));
    // One row per applied filter, each with its badge icon, an eye toggle and
    // a value; the aspect row additionally carries the mini disc.
    expect(html.match(/filter-row-value/g)).toHaveLength(2); // relief + bolets
    expect(html).toContain('100 - 600 m');
    expect(html).toContain('aspect-mini');
  });
});
