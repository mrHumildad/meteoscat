import { useEffect, useState } from 'react';

// How long each ticker item stays on screen before the next one slides in.
const ROTATE_MS = 2600;

// The app header. It holds nothing but a one-line ticker over the applied
// filters: it alternates the applied preset's name and each active condition,
// one at a time (items come from appliedFilters.appliedFilterItems). The line
// is remounted per item — its key includes the index — so the CSS entry
// animation replays on every rotation. Renders nothing while no filter is
// applied, so the header only exists when it has something to say.
const HeaderStatus = ({ items = [] }) => {
  const [index, setIndex] = useState(0);
  // Identity of the current list; any filter change restarts the cycle so the
  // new state shows immediately instead of at the old rotation's turn.
  const signature = items.join('\u0000');

  useEffect(() => { setIndex(0); }, [signature]);

  useEffect(() => {
    if (items.length < 2) return undefined;
    const id = setInterval(() => setIndex(i => (i + 1) % items.length), ROTATE_MS);
    return () => clearInterval(id);
  }, [signature, items.length]);

  if (items.length === 0) return null;
  // Clamp: a shrunk list may leave `index` past the end until the reset effect
  // runs (effects don't run during SSR either).
  const current = items[Math.min(index, items.length - 1)];

  return (
    <div className="app-header">
      <span key={`${signature}:${index}`} className="header-status">
        {current}
      </span>
    </div>
  );
};

export default HeaderStatus;
