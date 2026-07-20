// src/shared/onboarding-server/flow.ts
// The onboarding wizard's server-side brain: compute the next unresolved step and
// apply a single answer by writing the SAME state the agent used to write. Pure
// state IO (no HTTP, no child_process) so it is unit-testable in isolation. The
// step set + ordering is delegated to the existing predicates (nextOnboardingStep
// for new projects, nextLocalPreferenceStep for already-configured ones); this
// module only maps an answer → a writeState/mergeProjectPrefs call. The code-graph
// install is returned as a `task` signal for the HTTP layer to run out-of-band.

import { classifyPromptForStack, detectMode, promptHasStackSignal, reconcileStackFromArtifacts } from '../detection';
import { authEnforced, isLocallyAuthenticated } from '../auth';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { obj, type Rec } from '../obj';
import { isNewProjectOnboardingIncomplete } from '../onboarding/predicates';
import { nextOnboardingStep } from '../onboarding/prompts';
import { currentLocalPreferenceTarget, nextLocalPreferenceStep, type LocalPreferenceTarget } from '../onboarding/local-prefs';
import {
  projectContextDomainQuestionLines,
  projectContextOriginalPrompt,
} from '../onboarding/project-context';
import { detectHost } from '../host';
import { PERFORMANCE_CONFIG } from '../../config/performance';
import { ASK_USE_PLUGIN_FIRST, STEP_COPY, TEAM_ROLES, type StepCopy, type WizardStepId } from '../../config/onboarding';
import { readPluginUseChoice } from '../state/plugin-use';
import { TIER_IDS } from '../../config/model-tiers';
import { recommendTierForPlan } from '../model-tiers';
import { currentHostModelTarget, currentModelsForTier } from '../current-model-tiers';
import { effectiveTierForRole, modelForRoleHost, teamModeForLevel, type PlanCtx } from '../performance';
import { recommendLevelForPlan } from '../performance-config';
import { stateTimestamp } from '../state/io';
import { windsurfBackend } from '../windsurf-backend';
import {
  applyGlobalCodeGraphProvider,
  clearProjectHostPrefs,
  effectiveState,
  mergeProjectHostPrefs,
  mergeProjectPrefs,
  projectPrefsPath,
  hasValidPerformanceState,
  readEffectiveState,
  readGlobalCodeGraphProvider,
  readProjectPrefs,
  readState,
  writeGlobalCodeGraphProvider,
  writeState,
} from '../state';

// The action the wizard should take next: a question id, 'finalize' (new-project,
// all questions answered, commit the canonical state), or null (fully onboarded).
export type WizardStep = WizardStepId | 'finalize' | null;

// Re-exported so existing importers keep resolving these leaf types from flow.ts;
// the definitions (and the static step copy) now live in config/onboarding.ts.
export type { StepOption, FormField } from '../../config/onboarding';

// One subagent in the team-confirmation line-up: a role, what it does, the
// capability tier it runs at for the chosen performance level, and the concrete
// model id resolved for the active host (opus/sonnet/haiku, gpt-5.x, …).
export interface TeamMember {
  role: string;
  label: string;
  blurb: string;
  tier: string;
  model: string;
  // Display-only friendly name (e.g. "Opus 4.8") when `model` is a bare alias.
  modelLabel?: string;
}

export type PerformanceRepickReason =
  | 'initial'
  | 'configuration-required'
  | 'plan-changed'
  | 'models-changed'
  | 'team-settings-changed';

export interface PerformanceCatalogTier {
  tier: string;
  models: string[];
}

// The static step copy (kind/title/question/options/fields) is owned by
// config/onboarding.ts (STEP_COPY); StepMeta layers on the fields flow.ts
// resolves at display time.
export interface StepMeta extends StepCopy {
  step: WizardStep;
  domainQuestions?: string[];
  team?: TeamMember[];
  performanceLevel?: string;
  recommendedLevel?: string;
  recommendedTier?: string;
  host?: string;
  plan?: string;
  catalogSource?: 'one-mcp' | 'bundled';
  catalogVersion?: number;
  catalogTiers?: PerformanceCatalogTier[];
  repickReason?: PerformanceRepickReason;
  previousPlan?: string;
  // Exact model ids offered on the team step, grouped by capability tier. Each
  // tier contributes at most its first two models. Selectors show the cross-tier
  // union; the selected tier is persisted in team.overrides and the exact model
  // id in team.modelSelections.
  modelChoices?: { tier: string; model: string; label?: string }[];
  // True when the user declined Traffic One for this project — the wizard shows
  // the "Traffic One disabled" view instead of "Setup complete".
  declined?: boolean;
}

