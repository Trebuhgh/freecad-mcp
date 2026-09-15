import { ToolArgs, ToolResult } from '../types.js';
import { AREA_TOLERANCE_MM2, LINEAR_TOLERANCE_MM } from './cad-geometry-tolerances.js';

type PlanStatus = 'valid' | 'incomplete' | 'ambiguous' | 'unsupported' | 'invalid';
type IssueKind = Exclude<PlanStatus, 'valid'>;

interface PlanIssue {
  code: string;
  path: string;
  message: string;
  question?: string;
  options?: Array<{ id: string; value: string; label: string }>;
}

interface InternalIssue extends PlanIssue {
  kind: IssueKind;
}

interface Point2D {
  x: number;
  y: number;
}

export interface CadPlanValidationResult {
  status: PlanStatus;
  can_execute: boolean;
  issues: PlanIssue[];
  resolved_plan?: Record<string, unknown>;
  clarification_visual?: { type: 'svg'; content: string };
}

export type CadPlanState = 'unvalidated' | 'blocked' | 'validated';

export class CadPlanValidationGate {
  private currentState: CadPlanState = 'unvalidated';
  private revision = 0;
  private currentResult?: CadPlanValidationResult;
  private currentResolvedPlan?: Record<string, unknown>;
  private executingRevision?: number;

  get state(): CadPlanState {
    return this.currentState;
  }

  get validationResult(): CadPlanValidationResult | undefined {
    return this.currentResult;
  }

  get resolvedPlan(): Record<string, unknown> | undefined {
    return this.currentResolvedPlan;
  }

  get planRevision(): number | undefined {
    return this.currentState === 'validated' ? this.revision : undefined;
  }

  beginValidation(): number {
    if (this.executingRevision !== undefined) {
      throw new Error('CAD_PLAN_EXECUTION_IN_PROGRESS: validation cannot replace a plan during execution');
    }
    this.revision += 1;
    this.currentState = 'blocked';
    this.currentResult = undefined;
    this.currentResolvedPlan = undefined;
    return this.revision;
  }

  beginExecution(): { revision: number; resolvedPlan: Record<string, unknown> } | undefined {
    if (this.currentState !== 'validated' || this.currentResolvedPlan === undefined || this.executingRevision !== undefined) {
      return undefined;
    }
    this.executingRevision = this.revision;
    return {
      revision: this.revision,
      resolvedPlan: JSON.parse(JSON.stringify(this.currentResolvedPlan)) as Record<string, unknown>,
    };
  }

  endExecution(revision: number): void {
    if (this.executingRevision === revision) this.executingRevision = undefined;
  }

  blockAfterVerificationFailure(revision: number): void {
    if (this.executingRevision !== revision) return;
    this.currentState = 'blocked';
    this.currentResolvedPlan = undefined;
  }

  completeValidation(revision: number, result: CadPlanValidationResult): void {
    if (revision !== this.revision) return;
    this.currentResult = result;
    if (result.status === 'valid' && result.can_execute === true && result.resolved_plan !== undefined) {
      this.currentState = 'validated';
      this.currentResolvedPlan = result.resolved_plan;
    } else {
      this.currentState = 'blocked';
      this.currentResolvedPlan = undefined;
    }
  }
}

export const CAD_PLAN_TOOLS = [{
  name: 'cad_validate_plan',
  description: 'Mandatory non-mutating validation gate. PREFERRED INPUT: Simple Intent Plan. Plate: {shape:"plate",size:[100,60,10],unit:"mm"}. Polygon profile: {shape:"profile",profile:[[0,0],[100,0],[100,40],[0,40]],thickness:10,unit:"mm"}. Holes and finishing currently require shape:"plate". Feature and legacy plans remain supported.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      plan: {
        type: 'object',
        description: 'Prefer Simple Intent: shape:"plate" with size, or shape:"profile" with profile vertices and thickness. Holes/fillet/chamfer currently require plate. Ordered feature and legacy rectangular_plate plans remain supported.',
        properties: {
          shape: { type: ['string', 'null'], enum: ['plate', 'profile', null], description: 'Simple Intent shape: rectangular plate or straight-segment polygon profile.' },
          size: { type: ['array', 'null'], minItems: 3, maxItems: 3, items: { type: 'number' }, description: 'Simple plate [width,height,thickness].' },
          profile: { type: ['array', 'null'], minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, description: 'Simple profile polygon vertices as [[x,y],...]; closure is automatic.' },
          thickness: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Simple profile extrusion length in +Z, in mm.' },
          unit: { type: ['string', 'null'], enum: ['mm', null], description: 'Unit for a feature plan; currently only mm.' },
          features: {
            type: ['array', 'null'],
            description: 'Ordered feature construction plan. Supported types: rectangular_pad, profile_pad, hole_pattern, fillet, chamfer.',
            items: {
              type: 'object',
              properties: {
                id: { type: ['string', 'null'], description: 'Optional stable semantic feature ID. If omitted, the server deterministically generates base, holes, fillet, chamfer, then suffixed variants.' },
                type: { type: ['string', 'null'], enum: ['rectangular_pad', 'profile_pad', 'hole_pattern', 'fillet', 'chamfer', null] },
                points: { type: ['array', 'null'], minItems: 3, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, description: 'profile_pad polygon vertices; closure is automatic.' },
                width: { type: ['number', 'null'] },
                height: { type: ['number', 'null'] },
                length: { type: ['number', 'null'] },
                diameter: { type: ['number', 'null'] },
                count: { type: ['integer', 'null'] },
                placement: {
                  type: ['object', 'null'],
                  properties: {
                    type: { type: ['string', 'null'], enum: ['edge_offset', 'explicit', 'rectangular_grid', null] },
                    distance: { type: ['number', 'null'] },
                    reference: { type: ['string', 'null'], enum: ['center', 'boundary', null], description: 'Use null when center versus boundary is not explicit.' },
                    centers: { type: ['array', 'null'], items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
                    origin: { type: ['object', 'null'], properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
                    columns: { type: ['integer', 'null'] },
                    rows: { type: ['integer', 'null'] },
                    spacing_x: { type: ['number', 'null'] },
                    spacing_y: { type: ['number', 'null'] },
                  },
                },
                radius: { type: ['number', 'null'] },
                size: { type: ['number', 'null'] },
                edges: { type: ['string', 'null'], enum: ['all_vertical', 'all_top', 'all_bottom', 'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner', null] },
                after: { type: ['string', 'null'], description: 'Optional reference to an earlier feature ID.' },
                target: { type: ['string', 'null'], description: 'Optional semantic target referencing an earlier feature ID.' },
              },
            },
          },
          base: {
            type: ['object', 'null'],
            properties: {
              type: { type: ['string', 'null'] },
              width: { type: ['number', 'null'] },
              height: { type: ['number', 'null'] },
              thickness: { type: ['number', 'null'] },
              unit: { type: ['string', 'null'] },
            },
          },
          holes: {
            type: ['object', 'null'],
            properties: {
              count: { type: ['integer', 'null'] },
              diameter: { type: ['number', 'null'] },
              grid: { type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'integer' }, description: 'Simple grid [columns,rows].' },
              start: { type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'number' }, description: 'Simple grid origin [x,y].' },
              spacing: { type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'number' }, description: 'Simple grid spacing [x,y].' },
              centers: { type: ['array', 'null'], minItems: 1, items: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } }, description: 'Simple explicit centers as [[x,y],...].' },
              edge_offset: { type: ['number', 'null'], description: 'Simple four-corner edge offset.' },
              reference: { type: ['string', 'null'], enum: ['center', 'boundary', null] },
              placement: {
                type: ['object', 'null'],
                description: 'Required hole placement: edge_offset, explicit centers, or rectangular_grid.',
                properties: {
                  type: { type: ['string', 'null'], enum: ['edge_offset', 'explicit', 'rectangular_grid', null], description: 'Supported strategies: edge_offset, explicit, rectangular_grid.' },
                  distance: { type: ['number', 'null'] },
                  reference: { type: ['string', 'null'], enum: ['center', 'boundary', null], description: 'center means distance to hole center; boundary means distance to hole rim; use null whenever the user did not explicitly disambiguate.' },
                  centers: { type: ['array', 'null'], items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false } },
                  origin: { type: ['object', 'null'], properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
                  columns: { type: ['integer', 'null'] },
                  rows: { type: ['integer', 'null'] },
                  spacing_x: { type: ['number', 'null'] },
                  spacing_y: { type: ['number', 'null'] },
                },
              },
            },
          },
          fillet: {
            type: ['object', 'null'],
            properties: {
              radius: { type: ['number', 'null'] },
              edges: { type: ['string', 'object', 'null'] },
            },
          },
          chamfer: {
            type: ['object', 'null'],
            properties: {
              size: { type: ['number', 'null'] },
              edges: { type: ['string', 'object', 'null'] },
            },
          },
        },
      },
    },
    additionalProperties: false,
    required: ['plan'],
  },
}, {
  name: 'cad_execute_plan',
  description: 'Execute and deterministically verify exactly the resolved plan stored by the latest successful cad_validate_plan call. success=true means status=verified. CAD_VERIFICATION_FAILED requires a corrected plan to pass cad_validate_plan again; never directly repair failed geometry. Accepts no geometric overrides.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      documentName: { type: 'string', description: 'Optional explicit non-geometric FreeCAD document name. If omitted, the server atomically selects the smallest free CADPlan_N name. Explicit conflicts are errors and are never renamed or overwritten.' },
    },
    additionalProperties: false,
    required: [],
  },
}];

