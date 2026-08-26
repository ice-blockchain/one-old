// src/shared/onboarding-server/flow.ts
// The onboarding flow engine: computeOnboarding + applyAnswer over the
// view/meta helpers in flow-view.ts.

import * as path from 'path';

import { classifyPromptForStack, detectStackFromCodebase, promptHasStackSignal, reconcileStackFromArtifacts } from '../detection';
import { authEnforced, isLocallyAuthenticated } from '../auth';
import { obj, type Rec } from '../obj';
import { isNewProjectOnboardingIncomplete } from '../onboarding/predicates';
import { nextOnboardingStep } from '../onboarding/prompts';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../onboarding/local-prefs';
import {
  inheritWorkspacePrefsToMembers,
  isSharedWorkspaceAnswerStep,
  workspaceContainerView,
} from '../onboarding/workspace-inherit';
import {
  projectContextOriginalPrompt,
} from '../onboarding/project-context';
import { detectHost } from '../host';
import { hostFlags } from '../host/capability-flags';
import { readPluginUseChoice } from '../state/plugin-use';
import { currentModelsForTier } from '../current-model-tiers';
import {   teamModeForLevel, type PlanCtx } from '../performance';
import { stateTimestamp } from '../state/io';
import { windsurfBackend } from '../windsurf-backend';
import {
  clearProjectHostPrefs,
  mergeProjectHostPrefs,
  mergeProjectPrefs,
  readEffectiveState,
  readState,
  writeGlobalCodeGraphProvider,
  writeState,
} from '../state';

import { WORKSPACE_PROJECT_MODE } from '../hook/workspace-members';

import {
  buildTeamLineup,
  deviceFingerprint,
  deviceName,
  effectiveOnboardingState,
  enrichStepMeta,
  lacksDurableOnboardingState,
  metaForStep,
  stepWhenDurablePrefsMissing,
  wizardStepFromRaw,
  workspaceWaitingMeta,
  type AnswerOutcome,
  type OnboardingView,
  type WizardStep,
} from './flow-view';
import {
  persistWizardSharedFields,
  wizardSharedWriteWillNotHeal,
  wizardStateWriteRefused,
} from './wizard-state-write';

// State as the preference-step router should see it: with the stamped stack, or
// — when the stamp hasn't landed yet (ask-first same-session flow, or a wiped
// .traffic-one) — the freshly DETECTED one. Detection returning nothing leaves
// the state untouched, preserving the sparse-repo no-wizard behavior.
function stackRoutingState(cwd: string, state: Rec): Rec {
  if (typeof state.stack === 'string' && state.stack) return state;
  const detected = detectStackFromCodebase(cwd);
  return detected.stack ? { ...state, stack: detected.stack } : state;
}

// A workspace may hold a workspace. The recursion below is bounded by the same
// kind of constant every walk in hook/paths.ts uses rather than by an argument
// a caller could get wrong: a member is strictly INSIDE its container, so the
// chain is already bounded by directory depth, and this only caps the
// pathological case. A member reached at the cap is reported PENDING, never
// done — the safe direction, since "done" is what unblocks work.
const MAX_WORKSPACE_NESTING = 4;

