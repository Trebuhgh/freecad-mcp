import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import {
  AREA_TOLERANCE_MM2,
  DIRECTION_VECTOR_EPSILON_MM,
  LINEAR_TOLERANCE_MM,
  VOLUME_TOLERANCE_MM3,
} from './cad-geometry-tolerances.js';
import { cadGeometryInspectionPython } from './cad-geometry-inspection-python.js';
import { cadObjectStateInspectionPython } from './cad-object-state-python.js';
import { validateCadPlan } from './cad-plan-validation.js';

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
  parameter: 'width' | 'height' | 'length' | 'diameter' | 'center_x' | 'center_y' | 'spacing_x' | 'spacing_y';
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
  target_feature_id: { type: 'string', description: 'Semantic feature ID from the persistent resolved plan.' },
  parameter: { type: 'string', description: 'rectangular_pad: width, height, or length. hole_pattern: diameter; center_x/center_y for one explicitly positioned hole; or spacing_x/spacing_y for a persisted rectangular grid axis with more than one position.' },
  old_value: { type: 'number', description: 'Expected current parameter value in mm; center coordinates may be any finite value.' },
  new_value: { type: 'number', description: 'Requested new parameter value in mm; dimensions require a positive finite value and center coordinates require a finite value.' },
  unit: { type: 'string', description: 'Requested unit. Validation currently accepts only millimetres.' },
};

