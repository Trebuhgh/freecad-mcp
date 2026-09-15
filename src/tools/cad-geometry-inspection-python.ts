/** Shared independent BREP inspection used by construction and edit verification. */
export function cadGeometryInspectionPython(): string {
  return `
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

    bounds = shape.optimalBoundingBox(False)
    planar = []
    cylindrical = []
    probe_span = max(float(bounds.XLength), float(bounds.YLength), float(bounds.ZLength), 1.0) * 2.0 + 2.0
    for face in shape.Faces:
        surface = face.Surface
        surface_name = surface.__class__.__name__
        center = face.CenterOfMass
        face_bounds = face.optimalBoundingBox(False)
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
            axial_length = float(face_bounds.ZLength) if abs(abs(axis[2]) - 1.0) <= LINEAR_TOLERANCE_MM else 0.0
            angular_span = float(face.Area) / (float(surface.Radius) * axial_length) if axial_length > LINEAR_TOLERANCE_MM and float(surface.Radius) > LINEAR_TOLERANCE_MM else 0.0
            axis_material_length = clean(axis_probe.common(shape).Length)
            cylindrical.append({
                "surface_type": "cylinder",
                "area": clean(face.Area, AREA_TOLERANCE_MM2),
                "radius": clean(surface.Radius),
                "axis": axis,
                "axis_point": axis_point,
                "center": [clean(center.x), clean(center.y), clean(center.z)],
                "extent": extent,
                "axis_material_length": axis_material_length,
                "axis_relation": "void" if axis_material_length <= LINEAR_TOLERANCE_MM else "material",
                "angular_span": clean(angular_span),
                "surface_role": "hole" if abs(angular_span - 2.0 * math.pi) <= LINEAR_TOLERANCE_MM and axis_material_length <= LINEAR_TOLERANCE_MM else "outer_profile",
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
`;
}

