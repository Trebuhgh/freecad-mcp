import { FreeCADBridge } from '../freecad-bridge.js';
import { ToolArgs, ToolResult } from '../types.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUALIFIED_ID = /^([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)$/;
const MAX_DIMENSION = 1e6;

export const HIGH_LEVEL_CAD_TOOLS = [
  {
    name: 'cad_create_part',
    description: 'Create a new FreeCAD document containing exactly one PartDesign Body. Returns qualified, stable document and body IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Unique internal document name (default: Part)' },
        bodyName: { type: 'string', description: 'Internal Body name (default: Body)' },
      },
      additionalProperties: false,
      required: [],
    },
  },
  {
    name: 'cad_create_sketch',
    description: 'Create a sketch directly inside an explicitly identified PartDesign Body on its XY, XZ, or YZ origin plane.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Qualified Body ID returned by cad_create_part, for example Part::Body' },
        name: { type: 'string', description: 'Internal Sketch name (default: Sketch)' },
        plane: { type: 'string', enum: ['XY', 'XZ', 'YZ'], description: 'Body origin plane (default: XY)' },
      },
      additionalProperties: false,
      required: ['body'],
    },
  },
  {
    name: 'cad_sketch_rectangle',
    description: 'Create one fully constrained parametric rectangle in an empty Body-owned sketch. No GeometryIndex or PointPos is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sketch: { type: 'string', description: 'Qualified Sketch ID returned by cad_create_sketch' },
        x: { type: 'number', description: 'X coordinate of the lower-left reference point in mm' },
        y: { type: 'number', description: 'Y coordinate of the lower-left reference point in mm' },
        width: { type: 'number', exclusiveMinimum: 0, description: 'Rectangle width in mm' },
        height: { type: 'number', exclusiveMinimum: 0, description: 'Rectangle height in mm' },
      },
      additionalProperties: false,
      required: ['sketch', 'x', 'y', 'width', 'height'],
    },
  },
  {
    name: 'cad_inspect_sketch',
    description: 'Inspect geometry, constraints, solver state, degrees of freedom, and open/closed contours of a Body-owned sketch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sketch: { type: 'string', description: 'Qualified Sketch ID returned by cad_create_sketch' },
      },
      additionalProperties: false,
      required: ['sketch'],
    },
  },
  {
    name: 'cad_validate_sketch',
    description: 'Validate that a Body-owned sketch is solver-clean, fully constrained, closed, and suitable for a PartDesign Pad.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sketch: { type: 'string', description: 'Qualified Sketch ID returned by cad_create_sketch' },
      },
      additionalProperties: false,
      required: ['sketch'],
    },
  },
  {
    name: 'cad_pad',
    description: 'Create and validate a parametric PartDesign Pad from exactly one closed profile in an existing Body-owned sketch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sketch: { type: 'string', description: 'Qualified sketch ID (Document::Sketch or Document::Body::Sketch), or a globally unique sketch name' },
        length: { type: 'number', exclusiveMinimum: 0, description: 'Pad length in mm' },
        name: { type: 'string', description: 'Internal Pad name (default: Pad)' },
      },
      additionalProperties: false,
      required: ['sketch', 'length'],
    },
  },
];

function assertAllowedKeys(args: ToolArgs, allowed: string[]): void {
  const unexpected = Object.keys(args).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected argument(s): ${unexpected.join(', ')}`);
  }
}

function validateIdentifier(value: unknown, field: string, fallback?: string): string {
  const actual = value === undefined ? fallback : value;
  if (typeof actual !== 'string' || !IDENTIFIER.test(actual)) {
    throw new Error(`Invalid ${field}: use letters, digits, and underscores, starting with a letter or underscore`);
  }
  if (actual.length > 128) {
    throw new Error(`Invalid ${field}: maximum length is 128 characters`);
  }
  return actual;
}

function validateQualifiedId(value: unknown, field: string): { document: string; object: string; id: string } {
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}: expected a qualified ID such as Document::Object`);
  }
  const match = value.match(QUALIFIED_ID);
  if (!match) {
    throw new Error(`Invalid ${field}: expected a qualified ID such as Document::Object`);
  }
  return { document: match[1], object: match[2], id: value };
}

