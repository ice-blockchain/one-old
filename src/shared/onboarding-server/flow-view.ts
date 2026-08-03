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
import { ASK_USE_PLUGIN_FIRST, STEP_COPY, TEAM_ROLES, type StepCopy, type WizardStepId } from '../../config/onboarding';
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
  // SKIPPED (codeGraphProvider already set machine-wide by an earlier project),
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
