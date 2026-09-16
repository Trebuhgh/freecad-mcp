import { ToolArgs, ToolResult } from '../types.js';
import { AREA_TOLERANCE_MM2, LINEAR_TOLERANCE_MM, VOLUME_TOLERANCE_MM3 } from './cad-geometry-tolerances.js';
import { CanonicalProfileSegment, validateProfileSegments } from './cad-profile-geometry.js';

type PlanStatus = 'valid' | 'incomplete' | 'ambiguous' | 'unsupported' | 'invalid';
type IssueKind = Exclude<PlanStatus, 'valid'>;

interface PlanIssue {
  code: string;
  path: string;
  message: string;
  details?: Record<string, unknown>;
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

const coordinatePairSchema = {
  type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' },
};

const profileSegmentSchema = {
  oneOf: [{
    title: 'Line segment', type: 'object',
    properties: { type: { const: 'line' }, start: coordinatePairSchema, end: coordinatePairSchema },
    required: ['type', 'start', 'end'], additionalProperties: false,
  }, {
    title: 'Circular arc segment', type: 'object',
    properties: {
      type: { const: 'arc' }, start: coordinatePairSchema, end: coordinatePairSchema,
      center: coordinatePairSchema, direction: { type: 'string', enum: ['cw', 'ccw'] },
    },
    required: ['type', 'start', 'end', 'center', 'direction'], additionalProperties: false,
  }],
};

const simpleHolesSchema = {
  type: ['object', 'null'],
  description: 'Simple holes. For explicit holes use only {diameter,centers}; count is derived and operation is through_all. Never use placement, count, after, target, or operation here.',
  properties: {
    diameter: { type: ['number', 'null'], exclusiveMinimum: 0 },
    centers: { type: ['array', 'null'], minItems: 1, items: coordinatePairSchema, description: 'Explicit centers as [[x,y],...]. Use this directly; do not wrap it in placement.' },
    grid: { type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'integer', minimum: 1 }, description: 'Grid [columns,rows].' },
    start: { ...coordinatePairSchema, type: ['array', 'null'], description: 'Grid origin [x,y]. Required with grid.' },
    spacing: { ...coordinatePairSchema, type: ['array', 'null'], description: 'Positive grid spacing [x,y]. Required with grid.' },
    edge_offset: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'Four-corner edge distance.' },
    reference: { type: ['string', 'null'], enum: ['center', 'boundary', null], description: 'Only for edge_offset. Use null unless the user explicitly says center or hole boundary.' },
  },
  additionalProperties: false,
};

const simpleHoleGroupSchema = {
  type: 'object',
  description: 'One semantically named hole group. Uses the same placement forms as holes.',
  properties: {
    id: { type: ['string', 'null'], description: 'Required stable semantic feature ID.' },
    ...simpleHolesSchema.properties,
  },
  required: ['id'],
  additionalProperties: false,
};

const simplePlanSchema = {
  title: 'Preferred Simple Intent Plan',
  type: 'object',
  description: 'PREFERRED LLM FORMAT. Do not mix with base, features, placement, count, after, target, or operation. Include only geometry explicitly requested by the user.',
  properties: {
    shape: { type: ['string', 'null'], enum: ['plate', 'profile', null], description: 'Required discriminator: plate or profile.' },
    size: { type: ['array', 'null'], minItems: 3, maxItems: 3, items: { type: 'number' }, description: 'For shape:"plate": [width,height,thickness] in mm.' },
    profile: { type: ['array', 'null'], minItems: 3, items: coordinatePairSchema, description: 'For shape:"profile": polygon vertices [[x,y],...]; closure is automatic.' },
    segments: { type: ['array', 'null'], minItems: 1, items: profileSegmentSchema, description: 'For a mixed line/arc profile. Incomplete segment chains are accepted for non-mutating validation, but execution requires one explicitly closed outer contour. Never combine with profile and never invent closing segments.' },
    thickness: { type: ['number', 'null'], exclusiveMinimum: 0, description: 'For shape:"profile": extrusion length in +Z.' },
    unit: { type: ['string', 'null'], enum: ['mm', null], description: 'Currently mm.' },
    holes: simpleHolesSchema,
    hole_groups: { type: ['array', 'null'], minItems: 1, items: simpleHoleGroupSchema, description: 'Named independent hole_pattern features. Do not combine with holes.' },
    fillet: { type: ['object', 'null'], properties: { radius: { type: ['number', 'null'], exclusiveMinimum: 0 }, edges: { type: ['string', 'object', 'null'] } }, additionalProperties: false, description: 'Include only when the user explicitly requests a fillet.' },
    chamfer: { type: ['object', 'null'], properties: { size: { type: ['number', 'null'], exclusiveMinimum: 0 }, edges: { type: ['string', 'object', 'null'] } }, additionalProperties: false, description: 'Include only when the user explicitly requests a chamfer.' },
  },
  required: ['shape'],
  additionalProperties: false,
  examples: [
    { shape: 'plate', size: [100, 60, 10], unit: 'mm' },
    { shape: 'profile', profile: [[0, 0], [100, 0], [100, 40], [0, 40]], thickness: 10, unit: 'mm' },
    { shape: 'profile', profile: [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]], thickness: 10, unit: 'mm', holes: { diameter: 6, centers: [[20, 20], [40, 60], [80, 20]] } },
    { shape: 'plate', size: [100, 60, 10], unit: 'mm', holes: { diameter: 6, grid: [3, 2], start: [20, 15], spacing: [30, 20] } },
    { shape: 'profile', profile: [[0, 0], [100, 0], [100, 40], [60, 40], [60, 80], [0, 80]], thickness: 10, unit: 'mm', holes: { diameter: 6, grid: [2, 2], start: [20, 20], spacing: [30, 30] } },
    { shape: 'profile', segments: [{ type: 'line', start: [0, 0], end: [80, 0] }, { type: 'arc', start: [80, 0], end: [80, 40], center: [80, 20], direction: 'ccw' }, { type: 'line', start: [80, 40], end: [0, 40] }, { type: 'line', start: [0, 40], end: [0, 0] }], thickness: 10, unit: 'mm' },
  ],
};

