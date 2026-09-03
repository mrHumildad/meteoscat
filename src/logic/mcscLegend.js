// Legend for the MCSC forest / land-cover overlay (ICGC WMS "cobertes_2024").
// Colours are the official ones served by the WMS (GetLegendGraphic), in the
// official class order; the mapping was cross-checked by sampling map pixels
// at XEMA stations whose MCSC class is known from forest_types.json.
//
// The legend doubles as a switch panel: every entry starts highlighted and the
// user can press one to dim it to grey (MCSC_GREY — the same colour for every
// dimmed entry, both in the legend and on the map).
//
// `values` are the raster band values each entry controls. The cobertes_2024
// raster is a palette map — every pixel holds an integer band value that the
// WMS exposes as "class = '<classCode>. (<band>) <name>'", e.g. '342. (22)
// Eixample'. Bands follow MCSC class-code order, so each entry's values are
// its position in that order (verified by sampling: 342 Eixample → 22,
// 224 Matollar → 10, 113 Vinyes → 3):
//   111–116 → 1-6, 221→7, 222→8, 223→9, 224→10, 225→11, 226→12, 227→13,
//   228→14, 229→15, 230–234 → 16-20, 341–355 → 21-35, 461–466 → 36-41.
// Data source: Institut Cartogràfic i Geològic de Catalunya (ICGC) i CREAF,
// Mapa de Cobertes del Sòl de Catalunya v1.0 — CC BY 4.0.

// Colour shared by all water classes (mar, llacs, embassaments). Also used to
// paint the open sea: the MCSC raster leaves the ocean outside its tiles, so
// the app fills it with this colour to match the water terrain.
export const MCSC_WATER_COLOR = '#000080';

export const MCSC_LEGEND = [
  { color: '#33cc33', label: "Bosc d'aciculifolis (pins, avets)", codes: '221/225', values: [7, 11] },
  { color: '#66ff33', label: 'Bosc de caducifolis (roures, fagedes)', codes: '222/226', values: [8, 12] },
  { color: '#689018', label: "Bosc d'esclerofil·les (alzina, surera)", codes: '223/227', values: [9, 13] },
  { color: '#00ff9b', label: 'Bosc de ribera', codes: '229', values: [15] },
  { color: '#967d5f', label: 'Matollar', codes: '224', values: [10] },
  { color: '#c3c3a0', label: 'Prats i herbassars', codes: '228', values: [14] },
  { color: '#ffff00', label: 'Conreus', codes: '111–116', values: [1, 2, 3, 4, 5, 6] },
  { color: '#ff007d', label: 'Zones urbanes', codes: '341–355', values: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35] },
  { color: MCSC_WATER_COLOR, label: 'Aigües (mar, llacs, embassaments)', codes: '461–466', values: [36, 37, 38, 39, 40, 41] },
];

// Single grey used by the legend UI for a dimmed (off) swatch. The MAP no
// longer paints grey for unselected areas — dimmed classes (and areas that
// fail the stacked filters) are transparent, so the relief shows through.
export const MCSC_GREY = '#8a8a8a';

// Raster band values that exist on the map but have no legend entry of their
// own (230 sòl nu forestal, 231 zones cremades, 232 roquissars, 233 platges,
// 234 zones humides). They are never selectable, so they are treated like
// "no terrain info" and left transparent (relief shows through).
export const MCSC_EXTRA_VALUES = [16, 17, 18, 19, 20];

// Lowest / highest MCSC palette band value (bands follow class-code order,
// 111–116 → 1-6 … 461–466 → 36-41, plus 230–234 → 16-20 — contiguous 1..41).
export const MCSC_BAND_MIN = 1;
export const MCSC_BAND_MAX = 41;

// The Aigües (water) legend entry — inland water bodies within the raster.
// Like the open sea (handled by the sea overlay), water is painted when its
// legend switch is on and transparent when dimmed; it is never gated by the
// altitude / meteo conditions (water is not "mushroom terrain").
export const MCSC_WATER_ENTRY = MCSC_LEGEND.find(e => e.label.startsWith('Aigües')) ?? null;
export const MCSC_WATER_VALUES = MCSC_WATER_ENTRY?.values ?? [];

// Legend entry controlling a band value, or null for unlisted bands
// (230-234 sòl nu / zones cremades / roquissars / platges / zones humides).
export const entryForBand = (band, legend = MCSC_LEGEND) =>
  legend.find(e => e.values.includes(band)) ?? null;

// True for band values of the Aigües (water) legend entry.
export const isWaterBand = (band) => MCSC_WATER_VALUES.includes(band);

// Build the inline SLD that asks the MCSC WMS for the RAW palette value per
// pixel, encoded as the red channel (band v → colour rgb(v,0,0)) so the app
// can decode it client-side (everything else transparent). The stacked
// terrain layer paints the official class colour itself, gated by every
// active filter — the server never applies class colours / dimming anymore.
export function renderBandSld() {
  const entries = [];
  for (let v = MCSC_BAND_MIN; v <= MCSC_BAND_MAX; v++) {
    const hex = v.toString(16).padStart(2, '0');
    entries.push(`<ColorMapEntry color="#${hex}0000" quantity="${v}"/>`);
  }
  return (
    '<StyledLayerDescriptor version="1.0.0" ' +
    'xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">' +
    '<NamedLayer><Name>cobertes_2024</Name><UserStyle><Title>mcsc</Title>' +
    '<FeatureTypeStyle><Rule><RasterSymbolizer><ColorMap type="values">' +
    entries.join('') +
    '</ColorMap></RasterSymbolizer></Rule></FeatureTypeStyle></UserStyle>' +
    '</NamedLayer></StyledLayerDescriptor>'
  );
}