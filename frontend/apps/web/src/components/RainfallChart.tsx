import { useState } from 'react';
import { formatTime } from '../lib/format';
import type { RainPoint } from '../types';

/** Hourly bars: past 12 h (model estimate) and next 12 h (forecast). Missing hours are left empty. */
export default function RainfallChart({ series, nowMs = Date.now() }: { series: RainPoint[]; nowMs?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const points = series.filter((p) => Math.abs(new Date(p.time).getTime() - nowMs) <= 12 * 3600e3);
  if (points.length === 0) return <p className="fl-muted">No hourly rainfall values available for this period.</p>;

  const W = 300;
  const H = 110;
  const pad = { l: 26, r: 6, t: 10, b: 20 };
  const max = Math.max(2, ...points.map((p) => p.mm));
  const startMs = nowMs - 12 * 3600e3;
  const xFor = (ms: number) => pad.l + ((ms - startMs) / (24 * 3600e3)) * (W - pad.l - pad.r);
  const slot = (W - pad.l - pad.r) / 24;
  const barW = Math.max(2, slot - 2);
  const y = (mm: number) => H - pad.b - (mm / max) * (H - pad.t - pad.b);
  const pastTotal = points.filter((p) => p.kind === 'ESTIMATED_PAST').reduce((s, p) => s + p.mm, 0);
  const nextTotal = points.filter((p) => p.kind === 'FORECAST').reduce((s, p) => s + p.mm, 0);
  const summary = `Rainfall, past 12 hours estimated ${pastTotal.toFixed(1)} mm; next 12 hours forecast ${nextTotal.toFixed(1)} mm.`;
  const h = hover !== null ? points[hover] : null;

  return (
    <figure className="fl-chart">
      <div className="fl-chart-legend">
        <span><i className="fl-swatch fl-swatch--past" /> Estimated past (model)</span>
        <span><i className="fl-swatch fl-swatch--forecast" /> Forecast</span>
        <button type="button" className="fl-link-btn" onClick={() => setAsTable((t) => !t)} aria-pressed={asTable}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>
      {asTable ? (
        <div className="fl-table-wrap">
          <table className="fl-table">
            <caption className="fl-sr">{summary}</caption>
            <thead>
              <tr><th scope="col">Hour ending (IST)</th><th scope="col">mm</th><th scope="col">Type</th></tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.time}>
                  <td>{formatTime(p.time)}</td>
                  <td>{p.mm.toFixed(1)}</td>
                  <td>{p.kind === 'FORECAST' ? 'Forecast' : 'Estimated past'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="fl-chart-plot">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} onMouseLeave={() => setHover(null)}>
            <defs>
              <pattern id="fl-hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="4" height="4" fill="#7aa7f0" />
                <line x1="0" y1="0" x2="0" y2="4" stroke="#ffffff" strokeWidth="1.2" />
              </pattern>
            </defs>
            {[0, max / 2, max].map((v) => (
              <g key={v}>
                <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="fl-grid" />
                <text x={pad.l - 4} y={y(v) + 3} textAnchor="end" className="fl-axis">{v.toFixed(v < 10 ? 1 : 0)}</text>
              </g>
            ))}
            {points.map((p, i) => {
              const ms = new Date(p.time).getTime();
              // Bar spans the hour the value covers (hour ending at p.time).
              const x = xFor(ms - 3600e3) + 1;
              const top = y(p.mm);
              const height = Math.max(0, H - pad.b - top);
              const r = Math.min(3, barW / 2, height);
              const base = H - pad.b;
              return (
                <g key={p.time}>
                  {height > 0 && (
                    <path
                      d={`M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${base} Z`}
                      fill={p.kind === 'FORECAST' ? 'url(#fl-hatch)' : '#1d4ed8'}
                      opacity={hover === null || hover === i ? 1 : 0.55}
                    />
                  )}
                  <rect
                    x={x - 1}
                    y={pad.t}
                    width={slot}
                    height={H - pad.t - pad.b}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                  />
                </g>
              );
            })}
            <line x1={xFor(nowMs)} x2={xFor(nowMs)} y1={pad.t - 4} y2={H - pad.b} className="fl-now" />
            <text x={xFor(nowMs)} y={H - 6} textAnchor="middle" className="fl-axis fl-axis--strong">now</text>
            <text x={pad.l} y={H - 6} className="fl-axis">−12 h</text>
            <text x={W - pad.r} y={H - 6} textAnchor="end" className="fl-axis">+12 h</text>
            <text x={2} y={pad.t - 2} className="fl-axis">mm</text>
          </svg>
          {h && (
            <div className="fl-tooltip" role="status">
              <strong>{h.mm.toFixed(1)} mm</strong> · hour ending {formatTime(h.time)} IST · {h.kind === 'FORECAST' ? 'forecast' : 'model estimate'}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
