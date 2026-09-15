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
  {
    name: 'cad_create_hole_sketch',
    description: 'Create a fully constrained set of circular hole profiles directly inside an explicit PartDesign Body.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Qualified Body ID, for example Part::Body' },
        support: { type: 'string', description: 'Optional semantic support "top"/"bottom", or explicit Document::Object::FaceN reference' },
        plane: { type: 'string', enum: ['XY', 'XZ', 'YZ'], description: 'Body origin plane or semantic support orientation (default: XY)' },
        name: { type: 'string', description: 'Internal Sketch name (default: HoleSketch)' },
        holes: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'Circle center X coordinate in sketch space, in mm' },
              y: { type: 'number', description: 'Circle center Y coordinate in sketch space, in mm' },
              diameter: { type: 'number', exclusiveMinimum: 0, description: 'Hole diameter in mm' },
            },
            additionalProperties: false,
            required: ['x', 'y', 'diameter'],
          },
        },
      },
      additionalProperties: false,
      required: ['body', 'holes'],
    },
  },
  {
    name: 'cad_pocket',
    description: 'Create and validate a parametric PartDesign Pocket from one or more closed profiles in a Body-owned sketch.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sketch: { type: 'string', description: 'Qualified sketch ID, qualified Body path, or globally unique sketch name' },
        type: { type: 'string', enum: ['through_all', 'length'], description: 'Pocket extent (default: through_all)' },
        length: { type: 'number', exclusiveMinimum: 0, description: 'Pocket length in mm; required when type is length' },
        name: { type: 'string', description: 'Internal Pocket name (default: Pocket)' },
      },
      additionalProperties: false,
      required: ['sketch'],
    },
  },
  {
    name: 'cad_fillet',
    description: 'Create a validated PartDesign Fillet on semantically or geometrically selected edges of the current Body Tip.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Qualified Body ID, for example Part::Body' },
        radius: { type: 'number', exclusiveMinimum: 0, description: 'Fillet radius in mm' },
        edges: {
          description: 'Semantic selector or geometric edge query',
          oneOf: [
            { type: 'string', enum: ['all_vertical', 'all_top', 'all_bottom', 'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner'] },
            {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['x', 'y', 'z'], description: 'Select straight edges parallel to this global axis' },
                length: { type: 'number', exclusiveMinimum: 0, description: 'Required edge length in mm' },
                location: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
                  },
                  additionalProperties: false,
                },
                tolerance: { type: 'number', exclusiveMinimum: 0, description: 'Length/location tolerance in mm (default: 0.00001)' },
                count: { type: 'integer', minimum: 1, description: 'Expected number of matches (default: 1)' },
              },
              additionalProperties: false,
            },
          ],
        },
        name: { type: 'string', description: 'Internal feature name (default: Fillet)' },
      },
      additionalProperties: false,
      required: ['body', 'radius', 'edges'],
    },
  },
  {
    name: 'cad_chamfer',
    description: 'Create a validated PartDesign Chamfer on semantically or geometrically selected edges of the current Body Tip.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        body: { type: 'string', description: 'Qualified Body ID, for example Part::Body' },
        size: { type: 'number', exclusiveMinimum: 0, description: 'Chamfer size in mm' },
        edges: {
          description: 'Semantic selector or geometric edge query',
          oneOf: [
            { type: 'string', enum: ['all_vertical', 'all_top', 'all_bottom', 'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner'] },
            {
              type: 'object',
              properties: {
                direction: { type: 'string', enum: ['x', 'y', 'z'] },
                length: { type: 'number', exclusiveMinimum: 0 },
                location: {
                  type: 'object',
                  properties: {
                    x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' },
                  },
                  additionalProperties: false,
                },
                tolerance: { type: 'number', exclusiveMinimum: 0, description: 'Length/location tolerance in mm (default: 0.00001)' },
                count: { type: 'integer', minimum: 1, description: 'Expected number of matches (default: 1)' },
              },
              additionalProperties: false,
            },
          ],
        },
        name: { type: 'string', description: 'Internal feature name (default: Chamfer)' },
      },
      additionalProperties: false,
      required: ['body', 'size', 'edges'],
    },
  },
];

