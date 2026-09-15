import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

const base = {
  type: 'rectangular_plate', width: 100, height: 60, thickness: 10, unit: 'mm',
};

function holes(reference) {
  return {
    count: 4,
    diameter: 8,
    placement: { type: 'edge_offset', distance: 10, reference },
  };
}

async function validate(plan) {
  const bridge = {
    calls: 0,
    async run() {
      this.calls += 1;
      throw new Error('cad_validate_plan must never call FreeCAD');
    },
  };
  const gate = new CadPlanValidationGate();
  const response = await handleHighLevelCadTool('cad_validate_plan', { plan }, bridge, gate);
  return { result: JSON.parse(response.content[0].text), bridge, gate };
}

test('ambiguous distance reference returns A/B clarification and deterministic SVG without mutation', async () => {
  const first = await validate({ base, holes: holes(null) });
  const second = await validate({ base, holes: holes(null) });
  assert.equal(first.result.status, 'ambiguous');
  assert.equal(first.result.can_execute, false);
  assert.equal(first.bridge.calls, 0);
  const issue = first.result.issues.find((item) => item.code === 'AMBIGUOUS_DISTANCE_REFERENCE');
  assert.equal(issue.path, 'holes.placement.reference');
  assert.deepEqual(issue.options.map((option) => [option.id, option.value]), [
    ['A', 'center'], ['B', 'boundary'],
  ]);
  assert.equal(first.result.clarification_visual.type, 'svg');
  assert.match(first.result.clarification_visual.content, /^<svg/);
  assert.match(first.result.clarification_visual.content, />A</);
  assert.match(first.result.clarification_visual.content, />B</);
  assert.match(first.result.clarification_visual.content, /10 mm/);
  assert.equal(first.result.clarification_visual.content, second.result.clarification_visual.content);
});

test('center reference resolves the four requested hole centers', async () => {
  const { result, bridge } = await validate({ base, holes: holes('center') });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.equal(bridge.calls, 0);
  assert.deepEqual(result.resolved_plan.features.find((feature) => feature.type === 'hole_pattern').centers, [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 },
  ]);
});

test('boundary reference includes the hole radius in the center offset', async () => {
  const { result } = await validate({ base, holes: holes('boundary') });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.deepEqual(result.resolved_plan.features.find((feature) => feature.type === 'hole_pattern').centers, [
    { x: 14, y: 14 }, { x: 86, y: 14 }, { x: 14, y: 46 }, { x: 86, y: 46 },
  ]);
});

test('invalid dimensions and geometrically impossible holes are rejected', async () => {
  const invalidPlate = await validate({ base: { ...base, width: -100 } });
  assert.equal(invalidPlate.result.status, 'invalid');
  assert.equal(invalidPlate.result.can_execute, false);
  assert.ok(invalidPlate.result.issues.some((issue) => issue.path === 'base.width'));

  const impossible = await validate({
    base: { ...base, width: 20, height: 20 },
    holes: { ...holes('center'), placement: { type: 'edge_offset', distance: 2, reference: 'center' } },
  });
  assert.equal(impossible.result.status, 'invalid');
  assert.equal(impossible.result.can_execute, false);
  assert.ok(impossible.result.issues.some((issue) => issue.code === 'HOLE_OUTSIDE_BASE'));
});

test('missing thickness is incomplete', async () => {
  const { result } = await validate({ base: { ...base, thickness: null } });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.can_execute, false);
  assert.ok(result.issues.some((issue) => issue.path === 'base.thickness'));
});

test('unknown plan elements and unsupported features are reported as unsupported', async () => {
  const { result } = await validate({ base, shell: { thickness: 2 } });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.can_execute, false);
  assert.ok(result.issues.some((issue) => issue.code === 'UNSUPPORTED_PLAN_ELEMENT' && issue.path === 'shell'));
});

test('fillet and chamfer plan dimensions are validated deterministically', async () => {
  const valid = await validate({
    base,
    fillet: { radius: 5, edges: 'all_vertical' },
    chamfer: { size: 0.5, edges: 'all_top_inner' },
  });
  assert.equal(valid.result.status, 'valid');
  assert.equal(valid.result.can_execute, true);

  const invalid = await validate({ base, fillet: { radius: 0, edges: 'all_vertical' } });
  assert.equal(invalid.result.status, 'invalid');
  assert.equal(invalid.result.can_execute, false);
});

