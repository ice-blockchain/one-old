// src/shared/state/local-prefs/pref-schema.ts
// Preference key sets and every per-host normalizer.

import { obj, type Rec } from '../../obj';
import { HOST_IDS, type HostModelKey } from '../../../config/model-tiers';
import {
  ONE_MCP_MAX_AVAILABLE_MODELS,
  ONE_MCP_MAX_CONFIG_VERSION,
  isSafeOneMcpModelId,
} from '../../../config/one-mcp';
import {  canonicalPlan, planIsRecognized } from '../../model-tiers';
import { agentTierForPlan } from '../../performance-config';
import {
  canonicalPerformanceLevel,
  canonicalTeamMode,
  canonicalTeamOverrides,
  canonicalTeamSource,
  teamStateFromString,
} from '../canonicalize';
import {
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  VALID_AGENT_ROLES,
} from '../../../config/state';

function inSet(set: Set<string>, value: unknown): boolean {
  return typeof value === 'string' && set.has(value);
}

// Preferences that remain shared by all hosts used by this user on this project.
// codeGraphProvider is intentionally NOT here: it is MACHINE-WIDE (one.json).
//
// `originalPrompt` is the odd one out and is here for a PRIVACY reason, not
// because it is a setting. It is the user's raw first request, stored with only
// surrounding whitespace trimmed, and `.traffic-one/.one.json` is committed by
// design — so a prompt naming a client, an incident, an internal system, or a
// pasted credential was pushed to whatever remote the repository has. Routing it
// here moves it to `~/.traffic-one/projects/<hash>/preferences.json`, outside the
// repository, and makes the SessionStart scrub
// (state/normalize.ts `scrubProjectStateLocalPrefs`) migrate the value out of the
// committed file for projects that already carry one, rather than leaving those
// users with a leak no release fixes.
//
// Membership here has TWO consequences a reader has to hold together: every
// `readEffectiveState` consumer keeps seeing the field (effectiveState below
// projects PROJECT_PREF_KEYS back on), and every RAW reader — `readState`, which
// strips local preferences on read — stops seeing it. `seedOriginalPrompt`'s own
// idempotency guard was one of those raw readers and now reads the effective
// state; the two in onboarding-server/flow.ts (`project-context` and `finalize`)
// are NOT, and lose the seeded prompt as a stack signal.
export const PROJECT_PREF_KEYS = new Set([
  'openCode', 'toolchain', 'agentActivity', 'originalPrompt',
  'codeGraphAutoRun', 'graphifyAutoRun', 'graphifyLastHintedAt', 'graphifyLastRunAt',
  'graphifyLastErrorAt', 'graphifyLastError', 'gitnexusLastRunAt', 'gitnexusLastErrorAt', 'gitnexusLastError',
]);

// Runtime projects these fields from prefs.hosts[activeHost] onto effective
// state. Their old top-level form is recognized only so it can be stripped; it
// is never assigned to a host implicitly.
export const HOST_PREF_KEYS = new Set(['performance', 'team', 'availableModels']);
export const RETIRED_LOCAL_PREF_KEYS = new Set(['configuredFor', 'oneMcp']);

export const LOCAL_PREF_KEYS = new Set([
  ...PROJECT_PREF_KEYS,
  ...HOST_PREF_KEYS,
  ...RETIRED_LOCAL_PREF_KEYS,
  'hosts',
]);

interface PerformanceTarget {
  plan: string;
  appliedFingerprint: string;
  configVersion: number;
}

const ONE_MCP_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const AVAILABLE_MODELS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

function knownHost(value: string): value is HostModelKey {
  return (HOST_IDS as readonly string[]).includes(value);
}

export function canonicalHostKey(value: unknown): HostModelKey | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return knownHost(normalized) ? normalized : null;
}

export function normalizePerformanceTarget(host: HostModelKey, value: unknown): PerformanceTarget | null {
  const target = obj(value);
  if (!target
    || !planIsRecognized(target.plan)
    || typeof target.appliedFingerprint !== 'string'
    || !ONE_MCP_FINGERPRINT_RE.test(target.appliedFingerprint)
    || !Number.isInteger(target.configVersion)
    || (target.configVersion as number) < 0
    || (target.configVersion as number) > ONE_MCP_MAX_CONFIG_VERSION) return null;
  return {
    plan: canonicalPlan(host, target.plan),
    appliedFingerprint: target.appliedFingerprint,
    configVersion: target.configVersion as number,
  };
}

interface CursorAvailableModelsTarget {
  plan: string;
  appliedFingerprint: string;
}

// Cursor picker availability is invalidated only by the semantic catalog
// identity. A metadata-only One MCP version bump must neither invalidate the
// captured runner slugs nor force a fresh picker enumeration.
function normalizeCursorAvailableModelsTarget(value: unknown): CursorAvailableModelsTarget | null {
  const target = obj(value);
  if (!target
    || !planIsRecognized(target.plan)
    || typeof target.appliedFingerprint !== 'string'
    || !ONE_MCP_FINGERPRINT_RE.test(target.appliedFingerprint)) return null;
  return {
    plan: canonicalPlan('cursor', target.plan),
    appliedFingerprint: target.appliedFingerprint,
  };
}