const featureIdSchema = { type: ['string', 'null'] };
const featureDependencySchema = {
  after: { type: ['string', 'null'] },
  target: { type: ['string', 'null'] },
};
const rectangularPadFeatureSchema = {
  title: 'Rectangular pad feature', type: 'object',
  properties: {
    id: featureIdSchema, type: { const: 'rectangular_pad' },
    width: { type: 'number' }, height: { type: 'number' }, length: { type: 'number' },
  },
  required: ['type', 'width', 'height', 'length'], additionalProperties: false,
};
const polygonProfilePadFeatureSchema = {
  title: 'Polygon profile pad feature', type: 'object',
  properties: { id: featureIdSchema, type: { const: 'profile_pad' }, points: { type: 'array', minItems: 3, items: coordinatePairSchema }, length: { type: 'number' } },
  required: ['type', 'points', 'length'], additionalProperties: false,
};
const segmentedProfilePadFeatureSchema = {
  title: 'Mixed line/arc profile pad feature', type: 'object',
  properties: { id: featureIdSchema, type: { const: 'profile_pad' }, segments: { type: 'array', minItems: 1, items: profileSegmentSchema }, length: { type: 'number' } },
  required: ['type', 'segments', 'length'], additionalProperties: false,
};
const rectangularPocketFeatureSchema = {
  title: 'Semantic rectangular pocket feature', type: 'object',
  properties: {
    id: featureIdSchema, type: { const: 'rectangular_pocket' },
    face: { type: 'string', enum: ['top', 'front', 'back', 'left', 'right'] },
    width: { type: 'number' }, height: { type: 'number' }, depth: { type: 'number' },
    position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
    after: { type: 'string' }, target: { type: 'string' },
  },
  required: ['type', 'face', 'width', 'height', 'depth', 'position', 'after', 'target'], additionalProperties: false,
};
const rectangularAdditionFeatureSchema = {
  title: 'Semantic rectangular additive feature', type: 'object',
  properties: {
    id: featureIdSchema, type: { const: 'rectangular_addition' },
    face: { type: 'string', enum: ['top', 'front', 'back', 'left', 'right'] },
    width: { type: 'number' }, height: { type: 'number' }, length: { type: 'number' },
    position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
    after: { type: 'string' }, target: { type: 'string' },
  },
  required: ['type', 'face', 'width', 'height', 'length', 'position', 'after', 'target'], additionalProperties: false,
};
const holePatternFeatureSchema = {
  title: 'Hole pattern feature', type: 'object',
  properties: {
    id: featureIdSchema, type: { const: 'hole_pattern' }, diameter: { type: 'number' }, count: { type: ['integer', 'null'] },
    placement: {
      type: 'object',
      properties: {
        type: { type: ['string', 'null'], enum: ['edge_offset', 'explicit', 'rectangular_grid', null] },
        distance: { type: ['number', 'null'] }, reference: { type: ['string', 'null'], enum: ['center', 'boundary', null] },
        centers: { type: ['array', 'null'], items: { oneOf: [coordinatePairSchema, { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false }] } },
        origin: { type: ['object', 'null'], properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], additionalProperties: false },
        columns: { type: ['integer', 'null'] }, rows: { type: ['integer', 'null'] }, spacing_x: { type: ['number', 'null'] }, spacing_y: { type: ['number', 'null'] },
      },
      additionalProperties: false,
    },
    ...featureDependencySchema,
    operation: { type: ['string', 'null'], enum: ['through_all', null] },
  },
  required: ['type', 'diameter', 'placement'], additionalProperties: false,
};
const filletFeatureSchema = {
  title: 'Fillet feature', type: 'object',
  properties: { id: featureIdSchema, type: { const: 'fillet' }, radius: { type: 'number' }, edges: { type: 'string', enum: ['all_vertical', 'all_top', 'all_bottom', 'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner'] }, ...featureDependencySchema },
  required: ['type', 'radius', 'edges'], additionalProperties: false,
};
const chamferFeatureSchema = {
  title: 'Chamfer feature', type: 'object',
  properties: { id: featureIdSchema, type: { const: 'chamfer' }, size: { type: 'number' }, edges: { type: 'string', enum: ['all_vertical', 'all_top', 'all_bottom', 'all_top_outer', 'all_top_inner', 'all_bottom_outer', 'all_bottom_inner'] }, ...featureDependencySchema },
  required: ['type', 'size', 'edges'], additionalProperties: false,
};

export const CAD_CONSTRUCTION_FEATURE_SCHEMAS = [
  rectangularPadFeatureSchema,
  polygonProfilePadFeatureSchema,
  segmentedProfilePadFeatureSchema,
  rectangularPocketFeatureSchema,
  rectangularAdditionFeatureSchema,
  holePatternFeatureSchema,
  filletFeatureSchema,
  chamferFeatureSchema,
] as const;

const featurePlanSchema = {
  title: 'Advanced Feature Plan (compatibility)',
  type: 'object',
  description: 'Advanced compatibility format. Use only when Simple Intent cannot represent the request; never mix with Simple Intent or Legacy fields.',
  properties: {
    unit: { type: ['string', 'null'], enum: ['mm', null] },
    features: {
      type: 'array', minItems: 1,
      items: {
        oneOf: CAD_CONSTRUCTION_FEATURE_SCHEMAS,
      },
    },
  },
  required: ['features'],
  additionalProperties: false,
};

const legacyPlanSchema = {
  title: 'Legacy Plan (compatibility)',
  type: 'object',
  description: 'Legacy compatibility format. New LLM calls should use Simple Intent.',
  properties: {
    base: { type: 'object', properties: { type: { type: ['string', 'null'] }, width: { type: ['number', 'null'] }, height: { type: ['number', 'null'] }, thickness: { type: ['number', 'null'] }, unit: { type: ['string', 'null'] } }, additionalProperties: false },
    holes: { type: ['object', 'null'], additionalProperties: true },
    fillet: { type: ['object', 'null'], additionalProperties: true },
    chamfer: { type: ['object', 'null'], additionalProperties: true },
  },
  required: ['base'],
  additionalProperties: false,
};

