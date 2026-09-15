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

function featurePlan(reference, includeFinishing = false) {
  const features = [
    { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
    { id: 'mounting_holes', type: 'hole_pattern', diameter: 8, count: 4, placement: { type: 'edge_offset', distance: 10, reference }, after: 'base' },
  ];
  if (includeFinishing) {
    features.push(
      { id: 'outer_rounding', type: 'fillet', radius: 5, edges: 'all_vertical', target: 'mounting_holes' },
      { id: 'hole_chamfers', type: 'chamfer', size: 0.5, edges: 'all_top_inner', after: 'outer_rounding' },
    );
  }
  return { unit: 'mm', features };
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
    result = {"ok": True, "result": _mcp_result["result"], "openDocuments": list(FreeCAD.listDocuments().keys()), "documents": {name: [obj.Name for obj in doc.Objects] for name, doc in FreeCAD.listDocuments().items()}}
except Exception as error:
    import traceback
    result = {"ok": False, "error": str(error), "traceback": traceback.format_exc(), "openDocuments": list(FreeCAD.listDocuments().keys()), "documents": {name: [obj.Name for obj in doc.Objects] for name, doc in FreeCAD.listDocuments().items()}}
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
    assert.deepEqual(validation.resolved_plan.features.find((feature) => feature.type === 'hole_pattern').centers, expectedCenters);
    assert.doesNotMatch(bridge.commands[0], /edge_offset|"reference"|"distance"/);
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
    assert.ok(result.executed_steps.includes('holes'));
    assert.equal(result.features.find((feature) => feature.id === 'holes').verified_holes, 4);
    assert.ok(Math.abs(result.boundingBox.xLength - 100) < 1e-7);
    assert.ok(Math.abs(result.boundingBox.yLength - 60) < 1e-7);
    assert.ok(Math.abs(result.boundingBox.zLength - 10) < 1e-7);
  });
}

test('cad_execute_plan uses only validated fillet and chamfer parameters', async () => {
  const planned = featurePlan('center', true);
  const { bridge, validation } = await validateAndCapture(planned, 'ExecuteFeatures');
  assert.deepEqual(validation.resolved_plan.features.find((feature) => feature.type === 'fillet'), planned.features[2]);
  assert.deepEqual(validation.resolved_plan.features.find((feature) => feature.type === 'chamfer'), planned.features[3]);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.deepEqual(execution.result.executed_steps, ['base', 'mounting_holes', 'outer_rounding', 'hole_chamfers']);
  assert.equal(execution.result.features.at(-1).id, 'hole_chamfers');
  assert.equal(execution.result.solidCount, 1);
});