export const CAD_EDIT_TOOLS = [{
  name: 'cad_validate_edit_plan',
  description: 'Non-mutating validation gate for one semantic edit: rectangular_pad width/height/length; hole_pattern diameter; center_x/center_y for one explicitly positioned hole; or spacing_x/spacing_y for a rectangular grid. Never provide FreeCAD object names or constraint indices.',
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
  if (args.parameter !== 'width' && args.parameter !== 'height' && args.parameter !== 'length' && args.parameter !== 'diameter' && args.parameter !== 'center_x' && args.parameter !== 'center_y' && args.parameter !== 'spacing_x' && args.parameter !== 'spacing_y') return issue('unsupported', 'UNSUPPORTED_EDIT_PARAMETER', 'parameter', 'Supported parameters are rectangular_pad width/height/length and hole_pattern diameter/center_x/center_y/spacing_x/spacing_y.');
  if (args.unit !== 'mm') return issue('unsupported', 'UNSUPPORTED_EDIT_UNIT', 'unit', 'V1 supports only millimetres.');
  const positionParameter = args.parameter === 'center_x' || args.parameter === 'center_y';
  if (typeof args.old_value !== 'number' || !Number.isFinite(args.old_value) || (!positionParameter && args.old_value <= 0)) return issue('invalid', 'INVALID_OLD_VALUE', 'old_value', positionParameter ? 'old_value must be finite.' : 'old_value must be finite and greater than zero.');
  if (typeof args.new_value !== 'number' || !Number.isFinite(args.new_value) || (!positionParameter && args.new_value <= 0)) return issue('invalid', 'INVALID_NEW_VALUE', 'new_value', positionParameter ? 'new_value must be finite.' : 'new_value must be finite and greater than zero.');
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
                target_feature = features[0] if len(features) == 1 else None
                position_edit = edit["parameter"] in ("center_x", "center_y")
                spacing_edit = edit["parameter"] in ("spacing_x", "spacing_y")
                expected_parameter_value = None
                if target_feature is not None:
                    if position_edit and len(target_feature.get("centers", [])) == 1:
                        expected_parameter_value = target_feature["centers"][0]["x" if edit["parameter"] == "center_x" else "y"]
                    elif spacing_edit and isinstance(target_feature.get("grid"), dict):
                        expected_parameter_value = target_feature["grid"].get(edit["parameter"])
                    elif not position_edit:
                        expected_parameter_value = target_feature.get(edit["parameter"])
                if len(features) != 1:
                    fail("invalid", "TARGET_FEATURE_NOT_FOUND", "target_feature_id", "The target feature ID does not exist exactly once in the persistent resolved plan.")
                elif not ((target_feature.get("type") == "rectangular_pad" and edit["parameter"] in ("width", "height", "length")) or (target_feature.get("type") == "hole_pattern" and edit["parameter"] in ("diameter", "center_x", "center_y", "spacing_x", "spacing_y"))):
                    fail("unsupported", "UNSUPPORTED_EDIT_PARAMETER", "parameter", "The requested parameter is not supported for the target feature type.")
                elif target_feature.get("type") == "hole_pattern" and (not source_plan.get("features") or source_plan["features"][0].get("type") != "rectangular_pad"):
                    fail("unsupported", "UNSUPPORTED_EDIT_BASE", "target_feature_id", "hole_pattern editing currently requires a rectangular_pad base.")
                elif position_edit and (target_feature.get("center_editable") is not True or len(target_feature.get("centers", [])) != 1):
                    fail("unsupported", "SINGLE_EXPLICIT_HOLE_REQUIRED", "target_feature_id", "center_x/center_y editing requires exactly one explicitly positioned hole.")
                elif spacing_edit and (not isinstance(target_feature.get("grid"), dict) or int(target_feature["grid"].get("columns" if edit["parameter"] == "spacing_x" else "rows", 0)) <= 1):
                    fail("unsupported", "RECTANGULAR_GRID_REQUIRED", "target_feature_id", "spacing_x/spacing_y editing requires a persisted rectangular grid with more than one column or row on the edited axis.")
                elif expected_parameter_value is None or abs(float(expected_parameter_value) - float(edit["old_value"])) > LINEAR_TOLERANCE_MM:
                    fail("invalid", "OLD_VALUE_MISMATCH", "old_value", "old_value does not match the persistent resolved plan.", {"expected": expected_parameter_value, "actual": edit["old_value"]})
                elif edit["target_feature_id"] not in bindings or edit["parameter"] not in bindings[edit["target_feature_id"]].get("parameters", {}):
                    semantic_position_edit = position_edit or spacing_edit
                    fail("unsupported" if semantic_position_edit else "invalid", "POSITION_BINDING_UNAVAILABLE" if semantic_position_edit else "FEATURE_BINDING_MISSING", "target_feature_id", "The persistent parameter binding is missing.")
                else:
                    binding = bindings[edit["target_feature_id"]]
                    parameter_binding = binding["parameters"][edit["parameter"]]
                    sketch = doc.getObject(binding.get("sketch_object", ""))
                    feature = doc.getObject(binding.get("feature_object", ""))
                    feature_type = features[0].get("type")
                    expected_feature_type_id = "PartDesign::Pad" if feature_type == "rectangular_pad" else "PartDesign::Pocket"
                    if binding.get("type") != feature_type or binding.get("feature_type_id") != expected_feature_type_id:
                        fail("invalid", "FEATURE_BINDING_INVALID", "target_feature_id", "The persistent feature binding does not match the target feature semantic.")
                    elif sketch is None or feature is None:
                        fail("invalid", "BOUND_OBJECT_NOT_FOUND", "target_feature_id", "The bound Sketch or feature no longer exists.")
                    elif sketch.TypeId != "Sketcher::SketchObject" or feature.TypeId != expected_feature_type_id:
                        fail("invalid", "BOUND_OBJECT_TYPE_MISMATCH", "target_feature_id", "The bound objects have unexpected FreeCAD types.")
                    else:
                        body = feature.getParentGeoFeatureGroup()
                        profile_value = feature.Profile
                        profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                        if body is None or sketch not in body.Group or feature not in body.Group or profile_object != sketch:
                            fail("invalid", "FEATURE_BINDING_INVALID", "target_feature_id", "The bound Sketch is not the profile of the bound Pad in the same Body.")
                        else:
                            binding_valid = False
                            actual_value = None
                            actual_state_valid = True
                            if feature_type == "rectangular_pad" and edit["parameter"] in ("width", "height"):
                                expected_binding = parameter_binding.get("kind") == "sketch_constraint" and parameter_binding.get("constraint_name") == edit["parameter"] and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("sketch_object")
                                indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == parameter_binding.get("constraint_name")]
                                binding_valid = expected_binding and len(indices) == 1
                                actual_value = float(sketch.getDatum(indices[0]).Value) if binding_valid else None
                            elif feature_type == "rectangular_pad":
                                binding_valid = parameter_binding.get("kind") == "feature_property" and parameter_binding.get("property") == "Length" and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("feature_object")
                                actual_value = float(feature.Length.Value) if binding_valid else None
                            elif edit["parameter"] == "diameter":
                                centers = features[0].get("centers", [])
                                names = parameter_binding.get("constraint_names") if isinstance(parameter_binding, dict) else None
                                binding_valid = parameter_binding.get("kind") == "sketch_constraints" and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("sketch_object") and isinstance(names, list) and len(names) == len(centers) and len(names) > 0 and len(set(names)) == len(names)
                                actual_diameters = []
                                if binding_valid:
                                    for center, name in zip(centers, names):
                                        indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                                        if len(indices) != 1:
                                            binding_valid = False
                                            break
                                        constraint = sketch.Constraints[indices[0]]
                                        geometry_index = int(constraint.First)
                                        if constraint.Type != "Diameter" or geometry_index < 0 or geometry_index >= len(sketch.Geometry):
                                            binding_valid = False
                                            break
                                        geometry = sketch.Geometry[geometry_index]
                                        if geometry.__class__.__name__ != "Circle":
                                            binding_valid = False
                                            break
                                        if abs(float(geometry.Center.x) - float(center["x"])) > LINEAR_TOLERANCE_MM or abs(float(geometry.Center.y) - float(center["y"])) > LINEAR_TOLERANCE_MM:
                                            actual_state_valid = False
                                        actual_diameters.append(float(geometry.Radius) * 2.0)
                                if binding_valid and actual_diameters:
                                    actual_value = actual_diameters[0]
                                    if any(abs(value - actual_value) > LINEAR_TOLERANCE_MM for value in actual_diameters):
                                        actual_state_valid = False
                            elif position_edit:
                                centers = target_feature.get("centers", [])
                                constraint_name = parameter_binding.get("constraint_name") if isinstance(parameter_binding, dict) else None
                                indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == constraint_name]
                                expected_constraint_type = "DistanceX" if edit["parameter"] == "center_x" else "DistanceY"
                                binding_valid = parameter_binding.get("kind") == "sketch_constraint" and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("sketch_object") and isinstance(constraint_name, str) and len(indices) == 1 and len(centers) == 1
                                if binding_valid:
                                    constraint = sketch.Constraints[indices[0]]
                                    geometry_index = int(constraint.Second)
                                    binding_valid = constraint.Type == expected_constraint_type and geometry_index >= 0 and geometry_index < len(sketch.Geometry)
                                    if binding_valid:
                                        geometry = sketch.Geometry[geometry_index]
                                        binding_valid = geometry.__class__.__name__ == "Circle"
                                    if binding_valid:
                                        coordinate = float(geometry.Center.x if edit["parameter"] == "center_x" else geometry.Center.y)
                                        other_coordinate = float(geometry.Center.y if edit["parameter"] == "center_x" else geometry.Center.x)
                                        expected_other = float(centers[0]["y" if edit["parameter"] == "center_x" else "x"])
                                        actual_value = coordinate
                                        if abs(float(sketch.getDatum(indices[0]).Value) - coordinate) > LINEAR_TOLERANCE_MM or abs(other_coordinate - expected_other) > LINEAR_TOLERANCE_MM:
                                            actual_state_valid = False
                            else:
                                centers = target_feature.get("centers", [])
                                grid = target_feature.get("grid", {})
                                names = parameter_binding.get("constraint_names") if isinstance(parameter_binding, dict) else None
                                constraint_type = "DistanceX" if edit["parameter"] == "spacing_x" else "DistanceY"
                                coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
                                axis_count = int(grid.get("columns" if edit["parameter"] == "spacing_x" else "rows", 0))
                                pattern_center = float(grid.get("pattern_center_x" if edit["parameter"] == "spacing_x" else "pattern_center_y"))
                                binding_valid = parameter_binding.get("kind") == "grid_position_constraints" and parameter_binding.get("unit") == "mm" and parameter_binding.get("object") == binding.get("sketch_object") and isinstance(names, list) and len(names) == len(centers) and len(set(names)) == len(names) and axis_count > 1
                                axis_values = []
                                if binding_valid:
                                    for center_index, (center, name) in enumerate(zip(centers, names)):
                                        indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                                        if len(indices) != 1:
                                            binding_valid = False
                                            break
                                        constraint = sketch.Constraints[indices[0]]
                                        geometry_index = int(constraint.Second)
                                        if constraint.Type != constraint_type or geometry_index < 0 or geometry_index >= len(sketch.Geometry):
                                            binding_valid = False
                                            break
                                        geometry = sketch.Geometry[geometry_index]
                                        coordinate = float(geometry.Center.x if coordinate_key == "x" else geometry.Center.y)
                                        if geometry.__class__.__name__ != "Circle" or abs(coordinate - float(center[coordinate_key])) > LINEAR_TOLERANCE_MM or abs(float(sketch.getDatum(indices[0]).Value) - coordinate) > LINEAR_TOLERANCE_MM:
                                            actual_state_valid = False
                                        axis_values.append(coordinate)
                                if binding_valid:
                                    unique_axis_values = sorted(set(round(value, 12) for value in axis_values))
                                    actual_state_valid = actual_state_valid and len(unique_axis_values) == axis_count and abs(unique_axis_values[0] + unique_axis_values[-1] - 2.0 * pattern_center) <= LINEAR_TOLERANCE_MM
                                    actual_value = float(grid[edit["parameter"]])
                                    if any(abs((unique_axis_values[index + 1] - unique_axis_values[index]) - actual_value) > LINEAR_TOLERANCE_MM for index in range(len(unique_axis_values) - 1)):
                                        actual_state_valid = False
                            if not binding_valid:
                                fail("invalid", "FEATURE_BINDING_INVALID", "parameter", "The persistent parameter binding does not match the requested semantic.")
                            elif not actual_state_valid or abs(actual_value - float(expected_parameter_value)) > LINEAR_TOLERANCE_MM or abs(actual_value - float(edit["old_value"])) > LINEAR_TOLERANCE_MM:
                                fail("invalid", "MODEL_STATE_MISMATCH", "old_value", "The actual FreeCAD parameter differs from the persistent resolved plan or old_value.", {"expected": float(expected_parameter_value), "actual": actual_value})
                            else:
                                expected_plan = json.loads(canonical_source)
                                expected_feature = next(feature for feature in expected_plan["features"] if feature["id"] == edit["target_feature_id"])
                                if position_edit:
                                    expected_feature["centers"][0]["x" if edit["parameter"] == "center_x" else "y"] = edit["new_value"]
                                elif spacing_edit:
                                    grid = expected_feature["grid"]
                                    grid[edit["parameter"]] = edit["new_value"]
                                    columns = int(grid["columns"])
                                    rows = int(grid["rows"])
                                    expected_feature["centers"] = [{"x": float(grid["pattern_center_x"]) + (column - (columns - 1) / 2.0) * float(grid["spacing_x"]), "y": float(grid["pattern_center_y"]) + (row - (rows - 1) / 2.0) * float(grid["spacing_y"])} for row in range(rows) for column in range(columns)]
                                else:
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
edit = json.loads(${JSON.stringify(JSON.stringify(validated.editPlan))})
source_plan = json.loads(${JSON.stringify(JSON.stringify(validated.sourceResolvedPlan))})
source_plan_digest = ${JSON.stringify(validated.sourcePlanDigest)}
expected_plan = json.loads(${JSON.stringify(JSON.stringify(validated.expectedResolvedPlan))})
expected_plan_digest = "sha256:" + hashlib.sha256(json.dumps(expected_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")).hexdigest()
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}
AREA_TOLERANCE_MM2 = ${AREA_TOLERANCE_MM2}
VOLUME_TOLERANCE_MM3 = ${VOLUME_TOLERANCE_MM3}
DIRECTION_VECTOR_EPSILON_MM = ${DIRECTION_VECTOR_EPSILON_MM}
${cadObjectStateInspectionPython()}
doc = None
transaction_open = False
metadata = None
sketch = None
feature = None
parameter_indices = {}
diameter_constraint_names = []
position_constraint_name = None
target_circle_index = None
spacing_constraint_names = []
spacing_axis = None
source_geometry_signature = None
source_holes = []
source_target_holes = []
base_sketch = None
base_feature = None
base_parameter_indices = {}
base_values_before = {}

${cadGeometryInspectionPython()}

def require(condition, code):
    if not condition:
        raise RuntimeError(code)

def inspect_holes(signature):
    holes = []
    for cylinder in signature["surfaces"]["cylindrical"]:
        axis = cylinder["axis"]
        if cylinder["surface_role"] != "hole" or abs(axis[0]) > LINEAR_TOLERANCE_MM or abs(axis[1]) > LINEAR_TOLERANCE_MM or abs(abs(axis[2]) - 1.0) > LINEAR_TOLERANCE_MM:
            continue
        item = {"x": float(cylinder["axis_point"][0]), "y": float(cylinder["axis_point"][1]), "radius": float(cylinder["radius"]), "axis": [float(value) for value in axis], "axis_material_length": float(cylinder["axis_material_length"])}
        if not any(abs(existing["x"] - item["x"]) <= LINEAR_TOLERANCE_MM and abs(existing["y"] - item["y"]) <= LINEAR_TOLERANCE_MM and abs(existing["radius"] - item["radius"]) <= LINEAR_TOLERANCE_MM for existing in holes):
            holes.append(item)
    holes.sort(key=lambda item: (item["x"], item["y"], item["radius"]))
    return holes

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
    source_feature = next(item for item in source_plan["features"] if item["id"] == edit["target_feature_id"])
    expected_feature = next(item for item in expected_plan["features"] if item["id"] == edit["target_feature_id"])
    feature_type = source_feature["type"]
    require((feature_type == "rectangular_pad" and edit["parameter"] in ("width", "height", "length")) or (feature_type == "hole_pattern" and edit["parameter"] in ("diameter", "center_x", "center_y", "spacing_x", "spacing_y")), "UNSUPPORTED_EDIT_PARAMETER")
    expected_type_id = "PartDesign::Pad" if feature_type == "rectangular_pad" else "PartDesign::Pocket"
    require(binding.get("type") == feature_type and binding.get("feature_type_id") == expected_type_id, "FEATURE_BINDING_INVALID")
    sketch = doc.getObject(binding.get("sketch_object", ""))
    feature = doc.getObject(binding.get("feature_object", ""))
    require(sketch is not None and feature is not None, "BOUND_OBJECT_NOT_FOUND")
    require(sketch.TypeId == "Sketcher::SketchObject" and feature.TypeId == expected_type_id, "BOUND_OBJECT_TYPE_MISMATCH")
    body = feature.getParentGeoFeatureGroup()
    require(body is not None and body.TypeId == "PartDesign::Body", "BOUND_BODY_NOT_FOUND")
    profile_value = feature.Profile
    profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
    require(feature in body.Group and sketch in body.Group and profile_object == sketch and (feature_type == "hole_pattern" or body.Tip == feature), "FEATURE_CHAIN_MISMATCH")
    parameter_bindings = binding["parameters"]
    if feature_type == "rectangular_pad":
        require(all(name in parameter_bindings for name in ("width", "height", "length")), "FEATURE_BINDING_MISSING")
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
    else:
        base_plan = source_plan["features"][0]
        require(base_plan.get("type") == "rectangular_pad", "UNSUPPORTED_EDIT_BASE")
        base_binding = bindings.get(base_plan["id"], {})
        base_sketch = doc.getObject(base_binding.get("sketch_object", ""))
        base_feature = doc.getObject(base_binding.get("feature_object", ""))
        require(base_sketch is not None and base_feature is not None and base_feature.TypeId == "PartDesign::Pad", "FEATURE_BINDING_INVALID")
        base_parameter_indices = {}
        for name in ("width", "height"):
            base_parameter_binding = base_binding.get("parameters", {}).get(name, {})
            indices = [index for index, constraint in enumerate(base_sketch.Constraints) if constraint.Name == base_parameter_binding.get("constraint_name")]
            require(base_parameter_binding.get("kind") == "sketch_constraint" and len(indices) == 1, "FEATURE_BINDING_INVALID")
            base_parameter_indices[name] = indices[0]
        base_length_binding = base_binding.get("parameters", {}).get("length", {})
        require(base_length_binding.get("kind") == "feature_property" and base_length_binding.get("property") == "Length", "FEATURE_BINDING_INVALID")
        base_values_before = {"width": float(base_sketch.getDatum(base_parameter_indices["width"]).Value), "height": float(base_sketch.getDatum(base_parameter_indices["height"]).Value), "length": float(base_feature.Length.Value)}
        require(all(abs(base_values_before[name] - float(base_plan[name])) <= LINEAR_TOLERANCE_MM for name in base_values_before), "MODEL_STATE_CHANGED_AFTER_VALIDATION")
        require("diameter" in parameter_bindings, "FEATURE_BINDING_MISSING")
        diameter_binding = parameter_bindings["diameter"]
        diameter_constraint_names = diameter_binding.get("constraint_names", [])
        centers = source_feature.get("centers", [])
        require(diameter_binding.get("kind") == "sketch_constraints" and diameter_binding.get("object") == binding.get("sketch_object") and diameter_binding.get("unit") == "mm" and isinstance(diameter_constraint_names, list) and len(diameter_constraint_names) == len(centers) and len(diameter_constraint_names) > 0 and len(set(diameter_constraint_names)) == len(diameter_constraint_names), "FEATURE_BINDING_INVALID")
        circle_indices = []
        actual_diameters = []
        for center, name in zip(centers, diameter_constraint_names):
            indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
            require(len(indices) == 1, "FEATURE_BINDING_INVALID")
            constraint = sketch.Constraints[indices[0]]
            geometry_index = int(constraint.First)
            require(constraint.Type == "Diameter" and geometry_index >= 0 and geometry_index < len(sketch.Geometry) and geometry_index not in circle_indices, "FEATURE_BINDING_INVALID")
            circle = sketch.Geometry[geometry_index]
            require(circle.__class__.__name__ == "Circle" and abs(float(circle.Center.x) - float(center["x"])) <= LINEAR_TOLERANCE_MM and abs(float(circle.Center.y) - float(center["y"])) <= LINEAR_TOLERANCE_MM, "FEATURE_BINDING_INVALID")
            circle_indices.append(geometry_index)
            parameter_indices[name] = indices[0]
            actual_diameters.append(float(circle.Radius) * 2.0)
        require(len([geometry for geometry in sketch.Geometry if geometry.__class__.__name__ == "Circle"]) == len(centers), "MODEL_STATE_CHANGED_AFTER_VALIDATION")
        require(all(abs(value - float(source_feature["diameter"])) <= LINEAR_TOLERANCE_MM for value in actual_diameters), "MODEL_STATE_CHANGED_AFTER_VALIDATION")
        if edit["parameter"] == "diameter":
            source_values = {"diameter": float(source_feature["diameter"])}
            actual_before = {"diameter": actual_diameters[0]}
        elif edit["parameter"] in ("center_x", "center_y"):
            require(source_feature.get("center_editable") is True and len(centers) == 1, "SINGLE_EXPLICIT_HOLE_REQUIRED")
            position_binding = parameter_bindings.get(edit["parameter"], {})
            position_constraint_name = position_binding.get("constraint_name")
            position_indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == position_constraint_name]
            require(position_binding.get("kind") == "sketch_constraint" and position_binding.get("object") == binding.get("sketch_object") and position_binding.get("unit") == "mm" and isinstance(position_constraint_name, str) and len(position_indices) == 1, "FEATURE_BINDING_INVALID")
            position_constraint = sketch.Constraints[position_indices[0]]
            expected_constraint_type = "DistanceX" if edit["parameter"] == "center_x" else "DistanceY"
            require(position_constraint.Type == expected_constraint_type and int(position_constraint.Second) == circle_indices[0], "FEATURE_BINDING_INVALID")
            parameter_indices[edit["parameter"]] = position_indices[0]
            target_circle_index = circle_indices[0]
            axis_name = "x" if edit["parameter"] == "center_x" else "y"
            actual_coordinate = float(sketch.Geometry[target_circle_index].Center.x if axis_name == "x" else sketch.Geometry[target_circle_index].Center.y)
            require(abs(float(sketch.getDatum(position_indices[0]).Value) - actual_coordinate) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
            source_values = {edit["parameter"]: float(centers[0][axis_name])}
            actual_before = {edit["parameter"]: actual_coordinate}
        else:
            grid = source_feature.get("grid")
            require(isinstance(grid, dict), "RECTANGULAR_GRID_REQUIRED")
            spacing_axis = "x" if edit["parameter"] == "spacing_x" else "y"
            axis_count = int(grid.get("columns" if spacing_axis == "x" else "rows", 0))
            require(axis_count > 1, "RECTANGULAR_GRID_REQUIRED")
            spacing_binding = parameter_bindings.get(edit["parameter"], {})
            spacing_constraint_names = spacing_binding.get("constraint_names", [])
            require(spacing_binding.get("kind") == "grid_position_constraints" and spacing_binding.get("object") == binding.get("sketch_object") and spacing_binding.get("unit") == "mm" and isinstance(spacing_constraint_names, list) and len(spacing_constraint_names) == len(centers) and len(set(spacing_constraint_names)) == len(spacing_constraint_names), "FEATURE_BINDING_INVALID")
            expected_constraint_type = "DistanceX" if spacing_axis == "x" else "DistanceY"
            axis_values = []
            for center_index, name in enumerate(spacing_constraint_names):
                indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                require(len(indices) == 1, "FEATURE_BINDING_INVALID")
                constraint = sketch.Constraints[indices[0]]
                require(constraint.Type == expected_constraint_type and int(constraint.Second) == circle_indices[center_index], "FEATURE_BINDING_INVALID")
                parameter_indices[name] = indices[0]
                coordinate = float(sketch.Geometry[circle_indices[center_index]].Center.x if spacing_axis == "x" else sketch.Geometry[circle_indices[center_index]].Center.y)
                require(abs(float(sketch.getDatum(indices[0]).Value) - coordinate) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
                axis_values.append(coordinate)
            unique_axis_values = sorted(set(round(value, 12) for value in axis_values))
            current_spacing = float(grid[edit["parameter"]])
            require(len(unique_axis_values) == axis_count and all(abs((unique_axis_values[index + 1] - unique_axis_values[index]) - current_spacing) <= LINEAR_TOLERANCE_MM for index in range(len(unique_axis_values) - 1)), "MODEL_STATE_CHANGED_AFTER_VALIDATION")
            source_values = {edit["parameter"]: current_spacing}
            actual_before = {edit["parameter"]: current_spacing}
    require(abs(actual_before[edit["parameter"]] - float(edit["old_value"])) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
    source_geometry_signature = inspect_geometry(body.Tip.Shape)
    source_holes = inspect_holes(source_geometry_signature)
    if feature_type == "hole_pattern":
        expected_centers = source_feature["centers"]
        all_source_hole_count = sum(len(item["centers"]) for item in source_plan["features"] if item["type"] == "hole_pattern")
        require(len(source_holes) == all_source_hole_count, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
        for center in expected_centers:
            matches_for_center = [hole for hole in source_holes if abs(hole["x"] - float(center["x"])) <= LINEAR_TOLERANCE_MM and abs(hole["y"] - float(center["y"])) <= LINEAR_TOLERANCE_MM and abs(hole["radius"] * 2.0 - float(source_feature["diameter"])) <= LINEAR_TOLERANCE_MM]
            require(len(matches_for_center) == 1, "MODEL_STATE_CHANGED_AFTER_VALIDATION")
            source_target_holes.append(matches_for_center[0])

    doc.openTransaction("cad_execute_edit_plan_r" + str(edit["model_revision"]))
    transaction_open = True
    if edit["parameter"] in ("width", "height"):
        sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["new_value"]) + " mm"))
    elif edit["parameter"] == "length":
        feature.Length = float(edit["new_value"])
    elif edit["parameter"] == "diameter":
        for name in diameter_constraint_names:
            sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(edit["new_value"]) + " mm"))
    elif edit["parameter"] in ("center_x", "center_y"):
        sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["new_value"]) + " mm"))
    else:
        coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
        for center, name in zip(expected_feature["centers"], spacing_constraint_names):
            sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(center[coordinate_key]) + " mm"))
    doc.recompute()
    # edit_verification_snapshot_start
    shape = body.Tip.Shape
    geometry_signature = inspect_geometry(shape)
    if feature_type == "rectangular_pad":
        actual_values = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
    else:
        actual_diameters = [float(sketch.Geometry[int(sketch.Constraints[parameter_indices[name]].First)].Radius) * 2.0 for name in diameter_constraint_names]
        actual_circle = sketch.Geometry[target_circle_index if target_circle_index is not None else int(sketch.Constraints[parameter_indices[diameter_constraint_names[0]]].First)]
        actual_values = {"diameter": actual_diameters[0] if actual_diameters else None, "center_x": float(actual_circle.Center.x), "center_y": float(actual_circle.Center.y)}
        if edit["parameter"] in ("spacing_x", "spacing_y"):
            coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
            axis_values = sorted(set(round(float(sketch.Geometry[index].Center.x if coordinate_key == "x" else sketch.Geometry[index].Center.y), 12) for index in circle_indices))
            actual_values[edit["parameter"]] = axis_values[1] - axis_values[0] if len(axis_values) > 1 else None
    recompute_errors = [{"object": obj.Name, "states": cad_object_error_states(obj)} for obj in doc.Objects]
    recompute_errors = [entry for entry in recompute_errors if entry["states"]]
    actual_snapshot = {
        "solid_count": geometry_signature["solid_count"], "shape_valid": geometry_signature["shape_valid"],
        "bounding_box": geometry_signature["bounding_box"], "volume": geometry_signature["volume"],
        "body_tip": body.Tip.Name if body.Tip is not None else None,
        "feature_chain_complete": feature in body.Group and sketch in body.Group and profile_object == sketch and all(doc.getObject(bindings[item["id"]].get("feature_object", "")) in body.Group for item in source_plan["features"] if item["id"] in bindings),
        "binding_valid": doc.getObject(binding["feature_object"]) == feature and doc.getObject(binding["sketch_object"]) == sketch,
        "recompute_errors": recompute_errors,
    }
    actual_snapshot.update(actual_values)
    if feature_type == "hole_pattern":
        actual_snapshot["holes"] = inspect_holes(geometry_signature)
        actual_snapshot["base_dimensions"] = {"width": float(base_sketch.getDatum(base_parameter_indices["width"]).Value), "height": float(base_sketch.getDatum(base_parameter_indices["height"]).Value), "length": float(base_feature.Length.Value)}
    # edit_verification_snapshot_complete
    if feature_type == "rectangular_pad":
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
    else:
        actual_holes = actual_snapshot["holes"]
        expected_hole_features = [item for item in expected_plan["features"] if item["type"] == "hole_pattern"]
        expected_specs = [{"feature_id": item["id"], "x": float(center["x"]), "y": float(center["y"]), "diameter": float(item["diameter"])} for item in expected_hole_features for center in item["centers"]]
        matched_holes = []
        group_results = {}
        used_actual = set()
        for item in expected_hole_features:
            group_actual = []
            for center in item["centers"]:
                candidates = [(index, hole) for index, hole in enumerate(actual_holes) if index not in used_actual and abs(hole["x"] - float(center["x"])) <= LINEAR_TOLERANCE_MM and abs(hole["y"] - float(center["y"])) <= LINEAR_TOLERANCE_MM]
                if len(candidates) == 1:
                    used_actual.add(candidates[0][0])
                    matched_holes.append(candidates[0][1])
                    group_actual.append(candidates[0][1])
            group_results[item["id"]] = {"expected_diameter": float(item["diameter"]), "actual_diameters": [hole["radius"] * 2.0 for hole in group_actual], "expected_count": len(item["centers"]), "actual_count": len(group_actual)}
        expected_centers = sorted([{"x": item["x"], "y": item["y"]} for item in expected_specs], key=lambda item: (item["x"], item["y"]))
        actual_centers = sorted([{"x": hole["x"], "y": hole["y"]} for hole in actual_holes], key=lambda item: (item["x"], item["y"]))
        centers_passed = len(actual_centers) == len(expected_centers) and all(abs(actual_centers[index]["x"] - expected_centers[index]["x"]) <= LINEAR_TOLERANCE_MM and abs(actual_centers[index]["y"] - expected_centers[index]["y"]) <= LINEAR_TOLERANCE_MM for index in range(len(expected_centers)))
        groups_passed = len(matched_holes) == len(expected_specs) and all(result["actual_count"] == result["expected_count"] and all(abs(value - result["expected_diameter"]) <= LINEAR_TOLERANCE_MM for value in result["actual_diameters"]) for result in group_results.values())
        axes_passed = len(actual_holes) == len(source_holes) and all(abs(hole["axis"][0]) <= LINEAR_TOLERANCE_MM and abs(hole["axis"][1]) <= LINEAR_TOLERANCE_MM and abs(abs(hole["axis"][2]) - 1.0) <= LINEAR_TOLERANCE_MM and hole["axis_material_length"] <= LINEAR_TOLERANCE_MM for hole in actual_holes)
        expected_volume = base_values_before["width"] * base_values_before["height"] * base_values_before["length"] - sum(math.pi * (item["diameter"] / 2.0) ** 2 * base_values_before["length"] for item in expected_specs)
        target_actual_diameters = group_results[expected_feature["id"]]["actual_diameters"]
        target_diameter_passed = len(target_actual_diameters) == len(expected_feature["centers"]) and all(abs(value - float(expected_feature["diameter"])) <= LINEAR_TOLERANCE_MM for value in target_actual_diameters)
        checks = {
            "solid_count": {"expected": 1, "actual": actual_snapshot["solid_count"], "passed": actual_snapshot["solid_count"] == 1},
            "shape_valid": {"expected": True, "actual": actual_snapshot["shape_valid"], "passed": actual_snapshot["shape_valid"] is True},
            "bounding_box": {"expected": source_geometry_signature["bounding_box"], "actual": actual_snapshot["bounding_box"], "passed": all(abs(float(actual_snapshot["bounding_box"][axis]) - float(source_geometry_signature["bounding_box"][axis])) <= LINEAR_TOLERANCE_MM for axis in ("x", "y", "z"))},
            "volume": {"expected": expected_volume, "actual": actual_snapshot["volume"], "passed": abs(float(actual_snapshot["volume"]) - expected_volume) <= VOLUME_TOLERANCE_MM3},
            "hole_count": {"expected": len(expected_specs), "actual": len(actual_holes), "passed": len(actual_holes) == len(expected_specs)},
            "hole_centers": {"expected": expected_centers, "actual": actual_centers, "passed": centers_passed},
            "hole_diameter": {"expected": float(expected_feature["diameter"]), "actual": target_actual_diameters, "passed": target_diameter_passed},
            "hole_groups": {"expected": {item["id"]: {"diameter": float(item["diameter"]), "count": len(item["centers"])} for item in expected_hole_features}, "actual": group_results, "passed": groups_passed},
            "hole_axes": {"expected": [{"axis": hole["axis"], "axis_material_length": hole["axis_material_length"]} for hole in source_holes], "actual": [{"axis": hole["axis"], "axis_material_length": hole["axis_material_length"]} for hole in actual_holes], "passed": axes_passed},
            "parameter_diameter": {"expected": float(expected_feature["diameter"]), "actual": actual_snapshot["diameter"], "passed": actual_snapshot["diameter"] is not None and abs(actual_snapshot["diameter"] - float(expected_feature["diameter"])) <= LINEAR_TOLERANCE_MM},
            "base_dimensions": {"expected": base_values_before, "actual": actual_snapshot["base_dimensions"], "passed": all(abs(actual_snapshot["base_dimensions"][name] - base_values_before[name]) <= LINEAR_TOLERANCE_MM for name in base_values_before)},
        }
        if edit["parameter"] in ("center_x", "center_y"):
            expected_parameter = float(expected_feature["centers"][0]["x" if edit["parameter"] == "center_x" else "y"])
            checks["parameter_" + edit["parameter"]] = {"expected": expected_parameter, "actual": actual_snapshot[edit["parameter"]], "passed": abs(actual_snapshot[edit["parameter"]] - expected_parameter) <= LINEAR_TOLERANCE_MM}
        elif edit["parameter"] in ("spacing_x", "spacing_y"):
            expected_parameter = float(expected_feature["grid"][edit["parameter"]])
            checks["parameter_" + edit["parameter"]] = {"expected": expected_parameter, "actual": actual_snapshot[edit["parameter"]], "passed": actual_snapshot[edit["parameter"]] is not None and abs(actual_snapshot[edit["parameter"]] - expected_parameter) <= LINEAR_TOLERANCE_MM}
    checks.update({
        "body_tip": {"expected": bindings[source_plan["features"][-1]["id"]]["feature_object"], "actual": actual_snapshot["body_tip"], "passed": actual_snapshot["body_tip"] == bindings[source_plan["features"][-1]["id"]]["feature_object"]},
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
        elif edit["parameter"] == "length":
            feature.Length = float(edit["old_value"])
        elif edit["parameter"] == "diameter":
            for name in diameter_constraint_names:
                sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
        elif edit["parameter"] in ("center_x", "center_y"):
            sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
        else:
            coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
            for center, name in zip(source_feature["centers"], spacing_constraint_names):
                sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(center[coordinate_key]) + " mm"))
        metadata.IsManagedModel = True
        metadata.ResolvedPlanJson = json.dumps(source_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        metadata.PlanDigest = source_plan_digest
        metadata.ModelRevision = int(edit["model_revision"])
        doc.recompute()
        if feature_type == "rectangular_pad":
            rollback_values = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
            rollback_geometry_ok = True
        else:
            rollback_diameters = [float(sketch.Geometry[int(sketch.Constraints[parameter_indices[name]].First)].Radius) * 2.0 for name in diameter_constraint_names]
            rollback_circle = sketch.Geometry[target_circle_index if target_circle_index is not None else int(sketch.Constraints[parameter_indices[diameter_constraint_names[0]]].First)]
            rollback_values = {"diameter": rollback_diameters[0] if rollback_diameters else None, "center_x": float(rollback_circle.Center.x), "center_y": float(rollback_circle.Center.y), "width": float(base_sketch.getDatum(base_parameter_indices["width"]).Value), "height": float(base_sketch.getDatum(base_parameter_indices["height"]).Value), "length": float(base_feature.Length.Value)}
            if edit["parameter"] in ("spacing_x", "spacing_y"):
                coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
                axis_values = sorted(set(round(float(sketch.Geometry[index].Center.x if coordinate_key == "x" else sketch.Geometry[index].Center.y), 12) for index in circle_indices))
                rollback_values[edit["parameter"]] = axis_values[1] - axis_values[0] if len(axis_values) > 1 else None
            rollback_signature = inspect_geometry(body.Tip.Shape)
            rollback_holes = inspect_holes(rollback_signature)
            rollback_geometry_ok = len(rollback_holes) == len(source_holes) and abs(float(rollback_signature["volume"]) - float(source_geometry_signature["volume"])) <= VOLUME_TOLERANCE_MM3 and all(abs(float(rollback_signature["bounding_box"][axis]) - float(source_geometry_signature["bounding_box"][axis])) <= LINEAR_TOLERANCE_MM for axis in ("x", "y", "z")) and all(abs(rollback_holes[index]["x"] - source_holes[index]["x"]) <= LINEAR_TOLERANCE_MM and abs(rollback_holes[index]["y"] - source_holes[index]["y"]) <= LINEAR_TOLERANCE_MM and abs(rollback_holes[index]["radius"] - source_holes[index]["radius"]) <= LINEAR_TOLERANCE_MM for index in range(len(source_holes)))
        rollback_ok = all(abs(rollback_values[name] - source_values[name]) <= LINEAR_TOLERANCE_MM for name in source_values) and rollback_geometry_ok and int(metadata.ModelRevision) == int(edit["model_revision"]) and str(metadata.PlanDigest) == source_plan_digest and json.loads(metadata.ResolvedPlanJson) == source_plan
        _mcp_result["result"] = {"success": False, "status": "verification_failed", "code": "CAD_EDIT_VERIFICATION_FAILED", "issues": issues, "geometry_signature": geometry_signature, "verification": verification, "rollback": {"passed": rollback_ok, "parameter": edit["parameter"], "value": rollback_values[edit["parameter"]], "width": rollback_values.get("width"), "height": rollback_values.get("height"), "length": rollback_values.get("length"), "diameter": rollback_values.get("diameter"), "center_x": rollback_values.get("center_x"), "center_y": rollback_values.get("center_y"), "spacing_x": rollback_values.get("spacing_x"), "spacing_y": rollback_values.get("spacing_y"), "model_revision": int(metadata.ModelRevision), "plan_digest": str(metadata.PlanDigest)}}
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
    rollback = None
    if doc is not None and transaction_open:
        try:
            doc.abortTransaction()
            if sketch is not None and feature is not None and edit["parameter"] in parameter_indices:
                sketch.setDatum(parameter_indices[edit["parameter"]], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
            elif feature is not None and edit["parameter"] == "length":
                feature.Length = float(edit["old_value"])
            elif sketch is not None and edit["parameter"] == "diameter":
                for name in diameter_constraint_names:
                    if name in parameter_indices:
                        sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(edit["old_value"]) + " mm"))
            elif sketch is not None and edit["parameter"] in ("spacing_x", "spacing_y"):
                coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
                for center, name in zip(source_feature["centers"], spacing_constraint_names):
                    if name in parameter_indices:
                        sketch.setDatum(parameter_indices[name], FreeCAD.Units.Quantity(str(center[coordinate_key]) + " mm"))
            if metadata is not None:
                metadata.IsManagedModel = True
                metadata.ResolvedPlanJson = json.dumps(source_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
                metadata.PlanDigest = source_plan_digest
                metadata.ModelRevision = int(edit["model_revision"])
            doc.recompute()
            if feature_type == "hole_pattern":
                restored_diameters = [float(sketch.Geometry[int(sketch.Constraints[parameter_indices[name]].First)].Radius) * 2.0 for name in diameter_constraint_names]
                restored_circle = sketch.Geometry[target_circle_index if target_circle_index is not None else int(sketch.Constraints[parameter_indices[diameter_constraint_names[0]]].First)]
                restored_signature = inspect_geometry(body.Tip.Shape)
                restored_holes = inspect_holes(restored_signature)
                restored_values = {"diameter": restored_diameters[0] if restored_diameters else None, "center_x": float(restored_circle.Center.x), "center_y": float(restored_circle.Center.y)}
                if edit["parameter"] in ("spacing_x", "spacing_y"):
                    coordinate_key = "x" if edit["parameter"] == "spacing_x" else "y"
                    axis_values = sorted(set(round(float(sketch.Geometry[index].Center.x if coordinate_key == "x" else sketch.Geometry[index].Center.y), 12) for index in circle_indices))
                    restored_values[edit["parameter"]] = axis_values[1] - axis_values[0] if len(axis_values) > 1 else None
                rollback_ok = all(abs(restored_values[name] - source_values[name]) <= LINEAR_TOLERANCE_MM for name in source_values) and len(restored_diameters) == len(diameter_constraint_names) and len(restored_holes) == len(source_holes) and abs(float(restored_signature["volume"]) - float(source_geometry_signature["volume"])) <= VOLUME_TOLERANCE_MM3 and all(abs(restored_holes[index]["x"] - source_holes[index]["x"]) <= LINEAR_TOLERANCE_MM and abs(restored_holes[index]["y"] - source_holes[index]["y"]) <= LINEAR_TOLERANCE_MM and abs(restored_holes[index]["radius"] - source_holes[index]["radius"]) <= LINEAR_TOLERANCE_MM for index in range(len(source_holes)))
                rollback = {"passed": rollback_ok, **restored_values}
            else:
                restored_values = {"width": float(sketch.getDatum(parameter_indices["width"]).Value), "height": float(sketch.getDatum(parameter_indices["height"]).Value), "length": float(feature.Length.Value)}
                rollback = {"passed": all(abs(restored_values[name] - source_values[name]) <= LINEAR_TOLERANCE_MM for name in source_values), **restored_values}
            if rollback is not None:
                rollback["passed"] = rollback["passed"] and int(metadata.ModelRevision) == int(edit["model_revision"]) and str(metadata.PlanDigest) == source_plan_digest and json.loads(metadata.ResolvedPlanJson) == source_plan
                rollback["model_revision"] = int(metadata.ModelRevision)
                rollback["plan_digest"] = str(metadata.PlanDigest)
        except Exception as rollback_error:
            rollback = {"passed": False, "error": str(rollback_error)}
    result = {"success": False, "status": "execution_failed", "code": "CAD_EDIT_EXECUTION_FAILED", "error": str(error)}
    if rollback is not None:
        result["rollback"] = rollback
    _mcp_result["result"] = result
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

function resolvedPlanAsValidationInput(plan: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(plan);
  if (!Array.isArray(copy.features)) return copy;
  copy.features = copy.features.map((feature) => {
    if (!isRecord(feature) || feature.type !== 'hole_pattern' || !Array.isArray(feature.centers)) return feature;
    const { centers, center_editable: _centerEditable, grid, ...rest } = feature;
    if (isRecord(grid)
      && typeof grid.columns === 'number' && typeof grid.rows === 'number'
      && typeof grid.spacing_x === 'number' && typeof grid.spacing_y === 'number'
      && typeof grid.pattern_center_x === 'number' && typeof grid.pattern_center_y === 'number') {
      return {
        ...rest,
        placement: {
          type: 'rectangular_grid', columns: grid.columns, rows: grid.rows,
          origin: {
            x: grid.pattern_center_x - ((grid.columns - 1) * grid.spacing_x) / 2,
            y: grid.pattern_center_y - ((grid.rows - 1) * grid.spacing_y) / 2,
          },
          spacing_x: grid.spacing_x, spacing_y: grid.spacing_y,
        },
      };
    }
    return { ...rest, placement: { type: 'explicit', centers } };
  });
  return copy;
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
  const geometryValidation = validateCadPlan(resolvedPlanAsValidationInput(internal.expected_resolved_plan));
  if (geometryValidation.status !== 'valid' || geometryValidation.can_execute !== true) {
    gate.completeValidation(revision);
    return result({
      status: geometryValidation.status,
      can_execute: false,
      issues: geometryValidation.issues,
    });
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
