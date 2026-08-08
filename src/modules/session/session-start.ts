// src/modules/session/session-start.ts
// SessionStart: one-mcp sync, the authed path, and runSessionStart.

import { obj, type Rec } from '../../shared/obj';
import * as fs from 'fs';
import * as path from 'path';
import { context, mergeResults, noop } from '../../core/result';
import type { Ctx, HookResult, ResultMeta } from '../../core/types';
import { isKnownStack } from '../../shared/config';
import { detectMode, detectStackFromCodebase, reconcileStackFromArtifacts } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { autoDetectedAnnouncement } from '../../shared/directives';
import { buildOrchestrationDirective } from '../plan-guard/build-orchestration-directive';
import { isNewProjectOnboardingIncomplete } from '../../shared/onboarding/predicates';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../../shared/onboarding/local-prefs';
import { packBundle } from '../../shared/packing';
import { pluginRoot } from '../../shared/paths';
import { cleanActiveSkills, copyActiveSkills, listAllSkills, pruneSkillsDirective } from '../../shared/skill-filters';
import {  onboardingSetTechCommandTemplate, onboardingSyncSessionId } from '../../shared/onboarding-server/wait-command';
import {
  techClassifyHints,
  techClassifyRequiredCompactReason,
  techClassifyRequiredReason,
} from '../../shared/onboarding-server/tech-classify-setup';
import { makeSkillBlock } from '../../shared/skill-block';
import {  STACKS, stackSpecForState } from '../../shared/stacks';
import {
  ensureCurrentRunId,
  hasRunAgentState,
  hookSessionIdentity,
  isMaintenancePhase,
  isSubagentThread,
  legacyRunAgentContext,
  legacyStatePath,
  maintenanceLifecycle,
  normalizeState,
  pruneExpiredPendingClaims,
  readEffectiveState,
  reconcileRunIdentityDrift,
  recordRunStackDrift,
  resolveRunAgentContext,
  runIdentityFrozen,
  runReachedTerminalVerdict,
  scrubProjectStateLocalPrefs,
  stackFingerprint,
  statePath,
  stateVersion,
  writeState,
} from '../../shared/state';
import { initializeToolchainState } from '../../shared/state/toolchain';
import { hasLocalPreferenceFields } from '../../shared/state/local-prefs';
import { readJson } from '../../shared/fsjson';
import { applyExistingCodebaseDetection } from '../../shared/onboarding/detection-stamp';
import { nowIsoNoMs } from '../../shared/text';
import { ensureAgentTeamsEnv, ensureCodeGraphForExistingProject, ensureOpenCodeDelegationReady, ensureSessionMaterialization, readGraphPreview, sweepOldDigests, tokenEconomyBanner, uncertifiedHostBanner } from './session-start-lib';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { sweepTrafficOneRetention } from '../../shared/retention';
import {
  oneMcpSessionWarning,
  syncOneMcpForSessionStart,
  syncOneMcpOnce,
  type SessionOneMcpSync,
} from './one-mcp-sync';
import { sessionPerformanceContext } from '../../shared/session-performance-context';
import { ensureRunModelPolicy, readRunModelPolicy, runModelPolicyPath } from '../../shared/run-model-policy';
import { canonicalHost } from '../../shared/model-tiers';
import { detectHostPlan } from '../../shared/host/plan';
import { finalizePaidMaintenanceFallback } from '../../shared/maintenance/fallback';
import { reconcileRunSettlement } from '../../shared/run-settlement';
import { legacyCustomBackendMigration } from '../../shared/architecture-contract';
import { capabilityStateForRun } from '../../shared/architecture-contract';
import { freshCursorModels } from '../../shared/materialize/cursor-models';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import { initializeTrafficOneEnv } from '../../shared/state/runtime-env';

import {
  STACK_IDS,
  sessionProjectRoot,
  setupPendingBanner,
  setupPendingDirective,
  subagentRoleContext,
  runSubagentSessionStart,
} from './session-start-setup';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginUseDeclined, projectWritesPermitted } from '../../shared/state/plugin-use';
import { authEnforced, isLocallyAuthenticated } from '../../shared/auth';
import { ensureCodexOneMcpServerRegistered } from '../../shared/codex-mcp';
import { ONE_MCP_REGISTRATION } from '../../config/one-mcp';
import { removeStrayProjectArtifactsFromGlobalDir } from '../../shared/state/traffic-one-paths';