test('execution failure reports its step and removes the partial document', async () => {
  const gate = new CadPlanValidationGate();
  const failingBridge = new CapturingBridge({
    content: [{ type: 'text', text: 'FreeCAD error: CAD_EXECUTE_PLAN_FAILED|mounting_holes|hole_pattern|pocket|simulated failure' }],
    isError: true,
  });
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, failingBridge, gate);
  const structured = await handleHighLevelCadTool('cad_execute_plan', {}, failingBridge, gate);
  assert.deepEqual(payload(structured), {
    success: false, code: 'CAD_PLAN_EXECUTION_FAILED', failed_feature: 'mounting_holes', failed_feature_type: 'hole_pattern', failed_step: 'pocket', error: 'simulated failure',
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

test('automatic document naming selects the smallest free positive CADPlan number', async () => {
  const scenarios = [
    [[], 'CADPlan_1'],
    [['CADPlan_1', 'CADPlan_2'], 'CADPlan_3'],
    [['CADPlan_1', 'CADPlan_3'], 'CADPlan_2'],
  ];
  for (const [existing, expected] of scenarios) {
    const { bridge } = await validateAndCapture(plan('center'), undefined);
    const prelude = existing.map((name) => `FreeCAD.newDocument(${JSON.stringify(name)})`).join('\n');
    const execution = executeFreeCad(`${prelude}\n${bridge.commands[0]}`);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.document, expected);
    assert.ok(execution.openDocuments.includes(expected));
  }
});

test('explicit document names are strict and existing documents remain untouched', async () => {
  const conflict = await validateAndCapture(plan('center'), 'Motorhalter');
  const failed = executeFreeCad(`
existing = FreeCAD.newDocument("Motorhalter")
existing.addObject("App::FeaturePython", "ExistingMarker")
${conflict.bridge.commands[0]}`, true);
  assert.equal(failed.ok, false);
  assert.match(failed.error, /CAD_DOCUMENT_ALREADY_EXISTS\|Motorhalter/);
  assert.deepEqual(failed.documents.Motorhalter, ['ExistingMarker']);

  const structuredGate = new CadPlanValidationGate();
  const structuredBridge = new CapturingBridge({
    content: [{ type: 'text', text: 'FreeCAD error: CAD_DOCUMENT_ALREADY_EXISTS|Motorhalter' }],
    isError: true,
  });
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, structuredBridge, structuredGate);
  const structured = await handleHighLevelCadTool('cad_execute_plan', { documentName: 'Motorhalter' }, structuredBridge, structuredGate);
  assert.deepEqual(payload(structured), { success: false, code: 'CAD_DOCUMENT_ALREADY_EXISTS', document: 'Motorhalter' });

  const available = await validateAndCapture(plan('center'), 'Motorhalter');
  const succeeded = executeFreeCad(available.bridge.commands[0]);
  assert.equal(succeeded.result.document, 'Motorhalter');
});

test('sequential automatic executions allocate distinct names and concurrent calls are serialized', async () => {
  const gate = new CadPlanValidationGate();
  const bridge = new CapturingBridge();
  await handleHighLevelCadTool('cad_validate_plan', { plan: plan('center') }, bridge, gate);
  await handleHighLevelCadTool('cad_execute_plan', {}, bridge, gate);
  await handleHighLevelCadTool('cad_execute_plan', {}, bridge, gate);
  const combined = executeFreeCad(`${bridge.commands[0]}\n_mcp_first_document = _mcp_result["result"]["document"]\n${bridge.commands[1]}\n_mcp_result["result"]["firstDocument"] = _mcp_first_document`);
  assert.equal(combined.result.firstDocument, 'CADPlan_1');
  assert.equal(combined.result.document, 'CADPlan_2');

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
  const first = handleHighLevelCadTool('cad_execute_plan', {}, delayed, lockedGate);
  const second = await handleHighLevelCadTool('cad_execute_plan', {}, delayed, lockedGate);
  assert.equal(payload(second).code, 'CAD_PLAN_NOT_VALIDATED');
  release();
  await first;
  assert.equal(delayed.calls, 1);
});

test('failed automatic execution cleans only its new document and preserves existing documents', async () => {
  const oversized = await validateAndCapture(plan('center', { fillet: { radius: 1000, edges: 'all_vertical' } }), undefined);
  const execution = executeFreeCad(`
keep = FreeCAD.newDocument("KeepMe")
keep.addObject("App::FeaturePython", "KeepMarker")
${oversized.bridge.commands[0]}`, true);
  assert.equal(execution.ok, false);
  assert.match(execution.error, /CAD_EXECUTE_PLAN_FAILED\|fillet\|fillet\|fillet\|/);
  assert.deepEqual(execution.documents.KeepMe, ['KeepMarker']);
  assert.equal(execution.openDocuments.includes('CADPlan_1'), false);
});

test('executor creates actual through holes for one and three explicit centers', async () => {
  const cases = [
    [{ x: 50, y: 30 }],
    [{ x: 10, y: 10 }, { x: 50, y: 30 }, { x: 85, y: 45 }],
  ];
  for (const [index, centers] of cases.entries()) {
    const explicitPlan = {
      unit: 'mm',
      features: [
        { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
        { id: 'free_holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers } },
      ],
    };
    const { bridge, validation } = await validateAndCapture(explicitPlan, `Explicit_${index + 1}`);
    assert.deepEqual(validation.resolved_plan.features[1].centers, centers);
    assert.doesNotMatch(bridge.commands[0], /"placement"|"explicit"/);
    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.features[1].verified_holes, centers.length);
    assert.deepEqual(execution.result.verification.verifiedHoleCenters, centers);
    assert.equal(execution.result.solidCount, 1);
  }
});

test('executor creates six grid holes followed by fillet and inner chamfer', async () => {
  const gridPlan = {
    unit: 'mm',
    features: [
      { type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { type: 'hole_pattern', diameter: 6, placement: { type: 'rectangular_grid', origin: { x: 20, y: 15 }, columns: 3, rows: 2, spacing_x: 30, spacing_y: 20 } },
      { type: 'fillet', radius: 5, edges: 'all_vertical' },
      { type: 'chamfer', size: 0.5, edges: 'all_top_inner' },
    ],
  };
  const expected = [
    { x: 20, y: 15 }, { x: 50, y: 15 }, { x: 80, y: 15 },
    { x: 20, y: 35 }, { x: 50, y: 35 }, { x: 80, y: 35 },
  ];
  const { bridge, validation } = await validateAndCapture(gridPlan, 'GridFeatures');
  assert.deepEqual(validation.resolved_plan.features[1].centers, expected);
  assert.doesNotMatch(bridge.commands[0], /rectangular_grid|spacing_x|spacing_y|"origin"/);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.deepEqual(execution.result.executed_steps, ['base', 'holes', 'fillet', 'chamfer']);
  assert.equal(execution.result.features[1].verified_holes, 6);
  assert.deepEqual(execution.result.verification.verifiedHoleCenters, expected);
  assert.equal(execution.result.solidCount, 1);
  assert.equal(execution.result.valid, true);
});
