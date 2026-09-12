// Tests for the daily-shard loader — the seam between this repo and the
// server repo that publishes data/daily/. The URL base is read from the env at
// module load, so each case re-imports the module under a stubbed env.
import { describe, it, expect, vi, afterEach } from 'vitest';

/** Import refineData.js fresh, with the given Vite env values applied. */
async function loadWithEnv(env) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('./refineData.js');
}

/** Minimal fetch stub: serves `routes` (url → body), 404 otherwise. */
function stubFetch(routes) {
  const calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async url => {
      calls.push(url);
      if (!(url in routes)) return { ok: false, status: 404 };
      return { ok: true, status: 200, json: async () => routes[url] };
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('endpoint resolution', () => {
  it('uses VITE_DATA_BASE_URL (the server repo data site) when set', async () => {
    const { ENDPOINTS } = await loadWithEnv({
      VITE_DATA_BASE_URL: 'https://example.github.io/cepdata',
    });
    expect(ENDPOINTS.dayIndex()).toBe(
      'https://example.github.io/cepdata/daily/index.json'
    );
    expect(ENDPOINTS.dayShard('2026-09-10')).toBe(
      'https://example.github.io/cepdata/daily/2026-09-10.json'
    );
  });

  it('does not double the slash when the base already ends in one', async () => {
    const { ENDPOINTS } = await loadWithEnv({
      VITE_DATA_BASE_URL: 'https://example.github.io/cepdata/',
    });
    expect(ENDPOINTS.dayIndex()).toBe(
      'https://example.github.io/cepdata/daily/index.json'
    );
  });

  it('falls back to <BASE_URL>/logic for offline same-origin data', async () => {
    // Empty (not unset) mirrors an uncommented-but-blank .env entry.
    const { ENDPOINTS } = await loadWithEnv({
      VITE_DATA_BASE_URL: '',
      BASE_URL: '/meteoscat/',
    });
    expect(ENDPOINTS.dayIndex()).toBe('/meteoscat/logic/daily/index.json');
    expect(ENDPOINTS.dayShard('2026-09-10')).toBe(
      '/meteoscat/logic/daily/2026-09-10.json'
    );
  });
});

describe('loadAvailableDays', () => {
  it('returns the index sorted oldest-first', async () => {
    const base = 'https://data.test';
    stubFetch({ [`${base}/daily/index.json`]: ['2026-09-10', '2025-11-10'] });
    const { loadAvailableDays } = await loadWithEnv({
      VITE_DATA_BASE_URL: base,
    });
    expect(await loadAvailableDays()).toEqual(['2025-11-10', '2026-09-10']);
  });

  it('rejects an unrecognized index payload', async () => {
    const base = 'https://data.test';
    stubFetch({ [`${base}/daily/index.json`]: { days: [] } });
    const { loadAvailableDays } = await loadWithEnv({
      VITE_DATA_BASE_URL: base,
    });
    await expect(loadAvailableDays()).rejects.toThrow('Unrecognized day index');
  });
});

describe('loadSummaries', () => {
  it('fetches only the days inside the window and keys them by day', async () => {
    const base = 'https://data.test';
    const calls = stubFetch({
      [`${base}/daily/2026-09-09.json`]: { C6: { tempAvg: 1 }, dayStats: {} },
      [`${base}/daily/2026-09-10.json`]: { C6: { tempAvg: 2 }, dayStats: {} },
    });
    const { loadSummaries } = await loadWithEnv({ VITE_DATA_BASE_URL: base });

    const summaries = await loadSummaries(
      ['2025-11-10', '2026-09-09', '2026-09-10'],
      '2026-09-09',
      '2026-09-10'
    );

    expect(Object.keys(summaries)).toEqual(['2026-09-09', '2026-09-10']);
    expect(summaries['2026-09-10'].C6.tempAvg).toBe(2);
    expect(calls).toHaveLength(2); // the out-of-window day is never requested
  });
});
