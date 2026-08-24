// src/shared/onboarding-server/flow-view.ts
// Wizard view shapes, team lineup, device identity, and step metadata
// enrichment for the onboarding flow.

import {  detectMode } from '../detection';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { obj, type Rec } from '../obj';
import { isNewProjectOnboardingIncomplete } from '../onboarding/predicates';
import { nextOnboardingStep } from '../onboarding/prompts';
import {  nextLocalPreferenceStep, type LocalPreferenceTarget } from '../onboarding/local-prefs';
import {
  projectContextDomainQuestionLines,
} from '../onboarding/project-context';
import { detectHost } from '../host';
import { PERFORMANCE_CONFIG } from '../../config/performance';
import { askUsePluginFirst, STEP_COPY, TEAM_ROLES, type StepCopy, type WizardStepId } from '../../config/onboarding';
import { readPluginUseChoice } from '../state/plugin-use';
import { TIER_IDS } from '../../config/model-tiers';
import { recommendTierForPlan } from '../model-tiers';
import { currentModelsForTier } from '../current-model-tiers';
import { effectiveTierForRole, modelForRoleHost,  type PlanCtx } from '../performance';
import { recommendLevelForPlan } from '../performance-config';
import { windsurfBackend } from '../windsurf-backend';
import {
  applyGlobalCodeGraphProvider,
  effectiveState,
  projectPrefsPath,
  hasValidPerformanceState,
  readEffectiveState,
  readGlobalCodeGraphProvider,
  readProjectPrefs,
} from '../state';

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
  // Present only on the workspace-container views below. Machine-readable so a
  // caller (the wait runner's banner, a test) reads the facts rather than
  // parsing the prose.
  workspace?: WorkspaceStepInfo;
}

/**
 * Why a workspace CONTAINER is not done, in a shape a caller can branch on.
 *
 * `empty-registry` is a REFUSAL and not a to-do: a container that has
 * registered nobody is not a project the wizard can set up, and it is
 * deliberately not offered a chooser of the directories it can see. Only the
 * person knows which directory was meant, and enumerating-and-registering would
 * mint Traffic One state into folders a team may have excluded on purpose. The
 * same reasoning already ships as the `workspace-member-unresolved-empty` gate
 * refusal (shared/tool-scope.ts); this is that refusal reaching the one surface
 * that had no way to state it.
 */
export interface WorkspaceStepInfo {
  readonly container: string;
  /** Registered, non-opted-out members, relative to the container. */
  readonly members: readonly string[];
  /** The subset whose own setup is not finished. Empty for the two refusals. */
  readonly pending: readonly string[];
  readonly reason: 'empty-registry' | 'unreadable-registry' | 'members-pending';
  /** The registry reader's own words, on `unreadable-registry` only. */
  readonly why?: string;
}

/**
 * The container's passive page: a `waiting` step the user cannot answer.
 *
 * `waiting` rather than a new step id, deliberately. The kind already exists
 * and the wizard already renders it (it is what `tech-detect` uses), so the
 * container view needs no new entry in `STEP_COPY` and no new branch in the
 * wizard client — and, more to the point, a container has nothing to ANSWER
 * here. Every one of the three reasons is resolved somewhere else: by running
 * setup on a member, by finishing a member's own wizard, or by repairing state
 * the user owns.
 */
export function workspaceWaitingMeta(info: WorkspaceStepInfo): StepMeta {
  const question = info.reason === 'empty-registry'
    ? 'This directory is a Traffic One workspace CONTAINER, not a project: it holds member projects, and it has '
      + 'registered none of them. A container carries no stack, no plan and no run state, so there is nothing here '
      + 'to set up. Run setup inside the member directory you want worked on — that is what registers it.'
    : info.reason === 'unreadable-registry'
      ? `This workspace's member registry could not be read — ${info.why || 'the registry is unusable'} — so nothing `
        + 'here can say which projects it holds. Setup cannot continue until it is restored.'
      : `Setup for this workspace finishes when every member is done. Still pending: ${info.pending.join(', ')}. `
        + 'Open each of those directories and finish its setup; this page continues automatically.';
  return {
    step: null,
    kind: 'waiting',
    title: info.reason === 'members-pending' ? 'Waiting on workspace members' : 'A workspace container, not a project',
    question,
    workspace: info,
  };
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
export function deviceName(): string {
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
export function deviceFingerprint(): string {
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
  // SKIPPED (this project already acknowledged and the provider is set),
  // the flow's terminal answer fires the same task instead — otherwise OpenCode
  // stays unstamped in this project's prefs and delegation silently never
  // activates for the whole first build (observed 2026-06-12 on Codex).
  task?: { kind: 'onboarding-toolchain' };
}

export function metaForStep(step: WizardStep, originalPrompt: string): StepMeta {
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
export function lacksDurableOnboardingState(
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
  // `state` and `effective` cannot disagree about `openCode`, so nothing
  // compensates for it here any more. This function's only caller
  // (onboarding-server/flow.ts) hands it readEffectiveState's output, and
  // readEffectiveState takes every PROJECT_PREF_KEY from the per-user store —
  // the same store `prefs` above was just read from. The one channel that could
  // make the two differ was extractProjectPrefs rescuing a leaked `openCode`
  // out of `.traffic-one/.one.json`; that consent is now UNROUTED
  // (state/local-prefs/prefs-split.ts), so a state-file copy reaches neither
  // side. __tests__/durable-state-opencode.test.ts pins both shapes.
  const effective = applyGlobalCodeGraphProvider(effectiveState(state, prefs, host), env, cwd);
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
export function wizardStepFromRaw(raw: string | null): WizardStep {
  if (raw === 'state') return 'finalize';
  if (raw === 'team') return 'performance';
  return raw as WizardStep;
}

export function stepWhenDurablePrefsMissing(
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

export function enrichStepMeta(
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
// The implementation lives in config/onboarding.ts so the write fence
// (shared/state/plugin-use.ts) reads the identical answer; re-exported here
// because this module's own name for it is the one every caller already imports.
export { askUsePluginFirst };

// True when the ask-first chat question is still pending for this project: the
// feature is on and the user has recorded no use-plugin choice yet. Gates deny
// mutating work with the question; session/prompt hooks relay it — nothing
// launches the wizard until the user answers yes.
export function usePluginQuestionPending(cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return askUsePluginFirst(env) && readPluginUseChoice(cwd, env) === null;
}


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
