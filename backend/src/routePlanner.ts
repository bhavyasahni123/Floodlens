import type { LatLon } from './geo';
import type { RiskAssessment } from './risk';

export type Preference = 'Fastest' | 'Balanced' | 'Lower Risk';
export const PREFERENCES: Preference[] = ['Fastest', 'Balanced', 'Lower Risk'];

/**
 * Balanced cost = minutes + BALANCED_MINUTES_PER_POINT × risk score.
 * 0.15 means every 10 risk points saved is worth up to 1.5 extra minutes
 * (unchanged from the original FloodLens weighting).
 */
export const BALANCED_MINUTES_PER_POINT = 0.15;
/** Minimum score gap before a lower-risk alternative is recommended. */
export const RECOMMEND_SCORE_GAP = 10;

export type Candidate = {
  id: string;
  route: LatLon[];
  distanceKm: number;
  durationMinutes: number;
  risk: RiskAssessment;
};

export type PreferencePicks = { fastest: string; balanced: string | null; lowerRisk: string | null };

const scoreOf = (c: Candidate) => (c.risk.status === 'ASSESSED' ? c.risk.score : null);

export function pickPreferences(candidates: Candidate[]): PreferencePicks {
  if (candidates.length === 0) throw new Error('No candidates to choose from.');
  const byId = (a: Candidate, b: Candidate) => a.id.localeCompare(b.id);
  const fastest = [...candidates].sort(
    (a, b) => a.durationMinutes - b.durationMinutes || (scoreOf(a) ?? 0) - (scoreOf(b) ?? 0) || byId(a, b),
  )[0];
  const assessed = candidates.filter((c) => scoreOf(c) !== null);
  // Without risk scores we cannot honestly rank by risk.
  if (assessed.length === 0) return { fastest: fastest.id, balanced: null, lowerRisk: null };
  const lowerRisk = [...assessed].sort(
    (a, b) => scoreOf(a)! - scoreOf(b)! || a.durationMinutes - b.durationMinutes || byId(a, b),
  )[0];
  const cost = (c: Candidate) => c.durationMinutes + BALANCED_MINUTES_PER_POINT * scoreOf(c)!;
  const balanced = [...assessed].sort((a, b) => cost(a) - cost(b) || byId(a, b))[0];
  return { fastest: fastest.id, balanced: balanced.id, lowerRisk: lowerRisk.id };
}

export function preferenceNotes(candidates: Candidate[], picks: PreferencePicks): string[] {
  const notes: string[] = [];
  if (candidates.length === 1) {
    notes.push('The routing service returned only one distinct route, so all three preferences show the same route.');
  } else if (candidates.length === 2) {
    notes.push('The routing service returned two distinct routes; some preferences share a route.');
  }
  if (picks.lowerRisk === null) {
    notes.push('Risk could not be assessed, so Balanced and Lower Risk cannot be determined.');
  } else if (candidates.length > 1 && picks.fastest === picks.lowerRisk) {
    notes.push('The fastest route also has the lowest assessed risk among the available routes.');
  }
  return notes;
}

export function recommendation(candidates: Candidate[], picks: PreferencePicks, selectedId: string) {
  if (!picks.lowerRisk || picks.lowerRisk === selectedId) return null;
  const selected = candidates.find((c) => c.id === selectedId);
  const safer = candidates.find((c) => c.id === picks.lowerRisk);
  if (!selected || !safer) return null;
  const a = scoreOf(selected);
  const b = scoreOf(safer);
  if (a === null || b === null || a - b < RECOMMEND_SCORE_GAP) return null;
  const extra = safer.durationMinutes - selected.durationMinutes;
  return {
    routeId: safer.id,
    message: `Route ${safer.id} has lower assessed risk among available routes (${b} vs ${a})${
      extra > 0 ? `, about ${extra} min longer` : ''
    }.`,
  };
}
