# FloodLens route risk model — `floodlens-heuristic-v2`

A transparent, rule-based score from **0 to 100** for each candidate route. Implemented in
`src/risk.ts`; the weights are served live at `GET /api/risk-model`.

> **What it is not.** It is not a probability of flooding, has not been statistically validated,
> and does not estimate water depth. No machine-learning model is used: no labelled Delhi
> flood-incident dataset was available to train or evaluate one. Same inputs → same score.

## Inputs

| Input | Source | Nature | Used how |
|---|---|---|---|
| Historical hotspots | `data/delhi_waterlogging_hotspots.json` (22 records) | Historical susceptibility; **approximate, unverified compilation** | Main term |
| Rainfall intensity | Open-Meteo (5 Delhi sample points) | Modelled estimate (past 3 h) + forecast (next 3 h) | Multiplier + small additive term |
| Official alerts | NDMA SACHET CAP feed | Official | Additive term |
| Community reports | PostgreSQL, active (≤ 3 h) only | User-submitted, unverified | Capped additive term |
| River discharge | Open-Meteo Flood API (GloFAS) | Modelled, not a gauge | **Not used in the score** — displayed only, because it is not a measured level and has no validated link to street waterlogging |

## Calculation

1. **Base: 5 points.** Unmapped hazards can exist on any route, so no score is ever 0.
2. **Historical susceptibility.** For each hotspot, the minimum distance `d` to the route is computed
   **against every route segment** (point-to-segment distance in a local equirectangular projection), not
   only against vertices. If `d ≤ buffer` (the record's `bufferRadiusMeters`, default 200 m):
   `contribution = W[severity] × (1 − 0.5 × d / buffer)`, with `W = HIGH 55, MODERATE 30, LOW 12`
   (a direct pass counts in full; the buffer edge counts half).
   Contributions are sorted, then combined with diminishing returns: `c1 + 0.5·c2 + 0.25·Σ(rest)`, capped at **65**.
3. **Rainfall.** The worst intensity at the sample points nearest the route's start, middle and end. Intensity
   is the peak hourly rate over the past 3 h (estimate) and next 3 h (forecast):
   `NONE < 0.5 ≤ LIGHT < 2.5 ≤ MODERATE < 7.6 ≤ HEAVY` mm/h.
   The historical term is multiplied by `1 / 1.15 / 1.4 / 1.75` (capped at **75**), and `0 / 3 / 8 / 15` points are added.
4. **Official alerts.** For each active (`effectiveEnd` in the future), flood-relevant alert whose equal-area circle
   (around the published centroid) contains a route point: a flood/inundation/cloudburst alert adds **20**, and a
   rain/thunderstorm alert adds **10**. Only the strongest counts in full; each additional alert adds 5. Capped at **25**.
5. **Community reports** (active only, i.e. submitted ≤ 3 h ago):
   - A corroborated cluster (≥ 2 reports within 100 m and 2 h) whose centroid is ≤ 150 m from the route adds **12, once per cluster**,
     regardless of how many reports it contains — **only if** its reports come from ≥ 2 distinct submitters.
   - A cluster without established independence (one submitter, or unknown) counts as a single report.
   - Each unclustered report ≤ 100 m from the route adds 4; single reports are capped at **8** in total.
   - All community points are capped at **20**. A cluster is never treated as an official alert.
6. **Missing data never lowers the score.**
   - Rainfall unavailable → no rain assumption is made, and **+3** uncertainty points are added.
   - Stale rainfall → never treated as lighter than LIGHT.
   - Alerts unavailable → **+2** uncertainty points.
   - The hotspot dataset unavailable → **no score** (`NOT_ASSESSED`), because it cannot be computed responsibly.
7. **Total** = sum, rounded, clamped to 0–100.

**Categories:** `LOW < 35 ≤ MODERATE < 65 ≤ HIGH`.

## Route preferences

- **Fastest** — the minimum estimated duration (ties broken by score, then route id).
- **Lower Risk** — the minimum score (ties broken by duration). Labelled "lower assessed risk among available routes", never "safe".
- **Balanced** — the minimum of `minutes + 0.15 × score`, i.e. 10 risk points saved is worth up to 1.5 extra minutes
  (the weighting from the original FloodLens code, kept).
- A lower-risk alternative is recommended when its score is ≥ 10 points lower than the selected route's.
- Alternatives that overlap ≥ 90 % in both directions (30 m tolerance) with lengths within 5 % are treated as duplicates and removed.
  Fewer than three distinct routes are reported as such; none are invented.

## Short reason

The card reason names the largest non-base factor using actual computed values. For example:
"Passes 61 m from Tilak Bridge Underpass, a historically waterlogging-prone railway bridge underpass (moderate susceptibility)."
When nothing is found, it says so and adds: "This does not mean it is flood-free."

## Travel modes

Walking and cycling routes get an explicit note: the hotspot data describes road waterlogging for vehicles, and
pedestrians and cyclists face different hazards (shallower water, open drains, currents). The score is not validated for these modes.

## Change from v1 (original code)

v1 used vertex-only distance and step rules (any HIGH hotspot → 55 + 18 per HIGH, i.e. category HIGH). v2 weights each
hotspot by its actual segment distance and current rainfall. On 2026-10-11 (dry conditions), the original sample routes
scored: CP → India Gate 5 LOW (v1 5 LOW), CP → Laxmi Nagar 29 LOW (v1 40 MODERATE), CP → Kashmere Gate 58 MODERATE (v1 73 HIGH).
Under moderate rain, the same routes rise (for example, Kashmere Gate exceeds 65 → HIGH).

## Known weaknesses

- Hotspot coordinates and severities are unverified (see the dataset's `metadata.provenance`); a geocode audit matched only 7 of 22 names, with offsets of 294–1,569 m.
- Rainfall is a model estimate on a coarse grid, not gauge observations, so local cloudbursts can be missed.
- Alert coverage uses an equal-area circle, not the official polygon.
- Weights are expert judgement, not fitted to outcomes.
