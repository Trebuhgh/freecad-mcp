import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProfileSegments } from '../dist/tools/cad-profile-geometry.js';
import { validateCadPlan } from '../dist/tools/cad-plan-validation.js';

function roundedSegments(direction = 'ccw') {
  return [
    { type: 'line', start: [0, 0], end: [80, 0] },
    { type: 'arc', start: [80, 0], end: [80, 40], center: [80, 20], direction },
    { type: 'line', start: [80, 40], end: [0, 40] },
    { type: 'line', start: [0, 40], end: [0, 0] },
  ];
}

function segmentPlan(segments, additions = {}) {
  return { shape: 'profile', segments, thickness: 10, unit: 'mm', ...additions };
}

test('mixed line and CCW arc profile validates with analytic area and bounds', () => {
  const geometry = validateProfileSegments(roundedSegments('ccw'), 'segments');
  assert.deepEqual(geometry.issues, []);
  assert.equal(geometry.lineCount, 3);
  assert.equal(geometry.arcCount, 1);
  assert.ok(Math.abs(geometry.area - (3200 + 200 * Math.PI)) <= 1e-9);
  assert.deepEqual(geometry.bounds, { minX: 0, minY: 0, maxX: 100, maxY: 40 });

  const result = validateCadPlan(segmentPlan(roundedSegments('ccw')));
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.deepEqual(result.resolved_plan.features[0], {
    id: 'base', type: 'profile_pad', length: 10,
    segments: [
      { type: 'line', start: { x: 0, y: 0 }, end: { x: 80, y: 0 } },
      { type: 'arc', start: { x: 80, y: 0 }, end: { x: 80, y: 40 }, center: { x: 80, y: 20 }, direction: 'ccw' },
      { type: 'line', start: { x: 80, y: 40 }, end: { x: 0, y: 40 } },
      { type: 'line', start: { x: 0, y: 40 }, end: { x: 0, y: 0 } },
    ],
  });
});

test('CW arc semantics are preserved and produce the complementary analytic area', () => {
  const geometry = validateProfileSegments(roundedSegments('cw'), 'segments');
  assert.deepEqual(geometry.issues, []);
  assert.ok(Math.abs(geometry.area - (3200 - 200 * Math.PI)) <= 1e-9);
  assert.deepEqual(geometry.bounds, { minX: 0, minY: 0, maxX: 80, maxY: 40 });
  const result = validateCadPlan(segmentPlan(roundedSegments('cw')));
  assert.equal(result.status, 'valid');
  assert.equal(result.resolved_plan.features[0].segments[1].direction, 'cw');
});

for (const [name, segments, code] of [
  ['radius mismatch', [
    { type: 'arc', start: [0, 0], end: [10, 0], center: [4, 0], direction: 'ccw' },
    { type: 'line', start: [10, 0], end: [0, 0] },
  ], 'ARC_RADIUS_MISMATCH'],
  ['zero radius', [
    { type: 'arc', start: [0, 0], end: [10, 0], center: [0, 0], direction: 'ccw' },
    { type: 'line', start: [10, 0], end: [0, 0] },
  ], 'ARC_ZERO_RADIUS'],
  ['degenerate arc', [
    { type: 'arc', start: [0, 0], end: [0, 0], center: [0, 5], direction: 'ccw' },
    { type: 'line', start: [0, 0], end: [10, 0] },
  ], 'ARC_DEGENERATE'],
  ['invalid direction', [
    { type: 'arc', start: [0, 0], end: [10, 0], center: [5, 0], direction: 'auto' },
    { type: 'line', start: [10, 0], end: [0, 0] },
  ], 'ARC_INVALID_DIRECTION'],
  ['segment gap', [
    { type: 'line', start: [0, 0], end: [10, 0] },
    { type: 'line', start: [11, 0], end: [0, 10] },
    { type: 'line', start: [0, 10], end: [0, 0] },
  ], 'PROFILE_SEGMENT_GAP'],
]) {
  test(`${name} is rejected before execution`, () => {
    const result = validateCadPlan(segmentPlan(segments));
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === code), JSON.stringify(result));
  });
}

for (const [name, segments] of [
  ['line-line', [
    { type: 'line', start: [0, 0], end: [10, 10] },
    { type: 'line', start: [10, 10], end: [0, 10] },
    { type: 'line', start: [0, 10], end: [10, 0] },
    { type: 'line', start: [10, 0], end: [0, 0] },
  ]],
  ['line-arc', [
    { type: 'line', start: [0, 0], end: [10, 0] },
    { type: 'arc', start: [10, 0], end: [10, 10], center: [10, 5], direction: 'ccw' },
    { type: 'line', start: [10, 10], end: [15, 5] },
    { type: 'line', start: [15, 5], end: [0, 10] },
    { type: 'line', start: [0, 10], end: [0, 0] },
  ]],
  ['arc-arc', [
    { type: 'arc', start: [0, 0], end: [10, 0], center: [5, 0], direction: 'ccw' },
    { type: 'arc', start: [10, 0], end: [0, 0], center: [5, 0], direction: 'cw' },
  ]],
]) {
  test(`${name} self intersection is rejected analytically`, () => {
    const result = validateCadPlan(segmentPlan(segments));
    assert.equal(result.status, 'invalid');
    assert.ok(result.issues.some((issue) => issue.code === 'PROFILE_SEGMENT_SELF_INTERSECTION'), JSON.stringify(result));
  });
}

test('profile and segments cannot be mixed', () => {
  const result = validateCadPlan({ ...segmentPlan(roundedSegments()), profile: [[0, 0], [10, 0], [0, 10]] });
  assert.equal(result.status, 'invalid');
  assert.ok(result.issues.some((issue) => issue.code === 'MIXED_PROFILE_REPRESENTATION'));
});

test('arc profile with holes remains deterministically unsupported', () => {
  const result = validateCadPlan(segmentPlan(roundedSegments(), { holes: { diameter: 6, centers: [[20, 20]] } }));
  assert.equal(result.status, 'unsupported');
  assert.equal(result.can_execute, false);
  assert.ok(result.issues.some((issue) => issue.code === 'ARC_PROFILE_HOLES_UNSUPPORTED'));
});