test('ordered feature plan resolves hole placement to concrete centers', async () => {
  const { result } = await validate({
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'mounting_holes', type: 'hole_pattern', diameter: 8, count: 4, placement: { type: 'edge_offset', distance: 10, reference: 'center' }, after: 'base' },
    ],
  });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.deepEqual(result.resolved_plan, {
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'mounting_holes', type: 'hole_pattern', diameter: 8, centers: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 }], operation: 'through_all', after: 'base' },
    ],
  });
  const resolvedHole = result.resolved_plan.features[1];
  assert.equal(Object.hasOwn(resolvedHole, 'placement'), false);
  assert.equal(Object.hasOwn(resolvedHole, 'distance'), false);
  assert.equal(Object.hasOwn(resolvedHole, 'reference'), false);
});

test('feature plan preserves ambiguity handling and SVG clarification', async () => {
  const { result, bridge } = await validate({
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'holes', type: 'hole_pattern', diameter: 8, count: 4, placement: { type: 'edge_offset', distance: 10, reference: null } },
    ],
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.can_execute, false);
  assert.ok(result.issues.some((issue) => issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE' && issue.path === 'features.1.placement.reference'));
  assert.equal(result.clarification_visual.type, 'svg');
  assert.equal(bridge.calls, 0);
});

test('feature IDs are unique and construction order requires rectangular_pad first', async () => {
  const duplicate = await validate({
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'base', type: 'fillet', radius: 5, edges: 'all_vertical' },
    ],
  });
  assert.equal(duplicate.result.status, 'invalid');
  assert.ok(duplicate.result.issues.some((issue) => issue.code === 'DUPLICATE_FEATURE_ID'));

  const order = await validate({
    unit: 'mm',
    features: [
      { id: 'rounding', type: 'fillet', radius: 5, edges: 'all_vertical' },
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
    ],
  });
  assert.equal(order.result.status, 'invalid');
  assert.ok(order.result.issues.some((issue) => issue.code === 'INVALID_FEATURE_ORDER'));
});

function featureHolePlan(placement, options = {}) {
  return {
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'holes', type: 'hole_pattern', diameter: 6, placement, ...options },
    ],
  };
}

test('explicit placement resolves arbitrary finite centers without placement metadata', async () => {
  const centers = [{ x: 10, y: 10 }, { x: 50, y: 30 }, { x: 85, y: 45 }];
  const { result } = await validate(featureHolePlan({ type: 'explicit', centers }));
  assert.equal(result.status, 'valid');
  const resolved = result.resolved_plan.features[1];
  assert.deepEqual(resolved.centers, centers);
  assert.equal(resolved.diameter, 6);
  assert.equal(resolved.operation, 'through_all');
  assert.equal(Object.hasOwn(resolved, 'placement'), false);
});

test('rectangular_grid resolves row-major centers without placement metadata', async () => {
  const { result } = await validate(featureHolePlan({
    type: 'rectangular_grid', origin: { x: 20, y: 15 }, columns: 3, rows: 2, spacing_x: 30, spacing_y: 20,
  }));
  assert.equal(result.status, 'valid');
  const resolved = result.resolved_plan.features[1];
  assert.deepEqual(resolved.centers, [
    { x: 20, y: 15 }, { x: 50, y: 15 }, { x: 80, y: 15 },
    { x: 20, y: 35 }, { x: 50, y: 35 }, { x: 80, y: 35 },
  ]);
  assert.equal(Object.hasOwn(resolved, 'placement'), false);
});

test('hole geometry rejects outside, overlapping, touching, and count-mismatched patterns', async () => {
  const cases = [
    [featureHolePlan({ type: 'explicit', centers: [{ x: 2, y: 20 }] }, { diameter: 8 }), 'HOLE_OUTSIDE_BASE'],
    [featureHolePlan({ type: 'explicit', centers: [{ x: 20, y: 20 }, { x: 27, y: 20 }] }, { diameter: 8 }), 'HOLES_OVERLAP'],
    [featureHolePlan({ type: 'explicit', centers: [{ x: 20, y: 20 }, { x: 28, y: 20 }] }, { diameter: 8 }), 'HOLES_OVERLAP'],
    [featureHolePlan({ type: 'explicit', centers: [{ x: 10, y: 10 }, { x: 50, y: 30 }, { x: 85, y: 45 }] }, { count: 4 }), 'HOLE_COUNT_MISMATCH'],
    [featureHolePlan({ type: 'rectangular_grid', origin: { x: 20, y: 15 }, columns: 4, rows: 2, spacing_x: 30, spacing_y: 20 }), 'HOLE_OUTSIDE_BASE'],
  ];
  for (const [candidate, code] of cases) {
    const { result, bridge } = await validate(candidate);
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === code), code);
    assert.equal(bridge.calls, 0);
  }
});

