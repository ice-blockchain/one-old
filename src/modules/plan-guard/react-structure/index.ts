// src/modules/plan-guard/react-structure/index.ts
// Structural analyzer entry: analyzeStructureText plus the re-export barrel
// that keeps every original './react-structure' import specifier working.

import {
  canonicalRoutePath,
  type ArchitectureExceptionRequestV1,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import type { CapabilityProfileV1 } from '../../../shared/capabilities';

import {
  type StructureFinding,
} from './types';
import {
  normalizeRel,
} from './parse';
import {
  analyzeText,
} from './analyze';
import {
  localFindings,
} from './findings';

export function analyzeStructureText(
  file: string,
  text: string,
  profile: CapabilityProfileV1,
  exceptions: ArchitectureExceptionRequestV1[] = [],
): StructureFinding[] {
  return localFindings(analyzeText(normalizeRel(file), text), profile, exceptions);
}


export {
  STRUCTURE_REPORT_SCHEMA_VERSION,
  STRUCTURE_SCAN_DEFAULT_MAX_FILES,
  type StructureFinding,
  type StructureFindingId,
  type StructureReportV1,
  type StructureScanOptions,
} from './types';
export {
  analyzeStructureTextAgainstContract,
  type StructureTextContractOptions,
} from './contract';
export {
  analyzeProjectStructure,
  invalidateStructureCache,
  writeStructureReport,
} from './scan';
