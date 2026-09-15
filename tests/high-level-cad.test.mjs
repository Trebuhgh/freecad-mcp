import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { HIGH_LEVEL_CAD_TOOLS, handleHighLevelCadTool } from '../dist/tools/high-level-cad.js';

const freecadPython = process.env.FREECAD_PYTHON || 'C:\\Program Files\\FreeCAD 1.1\\bin\\python.exe';

class CapturingBridge {
  constructor(results) {
    this.results = [...results];
    this.commands = [];
  }

  async run(code) {
    this.commands.push(code);
    const result = this.results.shift() ?? {};
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
}

function runFreeCadScript(commands, allowFailure = false) {
  const directory = mkdtempSync(join(tmpdir(), 'freecad-mcp-test-'));
  const scriptPath = join(directory, 'integration.py');
  const outputPath = join(directory, 'result.json');
  const indentedCommands = commands
    .map((command) => command.split('\n').map((line) => `    ${line}`).join('\n'))
    .join('\n    results.append(_mcp_result["result"])\n    _mcp_result = {"success": True}\n');
  const script = `
import json
import FreeCAD
import Part

results = []
_mcp_result = {"success": True}
try:
${indentedCommands}
    results.append(_mcp_result["result"])
    with open(${JSON.stringify(outputPath)}, "w", encoding="utf-8") as output:
        json.dump({"ok": True, "results": results}, output)
except Exception as error:
    import traceback
    objects = {
        document.Name: [{"name": item.Name, "typeId": item.TypeId} for item in document.Objects]
        for document in FreeCAD.listDocuments().values()
    }
    with open(${JSON.stringify(outputPath)}, "w", encoding="utf-8") as output:
        json.dump({"ok": False, "error": str(error), "traceback": traceback.format_exc(), "objects": objects}, output)
    ${allowFailure ? 'pass' : 'raise'}
`;
  writeFileSync(scriptPath, script, 'utf8');
  try {
    execFileSync(freecadPython, [scriptPath], { stdio: 'pipe', timeout: 30000 });
    return JSON.parse(readFileSync(outputPath, 'utf8'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('public schemas expose neither GeometryIndex nor PointPos', () => {
  const publicArgumentNames = HIGH_LEVEL_CAD_TOOLS.flatMap((tool) => Object.keys(tool.inputSchema.properties));
  assert.equal(publicArgumentNames.some((name) => name.toLowerCase() === 'geometryindex'), false);
  assert.equal(publicArgumentNames.some((name) => name.toLowerCase() === 'pointpos'), false);
  assert.deepEqual(
    HIGH_LEVEL_CAD_TOOLS.map((tool) => tool.name),
    [
      'cad_create_part',
      'cad_create_sketch',
      'cad_sketch_rectangle',
      'cad_inspect_sketch',
      'cad_validate_sketch',
      'cad_pad',
      'cad_create_hole_sketch',
      'cad_pocket',
    ],
  );
});

test('server-side validation rejects hidden index arguments', async () => {
  const bridge = new CapturingBridge([]);
  await assert.rejects(
    handleHighLevelCadTool('cad_sketch_rectangle', {
      sketch: 'Part100x60::Sketch', x: 0, y: 0, width: 100, height: 60, geometryIndex: 0,
    }, bridge),
    /Unexpected argument/,
  );
  assert.equal(bridge.commands.length, 0);
});

test('FreeCAD integration: 100 x 60 x 10 plate receives four through holes with diameter 8', async () => {
  const bridge = new CapturingBridge([
    { documentId: 'Part100x60', bodyId: 'Part100x60::Body' },
    { sketchId: 'Part100x60::Sketch' },
    {},
    {},
    {},
    {},
    {},
    {},
  ]);

  await handleHighLevelCadTool('cad_create_part', { name: 'Part100x60' }, bridge);
  await handleHighLevelCadTool('cad_create_sketch', { body: 'Part100x60::Body', plane: 'XY' }, bridge);
  await handleHighLevelCadTool('cad_sketch_rectangle', {
    sketch: 'Part100x60::Sketch', x: 0, y: 0, width: 100, height: 60,
  }, bridge);
  await handleHighLevelCadTool('cad_inspect_sketch', { sketch: 'Part100x60::Sketch' }, bridge);
  await handleHighLevelCadTool('cad_validate_sketch', { sketch: 'Part100x60::Sketch' }, bridge);
  await handleHighLevelCadTool('cad_pad', { sketch: 'Part100x60::Sketch', length: 10 }, bridge);
  await handleHighLevelCadTool('cad_create_hole_sketch', {
    body: 'Part100x60::Body',
    plane: 'XY',
    holes: [
      { x: 10, y: 10, diameter: 8 },
      { x: 90, y: 10, diameter: 8 },
      { x: 10, y: 50, diameter: 8 },
      { x: 90, y: 50, diameter: 8 },
    ],
  }, bridge);
  await handleHighLevelCadTool('cad_pocket', {
    sketch: 'Part100x60::HoleSketch', type: 'through_all',
  }, bridge);

  const execution = runFreeCadScript(bridge.commands);
  assert.equal(execution.ok, true, execution.traceback);
  const [part, sketch, rectangle, inspection, validation, pad, holeSketch, pocket] = execution.results;

  assert.equal(part.bodyCount, 1);
  assert.equal(part.documentId, 'Part100x60');
  assert.equal(part.bodyId, 'Part100x60::Body');
  assert.equal(sketch.bodyId, part.bodyId);
  assert.equal(sketch.sketchId, 'Part100x60::Sketch');
  assert.equal(sketch.insideBody, true);

  assert.equal(rectangle.rectangle.width, 100);
  assert.equal(rectangle.rectangle.height, 60);
  assert.equal(rectangle.openContours, 0);
  assert.equal(rectangle.closedContours, 1);
  assert.equal(rectangle.fullyConstrained, true);
  assert.equal(rectangle.degreesOfFreedom, 0);
  assert.ok(rectangle.constraintTypes.includes('Horizontal'));
  assert.ok(rectangle.constraintTypes.includes('Vertical'));

  assert.equal(inspection.geometryCount, 4);
  assert.equal(inspection.constraintCount, 12);
  assert.equal(inspection.openContours, 0);
  assert.equal(inspection.closedContours, 1);
  assert.equal(inspection.fullyConstrained, true);
  assert.equal(inspection.degreesOfFreedom, 0);
  assert.deepEqual(inspection.solverErrors, []);
  assert.deepEqual(inspection.geometryTypes, ['LineSegment', 'LineSegment', 'LineSegment', 'LineSegment']);

  assert.equal(validation.ok, true);
  assert.equal(validation.fullyConstrained, true);
  assert.equal(validation.closedProfile, true);
  assert.equal(validation.suitableForPad, true);
  assert.deepEqual(validation.solverErrors, []);
  assert.deepEqual(validation.warnings, []);

  assert.equal(pad.document, 'Part100x60');
  assert.equal(pad.body, 'Part100x60::Body');
  assert.equal(pad.sketch, 'Part100x60::Sketch');
  assert.equal(pad.pad, 'Part100x60::Pad');
  assert.equal(pad.typeId, 'PartDesign::Pad');
  assert.equal(pad.length, 10);
  assert.equal(pad.valid, true);
  assert.equal(pad.error, null);
  assert.equal(pad.solidCount, 1);
  assert.ok(pad.volume > 0);
  assert.ok(Math.abs(pad.boundingBox.xLength - 100) < 1e-7);
  assert.ok(Math.abs(pad.boundingBox.yLength - 60) < 1e-7);
  assert.ok(Math.abs(pad.boundingBox.zLength - 10) < 1e-7);

  assert.equal(holeSketch.holeCount, 4);
  assert.equal(holeSketch.geometryCount, 4);
  assert.equal(holeSketch.constraintCount, 12);
  assert.equal(holeSketch.closedContours, 4);
  assert.equal(holeSketch.degreesOfFreedom, 0);
  assert.equal(holeSketch.fullyConstrained, true);
  assert.deepEqual(holeSketch.solverErrors, []);
  assert.deepEqual(holeSketch.geometryTypes, ['Circle', 'Circle', 'Circle', 'Circle']);

  const expectedVolume = 100 * 60 * 10 - 4 * Math.PI * 4 ** 2 * 10;
  assert.equal(pocket.typeId, 'PartDesign::Pocket');
  assert.equal(pocket.type, 'through_all');
  assert.equal(pocket.valid, true);
  assert.equal(pocket.error, null);
  assert.equal(pocket.solidCount, 1);
  assert.equal(pocket.cylindricalFaceCount, 4);
  assert.ok(Math.abs(pocket.boundingBox.xLength - 100) < 1e-7);
  assert.ok(Math.abs(pocket.boundingBox.yLength - 60) < 1e-7);
  assert.ok(Math.abs(pocket.boundingBox.zLength - 10) < 1e-7);
  assert.ok(Math.abs(pocket.volume - expectedVolume) < 1e-4);
});

test('cad_pad rejects non-positive length before FreeCAD mutation', async () => {
  for (const length of [0, -1]) {
    const bridge = new CapturingBridge([]);
    await assert.rejects(
      handleHighLevelCadTool('cad_pad', { sketch: 'Part100x60::Sketch', length }, bridge),
      /Invalid length/,
    );
    assert.equal(bridge.commands.length, 0);
  }
});

test('hole and Pocket inputs are rejected before FreeCAD mutation', async () => {
  for (const holes of [[], [{ x: 10, y: 10, diameter: 0 }], [{ x: 10, y: 10, diameter: -8 }]]) {
    const bridge = new CapturingBridge([]);
    await assert.rejects(
      handleHighLevelCadTool('cad_create_hole_sketch', { body: 'Part::Body', holes }, bridge),
      /Invalid holes/,
    );
    assert.equal(bridge.commands.length, 0);
  }

  const bridge = new CapturingBridge([]);
  await assert.rejects(
    handleHighLevelCadTool('cad_pocket', { sketch: 'Part::HoleSketch', type: 'length', length: 0 }, bridge),
    /Invalid length/,
  );
  assert.equal(bridge.commands.length, 0);
});

test('cad_pocket fails cleanly when its Body has no base solid', async () => {
  const bridge = new CapturingBridge([{}, {}, {}]);
  await handleHighLevelCadTool('cad_create_part', { name: 'NoSolidPart' }, bridge);
  await handleHighLevelCadTool('cad_create_hole_sketch', {
    body: 'NoSolidPart::Body', holes: [{ x: 10, y: 10, diameter: 8 }],
  }, bridge);
  await handleHighLevelCadTool('cad_pocket', {
    sketch: 'NoSolidPart::HoleSketch', type: 'through_all',
  }, bridge);

  const execution = runFreeCadScript(bridge.commands, true);
  assert.equal(execution.ok, false);
  assert.match(execution.error, /POCKET_BASE_SOLID_NOT_FOUND/);
  assert.deepEqual(execution.objects.NoSolidPart.filter((object) => object.typeId === 'PartDesign::Pocket'), []);
});
