// src/modules/materialize/converge-from-write.ts
// Materialize a project triggered by a tool write: from project-memory writes
// (materializeFromProjectMemoryWrite) or from tool-input path hints
// (materializeFromToolInputHints). Ported 1:1 from post.cjs. Returns a
// MaterializeOutcome (or null when nothing happened). The one-mcp reporter is
// injected (default no-op) — it is a Step-5 runner concern.

import { STACK_IDS } from '../../config/stacks';
import { detectMode } from '../../shared/detection';
import { isPathWithin, projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook-paths';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import {
  type MaterializeOutcome,
  materializeProjectAssets,
  materializeProjectIfNeeded,
} from '../../shared/materialize';
import {
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';
import { nowIsoNoMs } from '../../shared/text';
import { detectHostPlan } from '../../shared/host-plan';
import { CURSOR_MODELS_REL, stampCursorModels } from '../../shared/materialize/cursor-models';
import { clearModelChoice } from '../agent-model/model-choice';
import { cursorPickedModelUnavailableNotice, cursorUnavailablePicks } from '../../shared/materialize/cursor-eligibility';
import * as path from 'path';

import {
  isProjectMemoryWritePath,
  PROJECT_COMMAND_HINT_FIELDS,
  PROJECT_PATH_TOKEN_RE,
  PROJECT_ROOT_HINT_FIELDS,
  projectRootsFromToolInputHints,
} from './post-helpers';

type Rec = Record<string, unknown>;

export type ReportOneMcp = (cwd: string, state: Rec, trigger: string) => void;
const noopReporter: ReportOneMcp = () => {};

function isMaterializableState(state: Rec): boolean {
  return !!(state && state.stack && STACK_IDS.has(state.stack as string) && state.onboardingComplete === true);
}

function isCursorModelsRelativePath(relativePath: unknown): boolean {
  return String(relativePath || '').replace(/\\/g, '/') === CURSOR_MODELS_REL.replace(/\\/g, '/');
}

function pathHintTargetsCursorModels(cwd: string, projectRoot: string, hint: unknown): boolean {
  const raw = String(hint || '').trim();
  if (!raw || raw.startsWith('-') || raw.includes('://') || raw.includes('$')) return false;
  const cleaned = raw.replace(/^["'`]+|["'`,;]+$/g, '').replace(/\\ /g, ' ');
  if (!cleaned) return false;
  const abs = path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(cwd, cleaned);
  return path.resolve(abs) === path.resolve(projectRoot, CURSOR_MODELS_REL);
}

function toolInputTargetsCursorModels(cwd: string, projectRoot: string, toolInput: unknown): boolean {
  const ti = toolInput && typeof toolInput === 'object' ? (toolInput as Rec) : {};
  for (const field of PROJECT_ROOT_HINT_FIELDS) {
    if (pathHintTargetsCursorModels(cwd, projectRoot, ti[field])) return true;
  }
  for (const field of PROJECT_COMMAND_HINT_FIELDS) {
    const command = typeof ti[field] === 'string' ? (ti[field] as string) : '';
    if (!command) continue;
    for (const match of command.matchAll(PROJECT_PATH_TOKEN_RE)) {
      if (pathHintTargetsCursorModels(cwd, projectRoot, match[1])) return true;
    }
    if (command.includes(CURSOR_MODELS_REL.replace(/\\/g, '/'))) return true;
  }
  return false;
}

function materializeProjectMemoryPath(
  projectRoot: string,
  state: Rec,
  relativePath: string,
  reportOneMcp: ReportOneMcp,
  trigger: string,
): MaterializeOutcome | null {
  const isCursorModelsWrite = isCursorModelsRelativePath(relativePath);
  if (isCursorModelsWrite) {
    stampCursorModels(projectRoot, detectHostPlan('cursor'), nowIsoNoMs());
  }

  try {
    if (normalizeState(state, detectMode(projectRoot))) writeState(projectRoot, state);
    const materialized = materializeProjectAssets(projectRoot, state);
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIsoNoMs();
      state.materializedVersion = stateVersion();
      writeState(projectRoot, state);
    }
    reportOneMcp(projectRoot, state, trigger);
    // On a Cursor model-list capture, ask the USER (visible user_message) if a picked model isn't
    // offered — even when re-materialization itself changed nothing (the spawn-gate deny only
    // reaches the agent on Cursor, so this is the channel the user actually sees).
    const eligibilityNotice = isCursorModelsWrite ? cursorPickedModelUnavailableNotice(projectRoot, state) : '';
    if (isCursorModelsWrite) {
      const runId = typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : '';
      if (runId && cursorUnavailablePicks(projectRoot, state).length > 0) {
        // Fresh capture with unavailable picks → invalidate any stale auto-recorded choice.
        clearModelChoice(projectRoot, runId);
      }
    }
    if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
      return eligibilityNotice
        ? { status: 'materialized', systemMessage: eligibilityNotice, context: eligibilityNotice, result: materialized }
        : null;
    }
    return {
      status: 'materialized',
      systemMessage: eligibilityNotice || 'traffic-one — project-local rules/skills materialized',
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
    if (toolInputTargetsCursorModels(cwd, projectRoot, toolInput) && isMaterializableState(state)) {
      const out = materializeProjectMemoryPath(
        projectRoot,
        state,
        CURSOR_MODELS_REL,
        reportOneMcp,
        `${trigger}: ${relativeRoot} (${CURSOR_MODELS_REL})`,
      );
      if (out) return out;
      continue;
    }
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

  // When the orchestrator just wrote the captured Cursor model list, stamp it with the plan it
  // was captured under + a timestamp, so a later plan upgrade/downgrade is detected as stale and
  // re-captured (keeping subagent models current). Stamp BEFORE materializeProjectAssets so the
  // freshly-stamped (fresh) list is used to pin real slugs in .cursor/agents/<role>.md.
  return materializeProjectMemoryPath(projectRoot, state, relativePath, reportOneMcp, `project-memory write: ${relativePath}`);
}