type EdgeSelection =
  | 'all_vertical'
  | 'all_top'
  | 'all_bottom'
  | 'all_top_outer'
  | 'all_top_inner'
  | 'all_bottom_outer'
  | 'all_bottom_inner'
  | {
      direction?: 'x' | 'y' | 'z';
      length?: number;
      location?: { x?: number; y?: number; z?: number };
      tolerance: number;
      count: number;
    };

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

function validateHoles(value: unknown): Array<{ x: number; y: number; diameter: number }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Invalid holes: expected a non-empty array');
  }
  if (value.length > 1000) {
    throw new Error('Invalid holes: maximum number of holes is 1000');
  }
  return value.map((hole, index) => {
    if (typeof hole !== 'object' || hole === null || Array.isArray(hole)) {
      throw new Error(`Invalid holes[${index}]: expected an object`);
    }
    const record = hole as Record<string, unknown>;
    const unexpected = Object.keys(record).filter((key) => !['x', 'y', 'diameter'].includes(key));
    if (unexpected.length > 0) {
      throw new Error(`Unexpected holes[${index}] argument(s): ${unexpected.join(', ')}`);
    }
    return {
      x: validateFiniteNumber(record.x, `holes[${index}].x`),
      y: validateFiniteNumber(record.y, `holes[${index}].y`),
      diameter: validatePositiveDimension(record.diameter, `holes[${index}].diameter`),
    };
  });
}

function validateSupport(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (value === 'top' || value === 'bottom') return value;
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*::Face[1-9][0-9]*$/.test(value)) {
    throw new Error('Invalid support: expected "top", "bottom", or Document::Object::FaceN');
  }
  return value;
}

