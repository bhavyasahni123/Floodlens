import { useState, type ReactNode } from 'react';
import { formatAge, formatDateTime } from '../lib/format';
import type { Intelligence, LayerKey, ReportsResponse, SourceEnvelope, SourceStatus } from '../types';
import RainfallChart from './RainfallChart';

type Props = {
  intel: Intelligence | null;
  intelError: string | null;
  loading: boolean;
  reports: ReportsResponse | null;
  hazardCount: number | null;
  layers: Record<LayerKey, boolean>;
  onToggleLayer: (k: LayerKey) => void;
  onRefresh: () => void;
  onClose: () => void;
  onMinimise: () => void;
  onReport: () => void;
  reportForm: ReactNode;
};

function Status({ status, retrievedAt, error }: { status: SourceStatus | 'AVAILABLE'; retrievedAt?: string | null; error?: string }) {
  if (status === 'LIVE' || status === 'AVAILABLE') {
    return <span className="fl-status fl-status--live">● {status === 'LIVE' ? `Live · retrieved ${formatAge(retrievedAt)}` : 'Available'}</span>;
  }
  if (status === 'STALE') {
    return (
      <span className="fl-status fl-status--stale" title={error}>
        ◐ Stale · last retrieved {formatAge(retrievedAt)} (refresh failed)
      </span>
    );
  }
  return <span className="fl-status fl-status--down" title={error}>○ Unavailable{error ? ` — ${error}` : ''}</span>;
}

function SourceLine({ env }: { env: SourceEnvelope<unknown> }) {
  return (
    <p className="fl-source">
      Source: <a href={env.source.url} target="_blank" rel="noreferrer">{env.source.name}</a> · {env.source.license}
    </p>
  );
}

const LAYERS: { key: LayerKey; label: string; swatch: string }[] = [
  { key: 'alerts', label: 'Official alerts', swatch: 'fl-swatch--alert' },
  { key: 'hotspots', label: 'Historical hotspots', swatch: 'fl-swatch--hotspot' },
  { key: 'community', label: 'Community reports', swatch: 'fl-swatch--community' },
  { key: 'rainfall', label: 'Rainfall', swatch: 'fl-swatch--rain' },
  { key: 'river', label: 'River (Yamuna, modelled)', swatch: 'fl-swatch--river' },
];

