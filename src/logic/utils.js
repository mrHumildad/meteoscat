
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







const STYLES = [
  { name: 'Default (MapLibre demo)', url: 'https://demotiles.maplibre.org/style.json' },
  { name: 'CARTO Dark Matter', url: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json' },
  { name: 'Stadia Dark', url: 'https://tiles.stadiamaps.com/styles/alidade_smooth_dark.json' },
  { name: 'CARTO Positron (light)', url: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json' }
];