export const CAD_PLAN_TOOLS = [{
  name: 'cad_validate_plan',
  description: 'Mandatory non-mutating validation gate. ALWAYS use Preferred Simple Intent when possible. Do not mix formats. Polygon profile: {shape:"profile",profile:[[x,y],...],thickness:10,unit:"mm"}. Mixed profile example: {shape:"profile",segments:[{type:"line",start:[0,0],end:[80,0]},{type:"arc",start:[80,0],end:[80,40],center:[80,20],direction:"ccw"},{type:"line",start:[80,40],end:[0,40]},{type:"line",start:[0,40],end:[0,0]}],thickness:10,unit:"mm"}. Never combine profile and segments. Only include features explicitly requested by the user. Compatibility Feature/Legacy formats remain accepted.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      plan: {
        description: 'Choose exactly one format. The first oneOf branch is the preferred Simple Intent format for LLM calls.',
        oneOf: [simplePlanSchema, featurePlanSchema, legacyPlanSchema],
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
const SUPPORTED_FEATURE_TYPES = ['rectangular_pad', 'profile_pad', 'rectangular_pocket', 'rectangular_addition', 'hole_pattern', 'fillet', 'chamfer'] as const;

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
  segments?: CanonicalProfileSegment[];
  length?: number;
  area?: number;
  bounds?: { minX: number; minY: number; maxX: number; maxY: number };
  lineCount?: number;
  arcCount?: number;
  arcRadii?: number[];
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
    if (!['id', 'type', 'points', 'segments', 'length', 'after', 'target'].includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_PROFILE_FIELD', path: `${path}.${key}`, message: `Unknown profile_pad field "${key}".` });
  }
  const length = positiveNumber(feature, 'length', `${path}.length`, 'Profile extrusion length', issues);
  const hasPoints = feature.points !== undefined && feature.points !== null;
  const hasSegments = feature.segments !== undefined && feature.segments !== null;
  if (hasPoints && hasSegments) {
    issues.push({ kind: 'invalid', code: 'MIXED_PROFILE_REPRESENTATION', path, message: 'Use either points or segments for profile_pad, never both.' });
    return { length, issues };
  }
  if (hasSegments) {
    const validated = validateProfileSegments(feature.segments, `${path}.segments`);
    issues.push(...validated.issues.map((issue) => ({
      ...issue,
      kind: issue.code === 'PROFILE_NOT_CLOSED'
        ? 'ambiguous' as const
        : issue.code.startsWith('UNSUPPORTED_') ? 'unsupported' as const : 'invalid' as const,
    })));
    return {
      segments: validated.segments, length, area: validated.area, bounds: validated.bounds,
      lineCount: validated.lineCount, arcCount: validated.arcCount, arcRadii: validated.arcRadii, issues,
    };
  }
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
  return {
    points, length, area: Math.abs(signedArea),
    bounds: { minX: Math.min(...points.map((point) => point[0])), minY: Math.min(...points.map((point) => point[1])), maxX: Math.max(...points.map((point) => point[0])), maxY: Math.max(...points.map((point) => point[1])) },
    lineCount: points.length, arcCount: 0, arcRadii: [], issues,
  };
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

function appendSimpleHoleFeature(
  holes: Record<string, unknown>, path: string, requireId: boolean,
  features: Record<string, unknown>[], paths: string[], issues: InternalIssue[],
): void {
  const allowed = ['diameter', 'grid', 'start', 'spacing', 'centers', 'edge_offset', 'reference', ...(requireId ? ['id'] : [])];
  for (const key of Object.keys(holes)) {
    if (!allowed.includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_SIMPLE_FIELD', path: `${path}.${key}`, message: `Unknown Simple Intent hole field "${key}".` });
  }
  if (requireId && (holes.id === undefined || holes.id === null || holes.id === '')) addMissing(issues, `${path}.id`, 'Hole group ID');
  const placementKeys = ['grid', 'centers', 'edge_offset'].filter((key) => Object.hasOwn(holes, key) && holes[key] !== undefined);
  if (placementKeys.length > 1) issues.push({ kind: 'invalid', code: 'CONFLICTING_HOLE_PLACEMENT', path, message: `Specify exactly one hole placement form, not ${placementKeys.join(' + ')}.` });
  let placement: Record<string, unknown> | undefined;
  if (placementKeys.length === 0) addMissing(issues, path, `One of ${path}.grid, ${path}.centers, or ${path}.edge_offset`);
  else if (placementKeys.length === 1 && placementKeys[0] === 'grid') {
    const grid = simpleTuple(holes.grid, `${path}.grid`, true, true, issues);
    const start = simpleTuple(holes.start, `${path}.start`, false, false, issues);
    const spacing = simpleTuple(holes.spacing, `${path}.spacing`, true, false, issues);
    if (grid !== undefined && start !== undefined && spacing !== undefined) placement = { type: 'rectangular_grid', columns: grid[0], rows: grid[1], origin: { x: start[0], y: start[1] }, spacing_x: spacing[0], spacing_y: spacing[1] };
  } else if (placementKeys.length === 1 && placementKeys[0] === 'centers') {
    if (!Array.isArray(holes.centers) || holes.centers.length === 0) issues.push({ kind: 'invalid', code: 'EMPTY_HOLE_CENTERS', path: `${path}.centers`, message: 'centers must be a non-empty array.' });
    else {
      const centers: Point2D[] = [];
      holes.centers.forEach((center, index) => {
        if (!Array.isArray(center) || center.length !== 2 || center.some((item) => typeof item !== 'number' || !Number.isFinite(item))) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_CENTER', path: `${path}.centers.${index}`, message: 'Each center must be exactly [x,y] with finite coordinates.' });
        else centers.push({ x: center[0] as number, y: center[1] as number });
      });
      if (centers.length === holes.centers.length) placement = { type: 'explicit', centers };
    }
  } else if (placementKeys.length === 1) placement = { type: 'edge_offset', distance: holes.edge_offset, reference: holes.reference };
  features.push({ ...(requireId ? { id: holes.id } : {}), type: 'hole_pattern', diameter: holes.diameter, placement });
  paths.push(path);
}

function normalizeSimplePlan(value: Record<string, unknown>): NormalizedFeaturePlan {
  const issues: InternalIssue[] = [];
  for (const key of Object.keys(value)) {
    if (!['shape', 'size', 'profile', 'segments', 'thickness', 'unit', 'holes', 'hole_groups', 'fillet', 'chamfer'].includes(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_SIMPLE_FIELD', path: key, message: `Unknown Simple Intent field "${key}".` });
  }
  if (value.shape === undefined || value.shape === null) addMissing(issues, 'shape', 'shape');
  else if (value.shape !== 'plate' && value.shape !== 'profile') issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_SHAPE', path: 'shape', message: `Shape "${String(value.shape)}" is not supported.` });
  const features: Record<string, unknown>[] = [];
  const paths: string[] = [];
  if (value.shape === 'profile') {
    if (value.size !== undefined) issues.push({ kind: 'invalid', code: 'CONFLICTING_BASE_DEFINITION', path: 'size', message: 'shape:"profile" uses profile and thickness, not size.' });
    if (value.profile !== undefined && value.profile !== null && value.segments !== undefined && value.segments !== null) issues.push({ kind: 'invalid', code: 'MIXED_PROFILE_REPRESENTATION', path: 'profile', message: 'Use either profile or segments, never both.' });
    features.push({ type: 'profile_pad', ...(value.segments !== undefined && value.segments !== null ? { segments: value.segments } : { points: value.profile }), length: value.thickness });
    paths.push('profile');
  } else {
    if (value.profile !== undefined || value.segments !== undefined || value.thickness !== undefined) issues.push({ kind: 'invalid', code: 'CONFLICTING_BASE_DEFINITION', path: 'profile', message: 'shape:"plate" uses size, not profile, segments, or thickness.' });
    let size: number[] | undefined;
    if (value.size === undefined || value.size === null) addMissing(issues, 'size', 'Plate size');
    else if (!Array.isArray(value.size) || value.size.length !== 3 || value.size.some((item) => typeof item !== 'number' || !Number.isFinite(item) || item <= 0)) issues.push({ kind: 'invalid', code: 'INVALID_PLATE_SIZE', path: 'size', message: 'size must contain exactly three positive finite values [width,height,thickness].' });
    else size = value.size as number[];
    features.push({ type: 'rectangular_pad', width: size?.[0], height: size?.[1], length: size?.[2] });
    paths.push('shape');
  }
  if (Object.hasOwn(value, 'holes') && Object.hasOwn(value, 'hole_groups')) issues.push({ kind: 'invalid', code: 'CONFLICTING_HOLE_GROUP_FORMAT', path: 'hole_groups', message: 'Use either holes or hole_groups, never both.' });
  if (value.holes !== undefined && value.holes !== null) {
    if (!isRecord(value.holes)) issues.push({ kind: 'invalid', code: 'INVALID_HOLES', path: 'holes', message: 'holes must be an object.' });
    else appendSimpleHoleFeature(value.holes, 'holes', false, features, paths, issues);
  }
  if (value.hole_groups !== undefined && value.hole_groups !== null) {
    if (!Array.isArray(value.hole_groups) || value.hole_groups.length === 0) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_GROUPS', path: 'hole_groups', message: 'hole_groups must be a non-empty array.' });
    else value.hole_groups.forEach((group, index) => {
      const path = `hole_groups.${index}`;
      if (!isRecord(group)) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_GROUP', path, message: 'Each hole group must be an object.' });
      else appendSimpleHoleFeature(group, path, true, features, paths, issues);
    });
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
  const hasSimpleFields = ['shape', 'size', 'profile', 'segments', 'thickness'].some((key) => Object.hasOwn(value, key));
  const hasFeatureFields = Object.hasOwn(value, 'features');
  const hasLegacyFields = Object.hasOwn(value, 'base');
  if ([hasSimpleFields, hasFeatureFields, hasLegacyFields].filter(Boolean).length > 1) {
    const mixedKeys = [
      ...(hasSimpleFields ? ['Simple Intent'] : []),
      ...(hasFeatureFields ? ['Feature Plan'] : []),
      ...(hasLegacyFields ? ['Legacy Plan'] : []),
    ];
    return {
      source: 'simple',
      unit: value.unit,
      features: [],
      paths: [],
      issues: [{
        kind: 'invalid',
        code: 'MIXED_PLAN_FORMAT',
        path: 'plan',
        message: `Do not mix ${mixedKeys.join(' and ')} fields. Use shape/size/profile/segments/thickness for Simple Intent, features for Feature Plan, or base for Legacy Plan.`,
      }],
    };
  }
  const hasSimpleOperationWithoutFormat = !hasFeatureFields && !hasLegacyFields
    && ['holes', 'hole_groups', 'fillet', 'chamfer'].some((key) => Object.hasOwn(value, key));
  if (hasSimpleFields || hasSimpleOperationWithoutFormat) return normalizeSimplePlan(value);
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
  placementSource?: 'explicit' | 'rectangular_grid';
  grid?: { columns: number; rows: number; spacing_x: number; spacing_y: number; pattern_center_x: number; pattern_center_y: number };
  issues: InternalIssue[];
  ambiguityDistance?: number;
}

function pointToSegmentDistance(point: Point2D, start: PolygonPoint, end: PolygonPoint): number {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength <= LINEAR_TOLERANCE_MM * LINEAR_TOLERANCE_MM) return Math.hypot(point.x - start[0], point.y - start[1]);
  const projection = Math.max(0, Math.min(1, ((point.x - start[0]) * dx + (point.y - start[1]) * dy) / squaredLength));
  return Math.hypot(point.x - (start[0] + projection * dx), point.y - (start[1] + projection * dy));
}

function pointInPolygon(point: Point2D, polygon: PolygonPoint[]): boolean {
  let inside = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const [ax, ay] = polygon[index];
    const [bx, by] = polygon[(index + 1) % polygon.length];
    // Half-open ray crossing counts shared vertices once; horizontal edges do not cross.
    if ((ay > point.y) !== (by > point.y) && point.x < ax + ((point.y - ay) * (bx - ax)) / (by - ay)) inside = !inside;
  }
  return inside;
}

function validateCircleInsideProfile(
  center: Point2D, radius: number, polygon: PolygonPoint[], path: string, holeIndex: number, diameter: number,
  placementSource: 'explicit' | 'rectangular_grid', issues: InternalIssue[],
): void {
  const minimumClearance = polygon.reduce(
    (minimum, start, index) => Math.min(minimum, pointToSegmentDistance(center, start, polygon[(index + 1) % polygon.length])),
    Infinity,
  );
  const details = {
    holeIndex,
    center: { x: center.x, y: center.y },
    diameter,
    radius,
    placementSource,
    minimumBoundaryDistance: minimumClearance,
    requiredBoundaryDistanceExclusive: radius + LINEAR_TOLERANCE_MM,
  };
  if (!pointInPolygon(center, polygon) && minimumClearance > LINEAR_TOLERANCE_MM) {
    issues.push({ kind: 'invalid', code: 'PROFILE_HOLE_OUTSIDE_MATERIAL', path, message: 'Hole center is outside the polygon material.', details });
  } else if (minimumClearance <= radius + LINEAR_TOLERANCE_MM) {
    issues.push({ kind: 'invalid', code: 'PROFILE_HOLE_INTERSECTS_BOUNDARY', path, message: 'Hole circle intersects, touches, or is within tolerance of the polygon boundary.', details });
  }
}

function resolveHolePattern(feature: Record<string, unknown>, path: string, width: unknown, height: unknown, polygon?: PolygonPoint[]): HoleResolution {
  const issues: InternalIssue[] = [];
  const diameter = positiveNumber(feature, 'diameter', `${path}.diameter`, 'Hole diameter', issues);
  if (feature.operation !== undefined && feature.operation !== null && feature.operation !== 'through_all') {
    issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_HOLE_OPERATION', path: `${path}.operation`, message: 'Only through_all hole patterns are supported.' });
  }
  const countValue = feature.count;
  let requestedCount: number | undefined;
  if (countValue !== undefined && countValue !== null) {
    if (typeof countValue !== 'number' || !Number.isInteger(countValue) || countValue <= 0) issues.push({ kind: 'invalid', code: 'INVALID_HOLE_COUNT', path: `${path}.count`, message: 'Optional count must be a positive integer.' });
    else requestedCount = countValue;
  }
  const placement = feature.placement;
  let centers: Point2D[] | undefined;
  let placementSource: 'explicit' | 'rectangular_grid' | undefined;
  let grid: HoleResolution['grid'];
  let ambiguityDistance: number | undefined;
  if (placement === undefined || placement === null) addMissing(issues, `${path}.placement`, 'Hole placement');
  else if (!isRecord(placement)) issues.push({ kind: 'invalid', code: 'INVALID_PLACEMENT', path: `${path}.placement`, message: 'Hole placement must be an object.' });
  else if (polygon !== undefined && placement.type !== undefined && placement.type !== null && !['explicit', 'rectangular_grid'].includes(String(placement.type))) {
    issues.push({ kind: 'unsupported', code: 'PROFILE_PAD_HOLE_PLACEMENT_UNSUPPORTED', path: `${path}.placement.type`, message: 'Only explicit and rectangular_grid hole placement are supported on profile_pad.' });
  } else if (placement.type === 'edge_offset') {
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
    placementSource = 'explicit';
    if (!Array.isArray(placement.centers) || placement.centers.length === 0) issues.push({ kind: placement.centers === undefined || placement.centers === null ? 'incomplete' : 'invalid', code: placement.centers === undefined || placement.centers === null ? 'MISSING_REQUIRED_VALUE' : 'EMPTY_HOLE_CENTERS', path: `${path}.placement.centers`, message: 'explicit placement requires a non-empty centers array.' });
    else if (placement.centers.length > 1000) issues.push({ kind: 'invalid', code: 'TOO_MANY_HOLES', path: `${path}.placement.centers`, message: 'At most 1000 hole centers are supported.' });
    else {
      const parsed: Point2D[] = [];
      placement.centers.forEach((center, index) => {
        if (Array.isArray(center) && center.length === 2 && center.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate))) parsed.push({ x: center[0] as number, y: center[1] as number });
        else if (isRecord(center) && typeof center.x === 'number' && Number.isFinite(center.x) && typeof center.y === 'number' && Number.isFinite(center.y)) parsed.push({ x: center.x, y: center.y });
        else issues.push({ kind: 'invalid', code: 'INVALID_HOLE_CENTER', path: `${path}.placement.centers.${index}`, message: 'Each center requires finite x and y coordinates as [x,y] or {x,y}.' });
      });
      if (parsed.length === placement.centers.length) centers = parsed;
    }
  } else if (placement.type === 'rectangular_grid') {
    placementSource = 'rectangular_grid';
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
        grid = {
          columns,
          rows,
          spacing_x: spacingX,
          spacing_y: spacingY,
          pattern_center_x: origin.x + ((columns - 1) * spacingX) / 2,
          pattern_center_y: origin.y + ((rows - 1) * spacingY) / 2,
        };
      }
    }
  } else if (placement.type === undefined || placement.type === null) addMissing(issues, `${path}.placement.type`, 'Placement type');
  else issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_PLACEMENT', path: `${path}.placement.type`, message: `Placement type "${String(placement.type)}" is not supported.` });

  if (centers !== undefined && requestedCount !== undefined && requestedCount !== centers.length) issues.push({ kind: 'invalid', code: 'HOLE_COUNT_MISMATCH', path: `${path}.count`, message: `count ${requestedCount} does not match ${centers.length} resolved centers.` });
  if (centers !== undefined && diameter !== undefined) {
    const radius = diameter / 2;
    if (polygon !== undefined && placementSource !== undefined) {
      centers.forEach((center, index) => validateCircleInsideProfile(center, radius, polygon, `${path}.placement.centers.${index}`, index, diameter, placementSource, issues));
    } else if (typeof width === 'number' && typeof height === 'number') {
      if (!centers.every((center) => radius <= center.x && center.x <= width - radius && radius <= center.y && center.y <= height - radius)) issues.push({ kind: 'invalid', code: 'HOLE_OUTSIDE_BASE', path: `${path}.placement`, message: 'At least one hole is not completely inside the rectangular base.' });
    }
    for (let first = 0; first < centers.length; first += 1) for (let second = first + 1; second < centers.length; second += 1) {
      const centerDistance = Math.hypot(centers[first].x - centers[second].x, centers[first].y - centers[second].y);
      if (centerDistance <= diameter + (polygon === undefined ? 0 : LINEAR_TOLERANCE_MM)) {
        issues.push({ kind: 'invalid', code: 'HOLES_OVERLAP', path: `${path}.placement`, message: 'Hole profiles overlap, touch, or are within tolerance.', details: { firstHoleIndex: first, secondHoleIndex: second, firstCenter: centers[first], secondCenter: centers[second], diameter, centerDistance, requiredCenterDistanceExclusive: diameter + (polygon === undefined ? 0 : LINEAR_TOLERANCE_MM) } });
        first = centers.length;
        break;
      }
    }
  }
  return { diameter, centers, placementSource, grid, issues, ambiguityDistance };
}

