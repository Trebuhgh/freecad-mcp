import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { CadPlanValidationGate, cadPlanNotValidatedToolResult } from './cad-plan-validation.js';
import {
  AREA_TOLERANCE_MM2,
  DIRECTION_VECTOR_EPSILON_MM,
  LINEAR_TOLERANCE_MM,
  VOLUME_TOLERANCE_MM3,
} from './cad-geometry-tolerances.js';
import { cadGeometryInspectionPython } from './cad-geometry-inspection-python.js';
import { cadObjectStateInspectionPython } from './cad-object-state-python.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export { AREA_TOLERANCE_MM2, DIRECTION_VECTOR_EPSILON_MM, LINEAR_TOLERANCE_MM, VOLUME_TOLERANCE_MM3 };

function validateDocumentName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || value.length > 128) throw new Error('Invalid documentName: use letters, digits, and underscores, starting with a letter or underscore');
  return value;
}

function executionPython(plan: Record<string, unknown>, revision: number, requestedDocumentName: string | undefined): string {
  return `
import FreeCAD
import Part
import Sketcher
import hashlib
import json
import math
import uuid
plan = json.loads(${JSON.stringify(JSON.stringify(plan))})
plan_revision = ${revision}
resolved_plan_json = json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
plan_digest = "sha256:" + hashlib.sha256(resolved_plan_json.encode("utf-8")).hexdigest()
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}
AREA_TOLERANCE_MM2 = ${AREA_TOLERANCE_MM2}
VOLUME_TOLERANCE_MM3 = ${VOLUME_TOLERANCE_MM3}
DIRECTION_VECTOR_EPSILON_MM = ${DIRECTION_VECTOR_EPSILON_MM}
${cadObjectStateInspectionPython()}
requested_document_name = ${requestedDocumentName === undefined ? 'None' : JSON.stringify(requestedDocumentName)}
document_name = None
failed_feature = None
failed_feature_type = None
failed_step = "preflight"
doc = None

def check_object(obj, code):
    errors = cad_object_error_states(obj)
    if errors:
        raise RuntimeError(code + ": " + str(errors))

def attach_xy(sketch, body):
    support = next((item for item in body.Origin.OriginFeatures if getattr(item, "Role", "") == "XY_Plane"), None)
    if support is None:
        raise RuntimeError("ORIGIN_PLANE_NOT_FOUND: XY_Plane")
    if hasattr(sketch, "AttachmentSupport"):
        sketch.AttachmentSupport = (support, [""])
    elif hasattr(sketch, "Support"):
        sketch.Support = (support, [""])
    else:
        raise RuntimeError("SKETCH_ATTACHMENT_UNSUPPORTED")
    sketch.MapMode = "FlatFace"

def arc_sweep(segment):
    start_angle = math.atan2(segment["start"]["y"] - segment["center"]["y"], segment["start"]["x"] - segment["center"]["x"])
    end_angle = math.atan2(segment["end"]["y"] - segment["center"]["y"], segment["end"]["x"] - segment["center"]["x"])
    if segment["direction"] == "ccw":
        return (end_angle - start_angle) % (2.0 * math.pi)
    return -((start_angle - end_angle) % (2.0 * math.pi))

def arc_contains_angle(segment, angle):
    start_angle = math.atan2(segment["start"]["y"] - segment["center"]["y"], segment["start"]["x"] - segment["center"]["x"])
    sweep = arc_sweep(segment)
    travel = ((angle - start_angle) % (2.0 * math.pi)) if sweep > 0 else ((start_angle - angle) % (2.0 * math.pi))
    return travel <= abs(sweep) + LINEAR_TOLERANCE_MM / float(segment["radius"])

def profile_metrics(segments):
    area = 0.0
    points = []
    for segment in segments:
        start = segment["start"]
        end = segment["end"]
        points.extend([start, end])
        if segment["type"] == "line":
            area += (float(start["x"]) * float(end["y"]) - float(end["x"]) * float(start["y"])) / 2.0
        else:
            radius = float(segment["radius"])
            start_angle = math.atan2(float(start["y"]) - float(segment["center"]["y"]), float(start["x"]) - float(segment["center"]["x"]))
            end_angle = start_angle + arc_sweep(segment)
            area += (radius * radius * (end_angle - start_angle) + radius * float(segment["center"]["x"]) * (math.sin(end_angle) - math.sin(start_angle)) + radius * float(segment["center"]["y"]) * (math.cos(start_angle) - math.cos(end_angle))) / 2.0
            for angle in (0.0, math.pi / 2.0, math.pi, 3.0 * math.pi / 2.0):
                if arc_contains_angle(segment, angle):
                    points.append({"x": float(segment["center"]["x"]) + radius * math.cos(angle), "y": float(segment["center"]["y"]) + radius * math.sin(angle)})
    return {
        "area": abs(area),
        "bounds": {"min_x": min(float(point["x"]) for point in points), "max_x": max(float(point["x"]) for point in points), "min_y": min(float(point["y"]) for point in points), "max_y": max(float(point["y"]) for point in points)},
    }

def select_edges(source, selection):
    shape = source.Shape
    bounds = shape.BoundBox
    candidates = []
    for edge_index, edge in enumerate(shape.Edges, start=1):
        vertices = edge.Vertexes
        is_line = edge.Curve.__class__.__name__ == "Line" and len(vertices) >= 2
        direction = None
        if is_line:
            delta = vertices[-1].Point.sub(vertices[0].Point)
            if delta.Length > DIRECTION_VECTOR_EPSILON_MM:
                direction = (abs(delta.x / delta.Length), abs(delta.y / delta.Length), abs(delta.z / delta.Length))
        candidates.append({"subname": "Edge" + str(edge_index), "edge": edge, "vertices": vertices, "direction": direction, "adjacent": [face.Surface.__class__.__name__ for face in shape.ancestorsOfType(edge, Part.Face)]})
    tolerance = LINEAR_TOLERANCE_MM
    if selection == "all_vertical":
        selected = [item for item in candidates if item["direction"] is not None and item["direction"][2] > 1.0 - tolerance and "Cylinder" not in item["adjacent"]]
    elif selection in ("all_top", "all_bottom"):
        target_z = bounds.ZMax if selection == "all_top" else bounds.ZMin
        selected = [item for item in candidates if item["vertices"] and all(abs(vertex.Point.z - target_z) <= tolerance for vertex in item["vertices"])]
    elif selection in ("all_top_outer", "all_top_inner", "all_bottom_outer", "all_bottom_inner"):
        target_z = bounds.ZMax if selection.startswith("all_top") else bounds.ZMin
        outer_edges = []
        inner_edges = []
        for face in shape.Faces:
            if face.Surface.__class__.__name__ != "Plane" or not face.Vertexes or not all(abs(vertex.Point.z - target_z) <= tolerance for vertex in face.Vertexes):
                continue
            for wire in face.Wires:
                destination = outer_edges if wire.isSame(face.OuterWire) else inner_edges
                for wire_edge in wire.Edges:
                    if not any(existing.isSame(wire_edge) for existing in destination):
                        destination.append(wire_edge)
        requested = outer_edges if selection.endswith("outer") else inner_edges
        selected = [item for item in candidates if any(item["edge"].isSame(edge) for edge in requested)]
    else:
        raise ValueError("UNSUPPORTED_EDGE_SELECTOR: " + str(selection))
    if not selected:
        raise ValueError("EDGE_SELECTION_EMPTY: " + str(selection))
    return [item["subname"] for item in selected]

${cadGeometryInspectionPython()}

try:
    existing_documents = FreeCAD.listDocuments()
    if requested_document_name is None:
        document_number = 1
        while "CADPlan_" + str(document_number) in existing_documents:
            document_number += 1
        document_name = "CADPlan_" + str(document_number)
    else:
        document_name = requested_document_name
        if document_name in existing_documents:
            raise RuntimeError("CAD_DOCUMENT_ALREADY_EXISTS|" + document_name)
    features = plan["features"]
    base_plan = features[0]
    base_type = base_plan["type"]
    length = float(base_plan["length"])
    width = None
    height = None
    profile_points = None
    profile_segments = None
    expected_profile_area = None
    if base_type == "rectangular_pad":
        width = float(base_plan["width"])
        height = float(base_plan["height"])
        expected_bounds = {"x": width, "y": height, "z": length}
    elif base_type == "profile_pad":
        if "segments" in base_plan:
            profile_segments = []
            for source in base_plan["segments"]:
                segment = {"type": source["type"], "start": {"x": float(source["start"]["x"]), "y": float(source["start"]["y"])}, "end": {"x": float(source["end"]["x"]), "y": float(source["end"]["y"])}}
                if source["type"] == "arc":
                    segment["center"] = {"x": float(source["center"]["x"]), "y": float(source["center"]["y"])}
                    segment["direction"] = source["direction"]
                    segment["radius"] = math.hypot(segment["start"]["x"] - segment["center"]["x"], segment["start"]["y"] - segment["center"]["y"])
                profile_segments.append(segment)
        else:
            profile_points = [[float(point[0]), float(point[1])] for point in base_plan["points"]]
            profile_segments = [{"type": "line", "start": {"x": profile_points[index][0], "y": profile_points[index][1]}, "end": {"x": profile_points[(index + 1) % len(profile_points)][0], "y": profile_points[(index + 1) % len(profile_points)][1]}} for index in range(len(profile_points))]
        metrics = profile_metrics(profile_segments)
        expected_profile_area = metrics["area"]
        expected_bounds = {"x": metrics["bounds"]["max_x"] - metrics["bounds"]["min_x"], "y": metrics["bounds"]["max_y"] - metrics["bounds"]["min_y"], "z": length}
    else:
        raise RuntimeError("UNSUPPORTED_RESOLVED_BASE_FEATURE: " + str(base_type))
    executed_steps = []
    feature_results = []
    feature_bindings = {}
    expected_holes = []
    failed_step = "create_part"
    doc = FreeCAD.newDocument(document_name)
    doc.openTransaction("cad_execute_plan_r" + str(plan_revision))
    body = doc.addObject("PartDesign::Body", "Body")

    for feature_index, feature_plan in enumerate(features):
        feature_id = feature_plan["id"]
        feature_type = feature_plan["type"]
        failed_feature = feature_id
        failed_feature_type = feature_type
        failed_step = feature_type
        if feature_type == "rectangular_pad":
            sketch = body.newObject("Sketcher::SketchObject", "PlanSketch_" + str(feature_index))
            attach_xy(sketch, body)
            bottom = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(width, 0, 0)), False)
            right = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(width, 0, 0), FreeCAD.Vector(width, height, 0)), False)
            top = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(width, height, 0), FreeCAD.Vector(0, height, 0)), False)
            left = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(0, height, 0), FreeCAD.Vector(0, 0, 0)), False)
            for first, first_point, second, second_point in ((bottom, 2, right, 1), (right, 2, top, 1), (top, 2, left, 1), (left, 2, bottom, 1)):
                sketch.addConstraint(Sketcher.Constraint("Coincident", first, first_point, second, second_point))
            for constraint in (Sketcher.Constraint("Horizontal", bottom), Sketcher.Constraint("Vertical", right), Sketcher.Constraint("Horizontal", top), Sketcher.Constraint("Vertical", left)):
                sketch.addConstraint(constraint)
            width_constraint = sketch.addConstraint(Sketcher.Constraint("Distance", bottom, width))
            height_constraint = sketch.addConstraint(Sketcher.Constraint("Distance", right, height))
            sketch.renameConstraint(width_constraint, "width")
            sketch.renameConstraint(height_constraint, "height")
            sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, bottom, 1, 0.0))
            sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, bottom, 1, 0.0))
            solve_result = sketch.solve()
            doc.recompute()
            check_object(sketch, "BASE_SKETCH_RECOMPUTE_FAILED")
            if solve_result not in (None, 0) or not sketch.FullyConstrained or int(sketch.DoF) != 0 or len(sketch.Shape.Wires) != 1 or not sketch.Shape.Wires[0].isClosed():
                raise RuntimeError("BASE_SKETCH_VALIDATION_FAILED")
            pad = body.newObject("PartDesign::Pad", "PlanFeature_" + str(feature_index))
            pad.Label = feature_id
            pad.Profile = sketch
            pad.Length = length
            doc.recompute()
            check_object(pad, "PAD_RECOMPUTE_FAILED")
            if body.Tip != pad or pad.Shape.isNull() or not pad.Shape.isValid() or len(pad.Shape.Solids) != 1:
                raise RuntimeError("PAD_POSTCONDITION_FAILED")
            feature_bindings[feature_id] = {
                "type": feature_type,
                "feature_object": pad.Name,
                "feature_type_id": pad.TypeId,
                "sketch_object": sketch.Name,
                "parameters": {
                    "width": {"kind": "sketch_constraint", "object": sketch.Name, "constraint_name": "width", "unit": "mm"},
                    "height": {"kind": "sketch_constraint", "object": sketch.Name, "constraint_name": "height", "unit": "mm"},
                    "length": {"kind": "feature_property", "object": pad.Name, "property": "Length", "unit": "mm"},
                },
            }
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pad.Name, "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(sketch.DoF), "solid_valid": True})
        elif feature_type == "profile_pad":
            sketch = body.newObject("Sketcher::SketchObject", "PlanSketch_" + str(feature_index))
            attach_xy(sketch, body)
            segment_indices = []
            segment_start_positions = []
            segment_end_positions = []
            for segment_plan in profile_segments:
                start = segment_plan["start"]
                end = segment_plan["end"]
                if segment_plan["type"] == "line":
                    geometry = Part.LineSegment(FreeCAD.Vector(start["x"], start["y"], 0), FreeCAD.Vector(end["x"], end["y"], 0))
                else:
                    start_angle = math.atan2(start["y"] - segment_plan["center"]["y"], start["x"] - segment_plan["center"]["x"])
                    middle_angle = start_angle + arc_sweep(segment_plan) / 2.0
                    middle = FreeCAD.Vector(segment_plan["center"]["x"] + segment_plan["radius"] * math.cos(middle_angle), segment_plan["center"]["y"] + segment_plan["radius"] * math.sin(middle_angle), 0)
                    geometry = Part.Arc(FreeCAD.Vector(start["x"], start["y"], 0), middle, FreeCAD.Vector(end["x"], end["y"], 0))
                segment_indices.append(sketch.addGeometry(geometry, False))
                segment_start_positions.append(2 if segment_plan["type"] == "arc" and segment_plan["direction"] == "cw" else 1)
                segment_end_positions.append(1 if segment_plan["type"] == "arc" and segment_plan["direction"] == "cw" else 2)
            for point_index, segment in enumerate(segment_indices):
                next_segment = segment_indices[(point_index + 1) % len(segment_indices)]
                sketch.addConstraint(Sketcher.Constraint("Coincident", segment, segment_end_positions[point_index], next_segment, segment_start_positions[(point_index + 1) % len(segment_indices)]))
            for point_index, segment in enumerate(segment_indices):
                segment_plan = profile_segments[point_index]
                start_position = segment_start_positions[point_index]
                sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, segment, start_position, segment_plan["start"]["x"]))
                sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, segment, start_position, segment_plan["start"]["y"]))
                if segment_plan["type"] == "arc":
                    chord_dx = abs(segment_plan["end"]["x"] - segment_plan["start"]["x"])
                    chord_dy = abs(segment_plan["end"]["y"] - segment_plan["start"]["y"])
                    if chord_dy >= chord_dx:
                        sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, segment, 3, segment_plan["center"]["x"]))
                    else:
                        sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, segment, 3, segment_plan["center"]["y"]))
            solve_result = sketch.solve()
            doc.recompute()
            check_object(sketch, "PROFILE_SKETCH_RECOMPUTE_FAILED")
            actual_line_count = sum(1 for geometry in sketch.Geometry if geometry.__class__.__name__ == "LineSegment")
            actual_arc_geometries = [geometry for geometry in sketch.Geometry if geometry.__class__.__name__ in ("Arc", "ArcOfCircle")]
            expected_line_count = sum(1 for segment in profile_segments if segment["type"] == "line")
            expected_arc_count = sum(1 for segment in profile_segments if segment["type"] == "arc")
            arc_geometry_matches = len(actual_arc_geometries) == expected_arc_count
            if arc_geometry_matches:
                for segment_plan, geometry in zip([segment for segment in profile_segments if segment["type"] == "arc"], actual_arc_geometries):
                    arc_geometry_matches = arc_geometry_matches and abs(float(geometry.Radius) - float(segment_plan["radius"])) <= LINEAR_TOLERANCE_MM and geometry.Center.sub(FreeCAD.Vector(segment_plan["center"]["x"], segment_plan["center"]["y"], 0)).Length <= LINEAR_TOLERANCE_MM
            if solve_result not in (None, 0) or not sketch.FullyConstrained or int(sketch.DoF) != 0 or len(sketch.Geometry) != len(profile_segments) or actual_line_count != expected_line_count or not arc_geometry_matches or len(sketch.Shape.Wires) != 1 or not sketch.Shape.Wires[0].isClosed():
                raise RuntimeError("PROFILE_SKETCH_VALIDATION_FAILED")
            pad = body.newObject("PartDesign::Pad", "PlanFeature_" + str(feature_index))
            pad.Label = feature_id
            pad.Profile = sketch
            pad.Length = length
            if hasattr(pad, "Reversed"):
                pad.Reversed = False
            if hasattr(pad, "Midplane"):
                pad.Midplane = False
            doc.recompute()
            check_object(pad, "PROFILE_PAD_RECOMPUTE_FAILED")
            if body.Tip != pad or pad.Shape.isNull() or not pad.Shape.isValid() or len(pad.Shape.Solids) != 1 or float(pad.Shape.Volume) <= VOLUME_TOLERANCE_MM3:
                raise RuntimeError("PROFILE_PAD_POSTCONDITION_FAILED")
            feature_bindings[feature_id] = {"type": feature_type, "feature_object": pad.Name, "feature_type_id": pad.TypeId, "sketch_object": sketch.Name, "parameters": {"length": {"kind": "feature_property", "object": pad.Name, "property": "Length", "unit": "mm"}}}
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pad.Name, "object_type": pad.TypeId, "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(sketch.DoF), "segment_count": len(sketch.Geometry), "line_segment_count": actual_line_count, "arc_segment_count": len(actual_arc_geometries), "arc_radii": [float(geometry.Radius) for geometry in actual_arc_geometries], "arc_geometry_types": [geometry.__class__.__name__ for geometry in actual_arc_geometries], "solid_valid": True})
        elif feature_type == "hole_pattern":
            source_volume = float(body.Tip.Shape.Volume)
            diameter = float(feature_plan["diameter"])
            centers = feature_plan["centers"]
            hole_sketch = body.newObject("Sketcher::SketchObject", "PlanSketch_" + str(feature_index))
            attach_xy(hole_sketch, body)
            diameter_constraint_names = []
            center_x_constraint_names = []
            center_y_constraint_names = []
            for center_index, center in enumerate(centers):
                circle = hole_sketch.addGeometry(Part.Circle(FreeCAD.Vector(center["x"], center["y"], 0), FreeCAD.Vector(0, 0, 1), diameter / 2.0), False)
                diameter_constraint = hole_sketch.addConstraint(Sketcher.Constraint("Diameter", circle, diameter))
                diameter_constraint_name = "diameter_" + str(center_index)
                hole_sketch.renameConstraint(diameter_constraint, diameter_constraint_name)
                diameter_constraint_names.append(diameter_constraint_name)
                center_x_constraint = hole_sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, circle, 3, center["x"]))
                center_y_constraint = hole_sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, circle, 3, center["y"]))
                center_x_constraint_name = "center_x_" + str(center_index)
                center_y_constraint_name = "center_y_" + str(center_index)
                hole_sketch.renameConstraint(center_x_constraint, center_x_constraint_name)
                hole_sketch.renameConstraint(center_y_constraint, center_y_constraint_name)
                center_x_constraint_names.append(center_x_constraint_name)
                center_y_constraint_names.append(center_y_constraint_name)
            solve_result = hole_sketch.solve()
            doc.recompute()
            check_object(hole_sketch, "HOLE_SKETCH_RECOMPUTE_FAILED")
            if solve_result not in (None, 0) or not hole_sketch.FullyConstrained or int(hole_sketch.DoF) != 0 or len(hole_sketch.Shape.Wires) != len(centers) or any(not wire.isClosed() for wire in hole_sketch.Shape.Wires):
                raise RuntimeError("HOLE_SKETCH_VALIDATION_FAILED")
            pocket = body.newObject("PartDesign::Pocket", "PlanFeature_" + str(feature_index))
            pocket.Label = feature_id
            pocket.Profile = hole_sketch
            through_all = next((candidate for candidate in pocket.getEnumerationsOfProperty("Type") if candidate.replace(" ", "").replace("_", "").lower() == "throughall"), None)
            if through_all is None:
                raise RuntimeError("POCKET_TYPE_UNSUPPORTED: ThroughAll")
            pocket.Type = through_all
            doc.recompute()
            if hasattr(pocket, "Reversed") and not pocket.Shape.isNull() and float(pocket.Shape.Volume) >= source_volume - VOLUME_TOLERANCE_MM3:
                pocket.Reversed = not bool(pocket.Reversed)
                doc.recompute()
            check_object(pocket, "POCKET_RECOMPUTE_FAILED")
            if body.Tip != pocket or pocket.Shape.isNull() or not pocket.Shape.isValid() or len(pocket.Shape.Solids) != 1 or float(pocket.Shape.Volume) >= source_volume:
                raise RuntimeError("POCKET_POSTCONDITION_FAILED")
            hole_parameters = {"diameter": {"kind": "sketch_constraints", "object": hole_sketch.Name, "constraint_names": diameter_constraint_names, "unit": "mm"}}
            if feature_plan.get("center_editable") is True and len(centers) == 1:
                hole_parameters["center_x"] = {"kind": "sketch_constraint", "object": hole_sketch.Name, "constraint_name": center_x_constraint_names[0], "unit": "mm"}
                hole_parameters["center_y"] = {"kind": "sketch_constraint", "object": hole_sketch.Name, "constraint_name": center_y_constraint_names[0], "unit": "mm"}
            grid = feature_plan.get("grid")
            if isinstance(grid, dict):
                if int(grid.get("columns", 0)) > 1:
                    hole_parameters["spacing_x"] = {"kind": "grid_position_constraints", "object": hole_sketch.Name, "constraint_names": center_x_constraint_names, "unit": "mm"}
                if int(grid.get("rows", 0)) > 1:
                    hole_parameters["spacing_y"] = {"kind": "grid_position_constraints", "object": hole_sketch.Name, "constraint_names": center_y_constraint_names, "unit": "mm"}
            feature_bindings[feature_id] = {"type": feature_type, "feature_object": pocket.Name, "feature_type_id": pocket.TypeId, "sketch_object": hole_sketch.Name, "parameters": hole_parameters}
            expected_holes.append({"id": feature_id, "diameter": diameter, "centers": centers})
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pocket.Name, "object_type": pocket.TypeId, "verified_holes": len(centers), "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(hole_sketch.DoF), "source_volume": source_volume, "result_volume": float(pocket.Shape.Volume), "through_all": True})
        elif feature_type in ("fillet", "chamfer"):
            source = body.Tip
            source_volume = float(source.Shape.Volume)
            selected_subnames = select_edges(source, feature_plan["edges"])
            is_fillet = feature_type == "fillet"
            feature = body.newObject("PartDesign::Fillet" if is_fillet else "PartDesign::Chamfer", "PlanFeature_" + str(feature_index))
            feature.Label = feature_id
            feature.Base = (source, selected_subnames)
            dimension_name = "radius" if is_fillet else "size"
            property_name = "Radius" if is_fillet else "Size"
            setattr(feature, property_name, float(feature_plan[dimension_name]))
            doc.recompute()
            check_object(feature, feature_type.upper() + "_RECOMPUTE_FAILED")
            if body.Tip != feature or feature.Shape.isNull() or not feature.Shape.isValid() or len(feature.Shape.Solids) != 1 or abs(float(feature.Shape.Volume) - source_volume) <= VOLUME_TOLERANCE_MM3:
                raise RuntimeError(feature_type.upper() + "_POSTCONDITION_FAILED")
            if abs(float(getattr(feature, property_name).Value) - float(feature_plan[dimension_name])) > LINEAR_TOLERANCE_MM:
                raise RuntimeError(feature_type.upper() + "_DIMENSION_MISMATCH")
            feature_bindings[feature_id] = {"type": feature_type, "feature_object": feature.Name, "feature_type_id": feature.TypeId, "parameters": {dimension_name: {"kind": "feature_property", "object": feature.Name, "property": property_name, "unit": "mm"}}}
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": feature.Name, dimension_name: float(getattr(feature, property_name).Value), "edges": feature_plan["edges"], "source_volume": source_volume, "result_volume": float(feature.Shape.Volume), "geometry_changed": True})
        else:
            raise RuntimeError("UNSUPPORTED_RESOLVED_FEATURE: " + str(feature_type))
        executed_steps.append(feature_id)

    failed_feature = None
    failed_feature_type = None
    failed_step = "post_validation"
    doc.recompute()
    tip = body.Tip
    shape = tip.Shape
    recompute_errors = []
    for obj in body.Group:
        object_errors = cad_object_error_states(obj)
        if object_errors:
            recompute_errors.append({"object": obj.Name, "states": object_errors})

    # geometry_inspection_start
    geometry_signature = inspect_geometry(shape)
    actual_holes = []
    actual_outer_cylinders = []
    for cylinder in geometry_signature["surfaces"]["cylindrical"]:
        axis = cylinder["axis"]
        if abs(axis[0]) <= LINEAR_TOLERANCE_MM and abs(axis[1]) <= LINEAR_TOLERANCE_MM and abs(abs(axis[2]) - 1.0) <= LINEAR_TOLERANCE_MM and cylinder["surface_role"] == "outer_profile":
            actual_outer_cylinders.append(cylinder)
        if abs(axis[0]) > LINEAR_TOLERANCE_MM or abs(axis[1]) > LINEAR_TOLERANCE_MM or abs(abs(axis[2]) - 1.0) > LINEAR_TOLERANCE_MM or cylinder["surface_role"] != "hole":
            continue
        candidate = {"x": cylinder["axis_point"][0], "y": cylinder["axis_point"][1], "radius": cylinder["radius"], "axis": {"x": axis[0], "y": axis[1], "z": axis[2]}, "axis_material_length": cylinder["axis_material_length"]}
        if not any(abs(item["x"] - candidate["x"]) <= LINEAR_TOLERANCE_MM and abs(item["y"] - candidate["y"]) <= LINEAR_TOLERANCE_MM and abs(item["radius"] - candidate["radius"]) <= LINEAR_TOLERANCE_MM for item in actual_holes):
            actual_holes.append(candidate)

    actual_snapshot = {
        "solid_count": geometry_signature["solid_count"],
        "shape_valid": geometry_signature["shape_valid"],
        "bounding_box": geometry_signature["bounding_box"],
        "feature_ids": [item["id"] for item in feature_results],
        "body_tip": tip.Name if tip is not None else None,
        "expected_body_tip": feature_results[-1]["object"] if feature_results else None,
        "recompute_errors": recompute_errors,
        "holes": actual_holes,
        "outer_cylinders": actual_outer_cylinders,
    }
    # verification_snapshot_complete

    issues = []
    def add_issue(feature_id, feature_type, check, expected, actual, message):
        issues.append({"feature_id": feature_id, "feature_type": feature_type, "check": check, "expected": expected, "actual": actual, "message": message})

    solid_passed = actual_snapshot["solid_count"] == 1
    if not solid_passed:
        add_issue(None, None, "solid_count", 1, actual_snapshot["solid_count"], "The final shape must contain exactly one solid.")
    shape_passed = actual_snapshot["shape_valid"] is True
    if not shape_passed:
        add_issue(None, None, "shape_valid", True, actual_snapshot["shape_valid"], "The final shape is null or invalid.")
    actual_bounds = actual_snapshot["bounding_box"]
    bounds_passed = all(abs(float(actual_bounds[axis]) - float(expected_bounds[axis])) <= LINEAR_TOLERANCE_MM for axis in ("x", "y", "z"))
    if not bounds_passed:
        add_issue(features[0]["id"], features[0]["type"], "bounding_box", expected_bounds, actual_bounds, "The final bounding box does not match the resolved base dimensions.")
    expected_feature_ids = [item["id"] for item in features]
    feature_order_passed = actual_snapshot["feature_ids"] == expected_feature_ids
    if not feature_order_passed:
        add_issue(None, None, "feature_order", expected_feature_ids, actual_snapshot["feature_ids"], "The executed feature chain is incomplete or out of order.")
    body_tip_passed = actual_snapshot["body_tip"] == actual_snapshot["expected_body_tip"]
    if not body_tip_passed:
        add_issue(features[-1]["id"], features[-1]["type"], "body_tip", actual_snapshot["expected_body_tip"], actual_snapshot["body_tip"], "Body.Tip is not the final resolved feature.")
    if actual_snapshot["recompute_errors"]:
        add_issue(None, None, "recompute_errors", [], actual_snapshot["recompute_errors"], "One or more Body objects report recompute or feature errors.")
    expected_total_holes = sum(len(item["centers"]) for item in expected_holes)
    if len(actual_snapshot["holes"]) != expected_total_holes:
        add_issue(None, "hole_pattern", "hole_count", expected_total_holes, len(actual_snapshot["holes"]), "The total number of through-hole cylindrical surfaces does not match all resolved hole patterns.")
    all_expected_hole_centers = [center for item in expected_holes for center in item["centers"]]
    unassigned_actual_holes = [item for item in actual_snapshot["holes"] if not any(abs(item["x"] - center["x"]) <= LINEAR_TOLERANCE_MM and abs(item["y"] - center["y"]) <= LINEAR_TOLERANCE_MM for center in all_expected_hole_centers)]

    verification_features = []
    for feature_plan, feature_result in zip(features, feature_results):
        feature_id = feature_plan["id"]
        feature_type = feature_plan["type"]
        entry = {"id": feature_id, "type": feature_type, "passed": True}
        if feature_type in ("rectangular_pad", "profile_pad"):
            entry["sketch_closed"] = bool(feature_result.get("sketch_closed"))
            entry["sketch_fully_constrained"] = bool(feature_result.get("sketch_fully_constrained"))
            entry["sketch_degrees_of_freedom"] = feature_result.get("sketch_dof")
            entry["solid_created"] = bool(feature_result.get("solid_valid"))
            entry["passed"] = entry["sketch_closed"] and entry["sketch_fully_constrained"] and entry["sketch_degrees_of_freedom"] == 0 and entry["solid_created"]
            if feature_type == "profile_pad":
                expected_hole_volume = sum(len(item["centers"]) * math.pi * (float(item["diameter"]) / 2.0) ** 2 * length for item in features if item["type"] == "hole_pattern")
                expected_volume = expected_profile_area * length - expected_hole_volume
                actual_volume = geometry_signature["volume"]
                volume_passed = abs(float(actual_volume) - float(expected_volume)) <= VOLUME_TOLERANCE_MM3
                expected_line_count = sum(1 for segment in profile_segments if segment["type"] == "line")
                expected_arc_segments = [segment for segment in profile_segments if segment["type"] == "arc"]
                expected_arc_count = len(expected_arc_segments)
                entry["segment_count"] = {"expected": len(profile_segments), "actual": feature_result.get("segment_count"), "passed": feature_result.get("segment_count") == len(profile_segments)}
                entry["line_segment_count"] = {"expected": expected_line_count, "actual": feature_result.get("line_segment_count"), "passed": feature_result.get("line_segment_count") == expected_line_count}
                entry["arc_segment_count"] = {"expected": expected_arc_count, "actual": feature_result.get("arc_segment_count"), "passed": feature_result.get("arc_segment_count") == expected_arc_count}
                entry["arc_surfaces"] = []
                for expected_arc in expected_arc_segments:
                    nearest = min(actual_snapshot["outer_cylinders"], key=lambda cylinder: (cylinder["axis_point"][0] - expected_arc["center"]["x"]) ** 2 + (cylinder["axis_point"][1] - expected_arc["center"]["y"]) ** 2) if actual_snapshot["outer_cylinders"] else None
                    center_passed = nearest is not None and abs(nearest["axis_point"][0] - expected_arc["center"]["x"]) <= LINEAR_TOLERANCE_MM and abs(nearest["axis_point"][1] - expected_arc["center"]["y"]) <= LINEAR_TOLERANCE_MM
                    radius_passed = nearest is not None and abs(nearest["radius"] - expected_arc["radius"]) <= LINEAR_TOLERANCE_MM
                    entry["arc_surfaces"].append({"expected_center": expected_arc["center"], "actual_center": None if nearest is None else {"x": nearest["axis_point"][0], "y": nearest["axis_point"][1]}, "expected_radius": expected_arc["radius"], "actual_radius": None if nearest is None else nearest["radius"], "center_passed": center_passed, "radius_passed": radius_passed, "material_axis_passed": nearest is not None and nearest["surface_role"] == "outer_profile"})
                arc_surfaces_passed = len(actual_snapshot["outer_cylinders"]) >= expected_arc_count and all(item["center_passed"] and item["radius_passed"] and item["material_axis_passed"] for item in entry["arc_surfaces"])
                entry["extrusion_height"] = {"expected": length, "actual": geometry_signature["bounding_box"]["z"], "passed": abs(float(geometry_signature["bounding_box"]["z"]) - length) <= LINEAR_TOLERANCE_MM}
                entry["volume"] = {"expected": expected_volume, "actual": actual_volume, "passed": volume_passed}
                entry["passed"] = entry["passed"] and entry["segment_count"]["passed"] and entry["line_segment_count"]["passed"] and entry["arc_segment_count"]["passed"] and arc_surfaces_passed and entry["extrusion_height"]["passed"] and volume_passed
                if not volume_passed:
                    add_issue(feature_id, feature_type, "volume", expected_volume, actual_volume, "The actual volume does not equal the extruded polygon volume minus the resolved through-hole volumes.")
                if not entry["extrusion_height"]["passed"]:
                    add_issue(feature_id, feature_type, "extrusion_height", length, geometry_signature["bounding_box"]["z"], "The actual extrusion height does not match profile_pad.length.")
                if not entry["line_segment_count"]["passed"] or not entry["arc_segment_count"]["passed"]:
                    add_issue(feature_id, feature_type, "profile_segment_types", {"line": expected_line_count, "arc": expected_arc_count}, {"line": feature_result.get("line_segment_count"), "arc": feature_result.get("arc_segment_count")}, "The actual Sketch geometry types do not match the resolved profile segments.")
                if not arc_surfaces_passed:
                    add_issue(feature_id, feature_type, "arc_surfaces", [{"center": segment["center"], "radius": segment["radius"]} for segment in expected_arc_segments], entry["arc_surfaces"], "The actual solid does not contain the expected cylindrical outer profile surfaces.")
            if not entry["passed"]:
                add_issue(feature_id, feature_type, "base_feature", {"closed": True, "fully_constrained": True, "degrees_of_freedom": 0, "solid_created": True}, entry, "The base sketch or Pad postconditions were not preserved.")
        elif feature_type == "hole_pattern":
            expected_centers = [{"x": float(center["x"]), "y": float(center["y"])} for center in feature_plan["centers"]]
            expected_radius = float(feature_plan["diameter"]) / 2.0
            observed = []
            for expected_center in expected_centers:
                candidates = [item for item in actual_snapshot["holes"] if abs(item["x"] - expected_center["x"]) <= LINEAR_TOLERANCE_MM and abs(item["y"] - expected_center["y"]) <= LINEAR_TOLERANCE_MM]
                if len(candidates) == 1 and not any(existing is candidates[0] for existing in observed):
                    observed.append(candidates[0])
            entry["expected_count"] = len(expected_centers)
            entry["actual_count"] = len(observed)
            entry["expected_radius"] = expected_radius
            entry["actual_radii"] = [item["radius"] for item in observed]
            entry["centers"] = []
            entry["axes_passed"] = True
            entry["through_all_passed"] = True
            count_passed = len(observed) == len(expected_centers)
            if not count_passed:
                add_issue(feature_id, feature_type, "hole_count", len(expected_centers), len(observed), "The number of through-hole cylindrical surfaces does not match the resolved plan.")
            for expected_center in expected_centers:
                nearest = min(observed, key=lambda item: (item["x"] - expected_center["x"]) ** 2 + (item["y"] - expected_center["y"]) ** 2) if observed else None
                if nearest is None or abs(nearest["x"] - expected_center["x"]) > LINEAR_TOLERANCE_MM or abs(nearest["y"] - expected_center["y"]) > LINEAR_TOLERANCE_MM:
                    nearest = min(unassigned_actual_holes, key=lambda item: (item["x"] - expected_center["x"]) ** 2 + (item["y"] - expected_center["y"]) ** 2) if unassigned_actual_holes else nearest
                    if nearest in unassigned_actual_holes:
                        unassigned_actual_holes.remove(nearest)
                actual_center = None if nearest is None else {"x": nearest["x"], "y": nearest["y"]}
                center_passed = nearest is not None and abs(nearest["x"] - expected_center["x"]) <= LINEAR_TOLERANCE_MM and abs(nearest["y"] - expected_center["y"]) <= LINEAR_TOLERANCE_MM
                radius_passed = nearest is not None and abs(nearest["radius"] - expected_radius) <= LINEAR_TOLERANCE_MM
                axis_passed = nearest is not None and abs(float(nearest["axis"]["x"])) <= LINEAR_TOLERANCE_MM and abs(float(nearest["axis"]["y"])) <= LINEAR_TOLERANCE_MM and abs(abs(float(nearest["axis"]["z"])) - 1.0) <= LINEAR_TOLERANCE_MM
                through_all_passed = nearest is not None and float(nearest["axis_material_length"]) <= LINEAR_TOLERANCE_MM
                entry["centers"].append({"expected": expected_center, "actual": actual_center, "passed": center_passed, "radius_passed": radius_passed, "axis_passed": axis_passed, "through_all_passed": through_all_passed})
                entry["axes_passed"] = entry["axes_passed"] and axis_passed
                entry["through_all_passed"] = entry["through_all_passed"] and through_all_passed
                if not center_passed:
                    add_issue(feature_id, feature_type, "hole_center", expected_center, actual_center, "A resolved hole center was not found within tolerance.")
                if center_passed and not radius_passed:
                    add_issue(feature_id, feature_type, "hole_radius", expected_radius, None if nearest is None else nearest["radius"], "A hole radius does not match the resolved diameter.")
                if center_passed and not axis_passed:
                    add_issue(feature_id, feature_type, "hole_axis", {"parallel_to": "z"}, None if nearest is None else nearest["axis"], "A hole axis is not parallel to the sketch normal.")
                if not through_all_passed:
                    add_issue(feature_id, feature_type, "through_all", True, False, "Material remains on the hole center axis.")
            entry["sketch_closed"] = bool(feature_result.get("sketch_closed"))
            entry["sketch_fully_constrained"] = bool(feature_result.get("sketch_fully_constrained"))
            entry["material_removed"] = float(feature_result.get("result_volume", 0.0)) < float(feature_result.get("source_volume", 0.0)) - VOLUME_TOLERANCE_MM3
            if not entry["sketch_closed"]:
                add_issue(feature_id, feature_type, "sketch_closed", True, False, "The hole sketch does not contain only closed profiles.")
            if not entry["sketch_fully_constrained"]:
                add_issue(feature_id, feature_type, "sketch_fully_constrained", True, False, "The hole sketch is not fully constrained.")
            if not entry["material_removed"]:
                add_issue(feature_id, feature_type, "material_removed", True, False, "The Pocket did not remove material from the source solid.")
            entry["passed"] = count_passed and all(item["passed"] and item["radius_passed"] and item["axis_passed"] and item["through_all_passed"] for item in entry["centers"]) and entry["sketch_closed"] and entry["sketch_fully_constrained"] and entry["material_removed"]
        elif feature_type in ("fillet", "chamfer"):
            dimension = "radius" if feature_type == "fillet" else "size"
            expected_dimension = float(feature_plan[dimension])
            actual_dimension = float(feature_result[dimension])
            entry[dimension] = {"expected": expected_dimension, "actual": actual_dimension, "passed": abs(actual_dimension - expected_dimension) <= LINEAR_TOLERANCE_MM}
            entry["geometry_changed"] = abs(float(feature_result["result_volume"]) - float(feature_result["source_volume"])) > VOLUME_TOLERANCE_MM3
            entry["passed"] = entry[dimension]["passed"] and entry["geometry_changed"]
            if not entry[dimension]["passed"]:
                add_issue(feature_id, feature_type, dimension, expected_dimension, actual_dimension, "The stored feature dimension does not match the resolved plan.")
            if not entry["geometry_changed"]:
                add_issue(feature_id, feature_type, "geometry_changed", True, False, "The finishing feature did not change the solid geometry.")
        verification_features.append(entry)

    verification = {
        "solid_count": {"expected": 1, "actual": actual_snapshot["solid_count"], "passed": solid_passed},
        "shape_valid": {"expected": True, "actual": actual_snapshot["shape_valid"], "passed": shape_passed},
        "bounding_box": {"expected": expected_bounds, "actual": actual_bounds, "passed": bounds_passed},
        "feature_order": {"expected": expected_feature_ids, "actual": actual_snapshot["feature_ids"], "passed": feature_order_passed},
        "features": verification_features,
        "recompute_errors": actual_snapshot["recompute_errors"],
        "body_tip_correct": body_tip_passed,
        "tolerances": {"linear_mm": LINEAR_TOLERANCE_MM, "volume_mm3": VOLUME_TOLERANCE_MM3},
    }
    verification["featureChainComplete"] = feature_order_passed
    verification["recomputeErrors"] = actual_snapshot["recompute_errors"]
    verification["expectedHoleCount"] = sum(len(item["centers"]) for item in expected_holes)
    verification["verifiedHoleCenters"] = [item["expected"] for entry in verification_features if entry["type"] == "hole_pattern" for item in entry["centers"] if item["passed"]]
    verification["bodyTip"] = actual_snapshot["body_tip"]
    if issues:
        try:
            doc.abortTransaction()
        except Exception:
            pass
        failed_document_name = doc.Name
        FreeCAD.closeDocument(failed_document_name)
        doc = None
        _mcp_result["result"] = {"success": False, "status": "verification_failed", "code": "CAD_VERIFICATION_FAILED", "document": failed_document_name, "plan_revision": plan_revision, "issues": issues, "geometry_signature": geometry_signature, "verification": verification}
    else:
        failed_step = "persist_managed_model"
        model_id = str(uuid.uuid4())
        metadata = doc.addObject("App::FeaturePython", "ManagedModelMetadata")
        metadata.Label = "Managed Model Metadata"
        metadata.addProperty("App::PropertyBool", "IsManagedModel", "ManagedModel")
        metadata.addProperty("App::PropertyString", "ModelId", "ManagedModel")
        metadata.addProperty("App::PropertyInteger", "ModelRevision", "ManagedModel")
        metadata.addProperty("App::PropertyString", "PlanDigest", "ManagedModel")
        metadata.addProperty("App::PropertyString", "ResolvedPlanJson", "ManagedModel")
        metadata.addProperty("App::PropertyString", "FeatureBindingsJson", "ManagedModel")
        metadata.IsManagedModel = False
        metadata.ModelId = model_id
        metadata.ModelRevision = 1
        metadata.PlanDigest = plan_digest
        metadata.ResolvedPlanJson = resolved_plan_json
        metadata.FeatureBindingsJson = json.dumps(feature_bindings, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        doc.recompute()
        check_object(metadata, "MANAGED_MODEL_METADATA_RECOMPUTE_FAILED")
        if metadata.ModelId != model_id or int(metadata.ModelRevision) != 1 or metadata.PlanDigest != plan_digest or json.loads(metadata.ResolvedPlanJson) != plan or json.loads(metadata.FeatureBindingsJson) != feature_bindings:
            raise RuntimeError("MANAGED_MODEL_METADATA_POSTCONDITION_FAILED")
        metadata.IsManagedModel = True
        doc.recompute()
        check_object(metadata, "MANAGED_MODEL_ACTIVATION_FAILED")
        doc.commitTransaction()
        _mcp_result["result"] = {"success": True, "status": "verified", "document": doc.Name, "body": doc.Name + "::" + body.Name, "plan_revision": plan_revision, "managed_model": {"model_id": model_id, "model_revision": 1, "plan_digest": plan_digest}, "executed_steps": executed_steps, "features": feature_results, "valid": True, "solidCount": geometry_signature["solid_count"], "boundingBox": {"xLength": geometry_signature["bounding_box"]["x"], "yLength": geometry_signature["bounding_box"]["y"], "zLength": geometry_signature["bounding_box"]["z"]}, "volume": geometry_signature["volume"], "geometry_signature": geometry_signature, "verification": verification}
except Exception as error:
    if doc is not None:
        try:
            doc.abortTransaction()
        except Exception:
            pass
        try:
            FreeCAD.closeDocument(doc.Name)
        except Exception:
            pass
    if str(error).startswith("CAD_DOCUMENT_ALREADY_EXISTS|"):
        raise RuntimeError(str(error))
    raise RuntimeError("CAD_EXECUTE_PLAN_FAILED|" + str(failed_feature or "") + "|" + str(failed_feature_type or "") + "|" + failed_step + "|" + str(error))
`;
}

