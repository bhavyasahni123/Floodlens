# FloodLens 
### Monsoon-aware route planning for Delhi

FloodLens is a Delhi-first route-planning prototype that compares available routes by estimated travel time, distance, and an explainable **heuristic waterlogging-risk score**. It brings together routing, modelled rainfall, modelled river discharge, public alerts, a historical-hotspot layer, and unverified community reports.

> **Safety note:** FloodLens scores are informational estimates—not flood probabilities or guarantees of road safety. The historical-hotspot dataset has unverified provenance, weather and river inputs are modelled, and the risk model has not been validated against real-world outcomes.

**Project status:** Runs locally. AWS deployment has not yet been configured or deployed.

## Contents
- [Features](#features)
- [How it works](#how-it-works)
- [Architecture](#architecture)
- [Technology stack](#technology-stack)
- [Data sources and limitations](#data-sources-and-limitations)
- [Risk methodology](#risk-methodology)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [API reference](#api-reference)
- [Testing](#testing)
- [AWS deployment status](#aws-deployment-status)
- [Limitations and roadmap](#limitations-and-roadmap)
- [Repository structure](#repository-structure)
- [Attribution](#attribution)

## Features

- **Route comparison:** Fastest, Balanced, and Lower Risk preferences, selected from actual routes returned by the routing provider. FloodLens does not fabricate alternatives.
- **Explainable risk estimates:** A 0–100 heuristic score, LOW/MODERATE/HIGH category, contributing factors, and a short reason.
- **Flexible location selection:** Place search, map click, draggable markers, and optional device location (only after the user explicitly requests it).
- **Directions and in-app navigation:** Turn-by-turn instructions, GPS progress, off-route detection and rerouting, spoken instructions, arrival detection, and a clearly labelled simulation mode.
- **Monsoon & Flood Risk mode:** Optional overlays, layer toggles, legend, source links, status, and retrieval timestamps.
- **Rainfall timeline:** Model-estimated recent rainfall is separated from forecast values. Missing hours remain blank instead of being shown as zero.
- **Alerts and river context:** Relevant NDMA SACHET alerts and modelled Yamuna discharge are displayed with caveats.
- **Community reports:** Guest submissions with location and description. Reports remain unverified, cluster under configured rules, and leave the active map after three hours while remaining in PostgreSQL.
- **Recent routes:** Browser-local history using `localStorage`, with a clear-history option.
- **Installable PWA:** Caches the app shell only; routes and live data still require network access.
- **Honest degraded states:** External data is labelled LIVE, STALE, or UNAVAILABLE. Missing data must not be interpreted as proof that conditions are safe.

## How it works

1. Select an origin and destination by search, map click, marker drag, or optional device location.
2. The backend requests route candidates from an external routing provider and removes near-duplicates.
3. FloodLens assesses route geometry against available hotspot, rainfall, alert, and community-report inputs. River discharge is displayed for context but is not currently scored.
4. The app presents Fastest, Balanced, and Lower Risk options from the routes actually returned.
5. Inspect the flood-intelligence panel for source status, timestamps, map layers, and limitations.
6. Follow directions or submit an unverified community report.

**Route preferences**
- **Fastest:** prioritises estimated duration.
- **Balanced:** minimises `durationMinutes + 0.15 × riskScore`.
- **Lower Risk:** chooses a lower-scoring candidate where one is available.

These preferences are decision support, not safety guarantees. If the routing provider returns fewer candidates than requested, the app shows fewer choices.

## Architecture

```text
Browser / PWA
React 19 · TypeScript · Vite · React-Leaflet · OpenStreetMap tiles
                         │ JSON over HTTP
                         ▼
Express 5 + TypeScript API
  ├─ Routing & directions ── OSRM services
  ├─ Place search ────────── Photon / Nominatim fallback
  ├─ Rainfall ────────────── Open-Meteo Forecast API
  ├─ River discharge ─────── Open-Meteo Flood API / GloFAS
  ├─ Official alerts ─────── NDMA SACHET CAP feed
  ├─ Risk assessment ─────── Rule-based heuristic
  ├─ Historical hotspots ─── Local GeoJSON
  └─ Community reports ──── PostgreSQL
```

External data sources use source-specific caching. A failed refresh can result in STALE or UNAVAILABLE status instead of incorrectly labelling old data as live. The backend uses dependency injection so automated tests can use labelled fixtures.

## Technology stack

| Area | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 8 |
| Maps | React-Leaflet 5, Leaflet, OpenStreetMap raster tiles |
| Backend | Node.js, Express 5, TypeScript |
| Database | PostgreSQL, `pg` |
| Local/test database tooling | `embedded-postgres` |
| Routing | OSRM public routing services |
| Geocoding | Photon, Nominatim fallback |
| Weather/hydrology | Open-Meteo Forecast API, Open-Meteo Flood API (GloFAS v4) |
| Official alerts | NDMA SACHET CAP JSON feed |
| Backend tests | Node.js built-in `node:test` |
| Browser journey tests | `playwright-core` driving installed Google Chrome |
| PWA | Web manifest and service worker |

The reviewed repository did **not** contain Docker, AWS SDK integration, infrastructure-as-code, or CI/CD configuration.

## Data sources and limitations

Source availability, endpoint behaviour, licensing, and public-service policies may change. Verify current terms before public or high-volume use.

| Source | Purpose | Important caveats |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/) | Base map and underlying map data | Attribution required; tile usage policy applies. |
| [OSRM public demo](https://router.project-osrm.org/) | Driving routes and alternatives | Public demo, no SLA. The reviewed endpoint ignored the foot profile, so it is used for driving only. |
| [FOSSGIS OSRM](https://routing.openstreetmap.de/) | Walking and cycling routes | Volunteer-run services with no SLA. Risk scoring is not validated for these modes. |
| [Photon](https://photon.komoot.io/) | Type-ahead place suggestions | Public service; fair-use/throttling limits apply. |
| [Nominatim](https://nominatim.org/) | Fallback geocoding | App throttles requests to at most one per second; used as fallback, not autocomplete. |
| [Open-Meteo Forecast](https://open-meteo.com/) | Model-estimated recent rainfall and forecast | **Not rain-gauge observations.** Five Delhi sample points; CC BY 4.0 attribution required. |
| [Open-Meteo Flood API](https://open-meteo.com/en/docs/flood-api) / GloFAS v4 | Modelled daily discharge for a selected Yamuna grid cell | **Not a measured river level** and not comparable directly with official gauge levels. Displayed, not scored. |
| [NDMA SACHET](https://sachet.ndma.gov.in/) | Public official alerts | App uses an undocumented JSON endpoint. Alert positions are represented by a centroid and approximate circle, not the original polygon. |
| Local hotspot GeoJSON | Historical susceptibility input | 22 manually curated locations. **Claimed PWD/Traffic Police attribution is unverified.** A geocode audit matched 7/22 names with offsets of 294–1,569 m; coordinates are approximate. |
| PostgreSQL community reports | User-submitted reports | Unverified; leave the active map after three hours but are retained in the database. |

**Investigated but not integrated:** CWC flood forecasting had no documented public API identified during review, so its web app was not scraped. The tested IMD nowcast endpoint returned HTTP 404.

### Data freshness

| Source | Cache TTL | Maximum stale age |
|---|---:|---:|
| Rainfall | 15 minutes | 2 hours |
| River discharge | 3 hours | 24 hours |
| Official alerts | 10 minutes | 1 hour |

STALE means a previous response is being shown after a refresh problem. UNAVAILABLE means usable data is not available. Neither status implies that roads are safe.

## Risk methodology

The implementation in `backend/src/risk.ts` and `backend/RISK_MODEL.md` is a **rule-based heuristic**. It is not machine learning, is not a calibrated flood probability, and has not been validated against observed outcomes.

| Input | Current rule |
|---|---|
| Base allowance | Adds 5 points because unmapped hazards may exist on any route. |
| Historical hotspots | Uses point-to-route-segment distance. Within a hotspot buffer, severity weights are HIGH = 55, MODERATE = 30, LOW = 12, scaled by proximity. Multiple hotspot contributions have diminishing returns; component capped at 65. |
| Rainfall | Uses the highest relevant recent three-hour estimate or next-three-hour forecast at sample points near route start, middle, and end. Rain intensity adjusts the historical-hotspot contribution, capped at 75. |
| Official alerts | Adds points for active, flood-relevant alerts whose approximate circle covers a route point. Flood/inundation/cloudburst alerts weigh more than rain/thunderstorm alerts; component capped at 25. |
| Community reports | Counts nearby clusters once, with corroboration based on distinct submitters. Community contribution capped at 20. Reports are unverified. |
| Missing data | Adds uncertainty points if rainfall or alert data is unavailable. A missing hotspot dataset results in `NOT_ASSESSED`. |

Score categories: **LOW** below 35, **MODERATE** from 35 to below 65, **HIGH** at 65 or above.

Key limitations: weights are expert judgement; hotspot provenance and coordinate accuracy are uncertain; rainfall comes from coarse models; alert areas are approximated as circles; river discharge is not scored; walking/cycling scores are not validated. A low score does not establish that a road is passable or safe.

Example outputs recorded on **11 October 2026 in dry conditions** (examples only, not validation):

| Trip | Distance | Score | Category |
|---|---:|---:|---|
| Connaught Place → India Gate | 4.19 km | 5 | LOW |
| Connaught Place → Laxmi Nagar | 6.96 km | 29 | LOW |
| Connaught Place → Kashmere Gate | 11.87 km | 58 | MODERATE |

## Local setup

### Prerequisites
- Node.js and npm
- PostgreSQL, either a system installation or the project's embedded local PostgreSQL helper

Commands below assume Windows PowerShell and this project path:
`C:\Users\bhavy\Desktop\Project\Flood_aws project`

### 1. Install dependencies

```powershell
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\backend"
npm install

cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\frontend"
npm install
```

### 2. Start the local database

In a dedicated terminal:

```powershell
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\backend"
npm run db:local
```

Use the `DATABASE_URL` printed by the command and keep the terminal open. Alternatively, use a system PostgreSQL database named `floodlens`.

### 3. Configure the backend

In another terminal:

```powershell
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\backend"
Copy-Item .env.example .env
notepad .env
```

Set `DATABASE_URL` to the connection string printed by `db:local` or your own PostgreSQL connection string. Set `REPORT_HASH_SECRET` to a long random value; **never use a development default in a public deployment**.

Example shape only—replace the placeholder:

```dotenv
DATABASE_URL=postgres://postgres:YOUR_LOCAL_PASSWORD@localhost:5433/floodlens
REPORT_HASH_SECRET=replace-with-a-long-random-value
```

Then optionally migrate (the server also applies the schema on startup when `DATABASE_URL` is configured):

```powershell
npm run db:migrate
```

### 4. Start the backend

```powershell
npm run dev
```

Expected local API URL: `http://localhost:5000`.

### 5. Start the frontend

In a third terminal:

```powershell
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\frontend"
npm run web
```

Open `http://localhost:5173`.

Without `DATABASE_URL`, the app can run, but community-report persistence is unavailable.

### Build and verification commands

```powershell
# Backend
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\backend"
npm run build
npm start

# Frontend
cd "C:\Users\bhavy\Desktop\Project\Flood_aws project\frontend"
npm run typecheck
npm run build
npm run e2e
```

The reviewed frontend `mobile` and `api` scripts reference workspaces that were not present; they may fail and are not part of the current setup.

## Environment variables

Use `backend/.env.example` as the configuration reference. Never commit `.env` files or real credentials.

| Variable | Purpose | Reviewed default/example |
|---|---|---|
| `PORT` | API port | `5000` |
| `CORS_ORIGINS` | Allowed browser origins | `http://localhost:5173,http://localhost:4173` |
| `DATABASE_URL` | PostgreSQL connection | Configure for your database |
| `REPORT_HASH_SECRET` | HMAC key for submitter hashing | Long random secret |
| `REPORT_EXPIRY_HOURS` | Active-map report expiry | `3` |
| `CLUSTER_RADIUS_METERS` | Report clustering radius | `100` |
| `CLUSTER_WINDOW_HOURS` | Clustering time window | `2` |
| `CLUSTER_MIN_REPORTS` | Minimum reports per cluster | `2` |
| `REPORT_RATE_LIMIT` | Report submissions per IP per window | `5` |
| `REPORT_RATE_WINDOW_MINUTES` | Report rate-limit window | `10` |
| `OSRM_DRIVING_URL`, `OSRM_WALKING_URL`, `OSRM_CYCLING_URL` | Routing provider overrides | Public endpoints |
| `NOMINATIM_URL`, `PHOTON_URL` | Geocoding provider overrides | Public endpoints |
| `OPEN_METEO_FORECAST_URL`, `OPEN_METEO_FLOOD_URL` | Weather/hydrology provider overrides | Public endpoints |
| `SACHET_ALERTS_URL` | Alert feed override | Public endpoint |
| `HTTP_USER_AGENT` | External-request User-Agent | Configure an identifying value |
| `HOTSPOTS_PATH` | Hotspot dataset override | Optional |
| `LOCAL_PG_PORT`, `LOCAL_PG_PASSWORD` | Embedded local PostgreSQL settings | `5433` / local-only value |
| `TEST_DATABASE_URL` | Optional existing DB for tests | Optional |
| `E2E_PORT`, `E2E_VERBOSE`, `E2E_HEADED` | Browser test runner settings | Optional |
| `VITE_API_URL` | Frontend API base URL | `http://localhost:5000` |

Do not put secrets in `VITE_*` variables; they are exposed in the browser build. For public deployment, set the API URL and CORS origins explicitly.

## API reference

Local base URL: `http://localhost:5000`.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/health` | API status, database connectivity, hotspot availability |
| `GET` | `/api/hazards` | Historical hotspot GeoJSON and provenance metadata |
| `GET` | `/api/geocode?q=...` | Place suggestions; query length 3–200 characters |
| `POST` | `/api/routes` | Route candidates, risk assessments, directions, preferences, recommendation |
| `GET` | `/api/rainfall` | Rainfall data and source status |
| `GET` | `/api/river` | Modelled river discharge and source status |
| `GET` | `/api/alerts` | Alert data and source status |
| `GET` | `/api/intelligence` | Combined data for the flood panel |
| `GET` | `/api/risk-model` | Current model version and weights |
| `GET` | `/api/reports` | Active reports, clusters, and policy |
| `POST` | `/api/reports` | Submit an unverified community report |

### Example route request

```http
POST /api/routes
Content-Type: application/json
```

```json
{
  "origin": {
    "lat": 28.6315,
    "lon": 77.2167,
    "label": "Connaught Place"
  },
  "destination": {
    "lat": 28.6675,
    "lon": 77.2283,
    "label": "Kashmere Gate"
  },
  "travelMode": "driving",
  "mode": "Balanced"
}
```

A successful response includes assessment time, route request, coordinates, provider, coverage, available candidates, preference picks, selected route, notes, and recommendation. Each candidate includes route geometry, distance, duration, risk assessment, directions, and preference metadata. Legacy selected-route fields are also returned.

Common errors: `400` invalid input, `404` route/place not found, `413` body too large, `429` rate limit exceeded, `502` external provider failure, and `503` report database unavailable.

### Community reports

```json
{
  "lat": 28.6315,
  "lon": 77.2167,
  "description": "Waterlogging reported near the junction",
  "locationLabel": "Optional place label"
}
```

The API validates the location against the configured Delhi area and requires a 5–500 character description. The server assigns the timestamp. Reports expire from the active map after three hours but are retained in PostgreSQL.

## Testing

The build summary reported these results. Re-run them against the current checkout before relying on them.

**Run during the repository review**
- Backend TypeScript check (`npx tsc --noEmit`): passed.
- Frontend TypeScript check (`tsc --noEmit -p apps/web/src/tsconfig.json`): passed.
- Backend tests excluding the PostgreSQL suite: **66/66 passed**.

**Reported from an earlier development session**
- `npm test`: **79/79 passed**, including 13 tests against embedded PostgreSQL 18.4.
- Backend and frontend production builds: passed.
- `npm run e2e`: **21/21 browser journey steps passed** in installed Google Chrome at desktop and mobile viewport sizes.

The E2E server uses labelled fixture providers and is test-only. External services can still fail in real use. The current ESLint configuration covers `.js`/`.jsx`; TypeScript is type-checked but not linted by that configuration, and no frontend unit-test suite was present in the review.

## AWS deployment status

**AWS deployment is  implemented.** At the time of the repository review, there was no Dockerfile, infrastructure-as-code, deploy/teardown scripts, CI/CD, AWS SDK integration, or Amazon Location provider code. AWS CLI v2 was installed and configured for `ap-south-1`, but `aws sts get-caller-identity` returned `NoCredentials`. No AWS resources were deployed.

Possible future architecture:
- **Amazon S3 + CloudFront:** static frontend and HTTPS.
- **Amazon EC2** or a suitable managed compute service: backend API.
- **Amazon RDS for PostgreSQL:** persistent community reports.
- **AWS Secrets Manager:** database credentials and report hash secret.
- **IAM roles + Systems Manager:** access without SSH keys.
- **Amazon CloudWatch:** logs, metrics, alarms.
- **AWS Budgets:** cost notifications.
- **AWS CloudFormation:** repeatable provisioning and teardown.
- **EventBridge Scheduler:** time-limited demo cleanup, if appropriate.

These are recommendations only. AWS services can incur charges while idle. Verify current pricing and credit eligibility, and configure billing alerts before provisioning; budget alerts are notifications, not hard spending caps.


## Attribution

- © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), under the Open Database License (ODbL).
- [Open-Meteo](https://open-meteo.com/), with attribution under CC BY 4.0.
- [Copernicus Emergency Management Service / GloFAS](https://global-flood.emergency.copernicus.eu/) for modelled discharge data.
- [NDMA SACHET](https://sachet.ndma.gov.in/) for public alert information.
- Public OSRM and geocoding services, subject to their usage policies.

FloodLens is a prototype and is not affiliated with or endorsed by these providers. Confirm current attribution, licensing, and usage policies before release.

---

*Built as a Delhi-first prototype for monsoon-aware route planning. Contributions that improve data provenance, validation, reliability, and responsible deployment are especially welcome.*