interface ResolvedHoleGroup {
  feature: Record<string, unknown>;
  path: string;
  resolution: HoleResolution;
}

interface RectangularPocketBox {
  min_x: number; max_x: number;
  min_y: number; max_y: number;
  min_z: number; max_z: number;
}

interface RectangularOperation {
  kind: 'add' | 'subtract';
  box: RectangularPocketBox;
}

interface RectangularGeometryState {
  base: RectangularPocketBox;
  operations: RectangularOperation[];
}

interface RectangularStateMetrics {
  volume: number;
  components: number;
  bounds?: RectangularPocketBox;
  cells: RectangularPocketBox[];
}

interface RectangularPocketResolution {
  resolved?: Record<string, unknown>;
  box?: RectangularPocketBox;
  issues: InternalIssue[];
}

const RECTANGULAR_SEMANTIC_FACES = new Set(['top', 'front', 'back', 'left', 'right']);

function pointInBox(point: { x: number; y: number; z: number }, box: RectangularPocketBox): boolean {
  return point.x > box.min_x && point.x < box.max_x && point.y > box.min_y && point.y < box.max_y && point.z > box.min_z && point.z < box.max_z;
}

function rectangularStateMetrics(state: RectangularGeometryState): RectangularStateMetrics {
  const boxes = [state.base, ...state.operations.map((operation) => operation.box)];
  const axis = (minimum: keyof RectangularPocketBox, maximum: keyof RectangularPocketBox): number[] => [...new Set(boxes.flatMap((box) => [box[minimum], box[maximum]]))].sort((first, second) => first - second);
  const xs = axis('min_x', 'max_x');
  const ys = axis('min_y', 'max_y');
  const zs = axis('min_z', 'max_z');
  const material = new Set<string>();
  const cells: RectangularPocketBox[] = [];
  for (let xi = 0; xi < xs.length - 1; xi += 1) for (let yi = 0; yi < ys.length - 1; yi += 1) for (let zi = 0; zi < zs.length - 1; zi += 1) {
    const center = { x: (xs[xi] + xs[xi + 1]) / 2, y: (ys[yi] + ys[yi + 1]) / 2, z: (zs[zi] + zs[zi + 1]) / 2 };
    let present = pointInBox(center, state.base);
    for (const operation of state.operations) if (pointInBox(center, operation.box)) present = operation.kind === 'add';
    if (!present) continue;
    material.add(`${xi},${yi},${zi}`);
    cells.push({ min_x: xs[xi], max_x: xs[xi + 1], min_y: ys[yi], max_y: ys[yi + 1], min_z: zs[zi], max_z: zs[zi + 1] });
  }
  let components = 0;
  const remaining = new Set(material);
  while (remaining.size > 0) {
    components += 1;
    const start = remaining.values().next().value as string;
    const pending = [start];
    remaining.delete(start);
    while (pending.length > 0) {
      const [xi, yi, zi] = pending.pop()!.split(',').map(Number);
      for (const [dx, dy, dz] of [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]]) {
        const neighbor = `${xi + dx},${yi + dy},${zi + dz}`;
        if (remaining.delete(neighbor)) pending.push(neighbor);
      }
    }
  }
  const volume = cells.reduce((sum, cell) => sum + (cell.max_x - cell.min_x) * (cell.max_y - cell.min_y) * (cell.max_z - cell.min_z), 0);
  const bounds = cells.length === 0 ? undefined : {
    min_x: Math.min(...cells.map((cell) => cell.min_x)), max_x: Math.max(...cells.map((cell) => cell.max_x)),
    min_y: Math.min(...cells.map((cell) => cell.min_y)), max_y: Math.max(...cells.map((cell) => cell.max_y)),
    min_z: Math.min(...cells.map((cell) => cell.min_z)), max_z: Math.max(...cells.map((cell) => cell.max_z)),
  };
  return { volume, components, bounds, cells };
}

