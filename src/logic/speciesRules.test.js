import { describe, it, expect } from 'vitest';
import {
  clamp01,
  norm,
  smoothstep,
  SPECIES,
  speciesWindowStats,
  scoreSpecies,
  BIG_RAIN_EVENT_MM,
} from './speciesRules.js';

describe('norm', () => {
  it('maps the band [lo, hi] onto [0, 1] linearly and clamps', () => {
    expect(norm(40, 40, 200)).toBe(0);
    expect(norm(120, 40, 200)).toBe(0.5);
    expect(norm(200, 40, 200)).toBe(1);
    expect(norm(0, 40, 200)).toBe(0);
    expect(norm(500, 40, 200)).toBe(1);
  });

  it('guards degenerate ranges and non-finite input', () => {
    expect(norm(10, 10, 10)).toBe(1);
    expect(norm(5, 10, 10)).toBe(0);
    expect(norm(null, 0, 10)).toBe(0);
    expect(norm(undefined, 0, 10)).toBe(0);
  });
});

describe('smoothstep', () => {
  it('is 0 below e0, 1 at/above e1, 0.5 at the midpoint', () => {
    expect(smoothstep(15, 21, 10)).toBe(0);
    expect(smoothstep(15, 21, 15)).toBe(0);
    expect(smoothstep(15, 21, 18)).toBe(0.5);
    expect(smoothstep(15, 21, 21)).toBe(1);
    expect(smoothstep(15, 21, 30)).toBe(1);
  });

  it('guards degenerate ranges and non-finite input', () => {
    expect(smoothstep(5, 5, 6)).toBe(1);
    expect(smoothstep(5, 5, 4)).toBe(0);
    expect(smoothstep(15, 21, null)).toBe(0);
  });
});

describe('speciesWindowStats', () => {

  it('sums rain over present days; missing days contribute 0', () => {
    const entries = [
      { tempAvg: 10, tempMin: 4, precAcc: 5 },
      null, // station missing a day
      { tempAvg: 12, tempMin: 6, precAcc: '2.5' },
    ];
    const stats = speciesWindowStats(entries);
    expect(stats.rainTotalMm).toBe(7.5);
    expect(stats.tempMeanC).toBe(11);
    expect(stats.tempMinC).toBe(4);
  });

  it('returns null for an empty / all-missing window', () => {
    expect(speciesWindowStats([])).toBeNull();
    expect(speciesWindowStats([null, null])).toBeNull();
  });

  it('skips unusable temp values in the mean but keeps the window alive', () => {
    const entries = [
      { tempAvg: 10, tempMin: 5, precAcc: 0 },
      { tempAvg: null, tempMin: null, precAcc: 0 },
      { tempAvg: '14', tempMin: 9, precAcc: 0 },
    ];
    const stats = speciesWindowStats(entries);
    expect(stats.tempMeanC).toBe(12);
    expect(stats.tempMinC).toBe(5);
  });

  it('counts days since the MOST RECENT big-rain event, from the window end', () => {
    // 21-day window; a 20 mm day at index 2 ⇒ 21-1-2 = 18 days ago
    const entries = Array.from({ length: 21 }, (_, i) => ({
      tempAvg: 11.4, tempMin: 5, precAcc: i === 2 ? 20 : 0,
    }));
    expect(speciesWindowStats(entries).daysSinceBigRain).toBe(18);
  });

  it('returns null daysSinceBigRain when no day reaches the event threshold', () => {
    const entries = Array.from({ length: 21 }, () => ({
      tempAvg: 11, tempMin: 5, precAcc: 5, // drizzle only
    }));
    expect(speciesWindowStats(entries).daysSinceBigRain).toBeNull();
  });

  it('caps daysSinceBigRain at 30', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({
      tempAvg: 11, tempMin: 5, precAcc: i === 0 ? 20 : 0,
    }));
    expect(speciesWindowStats(entries).daysSinceBigRain).toBe(30);
  });

  it('uses the fixed 15 mm event threshold', () => {
    expect(BIG_RAIN_EVENT_MM).toBe(15);
    const entries = [
      { tempAvg: 11, tempMin: 5, precAcc: 14.9 },
      { tempAvg: 11, tempMin: 5, precAcc: 15 },
    ];
    const stats = speciesWindowStats(entries);
    expect(stats.daysSinceBigRain).toBe(0); // only the 15 mm day counts (today)
  });
});

