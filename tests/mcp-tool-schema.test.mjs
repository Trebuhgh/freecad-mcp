import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const esp32Plan = {
  unit: 'mm',
  features: [
    { id: 'outer_body', type: 'rectangular_pad', width: 59.95, height: 32.97, length: 14 },
    { id: 'inner_cavity', type: 'rectangular_pocket', face: 'top', width: 55.95, height: 28.97, depth: 12, position: { x: 2, y: 2 }, target: 'outer_body', after: 'outer_body' },
    { id: 'usb_cutout', type: 'rectangular_pocket', face: 'front', width: 12, height: 7, depth: 2, position: { x: 23.975, y: 4 }, target: 'inner_cavity', after: 'inner_cavity' },
  ],
};

async function withMcpClient(callback) {
  const client = new Client({ name: 'freecad-schema-regression', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: { ...process.env, FREECAD_MCP_TOOL_MODE: 'high-level' },
    stderr: 'pipe',
  });
  await client.connect(transport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

test('live MCP tools/list exports explicit feature schemas for rectangular pockets and additions', async () => {
  await withMcpClient(async (client) => {
    const listed = await client.listTools();
    const tool = listed.tools.find((candidate) => candidate.name === 'cad_validate_plan');
    assert.ok(tool, 'cad_validate_plan missing from live MCP tools/list response');
    const advanced = tool.inputSchema.properties.plan.oneOf.find((candidate) => candidate.title === 'Advanced Feature Plan (compatibility)');
    const featureSchemas = advanced.properties.features.items.oneOf;
    assert.equal(featureSchemas.length, 8);
    const pocket = featureSchemas.find((candidate) => candidate.properties.type.const === 'rectangular_pocket');
    assert.ok(pocket, 'rectangular_pocket branch missing from live MCP schema');
    assert.deepEqual(Object.keys(pocket.properties), ['id', 'type', 'face', 'width', 'height', 'depth', 'position', 'after', 'target']);
    assert.deepEqual(pocket.required, ['type', 'face', 'width', 'height', 'depth', 'position', 'after', 'target']);
    assert.deepEqual(pocket.properties.position.required, ['x', 'y']);
    assert.equal(pocket.additionalProperties, false);
    assert.equal(Object.hasOwn(pocket.properties, 'operation'), false);
    const addition = featureSchemas.find((candidate) => candidate.properties.type.const === 'rectangular_addition');
    assert.ok(addition, 'rectangular_addition branch missing from live MCP schema');
    assert.deepEqual(Object.keys(addition.properties), ['id', 'type', 'face', 'width', 'height', 'length', 'position', 'after', 'target']);
    assert.deepEqual(addition.required, ['type', 'face', 'width', 'height', 'length', 'position', 'after', 'target']);
    assert.equal(addition.additionalProperties, false);
    assert.equal(Object.hasOwn(addition.properties, 'depth'), false);
    assert.equal(Object.hasOwn(addition.properties, 'operation'), false);
    const holes = featureSchemas.find((candidate) => candidate.properties.type.const === 'hole_pattern');
    assert.ok(Object.hasOwn(holes.properties, 'operation'));
  });
});

test('live MCP call preserves the complete rectangular_pocket ESP32 plan', async () => {
  await withMcpClient(async (client) => {
    const response = await client.callTool({ name: 'cad_validate_plan', arguments: { plan: esp32Plan } });
    assert.equal(response.isError, undefined);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.status, 'valid', JSON.stringify(result));
    assert.equal(result.can_execute, true);
    assert.deepEqual(result.resolved_plan.features[1], {
      id: 'inner_cavity', type: 'rectangular_pocket', face: 'top', width: 55.95, height: 28.97,
      position: { x: 2, y: 2 }, depth: 12,
      box: { min_x: 2, max_x: 57.95, min_y: 2, max_y: 30.97, min_z: 2, max_z: 14 },
      after: 'outer_body', target: 'outer_body',
    });
    assert.deepEqual(result.resolved_plan.features[2], {
      id: 'usb_cutout', type: 'rectangular_pocket', face: 'front', width: 12, height: 7,
      position: { x: 23.975, y: 4 }, depth: 2,
      box: { min_x: 23.975, max_x: 35.975, min_y: 0, max_y: 2, min_z: 4, max_z: 11 },
      after: 'inner_cavity', target: 'inner_cavity',
    });
  });
});