// Display label for a wizard model id. Anthropic ids read poorly raw, so both
// forms get a friendly generation label: a concrete id parses directly
// (claude-opus-4-8 → "Opus 4.8"), and a bare alias ("opus") resolves through
// its tier row's first same-family versioned id. Ids on other hosts are
// already readable and return null (no label).
export function modelDisplayLabel(
  model: string,
  tier: string,
  host: string,
  plan?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Version = leading short numeric segments ('4-8' → '4.8'); anything longer
  // (a dated build like 20251001) is a pin, not a display generation.
  const claudeLabel = (id: string): string | null => {
    const m = /^claude-([a-z]+)-([\d-]+)$/.exec(id);
    const family = m?.[1];
    const raw = m?.[2];
    if (!family || !raw) return null;
    const version = raw.split('-').filter((seg) => /^\d{1,2}$/.test(seg)).join('.');
    if (!version) return null;
    return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${version}`;
  };
  const direct = claudeLabel(model);
  if (direct) return direct;
  if (!/^[a-z]+$/.test(model)) return null;
  const row = currentModelsForTier(tier, host, plan ?? undefined, env);
  const concrete = row.find((id) => id.startsWith(`claude-${model}-`));
  return concrete ? claudeLabel(concrete) : null;
}

// Build the per-role line-up for a performance level + host. Empty for levels with
// no subagent team (low / main-agent) or an unknown level.
export function buildTeamLineup(
  level: string,
  host: string,
  overrides?: Rec | null,
  planCtx?: PlanCtx | null,
  env: NodeJS.ProcessEnv = process.env,
  modelSelections?: Rec | null,
): TeamMember[] {
  const cfg = PERFORMANCE_CONFIG[level];
  if (!cfg || cfg.teamMode !== 'subagents') return [];
  const out: TeamMember[] = [];
  for (const r of TEAM_ROLES) {
    const tier = effectiveTierForRole(level, r.role, overrides || null, planCtx || null);
    if (!tier) continue;
    const resolvedModel = modelForRoleHost(
      level,
      r.role,
      host,
      overrides || null,
      planCtx || null,
      env,
      modelSelections || null,
    );
    if (!resolvedModel && modelSelections
      && Object.prototype.hasOwnProperty.call(modelSelections, r.role)) return [];
    const model = resolvedModel || tier;
    const modelLabel = modelDisplayLabel(model, tier, host, planCtx?.plan, env);
    out.push({ role: r.role, label: r.label, blurb: r.blurb, tier, model, ...(modelLabel ? { modelLabel } : {}) });
  }
  return out;
}

export interface OnboardingView {
  mode: string;
  stack: string | null;
  step: WizardStep;
  done: boolean;
  meta: StepMeta;
  originalPrompt: string;
  // This machine's name (os.hostname()). Traffic One auth is one key per device, so
  // the dashboard names the auto-generated api-key after the device it will run on.
  hostname: string;
  // A short, STABLE per-device fingerprint. The dashboard appends it to the key name
  // ("<hostname> · <deviceId>") so that re-authing on the SAME device finds the
  // existing key and REROLLs it (fresh secret) instead of piling up duplicates.
  deviceId: string;
}

// Short, human-friendly device label from os.hostname() — drops a trailing
// ".local"/".lan"/domain suffix so the key name reads as e.g. "MacBook-Pro". When the
// hostname is IP-like or numeric (DHCP networks resolve os.hostname() to an address,
// giving a useless "10"), fall back to the OS username so the label still identifies
// the device. The stable deviceId (deviceFingerprint) is unaffected either way.
function deviceName(): string {
  try {
    const raw = (os.hostname() || '').trim();
    const short = raw.split('.')[0] ?? '';
    const ipLike = /^\d+$/.test(short) || /^\d{1,3}(\.\d{1,3}){3}$/.test(raw) || raw.includes(':');
    if (short && !ipLike) return short;
    try {
      const user = os.userInfo().username;
      if (user) return `${user}'s device`;
    } catch { /* ignore */ }
    return short || 'this device';
  } catch {
    return 'this device';
  }
}

