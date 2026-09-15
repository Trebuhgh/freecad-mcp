import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { CadEditValidationGate } from '../dist/tools/cad-edit.js';
import { HIGH_LEVEL_CAD_TOOLS, handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

const freecadPython = process.env.FREECAD_PYTHON || 'C:\\Program Files\\FreeCAD 1.1\\bin\\python.exe';
const platePlan = { shape: 'plate', size: [100, 60, 10], unit: 'mm' };
const holeCenters = [{ x: 20, y: 20 }, { x: 80, y: 40 }];
const holedPlatePlan = {
  unit: 'mm',
  features: [
    { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
    { id: 'holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: holeCenters }, operation: 'through_all', after: 'base' },
  ],
};
const multiHolePlan = {
  unit: 'mm',
  features: [
    { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
    { id: 'mounting_holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [[20, 15], [80, 15], [20, 45], [80, 45]] }, operation: 'through_all', after: 'base' },
    { id: 'sensor_holes', type: 'hole_pattern', diameter: 4, placement: { type: 'explicit', centers: [[50, 30]] }, operation: 'through_all', after: 'mounting_holes' },
  ],
};
const positionEditPlan = {
  unit: 'mm',
  features: [
    { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
    { id: 'mounting_holes', type: 'hole_pattern', diameter: 9, placement: { type: 'explicit', centers: [[15, 15], [15, 45], [85, 15], [85, 45]] }, operation: 'through_all', after: 'base' },
    { id: 'sensor_holes', type: 'hole_pattern', diameter: 9, placement: { type: 'explicit', centers: [[50, 30]] }, operation: 'through_all', after: 'mounting_holes' },
  ],
};

function payload(toolResult) {
  return JSON.parse(toolResult.content[0].text);
}

class PersistentFreeCadBridge {
  constructor() {
    const server = `
import base64
import json
import sys
import FreeCAD
import Part
print("__READY__", flush=True)
for encoded in sys.stdin:
    try:
        code = base64.b64decode(encoded.strip()).decode("utf-8")
        namespace = dict(globals())
        namespace["_mcp_result"] = {"success": True}
        exec(code, namespace)
        response = {"ok": True, "result": namespace["_mcp_result"].get("result")}
    except Exception as error:
        import traceback
        response = {"ok": False, "error": str(error), "traceback": traceback.format_exc()}
    print("__RESULT__" + json.dumps(response), flush=True)
`;
    this.process = spawn(freecadPython, ['-u', '-c', server], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = undefined;
    this.stderr = '';
    this.transformNext = undefined;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    createInterface({ input: this.process.stdout }).on('line', (line) => {
      if (line === '__READY__') {
        this.resolveReady();
      } else if (line.startsWith('__RESULT__') && this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        pending.resolve(JSON.parse(line.slice('__RESULT__'.length)));
      }
    });
    this.process.stderr.on('data', (chunk) => { this.stderr += chunk.toString(); });
    this.process.on('error', (error) => this.rejectReady(error));
    this.process.on('exit', (code) => {
      if (this.pending) {
        const pending = this.pending;
        this.pending = undefined;
        pending.reject(new Error(`FreeCAD exited with ${code}: ${this.stderr}`));
      }
    });
  }

  mutateNextCode(transform) {
    this.transformNext = transform;
  }

  async run(originalCode) {
    await this.ready;
    assert.equal(this.pending, undefined, 'FreeCAD test bridge supports one command at a time');
    const code = this.transformNext ? this.transformNext(originalCode) : originalCode;
    this.transformNext = undefined;
    const response = await new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.process.stdin.write(`${Buffer.from(code, 'utf8').toString('base64')}\n`);
    });
    if (!response.ok) {
      return { content: [{ type: 'text', text: `FreeCAD error: ${response.error}\n${response.traceback}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(response.result) }] };
  }

  destroy() {
    this.process.stdin.end();
    this.process.kill();
  }
}

async function createManagedPlate(t, documentName) {
  const bridge = new PersistentFreeCadBridge();
  t.after(() => bridge.destroy());
  const planGate = new CadPlanValidationGate();
  const editGate = new CadEditValidationGate();
  const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: platePlan }, bridge, planGate, editGate);
  assert.equal(payload(validation).status, 'valid');
  const execution = await handleHighLevelCadTool('cad_execute_plan', { documentName }, bridge, planGate, editGate);
  const created = payload(execution);
  assert.equal(created.success, true, JSON.stringify(created, null, 2));
  assert.equal(created.status, 'verified');
  return { bridge, planGate, editGate, created };
}

async function createManagedHoledPlate(t, documentName, plan = holedPlatePlan) {
  const bridge = new PersistentFreeCadBridge();
  t.after(() => bridge.destroy());
  const planGate = new CadPlanValidationGate();
  const editGate = new CadEditValidationGate();
  const validation = payload(await handleHighLevelCadTool('cad_validate_plan', { plan }, bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  const created = payload(await handleHighLevelCadTool('cad_execute_plan', { documentName }, bridge, planGate, editGate));
  assert.equal(created.success, true, JSON.stringify(created, null, 2));
  return { bridge, planGate, editGate, created, validation };
}

function diameterEdit(created, overrides = {}) {
  return {
    model_id: created.managed_model.model_id,
    model_revision: 1,
    target_feature_id: 'holes',
    parameter: 'diameter',
    old_value: 6,
    new_value: 8,
    unit: 'mm',
    ...overrides,
  };
}

async function inspectManagedHoles(bridge, documentName) {
  return payload(await bridge.run(`
doc = FreeCAD.getDocument(${JSON.stringify(documentName)})
metadata = doc.getObject("ManagedModelMetadata")
plan = json.loads(metadata.ResolvedPlanJson)
bindings = json.loads(metadata.FeatureBindingsJson)
hole_binding = bindings["holes"]
hole_sketch = doc.getObject(hole_binding["sketch_object"])
pocket = doc.getObject(hole_binding["feature_object"])
diameter_binding = hole_binding["parameters"]["diameter"]
circles = []
for name in diameter_binding["constraint_names"]:
    constraint_index = next(index for index, constraint in enumerate(hole_sketch.Constraints) if constraint.Name == name)
    geometry_index = int(hole_sketch.Constraints[constraint_index].First)
    circle = hole_sketch.Geometry[geometry_index]
    circles.append({"name": name, "x": float(circle.Center.x), "y": float(circle.Center.y), "diameter": float(circle.Radius) * 2.0})
cylinders = []
for face in pocket.Shape.Faces:
    if face.Surface.__class__.__name__ == "Cylinder":
        surface = face.Surface
        axis = surface.Axis
        if abs(axis.x) < 1e-9 and abs(axis.y) < 1e-9 and abs(abs(axis.z) - 1.0) < 1e-9:
            cylinders.append({"x": float(surface.Center.x), "y": float(surface.Center.y), "diameter": float(surface.Radius) * 2.0})
cylinders.sort(key=lambda item: (item["x"], item["y"], item["diameter"]))
base_binding = bindings["base"]
base_sketch = doc.getObject(base_binding["sketch_object"])
base_pad = doc.getObject(base_binding["feature_object"])
width_index = next(index for index, constraint in enumerate(base_sketch.Constraints) if constraint.Name == "width")
height_index = next(index for index, constraint in enumerate(base_sketch.Constraints) if constraint.Name == "height")
_mcp_result["result"] = {
    "model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest),
    "resolved_plan": plan, "bindings": bindings, "circles": circles, "cylinders": cylinders,
    "base": {"width": float(base_sketch.getDatum(width_index).Value), "height": float(base_sketch.getDatum(height_index).Value), "length": float(base_pad.Length.Value)},
    "tip": doc.getObject("Body").Tip.Name, "object_count": len(doc.Objects),
}`));
}

async function inspectManagedHoleGroups(bridge, documentName) {
  return payload(await bridge.run(`
doc = FreeCAD.getDocument(${JSON.stringify(documentName)})
metadata = doc.getObject("ManagedModelMetadata")
plan = json.loads(metadata.ResolvedPlanJson)
bindings = json.loads(metadata.FeatureBindingsJson)
groups = {}
for feature_plan in plan["features"]:
    if feature_plan["type"] != "hole_pattern":
        continue
    binding = bindings[feature_plan["id"]]
    sketch = doc.getObject(binding["sketch_object"])
    circles = []
    for name in binding["parameters"]["diameter"]["constraint_names"]:
        index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
        circle = sketch.Geometry[int(sketch.Constraints[index].First)]
        circles.append({"x": float(circle.Center.x), "y": float(circle.Center.y), "diameter": float(circle.Radius) * 2.0})
    circles.sort(key=lambda item: (item["x"], item["y"]))
    groups[feature_plan["id"]] = {"diameter": float(feature_plan["diameter"]), "circles": circles, "sketch": sketch.Name, "pocket": binding["feature_object"], "constraint_names": binding["parameters"]["diameter"]["constraint_names"]}
cylinders = []
for face in doc.getObject("Body").Tip.Shape.Faces:
    if face.Surface.__class__.__name__ == "Cylinder":
        surface = face.Surface
        cylinders.append({"x": float(surface.Center.x), "y": float(surface.Center.y), "diameter": float(surface.Radius) * 2.0})
cylinders.sort(key=lambda item: (item["x"], item["y"]))
_mcp_result["result"] = {"model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest), "resolved_plan": plan, "bindings": bindings, "groups": groups, "cylinders": cylinders, "tip": doc.getObject("Body").Tip.Name, "object_count": len(doc.Objects)}`));
}

function groupDiameterEdit(created, modelRevision, targetFeatureId, oldValue, newValue, overrides = {}) {
  return {
    model_id: created.managed_model.model_id,
    model_revision: modelRevision,
    target_feature_id: targetFeatureId,
    parameter: 'diameter',
    old_value: oldValue,
    new_value: newValue,
    unit: 'mm',
    ...overrides,
  };
}

function holePositionEdit(created, modelRevision, parameter, oldValue, newValue, overrides = {}) {
  return {
    model_id: created.managed_model.model_id,
    model_revision: modelRevision,
    target_feature_id: 'sensor_holes',
    parameter,
    old_value: oldValue,
    new_value: newValue,
    unit: 'mm',
    ...overrides,
  };
}

function widthEdit(created, overrides = {}) {
  return {
    model_id: created.managed_model.model_id,
    model_revision: 1,
    target_feature_id: 'base',
    parameter: 'width',
    old_value: 100,
    new_value: 120,
    unit: 'mm',
    ...overrides,
  };
}

function parameterEdit(created, modelRevision, parameter, oldValue, newValue, overrides = {}) {
  return {
    model_id: created.managed_model.model_id,
    model_revision: modelRevision,
    target_feature_id: 'base',
    parameter,
    old_value: oldValue,
    new_value: newValue,
    unit: 'mm',
    ...overrides,
  };
}

async function setActualParameter(bridge, documentName, parameter, value) {
  return payload(await bridge.run(`
doc = FreeCAD.getDocument(${JSON.stringify(documentName)})
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
binding = bindings["base"]
parameter_binding = binding["parameters"][${JSON.stringify(parameter)}]
sketch = doc.getObject(binding["sketch_object"])
feature = doc.getObject(binding["feature_object"])
if parameter_binding["kind"] == "sketch_constraint":
    parameter_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == parameter_binding["constraint_name"])
    sketch.setDatum(parameter_index, FreeCAD.Units.Quantity(${JSON.stringify(`${value} mm`)}))
else:
    feature.Length = ${value}
doc.recompute()
_mcp_result["result"] = {"parameter": ${JSON.stringify(parameter)}, "value": ${value}}`));
}

test('edit tool schemas expose only semantic fields and allow invalid intents to reach deterministic validation', () => {
  const validateTool = HIGH_LEVEL_CAD_TOOLS.find((tool) => tool.name === 'cad_validate_edit_plan');
  const executeTool = HIGH_LEVEL_CAD_TOOLS.find((tool) => tool.name === 'cad_execute_edit_plan');
  assert.ok(validateTool);
  assert.ok(executeTool);
  assert.deepEqual(Object.keys(validateTool.inputSchema.properties), [
    'model_id', 'model_revision', 'target_feature_id', 'parameter', 'old_value', 'new_value', 'unit',
  ]);
  assert.equal(validateTool.inputSchema.properties.parameter.enum, undefined);
  assert.equal(validateTool.inputSchema.properties.new_value.exclusiveMinimum, undefined);
  assert.deepEqual(executeTool.inputSchema.properties, {});
  assert.doesNotMatch(
    Object.keys(validateTool.inputSchema.properties).join(','),
    /constraint|sketch|feature_object|document/i,
  );
});

test('a fresh edit gate blocks execution without calling FreeCAD', async () => {
  const bridge = { async run() { throw new Error('FreeCAD must not be called'); } };
  const blocked = await handleHighLevelCadTool(
    'cad_execute_edit_plan', {}, bridge, new CadPlanValidationGate(), new CadEditValidationGate(),
  );
  assert.equal(blocked.isError, true);
  assert.equal(payload(blocked).code, 'CAD_EDIT_NOT_VALIDATED');
});

async function inspectManagedModel(bridge) {
  return payload(await bridge.run(`
doc = next(iter(FreeCAD.listDocuments().values()))
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
binding = bindings["base"]
sketch = doc.getObject(binding["sketch_object"])
feature = doc.getObject(binding["feature_object"])
width_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "width")
height_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "height")
_mcp_result["result"] = {
    "documents": list(FreeCAD.listDocuments().keys()), "document": doc.Name, "body": doc.Name + "::" + feature.getParentGeoFeatureGroup().Name,
    "width": float(sketch.getDatum(width_index).Value), "height": float(sketch.getDatum(height_index).Value), "length": float(feature.Length.Value),
    "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest), "resolved_plan": json.loads(metadata.ResolvedPlanJson),
}`));
}

async function listManagedModels(bridge) {
  return payload(await handleHighLevelCadTool(
    'cad_list_managed_models', {}, bridge, new CadPlanValidationGate(), new CadEditValidationGate(),
  ));
}

test('managed-model discovery returns an empty deterministic result without open models', async (t) => {
  const bridge = new PersistentFreeCadBridge();
  t.after(() => bridge.destroy());
  const listed = await listManagedModels(bridge);
  assert.deepEqual(listed, { models: [], issues: [] });
});

test('managed-model discovery returns actual rectangular parameters without mutating FreeCAD', async (t) => {
  const { bridge, created } = await createManagedPlate(t, 'DiscoverOne');
  const before = await inspectManagedModel(bridge);
  const objectsBefore = payload(await bridge.run(`
doc = FreeCAD.getDocument("DiscoverOne")
_mcp_result["result"] = [obj.Name for obj in doc.Objects]`));
  const listed = await listManagedModels(bridge);
  assert.deepEqual(listed.issues, []);
  assert.deepEqual(listed.models, [{
    model_id: created.managed_model.model_id,
    model_revision: 1,
    document: 'DiscoverOne',
    features: [{ id: 'base', type: 'rectangular_pad', parameters: { width: 100, height: 60, length: 10 } }],
  }]);
  const after = await inspectManagedModel(bridge);
  const objectsAfter = payload(await bridge.run(`
doc = FreeCAD.getDocument("DiscoverOne")
_mcp_result["result"] = [obj.Name for obj in doc.Objects]`));
  assert.deepEqual(after, before);
  assert.deepEqual(objectsAfter, objectsBefore);
});

test('managed-model discovery returns every valid open model in deterministic document order', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'DiscoverB');
  const validation = await handleHighLevelCadTool('cad_validate_plan', { plan: platePlan }, bridge, planGate, editGate);
  assert.equal(payload(validation).status, 'valid');
  const secondResult = await handleHighLevelCadTool('cad_execute_plan', { documentName: 'DiscoverA' }, bridge, planGate, editGate);
  const second = payload(secondResult);
  assert.equal(second.success, true, JSON.stringify(second, null, 2));
  const listed = await listManagedModels(bridge);
  assert.deepEqual(listed.issues, []);
  assert.deepEqual(listed.models.map((model) => model.document), ['DiscoverA', 'DiscoverB']);
  assert.deepEqual(new Set(listed.models.map((model) => model.model_id)), new Set([
    created.managed_model.model_id, second.managed_model.model_id,
  ]));
  assert.ok(listed.models.every((model) => model.features[0].parameters.width === 100));
});

test('managed-model discovery excludes invalid metadata and reports structured issues', async (t) => {
  const { bridge } = await createManagedPlate(t, 'DiscoverCorrupt');
  const originals = payload(await bridge.run(`
doc = FreeCAD.getDocument("DiscoverCorrupt")
metadata = doc.getObject("ManagedModelMetadata")
_mcp_result["result"] = {"plan": str(metadata.ResolvedPlanJson), "digest": str(metadata.PlanDigest), "bindings": str(metadata.FeatureBindingsJson)}`));

  const scenarios = [
    {
      code: 'MODEL_NOT_MANAGED',
      corrupt: 'metadata.IsManagedModel = False',
      restore: 'metadata.IsManagedModel = True',
    },
    {
      code: 'PLAN_DIGEST_MISMATCH',
      corrupt: 'metadata.PlanDigest = "sha256:" + "0" * 64',
      restore: `metadata.PlanDigest = ${JSON.stringify(originals.digest)}`,
    },
    {
      code: 'RESOLVED_PLAN_INVALID',
      corrupt: 'metadata.ResolvedPlanJson = "{"',
      restore: `metadata.ResolvedPlanJson = ${JSON.stringify(originals.plan)}`,
    },
    {
      code: 'BOUND_OBJECT_NOT_FOUND',
      corrupt: 'bindings = json.loads(metadata.FeatureBindingsJson)\nbindings["base"]["feature_object"] = "MissingFeature"\nmetadata.FeatureBindingsJson = json.dumps(bindings)',
      restore: `metadata.FeatureBindingsJson = ${JSON.stringify(originals.bindings)}`,
    },
  ];

  for (const scenario of scenarios) {
    await bridge.run(`
doc = FreeCAD.getDocument("DiscoverCorrupt")
metadata = doc.getObject("ManagedModelMetadata")
${scenario.corrupt}
_mcp_result["result"] = {"changed": True}`);
    const listed = await listManagedModels(bridge);
    assert.deepEqual(listed.models, []);
    assert.equal(listed.issues.length, 1);
    assert.deepEqual(
      { document: listed.issues[0].document, code: listed.issues[0].code },
      { document: 'DiscoverCorrupt', code: scenario.code },
    );
    await bridge.run(`
doc = FreeCAD.getDocument("DiscoverCorrupt")
metadata = doc.getObject("ManagedModelMetadata")
${scenario.restore}
_mcp_result["result"] = {"restored": True}`);
  }

  const restored = await listManagedModels(bridge);
  assert.equal(restored.models.length, 1);
  assert.deepEqual(restored.issues, []);
  assert.deepEqual(restored.models[0].features[0].parameters, { width: 100, height: 60, length: 10 });
});

test('V1 validates and executes base.width with independent verification and persistent save/reload', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditSuccess');
  const originalDigest = created.managed_model.plan_digest;
  const edit = widthEdit(created);

  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  assert.equal(validation.can_execute, true);
  assert.deepEqual(validation.issues, []);
  assert.deepEqual(validation.edit_plan, edit);

  const executionResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const execution = payload(executionResult);
  assert.equal(executionResult.isError, undefined);
  assert.equal(execution.success, true, JSON.stringify(execution, null, 2));
  assert.equal(execution.status, 'verified');
  assert.equal(execution.document, created.document);
  assert.equal(execution.body, created.body);
  assert.deepEqual(execution.geometry_signature.bounding_box, { x: 120, y: 60, z: 10 });
  assert.equal(execution.geometry_signature.volume, 72000);
  assert.equal(execution.managed_model.model_id, created.managed_model.model_id);
  assert.equal(execution.managed_model.model_revision, 2);
  assert.notEqual(execution.managed_model.plan_digest, originalDigest);
  assert.equal(execution.verification.passed, true);
  assert.ok(Object.values(execution.verification.checks).every((check) => check.passed));

  const state = await inspectManagedModel(bridge);
  assert.deepEqual(state.documents, ['EditSuccess']);
  assert.equal(state.document, created.document);
  assert.equal(state.body, created.body);
  assert.equal(state.width, 120);
  assert.equal(state.height, 60);
  assert.equal(state.length, 10);
  assert.equal(state.model_revision, 2);
  assert.equal(state.plan_digest, execution.managed_model.plan_digest);
  assert.equal(state.resolved_plan.features[0].width, 120);

  const stale = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
  assert.equal(stale.can_execute, false);
  assert.equal(stale.issues[0].code, 'STALE_MODEL_REVISION');

  const reload = payload(await bridge.run(`
import os
import tempfile
doc = FreeCAD.getDocument("EditSuccess")
descriptor, path = tempfile.mkstemp(suffix=".FCStd")
os.close(descriptor)
doc.saveAs(path)
FreeCAD.closeDocument(doc.Name)
reloaded = FreeCAD.openDocument(path)
metadata = reloaded.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = reloaded.getObject(bindings["base"]["sketch_object"])
width_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "width")
_mcp_result["result"] = {
    "model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest),
    "resolved_plan": json.loads(metadata.ResolvedPlanJson), "width": float(sketch.getDatum(width_index).Value),
}
FreeCAD.closeDocument(reloaded.Name)
os.remove(path)`));
  assert.equal(reload.model_id, created.managed_model.model_id);
  assert.equal(reload.model_revision, 2);
  assert.equal(reload.plan_digest, execution.managed_model.plan_digest);
  assert.equal(reload.resolved_plan.features[0].width, 120);
  assert.equal(reload.width, 120);
});

for (const scenario of [
  { parameter: 'height', oldValue: 60, newValue: 80, driftValue: 70, bounds: { x: 100, y: 80, z: 10 }, volume: 80000 },
  { parameter: 'length', oldValue: 10, newValue: 15, driftValue: 12, bounds: { x: 100, y: 60, z: 15 }, volume: 90000 },
]) {
  test(`${scenario.parameter} edit validates plan and actual state, then changes only the bound parameter`, async (t) => {
    const documentName = `Edit_${scenario.parameter}`;
    const { bridge, planGate, editGate, created } = await createManagedPlate(t, documentName);
    const edit = parameterEdit(created, 1, scenario.parameter, scenario.oldValue, scenario.newValue);

    const wrongOld = payload(await handleHighLevelCadTool(
      'cad_validate_edit_plan', { ...edit, old_value: scenario.oldValue + 1 }, bridge, planGate, editGate,
    ));
    assert.equal(wrongOld.can_execute, false);
    assert.equal(wrongOld.issues[0].code, 'OLD_VALUE_MISMATCH');

    await setActualParameter(bridge, documentName, scenario.parameter, scenario.driftValue);
    const drift = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
    assert.equal(drift.can_execute, false);
    assert.equal(drift.issues[0].code, 'MODEL_STATE_MISMATCH');
    await setActualParameter(bridge, documentName, scenario.parameter, scenario.oldValue);

    const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
    assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
    assert.equal(validation.can_execute, true);
    const executionResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
    const execution = payload(executionResult);
    assert.equal(executionResult.isError, undefined);
    assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
    assert.deepEqual(execution.geometry_signature.bounding_box, scenario.bounds);
    assert.equal(execution.geometry_signature.volume, scenario.volume);
    assert.equal(execution.managed_model.model_revision, 2);
    assert.equal(execution.managed_model.model_id, created.managed_model.model_id);
    assert.equal(execution.verification.checks[`parameter_${scenario.parameter}`].passed, true);

    const state = await inspectManagedModel(bridge);
    assert.deepEqual(state.documents, [documentName]);
    assert.equal(state[scenario.parameter], scenario.newValue);
    for (const unchanged of ['width', 'height', 'length'].filter((name) => name !== scenario.parameter)) {
      assert.equal(state[unchanged], { width: 100, height: 60, length: 10 }[unchanged]);
    }
    assert.equal(state.resolved_plan.features[0][scenario.parameter], scenario.newValue);
  });
}

test('V1 edit validation blocks invalid identities, revisions, targets, parameters and values without mutation', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditValidationFailures');
  const cases = [
    [{ old_value: 99 }, 'OLD_VALUE_MISMATCH'],
    [{ model_revision: 2 }, 'STALE_MODEL_REVISION'],
    [{ model_id: '00000000-0000-4000-8000-000000000000' }, 'MANAGED_MODEL_NOT_FOUND'],
    [{ target_feature_id: 'missing' }, 'TARGET_FEATURE_NOT_FOUND'],
    [{ parameter: 'radius' }, 'UNSUPPORTED_EDIT_PARAMETER'],
    [{ unit: 'cm' }, 'UNSUPPORTED_EDIT_UNIT'],
    [{ new_value: 0 }, 'INVALID_NEW_VALUE'],
  ];
  for (const [overrides, expectedCode] of cases) {
    const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created, overrides), bridge, planGate, editGate));
    assert.equal(validation.can_execute, false, JSON.stringify(validation, null, 2));
    assert.notEqual(validation.status, 'valid');
    assert.equal(validation.issues[0].code, expectedCode);
  }
  const blocked = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  assert.equal(blocked.isError, true);
  assert.equal(payload(blocked).code, 'CAD_EDIT_NOT_VALIDATED');
  const unchanged = await inspectManagedModel(bridge);
  assert.equal(unchanged.width, 100);
  assert.equal(unchanged.model_revision, 1);
  assert.equal(unchanged.plan_digest, created.managed_model.plan_digest);

  await bridge.run(`
doc = FreeCAD.getDocument("EditValidationFailures")
metadata = doc.getObject("ManagedModelMetadata")
metadata.IsManagedModel = False
_mcp_result["result"] = {"is_managed": bool(metadata.IsManagedModel)}`);
  const unmanaged = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created), bridge, planGate, editGate));
  assert.equal(unmanaged.can_execute, false);
  assert.equal(unmanaged.issues[0].code, 'MODEL_NOT_MANAGED');
  await bridge.run(`
doc = FreeCAD.getDocument("EditValidationFailures")
metadata = doc.getObject("ManagedModelMetadata")
metadata.IsManagedModel = True
metadata.PlanDigest = "sha256:invalid"
_mcp_result["result"] = {"is_managed": bool(metadata.IsManagedModel)}`);
  const digestMismatch = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created), bridge, planGate, editGate));
  assert.equal(digestMismatch.can_execute, false);
  assert.equal(digestMismatch.issues[0].code, 'PLAN_DIGEST_MISMATCH');
  await bridge.run(`
doc = FreeCAD.getDocument("EditValidationFailures")
metadata = doc.getObject("ManagedModelMetadata")
metadata.PlanDigest = ${JSON.stringify(created.managed_model.plan_digest)}
_mcp_result["result"] = {"plan_digest": str(metadata.PlanDigest)}`);

  await bridge.run(`
doc = FreeCAD.getDocument("EditValidationFailures")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["base"]["sketch_object"])
width_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "width")
sketch.setDatum(width_index, FreeCAD.Units.Quantity("110 mm"))
doc.recompute()
_mcp_result["result"] = {"width": float(sketch.getDatum(width_index).Value)}`);
  const mismatch = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created), bridge, planGate, editGate));
  assert.equal(mismatch.can_execute, false);
  assert.equal(mismatch.issues[0].code, 'MODEL_STATE_MISMATCH');
  const drifted = await inspectManagedModel(bridge);
  assert.equal(drifted.width, 110);
  assert.equal(drifted.model_revision, 1);
});