function semanticFaceSize(bounds: RectangularPocketBox, face: string): { width: number; height: number; availableDepth: number } {
  return {
    width: face === 'left' || face === 'right' ? bounds.max_y - bounds.min_y : bounds.max_x - bounds.min_x,
    height: face === 'top' ? bounds.max_y - bounds.min_y : bounds.max_z - bounds.min_z,
    availableDepth: face === 'top' ? bounds.max_z - bounds.min_z : face === 'front' || face === 'back' ? bounds.max_y - bounds.min_y : bounds.max_x - bounds.min_x,
  };
}

function semanticRectangularBox(bounds: RectangularPocketBox, face: string, position: Point2D, width: number, height: number, distance: number, outward: boolean): RectangularPocketBox {
  if (face === 'top') return { min_x: bounds.min_x + position.x, max_x: bounds.min_x + position.x + width, min_y: bounds.min_y + position.y, max_y: bounds.min_y + position.y + height, min_z: outward ? bounds.max_z : bounds.max_z - distance, max_z: outward ? bounds.max_z + distance : bounds.max_z };
  if (face === 'front') return { min_x: bounds.min_x + position.x, max_x: bounds.min_x + position.x + width, min_y: outward ? bounds.min_y - distance : bounds.min_y, max_y: outward ? bounds.min_y : bounds.min_y + distance, min_z: bounds.min_z + position.y, max_z: bounds.min_z + position.y + height };
  if (face === 'back') return { min_x: bounds.min_x + position.x, max_x: bounds.min_x + position.x + width, min_y: outward ? bounds.max_y : bounds.max_y - distance, max_y: outward ? bounds.max_y + distance : bounds.max_y, min_z: bounds.min_z + position.y, max_z: bounds.min_z + position.y + height };
  if (face === 'left') return { min_x: outward ? bounds.min_x - distance : bounds.min_x, max_x: outward ? bounds.min_x : bounds.min_x + distance, min_y: bounds.min_y + position.x, max_y: bounds.min_y + position.x + width, min_z: bounds.min_z + position.y, max_z: bounds.min_z + position.y + height };
  return { min_x: outward ? bounds.max_x : bounds.max_x - distance, max_x: outward ? bounds.max_x + distance : bounds.max_x, min_y: bounds.min_y + position.x, max_y: bounds.min_y + position.x + width, min_z: bounds.min_z + position.y, max_z: bounds.min_z + position.y + height };
}

function footprintSupportArea(metrics: RectangularStateMetrics, face: string, box: RectangularPocketBox): number {
  if (metrics.bounds === undefined) return 0;
  const overlap = (firstMin: number, firstMax: number, secondMin: number, secondMax: number) => Math.max(0, Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin));
  return metrics.cells.reduce((area, cell) => {
    if (face === 'top' && Math.abs(cell.max_z - metrics.bounds!.max_z) <= LINEAR_TOLERANCE_MM) return area + overlap(cell.min_x, cell.max_x, box.min_x, box.max_x) * overlap(cell.min_y, cell.max_y, box.min_y, box.max_y);
    if (face === 'front' && Math.abs(cell.min_y - metrics.bounds!.min_y) <= LINEAR_TOLERANCE_MM) return area + overlap(cell.min_x, cell.max_x, box.min_x, box.max_x) * overlap(cell.min_z, cell.max_z, box.min_z, box.max_z);
    if (face === 'back' && Math.abs(cell.max_y - metrics.bounds!.max_y) <= LINEAR_TOLERANCE_MM) return area + overlap(cell.min_x, cell.max_x, box.min_x, box.max_x) * overlap(cell.min_z, cell.max_z, box.min_z, box.max_z);
    if (face === 'left' && Math.abs(cell.min_x - metrics.bounds!.min_x) <= LINEAR_TOLERANCE_MM) return area + overlap(cell.min_y, cell.max_y, box.min_y, box.max_y) * overlap(cell.min_z, cell.max_z, box.min_z, box.max_z);
    if (face === 'right' && Math.abs(cell.max_x - metrics.bounds!.max_x) <= LINEAR_TOLERANCE_MM) return area + overlap(cell.min_y, cell.max_y, box.min_y, box.max_y) * overlap(cell.min_z, cell.max_z, box.min_z, box.max_z);
    return area;
  }, 0);
}

function validateRectangularDependencies(feature: Record<string, unknown>, path: string, label: string, previousFeature: Record<string, unknown> | undefined, earlierById: Map<string, Record<string, unknown>>, allowedTargets: Set<string>, issues: InternalIssue[]): void {
  if (feature.target === undefined || feature.target === null || feature.target === '') addMissing(issues, `${path}.target`, `${label} target`);
  if (feature.after === undefined || feature.after === null || feature.after === '') addMissing(issues, `${path}.after`, `${label} predecessor`);
  const targetFeature = typeof feature.target === 'string' ? earlierById.get(feature.target) : undefined;
  if (targetFeature !== undefined && !allowedTargets.has(String(targetFeature.type))) issues.push({ kind: 'unsupported', code: `UNSUPPORTED_${label.toUpperCase()}_TARGET`, path: `${path}.target`, message: `${label} target type is not supported.` });
  if (targetFeature !== undefined && previousFeature !== undefined && feature.target !== previousFeature.id) issues.push({ kind: 'invalid', code: `${label.toUpperCase()}_TARGET_NOT_CURRENT_TIP`, path: `${path}.target`, message: `${label} must target the immediately preceding PartDesign geometry state.` });
  if (typeof feature.after === 'string' && typeof feature.target === 'string' && feature.after !== feature.target) issues.push({ kind: 'invalid', code: `${label.toUpperCase()}_DEPENDENCY_MISMATCH`, path: `${path}.after`, message: 'after and target must identify the same immediately preceding geometry state.' });
}

