import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { CadPlanValidationGate, cadPlanNotValidatedToolResult } from './cad-plan-validation.js';
import {
  AREA_TOLERANCE_MM2,
  DIRECTION_VECTOR_EPSILON_MM,
  LINEAR_TOLERANCE_MM,
  VOLUME_TOLERANCE_MM3,
} from './cad-geometry-tolerances.js';

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
plan = ${JSON.stringify(plan)}
plan_revision = ${revision}
LINEAR_TOLERANCE_MM = ${LINEAR_TOLERANCE_MM}
AREA_TOLERANCE_MM2 = ${AREA_TOLERANCE_MM2}
VOLUME_TOLERANCE_MM3 = ${VOLUME_TOLERANCE_MM3}
DIRECTION_VECTOR_EPSILON_MM = ${DIRECTION_VECTOR_EPSILON_MM}
requested_document_name = ${requestedDocumentName === undefined ? 'None' : JSON.stringify(requestedDocumentName)}
document_name = None
failed_feature = None
failed_feature_type = None
failed_step = "preflight"
doc = None

def check_object(obj, code):
    errors = [str(state) for state in obj.State if str(state) not in ("Up-to-date", "Touched")]
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

def inspect_geometry(shape):
    def clean(value, tolerance=LINEAR_TOLERANCE_MM):
        numeric = float(value)
        if abs(numeric) <= tolerance:
            return 0.0
        return float(round(numeric / tolerance) * tolerance)

    def canonical_axis(vector):
        axis = FreeCAD.Vector(vector.x, vector.y, vector.z)
        if axis.Length <= DIRECTION_VECTOR_EPSILON_MM:
            return [0.0, 0.0, 0.0]
        axis.normalize()
        components = [clean(axis.x), clean(axis.y), clean(axis.z)]
        first = next((component for component in components if abs(component) > LINEAR_TOLERANCE_MM), 0.0)
        return [-component for component in components] if first < 0.0 else components

    def quantized(values, tolerance):
        return tuple(int(round(float(value) / tolerance)) for value in values)

    bounds = shape.BoundBox
    planar = []
    cylindrical = []
    probe_span = max(float(bounds.XLength), float(bounds.YLength), float(bounds.ZLength), 1.0) * 2.0 + 2.0
    for face in shape.Faces:
        surface = face.Surface
        surface_name = surface.__class__.__name__
        center = face.CenterOfMass
        face_bounds = face.BoundBox
        extent = {
            "min": [clean(face_bounds.XMin), clean(face_bounds.YMin), clean(face_bounds.ZMin)],
            "max": [clean(face_bounds.XMax), clean(face_bounds.YMax), clean(face_bounds.ZMax)],
            "size": [clean(face_bounds.XLength), clean(face_bounds.YLength), clean(face_bounds.ZLength)],
        }
        if surface_name == "Plane":
            parameter_range = face.ParameterRange
            normal_vector = face.normalAt((parameter_range[0] + parameter_range[1]) / 2.0, (parameter_range[2] + parameter_range[3]) / 2.0)
            if normal_vector.Length > DIRECTION_VECTOR_EPSILON_MM:
                normal_vector.normalize()
            planar.append({
                "surface_type": "plane",
                "area": clean(face.Area, AREA_TOLERANCE_MM2),
                "center": [clean(center.x), clean(center.y), clean(center.z)],
                "normal": [clean(normal_vector.x), clean(normal_vector.y), clean(normal_vector.z)],
                "extent": extent,
            })
        elif surface_name == "Cylinder":
            axis = canonical_axis(surface.Axis)
            axis_vector = FreeCAD.Vector(axis[0], axis[1], axis[2])
            origin = FreeCAD.Vector(surface.Center.x, surface.Center.y, surface.Center.z)
            axis_point_vector = origin.sub(axis_vector * origin.dot(axis_vector))
            axis_point = [clean(axis_point_vector.x), clean(axis_point_vector.y), clean(axis_point_vector.z)]
            probe_start = axis_point_vector.sub(axis_vector * probe_span)
            probe_end = axis_point_vector.add(axis_vector * probe_span)
            axis_probe = Part.makeLine(probe_start, probe_end)
            cylindrical.append({
                "surface_type": "cylinder",
                "area": clean(face.Area, AREA_TOLERANCE_MM2),
                "radius": clean(surface.Radius),
                "axis": axis,
                "axis_point": axis_point,
                "center": [clean(center.x), clean(center.y), clean(center.z)],
                "extent": extent,
                "axis_material_length": clean(axis_probe.common(shape).Length),
            })
    planar.sort(key=lambda item: quantized([item["area"], *item["center"], *item["normal"]], AREA_TOLERANCE_MM2))
    cylindrical.sort(key=lambda item: quantized([item["radius"], *item["axis_point"], *item["axis"], item["area"]], LINEAR_TOLERANCE_MM))
    return {
        "solid_count": len(shape.Solids),
        "shape_valid": not shape.isNull() and shape.isValid(),
        "bounding_box": {"x": clean(bounds.XLength), "y": clean(bounds.YLength), "z": clean(bounds.ZLength)},
        "volume": clean(shape.Volume, VOLUME_TOLERANCE_MM3),
        "topology": {"faces": len(shape.Faces), "edges": len(shape.Edges), "vertices": len(shape.Vertexes)},
        "surfaces": {"planar": planar, "cylindrical": cylindrical},
    }

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
    expected_profile_area = None
    if base_type == "rectangular_pad":
        width = float(base_plan["width"])
        height = float(base_plan["height"])
        expected_bounds = {"x": width, "y": height, "z": length}
    elif base_type == "profile_pad":
        profile_points = [[float(point[0]), float(point[1])] for point in base_plan["points"]]
        expected_profile_area = abs(sum(profile_points[index][0] * profile_points[(index + 1) % len(profile_points)][1] - profile_points[(index + 1) % len(profile_points)][0] * profile_points[index][1] for index in range(len(profile_points))) / 2.0)
        expected_bounds = {"x": max(point[0] for point in profile_points) - min(point[0] for point in profile_points), "y": max(point[1] for point in profile_points) - min(point[1] for point in profile_points), "z": length}
    else:
        raise RuntimeError("UNSUPPORTED_RESOLVED_BASE_FEATURE: " + str(base_type))
    executed_steps = []
    feature_results = []
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
            for constraint in (Sketcher.Constraint("Horizontal", bottom), Sketcher.Constraint("Vertical", right), Sketcher.Constraint("Horizontal", top), Sketcher.Constraint("Vertical", left), Sketcher.Constraint("Distance", bottom, width), Sketcher.Constraint("Distance", right, height), Sketcher.Constraint("DistanceX", -1, 1, bottom, 1, 0.0), Sketcher.Constraint("DistanceY", -1, 1, bottom, 1, 0.0)):
                sketch.addConstraint(constraint)
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
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pad.Name, "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(sketch.DoF), "solid_valid": True})
        elif feature_type == "profile_pad":
            sketch = body.newObject("Sketcher::SketchObject", "PlanSketch_" + str(feature_index))
            attach_xy(sketch, body)
            segment_indices = []
            for point_index, point in enumerate(profile_points):
                next_point = profile_points[(point_index + 1) % len(profile_points)]
                segment_indices.append(sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(point[0], point[1], 0), FreeCAD.Vector(next_point[0], next_point[1], 0)), False))
            for point_index, segment in enumerate(segment_indices):
                next_segment = segment_indices[(point_index + 1) % len(segment_indices)]
                sketch.addConstraint(Sketcher.Constraint("Coincident", segment, 2, next_segment, 1))
            for point_index, segment in enumerate(segment_indices):
                point = profile_points[point_index]
                sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, segment, 1, point[0]))
                sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, segment, 1, point[1]))
            solve_result = sketch.solve()
            doc.recompute()
            check_object(sketch, "PROFILE_SKETCH_RECOMPUTE_FAILED")
            if solve_result not in (None, 0) or not sketch.FullyConstrained or int(sketch.DoF) != 0 or len(sketch.Geometry) != len(profile_points) or len(sketch.Shape.Wires) != 1 or not sketch.Shape.Wires[0].isClosed():
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
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pad.Name, "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(sketch.DoF), "segment_count": len(sketch.Geometry), "solid_valid": True})
        elif feature_type == "hole_pattern":
            source_volume = float(body.Tip.Shape.Volume)
            diameter = float(feature_plan["diameter"])
            centers = feature_plan["centers"]
            hole_sketch = body.newObject("Sketcher::SketchObject", "PlanSketch_" + str(feature_index))
            attach_xy(hole_sketch, body)
            for center in centers:
                circle = hole_sketch.addGeometry(Part.Circle(FreeCAD.Vector(center["x"], center["y"], 0), FreeCAD.Vector(0, 0, 1), diameter / 2.0), False)
                hole_sketch.addConstraint(Sketcher.Constraint("Diameter", circle, diameter))
                hole_sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, circle, 3, center["x"]))
                hole_sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, circle, 3, center["y"]))
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
            expected_holes.append({"id": feature_id, "diameter": diameter, "centers": centers})
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pocket.Name, "verified_holes": len(centers), "sketch_closed": True, "sketch_fully_constrained": True, "sketch_dof": int(hole_sketch.DoF), "source_volume": source_volume, "result_volume": float(pocket.Shape.Volume), "through_all": True})
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
        object_errors = [str(state) for state in obj.State if str(state) not in ("Up-to-date", "Touched")]
        if object_errors:
            recompute_errors.append({"object": obj.Name, "states": object_errors})

    # geometry_inspection_start
    geometry_signature = inspect_geometry(shape)
    actual_holes = []
    for cylinder in geometry_signature["surfaces"]["cylindrical"]:
        axis = cylinder["axis"]
        if abs(axis[0]) > LINEAR_TOLERANCE_MM or abs(axis[1]) > LINEAR_TOLERANCE_MM or abs(abs(axis[2]) - 1.0) > LINEAR_TOLERANCE_MM or cylinder["axis_material_length"] > LINEAR_TOLERANCE_MM:
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
                expected_volume = expected_profile_area * length
                actual_volume = geometry_signature["volume"]
                volume_passed = abs(float(actual_volume) - float(expected_volume)) <= VOLUME_TOLERANCE_MM3
                entry["segment_count"] = {"expected": len(profile_points), "actual": feature_result.get("segment_count"), "passed": feature_result.get("segment_count") == len(profile_points)}
                entry["extrusion_height"] = {"expected": length, "actual": geometry_signature["bounding_box"]["z"], "passed": abs(float(geometry_signature["bounding_box"]["z"]) - length) <= LINEAR_TOLERANCE_MM}
                entry["volume"] = {"expected": expected_volume, "actual": actual_volume, "passed": volume_passed}
                entry["passed"] = entry["passed"] and entry["segment_count"]["passed"] and entry["extrusion_height"]["passed"] and volume_passed
                if not volume_passed:
                    add_issue(feature_id, feature_type, "volume", expected_volume, actual_volume, "The actual volume does not equal polygon area multiplied by extrusion length.")
                if not entry["extrusion_height"]["passed"]:
                    add_issue(feature_id, feature_type, "extrusion_height", length, geometry_signature["bounding_box"]["z"], "The actual extrusion height does not match profile_pad.length.")
            if not entry["passed"]:
                add_issue(feature_id, feature_type, "base_feature", {"closed": True, "fully_constrained": True, "degrees_of_freedom": 0, "solid_created": True}, entry, "The base sketch or Pad postconditions were not preserved.")
        elif feature_type == "hole_pattern":
            expected_centers = [{"x": float(center["x"]), "y": float(center["y"])} for center in feature_plan["centers"]]
            expected_radius = float(feature_plan["diameter"]) / 2.0
            observed = actual_snapshot["holes"]
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
        doc.commitTransaction()
        _mcp_result["result"] = {"success": True, "status": "verified", "document": doc.Name, "body": doc.Name + "::" + body.Name, "plan_revision": plan_revision, "executed_steps": executed_steps, "features": feature_results, "valid": True, "solidCount": geometry_signature["solid_count"], "boundingBox": {"xLength": geometry_signature["bounding_box"]["x"], "yLength": geometry_signature["bounding_box"]["y"], "zLength": geometry_signature["bounding_box"]["z"]}, "volume": geometry_signature["volume"], "geometry_signature": geometry_signature, "verification": verification}
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