test('V1 edit execution rechecks model state and consumes its authorization', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditStateRace');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  await bridge.run(`
doc = FreeCAD.getDocument("EditStateRace")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["base"]["sketch_object"])
width_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "width")
sketch.setDatum(width_index, FreeCAD.Units.Quantity("110 mm"))
doc.recompute()
_mcp_result["result"] = {"width": float(sketch.getDatum(width_index).Value)}`);

  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_EXECUTION_FAILED');
  assert.match(failed.error, /MODEL_STATE_CHANGED_AFTER_VALIDATION/);
  const state = await inspectManagedModel(bridge);
  assert.equal(state.width, 110);
  assert.equal(state.model_revision, 1);
  assert.equal(state.plan_digest, created.managed_model.plan_digest);
  const retry = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  assert.equal(payload(retry).code, 'CAD_EDIT_NOT_VALIDATED');
});

test('V1 edit verification failure aborts the transaction and restores width and metadata', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditRollback');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', widthEdit(created), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const marker = '    # edit_verification_snapshot_complete';
    assert.ok(code.includes(marker));
    return code.replace(marker, '    actual_snapshot["bounding_box"]["x"] = 119.0\n' + marker);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.success, false);
  assert.equal(failed.status, 'verification_failed');
  assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  assert.equal(failed.rollback.width, 100);
  assert.equal(failed.rollback.model_revision, 1);
  assert.equal(failed.rollback.plan_digest, created.managed_model.plan_digest);
  const state = await inspectManagedModel(bridge);
  assert.equal(state.width, 100);
  assert.equal(state.height, 60);
  assert.equal(state.length, 10);
  assert.equal(state.model_revision, 1);
  assert.equal(state.plan_digest, created.managed_model.plan_digest);
  assert.equal(state.resolved_plan.features[0].width, 100);
  const retry = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  assert.equal(payload(retry).code, 'CAD_EDIT_NOT_VALIDATED');
});

for (const scenario of [
  { parameter: 'height', oldValue: 60, newValue: 80 },
  { parameter: 'length', oldValue: 10, newValue: 15 },
]) {
  test(`${scenario.parameter} verification failure rolls back the parameter and all managed metadata`, async (t) => {
    const documentName = `EditRollback_${scenario.parameter}`;
    const { bridge, planGate, editGate, created } = await createManagedPlate(t, documentName);
    const edit = parameterEdit(created, 1, scenario.parameter, scenario.oldValue, scenario.newValue);
    const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
    assert.equal(validation.can_execute, true);
    bridge.mutateNextCode((code) => {
      const marker = '    # edit_verification_snapshot_complete';
      assert.ok(code.includes(marker));
      return code.replace(marker, '    actual_snapshot["volume"] = 1.0\n' + marker);
    });
    const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
    const failed = payload(failedResult);
    assert.equal(failedResult.isError, true);
    assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
    assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
    assert.equal(failed.rollback.parameter, scenario.parameter);
    assert.equal(failed.rollback.value, scenario.oldValue);
    assert.deepEqual(
      { width: failed.rollback.width, height: failed.rollback.height, length: failed.rollback.length },
      { width: 100, height: 60, length: 10 },
    );
    assert.equal(failed.rollback.model_revision, 1);
    assert.equal(failed.rollback.plan_digest, created.managed_model.plan_digest);
    const state = await inspectManagedModel(bridge);
    assert.equal(state[scenario.parameter], scenario.oldValue);
    assert.deepEqual(
      { width: state.width, height: state.height, length: state.length },
      { width: 100, height: 60, length: 10 },
    );
    assert.equal(state.model_revision, 1);
    assert.equal(state.plan_digest, created.managed_model.plan_digest);
    assert.deepEqual(state.resolved_plan.features[0], {
      id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10,
    });
  });
}

test('sequential width, height, and length edits reach revision four and persist across save/reload', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditSequence');
  const modelId = created.managed_model.model_id;
  let previousDigest = created.managed_model.plan_digest;
  const edits = [
    parameterEdit(created, 1, 'width', 100, 120),
    parameterEdit(created, 2, 'height', 60, 80),
    parameterEdit(created, 3, 'length', 10, 15),
  ];
  for (const [index, edit] of edits.entries()) {
    const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
    assert.equal(validation.can_execute, true, JSON.stringify(validation, null, 2));
    const execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
    assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
    assert.equal(execution.managed_model.model_id, modelId);
    assert.equal(execution.managed_model.model_revision, index + 2);
    assert.notEqual(execution.managed_model.plan_digest, previousDigest);
    previousDigest = execution.managed_model.plan_digest;
    const stale = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
    assert.equal(stale.can_execute, false);
    assert.equal(stale.issues[0].code, 'STALE_MODEL_REVISION');
  }

  const finalState = await inspectManagedModel(bridge);
  assert.deepEqual(
    { width: finalState.width, height: finalState.height, length: finalState.length },
    { width: 120, height: 80, length: 15 },
  );
  assert.equal(finalState.model_revision, 4);
  assert.equal(finalState.plan_digest, previousDigest);
  assert.deepEqual(finalState.resolved_plan.features[0], {
    id: 'base', type: 'rectangular_pad', width: 120, height: 80, length: 15,
  });

  const reload = payload(await bridge.run(`
