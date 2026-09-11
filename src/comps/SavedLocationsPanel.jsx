import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLocationDot, faXmark } from '@fortawesome/free-solid-svg-icons';
import { describeSavedLocation } from '../logic/savedLocations.js';

// Basket of the locations saved in localStorage (savedLocations.js). Same
// card style as the filter panel, one button per saved place; pressing a
// button flies the map to that point (App.goToSavedLocation) and closes the
// panel, so the spot is back in view. Names are user-editable at save time,
// so the meta line carries the coordinates (and altitude) and the optional
// description gets its own line underneath.
const SavedLocationsPanel = ({ locations = [], activeName = null, onSelect, onDelete, onClose }) => (
  <div className="filter-panel basket-panel">
    <div className="filter-header">
      <span className="filter-title">
        Llocs desats{locations.length > 0 ? ` (${locations.length})` : ''}
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
      {locations.length === 0 ? (
        <div className="basket-empty">
          Encara no hi ha cap lloc desat. Tria un punt amb el cotxe i desa'l
          des del detall del lloc.
        </div>
      ) : (
        locations.map(l => {
          const active = l.name === activeName;
          return (
            <div key={l.name} className={`basket-item${active ? ' active' : ''}`}>
              <button
                type="button"
                className="basket-item-main"
                title="Vés a aquest lloc"
                onClick={() => onSelect?.(l)}
              >
                <span className="basket-item-name">
                  <FontAwesomeIcon icon={faLocationDot} /> {l.name}
                </span>
                <span className="basket-item-meta">{describeSavedLocation(l)}</span>
                {l.description && (
                  <span className="basket-item-desc">{l.description}</span>
                )}
              </button>
              <div
                className="sel-button filter-line-cancel"
                title="Esborra aquest lloc desat"
                onClick={() => onDelete?.(l.name)}
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

export default SavedLocationsPanel;
