import { describe, it, expect } from 'vitest';
import { parseDay, getDaysInRange, daysCount, fmtShortCat, fmtNum } from './utils.js';

describe('parseDay', () => {
  it('parses YYYY-MM-DD as a valid local-midnight Date', () => {
    const d = parseDay('2025-09-22');
    expect(d).not.toBeNull();
    expect(d.getFullYear()).toBe(2025);
    expect(d.getMonth()).toBe(8); // September is 0-indexed
    expect(d.getDate()).toBe(22);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });

  it('keeps leading zeros (single-digit month / day)', () => {
    const d = parseDay('2025-01-05');
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(5);
  });

  it('returns null for invalid or non-canonical input', () => {
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay('')).toBeNull();
    expect(parseDay('garbage')).toBeNull();
    expect(parseDay('22-09-2025')).toBeNull();        // wrong order
    expect(parseDay('2025-09-22T10:00:00')).toBeNull(); // not a plain date
    expect(parseDay('2025-9-2')).toBeNull();          // missing zero-padding
    expect(parseDay('2025-13-01')).toBeNull();        // month 13 rolls over
    expect(parseDay('2025-02-30')).toBeNull();        // Feb 30 does not exist
  });
});

describe('getDaysInRange', () => {
  const data = {
    '2025-09-22': {},
    '2025-09-23': {},
    '2025-09-24': {},
    '2025-09-25': {},
    '2025-09-29': {},
  };

  it('returns [] when there is no `from` date', () => {
    expect(getDaysInRange(data, null, null)).toEqual([]);
    expect(getDaysInRange(data, undefined, '2025-09-25')).toEqual([]);
  });

  it('returns just the day when from === to (inclusive)', () => {
    expect(getDaysInRange(data, '2025-09-24', '2025-09-24')).toEqual(['2025-09-24']);
  });

  it('keeps every day between from and to, inclusive', () => {
    expect(getDaysInRange(data, '2025-09-22', '2025-09-25'))
      .toEqual(['2025-09-22', '2025-09-23', '2025-09-24', '2025-09-25']);
  });

  it('ignores days outside the window and reports them sorted', () => {
    expect(getDaysInRange(data, '2025-09-23', '2025-09-29'))
      .toEqual(['2025-09-23', '2025-09-24', '2025-09-25', '2025-09-29']);
  });

  it('accepts Date objects (as produced by DayPicker / parseDay)', () => {
    expect(getDaysInRange(data, parseDay('2025-09-22'), parseDay('2025-09-24')))
      .toEqual(['2025-09-22', '2025-09-23', '2025-09-24']);
  });

  it('returns [] when `to` is before `from`', () => {
    expect(getDaysInRange(data, '2025-09-25', '2025-09-23')).toEqual([]);
  });
});

describe('fmtShortCat', () => {
  it('formats day + abbreviated Catalan month, no weekday or year', () => {
    expect(fmtShortCat(parseDay('2026-09-02'))).toBe('2 set');
    expect(fmtShortCat(parseDay('2025-11-15'))).toBe('15 nov');
    expect(fmtShortCat(parseDay('2026-01-05'))).toBe('5 gen');
  });

  it('returns "" for invalid input', () => {
    expect(fmtShortCat(null)).toBe('');
    expect(fmtShortCat('garbage')).toBe('');
  });
});

describe('fmtNum', () => {
  it('strips float noise at the requested decimals', () => {
    expect(fmtNum(0.30000000000000004, 1)).toBe('0.3');
    expect(fmtNum(88.39999999999999, 0)).toBe('88');
    expect(fmtNum(155.69999999999996, 1)).toBe('155.7');
  });

  it('rounds to whole numbers with maxDec 0 (humidity %)', () => {
    expect(fmtNum(88.3, 0)).toBe('88');
    expect(fmtNum(88.7, 0)).toBe('89');
    expect(fmtNum(100, 0)).toBe('100');
  });

  it('keeps one decimal for temp/rain but drops trailing zeros', () => {
    expect(fmtNum(21.55, 1)).toBe('21.6');
    expect(fmtNum(12.34, 1)).toBe('12.3');
    expect(fmtNum(12, 1)).toBe('12');
    expect(fmtNum(21.5, 1)).toBe('21.5');
  });

  it('handles negatives and no-data input', () => {
    expect(fmtNum(-5.25, 1)).toBe('-5.3');
    expect(fmtNum(-5, 1)).toBe('-5');
    expect(fmtNum(null, 1)).toBe('');
    expect(fmtNum(undefined, 1)).toBe('');
    expect(fmtNum('', 1)).toBe('');
    expect(fmtNum('garbage', 1)).toBe('');
    expect(fmtNum('6.5', 1)).toBe('6.5');
  });
});

describe('daysCount', () => {
  it('returns 0 when no range is set', () => {
    expect(daysCount(null)).toBe(0);
    expect(daysCount({})).toBe(0);
    expect(daysCount({ to: parseDay('2025-09-25') })).toBe(0);
  });

  it('counts a single selected day as 1', () => {
    expect(daysCount({ from: parseDay('2025-09-22') })).toBe(1);
    expect(daysCount({ from: parseDay('2025-09-22'), to: parseDay('2025-09-22') })).toBe(1);
  });

  it('counts inclusive days between from and to', () => {
    expect(daysCount({ from: parseDay('2025-09-22'), to: parseDay('2025-09-25') })).toBe(4);
  });

  it('counts a long range across a month boundary', () => {
    expect(daysCount({ from: parseDay('2025-09-22'), to: parseDay('2025-11-23') })).toBe(63);
  });

  it('is not fooled by the autumn DST transition (2025-10-26)', () => {
    expect(daysCount({ from: parseDay('2025-10-20'), to: parseDay('2025-11-03') })).toBe(15);
  });

  it('is not fooled by the spring DST transition (2026-03-29)', () => {
    expect(daysCount({ from: parseDay('2026-03-28'), to: parseDay('2026-04-01') })).toBe(5);
  });

  it('falls back to 1 for an inverted range (from > to)', () => {
    expect(daysCount({ from: parseDay('2025-09-25'), to: parseDay('2025-09-23') })).toBe(1);
  });
});