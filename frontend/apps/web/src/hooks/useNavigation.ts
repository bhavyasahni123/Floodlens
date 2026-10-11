import { useCallback, useEffect, useRef, useState } from 'react';
import { planRoutes } from '../api';
import { bearing, guidance, haversine, indexRoute, pointAt, spokenInstruction, stepPositions, type Guidance, type RouteIndex } from '../lib/navigation';
import type { LatLon, Place, Preference, RouteCandidate, RouteResponse, TravelMode } from '../types';

export type NavStatus = 'locating' | 'navigating' | 'rerouting' | 'arrived' | 'error';

export type NavState = {
  active: boolean;
  simulated: boolean;
  status: NavStatus;
  candidate: RouteCandidate | null;
  position: LatLon | null;
  heading: number | null;
  accuracyM: number | null;
  guide: Guidance | null;
  message: string | null;
  muted: boolean;
  follow: boolean;
  startedAt: number;
};

type Options = { destination: Place | null; travelMode: TravelMode; preference: Preference };

const IDLE: NavState = {
  active: false,
  simulated: false,
  status: 'locating',
  candidate: null,
  position: null,
  heading: null,
  accuracyM: null,
  guide: null,
  message: null,
  muted: false,
  follow: true,
  startedAt: 0,
};

const OFF_ROUTE_FIXES = 2;
const REROUTE_COOLDOWN_MS = 10000;
const SIM_SPEED_MS: Record<TravelMode, number> = { driving: 11, walking: 1.4, cycling: 4.5 };
export const SIM_FACTOR = 4;
/** Distance at which the "now" prompt is spoken for a maneuver. */
const NOW_PROMPT_M: Record<TravelMode, number> = { driving: 120, walking: 30, cycling: 50 };

function pickFor(data: RouteResponse, pref: Preference): RouteCandidate {
  const p = data.preferences;
  const id = (pref === 'Fastest' ? p.fastest : pref === 'Balanced' ? p.balanced : p.lowerRisk) ?? p.fastest;
  return data.candidates.find((c) => c.id === id) ?? data.candidates[0];
}

type WakeLockLike = { release: () => Promise<void> };

