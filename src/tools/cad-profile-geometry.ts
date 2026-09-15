import { AREA_TOLERANCE_MM2, LINEAR_TOLERANCE_MM } from './cad-geometry-tolerances.js';

export interface ProfilePoint {
  x: number;
  y: number;
}

export interface CanonicalLineSegment {
  type: 'line';
  start: ProfilePoint;
  end: ProfilePoint;
}

export interface CanonicalArcSegment {
  type: 'arc';
  start: ProfilePoint;
  end: ProfilePoint;
  center: ProfilePoint;
  direction: 'cw' | 'ccw';
  radius: number;
}

export type CanonicalProfileSegment = CanonicalLineSegment | CanonicalArcSegment;

export interface ProfileSegmentIssue {
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidatedSegmentProfile {
  segments?: CanonicalProfileSegment[];
  area?: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  lineCount?: number;
  arcCount?: number;
  arcRadii?: number[];
  issues: ProfileSegmentIssue[];
}

interface IntersectionResult {
  points: ProfilePoint[];
  overlaps: boolean;
}

const TAU = Math.PI * 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePoint(value: unknown, path: string, issues: ProfileSegmentIssue[]): ProfilePoint | undefined {
  if (!Array.isArray(value) || value.length !== 2 || value.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) {
    issues.push({ code: 'INVALID_PROFILE_SEGMENT_POINT', path, message: 'Segment points must be exactly [x,y] with finite coordinates.' });
    return undefined;
  }
  return { x: value[0] as number, y: value[1] as number };
}

function distance(first: ProfilePoint, second: ProfilePoint): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function samePoint(first: ProfilePoint, second: ProfilePoint): boolean {
  return distance(first, second) <= LINEAR_TOLERANCE_MM;
}

function cross(first: ProfilePoint, second: ProfilePoint, third: ProfilePoint): number {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function pointOnLineSegment(point: ProfilePoint, segment: CanonicalLineSegment): boolean {
  return Math.abs(cross(segment.start, segment.end, point)) <= AREA_TOLERANCE_MM2
    && point.x >= Math.min(segment.start.x, segment.end.x) - LINEAR_TOLERANCE_MM
    && point.x <= Math.max(segment.start.x, segment.end.x) + LINEAR_TOLERANCE_MM
    && point.y >= Math.min(segment.start.y, segment.end.y) - LINEAR_TOLERANCE_MM
    && point.y <= Math.max(segment.start.y, segment.end.y) + LINEAR_TOLERANCE_MM;
}

function normalizeAngle(angle: number): number {
  const normalized = angle % TAU;
  return normalized < 0 ? normalized + TAU : normalized;
}

function ccwDelta(start: number, end: number): number {
  return normalizeAngle(end - start);
}

function signedArcSweep(segment: CanonicalArcSegment): number {
  const start = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x);
  const end = Math.atan2(segment.end.y - segment.center.y, segment.end.x - segment.center.x);
  return segment.direction === 'ccw' ? ccwDelta(start, end) : -ccwDelta(end, start);
}

function pointOnArc(point: ProfilePoint, segment: CanonicalArcSegment): boolean {
  if (Math.abs(distance(point, segment.center) - segment.radius) > LINEAR_TOLERANCE_MM) return false;
  const start = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x);
  const angle = Math.atan2(point.y - segment.center.y, point.x - segment.center.x);
  const total = Math.abs(signedArcSweep(segment));
  const travel = segment.direction === 'ccw' ? ccwDelta(start, angle) : ccwDelta(angle, start);
  return travel <= total + LINEAR_TOLERANCE_MM / segment.radius;
}

function arcPoint(segment: CanonicalArcSegment, fraction: number): ProfilePoint {
  const start = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x);
  const angle = start + signedArcSweep(segment) * fraction;
  return { x: segment.center.x + segment.radius * Math.cos(angle), y: segment.center.y + segment.radius * Math.sin(angle) };
}

function uniquePoints(points: ProfilePoint[]): ProfilePoint[] {
  const unique: ProfilePoint[] = [];
  for (const point of points) if (!unique.some((candidate) => samePoint(candidate, point))) unique.push(point);
  return unique;
}

