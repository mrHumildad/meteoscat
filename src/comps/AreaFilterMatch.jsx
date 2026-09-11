import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MATCH_ACTIVE_KEY,
  hasFilterConditions,
  normalizeFilterConfig,
  sampleDiscPoints,
  matchAreaFilters,
} from '../logic/areaFilterMatch.js';
import { fmtNum } from '../logic/utils.js';

// "Filter" tab of the directions modal: how much of the analysed disc each
// filter covers. One row per filter — the LIVE stack first (only while it
// actually filters something), then every saved preset — with the share of the
// disc's sample points that satisfy it, drawn as a small bar.
//
// The component owns the sampling (same pattern as the other analysis panels):
// the DEM / MCSC / lithology reads are cached per disc, and matchAreaFilters
// reuses the map's own interpolated meteo grids, so switching filters or the
// radius mostly re-reads numbers.
const AreaFilterMatch = ({ lat, lng, radius, areaAnalysis = null }) => {
  const {
    agg = null,
    features = [],
    refDay = null,
    lithoGrid = null,
    activeConfig = null,
    savedPresets = [],
  } = areaAnalysis ?? {};

  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [rows, setRows] = useState([]);
  const reqRef = useRef(0);

  // The row list: the live stack (only when set) then the saved presets, each
  // with its day offsets already resolved to concrete window dates.
  const configs = useMemo(() => {
    const list = [];
    if (hasFilterConditions(activeConfig)) {
      const config = normalizeFilterConfig(activeConfig, refDay);
      if (config) list.push({ key: MATCH_ACTIVE_KEY, label: 'Filtre actiu', config });
    }
    for (const preset of savedPresets ?? []) {
      const config = normalizeFilterConfig(preset?.config, refDay);
      if (config && preset?.name) list.push({ key: preset.name, label: preset.name, config });
    }
    return list;
  }, [activeConfig, savedPresets, refDay]);

  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) return;
    if (!configs.length || !agg) {
      setRows([]);
      setStatus('ready');
      return;
    }
    const req = ++reqRef.current; // stale-guard: slider drags / edits overlap
    setStatus('loading');
    sampleDiscPoints(lat, lng, radius, { lithoGrid })
      .then(samples => {
        if (req !== reqRef.current) return;
        setRows(matchAreaFilters(samples, configs, { refDay, agg, features }));
        setStatus('ready');
      })
      .catch(err => {
        if (req !== reqRef.current) return;
        console.warn('Could not match the area against the filters:', err?.message ?? err);
        setRows([]);
        setStatus('error');
      });
  }, [lat, lng, radius, lithoGrid, configs, agg, features, refDay]);

  if (!configs.length) {
    return (
      <div className="directions-area-hint">
        Cap filtre aplicat ni desat. Desa'n un des del panell de filtres.
      </div>
    );
  }

  const sampled = rows[0]?.total ?? 0;

  return (
    <div className="directions-area filter-match">
      <div className="filter-match-note">
        {sampled > 0
          ? `Punts de l'àrea que compleixen cada filtre (sobre ${fmtNum(sampled, 0)} mostrejats):`
          : "Punts de l'àrea que compleixen cada filtre:"}
      </div>
      {rows.length === 0 ? (
        <div className="directions-area-hint">
          {status === 'error' ? "No s'han pogut comprovar els filtres." : 'Comprovant els filtres…'}
        </div>
      ) : (
        rows.map(row => (
          <div key={row.key} className="filter-match-item">
            <div className="filter-match-head">
              <span className={`filter-match-name${row.key === MATCH_ACTIVE_KEY ? ' active' : ''}`}>
                {row.label}
              </span>
              <span className="filter-match-pct" title={`${fmtNum(row.count, 0)} de ${fmtNum(row.total, 0)} punts`}>
                {Math.round(row.share * 100)}%
              </span>
            </div>
            <div className="filter-match-track">
              <div
                className="filter-match-fill"
                style={{ '--fill': `${row.share * 100}%` }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default AreaFilterMatch;