// Appended to the session header when any of runSessionStartAuthed's state stamps
// was refused. Names the fence and the exact path, the way persistCompiledArchitecture
// does, and says what the operator can act on — the rule bundle beside it is still
// valid, so this is an advisory, not a deny.
const STATE_NOT_RECORDED = '[traffic-one] session state was NOT recorded: the write fence refused '
  + '`.traffic-one/.one.json`, so this session\'s mode/stack/materialization stamps are not on disk and every later '
  + 'hook re-derives them from scratch. A symlink planted at that path is the usual cause (the fence refuses writing '
  + 'through a link, dangling or not) — restore it as a regular file. The rule context below is unaffected.\n';

function runSessionStartInner(ctx: Ctx): HookResult {
  // Self-heal machines the pre-guard bug touched: project artifacts materialized
  // into the machine dir (session cwd = $HOME) are never legitimate there.
  // Deletes only never-legitimate names; runs before the stand-down guard so a
  // $HOME session still heals itself.
  removeStrayProjectArtifactsFromGlobalDir();
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = sessionProjectRoot(ctx);
  initializeTrafficOneEnv(cwd, ctx.host);
  // The user chose not to use Traffic One for this project — stay silent.
  // (UserPromptSubmit offers re-enabling when the user explicitly names it.)
  if (pluginUseDeclined(cwd)) return noop();
  // Codex registration is machine-global and deliberately inert: the managed
  // server is appended disabled with both tools disabled, and an existing
  // same-name table owned by the user is never rewritten. It sits BELOW the
  // stand-down above rather than above it: the product tells the user that
  // declining means Traffic One stands down, and above the guard a session in a
  // declined project would append to ~/.codex/config.toml — outside the project,
  // but still a write the user had just refused. Nobody has been hit by that,
  // because ONE_MCP_REGISTRATION is false and the whole branch is dead; the
  // ordering was a contradiction waiting for the flag to flip. Determinism does
  // not need this call site either way: the same registration is reachable from
  // the explicit one-mcp-host runner, and every project the user did NOT decline
  // still performs it.
  if (ctx.host === 'codex' && ONE_MCP_REGISTRATION) {
    ensureCodexOneMcpServerRegistered({ ...process.env, TRAFFIC_ONE_HOST: 'codex' });
  }

  // A subagent must never run the full session-start hook (auth gate + onboarding +
  // mode routing). Onboarding belongs to the parent/main agent; the subagent only
  // needs its role-scoped rules. Intercept BEFORE auth + onboarding so a subagent
  // can never re-trigger onboarding while the team is building.
  if (isSubagentThread(ctx.input.raw)) {
    return runSubagentSessionStart(ctx);
  }

  // Advisory context merged onto whatever this SessionStart run returns —
  // never a deny, never a substitute for it. The one-mcp sync warning and the
  // uncertified-host banner (shared/host/tiers.ts) are both this shape.
  const oneMcpWarning = syncOneMcpAtSessionStart(cwd, ctx.host, ctx.input.raw);
  const uncertifiedBanner = uncertifiedHostBanner(cwd, ctx.host, hookSessionIdentity(ctx.input.raw).sessionId);
  const advisories = [oneMcpWarning, uncertifiedBanner].filter((text): text is string => Boolean(text));
  const withAdvisories = (result: HookResult): HookResult => advisories.length
    ? mergeResults([...advisories.map((text) => context(text)), result])
    : result;

  // Auth gate: a pure local boolean read — no per-session remote check. When auth
  // is enforced but the API key isn't entered yet, point at the wizard (the
  // same setup-pending surface onboarding uses). The wizard shows the api-key page
  // because computeOnboarding returns the 'api-key' step while unauthenticated —
  // covering both a fresh project and an already-onboarded one a 401 invalidated.
  if (authEnforced() && !isLocallyAuthenticated()) {
    return withAdvisories(context(setupPendingDirective(ctx, cwd), {
      systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [authentication required]'),
    }));
  }

  // Defer brand-new-project activation to the first prompt. SessionStart fires
  // before any prompt exists, so eagerly writing state + emitting the setup
  // directive here would trip the onboarding gate even for a non-coding question
  // — and Codex opens a fresh scratch dir per task, so EVERY session would look
  // like a new project. Leave a pristine dir untouched and stay silent; the
  // UserPromptSubmit coding-intent guard activates Traffic One only when the
  // first prompt is actually a coding/implementation request (it re-runs this
  // authed body then). An existing codebase still auto-detects below, because its
  // mode is existing-codebase, not new-project.
  const pristine = !fs.existsSync(statePath(cwd)) && !fs.existsSync(legacyStatePath(cwd));
  if (pristine && detectMode(cwd) === 'new-project') return withAdvisories(noop());

  return withAdvisories(runSessionStartAuthed(ctx));
}

