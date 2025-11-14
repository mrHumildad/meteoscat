import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

console.log('geojsonCreator: module loaded, argv:', process && process.argv ? process.argv.slice(0,3) : null);

export function stationsToGeoJSON(stations) {
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

    const { coordenades, longitud, latitud, lon: _lon, lat: _lat, ...rest } = s;

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        codi: s.codi ?? null,
        nom: s.nom ?? null,
        altitud: s.altitud ?? null,
        comarca: s.comarca ?? null,
        ...rest
      }
    };
  }).filter(Boolean);

  return { type: 'FeatureCollection', features };
}

// CLI
async function runCli() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const root = path.resolve(__dirname, '..', '..');
  const inPath = path.join(root, 'stations.json');
  const outDir = path.join(root, 'src', 'logic');
  const outPath = path.join(outDir, 'stations.geojson');

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
        return /^[\[\]\{\}",:\-0-9]|^"/.test(t);
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
  const geo = stationsToGeoJSON(stations);
  console.log('Feature count after conversion:', geo.features.length);

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