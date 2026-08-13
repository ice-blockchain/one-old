// src/modules/plan-guard/plan-readiness/architect.ts
// Architect-phase material: memory baseline, decision records, and the
// OpenCode delegation block checks.

import * as fs from 'fs';
import * as path from 'path';
import { readRegularFile } from '../../../shared/bounded-read';
import { packageJsonDeclaresWorkspace } from '../../../shared/hook/paths';
import { hostFlags } from '../../../shared/host/capability-flags';
import { canonicalHost } from '../../../shared/model-tiers';
import { OPENCODE_PLAN_MIN_UNITS, parsePlanDelegationUnits, planDelegationUnitCount } from '../../../shared/opencode-roles';
import { openCodeQueuePolicyViolations, type OpenCodeQueuePolicyOptions } from '../../../shared/opencode-queue';
import { obj } from '../../../shared/obj';
import { isNewProjectMode } from '../../../shared/state';

import {
  type Rec,
  existsAny,
  readTrimmed,
} from './context';

export const ADR_OR_DOC_RE = /(^|\/)(docs|architecture|README|ADR)/i;
export const ROOT_VITE_RE = /^(src\/|index\.html$|vite\.config\.(ts|js|mts|mjs)$|tailwind\.config\.(ts|js|cjs|mjs)$|postcss\.config\.(cjs|js|mjs)$|components\.json$|public\/)/;
export const ROOT_MONOREPO_FLAT_RE = /^tsconfig(?!\.base\.json$)(\.[a-z0-9-]+)?\.json$/;
export const T1_MEMORY_DIR = '.traffic' + '-one';

// The OpenCode plan-queue gate is a TOKEN-OPTIMIZATION, not a correctness gate: it
// wants the architect to list bounded units for the free OpenCode batch. On
// Windsurf/Devin it must NOT block — Devin's agent treats any gate deny as terminal
// (it stops, and a non-technical user is stuck with no "continue"), and OpenCode
// delegation is best-effort anyway (a missing queue just falls back to paid). So a
// host where a deny ends the turn never blocks here; the rest keep the original hard
// block (their agents read the deny and retry with the queue).
export function opencodeQueueBlocks(host: string | undefined): boolean {
  return !hostFlags(canonicalHost(host)).denyEndsTheTurn;
}



export function packageJsonMatchesWorkspaceRoot(projectRoot: string, content: string): boolean {
  if (packageJsonDeclaresWorkspace(content)) return true;
  if (!existsAny(projectRoot, ['pnpm-workspace.yaml', 'pnpm-workspace.yml'])) return false;
  try {
    const pkg = JSON.parse(content);
    const hasPnpmPackageManager = typeof pkg?.packageManager === 'string' && /^pnpm@\d/.test(pkg.packageManager);
    return pkg?.private === true && hasPnpmPackageManager;
  } catch {
    return true;
  }
}


function hasRealContent(projectRoot: string, relPath: string, minBytes = 16): boolean {
  const content = readTrimmed(projectRoot, relPath);
  return Boolean(content && content.length >= minBytes);
}

function hasNotApplicableReason(projectRoot: string, relPath: string): boolean {
  const content = readTrimmed(projectRoot, relPath);
  if (!content) return false;
  if (!/\b(not applicable|n\/a|not-applicable)\b/i.test(content)) return false;
  return content.length >= 32 && /\b(because|reason|no |without|none|external|static|frontend[- ]only)\b/i.test(content);
}

function hasDecisionRecordWhenNeeded(projectRoot: string, state: Rec): boolean {
  const mobile = obj(state.mobile);
  const hasNonDefaultChoice = state.stack !== 'default'
    || state.frontend !== 'react-vite'
    || state.backend !== 'supabase'
    || Boolean(mobile?.enabled);
  if (!hasNonDefaultChoice) return true;
  const dir = path.join(projectRoot, T1_MEMORY_DIR, 'decisions');
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
      if (!entry.isFile() || !/\.md$/i.test(entry.name)) return false;
      return hasRealContent(projectRoot, path.join(T1_MEMORY_DIR, 'decisions', entry.name), 32);
    });
  } catch {
    return false;
  }
}

