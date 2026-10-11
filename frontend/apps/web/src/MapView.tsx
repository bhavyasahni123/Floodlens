import { Fragment, useEffect, useMemo } from 'react';
import { Circle, CircleMarker, MapContainer, Marker, Polyline, Popup, TileLayer, Tooltip, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { formatDateTime, formatTime } from './lib/format';
import type {
  CommunityReport,
  HazardFeature,
  LatLon,
  LayerKey,
  OfficialAlert,
  Place,
  RainfallData,
  ReportCluster,
  RiverData,
  RouteCandidate,
} from './types';

export const DELHI_CENTER: LatLon = [28.6139, 77.209];

/** What the map needs while live navigation is running. */
export type NavMapState = {
  route: LatLon[];
  segment: number;
  snapped: LatLon | null;
  position: LatLon | null;
  heading: number | null;
  accuracyM: number | null;
  follow: boolean;
};

const ARROW = '<svg viewBox="0 0 24 24"><path d="M12 2 4.5 20.3l.7.7L12 18l6.8 3 .7-.7L12 2Z" /></svg>';
const userIcon = (heading: number | null) =>
  L.divIcon({
    className: '',
    html:
      heading === null
        ? '<span class="fl-user-dot" role="img" aria-label="Your position"></span>'
        : `<span class="fl-user-arrow" style="transform: rotate(${Math.round(heading)}deg)" role="img" aria-label="Your position and heading">${ARROW}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

function NavFollow({ nav, onUserPan }: { nav: NavMapState; onUserPan: () => void }) {
  const map = useMap();
  useMapEvents({ dragstart: onUserPan });
  useEffect(() => {
    if (!nav.follow || !nav.position) return;
    const position = nav.position;
    const centre = () => {
      // The container may have just grown (sidebar hidden); measure before centring.
      map.invalidateSize({ pan: false });
      // Jump for the initial zoom-in; animate the small pans that follow each GPS fix.
      const zoomingIn = map.getZoom() < 17;
      map.setView(position, Math.max(map.getZoom(), 17), { animate: !zoomingIn });
    };
    // A view change made during Leaflet's own zoom animation is overridden when it
    // finishes, so wait for any running zoom (e.g. the fit-to-route) to end first.
    // Leaflet 1.9 marks a running zoom animation with _animatingZoom (it may have started before this mounted).
    if ((map as unknown as { _animatingZoom?: boolean })._animatingZoom) {
      map.once('zoomend', centre);
      return () => {
        map.off('zoomend', centre);
      };
    }
    centre();
  }, [nav.follow, nav.position, map]);
  return null;
}

/** Leaflet caches its container size; re-measure whenever the surrounding layout changes. */
function SizeWatcher({ layoutKey }: { layoutKey: string }) {
  const map = useMap();
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize({ pan: false }), 0);
    return () => window.clearTimeout(id);
  }, [layoutKey, map]);
  return null;
}

function NavLayers({ nav }: { nav: NavMapState }) {
  // Split the route at the user's snapped position: travelled part grey, remaining part blue.
  const done = nav.snapped ? [...nav.route.slice(0, nav.segment + 1), nav.snapped] : [];
  const ahead = nav.snapped ? [nav.snapped, ...nav.route.slice(nav.segment + 1)] : nav.route;
  return (
    <>
      {done.length > 1 && <Polyline positions={done} pathOptions={{ color: '#94a3b8', weight: 7, opacity: 0.9 }} interactive={false} />}
      <Polyline positions={ahead} pathOptions={{ color: '#ffffff', weight: 11, opacity: 0.95 }} interactive={false} />
      <Polyline positions={ahead} pathOptions={{ color: '#1d4ed8', weight: 7, opacity: 1 }} interactive={false} />
      {nav.position && nav.accuracyM !== null && nav.accuracyM > 8 && (
        <Circle center={nav.position} radius={nav.accuracyM} pathOptions={{ color: '#1d4ed8', weight: 1, fillOpacity: 0.08 }} interactive={false} />
      )}
      {nav.position && <Marker position={nav.position} icon={userIcon(nav.heading)} interactive={false} zIndexOffset={1000} />}
    </>
  );
}

type MapViewProps = {
  origin: Place | null;
  destination: Place | null;
  candidates: RouteCandidate[];
  selectedId: string | null;
  fitKey: string;
  recenterKey: number;
  pickingTarget: 'origin' | 'destination' | 'report' | null;
  reportPin: LatLon | null;
  focusPoint: LatLon | null;
  navigation: NavMapState | null;
  onUserPan: () => void;
  onSelectRoute: (id: string) => void;
  onMapClick: (lat: number, lon: number) => void;
  onDragPlace: (which: 'origin' | 'destination', lat: number, lon: number) => void;
  floodMode: boolean;
  layers: Record<LayerKey, boolean>;
  hazards: HazardFeature[];
  alerts: OfficialAlert[];
  reports: CommunityReport[];
  clusters: ReportCluster[];
  rainfall: RainfallData | null;
  river: RiverData | null;
};

const pin = (cls: string, text: string, label: string) =>
  L.divIcon({
    className: '',
    html: `<span class="fl-pin ${cls}" role="img" aria-label="${label}"><span>${text}</span></span>`,
    iconSize: [30, 40],
    iconAnchor: [15, 38],
    popupAnchor: [0, -34],
  });

const originIcon = pin('fl-pin--origin', 'A', 'Origin');
const destinationIcon = pin('fl-pin--destination', 'B', 'Destination');
const reportPinIcon = pin('fl-pin--report', '+', 'New report location');
const alertIcon = L.divIcon({
  className: '',
  html: '<span class="fl-alert-icon" role="img" aria-label="Official alert">!</span>',
  iconSize: [30, 28],
  iconAnchor: [15, 14],
});
const riverIcon = L.divIcon({
  className: '',
  html: '<span class="fl-river-icon" role="img" aria-label="River model point">≈</span>',
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});
const clusterIcon = (count: number) =>
  L.divIcon({
    className: '',
    html: `<span class="fl-cluster-icon" role="img" aria-label="${count} corroborated community reports">${count}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });

const HOTSPOT_COLORS = { HIGH: '#c62828', MODERATE: '#d97706', LOW: '#a16207' };
const RAIN_COLORS = { NONE: '#94a3b8', LIGHT: '#60a5fa', MODERATE: '#2563eb', HEAVY: '#1e3a8a' };

function MapEvents({ onClick }: { onClick: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onClick(e.latlng.lat, e.latlng.lng) });
  return null;
}