function lineLineIntersections(first: CanonicalLineSegment, second: CanonicalLineSegment): IntersectionResult {
  const firstDirection = { x: first.end.x - first.start.x, y: first.end.y - first.start.y };
  const secondDirection = { x: second.end.x - second.start.x, y: second.end.y - second.start.y };
  const denominator = firstDirection.x * secondDirection.y - firstDirection.y * secondDirection.x;
  if (Math.abs(denominator) <= AREA_TOLERANCE_MM2) {
    if (Math.abs(cross(first.start, first.end, second.start)) > AREA_TOLERANCE_MM2) return { points: [], overlaps: false };
    const points = uniquePoints([first.start, first.end, second.start, second.end].filter((point) => pointOnLineSegment(point, first) && pointOnLineSegment(point, second)));
    return { points, overlaps: points.length >= 2 && distance(points[0], points[1]) > LINEAR_TOLERANCE_MM };
  }
  const offset = { x: second.start.x - first.start.x, y: second.start.y - first.start.y };
  const firstParameter = (offset.x * secondDirection.y - offset.y * secondDirection.x) / denominator;
  const secondParameter = (offset.x * firstDirection.y - offset.y * firstDirection.x) / denominator;
  const parameterTolerance = LINEAR_TOLERANCE_MM / Math.max(distance(first.start, first.end), distance(second.start, second.end), 1);
  if (firstParameter < -parameterTolerance || firstParameter > 1 + parameterTolerance || secondParameter < -parameterTolerance || secondParameter > 1 + parameterTolerance) return { points: [], overlaps: false };
  return { points: [{ x: first.start.x + firstParameter * firstDirection.x, y: first.start.y + firstParameter * firstDirection.y }], overlaps: false };
}

function lineArcIntersections(line: CanonicalLineSegment, arc: CanonicalArcSegment): IntersectionResult {
  const dx = line.end.x - line.start.x;
  const dy = line.end.y - line.start.y;
  const fx = line.start.x - arc.center.x;
  const fy = line.start.y - arc.center.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - arc.radius * arc.radius;
  const discriminant = b * b - 4 * a * c;
  const discriminantTolerance = LINEAR_TOLERANCE_MM * LINEAR_TOLERANCE_MM * Math.max(a, 1);
  if (discriminant < -discriminantTolerance) return { points: [], overlaps: false };
  const root = Math.sqrt(Math.max(0, discriminant));
  const parameters = root <= LINEAR_TOLERANCE_MM ? [-b / (2 * a)] : [(-b - root) / (2 * a), (-b + root) / (2 * a)];
  const parameterTolerance = LINEAR_TOLERANCE_MM / Math.max(Math.sqrt(a), 1);
  const points = parameters
    .filter((parameter) => parameter >= -parameterTolerance && parameter <= 1 + parameterTolerance)
    .map((parameter) => ({ x: line.start.x + parameter * dx, y: line.start.y + parameter * dy }))
    .filter((point) => pointOnArc(point, arc));
  return { points: uniquePoints(points), overlaps: false };
}

function arcArcIntersections(first: CanonicalArcSegment, second: CanonicalArcSegment): IntersectionResult {
  const centerDistance = distance(first.center, second.center);
  if (centerDistance <= LINEAR_TOLERANCE_MM && Math.abs(first.radius - second.radius) <= LINEAR_TOLERANCE_MM) {
    const points = uniquePoints([first.start, first.end, second.start, second.end].filter((point) => pointOnArc(point, first) && pointOnArc(point, second)));
    const overlaps = pointOnArc(arcPoint(first, 0.5), second) || pointOnArc(arcPoint(second, 0.5), first);
    return { points, overlaps };
  }
  if (centerDistance <= LINEAR_TOLERANCE_MM || centerDistance > first.radius + second.radius + LINEAR_TOLERANCE_MM || centerDistance < Math.abs(first.radius - second.radius) - LINEAR_TOLERANCE_MM) return { points: [], overlaps: false };
  const along = (first.radius ** 2 - second.radius ** 2 + centerDistance ** 2) / (2 * centerDistance);
  const heightSquared = first.radius ** 2 - along ** 2;
  if (heightSquared < -(LINEAR_TOLERANCE_MM ** 2)) return { points: [], overlaps: false };
  const height = Math.sqrt(Math.max(0, heightSquared));
  const ux = (second.center.x - first.center.x) / centerDistance;
  const uy = (second.center.y - first.center.y) / centerDistance;
  const base = { x: first.center.x + along * ux, y: first.center.y + along * uy };
  const candidates = height <= LINEAR_TOLERANCE_MM
    ? [base]
    : [{ x: base.x - height * uy, y: base.y + height * ux }, { x: base.x + height * uy, y: base.y - height * ux }];
  return { points: uniquePoints(candidates.filter((point) => pointOnArc(point, first) && pointOnArc(point, second))), overlaps: false };
}

