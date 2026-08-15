// src/modules/plan-guard/react-structure/repair.ts
// Restore compiled integration wiring at IMPLEMENTED on hosts whose work
// units are file-disjoint (OpenCode/Kilo). Same auto-fix doctrine as kebab
// retarget and the missing-delegate-block rewrite.
//
// OpenCode work units cannot edit the app shell. The seeded shell used to
// import pages for `<Route>` and nothing else, so a feature/component unit
// that the agent filled in stayed unimported. When a later unit overwrote
// App.tsx and dropped `<Routes>`, every contract route mismatched, the deny
// named the PAGE file, and the digest write looped until STOP RETRYING.
//
// Claude Code / Cursor / Codex workers CAN edit the shell. Calling this
// from their IMPLEMENTED write rewrites App.tsx with no tool call from the
// worker. Claude Code then injects: the file was modified by the user or a
// linter; the change is intentional; do not mention this. Workers report
// that as sabotage and stop trusting every other gate. The caller therefore
// invokes this only when `hostFlags().disjointWorkUnitFiles` is set; other
// hosts keep the structure deny and let the worker re-issue the shell.
//
// This module:
//   - rewrites the app shell to the compiled skeleton when the shell itself
//     has no literal router table and every delivered contract route is
//     unproven (the lost-`<Routes>` class);
//   - otherwise injects namespace imports for remaining STRUCT_ORPHAN_MODULE
//     outputs into the shell (export-shape-blind; the analyzer matches the
//     specifier).
// Greenfield only — the caller stands down on a tree Traffic One did not
// scaffold. A shell that already proves some routes is never overwritten.

import * as fs from 'fs';
import * as path from 'path';

import { readRegularFileResult } from '../../../shared/bounded-read';
import {
  compiledUiNamespaceImports,
  moduleOutputVariants,
  moduleSkeleton,
  type CompiledArchitectureV1,
} from '../../../shared/architecture-contract';
import { isSymlink, writeFileNoFollow } from '../../../shared/fs-nofollow';

import { analyzeText } from './analyze';
import { analyzeProjectStructure, invalidateStructureCache } from './scan';
import type { StructureFinding } from './types';

function resolveInsideProject(projectRoot: string, rel: string): string | null {
  const normalized = rel.replace(/\\/g, '/');
  if (!normalized || path.isAbsolute(normalized) || normalized.includes('\0')) return null;
  if (normalized.split('/').some((part) => part === '..')) return null;
  const absolute = path.resolve(projectRoot, normalized);
  const root = path.resolve(projectRoot);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

function writeShellFile(projectRoot: string, rel: string, body: string): boolean {
  const absolute = resolveInsideProject(projectRoot, rel);
  if (!absolute || isSymlink(absolute)) return false;
  try {
    const dir = path.dirname(absolute);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    writeFileNoFollow(absolute, body, 'truncate');
    invalidateStructureCache(absolute);
    return true;
  } catch {
    return false;
  }
}

function insertAfterImports(text: string, block: string): string {
  const lines = text.split('\n');
  let cursor = 0;
  while (cursor < lines.length) {
    const trimmed = lines[cursor]!.trim();
    if (
      trimmed === ''
      || trimmed.startsWith('//')
      || trimmed.startsWith('/*')
      || trimmed === "'use client';"
      || trimmed === '"use client";'
    ) {
      cursor += 1;
      continue;
    }
    break;
  }
  let last = cursor - 1;
  let inImport = false;
  for (let index = cursor; index < lines.length; index += 1) {
    const line = lines[index]!;
    const trimmed = line.trim();
    if (!inImport && /^import\b/.test(trimmed)) {
      last = index;
      inImport = !line.includes(';');
      continue;
    }
    if (inImport) {
      last = index;
      if (line.includes(';')) inImport = false;
      continue;
    }
    break;
  }
  lines.splice(last + 1, 0, block);
  return lines.join('\n');
}

function wiringErrors(findings: readonly StructureFinding[]): StructureFinding[] {
  return findings.filter((finding) => (
    finding.severity === 'error'
    && (finding.id === 'STRUCT_ORPHAN_MODULE' || finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH')
  ));
}

function deliveredContractRoutes(projectRoot: string, contract: CompiledArchitectureV1) {
  return contract.routes.filter((route) => {
    if (route.redirect === true || !route.moduleOutput) return false;
    const routeModule = contract.modules.find((module) => module.output === route.moduleOutput);
    const variants = routeModule ? moduleOutputVariants(routeModule) : [route.moduleOutput];
    return variants.some((variant) => fs.existsSync(path.join(projectRoot, variant)));
  });
}

/**
 * Restore compiled route + feature/component wiring on the app shell.
 * Returns the relative paths written (empty when nothing changed).
 */
export function repairCompiledIntegrationWiring(
  projectRoot: string,
  contract: CompiledArchitectureV1,
): string[] {
  const shell = contract.modules.find((module) => module.kind === 'app-shell');
  if (!shell) return [];
  const skeleton = moduleSkeleton(contract, shell);
  if (!skeleton || !skeleton.content.includes('<Routes>')) return [];

  const report = analyzeProjectStructure(projectRoot, contract, { greenfield: true });
  const errors = wiringErrors(report.findings);
  if (errors.length === 0) return [];

  const absolute = resolveInsideProject(projectRoot, shell.output);
  if (!absolute) return [];
  const read = readRegularFileResult(absolute);
  if (read.kind === 'unreadable') return [];

  const delivered = deliveredContractRoutes(projectRoot, contract);
  const allRoutesUnproven = delivered.length > 0 && delivered.every((route) => (
    errors.some((finding) => (
      finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH' && finding.file === route.moduleOutput
    ))
  ));
  const nonLiteral = errors.some((finding) => (
    finding.id === 'STRUCT_ROUTE_MODULE_MISMATCH' && finding.message.includes('non-literal route path')
  )) || report.findings.some((finding) => finding.id === 'STRUCT_ROUTE_PATH_UNRESOLVED');

  const existing = read.kind === 'text' ? read.text : '';
  const shellAnalysis = existing.trim().length > 0
    ? analyzeText(shell.output, existing)
    : { routes: [] as { path: string }[], unresolvedRoutes: [] as unknown[] };
  const shellLostRouter = shellAnalysis.routes.length === 0
    && shellAnalysis.unresolvedRoutes.length === 0;

  if (allRoutesUnproven && !nonLiteral && shellLostRouter) {
    if (existing === skeleton.content) return [];
    return writeShellFile(projectRoot, shell.output, skeleton.content) ? [shell.output] : [];
  }

  const orphanOutputs = new Set(
    errors.filter((finding) => finding.id === 'STRUCT_ORPHAN_MODULE').map((finding) => finding.file),
  );
  if (orphanOutputs.size === 0 || existing.trim().length === 0) return [];
  const missing = compiledUiNamespaceImports(contract, shell.output).filter((entry) => {
    if (!orphanOutputs.has(entry.output)) return false;
    return !existing.includes(`'${entry.specifier}'`) && !existing.includes(`"${entry.specifier}"`);
  });
  if (missing.length === 0) return [];
  const block = [
    '// Compiled feature/component modules must be imported from a live module',
    '// (STRUCT_ORPHAN_MODULE). Replace these namespace imports with the page',
    '// that actually renders each one.',
    ...missing.map((entry) => entry.line),
    `void [${missing.map((entry) => entry.local).join(', ')}];`,
  ].join('\n');
  const next = insertAfterImports(existing, block);
  if (next === existing) return [];
  return writeShellFile(projectRoot, shell.output, next) ? [shell.output] : [];
}
