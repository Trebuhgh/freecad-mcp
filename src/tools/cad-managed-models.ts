import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { LINEAR_TOLERANCE_MM } from './cad-geometry-tolerances.js';

export const CAD_MANAGED_MODEL_TOOLS = [{
  name: 'cad_list_managed_models',
  description: 'Read-only discovery of every valid managed model currently open in FreeCAD. Returns rectangular_pad dimensions; semantic rectangular_pocket face, size, position, depth, and target; semantic rectangular_addition face, size, position, length, and target; hole_pattern diameter; center_x/center_y for a positions-editable singleton explicit hole; and spacing_x/spacing_y for supported rectangular-grid axes through persistent semantic bindings. Never selects a model automatically.',
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

def semantic_face_frame(face, bounds):
    if face == "top":
        return FreeCAD.Vector(bounds.XMin, bounds.YMin, bounds.ZMax), FreeCAD.Vector(1, 0, 0), FreeCAD.Vector(0, 1, 0), False
    if face == "front":
        return FreeCAD.Vector(bounds.XMin, bounds.YMin, bounds.ZMin), FreeCAD.Vector(1, 0, 0), FreeCAD.Vector(0, 0, 1), False
    if face == "back":
        return FreeCAD.Vector(bounds.XMin, bounds.YMax, bounds.ZMin), FreeCAD.Vector(1, 0, 0), FreeCAD.Vector(0, 0, 1), True
    if face == "left":
        return FreeCAD.Vector(bounds.XMin, bounds.YMin, bounds.ZMin), FreeCAD.Vector(0, 1, 0), FreeCAD.Vector(0, 0, 1), True
    if face == "right":
        return FreeCAD.Vector(bounds.XMax, bounds.YMin, bounds.ZMin), FreeCAD.Vector(0, 1, 0), FreeCAD.Vector(0, 0, 1), False
    raise ManagedModelIssue("FEATURE_BINDING_INVALID", "The semantic face is unsupported.")

def semantic_target_bounds(feature_plan, feature_object, bindings, doc):
    if feature_plan.get("type") != "rectangular_addition":
        return feature_object.Shape.BoundBox
    predecessor_id = feature_plan.get("after")
    predecessor_binding = bindings.get(predecessor_id, {}) if isinstance(predecessor_id, str) else {}
    predecessor_object = doc.getObject(predecessor_binding.get("feature_object", "")) if isinstance(predecessor_binding, dict) else None
    require(predecessor_object is not None, "FEATURE_CHAIN_MISMATCH", "The rectangular_addition predecessor needed for target-local placement is missing.")
    added_shape = feature_object.Shape.cut(predecessor_object.Shape)
    require(not added_shape.isNull() and added_shape.isValid() and float(added_shape.Volume) > 0.0, "FEATURE_BINDING_INVALID", "The rectangular_addition material delta needed for target-local placement is invalid.")
    return added_shape.BoundBox

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
        resolved_features_by_id = {feature.get("id"): feature for feature in resolved_plan["features"] if isinstance(feature, dict) and isinstance(feature.get("id"), str)}
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
            elif feature_type == "rectangular_pocket":
                require(feature_object.TypeId == "PartDesign::Pocket" and binding.get("feature_type_id") == "PartDesign::Pocket", "BOUND_OBJECT_TYPE_MISMATCH", "The rectangular_pocket binding does not reference a PartDesign Pocket.")
                sketch = doc.getObject(binding.get("sketch_object", ""))
                require(sketch is not None and sketch.TypeId == "Sketcher::SketchObject", "BOUND_OBJECT_NOT_FOUND", "The bound rectangular_pocket Sketch no longer exists.")
                body = feature_object.getParentGeoFeatureGroup()
                profile_value = feature_object.Profile
                profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                target_id = feature_plan.get("target")
                target_binding = bindings.get(target_id, {}) if isinstance(target_id, str) else {}
                target_object = doc.getObject(target_binding.get("feature_object", "")) if isinstance(target_binding, dict) else None
                require(body is not None and body.TypeId == "PartDesign::Body" and feature_object in body.Group and sketch in body.Group and profile_object == sketch and target_object in body.Group, "FEATURE_CHAIN_MISMATCH", "The rectangular_pocket binding no longer matches its Body feature chain or semantic target.")
                require(binding.get("semantic_face") == feature_plan.get("face") and binding.get("target_feature_id") == target_id, "FEATURE_BINDING_INVALID", "The rectangular_pocket semantic face or target binding differs from the resolved plan.")
                target_plan = resolved_features_by_id.get(target_id, {})
                expected_origin, expected_x, expected_y, expected_reversed = semantic_face_frame(feature_plan["face"], semantic_target_bounds(target_plan, target_object, bindings, doc))
                actual_origin = sketch.Placement.multVec(FreeCAD.Vector(0, 0, 0))
                actual_x = sketch.Placement.multVec(FreeCAD.Vector(1, 0, 0)).sub(actual_origin)
                actual_y = sketch.Placement.multVec(FreeCAD.Vector(0, 1, 0)).sub(actual_origin)
                require(actual_origin.sub(expected_origin).Length <= LINEAR_TOLERANCE_MM and actual_x.sub(expected_x).Length <= LINEAR_TOLERANCE_MM and actual_y.sub(expected_y).Length <= LINEAR_TOLERANCE_MM and bool(feature_object.Reversed) == expected_reversed, "FEATURE_BINDING_INVALID", "The rectangular_pocket semantic placement or cut direction differs from its persistent face binding.")
                parameter_bindings = binding.get("parameters", {})
                require(all(name in parameter_bindings for name in ("width", "height", "position_x", "position_y", "depth")), "FEATURE_BINDING_MISSING", "rectangular_pocket parameter bindings are incomplete.")
                for name in ("width", "height", "position_x", "position_y"):
                    item = parameter_bindings[name]
                    require(isinstance(item, dict) and item.get("kind") == "sketch_constraint" and item.get("constraint_name") == name and item.get("object") == binding.get("sketch_object") and item.get("unit") == "mm", "FEATURE_BINDING_INVALID", "A rectangular_pocket Sketch parameter binding is invalid.")
                    indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                    require(len(indices) == 1, "FEATURE_BINDING_INVALID", "A named rectangular_pocket constraint does not exist exactly once.")
                    parameters[name] = float(sketch.getDatum(indices[0]).Value)
                depth_binding = parameter_bindings["depth"]
                require(isinstance(depth_binding, dict) and depth_binding.get("kind") == "feature_property" and depth_binding.get("property") == "Length" and depth_binding.get("object") == binding.get("feature_object") and depth_binding.get("unit") == "mm", "FEATURE_BINDING_INVALID", "The rectangular_pocket depth binding is invalid.")
                parameters["depth"] = float(feature_object.Length.Value)
                expected_position = feature_plan.get("position", {})
                require(abs(parameters["width"] - float(feature_plan.get("width"))) <= LINEAR_TOLERANCE_MM and abs(parameters["height"] - float(feature_plan.get("height"))) <= LINEAR_TOLERANCE_MM and abs(parameters["position_x"] - float(expected_position.get("x"))) <= LINEAR_TOLERANCE_MM and abs(parameters["position_y"] - float(expected_position.get("y"))) <= LINEAR_TOLERANCE_MM and abs(parameters["depth"] - float(feature_plan.get("depth"))) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_MISMATCH", "Actual rectangular_pocket parameters differ from the persistent resolved plan.")
                parameters = {"face": feature_plan["face"], "width": parameters["width"], "height": parameters["height"], "position": {"x": parameters["position_x"], "y": parameters["position_y"]}, "depth": parameters["depth"], "target": target_id}
            elif feature_type == "rectangular_addition":
                require(feature_object.TypeId == "PartDesign::Pad" and binding.get("feature_type_id") == "PartDesign::Pad", "BOUND_OBJECT_TYPE_MISMATCH", "The rectangular_addition binding does not reference a PartDesign Pad.")
                sketch = doc.getObject(binding.get("sketch_object", ""))
                require(sketch is not None and sketch.TypeId == "Sketcher::SketchObject", "BOUND_OBJECT_NOT_FOUND", "The bound rectangular_addition Sketch no longer exists.")
                body = feature_object.getParentGeoFeatureGroup()
                profile_value = feature_object.Profile
                profile_object = profile_value[0] if isinstance(profile_value, tuple) else profile_value
                target_id = feature_plan.get("target")
                target_binding = bindings.get(target_id, {}) if isinstance(target_id, str) else {}
                target_object = doc.getObject(target_binding.get("feature_object", "")) if isinstance(target_binding, dict) else None
                require(body is not None and body.TypeId == "PartDesign::Body" and feature_object in body.Group and sketch in body.Group and profile_object == sketch and target_object in body.Group, "FEATURE_CHAIN_MISMATCH", "The rectangular_addition binding no longer matches its Body feature chain or semantic target.")
                require(binding.get("semantic_face") == feature_plan.get("face") and binding.get("target_feature_id") == target_id, "FEATURE_BINDING_INVALID", "The rectangular_addition semantic face or target binding differs from the resolved plan.")
                target_plan = resolved_features_by_id.get(target_id, {})
                expected_origin, expected_x, expected_y, expected_reversed = semantic_face_frame(feature_plan["face"], semantic_target_bounds(target_plan, target_object, bindings, doc))
                actual_origin = sketch.Placement.multVec(FreeCAD.Vector(0, 0, 0))
                actual_x = sketch.Placement.multVec(FreeCAD.Vector(1, 0, 0)).sub(actual_origin)
                actual_y = sketch.Placement.multVec(FreeCAD.Vector(0, 1, 0)).sub(actual_origin)
                require(actual_origin.sub(expected_origin).Length <= LINEAR_TOLERANCE_MM and actual_x.sub(expected_x).Length <= LINEAR_TOLERANCE_MM and actual_y.sub(expected_y).Length <= LINEAR_TOLERANCE_MM and bool(feature_object.Reversed) == expected_reversed, "FEATURE_BINDING_INVALID", "The rectangular_addition semantic placement or extrusion direction differs from its persistent face binding.")
                if "SideType" in feature_object.PropertiesList:
                    require(str(feature_object.SideType).lower().replace(" ", "") == "oneside", "FEATURE_BINDING_INVALID", "The rectangular_addition Pad is not one-sided.")
                parameter_bindings = binding.get("parameters", {})
                require(all(name in parameter_bindings for name in ("width", "height", "position_x", "position_y", "length")), "FEATURE_BINDING_MISSING", "rectangular_addition parameter bindings are incomplete.")
                for name in ("width", "height", "position_x", "position_y"):
                    item = parameter_bindings[name]
                    require(isinstance(item, dict) and item.get("kind") == "sketch_constraint" and item.get("constraint_name") == name and item.get("object") == binding.get("sketch_object") and item.get("unit") == "mm", "FEATURE_BINDING_INVALID", "A rectangular_addition Sketch parameter binding is invalid.")
                    indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == name]
                    require(len(indices) == 1, "FEATURE_BINDING_INVALID", "A named rectangular_addition constraint does not exist exactly once.")
                    parameters[name] = float(sketch.getDatum(indices[0]).Value)
                length_binding = parameter_bindings["length"]
                require(isinstance(length_binding, dict) and length_binding.get("kind") == "feature_property" and length_binding.get("property") == "Length" and length_binding.get("object") == binding.get("feature_object") and length_binding.get("unit") == "mm", "FEATURE_BINDING_INVALID", "The rectangular_addition length binding is invalid.")
                parameters["length"] = float(feature_object.Length.Value)
                expected_position = feature_plan.get("position", {})
                require(abs(parameters["width"] - float(feature_plan.get("width"))) <= LINEAR_TOLERANCE_MM and abs(parameters["height"] - float(feature_plan.get("height"))) <= LINEAR_TOLERANCE_MM and abs(parameters["position_x"] - float(expected_position.get("x"))) <= LINEAR_TOLERANCE_MM and abs(parameters["position_y"] - float(expected_position.get("y"))) <= LINEAR_TOLERANCE_MM and abs(parameters["length"] - float(feature_plan.get("length"))) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_MISMATCH", "Actual rectangular_addition parameters differ from the persistent resolved plan.")
                parameters = {"face": feature_plan["face"], "width": parameters["width"], "height": parameters["height"], "position": {"x": parameters["position_x"], "y": parameters["position_y"]}, "length": parameters["length"], "target": target_id}
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
                if feature_plan.get("center_editable") is True:
                    require(len(centers) == 1, "RESOLVED_PLAN_INVALID", "A positions-editable hole_pattern must contain exactly one center.")
                    circle = sketch.Geometry[geometry_indices[0]]
                    for name, constraint_type, coordinate in (("center_x", "DistanceX", float(circle.Center.x)), ("center_y", "DistanceY", float(circle.Center.y))):
                        position_binding = binding.get("parameters", {}).get(name)
                        constraint_name = position_binding.get("constraint_name") if isinstance(position_binding, dict) else None
                        indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == constraint_name]
                        require(isinstance(position_binding, dict) and position_binding.get("kind") == "sketch_constraint" and position_binding.get("object") == binding.get("sketch_object") and position_binding.get("unit") == "mm" and isinstance(constraint_name, str) and len(indices) == 1, "FEATURE_BINDING_INVALID", "A singleton hole position binding is invalid.")
                        constraint = sketch.Constraints[indices[0]]
                        require(constraint.Type == constraint_type and int(constraint.Second) == geometry_indices[0] and abs(float(sketch.getDatum(indices[0]).Value) - coordinate) <= LINEAR_TOLERANCE_MM, "FEATURE_BINDING_INVALID", "A singleton hole position constraint does not match its circle center.")
                        require(abs(coordinate - float(centers[0]["x" if name == "center_x" else "y"])) <= LINEAR_TOLERANCE_MM, "MODEL_STATE_MISMATCH", "Actual hole position differs from the persistent resolved plan.")
                        parameters[name] = coordinate
                grid = feature_plan.get("grid")
                if isinstance(grid, dict):
                    columns = int(grid.get("columns", 0))
                    rows = int(grid.get("rows", 0))
                    require(columns > 0 and rows > 0 and columns * rows == len(centers), "RESOLVED_PLAN_INVALID", "Grid metadata does not match the resolved hole centers.")
                    for name, count, constraint_type, coordinate_key in (("spacing_x", columns, "DistanceX", "x"), ("spacing_y", rows, "DistanceY", "y")):
                        if count <= 1:
                            continue
                        spacing = float(grid.get(name))
                        pattern_center = float(grid.get("pattern_center_x" if name == "spacing_x" else "pattern_center_y"))
                        position_binding = binding.get("parameters", {}).get(name)
                        constraint_names = position_binding.get("constraint_names") if isinstance(position_binding, dict) else None
                        require(isinstance(position_binding, dict) and position_binding.get("kind") == "grid_position_constraints" and position_binding.get("object") == binding.get("sketch_object") and position_binding.get("unit") == "mm" and isinstance(constraint_names, list) and len(constraint_names) == len(centers) and len(set(constraint_names)) == len(constraint_names), "FEATURE_BINDING_INVALID", "A grid spacing binding is invalid.")
                        for center_index, constraint_name in enumerate(constraint_names):
                            indices = [index for index, constraint in enumerate(sketch.Constraints) if constraint.Name == constraint_name]
                            require(len(indices) == 1, "FEATURE_BINDING_INVALID", "A grid position constraint is missing or duplicated.")
                            constraint = sketch.Constraints[indices[0]]
                            require(constraint.Type == constraint_type and int(constraint.Second) == geometry_indices[center_index], "FEATURE_BINDING_INVALID", "A grid position constraint does not match its circle.")
                            actual_coordinate = float(sketch.Geometry[geometry_indices[center_index]].Center.x if coordinate_key == "x" else sketch.Geometry[geometry_indices[center_index]].Center.y)
                            require(abs(float(sketch.getDatum(indices[0]).Value) - actual_coordinate) <= LINEAR_TOLERANCE_MM, "FEATURE_BINDING_INVALID", "A grid position constraint datum differs from its circle center.")
                        axis_values = sorted(set(round(float(center[coordinate_key]), 12) for center in centers))
                        require(len(axis_values) == count and abs(axis_values[0] + axis_values[-1] - 2.0 * pattern_center) <= LINEAR_TOLERANCE_MM and all(abs((axis_values[index + 1] - axis_values[index]) - spacing) <= LINEAR_TOLERANCE_MM for index in range(len(axis_values) - 1)), "MODEL_STATE_MISMATCH", "Actual grid spacing or pattern center differs from the persistent resolved plan.")
                        parameters[name] = spacing
            semantic_features.append({"id": feature_id, "type": feature_type, "parameters": parameters})
        if resolved_plan["features"]:
            final_binding = bindings[resolved_plan["features"][-1]["id"]]
            final_object = doc.getObject(final_binding.get("feature_object", ""))
            final_body = final_object.getParentGeoFeatureGroup() if final_object is not None else None
            require(final_body is not None and final_body.Tip == final_object, "FEATURE_CHAIN_MISMATCH", "Body.Tip is not the final managed feature.")
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