import os
import tempfile
doc = FreeCAD.getDocument("EditSequence")
descriptor, path = tempfile.mkstemp(suffix=".FCStd")
os.close(descriptor)
doc.saveAs(path)
FreeCAD.closeDocument(doc.Name)
reloaded = FreeCAD.openDocument(path)
metadata = reloaded.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
binding = bindings["base"]
sketch = reloaded.getObject(binding["sketch_object"])
feature = reloaded.getObject(binding["feature_object"])
width_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "width")
height_index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == "height")
_mcp_result["result"] = {
    "model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest),
    "resolved_plan": json.loads(metadata.ResolvedPlanJson), "width": float(sketch.getDatum(width_index).Value),
    "height": float(sketch.getDatum(height_index).Value), "length": float(feature.Length.Value), "volume": float(feature.Shape.Volume),
}
FreeCAD.closeDocument(reloaded.Name)
os.remove(path)`));
  assert.equal(reload.model_id, modelId);
  assert.equal(reload.model_revision, 4);
  assert.equal(reload.plan_digest, previousDigest);
  assert.deepEqual(
    { width: reload.width, height: reload.height, length: reload.length, volume: reload.volume },
    { width: 120, height: 80, length: 15, volume: 144000 },
  );
  assert.deepEqual(reload.resolved_plan.features[0], {
    id: 'base', type: 'rectangular_pad', width: 120, height: 80, length: 15,
  });
});

test('hole_pattern diameter edit is discovered, validated, executed, and independently verified', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HoleDiameterEdit');
  const before = await inspectManagedHoles(bridge, 'HoleDiameterEdit');
  assert.deepEqual(before.circles.map((circle) => circle.diameter), [6, 6]);
  assert.deepEqual(before.cylinders.map((cylinder) => cylinder.diameter), [6, 6]);
  assert.deepEqual(before.base, { width: 100, height: 60, length: 10 });
  assert.deepEqual(before.bindings.holes.parameters.diameter, {
    kind: 'sketch_constraints', object: 'PlanSketch_1', constraint_names: ['diameter_0', 'diameter_1'], unit: 'mm',
  });

  const discovery = await listManagedModels(bridge);
  const holes = discovery.models[0].features.find((feature) => feature.id === 'holes');
  assert.deepEqual(holes, { id: 'holes', type: 'hole_pattern', parameters: { diameter: 6 } });

  const edit = diameterEdit(created);
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', edit, bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  assert.equal(validation.can_execute, true);
  const execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.success, true, JSON.stringify(execution, null, 2));
  assert.equal(execution.status, 'verified');
  assert.equal(execution.verification.passed, true);
  for (const check of ['hole_count', 'hole_centers', 'hole_diameter', 'hole_axes', 'base_dimensions', 'binding_valid', 'feature_chain_complete']) {
    assert.equal(execution.verification.checks[check].passed, true, check);
  }
  assert.equal(execution.managed_model.model_id, created.managed_model.model_id);
  assert.equal(execution.managed_model.model_revision, 2);
  assert.notEqual(execution.managed_model.plan_digest, created.managed_model.plan_digest);
  assert.deepEqual(execution.geometry_signature.surfaces.cylindrical.filter((surface) => surface.surface_role === 'hole').map((surface) => surface.radius), [4, 4]);

  const after = await inspectManagedHoles(bridge, 'HoleDiameterEdit');
  assert.deepEqual(after.circles.map((circle) => circle.diameter), [8, 8]);
  assert.deepEqual(after.cylinders.map((cylinder) => cylinder.diameter), [8, 8]);
  assert.deepEqual(after.cylinders.map(({ x, y }) => ({ x, y })), before.cylinders.map(({ x, y }) => ({ x, y })));
  assert.deepEqual(after.base, before.base);
  assert.equal(after.object_count, before.object_count);
  assert.equal(after.tip, before.tip);
  assert.equal(after.resolved_plan.features.find((feature) => feature.id === 'holes').diameter, 8);
});

test('hole diameter validation blocks wrong old value, actual constraint drift, and damaged binding', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HoleDiameterInvalid');
  const wrongOld = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created, { old_value: 7 }), bridge, planGate, editGate));
  assert.equal(wrongOld.can_execute, false);
  assert.equal(wrongOld.issues[0].code, 'OLD_VALUE_MISMATCH');

  await bridge.run(`