function resolvePadSketchReference(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 386) {
    throw new Error('Invalid sketch: expected a sketch name or qualified sketch ID');
  }
  const parts = value.split('::');
  if (parts.length < 1 || parts.length > 3 || parts.some((part) => !IDENTIFIER.test(part))) {
    throw new Error('Invalid sketch: expected Sketch, Document::Sketch, or Document::Body::Sketch');
  }

  if (parts.length === 1) {
    return `
matches = []
for candidate_doc in FreeCAD.listDocuments().values():
    candidate = candidate_doc.getObject(${JSON.stringify(parts[0])})
    if candidate is not None and candidate.TypeId == "Sketcher::SketchObject":
        matches.append((candidate_doc, candidate))
if len(matches) == 0:
    raise ValueError("SKETCH_NOT_FOUND: ${parts[0]}")
if len(matches) > 1:
    raise ValueError("SKETCH_AMBIGUOUS: ${parts[0]}")
doc, sketch = matches[0]`;
  }

  const document = parts[0];
  const sketchName = parts[parts.length - 1];
  const expectedBody = parts.length === 3 ? parts[1] : undefined;
  return `
doc = FreeCAD.getDocument(${JSON.stringify(document)})
sketch = doc.getObject(${JSON.stringify(sketchName)})
if sketch is None:
    raise ValueError("SKETCH_NOT_FOUND: ${value}")
if sketch.TypeId != "Sketcher::SketchObject":
    raise TypeError("OBJECT_IS_NOT_SKETCH: ${value}")
${expectedBody ? `if sketch.getParentGeoFeatureGroup() is None or sketch.getParentGeoFeatureGroup().Name != ${JSON.stringify(expectedBody)}:
    raise ValueError("SKETCH_PATH_BODY_MISMATCH: ${value}")` : ''}`;
}

function validateFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${field}: expected a finite number`);
  }
  if (Math.abs(value) > MAX_DIMENSION) {
    throw new Error(`Invalid ${field}: absolute value must not exceed ${MAX_DIMENSION} mm`);
  }
  return value;
}

function validatePositiveDimension(value: unknown, field: string): number {
  const number = validateFiniteNumber(value, field);
  if (number <= 0) {
    throw new Error(`Invalid ${field}: expected a value greater than zero`);
  }
  return number;
}

function sketchInspectionPython(sketchExpression: string, indent = ''): string {
  const code = `
def _cad_inspect_sketch(sketch):
    solve_result = sketch.solve()
    doc = sketch.Document
    doc.recompute()
    conflicting = [int(i) for i in sketch.ConflictingConstraints]
    redundant = [int(i) for i in sketch.RedundantConstraints]
    partially_redundant = [int(i) for i in sketch.PartiallyRedundantConstraints]
    malformed = [int(i) for i in sketch.MalformedConstraints]
    solver_errors = []
    if solve_result not in (None, 0):
        solver_errors.append("Sketch solver returned code " + str(solve_result))
    if conflicting:
        solver_errors.append("Conflicting constraints: " + str(conflicting))
    if redundant:
        solver_errors.append("Redundant constraints: " + str(redundant))
    if partially_redundant:
        solver_errors.append("Partially redundant constraints: " + str(partially_redundant))
    if malformed:
        solver_errors.append("Malformed constraints: " + str(malformed))
    error_states = [str(state) for state in sketch.State if str(state) not in ("Up-to-date", "Touched")]
    for state in error_states:
        solver_errors.append("Object state: " + state)
    shape = sketch.Shape
    closed_contours = sum(1 for wire in shape.Wires if wire.isClosed())
    open_contours = sum(1 for wire in shape.Wires if not wire.isClosed())
    geometry_types = [geometry.__class__.__name__ for geometry in sketch.Geometry]
    construction_count = sum(1 for index in range(sketch.GeometryCount) if sketch.getConstruction(index))
    return {
        "sketchId": doc.Name + "::" + sketch.Name,
        "geometryCount": int(sketch.GeometryCount),
        "constraintCount": int(sketch.ConstraintCount),
        "degreesOfFreedom": int(sketch.DoF),
        "fullyConstrained": bool(sketch.FullyConstrained),
        "openContours": int(open_contours),
        "closedContours": int(closed_contours),
        "solverErrors": solver_errors,
        "geometryTypes": geometry_types,
        "constructionGeometryCount": int(construction_count),
        "conflictingConstraints": conflicting,
        "redundantConstraints": redundant,
        "malformedConstraints": malformed
    }

