import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faDroplet, faMountain, faSeedling, faTemperatureLow, faTree, faXmark } from '@fortawesome/free-solid-svg-icons';
import { useEffect, useState } from 'react';
import RangeSlider from 'react-range-slider-input';
import { filterStationCodes } from '../logic/filterStations.js';
import { MCSC_LEGEND, MCSC_GREY } from '../logic/mcscLegend.js';
import './rangesliders.css';

// Rebuilt filter section — an unified *area* selector. Each slider-driven
// filter (relief, rain, humidity, temperature) draws its grey mask on the
// map; while editing it shows its controls (slider + OK/Cancel), once applied
// the controls collapse and only the rule stays, with a cancel button.
// Applied bands stack, so the non-grey area is where ALL active filters pass
// — the same AND semantics as the station filter (filterStationCodes).
const FILTER_DEFS = [
  { key: 'relief', label: 'Relleu', unit: 'm', step: 10, limits: 'alt', icon: faMountain, className: 'mountain', title: 'Filtre de relleu' },
  { key: 'rain', label: 'Pluja', unit: 'mm', step: 0.1, limits: 'rain', icon: faDroplet, className: 'rain', title: 'Filtre de pluja' },
  { key: 'hum', label: 'Humitat', unit: '%', step: 0.1, limits: 'hum', icon: faSeedling, className: 'humidity', title: "Filtre d'humitat" },
  { key: 'temp', label: 'Temperatura', unit: '°C', step: 0.1, limits: 'temp', icon: faTemperatureLow, className: 'temp', title: 'Filtre de temperatura' },
];

const FilterPanel = ({
  onClose,
  onApply,
  rangeLimits,
  stations,
  areaRanges,          // applied ranges per filter key { relief, rain, hum, temp }; null = off (lifted to App)
  onApplyAreaRange,    // (key, [lo, hi] | null)
  filteredForestCodes, // applied forest filter: codes dimmed off (Set); lifted to App
  onApplyForest,
  setFilteredStationsCodes,
  children,
}) => {
  const [editing, setEditing] = useState(null); // key of the line being edited (one at a time)
  const [draft, setDraft] = useState(null);     // slider value [lo, hi] while editing
  const [forestEditing, setForestEditing] = useState(false); // forest line in edit mode
  const [draftForest, setDraftForest] = useState(() => new Set()); // codes dimmed while editing

  const fullOf = def => rangeLimits
    ? [rangeLimits[`${def.limits}Min`], rangeLimits[`${def.limits}Max`]]
    : [0, 0];

  const openEditor = def => {
    setDraft(areaRanges[def.key] ?? fullOf(def));
    setEditing(def.key);
  };

  // Keep the station filter in sync with every applied area range: each range
  // (or the full span when off) ANDs together in filterStationCodes, so the
  // dimmed station dots match the stacked grey masks on the map.
  useEffect(() => {
    if (!rangeLimits) return;
    const full = rangeLimits;
    const rainRange = areaRanges.rain ?? [full.rainMin, full.rainMax];
    const humRange = areaRanges.hum ?? [full.humMin, full.humMax];
    const tempRange = areaRanges.temp ?? [full.tempMin, full.tempMax];
    const altRange = areaRanges.relief ?? [full.altMin, full.altMax];
    setFilteredStationsCodes(
      filterStationCodes(stations, rainRange, humRange, tempRange, altRange, full)
    );
  }, [areaRanges, stations, rangeLimits, setFilteredStationsCodes]);

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

  const forestApplied = (filteredForestCodes?.size ?? 0) > 0;
  const editingDef = FILTER_DEFS.find(d => d.key === editing) ?? null;

  return (
    <div className="filter-panel">
      <div className="filter-header">
        <span className="filter-title">Filtres</span>
        <div className="filter-actions">
          <div
            className="sel-button filter-apply"
            title="Aplicar"
            onClick={onApply}
          >
            <FontAwesomeIcon icon={faCheck} />
          </div>
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
        <div className="filter-buttons">
          {FILTER_DEFS.map(def => {
            const applied = areaRanges[def.key] != null;
            return (
              <div
                key={def.key}
                className={`sel-button ${def.className}${applied ? ' on' : ''}`}
                title={def.title}
                onClick={() => (editing === def.key ? setEditing(null) : openEditor(def))}
              >
                <FontAwesomeIcon icon={def.icon} />
              </div>
            );
          })}

          <div
            className={`sel-button forest${forestApplied ? ' on' : ''}`}
            title="Filtre de bosc"
            onClick={() => (forestEditing ? setForestEditing(false) : openForestEditor())}
          >
            <FontAwesomeIcon icon={faTree} />
          </div>
        </div>

        {editingDef && (
          <div className="filter-line">
            <div className="filter-line-header">
              <span className="filter-line-label">{editingDef.label}</span>
              <span className="range-value">
                {draft[0]} {editingDef.unit} - {draft[1]} {editingDef.unit}
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-ok"
                  title="D'acord"
                  onClick={() => {
                    onApplyAreaRange?.(editingDef.key, draft);
                    setEditing(null);
                  }}
                >
                  <FontAwesomeIcon icon={faCheck} />
                </div>
                <div
                  className="sel-button filter-line-cancel"
                  title="Cancel·la"
                  onClick={() => setEditing(null)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
            <RangeSlider
              min={fullOf(editingDef)[0]}
              max={fullOf(editingDef)[1]}
              step={editingDef.step}
              value={draft}
              onInput={setDraft}
            />
          </div>
        )}

        {!editingDef && FILTER_DEFS.filter(def => areaRanges[def.key] != null).map(def => (
          <div key={def.key} className="filter-line applied">
            <div className="filter-line-header">
              <span className="filter-line-label">{def.label}</span>
              <span className="range-value">
                {areaRanges[def.key][0]} {def.unit} - {areaRanges[def.key][1]} {def.unit}
              </span>
              <div className="filter-line-actions">
                <div
                  className="sel-button filter-line-cancel"
                  title="Treu el filtre"
                  onClick={() => onApplyAreaRange?.(def.key, null)}
                >
                  <FontAwesomeIcon icon={faXmark} />
                </div>
              </div>
            </div>
          </div>
        ))}

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
      </div>
      {children}
    </div>
  );
};

export default FilterPanel;