describe('scoreSpecies — rovellons (known-good window, plan §7.2)', () => {
  const goodEntries = Array.from({ length: 21 }, (_, i) => ({
    tempAvg: 11.4, tempMin: 5, precAcc: i === 2 ? 20 : 0,
  }));

  it('scores a textbook flush high (~0.469 by hand) on a conifer host', () => {
    const stats = speciesWindowStats(goodEntries);
    expect(stats.rainTotalMm).toBe(20);
    const score = scoreSpecies(stats, 'rovellons', 'forest_conif');
    // rain norm(20,40,200)=0 · temp norm(11.4,6,16)=0.54 · lag 0.5 · frost 1
    // raw = 0.30*0.54 + 0.15*0.5 + 0.10*1 = 0.162+0.075+0.1 = 0.337
    expect(score).toBeCloseTo(0.337, 3);
  });

  it('rewards 87 mm over 21 days with an event 18 days ago (hero example)', () => {
    // 20 + 7×4 + 13×3 = 87 mm; the only ≥15 mm day is at index 2
    const entries = Array.from({ length: 21 }, (_, i) => ({
      tempAvg: 11.4, tempMin: 5,
      precAcc: i === 2 ? 20 : i % 3 === 0 ? 4 : 3,
    }));
    const stats = speciesWindowStats(entries);
    expect(stats.rainTotalMm).toBe(87);
    expect(stats.daysSinceBigRain).toBe(18);
    const score = scoreSpecies(stats, 'rovellons', 'forest_conif');
    // rain norm(87,40,200)=0.29375 · temp 0.54 · lag 0.5 · frost 1
    // raw = 0.45*0.29375 + 0.162 + 0.075 + 0.1 = 0.4691875
    expect(score).toBeCloseTo(0.469, 3);
  });

  it('zeroes out on a non-host forest (binary forest gate)', () => {
    const stats = speciesWindowStats(goodEntries);
    expect(scoreSpecies(stats, 'rovellons', 'forest_decid')).toBe(0);
    expect(scoreSpecies(stats, 'rovellons', null)).toBe(0);
  });

  it('loses the lag term when no big-rain event occurred', () => {
    const drizzle = Array.from({ length: 21 }, () => ({
      tempAvg: 11.4, tempMin: 5, precAcc: 5,
    }));
    const stats = speciesWindowStats(drizzle);
    expect(stats.daysSinceBigRain).toBeNull();
    const score = scoreSpecies(stats, 'rovellons', 'forest_conif');
    // rain norm(105,40,200)=0.40625 · temp 0.54 · lag 0 · frost 1
    // raw = 0.45*0.40625 + 0.162 + 0 + 0.1 = 0.4448125
    expect(score).toBeCloseTo(0.445, 3);
  });

  it('drops the frost term when the daily minimum is at/below minTempC', () => {
    const frosty = Array.from({ length: 21 }, (_, i) => ({
      tempAvg: 11.4, tempMin: i === 2 ? 20 : -2, precAcc: i === 2 ? 20 : 0,
    }));
    const stats = speciesWindowStats(frosty);
    expect(stats.tempMinC).toBe(-2);
    const score = scoreSpecies(stats, 'rovellons', 'forest_conif');
    // same as the textbook flush minus the 0.10 frost term
    expect(score).toBeCloseTo(0.237, 3);
  });
});

describe('scoreSpecies — ceps', () => {
  it('scores a good beech/oak window on a deciduous host', () => {
    // 15-day window, 100 mm (20 + 13×6 + 1×2), 20 mm event 12 days ago
    const entries = Array.from({ length: 15 }, (_, i) => ({
      tempAvg: 14, tempMin: 6,
      precAcc: i === 2 ? 20 : i === 7 ? 2 : 6,
    }));
    const stats = speciesWindowStats(entries);
    expect(stats.rainTotalMm).toBe(100);
    expect(stats.daysSinceBigRain).toBe(12);
    const score = scoreSpecies(stats, 'ceps', 'forest_decid');
    // rain norm(100,60,200)=0.2857 · temp norm(14,10,18)=0.5 ·
    // lag smoothstep(10,15,12)=0.352 · frost 1
    // raw = 0.45*0.2857 + 0.30*0.5 + 0.15*0.352 + 0.1 = 0.4314
    expect(score).toBeCloseTo(0.431, 3);
  });

  it('rejects a conifer-only host for ceps', () => {
    const entries = Array.from({ length: 15 }, () => ({
      tempAvg: 14, tempMin: 6, precAcc: 5,
    }));
    const stats = speciesWindowStats(entries);
    expect(scoreSpecies(stats, 'ceps', 'forest_conif')).toBe(0);
  });
});

describe('scoreSpecies — general', () => {
  it('returns null for unknown species or missing stats', () => {
    expect(scoreSpecies(null, 'rovellons', 'forest_conif')).toBeNull();
    expect(scoreSpecies({}, 'nope', 'forest_conif')).toBeNull();
  });

  it('returns null when the station has no usable data', () => {
    expect(scoreSpecies(null, 'ceps', 'forest_decid')).toBeNull();
  });

  it('never exceeds [0, 1] even with extreme weather', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      tempAvg: 30, tempMin: 20, precAcc: i === 1 ? 100 : 50,
    }));
    const stats = speciesWindowStats(entries);
    const score = scoreSpecies(stats, 'llenegues', 'forest_sclerophyll');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('exposes all five species with the plan fields', () => {
    expect(Object.keys(SPECIES)).toEqual([
      'rovellons', 'ceps', 'llenegues', 'murgoles', 'rossinyols',
    ]);
    expect(SPECIES.rovellons.forestHostFc).toEqual(['forest_conif']);
    expect(SPECIES.ceps.forestHostFc).toEqual(['forest_decid', 'forest_mixed']);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });
});