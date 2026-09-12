import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('geojsonCreator: module loaded, argv:', process && process.argv ? process.argv.slice(0,3) : null);

// MCSC attribution (mandatory under CC BY 4.0 when forest data is embedded)
const MCSC_ATTRIBUTION =
  'Mapa de Cobertes del Sòl de Catalunya (MCSC) v1.0 — ICGC & CREAF, ' +
  'layer cobertes_2024 — CC BY 4.0 — http://www.icgc.cat';

/**
 * stations.json entries -> GeoJSON FeatureCollection.
 * Optional enrichment:
 *   meta  = the server repo's meteokat/meta.json map {codi: {tipus,
 *            emplacament, municipi}}
 *   forest = public/logic/forest_types.json map {codi: {mcscClass,
 *            mcscName, forestType}}
 */
export function stationsToGeoJSON(stations, { meta = {}, forest = {} } = {}) {
  if (!Array.isArray(stations)) throw new TypeError('stations must be an array');

  const features = stations.map((s, idx) => {
    if (!s || typeof s !== 'object') {
      console.debug(`skip index ${idx}: not an object`);
      return null;
    }

    const lonRaw = s.coordenades && s.coordenades.longitud;
    const latRaw = s.coordenades && s.coordenades.latitud;
    const lon = Number(lonRaw);
    const lat = Number(latRaw);

    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      console.debug(`skip ${s.codi ?? 'unknown'}: invalid coords lon=${lonRaw} lat=${latRaw}`);
      return null;
    }

    // strip coords/aliases from properties; underscore-prefixed renames keep
    // them out of `rest` without tripping no-unused-vars
    const { coordenades: _coordenades, longitud: _longitud, latitud: _latitud, lon: _lon, lat: _lat, ...rest } = s;
    const m = meta[s.codi] || {};
    const f = forest[s.codi] || {};

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        codi: s.codi ?? null,
        nom: s.nom ?? null,
        altitud: s.altitud ?? null,
        comarca: s.comarca ?? null,
        tipus: m.tipus ?? null,
        emplacament: m.emplacament ?? null,
        municipi: m.municipi?.nom ?? null,
        municipiCodi: m.municipi?.codi ?? null,
        mcscClass: f.mcscClass ?? null,
        mcscName: f.mcscName ?? null,
        forestType: f.forestType ?? null,
        ...rest
      }
    };
  }).filter(Boolean);

  const geo = { type: 'FeatureCollection', features };
  if (Object.keys(forest).length) {
    geo.attribution = MCSC_ATTRIBUTION;
  }
  return geo;
}

// CLI
async function runCli() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const root = path.resolve(__dirname, '..', '..');
  const opt = (name, dflt) => {
    const i = process.argv.indexOf(name);
    return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
  };
  const inPath = opt('--stations', path.join(root, 'src', 'logic', 'stations.json'));
  // meta.json is the scraper's station index and lives in the SERVER repo.
  // Default to the sibling checkout (../server, the layout of a combined
  // checkout); in a standalone clone pass --meta to point at it — this is
  // optional enrichment, so a miss only logs a warning.
  const metaPath = opt('--meta', path.join(root, '..', 'server', 'meteokat', 'meta.json'));
  const forestPath = opt('--forest', path.join(root, 'public', 'logic', 'forest_types.json'));
  const outPath = opt('--out', path.join(root, 'public', 'logic', 'stations.geojson'));

  const readJsonOptional = (p, label) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (err) {
      console.warn(`Warning: could not load ${label} (${p}): ${err.message}`);
      return null;
    }
  };

  console.log('geojsonCreator: start');
  console.log('Reading:', inPath);

  let raw;
  try {
    raw = fs.readFileSync(inPath, 'utf8');
    console.log('Read file length:', raw.length);
  } catch (err) {
    console.error('Error reading stations.json:', err.message);
    process.exitCode = 1;
    return;
  }

  let stations = null;
  try {
    stations = JSON.parse(raw);
    console.log('Parsed stations.json directly. items:', Array.isArray(stations) ? stations.length : typeof stations);
  } catch (e) {
    console.warn('Direct JSON.parse failed:', e.message);
    // Attempt simple bracket-slice repair
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    console.log('Bracket indices:', start, end);
    if (start !== -1 && end !== -1) {
      let slice = raw.slice(start, end + 1);

      // quick clean: remove obvious non-JSON stray lines (like lone words)
      slice = slice.split('\n').filter(line => {
        const t = line.trim();
        if (t === '') return true;
        // keep lines that start with json chars or quotes or braces
        return /^[[\]{}",:0-9-]|^"/.test(t);
      }).join('\n');

      // remove empty object placeholders and trailing commas
      slice = slice.replace(/,\s*\{\s*\}/g, '');
      slice = slice.replace(/,\s*(\]|\})/g, '$1');

      try {
        stations = JSON.parse(slice);
        console.log('Parsed after slice/repair. items:', Array.isArray(stations) ? stations.length : typeof stations);
      } catch (e2) {
        console.warn('Parse after slice failed:', e2.message);
        // fallback: extract objects that contain "codi"
        const objRegex = /\{[^}]*"codi"[^}]*\}/g;
        const matches = raw.match(objRegex) || [];
        console.log('Regex matches for objects with "codi":', matches.length);
        const parsed = [];
        for (const [i, m] of matches.entries()) {
          try {
            parsed.push(JSON.parse(m));
          } catch (e3) {
            console.debug('Skipping malformed match index', i, e3.message);
          }
        }
        if (parsed.length) {
          stations = parsed;
          console.log('Parsed fallback objects. items:', parsed.length);
        }
      }
    } else {
      console.warn('Could not find array boundaries in file.');
    }
  }

  if (!Array.isArray(stations)) {
    console.error('Could not parse stations.json into an array. Aborting.');
    process.exitCode = 1;
    return;
  }

  console.log('Converting', stations.length, 'stations to GeoJSON features');
  const meta = readJsonOptional(metaPath, 'meteokat meta.json');
  const forest = readJsonOptional(forestPath, 'forest types');
  const geo = stationsToGeoJSON(stations, { meta: meta || {}, forest: forest || {} });
  console.log('Feature count after conversion:', geo.features.length);
  if (forest && geo.attribution) console.log('MCSC attribution attached:', geo.attribution);

  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) {
    console.log('Creating output directory:', outDir);
    fs.mkdirSync(outDir, { recursive: true });
  }

  try {
    fs.writeFileSync(outPath, JSON.stringify(geo, null, 2), 'utf8');
    console.log('Wrote', outPath, 'features:', geo.features.length);
  } catch (werr) {
    console.error('Error writing geojson:', werr.message);
    process.exitCode = 1;
  }
}

// run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log('geojsonCreator: running as script (ESM)');
  runCli().catch(err => {
    console.error('Unhandled error in runCli:', err);
    process.exit(1);
  });
}