inspection = _cad_inspect_sketch(${sketchExpression})`.trimStart();
  return code.split('\n').map((line) => `${indent}${line}`).join('\n');
}

function resolveBodyPython(document: string, object: string): string {
  return `
doc = FreeCAD.getDocument(${JSON.stringify(document)})
body = doc.getObject(${JSON.stringify(object)})
if body is None:
    raise ValueError("BODY_NOT_FOUND: ${document}::${object}")
if body.TypeId != "PartDesign::Body":
    raise TypeError("OBJECT_IS_NOT_BODY: ${document}::${object}")`;
}

function resolveSketchPython(document: string, object: string): string {
  return `
doc = FreeCAD.getDocument(${JSON.stringify(document)})
sketch = doc.getObject(${JSON.stringify(object)})
if sketch is None:
    raise ValueError("SKETCH_NOT_FOUND: ${document}::${object}")
if sketch.TypeId != "Sketcher::SketchObject":
    raise TypeError("OBJECT_IS_NOT_SKETCH: ${document}::${object}")
body = sketch.getParentGeoFeatureGroup()
if body is None or body.TypeId != "PartDesign::Body" or sketch not in body.Group:
    raise ValueError("SKETCH_NOT_IN_BODY: ${document}::${object}")`;
}

export async function handleHighLevelCadTool(
  name: string,
  args: ToolArgs,
  bridge: FreeCADBridge,
): Promise<ToolResult> {
  switch (name) {
    case 'cad_create_part': {
      assertAllowedKeys(args, ['name', 'bodyName']);
      const documentName = validateIdentifier(args.name, 'name', 'Part');
      const bodyName = validateIdentifier(args.bodyName, 'bodyName', 'Body');
      return bridge.run(`
existing_documents = FreeCAD.listDocuments()
if ${JSON.stringify(documentName)} in existing_documents:
    raise ValueError("DOCUMENT_ALREADY_EXISTS: ${documentName}")
doc = None
try:
    doc = FreeCAD.newDocument(${JSON.stringify(documentName)})
    body = doc.addObject("PartDesign::Body", ${JSON.stringify(bodyName)})
    doc.recompute()
    bodies = [obj for obj in doc.Objects if obj.TypeId == "PartDesign::Body"]
    if len(bodies) != 1:
        raise RuntimeError("PART_POSTCONDITION_FAILED: expected exactly one Body")
    if bodies[0] != body or body.Document != doc:
        raise RuntimeError("PART_POSTCONDITION_FAILED: Body ownership mismatch")
    _mcp_result["result"] = {
        "ok": True,
        "documentId": doc.Name,
        "documentName": doc.Name,
        "bodyId": doc.Name + "::" + body.Name,
        "bodyName": body.Name,
        "bodyCount": len(bodies)
    }
except Exception:
    if doc is not None:
        FreeCAD.closeDocument(doc.Name)
    raise
`);
    }

    case 'cad_create_sketch': {
      assertAllowedKeys(args, ['body', 'name', 'plane']);
      const bodyRef = validateQualifiedId(args.body, 'body');
      const sketchName = validateIdentifier(args.name, 'name', 'Sketch');
      const plane = args.plane === undefined ? 'XY' : args.plane;
      if (plane !== 'XY' && plane !== 'XZ' && plane !== 'YZ') {
        throw new Error('Invalid plane: expected XY, XZ, or YZ');
      }
      return bridge.run(`
