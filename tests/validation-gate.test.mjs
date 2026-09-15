import assert from 'node:assert/strict';
import test from 'node:test';

import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

const validPlan = {
  base: { type: 'rectangular_plate', width: 100, height: 60, thickness: 10, unit: 'mm' },
  holes: {
    count: 4,
    diameter: 8,
    placement: { type: 'edge_offset', distance: 10, reference: 'center' },
  },
};

const ambiguousPlan = {
  ...validPlan,
  holes: {
    ...validPlan.holes,
    placement: { ...validPlan.holes.placement, reference: null },
  },
};

class GateBridge {
  calls = 0;
  commands = [];

  async run(code) {
    this.calls += 1;
    this.commands.push(code);
    return { content: [{ type: 'text', text: JSON.stringify({ accepted: true }) }] };
  }
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('fresh session blocks cad_create_part without calling FreeCAD', async () => {
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  const response = await handleHighLevelCadTool('cad_create_part', { name: 'Blocked' }, bridge, gate);
  assert.equal(response.isError, true);
  assert.deepEqual(payload(response), {
    success: false,
    code: 'CAD_PLAN_NOT_VALIDATED',
    message: 'CAD construction is blocked until cad_validate_plan returns status=valid and can_execute=true.',
  });
  assert.equal(gate.state, 'unvalidated');
  assert.equal(bridge.calls, 0);
});

test('fresh session blocks every mutating High-Level CAD tool', async () => {
  const mutatingTools = [
    'cad_create_part', 'cad_create_sketch', 'cad_sketch_rectangle', 'cad_pad',
    'cad_create_hole_sketch', 'cad_pocket', 'cad_fillet', 'cad_chamfer',
    'cad_execute_plan',
  ];
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  for (const tool of mutatingTools) {
    const response = await handleHighLevelCadTool(tool, {}, bridge, gate);
    assert.equal(payload(response).code, 'CAD_PLAN_NOT_VALIDATED', tool);
  }
  assert.equal(bridge.calls, 0);
});

test('ambiguous validation blocks subsequent mutations without FreeCAD calls', async () => {
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: ambiguousPlan }, bridge, gate);
  assert.equal(payload(validation).status, 'ambiguous');
  assert.equal(payload(validation).can_execute, false);
  assert.equal(gate.state, 'blocked');
  assert.equal(gate.validationResult.status, 'ambiguous');

  const mutation = await handleHighLevelCadTool('cad_create_part', { name: 'StillBlocked' }, bridge, gate);
  assert.equal(payload(mutation).code, 'CAD_PLAN_NOT_VALIDATED');
  assert.equal(bridge.calls, 0);
});

test('valid plan stores resolved plan and permits mutation', async () => {
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: validPlan }, bridge, gate);
  assert.equal(payload(validation).status, 'valid');
  assert.equal(payload(validation).can_execute, true);
  assert.equal(gate.state, 'validated');
  assert.deepEqual(gate.resolvedPlan.features.find((feature) => feature.type === 'hole_pattern').centers, [
    { x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 },
  ]);

  const mutation = await handleHighLevelCadTool('cad_create_part', { name: 'Allowed' }, bridge, gate);
  assert.equal(mutation.isError, undefined);
  assert.equal(bridge.calls, 1);
});

test('mutation racing an unfinished validation remains blocked', async () => {
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  const validationPromise = handleHighLevelCadTool('cad_validate_plan', { plan: validPlan }, bridge, gate);
  const mutationPromise = handleHighLevelCadTool('cad_create_part', { name: 'RaceBlocked' }, bridge, gate);
  const [validation, mutation] = await Promise.all([validationPromise, mutationPromise]);
  assert.equal(payload(validation).status, 'valid');
  assert.equal(payload(mutation).code, 'CAD_PLAN_NOT_VALIDATED');
  assert.equal(bridge.calls, 0);
  assert.equal(gate.state, 'validated');
});

test('a later invalid validation revokes earlier authorization', async () => {
  const bridge = new GateBridge();
  const gate = new CadPlanValidationGate();
  await handleHighLevelCadTool('cad_validate_plan', { plan: validPlan }, bridge, gate);
  assert.equal(gate.state, 'validated');

  const invalid = await handleHighLevelCadTool('cad_validate_plan', {
    plan: { ...validPlan, base: { ...validPlan.base, width: -100 } },
  }, bridge, gate);
  assert.equal(payload(invalid).status, 'invalid');
  assert.equal(gate.state, 'blocked');
  assert.equal(gate.resolvedPlan, undefined);

  const mutation = await handleHighLevelCadTool('cad_create_part', { name: 'Revoked' }, bridge, gate);
  assert.equal(payload(mutation).code, 'CAD_PLAN_NOT_VALIDATED');
  assert.equal(bridge.calls, 0);
});