doc = FreeCAD.getDocument("HoleDiameterInvalid")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["holes"]["sketch_object"])
name = bindings["holes"]["parameters"]["diameter"]["constraint_names"][0]
index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
sketch.setDatum(index, FreeCAD.Units.Quantity("7 mm"))
doc.recompute()
_mcp_result["result"] = True`);
  const drift = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created), bridge, planGate, editGate));
  assert.equal(drift.can_execute, false);
  assert.equal(drift.issues[0].code, 'MODEL_STATE_MISMATCH');

  await bridge.run(`
doc = FreeCAD.getDocument("HoleDiameterInvalid")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["holes"]["sketch_object"])
name = bindings["holes"]["parameters"]["diameter"]["constraint_names"][0]
index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
sketch.setDatum(index, FreeCAD.Units.Quantity("6 mm"))
bindings["holes"]["parameters"]["diameter"]["constraint_names"][0] = "missing_diameter"
metadata.FeatureBindingsJson = json.dumps(bindings, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
doc.recompute()
_mcp_result["result"] = True`);
  const damaged = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created), bridge, planGate, editGate));
  assert.equal(damaged.can_execute, false);
  assert.equal(damaged.issues[0].code, 'FEATURE_BINDING_INVALID');
});

test('hole diameter geometric validation blocks boundary intersection and hole contact without mutation', async (t) => {
  const first = await createManagedHoledPlate(t, 'HoleDiameterBoundary');
  const firstBefore = await inspectManagedHoles(first.bridge, 'HoleDiameterBoundary');
  const boundary = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(first.created, { new_value: 42 }), first.bridge, first.planGate, first.editGate));
  assert.equal(boundary.can_execute, false);
  assert.ok(boundary.issues.some((item) => item.code === 'HOLE_OUTSIDE_BASE'));
  assert.deepEqual(await inspectManagedHoles(first.bridge, 'HoleDiameterBoundary'), firstBefore);

  const closeCentersPlan = {
    unit: 'mm',
    features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [{ x: 30, y: 30 }, { x: 42, y: 30 }] }, operation: 'through_all', after: 'base' },
    ],
  };
  const second = await createManagedHoledPlate(t, 'HoleDiameterContact', closeCentersPlan);
  const secondBefore = await inspectManagedHoles(second.bridge, 'HoleDiameterContact');
  const overlap = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(second.created, { new_value: 12 }), second.bridge, second.planGate, second.editGate));
  assert.equal(overlap.can_execute, false);
  assert.ok(overlap.issues.some((item) => item.code === 'HOLES_OVERLAP'));
  assert.deepEqual(await inspectManagedHoles(second.bridge, 'HoleDiameterContact'), secondBefore);
});

test('hole diameter verification failure explicitly restores geometry and managed metadata', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HoleDiameterRollback');
  const before = await inspectManagedHoles(bridge, 'HoleDiameterRollback');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const marker = '    # edit_verification_snapshot_complete';
    assert.ok(code.includes(marker));
    return code.replace(marker, '    actual_snapshot["holes"][0]["radius"] = 99.0\n' + marker);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  assert.equal(failed.rollback.diameter, 6);
  assert.equal(failed.rollback.model_revision, 1);
  assert.equal(failed.rollback.plan_digest, created.managed_model.plan_digest);
  const after = await inspectManagedHoles(bridge, 'HoleDiameterRollback');
  assert.deepEqual(after.circles, before.circles);
  assert.deepEqual(after.cylinders, before.cylinders);
  assert.deepEqual(after.base, before.base);
  assert.equal(after.model_revision, before.model_revision);
  assert.equal(after.plan_digest, before.plan_digest);
});

test('hole diameter execution failure after mutation explicitly restores original BREP', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HoleDiameterExecutionRollback');
  const before = await inspectManagedHoles(bridge, 'HoleDiameterExecutionRollback');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const marker = '    # edit_verification_snapshot_start';
    assert.ok(code.includes(marker));
    return code.replace(marker, '    raise RuntimeError("SIMULATED_POST_MUTATION_FAILURE")\n' + marker);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_EXECUTION_FAILED');
  assert.match(failed.error, /SIMULATED_POST_MUTATION_FAILURE/);
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  const after = await inspectManagedHoles(bridge, 'HoleDiameterExecutionRollback');
  assert.deepEqual(after.circles, before.circles);
  assert.deepEqual(after.cylinders, before.cylinders);
  assert.deepEqual(after.base, before.base);
  assert.equal(after.model_revision, 1);
  assert.equal(after.plan_digest, created.managed_model.plan_digest);
});

test('successful hole diameter edit persists model identity, revision, digest, plan, binding, and BREP after save/reload', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HoleDiameterReload');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', diameterEdit(created), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  const execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  const reload = payload(await bridge.run(`
import os
import tempfile
doc = FreeCAD.getDocument("HoleDiameterReload")
descriptor, path = tempfile.mkstemp(suffix=".FCStd")
os.close(descriptor)
doc.saveAs(path)
FreeCAD.closeDocument(doc.Name)
reloaded = FreeCAD.openDocument(path)
metadata = reloaded.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
binding = bindings["holes"]
sketch = reloaded.getObject(binding["sketch_object"])
diameters = []
for name in binding["parameters"]["diameter"]["constraint_names"]:
    index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
    geometry = sketch.Geometry[int(sketch.Constraints[index].First)]
    diameters.append(float(geometry.Radius) * 2.0)
cylinder_diameters = sorted([float(face.Surface.Radius) * 2.0 for face in reloaded.getObject(binding["feature_object"]).Shape.Faces if face.Surface.__class__.__name__ == "Cylinder"])
_mcp_result["result"] = {"model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest), "resolved_plan": json.loads(metadata.ResolvedPlanJson), "binding": binding, "diameters": diameters, "cylinder_diameters": cylinder_diameters}
FreeCAD.closeDocument(reloaded.Name)
os.remove(path)`));
  assert.equal(reload.model_id, created.managed_model.model_id);
  assert.equal(reload.model_revision, 2);
  assert.equal(reload.plan_digest, execution.managed_model.plan_digest);
  assert.equal(reload.resolved_plan.features.find((feature) => feature.id === 'holes').diameter, 8);
  assert.deepEqual(reload.binding.parameters.diameter.constraint_names, ['diameter_0', 'diameter_1']);
  assert.deepEqual(reload.diameters, [8, 8]);
  assert.deepEqual(reload.cylinder_diameters, [8, 8]);
});

test('two hole patterns execute sequentially and can be edited independently across revisions', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'MultiHoleEdit', multiHolePlan);
  assert.deepEqual(created.executed_steps, ['base', 'mounting_holes', 'sensor_holes']);
  assert.equal(created.verification.bodyTip, 'PlanFeature_2');
  assert.equal(created.geometry_signature.surfaces.cylindrical.filter((surface) => surface.surface_role === 'hole').length, 5);
  const before = await inspectManagedHoleGroups(bridge, 'MultiHoleEdit');
  assert.equal(before.tip, 'PlanFeature_2');
  assert.deepEqual(Object.keys(before.groups), ['mounting_holes', 'sensor_holes']);
  assert.deepEqual(before.groups.mounting_holes.circles.map((hole) => hole.diameter), [6, 6, 6, 6]);
  assert.deepEqual(before.groups.sensor_holes.circles.map((hole) => hole.diameter), [4]);
  const discovery = await listManagedModels(bridge);
  assert.deepEqual(discovery.models[0].features.filter((feature) => feature.type === 'hole_pattern'), [
    { id: 'mounting_holes', type: 'hole_pattern', parameters: { diameter: 6 } },
    { id: 'sensor_holes', type: 'hole_pattern', parameters: { diameter: 4, center_x: 50, center_y: 30 } },
  ]);

  const mountingEdit = groupDiameterEdit(created, 1, 'mounting_holes', 6, 8);
  const mountingValidation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', mountingEdit, bridge, planGate, editGate));
  assert.equal(mountingValidation.status, 'valid', JSON.stringify(mountingValidation, null, 2));
  const mountingExecution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(mountingExecution.status, 'verified', JSON.stringify(mountingExecution, null, 2));
  assert.equal(mountingExecution.managed_model.model_id, created.managed_model.model_id);
  assert.equal(mountingExecution.managed_model.model_revision, 2);
  assert.equal(mountingExecution.verification.checks.hole_groups.passed, true);
  let state = await inspectManagedHoleGroups(bridge, 'MultiHoleEdit');
  assert.deepEqual(state.groups.mounting_holes.circles.map((hole) => hole.diameter), [8, 8, 8, 8]);
  assert.deepEqual(state.groups.sensor_holes.circles.map((hole) => hole.diameter), [4]);
  assert.deepEqual(state.cylinders.map((hole) => hole.diameter), [8, 8, 4, 8, 8]);
  assert.deepEqual(state.cylinders.map(({ x, y }) => ({ x, y })), before.cylinders.map(({ x, y }) => ({ x, y })));
  assert.equal(state.object_count, before.object_count);

  const stale = payload(await handleHighLevelCadTool('cad_validate_edit_plan', mountingEdit, bridge, planGate, editGate));
  assert.equal(stale.can_execute, false);
  assert.equal(stale.issues[0].code, 'STALE_MODEL_REVISION');
  const missing = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 2, 'missing_holes', 4, 5), bridge, planGate, editGate));
  assert.equal(missing.can_execute, false);
  assert.equal(missing.issues[0].code, 'TARGET_FEATURE_NOT_FOUND');
  const wrongType = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 2, 'base', 100, 110), bridge, planGate, editGate));
  assert.equal(wrongType.can_execute, false);
  assert.equal(wrongType.issues[0].code, 'UNSUPPORTED_EDIT_PARAMETER');

  const sensorEdit = groupDiameterEdit(created, 2, 'sensor_holes', 4, 5);
  const sensorValidation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', sensorEdit, bridge, planGate, editGate));
  assert.equal(sensorValidation.status, 'valid', JSON.stringify(sensorValidation, null, 2));
  const sensorExecution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(sensorExecution.status, 'verified', JSON.stringify(sensorExecution, null, 2));
  assert.equal(sensorExecution.managed_model.model_revision, 3);
  state = await inspectManagedHoleGroups(bridge, 'MultiHoleEdit');
  assert.deepEqual(state.groups.mounting_holes.circles.map((hole) => hole.diameter), [8, 8, 8, 8]);
  assert.deepEqual(state.groups.sensor_holes.circles.map((hole) => hole.diameter), [5]);
});

test('Expanded Body state does not fail a real multi-hole sensor diameter edit', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'ExpandedBodyEdit', multiHolePlan);
  let validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 1, 'mounting_holes', 6, 8), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  const mountingExecution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(mountingExecution.status, 'verified', JSON.stringify(mountingExecution, null, 2));

  validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 2, 'sensor_holes', 4, 6), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const original = 'recompute_errors = [{"object": obj.Name, "states": cad_object_error_states(obj)} for obj in doc.Objects]';
    const expanded = 'recompute_errors = [{"object": obj.Name, "states": (cad_error_states_from_state_strings(list(obj.State) + ["Expanded"]) if obj.Name == "Body" else cad_object_error_states(obj))} for obj in doc.Objects]';
    assert.ok(code.includes(original));
    return code.replace(original, expanded);
  });
  const executionResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const execution = payload(executionResult);
  assert.equal(executionResult.isError, undefined);
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  assert.deepEqual(execution.verification.checks.recompute_errors.actual, []);
  assert.equal(execution.managed_model.model_revision, 3);
  assert.equal(execution.rollback, undefined);
  const state = await inspectManagedHoleGroups(bridge, 'ExpandedBodyEdit');
  assert.deepEqual(state.groups.mounting_holes.circles.map((hole) => hole.diameter), [8, 8, 8, 8]);
  assert.deepEqual(state.groups.sensor_holes.circles.map((hole) => hole.diameter), [6]);
});

test('a real FreeCAD recompute failure remains Invalid and blocks edit verification', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'InvalidFeatureEdit', multiHolePlan);
  const before = await inspectManagedHoleGroups(bridge, 'InvalidFeatureEdit');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 1, 'sensor_holes', 4, 6), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const marker = '    doc.recompute()\n    # edit_verification_snapshot_start';
    assert.ok(code.includes(marker));
    return code.replace(marker, `    class _CadBrokenProxy:
        def execute(self, obj):
            raise RuntimeError("intentional recompute failure")
    broken = doc.addObject("PartDesign::FeaturePython", "InjectedBrokenFeature")
    broken.Proxy = _CadBrokenProxy()
    broken.touch()
    doc.recompute()
    # edit_verification_snapshot_start`);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
  const recomputeIssue = failed.issues.find((issue) => issue.check === 'recompute_errors');
  assert.ok(recomputeIssue, JSON.stringify(failed, null, 2));
  assert.deepEqual(recomputeIssue.actual, [{ object: 'InjectedBrokenFeature', states: ['Invalid'] }]);
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  await bridge.run(`
doc = FreeCAD.getDocument("InvalidFeatureEdit")
doc.removeObject("InjectedBrokenFeature")
doc.recompute()
_mcp_result["result"] = True`);
  assert.deepEqual(await inspectManagedHoleGroups(bridge, 'InvalidFeatureEdit'), before);
});