import Sketcher
${resolveBodyPython(bodyRef.document, bodyRef.object)}
doc.openTransaction("cad_create_sketch")
try:
    sketch = body.newObject("Sketcher::SketchObject", ${JSON.stringify(sketchName)})
    expected_role = ${JSON.stringify(`${plane}_Plane`)}
    support_plane = next((item for item in body.Origin.OriginFeatures if getattr(item, "Role", "") == expected_role), None)
    if support_plane is None:
        raise RuntimeError("ORIGIN_PLANE_NOT_FOUND: " + expected_role)
    if hasattr(sketch, "AttachmentSupport"):
        sketch.AttachmentSupport = (support_plane, [""])
    elif hasattr(sketch, "Support"):
        sketch.Support = (support_plane, [""])
    else:
        raise RuntimeError("SKETCH_ATTACHMENT_UNSUPPORTED: Sketch has no support property")
    sketch.MapMode = "FlatFace"
    doc.recompute()
    parent = sketch.getParentGeoFeatureGroup()
    if parent != body or sketch not in body.Group or sketch.Document != doc:
        raise RuntimeError("SKETCH_POSTCONDITION_FAILED: Sketch is not owned by requested Body")
    actual_support = sketch.AttachmentSupport if hasattr(sketch, "AttachmentSupport") else sketch.Support
    if not actual_support or actual_support[0][0] != support_plane:
        raise RuntimeError("SKETCH_POSTCONDITION_FAILED: origin plane support mismatch")
    doc.commitTransaction()
    _mcp_result["result"] = {
        "ok": True,
        "documentId": doc.Name,
        "bodyId": doc.Name + "::" + body.Name,
        "sketchId": doc.Name + "::" + sketch.Name,
        "sketchName": sketch.Name,
        "plane": ${JSON.stringify(plane)},
        "insideBody": True
    }
except Exception:
    doc.abortTransaction()
    doc.recompute()
    raise
`);
    }

    case 'cad_sketch_rectangle': {
      assertAllowedKeys(args, ['sketch', 'x', 'y', 'width', 'height']);
      const sketchRef = validateQualifiedId(args.sketch, 'sketch');
      const x = validateFiniteNumber(args.x, 'x');
      const y = validateFiniteNumber(args.y, 'y');
      const width = validatePositiveDimension(args.width, 'width');
      const height = validatePositiveDimension(args.height, 'height');
      return bridge.run(`
import Part
import Sketcher
${resolveSketchPython(sketchRef.document, sketchRef.object)}
if sketch.GeometryCount != 0 or sketch.ConstraintCount != 0:
    raise ValueError("SKETCH_NOT_EMPTY: cad_sketch_rectangle currently requires an empty sketch")
doc.openTransaction("cad_sketch_rectangle")
try:
    x = ${x}
    y = ${y}
    width = ${width}
    height = ${height}
    bottom = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(x, y, 0), FreeCAD.Vector(x + width, y, 0)), False)
    right = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(x + width, y, 0), FreeCAD.Vector(x + width, y + height, 0)), False)
    top = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(x + width, y + height, 0), FreeCAD.Vector(x, y + height, 0)), False)
    left = sketch.addGeometry(Part.LineSegment(FreeCAD.Vector(x, y + height, 0), FreeCAD.Vector(x, y, 0)), False)
    sketch.addConstraint(Sketcher.Constraint("Coincident", bottom, 2, right, 1))
    sketch.addConstraint(Sketcher.Constraint("Coincident", right, 2, top, 1))
    sketch.addConstraint(Sketcher.Constraint("Coincident", top, 2, left, 1))
    sketch.addConstraint(Sketcher.Constraint("Coincident", left, 2, bottom, 1))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", bottom))
    sketch.addConstraint(Sketcher.Constraint("Vertical", right))
    sketch.addConstraint(Sketcher.Constraint("Horizontal", top))
    sketch.addConstraint(Sketcher.Constraint("Vertical", left))
    sketch.addConstraint(Sketcher.Constraint("Distance", bottom, width))
    sketch.addConstraint(Sketcher.Constraint("Distance", right, height))
    sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, bottom, 1, x))
    sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, bottom, 1, y))
