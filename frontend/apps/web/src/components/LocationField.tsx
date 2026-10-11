import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, searchPlaces } from '../api';
import type { Place, PlaceSuggestion } from '../types';

type Props = {
  label: string;
  marker: string;
  tone: 'origin' | 'destination' | 'report';
  text: string;
  onTextChange: (text: string) => void;
  onSelect: (place: Place) => void;
  onClear: () => void;
  picking: boolean;
  onTogglePick: () => void;
  onUseMyLocation?: () => void;
  locating?: boolean;
};

const MIN_CHARS = 3;
const DEBOUNCE_MS = 450;

export default function LocationField(props: Props) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PlaceSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'empty'>('idle');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Only search when the user is typing, never for programmatic text changes.
    if (!dirty) return;
    const q = props.text.trim();
    if (q.length < MIN_CHARS) {
      setResults([]);
      setStatus('idle');
      return;
    }
    const timer = window.setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStatus('loading');
      try {
        const data = await searchPlaces(q, controller.signal);
        setResults(data.results);
        setActive(data.results.length ? 0 : -1);
        setStatus(data.results.length ? 'idle' : 'empty');
        setOpen(true);
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setResults([]);
        setStatus('error');
        setError(e instanceof ApiError ? e.message : 'Place search failed.');
        setOpen(true);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [props.text, dirty]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function choose(s: PlaceSuggestion) {
    props.onSelect({ lat: s.lat, lon: s.lon, label: [s.label, s.detail].filter(Boolean).join(', ') });
    setDirty(false);
    setOpen(false);
    setResults([]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % results.length);
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  const listId = `${id}-list`;
  return (
    <div className="fl-field">
      <label htmlFor={`${id}-input`} className="fl-field-label">
        <span className={`fl-dot fl-dot--${props.tone}`} aria-hidden="true">
          {props.marker}
        </span>
        {props.label}
      </label>
      <div className="fl-field-row">
        <div className="fl-combobox">
          <input
            id={`${id}-input`}
            role="combobox"
            aria-expanded={open && results.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${id}-opt-${active}` : undefined}
            autoComplete="off"
            placeholder="Search a place in Delhi"
            value={props.text}
            onChange={(e) => {
              setDirty(true);
              props.onTextChange(e.target.value);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => results.length > 0 && setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          />
          {props.text && (
            <button type="button" className="fl-icon-btn fl-clear" aria-label={`Clear ${props.label.toLowerCase()}`} onClick={props.onClear}>
              ×
            </button>
          )}
          {open && (results.length > 0 || status === 'error' || status === 'empty') && (
            <ul id={listId} role="listbox" className="fl-suggestions">
              {status === 'error' && <li className="fl-suggestion-msg" role="alert">{error} You can also pick the point on the map.</li>}
              {status === 'empty' && <li className="fl-suggestion-msg">No places found. Try another name or pick on the map.</li>}
              {results.map((s, i) => (
                <li
                  key={`${s.lat},${s.lon},${i}`}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'is-active' : ''}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(s);
                  }}
                  onMouseEnter={() => setActive(i)}
                >
                  <strong>{s.label}</strong>
                  {s.detail && <small>{s.detail}</small>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className={`fl-icon-btn fl-pick ${props.picking ? 'is-on' : ''}`}
          aria-pressed={props.picking}
          aria-label={`Pick ${props.label.toLowerCase()} on the map`}
          title="Pick on map"
          onClick={props.onTogglePick}
        >
          ⌖
        </button>
      </div>
      <div className="fl-field-foot" aria-live="polite">
        {status === 'loading' && <span className="fl-muted">Searching…</span>}
        {props.onUseMyLocation && (
          <button type="button" className="fl-link-btn" onClick={props.onUseMyLocation} disabled={props.locating}>
            {props.locating ? 'Locating…' : '◎ Use my location'}
          </button>
        )}
      </div>
    </div>
  );
}