// Deterministic 8-hex fingerprint of stable machine attributes — same value across
// re-auths on the same device, distinct across devices. No persistence, so it can't
// drift or need cleanup; if the hostname genuinely changes it becomes a new device,
// which is the correct behavior for a per-device key.
function deviceFingerprint(): string {
  const parts: string[] = [];
  try { parts.push(os.hostname()); } catch { /* ignore */ }
  try { parts.push(os.userInfo().username); } catch { /* ignore */ }
  try { parts.push(os.platform(), os.arch(), os.homedir()); } catch { /* ignore */ }
  const seed = parts.filter(Boolean).join('|') || 'traffic-one-device';
  return crypto.createHash('sha256').update(seed).digest('hex').slice(0, 8);
}

export interface AnswerOutcome {
  ok: boolean;
  error?: string;
  // The code-graph answer kicks the consolidated install task (graph provider +
  // OpenCode) so the wizard can gate "Setup complete" on it. When that step is
  // SKIPPED (codeGraphProvider already set machine-wide by an earlier project),
  // the flow's terminal answer fires the same task instead — otherwise OpenCode
  // stays unstamped in this project's prefs and delegation silently never
  // activates for the whole first build (observed 2026-06-12 on Codex).
  task?: { kind: 'onboarding-toolchain' };
}

function metaForStep(step: WizardStep, originalPrompt: string): StepMeta {
  if (step === null) {
    return { step: null, kind: 'done', title: 'All set', question: 'Traffic One setup is complete.' };
  }
  if (step === 'finalize') {
    return { step: 'finalize', kind: 'finalize', title: 'Finishing setup', question: 'Saving your configuration…' };
  }
  const base = STEP_COPY[step];
  const meta: StepMeta = { step, ...base };
  if (step === 'project-context') meta.domainQuestions = projectContextDomainQuestionLines(originalPrompt);
  return meta;
}

