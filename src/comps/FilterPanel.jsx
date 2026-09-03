import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faDroplet, faMountain, faSeedling, faTemperatureLow, faTree, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useState } from 'react';
import RangeSlider from 'react-range-slider-input';
import { limitsForWindow, TYPE_TO_VARIABLE, windowToDates } from '../logic/filterAggregate.js';
import { fmtNum, fmtShortCat } from '../logic/utils.js';
import { MCSC_LEGEND, MCSC_GREY } from '../logic/mcscLegend.js';
import './rangesliders.css';

// Per-filter time ranges (FILTER_REFACTOR_PLAN.md §6): each meteo filter is
// an INSTANCE with its own day range (offsets back from the reference day)
// and its own value band — two sliders per instance. Several instances of
// the same type can stack (they AND together). Altitude and terrain stay
// single and timeless, above the "Mètriques" section.
const MAX_PER_TYPE = 5;      // hard cap per type (panel readability + layer bound)
const DAY_DEFAULT = 60;      // new-instance day range: last 60 days

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
}) => {
  const [editingId, setEditingId] = useState(null);   // instance currently expanded
  const [pendingId, setPendingId] = useState(null);   // just-added instance: cancel removes it
  const [draft, setDraft] = useState(null);           // { from, to, range } while editing
  const [reliefEditing, setReliefEditing] = useState(false);
  const [reliefDraft, setReliefDraft] = useState(null);
  const [forestEditing, setForestEditing] = useState(false);
  const [draftForest, setDraftForest] = useState(() => new Set());

  const editing = editingId ? meteoFilters.find(f => f.id === editingId) ?? null : null;

  // Window helpers (shared vocabulary with the station filter / map layers)
  const fullSpanOf = f => (agg && f ? limitsForWindow(agg, f.type, f.from, f.to) : null);
  const isInert = f => {
    const span = fullSpanOf(f);
    return span != null && f.range[0] === span[0] && f.range[1] === span[1];
  };
  const datesOf = f => (refDay ? windowToDates(refDay, f.from, f.to) : { from: null, to: null });
  const shortDate = d => (d ? fmtShortCat(d) : '');
  const dayLabel = f => {
    if (f.to === 0) return `darrers ${f.from} dies`;
    if (f.from === f.to) return `fa ${f.from} dies`;
    return `fa ${f.from} → fa ${f.to} dies`;
  };

  const startEdit = f => {
    setDraft({ from: f.from, to: f.to, range: [f.range[0], f.range[1]] });
    setPendingId(null);
    setEditingId(f.id);
  };

  // Add a new instance with defaults and open its editor immediately. A
  // pending (never-applied) editor is dropped first — one editor at a time.
  const add = type => {
    if (pendingId) onRemoveFilter(pendingId);
    const inst = onAddFilter(type);
    setPendingId(inst.id);
    setDraft({ from: inst.from, to: inst.to, range: [inst.range[0], inst.range[1]] });
    setEditingId(inst.id);
  };

  // Day slider is drawn on a day-INDEX axis (0 = oldest … maxDays−1 = ref
  // day, rightmost); stored offsets map back with maxDays−1−index. When the
  // window changes, the value band clamps into the new window's full span.
  const onDayInput = ([lo, hi]) => {
    if (!editing) return;
    const from = maxDays - 1 - lo;
    const to = maxDays - 1 - hi;
    const span = limitsForWindow(agg, editing.type, from, to);
    let r0 = draft.range[0];
    let r1 = draft.range[1];
    if (span) { r0 = clamp(r0, span[0], span[1]); r1 = clamp(r1, span[0], span[1]); }
    setDraft({ from, to, range: [r0, r1] });
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

  // ── Relief (altitude) — single timeless filter ──────────────────────────
  const reliefApplied = reliefRange != null;
  const reliefFull = altLimits ?? [0, 0];
  const openReliefEditor = () => {
    setReliefDraft(reliefRange ? [...reliefRange] : [...reliefFull]);
    setReliefEditing(true);
  };

  const daySliderMax = Math.max(0, maxDays - 1);

  return (
    <div className="filter-panel">
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
            const span = fullSpanOf(f);
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
                      <span>{shortDate(datesOf(f).from)} – {shortDate(datesOf(f).to)}</span>
                      <span className="range-value">{dayLabel(f)}</span>
                    </div>
                    <RangeSlider
                      min={0}
                      max={daySliderMax}
                      step={1}
                      value={[daySliderMax - draft.from, daySliderMax - draft.to]}
                      onInput={onDayInput}
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
                      disabled={!span}
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