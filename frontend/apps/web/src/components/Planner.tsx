import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getHazards, getIntelligence, getReports, planRoutes } from '../api';
import { addRecent, loadRecent, saveRecent, type RecentRoute } from '../lib/recentRoutes';
import MapView from '../MapView';
import type {
  HazardFeature,
  Intelligence,
  LatLon,
  LayerKey,
  Place,
  Preference,
  ReportsResponse,
  RouteResponse,
  TravelMode,
} from '../types';
import { useNavigation } from '../hooks/useNavigation';
import DirectionsView from './DirectionsView';
import FloodPanel from './FloodPanel';
import LocationField from './LocationField';
import NavigationOverlay from './NavigationOverlay';
import RecentRoutes from './RecentRoutes';
import ReportForm from './ReportForm';
import RouteCards from './RouteCards';

type PickTarget = 'origin' | 'destination' | 'report' | null;
type RouteState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: RouteResponse }
  | { status: 'error'; message: string; retryable: boolean };

const PREFERENCES: { name: Preference; hint: string }[] = [
  { name: 'Fastest', hint: 'Shortest estimated time' },
  { name: 'Balanced', hint: 'Time and assessed risk' },
  { name: 'Lower Risk', hint: 'Lowest assessed risk' },
];
const MODES: { mode: TravelMode; label: string }[] = [
  { mode: 'driving', label: 'Drive' },
  { mode: 'walking', label: 'Walk' },
  { mode: 'cycling', label: 'Cycle' },
];
// Kept from the original app: Connaught Place is the default starting point.
const DEFAULT_ORIGIN: Place = { lat: 28.6315, lon: 77.2167, label: 'Connaught Place, New Delhi' };
const INTEL_REFRESH_MS = 5 * 60e3;
const ALL_LAYERS: Record<LayerKey, boolean> = { alerts: true, hotspots: true, community: true, rainfall: true, river: true };

const pinLabel = (lat: number, lon: number) => `Dropped pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`;

function pickFor(data: RouteResponse, pref: Preference): string {
  const p = data.preferences;
  return (pref === 'Fastest' ? p.fastest : pref === 'Balanced' ? p.balanced : p.lowerRisk) ?? p.fastest;
}