${sketchInspectionPython('sketch', '    ')}
    actual_width = sketch.Geometry[bottom].length()
    actual_height = sketch.Geometry[right].length()
    constraint_types = [constraint.Type for constraint in sketch.Constraints]
    required_types = ["Coincident", "Horizontal", "Vertical", "Distance", "DistanceX", "DistanceY"]
    if sketch.GeometryCount != 4:
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: expected four geometries")
    if abs(actual_width - width) > 1e-7 or abs(actual_height - height) > 1e-7:
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: dimensions do not match")
    if any(required not in constraint_types for required in required_types):
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: required constraint type missing")
    if inspection["openContours"] != 0 or inspection["closedContours"] != 1:
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: profile is not one closed contour")
    if not inspection["fullyConstrained"] or inspection["degreesOfFreedom"] != 0:
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: sketch is not fully constrained")
    if inspection["solverErrors"]:
        raise RuntimeError("RECTANGLE_POSTCONDITION_FAILED: solver errors: " + str(inspection["solverErrors"]))
    doc.commitTransaction()
    _mcp_result["result"] = {
        "ok": True,
        "sketchId": doc.Name + "::" + sketch.Name,
        "rectangle": {"x": x, "y": y, "width": actual_width, "height": actual_height},
        "fullyConstrained": inspection["fullyConstrained"],
        "degreesOfFreedom": inspection["degreesOfFreedom"],
        "closedContours": inspection["closedContours"],
        "openContours": inspection["openContours"],
        "constraintTypes": constraint_types
    }
except Exception:
    doc.abortTransaction()
    doc.recompute()
    raise
`);
    }

    case 'cad_inspect_sketch': {
      assertAllowedKeys(args, ['sketch']);
      const sketchRef = validateQualifiedId(args.sketch, 'sketch');
      return bridge.run(`
${resolveSketchPython(sketchRef.document, sketchRef.object)}
${sketchInspectionPython('sketch')}
_mcp_result["result"] = inspection
`);
    }

    case 'cad_validate_sketch': {
      assertAllowedKeys(args, ['sketch']);
      const sketchRef = validateQualifiedId(args.sketch, 'sketch');
      return bridge.run(`
${resolveSketchPython(sketchRef.document, sketchRef.object)}
${sketchInspectionPython('sketch')}
closed_profile = inspection["geometryCount"] > 0 and inspection["closedContours"] > 0 and inspection["openContours"] == 0
warnings = []
if inspection["geometryCount"] == 0:
    warnings.append("Sketch has no geometry")
if not inspection["fullyConstrained"]:
    warnings.append("Sketch has " + str(inspection["degreesOfFreedom"]) + " remaining degrees of freedom")
if inspection["openContours"] > 0:
    warnings.append("Sketch contains open contours")
if inspection["closedContours"] > 1:
    warnings.append("Sketch contains multiple closed contours; Pad may create multiple regions or nested cutouts")
if inspection["constructionGeometryCount"] == inspection["geometryCount"] and inspection["geometryCount"] > 0:
    warnings.append("Sketch contains only construction geometry")
suitable_for_pad = closed_profile and inspection["fullyConstrained"] and not inspection["solverErrors"] and inspection["constructionGeometryCount"] < inspection["geometryCount"]
_mcp_result["result"] = {
    "ok": bool(suitable_for_pad),
    "sketchId": inspection["sketchId"],
    "fullyConstrained": inspection["fullyConstrained"],
    "closedProfile": bool(closed_profile),
    "solverErrors": inspection["solverErrors"],
    "suitableForPad": bool(suitable_for_pad),
    "warnings": warnings
}
`);
    }

    case 'cad_pad': {
      assertAllowedKeys(args, ['sketch', 'length', 'name']);
      const sketchResolution = resolvePadSketchReference(args.sketch);
      const length = validatePositiveDimension(args.length, 'length');
      const padName = validateIdentifier(args.name, 'name', 'Pad');
      return bridge.run(`
