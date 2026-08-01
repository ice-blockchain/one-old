// src/modules/plan-guard/plan-readiness/satisfiability.ts
// The PLAN_READY satisfiability sweep: before a compiled contract may publish,
// every output it DEMANDS is pushed through the same blocking write gates the
// implementer will face. A contract that requires a file its own gates deny is
// unsatisfiable — the implementer is hard-denied on a mandatory output, the fix
// cycle cannot replan, and the run deadlocks (observed three times: 12co's
// reviewer-ordered `apps/web/public/llms.txt` that no allowlist owned, 13co's
// mandatory `index.html` scaffold whose `<title>`/`<noscript>` tripped
// STRUCT_HARDCODED_COPY, and the astro/angular crawl assets the reviewer
// baseline demands with no compiled owner). Fail closed HERE, where the
// architect can still change the semantic input, instead of mid-run where
// nobody can.
//
// One generic loop, no per-profile or per-rule conditions: candidates are
// (a) every compiled scaffoldOutput whose body is canonical runtime knowledge
// (`scaffoldFileContent`) — content conflicts are only judgeable where the
// content itself is compiled — and (b) the compliant skeleton of every module
// output (`moduleSkeletonContent`) — the exact bodies ensureScaffoldContent
// materializes at PLAN_READY, so what the sweep certifies is what greenfield
// implementers actually inherit. Where no skeleton is generated the candidate
// falls back to the EMPTY module: every gate on this path judges path shape
// plus authored content, so a finding that fires on the empty write is
// content-independent and would deny every possible implementation of that
// output. Deliberately in-memory only (contents are injected, mirroring
// validateI18nCatalogs' contentOverrides) — the sweep runs at every PLAN_READY
// and adds no filesystem scans of its own.

import {
  moduleSkeletonContent,
  scaffoldFileContent,
  type CompiledArchitectureV1,
  type RuntimeAssignmentsV1,
} from '../../../shared/architecture-contract';
import { profileHasWebUi } from '../../../shared/capabilities';
import {
  analyzeI18nSourceText,
  I18N_SOURCE_RE,
} from '../../../shared/i18n-enforcement';
import { planStaticViolations } from '../plan-static';
import { analyzeStructureTextAgainstContract } from '../react-structure';

import { roleContract } from './contracts';

export interface ContractSelfConflict {
  /** The compiled output the contract demands. */
  output: string;
  /** The gate/finding id that denies writing it. */
  gate: string;
  /** The gate's own message — the other side of the contradiction. */
  detail: string;
}

interface SweepOptions {
  /** Native (React Native/mobile) style rules instead of web rules. */
  isNative: boolean;
  /** Mirror of the hot path's `enforceI18n` (new-project or declared runtime). */
  enforceI18n: boolean;
  /** Test seam, same shape as validateI18nCatalogs' contentOverrides. */
  contentOverrides?: Readonly<Record<string, string>>;
}

// Mirror of the hot structural path's extension filter in `index.ts` — the
// sweep must judge exactly the writes that path will judge, nothing more.
const HOT_GATED_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte|astro|php)$/i;

/**
 * Every (demanded output, denying gate) contradiction in the compiled
 * contract. Empty array == the contract is satisfiable by its own gates.
 */
export function contractSelfConflicts(
  compiled: CompiledArchitectureV1,
  assignments: RuntimeAssignmentsV1,
  options: SweepOptions,
): ContractSelfConflict[] {
  const overrides = options.contentOverrides || {};
  const candidates: Array<{ path: string; content: string; role: string }> = [];
  for (const output of compiled.scaffoldOutputs || []) {
    const body = Object.prototype.hasOwnProperty.call(overrides, output.path)
      ? overrides[output.path]!
      // WITH the profile: `.env.example` is web-shaped or service-shaped
      // depending on it, so an un-profiled read would certify a body the seeder
      // never writes.
      : scaffoldFileContent(output.path, compiled.profile);
    if (body !== null) {
      candidates.push({ path: output.path, content: body, role: output.ownerRole });
    }
  }
  for (const module of compiled.modules) {
    candidates.push({
      path: module.output,
      content: Object.prototype.hasOwnProperty.call(overrides, module.output)
        ? overrides[module.output]!
        : moduleSkeletonContent(compiled, module) ?? '',
      role: module.ownerRole,
    });
  }

  const includeByRole = new Map<string, string[]>();
  for (const entry of assignments.assignments) {
    includeByRole.set(entry.role, [
      ...(includeByRole.get(entry.role) || []),
      ...entry.scope.include,
    ]);
  }
  const scopedByRole = new Map<string, CompiledArchitectureV1>();
  const uiProfile = profileHasWebUi(compiled.profile)
    || compiled.profile.surfaces.includes('native-ui');

  const conflicts = new Map<string, ContractSelfConflict>();
  const add = (output: string, gate: string, detail: string): void => {
    conflicts.set(`${output}\0${gate}\0${detail}`, { output, gate, detail });
  };

  for (const candidate of candidates) {
    // The static plan gate runs on every write target; its rules self-select by
    // path/extension exactly as they do live.
    planStaticViolations(candidate.path, candidate.content, options.isNative,
      (name, fallback) => {
        add(candidate.path, name, fallback);
        return name;
      });
    if (!uiProfile) continue;
    if (profileHasWebUi(compiled.profile)
      && (HOT_GATED_SOURCE_RE.test(candidate.path) || I18N_SOURCE_RE.test(candidate.path))) {
      let scoped = scopedByRole.get(candidate.role);
      if (!scoped) {
        scoped = roleContract(compiled, candidate.role);
        scopedByRole.set(candidate.role, scoped);
      }
      const structural = analyzeStructureTextAgainstContract(
        candidate.path,
        candidate.content,
        scoped,
        { allowlist: includeByRole.get(candidate.role) || [] },
      );
      for (const finding of structural) {
        if (finding.severity !== 'error') continue;
        add(finding.file, finding.id, finding.message);
      }
    }
    if (options.enforceI18n && I18N_SOURCE_RE.test(candidate.path)) {
      const source = analyzeI18nSourceText(
        candidate.path,
        candidate.content,
        compiled.profile,
        compiled.i18n,
      );
      for (const finding of source.findings) {
        add(candidate.path, finding.id, finding.message);
      }
    }
  }
  return [...conflicts.values()].sort((a, b) => (
    a.output.localeCompare(b.output) || a.gate.localeCompare(b.gate)
  ));
}

/** Deny-message summary naming BOTH sides of each contradiction. */
export function contractSelfConflictSummary(
  conflicts: readonly ContractSelfConflict[],
): string {
  const shown = conflicts.slice(0, 3).map((conflict) => (
    `\`${conflict.output}\` is a mandatory compiled output, but writing it is denied by \`${conflict.gate}\` (${conflict.detail})`
  ));
  const rest = conflicts.length - shown.length;
  return shown.join('; ') + (rest > 0 ? `; and ${rest} more conflict(s)` : '');
}

/** Verbatim TS fallback for the `contract-self-conflict` T1BLOCK. */
export function contractSelfConflictFallback(summary: string): string {
  return `Contract satisfiability gate: the compiled plan demands outputs its own write gates forbid — ${summary}. \`PLAN_READY\` is denied before any implementer spawns: a role facing this contract would be hard-denied on a mandatory output and the run would deadlock. Fix the semantic ArchitectureInputV1 (routes/modules/placement/i18n/exceptions) so every compiled output is writable, then re-emit \`PLAN_READY\`.`;
}
