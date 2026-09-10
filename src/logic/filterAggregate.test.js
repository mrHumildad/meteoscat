import { describe, it, expect } from 'vitest';
import {
  buildAggregateTable,
  aggregateWindow,
  aggregateWindowByDates,
  dayRangeLabel,
  DEFAULTDAYRANGE,
  limitsForWindow,
  windowToDates,
} from './filterAggregate.js';

// Fixture mirrors the loadSummaries shape. Days are ascending; the reference
// day (offset 0) is the last one: 2026-08-03.
//   A: data on all 3 days
//   B: missing on 08-03
//   D: string numbers + unusable (null) values on some days
//   E: present only on 08-01
const data = {
  '2026-08-01': {
    A: { tempAvg: 10, humAvg: 60, precAcc: 5 },
    B: { tempAvg: 25, humAvg: 40, precAcc: 2 },
    D: { tempAvg: '5', humAvg: null, precAcc: '2.5' },
    E: { tempAvg: 4, humAvg: 30, precAcc: 1 },
    dayStats: { tempMin: 4, tempMax: 27, precMin: 0, precMax: 5, humMin: 30, humMax: 60 },
  },
  '2026-08-02': {
    A: { tempAvg: 12, humAvg: 70, precAcc: 3 },
    B: { tempAvg: 27, humAvg: 45, precAcc: 0 },
    D: { tempAvg: null, humAvg: 50, precAcc: null },
    dayStats: { tempMin: 10, tempMax: 27, precMin: 0, precMax: 3, humMin: 45, humMax: 70 },
  },
  '2026-08-03': {
    A: { tempAvg: 11, humAvg: 65, precAcc: 1.5 },
    D: { tempAvg: 9, humAvg: null, precAcc: null },
    dayStats: { tempMin: 9, tempMax: 11, precMin: 0, precMax: 1.5, humMin: 65, humMax: 65 },
  },
};

const hasNumber = v =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

// Independent re-summation of the same aggregation rules, for cross-checking
// the O(1) prefix-sum results against a naive per-day loop.
const naive = (data, code, type, fromOffset, toOffset) => {
  const days = Object.keys(data).sort();
  const iFrom = days.length - 1 - fromOffset;
  const iTo = days.length - 1 - toOffset;
  if (iFrom < 0 || iTo >= days.length || iFrom > iTo) return null;
  let sum = 0;
  let usable = 0;
  let present = 0;
  for (let i = iFrom; i <= iTo; i++) {
    const s = data[days[i]]?.[code];
    if (!s) continue;
    present++;
    const v = s[type === 'rain' ? 'precAcc' : type === 'temp' ? 'tempAvg' : 'humAvg'];
    if (type === 'rain') {
      sum += hasNumber(v) ? Number(v) : 0;
    } else if (hasNumber(v)) {
      sum += Number(v);
      usable++;
    }
  }
  if (type === 'rain') return present === 0 ? null : sum;
  if (usable === 0) return null;
  const mean = sum / usable;
  // humidity means are rounded to whole % (see aggregateByIndex)
  return type === 'hum' ? Math.round(mean) : mean;
};

describe('buildAggregateTable', () => {
  it('sorts day keys ascending and skips dayStats / non-object entries', () => {
    const agg = buildAggregateTable(data);
    expect(agg.days).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(agg.stations).toEqual(['A', 'B', 'D', 'E']);
    expect(agg.stations).not.toContain('dayStats');
  });

  it('handles empty data', () => {
    const agg = buildAggregateTable({});
    expect(agg.days).toEqual([]);
    expect(agg.stations).toEqual([]);
    expect(aggregateWindow(agg, 'A', 'rain', 0, 0)).toBeNull();
    expect(limitsForWindow(agg, 'rain', 0, 0)).toBeNull();
  });
});

