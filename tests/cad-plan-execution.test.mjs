import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

const freecadPython = process.env.FREECAD_PYTHON || 'C:\\Program Files\\FreeCAD 1.1\\bin\\python.exe';
const base = { type: 'rectangular_plate', width: 100, height: 60, thickness: 10, unit: 'mm' };

function plan(reference, operations = {}) {
  return {
    base,
    holes: {
      count: 4, diameter: 8,
      placement: { type: 'edge_offset', distance: 10, reference },
    },
    ...operations,
  };
}

class CapturingBridge {
  calls = 0;
  commands = [];
  response;

  constructor(response = { content: [{ type: 'text', text: '{}' }] }) {
    this.response = response;
  }

  async run(code) {
    this.calls += 1;
    this.commands.push(code);
    return this.response;
  }
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function executeFreeCad(code, allowFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), 'freecad-plan-execution-'));
  const scriptPath = join(directory, 'execution.py');
  const outputPath = join(directory, 'result.json');
  const indented = code.split('\n').map((line) => `    ${line}`).join('\n');
  const script = `
import json
import FreeCAD
import Part
_mcp_result = {"success": True}
try:
${indented}
    result = {"ok": True, "result": _mcp_result["result"], "openDocuments": list(FreeCAD.listDocuments().keys())}
except Exception as error:
    import traceback
    result = {"ok": False, "error": str(error), "traceback": traceback.format_exc(), "openDocuments": list(FreeCAD.listDocuments().keys())}
    ${allowFailure ? 'pass' : 'raise'}
finally:
    with open(${JSON.stringify(outputPath)}, "w", encoding="utf-8") as output:
        json.dump(result, output)
`;
  writeFileSync(scriptPath, script, 'utf8');
  try {
    execFileSync(freecadPython, [scriptPath], { stdio: 'pipe', timeout: 30000 });
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function validateAndCapture(planValue, documentName) {
  const gate = new CadPlanValidationGate();
  const bridge = new CapturingBridge();
  const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: planValue }, bridge, gate);
  assert.equal(payload(validation).status, 'valid');
  const execution = await handleHighLevelCadTool('cad_execute_plan', { documentName }, bridge, gate);
  assert.equal(execution.isError, undefined);
  assert.equal(bridge.calls, 1);
  return { gate, bridge, validation: payload(validation) };
}

test('cad_execute_plan is blocked in fresh and ambiguous sessions without mutation', async () => {
  for (const ambiguous of [false, true]) {
    const gate = new CadPlanValidationGate();
    const bridge = new CapturingBridge();
    if (ambiguous) {
      const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: plan(null) }, bridge, gate);
      assert.equal(payload(validation).status, 'ambiguous');
    }
    const execution = await handleHighLevelCadTool('cad_execute_plan', {}, bridge, gate);
    assert.equal(payload(execution).code, 'CAD_PLAN_NOT_VALIDATED');
    assert.equal(bridge.calls, 0);
  }
});

for (const [reference, expectedCenters] of [
  ['center', [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 10, y: 50 }, { x: 90, y: 50 }]],
  ['boundary', [{ x: 14, y: 14 }, { x: 86, y: 14 }, { x: 14, y: 46 }, { x: 86, y: 46 }]],
]) {
  test(`cad_execute_plan constructs the exact ${reference} hole variant`, async () => {
    const { bridge, validation } = await validateAndCapture(plan(reference), `Execute_${reference}`);
    assert.deepEqual(validation.resolved_plan.holes.centers, expectedCenters);
    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    const result = execution.result;
    assert.equal(result.success, true);
    assert.equal(result.valid, true);
    assert.equal(result.solidCount, 1);
    assert.equal(result.plan_revision, 1);
    assert.deepEqual(result.verification.verifiedHoleCenters, expectedCenters);
    assert.equal(result.verification.expectedHoleCount, 4);
    assert.deepEqual(result.verification.recomputeErrors, []);
    assert.ok(result.executed_steps.includes('pocket_through_all'));
    assert.ok(Math.abs(result.boundingBox.xLength - 100) < 1e-7);
    assert.ok(Math.abs(result.boundingBox.yLength - 60) < 1e-7);
    assert.ok(Math.abs(result.boundingBox.zLength - 10) < 1e-7);
  });
}

test('cad_execute_plan uses only validated fillet and chamfer parameters', async () => {
  const planned = plan('center', {
    fillet: { radius: 5, edges: 'all_vertical' },
    chamfer: { size: 0.5, edges: 'all_top_inner' },
  });
  const { bridge, validation } = await validateAndCapture(planned, 'ExecuteFeatures');
  assert.deepEqual(validation.resolved_plan.fillet, planned.fillet);
  assert.deepEqual(validation.resolved_plan.chamfer, planned.chamfer);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.deepEqual(execution.result.executed_steps.slice(-2), ['fillet', 'chamfer']);
  assert.equal(execution.result.verification.bodyTip, 'Chamfer');
  assert.equal(execution.result.solidCount, 1);
});

test('execution failure reports its step and removes the partial document', async () => {
  const gate = new CadPlanValidationGate();
  const failingBridge = new CapturingBridge({
    content: [{ type: 'text', text: 'FreeCAD error: CAD_EXECUTE_PLAN_FAILED|pocket|simulated failure' }],
    isError: true,
  });
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, failingBridge, gate);
  const structured = await handleHighLevelCadTool('cad_execute_plan', {}, failingBridge, gate);
  assert.deepEqual(payload(structured), {
    success: false, code: 'CAD_PLAN_EXECUTION_FAILED', failed_step: 'pocket', error: 'simulated failure',
  });

  const oversized = await validateAndCapture(plan('center', {
    fillet: { radius: 1000, edges: 'all_vertical' },
  }), 'ExecuteCleanup');
  const execution = executeFreeCad(oversized.bridge.commands[0], true);
  assert.equal(execution.ok, false);
  assert.match(execution.error, /CAD_EXECUTE_PLAN_FAILED\|fillet\|/);
  assert.equal(execution.openDocuments.includes('ExecuteCleanup'), false);
});

test('execution binds to the latest plan revision and serializes validation races', async () => {
  const gate = new CadPlanValidationGate();
  const bridge = new CapturingBridge();
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, bridge, gate);
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('boundary') }, bridge, gate);
  await handleHighLevelCadTool('cad_execute_plan', { documentName: 'LatestRevision' }, bridge, gate);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.result.plan_revision, 2);
  assert.deepEqual(execution.result.verification.verifiedHoleCenters, [
    { x: 14, y: 14 }, { x: 86, y: 14 }, { x: 14, y: 46 }, { x: 86, y: 46 },
  ]);

  let release;
  const delayed = new CapturingBridge();
  delayed.run = async (code) => {
    delayed.calls += 1;
    delayed.commands.push(code);
    await new Promise((resolve) => { release = resolve; });
    return { content: [{ type: 'text', text: '{}' }] };
  };
  const lockedGate = new CadPlanValidationGate();
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, delayed, lockedGate);
  const running = handleHighLevelCadTool('cad_execute_plan', {}, delayed, lockedGate);
  await assert.rejects(
    handleHighLevelCadTool('cad_validate_plan', { plan: plan('boundary') }, delayed, lockedGate),
    /CAD_PLAN_EXECUTION_IN_PROGRESS/,
  );
  release();
  await running;
});
