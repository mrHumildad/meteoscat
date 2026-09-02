import { describe, it, expect } from 'vitest';
import { parseDay, getDaysInRange, daysCount } from './utils.js';

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