test('hole placement numeric fields reject empty arrays, non-finite coordinates, and invalid grids', async () => {
  const cases = [
    featureHolePlan({ type: 'explicit', centers: [] }),
    featureHolePlan({ type: 'explicit', centers: [{ x: Number.NaN, y: 10 }] }),
    featureHolePlan({ type: 'rectangular_grid', origin: { x: 10, y: 10 }, columns: 0, rows: 2, spacing_x: 20, spacing_y: 20 }),
    featureHolePlan({ type: 'rectangular_grid', origin: { x: 10, y: 10 }, columns: 2, rows: 2, spacing_x: 0, spacing_y: 20 }),
  ];
  for (const candidate of cases) {
    const { result } = await validate(candidate);
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
  }
});

test('minimal feature inputs derive IDs, dependencies, and counts server-side', async () => {
  const grid = await validate({
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 6, placement: { type: 'rectangular_grid', origin: { x: 20, y: 15 }, columns: 3, rows: 2, spacing_x: 30, spacing_y: 20 } },
    ],
  });
  assert.equal(grid.result.status, 'valid');
  assert.equal(grid.result.can_execute, true);
  assert.equal(grid.result.resolved_plan.features[0].id, 'base');
  assert.equal(grid.result.resolved_plan.features[1].id, 'holes');
  assert.equal(grid.result.resolved_plan.features[1].after, 'base');
  assert.equal(grid.result.resolved_plan.features[1].centers.length, 6);

  const explicitCenters = [{ x: 10, y: 10 }, { x: 50, y: 30 }, { x: 85, y: 45 }];
  const explicit = await validate({
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: explicitCenters } },
    ],
  });
  assert.equal(explicit.result.status, 'valid');
  assert.deepEqual(explicit.result.resolved_plan.features[1], { id: 'holes', type: 'hole_pattern', diameter: 6, centers: explicitCenters, operation: 'through_all', after: 'base' });

  const edgeOffset = await validate({
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 8, placement: { type: 'edge_offset', distance: 10, reference: 'center' } },
    ],
  });
  assert.equal(edgeOffset.result.status, 'valid');
  assert.equal(edgeOffset.result.resolved_plan.features[1].centers.length, 4);
});

test('explicit IDs are preserved and an invented incomplete feature is never discarded', async () => {
  const explicit = await validate({
    unit: 'mm',
    features: [
      { id: 'plate_core', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'mounting_pattern', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [{ x: 20, y: 20 }] } },
    ],
  });
  assert.equal(explicit.result.status, 'valid');
  assert.deepEqual(explicit.result.resolved_plan.features.map((feature) => feature.id), ['plate_core', 'mounting_pattern']);
  assert.equal(explicit.result.resolved_plan.features[1].after, 'plate_core');

  const invented = await validate({
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [{ x: 20, y: 20 }] } },
      { type: 'chamfer' },
    ],
  });
  assert.equal(invented.result.status, 'incomplete');
  assert.equal(invented.result.can_execute, false);
  assert.ok(invented.result.issues.some((issue) => issue.path.endsWith('.size')));
  assert.ok(invented.result.issues.some((issue) => issue.path.endsWith('.edges')));
});

test('simple plate intent resolves to one canonical rectangular pad', async () => {
  const { result, bridge } = await validate({ shape: 'plate', size: [100, 60, 10], unit: 'mm' });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.equal(bridge.calls, 0);
  assert.deepEqual(result.resolved_plan, {
    unit: 'mm',
    features: [{ id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 }],
  });
});

test('simple explicit holes resolve three centers', async () => {
  const centers = [[10, 10], [50, 30], [85, 45]];
  const { result } = await validate({ shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, centers } });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.resolved_plan.features[1], {
    id: 'holes', type: 'hole_pattern', diameter: 6,
    centers: centers.map(([x, y]) => ({ x, y })), operation: 'through_all', after: 'base',
  });
});

test('simple rectangular grid resolves six row-major centers', async () => {
  const simple = { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] } };
  const feature = {
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 6, placement: { type: 'rectangular_grid', columns: 3, rows: 2, origin: { x: 20, y: 15 }, spacing_x: 30, spacing_y: 20 } },
    ],
  };
  const simpleResult = (await validate(simple)).result;
  const featureResult = (await validate(feature)).result;
  assert.equal(simpleResult.status, 'valid');
  assert.deepEqual(simpleResult.resolved_plan.features[1].centers, [
    { x: 20, y: 15 }, { x: 50, y: 15 }, { x: 80, y: 15 },
    { x: 20, y: 35 }, { x: 50, y: 35 }, { x: 80, y: 35 },
  ]);
  assert.deepEqual(simpleResult.resolved_plan, featureResult.resolved_plan);
});

