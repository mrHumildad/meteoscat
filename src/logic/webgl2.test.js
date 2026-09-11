// Unit tests for the WebGL2 capability probe and GPU-failure classification
// (webgl2.js). The probe is what keeps the app from mounting a MapLibre map
// that can never render — v6 is WebGL2-only and Chromium no longer falls back
// to software WebGL — so a false positive here means a blank canvas, and a
// false negative means a working map is replaced by the notice.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { detectWebGL2, isGPUInitializationError } from './webgl2.js';

const stubDocument = createElement => vi.stubGlobal('document', { createElement });

// A document whose canvas returns `context` for webgl2 (and null for anything
// else, so a probe that asked for the wrong kind would fail the test).
const stubCanvas = context =>
  stubDocument(() => ({ getContext: kind => (kind === 'webgl2' ? context : null) }));

afterEach(() => vi.unstubAllGlobals());

describe('detectWebGL2', () => {
  it('returns null without a DOM (SSR / tests) — unknown, never "unsupported"', () => {
    vi.stubGlobal('document', undefined);
    expect(detectWebGL2()).toBeNull();
  });

  it('returns true when a webgl2 context can be created', () => {
    stubCanvas({});
    expect(detectWebGL2()).toBe(true);
  });

  it('releases the probe context so it cannot exhaust the browser context cap', () => {
    const loseContext = vi.fn();
    stubCanvas({ getExtension: () => ({ loseContext }) });
    expect(detectWebGL2()).toBe(true);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it('still reports true when the context has no lose-context extension', () => {
    stubCanvas({ getExtension: () => null });
    expect(detectWebGL2()).toBe(true);
  });

  it('returns false when the browser refuses the context (hardware accel off)', () => {
    stubCanvas(null);
    expect(detectWebGL2()).toBe(false);
  });

  it('returns false when createElement or getContext throws', () => {
    stubDocument(() => { throw new Error('canvas unavailable'); });
    expect(detectWebGL2()).toBe(false);

    stubDocument(() => ({ getContext: () => { throw new Error('context creation failed'); } }));
    expect(detectWebGL2()).toBe(false);
  });
});

describe('isGPUInitializationError', () => {
  it('recognises MapLibre v6 GPUInitializationError by name', () => {
    const err = new Error('whatever the message says');
    err.name = 'GPUInitializationError';
    expect(isGPUInitializationError(err)).toBe(true);
  });

  it('recognises the WebGL2-required message even without the name', () => {
    expect(isGPUInitializationError(new Error(
      'WebGL2 is required to display this map. We are sorry, but it seems that your browser does not support WebGL2'
    ))).toBe(true);
  });

  it('recognises browser context-creation and context-loss wording', () => {
    expect(isGPUInitializationError(new Error('Could not create a WebGL context'))).toBe(true);
    expect(isGPUInitializationError(new Error('Failed to create context'))).toBe(true);
    expect(isGPUInitializationError(new Error('WebGL context lost'))).toBe(true);
  });

  it('accepts a bare string and tolerates null/undefined', () => {
    expect(isGPUInitializationError('Failed to create WebGL context')).toBe(true);
    expect(isGPUInitializationError(null)).toBe(false);
    expect(isGPUInitializationError(undefined)).toBe(false);
  });

  it('does NOT treat a failed tile fetch as a dead GPU', () => {
    // Tile errors reach the same map 'error' channel: misclassifying one would
    // tear down a perfectly working map over a transient hiccup.
    expect(isGPUInitializationError(new Error('Failed to fetch'))).toBe(false);
    const http = new Error('AJAXError: Not Found');
    http.status = 404;
    expect(isGPUInitializationError(http)).toBe(false);
    expect(isGPUInitializationError(new Error('Unrecognized day index'))).toBe(false);
  });
});
