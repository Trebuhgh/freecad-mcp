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
const lProfile = [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]];
const esp32PocketPlan = {
  unit: 'mm',
  features: [
    { id: 'outer_body', type: 'rectangular_pad', width: 59.95, height: 32.97, length: 14 },
    { id: 'inner_cavity', type: 'rectangular_pocket', after: 'outer_body', target: 'outer_body', face: 'top', width: 55.95, height: 28.97, position: { x: 2, y: 2 }, depth: 12 },
    { id: 'usb_cutout', type: 'rectangular_pocket', after: 'inner_cavity', target: 'inner_cavity', face: 'front', width: 12, height: 7, position: { x: 23.975, y: 4 }, depth: 2 },
  ],
};

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

function mutateVerificationSnapshot(code, mutation) {
  const marker = '    # verification_snapshot_complete';
  assert.ok(code.includes(marker), 'verification snapshot marker missing');
  const indented = mutation.split('\n').map((line) => `    ${line}`).join('\n');
  return code.replace(marker, `${indented}\n${marker}`);
}

function mutateInspectedShape(code, mutation) {
  const marker = '    # geometry_inspection_start';
  assert.ok(code.includes(marker), 'geometry inspection marker missing');
  const indented = mutation.split('\n').map((line) => `    ${line}`).join('\n');
  return code.replace(marker, `${indented}\n${marker}`);
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
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
    assert.equal(result.valid, true);
    assert.equal(result.status, 'verified');
    assert.equal(result.solidCount, 1);
    assert.equal(result.verification.solid_count.passed, true);
    assert.equal(result.verification.bounding_box.passed, true);
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
    const holeVerification = execution.result.verification.features.find((feature) => feature.type === 'hole_pattern');
    assert.equal(holeVerification.expected_count, centers.length);
    assert.equal(holeVerification.actual_count, centers.length);
    assert.equal(holeVerification.expected_radius, 3);
    assert.ok(holeVerification.centers.every((center) => center.passed && center.radius_passed));
    const signatureCylinders = execution.result.geometry_signature.surfaces.cylindrical;
    assert.equal(signatureCylinders.length, centers.length);
    assert.ok(signatureCylinders.every((cylinder) => Math.abs(cylinder.radius - 3) <= 1e-6));
    assert.ok(signatureCylinders.every((cylinder) => Math.abs(Math.abs(cylinder.axis[2]) - 1) <= 1e-6));
    assert.deepEqual(signatureCylinders.map((cylinder) => cylinder.axis_point.slice(0, 2)), centers.map(({ x, y }) => [x, y]));
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
  assert.deepEqual(validation.resolved_plan.features[1].grid, { columns: 3, rows: 2, spacing_x: 30, spacing_y: 20, pattern_center_x: 50, pattern_center_y: 25 });
  assert.doesNotMatch(bridge.commands[0], /rectangular_grid|"origin"|"placement"/);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.deepEqual(execution.result.executed_steps, ['base', 'holes', 'fillet', 'chamfer']);
  assert.equal(execution.result.features[1].verified_holes, 6);
  assert.deepEqual(execution.result.verification.verifiedHoleCenters, expected);
  const holeVerification = execution.result.verification.features.find((feature) => feature.type === 'hole_pattern');
  assert.equal(holeVerification.expected_count, 6);
  assert.equal(holeVerification.actual_count, 6);
  assert.ok(holeVerification.centers.every((center) => center.passed));
  const signatureHoles = execution.result.geometry_signature.surfaces.cylindrical.filter((surface) => surface.axis_material_length <= 1e-6 && Math.abs(surface.radius - 3) <= 1e-6);
  assert.equal(signatureHoles.length, 6);
  assert.equal(execution.result.solidCount, 1);
  assert.equal(execution.result.valid, true);
});

test('executor consumes a full simple intent plan through the canonical resolved plan', async () => {
  const simplePlan = {
    shape: 'plate', size: [100, 60, 10], unit: 'mm',
    holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] },
    fillet: { radius: 5, edges: 'all_vertical' },
    chamfer: { size: 0.5, edges: 'all_top_inner' },
  };
  const { bridge, validation } = await validateAndCapture(simplePlan, 'SimpleIntentFeatures');
  assert.deepEqual(validation.resolved_plan.features.map((feature) => feature.type), [
    'rectangular_pad', 'hole_pattern', 'fillet', 'chamfer',
  ]);
  assert.deepEqual(validation.resolved_plan.features[1].grid, { columns: 3, rows: 2, spacing_x: 30, spacing_y: 20, pattern_center_x: 50, pattern_center_y: 25 });
  assert.doesNotMatch(bridge.commands[0], /rectangular_grid|edge_offset|"origin"|"placement"/);
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.equal(execution.result.valid, true);
  assert.equal(execution.result.solidCount, 1);
  assert.deepEqual(execution.result.executed_steps, ['base', 'holes', 'fillet', 'chamfer']);
  assert.equal(execution.result.features[1].verified_holes, 6);
  assert.ok(execution.result.verification.features.every((feature) => feature.passed));
  assert.deepEqual(execution.result.verification.recomputeErrors, []);
});