describe('aggregateWindow', () => {
  it('sums rain over the window; missing days contribute 0 (A: 5+3+1.5)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'A', 'rain', 2, 0)).toBe(9.5);
  });

  it('sums rain over the window; a station missing a whole day contributes 0 (B: 2+0)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'B', 'rain', 2, 0)).toBe(2);
  });

  it('treats unusable rain values as 0 but still counts the day as present (D)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'D', 'rain', 2, 0)).toBe(2.5); // '2.5' + null→0 + null→0
  });

  it('returns null for a rain window with no present day at all', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'B', 'rain', 0, 0)).toBeNull(); // B missing on 08-03
    expect(aggregateWindow(agg, 'E', 'rain', 1, 1)).toBeNull(); // E missing on 08-02
  });

  it('maps offsets to the right concrete window (offset 0 = last day)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'A', 'rain', 0, 0)).toBe(1.5); // 08-03
    expect(aggregateWindow(agg, 'A', 'rain', 1, 1)).toBe(3);   // 08-02
    expect(aggregateWindow(agg, 'A', 'rain', 2, 2)).toBe(5);   // 08-01
  });

  it('averages temp over the usable days of the window (A: (10+12+11)/3)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'A', 'temp', 2, 0)).toBe(11);
  });

  it('averages temp over present days only (B: (25+27)/2, 08-03 missing)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'B', 'temp', 2, 0)).toBe(26);
  });

  it('accepts string numbers and skips null values for the mean (D: (5+9)/2)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'D', 'temp', 2, 0)).toBe(7);
  });

  it('returns null when the window has no usable temp/hum value (D on 08-02)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'D', 'temp', 1, 1)).toBeNull();
  });

  it('averages humidity per variable (D: only 08-02 has a usable humAvg)', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'D', 'hum', 2, 0)).toBe(50);
    expect(aggregateWindow(agg, 'A', 'hum', 2, 0)).toBe(65);
  });

  it('rounds humidity means to whole % (step-1 slider thresholds)', () => {
    const agg = buildAggregateTable(data);
    // B: (40 + 45) / 2 = 42.5 → 43
    expect(aggregateWindow(agg, 'B', 'hum', 2, 0)).toBe(43);
    // humidity window limits across stations are integers too
    expect(limitsForWindow(agg, 'hum', 2, 0)).toEqual([30, 65]);
  });

  it('returns null for unknown stations and invalid offsets', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindow(agg, 'ZZ', 'rain', 0, 0)).toBeNull();
    expect(aggregateWindow(agg, 'A', 'relief', 0, 0)).toBeNull(); // unknown type
    expect(aggregateWindow(agg, 'A', 'rain', 0, 1)).toBeNull();   // from < to
    expect(aggregateWindow(agg, 'A', 'rain', -1, 0)).toBeNull();  // negative
    expect(aggregateWindow(agg, 'A', 'rain', 5, 0)).toBeNull();   // beyond range
  });

  it('O(1) prefix-sum results match a naive per-day re-summation', () => {
    const agg = buildAggregateTable(data);
    const windows = [[2, 0], [1, 0], [1, 1], [0, 0], [2, 2]];
    for (const code of agg.stations) {
      for (const type of ['rain', 'temp', 'hum']) {
        for (const [from, to] of windows) {
          const expected = naive(data, code, type, from, to);
          const actual = aggregateWindow(agg, code, type, from, to);
          if (expected === null) {
            expect(actual).toBeNull();
          } else {
            expect(actual).toBeCloseTo(expected, 10);
          }
        }
      }
    }
  });
});

