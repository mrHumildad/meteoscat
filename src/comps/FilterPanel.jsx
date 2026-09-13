import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faChevronDown, faCompass, faFloppyDisk, faXmark } from '@fortawesome/free-solid-svg-icons';
import { RainIcon, HumidityIcon, TemperatureIcon, MushroomIcon, ForestIcon, MountainIcon, AnticlineIcon, ViewIcon, HiddenIcon } from '../logic/nounIcons.jsx';
import { useState } from 'react';
import RangeSlider from 'react-range-slider-input';
import { DEFAULTDAYRANGE, limitsForWindow, TYPE_TO_VARIABLE, windowToDates } from '../logic/filterAggregate.js';
import { describeFilterConfig } from '../logic/savedFilters.js';
import { ASPECT_SECTORS } from '../logic/elevation.js';
import { fmtNum, fmtShortCat } from '../logic/utils.js';
import { MCSC_LEGEND } from '../logic/mcscLegend.js';
import { SPECIES, SPECIES_KEYS } from '../logic/speciesRules.js';
import './rangesliders.css';

// Per-filter time ranges (FILTER_REFACTOR_PLAN.md §6): each meteo filter is
// an INSTANCE with its own day range (offsets back from the reference day)
// and its own value band — two sliders per instance. Several instances of
// the same type can stack (they AND together). Altitude and terrain stay
// single and timeless, above the "Mètriques" section.
const MAX_PER_TYPE = 5;      // hard cap per type (panel readability + layer bound)
// New-instance day range: last DEFAULTDAYRANGE days — the shared reference
// constant (filterAggregate.js), also used by the station value windows.

// Humidity works in whole % everywhere: the window aggregates are rounded to
// integers (filterAggregate.js), so slider bounds/step 1, the stored band and
// the labels all agree. Rain/temp keep 1 decimal; `decimals` only rounds what
// the labels show (utils.fmtNum).
const METEO_DEFS = [
  { type: 'rain', label: 'Pluja', unit: 'mm', step: 0.1, decimals: 1, icon: RainIcon, className: 'rain' },
  { type: 'hum', label: 'Humitat', unit: '%', step: 1, decimals: 0, icon: HumidityIcon, className: 'humidity' },
  { type: 'temp', label: 'Temperatura', unit: '°C', step: 0.1, decimals: 1, icon: TemperatureIcon, className: 'temp' },
];
const defOf = type => METEO_DEFS.find(d => d.type === type) ?? null;

// Compass names for the orientation sectors (Catalan), used as tooltips.
const ASPECT_LABELS = {
  N: 'nord', NE: 'nord-est', E: 'est', SE: 'sud-est',
  S: 'sud', SW: 'sud-oest', W: 'oest', NW: 'nord-oest',
};

// Compass-rose geometry for the Orientació picker: the 8 sectors as wedges of
// ONE circle (0° = north/up, clockwise), so picking a facing reads like a
// compass instead of a row of letter chips. Each wedge is centred on its
// sector's bearing and its label sits on the bisector.
const ASPECT_ROSE_R = 44;
const rosePoint = (radius, angleDeg) => {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return [50 + radius * Math.cos(a), 50 + radius * Math.sin(a)];
};
const roseWedge = index => {
  const [x1, y1] = rosePoint(ASPECT_ROSE_R, index * 45 - 22.5);
  const [x2, y2] = rosePoint(ASPECT_ROSE_R, index * 45 + 22.5);
  return `M50 50 L${x1.toFixed(2)} ${y1.toFixed(2)} A${ASPECT_ROSE_R} ${ASPECT_ROSE_R} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`;
};