function FocusPoint({ point }: { point: LatLon | null }) {
  const map = useMap();
  useEffect(() => {
    if (point) map.flyTo(point, Math.max(map.getZoom(), 16), { duration: 0.6 });
  }, [point, map]);
  if (!point) return null;
  return <CircleMarker center={point} radius={9} pathOptions={{ color: '#ffffff', weight: 3, fillColor: '#0f1e45', fillOpacity: 1 }} />;
}

function Viewport({ fitKey, recenterKey, candidates, origin, destination }: {
  fitKey: string;
  recenterKey: number;
  candidates: RouteCandidate[];
  origin: Place | null;
  destination: Place | null;
}) {
  const map = useMap();
  // Fit to all candidates only when a new route result arrives (not on card selection).
  useEffect(() => {
    const points = candidates.flatMap((c) => c.route);
    if (points.length > 0) map.fitBounds(L.latLngBounds(points as L.LatLngTuple[]), { padding: [48, 48] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitKey, map]);
  useEffect(() => {
    if (candidates.length > 0) return;
    const pts = [origin, destination].filter(Boolean) as Place[];
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lon], Math.max(map.getZoom(), 13));
    if (pts.length === 2) map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lon]) as L.LatLngTuple[]), { padding: [60, 60] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin?.lat, origin?.lon, destination?.lat, destination?.lon, map]);
  useEffect(() => {
    if (recenterKey > 0) map.setView(DELHI_CENTER, 12);
  }, [recenterKey, map]);
  return null;
}

