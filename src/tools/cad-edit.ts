import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import {
  AREA_TOLERANCE_MM2,
  DIRECTION_VECTOR_EPSILON_MM,
  LINEAR_TOLERANCE_MM,
  VOLUME_TOLERANCE_MM3,
} from './cad-geometry-tolerances.js';
import { cadGeometryInspectionPython } from './cad-geometry-inspection-python.js';

type EditStatus = 'valid' | 'invalid' | 'unsupported';

interface EditIssue {
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

interface EditPlan {
  model_id: string;
  model_revision: number;
  target_feature_id: string;
  parameter: 'width' | 'height' | 'length';
  old_value: number;
  new_value: number;
  unit: 'mm';
}

interface EditValidationResult {
  status: EditStatus;
  can_execute: boolean;
  issues: EditIssue[];
  edit_plan?: EditPlan;
}

interface ValidatedEdit {
  editPlan: EditPlan;
  sourceResolvedPlan: Record<string, unknown>;
  sourcePlanDigest: string;
  expectedResolvedPlan: Record<string, unknown>;
  expectedPlanDigest: string;
}

type EditGateState = 'unvalidated' | 'blocked' | 'validated';

export class CadEditValidationGate {
  private currentState: EditGateState = 'unvalidated';
  private validationRevision = 0;
  private current?: ValidatedEdit;
  private executingRevision?: number;

  get state(): EditGateState {
    return this.currentState;
  }

  beginValidation(): number {
    if (this.executingRevision !== undefined) {
      throw new Error('CAD_EDIT_EXECUTION_IN_PROGRESS: validation cannot replace an edit during execution');
    }
    this.validationRevision += 1;
    this.currentState = 'blocked';
    this.current = undefined;
    return this.validationRevision;
  }

  completeValidation(revision: number, validated?: ValidatedEdit): void {
    if (revision !== this.validationRevision) return;
    if (validated === undefined) {
      this.currentState = 'blocked';
      this.current = undefined;
      return;
    }
    this.currentState = 'validated';
    this.current = structuredClone(validated);
  }

  beginExecution(): { revision: number; validated: ValidatedEdit } | undefined {
    if (this.currentState !== 'validated' || this.current === undefined || this.executingRevision !== undefined) return undefined;
    this.executingRevision = this.validationRevision;
    return { revision: this.validationRevision, validated: structuredClone(this.current) };
  }

  endExecution(revision: number): void {
    if (this.executingRevision !== revision) return;
    this.executingRevision = undefined;
    this.currentState = 'blocked';
    this.current = undefined;
  }
}

const editPlanProperties = {
  model_id: { type: 'string', description: 'Persistent managed-model UUID returned by cad_execute_plan.' },
  model_revision: { type: 'integer', description: 'Exact optimistic-concurrency revision currently stored by the managed model.' },
  target_feature_id: { type: 'string', description: 'Semantic feature ID from the resolved plan, for V1: base.' },
  parameter: { type: 'string', description: 'Requested semantic parameter. Validation accepts rectangular_pad width, height, or length.' },
  old_value: { type: 'number', description: 'Expected current parameter value in mm.' },
  new_value: { type: 'number', description: 'Requested new parameter value in mm; validation requires a positive finite value.' },
  unit: { type: 'string', description: 'Requested unit. Validation currently accepts only millimetres.' },
};

export const CAD_EDIT_TOOLS = [{
  name: 'cad_validate_edit_plan',
  description: 'Non-mutating validation gate for one semantic edit of an existing managed model. Supports rectangular_pad width, height, or length. Never provide FreeCAD object names or constraint indices.',
  inputSchema: {
    type: 'object' as const,
    properties: editPlanProperties,
    additionalProperties: false,
    required: ['model_id', 'model_revision', 'target_feature_id', 'parameter', 'old_value', 'new_value', 'unit'],
  },
}, {
  name: 'cad_execute_edit_plan',
  description: 'Execute and independently verify exactly the edit stored by the latest successful cad_validate_edit_plan call. Accepts no edit overrides.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
    required: [],
  },
}];