test('simple plate execution returns a complete verified report', async () => {
  const { bridge } = await validateAndCapture({ shape: 'plate', size: [100, 60, 10], unit: 'mm' }, 'VerifiedPlate');
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.result.success, true);
  assert.equal(execution.result.status, 'verified');
  assert.deepEqual(execution.result.verification.solid_count, { expected: 1, actual: 1, passed: true });
  assert.deepEqual(execution.result.verification.bounding_box, {
    expected: { x: 100, y: 60, z: 10 }, actual: { x: 100, y: 60, z: 10 }, passed: true,
  });
  assert.equal(execution.result.verification.features[0].passed, true);
  assert.equal(execution.result.verification.body_tip_correct, true);
  const signature = execution.result.geometry_signature;
  assert.equal(signature.solid_count, 1);
  assert.deepEqual(signature.bounding_box, { x: 100, y: 60, z: 10 });
  assert.equal(signature.volume, 60000);
  assert.deepEqual(signature.topology, { faces: 6, edges: 12, vertices: 8 });
  assert.equal(signature.surfaces.planar.length, 6);
  assert.equal(signature.surfaces.cylindrical.length, 0);
  assert.ok(signature.surfaces.planar.every((surface) => surface.surface_type === 'plane' && surface.area > 0 && surface.center.length === 3 && surface.normal.length === 3));
});

