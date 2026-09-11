import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCar, faXmark } from '@fortawesome/free-solid-svg-icons';
import { fmtNum } from '../logic/utils.js';

/**
 * Modal shown when the car (directions) button is armed and the user clicks a
 * point on the map. Instead of jumping straight to Google Maps, it shows the
 * picked point (coordinates + DEM altitude) with two actions: close the modal,
 * or open Google Maps driving directions to the point in a new tab.
 *
 * `point` is `{ lat, lng, elevation, pending }` — `pending` is true while the
 * DEM sample is still in flight (elevation then shows a placeholder instead of
 * the "no data" dash). `onNavigate` is provided by App, which owns the URL.
 *
 * Clicking the backdrop (but not the card) dismisses the modal, like Esc.
 *
 * `nearest` is the output of nearestStations.js — the closest Meteo stations
 * to the picked point, each with its distance, compass direction, municipality
 * (poble) and comarca. `distanceKm` is the straight-line distance from "my
 * location" (null while unknown/denied) and is shown on the Google Maps button.
 */
const DirectionsModal = ({ point, nearest = [], distanceKm = null, onClose, onNavigate }) => {
  if (!point) return null;
  const { lat, lng, elevation, pending } = point;
  return (
    <div
      className="directions-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Com hi arribo"
      onClick={onClose}
    >
      <div className="directions-card" onClick={e => e.stopPropagation()}>
        <div className="directions-header">
          <span className="directions-title">Com hi arribo</span>
          <div
            className="sel-button directions-close"
            title="Tanca"
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} />
          </div>
        </div>
        <div className="directions-rows">
          <div className="directions-row">
            <span className="directions-row-label">Latitud</span>
            <span className="directions-row-value">{lat.toFixed(5)}</span>
          </div>
          <div className="directions-row">
            <span className="directions-row-label">Longitud</span>
            <span className="directions-row-value">{lng.toFixed(5)}</span>
          </div>
          <div className="directions-row">
            <span className="directions-row-label">Altitud del terreny</span>
            <span className="directions-row-value">
              {pending ? '…' : elevation != null ? `${elevation} m` : '—'}
            </span>
          </div>
        </div>
        {nearest.length > 0 && (
          <div className="directions-nearest">
            <span className="directions-nearest-title">Estacions i pobles més propers</span>
            {nearest.map(s => (
              <div key={s.code ?? `${s.lat},${s.lng}`} className="directions-station">
                <div className="directions-station-head">
                  <span className="directions-station-name">{s.name}</span>
                  <span className="directions-station-meta">
                    {s.direction && <span className="directions-station-dir">{s.direction}</span>}
                    {fmtNum(s.distanceKm, 1)} km
                  </span>
                </div>
                {(s.municipi || s.comarca) && (
                  <div className="directions-station-place">
                    {[s.municipi, s.comarca].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="directions-go"
          title={distanceKm != null
            ? 'Obre la ruta a Google Maps des de la meva ubicaci\u00f3'
            : 'Obre la ruta a Google Maps'}
          onClick={onNavigate}
        >
          <FontAwesomeIcon icon={faCar} />
          {distanceKm != null
            ? `Com hi arribo \u00b7 ${fmtNum(distanceKm, 1)} km`
            : 'Com hi arribo (Google Maps)'}
        </button>
      </div>
    </div>
  );
};

export default DirectionsModal;
