import { ToolArgs, ToolResult } from '../types.js';
import { CAD_EDIT_CAPABILITY_DEFINITIONS } from './cad-edit.js';
import { CAD_CONSTRUCTION_FEATURE_SCHEMAS } from './cad-plan-validation.js';

type CapabilityStatus = 'supported' | 'unsupported' | 'not_exposed';
type JsonSchema = Record<string, unknown>;
interface CapabilityParameter {
  name: string;
  required: boolean;
  type?: string | string[];
  constant?: unknown;
  allowed_values?: unknown[];
  nested_allowed_values?: Record<string, unknown>;
}
interface ConstructionVariant {
  title: string;
  required_parameters: string[];
  optional_parameters: string[];
  parameters: CapabilityParameter[];
}
interface ConstructionCapability {
  supported: true;
  normal_feature_plan: true;
  description: string;
  constraints: string[];
  variants: ConstructionVariant[];
}

const CONSTRUCTION_METADATA: Record<string, { description: string; constraints: string[] }> = {
  rectangular_pad: {
    description: 'Create the first rectangular base solid, with width and height in XY and length in +Z.',
    constraints: ['Must be the first and only base feature.', 'Dimensions must be positive.', 'The result must be one valid solid.'],
  },
  profile_pad: {
    description: 'Create the first extruded base solid from a polygon or an explicitly closed mixed line/arc profile.',
    constraints: ['Must be the first and only base feature.', 'The outer profile must be valid and closed before execution.', 'No missing closing geometry is inferred.'],
  },
  rectangular_pocket: {
    description: 'Subtract a rectangular pocket from a supported semantic face of the current solid.',
    constraints: ['target and after must identify the current feature tip.', 'The pocket must fit the supported semantic face and remove material.', 'The resulting model must remain one valid solid.'],
  },
  hole_pattern: {
    description: 'Cut one semantic group of circular through-holes using an edge offset, explicit centers, or a rectangular grid.',
    constraints: ['The base must be supported by the current feature chain.', 'Hole centers and diameters must remain valid and non-overlapping.', 'Named groups remain independent semantic features.'],
  },
  fillet: {
    description: 'Apply a radius to a supported semantic edge selector on the current solid.',
    constraints: ['Only the exported semantic edge selectors are accepted.', 'The operation must preserve one valid solid.'],
  },
  chamfer: {
    description: 'Apply a chamfer size to a supported semantic edge selector on the current solid.',
    constraints: ['Only the exported semantic edge selectors are accepted.', 'The operation must preserve one valid solid.'],
  },
};

function record(value: unknown): JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonSchema : {};
}

function schemaType(schema: JsonSchema): string | string[] | undefined {
  const value = schema.type;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value as string[];
  return undefined;
}

function parameterDescriptor(name: string, schemaValue: unknown, required: Set<string>): CapabilityParameter {
  const schema = record(schemaValue);
  const nestedProperties = record(schema.properties);
  const nestedAllowedValues = Object.fromEntries(
    Object.entries(nestedProperties)
      .filter(([, value]) => Array.isArray(record(value).enum))
      .map(([key, value]) => [key, record(value).enum]),
  );
  return {
    name,
    required: required.has(name),
    ...(schemaType(schema) !== undefined ? { type: schemaType(schema) } : {}),
    ...(schema.const !== undefined ? { constant: schema.const } : {}),
    ...(Array.isArray(schema.enum) ? { allowed_values: schema.enum } : {}),
    ...(Object.keys(nestedAllowedValues).length > 0 ? { nested_allowed_values: nestedAllowedValues } : {}),
  };
}

function deriveConstructionFeatures(): Record<string, ConstructionCapability> {
  const grouped = new Map<string, ConstructionVariant[]>();
  for (const sourceSchema of CAD_CONSTRUCTION_FEATURE_SCHEMAS) {
    const schema = sourceSchema as unknown as JsonSchema;
    const properties = record(schema.properties);
    const featureType = record(properties.type).const;
    if (typeof featureType !== 'string') throw new Error('Construction feature schema is missing its type discriminator.');
    const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === 'string') : []);
    const parameters = Object.entries(properties).map(([name, value]) => parameterDescriptor(name, value, required));
    const variant = {
      title: typeof schema.title === 'string' ? schema.title : featureType,
      required_parameters: parameters.filter((parameter) => parameter.required).map((parameter) => parameter.name),
      optional_parameters: parameters.filter((parameter) => !parameter.required).map((parameter) => parameter.name),
      parameters,
    };
    grouped.set(featureType, [...(grouped.get(featureType) ?? []), variant]);
  }

  return Object.fromEntries([...grouped.entries()].map(([featureType, variants]) => {
    const metadata = CONSTRUCTION_METADATA[featureType];
    if (metadata === undefined) throw new Error(`Missing semantic capability metadata for ${featureType}.`);
    return [featureType, {
      supported: true,
      normal_feature_plan: true,
      description: metadata.description,
      constraints: metadata.constraints,
      variants,
    }];
  }));
}

