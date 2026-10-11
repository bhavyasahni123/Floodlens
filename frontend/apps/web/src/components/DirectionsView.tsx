import { formatDuration, levelLabel } from '../lib/format';
import { formatDistance } from '../lib/navigation';
import type { DirectionStep, Place, RouteCandidate, TravelMode } from '../types';

type Props = {
  candidate: RouteCandidate;
  origin: Place;
  destination: Place;
  travelMode: TravelMode;
  activeStep: number | null;
  onStep: (index: number, step: DirectionStep) => void;
  onBack: () => void;
  onStart: (simulate: boolean) => void;
};

const ROTATION: Record<string, number> = {
  straight: 0,
  'slight right': 35,
  right: 90,
  'sharp right': 135,
  uturn: 180,
  'sharp left': -135,
  left: -90,
  'slight left': -35,
};

export function ManeuverIcon({ step }: { step: DirectionStep }) {
  if (step.type === 'depart') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5" fill="currentColor" /></svg>
    );
  }
  if (step.type === 'arrive') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 1 6 6c0 4.2-6 11-6 11S6 13.2 6 9a6 6 0 0 1 6-6Zm0 3.6A2.4 2.4 0 1 0 12 11.4 2.4 2.4 0 0 0 12 6.6Z" fill="currentColor" /></svg>
    );
  }
  if (step.type === 'roundabout' || step.type === 'rotary' || step.type === 'roundabout turn') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="5" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 3v5m-3-2 3-3 3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
    );
  }
  const deg = ROTATION[step.modifier ?? 'straight'] ?? 0;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${deg}deg)` }}>
      <path d="M12 20V5m-5 5 5-5 5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function DirectionsView({ candidate: c, destination, travelMode, activeStep, onStep, onBack, onStart }: Props) {
  const risk = c.risk;
  const hazardSteps = c.steps.filter((s) => s.hazards.length > 0).length;
  return (
    <section className="fl-directions" aria-labelledby="directions-heading">
      <button type="button" className="fl-link-btn fl-back" onClick={onBack}>
        ← All routes
      </button>
      <div className="fl-directions-summary">
        <div>
          <span className="fl-eyebrow">Route {c.id} · {travelMode}</span>
          <h2 id="directions-heading">
            {formatDuration(c.durationMinutes)} <span className="fl-muted">· {c.distanceKm} km</span>
          </h2>
          <p className="fl-directions-to">to {destination.label}</p>
        </div>
        {risk.status === 'ASSESSED' && (
          <span className={`fl-risk fl-risk--${risk.level.toLowerCase()}`}>
            <strong>{risk.score}/100</strong>
            <small>{levelLabel[risk.level]} risk</small>
          </span>
        )}
      </div>

      <div className="fl-start-row">
        <button type="button" className="fl-btn fl-btn--primary fl-btn--block" onClick={() => onStart(false)}>
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7L12 2Z" fill="currentColor" /></svg>
          Start
        </button>
        <button type="button" className="fl-btn fl-btn--ghost" onClick={() => onStart(true)} title="Preview the journey with a simulated position">
          Simulate
        </button>
      </div>
      <p className="fl-small fl-muted fl-handoff-note">
        Start follows your live location with spoken turn-by-turn guidance and reroutes if you leave the route.
        Simulate drives a virtual position along the route for a preview.
      </p>

      {hazardSteps > 0 && (
        <p className="fl-warning" role="note">
          ⚠ {hazardSteps} step{hazardSteps > 1 ? 's pass' : ' passes'} a historical waterlogging hotspot. Check conditions before you go.
        </p>
      )}

      {c.steps.length === 0 ? (
        <p className="fl-empty">Turn-by-turn steps are not available for this route. The route line on the map is still accurate.</p>
      ) : (
        <ol className="fl-steps">
          {c.steps.map((s, i) => (
            <li key={i}>
              <button type="button" className={activeStep === i ? 'is-active' : ''} onClick={() => onStep(i, s)} aria-current={activeStep === i ? 'step' : undefined}>
                <span className="fl-step-icon">
                  <ManeuverIcon step={s} />
                </span>
                <span className="fl-step-body">
                  <span className="fl-step-text">{s.instruction}</span>
                  {s.hazards.length > 0 && (
                    <span className="fl-step-hazard">Historical hotspot: {s.hazards.join(', ')}</span>
                  )}
                </span>
                {s.type !== 'arrive' && <span className="fl-step-dist">{formatDistance(s.distanceM)}</span>}
              </button>
            </li>
          ))}
        </ol>
      )}
      <p className="fl-small fl-muted">Directions from OpenStreetMap data via OSRM. Watch for road closures and follow local instructions.</p>
    </section>
  );
}