function result(value: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function issue(status: Exclude<EditStatus, 'valid'>, code: string, path: string, message: string, details?: Record<string, unknown>): EditValidationResult {
  return { status, can_execute: false, issues: [{ code, path, message, ...(details ? { details } : {}) }] };
}

function validateInput(args: ToolArgs): EditValidationResult | EditPlan {
  const allowed = new Set(Object.keys(editPlanProperties));
  const unexpected = Object.keys(args).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) return issue('invalid', 'UNEXPECTED_FIELD', unexpected[0], `Unexpected edit-plan field: ${unexpected[0]}.`);
  for (const key of allowed) {
    if (!(key in args)) return issue('invalid', 'MISSING_REQUIRED_VALUE', key, `${key} is required.`);
  }
  if (typeof args.model_id !== 'string' || args.model_id.length === 0) return issue('invalid', 'INVALID_MODEL_ID', 'model_id', 'model_id must be a non-empty string.');
  if (!Number.isInteger(args.model_revision) || (args.model_revision as number) < 1) return issue('invalid', 'INVALID_MODEL_REVISION', 'model_revision', 'model_revision must be a positive integer.');
  if (typeof args.target_feature_id !== 'string' || args.target_feature_id.length === 0) return issue('invalid', 'INVALID_FEATURE_ID', 'target_feature_id', 'target_feature_id must be a non-empty semantic feature ID.');
  if (args.parameter !== 'width' && args.parameter !== 'height' && args.parameter !== 'length') return issue('unsupported', 'UNSUPPORTED_EDIT_PARAMETER', 'parameter', 'Supported rectangular_pad parameters are width, height, and length.');
  if (args.unit !== 'mm') return issue('unsupported', 'UNSUPPORTED_EDIT_UNIT', 'unit', 'V1 supports only millimetres.');
  if (typeof args.old_value !== 'number' || !Number.isFinite(args.old_value) || args.old_value <= 0) return issue('invalid', 'INVALID_OLD_VALUE', 'old_value', 'old_value must be finite and greater than zero.');
  if (typeof args.new_value !== 'number' || !Number.isFinite(args.new_value) || args.new_value <= 0) return issue('invalid', 'INVALID_NEW_VALUE', 'new_value', 'new_value must be finite and greater than zero.');
  return {
    model_id: args.model_id,
    model_revision: args.model_revision as number,
    target_feature_id: args.target_feature_id,
    parameter: args.parameter,
    old_value: args.old_value,
    new_value: args.new_value,
    unit: 'mm',
  };
}

