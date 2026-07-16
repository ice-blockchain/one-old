// src/shared/materialize/converge.ts
// Materialization convergence: the `materialize-project` body and the
// hook-time "materialize if needed" guard. Ported 1:1 from
// materializeProjectFromState + materializeProjectIfNeeded (_helpers.cjs).
//
// Returns a plain MaterializeOutcome (domain result) instead of host-shaped
// stdout — the calling module maps it to a canonical HookResult. The one-mcp
// background reporter is injected (default no-op) so this service stays free of
// the runner layer.

import { isKnownStack } from '../config';
import { postWriteIncompleteWarning } from '../directives';
import { isNonProjectRoot } from '../authoring-root';
import { ensureRunnerShims } from '../runner-shims';
import { isUnclaimedWorkspaceSubPackage } from '../hook-paths';
import { detectMode } from '../detection';
import { STACKS } from '../stacks';
import { nowIsoNoMs } from '../text';
import {
  isMaterialized,
  hasLocalPreferenceFields,
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  trafficOneStateValidationIssues,
  writeState,
} from '../state';
import { hasMaterializedProjectAssets } from './has-assets';
import { materializeProjectAssets, type MaterializeResult } from './materialize';
import { migrateArchitectureDocsToPlan } from './plan-migration';

type Rec = Record<string, unknown>;

export type MaterializeStatus =
  | 'authoring-root'
  | 'missing-state'
  | 'incomplete'
  | 'failed'
  | 'materialized'
  | 'current'
  | 'skipped';

export interface MaterializeOutcome {
  status: MaterializeStatus;
  systemMessage: string;
  context: string;
  result: MaterializeResult | null;
}

export interface ConvergeOptions {
  trigger?: string;
  // Fire-and-forget one-mcp first-look reporter; injected so shared/ stays
  // free of the runner layer. Defaults to a no-op.
  reportOneMcp?: (cwd: string, state: Rec, trigger: string) => void;
}

const noopReporter: NonNullable<ConvergeOptions['reportOneMcp']> = () => {};

function outcome(status: MaterializeStatus, systemMessage: string, context: string, result: MaterializeResult | null = null): MaterializeOutcome {
  return { status, systemMessage, context, result };
}

