
/**
 * Parse a 'YYYY-MM-DD' string as LOCAL midnight. `new Date('YYYY-MM-DD')`
 * parses as UTC midnight, which shifts the day in timezones east of UTC
 * and made calendar day ranges / disabled checks off by one.
 */
export const parseDay = str => {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  // reject input that rolls over (month 13, Feb 30, …)
  if (
    d.getFullYear() !== Number(m[1]) ||
    d.getMonth() !== Number(m[2]) - 1 ||
    d.getDate() !== Number(m[3])
  ) return null;
  return d;
};

export const getDaysInRange = (data, from, to) => {
  if (!from) return [];
  const all = Object.keys(data).sort(); // assume YYYY-MM-DD keys
  const f = new Date(from); f.setHours(0,0,0,0);
  const t = to ? new Date(to) : f; t.setHours(0,0,0,0);
  return all.filter(k => {
    const d = new Date(k);
    d.setHours(0,0,0,0);
    return d >= f && d <= t;
  });
};

export const daysCount = (daysRange) => {
  if (!daysRange || !daysRange.from) return 0;
  const from = new Date(daysRange.from);
  const to = daysRange.to ? new Date(daysRange.to) : from;
  // Count by UTC day numbers so DST transitions (23h/25h days) never skew
  // the result — the raw ms difference approach undercounts by one for
  // ranges crossing the spring-forward transition.
  const utcDay = d => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = (utcDay(to) - utcDay(from)) / (1000 * 60 * 60 * 24) + 1;
  return diffDays > 0 ? diffDays : 1;
}

export const fmt = d => {
  if (!d) return '-';
  const x = new Date(d);
  if (isNaN(x)) return '-';
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const safeAvg = arr => {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const nums = arr.map(n => Number(n)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((a,b) => a+b,0) / nums.length;
};
export const isToday = (dateInput) => {
  const d = new Date(dateInput);
  const today = new Date();
  return d.getDate() === today.getDate() &&
         d.getMonth() === today.getMonth() &&
         d.getFullYear() === today.getFullYear();
}
export function fmtDayCat(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d)) return '';
  const today = new Date();
  if (d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear()) {
    return 'AVUI';
  }
  if (d.getDate() === today.getDate() - 1 &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear()) {
    return 'AHIR';
  }
  const daysCat = ['DG', 'DL', 'DM', 'DC', 'DJ', 'DV', 'DS'];
  const dayAbbrev = daysCat[d.getDay()];
  const dayNum = d.getDate();

  return `${dayAbbrev} ${dayNum}`;
}

// Compact Catalan date for tight row labels, e.g. "15 nov" (no weekday, no
// year) — used by the filter panel's instance rows / editor labels.
export function fmtShortCat(dateInput) {
  if (dateInput === null || dateInput === undefined || dateInput === '') return ''; // new Date(null) is the epoch
  const d = new Date(dateInput);
  if (isNaN(d)) return '';
  const monthsCat = ['gen', 'febr', 'març', 'abr', 'maig', 'juny', 'jul', 'ag', 'set', 'oct', 'nov', 'des'];
  return `${d.getDate()} ${monthsCat[d.getMonth()]}`;
}

// Full Catalan date, e.g. "DS 15 nov 2025"; keeps AVUI/AHIR for the last 2 days
export function fmtDateCat(dateInput) {
  const dayCat = fmtDayCat(dateInput);
  if (dayCat === 'AVUI' || dayCat === 'AHIR') return dayCat;
  const d = new Date(dateInput);
  if (isNaN(d)) return '';
  const monthsCat = ['gen', 'febr', 'març', 'abr', 'maig', 'juny', 'jul', 'ag', 'set', 'oct', 'nov', 'des'];
  return `${dayCat} ${monthsCat[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * Round a value for display with AT MOST `maxDec` decimals, stripping float
 * noise and trailing zeros: 0.30000000000000004 → '0.3', 88.39999… → '88'
 * (maxDec 0), 21.0 → '21'. Humidity renders whole (%) with maxDec 0;
 * temperature and rain keep 1 decimal. DISPLAY-ONLY: filter comparisons and
 * map logic keep the full-precision numbers. Returns '' for no-data input so
 * callers can fall back to their own placeholder.
 */
export const fmtNum = (v, maxDec = 1) => {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  // Round HALF AWAY FROM ZERO, matching the ECMA-262 toFixed behaviour the
  // data pipeline already mirrors (meteokat/aggregate.py safe_avg).
  const f = 10 ** maxDec;
  const r = Math.round(Math.abs(n) * f) / f;
  return String(n < 0 ? -r : r);
};







const STYLES = [
  { name: 'Default (MapLibre demo)', url: 'https://demotiles.maplibre.org/style.json' },
  { name: 'CARTO Dark Matter', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { name: 'Stadia Dark', url: 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json' },
  { name: 'CARTO Positron (light)', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' }
];