test('verified rectangular pad persists managed-model metadata and semantic parameter bindings', async () => {
  const planned = { shape: 'plate', size: [100, 60, 10], unit: 'mm' };
  const { bridge, validation } = await validateAndCapture(planned, 'ManagedPlate');
  const execution = executeFreeCad(`${bridge.commands[0]}
_managed_result = _mcp_result["result"]
_metadata = doc.getObject("ManagedModelMetadata")
_bindings = json.loads(_metadata.FeatureBindingsJson)
_base_binding = _bindings["base"]
_bound_feature = doc.getObject(_base_binding["feature_object"])
_bound_sketch = doc.getObject(_base_binding["sketch_object"])
_model_id_before = _metadata.ModelId
doc.recompute()
_width_index = next(index for index, constraint in enumerate(_bound_sketch.Constraints) if constraint.Name == "width")
_height_index = next(index for index, constraint in enumerate(_bound_sketch.Constraints) if constraint.Name == "height")
_managed_result["managed_metadata_probe"] = {
    "is_managed": bool(_metadata.IsManagedModel),
    "model_id": str(_metadata.ModelId),
    "model_id_after_recompute": str(_metadata.ModelId),
    "model_revision": int(_metadata.ModelRevision),
    "plan_digest": str(_metadata.PlanDigest),
    "resolved_plan": json.loads(_metadata.ResolvedPlanJson),
    "bindings": _bindings,
    "feature_exists": _bound_feature is not None,
    "sketch_exists": _bound_sketch is not None,
    "feature_type_id": str(_bound_feature.TypeId),
    "sketch_type_id": str(_bound_sketch.TypeId),
    "constraint_names": [str(constraint.Name) for constraint in _bound_sketch.Constraints],
    "width_value": float(_bound_sketch.getDatum(_width_index).Value),
    "height_value": float(_bound_sketch.getDatum(_height_index).Value),
    "length_value": float(_bound_feature.Length.Value),
    "volume": float(body.Tip.Shape.Volume),
}
_mcp_result["result"] = _managed_result`);

  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.equal(execution.result.status, 'verified');
  assert.match(execution.result.managed_model.model_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(execution.result.managed_model.model_revision, 1);
  assert.match(execution.result.managed_model.plan_digest, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(execution.result.managed_model), /constraint_index|PlanFeature_0|PlanSketch_0/);

  const probe = execution.result.managed_metadata_probe;
  assert.equal(probe.is_managed, true);
  assert.equal(probe.model_id, execution.result.managed_model.model_id);
  assert.equal(probe.model_id_after_recompute, probe.model_id);
  assert.equal(probe.model_revision, 1);
  assert.equal(probe.plan_digest, execution.result.managed_model.plan_digest);
  assert.deepEqual(probe.resolved_plan, validation.resolved_plan);
  assert.equal(probe.feature_exists, true);
  assert.equal(probe.sketch_exists, true);
  assert.equal(probe.feature_type_id, 'PartDesign::Pad');
  assert.equal(probe.sketch_type_id, 'Sketcher::SketchObject');
  assert.ok(probe.constraint_names.includes('width'));
  assert.ok(probe.constraint_names.includes('height'));
  assert.equal(probe.width_value, 100);
  assert.equal(probe.height_value, 60);
  assert.equal(probe.length_value, 10);
  assert.equal(probe.volume, 60000);
  assert.deepEqual(probe.bindings.base, {
    type: 'rectangular_pad',
    feature_object: 'PlanFeature_0',
    feature_type_id: 'PartDesign::Pad',
    sketch_object: 'PlanSketch_0',
    parameters: {
      width: { kind: 'sketch_constraint', object: 'PlanSketch_0', constraint_name: 'width', unit: 'mm' },
      height: { kind: 'sketch_constraint', object: 'PlanSketch_0', constraint_name: 'height', unit: 'mm' },
      length: { kind: 'feature_property', object: 'PlanFeature_0', property: 'Length', unit: 'mm' },
    },
  });
  assert.ok(execution.documents.ManagedPlate.includes('ManagedModelMetadata'));
  assert.deepEqual(execution.result.geometry_signature.bounding_box, { x: 100, y: 60, z: 10 });
  assert.equal(execution.result.geometry_signature.volume, 60000);
});

test('managed model IDs are unique while canonical resolved plans have a stable digest', async () => {
  const planned = { shape: 'plate', size: [100, 60, 10], unit: 'mm' };
  const first = await validateAndCapture(planned, 'ManagedIdentityA');
  const second = await validateAndCapture(planned, 'ManagedIdentityB');
  const execution = executeFreeCad(`${first.bridge.commands[0]}
_first_managed_model = dict(_mcp_result["result"]["managed_model"])
${second.bridge.commands[0]}
_mcp_result["result"]["first_managed_model"] = _first_managed_model`);

  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.notEqual(execution.result.first_managed_model.model_id, execution.result.managed_model.model_id);
  assert.equal(execution.result.first_managed_model.plan_digest, execution.result.managed_model.plan_digest);
  assert.equal(execution.result.first_managed_model.model_revision, 1);
  assert.equal(execution.result.managed_model.model_revision, 1);
});

test('managed-model metadata and bindings survive a real FCStd save and reload', async () => {
  const planned = { shape: 'plate', size: [100, 60, 10], unit: 'mm' };
  const { bridge, validation } = await validateAndCapture(planned, 'ManagedReload');
  const execution = executeFreeCad(`${bridge.commands[0]}
import os
import tempfile
_execution_result = _mcp_result["result"]
_file_descriptor, _fcstd_path = tempfile.mkstemp(suffix=".FCStd")
os.close(_file_descriptor)
doc.saveAs(_fcstd_path)
FreeCAD.closeDocument(doc.Name)
_reloaded = FreeCAD.openDocument(_fcstd_path)
_reloaded_metadata = _reloaded.getObject("ManagedModelMetadata")
_reloaded_bindings = json.loads(_reloaded_metadata.FeatureBindingsJson)
_reloaded_base = _reloaded_bindings["base"]
_reloaded_feature = _reloaded.getObject(_reloaded_base["feature_object"])
_reloaded_sketch = _reloaded.getObject(_reloaded_base["sketch_object"])
_reloaded_body = _reloaded.getObject("Body")
_reloaded.recompute()
_reloaded_bounds = _reloaded_body.Tip.Shape.optimalBoundingBox(False)
_execution_result["reload_probe"] = {
    "is_managed": bool(_reloaded_metadata.IsManagedModel),
    "model_id": str(_reloaded_metadata.ModelId),
    "model_revision": int(_reloaded_metadata.ModelRevision),
    "plan_digest": str(_reloaded_metadata.PlanDigest),
    "resolved_plan": json.loads(_reloaded_metadata.ResolvedPlanJson),
    "feature_exists": _reloaded_feature is not None,
    "sketch_exists": _reloaded_sketch is not None,
    "bounding_box": {"x": float(_reloaded_bounds.XLength), "y": float(_reloaded_bounds.YLength), "z": float(_reloaded_bounds.ZLength)},
    "volume": float(_reloaded_body.Tip.Shape.Volume),
}
FreeCAD.closeDocument(_reloaded.Name)
os.remove(_fcstd_path)
_mcp_result["result"] = _execution_result`);

  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  const probe = execution.result.reload_probe;
  assert.equal(probe.is_managed, true);
  assert.equal(probe.model_id, execution.result.managed_model.model_id);
  assert.equal(probe.model_revision, 1);
  assert.equal(probe.plan_digest, execution.result.managed_model.plan_digest);
  assert.deepEqual(probe.resolved_plan, validation.resolved_plan);
  assert.equal(probe.feature_exists, true);
  assert.equal(probe.sketch_exists, true);
  assert.deepEqual(probe.bounding_box, { x: 100, y: 60, z: 10 });
  assert.equal(probe.volume, 60000);
});

test('geometry signature is deterministic and contains no topological index identities', async () => {
  const simplePlan = {
    shape: 'plate', size: [100, 60, 10], unit: 'mm',
    holes: { diameter: 6, centers: [[10, 10], [50, 30], [85, 45]] },
  };
  const first = await validateAndCapture(simplePlan, 'SignatureRepeatA');
  const second = await validateAndCapture(simplePlan, 'SignatureRepeatB');
  const firstSignature = executeFreeCad(first.bridge.commands[0]).result.geometry_signature;
  const secondSignature = executeFreeCad(second.bridge.commands[0]).result.geometry_signature;
  assert.deepEqual(firstSignature, secondSignature);
  assert.doesNotMatch(JSON.stringify(firstSignature), /(?:Face|Edge|Vertex)[1-9][0-9]*/);
});

for (const [name, profile, expectedBounds, expectedArea] of [
  ['L', lProfile, { x: 100, y: 80, z: 10 }, 6400],
  ['U', [[0, 0], [100, 0], [100, 80], [70, 80], [70, 30], [30, 30], [30, 80], [0, 80]], { x: 100, y: 80, z: 10 }, 6000],
]) {
  test(`${name}-profile executes as a fully constrained profile_pad and verifies geometry`, async () => {
    const { bridge, validation } = await validateAndCapture({ shape: 'profile', profile, thickness: 10, unit: 'mm' }, `Profile${name}`);
    assert.equal(validation.resolved_plan.features[0].type, 'profile_pad');
    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
    assert.equal(execution.result.status, 'verified');
    assert.equal(execution.result.solidCount, 1);
    assert.deepEqual(execution.result.geometry_signature.bounding_box, expectedBounds);
    assert.equal(execution.result.geometry_signature.volume, expectedArea * 10);
    const profileVerification = execution.result.verification.features[0];
    assert.equal(profileVerification.type, 'profile_pad');
    assert.equal(profileVerification.passed, true);
    assert.equal(profileVerification.sketch_closed, true);
    assert.equal(profileVerification.sketch_fully_constrained, true);
    assert.equal(profileVerification.sketch_degrees_of_freedom, 0);
    assert.deepEqual(profileVerification.volume, { expected: expectedArea * 10, actual: expectedArea * 10, passed: true });
  });
}

function roundedProfileSegments(direction) {
  return [
    { type: 'line', start: [0, 0], end: [80, 0] },
    { type: 'arc', start: [80, 0], end: [80, 40], center: [80, 20], direction },
    { type: 'line', start: [80, 40], end: [0, 40] },
    { type: 'line', start: [0, 40], end: [0, 0] },
  ];
}

for (const [direction, expectedX, expectedArea] of [
  ['ccw', 100, 3200 + 200 * Math.PI],
  ['cw', 80, 3200 - 200 * Math.PI],
]) {
  test(`mixed profile executes a real ${direction.toUpperCase()} arc sketch and analytically verifies the Pad`, async () => {
    const planned = { shape: 'profile', segments: roundedProfileSegments(direction), thickness: 10, unit: 'mm' };
    const { bridge, validation } = await validateAndCapture(planned, `ArcProfile_${direction}`);
    assert.equal(validation.resolved_plan.features[0].segments[1].type, 'arc');
    assert.equal(validation.resolved_plan.features[0].segments[1].direction, direction);
    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
    assert.equal(execution.result.status, 'verified');
    assert.equal(execution.result.features[0].object_type, 'PartDesign::Pad');
    assert.deepEqual(execution.result.features[0].arc_geometry_types, ['ArcOfCircle']);
    assert.equal(execution.result.features[0].sketch_dof, 0);
    assert.equal(execution.result.features[0].line_segment_count, 3);
    assert.equal(execution.result.features[0].arc_segment_count, 1);
    assert.ok(Math.abs(execution.result.features[0].arc_radii[0] - 20) <= 1e-6);
    assert.equal(execution.result.solidCount, 1);
    assert.deepEqual(execution.result.geometry_signature.bounding_box, { x: expectedX, y: 40, z: 10 });
    assert.ok(Math.abs(execution.result.geometry_signature.volume - expectedArea * 10) <= 1e-6);
    const outerCylinder = execution.result.geometry_signature.surfaces.cylindrical.find(
      (surface) => surface.surface_role === 'outer_profile' && Math.abs(surface.radius - 20) <= 1e-6,
    );
    assert.ok(outerCylinder, 'curved outer surface missing from independent Geometry Signature');
    assert.deepEqual(outerCylinder.axis_point.slice(0, 2), [80, 20]);
    const profileVerification = execution.result.verification.features[0];
    assert.equal(profileVerification.passed, true);
    assert.deepEqual(profileVerification.line_segment_count, { expected: 3, actual: 3, passed: true });
    assert.deepEqual(profileVerification.arc_segment_count, { expected: 1, actual: 1, passed: true });
    assert.equal(profileVerification.arc_surfaces.length, 1);
    assert.equal(profileVerification.arc_surfaces[0].radius_passed, true);
    assert.equal(profileVerification.arc_surfaces[0].material_axis_passed, true);
    assert.deepEqual(execution.result.verification.recomputeErrors, []);
  });
}

test('arc profile Geometry Signature uses exact BREP bounds even when triangulation is cached', async () => {
  const planned = { shape: 'profile', segments: roundedProfileSegments('ccw'), thickness: 10, unit: 'mm' };
  const { bridge } = await validateAndCapture(planned, 'ArcProfileExactBounds');
  const execution = executeFreeCad(mutateInspectedShape(bridge.commands[0], 'shape.tessellate(0.1)'));
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.equal(execution.result.status, 'verified');
  assert.deepEqual(execution.result.geometry_signature.bounding_box, { x: 100, y: 40, z: 10 });
  const curvedSurface = execution.result.geometry_signature.surfaces.cylindrical.find(
    (surface) => surface.surface_role === 'outer_profile' && Math.abs(surface.radius - 20) <= 1e-6,
  );
  assert.ok(curvedSurface, 'exact cylindrical BREP surface missing');
  assert.deepEqual(curvedSurface.extent.size, [20, 40, 10]);
});

for (const [name, centers] of [
  ['one', [[20, 20]]],
  ['multiple', [[20, 20], [40, 60], [80, 20]]],
]) {
  test(`profile_pad executes ${name} explicit through hole pattern and verifies actual geometry`, async () => {
    const planned = {
      unit: 'mm',
      features: [
        { id: 'base', type: 'profile_pad', points: lProfile, length: 10 },
        { id: 'holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers }, operation: 'through_all' },
      ],
    };
    const expectedCenters = centers.map(([x, y]) => ({ x, y }));
    const { bridge, validation } = await validateAndCapture(planned, `ProfileHoles_${name}`);
    assert.deepEqual(validation.resolved_plan.features[1].centers, expectedCenters);
    assert.equal(validation.resolved_plan.features[1].operation, 'through_all');
    assert.doesNotMatch(bridge.commands[0], /"placement"|"explicit"/);

    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
    assert.equal(execution.result.status, 'verified');
    assert.equal(execution.result.features[1].object_type, 'PartDesign::Pocket');
    assert.equal(execution.result.features[1].through_all, true);
    assert.equal(execution.result.features[1].verified_holes, centers.length);
    assert.equal(execution.result.solidCount, 1);
    assert.deepEqual(execution.result.verification.recomputeErrors, []);
    assert.deepEqual(execution.result.verification.verifiedHoleCenters, expectedCenters);

    const expectedVolume = 64000 - centers.length * Math.PI * 3 ** 2 * 10;
    assert.ok(Math.abs(execution.result.geometry_signature.volume - expectedVolume) <= 1e-6);
    const cylinders = execution.result.geometry_signature.surfaces.cylindrical.filter(
      (surface) => surface.axis_material_length <= 1e-6 && Math.abs(surface.radius - 3) <= 1e-6,
    );
    assert.equal(cylinders.length, centers.length);
    assert.deepEqual(cylinders.map((surface) => surface.axis_point.slice(0, 2)), centers);
    assert.ok(execution.result.verification.features.every((feature) => feature.passed));
  });
}

test('profile hole SOLL/IST verification independently rejects a filled actual hole', async () => {
  const planned = {
    shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm',
    holes: { diameter: 6, centers: [[20, 20]] },
  };
  const { bridge } = await validateAndCapture(planned, 'ProfileHoleSignatureMismatch');
  const mutation = 'shape = shape.fuse(Part.makeCylinder(3.0, 10.0, FreeCAD.Vector(20.0, 20.0, 0.0)))';
  const execution = executeFreeCad(mutateInspectedShape(bridge.commands[0], mutation), true);
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, false);
  assert.equal(execution.result.status, 'verification_failed');
  assert.equal(execution.result.code, 'CAD_VERIFICATION_FAILED');
  assert.equal(execution.result.geometry_signature.surfaces.cylindrical.length, 0);
  const issue = execution.result.issues.find((candidate) => candidate.check === 'hole_count');
  assert.ok(issue, 'hole_count issue missing');
  assert.deepEqual({ expected: issue.expected, actual: issue.actual }, { expected: 1, actual: 0 });
});

test('profile_pad executes a normalized rectangular grid as verified through holes', async () => {
  const planned = {
    shape: 'profile', profile: lProfile, thickness: 10, unit: 'mm',
    holes: { diameter: 6, grid: [2, 2], start: [20, 20], spacing: [30, 30] },
  };
  const expectedCenters = [{ x: 20, y: 20 }, { x: 50, y: 20 }, { x: 20, y: 50 }, { x: 50, y: 50 }];
  const { bridge, validation } = await validateAndCapture(planned, 'ProfileGridHoles');
  assert.deepEqual(validation.resolved_plan.features[1].centers, expectedCenters);
  const serializedPlan = bridge.commands[0].split('\n').find((line) => line.startsWith('plan = '));
  assert.doesNotMatch(serializedPlan, /rectangular_grid|"grid"|"start"|"spacing"|"placement"/);

  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.equal(execution.result.status, 'verified');
  assert.equal(execution.result.features[1].object_type, 'PartDesign::Pocket');
  assert.equal(execution.result.features[1].verified_holes, 4);
  assert.equal(execution.result.features[1].through_all, true);
  assert.equal(execution.result.solidCount, 1);
  assert.deepEqual(execution.result.verification.verifiedHoleCenters, expectedCenters);
  assert.deepEqual(execution.result.verification.recomputeErrors, []);
  const holeVerification = execution.result.verification.features[1];
  assert.equal(holeVerification.expected_count, 4);
  assert.equal(holeVerification.actual_count, 4);
  assert.ok(holeVerification.centers.every((center) => center.passed && center.radius_passed && center.axis_passed && center.through_all_passed));
  const cylinders = execution.result.geometry_signature.surfaces.cylindrical.filter(
    (surface) => surface.axis_material_length <= 1e-6 && Math.abs(surface.radius - 3) <= 1e-6,
  );
  assert.equal(cylinders.length, 4);
  const byCoordinates = (first, second) => first[1] - second[1] || first[0] - second[0];
  assert.deepEqual(
    cylinders.map((surface) => surface.axis_point.slice(0, 2)).sort(byCoordinates),
    expectedCenters.map(({ x, y }) => [x, y]).sort(byCoordinates),
  );
  assert.ok(Math.abs(execution.result.geometry_signature.volume - (64000 - 4 * Math.PI * 3 ** 2 * 10)) <= 1e-6);
});

for (const scenario of [
  {
    name: 'five actual holes versus six expected holes',
    mutation: 'shape = shape.fuse(Part.makeCylinder(3.0, 10.0, FreeCAD.Vector(80.0, 35.0, 0.0)))',
    check: 'hole_count', expected: 6, actual: 5,
    inspect(signature) {
      const holes = signature.surfaces.cylindrical.filter((surface) => surface.axis_material_length <= 1e-6);
      assert.equal(signature.surfaces.cylindrical.length, 5);
      assert.equal(holes.length, 5);
    },
  },
  {
    name: 'actual radius four versus expected radius three',
    mutation: 'shape = shape.fuse(Part.makeCylinder(3.0, 10.0, FreeCAD.Vector(20.0, 15.0, 0.0))).cut(Part.makeCylinder(4.0, 10.0, FreeCAD.Vector(20.0, 15.0, 0.0)))',
    check: 'hole_radius', expected: 3, actual: 4,
    inspect(signature) {
      assert.ok(signature.surfaces.cylindrical.some((surface) => surface.axis_point[0] === 20 && surface.axis_point[1] === 15 && surface.radius === 4));
    },
  },
  {
    name: 'actual center 21,15 versus expected center 20,15',
    mutation: 'shape = shape.fuse(Part.makeCylinder(3.0, 10.0, FreeCAD.Vector(20.0, 15.0, 0.0))).cut(Part.makeCylinder(3.0, 10.0, FreeCAD.Vector(21.0, 15.0, 0.0)))',
    check: 'hole_center', expected: { x: 20, y: 15 }, actual: { x: 21, y: 15 },
    inspect(signature) {
      assert.ok(signature.surfaces.cylindrical.some((surface) => surface.axis_point[0] === 21 && surface.axis_point[1] === 15 && surface.radius === 3));
    },
  },
]) {
  test(`geometry signature independence: ${scenario.name}`, async () => {
    const gridPlan = {
      shape: 'plate', size: [100, 60, 10], unit: 'mm',
      holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] },
    };
    const { bridge } = await validateAndCapture(gridPlan, `Signature_${scenario.check}`);
    const execution = executeFreeCad(mutateInspectedShape(bridge.commands[0], scenario.mutation), true);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, false);
    assert.equal(execution.result.status, 'verification_failed');
    assert.equal(execution.result.code, 'CAD_VERIFICATION_FAILED');
    scenario.inspect(execution.result.geometry_signature);
    const issue = execution.result.issues.find((candidate) => candidate.check === scenario.check);
    assert.ok(issue, `${scenario.check} issue missing`);
    assert.deepEqual(issue.expected, scenario.expected);
    assert.deepEqual(issue.actual, scenario.actual);
  });
}

