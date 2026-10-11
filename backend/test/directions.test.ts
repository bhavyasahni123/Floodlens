import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDirections, instructionFor, type OsrmStep } from '../src/directions';

const step = (type: string, extra: Partial<OsrmStep['maneuver']> = {}, name = 'Ring Road', more: Partial<OsrmStep> = {}): OsrmStep => ({
  distance: 120.4,
  duration: 30.6,
  name,
  maneuver: { type, location: [77.2, 28.6], ...extra },
  ...more,
});

describe('turn-by-turn instructions', () => {
  it('describes common OSRM maneuvers in plain English', () => {
    assert.equal(instructionFor(step('depart', { bearing_after: 0 }), false), 'Head north on Ring Road');
    assert.equal(instructionFor(step('turn', { modifier: 'left' }), false), 'Turn left onto Ring Road');
    assert.equal(instructionFor(step('turn', { modifier: 'uturn' }), false), 'Make a U-turn onto Ring Road');
    assert.equal(instructionFor(step('new name'), false), 'Continue onto Ring Road');
    assert.equal(instructionFor(step('fork', { modifier: 'slight right' }), false), 'Keep right at the fork onto Ring Road');
    assert.equal(instructionFor(step('roundabout', { exit: 2 }), false), 'At the roundabout, take the 2nd exit onto Ring Road');
    assert.equal(instructionFor(step('end of road', { modifier: 'right' }), false), 'At the end of the road, turn right onto Ring Road');
    assert.equal(instructionFor(step('arrive', { modifier: 'left' }, ''), true), 'Arrive at your destination on the left');
  });

  it('handles unnamed roads and refs', () => {
    assert.equal(instructionFor(step('turn', { modifier: 'right' }, ''), false), 'Turn right');
    assert.equal(instructionFor(step('turn', { modifier: 'right' }, 'Mathura Road', { ref: 'NH19' }), false), 'Turn right onto Mathura Road (NH19)');
  });

  it('attaches a hotspot warning to the step whose geometry passes it', () => {
    const steps: OsrmStep[] = [
      step('depart', { bearing_after: 90 }, 'A Road', { geometry: { coordinates: [[77.2, 28.6], [77.21, 28.6]] } }),
      step('turn', { modifier: 'left', location: [77.21, 28.6] }, 'B Road', { geometry: { coordinates: [[77.21, 28.6], [77.21, 28.62]] } }),
      step('arrive', { location: [77.21, 28.62] }, '', { geometry: { coordinates: [[77.21, 28.62], [77.21, 28.62]] } }),
    ];
    const out = buildDirections(steps, [{ name: 'Fixture Underpass', point: [28.61, 77.2101] }]);
    assert.deepEqual(out.map((s) => s.hazards), [[], ['Fixture Underpass'], []]);
    assert.deepEqual(out[1].location, [28.6, 77.21]);
    assert.equal(out[0].distanceM, 120);
  });

  it('returns no steps when the provider sends none (never invents directions)', () => {
    assert.deepEqual(buildDirections([]), []);
  });
});