export function missingProjectMemoryBaseline(projectRoot: string, state: Rec): string[] {
  if (!isNewProjectMode(state)) return [];
  const missing: string[] = [];
  for (const relPath of [
    '.traffic-one/product.md',
    '.traffic-one/stack.md',
    '.traffic-one/coding.md',
    '.traffic-one/security.md',
    '.traffic-one/known-issues.md',
    '.traffic-one/deployment.md',
    '.traffic-one/environment-setup.md',
    '.traffic-one/agent-log.md',
    '.traffic-one/.agentignore',
  ]) {
    if (!hasRealContent(projectRoot, relPath, relPath.endsWith('.agentignore') ? 1 : 16)) missing.push(relPath);
  }

  const backend = typeof state.backend === 'string' ? state.backend : '';
  const hasOwnedBackend = backend !== '' && backend !== 'none' && backend !== 'external-api';
  const backendDocs = ['.traffic-one/api.md', '.traffic-one/database.md', '.traffic-one/schema.sql'];
  for (const relPath of backendDocs) {
    const ok = hasOwnedBackend
      ? (hasRealContent(projectRoot, relPath, 16) || hasNotApplicableReason(projectRoot, relPath))
      : hasNotApplicableReason(projectRoot, relPath);
    if (!ok) missing.push(hasOwnedBackend ? relPath : `${relPath} (Not applicable + reason)`);
  }

  if (!hasDecisionRecordWhenNeeded(projectRoot, state)) {
    missing.push('.traffic-one/decisions/*.md (ADR for non-default stack choice)');
  }
  return missing;
}

export function missingOpenCodeDelegateBlock(content: string): boolean {
  return planDelegationUnitCount(content) < OPENCODE_PLAN_MIN_UNITS;
}

export function hasOpenCodeDelegateMarker(content: string): boolean {
  return content.includes('opencode-delegate:start') || content.includes('opencode-delegate:end');
}

export function openCodeQueuePolicyErrors(content: string): string[] {
  return openCodeQueuePolicyViolations(parsePlanDelegationUnits(content));
}

/**
 * `.traffic-one/plan.md`, BOUNDED (shared/bounded-read.ts), for the three
 * readers below.
 *
 * The bare `fs.readFileSync` these replace had no bound at all on two shapes,
 * and this is the file that MEASURED it: a FIFO at `.traffic-one/plan.md`
 * SIGKILLed `planReadinessViolations` at 12 023 ms and a symlink to `/dev/zero`
 * at 12 080 ms (.tmp/bounded-reads, load 9.54 of 10 cpus, one child per shape
 * under a hard alarm, the planted path logged as the last read before the
 * hang) — against a regular-file control that returned
 * `architect-opencode-queue-gate` in 2.4 s. That is a PreToolUse hook, so the
 * outcome is the one this codebase ranks below failing closed: no deny, no
 * timeout, nothing logged, the editor session wedged until somebody finds the
 * process.
 *
 * `null` — something is there and it is not a regular file — is deliberately
 * folded into each caller's existing catch arm rather than into "the plan is
 * empty". An `O_NONBLOCK` FIFO READS AS EMPTY, so a reader that mapped it onto
 * `''` would hand `missingOpenCodeDelegateBlock` bytes nobody read; the fold
 * below lands it exactly where an unreadable plan already landed.
 */
function readPlanOnDisk(projectRoot: string): string | null {
  return readRegularFile(path.join(projectRoot, T1_MEMORY_DIR, 'plan.md'));
}

export function planOnDiskMissingOpenCodeBlock(projectRoot: string): boolean {
  try {
    const plan = readPlanOnDisk(projectRoot);
    return plan === null ? true : missingOpenCodeDelegateBlock(plan);
  } catch {
    return true;
  }
}

export function planOnDiskHasOpenCodeDelegateMarker(projectRoot: string): boolean {
  try {
    const plan = readPlanOnDisk(projectRoot);
    return plan === null ? false : hasOpenCodeDelegateMarker(plan);
  } catch {
    return false;
  }
}

export function planOnDiskOpenCodeQueuePolicyErrors(
  projectRoot: string,
  options: OpenCodeQueuePolicyOptions = {},
): string[] {
  try {
    const plan = readPlanOnDisk(projectRoot);
    return plan === null ? [] : openCodeQueuePolicyViolations(parsePlanDelegationUnits(plan), options);
  } catch {
    return [];
  }
}