export default function FloodPanel(props: Props) {
  const { intel, reports } = props;
  const [zone, setZone] = useState('central');

  const layerStatus = (k: LayerKey): { text: string; ok: boolean } => {
    if (!intel) return { text: '…', ok: false };
    switch (k) {
      case 'alerts':
        return intel.alerts.data ? { text: `${intel.alerts.data.alerts.length} near Delhi`, ok: true } : { text: 'Unavailable', ok: false };
      case 'hotspots':
        return props.hazardCount !== null ? { text: `${props.hazardCount} mapped`, ok: true } : { text: 'Unavailable', ok: false };
      case 'community':
        return reports?.available ? { text: `${reports.reports.length} active`, ok: true } : { text: 'Unavailable', ok: false };
      case 'rainfall':
        return intel.rainfall.data ? { text: intel.rainfall.status === 'STALE' ? 'Stale' : '5 points', ok: true } : { text: 'Unavailable', ok: false };
      case 'river':
        return intel.river.data ? { text: intel.river.status === 'STALE' ? 'Stale' : '1 point', ok: true } : { text: 'Unavailable', ok: false };
    }
  };

  const sample = intel?.rainfall.data?.samples.find((s) => s.id === zone) ?? intel?.rainfall.data?.samples[0];
  const river = intel?.river.data;

  return (
    <aside className="fl-panel" aria-labelledby="flood-heading">
      <header className="fl-panel-head">
        <div>
          <span className="fl-eyebrow">Delhi · flood intelligence</span>
          <h2 id="flood-heading">Monsoon &amp; Flood Risk</h2>
        </div>
        <div className="fl-row">
          <button type="button" className="fl-icon-btn" onClick={props.onRefresh} aria-label="Refresh flood data" title="Refresh" disabled={props.loading}>
            ↻
          </button>
          <button type="button" className="fl-icon-btn fl-only-mobile" onClick={props.onMinimise} aria-label="Minimise panel, keep overlays" title="Minimise">
            ▾
          </button>
          <button type="button" className="fl-icon-btn" onClick={props.onClose} aria-label="Close flood panel and hide overlays" title="Close">
            ×
          </button>
        </div>
      </header>

      <div className="fl-panel-body">
        {props.intelError && <p className="fl-error" role="alert">{props.intelError}</p>}
        {props.loading && !intel && <p className="fl-muted" aria-live="polite">Loading flood data…</p>}

        <fieldset className="fl-layers">
          <legend>Map layers</legend>
          {LAYERS.map((l) => {
            const st = layerStatus(l.key);
            return (
              <label key={l.key} className={`fl-layer ${st.ok ? '' : 'is-unavailable'}`}>
                <input type="checkbox" checked={props.layers[l.key]} onChange={() => props.onToggleLayer(l.key)} disabled={!st.ok} />
                <i className={`fl-swatch ${l.swatch}`} aria-hidden="true" />
                <span>{l.label}</span>
                <small>{st.text}</small>
              </label>
            );
          })}
        </fieldset>

        {intel && (
          <>
            <section className="fl-block" aria-labelledby="alerts-h">
              <h3 id="alerts-h">Official alerts</h3>
              <Status status={intel.alerts.status} retrievedAt={intel.alerts.retrievedAt} error={intel.alerts.error} />
              {intel.alerts.data && (
                <p>
                  {intel.alerts.data.alerts.length === 0
                    ? `No active alerts near Delhi in the national feed (${intel.alerts.data.nationalCount} alerts nationwide). This does not mean roads are clear.`
                    : `${intel.alerts.data.alerts.length} alert(s) near Delhi — shown on the map with a purple ! marker. Select one for details.`}
                </p>
              )}
              <SourceLine env={intel.alerts} />
            </section>

            <section className="fl-block" aria-labelledby="rain-h">
              <h3 id="rain-h">Rainfall</h3>
              <Status status={intel.rainfall.status} retrievedAt={intel.rainfall.retrievedAt} error={intel.rainfall.error} />
              {sample && (
                <>
                  <label className="fl-inline">
                    Area{' '}
                    <select value={sample.id} onChange={(e) => setZone(e.target.value)}>
                      {intel.rainfall.data!.samples.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  </label>
                  <dl className="fl-stats">
                    <div><dt>Past 3 h <small>(estimate)</small></dt><dd>{sample.summary.past3hMm} mm</dd></div>
                    <div><dt>Next 3 h <small>(forecast)</small></dt><dd>{sample.summary.next3hMm} mm</dd></div>
                    <div><dt>Past 24 h <small>(estimate)</small></dt><dd>{sample.summary.past24hMm} mm</dd></div>
                    <div><dt>Next 24 h <small>(forecast)</small></dt><dd>{sample.summary.next24hMm} mm</dd></div>
                  </dl>
                  <RainfallChart series={sample.series} />
                </>
              )}
              <p className="fl-note">{intel.rainfall.source.note}</p>
              <SourceLine env={intel.rainfall} />
            </section>

            <section className="fl-block" aria-labelledby="river-h">
              <h3 id="river-h">River — Yamuna</h3>
              <Status status={intel.river.status} retrievedAt={intel.river.retrievedAt} error={intel.river.error} />
              {river ? (
                <dl className="fl-stats">
                  <div><dt>Today <small>(modelled)</small></dt><dd>{river.todayM3s ?? '—'} m³/s</dd></div>
                  <div><dt>7-day peak <small>(forecast)</small></dt><dd>{river.forecastPeakM3s ?? '—'} m³/s</dd></div>
                  <div><dt>Trend</dt><dd>{river.trend.charAt(0) + river.trend.slice(1).toLowerCase()}</dd></div>
                </dl>
              ) : (
                <p>River data could not be retrieved. Missing data does not mean safe conditions.</p>
              )}
              <p className="fl-note">{intel.river.source.note}</p>
              <SourceLine env={intel.river} />
            </section>

            <section className="fl-block" aria-labelledby="community-h">
              <h3 id="community-h">Community reports</h3>
              {reports?.available ? (
                <>
                  <span className="fl-status fl-status--live">● Available</span>
                  <p>
                    {reports.reports.length} active unverified report(s); {reports.clusters.length} corroborated cluster(s).
                    Reports within {reports.policy.clusterRadiusMeters} m and {reports.policy.clusterWindowHours} h of each other are
                    grouped as “Corroborated Community Reports” — still not officially verified. Reports leave the map after{' '}
                    {reports.policy.expiryHours} h.
                  </p>
                </>
              ) : (
                <Status status="UNAVAILABLE" error={reports && !reports.available ? reports.reason : undefined} />
              )}
              {props.reportForm ?? (
                <button type="button" className="fl-btn fl-btn--secondary" onClick={props.onReport}>
                  + Report waterlogging
                </button>
              )}
            </section>

            <section className="fl-block" aria-labelledby="hotspot-h">
              <h3 id="hotspot-h">Historical hotspots</h3>
              <p>
                {props.hazardCount ?? 0} places commonly reported as waterlogging-prone. Locations and severity are approximate and
                their official attribution is unverified. They describe past susceptibility, not current water.
              </p>
            </section>

            <section className="fl-block fl-legend" aria-labelledby="legend-h">
              <h3 id="legend-h">Legend</h3>
              <ul>
                <li><span className="fl-legend-alert" aria-hidden="true">!</span> Official alert (area centroid; dashed = approx. area)</li>
                <li><i className="fl-swatch fl-swatch--hotspot" aria-hidden="true" /> High / <i className="fl-swatch fl-swatch--hotspot-mod" aria-hidden="true" /> moderate historical hotspot</li>
                <li><i className="fl-swatch fl-swatch--community" aria-hidden="true" /> Unverified report · <span className="fl-legend-cluster" aria-hidden="true">2</span> corroborated cluster</li>
                <li><i className="fl-swatch fl-swatch--rain" aria-hidden="true" /> Rainfall point (darker = heavier)</li>
                <li><span className="fl-legend-river" aria-hidden="true">≈</span> River model point</li>
              </ul>
              <p className="fl-muted">Updated {formatDateTime(intel.generatedAt)}. Each source refreshes independently.</p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
