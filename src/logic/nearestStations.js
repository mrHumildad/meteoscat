/**
 * Nearest Meteo stations to an arbitrary map point — used by the directions
 * modal (the point picked with the car button) to answer "where am I?" with
 * the closest towns: each result carries the distance, the compass direction
 * from the picked point, and the station's municipality (poble) + comarca.
 *
 * All math is pure and DOM-free so it can be unit-tested directly.
 */

// 8-sector compass, Catalan abbreviations (Oest / O, Sud-oest / SO…). The
// sectors are centred on the cardinals: N covers 337.5°–22.5°, NE 22.5°–67.5°
// and so on.
export const COMPASS_SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

const EARTH_RADIUS_KM = 6371;
const toRad = deg => (deg * Math.PI) / 180;

/** Great-circle distance (haversine) between two lng/lat points, in km. */
export const distanceKm = (lng1, lat1, lng2, lat2) => {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
};

/** Initial bearing (0–360°, clockwise from north) from point 1 to point 2. */
export const bearingDeg = (lng1, lat1, lng2, lat2) => {
  const y = Math.sin(toRad(lng2 - lng1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lng2 - lng1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

/** Bearing (°) → 8-sector Catalan compass abbreviation. */
export const compassDirection = (bearing) => {
  if (!Number.isFinite(bearing)) return null;
  const norm = ((bearing % 360) + 360) % 360;
  return COMPASS_SECTORS[Math.round(norm / 45) % 8];
};

/**
 * The `limit` closest stations to (lng, lat), nearest first. Features without
 * usable coordinates are skipped; a missing `municipi`/`comarca` stays null
 * (the UI hides it rather than inventing a place).
 */
export const nearestStations = (features, lng, lat, limit = 3) => {
  if (!Array.isArray(features) || !Number.isFinite(lng) || !Number.isFinite(lat)) return [];
  if (!(limit > 0)) return [];
  const results = [];
  for (const f of features) {
    const [flng, flat] = f?.geometry?.coordinates ?? [];
    if (!Number.isFinite(flng) || !Number.isFinite(flat)) continue;
    const bearing = bearingDeg(lng, lat, flng, flat);
    results.push({
      code: f.properties?.codi ?? null,
      name: f.properties?.nom ?? f.properties?.codi ?? null,
      municipi: f.properties?.municipi ?? null,
      comarca: f.properties?.comarca ?? null,
      lat: flat,
      lng: flng,
      distanceKm: distanceKm(lng, lat, flng, flat),
      bearing,
      direction: compassDirection(bearing),
    });
  }
  results.sort((a, b) => a.distanceKm - b.distanceKm);
  return results.slice(0, Math.floor(limit));
};