for (const [check, mutation, expected, actual] of [
  ['hole_count', 'actual_snapshot["holes"] = actual_snapshot["holes"][:-1]', 6, 5],
  ['hole_center', 'actual_snapshot["holes"][0]["x"] = 21.0', { x: 20, y: 15 }, { x: 21, y: 15 }],
  ['hole_radius', 'actual_snapshot["holes"][0]["radius"] = 4.0', 3, 4],
  ['bounding_box', 'actual_snapshot["bounding_box"]["x"] = 99.0', { x: 100, y: 60, z: 10 }, { x: 99, y: 60, z: 10 }],
  ['body_tip', 'actual_snapshot["body_tip"] = "WrongTip"', 'PlanFeature_1', 'WrongTip'],
  ['recompute_errors', 'actual_snapshot["recompute_errors"] = [{"object": "PlanFeature_1", "states": ["Invalid"]}]', [], [{ object: 'PlanFeature_1', states: ['Invalid'] }]],
]) {
  test(`verification failure: ${check} is structured and cleans only the new document`, async () => {
    const gridPlan = {
      shape: 'plate', size: [100, 60, 10], unit: 'mm',
      holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] },
    };
    const { bridge } = await validateAndCapture(gridPlan, `VerificationFailure_${check}`);
    const code = mutateVerificationSnapshot(bridge.commands[0], mutation);
    const execution = executeFreeCad(`
keep = FreeCAD.newDocument("VerificationKeep")
keep.addObject("App::FeaturePython", "KeepMarker")
${code}`, true);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, false);
    assert.equal(execution.result.status, 'verification_failed');
    assert.equal(execution.result.code, 'CAD_VERIFICATION_FAILED');
    const issue = execution.result.issues.find((candidate) => candidate.check === check);
    assert.ok(issue, `${check} issue missing`);
    assert.deepEqual(issue.expected, expected);
    assert.deepEqual(issue.actual, actual);
    assert.equal(execution.openDocuments.includes(`VerificationFailure_${check}`), false);
    assert.equal(execution.result.managed_model, undefined);
    assert.equal(execution.documents[`VerificationFailure_${check}`], undefined);
    assert.equal(Object.values(execution.documents).flat().includes('ManagedModelMetadata'), false);
    assert.deepEqual(execution.documents.VerificationKeep, ['KeepMarker']);
  });
}