export default function Planner({ onHome }: { onHome: () => void }) {
  const [origin, setOrigin] = useState<Place | null>(DEFAULT_ORIGIN);
  const [destination, setDestination] = useState<Place | null>(null);
  const [originText, setOriginText] = useState(DEFAULT_ORIGIN.label);
  const [destText, setDestText] = useState('');
  const [travelMode, setTravelMode] = useState<TravelMode>('driving');
  const [preference, setPreference] = useState<Preference>('Balanced');
  const [routeState, setRouteState] = useState<RouteState>({ status: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [routeNonce, setRouteNonce] = useState(0);
  const [pickTarget, setPickTarget] = useState<PickTarget>(null);
  const [locating, setLocating] = useState(false);
  const [notice, setNotice] = useState('');
  const [recent, setRecent] = useState<RecentRoute[]>(() => loadRecent());
  const [recenterKey, setRecenterKey] = useState(0);
  const [sheetCollapsed, setSheetCollapsed] = useState(false);
  const [directionsOpen, setDirectionsOpen] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const [focusPoint, setFocusPoint] = useState<LatLon | null>(null);
  const [refitNonce, setRefitNonce] = useState(0);

  const [floodMode, setFloodMode] = useState(false);
  const [panelMinimised, setPanelMinimised] = useState(false);
  const [layers, setLayers] = useState(ALL_LAYERS);
  const [intel, setIntel] = useState<Intelligence | null>(null);
  const [intelError, setIntelError] = useState<string | null>(null);
  const [intelLoading, setIntelLoading] = useState(false);
  const [hazards, setHazards] = useState<HazardFeature[] | null>(null);
  const [reports, setReports] = useState<ReportsResponse | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportPin, setReportPin] = useState<Place | null>(null);

  const { nav, start: startNavigation, stop: stopNavigation, toggleMute, setFollow } = useNavigation({ destination, travelMode, preference });
  const requestSeq = useRef(0);
  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;

  // Recalculate whenever the locations or travel mode change. Only the latest
  // request may update state, so slow responses never overwrite newer input.
  useEffect(() => {
    if (!origin || !destination) {
      setRouteState({ status: 'idle' });
      setSelectedId(null);
      return;
    }
    const seq = ++requestSeq.current;
    const controller = new AbortController();
    setRouteState({ status: 'loading' });
    planRoutes({ origin, destination, travelMode, preference: preferenceRef.current }, controller.signal)
      .then((data) => {
        if (seq !== requestSeq.current) return;
        setRouteState({ status: 'success', data });
        setSelectedId(pickFor(data, preferenceRef.current));
        setRecent((list) => {
          const next = addRecent(list, { origin, destination, travelMode, preference: preferenceRef.current });
          saveRecent(next);
          return next;
        });
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRouteState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Route calculation failed.',
          retryable: error instanceof ApiError ? error.retryable : true,
        });
      });
    return () => controller.abort();
  }, [origin, destination, travelMode, routeNonce]);

  const loadIntel = useCallback(async () => {
    setIntelLoading(true);
    const [i, r, h] = await Promise.allSettled([getIntelligence(), getReports(), hazards ? Promise.resolve(null) : getHazards()]);
    if (i.status === 'fulfilled') {
      setIntel(i.value);
      setIntelError(null);
    } else {
      // Keep nothing that would look current: drop old values and say why.
      setIntel(null);
      setIntelError(i.reason instanceof Error ? i.reason.message : 'Flood data could not be loaded.');
    }
    setReports(r.status === 'fulfilled' ? r.value : null);
    if (h.status === 'fulfilled' && h.value) setHazards(h.value.features);
    setIntelLoading(false);
  }, [hazards]);

  useEffect(() => {
    if (!floodMode) return;
    void loadIntel();
    const timer = window.setInterval(() => void loadIntel(), INTEL_REFRESH_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [floodMode]);

  function setPlace(which: 'origin' | 'destination', place: Place | null) {
    if (which === 'origin') {
      setOrigin(place);
      setOriginText(place?.label ?? '');
    } else {
      setDestination(place);
      setDestText(place?.label ?? '');
    }
  }

  function onMapClick(lat: number, lon: number) {
    const place = { lat, lon, label: pinLabel(lat, lon) };
    if (pickTarget === 'report') {
      setReportPin(place);
      setPickTarget(null);
      return;
    }
    if (pickTarget) {
      setPlace(pickTarget, place);
      setPickTarget(null);
      return;
    }
    if (!origin) setPlace('origin', place);
    else if (!destination) setPlace('destination', place);
    else setNotice('Tap ⌖ next to Start or Destination to move a point, or drag its marker.');
  }

  function useMyLocation() {
    if (!('geolocation' in navigator)) {
      setNotice('Location is not available in this browser. Search for a place or pick it on the map.');
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        setNotice('');
        setPlace('origin', { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'My location', fromGeolocation: true });
      },
      (err) => {
        setLocating(false);
        setNotice(
          err.code === err.PERMISSION_DENIED
            ? 'Location permission was denied. Search for your start point or pick it on the map instead.'
            : 'Your location could not be determined. Search for your start point or pick it on the map instead.',
        );
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
    );
  }

  function choosePreference(pref: Preference) {
    setPreference(pref);
    if (routeState.status === 'success') setSelectedId(pickFor(routeState.data, pref));
  }

  function swap() {
    const o = origin;
    const ot = originText;
    setOrigin(destination);
    setOriginText(destText);
    setDestination(o);
    setDestText(ot);
  }

  function pickRecent(r: RecentRoute) {
    setPreference(r.preference);
    setTravelMode(r.travelMode);
    setPlace('origin', r.origin);
    setPlace('destination', r.destination);
  }

  const result = routeState.status === 'success' ? routeState.data : null;
  const candidates = result?.candidates ?? [];
  const selected = candidates.find((c) => c.id === selectedId) ?? null;
  const showDirections = directionsOpen && selected !== null && origin !== null && destination !== null;
  const navigating = nav.active && destination !== null;
  function beginNavigation(simulate: boolean) {
    if (!selected) return;
    setDirectionsOpen(true);
    setPickTarget(null);
    setFocusPoint(null);
    setActiveStep(null);
    startNavigation(selected, simulate);
  }
  function endNavigation() {
    stopNavigation();
    // Like Google Maps: finishing or exiting returns to the route overview.
    setDirectionsOpen(false);
    setRefitNonce((n) => n + 1);
  }
  const [stepKey, setStepKey] = useState('');
  const currentKey = `${result?.assessedAt ?? ''}-${selectedId ?? ''}`;
  if (currentKey !== stepKey) {
    setStepKey(currentKey);
    setActiveStep(null);
    setFocusPoint(null);
  }
  const showPanel = floodMode && !panelMinimised;

  return (
    <div className={`fl-app ${navigating ? 'is-navigating' : ''}`}>
      <header className="fl-topbar">
        <button type="button" className="fl-brand" onClick={onHome} aria-label="FloodLens home">
          <span className="fl-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 2.5c3.6 4.6 6.5 8.3 6.5 11.6A6.5 6.5 0 0 1 5.5 14C5.5 10.8 8.4 7.1 12 2.5Z" fill="currentColor" /></svg>
          </span>
          FloodLens
        </button>
        <span className="fl-topbar-scope">Delhi</span>
        <button
          type="button"
          className={`fl-flood-toggle ${floodMode ? 'is-on' : ''}`}
          aria-pressed={floodMode}
          onClick={() => {
            if (floodMode && panelMinimised) setPanelMinimised(false);
            else {
              setFloodMode(!floodMode);
              setPanelMinimised(false);
            }
          }}
        >
          Monsoon &amp; Flood Risk
        </button>
      </header>

      <main className={`fl-main ${showPanel ? 'has-panel' : ''}`}>
        <aside className={`fl-sidebar ${sheetCollapsed ? 'is-collapsed' : ''}`} aria-label="Route planner">
          <button
            type="button"
            className="fl-sheet-handle"
            aria-expanded={!sheetCollapsed}
            onClick={() => setSheetCollapsed((c) => !c)}
          >
            <span aria-hidden="true" />
            {sheetCollapsed ? 'Show route planner' : 'Hide route planner'}
          </button>
          <div className="fl-sidebar-body">
            {showDirections && selected && origin && destination ? (
              <DirectionsView
                candidate={selected}
                origin={origin}
                destination={destination}
                travelMode={travelMode}
                activeStep={activeStep}
                onStep={(i, s) => {
                  setActiveStep(i);
                  setFocusPoint(s.location);
                  setSheetCollapsed(false);
                }}
                onStart={beginNavigation}
                onBack={() => {
                  setDirectionsOpen(false);
                  setFocusPoint(null);
                  setActiveStep(null);
                  // Zoom back out to the whole route after inspecting a step.
                  setRefitNonce((n) => n + 1);
                }}
              />
            ) : (
            <>
            <section className="fl-section" aria-labelledby="plan-heading">
              <h1 id="plan-heading" className="fl-title">Plan a route</h1>
              <div className="fl-fields">
                <LocationField
                  label="Start"
                  marker="A"
                  tone="origin"
                  text={originText}
                  onTextChange={setOriginText}
                  onSelect={(p) => setPlace('origin', p)}
                  onClear={() => setPlace('origin', null)}
                  picking={pickTarget === 'origin'}
                  onTogglePick={() => setPickTarget(pickTarget === 'origin' ? null : 'origin')}
                  onUseMyLocation={useMyLocation}
                  locating={locating}
                />
                <button type="button" className="fl-swap" onClick={swap} aria-label="Swap start and destination" title="Swap">
                  ⇅
                </button>
                <LocationField
                  label="Destination"
                  marker="B"
                  tone="destination"
                  text={destText}
                  onTextChange={setDestText}
                  onSelect={(p) => setPlace('destination', p)}
                  onClear={() => setPlace('destination', null)}
                  picking={pickTarget === 'destination'}
                  onTogglePick={() => setPickTarget(pickTarget === 'destination' ? null : 'destination')}
                />
              </div>
              {pickTarget && pickTarget !== 'report' && (
                <p className="fl-hint" role="status">Tap the map to set the {pickTarget === 'origin' ? 'start' : 'destination'}.</p>
              )}
              {notice && (
                <p className="fl-hint" role="status">
                  {notice}{' '}
                  <button type="button" className="fl-link-btn" onClick={() => setNotice('')}>Dismiss</button>
                </p>
              )}

              <div className="fl-segment" role="group" aria-label="Travel mode">
                {MODES.map((m) => (
                  <button key={m.mode} type="button" aria-pressed={travelMode === m.mode} onClick={() => setTravelMode(m.mode)}>
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="fl-prefs" role="group" aria-label="Route preference">
                {PREFERENCES.map((p) => (
                  <button key={p.name} type="button" aria-pressed={preference === p.name} onClick={() => choosePreference(p.name)}>
                    <strong>{p.name}</strong>
                    <small>{p.hint}</small>
                  </button>
                ))}
              </div>
            </section>

            <div aria-live="polite">
              {routeState.status === 'idle' && (
                <p className="fl-empty">Choose a destination by searching, or tap the map. Routes appear automatically.</p>
              )}
              {routeState.status === 'loading' && (
                <div className="fl-loading" role="status">
                  <span className="fl-spinner" aria-hidden="true" /> Calculating routes and assessing flood risk…
                </div>
              )}
              {routeState.status === 'error' && (
                <div className="fl-error-box" role="alert">
                  <strong>Route not calculated</strong>
                  <p>{routeState.message}</p>
                  <p className="fl-muted">Your start, destination and travel mode are kept.</p>
                  <button type="button" className="fl-btn fl-btn--primary" onClick={() => setRouteNonce((n) => n + 1)}>
                    Retry
                  </button>
                </div>
              )}
            </div>

            {result && (
              <RouteCards
                result={result}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onDirections={() => setDirectionsOpen(true)}
                onStart={() => beginNavigation(false)}
              />
            )}
            {result && (
              <p className="fl-disclaimer">
                Informational estimate only — not a guarantee of safety. Never drive, cycle or walk into flood water.
              </p>
            )}

            </>
            )}

            {!showDirections && (
            <RecentRoutes
              items={recent}
              onPick={pickRecent}
              onClear={() => {
                setRecent([]);
                saveRecent([]);
              }}
            />
            )}
          </div>
        </aside>

        <section className="fl-map" aria-label="Map">
          <MapView
            origin={origin}
            destination={destination}
            candidates={candidates}
            selectedId={selectedId}
            fitKey={result ? `${result.assessedAt}-${travelMode}-${refitNonce}` : 'none'}
            recenterKey={recenterKey}
            pickingTarget={pickTarget}
            reportPin={reportOpen && reportPin ? ([reportPin.lat, reportPin.lon] as LatLon) : null}
            focusPoint={showDirections && !navigating ? focusPoint : null}
            navigation={
              navigating && nav.candidate
                ? {
                    route: nav.candidate.route,
                    segment: nav.guide?.segment ?? 0,
                    snapped: nav.guide?.snapped ?? null,
                    position: nav.position,
                    heading: nav.heading,
                    accuracyM: nav.accuracyM,
                    follow: nav.follow,
                  }
                : null
            }
            onUserPan={() => setFollow(false)}
            onSelectRoute={setSelectedId}
            onMapClick={onMapClick}
            onDragPlace={(which, lat, lon) => setPlace(which, { lat, lon, label: pinLabel(lat, lon) })}
            floodMode={floodMode}
            layers={layers}
            hazards={hazards ?? []}
            alerts={intel?.alerts.data?.alerts ?? []}
            reports={reports?.available ? reports.reports : []}
            clusters={reports?.available ? reports.clusters : []}
            rainfall={intel?.rainfall.data ?? null}
            river={intel?.river.data ?? null}
          />
          <div className="fl-map-tools">
            <button type="button" onClick={() => setRecenterKey((k) => k + 1)} aria-label="Centre map on Delhi" title="Centre on Delhi">
              ⌂
            </button>
          </div>
          {pickTarget === 'report' && <div className="fl-map-banner" role="status">Tap the map where you saw waterlogging</div>}
          {navigating && destination && (
            <NavigationOverlay nav={nav} destination={destination} onExit={endNavigation} onToggleMute={toggleMute} onRecenter={() => setFollow(true)} />
          )}
        </section>

        {showPanel && !navigating && (
          <FloodPanel
            intel={intel}
            intelError={intelError}
            loading={intelLoading}
            reports={reports}
            hazardCount={hazards ? hazards.length : null}
            layers={layers}
            onToggleLayer={(k) => setLayers((l) => ({ ...l, [k]: !l[k] }))}
            onRefresh={() => void loadIntel()}
            onClose={() => {
              setFloodMode(false);
              setReportOpen(false);
              setPickTarget(null);
            }}
            onMinimise={() => setPanelMinimised(true)}
            onReport={() => {
              setReportOpen(true);
              setLayers((l) => ({ ...l, community: true }));
            }}
            reportForm={
              reportOpen ? (
                <ReportForm
                  policy={reports?.policy ?? { expiryHours: 3, clusterRadiusMeters: 100, clusterWindowHours: 2, clusterMinReports: 2 }}
                  available={Boolean(reports?.available)}
                  pin={reportPin ? [reportPin.lat, reportPin.lon] : null}
                  pinLabel={reportPin?.label ?? ''}
                  onPinChange={setReportPin}
                  picking={pickTarget === 'report'}
                  onTogglePick={() => setPickTarget(pickTarget === 'report' ? null : 'report')}
                  onSubmitted={() => {
                    setReportPin(null);
                    void loadIntel();
                    // Re-assess the current route so the new report is reflected.
                    if (origin && destination) setRouteNonce((n) => n + 1);
                  }}
                  onCancel={() => {
                    setReportOpen(false);
                    setReportPin(null);
                    if (pickTarget === 'report') setPickTarget(null);
                  }}
                />
              ) : null
            }
          />
        )}
        {floodMode && panelMinimised && (
          <button type="button" className="fl-panel-reopen" onClick={() => setPanelMinimised(false)}>
            ☔ Show flood panel
          </button>
        )}
      </main>
    </div>
  );
}