export function effectiveOnboardingState(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { state: Rec; mode: string } {
  const state = readEffectiveState(cwd, env);
  const mode = (typeof state.mode === 'string' && state.mode) || detectMode(cwd);
  return { state: { ...state, mode }, mode };
}

// Fail closed: shared .one.json can show onboardingComplete while per-user prefs
// never landed on disk (observed on OpenCode/Electron when ~/.traffic-one is not
// writable). Require the prefs file + effective fields before reporting done.
function lacksDurableOnboardingState(
  cwd: string,
  state: Rec,
  host: string,
  env: NodeJS.ProcessEnv,
  target: LocalPreferenceTarget,
): boolean {
  // Sparse existing projects may have no stack yet — local prefs are not required then.
  if (typeof state.stack !== 'string' || !state.stack.trim()) return false;
  let prefsFileExists = false;
  try {
    prefsFileExists = fs.existsSync(projectPrefsPath(cwd, env));
  } catch {
    prefsFileExists = false;
  }
  const prefs = readProjectPrefs(cwd, env);
  if (!prefsFileExists && Object.keys(prefs).length === 0) return true;
  const effective = applyGlobalCodeGraphProvider(effectiveState(state, prefs, host), env, cwd);
  if (!effective.openCode && state.openCode) effective.openCode = state.openCode;
  if (isNewProjectOnboardingIncomplete(effective, host)) return true;
  if (nextLocalPreferenceStep(effective, host, target) != null) return true;
  const provider = readGlobalCodeGraphProvider(env)
    || (typeof effective.codeGraphProvider === 'string' ? effective.codeGraphProvider : null);
  return provider !== 'gitnexus' && provider !== 'graphify';
}

// nextOnboardingStep can return ids that aren't wizard steps: 'state' (all
// answered → the wizard's finalize step) and 'team' (team unstamped but fully
// derivable — the performance answer writes both performance AND team, so re-ask
// that). Anything else IS a WizardStepId. Without this mapping a raw 'team'
// reaches metaForStep, which finds no STEP_COPY entry and returns a kind-less
// meta the wizard client can't render (the appendChild-on-undefined crash).
function wizardStepFromRaw(raw: string | null): WizardStep {
  if (raw === 'state') return 'finalize';
  if (raw === 'team') return 'performance';
  return raw as WizardStep;
}

function stepWhenDurablePrefsMissing(
  cwd: string,
  state: Rec,
  mode: string,
  host: string,
  target: LocalPreferenceTarget,
): WizardStep {
  if (mode === 'new-project') {
    if (isNewProjectOnboardingIncomplete(state, host)) {
      return wizardStepFromRaw(nextOnboardingStep(state, host));
    }
    const raw = nextLocalPreferenceStep(state, host, target);
    return (raw as WizardStep) ?? 'performance';
  }
  const raw = nextLocalPreferenceStep(state, host, target);
  return (raw as WizardStep) ?? 'performance';
}

function enrichStepMeta(
  meta: StepMeta,
  step: WizardStep,
  state: Rec,
  env: NodeJS.ProcessEnv,
  target: LocalPreferenceTarget,
): StepMeta {
  if (step === 'team-confirmation') enrichTeamMeta(meta, state, env, target);
  if (step === 'performance') enrichPerformanceMeta(meta, state, env, target);
  return meta;
}

// Runtime override (TRAFFIC_ONE_ASK_USE_PLUGIN=1|0) over the bundled default so
// the ask-first behavior can be toggled without rebuilding the plugin. When
// active AND the project has no recorded use-plugin choice, the hooks ask the
// question in the HOST CHAT (no wizard server, no URL) — see usePluginQuestion.
export function askUsePluginFirst(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TRAFFIC_ONE_ASK_USE_PLUGIN;
  if (typeof raw === 'string' && raw.trim()) return /^(1|true|on|yes)$/i.test(raw.trim());
  return ASK_USE_PLUGIN_FIRST;
}

// True when the ask-first chat question is still pending for this project: the
// feature is on and the user has recorded no use-plugin choice yet. Gates deny
// mutating work with the question; session/prompt hooks relay it — nothing
// launches the wizard until the user answers yes.
export function usePluginQuestionPending(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return askUsePluginFirst(env) && readPluginUseChoice(cwd, env) === null;
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
    const raw = nextLocalPreferenceStep(state, host, localPreferenceTarget);
    step = (raw as WizardStep) ?? null;
    done = raw == null;
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
function enrichTeamMeta(
  meta: StepMeta,
  state: Rec,
  env: NodeJS.ProcessEnv,
  target: LocalPreferenceTarget,
): void {
  const performance = obj(state.performance);
  const level = performance && typeof performance.level === 'string' ? performance.level : '';
  const team = obj(state.team);
  const overrides = team && obj(team.overrides) ? (team.overrides as Rec) : null;
  const host = detectHost(env);
  if (host === 'windsurf' && windsurfBackend(env) === 'cascade') {
    meta.team = [];
    meta.performanceLevel = 'low';
    meta.recommendedTier = 'cheapest';
    meta.modelChoices = [];
    meta.host = host;
    return;
  }
  const planCtx: PlanCtx = { host, plan: target.plan };
  const savedModelSelections = team && obj(team.modelSelections)
    ? (team.modelSelections as Rec)
    : null;
  meta.team = buildTeamLineup(level, host, overrides, planCtx, env, savedModelSelections);
  meta.performanceLevel = level;
  meta.recommendedTier = recommendTierForPlan(host, planCtx.plan);
  meta.host = host;
  // Restore the cross-tier picker while keeping it bounded: each row contributes
  // its first two models, in preferred order. Do not dedupe across tiers because
  // the same exact model can intentionally represent two different tier choices.
  meta.modelChoices = TIER_IDS.flatMap((tier) => (
    currentModelsForTier(tier, host, planCtx.plan, env).slice(0, 2).map((model) => {
      const label = modelDisplayLabel(model, tier, host, planCtx.plan, env);
      return { tier, model, ...(label ? { label } : {}) };
    })
  ));
}

// Pre-select the wizard's plan recommendation: move it first and tag its hint
// "Recommended". Clones option objects so STEP_META is never mutated.
function enrichPerformanceMeta(
  meta: StepMeta,
  state: Rec,
  env: NodeJS.ProcessEnv,
  target: LocalPreferenceTarget,
): void {
  const host = detectHost(env);
  const plan = target.plan;
  const cascade = host === 'windsurf' && windsurfBackend(env) === 'cascade';
  const recommended = cascade ? 'low' : recommendLevelForPlan(host, plan);
  const options = (meta.options || []).filter((o) => !cascade || o.id === 'low').map((o) => ({ ...o }));
  for (const o of options) {
    if (o.id === recommended) o.hint = o.hint ? `Recommended — ${o.hint}` : 'Recommended';
  }
  options.sort((a, b) => (a.id === recommended ? -1 : b.id === recommended ? 1 : 0));
  meta.options = options;
  meta.recommendedLevel = recommended;
  meta.recommendedTier = recommendTierForPlan(host, plan);
  meta.host = host;
  meta.plan = plan;

  const catalog = currentHostModelTarget(host, plan, env);
  meta.catalogSource = catalog.source;
  meta.catalogVersion = catalog.configVersion;
  meta.catalogTiers = TIER_IDS.map((tier) => ({
    tier,
    models: [...catalog.snapshot.tiers[tier]],
  }));

  const performance = obj(state.performance);
  const previousTarget = obj(performance?.target);
  if (!hasValidPerformanceState(performance)) {
    meta.repickReason = 'initial';
  } else if (!previousTarget) {
    meta.repickReason = 'configuration-required';
  } else if (previousTarget.plan !== plan) {
    meta.repickReason = 'plan-changed';
    if (typeof previousTarget.plan === 'string' && previousTarget.plan.trim()) {
      meta.previousPlan = previousTarget.plan;
    }
  } else if (previousTarget.appliedFingerprint !== target.appliedFingerprint) {
    meta.repickReason = 'models-changed';
  } else {
    meta.repickReason = 'team-settings-changed';
  }
}

// ── Answer application ──────────────────────────────────────────────────────────
function patchSharedState(cwd: string, patch: Rec): void {
  writeState(cwd, { ...readState(cwd), ...patch });
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
  let { stack, frontend, backend } = cls;
  if (mobileFramework === 'react-native-expo') {
    frontend = 'none';
    if (stack === 'minimal') stack = 'custom-frontend';
    if (backend === 'none') backend = 'supabase';
  } else if (mobileFramework === 'ionic-capacitor') {
    if (frontend === 'none') frontend = 'react-vite';
    if (stack === 'minimal') stack = 'default';
    if (backend === 'none') backend = 'supabase';
  }
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
  if (host !== 'opencode' && host !== 'kilo' && obj(state.openCode)?.enabled === true && !stamped('opencode')) return true;
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
  const hasStack = typeof state.stack === 'string' && state.stack.trim() !== '';
  const target = currentLocalPreferenceTarget(host, env, cwd);
  const terminal = step === 'finalize' || (hasStack && nextLocalPreferenceStep(state, host, target) == null);
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
      patchSharedState(cwd, {
        openCodeDelegation: { approved: enabled, source: 'onboarding', decidedAt: stateTimestamp() },
      });
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
      patchSharedState(cwd, {
        mode: 'new-project',
        projectContext: { source: 'prompted', originalPrompt, summary, answers, collectedAt: stateTimestamp() },
      });
      return { ok: true };
    }
    case 'mobile': {
      const mobile = mobileFromChoice(value);
      if (!mobile) return { ok: false, error: 'invalid mobile choice' };
      patchSharedState(cwd, { mode: 'new-project', mobile: { ...mobile, source: 'prompted' } });
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
      // to `minimal` on its own; folding in the answers recovers the real signal.
      // Concatenation is monotonic for classifyPromptForStack — extra keywords only
      // add signal, so a rich originalPrompt is never downgraded.
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
      // field, so promptSignal === ''). deriveStack('') collapses to `minimal/none/none`,
      // silently scaffolding the wrong (empty) stack. So when there is NO stack signal at
      // all, floor to the default build seed instead of minimal. An EXPLICIT minimal
      // request ("landing page", "static site") carries promptHasStackSignal===true, so it
      // classifies normally and is preserved — only a truly signal-less build is floored.
      const stackSeed = promptHasStackSignal(promptSignal) ? promptSignal : 'app with users and an admin dashboard';
      const derived = hasStack ? {} : deriveStack(stackSeed, String(mobile.framework || 'none'));
      const next = { ...committed, mode: 'new-project', ...derived };
      reconcileStackFromArtifacts(cwd, next);
      writeState(cwd, next);
      return { ok: true };
    }
    default:
      return { ok: false, error: `unknown step: ${step}` };
  }
}
