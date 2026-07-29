// src/runners/opencode/diff-policy.ts
// The delegated-diff scope policy and the boundary prompt appended to every
// delegated task.

import * as path from 'path';
import { matchesPattern, matchesScope, normalizeRelPath, type AssignedScope } from '../../shared/scope';
import {
  blockedByFailedDependencies,
  buildOpenCodeQueue,
  normalizeOpenCodeRole,
  opencodeAssignmentHash,
  openCodeQueuePolicyReport,
  parseAllowedFiles,
  readOpenCodeUnitStatuses,
  recordOpenCodeUnitStatus,
  reconcileStaleRunningUnits,
  statusFromDelegateAction,
  unsafeAllowedFilePatterns,
  writeOpenCodeQueue,
  type OpenCodeUnitStatus,
} from '../../shared/opencode-queue';
import { isMaintenancePhase, readEffectiveState, readRunAssignmentsResilient } from '../../shared/state';

import {
  which,
} from './types';
import {
  uniquePaths,
} from './git-sandbox';

export interface DelegatedDiffPolicy {
  cwd: string;
  role: string;
  runId: string;
  allowedPatterns: string[];
  assignmentScopes: AssignedScope[];
  assignmentRequired: boolean;
  expectedAssignmentHash: string | null;
}

const GENERATED_DIFF_PATTERNS = [
  '**/node_modules/**',
  'node_modules/**',
  '**/dist/**',
  'dist/**',
  '**/build/**',
  'build/**',
  '**/.turbo/**',
  '.turbo/**',
  '**/.next/**',
  '.next/**',
  '**/.vite/**',
  '.vite/**',
  '**/.cache/**',
  '.cache/**',
  '**/coverage/**',
  'coverage/**',
  '**/playwright-report/**',
  'playwright-report/**',
  '**/test-results/**',
  'test-results/**',
  '**/*.tsbuildinfo',
  '*.tsbuildinfo',
  '.traffic-one/**',
];

function roleNeedsAssignment(role: string): boolean {
  const normalized = normalizePlanRole(role);
  return normalized === 'frontend' || normalized === 'backend';
}

export function buildDelegatedDiffPolicy(cwd: string, runId: string, role: string, allowedFiles: unknown, expectedAssignmentHash?: string | null): DelegatedDiffPolicy {
  const normalizedRole = normalizePlanRole(role);
  const manifest = readRunAssignmentsResilient(cwd, runId);
  const assignmentScopes = manifest
    ? manifest.assignments
      .filter((assignment) => normalizePlanRole(assignment.role) === normalizedRole)
      .map((assignment) => assignment.scope)
    : [];
  return {
    cwd,
    role,
    runId,
    allowedPatterns: parseAllowedFiles(allowedFiles),
    assignmentScopes,
    assignmentRequired: Boolean(manifest && roleNeedsAssignment(role)),
    expectedAssignmentHash: expectedAssignmentHash === undefined ? opencodeAssignmentHash(cwd, runId) : expectedAssignmentHash,
  };
}

function pathList(paths: string[]): string {
  return paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, ... +${paths.length - 8} more` : '');
}

export function validateDelegatedDiff(paths: string[], policy: DelegatedDiffPolicy): string | null {
  const targets = uniquePaths(paths.map((p) => normalizeRelPath(p)).filter(Boolean));
  if (policy.expectedAssignmentHash) {
    const current = opencodeAssignmentHash(policy.cwd, policy.runId);
    if (current !== policy.expectedAssignmentHash) {
      return `assignment scope changed while OpenCode was running for ${policy.role}; delegated diff is stale`;
    }
  }

  const generated = targets.filter((target) => GENERATED_DIFF_PATTERNS.some((pattern) => matchesPattern(target, pattern)));
  if (generated.length > 0) {
    return `delegated diff contains generated/internal artifact path(s): ${pathList(generated)}`;
  }

  if (policy.allowedPatterns.length > 0) {
    const outsideAllowlist = targets.filter((target) => !policy.allowedPatterns.some((pattern) => matchesPattern(target, pattern)));
    if (outsideAllowlist.length > 0) {
      return `delegated diff touched file(s) outside the plan files/area allowlist (${policy.allowedPatterns.join(', ')}): ${pathList(outsideAllowlist)}`;
    }
  }

  if (policy.assignmentScopes.length > 0) {
    const outsideScope = targets.filter((target) => !policy.assignmentScopes.some((scope) => matchesScope(target, scope)));
    if (outsideScope.length > 0) {
      return `delegated diff touched file(s) outside ${policy.role}'s assignment scope: ${pathList(outsideScope)}`;
    }
  } else if (policy.assignmentRequired) {
    return `no assignment scope found for delegated ${policy.role} work in run ${policy.runId}`;
  }

  return null;
}

// The guard above runs AFTER the model finished, so an out-of-bounds edit costs the
// whole unit (17c: 6 of 8 units rejected, ~1395s, every one for a companion edit the
// model had no way to know was forbidden). State the boundary up front. This mirrors
// validateDelegatedDiff — keep the two adjacent — but relaxes nothing: an ignored
// instruction still ends in the same rejection.
// The sandbox worktree carries the project's own AGENTS.md/`.traffic-one` rules
// (which, for instance, order a schema.sql refresh after a migration), so the
// override line is load-bearing, not boilerplate.
export function delegationBoundaryPrompt(policy: DelegatedDiffPolicy): string {
  const lines = ['', '## Edit boundary (Traffic One — overrides any AGENTS.md/CLAUDE.md or .traffic-one rule in this sandbox)'];
  if (policy.allowedPatterns.length > 0) {
    lines.push(`- Create or modify ONLY: ${policy.allowedPatterns.join(', ')}`);
  }
  lines.push('- NEVER touch: `.traffic-one/**` (including schema.sql and the project-memory docs), any `package.json`, any lockfile, or build/cache output.');
  lines.push('- Do NOT add dependencies, re-export from a barrel/index file, or register your module anywhere else — the paid implementer wires it up afterwards.');
  lines.push('- If the task cannot be completed inside this boundary, do as much as you can inside it and say what is missing in your final message. Editing outside it discards ALL of your work.');
  return lines.join('\n');
}


export function normalizePlanRole(role: string): string {
  return normalizeOpenCodeRole(role);
}
