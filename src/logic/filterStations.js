// Pure slider-filter logic for station features.
// Extracted from Selectors.jsx so it can be unit-tested without React.
//
// `stations` is an array of GeoJSON features whose `properties` carry the
// computed averages `precAcc`, `humAvg`, `tempAvg` and the station code
// `codi` (see computeGeoValues.js).
//
// Returns the list of station codes that pass every active slider range.
// While all four sliders sit at their full span, NO filtering is applied:
// returns [] which the caller treats as "show everything".
//
// `altitud` is the station's static metadata height in metres (survives into
// the features via computeGeoValues' property spread).

const hasNumber = v =>
  v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

export const filterStationCodes = (stations, rainRange, humRange, tempRange, altRange, rangeLimits) => {
  if (!Array.isArray(stations) || stations.length === 0) return [];

  const lim = [
    rangeLimits.rainMin, rangeLimits.rainMax,
    rangeLimits.humMin, rangeLimits.humMax,
    rangeLimits.tempMin, rangeLimits.tempMax,
    rangeLimits.altMin, rangeLimits.altMax
  ];
  const ranges = [rainRange, humRange, tempRange, altRange];
  const atFullRange = ranges.every((r, i) => r[0] === lim[i * 2] && r[1] === lim[i * 2 + 1]);
  if (atFullRange) return [];

  const codes = [];
  for (const st of stations) {
    const p = st.properties || {};
    if (!hasNumber(p.tempAvg) || !hasNumber(p.humAvg) || !hasNumber(p.precAcc)) continue;
    if (!hasNumber(p.altitud)) continue;
    const t = Number(p.tempAvg);
    const h = Number(p.humAvg);
    const r = Number(p.precAcc);
    const a = Number(p.altitud);
    if (
      t >= tempRange[0] && t <= tempRange[1] &&
      h >= humRange[0] && h <= humRange[1] &&
      r >= rainRange[0] && r <= rainRange[1] &&
      a >= altRange[0] && a <= altRange[1]
    ) {
      codes.push(p.codi);
    }
  }
  return codes;
};