function normalizePerformance(host: HostModelKey, value: unknown): Rec | null {
  if (typeof value === 'string') {
    const level = canonicalPerformanceLevel(value);
    return typeof level === 'string' && PERFORMANCE_LEVEL_IDS.has(level)
      ? { level, source: 'prompted' }
      : null;
  }
  const perf = obj(value);
  if (!perf) return null;
  const level = canonicalPerformanceLevel(perf.level);
  if (typeof level !== 'string' || !PERFORMANCE_LEVEL_IDS.has(level)) return null;
  const rawSource = typeof perf.source === 'string'
    ? perf.source.trim().toLowerCase().replace(/[_\s]+/g, '-')
    : 'prompted';
  const normalized: Rec = {
    ...perf,
    level,
    source: PERFORMANCE_SOURCE_IDS.has(rawSource) ? rawSource : 'prompted',
  };
  const target = normalizePerformanceTarget(host, perf.target);
  if (target) normalized.target = target;
  else delete normalized.target;
  return normalized;
}

function normalizeTeamModelSelections(host: HostModelKey, value: unknown): Rec | null {
  const raw = obj(value);
  if (!raw) return null;
  const selections: Rec = {};
  for (const [role, model] of Object.entries(raw)) {
    if (!VALID_AGENT_ROLES.has(role) || !isSafeOneMcpModelId(model, host)) continue;
    selections[role] = model;
  }
  return Object.keys(selections).length > 0 ? selections : null;
}

// Local preferences have the canonical host + plan target, so redundant
// overrides must be compared with the plan-aware role tier rather than the
// static Performance table. Otherwise, for example, Codex Free + High defaults
// Architect to Balanced but an explicit Highest choice is incorrectly dropped
// merely because Highest is the generic High default.
function normalizePlanAwareTeamOverrides(
  host: HostModelKey,
  value: unknown,
  performance: unknown,
): Rec | null {
  const candidates = canonicalTeamOverrides(value, null);
  if (!candidates) return null;
  const perf = obj(performance);
  const level = typeof perf?.level === 'string' ? perf.level : '';
  const target = obj(perf?.target);
  const plan = typeof target?.plan === 'string' ? target.plan : '';
  if (!level || !plan) return canonicalTeamOverrides(value, level);

  const overrides: Rec = {};
  for (const [role, tier] of Object.entries(candidates)) {
    const baseline = agentTierForPlan(host, plan, level, role);
    if (!baseline || baseline !== tier) overrides[role] = tier;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

function normalizeTeam(host: HostModelKey, value: unknown, performance: unknown): Rec | null {
  const fromString = typeof value === 'string' ? teamStateFromString(value) : null;
  const team = fromString || obj(value);
  if (!team) return null;
  const normalized: Rec = {
    ...team,
    mode: canonicalTeamMode(team.mode),
    source: canonicalTeamSource((team.source as string) || 'prompted'),
  };
  const normalizedOverrides = normalizePlanAwareTeamOverrides(host, team.overrides, performance);
  if (normalizedOverrides) normalized.overrides = normalizedOverrides;
  else delete normalized.overrides;
  const modelSelections = normalizeTeamModelSelections(host, team.modelSelections);
  if (normalized.mode === 'subagents' && modelSelections) normalized.modelSelections = modelSelections;
  else delete normalized.modelSelections;
  if (team.approved === true) normalized.approved = true;
  else delete normalized.approved;
  if (normalized.mode !== 'subagents') delete normalized.modeChangeApproval;
  return inSet(TEAM_MODE_IDS, normalized.mode) && inSet(TEAM_SOURCE_IDS, normalized.source)
    ? normalized
    : null;
}

function validModelId(value: unknown): value is string {
  return isSafeOneMcpModelId(value);
}

function normalizeAvailableModels(host: HostModelKey, value: unknown): Rec | null {
  if (host !== 'cursor') return null;
  const capture = obj(value);
  if (!capture
    || !Array.isArray(capture.models)
    || capture.models.length > ONE_MCP_MAX_AVAILABLE_MODELS
    || typeof capture.capturedAt !== 'string') return null;
  const capturedAt = Date.parse(capture.capturedAt);
  if (!Number.isFinite(capturedAt)
    || capturedAt > Date.now() + AVAILABLE_MODELS_MAX_FUTURE_SKEW_MS) return null;
  const target = normalizeCursorAvailableModelsTarget(capture.target);
  if (!target) return null;
  const models = [...new Set(capture.models.filter(validModelId).map((model) => model.trim()))];
  if (models.length === 0) return null;
  return {
    ...capture,
    models,
    capturedAt: capture.capturedAt.trim(),
    target,
  };
}

export function normalizeHostPrefs(host: HostModelKey, value: unknown): Rec | null {
  const raw = obj(value);
  if (!raw) return null;
  const out: Rec = { ...raw };
  delete out.configuredFor;
  delete out.oneMcp;
  const performance = normalizePerformance(host, raw.performance);
  if (performance) out.performance = performance;
  else delete out.performance;
  const team = normalizeTeam(host, raw.team, performance);
  if (team) out.team = team;
  else delete out.team;
  const availableModels = normalizeAvailableModels(host, raw.availableModels);
  if (availableModels) out.availableModels = availableModels;
  else delete out.availableModels;
  return Object.keys(out).length > 0 ? out : null;
}

