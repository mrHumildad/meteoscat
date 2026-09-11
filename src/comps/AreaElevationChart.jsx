import { useEffect, useRef, useState } from 'react';
import { sampleAreaElevations, buildElevationProfile, elevationLinePoints } from '../logic/areaElevation.js';
import { fmtNum } from '../logic/utils.js';

// Altitude profile of the disc analysed around the picked point: the DEM is
// sampled on the grid of areaElevation.js and the values are drawn as a LINE
// with ALTITUDE ON THE Y AXIS — the X axis is the Nth lowest sampled point, so
// the line climbs from the lowest to the highest spot of the patch (a flat
// stretch means no sample at that height).
//
// The component owns its own async sampling — the profile is a property of the
// (point, radius) pair, and the DEM tiles are cached, so a new radius only
// re-reads pixels. While a sample is in flight the previous profile stays on
// screen and only the hint changes, so dragging the slider doesn't flicker.
const AreaElevationChart = ({ lat, lng, radius }) => {
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [profile, setProfile] = useState(null);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) return;
    const req = ++reqRef.current; // stale-guard: slider drags overlap
    setStatus('loading');
    sampleAreaElevations(lat, lng, radius)
      .then(values => {
        if (req !== reqRef.current) return;
        setProfile(buildElevationProfile(values));
        setStatus('ready');
      })
      .catch(err => {
        if (req !== reqRef.current) return;
        console.warn('Could not sample the area elevations:', err?.message ?? err);
        setProfile(null);
        setStatus('error');
      });
  }, [lat, lng, radius]);

  const midAxis = profile ? (profile.yMin + profile.yMax) / 2 : null;

  return (
    <div className="directions-area">
      <div className="filter-editor-label">
        <span>Altituds dins del radi</span>
        <span className="range-value">
          {profile ? `${profile.count} punts` : status === 'loading' ? '…' : '—'}
        </span>
      </div>
      {profile ? (
        <>
          <div className="area-elevation-plot">
            {/* Altitude axis: the same padded range the line is mapped onto,
                so the labels line up with the top / middle / bottom of the box. */}
            <div className="area-elevation-yaxis">
              <span>{fmtNum(profile.yMax, 0)} m</span>
              <span>{fmtNum(midAxis, 0)} m</span>
              <span>{fmtNum(profile.yMin, 0)} m</span>
            </div>
            <div className="area-elevation-canvas">
              <svg
                className="area-elevation-svg"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                role="img"
                aria-label={`Perfil d'altitud de ${profile.count} punts, de ${fmtNum(profile.min, 0)} a ${fmtNum(profile.max, 0)} m`}
              >
                <polyline
                  points={elevationLinePoints(profile)}
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </div>
          </div>
          <div className="area-elevation-axis">
            <span>punt més baix</span>
            <span>mitjana {fmtNum(profile.mean, 0)} m</span>
            <span>punt més alt</span>
          </div>
        </>
      ) : (
        <div className="directions-area-hint">
          {status === 'error'
            ? "No s'han pogut mostrejar les altituds."
            : 'Mostrejant el terreny…'}
        </div>
      )}
    </div>
  );
};

export default AreaElevationChart;