function executionFailure(result: ToolResult): ToolResult {
  const text = result.content.map((item) => item.text).join('\n');
  const conflictMarker = 'CAD_DOCUMENT_ALREADY_EXISTS|';
  const conflictStart = text.indexOf(conflictMarker);
  if (conflictStart >= 0) {
    const document = text.slice(conflictStart + conflictMarker.length).split(/[\r\n]/, 1)[0].trim();
    return { content: [{ type: 'text', text: JSON.stringify({ success: false, code: 'CAD_DOCUMENT_ALREADY_EXISTS', document }) }], isError: true };
  }
  const marker = 'CAD_EXECUTE_PLAN_FAILED|';
  const start = text.indexOf(marker);
  const parts = start >= 0 ? text.slice(start + marker.length).split('|') : [];
  return { content: [{ type: 'text', text: JSON.stringify({ success: false, code: 'CAD_PLAN_EXECUTION_FAILED', failed_feature: parts.shift() || null, failed_feature_type: parts.shift() || null, failed_step: parts.shift() || 'unknown', error: parts.length > 0 ? parts.join('|').trim() : text }) }], isError: true };
}

function verificationFailure(result: ToolResult): boolean {
  try {
    const parsed = JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
    return parsed.success === false && parsed.status === 'verification_failed' && parsed.code === 'CAD_VERIFICATION_FAILED';
  } catch {
    return false;
  }
}

export async function handleCadExecutePlan(args: ToolArgs, bridge: FreeCADBridge, gate: CadPlanValidationGate): Promise<ToolResult> {
  const unexpected = Object.keys(args).filter((key) => key !== 'documentName');
  if (unexpected.length > 0) throw new Error(`Unexpected argument(s): ${unexpected.join(', ')}`);
  const execution = gate.beginExecution();
  if (execution === undefined) return cadPlanNotValidatedToolResult();
  const name = validateDocumentName(args.documentName);
  try {
    const result = await bridge.run(executionPython(execution.resolvedPlan, execution.revision, name));
    if (result.isError) return executionFailure(result);
    if (verificationFailure(result)) {
      gate.blockAfterVerificationFailure(execution.revision);
      return { ...result, isError: true };
    }
    return result;
  } finally {
    gate.endExecution(execution.revision);
  }
}