function validationPython(edit: EditPlan): string {
  return `
import FreeCAD
import hashlib
import json
edit = ${JSON.stringify(edit)}
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}

def fail(status, code, path, message, details=None):
    value = {"status": status, "can_execute": False, "issues": [{"code": code, "path": path, "message": message}]}
    if details is not None:
        value["issues"][0]["details"] = details
    _mcp_result["result"] = value

matches = []
for candidate_doc in FreeCAD.listDocuments().values():
    for candidate in candidate_doc.Objects:
        if "ModelId" in candidate.PropertiesList and str(candidate.ModelId) == edit["model_id"]:
            matches.append((candidate_doc, candidate))

if len(matches) == 0:
    fail("invalid", "MANAGED_MODEL_NOT_FOUND", "model_id", "No open managed FreeCAD model has the requested model_id.")
elif len(matches) > 1:
    fail("invalid", "MODEL_ID_NOT_UNIQUE", "model_id", "More than one open FreeCAD document has the requested model_id.")
else:
    doc, metadata = matches[0]
    required_properties = ("IsManagedModel", "ModelRevision", "PlanDigest", "ResolvedPlanJson", "FeatureBindingsJson")
    if any(name not in metadata.PropertiesList for name in required_properties):
        fail("invalid", "MODEL_METADATA_INVALID", "model_id", "The managed-model metadata is incomplete.")
    elif not bool(metadata.IsManagedModel):
        fail("invalid", "MODEL_NOT_MANAGED", "model_id", "The matching model is not marked as a valid managed model.")
    elif int(metadata.ModelRevision) != int(edit["model_revision"]):
        fail("invalid", "STALE_MODEL_REVISION", "model_revision", "The requested model revision is stale.", {"expected": int(metadata.ModelRevision), "actual": int(edit["model_revision"])})
    else:
        try:
            source_plan = json.loads(metadata.ResolvedPlanJson)
            bindings = json.loads(metadata.FeatureBindingsJson)
            canonical_source = json.dumps(source_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
            actual_digest = "sha256:" + hashlib.sha256(canonical_source.encode("utf-8")).hexdigest()
        except Exception as error:
            fail("invalid", "MODEL_METADATA_INVALID", "model_id", "The managed-model JSON metadata cannot be read.", {"error": str(error)})
        else:
            if str(metadata.PlanDigest) != actual_digest:
                fail("invalid", "PLAN_DIGEST_MISMATCH", "model_id", "The persistent plan digest does not match the persistent resolved plan.")
            elif source_plan.get("unit") != "mm":
                fail("unsupported", "UNSUPPORTED_EDIT_UNIT", "unit", "The persistent resolved plan is not expressed in millimetres.")
            else:
                features = [feature for feature in source_plan.get("features", []) if feature.get("id") == edit["target_feature_id"]]
                if len(features) != 1:
                    fail("invalid", "TARGET_FEATURE_NOT_FOUND", "target_feature_id", "The target feature ID does not exist exactly once in the persistent resolved plan.")
                elif features[0].get("type") != "rectangular_pad":
                    fail("unsupported", "UNSUPPORTED_EDIT_FEATURE", "target_feature_id", "V1 supports edits only on rectangular_pad features.")
                elif features[0].get(edit["parameter"]) is None or abs(float(features[0][edit["parameter"]]) - float(edit["old_value"])) > LINEAR_TOLERANCE_MM:
                    fail("invalid", "OLD_VALUE_MISMATCH", "old_value", "old_value does not match the persistent resolved plan.", {"expected": features[0].get(edit["parameter"]), "actual": edit["old_value"]})
                elif edit["target_feature_id"] not in bindings or edit["parameter"] not in bindings[edit["target_feature_id"]].get("parameters", {}):
                    fail("invalid", "FEATURE_BINDING_MISSING", "target_feature_id", "The persistent parameter binding is missing.")
                else:
                    binding = bindings[edit["target_feature_id"]]
                    parameter_binding = binding["parameters"][edit["parameter"]]
                    sketch = doc.getObject(binding.get("sketch_object", ""))
                    feature = doc.getObject(binding.get("feature_object", ""))
                    if binding.get("type") != "rectangular_pad" or binding.get("feature_type_id") != "PartDesign::Pad":
                        fail("invalid", "FEATURE_BINDING_INVALID", "target_feature_id", "The persistent feature binding does not describe a rectangular Pad.")
                    elif sketch is None or feature is None:
                        fail("invalid", "BOUND_OBJECT_NOT_FOUND", "target_feature_id", "The bound Sketch or feature no longer exists.")
                    elif sketch.TypeId != "Sketcher::SketchObject" or feature.TypeId != "PartDesign::Pad":
                        fail("invalid", "BOUND_OBJECT_TYPE_MISMATCH", "target_feature_id", "The bound objects have unexpected FreeCAD types.")
                    else:
                        body = feature.getParentGeoFeatureGroup()
                        profile_value = feature.Profile
                        profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                        if body is None or sketch not in body.Group or feature not in body.Group or profile_object != sketch:
                            fail("invalid", "FEATURE_BINDING_INVALID", "target_feature_id", "The bound Sketch is not the profile of the bound Pad in the same Body.")
                        else:
                            if edit["parameter"] in ("width", "height"):
                                expected_binding = parameter_binding.get("kind") == "sketch_constraint" and parameter_binding.get("constraint_name") == edit["parameter"] and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("sketch_object")
                                indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == parameter_binding.get("constraint_name")]
                                binding_valid = expected_binding and len(indices) == 1
                                actual_value = float(sketch.getDatum(indices[0]).Value) if binding_valid else None
                            else:
                                binding_valid = parameter_binding.get("kind") == "feature_property" and parameter_binding.get("property") == "Length" and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("feature_object")
                                actual_value = float(feature.Length.Value) if binding_valid else None
                            if not binding_valid:
                                fail("invalid", "FEATURE_BINDING_INVALID", "parameter", "The persistent parameter binding does not match its rectangular_pad semantic.")
                            elif abs(actual_value - float(features[0][edit["parameter"]])) > LINEAR_TOLERANCE_MM or abs(actual_value - float(edit["old_value"])) > LINEAR_TOLERANCE_MM:
                                fail("invalid", "MODEL_STATE_MISMATCH", "old_value", "The actual FreeCAD parameter differs from the persistent resolved plan or old_value.", {"expected": float(features[0][edit["parameter"]]), "actual": actual_value})
                            else:
                                expected_plan = json.loads(canonical_source)
                                expected_feature = next(feature for feature in expected_plan["features"] if feature["id"] == edit["target_feature_id"])
                                expected_feature[edit["parameter"]] = edit["new_value"]
                                expected_json = json.dumps(expected_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
                                expected_digest = "sha256:" + hashlib.sha256(expected_json.encode("utf-8")).hexdigest()
                                _mcp_result["result"] = {
                                    "status": "valid", "can_execute": True, "issues": [], "edit_plan": edit,
                                    "_validated_edit": {"source_resolved_plan": source_plan, "source_plan_digest": actual_digest, "expected_resolved_plan": expected_plan, "expected_plan_digest": expected_digest},
                                }
`;
}

