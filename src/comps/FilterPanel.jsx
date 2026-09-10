import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCarrot, faCheck, faDroplet, faLayerGroup, faMountain, faSeedling, faTemperatureLow, faTree, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import RangeSlider from 'react-range-slider-input';
import { DEFAULTDAYRANGE, dayRangeLabel, limitsForWindow, TYPE_TO_VARIABLE, windowToDates } from '../logic/filterAggregate.js';
import { fmtNum, fmtShortCat } from '../logic/utils.js';
import { MCSC_LEGEND, MCSC_GREY } from '../logic/mcscLegend.js';
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
  { type: 'rain', label: 'Pluja', unit: 'mm', step: 0.1, decimals: 1, icon: faDroplet, className: 'rain' },
  { type: 'hum', label: 'Humitat', unit: '%', step: 1, decimals: 0, icon: faSeedling, className: 'humidity' },
  { type: 'temp', label: 'Temperatura', unit: '°C', step: 0.1, decimals: 1, icon: faTemperatureLow, className: 'temp' },
];
const defOf = type => METEO_DEFS.find(d => d.type === type) ?? null;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const FilterPanel = ({
  onClose,
  reliefRange,
  busy = false, // repaint in flight → controls disabled to avoid input floods
  onApplyRelief,
  meteoFilters,
  onAddFilter,
  onUpdateFilter,
  onRemoveFilter,
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
}) => {
  const [editingId, setEditingId] = useState(null);   // instance currently expanded
  const [pendingId, setPendingId] = useState(null);   // just-added instance: cancel removes it
  const [draft, setDraft] = useState(null);           // { from, to, range } while editing
  const [reliefEditing, setReliefEditing] = useState(false);
  const [reliefDraft, setReliefDraft] = useState(null);
  const [forestEditing, setForestEditing] = useState(false);
  const [draftForest, setDraftForest] = useState(() => new Set());
  const [geoEditing, setGeoEditing] = useState(false);
  const [draftGeo, setDraftGeo] = useState(() => new Set());
  const [boletEditing, setBoletEditing] = useState(false);
  const [draftBolet, setDraftBolet] = useState(() => ({
    species: boletFilter?.species ?? 'rovellons',
    threshold: boletFilter?.threshold ?? 0.5,
  }));

  const editing = editingId ? meteoFilters.find(f => f.id === editingId) ?? null : null;

  // Window helpers (shared vocabulary with the station filter / map layers)
  const fullSpanOf = f => (agg && f ? limitsForWindow(agg, f.type, f.from, f.to) : null);
  const isInert = f => {
    const span = fullSpanOf(f);
    return span != null && f.range[0] === span[0] && f.range[1] === span[1];
  };
  const datesOf = f => (refDay ? windowToDates(refDay, f.from, f.to) : { from: null, to: null });
  const shortDate = d => (d ? fmtShortCat(d) : '');
  const dayLabel = f => dayRangeLabel(f.from, f.to); // shared wording with the station-info span

  // While editing, the day labels must follow the LIVE draft (slider
  // onInput), not the committed instance `f` — dates and day count recompute
  // on every drag. Day count matches the existing "darrers N dies" wording
  // (from − to, floor 1 for a single-day window).
  const draftDates = draft && refDay ? windowToDates(refDay, draft.from, draft.to) : { from: null, to: null };
  const draftDayCount = draft ? Math.max(1, draft.from - draft.to) : 0;

  const startEdit = f => {
    setDraft({ from: f.from, to: f.to, range: [f.range[0], f.range[1]], span: fullSpanOf(f) });
    setPendingId(null);
    setEditingId(f.id);
  };

  // Add a new instance with defaults and open its editor immediately. A
  // pending (never-applied) editor is dropped first — one editor at a time.
  const add = type => {
    if (pendingId) onRemoveFilter(pendingId);
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
    setReliefDraft(reliefRange ? [...reliefRange] : [...reliefFull]);
    setReliefEditing(true);
  };

  const daySliderMax = Math.max(0, maxDays - 1);

  return (
    <div className={`filter-panel${busy ? ' busy' : ''}`} aria-busy={busy || undefined}>
      <div className="filter-header">
        <span className="filter-title">Filtres</span>
        <span className="filter-anchor" title="Dia de referència (últimes dades disponibles)">
          fins a les dades del {shortDate(refDay)}
        </span>
        <div className="filter-actions">
          <div
            className="sel-button filter-close"
            title="Tanca"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} />
          </div>
        </div>
      </div>
      <div className="filter-body">
        {/* Single, timeless filters: terrain + altitude */}
        <div className="filter-buttons">
          <div
            className={`sel-button forest${forestApplied ? ' on' : ''}`}
            title="Filtre de bosc"
            onClick={() => (forestEditing ? setForestEditing(false) : openForestEditor())}
          >
            <FontAwesomeIcon icon={faTree} />
          </div>
          <div
            className={`sel-button mountain${reliefApplied ? ' on' : ''}`}
            title="Filtre de relleu"
            onClick={() => (reliefEditing ? setReliefEditing(false) : openReliefEditor())}
          >
            <FontAwesomeIcon icon={faMountain} />
          </div>
          {lithoLegend.length > 0 && (
            <div
              className={`sel-button substrat${geoApplied ? ' on' : ''}`}
              title="Filtre de substrat geològic"
              onClick={() => (geoEditing ? setGeoEditing(false) : openGeoEditor())}
            >
              <FontAwesomeIcon icon={faLayerGroup} />
            </div>
          )}
          <div
            className={`sel-button bolet${boletFilter ? ' on' : ''}`}
            title="Filtre de bolets (regles d'espècie — prova)"
            onClick={() => (boletEditing ? setBoletEditing(false) : setBoletEditing(true))}
          >
            <FontAwesomeIcon icon={faCarrot} />
          </div>
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
                    <span className="mcsc-legend-swatch" style={{ backgroundColor: off ? MCSC_GREY : entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {!forestEditing && forestApplied && (
          <div className="filter-line applied">
            <div className="filter-line-header">
              <span className="filter-line-label">Bosc</span>
              {/* Squares for the still-selected (non-dimmed) terrain types,
                  hover shows which terrain each square corresponds to */}
              <div className="filter-swatches">
                {MCSC_LEGEND.filter(e => !filteredForestCodes.has(e.codes)).map(entry => (
                  <span
                    key={entry.codes}
                    className="mcsc-legend-swatch"
                    style={{ backgroundColor: entry.color }}
                    title={entry.label}
                  />
                ))}
              </div>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-cancel"
                  title="Treu el filtre"
                  onClick={() => onApplyForest?.(new Set())}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
          </div>
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
                    <span className="mcsc-legend-swatch" style={{ backgroundColor: off ? MCSC_GREY : entry.color }} />
                    <span className="mcsc-legend-label">{entry.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="mcsc-legend-footer">Mapa geològic 1:50.000 v3.0 — ICGC · CC BY 4.0</div>
          </div>
        )}

        {!geoEditing && geoApplied && (
          <div className="filter-line applied">
            <div className="filter-line-header">
              <span className="filter-line-label">Substrat</span>
              {/* Squares for the still-selected (non-dimmed) substrate
                  families; hover shows which family each square is */}
              <div className="filter-swatches">
                {lithoLegend.filter(e => !geoOff.has(e.key)).map(entry => (
                  <span
                    key={entry.key}
                    className="mcsc-legend-swatch"
                    style={{ backgroundColor: entry.color }}
                    title={entry.label}
                  />
                ))}
              </div>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-cancel"
                  title="Treu el filtre"
                  onClick={() => onApplyGeo?.(new Set())}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
          </div>
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
          <div className="filter-line applied">
            <div className="filter-line-header">
              <span className="filter-line-label">Relleu</span>
              <span className="range-value">
                {reliefRange[0]} - {reliefRange[1]} m
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-cancel"
                  title="Treu el filtre"
                  onClick={() => onApplyRelief?.(null)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
          </div>
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
          <div className="filter-line applied">
            <div className="filter-line-header">
              <span className="filter-line-label">Bolets</span>
              <span className="range-value">
                {SPECIES[boletFilter.species]?.name} · ≥ {Math.round(boletFilter.threshold * 100)} %
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-cancel"
                  title="Treu el filtre"
                  onClick={() => onApplyBolet?.(null)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Mètriques: per-instance filters with their own period ─────── */}
        <div className="filter-section-label">Mètriques (cada filtre amb el seu període)</div>
        <div className="filter-add-buttons">
          {METEO_DEFS.map(def => {
            const count = meteoFilters.filter(f => f.type === def.type).length;
            const capped = count >= MAX_PER_TYPE;
            return (
              <button
                type="button"
                key={def.type}
                className={`filter-add-btn ${def.className}`}
                disabled={capped}
                title={capped
                  ? `Màxim ${MAX_PER_TYPE} filtres de ${def.label.toLowerCase()}`
                  : `Afegeix un filtre de ${def.label.toLowerCase()}`}
                onClick={() => add(def.type)}
              >
                + <FontAwesomeIcon icon={def.icon} /> {def.label}
              </button>
            );
          })}
        </div>

        {meteoFilters.map(f => {
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
          return (
            <div
              key={f.id}
              className={`filter-instance ${def.className}${inert ? ' inert' : ''}`}
              title="Edita el filtre"
              onClick={() => startEdit(f)}
            >
              <div className="filter-instance-header">
                <span className="filter-instance-title">
                  {def.label} · {shortDate(datesOf(f).from)} – {shortDate(datesOf(f).to)} ({dayLabel(f)})
                </span>
                <div className="filter-instance-actions">
                  <div
                    className="sel-button filter-line-cancel"
                    title="Treu el filtre"
                    onClick={e => {
                      e.stopPropagation();
                      onRemoveFilter(f.id);
                    }}
                  >
                    <FontAwesomeIcon icon={faXmark} />
                  </div>
                </div>
              </div>
              <div className="filter-instance-value">
                {inert ? 'qualsevol valor · inactiu' : `${fmtNum(f.range[0], def.decimals)} – ${fmtNum(f.range[1], def.decimals)} ${def.unit}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FilterPanel;