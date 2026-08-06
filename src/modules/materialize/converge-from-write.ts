// src/modules/materialize/converge-from-write.ts
// Materialize a project triggered by a tool write: from project-memory writes
// (materializeFromProjectMemoryWrite) or from tool-input path hints
// (materializeFromToolInputHints). Ported 1:1 from post.cjs. Returns a
// MaterializeOutcome (or null when nothing happened). The one-mcp reporter is
// injected (default no-op) — it is a Step-5 runner concern.

import { STACK_IDS } from '../../config/stacks';
import { detectMode } from '../../shared/detection';
import { isPathWithin, projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook/paths';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import {
  hasMaterializedProjectAssets,
  type MaterializeOutcome,
  materializeProjectAssets,
  materializeProjectIfNeeded,
  materializeRefusedOutcome,
  stateWriteRefusedOutcome,
} from '../../shared/materialize';
import {
  isMaterialized,
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { nowIsoNoMs } from '../../shared/text';
import * as path from 'path';

import {
  isProjectMemoryWritePath,
  projectRootsFromToolInputHints,
} from './post-helpers';

type Rec = Record<string, unknown>;

export type ReportOneMcp = (cwd: string, state: Rec, trigger: string) => void;
const noopReporter: ReportOneMcp = () => {};

function isMaterializableState(state: Rec): boolean {
  return !!(state && state.stack && STACK_IDS.has(state.stack as string) && state.onboardingComplete === true);
}

// Refusals that must produce NO system message on a tool-write convergence.
// Both are "this directory is not ours to write to", not "something is broken":
// the plugin's own repo must stay silent, and so must a project whose use-plugin
// question is unanswered — the onboarding gate owns that conversation, and a
// project that declined is entitled to hear nothing at all. Every other refusal
// names a plugin root that still needs fixing and is worth reporting.
// Exported for the test that pins the membership: which refusals are silent is a
// product decision, not an implementation detail, and inferring it from an
// end-to-end drive would prove only that some path was quiet.
export const SILENT_MATERIALIZE_REFUSALS = new Set(['plugin-authoring-root', 'plugin-use-not-permitted']);

function materializeProjectMemoryPath(
  projectRoot: string,
  state: Rec,
  relativePath: string,
  reportOneMcp: ReportOneMcp,
  trigger: string,
): MaterializeOutcome | null {
  try {
    // Both writes here land on `.traffic-one/.one.json`, and a refusal of it is
    // durable, so the first one already settles whether this convergence can be
    // recorded at all — reported through converge.ts's single diagnostic for it
    // rather than dropped and then contradicted by the `materialized` outcome
    // below (see stateWriteRefusedOutcome for what an unstamped pass costs).
    if (normalizeState(state, detectMode(projectRoot)) && !writeState(projectRoot, state)) {
      return stateWriteRefusedOutcome();
    }
    // A memory-doc write cannot change the stack fingerprint or the plugin
    // version, so an already-materialized project with its assets on disk needs
    // only the one-mcp report — not a full (skills-tree-touching) re-emit.
    if (isMaterialized(state) && hasMaterializedProjectAssets(projectRoot, state)) {
      reportOneMcp(projectRoot, state, trigger);
      return null;
    }
    const materialized = materializeProjectAssets(projectRoot, state);
    if (materialized.skipped && !SILENT_MATERIALIZE_REFUSALS.has(materialized.skipped)) {
      // Do NOT stamp materializedStack/At/Version — nothing was actually
      // materialized, so recording "current" would hide a plugin root (or a
      // half-written plugin tree) that still needs fixing, and would stop every
      // later hook from retrying. Report the same diagnostic converge.ts's
      // materialize-project subcommand would, instead of the generic
      // "nothing happened" null this function otherwise returns below.
      return materializeRefusedOutcome(materialized);
    }
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIsoNoMs();
      state.materializedVersion = stateVersion();
      if (!writeState(projectRoot, state)) return stateWriteRefusedOutcome(materialized);
    }
    reportOneMcp(projectRoot, state, trigger);
    if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
      return null;
    }
    return {
      status: 'materialized',
      systemMessage: 'traffic-one — project-local rules/skills materialized',
      context: `Project-local rules/skills materialized after ${relativePath}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
      result: materialized,
    };
  } catch (error) {
    const detail = error && (error as Error).message ? (error as Error).message : String(error || 'unknown error');
    return {
      status: 'failed',
      systemMessage: 'traffic-one — project-local materialization failed',
      context: `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
      result: null,
    };
  }
}

export function materializeFromToolInputHints(
  cwd: string,
  toolInput: unknown,
  opts: { trigger?: string; reportOneMcp?: ReportOneMcp; workspaceRoot?: string } = {},
): MaterializeOutcome | null {
  const trigger = opts.trigger || 'generic post-tool convergence';
  const reportOneMcp = opts.reportOneMcp || noopReporter;
  const ceiling = opts.workspaceRoot ? path.resolve(opts.workspaceRoot) : '';
  for (const projectRoot of projectRootsFromToolInputHints(cwd, toolInput)) {
    // Never materialize a project root OUTSIDE the host's authoritative workspace
    // (Cursor's workspace_roots) — a path hint above it would mint a stray parent root.
    if (ceiling && !isPathWithin(projectRoot, ceiling)) continue;
    const relativeRoot = path.relative(cwd, projectRoot).replace(/\\/g, '/') || '.';
    const state = readEffectiveState(projectRoot);
    const result = materializeProjectIfNeeded(projectRoot, { trigger: `${trigger}: ${relativeRoot}` });
    reportOneMcp(projectRoot, readEffectiveState(projectRoot), `${trigger}: ${relativeRoot}`);
    if (result) return result;
  }
  return null;
}

export function materializeFromProjectMemoryWrite(
  cwd: string,
  filePath: unknown,
  opts: { reportOneMcp?: ReportOneMcp; workspaceRoot?: string } = {},
): MaterializeOutcome | null {
  const reportOneMcp = opts.reportOneMcp || noopReporter;
  const projectRoot = resolveProjectRoot(cwd, filePath, { ceiling: opts.workspaceRoot });
  if (isPluginAuthoringRoot(projectRoot)) return null;

  const relativePath = projectRelativeHookPath(cwd, projectRoot, filePath);
  if (!isProjectMemoryWritePath(relativePath)) return null;

  const state = readEffectiveState(projectRoot);
  if (!isMaterializableState(state)) {
    return null;
  }

  return materializeProjectMemoryPath(projectRoot, state, relativePath, reportOneMcp, `project-memory write: ${relativePath}`);
}