// The `materialize-project` subcommand body: validate state, write
// .traffic-one/** rules+skills + root AGENTS.md/CLAUDE.md, stamp the state, and
// kick the background reporter.
export function materializeProjectFromState(cwd: string, opts: ConvergeOptions = {}): MaterializeOutcome {
  const trigger = opts.trigger || 'manual materialize-project';
  const reportOneMcp = opts.reportOneMcp || noopReporter;

  if (isNonProjectRoot(cwd)) {
    return outcome(
      'authoring-root',
      'traffic-one — plugin authoring root detected; project materialization skipped',
      'This directory is the Traffic One plugin source, not a generated Traffic One project. `materialize-project` only rewrites `.traffic-one/**`, root `AGENTS.md`, and root `CLAUDE.md` inside projects created with the plugin.',
    );
  }

  try { ensureRunnerShims(); } catch { /* best-effort; MCP may load before sessionStart */ }

  const state = readEffectiveState(cwd);
  const validStackIds = Object.keys(STACKS);
  const validCodeGraphProviders = ['gitnexus', 'graphify'];

  if (!state || typeof state !== 'object') {
    return outcome(
      'missing-state',
      'traffic-one — `.traffic-one/.one.json` is missing or invalid; cannot materialize project rules',
      'Write the complete Traffic One state file first, then run `node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}}/scripts/hook-runtime.cjs" materialize-project` from the project root.',
    );
  }

  const hadLocalPreferenceFields = hasLocalPreferenceFields(state);
  const normalizedBeforeValidation = normalizeState(state, (state.mode as string) || detectMode(cwd));
  if (normalizedBeforeValidation || hadLocalPreferenceFields) {
    try {
      writeState(cwd, state);
    } catch {
      // best-effort; validation below still reports any missing fields.
    }
  }

  const cgProvider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;
  const validationIssues = trafficOneStateValidationIssues(state, validCodeGraphProviders);
  if (validationIssues.length > 0) {
    const context = postWriteIncompleteWarning({
      stack: (state.stack as string) || null,
      validStackIds,
      codeGraphProvider: cgProvider,
      validCodeGraphProviders,
      validationIssues,
    });
    return outcome(
      'incomplete',
      'traffic-one — `.traffic-one/.one.json` is incomplete; cannot materialize project rules yet',
      context,
    );
  }
  migrateArchitectureDocsToPlan(cwd);

  let materialized: MaterializeResult | null = null;
  try {
    materialized = materializeProjectAssets(cwd, state);
  } catch (error) {
    const detail = error && (error as Error).message ? (error as Error).message : String(error || 'unknown error');
    return outcome(
      'failed',
      'traffic-one — project-local materialization failed',
      `traffic-one could not materialize .traffic-one/rules, .traffic-one/skills, and .traffic-one/manifest.json: ${detail}`,
    );
  }

  try {
    state.materializedStack = stackFingerprint(state);
    state.materializedAt = nowIsoNoMs();
    state.materializedVersion = stateVersion();
    writeState(cwd, state);
  } catch {
    // best-effort; the copied local assets are still usable.
  }

  reportOneMcp(cwd, state, trigger);

  if (!materialized || (materialized.written <= 0 && materialized.removed <= 0)) {
    return outcome(
      'current',
      'traffic-one — project-local rules/skills already materialized',
      `Project-local rules/skills are current for ${stackFingerprint(state)}. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
      materialized,
    );
  }

  return outcome(
    'materialized',
    'traffic-one — project-local rules/skills materialized',
    `Project-local rules/skills materialized after ${trigger}: ${materialized.rules} rule files, ${materialized.skills} skills, manifest .traffic-one/manifest.json. Root AGENTS.md contains or preserves existing content with the Traffic One active rule kernel/index; root CLAUDE.md symlinks to AGENTS.md only when no CLAUDE.md exists.`,
    materialized,
  );
}

// Hook-time convergence guard: ensure a project's .traffic-one/** is current
// for its state, materializing on demand. Returns null when nothing is needed
// (the common case); callers that only want the side-effect ignore the return.
export function materializeProjectIfNeeded(cwd: string, opts: ConvergeOptions = {}): MaterializeOutcome | null {
  const trigger = opts.trigger || 'generic hook convergence';
  const reportOneMcp = opts.reportOneMcp || noopReporter;

  if (isNonProjectRoot(cwd)) return null;

  // Never auto-converge a monorepo SUB-PACKAGE as its own project. When `cwd` owns
  // no Traffic One state but sits inside a workspace (an ancestor declares
  // package.json workspaces / pnpm-workspace.yaml), it belongs to that workspace
  // root — bail before normalizeState/writeState below would mint a stray shallow
  // .traffic-one/.one.json here (detectMode labels any sparse dir 'new-project').
  // resolveProjectRoot already anchors callers at the real root; this is the
  // write-side backstop for a caller that passes a raw sub-package cwd.
  if (isUnclaimedWorkspaceSubPackage(cwd)) return null;

  const state = readEffectiveState(cwd);
  if (!state || typeof state !== 'object') return null;

  migrateArchitectureDocsToPlan(cwd);

  const normalized = normalizeState(state, (state.mode as string) || detectMode(cwd));
  if (normalized) {
    try {
      writeState(cwd, state);
    } catch {
      // Let the materializer surface a validation or write failure below.
    }
  }

  if (!state.stack || !isKnownStack(state.stack)) {
    if (state.mode === 'new-project' || state.onboardingComplete === true) {
      return materializeProjectFromState(cwd, { trigger, reportOneMcp });
    }
    return null;
  }
  if (state.onboardingComplete !== true) return null;

  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) {
    reportOneMcp(cwd, state, trigger);
    return null;
  }

  return materializeProjectFromState(cwd, { trigger, reportOneMcp });
}
