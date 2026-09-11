// Smoke test: App must render to markup without throwing (catches bad
// imports, render-time ReferenceErrors, broken hooks order, etc.).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderToString } from 'react-dom/server';
import React from 'react';
import App from './App.jsx';

afterEach(() => vi.unstubAllGlobals());

describe('App smoke render', () => {
  it('renders without throwing', () => {
    let html;
    expect(() => { html = renderToString(React.createElement(App)); }).not.toThrow();
    expect(html).toContain('MeteoSeps');
  });

  it('explains the failure instead of mounting the map when WebGL2 is unavailable', () => {
    // A browser that refuses the WebGL2 context (hardware acceleration off,
    // Chromium's software fallback removed) must get the notice, not a blank
    // canvas — and the map-only controls must be hidden with it.
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
    const html = renderToString(React.createElement(App));
    expect(html).toContain('No es pot mostrar el mapa');
    expect(html).toContain('WebGL2');
    expect(html).toContain('no-webgl');
  });
});