test('a structured verification failure is an MCP error and revokes execution authorization', async () => {
  const gate = new CadPlanValidationGate();
  const bridge = new CapturingBridge({
    content: [{ type: 'text', text: JSON.stringify({ success: false, status: 'verification_failed', code: 'CAD_VERIFICATION_FAILED', issues: [] }) }],
  });
  await handleHighLevelCadTool('cad_validate_plan', { plan: { shape: 'plate', size: [100, 60, 10], unit: 'mm' } }, bridge, gate);
  const failed = await handleHighLevelCadTool('cad_execute_plan', {}, bridge, gate);
  assert.equal(failed.isError, true);
  assert.equal(gate.state, 'blocked');
  const retry = await handleHighLevelCadTool('cad_execute_plan', {}, bridge, gate);
  assert.equal(payload(retry).code, 'CAD_PLAN_NOT_VALIDATED');
  assert.equal(bridge.calls, 1);
});

for (const face of ['top', 'front', 'back', 'left', 'right']) {
  test(`cad_execute_plan creates and independently verifies a real ${face} rectangular PartDesign pocket`, async () => {
    const planned = {
      unit: 'mm',
      features: [
        { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 20 },
        { id: 'pocket', type: 'rectangular_pocket', after: 'base', target: 'base', face, width: 20, height: 10, position: { x: 5, y: 5 }, depth: 4 },
      ],
    };
    const { bridge } = await validateAndCapture(planned, `RectangularPocket_${face}`);
    assert.doesNotMatch(bridge.commands[0], /Face\d+|Edge\d+/);
    const execution = executeFreeCad(bridge.commands[0]);
    assert.equal(execution.ok, true, execution.traceback);
    assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
    assert.equal(execution.result.status, 'verified');
    assert.equal(execution.result.solidCount, 1);
    assert.deepEqual(execution.result.geometry_signature.bounding_box, { x: 100, y: 60, z: 20 });
    assert.equal(execution.result.features[1].object_type, 'PartDesign::Pocket');
    assert.equal(execution.result.features[1].sketch_dof, 0);
    const verification = execution.result.verification.features[1];
    assert.equal(verification.passed, true, JSON.stringify(verification));
    assert.equal(verification.semantic_face.passed, true);
    assert.equal(verification.void_box.passed, true);
    assert.equal(verification.axis_material_length.passed, true);
    assert.equal(execution.result.verification.rectangular_pocket_volume.passed, true);
  });
}

