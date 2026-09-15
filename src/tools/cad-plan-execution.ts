import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { CadPlanValidationGate, cadPlanNotValidatedToolResult } from './cad-plan-validation.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateDocumentName(value: unknown, revision: number): string {
  const name = value === undefined ? `CADPlan_${revision}` : value;
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || name.length > 128) throw new Error('Invalid documentName: use letters, digits, and underscores, starting with a letter or underscore');
  return name;
}

function executionPython(plan: Record<string, unknown>, revision: number, documentName: string): string {
  return `
import FreeCAD
import Part
import Sketcher
plan = ${JSON.stringify(plan)}
plan_revision = ${revision}
document_name = ${JSON.stringify(documentName)}
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
            if delta.Length > 1e-12:
                direction = (abs(delta.x / delta.Length), abs(delta.y / delta.Length), abs(delta.z / delta.Length))
        candidates.append({"subname": "Edge" + str(edge_index), "edge": edge, "vertices": vertices, "direction": direction, "adjacent": [face.Surface.__class__.__name__ for face in shape.ancestorsOfType(edge, Part.Face)]})
    tolerance = 1e-7
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

try:
    if document_name in FreeCAD.listDocuments():
        raise ValueError("DOCUMENT_ALREADY_EXISTS: " + document_name)
    features = plan["features"]
    base_plan = features[0]
    width = float(base_plan["width"])
    height = float(base_plan["height"])
    length = float(base_plan["length"])
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
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pad.Name})
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
            if hasattr(pocket, "Reversed") and not pocket.Shape.isNull() and float(pocket.Shape.Volume) >= source_volume - 1e-7:
                pocket.Reversed = not bool(pocket.Reversed)
                doc.recompute()
            check_object(pocket, "POCKET_RECOMPUTE_FAILED")
            if body.Tip != pocket or pocket.Shape.isNull() or not pocket.Shape.isValid() or len(pocket.Shape.Solids) != 1 or float(pocket.Shape.Volume) >= source_volume:
                raise RuntimeError("POCKET_POSTCONDITION_FAILED")
            expected_holes.append({"id": feature_id, "diameter": diameter, "centers": centers})
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": pocket.Name, "verified_holes": len(centers)})
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
            if body.Tip != feature or feature.Shape.isNull() or not feature.Shape.isValid() or len(feature.Shape.Solids) != 1 or abs(float(feature.Shape.Volume) - source_volume) <= 1e-7:
                raise RuntimeError(feature_type.upper() + "_POSTCONDITION_FAILED")
            if abs(float(getattr(feature, property_name).Value) - float(feature_plan[dimension_name])) > 1e-7:
                raise RuntimeError(feature_type.upper() + "_DIMENSION_MISMATCH")
            feature_results.append({"id": feature_id, "type": feature_type, "success": True, "object": feature.Name, dimension_name: float(getattr(feature, property_name).Value), "edges": feature_plan["edges"]})
        else:
            raise RuntimeError("UNSUPPORTED_RESOLVED_FEATURE: " + str(feature_type))
        executed_steps.append(feature_id)

    failed_feature = None
    failed_feature_type = None
    failed_step = "post_validation"
    doc.recompute()
    tip = body.Tip
    shape = tip.Shape
    if shape.isNull() or not shape.isValid() or len(shape.Solids) != 1:
        raise RuntimeError("FINAL_SOLID_INVALID")
    for obj in body.Group:
        check_object(obj, "FEATURE_CHAIN_ERROR_" + obj.Name)
    bounds = shape.BoundBox
    if abs(float(bounds.XLength) - width) > 1e-6 or abs(float(bounds.YLength) - height) > 1e-6 or abs(float(bounds.ZLength) - length) > 1e-6:
        raise RuntimeError("BOUNDING_BOX_MISMATCH")
    verified_hole_centers = []
    for hole_feature in expected_holes:
        radius = float(hole_feature["diameter"]) / 2.0
        verified = 0
        for expected in hole_feature["centers"]:
            found = False
            for face in shape.Faces:
                if face.Surface.__class__.__name__ != "Cylinder":
                    continue
                surface = face.Surface
                if abs(float(surface.Radius) - radius) <= 1e-6 and abs(abs(float(surface.Axis.z)) - 1.0) <= 1e-6 and abs(float(surface.Center.x) - float(expected["x"])) <= 1e-6 and abs(float(surface.Center.y) - float(expected["y"])) <= 1e-6:
                    found = True
                    break
            if not found:
                raise RuntimeError("HOLE_GEOMETRY_MISSING_AT_" + str(expected))
            verified += 1
            verified_hole_centers.append({"x": float(expected["x"]), "y": float(expected["y"])})
        next(item for item in feature_results if item["id"] == hole_feature["id"])["verified_holes"] = verified
    if len(feature_results) != len(features) or [item["id"] for item in feature_results] != [item["id"] for item in features]:
        raise RuntimeError("FEATURE_CHAIN_INCOMPLETE")
    doc.commitTransaction()
    _mcp_result["result"] = {"success": True, "document": doc.Name, "body": doc.Name + "::" + body.Name, "plan_revision": plan_revision, "executed_steps": executed_steps, "features": feature_results, "valid": True, "solidCount": len(shape.Solids), "boundingBox": {"xLength": float(bounds.XLength), "yLength": float(bounds.YLength), "zLength": float(bounds.ZLength)}, "volume": float(shape.Volume), "verification": {"featureChainComplete": True, "recomputeErrors": [], "expectedHoleCount": sum(len(item["centers"]) for item in expected_holes), "verifiedHoleCenters": verified_hole_centers, "bodyTip": tip.Name}}
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
    raise RuntimeError("CAD_EXECUTE_PLAN_FAILED|" + str(failed_feature or "") + "|" + str(failed_feature_type or "") + "|" + failed_step + "|" + str(error))
`;
}

function executionFailure(result: ToolResult): ToolResult {
  const text = result.content.map((item) => item.text).join('\n');
  const marker = 'CAD_EXECUTE_PLAN_FAILED|';
  const start = text.indexOf(marker);
  const parts = start >= 0 ? text.slice(start + marker.length).split('|') : [];
  return { content: [{ type: 'text', text: JSON.stringify({ success: false, code: 'CAD_PLAN_EXECUTION_FAILED', failed_feature: parts.shift() || null, failed_feature_type: parts.shift() || null, failed_step: parts.shift() || 'unknown', error: parts.length > 0 ? parts.join('|').trim() : text }) }], isError: true };
}

export async function handleCadExecutePlan(args: ToolArgs, bridge: FreeCADBridge, gate: CadPlanValidationGate): Promise<ToolResult> {
  const unexpected = Object.keys(args).filter((key) => key !== 'documentName');
  if (unexpected.length > 0) throw new Error(`Unexpected argument(s): ${unexpected.join(', ')}`);
  const execution = gate.beginExecution();
  if (execution === undefined) return cadPlanNotValidatedToolResult();
  const name = validateDocumentName(args.documentName, execution.revision);
  try {
    const result = await bridge.run(executionPython(execution.resolvedPlan, execution.revision, name));
    return result.isError ? executionFailure(result) : result;
  } finally {
    gate.endExecution(execution.revision);
  }
}