${sketchResolution}
if sketch.TypeId != "Sketcher::SketchObject":
    raise TypeError("OBJECT_IS_NOT_SKETCH: " + sketch.Name)
body = sketch.getParentGeoFeatureGroup()
if body is None or body.TypeId != "PartDesign::Body" or sketch not in body.Group:
    raise ValueError("SKETCH_NOT_IN_BODY: " + doc.Name + "::" + sketch.Name)
${sketchInspectionPython('sketch')}
closed_profile = inspection["geometryCount"] > 0 and inspection["closedContours"] == 1 and inspection["openContours"] == 0
has_regular_geometry = inspection["constructionGeometryCount"] < inspection["geometryCount"]
suitable_for_pad = closed_profile and inspection["fullyConstrained"] and not inspection["solverErrors"] and has_regular_geometry
if not closed_profile:
    raise ValueError("SKETCH_NOT_SINGLE_CLOSED_PROFILE: " + doc.Name + "::" + sketch.Name)
if not suitable_for_pad:
    raise ValueError("SKETCH_NOT_SUITABLE_FOR_PAD: " + str(inspection))
doc.openTransaction("cad_pad")
try:
    pad = body.newObject("PartDesign::Pad", ${JSON.stringify(padName)})
    pad.Profile = sketch
    pad.Length = ${length}
    doc.recompute()
    error_states = [str(state) for state in pad.State if str(state) not in ("Up-to-date", "Touched")]
    if error_states:
        raise RuntimeError("PAD_RECOMPUTE_FAILED: " + str(error_states))
    if pad.TypeId != "PartDesign::Pad":
        raise RuntimeError("PAD_POSTCONDITION_FAILED: unexpected TypeId " + pad.TypeId)
    if pad.getParentGeoFeatureGroup() != body or pad not in body.Group:
        raise RuntimeError("PAD_POSTCONDITION_FAILED: Pad is not in the Sketch Body")
    profile_target = pad.Profile[0] if isinstance(pad.Profile, tuple) else pad.Profile
    if profile_target != sketch:
        raise RuntimeError("PAD_POSTCONDITION_FAILED: Profile does not reference the requested Sketch")
    if abs(float(pad.Length.Value) - ${length}) > 1e-7:
        raise RuntimeError("PAD_POSTCONDITION_FAILED: Length mismatch")
    shape = pad.Shape
    valid = not shape.isNull() and shape.isValid() and len(shape.Solids) == 1 and shape.Volume > 0
    if not valid:
        raise RuntimeError("PAD_POSTCONDITION_FAILED: result is not one valid solid")
    if body.Tip != pad:
        raise RuntimeError("PAD_POSTCONDITION_FAILED: Pad is not the Body Tip")
    bounds = shape.BoundBox
    doc.commitTransaction()
    _mcp_result["result"] = {
        "document": doc.Name,
        "body": doc.Name + "::" + body.Name,
        "sketch": doc.Name + "::" + sketch.Name,
        "pad": doc.Name + "::" + pad.Name,
        "typeId": pad.TypeId,
        "length": float(pad.Length.Value),
        "valid": bool(valid),
        "error": None,
        "solidCount": len(shape.Solids),
        "volume": float(shape.Volume),
        "boundingBox": {
            "xLength": float(bounds.XLength),
            "yLength": float(bounds.YLength),
            "zLength": float(bounds.ZLength)
        }
    }
except Exception:
    doc.abortTransaction()
    doc.recompute()
    raise
`);
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown high-level CAD tool: ${name}` }],
        isError: true,
      };
  }
}