const SUPPORTED_EDGE_SELECTORS = new Set([
  'all_vertical', 'all_top', 'all_bottom',
  'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addMissing(issues: InternalIssue[], path: string, label: string): void {
  issues.push({ kind: 'incomplete', code: 'MISSING_REQUIRED_VALUE', path, message: `${label} is required.` });
}

function positiveNumber(
  record: Record<string, unknown>, key: string, path: string, label: string, issues: InternalIssue[],
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) {
    addMissing(issues, path, label);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ kind: 'invalid', code: 'INVALID_NUMBER', path, message: `${label} must be a finite number.` });
    return undefined;
  }
  if (value <= 0) {
    issues.push({ kind: 'invalid', code: 'VALUE_MUST_BE_POSITIVE', path, message: `${label} must be greater than zero.` });
    return undefined;
  }
  return value;
}

function validateEdges(value: unknown, path: string, issues: InternalIssue[]): void {
  if (value === undefined || value === null) {
    addMissing(issues, path, 'Edge selection');
  } else if (typeof value === 'string' && !SUPPORTED_EDGE_SELECTORS.has(value)) {
    issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_EDGE_SELECTOR', path, message: `Edge selector "${value}" is not supported.` });
  } else if (typeof value !== 'string') {
    issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_EDGE_SELECTION', path, message: 'Plan execution currently supports semantic edge selector strings only.' });
  }
}