test('exact ESP32 enclosure executes as a verified linear PartDesign chain with analytic BREP measurements', async () => {
  const { bridge } = await validateAndCapture(esp32PocketPlan, 'ESP32_Enclosure');
  const execution = executeFreeCad(bridge.commands[0]);
  assert.equal(execution.ok, true, execution.traceback);
  const result = execution.result;
  assert.equal(result.success, true, JSON.stringify(result, null, 2));
  assert.equal(result.status, 'verified');
  assert.equal(result.geometry_signature.solid_count, 1);
  assert.equal(result.geometry_signature.shape_valid, true);
  assert.ok(Math.abs(result.geometry_signature.bounding_box.x - 59.95) <= 1e-6);
  assert.ok(Math.abs(result.geometry_signature.bounding_box.y - 32.97) <= 1e-6);
  assert.ok(Math.abs(result.geometry_signature.bounding_box.z - 14) <= 1e-6);
  assert.deepEqual(result.executed_steps, ['outer_body', 'inner_cavity', 'usb_cutout']);
  assert.equal(result.verification.bodyTip, 'PlanFeature_2');
  assert.equal(result.verification.featureChainComplete, true);
  assert.deepEqual(result.verification.recomputeErrors, []);
  const cavity = result.verification.rectangular_pockets.find((pocket) => pocket.id === 'inner_cavity');
  const usb = result.verification.rectangular_pockets.find((pocket) => pocket.id === 'usb_cutout');
  assert.ok(Math.abs(cavity.dimensions.x - 55.95) <= 1e-6);
  assert.ok(Math.abs(cavity.dimensions.y - 28.97) <= 1e-6);
  assert.ok(Math.abs(cavity.dimensions.z - 12) <= 1e-6);
  assert.ok(Math.abs(cavity.axis_material_length - 2) <= 1e-6, JSON.stringify(cavity));
  assert.deepEqual(usb.dimensions, { x: 12, y: 2, z: 7 });
  assert.deepEqual(usb.box, { min_x: 23.975, max_x: 35.975, min_y: 0, max_y: 2, min_z: 4, max_z: 11 });
  assert.ok(Math.abs(usb.axis_material_length - 2) <= 1e-6, JSON.stringify(usb));
  assert.ok(cavity.void_intersection_volume <= 1e-7);
  assert.ok(usb.void_intersection_volume <= 1e-7);
  assert.equal(result.features[2].object, 'PlanFeature_2');
  assert.equal(result.features[2].face, 'front');
});

