import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CAD_PLAN_TOOLS, CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

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

test('cad_validate_plan schema presents Simple Intent first and isolates compatibility formats', () => {
  const tool = CAD_PLAN_TOOLS.find((candidate) => candidate.name === 'cad_validate_plan');
  const planSchema = tool.inputSchema.properties.plan;
  assert.equal(planSchema.oneOf.length, 3);
  const [simple, feature, legacy] = planSchema.oneOf;
  assert.equal(simple.title, 'Preferred Simple Intent Plan');
  assert.deepEqual(simple.required, ['shape']);
  assert.equal(simple.additionalProperties, false);
  assert.equal(Object.hasOwn(simple.properties, 'features'), false);
  assert.equal(Object.hasOwn(simple.properties, 'base'), false);
  assert.equal(Object.hasOwn(simple.properties.holes.properties, 'placement'), false);
  assert.equal(Object.hasOwn(simple.properties.holes.properties, 'count'), false);
  assert.equal(feature.title, 'Advanced Feature Plan (compatibility)');
  assert.deepEqual(feature.required, ['features']);
  assert.equal(legacy.title, 'Legacy Plan (compatibility)');
  assert.deepEqual(legacy.required, ['base']);
  assert.match(tool.description, /Only include features explicitly requested by the user/);
  assert.match(tool.description, /Do not mix formats/);
});

test('all seven preferred Simple Intent happy paths validate on the first call', async () => {
  const profile = [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]];
  const candidates = [
    { shape: 'plate', size: [100, 60, 10], unit: 'mm' },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, centers: [[10, 10], [50, 30], [90, 50]] } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] } },
    { shape: 'profile', profile, thickness: 10, unit: 'mm' },
    { shape: 'profile', profile, thickness: 10, unit: 'mm', holes: { diameter: 6, centers: [[20, 20], [40, 60], [80, 20]] } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', fillet: { radius: 5, edges: 'all_vertical' } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', chamfer: { size: 0.5, edges: 'all_top_outer' } },
  ];
  for (const candidate of candidates) {
    const { result, bridge } = await validate(candidate);
    assert.equal(result.status, 'valid', JSON.stringify(result));
    assert.equal(result.can_execute, true);
    assert.ok(result.resolved_plan);
    assert.equal(bridge.calls, 0);
  }
});

test('Simple Intent rejects Feature Plan hole fields with precise paths', async () => {
  for (const [field, value] of [['placement', { type: 'explicit', centers: [{ x: 20, y: 20 }] }], ['count', 1]]) {
    const { result } = await validate({
      shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, centers: [[20, 20]], [field]: value },
    });
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_SIMPLE_FIELD' && issue.path === `holes.${field}`));
  }
});

test('mixed Simple, Feature, and Legacy formats return MIXED_PLAN_FORMAT only', async () => {
  const mixedPlans = [
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', features: [{ type: 'rectangular_pad', width: 100, height: 60, length: 10 }] },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', base },
    { unit: 'mm', features: [{ type: 'rectangular_pad', width: 100, height: 60, length: 10 }], base },
  ];
  for (const mixed of mixedPlans) {
    const { result } = await validate(mixed);
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    assert.deepEqual(result.issues.map((issue) => issue.code), ['MIXED_PLAN_FORMAT']);
    assert.equal(result.issues.some((issue) => issue.code === 'INVALID_FEATURE_ORDER'), false);
  }
});

test('operation-only incomplete Simple Intent reports missing shape instead of Feature Plan errors', async () => {
  const { result } = await validate({ unit: 'mm', holes: { diameter: 6, centers: [[20, 20]] } });
  assert.equal(result.status, 'incomplete');
  assert.ok(result.issues.some((issue) => issue.code === 'MISSING_REQUIRED_VALUE' && issue.path === 'shape'));
  assert.equal(result.issues.some((issue) => issue.code === 'INVALID_FEATURE_ORDER'), false);
});

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

function profileHolePlan(centers, diameter = 6) {
  return {
    unit: 'mm', features: [
      { id: 'base', type: 'profile_pad', points: lProfile, length: 10 },
      { id: 'holes', type: 'hole_pattern', diameter, placement: { type: 'explicit', centers }, operation: 'through_all' },
    ],
  };
}