function resolveRectangularPocket(
  feature: Record<string, unknown>, path: string,
  state: RectangularGeometryState,
  previousFeature: Record<string, unknown> | undefined,
  earlierById: Map<string, Record<string, unknown>>,
): RectangularPocketResolution {
  const issues: InternalIssue[] = [];
  const allowed = new Set(['id', 'type', 'after', 'target', 'face', 'width', 'height', 'position', 'depth']);
  for (const key of Object.keys(feature)) {
    if (!allowed.has(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_RECTANGULAR_POCKET_FIELD', path: `${path}.${key}`, message: `Unknown rectangular_pocket field "${key}".` });
  }
  const width = positiveNumber(feature, 'width', `${path}.width`, 'Pocket width', issues);
  const height = positiveNumber(feature, 'height', `${path}.height`, 'Pocket height', issues);
  const depth = positiveNumber(feature, 'depth', `${path}.depth`, 'Pocket depth', issues);
  const face = feature.face;
  if (face === undefined || face === null || face === '') addMissing(issues, `${path}.face`, 'Semantic face');
  else if (typeof face !== 'string' || !RECTANGULAR_SEMANTIC_FACES.has(face)) issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_POCKET_FACE', path: `${path}.face`, message: 'rectangular_pocket supports only top, front, back, left, and right.' });
  let position: Point2D | undefined;
  if (feature.position === undefined || feature.position === null) addMissing(issues, `${path}.position`, 'Pocket position');
  else if (!isRecord(feature.position)) issues.push({ kind: 'invalid', code: 'INVALID_POCKET_POSITION', path: `${path}.position`, message: 'position must contain finite local x and y coordinates.' });
  else {
    const x = feature.position.x;
    const y = feature.position.y;
    if (typeof x !== 'number' || !Number.isFinite(x)) issues.push({ kind: 'invalid', code: 'INVALID_POCKET_POSITION', path: `${path}.position.x`, message: 'position.x must be finite.' });
    if (typeof y !== 'number' || !Number.isFinite(y)) issues.push({ kind: 'invalid', code: 'INVALID_POCKET_POSITION', path: `${path}.position.y`, message: 'position.y must be finite.' });
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) position = { x, y };
  }
  validateRectangularDependencies(feature, path, 'pocket', previousFeature, earlierById, new Set(['rectangular_pad', 'rectangular_pocket', 'rectangular_addition']), issues);
  const current = rectangularStateMetrics(state);
  if (width === undefined || height === undefined || depth === undefined || position === undefined || typeof face !== 'string' || !RECTANGULAR_SEMANTIC_FACES.has(face) || current.bounds === undefined || issues.length > 0) return { issues };
  const { width: faceWidth, height: faceHeight, availableDepth } = semanticFaceSize(current.bounds, face);
  if (position.x < -LINEAR_TOLERANCE_MM || position.y < -LINEAR_TOLERANCE_MM
    || position.x + width > faceWidth + LINEAR_TOLERANCE_MM || position.y + height > faceHeight + LINEAR_TOLERANCE_MM) {
    issues.push({ kind: 'invalid', code: 'POCKET_OUTSIDE_FACE', path: `${path}.position`, message: 'The rectangular pocket must lie completely inside the selected semantic face.', details: { face, faceWidth, faceHeight, position, width, height } });
  }
  if (depth > availableDepth + LINEAR_TOLERANCE_MM) issues.push({ kind: 'invalid', code: 'POCKET_TOO_DEEP', path: `${path}.depth`, message: 'Pocket depth exceeds the available base dimension in the semantic cut direction.', details: { face, availableDepth, requestedDepth: depth } });
  const box = semanticRectangularBox(current.bounds, face, position, width, height, depth, false);
  const resulting = rectangularStateMetrics({ ...state, operations: [...state.operations, { kind: 'subtract', box }] });
  if (current.volume - resulting.volume <= VOLUME_TOLERANCE_MM3) {
    issues.push({ kind: 'invalid', code: 'POCKET_REMOVES_NO_MATERIAL', path, message: 'The requested pocket is completely contained in an earlier removed volume.' });
  }
  if (resulting.volume <= VOLUME_TOLERANCE_MM3) {
    issues.push({ kind: 'invalid', code: 'POCKET_REMOVES_ALL_MATERIAL', path, message: 'The resolved rectangular pocket union would remove the complete base solid.' });
  }
  if (resulting.components > 1) {
    issues.push({ kind: 'invalid', code: 'POCKET_DISCONNECTS_SOLID', path, message: 'The resolved rectangular pocket would split the base into multiple solids.', details: { materialComponents: resulting.components } });
  }
  if (issues.length > 0) return { issues };
  return {
    issues: [], box,
    resolved: { id: feature.id, type: 'rectangular_pocket', face, width, height, position, depth, box, after: feature.after, target: feature.target },
  };
}

function resolveRectangularAddition(feature: Record<string, unknown>, path: string, state: RectangularGeometryState, previousFeature: Record<string, unknown> | undefined, earlierById: Map<string, Record<string, unknown>>): RectangularPocketResolution {
  const issues: InternalIssue[] = [];
  const allowed = new Set(['id', 'type', 'after', 'target', 'face', 'width', 'height', 'position', 'length']);
  for (const key of Object.keys(feature)) if (!allowed.has(key)) issues.push({ kind: 'invalid', code: 'UNKNOWN_RECTANGULAR_ADDITION_FIELD', path: `${path}.${key}`, message: `Unknown rectangular_addition field "${key}".` });
  const width = positiveNumber(feature, 'width', `${path}.width`, 'Addition width', issues);
  const height = positiveNumber(feature, 'height', `${path}.height`, 'Addition height', issues);
  const length = positiveNumber(feature, 'length', `${path}.length`, 'Addition length', issues);
  const face = feature.face;
  if (face === undefined || face === null || face === '') addMissing(issues, `${path}.face`, 'Semantic face');
  else if (typeof face !== 'string' || !RECTANGULAR_SEMANTIC_FACES.has(face)) issues.push({ kind: 'unsupported', code: 'UNSUPPORTED_ADDITION_FACE', path: `${path}.face`, message: 'rectangular_addition supports only top, front, back, left, and right.' });
  let position: Point2D | undefined;
  if (!isRecord(feature.position)) issues.push({ kind: feature.position === undefined || feature.position === null ? 'incomplete' : 'invalid', code: feature.position === undefined || feature.position === null ? 'MISSING_REQUIRED_VALUE' : 'INVALID_ADDITION_POSITION', path: `${path}.position`, message: 'Addition position with finite x and y is required.' });
  else {
    const x = feature.position.x; const y = feature.position.y;
    if (typeof x !== 'number' || !Number.isFinite(x)) issues.push({ kind: 'invalid', code: 'INVALID_ADDITION_POSITION', path: `${path}.position.x`, message: 'position.x must be finite.' });
    if (typeof y !== 'number' || !Number.isFinite(y)) issues.push({ kind: 'invalid', code: 'INVALID_ADDITION_POSITION', path: `${path}.position.y`, message: 'position.y must be finite.' });
    if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) position = { x, y };
  }
  validateRectangularDependencies(feature, path, 'addition', previousFeature, earlierById, new Set(['rectangular_pad', 'rectangular_pocket', 'rectangular_addition']), issues);
  const current = rectangularStateMetrics(state);
  if (width === undefined || height === undefined || length === undefined || position === undefined || typeof face !== 'string' || !RECTANGULAR_SEMANTIC_FACES.has(face) || current.bounds === undefined || issues.length > 0) return { issues };
  const size = semanticFaceSize(current.bounds, face);
  if (position.x < -LINEAR_TOLERANCE_MM || position.y < -LINEAR_TOLERANCE_MM || position.x + width > size.width + LINEAR_TOLERANCE_MM || position.y + height > size.height + LINEAR_TOLERANCE_MM) issues.push({ kind: 'invalid', code: 'ADDITION_OUTSIDE_FACE', path: `${path}.position`, message: 'The rectangular addition must lie completely inside the selected semantic face.', details: { face, faceWidth: size.width, faceHeight: size.height, position, width, height } });
  const box = semanticRectangularBox(current.bounds, face, position, width, height, length, true);
  const expectedFootprintArea = width * height;
  const supportedArea = footprintSupportArea(current, face, box);
  if (supportedArea < expectedFootprintArea - AREA_TOLERANCE_MM2) issues.push({ kind: 'invalid', code: 'ADDITION_FOOTPRINT_NOT_FULLY_SUPPORTED', path: `${path}.position`, message: 'The complete rectangular addition footprint must lie on existing material.', details: { expectedArea: expectedFootprintArea, supportedArea } });
  const resulting = rectangularStateMetrics({ ...state, operations: [...state.operations, { kind: 'add', box }] });
  const addedVolume = resulting.volume - current.volume;
  const expectedAddedVolume = width * height * length;
  if (addedVolume <= VOLUME_TOLERANCE_MM3) issues.push({ kind: 'invalid', code: 'ADDITION_ADDS_NO_MATERIAL', path, message: 'The rectangular addition must add positive new material.' });
  if (Math.abs(addedVolume - expectedAddedVolume) > VOLUME_TOLERANCE_MM3) issues.push({ kind: 'invalid', code: 'ADDITION_NOT_FULLY_OUTWARD', path, message: 'The rectangular addition must extrude completely outward from the selected face.', details: { expectedAddedVolume, addedVolume } });
  if (resulting.components !== 1) issues.push({ kind: 'invalid', code: 'ADDITION_DISCONNECTED_SOLID', path, message: 'The rectangular addition must remain connected to the existing solid.', details: { materialComponents: resulting.components } });
  if (issues.length > 0) return { issues };
  return { issues: [], box, resolved: { id: feature.id, type: 'rectangular_addition', face, width, height, position, length, box, after: feature.after, target: feature.target } };
}