test('multi-hole validation detects binding damage, isolated constraint drift, and cross-group edit collisions', async (t) => {
  const first = await createManagedHoledPlate(t, 'MultiHoleInvalid', multiHolePlan);
  await first.bridge.run(`
doc = FreeCAD.getDocument("MultiHoleInvalid")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["sensor_holes"]["sketch_object"])
name = bindings["sensor_holes"]["parameters"]["diameter"]["constraint_names"][0]
index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
sketch.setDatum(index, FreeCAD.Units.Quantity("4.5 mm"))
doc.recompute()
_mcp_result["result"] = True`);
  const drift = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(first.created, 1, 'sensor_holes', 4, 5), first.bridge, first.planGate, first.editGate));
  assert.equal(drift.can_execute, false);
  assert.equal(drift.issues[0].code, 'MODEL_STATE_MISMATCH');
  await first.bridge.run(`
doc = FreeCAD.getDocument("MultiHoleInvalid")
metadata = doc.getObject("ManagedModelMetadata")
bindings = json.loads(metadata.FeatureBindingsJson)
sketch = doc.getObject(bindings["sensor_holes"]["sketch_object"])
name = bindings["sensor_holes"]["parameters"]["diameter"]["constraint_names"][0]
index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
sketch.setDatum(index, FreeCAD.Units.Quantity("4 mm"))
bindings["mounting_holes"]["parameters"]["diameter"]["constraint_names"][0] = "missing"
metadata.FeatureBindingsJson = json.dumps(bindings, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
doc.recompute()
_mcp_result["result"] = True`);
  const damaged = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(first.created, 1, 'mounting_holes', 6, 8), first.bridge, first.planGate, first.editGate));
  assert.equal(damaged.can_execute, false);
  assert.equal(damaged.issues[0].code, 'FEATURE_BINDING_INVALID');

  const collisionPlan = {
    unit: 'mm', features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'mounting_holes', type: 'hole_pattern', diameter: 6, placement: { type: 'explicit', centers: [[30, 30]] }, operation: 'through_all', after: 'base' },
      { id: 'sensor_holes', type: 'hole_pattern', diameter: 4, placement: { type: 'explicit', centers: [[42, 30]] }, operation: 'through_all', after: 'mounting_holes' },
    ],
  };
  const second = await createManagedHoledPlate(t, 'MultiHoleCollision', collisionPlan);
  const before = await inspectManagedHoleGroups(second.bridge, 'MultiHoleCollision');
  const collision = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(second.created, 1, 'mounting_holes', 6, 20), second.bridge, second.planGate, second.editGate));
  assert.equal(collision.can_execute, false);
  assert.ok(collision.issues.some((issue) => issue.code === 'HOLES_OVERLAP'));
  assert.deepEqual(await inspectManagedHoleGroups(second.bridge, 'MultiHoleCollision'), before);
});

