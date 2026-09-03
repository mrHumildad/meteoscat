// Smoke test: App must render to markup without throwing (catches bad
// imports, render-time ReferenceErrors, broken hooks order, etc.).
import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import App from './App.jsx';

describe('App smoke render', () => {
  it('renders without throwing', () => {
    let html;
    expect(() => { html = renderToString(React.createElement(App)); }).not.toThrow();
    expect(html).toContain('MeteoSeps');
  });
});