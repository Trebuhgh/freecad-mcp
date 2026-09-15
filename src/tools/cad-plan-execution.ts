import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';
import { CadPlanValidationGate, cadPlanNotValidatedToolResult } from './cad-plan-validation.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function documentName(value: unknown, revision: number): string {
  const name = value === undefined ? `CADPlan_${revision}` : value;
  if (typeof name !== 'string' || !IDENTIFIER.test(name) || name.length > 128) {
    throw new Error('Invalid documentName: use letters, digits, and underscores, starting with a letter or underscore');
  }
  return name;
}

function executionPython(plan: Record<string, unknown>, revision: number, name: string): string {
  return `
import FreeCAD
import Part
import Sketcher

plan = ${JSON.stringify(plan)}
plan_revision = ${revision}
document_name = ${JSON.stringify(name)}
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
        candidates.append({
            "subname": "Edge" + str(edge_index), "edge": edge, "vertices": vertices,
            "direction": direction,
            "adjacent": [face.Surface.__class__.__name__ for face in shape.ancestorsOfType(edge, Part.Face)]
        })
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
            if face.Surface.__class__.__name__ != "Plane":
                continue
            if not face.Vertexes or not all(abs(vertex.Point.z - target_z) <= tolerance for vertex in face.Vertexes):
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
    base = plan["base"]
    width = float(base["width"])
    height = float(base["height"])
    thickness = float(base["thickness"])
    executed_steps = []

    failed_step = "create_part"
    doc = FreeCAD.newDocument(document_name)
    doc.openTransaction("cad_execute_plan_r" + str(plan_revision))
    body = doc.addObject("PartDesign::Body", "Body")
    executed_steps.append("create_part")

    failed_step = "create_base_sketch"
    sketch = body.newObject("Sketcher::SketchObject", "Sketch")
    attach_xy(sketch, body)
    bottom = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(0, 0, 0), FreeCAD.Vector(width, 0, 0)), False)
    right = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(width, 0, 0), FreeCAD.Vector(width, height, 0)), False)
    top = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(width, height, 0), FreeCAD.Vector(0, height, 0)), False)
    left = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(0, height, 0), FreeCAD.Vector(0, 0, 0)), False)
    for first, first_point, second, second_point in ((bottom, 2, right, 1), (right, 2, top, 1), (top, 2, left, 1), (left, 2, bottom, 1)):
        sketch.addConstraint(Sketcher.Constraint("Coincident", first, first_point, second, second_point))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", bottom))
    sketch.addConstraint(Sketcher.Constraint("Vertical", right))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", top))
    sketch.addConstraint(Sketcher.Constraint("Vertical", left))
    sketch.addConstraint(Sketcher.Constraint("Distance", bottom, width))
    sketch.addConstraint(Sketcher.Constraint("Distance", right, height))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, bottom, 1, 0.0))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, bottom, 1, 0.0))
    solve_result = sketch.solve()
    doc.recompute()
    check_object(sketch, "BASE_SKETCH_RECOMPUTE_FAILED")
    if solve_result not in (None, 0) or not sketch.FullyConstrained or int(sketch.DoF) != 0:
        raise RuntimeError("BASE_SKETCH_NOT_FULLY_CONSTRAINED")
    if len(sketch.Shape.Wires) != 1 or not sketch.Shape.Wires[0].isClosed():
        raise RuntimeError("BASE_SKETCH_NOT_SINGLE_CLOSED_PROFILE")
    executed_steps.append("create_base_sketch")
    executed_steps.append("validate_base_sketch")

    failed_step = "pad"
    pad = body.newObject("PartDesign::Pad", "Pad")
    pad.Profile = sketch
    pad.Length = thickness
    doc.recompute()
    check_object(pad, "PAD_RECOMPUTE_FAILED")
    if body.Tip != pad or pad.Shape.isNull() or not pad.Shape.isValid() or len(pad.Shape.Solids) != 1:
        raise RuntimeError("PAD_POSTCONDITION_FAILED")
    executed_steps.append("pad")

    if "holes" in plan:
        failed_step = "create_hole_sketch"
        hole_plan = plan["holes"]
        hole_sketch = body.newObject("Sketcher::SketchObject", "HoleSketch")
        attach_xy(hole_sketch, body)
        diameter = float(hole_plan["diameter"])
        centers = hole_plan["centers"]
        for center in centers:
            circle = hole_sketch.addGeometry(Part.Circle(FreeCAD.Vector(center["x"], center["y"], 0), FreeCAD.Vector(0, 0, 1), diameter / 2.0), False)
            hole_sketch.addConstraint(Sketcher.Constraint("Diameter", circle, diameter))
            hole_sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, circle, 3, center["x"]))
            hole_sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, circle, 3, center["y"]))
        solve_result = hole_sketch.solve()
        doc.recompute()
        check_object(hole_sketch, "HOLE_SKETCH_RECOMPUTE_FAILED")
        if solve_result not in (None, 0) or not hole_sketch.FullyConstrained or int(hole_sketch.DoF) != 0:
            raise RuntimeError("HOLE_SKETCH_NOT_FULLY_CONSTRAINED")
        if len(hole_sketch.Shape.Wires) != len(centers) or any(not wire.isClosed() for wire in hole_sketch.Shape.Wires):
            raise RuntimeError("HOLE_SKETCH_PROFILE_COUNT_MISMATCH")
        executed_steps.append("create_hole_sketch")

        failed_step = "pocket"
        before_pocket_volume = float(pad.Shape.Volume)
        pocket = body.newObject("PartDesign::Pocket", "Pocket")
        pocket.Profile = hole_sketch
        available_types = list(pocket.getEnumerationsOfProperty("Type"))
        through_all = next((candidate for candidate in available_types if candidate.replace(" ", "").replace("_", "").lower() == "throughall"), None)
        if through_all is None:
            raise RuntimeError("POCKET_TYPE_UNSUPPORTED: ThroughAll")
        pocket.Type = through_all
        doc.recompute()
        if hasattr(pocket, "Reversed") and not pocket.Shape.isNull() and float(pocket.Shape.Volume) >= before_pocket_volume - 1e-7:
            pocket.Reversed = not bool(pocket.Reversed)
            doc.recompute()
        check_object(pocket, "POCKET_RECOMPUTE_FAILED")
        if body.Tip != pocket or pocket.Shape.isNull() or not pocket.Shape.isValid() or len(pocket.Shape.Solids) != 1 or float(pocket.Shape.Volume) >= before_pocket_volume:
            raise RuntimeError("POCKET_POSTCONDITION_FAILED")
        executed_steps.append("pocket_through_all")

    for operation, feature_type, property_name, dimension_name, default_name in (
        ("fillet", "PartDesign::Fillet", "Radius", "radius", "Fillet"),
        ("chamfer", "PartDesign::Chamfer", "Size", "size", "Chamfer")
    ):
        if operation not in plan:
            continue
        failed_step = operation
        operation_plan = plan[operation]
        source = body.Tip
        source_volume = float(source.Shape.Volume)
        selected_subnames = select_edges(source, operation_plan["edges"])
        feature = body.newObject(feature_type, default_name)
        feature.Base = (source, selected_subnames)
        setattr(feature, property_name, float(operation_plan[dimension_name]))
        doc.recompute()
        check_object(feature, operation.upper() + "_RECOMPUTE_FAILED")
        if body.Tip != feature or feature.Shape.isNull() or not feature.Shape.isValid() or len(feature.Shape.Solids) != 1:
            raise RuntimeError(operation.upper() + "_POSTCONDITION_FAILED")
        if abs(float(feature.Shape.Volume) - source_volume) <= 1e-7:
            raise RuntimeError(operation.upper() + "_GEOMETRY_UNCHANGED")
        executed_steps.append(operation)

    failed_step = "post_validation"
    doc.recompute()
    tip = body.Tip
    shape = tip.Shape
    if shape.isNull() or not shape.isValid() or len(shape.Solids) != 1:
        raise RuntimeError("FINAL_SOLID_INVALID")
    for feature in body.Group:
        check_object(feature, "FEATURE_CHAIN_ERROR_" + feature.Name)
    bounds = shape.BoundBox
    dimension_tolerance = 1e-6
    if abs(float(bounds.XLength) - width) > dimension_tolerance or abs(float(bounds.YLength) - height) > dimension_tolerance or abs(float(bounds.ZLength) - thickness) > dimension_tolerance:
        raise RuntimeError("BOUNDING_BOX_MISMATCH")

    verified_hole_centers = []
    if "holes" in plan:
        hole_plan = plan["holes"]
        radius = float(hole_plan["diameter"]) / 2.0
        for expected in hole_plan["centers"]:
            matches = []
            for face in shape.Faces:
                if face.Surface.__class__.__name__ != "Cylinder":
                    continue
                surface = face.Surface
                if abs(float(surface.Radius) - radius) > 1e-6 or abs(abs(float(surface.Axis.z)) - 1.0) > 1e-6:
                    continue
                if abs(float(surface.Center.x) - float(expected["x"])) <= 1e-6 and abs(float(surface.Center.y) - float(expected["y"])) <= 1e-6:
                    matches.append(face)
            if not matches:
                raise RuntimeError("HOLE_GEOMETRY_MISSING_AT_" + str(expected))
            verified_hole_centers.append({"x": float(expected["x"]), "y": float(expected["y"])})

    expected_types = ["Sketcher::SketchObject", "PartDesign::Pad"]
    if "holes" in plan:
        expected_types.extend(["Sketcher::SketchObject", "PartDesign::Pocket"])
    if "fillet" in plan:
        expected_types.append("PartDesign::Fillet")
    if "chamfer" in plan:
        expected_types.append("PartDesign::Chamfer")
    actual_types = [feature.TypeId for feature in body.Group if feature.TypeId != "PartDesign::FeatureBase"]
    for expected_type in expected_types:
        if expected_type not in actual_types:
            raise RuntimeError("FEATURE_CHAIN_INCOMPLETE: " + expected_type)

    doc.commitTransaction()
    _mcp_result["result"] = {
        "success": True,
        "document": doc.Name,
        "body": doc.Name + "::" + body.Name,
        "plan_revision": plan_revision,
        "executed_steps": executed_steps,
        "valid": True,
        "solidCount": len(shape.Solids),
        "boundingBox": {"xLength": float(bounds.XLength), "yLength": float(bounds.YLength), "zLength": float(bounds.ZLength)},
        "volume": float(shape.Volume),
        "verification": {
            "featureChainComplete": True,
            "recomputeErrors": [],
            "expectedHoleCount": len(plan["holes"]["centers"]) if "holes" in plan else 0,
            "verifiedHoleCenters": verified_hole_centers,
            "bodyTip": tip.Name
        }
    }
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
    raise RuntimeError("CAD_EXECUTE_PLAN_FAILED|" + failed_step + "|" + str(error))
`;
}