describe('aggregateWindowByDates', () => {
  it('matches aggregateWindow for the same concrete window', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindowByDates(agg, 'A', 'rain', '2026-08-01', '2026-08-03'))
      .toBe(aggregateWindow(agg, 'A', 'rain', 2, 0));
    expect(aggregateWindowByDates(agg, 'B', 'temp', '2026-08-01', '2026-08-03'))
      .toBe(aggregateWindow(agg, 'B', 'temp', 2, 0));
  });

  it('returns null for unknown dates or stations', () => {
    const agg = buildAggregateTable(data);
    expect(aggregateWindowByDates(agg, 'A', 'rain', '2026-01-01', '2026-08-03')).toBeNull();
    expect(aggregateWindowByDates(agg, 'A', 'rain', '2026-08-03', '2026-08-01')).toBeNull();
    expect(aggregateWindowByDates(agg, 'ZZ', 'rain', '2026-08-01', '2026-08-03')).toBeNull();
  });
});

describe('windowToDates', () => {
  it('converts offsets to concrete dates from the reference day', () => {
    expect(windowToDates('2026-08-03', 2, 0)).toEqual({ from: '2026-08-01', to: '2026-08-03' });
    expect(windowToDates('2026-08-03', 1, 1)).toEqual({ from: '2026-08-02', to: '2026-08-02' });
    expect(windowToDates('2026-08-03', 0, 0)).toEqual({ from: '2026-08-03', to: '2026-08-03' });
  });

  it('accepts a Date reference day', () => {
    expect(windowToDates(new Date(2026, 7, 3), 2, 0)).toEqual({ from: '2026-08-01', to: '2026-08-03' });
  });
});

describe('DEFAULTDAYRANGE / dayRangeLabel', () => {
  it('is the single 60-day reference (station values, filter defaults, chart)', () => {
    expect(DEFAULTDAYRANGE).toBe(60);
  });

  it('labels the three window shapes used by the station-info span and filter rows', () => {
    expect(dayRangeLabel(60, 0)).toBe('darrers 60 dies');
    expect(dayRangeLabel(14, 0)).toBe('darrers 14 dies');
    expect(dayRangeLabel(14, 7)).toBe('fa 14 → fa 7 dies');
    expect(dayRangeLabel(3, 3)).toBe('fa 3 dies');
  });
});

describe('limitsForWindow', () => {
  it('returns [min, max] across all stations over the window', () => {
    const agg = buildAggregateTable(data);
    // rain [2,0]: A 9.5, B 2, D 2.5, E 1 → [1, 9.5]
    expect(limitsForWindow(agg, 'rain', 2, 0)).toEqual([1, 9.5]);
    // temp [2,0]: A 11, B 26, D 7, E 4 → [4, 26]
    expect(limitsForWindow(agg, 'temp', 2, 0)).toEqual([4, 26]);
  });

  it('ignores stations without data in the window', () => {
    const agg = buildAggregateTable(data);
    // rain [1,1] (08-02): A 3, B 0, D 0, E null → [0, 3]
    expect(limitsForWindow(agg, 'rain', 1, 1)).toEqual([0, 3]);
    // temp [1,1]: A 12, B 27, D/E null → [12, 27]
    expect(limitsForWindow(agg, 'temp', 1, 1)).toEqual([12, 27]);
  });

  it('returns null when no station has data in the window', () => {
    const lonely = {
      '2026-08-01': { G: { tempAvg: null, humAvg: null, precAcc: null } },
    };
    const agg = buildAggregateTable(lonely);
    expect(limitsForWindow(agg, 'temp', 0, 0)).toBeNull();
    expect(limitsForWindow(agg, 'temp', 5, 0)).toBeNull(); // out of range
  });

  it('is memoized per aggregate table (repeated calls agree)', () => {
    const agg = buildAggregateTable(data);
    const first = limitsForWindow(agg, 'rain', 2, 0);
    const second = limitsForWindow(agg, 'rain', 2, 0);
    expect(first).toEqual(second);
    expect(first).toEqual([1, 9.5]);
    // A different table is never served stale limits
    const other = buildAggregateTable({ '2026-08-01': { X: { tempAvg: 3, humAvg: 10, precAcc: 7 } } });
    expect(limitsForWindow(other, 'rain', 0, 0)).toEqual([7, 7]);
  });
});