export function useNavigation({ destination, travelMode, preference }: Options) {
  const [state, setState] = useState<NavState>(IDLE);
  const s = useRef({
    index: null as RouteIndex | null,
    positions: [] as number[],
    segment: 0,
    offCount: 0,
    lastReroute: 0,
    spoken: new Set<string>(),
    prev: null as LatLon | null,
    watchId: null as number | null,
    simTimer: null as number | null,
    simAlong: 0,
    wake: null as WakeLockLike | null,
    muted: false,
    active: false,
    rerouting: false,
    candidate: null as RouteCandidate | null,
  });
  const opts = useRef({ destination, travelMode, preference });
  opts.current = { destination, travelMode, preference };

  const speak = useCallback((text: string) => {
    if (s.current.muted || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-IN';
      u.rate = 1;
      window.speechSynthesis.speak(u);
    } catch {
      // Voice guidance is best-effort.
    }
  }, []);

  const loadRoute = useCallback((candidate: RouteCandidate) => {
    const index = indexRoute(candidate.route);
    s.current.index = index;
    s.current.positions = stepPositions(index, candidate.steps);
    s.current.segment = 0;
    s.current.offCount = 0;
    s.current.spoken = new Set();
    s.current.candidate = candidate;
  }, []);

  const stopSensors = useCallback(() => {
    const c = s.current;
    if (c.watchId !== null) navigator.geolocation?.clearWatch(c.watchId);
    if (c.simTimer !== null) window.clearInterval(c.simTimer);
    c.watchId = null;
    c.simTimer = null;
    c.wake?.release().catch(() => {});
    c.wake = null;
  }, []);

  const reroute = useCallback(
    async (from: LatLon) => {
      const c = s.current;
      const { destination: dest, travelMode: mode, preference: pref } = opts.current;
      if (!dest || c.rerouting) return;
      c.rerouting = true;
      c.lastReroute = Date.now();
      setState((st) => ({ ...st, status: 'rerouting', message: 'You left the route. Finding a new one…' }));
      speak('Rerouting');
      try {
        const data = await planRoutes({ origin: { lat: from[0], lon: from[1], label: 'Current position' }, destination: dest, travelMode: mode, preference: pref });
        if (!c.active) return;
        const next = pickFor(data, pref);
        loadRoute(next);
        speak('Route updated');
        setState((st) => ({ ...st, status: 'navigating', candidate: next, message: 'Route updated from your current position' }));
      } catch {
        if (!c.active) return;
        setState((st) => ({ ...st, status: 'navigating', message: 'Could not find a new route. Head back to the blue line; FloodLens will keep trying.' }));
      } finally {
        c.rerouting = false;
        c.lastReroute = Date.now();
      }
    },
    [loadRoute, speak],
  );

  const onFix = useCallback(
    (pos: LatLon, accuracyM: number, gpsHeading: number | null) => {
      const c = s.current;
      const { destination: dest, travelMode: mode } = opts.current;
      if (!c.active || !c.index || !c.candidate || !dest) return;
      let heading: number | null = gpsHeading;
      if (heading === null && c.prev && haversine(c.prev, pos) > 4) heading = bearing(c.prev, pos);
      if (heading !== null || !c.prev) c.prev = pos;

      const g = guidance(c.index, c.positions, pos, accuracyM, mode, [dest.lat, dest.lon], c.segment);
      if (!g.offRoute) c.segment = g.segment;

      if (g.arrived) {
        if (!c.spoken.has('arrived')) {
          c.spoken.add('arrived');
          speak('You have arrived at your destination');
        }
        stopSensors();
        setState((st) => ({ ...st, position: pos, accuracyM, heading: heading ?? st.heading, guide: g, status: 'arrived', message: null }));
        return;
      }

      // Off-route needs consecutive fixes so one noisy GPS reading doesn't trigger a reroute.
      c.offCount = g.offRoute ? c.offCount + 1 : 0;
      if (c.offCount >= OFF_ROUTE_FIXES && !c.rerouting && Date.now() - c.lastReroute > REROUTE_COOLDOWN_MS) {
        void reroute(pos);
      }

      // Voice prompts: once when a maneuver becomes next, once when it is close.
      const step = c.candidate.steps[g.nextStep];
      if (step && !g.offRoute) {
        const keyNext = `${c.candidate.id}-${g.nextStep}-next`;
        const keyNow = `${c.candidate.id}-${g.nextStep}-now`;
        if (g.distanceToNextM <= NOW_PROMPT_M[mode] && !c.spoken.has(keyNow)) {
          c.spoken.add(keyNow);
          c.spoken.add(keyNext);
          speak(step.instruction);
        } else if (!c.spoken.has(keyNext)) {
          c.spoken.add(keyNext);
          speak(spokenInstruction(step.instruction, g.distanceToNextM));
        }
      }

      setState((st) => ({
        ...st,
        position: pos,
        accuracyM,
        heading: heading ?? st.heading,
        guide: g,
        status: c.rerouting ? 'rerouting' : 'navigating',
        // A good on-route fix clears stale notices (e.g. an earlier GPS timeout or a failed reroute).
        message: c.rerouting ? st.message : g.offRoute ? (st.message && st.message !== 'Off route' ? st.message : 'Off route') : null,
      }));
    },
    [reroute, speak, stopSensors],
  );

  const start = useCallback(
    (candidate: RouteCandidate, simulate = false) => {
      stopSensors();
      const c = s.current;
      c.active = true;
      c.prev = null;
      c.lastReroute = 0;
      c.rerouting = false;
      loadRoute(candidate);
      setState({ ...IDLE, active: true, simulated: simulate, candidate, muted: c.muted, status: simulate ? 'navigating' : 'locating', startedAt: Date.now() });

      // Keep the screen on while navigating (supported browsers only).
      const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockLike> } };
      nav.wakeLock?.request('screen').then((w) => (c.wake = w)).catch(() => {});

      if (simulate) {
        c.simAlong = 0;
        const tick = () => {
          if (!c.index) return;
          const step = SIM_SPEED_MS[opts.current.travelMode] * SIM_FACTOR;
          c.simAlong = Math.min(c.index.total, c.simAlong + step);
          const p = pointAt(c.index, c.simAlong);
          const ahead = pointAt(c.index, c.simAlong + 15);
          onFix(p, 5, haversine(p, ahead) > 1 ? bearing(p, ahead) : null);
        };
        tick();
        c.simTimer = window.setInterval(tick, 1000);
        return;
      }

      if (!('geolocation' in navigator)) {
        setState((st) => ({ ...st, status: 'error', message: 'This browser cannot provide your location, so live navigation is unavailable.' }));
        return;
      }
      c.watchId = navigator.geolocation.watchPosition(
        (p) => {
          const h = p.coords.heading;
          const moving = (p.coords.speed ?? 0) > 0.7;
          onFix([p.coords.latitude, p.coords.longitude], p.coords.accuracy, h !== null && !Number.isNaN(h) && moving ? h : null);
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) {
            stopSensors();
            setState((st) => ({ ...st, status: 'error', message: 'Location permission was denied. Allow location access to use live navigation.' }));
          } else {
            setState((st) => ({ ...st, message: 'Waiting for a GPS signal…' }));
          }
        },
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 },
      );
    },
    [loadRoute, onFix, stopSensors],
  );

  const stop = useCallback(() => {
    s.current.active = false;
    stopSensors();
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    setState(IDLE);
  }, [stopSensors]);

  const toggleMute = useCallback(() => {
    s.current.muted = !s.current.muted;
    if (s.current.muted && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setState((st) => ({ ...st, muted: s.current.muted }));
  }, []);

  const setFollow = useCallback((follow: boolean) => setState((st) => (st.follow === follow ? st : { ...st, follow })), []);

  useEffect(() => () => stopSensors(), [stopSensors]);

  return { nav: state, start, stop, toggleMute, setFollow };
}