function validateCrossGroupHoleGeometry(groups: ResolvedHoleGroup[]): InternalIssue[] {
  const issues: InternalIssue[] = [];
  for (let firstGroup = 0; firstGroup < groups.length; firstGroup += 1) {
    const first = groups[firstGroup];
    if (first.resolution.centers === undefined || first.resolution.diameter === undefined) continue;
    for (let secondGroup = firstGroup + 1; secondGroup < groups.length; secondGroup += 1) {
      const second = groups[secondGroup];
      if (second.resolution.centers === undefined || second.resolution.diameter === undefined) continue;
      for (let firstIndex = 0; firstIndex < first.resolution.centers.length; firstIndex += 1) {
        for (let secondIndex = 0; secondIndex < second.resolution.centers.length; secondIndex += 1) {
          const firstCenter = first.resolution.centers[firstIndex];
          const secondCenter = second.resolution.centers[secondIndex];
          const centerDistance = Math.hypot(firstCenter.x - secondCenter.x, firstCenter.y - secondCenter.y);
          const requiredDistanceExclusive = (first.resolution.diameter + second.resolution.diameter) / 2 + LINEAR_TOLERANCE_MM;
          if (centerDistance <= requiredDistanceExclusive) {
            issues.push({
              kind: 'invalid', code: 'HOLES_OVERLAP', path: `${second.path}.placement`,
              message: 'Hole profiles from different semantic groups overlap, touch, or are within tolerance.',
              details: {
                firstFeatureId: first.feature.id, secondFeatureId: second.feature.id,
                firstHoleIndex: firstIndex, secondHoleIndex: secondIndex,
                firstCenter, secondCenter, centerDistance, requiredCenterDistanceExclusive: requiredDistanceExclusive,
              },
            });
            firstIndex = first.resolution.centers.length;
            secondIndex = second.resolution.centers.length;
          }
        }
      }
    }
  }
  return issues;
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
      if (type !== 'hole_pattern' && type !== 'rectangular_pocket' && type !== 'rectangular_addition' && seenTypes.has(String(type))) structuralIssues.push({ kind: 'invalid', code: 'DUPLICATE_FEATURE_TYPE', path: `${path}.type`, message: `Only one ${String(type)} feature is currently supported.` });
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
      if (feature === profileFeature || feature.type === 'hole_pattern') return;
      structuralIssues.push({ kind: 'unsupported', code: 'PROFILE_PAD_FINISHING_UNSUPPORTED', path: normalized.paths[index], message: `${String(feature.type)} is not yet supported after profile_pad.` });
    });
    const profileIndex = normalized.features.indexOf(profileFeature);
    const profilePath = normalized.paths[profileIndex];
    const profileValidation = validateProfilePad(profileFeature, profilePath);
    structuralIssues.push(...profileValidation.issues.map((issue) => {
      if (normalized.source !== 'simple') return issue;
      if (issue.path === `${profilePath}.points`) return { ...issue, path: 'profile' };
      if (issue.path.startsWith(`${profilePath}.points.`)) return { ...issue, path: `profile${issue.path.slice(`${profilePath}.points`.length)}` };
      if (issue.path === `${profilePath}.segments`) return { ...issue, path: 'segments' };
      if (issue.path.startsWith(`${profilePath}.segments.`)) return { ...issue, path: `segments${issue.path.slice(`${profilePath}.segments`.length)}` };
      if (issue.path === `${profilePath}.length`) return { ...issue, path: 'thickness' };
      return issue;
    }));
    if (normalized.unit === undefined || normalized.unit === null || normalized.unit === '') addMissing(structuralIssues, 'unit', 'Unit');
    else if (typeof normalized.unit !== 'string') structuralIssues.push({ kind: 'invalid', code: 'INVALID_UNIT', path: 'unit', message: 'Unit must be a string.' });
    else if (normalized.unit !== 'mm') structuralIssues.push({ kind: 'unsupported', code: 'UNSUPPORTED_UNIT', path: 'unit', message: `Unit "${normalized.unit}" is not supported; use mm.` });
    const holeFeatures = normalized.features
      .map((feature, index) => ({ feature, path: normalized.paths[index] }))
      .filter((entry) => entry.feature.type === 'hole_pattern');
    if (profileValidation.segments !== undefined && profileValidation.arcCount !== undefined && profileValidation.arcCount > 0 && holeFeatures.length > 0) {
      structuralIssues.push({ kind: 'unsupported', code: 'ARC_PROFILE_HOLES_UNSUPPORTED', path: holeFeatures[0].path, message: 'Hole patterns on profiles containing arcs are not supported until curved-boundary material validation is available.' });
    }
    const linearMaterialPolygon: PolygonPoint[] | undefined = profileValidation.points
      ?? (profileValidation.segments !== undefined && profileValidation.arcCount === 0
        ? profileValidation.segments.map((segment) => [segment.start.x, segment.start.y])
        : undefined);
    const holeGroups: ResolvedHoleGroup[] = linearMaterialPolygon === undefined ? [] : holeFeatures.map(({ feature, path }) => ({
      feature, path, resolution: resolveHolePattern(feature, path, undefined, undefined, linearMaterialPolygon),
    }));
    structuralIssues.push(...holeGroups.flatMap((group) => group.resolution.issues), ...validateCrossGroupHoleGeometry(holeGroups));
    const validProfileRepresentation = profileValidation.points !== undefined || profileValidation.segments !== undefined;
    if (structuralIssues.length > 0 || !validProfileRepresentation || profileValidation.length === undefined
      || holeGroups.some((group) => group.resolution.centers === undefined || group.resolution.diameter === undefined)) {
      const status = statusFor(structuralIssues);
      return { status, can_execute: false, issues: structuralIssues.map(({ kind: _kind, ...issue }) => issue) };
    }
    const resolvedProfile: Record<string, unknown> = { id: profileFeature.id, type: 'profile_pad', length: profileValidation.length };
    if (profileValidation.points !== undefined) resolvedProfile.points = profileValidation.points;
    else resolvedProfile.segments = profileValidation.segments!.map((segment) => segment.type === 'line'
      ? { type: 'line', start: segment.start, end: segment.end }
      : { type: 'arc', start: segment.start, end: segment.end, center: segment.center, direction: segment.direction });
    const resolvedFeatures: Record<string, unknown>[] = [resolvedProfile];
    for (const { feature: holeFeature, resolution: holeResolution } of holeGroups) {
      resolvedFeatures.push({
        id: holeFeature.id,
        type: 'hole_pattern',
        diameter: holeResolution.diameter,
        centers: holeResolution.centers,
        ...(holeResolution.placementSource === 'explicit' && holeResolution.centers?.length === 1 ? { center_editable: true } : {}),
        ...(holeResolution.grid !== undefined ? { grid: holeResolution.grid } : {}),
        operation: 'through_all',
        ...(typeof holeFeature.after === 'string' ? { after: holeFeature.after } : {}),
        ...(typeof holeFeature.target === 'string' ? { target: holeFeature.target } : {}),
      });
    }
    return {
      status: 'valid',
      can_execute: true,
      issues: [],
      resolved_plan: { unit: 'mm', features: resolvedFeatures },
    };
  }

  const baseFeatureForPockets = normalized.features.find((feature) => feature.type === 'rectangular_pad');
  const rectangularFeatures = normalized.features
    .map((feature, index) => ({ feature, path: normalized.paths[index], index }))
    .filter((entry) => entry.feature.type === 'rectangular_pocket' || entry.feature.type === 'rectangular_addition');
  const rectangularResolutionByFeature = new Map<Record<string, unknown>, RectangularPocketResolution>();
  if (rectangularFeatures.length > 0) {
    const incompatible = normalized.features.find((feature) => feature.type === 'hole_pattern' || feature.type === 'fillet' || feature.type === 'chamfer');
    if (incompatible !== undefined) {
      const incompatibleIndex = normalized.features.indexOf(incompatible);
      structuralIssues.push({ kind: 'unsupported', code: 'RECTANGULAR_FEATURE_COMBINATION_UNSUPPORTED', path: normalized.paths[incompatibleIndex], message: 'V1 rectangular pocket/addition plans cannot be combined with hole_pattern, fillet, or chamfer features.' });
    }
    if (baseFeatureForPockets !== undefined
      && typeof baseFeatureForPockets.width === 'number' && Number.isFinite(baseFeatureForPockets.width) && baseFeatureForPockets.width > 0
      && typeof baseFeatureForPockets.height === 'number' && Number.isFinite(baseFeatureForPockets.height) && baseFeatureForPockets.height > 0
      && typeof baseFeatureForPockets.length === 'number' && Number.isFinite(baseFeatureForPockets.length) && baseFeatureForPockets.length > 0) {
      const earlierById = new Map<string, Record<string, unknown>>();
      const state: RectangularGeometryState = {
        base: { min_x: 0, max_x: baseFeatureForPockets.width as number, min_y: 0, max_y: baseFeatureForPockets.height as number, min_z: 0, max_z: baseFeatureForPockets.length as number },
        operations: [],
      };
      normalized.features.forEach((feature, index) => {
        if (feature.type === 'rectangular_pocket') {
          const resolution = resolveRectangularPocket(feature, normalized.paths[index], state, normalized.features[index - 1], earlierById);
          rectangularResolutionByFeature.set(feature, resolution);
          structuralIssues.push(...resolution.issues);
          if (resolution.box !== undefined && resolution.issues.length === 0) state.operations.push({ kind: 'subtract', box: resolution.box });
        } else if (feature.type === 'rectangular_addition') {
          const resolution = resolveRectangularAddition(feature, normalized.paths[index], state, normalized.features[index - 1], earlierById);
          rectangularResolutionByFeature.set(feature, resolution);
          structuralIssues.push(...resolution.issues);
          if (resolution.box !== undefined && resolution.issues.length === 0) state.operations.push({ kind: 'add', box: resolution.box });
        }
        if (typeof feature.id === 'string') earlierById.set(feature.id, feature);
      });
    }
  }

  if (structuralIssues.length > 0) {
    const status = statusFor(structuralIssues);
    return { status, can_execute: false, issues: structuralIssues.map(({ kind: _kind, ...issue }) => issue) };
  }

  const baseFeature = baseFeatureForPockets;
  const holeFeatures = normalized.features
    .map((feature, index) => ({ feature, path: normalized.paths[index] }))
    .filter((entry) => entry.feature.type === 'hole_pattern');
  const filletFeature = normalized.features.find((feature) => feature.type === 'fillet');
  const chamferFeature = normalized.features.find((feature) => feature.type === 'chamfer');
  const holeGroups: ResolvedHoleGroup[] = holeFeatures.map(({ feature, path }) => ({
    feature, path, resolution: resolveHolePattern(feature, path, baseFeature?.width, baseFeature?.height),
  }));
  const legacyPlan: Record<string, unknown> = {
    base: baseFeature === undefined ? undefined : { type: 'rectangular_plate', width: baseFeature.width, height: baseFeature.height, thickness: baseFeature.length, unit: normalized.unit },
  };
  if (filletFeature !== undefined) legacyPlan.fillet = { radius: filletFeature.radius, edges: filletFeature.edges };
  if (chamferFeature !== undefined) legacyPlan.chamfer = { size: chamferFeature.size, edges: chamferFeature.edges };
  const validated = validateLegacyCadPlan(legacyPlan);
  validated.issues = validated.issues.map((issue) => ({ ...issue, path: translateIssuePath(issue.path, normalized) }));
  const holeIssues = [...holeGroups.flatMap((group) => group.resolution.issues), ...validateCrossGroupHoleGeometry(holeGroups)];
  validated.issues.push(...holeIssues.map(({ kind: _kind, ...issue }) => issue));
  const combinedInternalIssues: InternalIssue[] = [
    ...validated.issues.map((issue) => ({ ...issue, kind: issue.code === 'AMBIGUOUS_DISTANCE_REFERENCE' ? 'ambiguous' as const : issue.code === 'MISSING_REQUIRED_VALUE' ? 'incomplete' as const : issue.code.startsWith('UNSUPPORTED_') ? 'unsupported' as const : 'invalid' as const })),
  ];
  validated.status = statusFor(combinedInternalIssues);
  validated.can_execute = validated.status === 'valid';
  if (validated.status !== 'valid' || validated.resolved_plan === undefined || holeGroups.some((group) => group.resolution.centers === undefined || group.resolution.diameter === undefined)) {
    delete validated.resolved_plan;
    const ambiguousGroup = holeGroups.find((group) => group.resolution.ambiguityDistance !== undefined);
    if (ambiguousGroup?.resolution.ambiguityDistance !== undefined) validated.clarification_visual = { type: 'svg', content: ambiguitySvg(ambiguousGroup.resolution.ambiguityDistance) };
    return validated;
  }

  const legacyResolved = validated.resolved_plan;
  const resolutionByFeature = new Map(holeGroups.map((group) => [group.feature, group.resolution]));
  const resolvedFeatures = normalized.features.map((feature) => {
    const dependencies: Record<string, unknown> = {};
    if (typeof feature.after === 'string') dependencies.after = feature.after;
    if (typeof feature.target === 'string') dependencies.target = feature.target;
    if (feature.type === 'rectangular_pad') {
      const resolvedBase = legacyResolved.base as Record<string, unknown>;
      return { id: feature.id, type: 'rectangular_pad', width: resolvedBase.width, height: resolvedBase.height, length: resolvedBase.thickness, ...dependencies };
    }
    if (feature.type === 'hole_pattern') {
      const resolution = resolutionByFeature.get(feature)!;
      return { id: feature.id, type: 'hole_pattern', diameter: resolution.diameter, centers: resolution.centers, ...(resolution.placementSource === 'explicit' && resolution.centers?.length === 1 ? { center_editable: true } : {}), ...(resolution.grid !== undefined ? { grid: resolution.grid } : {}), operation: 'through_all', ...dependencies };
    }
    if (feature.type === 'rectangular_pocket' || feature.type === 'rectangular_addition') return rectangularResolutionByFeature.get(feature)!.resolved!;
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
