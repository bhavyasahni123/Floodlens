import '@fontsource-variable/source-serif-4';

const STEPS = [
  {
    n: '01',
    title: 'Compare real routes',
    body: 'Fastest, Balanced and Lower Risk are chosen from the alternatives the routing service actually returns. Nothing is invented.',
  },
  {
    n: '02',
    title: 'Read the reason',
    body: 'Every route carries a score out of 100 and the main factor behind it, such as passing a known waterlogging underpass.',
  },
  {
    n: '03',
    title: 'Check the conditions',
    body: 'Official alerts, rainfall, river flow and community reports, each with its source and how fresh it is.',
  },
];

const SOURCES = [
  { name: 'OpenStreetMap & OSRM', role: 'Roads, routing and turn-by-turn directions' },
  { name: 'Open-Meteo', role: 'Modelled recent rainfall and hourly forecasts' },
  { name: 'NDMA SACHET', role: 'Official alerts from IMD and state authorities' },
  { name: 'Copernicus GloFAS', role: 'Modelled Yamuna river discharge' },
  { name: 'Community reports', role: 'Unverified, and removed from the map after three hours' },
];

function Mark() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M12 2.5c3.6 4.6 6.5 8.3 6.5 11.6A6.5 6.5 0 0 1 5.5 14C5.5 10.8 8.4 7.1 12 2.5Z" fill="currentColor" />
    </svg>
  );
}

/** Schematic only — deliberately not a real map, and labelled as such. */
function Illustration() {
  return (
    <figure className="fw-figure" aria-label="Illustration of two routes compared by flood risk. Not live data.">
      <svg viewBox="0 0 440 360" role="img" aria-hidden="true">
        <defs>
          <pattern id="fw-grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M40 0H0V40" fill="none" stroke="#ffffff" strokeOpacity="0.06" />
          </pattern>
        </defs>
        <rect width="440" height="360" fill="url(#fw-grid)" />
        {/* streets */}
        <g stroke="#ffffff" strokeOpacity="0.14" strokeWidth="1.5" fill="none">
          <path d="M0 250 C120 240 200 260 440 230" />
          <path d="M60 0 L110 360" />
          <path d="M0 120 C140 130 260 100 440 110" />
          <path d="M300 0 C290 120 310 240 280 360" />
        </g>
        {/* river */}
        <path d="M380 0 C340 80 400 150 360 220 C330 280 370 320 350 360" fill="none" stroke="#7aa7f0" strokeOpacity="0.55" strokeWidth="14" strokeLinecap="round" />
        {/* hotspot */}
        <circle cx="205" cy="168" r="30" fill="#f0a5a5" fillOpacity="0.16" stroke="#f0a5a5" strokeOpacity="0.7" strokeDasharray="3 4" />
        <circle cx="205" cy="168" r="3.5" fill="#f0a5a5" />
        {/* route A: direct, through the hotspot */}
        <path d="M90 300 C150 250 180 200 205 168 S260 90 320 60" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="3" strokeDasharray="1 7" strokeLinecap="round" />
        {/* route B: detour, selected */}
        <path d="M90 300 C70 220 120 150 170 110 S270 70 320 60" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" />
        <circle cx="90" cy="300" r="7" fill="#0f1e45" stroke="#ffffff" strokeWidth="2.5" />
        <circle cx="320" cy="60" r="7" fill="#ffffff" />
      </svg>
      <div className="fw-compare">
        <div className="fw-compare-row is-muted">
          <span className="fw-compare-id">A</span>
          <span>Fastest · 10 min</span>
          <span className="fw-level fw-level--high">High</span>
        </div>
        <div className="fw-compare-row">
          <span className="fw-compare-id">B</span>
          <span>Lower risk · 13 min</span>
          <span className="fw-level fw-level--mod">Moderate</span>
        </div>
        <p>Route A passes a historically waterlogging-prone underpass.</p>
      </div>
      <figcaption>Illustration — not live data</figcaption>
    </figure>
  );
}

export default function Welcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="fw">
      <header className="fw-nav">
        <span className="fw-wordmark">
          <span className="fw-mark"><Mark /></span>
          FloodLens
        </span>
        <nav aria-label="Home">
          <a href="#how">How it works</a>
          <a href="#sources">Sources</a>
          <button type="button" className="fw-nav-cta" onClick={onStart}>Open planner</button>
        </nav>
      </header>

      <main>
        <section className="fw-hero">
          <div className="fw-hero-copy">
            <p className="fw-kicker">Monsoon routing for Delhi</p>
            <h1>Know where the water gathers before you set out.</h1>
            <p className="fw-lead">
              FloodLens compares routes across Delhi by travel time and an explained flood-risk assessment, built from
              historical waterlogging hotspots, rainfall, official alerts and reports from people on the ground.
            </p>
            <div className="fw-actions">
              <button type="button" className="fw-cta" onClick={onStart}>
                Plan a Safer Route
              </button>
              <a className="fw-text-link" href="#how">How risk is assessed</a>
            </div>
            <p className="fw-meta">Free to use · No account needed · Delhi only</p>
          </div>
          <Illustration />
        </section>

        <section id="how" className="fw-section" aria-labelledby="how-h">
          <h2 id="how-h" className="fw-section-title">How it works</h2>
          <ol className="fw-steps">
            {STEPS.map((s) => (
              <li key={s.n}>
                <span className="fw-num" aria-hidden="true">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="fw-principle" aria-label="Our principle">
          <blockquote>
            A score is a guide, not a guarantee. Where data is missing, FloodLens says so and never treats it as safe.
          </blockquote>
        </section>

        <section id="sources" className="fw-section" aria-labelledby="sources-h">
          <h2 id="sources-h" className="fw-section-title">Where the information comes from</h2>
          <dl className="fw-sources">
            {SOURCES.map((s) => (
              <div key={s.name}>
                <dt>{s.name}</dt>
                <dd>{s.role}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="fw-closing">
          <h2>Planning a trip across the city?</h2>
          <button type="button" className="fw-cta fw-cta--light" onClick={onStart}>
            Plan a Safer Route
          </button>
        </section>
      </main>

      <footer className="fw-footer">
        <p>
          Risk assessments are informational estimates, not guarantees of safety. Follow official instructions and never
          enter flood water.
        </p>
        <p>Map data © OpenStreetMap contributors.</p>
      </footer>
    </div>
  );
}
