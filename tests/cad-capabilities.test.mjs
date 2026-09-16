import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  CAD_CAPABILITY_TOOLS,
  getCadCapabilities,
  serializeCadCapabilitiesForPlanner,
} from '../dist/tools/cad-capabilities.js';
import { CAD_CONSTRUCTION_FEATURE_SCHEMAS, CadPlanValidationGate } from '../dist/tools/cad-plan-validation.js';
import { CadEditValidationGate } from '../dist/tools/cad-edit.js';
import { handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';
import { getRegisteredTools } from '../dist/tool-registry.js';

const expectedFeatureTypes = ['rectangular_pad', 'profile_pad', 'rectangular_pocket', 'rectangular_addition', 'hole_pattern', 'fillet', 'chamfer'];

function payload(result) {
  return JSON.parse(result.content[0].text);
}

test('cad_get_capabilities is registered in high-level mode with an empty strict schema', () => {
  const registered = getRegisteredTools('high-level');
  const tool = registered.find((candidate) => candidate.name === 'cad_get_capabilities');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
  assert.equal(tool, CAD_CAPABILITY_TOOLS[0]);
});

test('cad_get_capabilities is read-only and independent of both validation gates and FreeCAD', async () => {
  const bridge = { run() { throw new Error('cad_get_capabilities must never call FreeCAD'); } };
  const planGate = new CadPlanValidationGate();
  const editGate = new CadEditValidationGate();
  const result = await handleHighLevelCadTool('cad_get_capabilities', {}, bridge, planGate, editGate);
  assert.equal(result.isError, undefined);
  assert.equal(planGate.state, 'unvalidated');
  assert.equal(editGate.state, 'unvalidated');
  assert.equal(payload(result).version, 1);
});

test('construction capabilities contain every type exported by the real Feature Plan schema', () => {
  const schemaTypes = [...new Set(CAD_CONSTRUCTION_FEATURE_SCHEMAS.map((schema) => schema.properties.type.const))];
  const manifestTypes = Object.keys(getCadCapabilities().construction_features);
  assert.deepEqual(manifestTypes, expectedFeatureTypes);
  assert.deepEqual(manifestTypes, schemaTypes);
});

test('rectangular_pocket parameters and faces are derived exactly from its public schema', () => {
  const manifestPocket = getCadCapabilities().construction_features.rectangular_pocket.variants[0];
  const schemaPocket = CAD_CONSTRUCTION_FEATURE_SCHEMAS.find((schema) => schema.properties.type.const === 'rectangular_pocket');
  assert.ok(schemaPocket);
  assert.deepEqual(manifestPocket.required_parameters, schemaPocket.required);
  assert.deepEqual(manifestPocket.optional_parameters, ['id']);
  assert.deepEqual(manifestPocket.parameters.find((parameter) => parameter.name === 'face').allowed_values, ['top', 'front', 'back', 'left', 'right']);
  assert.equal(manifestPocket.parameters.some((parameter) => parameter.name === 'operation'), false);
});

test('rectangular_addition is schema-derived with semantic faces and no edit capability', () => {
  const manifest = getCadCapabilities();
  const addition = manifest.construction_features.rectangular_addition.variants[0];
  const schema = CAD_CONSTRUCTION_FEATURE_SCHEMAS.find((candidate) => candidate.properties.type.const === 'rectangular_addition');
  assert.ok(schema);
  assert.deepEqual(addition.required_parameters, schema.required);
  assert.deepEqual(addition.optional_parameters, ['id']);
  assert.deepEqual(addition.parameters.find((parameter) => parameter.name === 'face').allowed_values, ['top', 'front', 'back', 'left', 'right']);
  assert.equal(addition.parameters.some((parameter) => parameter.name === 'depth' || parameter.name === 'operation'), false);
  assert.equal(Object.hasOwn(manifest.editing.features, 'rectangular_addition'), false);
});

test('edit capabilities describe the exact implemented parameter cases', () => {
  const editing = getCadCapabilities().editing.features;
  assert.deepEqual(editing.rectangular_pad.parameters, ['width', 'height', 'length']);
  assert.deepEqual(editing.hole_pattern.parameters, ['diameter', 'center_x', 'center_y', 'spacing_x', 'spacing_y']);
  assert.match(editing.hole_pattern.parameter_cases.center_x, /one explicitly positioned hole/);
  assert.match(editing.hole_pattern.parameter_cases.spacing_x, /rectangular grid/);
  assert.match(editing.hole_pattern.parameter_cases.spacing_y, /more than one row/);
});

test('structural limitations distinguish High-Level exposure from FreeCAD capability', () => {
  const structure = getCadCapabilities().model_structure;
  assert.equal(structure.single_managed_body.status, 'supported');
  for (const name of ['multiple_components', 'multiple_bodies', 'separate_component', 'independent_lid', 'general_boolean', 'arbitrary_face_sketch']) {
    assert.equal(structure[name].status, 'not_exposed');
  }
});

test('planner snapshot is deterministic and contains construction, editing, and structure sections', () => {
  const first = serializeCadCapabilitiesForPlanner();
  assert.equal(first, serializeCadCapabilitiesForPlanner());
  assert.match(first, /^CAD CAPABILITIES V1/);
  assert.match(first, /rectangular_pocket/);
  assert.match(first, /Faces: top, front, back, left, right/);
  assert.match(first, /spacing_x/);
  assert.match(first, /independent_lid: not_exposed/);
});

test('cad_get_capabilities rejects arguments without changing validation state', async () => {
  const planGate = new CadPlanValidationGate();
  const result = await handleHighLevelCadTool('cad_get_capabilities', { unexpected: true }, {}, planGate, new CadEditValidationGate());
  assert.equal(result.isError, true);
  assert.equal(payload(result).code, 'UNEXPECTED_FIELD');
  assert.equal(planGate.state, 'unvalidated');
});

test('live MCP tools/list and callTool expose the read-only capability manifest', async () => {
  const client = new Client({ name: 'freecad-capability-regression', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { ...process.env, FREECAD_MCP_TOOL_MODE: 'high-level' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'cad_get_capabilities');
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema, { type: 'object', properties: {}, additionalProperties: false });
    const response = await client.callTool({ name: 'cad_get_capabilities', arguments: {} });
    assert.equal(response.isError, undefined);
    const manifest = JSON.parse(response.content[0].text);
    assert.deepEqual(Object.keys(manifest.construction_features), expectedFeatureTypes);
    assert.equal(manifest.model_structure.multiple_components.status, 'not_exposed');
    assert.match(manifest.planner_snapshot, /CAD CAPABILITIES V1/);
  } finally {
    await client.close();
  }
});