function validateEdgeSelection(value: unknown): EdgeSelection {
  if (
    value === 'all_vertical' || value === 'all_top' || value === 'all_bottom'
    || value === 'all_top_outer' || value === 'all_top_inner'
    || value === 'all_bottom_outer' || value === 'all_bottom_inner'
  ) {
    return value;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid edges: expected a semantic selector or geometric query');
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !['direction', 'length', 'location', 'tolerance', 'count'].includes(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected edges argument(s): ${unexpected.join(', ')}`);
  }
  let direction: 'x' | 'y' | 'z' | undefined;
  if (record.direction !== undefined) {
    if (record.direction !== 'x' && record.direction !== 'y' && record.direction !== 'z') {
      throw new Error('Invalid edges.direction: expected x, y, or z');
    }
    direction = record.direction;
  }
  const length = record.length === undefined ? undefined : validatePositiveDimension(record.length, 'edges.length');
  let location: { x?: number; y?: number; z?: number } | undefined;
  if (record.location !== undefined) {
    if (typeof record.location !== 'object' || record.location === null || Array.isArray(record.location)) {
      throw new Error('Invalid edges.location: expected an object');
    }
    const locationRecord = record.location as Record<string, unknown>;
    const unexpectedLocation = Object.keys(locationRecord).filter((key) => !['x', 'y', 'z'].includes(key));
    if (unexpectedLocation.length > 0) {
      throw new Error(`Unexpected edges.location argument(s): ${unexpectedLocation.join(', ')}`);
    }
    if (Object.keys(locationRecord).length === 0) {
      throw new Error('Invalid edges.location: specify at least one coordinate');
    }
    location = {};
    if (locationRecord.x !== undefined) location.x = validateFiniteNumber(locationRecord.x, 'edges.location.x');
    if (locationRecord.y !== undefined) location.y = validateFiniteNumber(locationRecord.y, 'edges.location.y');
    if (locationRecord.z !== undefined) location.z = validateFiniteNumber(locationRecord.z, 'edges.location.z');
  }
  if (direction === undefined && length === undefined && location === undefined) {
    throw new Error('Invalid edges: geometric query requires direction, length, or location');
  }
  const tolerance = record.tolerance === undefined ? 1e-5 : validatePositiveDimension(record.tolerance, 'edges.tolerance');
  const countValue = record.count === undefined ? 1 : record.count;
  if (typeof countValue !== 'number' || !Number.isInteger(countValue) || countValue < 1 || countValue > 1000) {
    throw new Error('Invalid edges.count: expected an integer from 1 to 1000');
  }
  return { direction, length, location, tolerance, count: countValue };
}

function edgeSelectionPython(selection: EdgeSelection): string {
  const serialized = JSON.stringify(selection);
  return `
selection = ${serialized}
source = body.Tip
if source is None or not hasattr(source, "Shape") or source.Shape.isNull():
    raise ValueError("BODY_TIP_SOLID_NOT_FOUND: Body Tip has no Shape")
if not source.Shape.isValid() or len(source.Shape.Solids) != 1:
    raise ValueError("BODY_TIP_INVALID: expected exactly one valid solid")
source_shape = source.Shape
source_volume = float(source_shape.Volume)
source_bounds = source_shape.BoundBox
edge_candidates = []
for edge_index, edge in enumerate(source_shape.Edges, start=1):
    center = edge.CenterOfMass
    vertices = edge.Vertexes
    is_line = edge.Curve.__class__.__name__ == "Line" and len(vertices) >= 2
    direction = None
    if is_line:
        delta = vertices[-1].Point.sub(vertices[0].Point)
        if delta.Length > 1e-12:
            direction = (abs(delta.x / delta.Length), abs(delta.y / delta.Length), abs(delta.z / delta.Length))
    record = {
        "subname": "Edge" + str(edge_index),
        "length": float(edge.Length),
        "center": {"x": float(center.x), "y": float(center.y), "z": float(center.z)},
        "direction": None if direction is None else {"x": direction[0], "y": direction[1], "z": direction[2]},
        "isLine": bool(is_line),
        "adjacentSurfaceTypes": [face.Surface.__class__.__name__ for face in source_shape.ancestorsOfType(edge, Part.Face)],
        "vertices": vertices,
        "edge": edge
    }
    edge_candidates.append(record)

selected = []
if isinstance(selection, str):
    tolerance = 1e-7
    if selection == "all_vertical":
        selected = [item for item in edge_candidates if item["direction"] is not None and item["direction"]["z"] > 1.0 - 1e-7 and "Cylinder" not in item["adjacentSurfaceTypes"]]
    elif selection == "all_top":
        selected = [item for item in edge_candidates if item["vertices"] and all(abs(vertex.Point.z - source_bounds.ZMax) <= tolerance for vertex in item["vertices"])]
    elif selection == "all_bottom":
        selected = [item for item in edge_candidates if item["vertices"] and all(abs(vertex.Point.z - source_bounds.ZMin) <= tolerance for vertex in item["vertices"])]
    elif selection in ("all_top_outer", "all_top_inner", "all_bottom_outer", "all_bottom_inner"):
        target_z = source_bounds.ZMax if selection.startswith("all_top") else source_bounds.ZMin
        requested_boundary = "outer" if selection.endswith("outer") else "inner"
        outer_edges = []
        inner_edges = []
        for face in source_shape.Faces:
            if face.Surface.__class__.__name__ != "Plane":
                continue
            face_vertices = face.Vertexes
            if not face_vertices or not all(abs(vertex.Point.z - target_z) <= tolerance for vertex in face_vertices):
                continue
            outer_wire = face.OuterWire
            for wire in face.Wires:
                destination = outer_edges if wire.isSame(outer_wire) else inner_edges
                for wire_edge in wire.Edges:
                    if not any(existing.isSame(wire_edge) for existing in destination):
                        destination.append(wire_edge)
        boundary_edges = outer_edges if requested_boundary == "outer" else inner_edges
        selected = [item for item in edge_candidates if any(item["edge"].isSame(boundary_edge) for boundary_edge in boundary_edges)]
else:
    tolerance = float(selection.get("tolerance", 1e-5))
    for item in edge_candidates:
        matches = True
        requested_direction = selection.get("direction")
        if requested_direction is not None:
            matches = item["direction"] is not None and item["direction"][requested_direction] > 1.0 - 1e-7
        if matches and selection.get("length") is not None:
            matches = abs(item["length"] - float(selection["length"])) <= tolerance
        if matches and selection.get("location") is not None:
            for axis, coordinate in selection["location"].items():
                if abs(item["center"][axis] - float(coordinate)) > tolerance:
                    matches = False
                    break
        if matches:
            selected.append(item)
    expected_count = int(selection.get("count", 1))
    if len(selected) > expected_count:
        raise ValueError("EDGE_SELECTION_AMBIGUOUS: matched " + str(len(selected)) + " edges, expected " + str(expected_count))
    if len(selected) < expected_count:
        raise ValueError("EDGE_SELECTION_COUNT_MISMATCH: matched " + str(len(selected)) + " edges, expected " + str(expected_count))

if not selected:
    raise ValueError("EDGE_SELECTION_EMPTY: no matching edges")
selected_subnames = [item["subname"] for item in selected]
selected_descriptions = [{
    "selectionId": "selected-" + str(index + 1),
    "length": item["length"],
    "center": item["center"],
    "direction": item["direction"],
    "isLine": item["isLine"]
} for index, item in enumerate(selected)]`;
}

function sketchSupportPython(plane: 'XY' | 'XZ' | 'YZ', support: string | undefined): string {
  if (support === undefined) {
    return `
expected_role = ${JSON.stringify(`${plane}_Plane`)}
support_object = next((item for item in body.Origin.OriginFeatures if getattr(item, "Role", "") == expected_role), None)
if support_object is None:
    raise RuntimeError("ORIGIN_PLANE_NOT_FOUND: " + expected_role)
support_subname = ""`;
  }

  if (support === 'top' || support === 'bottom') {
    const axis = plane === 'XY' ? 'z' : plane === 'XZ' ? 'y' : 'x';
    const normal = plane === 'XY' ? '(0.0, 0.0, 1.0)' : plane === 'XZ' ? '(0.0, 1.0, 0.0)' : '(1.0, 0.0, 0.0)';
    const choose = support === 'top' ? 'max' : 'min';
    return `
support_object = body.Tip
if support_object is None or not hasattr(support_object, "Shape") or support_object.Shape.isNull():
    raise ValueError("SUPPORT_SOLID_NOT_FOUND: Body has no usable Tip")
target_normal = ${normal}
face_candidates = []
for face_index, face in enumerate(support_object.Shape.Faces, start=1):
    if face.Surface.__class__.__name__ != "Plane":
        continue
    center = face.CenterOfMass
    normal = face.normalAt(0, 0)
    alignment = abs(normal.x * target_normal[0] + normal.y * target_normal[1] + normal.z * target_normal[2])
    if alignment > 0.999999:
        face_candidates.append((getattr(center, ${JSON.stringify(axis)}), face_index))
if not face_candidates:
    raise ValueError("SEMANTIC_SUPPORT_NOT_FOUND: no planar face parallel to ${plane}")
selected_coordinate = ${choose}(item[0] for item in face_candidates)
selected = [item for item in face_candidates if abs(item[0] - selected_coordinate) < 1e-7]
if len(selected) != 1:
    raise ValueError("SEMANTIC_SUPPORT_AMBIGUOUS: ${support} face is not unique")
support_subname = "Face" + str(selected[0][1])`;
  }

  const [document, object, face] = support.split('::');
  return `
if doc.Name != ${JSON.stringify(document)}:
    raise ValueError("SUPPORT_DOCUMENT_MISMATCH: ${support}")
support_object = doc.getObject(${JSON.stringify(object)})
if support_object is None:
    raise ValueError("SUPPORT_OBJECT_NOT_FOUND: ${support}")
if support_object.getParentGeoFeatureGroup() != body:
    raise ValueError("SUPPORT_BODY_MISMATCH: ${support}")
support_subname = ${JSON.stringify(face)}
support_index = int(support_subname[4:])
if support_index < 1 or support_index > len(support_object.Shape.Faces):
    raise ValueError("SUPPORT_FACE_NOT_FOUND: ${support}")`;
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

    case 'cad_create_hole_sketch': {
      assertAllowedKeys(args, ['body', 'support', 'plane', 'name', 'holes']);
      const bodyRef = validateQualifiedId(args.body, 'body');
      const support = validateSupport(args.support);
      const planeValue = args.plane === undefined ? 'XY' : args.plane;
      if (planeValue !== 'XY' && planeValue !== 'XZ' && planeValue !== 'YZ') {
        throw new Error('Invalid plane: expected XY, XZ, or YZ');
      }
      const plane = planeValue as 'XY' | 'XZ' | 'YZ';
      const sketchName = validateIdentifier(args.name, 'name', 'HoleSketch');
      const holes = validateHoles(args.holes);
      const holesPython = JSON.stringify(holes);
      return bridge.run(`
import Part
import Sketcher
${resolveBodyPython(bodyRef.document, bodyRef.object)}
${sketchSupportPython(plane, support)}
doc.openTransaction("cad_create_hole_sketch")
try:
    sketch = body.newObject("Sketcher::SketchObject", ${JSON.stringify(sketchName)})
    if hasattr(sketch, "AttachmentSupport"):
        sketch.AttachmentSupport = (support_object, [support_subname])
    elif hasattr(sketch, "Support"):
        sketch.Support = (support_object, [support_subname])
    else:
        raise RuntimeError("SKETCH_ATTACHMENT_UNSUPPORTED: Sketch has no support property")
    sketch.MapMode = "FlatFace"
    holes = ${holesPython}
    for hole in holes:
        circle = sketch.addGeometry(Part.Circle(FreeCAD.Vector(hole["x"], hole["y"], 0), FreeCAD.Vector(0, 0, 1), hole["diameter"] / 2.0), False)
        sketch.addConstraint(Sketcher.Constraint("Diameter", circle, hole["diameter"]))
        sketch.addConstraint(Sketcher.Constraint("DistanceX", -1, 1, circle, 3, hole["x"]))
        sketch.addConstraint(Sketcher.Constraint("DistanceY", -1, 1, circle, 3, hole["y"]))
${sketchInspectionPython('sketch', '    ')}
    if sketch.getParentGeoFeatureGroup() != body or sketch not in body.Group:
        raise RuntimeError("HOLE_SKETCH_POSTCONDITION_FAILED: Sketch is not in requested Body")
    if inspection["geometryCount"] != len(holes) or inspection["closedContours"] != len(holes) or inspection["openContours"] != 0:
        raise RuntimeError("HOLE_SKETCH_POSTCONDITION_FAILED: circle/profile count mismatch")
    if any(kind != "Circle" for kind in inspection["geometryTypes"]):
        raise RuntimeError("HOLE_SKETCH_POSTCONDITION_FAILED: non-circle geometry found")
    if not inspection["fullyConstrained"] or inspection["degreesOfFreedom"] != 0 or inspection["solverErrors"]:
        raise RuntimeError("HOLE_SKETCH_POSTCONDITION_FAILED: Sketch is not solver-clean and fully constrained")
    actual_support = sketch.AttachmentSupport if hasattr(sketch, "AttachmentSupport") else sketch.Support
    if not actual_support or actual_support[0][0] != support_object:
        raise RuntimeError("HOLE_SKETCH_POSTCONDITION_FAILED: support mismatch")
    doc.commitTransaction()
    _mcp_result["result"] = {
        "ok": True,
        "document": doc.Name,
        "body": doc.Name + "::" + body.Name,
        "sketch": doc.Name + "::" + sketch.Name,
        "support": ${JSON.stringify(support ?? plane)},
        "holeCount": len(holes),
        "geometryCount": inspection["geometryCount"],
        "constraintCount": inspection["constraintCount"],
        "degreesOfFreedom": inspection["degreesOfFreedom"],
        "fullyConstrained": inspection["fullyConstrained"],
        "closedContours": inspection["closedContours"],
        "solverErrors": inspection["solverErrors"],
        "geometryTypes": inspection["geometryTypes"]
    }
except Exception:
    doc.abortTransaction()
    doc.recompute()
    raise
`);
    }

    case 'cad_pocket': {
      assertAllowedKeys(args, ['sketch', 'type', 'length', 'name']);
      const sketchResolution = resolvePadSketchReference(args.sketch);
      const pocketType = args.type === undefined ? 'through_all' : args.type;
      if (pocketType !== 'through_all' && pocketType !== 'length') {
        throw new Error('Invalid type: expected through_all or length');
      }
      if (pocketType === 'length' && args.length === undefined) {
        throw new Error('Invalid length: required when type is length');
      }
      const length = args.length === undefined ? undefined : validatePositiveDimension(args.length, 'length');
      const pocketName = validateIdentifier(args.name, 'name', 'Pocket');
      return bridge.run(`
${sketchResolution}
if sketch.TypeId != "Sketcher::SketchObject":
    raise TypeError("OBJECT_IS_NOT_SKETCH: " + sketch.Name)
body = sketch.getParentGeoFeatureGroup()
if body is None or body.TypeId != "PartDesign::Body" or sketch not in body.Group:
    raise ValueError("SKETCH_NOT_IN_BODY: " + doc.Name + "::" + sketch.Name)
${sketchInspectionPython('sketch')}
closed_profiles_valid = inspection["geometryCount"] > 0 and inspection["closedContours"] > 0 and inspection["openContours"] == 0
profiles_suitable = closed_profiles_valid and inspection["fullyConstrained"] and not inspection["solverErrors"] and inspection["constructionGeometryCount"] < inspection["geometryCount"]
if not profiles_suitable:
    raise ValueError("SKETCH_NOT_SUITABLE_FOR_POCKET: " + str(inspection))
base_features = [item for item in body.Group if item != sketch and hasattr(item, "Shape") and not item.Shape.isNull() and len(item.Shape.Solids) == 1 and item.Shape.isValid()]
if not base_features:
    raise ValueError("POCKET_BASE_SOLID_NOT_FOUND: Body contains no valid solid before the Sketch")
base_feature = base_features[-1]
base_volume = float(base_feature.Shape.Volume)
doc.openTransaction("cad_pocket")
try:
    pocket = body.newObject("PartDesign::Pocket", ${JSON.stringify(pocketName)})
    pocket.Profile = sketch
    available_types = list(pocket.getEnumerationsOfProperty("Type"))
    ${pocketType === 'through_all' ? `through_all_type = next((candidate for candidate in available_types if candidate.replace(" ", "").replace("_", "").lower() == "throughall"), None)
    if through_all_type is None:
        raise RuntimeError("POCKET_TYPE_UNSUPPORTED: ThroughAll is unavailable")
    pocket.Type = through_all_type` : `length_type = next((candidate for candidate in available_types if candidate.lower() == "length"), None)
    if length_type is None:
        raise RuntimeError("POCKET_TYPE_UNSUPPORTED: Length is unavailable")
    pocket.Type = length_type
    pocket.Length = ${length}`}
    doc.recompute()
    if hasattr(pocket, "Reversed") and not pocket.Shape.isNull() and float(pocket.Shape.Volume) >= base_volume - 1e-7:
        pocket.Reversed = not bool(pocket.Reversed)
        doc.recompute()
    error_states = [str(state) for state in pocket.State if str(state) not in ("Up-to-date", "Touched")]
    if error_states:
        raise RuntimeError("POCKET_RECOMPUTE_FAILED: " + str(error_states))
    if pocket.TypeId != "PartDesign::Pocket":
        raise RuntimeError("POCKET_POSTCONDITION_FAILED: unexpected TypeId " + pocket.TypeId)
    if pocket.getParentGeoFeatureGroup() != body or pocket not in body.Group or body.Tip != pocket:
        raise RuntimeError("POCKET_POSTCONDITION_FAILED: Pocket is not the Body Tip")
    profile_target = pocket.Profile[0] if isinstance(pocket.Profile, tuple) else pocket.Profile
    if profile_target != sketch:
        raise RuntimeError("POCKET_POSTCONDITION_FAILED: Profile mismatch")
    shape = pocket.Shape
    valid = not shape.isNull() and shape.isValid() and len(shape.Solids) == 1 and shape.Volume > 0
    if not valid:
        raise RuntimeError("POCKET_POSTCONDITION_FAILED: result is not one valid solid")
    if float(shape.Volume) >= base_volume:
        raise RuntimeError("POCKET_POSTCONDITION_FAILED: no material was removed")
    bounds = shape.BoundBox
    cylindrical_faces = sum(1 for face in shape.Faces if face.Surface.__class__.__name__ == "Cylinder")
    doc.commitTransaction()
    _mcp_result["result"] = {
        "ok": True,
        "document": doc.Name,
        "body": doc.Name + "::" + body.Name,
        "sketch": doc.Name + "::" + sketch.Name,
        "pocket": doc.Name + "::" + pocket.Name,
        "typeId": pocket.TypeId,
        "type": ${JSON.stringify(pocketType)},
        "length": ${length ?? 'None'},
        "valid": bool(valid),
        "error": None,
        "solidCount": len(shape.Solids),
        "volume": float(shape.Volume),
        "removedVolume": base_volume - float(shape.Volume),
        "cylindricalFaceCount": cylindrical_faces,
        "boundingBox": {"xLength": float(bounds.XLength), "yLength": float(bounds.YLength), "zLength": float(bounds.ZLength)}
    }
except Exception:
    doc.abortTransaction()
    doc.recompute()
    raise
`);
    }

    case 'cad_fillet':
    case 'cad_chamfer': {
      const isFillet = name === 'cad_fillet';
      const dimensionField = isFillet ? 'radius' : 'size';
      assertAllowedKeys(args, ['body', dimensionField, 'edges', 'name']);
      const bodyRef = validateQualifiedId(args.body, 'body');
      const dimension = validatePositiveDimension(args[dimensionField], dimensionField);
      const selection = validateEdgeSelection(args.edges);
      const featureName = validateIdentifier(args.name, 'name', isFillet ? 'Fillet' : 'Chamfer');
      const featureType = isFillet ? 'PartDesign::Fillet' : 'PartDesign::Chamfer';
      const property = isFillet ? 'Radius' : 'Size';
      return bridge.run(`
${resolveBodyPython(bodyRef.document, bodyRef.object)}
${edgeSelectionPython(selection)}
doc.openTransaction(${JSON.stringify(name)})
try:
    feature = body.newObject(${JSON.stringify(featureType)}, ${JSON.stringify(featureName)})
    feature.Base = (source, selected_subnames)
    feature.${property} = ${dimension}
    doc.recompute()
    error_states = [str(state) for state in feature.State if str(state) not in ("Up-to-date", "Touched")]
    if error_states:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_RECOMPUTE_FAILED: `)} + str(error_states))
    if feature.TypeId != ${JSON.stringify(featureType)}:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: unexpected TypeId`)})
    if feature.getParentGeoFeatureGroup() != body or feature not in body.Group or body.Tip != feature:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: feature is not the Body Tip`)})
    base_target = feature.Base[0] if isinstance(feature.Base, tuple) else feature.Base
    if base_target != source:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: source feature mismatch`)})
    if abs(float(feature.${property}.Value) - ${dimension}) > 1e-7:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: dimension mismatch`)})
    shape = feature.Shape
    valid = not shape.isNull() and shape.isValid() and len(shape.Solids) == 1 and shape.Volume > 0
    if not valid:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: result is not one valid solid`)})
    if abs(float(shape.Volume) - source_volume) <= 1e-7:
        raise RuntimeError(${JSON.stringify(`${isFillet ? 'FILLET' : 'CHAMFER'}_POSTCONDITION_FAILED: geometry did not change`)})
    bounds = shape.BoundBox
    doc.commitTransaction()
    _mcp_result["result"] = {
        "document": doc.Name,
        "body": doc.Name + "::" + body.Name,
        "sourceFeature": doc.Name + "::" + source.Name,
        "feature": doc.Name + "::" + feature.Name,
        "typeId": feature.TypeId,
        "selectedEdges": selected_descriptions,
        ${JSON.stringify(dimensionField)}: float(feature.${property}.Value),
        "valid": bool(valid),
        "solidCount": len(shape.Solids),
        "volume": float(shape.Volume),
        "sourceVolume": source_volume,
        "boundingBox": {"xLength": float(bounds.XLength), "yLength": float(bounds.YLength), "zLength": float(bounds.ZLength)},
        "error": None
    }
except Exception:
    doc.abortTransaction()
    if "feature" in locals() and doc.getObject(feature.Name) is not None:
        doc.removeObject(feature.Name)
    if doc.getObject(source.Name) is not None and body.Tip != source:
        body.Tip = source
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