test('rectangular pocket BREP verification rejects material left inside the planned void and removes the partial document', async () => {
  const { bridge } = await validateAndCapture(esp32PocketPlan, 'ESP32_PocketFailure');
  const mutation = 'shape = shape.fuse(Part.makeBox(1.0, 1.0, 1.0, FreeCAD.Vector(10.0, 10.0, 10.0)))';
  const execution = executeFreeCad(mutateInspectedShape(bridge.commands[0], mutation), true);
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, false);
  assert.equal(execution.result.status, 'verification_failed');
  assert.ok(execution.result.issues.some((issue) => issue.check === 'pocket_void' || issue.check === 'volume'), JSON.stringify(execution.result.issues));
  assert.equal(execution.openDocuments.includes('ESP32_PocketFailure'), false);
  assert.equal(execution.result.managed_model, undefined);
});

test('rectangular pocket metadata and semantic discovery survive an FCStd save/reload', async () => {
  const { bridge, validation } = await validateAndCapture(esp32PocketPlan, 'ESP32_Reload');
  const discoveryBridge = new CapturingBridge();
  await handleHighLevelCadTool('cad_list_managed_models', {}, discoveryBridge, new CadPlanValidationGate());
  assert.equal(discoveryBridge.calls, 1);
  const execution = executeFreeCad(`${bridge.commands[0]}
import os
import tempfile
_execution_result = _mcp_result["result"]
_fd, _path = tempfile.mkstemp(suffix=".FCStd")
os.close(_fd)
doc.saveAs(_path)
FreeCAD.closeDocument(doc.Name)
_reloaded = FreeCAD.openDocument(_path)
_reloaded.recompute()
${discoveryBridge.commands[0]}
_execution_result["discovery"] = _mcp_result["result"]
FreeCAD.closeDocument(_reloaded.Name)
os.remove(_path)
_mcp_result["result"] = _execution_result`);
  assert.equal(execution.ok, true, execution.traceback);
  assert.equal(execution.result.success, true, JSON.stringify(execution.result, null, 2));
  assert.deepEqual(execution.result.discovery.issues, []);
  assert.equal(execution.result.discovery.models.length, 1);
  const model = execution.result.discovery.models[0];
  assert.equal(model.model_id, execution.result.managed_model.model_id);
  assert.equal(model.model_revision, 1);
  assert.deepEqual(model.features, [
    { id: 'outer_body', type: 'rectangular_pad', parameters: { width: 59.95, height: 32.97, length: 14 } },
    { id: 'inner_cavity', type: 'rectangular_pocket', parameters: { face: 'top', width: 55.95, height: 28.97, position: { x: 2, y: 2 }, depth: 12, target: 'outer_body' } },
    { id: 'usb_cutout', type: 'rectangular_pocket', parameters: { face: 'front', width: 12, height: 7, position: { x: 23.975, y: 4 }, depth: 2, target: 'inner_cavity' } },
  ]);
  assert.deepEqual(validation.resolved_plan.features.map((feature) => feature.id), model.features.map((feature) => feature.id));
});
