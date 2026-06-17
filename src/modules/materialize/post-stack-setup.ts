// src/modules/materialize/post-stack-setup.ts
// PostToolUse dispatcher (priority ~60): auth gate → supabase function-edit
// auto-deploy → digest-size warning → write-triggered materialization (project
// memory / tool-input hints / generic convergence) → state-file write
// materialization. Ported from runPostStackSetup (post.cjs). The token-log and
// one-mcp-report couplings are wired (default logger import + materialize/index.ts);
// the supabase function-edit auto-deploy coupling is injected via deps and is not
// yet wired (functionEditDeploy defaults to a no-op — to be wired separately).
//
// TODO (cutover reconcile): the legacy state-file branch emits per-validation-
// issue systemMessages + a gitnexus node-warning + the exact "rules loaded for
// stack X" wording. Here it delegates to materializeProjectFromState (which
// strips local prefs via writeState + validates + materializes); reconcile the
// exact wording against the legacy when both are side-by-side.

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { isInsidePluginAuthoringRoot, isPluginAuthoringRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { logToolUse } from '../../shared/token-logger';
import { makeSkillBlock } from '../../shared/skill-block';
import { isStateFilePath, parsedToolInput } from '../../shared/tool-classify';
import { isMaintenancePhase, readEffectiveState } from '../../shared/state';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { computeOnboarding } from '../../shared/onboarding-server/flow';
import { ensureOpenCodeDelegationReady } from '../session/session-start-lib';
import { maybeFlipToMaintenance } from './build-complete';
import { ONE_UID_FIELD } from '../../config/reporting';
import {
  type MaterializeOutcome,
  materializeProjectFromState,
  materializeProjectIfNeeded,
} from '../../shared/materialize';
import { materializeFromProjectMemoryWrite, materializeFromToolInputHints, type ReportOneMcp } from './converge-from-write';
import { DIGEST_HARD_BYTES, DIGEST_PATH_RE, FUNCTION_PATH_RE, projectRootFromStateFilePath } from './post-helpers';

const skillBlock = makeSkillBlock(pluginRoot);
const SPAWN_TOOL_RE = /^(Task|Agent|spawn_agent|send_input|wait_agent)$/i;

export interface PostStackSetupDeps {
  logTokenUse?: (cwd: string, payload: unknown) => void;
  functionEditDeploy?: (filePath: string) => string | null;
  reportOneMcp?: ReportOneMcp;
}

function outcomeToResult(out: MaterializeOutcome | null): HookResult {
  return out ? context(out.context, { systemMessage: out.systemMessage }) : noop();
}

function digestWarning(role: string, kb: number): string {
  const verbatim = [
    `[digest-size] Your \`${role}.md\` digest is ${kb} KB; the spec target is ≤2 KB (see \`rules/common/agent-handoff-digests.md\`). Re-write before completing your turn:`,
    '  1. Use repo-relative paths, never absolute (drop `/Users/.../` prefixes).',
    '  2. Touched: file paths only, no parenthetical annotations.',
    '  3. Public contracts: delta-only — what changed vs the plan, not the full surface.',
    '  4. Open questions: at most 3 bullets; link to plan §, do not inline rationale.',
    'Reviewer / tester / shipper read this digest INSTEAD of the diff; bloated digests defeat the token-economy layer.',
  ].join('\n');
  return skillBlock('materialize', 'digest-size', { ROLE: role, KB: kb }, verbatim);
}

function architectDigestProjectRoot(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/^(.*)\/\.traffic-one\/digests\/[^/]+\/architect\.md$/);
  return match?.[1] ?? null;
}

