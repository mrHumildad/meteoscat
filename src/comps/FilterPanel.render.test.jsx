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
  it('renders the applied orientation selection', () => {
    const html = renderToString(React.createElement(FilterPanel, {
      ...baseProps,
      aspectSectors: ['N', 'NE'],
    }));
    // React splits the interpolated list into text nodes, so strip its SSR
    // comment separators before matching the sentence.
    const text = html.replace(/<!-- -->/g, '');
    expect(text).toContain('Orientació');
    expect(text).toContain('només N · NE');
  });

  it('renders with no orientation filter', () => {
    const html = renderToString(React.createElement(FilterPanel, baseProps));
    expect(html).toContain('Filtres');
    expect(html).not.toContain('Orientació');
  });
});
