// Smoke test: the header ticker renders its first item and disappears when
// there is nothing to show. renderToString runs no effects, so the first item
// is deterministic (no jsdom in this project).
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import HeaderStatus from './HeaderStatus.jsx';

describe('HeaderStatus', () => {
  it('renders the first item inside the app-header', () => {
    const html = renderToString(React.createElement(HeaderStatus, {
      items: ['Filtre A', 'Pluja 4–10 mm · darrers 10 dies'],
    }));
    expect(html).toContain('app-header');
    expect(html).toContain('Filtre A');
    expect(html).not.toContain('Pluja 4–10 mm');
  });

  it('renders nothing when no filter is applied', () => {
    expect(renderToString(React.createElement(HeaderStatus, { items: [] }))).toBe('');
  });
});
