import { SIM_FACTOR, type NavState } from '../hooks/useNavigation';
import { formatDuration, formatTime } from '../lib/format';
import { formatDistance } from '../lib/navigation';
import type { Place } from '../types';
import { ManeuverIcon } from './DirectionsView';

type Props = {
  nav: NavState;
  destination: Place;
  onExit: () => void;
  onToggleMute: () => void;
  onRecenter: () => void;
};

export default function NavigationOverlay({ nav, destination, onExit, onToggleMute, onRecenter }: Props) {
  const c = nav.candidate;
  const g = nav.guide;
  if (!c) return null;

  const steps = c.steps;
  const next = g ? steps[g.nextStep] : undefined;
  const then = g ? steps[g.nextStep + 1] : undefined;
  const totalM = c.distanceKm * 1000;
  // Remaining time is scaled from the routing estimate by remaining distance.
  const remainingMin = g && totalM > 0 ? Math.max(1, Math.round((c.durationMinutes * g.remainingM) / totalM)) : c.durationMinutes;
  const eta = new Date(Date.now() + remainingMin * 60e3).toISOString();

  // Flood-aware cue: hotspots on the stretch being driven now, or on the next one when it is close.
  const current = g && g.nextStep > 0 ? steps[g.nextStep - 1] : steps[0];
  const hazardsNow = current?.hazards ?? [];
  const hazardsAhead = g && next && g.distanceToNextM < 500 ? next.hazards.filter((h) => !hazardsNow.includes(h)) : [];

  return (
    <div className="fl-nav" role="region" aria-label="Live navigation">
      <div className="fl-nav-top">
        {nav.status === 'arrived' ? (
          <div className="fl-nav-banner fl-nav-banner--done" role="status">
            <span className="fl-nav-icon">
              <ManeuverIcon step={{ type: 'arrive', modifier: null, instruction: '', distanceM: 0, durationS: 0, location: [0, 0], hazards: [] }} />
            </span>
            <div>
              <strong className="fl-nav-instruction">You have arrived</strong>
              <span className="fl-nav-sub">{destination.label}</span>
            </div>
          </div>
        ) : nav.status === 'error' ? (
          <div className="fl-nav-banner fl-nav-banner--error" role="alert">
            <div>
              <strong className="fl-nav-instruction">Live navigation unavailable</strong>
              <span className="fl-nav-sub">{nav.message}</span>
            </div>
          </div>
        ) : nav.status === 'locating' || !g || !next ? (
          <div className="fl-nav-banner" role="status">
            <span className="fl-spinner fl-spinner--light" aria-hidden="true" />
            <div>
              <strong className="fl-nav-instruction">Finding your location…</strong>
              <span className="fl-nav-sub">{nav.message ?? 'Allow location access if your browser asks.'}</span>
            </div>
          </div>
        ) : (
          <div className={`fl-nav-banner ${nav.status === 'rerouting' ? 'is-rerouting' : ''}`} aria-live="polite">
            <span className="fl-nav-icon">
              <ManeuverIcon step={next} />
            </span>
            <div className="fl-nav-main">
              <strong className="fl-nav-distance">{formatDistance(g.distanceToNextM)}</strong>
              <span className="fl-nav-instruction">{next.instruction}</span>
            </div>
          </div>
        )}

        {nav.status === 'navigating' && then && g && g.distanceToNextM < 1500 && (
          <div className="fl-nav-then">
            <span>Then</span>
            <span className="fl-nav-then-icon"><ManeuverIcon step={then} /></span>
            <span className="fl-nav-then-text">{then.instruction}</span>
          </div>
        )}
        {nav.status === 'rerouting' && <div className="fl-nav-strip fl-nav-strip--info" role="status">Rerouting…</div>}
        {nav.status === 'navigating' && nav.message && <div className="fl-nav-strip fl-nav-strip--info" role="status">{nav.message}</div>}
        {nav.status === 'navigating' && hazardsNow.length > 0 && (
          <div className="fl-nav-strip fl-nav-strip--hazard" role="note">
            ⚠ Historical waterlogging hotspot on this stretch: {hazardsNow.join(', ')}
          </div>
        )}
        {nav.status === 'navigating' && hazardsAhead.length > 0 && (
          <div className="fl-nav-strip fl-nav-strip--hazard" role="note">
            ⚠ Hotspot after the next turn: {hazardsAhead.join(', ')}
          </div>
        )}
        {nav.simulated && <div className="fl-nav-sim">Simulated journey · {SIM_FACTOR}× speed — not your real location</div>}
        {!nav.simulated && nav.accuracyM !== null && nav.accuracyM > 50 && nav.status === 'navigating' && (
          <div className="fl-nav-strip fl-nav-strip--info">Weak GPS signal (±{Math.round(nav.accuracyM)} m)</div>
        )}
      </div>

      <div className="fl-nav-side">
        {!nav.follow && nav.position && (
          <button type="button" className="fl-nav-fab" onClick={onRecenter} aria-label="Re-centre on your position">
            ◎ Re-centre
          </button>
        )}
        <button type="button" className="fl-nav-fab" onClick={onToggleMute} aria-pressed={nav.muted} aria-label={nav.muted ? 'Unmute voice guidance' : 'Mute voice guidance'}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M4 9v6h4l5 4V5L8 9H4Z" fill="currentColor" />
            {nav.muted ? (
              <path d="m16 9 5 6m0-6-5 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      <div className="fl-nav-bottom">
        {nav.status === 'arrived' ? (
          <>
            <div className="fl-nav-trip">
              <strong>Arrived</strong>
              <span>Trip took {formatDuration(Math.max(1, Math.round((Date.now() - nav.startedAt) / 60000)))}</span>
            </div>
            <button type="button" className="fl-btn fl-btn--primary" onClick={onExit}>Done</button>
          </>
        ) : (
          <>
            <div className="fl-nav-trip">
              <strong className={c.risk.status === 'ASSESSED' ? `fl-nav-time fl-nav-time--${c.risk.level.toLowerCase()}` : 'fl-nav-time'}>
                {formatDuration(remainingMin)}
              </strong>
              <span>
                {g ? formatDistance(g.remainingM) : `${c.distanceKm} km`} · arrive {formatTime(eta)}
                {c.risk.status === 'ASSESSED' && ` · ${c.risk.score}/100 risk`}
              </span>
            </div>
            <button type="button" className="fl-btn fl-nav-exit" onClick={onExit}>Exit</button>
          </>
        )}
      </div>
    </div>
  );
}
