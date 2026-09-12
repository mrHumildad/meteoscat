import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { describeFilterConfig } from '../logic/savedFilters.js';

// Basket of the filter presets saved in localStorage (savedFilters.js). Same
// card style as the filter panel, one button per preset; pressing a button
// applies that preset to the live filters (App.applyFilterPreset) — the same
// effect as building the stack by hand in the filter panel. The row matching
// the live filters is marked as applied (App derives it from the filter
// state, so editing any filter clears the mark on its own).
const SavedFiltersPanel = ({ presets = [], activeName = null, onApply, onDelete, onClose }) => (
  <div className="filter-panel basket-panel">
    <div className="filter-header">
      <span className="filter-title">
        Las mevas 'reCetas'{presets.length > 0 ? ` (${presets.length})` : ''}
      </span>
      
    </div>
    <div className="filter-body">
      {presets.length === 0 ? (
        <div className="basket-empty">
          Encara no hi ha cap filtre desat.
        </div>
      ) : (
        presets.map(p => {
          const active = p.name === activeName;
          return (
            <div key={p.name} className={`basket-item${active ? ' active' : ''}`}>
              <button
                type="button"
                className="basket-item-main"
                title={active ? 'Filtre aplicat' : 'Aplica aquest filtre'}
                onClick={() => onApply?.(p)}
              >
                <span className="basket-item-name">{p.name}</span>
                <span className="basket-item-meta">{describeFilterConfig(p.config)}</span>
              </button>
              {active && (
                <span className="basket-item-active" title="Filtre aplicat">
                  <FontAwesomeIcon icon={faCheck} />
                </span>
              )}
              <div
                className="sel-button filter-line-cancel"
                title="Esborra aquest filtre desat"
                onClick={() => onDelete?.(p.name)}
              >
                <FontAwesomeIcon icon={faXmark} />
              </div>
            </div>
          );
        })
      )}
    </div>
  </div>
);

export default SavedFiltersPanel;
