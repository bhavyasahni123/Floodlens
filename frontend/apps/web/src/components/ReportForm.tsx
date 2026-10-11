import { useState, type FormEvent } from 'react';
import { ApiError, submitReport } from '../api';
import type { LatLon, Place, ReportPolicy } from '../types';
import LocationField from './LocationField';

type Props = {
  policy: ReportPolicy;
  available: boolean;
  pin: LatLon | null;
  pinLabel: string;
  onPinChange: (place: Place | null) => void;
  picking: boolean;
  onTogglePick: () => void;
  onSubmitted: () => void;
  onCancel: () => void;
};

const MIN = 5;
const MAX = 500;

export default function ReportForm(props: Props) {
  const [text, setText] = useState(props.pinLabel);
  const [description, setDescription] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'error' | 'done'; message?: string }>({ kind: 'idle' });
  const [lastPinLabel, setLastPinLabel] = useState(props.pinLabel);
  if (props.pinLabel !== lastPinLabel) {
    // Map clicks update the pin from outside; mirror its label in the field.
    setLastPinLabel(props.pinLabel);
    setText(props.pinLabel);
  }

  const trimmed = description.trim();
  const valid = props.pin !== null && trimmed.length >= MIN && trimmed.length <= MAX;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!props.pin || !valid) return;
    setState({ kind: 'sending' });
    try {
      const res = await submitReport({ lat: props.pin[0], lon: props.pin[1], description: trimmed, locationLabel: text || undefined });
      setState({ kind: 'done', message: res.message });
      setDescription('');
      props.onSubmitted();
    } catch (err) {
      setState({ kind: 'error', message: err instanceof ApiError ? err.message : 'Could not submit the report.' });
    }
  }

  if (!props.available) {
    return (
      <div className="fl-report">
        <p className="fl-warning">Community reports are unavailable right now (the report database is not reachable).</p>
        <button type="button" className="fl-btn fl-btn--ghost" onClick={props.onCancel}>Close</button>
      </div>
    );
  }

  return (
    <form className="fl-report" onSubmit={onSubmit} aria-labelledby="report-heading">
      <h3 id="report-heading">Report waterlogging</h3>
      <p className="fl-muted">
        No account needed. Reports are public, shown as <strong>unverified</strong>, and leave the active map after{' '}
        {props.policy.expiryHours} hours. Do not include personal information.
      </p>
      <LocationField
        label="Location"
        marker="!"
        tone="report"
        text={text}
        onTextChange={setText}
        onSelect={(p) => {
          setText(p.label);
          setLastPinLabel(p.label);
          props.onPinChange(p);
        }}
        onClear={() => {
          setText('');
          props.onPinChange(null);
        }}
        picking={props.picking}
        onTogglePick={props.onTogglePick}
      />
      {!props.pin && <p className="fl-hint">Search for the place or tap ⌖ and then tap the map.</p>}
      <label className="fl-field-label" htmlFor="report-desc">What did you see?</label>
      <textarea
        id="report-desc"
        rows={3}
        maxLength={MAX}
        value={description}
        placeholder="e.g. Water above the kerb under the underpass; cars turning back."
        onChange={(e) => setDescription(e.target.value)}
        aria-describedby="report-count"
      />
      <span id="report-count" className="fl-muted fl-count">{trimmed.length}/{MAX} (min {MIN})</span>
      <div className="fl-row">
        <button type="submit" className="fl-btn fl-btn--primary" disabled={!valid || state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Submitting…' : 'Submit report'}
        </button>
        <button type="button" className="fl-btn fl-btn--ghost" onClick={props.onCancel}>Cancel</button>
      </div>
      <div aria-live="polite">
        {state.kind === 'done' && <p className="fl-success">{state.message}</p>}
        {state.kind === 'error' && <p className="fl-error" role="alert">{state.message}</p>}
      </div>
    </form>
  );
}