export function computeOnboarding(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingView {
  return computeOnboardingAt(cwd, env, 0);
}

function computeOnboardingAt(
  cwd: string,
  env: NodeJS.ProcessEnv,
  depth: number,
): OnboardingView {
  const { state, mode } = effectiveOnboardingState(cwd, env);
  const originalPrompt = projectContextOriginalPrompt(state);
  const host = detectHost(env);

  // The durable per-project opt-out is evaluated before auth or any onboarding
  // step. A declined project is terminally done even when machine auth is absent
  // or malformed, and the supplied environment owns both preference and auth
  // path resolution.
  if (readPluginUseChoice(cwd, env)?.enabled === false) {
    const meta = metaForStep(null, originalPrompt);
    meta.declined = true;
    return {
      mode,
      stack: null,
      step: null,
      done: true,
      originalPrompt,
      meta,
      hostname: deviceName(),
      deviceId: deviceFingerprint(),
    };
  }

  // Web auth gate. Until the user enters the API key on the wizard's api-key page,
  // the ONLY unresolved step is 'api-key' — the FIRST wizard step on a fresh
  // project, and the ONLY step shown for an already-onboarded project that has
  // lost its local auth record (deleted, or unparseable).
  //
  // A REMOTE REJECTION reaches this step too, and does so without any code here:
  // validateApiKey now runs at a second site, the background revalidation worker
  // (runners/auth/revalidate.ts, fired detached from SessionStart at most once
  // per AUTH_REVALIDATION_CADENCE_MS per machine), and a 401 carrying
  // `invalid_token` makes it clear the auth record. The next computeOnboarding
  // then finds no record and returns 'api-key' — one predicate, three causes.
  //
  // What does NOT re-open this step, deliberately: an unreachable endpoint, a
  // rate-limited probe, or an auth-PROVIDER outage (the server's `unkey_
  // unavailable`, a 401 that means "we could not check"). Those spend the
  // offline grace window instead (shared/auth/offline-grace.ts), because sending
  // an offline user here is a dead end — this very step's /answer route
  // validates through the same endpoint and would reject them for the same
  // reason that got them cleared.
  //
  // Gated on authEnforced so dev/test runs with TRAFFIC_ONE_AUTH=0 keep their
  // existing onboarding flow.
  if (authEnforced(env) && !isLocallyAuthenticated(env)) {
    return {
      mode,
      stack: typeof state.stack === 'string' ? state.stack : null,
      step: 'api-key',
      done: false,
      originalPrompt,
      meta: metaForStep('api-key', originalPrompt),
      hostname: deviceName(),
      deviceId: deviceFingerprint(),
    };
  }

  let step: WizardStep;
  let done: boolean;
  const localPreferenceTarget = currentLocalPreferenceTarget(host, env, cwd);

  // ── The workspace CONTAINER branch ─────────────────────────────────────────
  // A container is not a codebase, and every arm below follows from that one
  // fact. Reached only for `mode: 'workspace'`, which no project carried before
  // this wave, so every existing shape falls straight through.
  //
  // What it fixes, measured on a two-member container whose registry was minted
  // by the product's own writer: WITHOUT this branch the container fell into
  // the existing-codebase arm below, `stackRoutingState` derived no stack for
  // it (correctly — it has none), and the wizard demanded `tech-detect`. That
  // asks the session agent to classify the tech stack of a directory that by
  // construction has no single one, and setup could never complete.
  if (mode === WORKSPACE_PROJECT_MODE) {
    const container = workspaceContainerView(cwd);
    if (container.isContainer) {
      return workspaceContainerOnboarding(cwd, state, container, env, host, originalPrompt, localPreferenceTarget, depth);
    }
    // `mode` said workspace and the registry reader disagrees — the state file
    // the two read is the same file, so this is only reachable through a legacy
    // state path. Fall through to the ordinary router rather than inventing a
    // third answer.
  }

  if (mode === 'new-project') {
    if (isNewProjectOnboardingIncomplete(state, host)) {
      step = wizardStepFromRaw(nextOnboardingStep(state, host));
      done = false;
    } else {
      const raw = nextLocalPreferenceStep(state, host, localPreferenceTarget);
      step = (raw as WizardStep) ?? null;
      done = raw == null;
    }
  } else {
    // nextLocalPreferenceStep treats a stack-less state as "no step pending",
    // which reads a DETECTABLE codebase whose stamp hasn't landed yet as done.
    // That state is normal in the ask-first flow: SessionStart deliberately
    // writes nothing while the plugin-use question is pending, and the consent
    // answer runs `--use --bootstrap-only` in the SAME session — so the whole
    // wizard (OpenCode, performance, team, code graph) was skipped for every
    // existing codebase on an already-authenticated machine. Route the step
    // check through fresh detection instead.
    const routed = stackRoutingState(cwd, state);
    if (typeof routed.stack !== 'string' || !routed.stack) {
      // The deterministic tables derived NO stack for a real existing repo (a
      // genuinely-empty dir is `new-project` by detectMode's ≤5-file rule, so
      // this is a repo the tables cannot see — e.g. bare Express). Setup is NOT
      // done: the session agent must classify the tech and submit it via the
      // allow-listed `--set-tech` runner command; the wizard shows a passive
      // waiting page until the classification lands. This used to read as done
      // and print a premature SETUP_COMPLETE, leaving the project half-onboarded.
      step = 'tech-detect';
      done = false;
    } else {
      const raw = nextLocalPreferenceStep(routed, host, localPreferenceTarget);
      step = (raw as WizardStep) ?? null;
      done = raw == null;
    }
  }

  if (done && lacksDurableOnboardingState(cwd, state, host, env, localPreferenceTarget)) {
    done = false;
    step = stepWhenDurablePrefsMissing(cwd, state, mode, host, localPreferenceTarget);
  }
  const meta = enrichStepMeta(metaForStep(step, originalPrompt), step, state, env, localPreferenceTarget);

  return {
    mode,
    stack: typeof state.stack === 'string' ? state.stack : null,
    step,
    done,
    originalPrompt,
    meta,
    hostname: deviceName(),
    deviceId: deviceFingerprint(),
  };
}

/**
 * The container's own view: shared steps here, stack steps nowhere, done only
 * when every member is done.
 *
 * THREE THINGS THE CONTAINER IS NOT ASKED, and each omission is the point:
 *
 *   - a STACK. `tech-detect`, `project-context`, `mobile` and `finalize` all
 *     describe one codebase. The members are the codebases; the container has
 *     no stack to classify and nothing to derive one from.
 *   - a MEMBER LIST. An empty registry is a refusal, not a to-do — see
 *     WorkspaceStepInfo. Nothing here enumerates the directory, offers a
 *     chooser, or registers anything: registration happens when a person runs
 *     setup ON the member they mean.
 *   - anything a member already answered. The shared steps run against the
 *     CONTAINER's own preference bucket, once, and reach members through
 *     onboarding/workspace-inherit.ts.
 *
 * The shared-step router is `nextLocalPreferenceStep`, unchanged, with one
 * substitution that has to be named rather than hidden: it opens with
 * `if (!s.stack) return null`, a guard that exists so a SPARSE repo — one whose
 * stack is not yet known — is not asked for preferences it may not need. A
 * container's stack is not unknown, it is absent by construction, which is the
 * opposite fact reaching the same test. The sentinel below satisfies the guard
 * and is never published: the view's `stack` is read from the real state, so a
 * container still reports `stack: null` to every consumer.
 */
const WORKSPACE_ROUTING_STACK = 'workspace-container';

function workspaceContainerOnboarding(
  cwd: string,
  state: Rec,
  container: ReturnType<typeof workspaceContainerView>,
  env: NodeJS.ProcessEnv,
  host: string,
  originalPrompt: string,
  localPreferenceTarget: ReturnType<typeof currentLocalPreferenceTarget>,
  depth: number,
): OnboardingView {
  const base = {
    mode: WORKSPACE_PROJECT_MODE,
    stack: typeof state.stack === 'string' ? state.stack : null,
    originalPrompt,
    hostname: deviceName(),
    deviceId: deviceFingerprint(),
  };

  if (container.why) {
    return {
      ...base,
      step: null,
      done: false,
      meta: workspaceWaitingMeta({
        container: cwd, members: [], pending: [], reason: 'unreadable-registry', why: container.why,
      }),
    };
  }

  // The shared half, answered at the container exactly once.
  const routed = { ...state, stack: WORKSPACE_ROUTING_STACK };
  const sharedStep = nextLocalPreferenceStep(routed, host, localPreferenceTarget);
  if (sharedStep) {
    return {
      ...base,
      step: sharedStep as WizardStep,
      done: false,
      meta: enrichStepMeta(metaForStep(sharedStep as WizardStep, originalPrompt), sharedStep as WizardStep, state, env, localPreferenceTarget),
    };
  }

  // An empty registry is checked AFTER the shared steps, not before, and the
  // order is deliberate: the shared answers are what a member inherits, so a
  // person who registers their first member should find those questions already
  // answered rather than meeting them one directory later.
  if (container.members.length === 0) {
    return {
      ...base,
      step: null,
      done: false,
      meta: workspaceWaitingMeta({ container: cwd, members: [], pending: [], reason: 'empty-registry' }),
    };
  }

  const pending = container.members.filter((member) => {
    if (depth >= MAX_WORKSPACE_NESTING) return true;
    return !computeOnboardingAt(path.join(cwd, ...member.split('/')), env, depth + 1).done;
  });
  if (pending.length > 0) {
    return {
      ...base,
      step: null,
      done: false,
      meta: workspaceWaitingMeta({
        container: cwd, members: container.members, pending, reason: 'members-pending',
      }),
    };
  }
  return { ...base, step: null, done: true, meta: metaForStep(null, originalPrompt) };
}

// Attach the resolved subagent line-up (role → tier → host model) so the wizard's
// team step can SHOW who will build, instead of asking for a blind approval.

// Returns whether the patch actually reached `.traffic-one/.one.json`.
//
// `void` here hid the same fabricated-success defect one indirection deeper than
// the scanner looks: writeState's refusal died in this helper, and three of
// applyAnswerStep's cases returned `{ ok: true }` over it. The wizard then
// advanced past a step whose answer the state file never carried, so the step
// re-opens on the next read with nothing anywhere naming the write that was
// refused — and for `open-code` the field that goes missing is the durable
// authorization the spawn gate cites, so delegation is later denied as "not
// explicitly authorized" for a permission the user did grant.
//
// `persistWizardSharedFields`, not a bare `patchState`. A readable or absent
// file still merges inside the state lock. An illegible file is split:
//
//   - first-time empty / null / torn with no `"stack"` in the RAW bytes heals
//     through `writeState` (quarantine to `.one.json.corrupt`). OpenCode is
//     earlier than `finalize`, so that heal has to live here or a brand-new
//     project whose first write tore can never record delegation.
//   - a torn file whose raw bytes already carry a stack is refused. `readState`
//     answers those with `{}`, and healing would replace a stacked project
//     with one wizard answer plus a version.
//
// `finalize` still uses `writeState` directly: it is the wizard's COMMIT and
// the repair path a stacked-torn file has to heal through.
function patchSharedState(cwd: string, patch: Rec): boolean {
  return persistWizardSharedFields(cwd, patch);
}

// The wizard renders `error` (routes.ts answers 400 `{ ok:false, error }`;
// wizard.html rethrows it into showError), and the step does not advance. Both
// reasons a wizard answer fails to reach disk are durable — a planted symlink
// stays planted, an unanswered "use Traffic One here?" stays unanswered, and a
// torn stacked `.one.json` stays torn — so there is nothing to retry silently;
// name the answer that was not recorded and the specific reason when we have one.
function stateWriteRefused(subject: string, cwd: string, env: NodeJS.ProcessEnv): AnswerOutcome {
  return wizardStateWriteRefused(subject, cwd, env);
}

function mobileFromChoice(value: unknown): { enabled: boolean; framework: string } | null {
  switch (String(value)) {
    case 'web_only':
      return { enabled: false, framework: 'none' };
    case 'ionic_capacitor':
      return { enabled: true, framework: 'ionic-capacitor' };
    case 'react_native_expo':
      return { enabled: true, framework: 'react-native-expo' };
    default:
      return null;
  }
}

function deriveStack(originalPrompt: string, mobileFramework: string): { stack: string; frontend: string; backend: string } {
  const cls = classifyPromptForStack(originalPrompt);
  let { frontend, backend } = cls;
  const { stack } = cls;
  if (mobileFramework === 'react-native-expo') {
    frontend = 'none';
    if (backend === 'none') backend = 'supabase';
  } else if (mobileFramework === 'ionic-capacitor') {
    if (frontend === 'none') frontend = 'react-vite';
    if (backend === 'none') backend = 'supabase';
  }
  // The `stack === 'minimal'` remaps that used to live here are gone with the
  // classifier arm that produced them: it never returns `minimal`, and it never
  // returns a frontend-less stack for a non-mobile web prompt. Ionic no longer
  // PROMOTES the stack id either — `default` carries the pnpm/Turborepo
  // contract, and a brochure brief never asked for one.
  return { stack, frontend, backend };
}

// True when a tool the user opted into still has no per-project toolchain stamp:
// OpenCode enabled but unstamped, or a chosen graph provider unstamped. Drives
// the terminal-answer install-task fallback below — the stamp lives in this
// project's prefs, so a machine-wide provider choice from an earlier project
// does NOT mean this project's toolchain is ready.
function toolchainInstallPending(state: Rec, host: string): boolean {
  const tc = obj(state.toolchain);
  const stamped = (tool: string): boolean => {
    const entry = tc ? obj(tc[tool]) : null;
    return typeof entry?.installedVersion === 'string' && entry.installedVersion.length > 0;
  };
  // Same predicate the toolchain runner already spells with the flag
  // (runners/onboarding-toolchain/index.ts: `!hostFlags(host).opencodeSelfHosted
  // && openCode?.enabled === true`). An OpenCode-compatible host never installs
  // the OpenCode toolchain for itself, so it must not fire the install task here
  // either, or the flow prescribes work the runner will decline.
  if (!hostFlags(host).opencodeSelfHosted && obj(state.openCode)?.enabled === true && !stamped('opencode')) return true;
  const provider = state.codeGraphProvider;
  if ((provider === 'gitnexus' || provider === 'graphify') && !stamped(provider)) return true;
  return false;
}

// The install task normally fires from the code-graph answer. When THIS project
// has already acknowledged and the provider is set, that step is skipped, so
// the task must fire from the flow's terminal answer: 'finalize' for new
// projects, the last unresolved local-preference answer for existing ones.
// Idempotent — the runner stamps present bins and exits fast when everything
// is already installed, and a fresh-machine flow that already ran the task
// from code-graph is stamped by the time finalize lands here.
function attachPendingInstallTask(
  cwd: string,
  step: string,
  outcome: AnswerOutcome,
  env: NodeJS.ProcessEnv,
): AnswerOutcome {
  if (!outcome.ok || outcome.task) return outcome;
  const state = readEffectiveState(cwd, env);
  const host = detectHost(env);
  // Terminal = 'finalize' (new project; it just committed the stack) or, for an
  // already-onboarded project (stack present), the answer that resolved the last
  // local preference. Mid-wizard answers in a NEW project have no stack yet and
  // must never fire the install — it would block the wizard's next question on a
  // potentially minutes-long managed install.
  // Same detection fallback as computeOnboarding's existing-codebase routing:
  // in the ask-first flow the stack is detectable but not yet stamped, and
  // without it the LAST pref answer never fires the install task. The routed
  // state must ALSO drive nextLocalPreferenceStep, or the stack-less null would
  // read as "last answer" on the very first one. A mid-wizard NEW project is
  // unaffected — its directory is empty, so detection finds nothing and the
  // install stays deferred exactly as before.
  const routed = stackRoutingState(cwd, state);
  const hasStack = typeof routed.stack === 'string' && routed.stack.trim() !== '';
  const target = currentLocalPreferenceTarget(host, env, cwd);
  const terminal = step === 'finalize' || (hasStack && nextLocalPreferenceStep(routed, host, target) == null);
  if (!terminal || !toolchainInstallPending(state, host)) return outcome;
  return { ...outcome, task: { kind: 'onboarding-toolchain' } };
}

/**
 * Fan a SHARED answer out to the container's members, immediately after it is
 * recorded.
 *
 * Here rather than inside each `applyAnswerStep` case because the three shared
 * steps write through three different helpers (`mergeProjectPrefs`,
 * `mergeProjectHostPrefs` twice) and the propagation rule is the same for all
 * of them: whatever the container's bucket now holds is what its members hold.
 * Reading the bucket back after the answer, rather than forwarding the answer's
 * own value, is what keeps the two in step — normalization, the performance
 * target metadata and the team line-up derived from the level all happen inside
 * the write, and a member seeded from the raw submitted value would carry a
 * different record than the container it inherited from.
 *
 * `code-graph` is absent from the shared set on purpose: the provider is
 * MACHINE-wide (`~/.traffic-one/one.json`), which every directory already
 * reads, and `codeGraphAcknowledged` is per-project — members must ack
 * themselves. Measured: a member's effective state carried the container's
 * `codeGraphProvider` with nothing copied anywhere.
 *
 * Best-effort by contract. A member that could not take the write is a real
 * failure and it is reported by `inheritWorkspacePrefsToMember`, but it must
 * not turn a recorded container answer into a wizard error — the answer DID
 * land, and re-asking it would be the false report this file's
 * `stateWriteRefused` note exists to prevent.
 */
function fanOutSharedWorkspaceAnswer(cwd: string, step: string, env: NodeJS.ProcessEnv): void {
  if (!isSharedWorkspaceAnswerStep(step)) return;
  if (!workspaceContainerView(cwd).isContainer) return;
  inheritWorkspacePrefsToMembers(cwd, env);
}

export function applyAnswer(
  cwd: string,
  step: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AnswerOutcome {
  const outcome = applyAnswerStep(cwd, step, value, env);
  if (outcome.ok) fanOutSharedWorkspaceAnswer(cwd, step, env);
  return attachPendingInstallTask(cwd, step, outcome, env);
}

function applyAnswerStep(
  cwd: string,
  step: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
): AnswerOutcome {
  switch (step) {
    case 'open-code': {
      const enabled = value === true || value === 'enable' || value === 'enabled';
      // `openCodeDelegation` is the durable authorization the spawn gate cites.
      // Shared write FIRST: writing the per-user toggle first let a failed
      // patch skip this step on refresh (`hasResolvedOpenCodeState` reads prefs)
      // while `.one.json` still lacked the field and delegation was later
      // denied. A refusal that will not heal is named before either write so
      // prefs cannot answer the step alone.
      if (wizardSharedWriteWillNotHeal(cwd, env)) {
        return stateWriteRefused('your OpenCode delegation answer', cwd, env);
      }
      if (!patchSharedState(cwd, {
        openCodeDelegation: { approved: enabled, source: 'onboarding', decidedAt: stateTimestamp() },
      })) {
        return stateWriteRefused('your OpenCode delegation answer', cwd, env);
      }
      mergeProjectPrefs(cwd, { openCode: { enabled, source: 'prompted', decidedAt: stateTimestamp() } }, env);
      return { ok: true };
    }
    case 'performance': {
      const level = String(value);
      if (level !== 'high' && level !== 'balanced' && level !== 'low') {
        return { ok: false, error: 'invalid performance level' };
      }
      const host = detectHost(env);
      if (host === 'windsurf' && windsurfBackend(env) === 'cascade' && level !== 'low') {
        return { ok: false, error: 'Cascade supports main-agent mode only' };
      }
      const target = currentLocalPreferenceTarget(host, env, cwd);
      mergeProjectHostPrefs(cwd, host, {
        performance: {
          level,
          source: 'prompted',
          target: {
            plan: target.plan,
            appliedFingerprint: target.appliedFingerprint,
            configVersion: target.configVersion,
          },
        },
        team: { mode: teamModeForLevel(level), source: 'prompted' },
      }, env);
      return { ok: true };
    }
    case 'team-confirmation': {
      const host = detectHost(env);
      if (host === 'windsurf' && windsurfBackend(env) === 'cascade') {
        return { ok: false, error: 'Cascade does not expose a subagent runner' };
      }
      const v = obj(value);
      const action = (v && typeof v.action === 'string' ? v.action : String(value));
      // "Start the build" confirms the line-up shown for the chosen performance.
      // This is the SINGLE team confirmation — once set, the agent auto-runs the
      // team and never re-asks (see senior-engineer-team rules). "Re-pick
      // performance" clears performance + team to choose again.
      if (action === 'approve' || action === 'continue' || action === 'customise') {
        const state = readEffectiveState(cwd, env);
        const performance = obj(state.performance);
        const level = typeof performance?.level === 'string' ? performance.level : '';
        const existingTeam = obj(state.team);
        const submittedOverrides = v && obj(v.overrides);
        const overrides = submittedOverrides || obj(existingTeam?.overrides);
        let modelSelections: Rec | null = null;
        if (v && Object.prototype.hasOwnProperty.call(v, 'modelSelections')) {
          const requested = obj(v.modelSelections);
          if (!requested) return { ok: false, error: 'invalid team model selections' };

          const target = currentLocalPreferenceTarget(host, env, cwd);
          const planCtx: PlanCtx = { host, plan: target.plan };
          const lineup = buildTeamLineup(level, host, overrides, planCtx, env);
          const expectedRoles = new Set(lineup.map((member) => member.role));
          const requestedRoles = Object.keys(requested);
          if (requestedRoles.length !== expectedRoles.size
            || requestedRoles.some((role) => !expectedRoles.has(role))) {
            return { ok: false, error: 'team model selections must cover the visible team exactly' };
          }

          modelSelections = {};
          for (const member of lineup) {
            const selected = requested[member.role];
            // The picker intentionally exposes only the first two entries in a
            // row. Remaining entries stay runtime fallbacks, not manual choices.
            const allowed = currentModelsForTier(member.tier, host, planCtx.plan, env).slice(0, 2);
            if (typeof selected !== 'string' || !allowed.includes(selected)) {
              return {
                ok: false,
                error: `${member.label || member.role} model is not available in the ${member.tier} tier`,
              };
            }
            modelSelections[member.role] = selected;
          }
        }

        mergeProjectHostPrefs(cwd, host, {
          team: {
            mode: 'subagents',
            source: 'prompted',
            approved: true,
            ...(overrides ? { overrides } : {}),
            ...(modelSelections ? { modelSelections } : {}),
          },
        }, env);
        return { ok: true };
      }
      if (action === 'repick_performance' || action === 'repick') {
        clearProjectHostPrefs(
          cwd,
          host,
          ['performance', 'team'],
          env,
        );
        return { ok: true };
      }
      return { ok: false, error: 'invalid team-confirmation action' };
    }
    case 'code-graph': {
      const provider = String(value);
      if (provider !== 'gitnexus' && provider !== 'graphify') return { ok: false, error: 'invalid code-graph provider' };
      // Machine-wide provider (runners reuse it) plus THIS project's
      // acknowledgement. A set provider alone does not skip the picker.
      writeGlobalCodeGraphProvider(provider, env);
      mergeProjectPrefs(cwd, { codeGraphAcknowledged: true }, env);
      return { ok: true, task: { kind: 'onboarding-toolchain' } };
    }
    case 'project-context': {
      const v = obj(value) || {};
      const answers = obj(v.answers) || {};
      // The user's typed sentence is NOT committed, in either of the two
      // spellings this step used to write it in.
      //
      //   - `projectContext.originalPrompt` is gone. `.traffic-one/.one.json`
      //     is committed and pushed, and the prompt is the one field in it that
      //     is the user's own words rather than a fact about the project.
      //     Nothing loses the value: `projectContextOriginalPrompt` falls
      //     through to the top-level field, which is a routed local preference
      //     living in the per-user store, so every `readEffectiveState`
      //     consumer still finds it (validate.ts no longer requires the nested
      //     member; scrubProjectStateLocalPrefs migrates projects that carry
      //     one).
      //   - the SUMMARY no longer falls back to it. Blank is reachable — the
      //     wizard's Continue button is not gated on the summary box — and that
      //     fallback made the blank case commit a verbatim SECOND copy. The
      //     tail below is unchanged (`answers.audience`, then `MVP`) and stays
      //     that way deliberately: the only other material this step receives
      //     is `answers`, which is committed verbatim in this same object, so
      //     promoting one of its values discloses nothing new — and anything
      //     richer would be a summariser of the prompt, which is exactly the
      //     text that must not be derived into the committed file.
      //
      // The EFFECTIVE state, not `readState`: the seeded prompt is a routed
      // local preference, so the raw reader has been blind to it since the
      // split landed (see PROJECT_PREF_KEYS in state/local-prefs/pref-schema.ts,
      // which names this call site) — the same defect `finalize` was already
      // fixed for.
      const effective = readEffectiveState(cwd, env);
      const stored = typeof effective.originalPrompt === 'string' && effective.originalPrompt.trim() !== '';
      // Only when the private store does NOT already hold it: a prompt still
      // sitting in a legacy committed `projectContext`, or one submitted on the
      // wire, is rescued to the top level so writeState's local-preference
      // split carries it to `~/.traffic-one/projects/<hash>/preferences.json`
      // on the way out — the same place `seedOriginalPrompt` writes. It is
      // routed OUT of the object before `.one.json` is written, so this adds no
      // committed copy.
      const rescued = stored
        ? ''
        : (projectContextOriginalPrompt(effective) || String(v.originalPrompt || '').trim());
      const summary = String(v.summary || '').trim()
        || String(answers.audience || '').trim()
        || 'MVP';
      if (!patchSharedState(cwd, {
        mode: 'new-project',
        ...(rescued ? { originalPrompt: rescued } : {}),
        projectContext: { source: 'prompted', summary, answers, collectedAt: stateTimestamp() },
      })) {
        return stateWriteRefused('what you want built', cwd, env);
      }
      return { ok: true };
    }
    case 'mobile': {
      const mobile = mobileFromChoice(value);
      if (!mobile) return { ok: false, error: 'invalid mobile choice' };
      if (!patchSharedState(cwd, { mode: 'new-project', mobile: { ...mobile, source: 'prompted' } })) {
        return stateWriteRefused('your mobile choice', cwd, env);
      }
      return { ok: true };
    }
    case 'finalize': {
      const committed = readState(cwd);
      // The stack SIGNAL and the WRITE BASE are deliberately two different
      // reads. `originalPrompt` is a PROJECT_PREF_KEY (privacy: it lives in the
      // per-user store, outside the repository), so a raw `readState` cannot see
      // it and the derivation silently floors to the default seed. Only the
      // signal is sourced from the effective state; `committed` stays the raw
      // base for the write below, or every local preference — the prompt
      // foremost — would be folded back into the committed `.one.json` that the
      // privacy split just took it out of. What derivation emits is a stack
      // NAME, never the prompt.
      const effective = readEffectiveState(cwd, env);
      // Preserve an already-committed stack (a second user reopening the wizard
      // only needs their local prefs/toolchain seeded — don't re-derive and risk
      // overwriting the first user's choices). Derive only when stack is unset.
      const hasStack = typeof committed.stack === 'string' && committed.stack.trim() !== '';
      // Stack signal: the user's original prompt MERGED WITH the MVP answers they
      // typed — not a short-circuit on the first non-empty value. A present-but-thin
      // originalPrompt (e.g. a later "ok build it" that became the seed) classifies
      // to a bare frontend-only shell on its own; folding in the answers recovers
      // the real signal. Concatenation is monotonic for classifyPromptForStack —
      // extra keywords only add signal, so a rich originalPrompt is never downgraded.
      const answers = obj((obj(committed.projectContext) || {}).answers) || {};
      const answerSignal = Object.values(answers).filter((v): v is string => typeof v === 'string' && v.trim() !== '').join('. ');
      const promptSignal = [projectContextOriginalPrompt(effective), answerSignal]
        .filter((s) => s.trim() !== '')
        .join('. ');
      const mobile = obj(committed.mobile) || { enabled: false, framework: 'none' };
      // No-signal floor: reaching finalize on a new-project onboarding means a build
      // WAS intended, but the prompt can be LOST before it is ever seeded (observed on
      // Cursor 9b: the user-prompt-submit hook no-ops when the host payload carries no
      // prompt text, so seedOriginalPrompt never runs; the wizard form has no prompt
      // field, so promptSignal === ''). deriveStack('') resolves to
      // `custom-frontend/react-vite/none` — a bare frontend shell with no backend,
      // still the wrong (empty) stack for a build nobody described. So when there is
      // NO stack signal at all, floor to the default build seed. An EXPLICIT brochure
      // request ("landing page", "static site") carries promptHasStackSignal===true
      // via wantsStaticSite, so it classifies normally and is preserved — only a
      // truly signal-less build is floored.
      const stackSeed = promptHasStackSignal(promptSignal) ? promptSignal : 'app with users and an admin dashboard';
      const derived = hasStack ? {} : deriveStack(stackSeed, String(mobile.framework || 'none'));
      const next = { ...committed, mode: 'new-project', ...derived };
      reconcileStackFromArtifacts(cwd, next);
      // `finalize` is the wizard's commit: this write IS the stack decision, and
      // `{ ok: true }` over a refused one told the user their project was set up
      // while `.one.json` still carried no stack — after which every gate reads an
      // unonboarded project and re-opens the wizard with no explanation. The step
      // already has an error channel the wizard renders; use it.
      if (!writeState(cwd, next)) return stateWriteRefused('the stack this wizard just committed', cwd, env);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown step: ${step}` };
  }
}
export {
  askUsePluginFirst,
  buildTeamLineup,
  effectiveOnboardingState,
  modelDisplayLabel,
  type AnswerOutcome,
  type OnboardingView,
  type PerformanceRepickReason,
  type StepMeta,
  type TeamMember,
  type WizardStep,
  usePluginQuestionPending,
} from './flow-view';
