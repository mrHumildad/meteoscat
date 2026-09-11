// Named map locations, persisted in the browser's localStorage.
//
// Same contract as savedFilters.js, one level down: the directions modal
// (the "location details" card of a point picked with the car button) lets
// the user name a spot and add a free description; this module snapshots just
// the point itself — `{ name, description, lat, lng, elevation }` — so it can
// be listed and revisited later. It is the only place that touches the
// storage key, so the modal and App stay free of serialisation details.
//
// The saved name doubles as the identity, exactly like the filter presets:
// saving under a name the user already used overwrites that entry (one spot
// per name, most recent first) instead of piling up duplicates.
//
// Every storage call is defensive: localStorage can be missing (SSR / tests)
// or throw (private mode, quota), and a corrupt payload must never crash the
// app — a failed read is just "no saved places".

export const SAVED_LOCATIONS_KEY = 'meteoseps.savedLocations';

// Cap so a runaway save loop can't fill the user's storage.
export const SAVED_LOCATIONS_MAX = 50;

// localStorage when available and usable, else null (SSR, tests, private mode).
const resolveStore = storage => {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // accessing localStorage itself can throw in some sandboxes
  }
};

/**
 * Suggested name for a point picked on the map: the toponym of the nearest
 * station (its municipality, or its own name when the municipality is
 * unknown). Pure and defensive — the returned string is only a DEFAULT the
 * user edits before saving, so an unknown place yields '' rather than a
 * made-up label.
 */
export const suggestLocationName = (nearest) => {
  const top = Array.isArray(nearest) ? nearest[0] : null;
  if (!top) return '';
  return String(top.municipi || top.name || top.comarca || '').trim();
};

/**
 * Snapshot a picked point as a plain JSON entry. Coordinates are required —
 * a point without usable ones is not a place and is refused (null).
 * `elevation` is the DEM sample and may legitimately be unknown (null).
 */
export const buildLocation = ({ name, description = '', lat, lng, elevation = null } = {}) => {
  const trimmed = String(name ?? '').trim();
  if (!trimmed || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    name: trimmed,
    description: String(description ?? '').trim(),
    lat,
    lng,
    elevation: Number.isFinite(elevation) ? elevation : null,
  };
};

/** Stored locations, newest first. Malformed entries / payloads are dropped. */
export const readSavedLocations = (storage) => {
  const store = resolveStore(storage);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(SAVED_LOCATIONS_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      l => l && typeof l.name === 'string' && Number.isFinite(l.lat) && Number.isFinite(l.lng),
    );
  } catch {
    return [];
  }
};

/** Persist the saved-location list. Returns false when storage is unavailable/full. */
export const writeSavedLocations = (locations, storage) => {
  const store = resolveStore(storage);
  if (!store) return false;
  try {
    store.setItem(SAVED_LOCATIONS_KEY, JSON.stringify(locations));
    return true;
  } catch {
    return false;
  }
};

/**
 * Save a point under `name`. A repeated name overwrites its previous entry
 * (one place per name, most recent first) instead of piling up duplicates.
 * Returns the resulting list either way, so the caller can report success
 * even when persistence itself was refused.
 */
export const saveLocation = (name, location, storage) => {
  const store = resolveStore(storage);
  const entry = buildLocation({ ...location, name });
  const prev = readSavedLocations(store);
  if (!entry) return prev;
  const next = [
    { ...entry, savedAt: Date.now() },
    ...prev.filter(l => l.name !== entry.name),
  ].slice(0, SAVED_LOCATIONS_MAX);
  writeSavedLocations(next, store);
  return next;
};

/** Remove one saved location by name. Returns the resulting list. */
export const removeSavedLocation = (name, storage) => {
  const store = resolveStore(storage);
  const next = readSavedLocations(store).filter(l => l.name !== name);
  writeSavedLocations(next, store);
  return next;
};

/**
 * One-line position text for a saved row ("41.90000, 1.90000 · 512 m"),
 * shared by the locations panel. The description, when present, is rendered
 * as its own line by the panel.
 */
export const describeSavedLocation = (location) => {
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) return '';
  const coords = `${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`;
  return Number.isFinite(location.elevation) ? `${coords} · ${location.elevation} m` : coords;
};
