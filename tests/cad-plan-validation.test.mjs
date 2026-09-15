import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';

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
  const response = await handleHighLevelCadTool('cad_validate_plan', { plan }, bridge);
  return { result: JSON.parse(response.content[0].text), bridge };
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
  assert.deepEqual(result.resolved_plan.holes.centers, [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 },
  ]);
});

test('boundary reference includes the hole radius in the center offset', async () => {
  const { result } = await validate({ base, holes: holes('boundary') });
  assert.equal(result.status, 'valid');
  assert.equal(result.can_execute, true);
  assert.deepEqual(result.resolved_plan.holes.centers, [
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
  assert.ok(impossible.result.issues.some((issue) => issue.code === 'HOLE_OUTSIDE_PLATE'));
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
