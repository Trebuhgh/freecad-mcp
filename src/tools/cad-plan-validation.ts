import { ToolArgs, ToolResult } from '../types.js';

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
  description: 'Mandatory, non-mutating gate before CAD construction. Validates a structured plan deterministically. holes.placement.type supports only "edge_offset". holes.placement.reference supports "center", "boundary", or null. Use null when wording such as "10 mm from the outer edges" does not explicitly identify center versus hole boundary; this tool never interprets that ambiguity.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      plan: {
        type: 'object',
        description: 'Typed plan containing a rectangular_plate base and optional holes, fillet, and chamfer operations. Geometrically relevant values have no implicit defaults.',
        properties: {
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
              placement: {
                type: ['object', 'null'],
                description: 'Required hole placement. Only edge_offset is currently supported.',
                properties: {
                  type: { type: ['string', 'null'], enum: ['edge_offset', null], description: 'Placement strategy; currently only edge_offset.' },
                  distance: { type: ['number', 'null'] },
                  reference: { type: ['string', 'null'], enum: ['center', 'boundary', null], description: 'center means distance to hole center; boundary means distance to hole rim; use null whenever the user did not explicitly disambiguate.' },
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
  description: 'Execute exactly the resolved plan stored by the latest successful cad_validate_plan call. Accepts no dimensions, positions, or other geometric overrides.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      documentName: { type: 'string', description: 'Optional non-geometric FreeCAD document name.' },
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

export function validateCadPlan(value: unknown): CadPlanValidationResult {
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
