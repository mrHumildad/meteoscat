import { useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCircleInfo, faFilter, faFloppyDisk, faTowerBroadcast, faXmark } from '@fortawesome/free-solid-svg-icons';
import { JeepIcon } from '../logic/nounIcons.jsx';
import { fmtNum } from '../logic/utils.js';
import { suggestLocationName } from '../logic/savedLocations.js';
import AreaElevationChart from './AreaElevationChart.jsx';
import AreaCompositionBlocks from './AreaCompositionBlocks.jsx';
import AreaFilterMatch from './AreaFilterMatch.jsx';

// Radius of the area analysed around the picked point — the modal reads as an
// AREA analysis, not a single-point one: 500 m minimum, 2.5 km maximum, 100 m
// steps. 1 km is the default patch (a mushroom walk's reach). Exported so App
// resets the slider to the same default on every new pick.
export const ROUTE_RADIUS_MIN = 500;
export const ROUTE_RADIUS_MAX = 2500;
export const ROUTE_RADIUS_STEP = 100;
export const ROUTE_RADIUS_DEFAULT = 1000;

// Save-a-place block of the directions modal: none → name + description inputs
// → "Desat: name" (same wording/style as the filter panel's save preset). The
// name is PRE-FILLED with the nearest toponym (suggestLocationName) but the
// user edits it freely and may add a description; saving hands both to App,
// which owns the localStorage list. Keyed by the picked point (see the modal
// below) so each new point starts from its own suggestion.
const SaveLocationForm = ({ nearest, onSaveLocation }) => {
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState(() => suggestLocationName(nearest));
  const [saveDesc, setSaveDesc] = useState('');
  const [savedName, setSavedName] = useState(null);

  const confirmSave = () => {
    const name = saveName.trim();
    if (!name) return;
    onSaveLocation?.(name, saveDesc.trim());
    setSaveName(name);
    setSavedName(name);
    setSaveOpen(false);
  };

  if (!saveOpen) {
    return (
      <button
        type="button"
        className={`filter-save-btn${savedName ? ' saved' : ''}`}
        title="Desa aquest lloc"
        onClick={() => setSaveOpen(true)}
      >
        <FontAwesomeIcon icon={faFloppyDisk} />{' '}
        {savedName ? `Desat: ${savedName}` : 'Desa aquest lloc'}
      </button>
    );
  }

  return (
    <div className="directions-save">
      <div className="filter-save-row">
        <input
          type="text"
          className="filter-save-input"
          value={saveName}
          autoFocus
          maxLength={60}
          placeholder="Nom del lloc"
          aria-label="Nom del lloc"
          onChange={e => setSaveName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmSave();
            if (e.key === 'Escape') setSaveOpen(false);
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
          onClick={() => setSaveOpen(false)}
        >
          <FontAwesomeIcon icon={faXmark} />
        </div>
      </div>
      <div className="filter-save-row">
        <input
          type="text"
          className="filter-save-input"
          value={saveDesc}
          maxLength={140}
          placeholder="Descripció (opcional)"
          aria-label="Descripció del lloc"
          onChange={e => setSaveDesc(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') confirmSave();
            if (e.key === 'Escape') setSaveOpen(false);
          }}
        />
      </div>
    </div>
  );
};

// ── Tab panels ───────────────────────────────────────────────────────────
// The analysis produces a lot of numbers, so they are split over tabs picked
// with the icon buttons below; only one panel is mounted at a time, which also
// keeps the modal short enough to fit a phone screen.

// Where the point is, how big the disc is and what that disc contains.
const AreaInfoPanel = ({ lat, lng, elevation, pending, radius, lithoGrid, onRadiusChange }) => (
  <>
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
    {/* Area size: the point is analysed as a DISC, so the radius comes before
        the results it bounds. Single-value slider (500 m - 2.5 km, 100 m
        steps), styled like the filter panel's range sliders. */}
    <div className="directions-radius">
      <div className="filter-editor-label">
        <span>Radi de l'àrea</span>
        <span className="range-value">{fmtNum(radius / 1000, 1)} km</span>
      </div>
      <input
        type="range"
        className="directions-radius-slider"
        min={ROUTE_RADIUS_MIN}
        max={ROUTE_RADIUS_MAX}
        step={ROUTE_RADIUS_STEP}
        value={radius}
        aria-label="Radi de l'àrea"
        onChange={e => onRadiusChange?.(Number(e.target.value))}
      />
    </div>
    {/* Altitude profile of that same disc — the point's own height is in the
        rows above, this is the terrain AROUND it. */}
    <AreaElevationChart lat={lat} lng={lng} radius={radius} />
    {/* …and what that patch is made of: substrate families (geology) and
        MCSC land-cover classes, as station-panel-style blocks. */}
    <AreaCompositionBlocks lat={lat} lng={lng} radius={radius} lithoGrid={lithoGrid} />
  </>
);

// Closest Meteo stations / villages (nearestStations.js output).
const StationsPanel = ({ nearest = [] }) => (
  nearest.length === 0 ? (
    <div className="directions-area-hint">Cap estació a prop.</div>
  ) : (
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
  )
);

const TAB_ICONS = { info: faCircleInfo, filters: faFilter, stations: faTowerBroadcast };
const TAB_TITLES = {
  info: "Informació de l'àrea",
  filters: 'Coincidència amb els filtres',
  stations: 'Estacions i pobles més propers',
};

// Tab bar + the active panel + the point-level actions, which stay visible in
// every tab (they act on the picked point, not on what is being shown).
const DirectionsTabs = ({
  initialTab = 'info',
  lat,
  lng,
  elevation,
  pending,
  nearest,
  distanceKm,
  radius,
  lithoGrid,
  areaAnalysis,
  onRadiusChange,
  onNavigate,
  onSaveLocation,
}) => {
  const [tab, setTab] = useState(initialTab);
  return (
    <>
      <div className="directions-tabs" role="tablist">
        {['info', 'filters', 'stations'].map(key => (
          <div
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`sel-button directions-tab${tab === key ? ' on' : ''}`}
            title={TAB_TITLES[key]}
            onClick={() => setTab(key)}
          >
            <FontAwesomeIcon icon={TAB_ICONS[key]} />
          </div>
        ))}
      </div>
      <div className="directions-tab-body">
        {tab === 'stations' && <StationsPanel nearest={nearest} />}
        {tab === 'filters' && (
          <AreaFilterMatch lat={lat} lng={lng} radius={radius} areaAnalysis={areaAnalysis} />
        )}
        {tab === 'info' && (
          <AreaInfoPanel
            lat={lat}
            lng={lng}
            elevation={elevation}
            pending={pending}
            radius={radius}
            lithoGrid={lithoGrid}
            onRadiusChange={onRadiusChange}
          />
        )}
      </div>
      <button
        type="button"
        className="directions-go"
        title={distanceKm != null
          ? 'Obre la ruta a Google Maps des de la meva ubicaci\u00f3'
          : 'Obre la ruta a Google Maps'}
        onClick={onNavigate}
      >          <JeepIcon className="noun-icon" />
        {distanceKm != null
          ? `Com hi arribo \u00b7 ${fmtNum(distanceKm, 1)} km`
          : 'Com hi arribo (Google Maps)'}
      </button>
      <SaveLocationForm nearest={nearest} onSaveLocation={onSaveLocation} />
    </>
  );
};