test('multi-hole verification rollback restores only the target constraints and the complete original model', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'MultiHoleRollback', multiHolePlan);
  const before = await inspectManagedHoleGroups(bridge, 'MultiHoleRollback');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 1, 'mounting_holes', 6, 8), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  bridge.mutateNextCode((code) => {
    const marker = '    # edit_verification_snapshot_complete';
    assert.ok(code.includes(marker));
    return code.replace(marker, '    actual_snapshot["volume"] = 1.0\n' + marker);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  const after = await inspectManagedHoleGroups(bridge, 'MultiHoleRollback');
  assert.deepEqual(after.groups, before.groups);
  assert.deepEqual(after.cylinders, before.cylinders);
  assert.equal(after.model_revision, before.model_revision);
  assert.equal(after.plan_digest, before.plan_digest);
  assert.deepEqual(after.resolved_plan, before.resolved_plan);
});

test('two hole pattern bindings and edited geometry survive FCStd save and reload', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'MultiHoleReload', multiHolePlan);
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(created, 1, 'mounting_holes', 6, 8), bridge, planGate, editGate));
  assert.equal(validation.can_execute, true);
  const execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  const reload = payload(await bridge.run(`
import os
import tempfile
doc = FreeCAD.getDocument("MultiHoleReload")
descriptor, path = tempfile.mkstemp(suffix=".FCStd")
os.close(descriptor)
doc.saveAs(path)
FreeCAD.closeDocument(doc.Name)
reloaded = FreeCAD.openDocument(path)
metadata = reloaded.getObject("ManagedModelMetadata")
plan = json.loads(metadata.ResolvedPlanJson)
bindings = json.loads(metadata.FeatureBindingsJson)
groups = {}
for item in plan["features"]:
    if item["type"] != "hole_pattern": continue
    binding = bindings[item["id"]]
    sketch = reloaded.getObject(binding["sketch_object"])
    diameters = []
    for name in binding["parameters"]["diameter"]["constraint_names"]:
        index = next(index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name)
        diameters.append(float(sketch.Geometry[int(sketch.Constraints[index].First)].Radius) * 2.0)
    groups[item["id"]] = {"sketch": sketch.Name, "pocket": binding["feature_object"], "constraint_names": binding["parameters"]["diameter"]["constraint_names"], "diameters": diameters}
_mcp_result["result"] = {"model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest), "plan": plan, "groups": groups, "tip": reloaded.getObject("Body").Tip.Name}
FreeCAD.closeDocument(reloaded.Name)
os.remove(path)`));
  assert.equal(reload.model_id, created.managed_model.model_id);
  assert.equal(reload.model_revision, 2);
  assert.equal(reload.plan_digest, execution.managed_model.plan_digest);
  assert.equal(reload.plan.features.find((feature) => feature.id === 'mounting_holes').diameter, 8);
  assert.equal(reload.plan.features.find((feature) => feature.id === 'sensor_holes').diameter, 4);
  assert.deepEqual(reload.groups.mounting_holes.diameters, [8, 8, 8, 8]);
  assert.deepEqual(reload.groups.sensor_holes.diameters, [4]);
  assert.equal(reload.tip, 'PlanFeature_2');
});