// OpenCode/Kilo can invoke their SessionStart-compatible system transform more
// than once per chat. Consent and the runtime switch are checked BEFORE writing
// the per-session marker; payloads without a stable session id deliberately run
// every time because duplicates are safe and guessing an identity is not.

// The sync defaults to `syncOneMcpForSessionStart`, NOT `syncOneMcpForSession`:
// on a host that already has a usable cached model config the worker is fired
// detached, so SessionStart stops blocking on a second full node process. The
// blocking form is kept for the cold-cache case (and for the onboarding-wait
// runner, which genuinely depends on the result — see consent.ts).
//
// BEHAVIOUR THIS CHANGES, stated rather than buried. On the detached path the
// warning below reads the diagnostic the PREVIOUS sync left, because the child
// writes it after this hook has returned. A sync that fails now surfaces its
// advisory one session later than it used to. It cannot surface a WRONG one:
// `claimOneMcpWarningKey` keys on (host, configName, reason, requested,
// observed), so an already-shown diagnostic stays claimed and a new one is
// shown exactly once, whenever it lands.
export function syncOneMcpAtSessionStart(
  cwd: string,
  host: unknown,
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
  sync: SessionOneMcpSync = syncOneMcpForSessionStart,
  featureEnabled?: boolean,
): string | null {
  const sessionId = onboardingSyncSessionId(hookSessionIdentity(raw).sessionId);
  if (!syncOneMcpOnce(cwd, host, sessionId, env, sync, featureEnabled)) return null;
  return oneMcpSessionWarning(host, env);
}