function intersections(first: CanonicalProfileSegment, second: CanonicalProfileSegment): IntersectionResult {
  if (first.type === 'line' && second.type === 'line') return lineLineIntersections(first, second);
  if (first.type === 'line' && second.type === 'arc') return lineArcIntersections(first, second);
  if (first.type === 'arc' && second.type === 'line') return lineArcIntersections(second, first);
  return arcArcIntersections(first as CanonicalArcSegment, second as CanonicalArcSegment);
}

function segmentAreaContribution(segment: CanonicalProfileSegment): number {
  if (segment.type === 'line') return (segment.start.x * segment.end.y - segment.end.x * segment.start.y) / 2;
  const startAngle = Math.atan2(segment.start.y - segment.center.y, segment.start.x - segment.center.x);
  const endAngle = startAngle + signedArcSweep(segment);
  return (
    segment.radius ** 2 * (endAngle - startAngle)
    + segment.radius * segment.center.x * (Math.sin(endAngle) - Math.sin(startAngle))
    + segment.radius * segment.center.y * (Math.cos(startAngle) - Math.cos(endAngle))
  ) / 2;
}

function profileBounds(segments: CanonicalProfileSegment[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const points: ProfilePoint[] = segments.flatMap((segment) => [segment.start, segment.end]);
  for (const segment of segments) {
    if (segment.type !== 'arc') continue;
    for (const angle of [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
      const point = { x: segment.center.x + segment.radius * Math.cos(angle), y: segment.center.y + segment.radius * Math.sin(angle) };
      if (pointOnArc(point, segment)) points.push(point);
    }
  }
  return {
    minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)),
  };
}

