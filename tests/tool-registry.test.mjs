import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FULL_TOOLS,
  LOW_LEVEL_TOOLS,
  getRegisteredTools,
  resolveToolMode,
} from '../dist/tool-registry.js';

const expectedHighLevelNames = [
  'cad_create_part',
  'cad_create_sketch',
  'cad_sketch_rectangle',
  'cad_inspect_sketch',
  'cad_validate_sketch',
  'cad_pad',
  'cad_create_hole_sketch',
  'cad_pocket',
  'cad_fillet',
  'cad_chamfer',
  'cad_validate_plan',
  'cad_execute_plan',
  'cad_validate_edit_plan',
  'cad_execute_edit_plan',
];

test('high-level is the default tool mode', () => {
  assert.equal(resolveToolMode(undefined), 'high-level');
  assert.equal(resolveToolMode(''), 'high-level');
});

test('high-level mode exposes only the fourteen High-Level CAD tools', () => {
  const tools = getRegisteredTools(resolveToolMode('high-level'));
  assert.deepEqual(tools.map((tool) => tool.name), expectedHighLevelNames);
  assert.equal(tools.length, 14);

  const lowLevelNames = new Set(LOW_LEVEL_TOOLS.map((tool) => tool.name));
  assert.equal(tools.some((tool) => lowLevelNames.has(tool.name)), false);
  assert.equal(tools.some((tool) => tool.name.startsWith('freecad_')), false);
});

test('full mode exposes High-Level and all existing Low-Level tools', () => {
  const tools = getRegisteredTools(resolveToolMode('full'));
  assert.equal(tools, FULL_TOOLS);
  assert.equal(tools.length, 179);
  assert.equal(LOW_LEVEL_TOOLS.length, 165);
  assert.ok(tools.some((tool) => tool.name === 'cad_create_part'));
  assert.ok(tools.some((tool) => tool.name === 'freecad_new_document'));
});

test('invalid tool modes fail closed', () => {
  assert.throws(() => resolveToolMode('legacy'), /Invalid FREECAD_MCP_TOOL_MODE/);
});