test('simple edge offset preserves resolved and ambiguous reference semantics', async () => {
  const center = (await validate({ shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 8, edge_offset: 10, reference: 'center' } })).result;
  assert.equal(center.status, 'valid');
  assert.deepEqual(center.resolved_plan.features[1].centers, [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 },
  ]);

  const ambiguous = (await validate({ shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 8, edge_offset: 10, reference: null } })).result;
  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.can_execute, false);
  assert.ok(ambiguous.issues.some((issue) => issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE' && issue.path === 'holes.placement.reference'));
  assert.equal(ambiguous.clarification_visual.type, 'svg');
  assert.deepEqual(ambiguous.issues.find((issue) => issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE').options.map((option) => option.id), ['A', 'B']);
});

test('simple hole placement forms are mutually exclusive', async () => {
  const combinations = [
    { grid: [2, 2], start: [10, 10], spacing: [30, 20], centers: [[10, 10]] },
    { grid: [2, 2], start: [10, 10], spacing: [30, 20], edge_offset: 10, reference: 'center' },
    { centers: [[10, 10]], edge_offset: 10, reference: 'center' },
  ];
  for (const placement of combinations) {
    const { result, bridge } = await validate({ shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, ...placement } });
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === 'CONFLICTING_HOLE_PLACEMENT'));
    assert.equal(bridge.calls, 0);
  }
});

test('simple intent rejects malformed arrays and unknown fields', async () => {
  const candidates = [
    { shape: 'plate', size: [100, 60], unit: 'mm' },
    { shape: 'plate', size: [100, -60, 10], unit: 'mm' },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, grid: [3, 0], start: [20, 15], spacing: [30, 20] } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, grid: [3, 2], start: [20], spacing: [30, 20] } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', invented: true },
  ];
  for (const candidate of candidates) {
    const { result } = await validate(candidate);
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
  }
});

const lProfile = [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]];

test('simple polygon profile normalizes to canonical profile_pad', async () => {
  const { result, bridge } = await validate({ shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm' });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.equal(bridge.calls, 0);
  assert.deepEqual(result.resolved_plan, {
    unit: 'mm', features: [{ id: 'base', type: 'profile_pad', points: lProfile, length: 10 }],
  });
  const featureResult = (await validate({ unit: 'mm', features: [{ type: 'profile_pad', points: lProfile, length: 10 }] })).result;
  assert.equal(featureResult.status, 'valid');
  assert.deepEqual(featureResult.resolved_plan, result.resolved_plan);
});

test('clockwise and counter-clockwise profiles produce the same resolved plan', async () => {
  const clockwise = [lProfile[0], ...lProfile.slice(1).reverse()];
  const ccwResult = (await validate({ shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm' })).result;
  const cwResult = (await validate({ shape: 'profile', profile: clockwise, thickness: 10, unit: 'mm' })).result;
  assert.deepEqual(cwResult.resolved_plan, ccwResult.resolved_plan);
});

test('explicit polygon closure is removed from the resolved plan', async () => {
  const { result } = await validate({ shape: 'profile', profile: [...lProfile, lProfile[0]], thickness: 10, unit: 'mm' });
  assert.equal(result.status, 'valid');
  assert.deepEqual(result.resolved_plan.features[0].points, lProfile);
  assert.equal(result.resolved_plan.features[0].points.length, 6);
});

for (const [name, profile, code] of [
  ['self-intersecting bow-tie', [[0, 0], [100, 100], [0, 100], [100, 0]], 'PROFILE_SELF_INTERSECTION'],
  ['zero-area collinear profile', [[0, 0], [50, 0], [100, 0]], 'PROFILE_ZERO_AREA'],
  ['consecutive duplicate point', [[0, 0], [100, 0], [100, 0], [0, 80]], 'PROFILE_DUPLICATE_POINT'],
  ['too few vertices', [[0, 0], [100, 0]], 'PROFILE_TOO_FEW_POINTS'],
]) {
  test(`${name} is rejected before FreeCAD execution`, async () => {
    const { result, bridge } = await validate({ shape: 'profile', profile, thickness: 10, unit: 'mm' });
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === code));
    assert.equal(bridge.calls, 0);
  });
}

test('profile_pad followed by hole_pattern or finishing is explicitly unsupported', async () => {
  const plans = [
    {
      unit: 'mm', features: [
        { type: 'profile_pad', points: lProfile, length: 10 },
        { type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [{ x: 20, y: 20 }] } },
      ],
    },
    { shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', fillet: { radius: 2, edges: 'all_vertical' } },
    { shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', chamfer: { size: 1, edges: 'all_top_outer' } },
  ];
  for (const planValue of plans) {
    const { result, bridge } = await validate(planValue);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === 'PROFILE_PAD_HOLE_PATTERN_UNSUPPORTED' || issue.code === 'PROFILE_PAD_FINISHING_UNSUPPORTED'));
    assert.equal(bridge.calls, 0);
  }
});