export function validateProfileSegments(value: unknown, path: string): ValidatedSegmentProfile {
  const issues: ProfileSegmentIssue[] = [];
  if (!Array.isArray(value)) return { issues: [{ code: 'INVALID_PROFILE_SEGMENTS', path, message: 'segments must be an array.' }] };
  if (value.length === 0) return { issues: [{ code: 'PROFILE_TOO_FEW_SEGMENTS', path, message: 'A segment profile requires at least one explicitly provided segment for validation.' }] };
  if (value.length > 1000) return { issues: [{ code: 'PROFILE_TOO_MANY_SEGMENTS', path, message: 'At most 1000 profile segments are supported.' }] };
  const segments: CanonicalProfileSegment[] = [];
  value.forEach((candidate, index) => {
    const segmentPath = `${path}.${index}`;
    if (!isRecord(candidate)) { issues.push({ code: 'INVALID_PROFILE_SEGMENT', path: segmentPath, message: 'Each segment must be an object.' }); return; }
    if (candidate.type !== 'line' && candidate.type !== 'arc') { issues.push({ code: 'UNSUPPORTED_PROFILE_SEGMENT_TYPE', path: `${segmentPath}.type`, message: `Segment type "${String(candidate.type)}" is unsupported; use line or arc.` }); return; }
    const allowed = candidate.type === 'line' ? ['type', 'start', 'end'] : ['type', 'start', 'end', 'center', 'direction'];
    for (const key of Object.keys(candidate)) if (!allowed.includes(key)) issues.push({ code: 'UNKNOWN_PROFILE_SEGMENT_FIELD', path: `${segmentPath}.${key}`, message: `Unknown ${String(candidate.type)} segment field "${key}".` });
    const start = parsePoint(candidate.start, `${segmentPath}.start`, issues);
    const end = parsePoint(candidate.end, `${segmentPath}.end`, issues);
    if (start === undefined || end === undefined) return;
    if (samePoint(start, end)) { issues.push({ code: candidate.type === 'arc' ? 'ARC_DEGENERATE' : 'PROFILE_DEGENERATE_SEGMENT', path: segmentPath, message: 'Segment start and end must be distinct.' }); return; }
    if (candidate.type === 'line') { segments.push({ type: 'line', start, end }); return; }
    const center = parsePoint(candidate.center, `${segmentPath}.center`, issues);
    if (candidate.direction !== 'cw' && candidate.direction !== 'ccw') issues.push({ code: 'ARC_INVALID_DIRECTION', path: `${segmentPath}.direction`, message: 'Arc direction must be cw or ccw.' });
    if (center === undefined || (candidate.direction !== 'cw' && candidate.direction !== 'ccw')) return;
    const startRadius = distance(center, start);
    const endRadius = distance(center, end);
    if (startRadius <= LINEAR_TOLERANCE_MM || endRadius <= LINEAR_TOLERANCE_MM) { issues.push({ code: 'ARC_ZERO_RADIUS', path: segmentPath, message: 'Arc radius must be greater than the linear tolerance.', details: { startRadius, endRadius } }); return; }
    if (Math.abs(startRadius - endRadius) > LINEAR_TOLERANCE_MM) { issues.push({ code: 'ARC_RADIUS_MISMATCH', path: segmentPath, message: 'Center-to-start and center-to-end radii differ.', details: { startRadius, endRadius, difference: Math.abs(startRadius - endRadius) } }); return; }
    segments.push({ type: 'arc', start, end, center, direction: candidate.direction, radius: (startRadius + endRadius) / 2 });
  });
  if (issues.length > 0 || segments.length !== value.length) return { issues };

  for (let index = 0; index < segments.length - 1; index += 1) {
    const next = index + 1;
    const gap = distance(segments[index].end, segments[next].start);
    if (gap > LINEAR_TOLERANCE_MM) issues.push({
      code: 'PROFILE_SEGMENT_GAP', path: `${path}.${index}.end`, message: 'Adjacent profile segments are not continuous.',
      details: { segmentIndex: index, nextSegmentIndex: next, expectedPoint: segments[index].end, actualPoint: segments[next].start, distance: gap },
    });
  }
  if (issues.length > 0) return { issues };

  const lastSegmentIndex = segments.length - 1;
  const closureDistance = distance(segments[lastSegmentIndex].end, segments[0].start);
  if (closureDistance > LINEAR_TOLERANCE_MM) return {
    segments,
    issues: [{
      code: 'PROFILE_NOT_CLOSED', path: `${path}.${lastSegmentIndex}.end`,
      message: 'The provided contour is open; one or more explicitly supplied segments must connect the final endpoint to the first start point.',
      details: {
        lastSegmentIndex,
        expectedPoint: segments[0].start,
        actualPoint: segments[lastSegmentIndex].end,
        distance: closureDistance,
      },
    }],
  };

  for (let first = 0; first < segments.length; first += 1) for (let second = first + 1; second < segments.length; second += 1) {
    const result = intersections(segments[first], segments[second]);
    const allowed: ProfilePoint[] = [];
    if (second === first + 1) allowed.push(segments[first].end);
    if (first === 0 && second === segments.length - 1) allowed.push(segments[first].start);
    if (result.overlaps || result.points.some((point) => !allowed.some((candidate) => samePoint(candidate, point)))) {
      issues.push({ code: 'PROFILE_SEGMENT_SELF_INTERSECTION', path, message: `Profile segments ${first} and ${second} intersect, touch, or overlap outside their shared endpoint.`, details: { firstSegmentIndex: first, secondSegmentIndex: second, intersectionPoints: result.points, overlaps: result.overlaps } });
      return { issues };
    }
  }

  const signedArea = segments.reduce((sum, segment) => sum + segmentAreaContribution(segment), 0);
  if (Math.abs(signedArea) <= AREA_TOLERANCE_MM2) return { issues: [{ code: 'PROFILE_ZERO_AREA', path, message: 'The segment profile encloses no usable area.' }] };
  return {
    segments,
    area: Math.abs(signedArea),
    bounds: profileBounds(segments),
    lineCount: segments.filter((segment) => segment.type === 'line').length,
    arcCount: segments.filter((segment) => segment.type === 'arc').length,
    arcRadii: segments.filter((segment): segment is CanonicalArcSegment => segment.type === 'arc').map((segment) => segment.radius),
    issues,
  };
}
