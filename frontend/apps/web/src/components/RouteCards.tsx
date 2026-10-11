import { formatDuration, levelLabel } from '../lib/format';
import type { RouteCandidate, RouteResponse } from '../types';

type Props = {
  result: RouteResponse;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDirections: () => void;
  onStart: () => void;
};

export default function RouteCards({ result, selectedId, onSelect, onDirections, onStart }: Props) {
  const modeNote = result.candidates.find((c) => c.risk.status === 'ASSESSED' && c.risk.modeNote)?.risk;
  return (
    <section className="fl-section" aria-labelledby="routes-heading">
      <div className="fl-section-head">
        <h2 id="routes-heading">
          {result.candidates.length} route{result.candidates.length > 1 ? 's' : ''} found
        </h2>
        <span className="fl-muted">via {result.provider.name}</span>
      </div>

      {result.recommendation && result.recommendation.routeId !== selectedId && (
        <div className="fl-recommend" role="note">
          <span>{result.recommendation.message}</span>
          <button type="button" className="fl-link-btn" onClick={() => onSelect(result.recommendation!.routeId)}>
            View route {result.recommendation.routeId}
          </button>
        </div>
      )}

      <ul className="fl-cards" role="list">
        {result.candidates.map((c) => (
          <li key={c.id}>
            <RouteCard candidate={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
          </li>
        ))}
      </ul>

      {selectedId && (
        <div className="fl-route-actions">
          <button type="button" className="fl-btn fl-btn--primary" onClick={onDirections}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 2 12l10 10 10-10L12 2Zm1 13v-3H9v3H7v-4a1 1 0 0 1 1-1h5V7l4 4-4 4Z" fill="currentColor" /></svg>
            Directions
          </button>
          <button type="button" className="fl-btn fl-btn--secondary" onClick={onStart}>
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7L12 2Z" fill="currentColor" /></svg>
            Start
          </button>
        </div>
      )}

      {result.notes.length > 0 && (
        <ul className="fl-notes">
          {result.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {modeNote && modeNote.status === 'ASSESSED' && modeNote.modeNote && (
        <p className="fl-warning" role="note">⚠ {modeNote.modeNote}</p>
      )}
      {!result.coverage.inCoverage && (
        <p className="fl-warning" role="note">⚠ Flood data covers {result.coverage.area} only. Parts of this route are outside it.</p>
      )}
    </section>
  );
}

function RouteCard({ candidate: c, selected, onSelect }: { candidate: RouteCandidate; selected: boolean; onSelect: () => void }) {
  const risk = c.risk;
  const tag = c.preferences.length ? c.preferences.join(' · ') : 'Alternative';
  return (
    <button
      type="button"
      className={`fl-card ${selected ? 'is-selected' : ''}`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <span className="fl-card-top">
        <span className="fl-card-id" aria-hidden="true">{c.id}</span>
        <span className="fl-card-tag">
          <span className="fl-sr">Route {c.id}: </span>
          {tag}
        </span>
        {selected && <span className="fl-card-selected">Selected</span>}
      </span>
      <span className="fl-card-stats">
        <span><strong>{formatDuration(c.durationMinutes)}</strong> <small>est. time</small></span>
        <span><strong>{c.distanceKm} km</strong> <small>distance</small></span>
        {risk.status === 'ASSESSED' ? (
          <span className={`fl-risk fl-risk--${risk.level.toLowerCase()}`}>
            <strong>{risk.score}/100</strong>
            <small>{levelLabel[risk.level]} assessed risk</small>
          </span>
        ) : (
          <span className="fl-risk fl-risk--unknown">
            <strong>—</strong>
            <small>Not assessed</small>
          </span>
        )}
      </span>
      <span className="fl-card-reason">{risk.reason}</span>
      {risk.status === 'ASSESSED' && risk.limitations.length > 0 && (
        <span className="fl-card-limits">ⓘ {risk.limitations[0]}{risk.limitations.length > 1 ? ` (+${risk.limitations.length - 1} more)` : ''}</span>
      )}
    </button>
  );
}
