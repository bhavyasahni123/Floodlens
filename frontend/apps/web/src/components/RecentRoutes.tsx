import { useState } from 'react';
import { formatAge } from '../lib/format';
import type { RecentRoute } from '../lib/recentRoutes';

type Props = { items: RecentRoute[]; onPick: (r: RecentRoute) => void; onClear: () => void };

const MODE_LABEL = { driving: 'Drive', walking: 'Walk', cycling: 'Cycle' };
const short = (label: string) => label.split(',')[0];

export default function RecentRoutes({ items, onPick, onClear }: Props) {
  const [confirming, setConfirming] = useState(false);
  if (items.length === 0) return null;
  return (
    <section className="fl-section" aria-labelledby="recent-heading">
      <div className="fl-section-head">
        <h2 id="recent-heading">Recent routes</h2>
        {confirming ? (
          <span className="fl-row">
            <button type="button" className="fl-link-btn fl-link-btn--danger" onClick={() => { onClear(); setConfirming(false); }}>
              Clear all
            </button>
            <button type="button" className="fl-link-btn" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="fl-link-btn" onClick={() => setConfirming(true)}>Clear history</button>
        )}
      </div>
      <ul className="fl-recent" role="list">
        {items.map((r) => (
          <li key={r.savedAt}>
            <button type="button" onClick={() => onPick(r)}>
              <span>{short(r.origin.label)} → {short(r.destination.label)}</span>
              <small>{MODE_LABEL[r.travelMode]} · {r.preference} · {formatAge(r.savedAt)}</small>
            </button>
          </li>
        ))}
      </ul>
      <p className="fl-muted fl-small">Saved only in this browser — not synced to other devices.</p>
    </section>
  );
}