// ONE schema for every applied filter row, so the panel reads as a single
// list: the filter's own icon on the left (a badge matching its creator
// button), its value in the middle with the day range — when it has one — on
// a second line, and the mute + remove buttons on the right (eye left of ✕).
// Uniform height comes from the `.filter-row` CSS grid. `children` renders
// under the value (the forest / substrate swatches, the aspect disc).
const FilterRow = ({
  icon,
  iconClass,
  value = null,
  range = null,
  muted = false,
  inert = false,
  clickable = false,
  title,
  onClick,
  onToggle,
  onRemove,
  children,
}) => (
  <div
    className={`filter-row${inert ? ' inert' : ''}${muted ? ' muted' : ''}${clickable ? ' clickable' : ''}`}
    title={title}
    onClick={onClick}
  >
    <span className={`filter-instance-icon ${iconClass}`}>{icon}</span>
    <div className="filter-row-main">
      {value != null && <span className="filter-row-value">{value}</span>}
      {range != null && <span className="filter-row-range">{range}</span>}
      {children}
    </div>
    <div className="filter-row-actions">
      <div
        className={`sel-button filter-instance-toggle${muted ? ' off' : ''}`}
        title={muted ? 'Activa el filtre' : 'Desactiva el filtre'}
        aria-pressed={!muted}
        onClick={e => {
          e.stopPropagation();
          onToggle?.();
        }}
      >
        {muted
          ? <HiddenIcon className="noun-icon" />
          : <ViewIcon className="noun-icon" />}
      </div>
      <div
        className="sel-button filter-line-cancel"
        title="Treu el filtre"
        onClick={e => {
          e.stopPropagation();
          onRemove?.();
        }}
      >
        <FontAwesomeIcon icon={faXmark} />
      </div>
    </div>
  </div>
);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FilterPanel = ({
  onClose,
  reliefRange,
  busy = false, // repaint in flight → controls disabled to avoid input floods
  onApplyRelief,
  aspectSectors,
  onApplyAspect,
  mutedFilters,
  onToggleMuted,
  meteoFilters,
  onAddFilter,
  onUpdateFilter,
  onRemoveFilter,
  onToggleFilter,
  agg,
  refDay,
  maxDays,
  altLimits,
  filteredForestCodes,
  onApplyForest,
  lithoLegend,
  geoOff,
  onApplyGeo,
  boletFilter,
  onApplyBolet,
  onSaveFilter,
  // Saved presets (localStorage). The selector at the top of the panel lists
  // them (accordion) and loads one on click; activeName is the preset the live
  // filters currently match — null means "Manual" (nothing loaded, or a loaded
  // preset that was then tweaked). The save button is only live in that state.
  presets = [],
  activeName = null,
  onApplyPreset,
  onDeletePreset,
}) => {
  const [editingId, setEditingId] = useState(null);   // instance currently expanded
  const [pendingId, setPendingId] = useState(null);   // just-added instance: cancel removes it
  const [draft, setDraft] = useState(null);           // { from, to, range } while editing
  const [reliefEditing, setReliefEditing] = useState(false);
  const [reliefDraft, setReliefDraft] = useState(null);
  const [aspectEditing, setAspectEditing] = useState(false);
  const [draftAspect, setDraftAspect] = useState(() => new Set());
  const [forestEditing, setForestEditing] = useState(false);
  const [draftForest, setDraftForest] = useState(() => new Set());
  const [geoEditing, setGeoEditing] = useState(false);
  const [draftGeo, setDraftGeo] = useState(() => new Set());
  const [boletEditing, setBoletEditing] = useState(false);
  const [draftBolet, setDraftBolet] = useState(() => ({
    species: boletFilter?.species ?? 'rovellons',
    threshold: boletFilter?.threshold ?? 0.5,
  }));
  // Save preset (localStorage): none → name input → "Desat: name". The name
  // input reopens pre-filled with the last saved name so re-saving overwrites
  // that same preset (saveFilterPreset) instead of duplicating it.
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [savedName, setSavedName] = useState(null);
  const [presetOpen, setPresetOpen] = useState(false); // preset accordion

  // "Manual" = the live filters match no saved preset: either nothing was
  // loaded, or a loaded preset was modified afterwards (App derives activeName
  // from the filter state, so any edit drops it back to null). Saving is only
  // meaningful in this state — a loaded, unmodified preset has nothing to save.
  const manual = activeName == null;

  const editing = editingId ? meteoFilters.find(f => f.id === editingId) ?? null : null;

  // Window helpers (shared vocabulary with the station filter / map layers)
  const fullSpanOf = f => (agg && f ? limitsForWindow(agg, f.type, f.from, f.to) : null);
  const isInert = f => {
    const span = fullSpanOf(f);
    return span != null && f.range[0] === span[0] && f.range[1] === span[1];
  };
  const datesOf = f => (refDay ? windowToDates(refDay, f.from, f.to) : { from: null, to: null });
  const shortDate = d => (d ? fmtShortCat(d) : '');


  // While editing, the day labels must follow the LIVE draft (slider
  // onInput), not the committed instance `f` — dates and day count recompute
  // on every drag. Day count matches the existing "darrers N dies" wording
  // (from − to, floor 1 for a single-day window).
  const draftDates = draft && refDay ? windowToDates(refDay, draft.from, draft.to) : { from: null, to: null };
  const draftDayCount = draft ? Math.max(1, draft.from - draft.to) : 0;

  // ONLY ONE editor is ever open. Opening any editor (single filter or meteo
  // instance) first closes every other, and a never-applied "pending" new
  // instance is dropped so it can't linger in the list. Together with new
  // instances rendering at the TOP of the list, this keeps the open editor
  // visible instead of pushing it past the bottom of the screen.
  const closeEditors = () => {
    if (pendingId) {
      onRemoveFilter(pendingId);
      setPendingId(null);
    }
    setEditingId(null);
    setForestEditing(false);
    setReliefEditing(false);
    setAspectEditing(false);
    setGeoEditing(false);
    setBoletEditing(false);
  };

  const startEdit = f => {
    closeEditors();
    setDraft({ from: f.from, to: f.to, range: [f.range[0], f.range[1]], span: fullSpanOf(f) });
    setEditingId(f.id);
  };

  // Add a new instance with defaults and open its editor immediately. It is
  // appended to the state list (the app's "last active filter wins" rule for
  // the station value windows reads the array order) but rendered FIRST by the
  // panel — see the reversed map below — so its editor always appears on top.
  const add = type => {
    closeEditors();
    const inst = onAddFilter(type);
    setPendingId(inst.id);
    setDraft({ from: inst.from, to: inst.to, range: [inst.range[0], inst.range[1]], span: fullSpanOf(inst) });
    setEditingId(inst.id);
  };

  // Day slider is drawn on a day-INDEX axis (0 = oldest … maxDays−1 = ref
  // day, rightmost); stored offsets map back with maxDays−1−index. Dragging
  // only moves from/to (keeps the date/day-count labels live); the window's
  // full value span is recomputed on release — see onDayRelease.
  const onDayInput = ([lo, hi]) => {
    if (!editing) return;
    const from = maxDays - 1 - lo;
    const to = maxDays - 1 - hi;
    setDraft(d => ({ ...d, from, to }));
  };

  // Day slider released → compute the min/max of the variable across ALL
  // stations over the new day range (limitsForWindow iterates every station,
  // so once per drag, not per tick) and feed it to the value slider as its
  // bounds, clamping the current band into it.
  const onDayRelease = () => {
    if (!editing) return;
    const span = limitsForWindow(agg, editing.type, draft.from, draft.to);
    setDraft(d => {
      let r0 = d.range[0];
      let r1 = d.range[1];
      if (span) { r0 = clamp(r0, span[0], span[1]); r1 = clamp(r1, span[0], span[1]); }
      return { ...d, span, range: [r0, r1] };
    });
  };

  const onValueInput = ([lo, hi]) => {
    setDraft(d => ({ ...d, range: [lo, hi] }));
  };

  const confirmEdit = () => {
    if (!editing) return;
    onUpdateFilter(editing.id, { from: draft.from, to: draft.to, range: draft.range });
    setPendingId(null);
    setEditingId(null);
  };

  const cancelEdit = () => {
    if (pendingId && editingId) onRemoveFilter(editingId);
    setPendingId(null);
    setEditingId(null);
  };

  // ── Forest (terrain) — unchanged single filter ──────────────────────────
  const forestApplied = (filteredForestCodes?.size ?? 0) > 0;
  const openForestEditor = () => {
    closeEditors();
    setDraftForest(new Set(filteredForestCodes ?? []));
    setForestEditing(true);
  };
  const toggleForestClass = codes => {
    setDraftForest(prev => {
      const next = new Set(prev);
      if (next.has(codes)) next.delete(codes);
      else next.add(codes);
      return next;
    });
  };

  // ── Geology (substrat) — single timeless filter, mirrors the forest one:
  // the legend rows ARE the toggle list; dimmed families are transparent on
  // the map (terrainState.geoOff) and exclude the stations on them
  // (filterStationCodes geo gate). Nodata cells (family 0) are never listed
  // nor filtered — missing substrate info is not a reason to hide anything.
  const geoApplied = (geoOff?.size ?? 0) > 0;
  const openGeoEditor = () => {
    closeEditors();
    setDraftGeo(new Set(geoOff ?? []));
    setGeoEditing(true);
  };
  const toggleGeoFamily = key => {
    setDraftGeo(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // ── Relief (altitude) — single timeless filter ──────────────────────────
  const reliefApplied = reliefRange != null;
  const reliefFull = altLimits ?? [0, 0];
  const openReliefEditor = () => {
    closeEditors();
    setReliefDraft(reliefRange ? [...reliefRange] : [...reliefFull]);
    setReliefEditing(true);
  };

  // ── Orientation (slope aspect) — single timeless filter ─────────────────
  // Keep-selected sectors: no selection (or all 8, which App normalises to
  // null) is "off"; otherwise only land facing one of the picked directions
  // is painted. Flat land (< ASPECT_MIN_SLOPE_DEG) has no sector and is
  // therefore excluded while the filter is active (D2 strict).
  const aspectPicked = ASPECT_SECTORS.filter(s => (aspectSectors ?? []).includes(s));
  const aspectApplied = aspectPicked.length > 0;
  // Single-filter mute state (relief / forest / geo / bolet / aspect); meteo
  // instances carry their own `enabled` flag instead.
  const isMuted = key => mutedFilters?.has(key) ?? false;
  const openAspectEditor = () => {
    closeEditors();
    setDraftAspect(new Set(aspectSectors ?? []));
    setAspectEditing(true);
  };
  const toggleAspectSector = key => {
    setDraftAspect(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const daySliderMax = Math.max(0, maxDays - 1);

  // ── Save preset ─────────────────────────────────────────────────────────
  const openSave = () => {
    setSaveName(savedName ?? '');
    setSaveOpen(true);
  };
  const closeSave = () => {
    setSaveOpen(false);
    setSaveName('');
  };
  const confirmSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSaveFilter?.(name);
    setSavedName(name);
    closeSave();
  };

  return (
    <div className={`filter-panel${busy ? ' busy' : ''}`} aria-busy={busy || undefined}>
      <div className="filter-header">
        
      </div>
      <div className="filter-body">
        {/* Preset selector: shows the loaded preset's name, or "Manual" when
            nothing is loaded / the loaded preset was tweaked. The accordion
            below it lists every saved preset (load = whole filter stack, ✕ =
            delete). */}
        <div className={`filter-preset${presetOpen ? ' open' : ''}`}>
          <button
            type="button"
            className="filter-preset-toggle"
            title={manual ? 'Filtres manuals' : `'reCeta' carregada: ${activeName}`}
            aria-expanded={presetOpen}
            onClick={() => setPresetOpen(o => !o)}
          >
            <span className="filter-preset-name">{activeName ?? 'Manual'}</span>
            <FontAwesomeIcon icon={faChevronDown} className="filter-preset-caret" />
          </button>
          {presetOpen && (
            <div className="filter-preset-list">
              {presets.length === 0 ? (
                <div className="basket-empty">
                  Encara no hi ha cap 'reCeta' desada.
                </div>
              ) : (
                presets.map(p => {
                  const active = p.name === activeName;
                  return (
                    <div key={p.name} className={`basket-item${active ? ' active' : ''}`}>
                      <button
                        type="button"
                        className="basket-item-main"
                        title={active ? "'reCeta' aplicada" : 'Aplica aquesta reCeta'}
                        onClick={() => {
                          closeEditors(); // a loaded preset replaces the stack
                          onApplyPreset?.(p);
                          setPresetOpen(false);
                        }}
                      >
                        <span className="basket-item-name">{p.name}</span>
                        <span className="basket-item-meta">{describeFilterConfig(p.config)}</span>
                      </button>
                      {active && (
                        <span className="basket-item-active" title="'reCeta' aplicada">
                          <FontAwesomeIcon icon={faCheck} />
                        </span>
                      )}
                      <div
                        className="sel-button filter-line-cancel"
                        title="Esborra aquesta 'reCeta'"
                        onClick={() => onDeletePreset?.(p.name)}
                      >
                        <FontAwesomeIcon icon={faXmark} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* Single, timeless filters: terrain + altitude */}
        <div className="filter-buttons">
          <div
            className={`sel-button forest${forestApplied ? ' on' : ''}`}
            title="Filtre de bosc"
            onClick={() => (forestEditing ? setForestEditing(false) : openForestEditor())}
          >
            <ForestIcon className="noun-icon" />
          </div>
          <div
            className={`sel-button mountain${reliefApplied ? ' on' : ''}`}
            title="Filtre de relleu"
            onClick={() => (reliefEditing ? setReliefEditing(false) : openReliefEditor())}
          >
            <MountainIcon className="noun-icon" />
          </div>
          <div
            className={`sel-button compass${aspectApplied ? ' on' : ''}`}
            title="Filtre d'orientació (cara del pendent)"
            onClick={() => (aspectEditing ? setAspectEditing(false) : openAspectEditor())}
          >
            <FontAwesomeIcon icon={faCompass} />
          </div>
          {lithoLegend.length > 0 && (
            <div
              className={`sel-button substrat${geoApplied ? ' on' : ''}`}
              title="Filtre de substrat geològic"
              onClick={() => (geoEditing ? setGeoEditing(false) : openGeoEditor())}
            >
              <AnticlineIcon className="noun-icon" />
            </div>
          )}
          
          {/* Meteo filter creators: icon-only, same row/size as the filters
              above — each click appends an instance below ("Mètriques"). */}
          {METEO_DEFS.map(def => {
            const capped = meteoFilters.filter(f => f.type === def.type).length >= MAX_PER_TYPE;
            return (
              <div
                key={def.type}
                className={`sel-button ${def.className}`}
                title={capped
                  ? `Màxim ${MAX_PER_TYPE} filtres de ${def.label.toLowerCase()}`
                  : `Afegeix un filtre de ${def.label.toLowerCase()}`}
                style={capped ? { opacity: 0.45, pointerEvents: 'none' } : undefined}
                onClick={() => { if (!capped) add(def.type); }}
              >
                <def.icon className="noun-icon" />
              </div>
            );
          })}
        </div>

        {forestEditing && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">Bosc</span>
              <span className="range-value">
                {draftForest.size === 0
                  ? 'Tots els tipus'
                  : `${draftForest.size} tipus atenuat${draftForest.size > 1 ? 's' : ''}`}
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    onApplyForest?.(new Set(draftForest));
                    setForestEditing(false);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setForestEditing(false)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <div className="filter-legend">
              {MCSC_LEGEND.map(entry => {
                const off = draftForest.has(entry.codes);
                return (
                  <button
                    type="button"
                    key={entry.codes}
                    className={`mcsc-legend-row${off ? ' off' : ''}`}
                    title={off ? 'Ressaltar' : 'Atenuar'}
                    onClick={() => toggleForestClass(entry.codes)}
                  >
                    <span className="mcsc-legend-swatch" style={{ '--swatch-color': entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!forestEditing && forestApplied && (
          <FilterRow
            icon={<ForestIcon className="noun-icon" />}
            iconClass="forest"
            title="Bosc"
            muted={isMuted('forest')}
            onToggle={() => onToggleMuted?.('forest')}
            onRemove={() => onApplyForest?.(new Set())}
          >
            {/* Squares for the still-selected (non-dimmed) terrain types,
                hover shows which terrain each square corresponds to */}
            <div className="filter-swatches">
              {MCSC_LEGEND.filter(e => !filteredForestCodes.has(e.codes)).map(entry => (
                <span
                  key={entry.codes}
                  className="mcsc-legend-swatch"
                  style={{ '--swatch-color': entry.color }}
                  title={entry.label}
                />
              ))}
            </div>
          </FilterRow>
        )}

        {geoEditing && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">Substrat geològic</span>
              <span className="range-value">
                {draftGeo.size === 0
                  ? 'Tots els substrats'
                  : `${draftGeo.size} família${draftGeo.size > 1 ? 's' : ''} atenuada${draftGeo.size > 1 ? 's' : ''}`}
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    onApplyGeo?.(new Set(draftGeo));
                    setGeoEditing(false);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setGeoEditing(false)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <div className="filter-legend">
              {lithoLegend.map(entry => {
                const off = draftGeo.has(entry.key);
                return (
                  <button
                    type="button"
                    key={entry.key}
                    className={`mcsc-legend-row${off ? ' off' : ''}`}
                    title={off ? 'Ressaltar' : 'Atenuar'}
                    onClick={() => toggleGeoFamily(entry.key)}
                  >
                    <span className="mcsc-legend-swatch" style={{ '--swatch-color': entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mcsc-legend-footer">Mapa geològic 1:50.000 v3.0 — ICGC · CC BY 4.0</div>
          </div>
        )}

        {!geoEditing && geoApplied && (
          <FilterRow
            icon={<AnticlineIcon className="noun-icon" />}
            iconClass="substrat"
            title="Substrat"
            muted={isMuted('geo')}
            onToggle={() => onToggleMuted?.('geo')}
            onRemove={() => onApplyGeo?.(new Set())}
          >
            {/* Squares for the still-selected (non-dimmed) substrate
                families; hover shows which family each square is */}
            <div className="filter-swatches">
              {lithoLegend.filter(e => !geoOff.has(e.key)).map(entry => (
                <span
                  key={entry.key}
                  className="mcsc-legend-swatch"
                  style={{ '--swatch-color': entry.color }}
                  title={entry.label}
                />
              ))}
            </div>
          </FilterRow>
        )}

        {reliefEditing && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">Relleu</span>
              <span className="range-value">
                {reliefDraft[0]} - {reliefDraft[1]} m
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    onApplyRelief?.(reliefDraft);
                    setReliefEditing(false);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setReliefEditing(false)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <RangeSlider
              min={reliefFull[0]}
              max={reliefFull[1]}
              step={10}
              value={reliefDraft}
              onInput={setReliefDraft}
              disabled={busy}
            />
          </div>
        )}

        {!reliefEditing && reliefApplied && (
          <FilterRow
            icon={<MountainIcon className="noun-icon" />}
            iconClass="mountain"
            title="Relleu"
            value={`${reliefRange[0]} - ${reliefRange[1]} m`}
            muted={isMuted('relief')}
            onToggle={() => onToggleMuted?.('relief')}
            onRemove={() => onApplyRelief?.(null)}
          />
        )}

        {aspectEditing && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">Orientació</span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    // No sector picked = filter off. All 8 picked is also off
                    // (App collapses it), so it never repaints for nothing.
                    const picked = ASPECT_SECTORS.filter(s => draftAspect.has(s));
                    onApplyAspect?.(picked.length && picked.length < 8 ? picked : null);
                    setAspectEditing(false);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setAspectEditing(false)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <svg
              className="aspect-rose"
              viewBox="0 0 100 100"
              role="group"
              aria-label="Orientació"
            >
              {ASPECT_SECTORS.map((s, i) => {
                const on = draftAspect.has(s);
                const [lx, ly] = rosePoint(28, i * 45);
                return (
                  <g key={s}>
                    <path
                      className={`aspect-wedge${on ? ' on' : ''}`}
                      d={roseWedge(i)}
                      role="button"
                      aria-pressed={on}
                      aria-label={ASPECT_LABELS[s]}
                      tabIndex={0}
                      onClick={() => toggleAspectSector(s)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleAspectSector(s);
                        }
                      }}
                    >
                      <title>{ASPECT_LABELS[s]}</title>
                    </path>
                    <text
                      className="aspect-wedge-label"
                      x={lx.toFixed(2)}
                      y={ly.toFixed(2)}
                      textAnchor="middle"
                      dominantBaseline="central"
                    >
                      {s}
                    </text>
                  </g>
                );
              })}
              <circle className="aspect-hub" cx="50" cy="50" r="5" />
            </svg>
          </div>
        )}

        {!aspectEditing && aspectApplied && (
          <FilterRow
            icon={<FontAwesomeIcon icon={faCompass} />}
            iconClass="compass"
            title="Orientació"
            muted={isMuted('aspect')}
            onToggle={() => onToggleMuted?.('aspect')}
            onRemove={() => onApplyAspect?.(null)}
          >
            {/* The applied selection as a plain graphic circle — no letters,
                much smaller than the editor's rose. */}
            <svg className="aspect-mini" viewBox="0 0 100 100" aria-hidden="true">
              {ASPECT_SECTORS.map((s, i) => (
                <path
                  key={s}
                  className={`aspect-mini-wedge${aspectPicked.includes(s) ? ' on' : ''}`}
                  d={roseWedge(i)}
                />
              ))}
              <circle className="aspect-mini-hub" cx="50" cy="50" r="5" />
            </svg>
          </FilterRow>
        )}

        {/* ── Bolets: species rule filter (test) ──────────────────────── */}
        {boletEditing && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">Bolets</span>
              <span className="range-value">
                {SPECIES[draftBolet.species]?.name} · puntuació ≥ {Math.round(draftBolet.threshold * 100)} %
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    onApplyBolet?.(draftBolet);
                    setBoletEditing(false);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setBoletEditing(false)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <div className="filter-legend">
              {SPECIES_KEYS.map(key => {
                const s = SPECIES[key];
                return (
                  <button
                    type="button"
                    key={key}
                    className={`mcsc-legend-row${draftBolet.species === key ? ' on' : ''}`}
                    onClick={() => setDraftBolet(d => ({ ...d, species: key }))}
                  >
                    <span className="mcsc-legend-label">{s.name}</span>
                    <span className="mcsc-legend-sub">{s.latin}</span>
                  </button>
                );
              })}
            </div>
            <div className="filter-editor-row">
              <div className="filter-editor-label">
                <span>Llindar de puntuació</span>
                <span className="range-value">≥ {Math.round(draftBolet.threshold * 100)} %</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={draftBolet.threshold}
                onChange={e => setDraftBolet(d => ({ ...d, threshold: Number(e.target.value) }))}
                aria-label="Llindar de puntuació"
              />
            </div>
            <div className="mcsc-legend-footer">Regles d'espècie en proves (rovellons/ceps primer)</div>
          </div>
        )}

        {!boletEditing && boletFilter && (
          <FilterRow
            icon={<MushroomIcon className="noun-icon" />}
            iconClass="bolet"
            title="Bolets"
            value={`${SPECIES[boletFilter.species]?.name} · ≥ ${Math.round(boletFilter.threshold * 100)} %`}
            muted={isMuted('bolet')}
            onToggle={() => onToggleMuted?.('bolet')}
            onRemove={() => onApplyBolet?.(null)}
          />
        )}

        {/* Newest first: a freshly added instance (last in the state list) is
            rendered on top, so its open editor is always in view. */}
        {[...meteoFilters].reverse().map(f => {
          const def = defOf(f.type);
          if (!def) return null;
          const isEditingThis = f.id === editingId && editing;

          if (isEditingThis) {
            // Value-slider bounds follow the DRAFT window: set on startEdit /
            // add, refreshed on day-slider release (onDayRelease).
            const span = draft.span;
            return (
              <div key={f.id} className={`filter-instance ${def.className} editing`}>
                <div className="filter-instance-header">
                  <span className="filter-instance-title">{def.label} (editant)</span>
                  <div className="filter-instance-actions">
                    <div
                      className="sel-button filter-line-ok"
                      title="D'acord"
                      onClick={confirmEdit}
                    >
                      <FontAwesomeIcon icon={faCheck} />
                    </div>
                    <div
                      className="sel-button filter-line-cancel"
                      title="Cancel·la"
                      onClick={cancelEdit}
                    >
                      <FontAwesomeIcon icon={faXmark} />
                    </div>
                  </div>
                </div>
                <div className="filter-editor">
                  <div className="filter-editor-row">
                    <div className="filter-editor-label">
                      <span>{shortDate(draftDates.from)} – {shortDate(draftDates.to)}</span>
                      <span className="range-value">{draftDayCount} dies</span>
                    </div>
                    <RangeSlider
                      min={0}
                      max={daySliderMax}
                      step={1}
                      value={[daySliderMax - draft.from, daySliderMax - draft.to]}
                      onInput={onDayInput}
                      onThumbDragEnd={onDayRelease}
                      disabled={busy}
                      ariaLabel={['Inici del període', 'Fi del període']}
                    />
                  </div>
                  <div className="filter-editor-row">
                    <div className="filter-editor-label">
                      <span>valor: {fmtNum(draft.range[0], def.decimals)} – {fmtNum(draft.range[1], def.decimals)} {def.unit}</span>
                      <span className="range-value">
                        {span ? `${fmtNum(span[0], def.decimals)} – ${fmtNum(span[1], def.decimals)} ${def.unit} disponibles` : ''}
                      </span>
                    </div>
                    <RangeSlider
                      min={span?.[0] ?? 0}
                      max={span?.[1] ?? 1}
                      step={def.step}
                      value={draft.range}
                      onInput={onValueInput}
                      disabled={busy || !span}
                      ariaLabel={['Valor mínim', 'Valor màxim']}
                    />
                  </div>
                </div>
              </div>
            );
          }

          const inert = isInert(f);
          const muted = f.enabled === false;
          return (
            <FilterRow
              key={f.id}
              clickable
              inert={inert}
              muted={muted}
              title="Edita el filtre"
              onClick={() => startEdit(f)}
              icon={<def.icon className="noun-icon" />}
              iconClass={def.className}
              value={inert
                ? 'qualsevol valor · inactiu'
                : `${fmtNum(f.range[0], def.decimals)} – ${fmtNum(f.range[1], def.decimals)} ${def.unit}`}
              range={`${shortDate(datesOf(f).from)} – ${shortDate(datesOf(f).to)}`}
              onToggle={() => onToggleFilter?.(f.id)}
              onRemove={() => onRemoveFilter(f.id)}
            />
          );
        })}

        {/* ── Save preset: whole filter stack under a name (localStorage) ── */}
        <div className="filter-save">
          {saveOpen ? (
            <div className="filter-save-row">
              <input
                type="text"
                className="filter-save-input"
                value={saveName}
                autoFocus
                maxLength={40}
                placeholder="Nom del filtre"
                aria-label="Nom del filtre"
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmSave();
                  if (e.key === 'Escape') closeSave();
                }}
              />
              <div
                className="sel-button filter-line-ok"
                title="Desa"
                onClick={confirmSave}
              >
                <FontAwesomeIcon icon={faCheck} />
              </div>
              <div
                className="sel-button filter-line-cancel"
                title="Cancel·la"
                onClick={closeSave}
              >
                <FontAwesomeIcon icon={faXmark} />
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={`filter-save-btn${manual ? (savedName ? ' saved' : '') : ' disabled'}`}
              title={manual
                ? "Desa la configuració de filtres"
                : `Ja tens la 'reCeta' "${activeName}" carregada — modifica-la per tornar a Manual`}
              disabled={!manual}
              onClick={openSave}
            >
              <FontAwesomeIcon icon={faFloppyDisk} />{' '}
              {"Desa la teva 'reCeta'"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default FilterPanel;