function executionPython(validated: ValidatedEdit): string {
  return `
import FreeCAD
import Part
import hashlib
import json
import math
edit = ${JSON.stringify(validated.editPlan)}
source_plan = ${JSON.stringify(validated.sourceResolvedPlan)}
source_plan_digest = ${JSON.stringify(validated.sourcePlanDigest)}
expected_plan = ${JSON.stringify(validated.expectedResolvedPlan)}
expected_plan_digest = ${JSON.stringify(validated.expectedPlanDigest)}
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}
AREA_TOLERANCE_MM2 = ${AREA_TOLERANCE_MM2}
VOLUME_TOLERANCE_MM3 = ${VOLUME_TOLERANCE_MM3}
DIRECTION_VECTOR_EPSILON_MM = ${DIRECTION_VECTOR_EPSILON_MM}
doc = None
transaction_open = False
metadata = None
sketch = None
feature = None
parameter_indices = {}

${cadGeometryInspectionPython()}

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

try:
    matches = []
    for candidate_doc in FreeCAD.listDocuments().values():
        for candidate in candidate_doc.Objects:
            if "ModelId" in candidate.PropertiesList and str(candidate.ModelId) == edit["model_id"]:
                matches.append((candidate_doc, candidate))
    require(len(matches) == 1, "MANAGED_MODEL_NOT_FOUND_OR_NOT_UNIQUE")
    doc, metadata = matches[0]
    require(bool(metadata.IsManagedModel), "MODEL_NOT_MANAGED")
    require(int(metadata.ModelRevision) == int(edit["model_revision"]), "STALE_MODEL_REVISION")
    persistent_plan = json.loads(metadata.ResolvedPlanJson)
    persistent_json = json.dumps(persistent_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    persistent_digest = "sha256:" + hashlib.sha256(persistent_json.encode("utf-8")).hexdigest()
    require(persistent_plan == source_plan and str(metadata.PlanDigest) == source_plan_digest and persistent_digest == source_plan_digest, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
    bindings = json.loads(metadata.FeatureBindingsJson)
    require(edit["target_feature_id"] in bindings, "FEATURE_BINDING_MISSING")
    binding = bindings[edit["target_feature_id"]]
    require(binding.get("type") == "rectangular_pad" and binding.get("feature_type_id") == "PartDesign::Pad", "FEATURE_BINDING_INVALID")
    require(all(name in binding.get("parameters", {}) for name in ("width", "height", "length")), "FEATURE_BINDING_MISSING")
    sketch = doc.getObject(binding.get("sketch_object", ""))
    feature = doc.getObject(binding.get("feature_object", ""))
    require(sketch is not None and feature is not None, "BOUND_OBJECT_NOT_FOUND")
    require(sketch.TypeId == "Sketcher::SketchObject" and feature.TypeId == "PartDesign::Pad", "BOUND_OBJECT_TYPE_MISMATCH")
    body = feature.getParentGeoFeatureGroup()
    require(body is not None and body.TypeId == "PartDesign::Body", "BOUND_BODY_NOT_FOUND")
    profile_value = feature.Profile
    profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
    require(feature in body.Group and sketch in body.Group and profile_object == sketch and body.Tip == feature, "FEATURE_CHAIN_MISMATCH")
    source_feature = next(item for item in source_plan["features"] if item["id"] == edit["target_feature_id"])
    expected_feature = next(item for item in expected_plan["features"] if item["id"] == edit["target_feature_id"])
    parameter_bindings = binding["parameters"]
    for name in ("width", "height"):
        item = parameter_bindings[name]
        require(item.get("kind") == "sketch_constraint" and item.get("constraint_name") == name and item.get("unit") == "mm" and item.get("object") == binding.get("sketch_object"), "FEATURE_BINDING_INVALID")
        indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
        require(len(indices) == 1, "FEATURE_BINDING_INVALID")
        parameter_indices[name] = indices[0]
    length_binding = parameter_bindings["length"]
    require(length_binding.get("kind") == "feature_property" and length_binding.get("property") == "Length" and length_binding.get("unit") == "mm" and length_binding.get("object") == binding.get("feature_object"), "FEATURE_BINDING_INVALID")
    source_values = {"width": float(source_feature["width"]), "height": float(source_feature["height"]), "length": float(source_feature["length"])}
    actual_before = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
    require(all(abs(actual_before[name] - source_values[name]) <= LINEAR_TOLERANCE_MM for name in source_values), "MODEL_STATE_CHANGED_AFTER_VALIDATION")
    require(abs(actual_before[edit["parameter"]] - float(edit["old_value"])) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_CHANGED_AFTER_VALIDATION")

    doc.openTransaction("cad_execute_edit_plan_r" + str(edit["model_revision"]))
    transaction_open = True
    if edit["parameter"] in ("width", "height"):
        sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["new_value"]) + " mm"))
    else:
        feature.Length = float(edit["new_value"])
    doc.recompute()
    # edit_verification_snapshot_start
    shape = body.Tip.Shape
    geometry_signature = inspect_geometry(shape)
    actual_values = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
    recompute_errors = [{"object": obj.Name, "states": [str(state) for state in obj.State if str(state) not in ("Up-to-date", "Touched")]} for obj in doc.Objects]
    recompute_errors = [entry for entry in recompute_errors if entry["states"]]
    actual_snapshot = {
        "solid_count": geometry_signature["solid_count"], "shape_valid": geometry_signature["shape_valid"],
        "bounding_box": geometry_signature["bounding_box"], "volume": geometry_signature["volume"],
        "width": actual_values["width"], "height": actual_values["height"], "length": actual_values["length"],
        "body_tip": body.Tip.Name if body.Tip is not None else None,
        "feature_chain_complete": feature in body.Group and sketch in body.Group and profile_object == sketch and body.Tip == feature,
        "binding_valid": doc.getObject(binding["feature_object"]) == feature and doc.getObject(binding["sketch_object"]) == sketch,
        "recompute_errors": recompute_errors,
    }
    # edit_verification_snapshot_complete
    expected_bounds = {"x": float(expected_feature["width"]), "y": float(expected_feature["height"]), "z": float(expected_feature["length"])}
    expected_volume = float(expected_feature["width"]) * float(expected_feature["height"]) * float(expected_feature["length"])
    checks = {
        "solid_count": {"expected": 1, "actual": actual_snapshot["solid_count"], "passed": actual_snapshot["solid_count"] == 1},
        "shape_valid": {"expected": True, "actual": actual_snapshot["shape_valid"], "passed": actual_snapshot["shape_valid"] is True},
        "bounding_box": {"expected": expected_bounds, "actual": actual_snapshot["bounding_box"], "passed": all(abs(float(actual_snapshot["bounding_box"][axis]) - expected_bounds[axis]) <= LINEAR_TOLERANCE_MM for axis in ("x", "y", "z"))},
        "volume": {"expected": expected_volume, "actual": actual_snapshot["volume"], "passed": abs(float(actual_snapshot["volume"]) - expected_volume) <= VOLUME_TOLERANCE_MM3},
    }
    for name in ("width", "height", "length"):
        checks["parameter_" + name] = {"expected": float(expected_feature[name]), "actual": actual_snapshot[name], "passed": abs(actual_snapshot[name] - float(expected_feature[name])) <= LINEAR_TOLERANCE_MM}
    checks.update({
        "body_tip": {"expected": feature.Name, "actual": actual_snapshot["body_tip"], "passed": actual_snapshot["body_tip"] == feature.Name},
        "feature_chain_complete": {"expected": True, "actual": actual_snapshot["feature_chain_complete"], "passed": actual_snapshot["feature_chain_complete"] is True},
        "binding_valid": {"expected": True, "actual": actual_snapshot["binding_valid"], "passed": actual_snapshot["binding_valid"] is True},
        "recompute_errors": {"expected": [], "actual": actual_snapshot["recompute_errors"], "passed": len(actual_snapshot["recompute_errors"]) == 0},
    })
    issues = [{"code": "EDIT_VERIFICATION_MISMATCH", "check": name, "expected": check["expected"], "actual": check["actual"], "message": "The edited FreeCAD model does not match the validated expected plan."} for name, check in checks.items() if not check["passed"]]
    verification = {"passed": len(issues) == 0, "checks": checks}
    if issues:
        doc.abortTransaction()
        transaction_open = False
        if edit["parameter"] in ("width", "height"):
            sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
        else:
            feature.Length = float(edit["old_value"])
        metadata.IsManagedModel = True
        metadata.ResolvedPlanJson = json.dumps(source_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        metadata.PlanDigest = source_plan_digest
        metadata.ModelRevision = int(edit["model_revision"])
        doc.recompute()
        rollback_values = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
        rollback_ok = all(abs(rollback_values[name] - source_values[name]) <= LINEAR_TOLERANCE_MM for name in source_values) and int(metadata.ModelRevision) == int(edit["model_revision"]) and str(metadata.PlanDigest) == source_plan_digest and json.loads(metadata.ResolvedPlanJson) == source_plan
        _mcp_result["result"] = {"success": False, "status": "verification_failed", "code": "CAD_EDIT_VERIFICATION_FAILED", "issues": issues, "geometry_signature": geometry_signature, "verification": verification, "rollback": {"passed": rollback_ok, "parameter": edit["parameter"], "value": rollback_values[edit["parameter"]], "width": rollback_values["width"], "height": rollback_values["height"], "length": rollback_values["length"], "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest)}}
    else:
        metadata.IsManagedModel = False
        metadata.ResolvedPlanJson = json.dumps(expected_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        metadata.PlanDigest = expected_plan_digest
        metadata.ModelRevision = int(edit["model_revision"]) + 1
        metadata.IsManagedModel = True
        doc.recompute()
        require(json.loads(metadata.ResolvedPlanJson) == expected_plan and str(metadata.PlanDigest) == expected_plan_digest and int(metadata.ModelRevision) == int(edit["model_revision"]) + 1 and bool(metadata.IsManagedModel), "MANAGED_MODEL_UPDATE_FAILED")
        doc.commitTransaction()
        transaction_open = False
        _mcp_result["result"] = {
            "success": True, "status": "verified", "document": doc.Name, "body": doc.Name + "::" + body.Name,
            "managed_model": {"model_id": str(metadata.ModelId), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest)},
            "edit": edit, "geometry_signature": geometry_signature, "verification": verification,
        }
except Exception as error:
    if doc is not None and transaction_open:
        try:
            doc.abortTransaction()
            if sketch is not None and feature is not None and edit["parameter"] in parameter_indices:
                sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
            elif feature is not None and edit["parameter"] == "length":
                feature.Length = float(edit["old_value"])
            if metadata is not None:
                metadata.IsManagedModel = True
                metadata.ResolvedPlanJson = json.dumps(source_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
                metadata.PlanDigest = source_plan_digest
                metadata.ModelRevision = int(edit["model_revision"])
            doc.recompute()
        except Exception:
            pass
    _mcp_result["result"] = {"success": False, "status": "execution_failed", "code": "CAD_EDIT_EXECUTION_FAILED", "error": str(error)}
`;
}

