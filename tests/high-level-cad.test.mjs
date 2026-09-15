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

function runFreeCadScript(commands) {
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
    with open(${JSON.stringify(outputPath)}, "w", encoding="utf-8") as output:
        json.dump({"ok": False, "error": str(error), "traceback": traceback.format_exc()}, output)
    raise
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
    ['cad_create_part', 'cad_create_sketch', 'cad_sketch_rectangle', 'cad_inspect_sketch', 'cad_validate_sketch'],
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

test('FreeCAD integration: Document -> Body -> Sketch and fully constrained 100 x 60 rectangle', async () => {
  const bridge = new CapturingBridge([
    { documentId: 'Part100x60', bodyId: 'Part100x60::Body' },
    { sketchId: 'Part100x60::Sketch' },
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

  const execution = runFreeCadScript(bridge.commands);
  assert.equal(execution.ok, true, execution.traceback);
  const [part, sketch, rectangle, inspection, validation] = execution.results;

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
});