test('profile_pad accepts explicit holes and Simple Intent resolves identically', async () => {
  const feature = (await validate(profileHolePlan([[20, 20], [40, 60], [80, 20]]))).result;
  const simple = (await validate({ shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', holes: { diameter: 6, centers: [[20, 20], [40, 60], [80, 20]] } })).result;
  assert.equal(feature.status, 'valid');
  assert.equal(feature.can_execute, true);
  assert.deepEqual(feature.resolved_plan.features[1], {
    id: 'holes', type: 'hole_pattern', diameter: 6,
    centers: [{ x: 20, y: 20 }, { x: 40, y: 60 }, { x: 80, y: 20 }], operation: 'through_all', after: 'base',
  });
  assert.deepEqual(simple.resolved_plan, feature.resolved_plan);
});

for (const [name, centers, code, expectedDetails] of [
  ['center in bounding-box cutout', [[80, 60]], 'PROFILE_HOLE_OUTSIDE_MATERIAL', { holeIndex: 0, center: { x: 80, y: 60 }, radius: 3 }],
  ['circle intersects outer boundary', [[2, 20]], 'PROFILE_HOLE_INTERSECTS_BOUNDARY', { holeIndex: 0, minimumBoundaryDistance: 2, radius: 3 }],
  ['circle touches outer boundary', [[3, 20]], 'PROFILE_HOLE_INTERSECTS_BOUNDARY', { holeIndex: 0, minimumBoundaryDistance: 3, radius: 3 }],
  ['circle crosses concave corner', [[58, 38]], 'PROFILE_HOLE_INTERSECTS_BOUNDARY', { holeIndex: 0, radius: 3 }],
  ['center lies exactly on concave corner', [[60, 40]], 'PROFILE_HOLE_INTERSECTS_BOUNDARY', { holeIndex: 0, minimumBoundaryDistance: 0, radius: 3 }],
  ['holes overlap', [[20, 20], [25, 20]], 'HOLES_OVERLAP', { firstHoleIndex: 0, secondHoleIndex: 1, centerDistance: 5 }],
]) {
  test(`profile hole validation rejects ${name}`, async () => {
    const { result, bridge } = await validate(profileHolePlan(centers));
    assert.equal(result.status, 'invalid');
    assert.equal(result.can_execute, false);
    const issue = result.issues.find((candidate) => candidate.code === code);
    assert.ok(issue, code);
    assert.equal(bridge.calls, 0);
    for (const [key, expected] of Object.entries(expectedDetails)) assert.deepEqual(issue.details[key], expected);
  });
}

test('profile_pad non-explicit placement, non-through operation, fillet, and chamfer remain explicitly unsupported', async () => {
  const plans = [
    {
      unit: 'mm', features: [
        { type: 'profile_pad', points: lProfile, length: 10 },
        { type: 'hole_pattern', diameter: 6, placement: { type: 'rectangular_grid', origin: { x: 20, y: 20 }, columns: 2, rows: 1, spacing_x: 20, spacing_y: 20 } },
      ],
    },
    {
      unit: 'mm', features: [
        { type: 'profile_pad', points: lProfile, length: 10 },
        { type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [[20, 20]] }, operation: 'length' },
      ],
    },
    { shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', holes: { diameter: 6, edge_offset: 10, reference: 'center' } },
    { shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', fillet: { radius: 2, edges: 'all_vertical' } },
    { shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm', chamfer: { size: 1, edges: 'all_top_outer' } },
  ];
  for (const planValue of plans) {
    const { result, bridge } = await validate(planValue);
    assert.equal(result.status, 'unsupported');
    assert.equal(result.can_execute, false);
    assert.ok(result.issues.some((issue) => ['PROFILE_PAD_HOLE_PLACEMENT_UNSUPPORTED', 'UNSUPPORTED_HOLE_OPERATION', 'PROFILE_PAD_FINISHING_UNSUPPORTED'].includes(issue.code)));
    assert.equal(bridge.calls, 0);
  }
});
