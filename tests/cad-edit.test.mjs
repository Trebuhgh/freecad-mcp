import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { CadEditValidationGate } from '../dist/tools/cad-edit.js';
import { HIGH_LEVEL_CAD_TOOLS, handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';

const freecadPython = process.env.FREECAD_PYTHON || 'C:\\Program Files\\FreeCAD 1.1\\bin\\python.exe';
const platePlan = { shape: 'plate', size: [100, 60, 10], unit: 'mm' };

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
  assert.doesNotMatch(JSON.stringify(validateTool.inputSchema), /constraint|sketch|feature_object|document/i);
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

test('V1 edit validation blocks invalid identities, revisions, targets, parameters and values without mutation', async (t) => {
  const { bridge, planGate, editGate, created } = await createManagedPlate(t, 'EditValidationFailures');
  const cases = [
    [{ old_value: 99 }, 'OLD_VALUE_MISMATCH'],
    [{ model_revision: 2 }, 'STALE_MODEL_REVISION'],
    [{ model_id: '00000000-0000-4000-8000-000000000000' }, 'MANAGED_MODEL_NOT_FOUND'],
    [{ target_feature_id: 'missing' }, 'TARGET_FEATURE_NOT_FOUND'],
    [{ parameter: 'height' }, 'UNSUPPORTED_EDIT_PARAMETER'],
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
