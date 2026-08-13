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
import { obj } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { isInsidePluginAuthoringRoot, isPluginAuthoringRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { logToolUse } from '../../shared/token-logger';
import { makeSkillBlock } from '../../shared/skill-block';
import {
  canonicalToolName,
  isOnboardingWaitCommand,
  isStateFilePath,
  normalizedToolName,
  parsedToolInput,
  patchTextFromToolInput,
} from '../../shared/tool-classify';
import { parseApplyPatch } from '../../shared/apply-patch';
import { firstEmitThisSession } from '../../shared/once';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import {
  AGENT_ACTIVITY_WARN_THRESHOLD,
  hookSessionIdentity,
  isMaintenancePhase,
  isNewProjectMode,
  readEffectiveState,
  readRunAgentActivity,
  resolveRunAgentContext,
} from '../../shared/state';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { computeOnboarding, usePluginQuestionPending } from '../../shared/onboarding-server/flow';
import { ensureOpenCodeDelegationReady } from '../session/session-start-lib';
import { maybeFlipToMaintenance } from './build-complete';
import { buildPostPlanReadyOpenCodeDirective } from '../../shared/opencode-plan/directive';
import { ONE_UID_FIELD } from '../../config/reporting';
import {
  type MaterializeOutcome,
  materializeProjectFromState,
  materializeProjectIfNeeded,
} from '../../shared/materialize';
import { materializeFromProjectMemoryWrite, materializeFromToolInputHints, type ReportOneMcp } from './converge-from-write';
import { DIGEST_HARD_BYTES, DIGEST_PATH_RE, FUNCTION_PATH_RE, projectRootFromStateFilePath, runStartMsForDigest } from './post-helpers';
import { normalizeDigestFinishedAt } from './digest-finished-at';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

const skillBlock = makeSkillBlock(pluginRoot);
const SPAWN_TOOL_RE = /^(Task|Agent|spawn_agent|followup_task|send_message|send_input|wait_agent)$/i;

interface PostStackSetupDeps {
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

// F3: overwrite a fabricated/implausible digest `finished_at` with the real
// write-time. Agents routinely hand-type future-dated timestamps and nothing
// downstream validated them (the settlement sanity check only tests presence).
// Returns a short audit note when it corrected the file, else ''. Never throws —
// the digest hook must never block or fail the write.
function hostStampDigestFinishedAt(targetPath: string, role: string): string {
  try {
    const content = readRegularFileOrThrow(targetPath);
    const fix = normalizeDigestFinishedAt(content, Date.now(), { runStartMs: runStartMsForDigest(targetPath) });
    if (!fix) return '';
    fs.writeFileSync(targetPath, fix.content);
    return fix.from === null
      ? `traffic-one — digest ${role}.md finished_at was missing; host-stamped ${fix.to}`
      : `traffic-one — digest ${role}.md finished_at (${fix.from}) was ${fix.reason}; host-stamped real UTC ${fix.to}`;
  } catch {
    return '';
  }
}

export function runPostStackSetup(ctx: Ctx, deps: PostStackSetupDeps = {}): HookResult {
  const cwd = ctx.cwd;
  const raw = obj(ctx.input.raw) || {};
  // parsedToolInput lifts ctx.input.tool.command on Cursor (no raw.tool_input) so the
  // shell command-hint convergence (materializeFromToolInputHints) sees the command.
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  // Devin Local backgrounds long exec calls after ~5 seconds and emits
  // PostToolUse while onboarding-wait is still running. Converging at that
  // moment reads the intentionally incomplete state and injects a stale
  // "rewrite .one.json" directive, causing the model to overwrite wizard
  // answers. The wait runner owns setup completion + materialization.
  if (isOnboardingWaitCommand(toolName, toolInput)) return noop();
  const filePath = ctx.input.tool?.filePath || asString(toolInput.file_path);
  const workdir = ctx.input.tool?.workdir || asString(toolInput.workdir ?? toolInput.cwd);
  const pathBase = workdir
    ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(ctx.input.cwd, workdir))
    : ctx.input.cwd;
  const cwdAbs = path.resolve(cwd);
  const targetPath = filePath ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(pathBase, filePath)) : '';
  const patchText = normalizedToolName(toolName).toLowerCase() === 'apply_patch'
    ? patchTextFromToolInput(ctx.input.tool?.patchText, raw.tool_input, raw.toolInput, raw.input, raw, toolInput)
    : '';
  const parsedPatch = patchText ? parseApplyPatch(patchText) : null;
  const patchTargetPaths = parsedPatch?.ok
    ? parsedPatch.operations.flatMap((operation) => {
      if (operation.kind === 'delete') return [];
      const written = operation.kind === 'move' ? operation.destinationPath : operation.path;
      if (!written) return [];
      return [path.isAbsolute(written) ? path.resolve(written) : path.resolve(pathBase, written)];
    })
    : [];
  const writtenTargetPaths = [...new Set([targetPath, ...patchTargetPaths].filter(Boolean))];
  const targetInsideCwd = Boolean(targetPath && (targetPath === cwdAbs || targetPath.startsWith(`${cwdAbs}${path.sep}`)));
  if (isPluginAuthoringRoot(cwd) && (!targetPath || targetInsideCwd)) return noop();
  // A write LANDING inside the plugin's own repo must stand down even when the
  // session cwd is a parent workspace (the cwd-only check above can't see it).
  if (targetPath && isInsidePluginAuthoringRoot(targetPath)) return noop();

  const fp = filePath.replace(/\\/g, '/');
  const reportOneMcp = deps.reportOneMcp;
  const digestTargets = writtenTargetPaths.flatMap((writtenPath) => {
    const match = writtenPath.replace(/\\/g, '/').match(DIGEST_PATH_RE);
    return match ? [{ path: writtenPath, role: match[1] as string }] : [];
  });
  const architectDigest = digestTargets.find((candidate) => candidate.role === 'architect');
  const digestRoot = architectDigestProjectRoot(architectDigest?.path || targetPath || filePath);
  // Resolve UP to the workspace root so the one-mcp report + maintenance flip + state
  // read target the real project, not a monorepo sub-package whose stray shallow
  // .one.json would otherwise mint a one-uid / hide maintenance phase there.
  const reportRoot = digestRoot || resolveProjectRoot(cwd, targetPath || filePath, { ceiling: ctx.input.workspaceRoot });
  // digestRoot bypasses resolveProjectRoot's authoring filter — re-check the result.
  if (isPluginAuthoringRoot(reportRoot)) return noop();
  // The user declined Traffic One for this project — every hook stands down.
  // Critically, computeOnboarding reports done:true for a declined project (so
  // waiters unblock), which would otherwise satisfy the one-mcp report gate
  // below and mint a one-uid .one.json into a repo the user said no to.
  if (pluginUseDeclined(reportRoot)) return noop();
  const state = readEffectiveState(reportRoot);
  // Ask-first pending on a never-onboarded project: nothing may be written
  // before the user's answer. A pristine EXISTING codebase also computes
  // done:true (no stack → no required local prefs), so without this the report
  // gate would mint a one-uid pre-decision. A mode-bearing state means the
  // project was genuinely onboarded (possibly before ask-first existed) — those
  // keep reporting/flipping/converging normally.
  const onboardedState = typeof state.mode === 'string' && state.mode.trim() !== '';
  if (!onboardedState && usePluginQuestionPending(reportRoot)) return noop();
  const isSpawnAgentLifecycleTool = ctx.input.tool?.class === 'spawn-agent' || SPAWN_TOOL_RE.test(asString(raw.tool_name ?? raw.toolName));

  // Single one-mcp report gate: fire ONLY once onboarding is finalized — new-project
  // (canonical state committed) or existing-project (local prefs resolved), via
  // computeOnboarding(...).done. The anonymous report is independent of auth;
  // prepareReport owns the real-codebase, exact plugin-use opt-in, and
  // once-per-project checks.
  const oneUidMissing = !(typeof state[ONE_UID_FIELD] === 'string' && state[ONE_UID_FIELD]);
  if (reportOneMcp && oneUidMissing && computeOnboarding(reportRoot).done) {
    reportOneMcp(reportRoot, state, 'onboarding-complete');
  }

  // Build-completion fallback: flip a finished new-project build to maintenance
  // phase (the primary signal is the orchestrator's explicit Phase-5 write). Cheap
  // guards first so computeOnboarding + the disk scans inside maybeFlipToMaintenance
  // only run for a new-project still in the building window — once flipped,
  // isMaintenancePhase short-circuits. Independent of one-mcp; runs before the auth
  // gate so it also works in explicit auth-bypass dev/test runs.
  if (!isSpawnAgentLifecycleTool
    && isNewProjectMode(state)
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

  // 2. Digest post-write. Host-stamp an implausible finished_at FIRST (F3) so it
  //    fires for every role — including architect, whose PLAN_READY branch below
  //    can return early — then the architect Step-0 re-inject and size warning.
  const digestStampNotes = digestTargets
    .filter((candidate) => fs.existsSync(candidate.path))
    .map((candidate) => hostStampDigestFinishedAt(candidate.path, candidate.role))
    .filter(Boolean);

  // 2a. Architect PLAN_READY → re-inject OpenCode Step-0 while batch is pending.
  if (architectDigest && fs.existsSync(architectDigest.path)) {
    let content = '';
    try { content = readRegularFileOrThrow(architectDigest.path); } catch { content = ''; }
    if (/\bPLAN_READY\b/.test(content)) {
      const planReadyDirective = buildPostPlanReadyOpenCodeDirective(reportRoot);
      if (planReadyDirective) {
        // This fires on every PostToolUse write while the batch is pending, so
        // the ~2 KB recipe would repeat per tool call. Inject it in full once
        // per session, then a one-line reminder that keeps the load-bearing
        // fact; the spawn gate (not this directive) is the enforcement.
        const full = firstEmitThisSession(
          reportRoot,
          'opencode-step0-plan-ready',
          hookSessionIdentity(raw).sessionId,
        );
        return context(full
          ? planReadyDirective
          : '[traffic-one] PLAN_READY — OpenCode Step 0 is still required before implementer spawns; run the plan batch via `opencode_delegate_from_plan` (full recipe earlier this session).', {
          systemMessage: 'traffic-one — run OpenCode Step 0 before spawning implementers',
        });
      }
    }
  }

  // 3. Soft digest-size warning (never blocks the write); else surface the
  //    finished_at correction, if any.
  if (digestTargets.length > 0) {
    for (const candidate of digestTargets) {
      let bytes = 0;
      try { bytes = fs.statSync(candidate.path).size; } catch { bytes = 0; }
      if (bytes <= DIGEST_HARD_BYTES) continue;
      const role = candidate.role;
      const kb = Math.round((bytes / 1024) * 10) / 10;
      return context(digestWarning(role, kb), { systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB` });
    }
    if (digestStampNotes.length > 0) return context('', { systemMessage: digestStampNotes.join('\n') });
    return noop();
  }

  // 3b. Turn-count nudge, once per session: a role past the warn threshold gets
  //     ONE consolidation directive (12co: frontend at 163 calls, no signal).
  //     Deliberately AFTER the digest branch — an early return here once
  //     swallowed the digest finished_at host-stamp for the very write it rode
  //     (adversarial review) — and before the generic convergence steps, which
  //     re-fire on every later write and lose nothing. Fail-open, never a deny.
  try {
    const runIdForActivity = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    const activityContext = runIdForActivity
      ? resolveRunAgentContext(reportRoot, state, raw, { claimPending: false, host: ctx.host })
      : null;
    const activityRole = typeof activityContext?.role === 'string' ? activityContext.role : '';
    if (runIdForActivity && activityRole) {
      const tally = readRunAgentActivity(reportRoot, runIdForActivity, activityRole);
      if (tally.total >= AGENT_ACTIVITY_WARN_THRESHOLD
        && firstEmitThisSession(reportRoot, `agent-activity-warn-${runIdForActivity}-${activityRole}`, hookSessionIdentity(raw).sessionId)) {
        return context(
          `[traffic-one] ${activityRole} has made ${tally.total} tool calls in run ${runIdForActivity}. Consolidate: `
          + 'batch the remaining related reads, group coherent edits, run ONE combined verification command per '
          + 'surface, and do not re-read rules or files already loaded — finish the assignment, then emit your digest.',
          { systemMessage: `traffic-one — ${activityRole}: ${tally.total} tool calls this run; consolidate` },
        );
      }
    }
  } catch {
    // telemetry must never affect the tool call
  }

  // 4. Non-state-file write → write-triggered convergence.
  if (!isStateFilePath(filePath)) {
    const mem = materializeFromProjectMemoryWrite(cwd, targetPath || filePath, { workspaceRoot: ctx.input.workspaceRoot });
    if (mem) return outcomeToResult(mem);
    const hintInput = targetPath ? { ...toolInput, file_path: targetPath } : toolInput;
    const hint = materializeFromToolInputHints(cwd, hintInput, { workspaceRoot: ctx.input.workspaceRoot });
    if (hint) return outcomeToResult(hint);
    return outcomeToResult(materializeProjectIfNeeded(reportRoot, { trigger: 'generic post-tool convergence' }));
  }

  // 5. State-file write → validate + materialize (writeState strips local prefs).
  // The one-mcp report is NOT fired here — only the single onboarding-finalized
  // gate above reports.
  if (!targetPath || !fs.existsSync(targetPath)) return noop();
  return outcomeToResult(materializeProjectFromState(projectRootFromStateFilePath(targetPath), { trigger: 'post-stack-setup' }));
}