export function runPostStackSetup(ctx: Ctx, deps: PostStackSetupDeps = {}): HookResult {
  const cwd = ctx.cwd;
  const raw = obj(ctx.input.raw) || {};
  // parsedToolInput lifts ctx.input.tool.command on Cursor (no raw.tool_input) so the
  // shell command-hint convergence (materializeFromToolInputHints) sees the command.
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path);
  const workdir = ctx.input.tool?.workdir || asString(toolInput.workdir ?? toolInput.cwd);
  const pathBase = workdir
    ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.input.cwd, workdir))
    : ctx.input.cwd;
  const cwdAbs = path.resolve(cwd);
  const targetPath = filePath ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(pathBase, filePath)) : '';
  const targetInsideCwd = Boolean(targetPath && (targetPath === cwdAbs || targetPath.startsWith(`${cwdAbs}${path.sep}`)));
  if (isPluginAuthoringRoot(cwd) && (!targetPath || targetInsideCwd)) return noop();
  // A write LANDING inside the plugin's own repo must stand down even when the
  // session cwd is a parent workspace (the cwd-only check above can't see it).
  if (targetPath && isInsidePluginAuthoringRoot(targetPath)) return noop();

  const fp = filePath.replace(/\\/g, '/');
  const reportOneMcp = deps.reportOneMcp;
  const digestRoot = architectDigestProjectRoot(targetPath || filePath);
  // Resolve UP to the workspace root so the one-mcp report + maintenance flip + state
  // read target the real project, not a monorepo sub-package whose stray shallow
  // .one.json would otherwise mint a one-uid / hide maintenance phase there.
  const reportRoot = digestRoot || resolveProjectRoot(cwd, targetPath || filePath, { ceiling: ctx.input.workspaceRoot });
  // digestRoot bypasses resolveProjectRoot's authoring filter — re-check the result.
  if (isPluginAuthoringRoot(reportRoot)) return noop();
  const state = readEffectiveState(reportRoot);
  const isSpawnAgentLifecycleTool = ctx.input.tool?.class === 'spawn-agent' || SPAWN_TOOL_RE.test(asString(raw.tool_name ?? raw.toolName));

  // Single one-mcp report gate: fire ONLY once onboarding is finalized — new-project
  // (canonical state committed) or existing-project (local prefs resolved), via
  // computeOnboarding(...).done. Runs BEFORE the auth gate below so an
  // AUTH_ENABLED=false dev/test run still reports. prepareReport then enforces
  // real-codebase + auth (bypassed when auth isn't enforced) + once-per-project.
  const oneUidMissing = !(typeof state[ONE_UID_FIELD] === 'string' && state[ONE_UID_FIELD]);
  if (reportOneMcp && oneUidMissing && computeOnboarding(reportRoot).done) {
    reportOneMcp(reportRoot, state, 'onboarding-complete');
  }

  // Build-completion fallback: flip a finished new-project build to maintenance
  // phase (the primary signal is the orchestrator's explicit Phase-5 write). Cheap
  // guards first so computeOnboarding + the disk scans inside maybeFlipToMaintenance
  // only run for a new-project still in the building window — once flipped,
  // isMaintenancePhase short-circuits. Independent of one-mcp; runs before the auth
  // gate so it also works in AUTH_ENABLED=false dev/test.
  if (!isSpawnAgentLifecycleTool
    && state.mode === 'new-project'
    && !isMaintenancePhase(state, 'new-project')
    && computeOnboarding(reportRoot).done) {
    maybeFlipToMaintenance(reportRoot, state);
  }

  // In-session OpenCode heal: if the user opted in but the per-project stamp is
  // missing (wizard install task skipped/killed — see flow.ts
  // attachPendingInstallTask), heal NOW so the build session that follows
  // onboarding can actually delegate, instead of waiting for the next
  // SessionStart. The enabled+stamp guard is in-memory on the state already
  // read; the heal itself is disk-lock cooldown-guarded and detached.
  const ocEnabled = obj(state.openCode)?.enabled === true;
  const ocVersion = obj(obj(state.toolchain)?.opencode)?.installedVersion;
  if (ocEnabled && !(typeof ocVersion === 'string' && ocVersion.length > 0)) {
    ensureOpenCodeDelegationReady(reportRoot, state);
  }

  if (!authSatisfied()) return noop();

  // Opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1). Real
  // logger by default; tests inject a spy/no-op via deps.
  (deps.logTokenUse ?? logToolUse)(cwd, raw);

  if (isSpawnAgentLifecycleTool) return noop();

  // 1. Supabase Edge Function edit → auto-deploy (injected; skip when no hook).
  if (FUNCTION_PATH_RE.test(fp)) {
    const result = deps.functionEditDeploy ? deps.functionEditDeploy(targetPath || filePath) : null;
    return result ? context(result) : noop();
  }

  // 2. Soft digest-size warning (never blocks the write).
  const digestMatch = fp.match(DIGEST_PATH_RE);
  if (digestMatch && targetPath && fs.existsSync(targetPath)) {
    let bytes = 0;
    try { bytes = fs.statSync(targetPath).size; } catch { bytes = 0; }
    if (bytes > DIGEST_HARD_BYTES) {
      const role = digestMatch[1] as string;
      const kb = Math.round((bytes / 1024) * 10) / 10;
      return context(digestWarning(role, kb), { systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB` });
    }
    return noop();
  }

  // 3. Non-state-file write → write-triggered convergence.
  if (!isStateFilePath(filePath)) {
    const mem = materializeFromProjectMemoryWrite(cwd, targetPath || filePath, { workspaceRoot: ctx.input.workspaceRoot });
    if (mem) return outcomeToResult(mem);
    const hintInput = targetPath ? { ...toolInput, file_path: targetPath } : toolInput;
    const hint = materializeFromToolInputHints(cwd, hintInput, { workspaceRoot: ctx.input.workspaceRoot });
    if (hint) return outcomeToResult(hint);
    return outcomeToResult(materializeProjectIfNeeded(reportRoot, { trigger: 'generic post-tool convergence' }));
  }

  // 4. State-file write → validate + materialize (writeState strips local prefs).
  // The one-mcp report is NOT fired here — only the single onboarding-finalized
  // gate above reports.
  if (!targetPath || !fs.existsSync(targetPath)) return noop();
  return outcomeToResult(materializeProjectFromState(projectRootFromStateFilePath(targetPath), { trigger: 'post-stack-setup' }));
}
