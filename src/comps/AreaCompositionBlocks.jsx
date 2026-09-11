import { useEffect, useMemo, useRef, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLayerGroup, faTree } from '@fortawesome/free-solid-svg-icons';
import { countLandCover, countSubstrates, buildComposition } from '../logic/areaComposition.js';
import { fmtNum } from '../logic/utils.js';

// What the analysed disc is made of, as two blocks shaped like the station
// panel's (icon + value on the left, a `.bars` chart on the right):
//   • Cobertes del sòl — the MCSC land-cover classes inside the disc, counted
//     from the same raw-band tiles the map paints (the "forest" graph).
//   • Substrat — the geology families inside the disc, counted on the same
//     grid as the altitude profile (the "geo" graph).
// Each bar is one class, as tall as its share of the classified area and in
// its legend colour, so the graph reads against the map / legend.
//
// The land cover is fetched (its own async state, stale-guarded like the
// profile); the substrate is a pure read of the already-loaded lithology grid.
const CompositionBlock = ({ icon, title, composition, hint }) => {
  const top = composition?.items?.[0] ?? null;
  return (
    <div className="st-block">
      <div className="block-left">
        <span className="st-block-icon" title={title}>
          <FontAwesomeIcon icon={icon} />
        </span>
        <span className="st-block-value">
          <span className="area-block-title">{title}</span>
          {top ? `${top.label} ${Math.round(top.share * 100)}%` : hint}
        </span>
      </div>
      <div className="block-right">
        <div className="bars horizontal">
          {(composition?.items ?? []).map(item => (
            <div
              key={item.key}
              className="bar area-comp-bar"
              style={{ '--bar-h': `${item.share * 100}%`, '--bar-color': item.color }}
              title={`${item.label}: ${Math.round(item.share * 100)}% (${fmtNum(item.count, 0)} punts)`}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

const AreaCompositionBlocks = ({ lat, lng, radius, lithoGrid = null }) => {
  const [status, setStatus] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [landCover, setLandCover] = useState(null);
  const reqRef = useRef(0);

  useEffect(() => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius)) return;
    const req = ++reqRef.current; // stale-guard: slider drags overlap
    setStatus('loading');
    countLandCover(lat, lng, radius)
      .then(entries => {
        if (req !== reqRef.current) return;
        setLandCover(buildComposition(entries));
        setStatus('ready');
      })
      .catch(err => {
        if (req !== reqRef.current) return;
        console.warn('Could not count the area land cover:', err?.message ?? err);
        setLandCover(null);
        setStatus('error');
      });
  }, [lat, lng, radius]);

  // Substrate needs no fetch — it reads the already-loaded grid — but it does
  // scan the disc's sample points, so it is memoised off the same trio.
  const substrate = useMemo(
    () => buildComposition(countSubstrates(lithoGrid, lat, lng, radius)),
    [lithoGrid, lat, lng, radius],
  );
  const landCoverHint = status === 'loading' ? '…' : status === 'error' ? 'Sense dades' : '—';

  return (
    <div className="directions-area area-composition">
      <CompositionBlock
        icon={faLayerGroup}
        title="Substrat"
        composition={substrate}
        hint={lithoGrid ? 'Sense dades' : 'Mapa geològic no disponible'}
      />
      <CompositionBlock
        icon={faTree}
        title="Cobertes del sòl"
        composition={landCover}
        hint={landCoverHint}
      />
    </div>
  );
};

export default AreaCompositionBlocks;