test('singleton explicit sensor hole center_x and center_y edits are in-place and BREP-verified', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HolePositionEdit', positionEditPlan);
  const before = await inspectManagedHoleGroups(bridge, 'HolePositionEdit');
  const discovery = await listManagedModels(bridge);
  assert.deepEqual(discovery.models[0].features.filter((feature) => feature.type === 'hole_pattern'), [
    { id: 'mounting_holes', type: 'hole_pattern', parameters: { diameter: 9 } },
    { id: 'sensor_holes', type: 'hole_pattern', parameters: { diameter: 9, center_x: 50, center_y: 30 } },
  ]);

  const xEdit = holePositionEdit(created, 1, 'center_x', 50, 60);
  let validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', xEdit, bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  let execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  assert.equal(execution.managed_model.model_revision, 2);
  assert.equal(execution.rollback, undefined);
  assert.equal(execution.verification.checks.parameter_center_x.passed, true);
  assert.equal(execution.verification.checks.hole_centers.passed, true);
  assert.deepEqual(execution.geometry_signature.bounding_box, { x: 100, y: 60, z: 10 });
  assert.deepEqual(execution.verification.checks.recompute_errors.actual, []);
  let state = await inspectManagedHoleGroups(bridge, 'HolePositionEdit');
  assert.deepEqual(state.groups.mounting_holes.circles, before.groups.mounting_holes.circles);
  assert.deepEqual(state.groups.sensor_holes.circles, [{ x: 60, y: 30, diameter: 9 }]);
  assert.equal(state.cylinders.some((hole) => hole.x === 50 && hole.y === 30), false);
  assert.equal(state.object_count, before.object_count);
  assert.equal(state.tip, before.tip);

  validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(created, 2, 'center_y', 30, 35), bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  assert.equal(execution.managed_model.model_revision, 3);
  assert.equal(execution.verification.checks.parameter_center_y.passed, true);
  state = await inspectManagedHoleGroups(bridge, 'HolePositionEdit');
  assert.deepEqual(state.groups.sensor_holes.circles, [{ x: 60, y: 35, diameter: 9 }]);
  assert.deepEqual(state.groups.mounting_holes.circles, before.groups.mounting_holes.circles);

  const stale = payload(await handleHighLevelCadTool('cad_validate_edit_plan', xEdit, bridge, planGate, editGate));
  assert.equal(stale.can_execute, false);
  assert.equal(stale.issues[0].code, 'STALE_MODEL_REVISION');
  const mismatch = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(created, 3, 'center_x', 50, 65), bridge, planGate, editGate));
  assert.equal(mismatch.can_execute, false);
  assert.equal(mismatch.issues[0].code, 'OLD_VALUE_MISMATCH');
});

