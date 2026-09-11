/**
 * WebGL2 capability probe + MapLibre GPU-failure detection.
 *
 * MapLibre GL JS v6 renders exclusively through WebGL2 (v6 dropped WebGL1), so
 * a browser that cannot create a `webgl2` context cannot show the map at all.
 * That is no longer an exotic case: Chromium removed the automatic SwiftShader
 * software fallback, so with hardware acceleration off — or with no GPU, a
 * blocklisted driver, or a crashed GPU process — context creation simply fails.
 * MapLibre then throws `GPUInitializationError` instead of drawing anything.
 *
 * This module lets the app answer "can this browser render the map?" BEFORE
 * mounting `<Map>` (so the failure is explained instead of leaving a blank
 * canvas), and recognises the same failure when it arrives as a runtime map
 * error. See WEBGL_FALLBACK_REPORT.md for the background and the user-facing
 * remediation steps the notice points at.
 */

// MapLibre v6 throws this named error from the Map constructor whenever the
// GPU context cannot be created (and re-fires it via the map's 'error' event
// when recreating the context after a `webglcontextrestored` fails). Matched by
// NAME, so this module needs no maplibre-gl import — it stays runnable in a
// plain Node test environment.
const GPU_INIT_ERROR_NAME = 'GPUInitializationError';

// Fallback patterns for GPU/context failures that do not carry the name above:
// other MapLibre builds, and the browser's own `webglcontextcreationerror`
// text. Deliberately narrow — a failed tile fetch must NOT be mistaken for a
// dead GPU, or the app would replace a working map with the notice over a
// transient 500.
const WEBGL_RE = /webgl/i;
const CONTEXT_CREATE_RE = /(could not|failed to|cannot|can't) create\b[^.]*\bcontext/i;
const CONTEXT_LOST_RE = /context (lost|creation failed)/i;

/**
 * True when `err` means "the GPU/WebGL context could not be created (or was
 * lost)". False for every other error — notably HTTP/tile errors, which
 * MapLibre reports through the same map 'error' channel.
 */
export const isGPUInitializationError = err => {
  if (!err) return false;
  if (err.name === GPU_INIT_ERROR_NAME) return true;
  const msg = String(err.message ?? err);
  return WEBGL_RE.test(msg) || CONTEXT_CREATE_RE.test(msg) || CONTEXT_LOST_RE.test(msg);
};

/**
 * Probe WebGL2 support.
 *
 * @returns {boolean|null} `true`/`false`, or `null` when it cannot be
 *   determined because there is no DOM (SSR, the render smoke test). Callers
 *   must treat `null` as UNKNOWN — never as "unsupported" — so a server render
 *   never claims the map is broken.
 */
export const detectWebGL2 = () => {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return false;
    // Release the probe context immediately: browsers cap the number of live
    // WebGL contexts, and the map is about to create one of its own.
    gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return true;
  } catch {
    // createElement/getContext throwing is itself a "cannot render" answer.
    return false;
  }
};
