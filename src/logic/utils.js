
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
  const diffDays = Math.floor((to - from) / (1000 * 60 * 60 * 24)) + 1;
  return diffDays > 0 ? diffDays : 1;
}

export const fmt = d => d ? new Date(d).toISOString().slice(0,10) : '-';

export const safeAvg = arr => {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const nums = arr.map(n => Number(n)).filter(Number.isFinite);
  if (!nums.length) return null;
  return nums.reduce((a,b) => a+b,0) / nums.length;
};



const STYLES = [
  { name: 'Default (MapLibre demo)', url: 'https://demotiles.maplibre.org/style.json' },
  { name: 'CARTO Dark Matter', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { name: 'Stadia Dark', url: 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json' },
  { name: 'CARTO Positron (light)', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' }
];