function executionFailure(result: ToolResult): ToolResult {
  const text = result.content.map((item) => item.text).join('\n');
  const marker = 'CAD_EXECUTE_PLAN_FAILED|';
  const start = text.indexOf(marker);
  if (start >= 0) {
    const parts = text.slice(start + marker.length).split('|');
    return {
      content: [{ type: 'text', text: JSON.stringify({
        success: false,
        code: 'CAD_PLAN_EXECUTION_FAILED',
        failed_step: parts.shift() || 'unknown',
        error: parts.join('|').trim(),
      }) }],
      isError: true,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify({
      success: false,
      code: 'CAD_PLAN_EXECUTION_FAILED',
      failed_step: 'unknown',
      error: text,
    }) }],
    isError: true,
  };
}

export async function handleCadExecutePlan(
  args: ToolArgs,
  bridge: FreeCADBridge,
  gate: CadPlanValidationGate,
): Promise<ToolResult> {
  const unexpected = Object.keys(args).filter((key) => key !== 'documentName');
  if (unexpected.length > 0) throw new Error(`Unexpected argument(s): ${unexpected.join(', ')}`);
  const execution = gate.beginExecution();
  if (execution === undefined) return cadPlanNotValidatedToolResult();
  const name = documentName(args.documentName, execution.revision);
  try {
    const result = await bridge.run(executionPython(execution.resolvedPlan, execution.revision, name));
    return result.isError ? executionFailure(result) : result;
  } finally {
    gate.endExecution(execution.revision);
  }
}