test('hole position validation blocks boundary, cross-group collision, and multi-hole targets without mutation', async (t) => {
  const boundaryCase = await createManagedHoledPlate(t, 'HolePositionBoundary', positionEditPlan);
  const boundaryBefore = await inspectManagedHoleGroups(boundaryCase.bridge, 'HolePositionBoundary');
  const boundary = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(boundaryCase.created, 1, 'center_x', 50, 96), boundaryCase.bridge, boundaryCase.planGate, boundaryCase.editGate));
  assert.equal(boundary.can_execute, false);
  assert.ok(boundary.issues.some((issue) => issue.code === 'HOLE_OUTSIDE_BASE'));
  assert.deepEqual(await inspectManagedHoleGroups(boundaryCase.bridge, 'HolePositionBoundary'), boundaryBefore);

  const collisionPlan = structuredClone(positionEditPlan);
  collisionPlan.features[1].placement.centers = [[15, 15], [15, 45], [65, 30], [85, 45]];
  const collisionCase = await createManagedHoledPlate(t, 'HolePositionCollision', collisionPlan);
  const collisionBefore = await inspectManagedHoleGroups(collisionCase.bridge, 'HolePositionCollision');
  const collision = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(collisionCase.created, 1, 'center_x', 50, 60), collisionCase.bridge, collisionCase.planGate, collisionCase.editGate));
  assert.equal(collision.can_execute, false);
  assert.ok(collision.issues.some((issue) => issue.code === 'HOLES_OVERLAP'));
  assert.deepEqual(await inspectManagedHoleGroups(collisionCase.bridge, 'HolePositionCollision'), collisionBefore);

  const multiBefore = await inspectManagedHoleGroups(boundaryCase.bridge, 'HolePositionBoundary');
  const multi = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(boundaryCase.created, 1, 'center_x', 15, 20, { target_feature_id: 'mounting_holes' }), boundaryCase.bridge, boundaryCase.planGate, boundaryCase.editGate));
  assert.equal(multi.can_execute, false);
  assert.equal(multi.issues[0].code, 'SINGLE_EXPLICIT_HOLE_REQUIRED');
  assert.deepEqual(await inspectManagedHoleGroups(boundaryCase.bridge, 'HolePositionBoundary'), multiBefore);
});

test('singleton grid and legacy singleton models do not expose or authorize position edits', async (t) => {
  const gridPlan = {
    unit: 'mm', features: [
      { id: 'base', type: 'rectangular_pad', width: 100, height: 60, length: 10 },
      { id: 'sensor_holes', type: 'hole_pattern', diameter: 9, placement: { type: 'rectangular_grid', origin: { x: 50, y: 30 }, columns: 1, rows: 1, spacing_x: 10, spacing_y: 10 }, operation: 'through_all', after: 'base' },
    ],
  };
  const grid = await createManagedHoledPlate(t, 'SingletonGridPosition', gridPlan);
  const gridDiscovery = await listManagedModels(grid.bridge);
  assert.deepEqual(gridDiscovery.models[0].features[1].parameters, { diameter: 9 });
  const gridEdit = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(grid.created, 1, 'center_x', 50, 60), grid.bridge, grid.planGate, grid.editGate));
  assert.equal(gridEdit.can_execute, false);
  assert.equal(gridEdit.issues[0].code, 'SINGLE_EXPLICIT_HOLE_REQUIRED');

  const legacy = await createManagedHoledPlate(t, 'LegacySingletonPosition', positionEditPlan);
  await legacy.bridge.run(`
import hashlib
doc = FreeCAD.getDocument("LegacySingletonPosition")
metadata = doc.getObject("ManagedModelMetadata")
plan = json.loads(metadata.ResolvedPlanJson)
bindings = json.loads(metadata.FeatureBindingsJson)
sensor = next(item for item in plan["features"] if item["id"] == "sensor_holes")
sensor.pop("center_editable", None)
bindings["sensor_holes"]["parameters"].pop("center_x", None)
bindings["sensor_holes"]["parameters"].pop("center_y", None)
canonical = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
metadata.ResolvedPlanJson = canonical
metadata.PlanDigest = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
metadata.FeatureBindingsJson = json.dumps(bindings, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
doc.recompute()
_mcp_result["result"] = True`);
  const legacyDiscovery = await listManagedModels(legacy.bridge);
  assert.deepEqual(legacyDiscovery.models[0].features.find((feature) => feature.id === 'sensor_holes').parameters, { diameter: 9 });
  const diameter = payload(await handleHighLevelCadTool('cad_validate_edit_plan', groupDiameterEdit(legacy.created, 1, 'sensor_holes', 9, 8), legacy.bridge, legacy.planGate, legacy.editGate));
  assert.equal(diameter.status, 'valid', JSON.stringify(diameter, null, 2));
  const center = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(legacy.created, 1, 'center_x', 50, 60), legacy.bridge, legacy.planGate, legacy.editGate));
  assert.equal(center.can_execute, false);
  assert.equal(center.issues[0].code, 'SINGLE_EXPLICIT_HOLE_REQUIRED');
});

test('position verification failure explicitly restores center, complete BREP, plan, digest, and revision', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HolePositionRollback', positionEditPlan);
  const before = await inspectManagedHoleGroups(bridge, 'HolePositionRollback');
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(created, 1, 'center_x', 50, 60), bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  bridge.mutateNextCode((code) => {
    const marker = '    # edit_verification_snapshot_complete';
    assert.ok(code.includes(marker));
    return code.replace(marker, '    actual_snapshot["volume"] = 1.0\n' + marker);
  });
  const failedResult = await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate);
  const failed = payload(failedResult);
  assert.equal(failedResult.isError, true);
  assert.equal(failed.code, 'CAD_EDIT_VERIFICATION_FAILED');
  assert.equal(failed.rollback.passed, true, JSON.stringify(failed, null, 2));
  assert.equal(failed.rollback.center_x, 50);
  assert.equal(failed.rollback.center_y, 30);
  const after = await inspectManagedHoleGroups(bridge, 'HolePositionRollback');
  assert.deepEqual(after, before);
});

test('position bindings survive FCStd save/reload and authorize a subsequent verified edit', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedHoledPlate(t, 'HolePositionReload', positionEditPlan);
  const reload = payload(await bridge.run(`
import os
import tempfile
doc = FreeCAD.getDocument("HolePositionReload")
descriptor, path = tempfile.mkstemp(suffix=".FCStd")
os.close(descriptor)
doc.saveAs(path)
FreeCAD.closeDocument(doc.Name)
reloaded = FreeCAD.openDocument(path)
_mcp_result["result"] = {"document": reloaded.Name, "path": path}`));
  assert.equal(typeof reload.document, 'string');
  const discovery = await listManagedModels(bridge);
  const sensor = discovery.models[0].features.find((feature) => feature.id === 'sensor_holes');
  assert.deepEqual(sensor.parameters, { diameter: 9, center_x: 50, center_y: 30 });
  const validation = payload(await handleHighLevelCadTool('cad_validate_edit_plan', holePositionEdit(created, 1, 'center_x', 50, 60), bridge, planGate, editGate));
  assert.equal(validation.status, 'valid', JSON.stringify(validation, null, 2));
  const execution = payload(await handleHighLevelCadTool('cad_execute_edit_plan', {}, bridge, planGate, editGate));
  assert.equal(execution.status, 'verified', JSON.stringify(execution, null, 2));
  assert.equal(execution.managed_model.model_revision, 2);
  const state = await inspectManagedHoleGroups(bridge, reload.document);
  assert.deepEqual(state.groups.sensor_holes.circles, [{ x: 60, y: 30, diameter: 9 }]);
  await bridge.run(`
import os
doc = FreeCAD.getDocument(${JSON.stringify(reload.document)})
path = ${JSON.stringify(reload.path)}
FreeCAD.closeDocument(doc.Name)
os.remove(path)
_mcp_result["result"] = True`);
});