export function getCadCapabilities() {
  return {
    version: 1,
    units: ['mm'],
    source_of_truth: {
      auto_derived: [
        'construction feature types',
        'required and optional construction parameters',
        'feature and parameter enum values',
      ],
      manual_semantic_metadata: [
        'planner-oriented feature descriptions and constraints',
        'conditional edit applicability',
        'high-level model-structure exposure limits',
      ],
    },
    construction_features: deriveConstructionFeatures(),
    editing: {
      unit: 'mm',
      validation_gate_required: true,
      features: CAD_EDIT_CAPABILITY_DEFINITIONS,
      constraints: [
        'The target must be a managed semantic feature with the required persistent bindings.',
        'Validation checks model revision, plan digest, old value, the fully updated plan, and geometric validity.',
        'Execution recomputes and independently verifies the actual BREP; verification failure triggers explicit rollback.',
      ],
    },
    model_structure: {
      single_managed_body: { status: 'supported' as CapabilityStatus, detail: 'A feature plan creates and verifies one PartDesign Body and one valid resulting solid.' },
      semantic_feature_chain: { status: 'supported' as CapabilityStatus, detail: 'Features use stable semantic IDs and predecessor/target relationships.' },
      multiple_documents: { status: 'supported' as CapabilityStatus, detail: 'Independent plan executions may create independent managed documents.' },
      multiple_components: { status: 'not_exposed' as CapabilityStatus, detail: 'The High-Level Feature Plan has no multi-component or assembly representation.' },
      multiple_bodies: { status: 'not_exposed' as CapabilityStatus, detail: 'One managed Feature Plan is bound to one PartDesign Body.' },
      separate_component: { status: 'not_exposed' as CapabilityStatus, detail: 'No construction feature creates a second independent component inside one plan.' },
      independent_lid: { status: 'not_exposed' as CapabilityStatus, detail: 'There is no lid-specific or second-component feature in the High-Level Feature Plan.' },
      general_boolean: { status: 'not_exposed' as CapabilityStatus, detail: 'Arbitrary boolean operands are not part of the High-Level Feature Plan.' },
      arbitrary_face_sketch: { status: 'not_exposed' as CapabilityStatus, detail: 'Planner-facing construction uses exported semantic faces, never FaceN indices.' },
    },
  };
}

export function serializeCadCapabilitiesForPlanner(capabilities = getCadCapabilities()): string {
  const lines = ['CAD CAPABILITIES V1', '', 'CONSTRUCTION'];
  for (const [featureType, featureValue] of Object.entries(capabilities.construction_features)) {
    lines.push('', featureType);
    for (const variant of featureValue.variants) {
      lines.push(`Required (${variant.title}): ${variant.required_parameters.join(', ') || 'none'}`);
      lines.push(`Optional (${variant.title}): ${variant.optional_parameters.join(', ') || 'none'}`);
      const faces = variant.parameters.find((parameter) => parameter.name === 'face')?.allowed_values;
      if (faces !== undefined) lines.push(`Faces: ${faces.join(', ')}`);
    }
  }
  lines.push('', 'EDITING');
  for (const [featureType, definition] of Object.entries(capabilities.editing.features)) {
    lines.push(`${featureType}: ${definition.parameters.join(', ')}`);
  }
  lines.push('', 'STRUCTURE');
  for (const [name, value] of Object.entries(capabilities.model_structure)) lines.push(`${name}: ${value.status}`);
  return lines.join('\n');
}

export const CAD_CAPABILITY_TOOLS = [{
  name: 'cad_get_capabilities',
  description: 'Return the deterministic, read-only High-Level CAD capability manifest and a compact planner snapshot. Works without an open FreeCAD document and does not use a validation gate.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    additionalProperties: false,
  },
}];

export function handleCadGetCapabilities(args: ToolArgs): ToolResult {
  if (Object.keys(args).length > 0) {
    return {
      content: [{ type: 'text', text: JSON.stringify({
        code: 'UNEXPECTED_FIELD',
        message: 'cad_get_capabilities accepts no arguments.',
      }) }],
      isError: true,
    };
  }
  const capabilities = getCadCapabilities();
  return {
    content: [{ type: 'text', text: JSON.stringify({ ...capabilities, planner_snapshot: serializeCadCapabilitiesForPlanner(capabilities) }) }],
  };
}