function ambiguitySvg(distance: number): string {
  const label = `${distance} mm`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260" viewBox="0 0 720 260" role="img" aria-label="Distance reference alternatives A and B"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="4" refY="4" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 Z" fill="#1f2937"/></marker></defs><rect width="720" height="260" fill="white"/><g font-family="Arial,sans-serif" fill="#111827" stroke="#1f2937"><g transform="translate(20,20)"><text x="0" y="20" font-size="22" font-weight="700" stroke="none">A</text><text x="35" y="20" font-size="15" stroke="none">Außenkante → Bohrungsmittelpunkt</text><line x1="45" y1="55" x2="45" y2="220" stroke-width="4"/><circle cx="205" cy="140" r="32" fill="none" stroke-width="3"/><circle cx="205" cy="140" r="4" fill="#dc2626" stroke="none"/><line x1="45" y1="90" x2="205" y2="90" marker-start="url(#arrow)" marker-end="url(#arrow)"/><line x1="45" y1="80" x2="45" y2="105"/><line x1="205" y1="80" x2="205" y2="140"/><text x="105" y="82" font-size="15" stroke="none">${label}</text></g><g transform="translate(380,20)"><text x="0" y="20" font-size="22" font-weight="700" stroke="none">B</text><text x="35" y="20" font-size="15" stroke="none">Außenkante → Bohrungsrand</text><line x1="45" y1="55" x2="45" y2="220" stroke-width="4"/><circle cx="205" cy="140" r="32" fill="none" stroke-width="3"/><circle cx="205" cy="140" r="4" fill="#dc2626" stroke="none"/><line x1="45" y1="90" x2="173" y2="90" marker-start="url(#arrow)" marker-end="url(#arrow)"/><line x1="45" y1="80" x2="45" y2="105"/><line x1="173" y1="80" x2="173" y2="140"/><text x="90" y="82" font-size="15" stroke="none">${label}</text></g></g></svg>`;
}

function statusFor(issues: InternalIssue[]): PlanStatus {
  if (issues.some((issue) => issue.kind === 'invalid')) return 'invalid';
  if (issues.some((issue) => issue.kind === 'unsupported')) return 'unsupported';
  if (issues.some((issue) => issue.kind === 'ambiguous')) return 'ambiguous';
  if (issues.some((issue) => issue.kind === 'incomplete')) return 'incomplete';
  return 'valid';
}

function validateLegacyCadPlan(value: unknown): CadPlanValidationResult {
  const issues: InternalIssue[] = [];
  const resolved: Record<string, unknown> = {};
  let ambiguityDistance: number | undefined;

  if (!isRecord(value)) {
    return {
      status: value === undefined || value === null ? 'incomplete' : 'invalid',
      can_execute: false,
      issues: [{
        code: value === undefined || value === null ? 'MISSING_REQUIRED_VALUE' : 'INVALID_PLAN',
        path: 'plan',
        message: value === undefined || value === null ? 'CAD plan is required.' : 'CAD plan must be an object.',
      }],
    };
  }

  for (const key of Object.keys(value)) {
    if (!['base', 'holes', 'fillet', 'chamfer'].includes(key)) {
      issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLAN_ELEMENT', path: key, message: `Plan element "${key}" is not supported.` });
    }
  }

  const base = value.base;
  let width: number | undefined;
  let height: number | undefined;
  if (base === undefined || base === null) {
    addMissing(issues, 'base', 'Base feature');
  } else if (!isRecord(base)) {
    issues.push({ kind: 'invalid', code: 'INVALID_BASE', path: 'base', message: 'Base must be an object.' });
  } else {
    if (base.type === undefined || base.type === null) addMissing(issues, 'base.type', 'Base type');
    else if (base.type !== 'rectangular_plate') issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_BASE_TYPE', path: 'base.type', message: `Base type "${String(base.type)}" is not supported.` });
    width = positiveNumber(base, 'width', 'base.width', 'Plate width', issues);
    height = positiveNumber(base, 'height', 'base.height', 'Plate height', issues);
    const thickness = positiveNumber(base, 'thickness', 'base.thickness', 'Plate thickness', issues);
    if (base.unit === undefined || base.unit === null || base.unit === '') addMissing(issues, 'base.unit', 'Unit');
    else if (typeof base.unit !== 'string') issues.push({ kind: 'invalid', code: 'INVALID_UNIT', path: 'base.unit', message: 'Unit must be a string.' });
    else if (base.unit !== 'mm') issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_UNIT', path: 'base.unit', message: `Unit "${base.unit}" is not supported; use mm.` });
    if (width !== undefined && height !== undefined && thickness !== undefined && base.type === 'rectangular_plate' && base.unit === 'mm') {
      resolved.base = { type: 'rectangular_plate', width, height, thickness, unit: 'mm' };
    }
  }

  if (value.holes !== undefined && value.holes !== null) {
    const holes = value.holes;
    if (!isRecord(holes)) {
      issues.push({ kind: 'invalid', code: 'INVALID_HOLES', path: 'holes', message: 'Holes must be an object.' });
    } else {
      const countValue = holes.count;
      let count: number | undefined;
      if (countValue === undefined || countValue === null) addMissing(issues, 'holes.count', 'Hole count');
      else if (typeof countValue !== 'number' || !Number.isInteger(countValue)) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_COUNT', path: 'holes.count', message: 'Hole count must be an integer.' });
      else if (countValue <= 0) issues.push({ kind: 'invalid', code: 'VALUE_MUST_BE_POSITIVE', path: 'holes.count', message: 'Hole count must be greater than zero.' });
      else count = countValue;
      const diameter = positiveNumber(holes, 'diameter', 'holes.diameter', 'Hole diameter', issues);
      const placement = holes.placement;
      let distance: number | undefined;
      let reference: 'center' | 'boundary' | undefined;
      if (placement === undefined || placement === null) {
        addMissing(issues, 'holes.placement', 'Hole placement');
      } else if (!isRecord(placement)) {
        issues.push({ kind: 'invalid', code: 'INVALID_PLACEMENT', path: 'holes.placement', message: 'Hole placement must be an object.' });
      } else {
        if (placement.type === undefined || placement.type === null) addMissing(issues, 'holes.placement.type', 'Placement type');
        else if (placement.type !== 'edge_offset') issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLACEMENT', path: 'holes.placement.type', message: `Placement type "${String(placement.type)}" is not supported.` });
        distance = positiveNumber(placement, 'distance', 'holes.placement.distance', 'Edge distance', issues);
        if (placement.reference === undefined) {
          addMissing(issues, 'holes.placement.reference', 'Distance reference');
        } else if (placement.reference === null) {
          ambiguityDistance = distance;
          issues.push({
            kind: 'ambiguous',
            code: 'AMBIGUOUS_DISTANCE_REFERENCE',
            path: 'holes.placement.reference',
            message: 'The edge distance can refer either to the hole center or to the hole boundary.',
            question: 'Worauf beziehen sich die angegebenen Abstände zur Außenkante?',
            options: [
              { id: 'A', value: 'center', label: `${distance ?? '?'} mm bis zum Bohrungsmittelpunkt` },
              { id: 'B', value: 'boundary', label: `${distance ?? '?'} mm bis zum Bohrungsrand` },
            ],
          });
        } else if (placement.reference === 'center' || placement.reference === 'boundary') {
          reference = placement.reference;
        } else {
          issues.push({ kind: 'invalid', code: 'INVALID_DISTANCE_REFERENCE', path: 'holes.placement.reference', message: 'Distance reference must be center, boundary, or null for clarification.' });
        }
      }

      if (count !== undefined && count !== 4) {
        issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_HOLE_PATTERN', path: 'holes.count', message: 'edge_offset currently supports exactly four corner holes.' });
      }
      if (width !== undefined && height !== undefined && diameter !== undefined && distance !== undefined && reference !== undefined && count === 4) {
        const radius = diameter / 2;
        const offset = reference === 'center' ? distance : distance + radius;
        const centers: Point2D[] = [
          { x: offset, y: offset }, { x: width - offset, y: offset },
          { x: offset, y: height - offset }, { x: width - offset, y: height - offset },
        ];
        const fits = centers.every((point) => point.x - radius >= 0 && point.x + radius <= width && point.y - radius >= 0 && point.y + radius <= height);
        let separated = true;
        for (let first = 0; first < centers.length; first += 1) {
          for (let second = first + 1; second < centers.length; second += 1) {
            const dx = centers[first].x - centers[second].x;
            const dy = centers[first].y - centers[second].y;
            if (Math.hypot(dx, dy) <= diameter) separated = false;
          }
        }
        if (!fits) issues.push({ kind: 'invalid', code: 'HOLE_OUTSIDE_PLATE', path: 'holes.placement', message: 'At least one hole is not completely inside the plate.' });
        if (!separated) issues.push({ kind: 'invalid', code: 'HOLES_OVERLAP', path: 'holes.placement', message: 'The calculated hole profiles overlap or touch.' });
        if (fits && separated) resolved.holes = { count, diameter, placement: { type: 'edge_offset', distance, reference }, centers };
      }
    }
  }

  for (const [operation, dimension] of [['fillet', 'radius'], ['chamfer', 'size']] as const) {
    const operationValue = value[operation];
    if (operationValue === undefined || operationValue === null) continue;
    if (!isRecord(operationValue)) {
      issues.push({ kind: 'invalid', code: `INVALID_${operation.toUpperCase()}`, path: operation, message: `${operation} must be an object.` });
      continue;
    }
    const size = positiveNumber(operationValue, dimension, `${operation}.${dimension}`, `${operation} ${dimension}`, issues);
    validateEdges(operationValue.edges, `${operation}.edges`, issues);
    if (size !== undefined && operationValue.edges !== undefined && operationValue.edges !== null) {
      resolved[operation] = { [dimension]: size, edges: operationValue.edges };
    }
  }

  const status = statusFor(issues);
  const result: CadPlanValidationResult = {
    status,
    can_execute: status === 'valid',
    issues: issues.map(({ kind: _kind, ...issue }) => issue),
  };
  if (status === 'valid') result.resolved_plan = resolved;
  if (issues.some((issue) => issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE') && ambiguityDistance !== undefined) {
    result.clarification_visual = { type: 'svg', content: ambiguitySvg(ambiguityDistance) };
  }
  return result;
}

const FEATURE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;
const BASE_FEATURE_TYPES = ['rectangular_pad', 'profile_pad'] as const;
const SUPPORTED_FEATURE_TYPES = ['rectangular_pad', 'profile_pad', 'hole_pattern', 'fillet', 'chamfer'] as const;

interface NormalizedFeaturePlan {
  source: 'legacy' | 'feature' | 'simple';
  unit: unknown;
  features: Record<string, unknown>[];
  paths: string[];
  issues: InternalIssue[];
}

type PolygonPoint = [number, number];

interface ValidatedProfile {
  points?: PolygonPoint[];
  length?: number;
  area?: number;
  issues: InternalIssue[];
}

function pointsEqual(first: PolygonPoint, second: PolygonPoint): boolean {
  return Math.abs(first[0] - second[0]) <= LINEAR_TOLERANCE_MM
    && Math.abs(first[1] - second[1]) <= LINEAR_TOLERANCE_MM;
}

function signedPolygonArea(points: PolygonPoint[]): number {
  const origin = points[0];
  let twiceArea = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const currentX = points[index][0] - origin[0];
    const currentY = points[index][1] - origin[1];
    const nextX = points[index + 1][0] - origin[0];
    const nextY = points[index + 1][1] - origin[1];
    twiceArea += currentX * nextY - nextX * currentY;
  }
  return twiceArea / 2;
}

function orientation(first: PolygonPoint, second: PolygonPoint, third: PolygonPoint): number {
  return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0]);
}

function pointOnSegment(point: PolygonPoint, start: PolygonPoint, end: PolygonPoint): boolean {
  return Math.abs(orientation(start, end, point)) <= AREA_TOLERANCE_MM2
    && point[0] >= Math.min(start[0], end[0]) - LINEAR_TOLERANCE_MM
    && point[0] <= Math.max(start[0], end[0]) + LINEAR_TOLERANCE_MM
    && point[1] >= Math.min(start[1], end[1]) - LINEAR_TOLERANCE_MM
    && point[1] <= Math.max(start[1], end[1]) + LINEAR_TOLERANCE_MM;
}

function segmentsIntersect(firstStart: PolygonPoint, firstEnd: PolygonPoint, secondStart: PolygonPoint, secondEnd: PolygonPoint): boolean {
  const firstSide = orientation(firstStart, firstEnd, secondStart);
  const secondSide = orientation(firstStart, firstEnd, secondEnd);
  const thirdSide = orientation(secondStart, secondEnd, firstStart);
  const fourthSide = orientation(secondStart, secondEnd, firstEnd);
  const opposite = (firstSide > AREA_TOLERANCE_MM2 && secondSide < -AREA_TOLERANCE_MM2) || (firstSide < -AREA_TOLERANCE_MM2 && secondSide > AREA_TOLERANCE_MM2);
  const reverseOpposite = (thirdSide > AREA_TOLERANCE_MM2 && fourthSide < -AREA_TOLERANCE_MM2) || (thirdSide < -AREA_TOLERANCE_MM2 && fourthSide > AREA_TOLERANCE_MM2);
  if (opposite && reverseOpposite) return true;
  return (Math.abs(firstSide) <= AREA_TOLERANCE_MM2 && pointOnSegment(secondStart, firstStart, firstEnd))
    || (Math.abs(secondSide) <= AREA_TOLERANCE_MM2 && pointOnSegment(secondEnd, firstStart, firstEnd))
    || (Math.abs(thirdSide) <= AREA_TOLERANCE_MM2 && pointOnSegment(firstStart, secondStart, secondEnd))
    || (Math.abs(fourthSide) <= AREA_TOLERANCE_MM2 && pointOnSegment(firstEnd, secondStart, secondEnd));
}

function validateProfilePad(feature: Record<string, unknown>, path: string): ValidatedProfile {
  const issues: InternalIssue[] = [];
  for (const key of Object.keys(feature)) {
    if (!['id', 'type', 'points', 'length', 'after', 'target'].includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_PROFILE_FIELD', path: `${path}.${key}`, message: `Unknown profile_pad field "${key}".` });
  }
  const length = positiveNumber(feature, 'length', `${path}.length`, 'Profile extrusion length', issues);
  if (!Array.isArray(feature.points)) {
    issues.push({ kind: feature.points === undefined || feature.points === null ? 'incomplete' : 'invalid', code: feature.points === undefined || feature.points === null ? 'MISSING_REQUIRED_VALUE' : 'INVALID_PROFILE_POINTS', path: `${path}.points`, message: 'profile_pad points must be an array.' });
    return { length, issues };
  }
  if (feature.points.length > 1000) {
    issues.push({ kind: 'invalid', code: 'PROFILE_TOO_MANY_POINTS', path: `${path}.points`, message: 'At most 1000 profile points are supported.' });
    return { length, issues };
  }
  const parsed: PolygonPoint[] = [];
  feature.points.forEach((point, index) => {
    if (!Array.isArray(point) || point.length !== 2 || point.some((coordinate) => typeof coordinate !== 'number' || !Number.isFinite(coordinate))) issues.push({ kind: 'invalid', code: 'INVALID_PROFILE_POINT', path: `${path}.points.${index}`, message: 'Each profile point must be exactly [x,y] with finite coordinates.' });
    else parsed.push([point[0] as number, point[1] as number]);
  });
  if (parsed.length !== feature.points.length) return { length, issues };
  if (parsed.length >= 2 && pointsEqual(parsed[0], parsed[parsed.length - 1])) parsed.pop();
  if (parsed.length < 3) {
    issues.push({ kind: 'invalid', code: 'PROFILE_TOO_FEW_POINTS', path: `${path}.points`, message: 'A profile requires at least three distinct vertices.' });
    return { length, issues };
  }
  for (let index = 0; index < parsed.length; index += 1) {
    if (pointsEqual(parsed[index], parsed[(index + 1) % parsed.length])) issues.push({ kind: 'invalid', code: 'PROFILE_DUPLICATE_POINT', path: `${path}.points.${index}`, message: 'Consecutive profile points create a zero-length segment.' });
  }
  const distinct: PolygonPoint[] = [];
  for (const point of parsed) if (!distinct.some((candidate) => pointsEqual(candidate, point))) distinct.push(point);
  if (distinct.length < 3 && !issues.some((issue) => issue.code === 'PROFILE_TOO_FEW_POINTS')) issues.push({ kind: 'invalid', code: 'PROFILE_TOO_FEW_POINTS', path: `${path}.points`, message: 'A profile requires at least three distinct vertices.' });
  const signedArea = signedPolygonArea(parsed);
  if (!Number.isFinite(signedArea)) issues.push({ kind: 'invalid', code: 'PROFILE_AREA_NOT_FINITE', path: `${path}.points`, message: 'The polygon area cannot be represented as a finite number.' });
  else if (Math.abs(signedArea) <= AREA_TOLERANCE_MM2) issues.push({ kind: 'invalid', code: 'PROFILE_ZERO_AREA', path: `${path}.points`, message: 'The polygon area is zero within geometric tolerance.' });
  for (let first = 0; first < parsed.length; first += 1) {
    const firstNext = (first + 1) % parsed.length;
    for (let second = first + 1; second < parsed.length; second += 1) {
      const secondNext = (second + 1) % parsed.length;
      if (first === second || firstNext === second || secondNext === first) continue;
      if (segmentsIntersect(parsed[first], parsed[firstNext], parsed[second], parsed[secondNext])) {
        issues.push({ kind: 'invalid', code: 'PROFILE_SELF_INTERSECTION', path: `${path}.points`, message: `Non-adjacent profile segments ${first} and ${second} intersect or overlap.` });
        first = parsed.length;
        break;
      }
    }
  }
  if (issues.length > 0 || length === undefined) return { length, issues };
  const points = signedArea < 0 ? [parsed[0], ...parsed.slice(1).reverse()] : parsed;
  return { points, length, area: Math.abs(signedArea), issues };
}

function simpleTuple(value: unknown, path: string, positive: boolean, integer: boolean, issues: InternalIssue[]): number[] | undefined {
  if (value === undefined || value === null) {
    addMissing(issues, path, path);
    return undefined;
  }
  if (!Array.isArray(value) || value.length !== 2 || value.some((item) => typeof item !== 'number' || !Number.isFinite(item) || (positive && item <= 0) || (integer && !Number.isInteger(item)))) {
    issues.push({ kind: 'invalid', code: 'INVALID_SIMPLE_ARRAY', path, message: `${path} must contain exactly two ${positive ? 'positive ' : ''}${integer ? 'integer ' : ''}finite numbers.` });
    return undefined;
  }
  return value as number[];
}

function normalizeSimplePlan(value: Record<string, unknown>): NormalizedFeaturePlan {
  const issues: InternalIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!['shape', 'size', 'profile', 'thickness', 'unit', 'holes', 'fillet', 'chamfer'].includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_SIMPLE_FIELD', path: key, message: `Unknown Simple Intent field "${key}".` });
  }
  if (value.shape === undefined || value.shape === null) addMissing(issues, 'shape', 'shape');
  else if (value.shape !== 'plate' && value.shape !== 'profile') issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_SHAPE', path: 'shape', message: `Shape "${String(value.shape)}" is not supported.` });
  const features: Record<string, unknown>[] = [];
  const paths: string[] = [];
  if (value.shape === 'profile') {
    if (value.size !== undefined) issues.push({ kind: 'invalid', code: 'CONFLICTING_BASE_DEFINITION', path: 'size', message: 'shape:"profile" uses profile and thickness, not size.' });
    features.push({ type: 'profile_pad', points: value.profile, length: value.thickness });
    paths.push('profile');
  } else {
    if (value.profile !== undefined || value.thickness !== undefined) issues.push({ kind: 'invalid', code: 'CONFLICTING_BASE_DEFINITION', path: 'profile', message: 'shape:"plate" uses size, not profile or thickness.' });
    let size: number[] | undefined;
    if (value.size === undefined || value.size === null) addMissing(issues, 'size', 'Plate size');
    else if (!Array.isArray(value.size) || value.size.length !== 3 || value.size.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) issues.push({ kind: 'invalid', code: 'INVALID_PLATE_SIZE', path: 'size', message: 'size must contain exactly three positive finite values [width,height,thickness].' });
    else size = value.size as number[];
    features.push({ type: 'rectangular_pad', width: size?.[0], height: size?.[1], length: size?.[2] });
    paths.push('shape');
  }
  if (value.holes !== undefined && value.holes !== null) {
    if (!isRecord(value.holes)) issues.push({ kind: 'invalid', code: 'INVALID_HOLES', path: 'holes', message: 'holes must be an object.' });
    else {
      const holes = value.holes;
      for (const key of Object.keys(holes)) {
        if (!['diameter', 'grid', 'start', 'spacing', 'centers', 'edge_offset', 'reference'].includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_SIMPLE_FIELD', path: `holes.${key}`, message: `Unknown Simple Intent hole field "${key}".` });
      }
      const placementKeys = ['grid', 'centers', 'edge_offset'].filter((key) => Object.hasOwn(holes, key) && holes[key] !== undefined);
      if (placementKeys.length > 1) issues.push({ kind: 'invalid', code: 'CONFLICTING_HOLE_PLACEMENT', path: 'holes', message: `Specify exactly one hole placement form, not ${placementKeys.join(' + ')}.` });
      let placement: Record<string, unknown> | undefined;
      if (placementKeys.length === 0) addMissing(issues, 'holes', 'One of holes.grid, holes.centers, or holes.edge_offset');
      else if (placementKeys.length === 1 && placementKeys[0] === 'grid') {
        const grid = simpleTuple(holes.grid, 'holes.grid', true, true, issues);
        const start = simpleTuple(holes.start, 'holes.start', false, false, issues);
        const spacing = simpleTuple(holes.spacing, 'holes.spacing', true, false, issues);
        if (grid !== undefined && start !== undefined && spacing !== undefined) placement = { type: 'rectangular_grid', columns: grid[0], rows: grid[1], origin: { x: start[0], y: start[1] }, spacing_x: spacing[0], spacing_y: spacing[1] };
      } else if (placementKeys.length === 1 && placementKeys[0] === 'centers') {
        if (!Array.isArray(holes.centers) || holes.centers.length === 0) issues.push({ kind: 'invalid', code: 'EMPTY_HOLE_CENTERS', path: 'holes.centers', message: 'centers must be a non-empty array.' });
        else {
          const centers: Point2D[] = [];
          holes.centers.forEach((center, index) => {
            if (!Array.isArray(center) || center.length !== 2 || center.some((item) => typeof item !== 'number' || !Number.isFinite(item))) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_CENTER', path: `holes.centers.${index}`, message: 'Each center must be exactly [x,y] with finite coordinates.' });
            else centers.push({ x: center[0] as number, y: center[1] as number });
          });
          if (centers.length === holes.centers.length) placement = { type: 'explicit', centers };
        }
      } else if (placementKeys.length === 1) {
        placement = { type: 'edge_offset', distance: holes.edge_offset, reference: holes.reference };
      }
      features.push({ type: 'hole_pattern', diameter: holes.diameter, placement });
      paths.push('holes');
    }
  }
  for (const [operation, allowed] of [['fillet', ['radius', 'edges']], ['chamfer', ['size', 'edges']]] as const) {
    const candidate = value[operation];
    if (candidate === undefined || candidate === null) continue;
    if (!isRecord(candidate)) issues.push({ kind: 'invalid', code: `INVALID_${operation.toUpperCase()}`, path: operation, message: `${operation} must be an object.` });
    else {
      for (const key of Object.keys(candidate)) if (!(allowed as readonly string[]).includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_SIMPLE_FIELD', path: `${operation}.${key}`, message: `Unknown ${operation} field "${key}".` });
      features.push({ type: operation, ...candidate });
      paths.push(operation);
    }
  }
  return { source: 'simple', unit: value.unit, features, paths, issues };
}

function normalizeToFeaturePlan(value: Record<string, unknown>): NormalizedFeaturePlan {
  if (Object.hasOwn(value, 'shape') || Object.hasOwn(value, 'size')) return normalizeSimplePlan(value);
  const issues: InternalIssue[] = [];
  if (Object.hasOwn(value, 'features') || Object.hasOwn(value, 'unit')) {
    for (const key of Object.keys(value)) {
      if (!['unit', 'features'].includes(key)) issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLAN_ELEMENT', path: key, message: `Plan element "${key}" is not supported in a feature plan.` });
    }
    if (!Array.isArray(value.features)) {
      issues.push({ kind: value.features === undefined || value.features === null ? 'incomplete' : 'invalid', code: value.features === undefined || value.features === null ? 'MISSING_REQUIRED_VALUE' : 'INVALID_FEATURE_LIST', path: 'features', message: 'features must be a non-empty array.' });
      return { source: 'feature', unit: value.unit, features: [], paths: [], issues };
    }
    if (value.features.length === 0) issues.push({ kind: 'incomplete', code: 'MISSING_REQUIRED_VALUE', path: 'features', message: 'At least one feature is required.' });
    const features: Record<string, unknown>[] = [];
    const paths: string[] = [];
    value.features.forEach((feature, index) => {
      if (!isRecord(feature)) issues.push({ kind: 'invalid', code: 'INVALID_FEATURE', path: `features.${index}`, message: 'Each feature must be an object.' });
      else {
        features.push(feature);
        paths.push(`features.${index}`);
      }
    });
    return { source: 'feature', unit: value.unit, features, paths, issues };
  }

  const features: Record<string, unknown>[] = [];
  const paths: string[] = [];
  for (const key of Object.keys(value)) {
    if (!['base', 'holes', 'fillet', 'chamfer'].includes(key)) issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLAN_ELEMENT', path: key, message: `Plan element "${key}" is not supported.` });
  }
  const base = value.base;
  let unit: unknown;
  for (const property of ['base', 'holes', 'fillet', 'chamfer']) {
    if (value[property] !== undefined && value[property] !== null && !isRecord(value[property])) issues.push({ kind: 'invalid', code: `INVALID_${property.toUpperCase()}`, path: property, message: `${property} must be an object.` });
  }
  if (isRecord(base)) {
    unit = base.unit;
    features.push({ id: 'base', type: base.type === 'rectangular_plate' ? 'rectangular_pad' : base.type, width: base.width, height: base.height, length: base.thickness });
    paths.push('base');
  }
  for (const [property, type] of [['holes', 'hole_pattern'], ['fillet', 'fillet'], ['chamfer', 'chamfer']] as const) {
    if (isRecord(value[property])) {
      features.push({ id: property, type, ...value[property] as Record<string, unknown> });
      paths.push(property);
    }
  }
  return { source: 'legacy', unit, features, paths, issues };
}

function translateIssuePath(path: string, normalized: NormalizedFeaturePlan): string {
  if (normalized.source === 'legacy') return path;
  if (normalized.source === 'simple') {
    if (path === 'base.unit') return 'unit';
    if (path === 'base.width' || path === 'base.height' || path === 'base.thickness') return 'size';
  }
  const mappings: Array<[string, string | undefined]> = [
    ['base', normalized.paths[normalized.features.findIndex((feature) => feature.type === 'rectangular_pad')]],
    ['holes', normalized.paths[normalized.features.findIndex((feature) => feature.type === 'hole_pattern')]],
    ['fillet', normalized.paths[normalized.features.findIndex((feature) => feature.type === 'fillet')]],
    ['chamfer', normalized.paths[normalized.features.findIndex((feature) => feature.type === 'chamfer')]],
  ];
  for (const [legacy, featurePath] of mappings) {
    if (featurePath !== undefined && (path === legacy || path.startsWith(`${legacy}.`))) return featurePath + path.slice(legacy.length);
  }
  return path === 'base.unit' ? 'unit' : path;
}

interface HoleResolution {
  diameter?: number;
  centers?: Point2D[];
  issues: InternalIssue[];
  ambiguityDistance?: number;
}

function resolveHolePattern(feature: Record<string, unknown>, path: string, width: unknown, height: unknown): HoleResolution {
  const issues: InternalIssue[] = [];
  const diameter = positiveNumber(feature, 'diameter', `${path}.diameter`, 'Hole diameter', issues);
  const countValue = feature.count;
  let requestedCount: number | undefined;
  if (countValue !== undefined && countValue !== null) {
    if (typeof countValue !== 'number' || !Number.isInteger(countValue) || countValue <= 0) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_COUNT', path: `${path}.count`, message: 'Optional count must be a positive integer.' });
    else requestedCount = countValue;
  }
  const placement = feature.placement;
  let centers: Point2D[] | undefined;
  let ambiguityDistance: number | undefined;
  if (placement === undefined || placement === null) addMissing(issues, `${path}.placement`, 'Hole placement');
  else if (!isRecord(placement)) issues.push({ kind: 'invalid', code: 'INVALID_PLACEMENT', path: `${path}.placement`, message: 'Hole placement must be an object.' });
  else if (placement.type === 'edge_offset') {
    const distance = positiveNumber(placement, 'distance', `${path}.placement.distance`, 'Edge distance', issues);
    let reference: 'center' | 'boundary' | undefined;
    if (placement.reference === undefined) addMissing(issues, `${path}.placement.reference`, 'Distance reference');
    else if (placement.reference === null) {
      ambiguityDistance = distance;
      issues.push({ kind: 'ambiguous', code: 'AMBIGUOUS_DISTANCE_REFERENCE', path: `${path}.placement.reference`, message: 'The edge distance can refer either to the hole center or to the hole boundary.', question: 'Worauf beziehen sich die angegebenen Abstände zur Außenkante?', options: [{ id: 'A', value: 'center', label: `${distance ?? '?'} mm bis zum Bohrungsmittelpunkt` }, { id: 'B', value: 'boundary', label: `${distance ?? '?'} mm bis zum Bohrungsrand` }] });
    } else if (placement.reference === 'center' || placement.reference === 'boundary') reference = placement.reference;
    else issues.push({ kind: 'invalid', code: 'INVALID_DISTANCE_REFERENCE', path: `${path}.placement.reference`, message: 'Distance reference must be center, boundary, or null.' });
    if (typeof width === 'number' && typeof height === 'number' && diameter !== undefined && distance !== undefined && reference !== undefined) {
      const offset = reference === 'center' ? distance : distance + diameter / 2;
      centers = [{ x: offset, y: offset }, { x: width - offset, y: offset }, { x: offset, y: height - offset }, { x: width - offset, y: height - offset }];
    }
  } else if (placement.type === 'explicit') {
    if (!Array.isArray(placement.centers) || placement.centers.length === 0) issues.push({ kind: placement.centers === undefined || placement.centers === null ? 'incomplete' : 'invalid', code: placement.centers === undefined || placement.centers === null ? 'MISSING_REQUIRED_VALUE' : 'EMPTY_HOLE_CENTERS', path: `${path}.placement.centers`, message: 'explicit placement requires a non-empty centers array.' });
    else if (placement.centers.length > 1000) issues.push({ kind: 'invalid', code: 'TOO_MANY_HOLES', path: `${path}.placement.centers`, message: 'At most 1000 hole centers are supported.' });
    else {
      const parsed: Point2D[] = [];
      placement.centers.forEach((center, index) => {
        if (!isRecord(center) || typeof center.x !== 'number' || !Number.isFinite(center.x) || typeof center.y !== 'number' || !Number.isFinite(center.y)) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_CENTER', path: `${path}.placement.centers.${index}`, message: 'Each center requires finite x and y coordinates.' });
        else parsed.push({ x: center.x, y: center.y });
      });
      if (parsed.length === placement.centers.length) centers = parsed;
    }
  } else if (placement.type === 'rectangular_grid') {
    let origin: Point2D | undefined;
    if (!isRecord(placement.origin) || typeof placement.origin.x !== 'number' || !Number.isFinite(placement.origin.x) || typeof placement.origin.y !== 'number' || !Number.isFinite(placement.origin.y)) issues.push({ kind: placement.origin === undefined || placement.origin === null ? 'incomplete' : 'invalid', code: placement.origin === undefined || placement.origin === null ? 'MISSING_REQUIRED_VALUE' : 'INVALID_GRID_ORIGIN', path: `${path}.placement.origin`, message: 'Grid origin requires finite x and y coordinates.' });
    else origin = { x: placement.origin.x, y: placement.origin.y };
    const positiveInteger = (key: 'columns' | 'rows'): number | undefined => {
      const value = placement[key];
      if (value === undefined || value === null) { addMissing(issues, `${path}.placement.${key}`, key); return undefined; }
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) { issues.push({ kind: 'invalid', code: 'INVALID_GRID_COUNT', path: `${path}.placement.${key}`, message: `${key} must be a positive integer.` }); return undefined; }
      return value;
    };
    const columns = positiveInteger('columns');
    const rows = positiveInteger('rows');
    const spacingX = positiveNumber(placement, 'spacing_x', `${path}.placement.spacing_x`, 'Grid X spacing', issues);
    const spacingY = positiveNumber(placement, 'spacing_y', `${path}.placement.spacing_y`, 'Grid Y spacing', issues);
    if (origin !== undefined && columns !== undefined && rows !== undefined && spacingX !== undefined && spacingY !== undefined) {
      if (columns * rows > 1000) issues.push({ kind: 'invalid', code: 'TOO_MANY_HOLES', path: `${path}.placement`, message: 'At most 1000 grid holes are supported.' });
      else {
        centers = [];
        for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) centers.push({ x: origin.x + column * spacingX, y: origin.y + row * spacingY });
      }
    }
  } else if (placement.type === undefined || placement.type === null) addMissing(issues, `${path}.placement.type`, 'Placement type');
  else issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLACEMENT', path: `${path}.placement.type`, message: `Placement type "${String(placement.type)}" is not supported.` });

  if (centers !== undefined && requestedCount !== undefined && requestedCount !== centers.length) issues.push({ kind: 'invalid', code: 'HOLE_COUNT_MISMATCH', path: `${path}.count`, message: `count ${requestedCount} does not match ${centers.length} resolved centers.` });
  if (centers !== undefined && diameter !== undefined && typeof width === 'number' && typeof height === 'number') {
    const radius = diameter / 2;
    if (!centers.every((center) => radius <= center.x && center.x <= width - radius && radius <= center.y && center.y <= height - radius)) issues.push({ kind: 'invalid', code: 'HOLE_OUTSIDE_BASE', path: `${path}.placement`, message: 'At least one hole is not completely inside the rectangular base.' });
    for (let first = 0; first < centers.length; first += 1) for (let second = first + 1; second < centers.length; second += 1) {
      if (Math.hypot(centers[first].x - centers[second].x, centers[first].y - centers[second].y) <= diameter) {
        issues.push({ kind: 'invalid', code: 'HOLES_OVERLAP', path: `${path}.placement`, message: 'Hole profiles overlap or touch.' });
        first = centers.length;
        break;
      }
    }
  }
  return { diameter, centers, issues, ambiguityDistance };
}

export function validateCadPlan(value: unknown): CadPlanValidationResult {
  if (!isRecord(value)) return validateLegacyCadPlan(value);
  const normalized = normalizeToFeaturePlan(value);
  const structuralIssues = normalized.issues;
  const generatedTypeCounts = new Map<string, number>();
  normalized.features = normalized.features.map((feature) => {
    const copy = { ...feature };
    const type = typeof copy.type === 'string' ? copy.type : undefined;
    if (type !== undefined && (SUPPORTED_FEATURE_TYPES as readonly string[]).includes(type)) {
      const count = (generatedTypeCounts.get(type) ?? 0) + 1;
      generatedTypeCounts.set(type, count);
      if (copy.id === undefined || copy.id === null || copy.id === '') {
        const baseId = (BASE_FEATURE_TYPES as readonly string[]).includes(type) ? 'base' : type === 'hole_pattern' ? 'holes' : type;
        copy.id = count === 1 ? baseId : `${baseId}_${count}`;
      }
    }
    return copy;
  });
  let previousSolidId: string | undefined;
  normalized.features = normalized.features.map((feature) => {
    const copy = { ...feature };
    const supported = typeof copy.type === 'string' && (SUPPORTED_FEATURE_TYPES as readonly string[]).includes(copy.type);
    if (supported && previousSolidId !== undefined && (copy.after === undefined || copy.after === null) && (copy.target === undefined || copy.target === null)) copy.after = previousSolidId;
    if (supported && typeof copy.id === 'string' && FEATURE_ID.test(copy.id)) previousSolidId = copy.id;
    return copy;
  });
  const seenIds = new Set<string>();
  const earlierIds = new Set<string>();
  const seenTypes = new Set<string>();
  let solidAvailable = false;

  normalized.features.forEach((feature, index) => {
    const path = normalized.paths[index];
    const id = feature.id;
    if (id === undefined || id === null || id === '') structuralIssues.push({ kind: 'incomplete', code: 'MISSING_REQUIRED_VALUE', path: `${path}.id`, message: 'Feature ID could not be derived without a supported feature type.' });
    else if (typeof id !== 'string' || !FEATURE_ID.test(id) || id.length > 128) structuralIssues.push({ kind: 'invalid', code: 'INVALID_FEATURE_ID', path: `${path}.id`, message: 'Feature ID must use letters, digits, and underscores and start with a letter or underscore.' });
    else {
      if (seenIds.has(id)) structuralIssues.push({ kind: 'invalid', code: 'DUPLICATE_FEATURE_ID', path: `${path}.id`, message: `Feature ID "${id}" occurs more than once.` });
      seenIds.add(id);
    }
    for (const dependency of ['after', 'target'] as const) {
      if (feature[dependency] !== undefined && feature[dependency] !== null && (typeof feature[dependency] !== 'string' || !earlierIds.has(feature[dependency] as string))) {
        structuralIssues.push({ kind: 'invalid', code: 'INVALID_FEATURE_REFERENCE', path: `${path}.${dependency}`, message: `${dependency} must reference an earlier feature ID.` });
      }
    }
    const type = feature.type;
    if (type === undefined || type === null) structuralIssues.push({ kind: 'incomplete', code: 'MISSING_REQUIRED_VALUE', path: `${path}.type`, message: 'Feature type is required.' });
    else if (!(SUPPORTED_FEATURE_TYPES as readonly string[]).includes(String(type))) structuralIssues.push({ kind: 'unsupported', code: 'UNSUPPORTED_FEATURE_TYPE', path: `${path}.type`, message: `Feature type "${String(type)}" is not supported.` });
    else {
      if (seenTypes.has(String(type))) structuralIssues.push({ kind: 'invalid', code: 'DUPLICATE_FEATURE_TYPE', path: `${path}.type`, message: `Only one ${String(type)} feature is currently supported.` });
      seenTypes.add(String(type));
      if ((BASE_FEATURE_TYPES as readonly string[]).includes(String(type))) {
        if (index !== 0 || solidAvailable) structuralIssues.push({ kind: 'invalid', code: 'INVALID_FEATURE_ORDER', path, message: `${String(type)} must be the first and only base feature.` });
        solidAvailable = true;
      } else if (!solidAvailable) structuralIssues.push({ kind: 'invalid', code: 'INVALID_FEATURE_ORDER', path, message: `${String(type)} requires an earlier base solid.` });
    }
    if (typeof id === 'string' && FEATURE_ID.test(id)) earlierIds.add(id);
  });
  if (normalized.features.length > 0 && !(BASE_FEATURE_TYPES as readonly unknown[]).includes(normalized.features[0].type) && !structuralIssues.some((issue) => issue.code === 'INVALID_FEATURE_ORDER')) {
    structuralIssues.push({ kind: 'invalid', code: 'INVALID_FEATURE_ORDER', path: normalized.paths[0], message: 'The first feature must be rectangular_pad or profile_pad.' });
  }

  const profileFeature = normalized.features.find((feature) => feature.type === 'profile_pad');
  if (profileFeature !== undefined) {
    normalized.features.forEach((feature, index) => {
      if (feature === profileFeature) return;
      const code = feature.type === 'hole_pattern' ? 'PROFILE_PAD_HOLE_PATTERN_UNSUPPORTED' : 'PROFILE_PAD_FINISHING_UNSUPPORTED';
      structuralIssues.push({ kind: 'unsupported', code, path: normalized.paths[index], message: `${String(feature.type)} is not yet supported after profile_pad.` });
    });
    const profileIndex = normalized.features.indexOf(profileFeature);
    const profilePath = normalized.paths[profileIndex];
    const profileValidation = validateProfilePad(profileFeature, profilePath);
    structuralIssues.push(...profileValidation.issues.map((issue) => {
      if (normalized.source !== 'simple') return issue;
      if (issue.path === `${profilePath}.points`) return { ...issue, path: 'profile' };
      if (issue.path.startsWith(`${profilePath}.points.`)) return { ...issue, path: `profile${issue.path.slice(`${profilePath}.points`.length)}` };
      if (issue.path === `${profilePath}.length`) return { ...issue, path: 'thickness' };
      return issue;
    }));
    if (normalized.unit === undefined || normalized.unit === null || normalized.unit === '') addMissing(structuralIssues, 'unit', 'Unit');
    else if (typeof normalized.unit !== 'string') structuralIssues.push({ kind: 'invalid', code: 'INVALID_UNIT', path: 'unit', message: 'Unit must be a string.' });
    else if (normalized.unit !== 'mm') structuralIssues.push({ kind: 'unsupported', code: 'UNSUPPORTED_UNIT', path: 'unit', message: `Unit "${normalized.unit}" is not supported; use mm.` });
    if (structuralIssues.length > 0 || profileValidation.points === undefined || profileValidation.length === undefined) {
      const status = statusFor(structuralIssues);
      return { status, can_execute: false, issues: structuralIssues.map(({ kind: _kind, ...issue }) => issue) };
    }
    return {
      status: 'valid',
      can_execute: true,
      issues: [],
      resolved_plan: { unit: 'mm', features: [{ id: profileFeature.id, type: 'profile_pad', points: profileValidation.points, length: profileValidation.length }] },
    };
  }

  if (structuralIssues.length > 0) {
    const status = statusFor(structuralIssues);
    return { status, can_execute: false, issues: structuralIssues.map(({ kind: _kind, ...issue }) => issue) };
  }

  const baseFeature = normalized.features.find((feature) => feature.type === 'rectangular_pad');
  const holeFeature = normalized.features.find((feature) => feature.type === 'hole_pattern');
  const filletFeature = normalized.features.find((feature) => feature.type === 'fillet');
  const chamferFeature = normalized.features.find((feature) => feature.type === 'chamfer');
  const holePath = holeFeature === undefined ? undefined : normalized.paths[normalized.features.indexOf(holeFeature)];
  const holeResolution = holeFeature === undefined || holePath === undefined
    ? undefined
    : resolveHolePattern(holeFeature, holePath, baseFeature?.width, baseFeature?.height);
  const legacyPlan: Record<string, unknown> = {
    base: baseFeature === undefined ? undefined : { type: 'rectangular_plate', width: baseFeature.width, height: baseFeature.height, thickness: baseFeature.length, unit: normalized.unit },
  };
  if (filletFeature !== undefined) legacyPlan.fillet = { radius: filletFeature.radius, edges: filletFeature.edges };
  if (chamferFeature !== undefined) legacyPlan.chamfer = { size: chamferFeature.size, edges: chamferFeature.edges };
  const validated = validateLegacyCadPlan(legacyPlan);
  validated.issues = validated.issues.map((issue) => ({ ...issue, path: translateIssuePath(issue.path, normalized) }));
  if (holeResolution !== undefined) validated.issues.push(...holeResolution.issues.map(({ kind: _kind, ...issue }) => issue));
  const combinedInternalIssues: InternalIssue[] = [
    ...validated.issues.map((issue) => ({ ...issue, kind: issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE' ? 'ambiguous' as const : issue.code === 'MISSING_REQUIRED_VALUE' ? 'incomplete' as const : issue.code.startsWith('UNSUPPORTED_') ? 'unsupported' as const : 'invalid' as const })),
  ];
  validated.status = statusFor(combinedInternalIssues);
  validated.can_execute = validated.status === 'valid';
  if (validated.status !== 'valid' || validated.resolved_plan === undefined || (holeFeature !== undefined && (holeResolution?.centers === undefined || holeResolution.diameter === undefined))) {
    delete validated.resolved_plan;
    if (holeResolution?.ambiguityDistance !== undefined) validated.clarification_visual = { type: 'svg', content: ambiguitySvg(holeResolution.ambiguityDistance) };
    return validated;
  }

  const legacyResolved = validated.resolved_plan;
  const resolvedFeatures = normalized.features.map((feature) => {
    const dependencies: Record<string, unknown> = {};
    if (typeof feature.after === 'string') dependencies.after = feature.after;
    if (typeof feature.target === 'string') dependencies.target = feature.target;
    if (feature.type === 'rectangular_pad') {
      const resolvedBase = legacyResolved.base as Record<string, unknown>;
      return { id: feature.id, type: 'rectangular_pad', width: resolvedBase.width, height: resolvedBase.height, length: resolvedBase.thickness, ...dependencies };
    }
    if (feature.type === 'hole_pattern') {
      return { id: feature.id, type: 'hole_pattern', diameter: holeResolution!.diameter, centers: holeResolution!.centers, operation: 'through_all', ...dependencies };
    }
    const dimension = feature.type === 'fillet' ? 'radius' : 'size';
    const resolvedOperation = legacyResolved[String(feature.type)] as Record<string, unknown>;
    return { id: feature.id, type: feature.type, [dimension]: resolvedOperation[dimension], edges: resolvedOperation.edges, ...dependencies };
  });
  validated.resolved_plan = { unit: 'mm', features: resolvedFeatures };
  return validated;
}

export function validateCadPlanArgs(args: ToolArgs): CadPlanValidationResult {
  const unexpected = Object.keys(args).filter((key) => key !== 'plan');
  if (unexpected.length > 0) throw new Error(`Unexpected argument(s): ${unexpected.join(', ')}`);
  return validateCadPlan(args.plan);
}

export function cadPlanValidationToolResult(result: CadPlanValidationResult): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

export function cadPlanNotValidatedToolResult(): ToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        success: false,
        code: 'CAD_PLAN_NOT_VALIDATED',
        message: 'CAD construction is blocked until cad_validate_plan returns status=valid and can_execute=true.',
      }),
    }],
    isError: true,
  };
}
