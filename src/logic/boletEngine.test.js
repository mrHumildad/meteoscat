import { describe, it, expect } from 'vitest';
import { scoreStations, codesAboveThreshold, scoreByCode } from './boletEngine.js';

// Fixture mirrors the loadSummaries shape: per-day shards keyed by station
// code, with a dayStats entry to make sure the engine ignores it.
//
// 25 days, 2026-07-12 … 2026-08-05 (reference day = last one).
//   A — conifer host: 400 mm on the FIRST 4 days (older than rovellons'
//       21-day window → must be excluded), plus a 20 mm day exactly 18 days
//       before the reference day. tempAvg 11.4 / tempMin 5 every day.
//   B — deciduous host: some rain, but rovellons never grow on it.
//   C — conifer host: 3 mm drizzle, no ≥15 mm event (no flush trigger).
//   D — present only on the first day (outside the window → no data).
const days = Array.from({ length: 25 }, (_, i) => {
  const d = new Date(2026, 6, 12 + i); // July 12 …
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});

const shard = (i, overrides = {}) => ({
  A: { tempAvg: 11.4, tempMin: 5, humAvg: 70, precAcc: i < 4 ? 100 : i === 6 ? 20 : 0, ...(overrides.A ?? {}) },
  B: { tempAvg: 11.4, tempMin: 5, humAvg: 60, precAcc: i === 6 ? 20 : 0, ...(overrides.B ?? {}) },
  C: { tempAvg: 11.4, tempMin: 5, humAvg: 70, precAcc: i === 10 ? 3 : 0, ...(overrides.C ?? {}) },
  D: i === 0 ? { tempAvg: 11.4, tempMin: 5, humAvg: 70, precAcc: 2, ...(overrides.D ?? {}) } : undefined,
  dayStats: { tempMin: 5, tempMax: 15, precMin: 0, precMax: 100, humMin: 60, humMax: 70 },
});

const data = Object.fromEntries(days.map((day, i) => [day, shard(i)]));

const forest = { A: 'forest_conif', B: 'forest_decid', C: 'forest_conif', D: 'forest_conif' };

describe('scoreStations', () => {
  it('uses only the LAST windowDays of the range (retrospective rules)', () => {
    // rovellons window = 21 days: the first 4 days (400 mm) fall outside,
    // so the window rain total is just the 20 mm event.
    const scores = scoreStations(data, days, 'rovellons', forest);
    const a = scores.find(s => s.code === 'A');
    expect(a.stats.rainTotalMm).toBe(20);
    expect(a.stats.daysSinceBigRain).toBe(18); // 20 mm day, 18 days ago
  });

  it('scores every station over the species window and sorts by score', () => {
    const scores = scoreStations(data, days, 'rovellons', forest);
    expect(scores.map(s => s.code)).toEqual(['A', 'C', 'B']);
    // A: 20 mm + flush in lag window + conifer → highest
    // C: conifer but no big-rain event → lag term 0 → lower than A
    // B: deciduous host → binary gate zeroes the score
    const a = scores.find(s => s.code === 'A');
    const b = scores.find(s => s.code === 'B');
    const c = scores.find(s => s.code === 'C');
    expect(a.score).toBeGreaterThan(0);
    expect(c.score).toBeGreaterThan(0);
    expect(c.score).toBeLessThan(a.score);
    expect(b.score).toBe(0);
    // D has no data inside the window → not scored at all
    expect(scores.find(s => s.code === 'D')).toBeUndefined();
  });

  it('ignores dayStats entries', () => {
    const scores = scoreStations(data, days, 'rovellons', forest);
    expect(scores.map(s => s.code)).not.toContain('dayStats');
  });

  it('returns [] for unknown species, empty data or empty range', () => {
    expect(scoreStations(data, days, 'nope', forest)).toEqual([]);
    expect(scoreStations({}, days, 'rovellons', forest)).toEqual([]);
    expect(scoreStations(data, [], 'rovellons', forest)).toEqual([]);
    expect(scoreStations(null, days, 'rovellons', forest)).toEqual([]);
  });

  it('defaults unknown stations to no host match', () => {
    // No forest map at all → every station has null host → all scores 0
    const scores = scoreStations(data, days, 'rovellons', {});
    expect(scores.every(s => s.score === 0)).toBe(true);
  });
});

describe('codesAboveThreshold', () => {
  it('keeps only scores at/above the threshold; null never passes', () => {
    const scores = [
      { code: 'A', score: 0.8 },
      { code: 'B', score: 0.2 },
      { code: 'C', score: null },
    ];
    expect(codesAboveThreshold(scores, 0.5)).toEqual(['A']);
    expect(codesAboveThreshold(scores, 0.2)).toEqual(['A', 'B']);
    expect(codesAboveThreshold(scores, 0.9)).toEqual([]);
    expect(codesAboveThreshold([], 0.5)).toEqual([]);
  });
});

describe('scoreByCode', () => {
  it('builds a code → score lookup, null when absent', () => {
    const scores = [
      { code: 'A', score: 0.8 },
      { code: 'B', score: null },
    ];
    expect(scoreByCode(scores)).toEqual({ A: 0.8, B: null });
    expect(scoreByCode([])).toEqual({});
  });
});