function parseBridgeResult(value: ToolResult): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value.content[0]?.text ?? '{}');
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function handleCadValidateEditPlan(args: ToolArgs, bridge: FreeCADBridge, gate: CadEditValidationGate): Promise<ToolResult> {
  const revision = gate.beginValidation();
  await Promise.resolve();
  const checked = validateInput(args);
  if ('status' in checked) {
    gate.completeValidation(revision);
    return result(checked as unknown as Record<string, unknown>);
  }
  const response = await bridge.run(validationPython(checked));
  if (response.isError) {
    gate.completeValidation(revision);
    return response;
  }
  const parsed = parseBridgeResult(response);
  const internal = parsed?._validated_edit;
  if (parsed?.status !== 'valid' || parsed.can_execute !== true) {
    gate.completeValidation(revision);
    return response;
  }
  if (!isRecord(internal)
    || !isRecord(internal.source_resolved_plan)
    || typeof internal.source_plan_digest !== 'string'
    || !isRecord(internal.expected_resolved_plan)
    || typeof internal.expected_plan_digest !== 'string') {
    gate.completeValidation(revision);
    return result({
      status: 'invalid', can_execute: false,
      issues: [{ code: 'EDIT_VALIDATION_PROTOCOL_ERROR', path: '', message: 'FreeCAD returned an incomplete validated-edit payload.' }],
    }, true);
  }
  gate.completeValidation(revision, {
    editPlan: checked,
    sourceResolvedPlan: internal.source_resolved_plan,
    sourcePlanDigest: internal.source_plan_digest,
    expectedResolvedPlan: internal.expected_resolved_plan,
    expectedPlanDigest: internal.expected_plan_digest,
  });
  const { _validated_edit: _removed, ...publicResult } = parsed;
  return result(publicResult);
}

export async function handleCadExecuteEditPlan(args: ToolArgs, bridge: FreeCADBridge, gate: CadEditValidationGate): Promise<ToolResult> {
  if (Object.keys(args).length > 0) return result({ success: false, code: 'CAD_EDIT_NOT_VALIDATED', message: 'cad_execute_edit_plan accepts no edit overrides.' }, true);
  const execution = gate.beginExecution();
  if (execution === undefined) return result({ success: false, code: 'CAD_EDIT_NOT_VALIDATED', message: 'CAD edit is blocked until cad_validate_edit_plan returns status=valid and can_execute=true.' }, true);
  try {
    const response = await bridge.run(executionPython(execution.validated));
    if (response.isError) return response;
    const parsed = parseBridgeResult(response);
    if (parsed?.success !== true || parsed.status !== 'verified') return { ...response, isError: true };
    return response;
  } finally {
    gate.endExecution(execution.revision);
  }
}