// The post-auth SessionStart body: skill sweep + digest retention + session
// materialization → subagent fast path → mode-routed rule bundle / directive.
// Exported so its post-gate behavior can be tested directly.
export function runSessionStartAuthed(ctx: Ctx): HookResult {
  const cwd = sessionProjectRoot(ctx);
  initializeTrafficOneEnv(cwd, ctx.host);
  const root = pluginRoot();
  const raw = ctx.input.raw;

  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });

  // ── Ask-first: nothing below this line may touch the project ──────────────
  // Everything after this point writes: the legacy-backend migration and the
  // settlement/identity reconcilers write state, the sweep block deletes
  // (digests, retention) and materializes, and all three flows write state and
  // copy the rule/skill tree. None of it may happen before the user has
  // answered "do you want to use Traffic One here?".
  //
  // Measured on an ONBOARDED project with the answer still pending — a repo
  // cloned to a second machine, a moved directory, a pre-ASK_USE_PLUGIN_FIRST
  // install, or a cleared choice, all of which present as "mode-bearing
  // .one.json, no recorded answer" — this body removed 69 paths and wrote 151,
  // and the removals are irreversible. The hook entry already stands down on a
  // DECLINE (runSessionStartInner); the gap was the pending case, and pending
  // is the common one.
  //
  // What the user sees is the question and nothing else — the same
  // setup-pending pair Flow 2 used to emit for this state, hoisted to cover
  // every mode instead of only existing-codebase. Deliberately NOT a "skipped
  // housekeeping" banner: that would explain plugin internals to someone who
  // has not yet agreed to run the plugin, and the only thing they can act on is
  // the question itself. The uncertified-host advisory still merges on top of
  // this result in runSessionStartInner, because an uncertified host is
  // material to the very decision being asked for.
  //
  // This is the caller-side half of the fence. The other half is the write
  // primitives themselves (shared/fsjson.ts), which refuse the same paths even
  // if a future edit reintroduces a call above — a fence that only exists here
  // is the one that has now been forgotten three times.
  if (!projectWritesPermitted(cwd)) {
    return context(setupPendingDirective(ctx, cwd), {
      systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
    });
  }

  // Every writeState below lands on the same `.traffic-one/.one.json`, and the
  // fence's refusal of it is durable, so ONE flag carries all of them: this
  // session's stamps (the migrated backend, the reconciled stack, the
  // materialization record, the toolchain skeleton, `mode`) either reach disk or
  // none of them do. SessionStart must never fail a session over a refused write
  // (see fsjson.ts), so this is reported in the header each flow returns rather
  // than thrown — but it must not hand back a session context that describes
  // state no later hook can read back either, which is what dropping these five
  // booleans did.
  //
  // The notice is attached HERE, once, wrapping every context this body can
  // return, rather than at the eleven return sites below: three of those exits
  // discard the `header` local they build (Flow 2's local-preference exit is one),
  // so a per-site notice is both easy to misplace and easy for the next edit to
  // forget — which is the shape of the defect being fixed.
  let stateRecorded = true;
  const sessionContext = (text: string, meta?: ResultMeta): HookResult => (
    context(stateRecorded ? text : `${STATE_NOT_RECORDED}${text}`, meta ?? {})
  );
  const legacyMigration = legacyCustomBackendMigration(cwd, state);
  if (legacyMigration.changed) {
    Object.assign(state, legacyMigration.state);
    if (!writeState(cwd, state)) stateRecorded = false;
  }
  const settlementRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  // Reconcile only unresolved work. A completed legacy ledger predates the V2
  // evidence sidecars; reopening it as `validating` during a read-only session
  // start would resume/upgrade historical work instead of preserving backward
  // compatibility. New prompt-boundary work receives a fresh strict run.
  if (settlementRunId) {
    const fallback = finalizePaidMaintenanceFallback(cwd, settlementRunId);
    if (fallback.status !== 'completed'
      && !runReachedTerminalVerdict(cwd, settlementRunId)) {
      reconcileRunSettlement(cwd, settlementRunId);
    }
  }

  // Un-wedge a project whose run identity already drifted away from its claims
  // (a ledger with no frozen fingerprint, or a sibling run minted beside a live
  // team). Idempotent and silent when there is nothing to repair, so a project
  // broken by an earlier runtime heals on its next session with no user action.
  try {
    reconcileRunIdentityDrift(cwd, state);
  } catch {
    // Never fail SessionStart on a best-effort repair.
  }

  // Multi-project safety: reset to the 3-skill baseline before copying THIS
  // project's set. Digest retention sweep. Best-effort session materialization.
  cleanActiveSkills();
  sweepOldDigests(cwd, 5);
  pruneExpiredPendingClaims(cwd);
  sweepTrafficOneRetention(cwd, { dryRun: false });
  // Deterministic self-heal: strip any machine-local preference fields (team, toolchain
  // with absolute binPaths, performance, …) a stale runner may have left in the committed
  // .one.json, routing them to the per-user preferences.json. .one.json is not gitignored.
  // `false` from the scrub is ambiguous by construction — "already clean" and
  // "the fence refused the rewrite" are the same answer — and a banner on every
  // clean session would be worse than none. So ask the question this scrub's
  // consumer asks, of the RAW file it asks it of: is the leak still there? That
  // read-back is what the boolean cannot give, and it matters because `.one.json`
  // is NOT gitignored — a surviving leak is a machine-absolute binPath committed
  // to a teammate's checkout.
  if (!scrubProjectStateLocalPrefs(cwd) && hasLocalPreferenceFields(readJson<Rec>(statePath(cwd), {} as Rec))) {
    stateRecorded = false;
  }
  try {
    ensureSessionMaterialization(cwd, state);
  } catch {
    // best-effort; the full branches below still provide rule context
  }

  // ── Subagent fast path (legacy run-agent contexts; detected subagents are
  // already intercepted before auth in runSessionStartInner) ──
  const agentContext = resolveRunAgentContext(cwd, state, raw, { claimPending: true, host: ctx.host })
    || (!hasRunAgentState(cwd, state) ? legacyRunAgentContext(state) : null);
  if (agentContext && hasMaterializedProjectAssets(cwd, state)) {
    return subagentRoleContext(ctx, state, agentContext, root);
  }

  const mode = (state.mode as string) || detectMode(cwd);
  state.mode = mode;
  let stackId = state.stack as string | undefined;
  if (mode === 'new-project' && reconcileStackFromArtifacts(cwd, state)) {
    normalizeState(state, mode);
    if (!writeState(cwd, state)) stateRecorded = false;
    try {
      ensureSessionMaterialization(cwd, state);
    } catch {
      // best-effort; the normal materialization branch below still provides context
    }
    stackId = state.stack as string | undefined;
  }
  if (stackId && isKnownStack(stackId)) {
    normalizeState(state, mode);
    stackId = state.stack as string;
  }

  const onboardingComplete = Boolean(state.onboardingComplete);
  const onboardingReady = onboardingComplete
    && typeof stackId === 'string' && STACK_IDS.has(stackId)
    && (mode !== 'new-project' || !isNewProjectOnboardingIncomplete(state, ctx.host));
  // Preference acknowledgements are keyed by the canonical project root. Never
  // let a nested package or the hook process cwd select another project's hash.
  const localPreferenceTarget = currentLocalPreferenceTarget(
    ctx.host,
    { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
    cwd,
  );

  // ── Flow 1 — already onboarded → pack the rule bundle ──
  if (onboardingReady) {
    const activeStackId = String(stackId);
    if (nextLocalPreferenceStep(state, ctx.host, localPreferenceTarget)) {
      return sessionContext(`[ACTIVE STACK: ${activeStackId}]\n\n${setupPendingDirective(ctx, cwd)}`, {
        systemMessage: setupPendingBanner(ctx, cwd, `traffic-one [${activeStackId}] setup required`),
      });
    }

    const capabilityState = capabilityStateForRun(cwd, state);
    const spec = stackSpecForState(capabilityState);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;

    const copied = copyActiveSkills(capabilityState, ctx.host);
    const skillDirective = pruneSkillsDirective(capabilityState, listAllSkills(), ctx.host);
    stampMaterialization(cwd, state);
    // The materialized project AGENTS.md/CLAUDE.md (just re-stamped) carries the
    // same Active Rule Index and is auto-loaded by every host — re-listing the
    // paths here duplicates ~400-500 tokens per session. Emit the full bundle
    // only when the mirror is missing.
    const body = hasMaterializedProjectAssets(cwd, state)
      ? 'Active rules are indexed in the project AGENTS.md / CLAUDE.md (read rule bodies on demand from `.traffic-one/rules/**`).\n'
      : packBundle(root, modeMandatory, spec.optional).body;
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the code graph if an existing project is missing it

    // Freeze the model catalog before any parent-side spawn map is emitted. The
    // run snapshot is create-once; a later machine-global One MCP update affects
    // the next run, never children already pinned to this one.
    const team = obj(state.team);
    const existingRunId = typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
    // SessionStart runs before the prompt is known. Do not pre-mint a maintenance
    // run here: runtime-only prompts must remain parent-only and create no run.
    // Worker-routing/model gates freeze policy when an implementation prompt
    // actually starts work. Existing runs still get their immutable policy read.
    if (team?.mode === 'subagents' && (!isMaintenancePhase(state, mode) || existingRunId)) {
      const runId = ensureCurrentRunId(cwd, state);
      const policy = ensureRunModelPolicy(
        cwd,
        runId,
        ctx.host,
        state,
        { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
      );
      if (!policy) {
        // A null policy has three distinct causes and only one of them is
        // repaired by Performance. Telling every session to "Reopen Performance"
        // sends the user to a wizard that CANNOT touch a create-once policy that
        // is already frozen — observed 16co, where a failing parent bootstrap
        // preflight wedged every session behind an unactionable message. Same
        // discrimination, token vocabulary, and ordering as the onboarding gate
        // (modules/onboarding-gate/handler.ts) and the setup-completion runner
        // (runners/onboarding-wait/pre-spawn-directives.ts).
        const frozenPolicy = readRunModelPolicy(cwd, runId);
        // Capture is the only action that can still make an UNPUBLISHED Cursor
        // policy buildable; once the path exists (valid or corrupt) create-once
        // forbids rebasing it, so capture would be busy-work.
        if (ctx.host === 'cursor'
          && !fs.existsSync(runModelPolicyPath(cwd, runId))
          && freshCursorModels(cwd, detectHostPlan('cursor')).length === 0) {
          return sessionContext(
            `TRAFFIC_ONE_CURSOR_MODELS_REQUIRED\nBefore run ${runId} can be frozen, enumerate the exact model ids in Cursor's Task picker and run:\n`
            + `${modelCaptureCommand(cwd, 'cursor')}\n`
            + 'Then retry the parent action. Traffic One will create model-policy.json only after those exact runnable slugs are available.',
            { systemMessage: 'traffic-one: capture Cursor subagent models before starting the immutable run' },
          );
        }
        if (frozenPolicy && frozenPolicy.host !== canonicalHost(ctx.host)) {
          return sessionContext(
            `TRAFFIC_ONE_MODEL_POLICY_BLOCKED\nRun ${runId} is frozen for ${frozenPolicy.host}, not ${canonicalHost(ctx.host)}. `
            + 'Start a new parent run for the active host; do not rebase or replace model-policy.json.',
            { systemMessage: 'traffic-one: this run is frozen for another host — start a new parent run' },
          );
        }
        if (frozenPolicy) {
          return sessionContext(
            `TRAFFIC_ONE_BOOTSTRAP_BLOCKED\nRun ${runId} already has a valid immutable model policy and saved Performance choice, but Traffic One `
            + 'could not publish or validate its capability baseline and parent bootstrap. Do not spawn a child and do not redo onboarding; '
            + 'Performance cannot repair this. Update or repair Traffic One, then retry this parent session with the same run.',
            { systemMessage: 'traffic-one: subagent spawning paused until the run capability baseline and parent bootstrap can be published' },
          );
        }
        return sessionContext(
          `TRAFFIC_ONE_MODEL_POLICY_BLOCKED\nThe acknowledged Performance target could not be frozen for run ${runId}. `
          + 'Do not spawn a child. Reopen Performance and retry this parent session after the active host/plan target is acknowledged.',
          { systemMessage: 'traffic-one: subagent spawning paused until the immutable run model policy can be created' },
        );
      }
    }

    let header = `═══ traffic-one — stack: ${stackId} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    header += sessionPerformanceContext(state, ctx.host, process.env, cwd);
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd, state.codeGraphProvider);
    const orchestration = buildOrchestrationDirective(cwd, ctx.host, state);
    if (orchestration) header += `${orchestration}\n`;
    if (!writeState(cwd, state)) stateRecorded = false;
    return sessionContext(`${header}${graphPreview}\n${body}`);
  }

  // ── Flow 2 — existing project with detectable stack → auto-write + prune ──
  if (mode === 'existing-codebase' || mode === 'existing-with-supabase') {
    // The ask-first question used to be answered HERE, which is why an
    // onboarded project (Flow 1, above) never reached it. It now guards the
    // whole body — see the projectWritesPermitted return above.
    //
    // The stamp itself lives in shared/onboarding/detection-stamp so the
    // onboarding-wait runner can apply the SAME write at consent time (SessionStart
    // cannot: it writes nothing while the use-plugin question is pending). Mutates
    // `state` in place; persistence stays with the single writeState below, after
    // stampMaterialization has added its fields.
    const detected = applyExistingCodebaseDetection(cwd, state, mode);
    // Undetectable: the deterministic tables derived no stack, and the historical
    // `stack: 'minimal'` floor is gone — the SESSION AGENT classifies instead.
    // ZERO writes here (the repo stays byte-identical until the agent's
    // `--set-tech` submission lands through the shared writer).
    if (!detected.stack) {
      const template = onboardingSetTechCommandTemplate(cwd, ctx.host, onboardingSyncSessionId(hookSessionIdentity(ctx.input.raw).sessionId));
      const hints = techClassifyHints(detected);
      const reason = ctx.host === 'opencode' || ctx.host === 'kilo'
        ? techClassifyRequiredCompactReason(template, hints)
        : makeSkillBlock(pluginRoot)('onboarding-gate', 'tech-classify-required', {
          SET_TECH_TEMPLATE: template,
          HINTS: hints,
        }, techClassifyRequiredReason(template, hints));
      return sessionContext(reason, {
        systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
      });
    }

    const capabilityState = capabilityStateForRun(cwd, state);
    const spec = stackSpecForState(capabilityState);
    const modeRulePath = `rules/modes/${mode}.md`;
    const modeMandatory = fs.existsSync(path.join(root, modeRulePath)) ? [...spec.mandatory, modeRulePath] : spec.mandatory;
    const { body } = packBundle(root, modeMandatory, spec.optional);

    const copied = copyActiveSkills(capabilityState, ctx.host);
    const allSkills = listAllSkills();
    stampMaterialization(cwd, state);
    ensureCodeGraphForExistingProject(cwd, state); // self-heal: build the graph for a freshly auto-detected existing project
    if (!writeState(cwd, state)) stateRecorded = false;
    const skillDirective = pruneSkillsDirective(capabilityState, allSkills, ctx.host);

    const banner = autoDetectedAnnouncement(detected as never);
    let header = `═══ traffic-one — stack: ${state.stack} · mode: ${mode} · frontend: ${state.frontend || 'none'} · backend: ${state.backend || 'none'} ═══\n`;
    header += sessionPerformanceContext(state, ctx.host, process.env, cwd);
    if (copied > 0) header += `[skills] ${copied} stack-specific skills activated. Fully visible in next session; available now via the active-skills directive above.\n`;
    header += tokenEconomyBanner(cwd);
    header += ensureOpenCodeDelegationReady(cwd, state); // zero-touch: Codex MCP registration + missing-CLI self-heal
    header += ensureAgentTeamsEnv(cwd, ctx.host); // zero-touch: enable senior-team continuation (one agent per role)
    ensureRunnerShims(); // version-stable runner paths under ~/.traffic-one/bin (host approvals survive plugin bumps)
    if (skillDirective) header += skillDirective;
    const graphPreview = readGraphPreview(cwd, state.codeGraphProvider);
    if (nextLocalPreferenceStep(state, ctx.host, localPreferenceTarget)) {
      return sessionContext(`${banner}\n\n${setupPendingDirective(ctx, cwd)}`, {
        systemMessage: setupPendingBanner(ctx, cwd, `traffic-one [${state.stack || mode}] setup required`),
      });
    }
    return sessionContext(`${banner}\n\n${header}${graphPreview}\n${body}`);
  }

  if (mode === 'new-project' && stackId && isNewProjectOnboardingIncomplete(state, ctx.host)) {
    return sessionContext(`[ACTIVE STACK: ${stackId}]\n\n${setupPendingDirective(ctx, cwd)}`, {
      systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
    });
  }

  // ── Flow 3 — new project (or undetectable existing) → point at the setup wizard ──
  // On Cursor the directive carries the live URL + "post the link FIRST" recipe in the
  // agent-facing channel (additional_context); other hosts keep the plain note.
  const directive = setupPendingDirective(ctx, cwd);
  const spec = STACKS.minimal;
  const { body } = packBundle(root, spec.mandatory, spec.optional);
  // Reached only once the answer exists and is yes (the projectWritesPermitted
  // return above), so the stub state (mode + toolchain skeleton) is stamped
  // unconditionally here — the ask-first check this branch used to repeat now
  // guards the whole body.
  if (!obj(state.toolchain)) state.toolchain = initializeToolchainState();
  if (!writeState(cwd, state)) stateRecorded = false;
  return sessionContext(`${directive}\n\n═══ Baseline rules (in effect until onboarding completes) ═══\n${body}`, {
    systemMessage: setupPendingBanner(ctx, cwd, 'traffic-one [setup required]'),
  });
}

// Stamp materialization fields after a successful copy (best-effort).
function stampMaterialization(cwd: string, state: Rec): void {
  try {
    const materialized = materializeProjectAssets(cwd, state);
    if (!materialized.skipped) {
      state.materializedStack = stackFingerprint(state);
      state.materializedAt = nowIsoNoMs();
      state.materializedVersion = stateVersion();
    }
  } catch {
    // best-effort; the in-memory bundle is still provided
  }
}

// Fail-closed: a throw anywhere in SessionStart must never crash the hook. The
// auth instruction / noop still surfaces; the try/catch below guarantees exit-0.
export function runSessionStart(ctx: Ctx): HookResult {
  try {
    return runSessionStartInner(ctx);
  } catch {
    return noop();
  }
}