export default function MapView(props: MapViewProps) {
  const { candidates, selectedId, floodMode, layers } = props;
  const ordered = useMemo(
    () => [...candidates].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId)),
    [candidates, selectedId],
  );
  const show = (k: LayerKey) => floodMode && layers[k];

  return (
    <MapContainer
      center={DELHI_CENTER}
      zoom={12}
      scrollWheelZoom
      className={`fl-leaflet ${props.pickingTarget ? 'is-picking' : ''}`}
      attributionControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <MapEvents onClick={props.onMapClick} />
      <SizeWatcher layoutKey={props.navigation ? 'nav' : 'plan'} />
      <Viewport
        fitKey={props.fitKey}
        recenterKey={props.recenterKey}
        candidates={candidates}
        origin={props.origin}
        destination={props.destination}
      />

      {show('hotspots') &&
        props.hazards.map((f) => {
          const [lon, lat] = f.geometry.coordinates;
          const color = HOTSPOT_COLORS[f.properties.severity] ?? HOTSPOT_COLORS.LOW;
          return (
            <Circle
              key={f.id}
              center={[lat, lon]}
              radius={f.properties.bufferRadiusMeters}
              pathOptions={{ color, fillColor: color, fillOpacity: 0.18, weight: 1.5 }}
            >
              <Popup>
                <div className="fl-popup">
                  <span className="fl-popup-kind">Historical hotspot · not a live reading</span>
                  <strong>{f.properties.name}</strong>
                  <span className={`fl-chip fl-chip--${f.properties.severity.toLowerCase()}`}>
                    {f.properties.severity} historical susceptibility
                  </span>
                  <p>{f.properties.infrastructureType} · {f.properties.zone}</p>
                  <p>{f.properties.description}</p>
                  <p className="fl-popup-meta">
                    Location approximate; circle is a {f.properties.bufferRadiusMeters} m analysis margin, not a flood boundary.
                    Claimed source “{f.properties.provenance?.claimedAttribution ?? f.properties.dataSource}” — not verified.
                  </p>
                </div>
              </Popup>
            </Circle>
          );
        })}

      {show('alerts') &&
        props.alerts.map((a) => (
          <Fragment key={a.id}>
            {a.approxRadiusKm !== null && (
              <Circle
                center={a.centroid}
                radius={a.approxRadiusKm * 1000}
                pathOptions={{ color: '#6b21a8', weight: 2, dashArray: '6 6', fillOpacity: 0.05 }}
                interactive={false}
              />
            )}
            <Marker position={a.centroid} icon={alertIcon}>
              <Popup>
                <div className="fl-popup">
                  <span className="fl-popup-kind fl-popup-kind--official">Official alert · {a.issuer}</span>
                  <strong>{a.event}</strong>
                  <p>{a.headline}</p>
                  <p>Area: {a.areaDescription}</p>
                  <p>
                    Valid {formatDateTime(a.effectiveStart)} – {formatDateTime(a.effectiveEnd)}
                  </p>
                  <p>Severity: {a.severity}{a.certainty ? ` · ${a.certainty}` : ''}</p>
                  <p className="fl-popup-meta">
                    Marker = published area centroid; dashed circle = equal-area approximation, not the official polygon.
                  </p>
                  <a href={a.sourceUrl} target="_blank" rel="noreferrer">Official CAP alert (SACHET)</a>
                </div>
              </Popup>
            </Marker>
          </Fragment>
        ))}

      {show('community') &&
        props.clusters.map((c) => (
          <Marker key={c.id} position={c.centroid} icon={clusterIcon(c.reportCount)}>
            <Popup>
              <div className="fl-popup">
                <span className="fl-popup-kind fl-popup-kind--community">Corroborated Community Reports · unverified</span>
                <strong>{c.reportCount} matching reports</strong>
                <p>
                  {formatTime(c.firstSubmittedAt)}–{formatTime(c.lastSubmittedAt)} IST
                </p>
                <p className="fl-popup-meta">
                  {c.independenceEstablished
                    ? `From ${c.distinctSources} different submitters.`
                    : 'May come from a single device or network — independence not established.'}{' '}
                  Not officially verified.
                </p>
              </div>
            </Popup>
          </Marker>
        ))}
      {show('community') &&
        props.reports.map((r) => (
          <CircleMarker
            key={r.id}
            center={[r.lat, r.lon]}
            radius={7}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#0e7490', fillOpacity: 1 }}
          >
            <Popup>
              <div className="fl-popup">
                <span className="fl-popup-kind fl-popup-kind--community">Community report · unverified</span>
                <p>{r.description}</p>
                {r.locationLabel && <p>Near {r.locationLabel}</p>}
                <p className="fl-popup-meta">
                  Submitted {formatDateTime(r.submittedAt)} · leaves the map at {formatTime(r.expiresAt)} IST
                </p>
              </div>
            </Popup>
          </CircleMarker>
        ))}

      {show('rainfall') &&
        props.rainfall?.samples.map((s) => (
          <CircleMarker
            key={s.id}
            center={[s.lat, s.lon]}
            radius={12}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: RAIN_COLORS[s.summary.intensity], fillOpacity: 0.9 }}
          >
            <Tooltip direction="top" offset={[0, -10]}>
              {s.name}: {s.summary.past3hMm} mm past 3 h (est.) · {s.summary.next3hMm} mm next 3 h (forecast)
            </Tooltip>
          </CircleMarker>
        ))}

      {show('river') && props.river && (
        <Marker position={[props.river.lat, props.river.lon]} icon={riverIcon}>
          <Popup>
            <div className="fl-popup">
              <span className="fl-popup-kind">Modelled river discharge · not a gauge</span>
              <strong>{props.river.river}</strong>
              <p>
                Today: {props.river.todayM3s ?? '—'} {props.river.units} · trend {props.river.trend.toLowerCase()}
              </p>
              <p className="fl-popup-meta">{props.river.label}</p>
            </div>
          </Popup>
        </Marker>
      )}

      {props.navigation && <NavLayers nav={props.navigation} />}
      {props.navigation && <NavFollow nav={props.navigation} onUserPan={props.onUserPan} />}

      {!props.navigation && ordered.map((c) => {
        const selected = c.id === selectedId;
        return (
          // Keyed by selection so a newly selected route remounts and is drawn above the others
          // (Leaflet stacks layers by mount order, not by React child order).
          <Fragment key={`${c.id}-${selected}`}>
            {selected && <Polyline positions={c.route} pathOptions={{ color: '#ffffff', weight: 9, opacity: 0.95 }} interactive={false} />}
            <Polyline
              positions={c.route}
              pathOptions={{ color: selected ? '#1d4ed8' : '#7c8db5', weight: selected ? 6 : 5, opacity: selected ? 1 : 0.75 }}
              eventHandlers={{
                click: (e) => {
                  L.DomEvent.stopPropagation(e);
                  props.onSelectRoute(c.id);
                },
              }}
            >
              <Tooltip sticky>Route {c.id}{selected ? ' (selected)' : ' — click to select'}</Tooltip>
            </Polyline>
          </Fragment>
        );
      })}

      {props.origin && !props.navigation && (
        <Marker
          position={[props.origin.lat, props.origin.lon]}
          icon={originIcon}
          draggable
          eventHandlers={{ dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); props.onDragPlace('origin', p.lat, p.lng); } }}
        >
          <Tooltip direction="top" offset={[0, -34]}>Start: {props.origin.label} (drag to move)</Tooltip>
        </Marker>
      )}
      {props.destination && (
        <Marker
          position={[props.destination.lat, props.destination.lon]}
          icon={destinationIcon}
          draggable
          eventHandlers={{ dragend: (e) => { const p = (e.target as L.Marker).getLatLng(); props.onDragPlace('destination', p.lat, p.lng); } }}
        >
          <Tooltip direction="top" offset={[0, -34]}>Destination: {props.destination.label} (drag to move)</Tooltip>
        </Marker>
      )}
      {props.reportPin && <Marker position={props.reportPin} icon={reportPinIcon} />}
      <FocusPoint point={props.focusPoint} />
    </MapContainer>
  );
}
