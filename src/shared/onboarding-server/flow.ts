// src/shared/onboarding-server/flow.ts
// The onboarding flow engine: computeOnboarding + applyAnswer over the
// view/meta helpers in flow-view.ts.

import { classifyPromptForStack, detectStackFromCodebase, promptHasStackSignal, reconcileStackFromArtifacts } from '../detection';
import { authEnforced, isLocallyAuthenticated } from '../auth';
import { obj, type Rec } from '../obj';
import { isNewProjectOnboardingIncomplete } from '../onboarding/predicates';
import { nextOnboardingStep } from '../onboarding/prompts';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep } from '../onboarding/local-prefs';
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
  patchState,
  readEffectiveState,
  readState,
  writeGlobalCodeGraphProvider,
  writeState,
} from '../state';

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
  type AnswerOutcome,
  type OnboardingView,
  type WizardStep,
} from './flow-view';

// State as the preference-step router should see it: with the stamped stack, or
// — when the stamp hasn't landed yet (ask-first same-session flow, or a wiped
// .traffic-one) — the freshly DETECTED one. Detection returning nothing leaves
// the state untouched, preserving the sparse-repo no-wizard behavior.
function stackRoutingState(cwd: string, state: Rec): Rec {
  if (typeof state.stack === 'string' && state.stack) return state;
  const detected = detectStackFromCodebase(cwd);
  return detected.stack ? { ...state, stack: detected.stack } : state;
}

export function computeOnboarding(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
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
  // the ONLY unresolved step is 'api-key' — this is the FIRST wizard step on a
  // fresh project AND the ONLY step shown for an already-onboarded project whose
  // key a 401 invalidated (the api-key-only re-auth). Gated on authEnforced so
  // dev/test runs with TRAFFIC_ONE_AUTH=0 keep their existing onboarding flow.
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
// `patchState`, not `writeState(cwd, { ...readState(cwd), ...patch })`. Three
// things change, and all three are what a wizard answer wants:
//
//   - the base is re-read INSIDE the state lock, so a SessionStart backfill or
//     another wizard tab landing between this step's read and its write is no
//     longer erased. Every caller here declares one or two fields and means
//     exactly those; the old spelling published a whole-object snapshot taken
//     before the lock and dropped whatever arrived in between.
//   - an ILLEGIBLE base now REFUSES instead of healing. That is the important
//     half: `readState` answers a torn `.one.json` with `{}`, so the old
//     spelling replaced the user's whole project state with this one answer
//     plus a version — stack, mode and onboardingComplete gone — and reported
//     success. The bytes went to `.one.json.corrupt`, where nothing reads them.
//     A refusal keeps the file, and the three steps below already have the
//     channel to say so.
//   - `finalize` deliberately keeps `writeState`: it is the wizard's COMMIT, it
//     means to replace the file, and it is the repair path a corrupt state has
//     to heal through. Refusing there would wedge a hand-broken `.one.json`
//     with no in-product way out.
function patchSharedState(cwd: string, patch: Rec): boolean {
  return patchState(cwd, patch);
}

// The wizard renders `error` (routes.ts answers 400 `{ ok:false, error }`;
// wizard.html rethrows it into showError), and the step does not advance. Both
// reasons a wizard answer fails to reach disk are durable — a planted symlink
// stays planted, an unanswered "use Traffic One here?" stays unanswered, and a
// torn `.one.json` stays torn — so there is nothing to retry silently; name the
// answer that was not recorded and the file that did not take it.
function stateWriteRefused(subject: string): AnswerOutcome {
  return {
    ok: false,
    error: `\`.traffic-one/.one.json\` did not accept the write (the project state write fence refused it, `
      + `or its current contents could not be read), so ${subject} was not recorded`,
  };
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

// The install task normally fires from the code-graph answer. On a machine where
// codeGraphProvider is already set (any project after the first), that step is
// skipped entirely, so the task must fire from the flow's terminal answer:
// 'finalize' for new projects, the last unresolved local-preference answer for
// existing ones. Idempotent — the runner stamps present bins and exits fast when
// everything is already installed, and a fresh-machine flow that already ran the
// task from code-graph is stamped by the time finalize lands here.
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

export function applyAnswer(
  cwd: string,
  step: string,
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AnswerOutcome {
  return attachPendingInstallTask(
    cwd,
    step,
    applyAnswerStep(cwd, step, value, env),
    env,
  );
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
      mergeProjectPrefs(cwd, { openCode: { enabled, source: 'prompted', decidedAt: stateTimestamp() } }, env);
      // Record the consent as a DURABLE AUTHORIZATION in committed project state
      // (.traffic-one/.one.json), not just per-user prefs. Hosts with an
      // action-level safety reviewer (Codex) reject the opencode_delegate tool
      // call as "external delegation … not explicitly authorized" unless the
      // user's authorization is visible at call time — this field is that
      // machine-readable record, cited by the spawn gate's deny message so
      // delegation never re-asks the user for approval.
      if (!patchSharedState(cwd, {
        openCodeDelegation: { approved: enabled, source: 'onboarding', decidedAt: stateTimestamp() },
      })) {
        return stateWriteRefused('your OpenCode delegation answer');
      }
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
      // The provider is machine-wide (one.json), not a per-project pref — once set
      // it is reused across projects. OpenCode was decided at the first step, so the
      // consolidated install task can read the final choices from the effective state.
      writeGlobalCodeGraphProvider(provider, env);
      return { ok: true, task: { kind: 'onboarding-toolchain' } };
    }
    case 'project-context': {
      const v = obj(value) || {};
      const answers = obj(v.answers) || {};
      const originalPrompt = projectContextOriginalPrompt(readState(cwd)) || String(v.originalPrompt || '').trim();
      const summary = String(v.summary || '').trim()
        || originalPrompt
        || String(answers.audience || '').trim()
        || 'MVP';
      if (!patchSharedState(cwd, {
        mode: 'new-project',
        projectContext: { source: 'prompted', originalPrompt, summary, answers, collectedAt: stateTimestamp() },
      })) {
        return stateWriteRefused('what you want built');
      }
      return { ok: true };
    }
    case 'mobile': {
      const mobile = mobileFromChoice(value);
      if (!mobile) return { ok: false, error: 'invalid mobile choice' };
      if (!patchSharedState(cwd, { mode: 'new-project', mobile: { ...mobile, source: 'prompted' } })) {
        return stateWriteRefused('your mobile choice');
      }
      return { ok: true };
    }
    case 'finalize': {
      const committed = readState(cwd);
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
      const promptSignal = [projectContextOriginalPrompt(committed), answerSignal]
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
      if (!writeState(cwd, next)) return stateWriteRefused('the stack this wizard just committed');
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
