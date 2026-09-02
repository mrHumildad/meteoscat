// Daily station summaries, pre-aggregated server-side by
// meteokat/aggregate.py into public/logic/daily/*.json. Fetched lazily so the
// raw dataset (full_dades.json) never ships inside the JS bundle.
//
// Shape of a day shard (identical to the old refineData() output):
//   { "<stationCodi>": { tempAvg, tempMin, tempMax, humAvg, humMin, humMax,
//                        precAcc }, ..., dayStats: {...} }

const findEndpoint = path => `${import.meta.env.BASE_URL || '/'}${path}`;

export const ENDPOINTS = {
  dayIndex: () => findEndpoint('logic/daily/index.json'),
  dayShard: day => findEndpoint(`logic/daily/${day}.json`),
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