import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { LINEAR_TOLERANCE_MM } from './cad-geometry-tolerances.js';

export const CAD_MANAGED_MODEL_TOOLS = [{
  name: 'cad_list_managed_models',
  description: 'Read-only discovery of every valid managed model currently open in FreeCAD. Returns rectangular_pad width/height/length and hole_pattern diameter through persistent semantic bindings. Never selects a model automatically.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
    required: [],
  },
}];

function discoveryPython(): string {
  return `
import FreeCAD
import hashlib
import json
import uuid
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}
models = []
issues = []

class ManagedModelIssue(Exception):
    def __init__(self, code, message):
        self.code = code
        self.message = message

def require(condition, code, message):
    if not condition:
        raise ManagedModelIssue(code, message)

for document_name in sorted(FreeCAD.listDocuments().keys()):
    doc = FreeCAD.getDocument(document_name)
    metadata = doc.getObject("ManagedModelMetadata")
    if metadata is None:
        continue
    try:
        required = ("IsManagedModel", "ModelId", "ModelRevision", "PlanDigest", "ResolvedPlanJson", "FeatureBindingsJson")
        require(all(name in metadata.PropertiesList for name in required), "MODEL_METADATA_INVALID", "Managed-model metadata properties are incomplete.")
        require(bool(metadata.IsManagedModel), "MODEL_NOT_MANAGED", "Managed-model metadata is not marked valid.")
        model_id = str(metadata.ModelId)
        try:
            parsed_id = uuid.UUID(model_id)
        except Exception:
            raise ManagedModelIssue("MODEL_ID_INVALID", "ModelId is not a valid UUID.")
        require(str(parsed_id) == model_id.lower(), "MODEL_ID_INVALID", "ModelId is not in canonical UUID form.")
        model_revision = int(metadata.ModelRevision)
        require(model_revision >= 1, "MODEL_REVISION_INVALID", "ModelRevision must be a positive integer.")
        plan_digest = str(metadata.PlanDigest)
        require(plan_digest.startswith("sha256:") and len(plan_digest) == 71, "PLAN_DIGEST_INVALID", "PlanDigest is missing or malformed.")
        try:
            resolved_plan = json.loads(metadata.ResolvedPlanJson)
        except Exception:
            raise ManagedModelIssue("RESOLVED_PLAN_INVALID", "ResolvedPlanJson is not valid JSON.")
        require(isinstance(resolved_plan, dict) and isinstance(resolved_plan.get("features"), list), "RESOLVED_PLAN_INVALID", "ResolvedPlanJson does not contain a canonical feature plan.")
        canonical_plan = json.dumps(resolved_plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        actual_digest = "sha256:" + hashlib.sha256(canonical_plan.encode("utf-8")).hexdigest()
        require(plan_digest == actual_digest, "PLAN_DIGEST_MISMATCH", "PlanDigest does not match the canonical resolved plan.")
        try:
            bindings = json.loads(metadata.FeatureBindingsJson)
        except Exception:
            raise ManagedModelIssue("FEATURE_BINDINGS_INVALID", "FeatureBindingsJson is not valid JSON.")
        require(isinstance(bindings, dict), "FEATURE_BINDINGS_INVALID", "FeatureBindingsJson must contain an object keyed by feature ID.")

        semantic_features = []
        seen_ids = set()
        for feature_plan in resolved_plan["features"]:
            require(isinstance(feature_plan, dict), "RESOLVED_PLAN_INVALID", "A resolved feature is not an object.")
            feature_id = feature_plan.get("id")
            feature_type = feature_plan.get("type")
            require(isinstance(feature_id, str) and feature_id and feature_id not in seen_ids, "RESOLVED_PLAN_INVALID", "Feature IDs must be non-empty and unique.")
            seen_ids.add(feature_id)
            require(feature_id in bindings and isinstance(bindings[feature_id], dict), "FEATURE_BINDING_MISSING", "A persistent feature binding is missing.")
            binding = bindings[feature_id]
            require(binding.get("type") == feature_type, "FEATURE_BINDING_INVALID", "Feature binding type does not match the resolved plan.")
            feature_object = doc.getObject(binding.get("feature_object", ""))
            require(feature_object is not None, "BOUND_OBJECT_NOT_FOUND", "A bound FreeCAD feature no longer exists.")
            parameters = {}
            if feature_type == "rectangular_pad":
                require(feature_object.TypeId == "PartDesign::Pad" and binding.get("feature_type_id") == "PartDesign::Pad", "BOUND_OBJECT_TYPE_MISMATCH", "The rectangular_pad binding does not reference a PartDesign Pad.")
                sketch = doc.getObject(binding.get("sketch_object", ""))
                require(sketch is not None and sketch.TypeId == "Sketcher::SketchObject", "BOUND_OBJECT_NOT_FOUND", "The bound rectangular_pad Sketch no longer exists.")
                body = feature_object.getParentGeoFeatureGroup()
                profile_value = feature_object.Profile
                profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                require(body is not None and body.TypeId == "PartDesign::Body" and feature_object in body.Group and sketch in body.Group and profile_object == sketch, "FEATURE_CHAIN_MISMATCH", "The rectangular_pad binding no longer matches its Body feature chain.")
                parameter_bindings = binding.get("parameters", {})
                require(all(name in parameter_bindings for name in ("width", "height", "length")), "FEATURE_BINDING_MISSING", "rectangular_pad parameter bindings are incomplete.")
                for name in ("width", "height"):
                    item = parameter_bindings[name]
                    require(isinstance(item, dict) and item.get("kind") == "sketch_constraint" and item.get("constraint_name") == name and item.get("object") == binding.get("sketch_object") and item.get("unit") == "mm", "FEATURE_BINDING_INVALID", "A rectangular_pad Sketch parameter binding is invalid.")
                    indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                    require(len(indices) == 1, "FEATURE_BINDING_INVALID", "A named rectangular_pad constraint does not exist exactly once.")
                    parameters[name] = float(sketch.getDatum(indices[0]).Value)
                length_binding = parameter_bindings["length"]
                require(isinstance(length_binding, dict) and length_binding.get("kind") == "feature_property" and length_binding.get("property") == "Length" and length_binding.get("object") == binding.get("feature_object") and length_binding.get("unit") == "mm", "FEATURE_BINDING_INVALID", "The rectangular_pad length binding is invalid.")
                parameters["length"] = float(feature_object.Length.Value)
                require(all(name in feature_plan and abs(parameters[name] - float(feature_plan[name])) <= LINEAR_TOLERANCE_MM for name in ("width", "height", "length")), "MODEL_STATE_MISMATCH", "Actual rectangular_pad parameters differ from the persistent resolved plan.")
            elif feature_type == "hole_pattern":
                require(feature_object.TypeId == "PartDesign::Pocket" and binding.get("feature_type_id") == "PartDesign::Pocket", "BOUND_OBJECT_TYPE_MISMATCH", "The hole_pattern binding does not reference a PartDesign Pocket.")
                sketch = doc.getObject(binding.get("sketch_object", ""))
                require(sketch is not None and sketch.TypeId == "Sketcher::SketchObject", "BOUND_OBJECT_NOT_FOUND", "The bound hole_pattern Sketch no longer exists.")
                body = feature_object.getParentGeoFeatureGroup()
                profile_value = feature_object.Profile
                profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                require(body is not None and body.TypeId == "PartDesign::Body" and feature_object in body.Group and sketch in body.Group and profile_object == sketch, "FEATURE_CHAIN_MISMATCH", "The hole_pattern binding no longer matches its Body feature chain.")
                diameter_binding = binding.get("parameters", {}).get("diameter")
                centers = feature_plan.get("centers", [])
                names = diameter_binding.get("constraint_names") if isinstance(diameter_binding, dict) else None
                require(isinstance(diameter_binding, dict) and diameter_binding.get("kind") == "sketch_constraints" and diameter_binding.get("object") == binding.get("sketch_object") and diameter_binding.get("unit") == "mm" and isinstance(names, list) and len(names) == len(centers) and len(names) > 0 and len(set(names)) == len(names), "FEATURE_BINDING_INVALID", "The hole_pattern diameter binding is invalid.")
                diameters = []
                geometry_indices = []
                for center, name in zip(centers, names):
                    indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                    require(len(indices) == 1, "FEATURE_BINDING_INVALID", "A named hole diameter constraint does not exist exactly once.")
                    constraint = sketch.Constraints[indices[0]]
                    geometry_index = int(constraint.First)
                    require(constraint.Type == "Diameter" and geometry_index >= 0 and geometry_index < len(sketch.Geometry) and geometry_index not in geometry_indices, "FEATURE_BINDING_INVALID", "A hole diameter constraint is not bound to one unique circle.")
                    circle = sketch.Geometry[geometry_index]
                    require(circle.__class__.__name__ == "Circle" and abs(float(circle.Center.x) - float(center["x"])) <= LINEAR_TOLERANCE_MM and abs(float(circle.Center.y) - float(center["y"])) <= LINEAR_TOLERANCE_MM, "FEATURE_BINDING_INVALID", "A bound hole circle center differs from the resolved plan.")
                    geometry_indices.append(geometry_index)
                    diameters.append(float(circle.Radius) * 2.0)
                require(len([geometry for geometry in sketch.Geometry if geometry.__class__.__name__ == "Circle"]) == len(centers) and all(abs(value - float(feature_plan.get("diameter"))) <= LINEAR_TOLERANCE_MM for value in diameters), "MODEL_STATE_MISMATCH", "Actual hole diameters differ from the persistent resolved plan.")
                parameters["diameter"] = diameters[0]
            semantic_features.append({"id": feature_id, "type": feature_type, "parameters": parameters})
        models.append({"model_id": model_id, "model_revision": model_revision, "document": doc.Name, "features": semantic_features})
    except ManagedModelIssue as error:
        issues.append({"document": doc.Name, "code": error.code, "message": error.message})
    except Exception as error:
        issues.append({"document": doc.Name, "code": "MODEL_METADATA_INVALID", "message": str(error)})

models.sort(key=lambda item: (item["document"], item["model_id"]))
issues.sort(key=lambda item: (item["document"], item["code"]))
_mcp_result["result"] = {"models": models, "issues": issues}
`;
}

export async function handleCadListManagedModels(args: ToolArgs, bridge: FreeCADBridge): Promise<ToolResult> {
  if (Object.keys(args).length > 0) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ models: [], issues: [{ code: 'UNEXPECTED_FIELD', path: Object.keys(args)[0], message: 'cad_list_managed_models accepts no arguments.' }] }) }],
      isError: true,
    };
  }
  return bridge.run(discoveryPython());
}
