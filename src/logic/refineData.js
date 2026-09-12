// Daily station summaries, pre-aggregated server-side and published by the
// meteoscat **server** repo (see its aggregate.py) to its GitHub Pages data
// site as daily/YYYY-MM-DD.json + daily/index.json. Fetched lazily so no
// dataset ships inside the JS bundle.
//
// The data lives in a different repo than this app — the daily cron commits
// there, never here — so the shards are fetched cross-origin from
// VITE_DATA_BASE_URL (set in .env; GitHub Pages serves them with
// `Access-Control-Allow-Origin: *`). When that variable is unset the app
// falls back to a same-origin `logic/` directory, which is handy for offline
// work: copy the server's data/daily/ into public/logic/daily/ and the app
// behaves exactly as before the split.
//
// Shape of a day shard (identical to the old refineData() output):
//   { "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg, humMin, humMax,
//                        precAcc }, ..., dayStats: {...} }

const withSlash = url => (url.endsWith('/') ? url : `${url}/`);

// Trailing slash is normalized so both "https://host/repo" and a base ending
// in "/" resolve the same way.
const DATA_BASE = withSlash(
  import.meta.env.VITE_DATA_BASE_URL ||
    `${import.meta.env.BASE_URL || '/'}logic`
);

export const ENDPOINTS = {
  dayIndex: () => `${DATA_BASE}daily/index.json`,
  dayShard: day => `${DATA_BASE}daily/${day}.json`,
};

const fetchJson = async url => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
};

/** All days with data, oldest first (YYYY-MM-DD strings). */
export async function loadAvailableDays() {
  const days = await fetchJson(ENDPOINTS.dayIndex());
  if (!Array.isArray(days)) throw new Error('Unrecognized day index');
  return days.slice().sort();
}

/**
 * Station × day summaries for the [from, to] window (YYYY-MM-DD inclusive).
 * Returns the same object the old refineData() produced, but containing only
 * the days of the window: { day: { stationCode: {...}, dayStats: {...} } }.
 */
export async function loadSummaries(days, from, to) {
  const rangeDays = days.filter(d => d >= from && d <= to);
  const shards = await Promise.all(
    rangeDays.map(day => fetchJson(ENDPOINTS.dayShard(day)))
  );
  const summaries = {};
  rangeDays.forEach((day, i) => {
    summaries[day] = shards[i];
  });
  return summaries;
}