/**
 * Modal shown when the car (directions) button is armed and the user clicks a
 * point on the map. Instead of jumping straight to Google Maps it opens an
 * AREA analysis of that point, split over tabs picked with the icon buttons at
 * the top (only the active panel is mounted, so the card stays short):
 *   • info     — coordinates + DEM altitude, the disc radius slider, the
 *                altitude profile of the disc and what it is made of
 *                (substrate / land cover).
 *   • stations — the closest Meteo stations and villages.
 * The point-level actions (open Google Maps, save the place) sit below the
 * tabs in every panel.
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
 *
 * `onSaveLocation(name, description)` stores the picked point (App owns the
 * localStorage list); the name is suggested from `nearest` but editable.
 *
 * `radius` (metres) is the size of the AREA analysed around the point — the
 * single-value slider between ROUTE_RADIUS_MIN and ROUTE_RADIUS_MAX; App owns
 * the state so the rest of the analysis (nearest stations, map circle) can
 * read the same value.
 *
 * `areaAnalysis` bundles what the analysis needs beyond the point itself:
 * `{ agg, features, refDay, lithoGrid, activeConfig, savedPresets }` — the
 * aggregate table + station features + reference day that rebuild the map's
 * meteo grids, the decoded substrate grid App already loaded for the geology
 * filter (null while it is still loading), the live filter stack (null when
 * nothing is set) and the saved presets. All of it is optional: the panels
 * degrade to "no data" hints without it.
 *
 * `initialTab` is the tab opened first ('info'); tests use it to render a
 * specific panel.
 */
const DirectionsModal = ({
  point,
  nearest = [],
  distanceKm = null,
  radius = ROUTE_RADIUS_DEFAULT,
  areaAnalysis = null,
  initialTab = 'info',
  onRadiusChange,
  onClose,
  onNavigate,
  onSaveLocation,
}) => {
  if (!point) return null;
  const { lat, lng, elevation, pending } = point;
  const { lithoGrid = null } = areaAnalysis ?? {};
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
        {/* Keyed by the point: a newly picked point remounts the tabs (back to
            the first one) and the save form's suggested toponym. */}
        <DirectionsTabs
          key={`${lat},${lng}`}
          initialTab={initialTab}
          lat={lat}
          lng={lng}
          elevation={elevation}
          pending={pending}
          nearest={nearest}
          distanceKm={distanceKm}
          radius={radius}
          lithoGrid={lithoGrid}
          areaAnalysis={areaAnalysis}
          onRadiusChange={onRadiusChange}
          onNavigate={onNavigate}
          onSaveLocation={onSaveLocation}
        />
      </div>
    </div>
  );
};

export default DirectionsModal;
