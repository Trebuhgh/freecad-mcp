import { ADVANCED_OPERATION_TOOLS } from './tools/advanced-operations.js';
import { ASSEMBLY_TOOLS } from './tools/assembly.js';
import { BIM_TOOLS } from './tools/bim.js';
import { DOCUMENT_TOOLS } from './tools/document.js';
import { DRAFT_TOOLS } from './tools/draft.js';
import { FEM_TOOLS } from './tools/fem.js';
import { HIGH_LEVEL_CAD_TOOLS } from './tools/high-level-cad.js';
import { IMPORT_EXPORT_TOOLS } from './tools/import-export.js';
import { MESH_TOOLS } from './tools/mesh.js';
import { OPERATION_TOOLS } from './tools/operations.js';
import { PART_DESIGN_TOOLS } from './tools/part-design.js';
import { PRIMITIVE_TOOLS } from './tools/primitives.js';
import { SKETCHER_TOOLS } from './tools/sketcher.js';
import { SPREADSHEET_TOOLS } from './tools/spreadsheet.js';
import { SURFACE_TOOLS } from './tools/surface.js';
import { TECHDRAW_TOOLS } from './tools/techdraw.js';

export type ToolMode = 'high-level' | 'full';

export const LOW_LEVEL_TOOLS = [
  ...DOCUMENT_TOOLS,
  ...PRIMITIVE_TOOLS,
  ...OPERATION_TOOLS,
  ...SKETCHER_TOOLS,
  ...PART_DESIGN_TOOLS,
  ...IMPORT_EXPORT_TOOLS,
  ...DRAFT_TOOLS,
  ...MESH_TOOLS,
  ...TECHDRAW_TOOLS,
  ...ADVANCED_OPERATION_TOOLS,
  ...SPREADSHEET_TOOLS,
  ...BIM_TOOLS,
  ...FEM_TOOLS,
  ...SURFACE_TOOLS,
  ...ASSEMBLY_TOOLS,
];

export const FULL_TOOLS = [
  ...HIGH_LEVEL_CAD_TOOLS,
  ...LOW_LEVEL_TOOLS,
];

export function resolveToolMode(value: string | undefined): ToolMode {
  if (value === undefined || value.trim() === '') {
    return 'high-level';
  }
  if (value === 'high-level' || value === 'full') {
    return value;
  }
  throw new Error(`Invalid FREECAD_MCP_TOOL_MODE: ${value}. Expected "high-level" or "full".`);
}

export function getRegisteredTools(mode: ToolMode) {
  return mode === 'full' ? FULL_TOOLS : HIGH_LEVEL_CAD_TOOLS;
}
