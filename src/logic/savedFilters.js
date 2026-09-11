// Named filter presets, persisted in the browser's localStorage.
//
// The filter panel lets the user build a stack (meteo instances, forest /
// substrate dims, altitude band, species filter); this module snapshots that
// stack under a user-given name so it can be reloaded later. It is the only
// place that touches the storage key, so the panel and App stay free of
// serialisation details.
//
// The snapshot is deliberately an app state, not the app's own data shapes:
//   { reliefRange: [lo, hi] | null,
//     meteoFilters: [{ type, from, to, range: [lo, hi] }],
//     forestOff: [codes...], geoOff: [keys...],   // sorted (Sets → arrays)
//     boletFilter: { species, threshold } | null }
// Filter instance ids are dropped: they are per-session counters (`f1`, `f2`…)
// that a reloaded preset must not reuse.
//
// Every storage call is defensive: localStorage can be missing (SSR / tests)
// or throw (private mode, quota), and a corrupt payload must never crash the
// app — a failed read is just "no presets".

export const SAVED_FILTERS_KEY = 'meteoseps.savedFilters';

// Cap so a runaway save loop can't fill the user's storage.
export const SAVED_FILTERS_MAX = 50;

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
 * Snapshot the current filter state as plain JSON. Arrays keep both bounds in
 * ascending order; Sets become sorted arrays (JSON has no Set) so the payload
 * is deterministic — two saves of the same state compare equal.
 */
export const buildFilterConfig = ({
  reliefRange = null,
  meteoFilters = [],
  forestOff = null,
  geoOff = null,
  boletFilter = null,
} = {}) => ({
  reliefRange: reliefRange ? [reliefRange[0], reliefRange[1]] : null,
  meteoFilters: meteoFilters.map(f => ({
    type: f.type,
    from: f.from,
    to: f.to,
    range: [f.range[0], f.range[1]],
  })),
  forestOff: [...(forestOff ?? [])].sort(),
  geoOff: [...(geoOff ?? [])].sort(),
  boletFilter: boletFilter
    ? { species: boletFilter.species, threshold: boletFilter.threshold }
    : null,
});

/** Stored presets, newest first. Malformed entries / payloads are dropped. */
export const readSavedFilters = (storage) => {
  const store = resolveStore(storage);
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(SAVED_FILTERS_KEY) ?? 'null');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      p => p && typeof p.name === 'string' && p.config && typeof p.config === 'object',
    );
  } catch {
    return [];
  }
};

/** Persist the preset list. Returns false when storage is unavailable/full. */
export const writeSavedFilters = (presets, storage) => {
  const store = resolveStore(storage);
  if (!store) return false;
  try {
    store.setItem(SAVED_FILTERS_KEY, JSON.stringify(presets));
    return true;
  } catch {
    return false;
  }
};

/**
 * Save `config` under `name`. A repeated name overwrites its previous entry
 * (one preset per name, most recent first) instead of piling up duplicates.
 * Returns the resulting list either way, so the caller can report success
 * even when persistence itself was refused.
 */
export const saveFilterPreset = (name, config, storage) => {
  const store = resolveStore(storage);
  const trimmed = String(name ?? '').trim();
  const prev = readSavedFilters(store);
  if (!trimmed || !config) return prev;
  const entry = { name: trimmed, savedAt: Date.now(), config };
  const next = [entry, ...prev.filter(p => p.name !== trimmed)].slice(0, SAVED_FILTERS_MAX);
  writeSavedFilters(next, store);
  return next;
};

// Panel-facing label per meteo instance type (same wording as METEO_DEFS).
const TYPE_LABEL = { rain: 'Pluja', hum: 'Humitat', temp: 'Temperatura' };

/**
 * One-line description of what a preset contains, for the basket buttons
 * ("Pluja · Bosc (3) · Bolets ceps"). Pure and defensive: it renders from a
 * stored config that may predate a filter type, so unknown types are skipped
 * rather than shown as raw keys.
 */
export const describeFilterConfig = (config) => {
  if (!config || typeof config !== 'object') return '';
  const parts = [];

  const counts = {};
  for (const f of config.meteoFilters ?? []) {
    if (TYPE_LABEL[f?.type]) counts[f.type] = (counts[f.type] ?? 0) + 1;
  }
  for (const [type, label] of Object.entries(TYPE_LABEL)) {
    const n = counts[type] ?? 0;
    if (n === 1) parts.push(label);
    else if (n > 1) parts.push(`${n}× ${label}`);
  }

  const relief = config.reliefRange;
  if (Array.isArray(relief) && relief.length === 2) {
    parts.push(`Relleu ${relief[0]}–${relief[1]} m`);
  }

  const forest = config.forestOff?.length ?? 0;
  if (forest) parts.push(forest > 1 ? `Bosc (${forest})` : 'Bosc');

  const geo = config.geoOff?.length ?? 0;
  if (geo) parts.push(geo > 1 ? `Substrat (${geo})` : 'Substrat');

  if (config.boletFilter?.species) parts.push(`Bolets ${config.boletFilter.species}`);

  return parts.length ? parts.join(' · ') : 'Sense filtres';
};

/**
 * Deep equality of two stored configs — used to tell which saved preset (if
 * any) the live filters currently match. Compared field by field rather than
 * by JSON.stringify so key order and Set/String representation can't matter.
 */
export const sameFilterConfig = (a, b) => {
  if (!a || !b) return false;

  const mfA = a.meteoFilters ?? [];
  const mfB = b.meteoFilters ?? [];
  if (mfA.length !== mfB.length) return false;
  const sameMeteo = mfA.every((f, i) => {
    const g = mfB[i];
    return f.type === g.type && f.from === g.from && f.to === g.to &&
      f.range?.[0] === g.range?.[0] && f.range?.[1] === g.range?.[1];
  });
  if (!sameMeteo) return false;

  const sameList = (x, y) => {
    const xs = x ?? [];
    const ys = y ?? [];
    return xs.length === ys.length && xs.every((v, i) => v === ys[i]);
  };
  const boA = a.boletFilter ?? null;
  const boB = b.boletFilter ?? null;
  return (
    sameList(a.reliefRange, b.reliefRange) &&
    sameList(a.forestOff, b.forestOff) &&
    sameList(a.geoOff, b.geoOff) &&
    (boA == null || boB == null
      ? boA === boB
      : boA.species === boB.species && boA.threshold === boB.threshold)
  );
};

/** Remove one preset by name. Returns the resulting list. */
export const removeSavedFilter = (name, storage) => {
  const store = resolveStore(storage);
  const next = readSavedFilters(store).filter(p => p.name !== name);
  writeSavedFilters(next, store);
  return next;
};
