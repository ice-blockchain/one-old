// src/modules/agent-model/spawn-shape.ts
// Spawn-shape parsing: quick-fix scope extraction, agent-type resolution
// with its per-host denies, and model/tier predicates.

import { asString } from '../../adapters/coerce';
import {  type Rec } from '../../shared/obj';
import {  deny } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { detectHostPlan } from '../../shared/host/plan';
import {  modelMatchesHostModels } from '../../shared/model-tiers';
import { currentAcceptableModels } from '../../shared/current-model-tiers';
import { openCodeGlobalAgentName, openCodeGlobalAgentPath } from '../../shared/materialize/opencode-assets';
import {   hostSpawnType } from '../../shared/host/spawn-types';
import { cursorAgentTypeReason } from './cursor-agent-type';
import {
  policyModelsForExpected,
  type RunModelPolicyV1,
} from '../../shared/run-model-policy';

import {
  block,
} from './handler-prose';

interface QuickFixScopeInput {
  present: boolean;
  valid: boolean;
  outputs: string[];
  allowlist: string[];
  exclude: string[];
}

function exactQuickFixPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const normalized = item.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    if (!normalized
      || normalized.startsWith('/')
      || normalized === '.'
      || normalized.split('/').includes('..')
      || normalized.includes('\0')
      || /[*?[\]{}]/.test(normalized)
      || normalized === '.traffic-one'
      || normalized.startsWith('.traffic-one/')) return null;
    paths.push(normalized);
  }
  return [...new Set(paths)].sort();
}

export function quickFixScopeFromSpawn(toolInput: Rec, prompt: string): QuickFixScopeInput {
  const candidates = [
    toolInput.allowedFiles,
    toolInput.allowed_files,
    toolInput.files,
  ].filter((value) => value !== undefined);
  const structured = candidates.map(exactQuickFixPaths);
  if (structured.some((scope) => scope === null)) {
    return { present: candidates.length > 0, valid: false, outputs: [], allowlist: [], exclude: [] };
  }
  const structuredScope = structured[0] || null;
  if (structuredScope
    && !structured.every((scope) => JSON.stringify(scope) === JSON.stringify(structuredScope))) {
    return { present: true, valid: false, outputs: [], allowlist: [], exclude: [] };
  }

  const markerMatches = [...prompt.matchAll(
    /^\[t1-bounded-scope:\s*(\{[^\r\n]{1,4096}\})\s*\]$/gm,
  )];
  if (markerMatches.length > 1) {
    return { present: true, valid: false, outputs: [], allowlist: [], exclude: [] };
  }
  let markerScope: { outputs: string[]; allowlist: string[]; exclude: string[] } | null = null;
  if (markerMatches.length === 1) {
    try {
      const parsed = JSON.parse(markerMatches[0]?.[1] || '') as Record<string, unknown>;
      if (!parsed || typeof parsed !== 'object'
        || Object.keys(parsed).some((key) => !['outputs', 'allowlist', 'exclude'].includes(key))) {
        throw new Error('invalid marker keys');
      }
      const outputs = exactQuickFixPaths(parsed.outputs);
      const allowlist = parsed.allowlist === undefined
        ? outputs
        : exactQuickFixPaths(parsed.allowlist);
      const exclude = parsed.exclude === undefined
        ? []
        : (Array.isArray(parsed.exclude) && parsed.exclude.length === 0
            ? []
            : exactQuickFixPaths(parsed.exclude));
      if (!outputs || !allowlist || !exclude
        || outputs.some((output) => !allowlist.includes(output) || exclude.includes(output))) {
        throw new Error('invalid marker scope');
      }
      markerScope = { outputs, allowlist, exclude };
    } catch {
      return { present: true, valid: false, outputs: [], allowlist: [], exclude: [] };
    }
  }
  if (structuredScope && markerScope
    && (JSON.stringify(structuredScope) !== JSON.stringify(markerScope.outputs)
      || JSON.stringify(structuredScope) !== JSON.stringify(markerScope.allowlist))) {
    return { present: true, valid: false, outputs: [], allowlist: [], exclude: [] };
  }
  if (markerScope) {
    return { present: true, valid: true, ...markerScope };
  }
  if (structuredScope) {
    return {
      present: true,
      valid: true,
      outputs: structuredScope,
      allowlist: structuredScope,
      exclude: [],
    };
  }
  return { present: false, valid: false, outputs: [], allowlist: [], exclude: [] };
}

// A role's tier is satisfied ONLY when the spawn's `model` PARAMETER matches it on hosts
// where Traffic One enforces stable subagent model ids (family-aware against the
// active local snapshot's preferred-first tier array). The passed arg is authoritative there — INCLUDING Cursor:
// the earlier design trusted the `.cursor/agents/<role>.md` frontmatter, but
// live evidence proved Cursor does NOT honor that frontmatter when no `model` arg is passed — it
// INHERITS THE PARENT (orchestrator) model (captured: a balanced-override frontend with
// frontmatter `gpt-5.5-medium` ran on the parent's Opus because `subagent_model == parent model`).
// So the per-role model only takes effect when the orchestrator PASSES it in the Task `model`
// arg; the gate must therefore require it (the frontmatter is just the source/hint the
// orchestrator reads, never proof the subagent will run on it).
export function modelSatisfiesTier(
  ctx: Ctx,
  passedModel: string,
  expected: string,
  policy: RunModelPolicyV1 | null = null,
  role?: string,
): boolean {
  const acceptable = policy
    ? (role && policy.roles[role]?.acceptableModels) || policyModelsForExpected(policy, expected)
    : currentAcceptableModels(expected, ctx.host, detectHostPlan(ctx.host));
  return ctx.host === 'codex'
    ? acceptable.includes(passedModel)
    : modelMatchesHostModels(passedModel, acceptable, ctx.host);
}

export function modelParamEnforced(host: string): boolean {
  // Codex collaboration accepts an explicit model too. Its parent spawn surface
  // is not guaranteed to emit PreToolUse, so SubagentStart/child PreToolUse remain
  // the authoritative runtime check; when the parent hook is present, validate it
  // here as an earlier actionable deny.
  return host === 'claude' || host === 'cursor' || host === 'codex';
}

export function spawnAgentType(toolInput: Rec, opts: { includeRoleAlias?: boolean } = {}): string {
  const includeRoleAlias = opts.includeRoleAlias !== false;
  return asString(
    toolInput.agent_type
      ?? toolInput.agentType
      ?? toolInput.subagent_type
      ?? toolInput.subagentType
      ?? toolInput.subagent_profile
      ?? toolInput.subagentProfile
      ?? toolInput.profile
      ?? toolInput.profile_name
      ?? toolInput.profileName
      ?? toolInput.agent
      ?? (includeRoleAlias ? toolInput.role : undefined)
      ?? toolInput.name
      ?? toolInput.agentName
      ?? toolInput.agent_name
      ?? toolInput.type,
  ).trim();
}

export function isBuiltinSubagent(agentType: string): boolean {
  return /^(general|general[-_]?purpose|explore|scout)$/i.test(agentType.trim());
}

// Cursor's `Task` builds its accepted `subagent_type` set from the agent files it
// knew about when the session started, so a role materialized during onboarding
// can be missing from it — the spawn then fails inside Cursor's schema validation,
// before any hook runs. The supported recovery is the built-in generic worker plus
// the role marker, so BOTH are legitimate here; anything else is a real misroute.
export function cursorAgentTypeDeny(role: string, agentType: string): HookResult {
  const spawn = hostSpawnType('cursor', role);
  return deny(block('cursor-agent-type-required', {
    ROLE: role,
    AGENT_TYPE: agentType || 'missing',
    EXPECTED_AGENT: spawn.primary || role,
    FALLBACK_AGENT: spawn.fallback || 'generalPurpose',
    AGENT_PATH: spawn.contractPath || `.cursor/agents/${role}.md`,
  }, cursorAgentTypeReason(role, agentType, spawn.primary || role, spawn.fallback || 'generalPurpose', spawn.contractPath || `.cursor/agents/${role}.md`)),
  { denyId: 'cursor-agent-type-required', denyTarget: role });
}

export function namedOpenCodeAgentDeny(cwd: string, role: string, agentType: string, expected: string): HookResult {
  const expectedAgent = openCodeGlobalAgentName(cwd, role);
  return deny(block('opencode-named-agent-required', {
    HOST: 'OpenCode',
    ROLE: role,
    AGENT_TYPE: agentType || 'missing',
    EXPECTED_AGENT: expectedAgent,
    AGENT_PATH: openCodeGlobalAgentPath(cwd, role),
    MODEL_NOTE: `Traffic One materialized this project-scoped global agent with \`model: ${expected}\`. OpenCode applies that per-role model only when Task uses \`${expectedAgent}\`; built-in agents inherit the parent session model.`,
  }), { denyId: 'opencode-named-agent-required', denyTarget: role });
}

// The path is READ FROM THE TABLE, not spelled again: a second literal for the
// same file is how Copilot's contract path stayed at `.copilot/` (a HOME
// location written as a project-relative one) long after the writer moved.
//
// It stays UNCONDITIONAL on the file existing, deliberately. Every reason string
// a gate renders is part of the deny-repeat signature (shared/state/
// deny-repeat.ts), so a sentence that changed with disk state would split one
// refusal into two counters and silently stop escalation — and this deny's
// subject is the spawn TYPE, which is wrong whether or not the contract landed.
// A missing contract is refused where it is actionable instead: mutating work is
// blocked at the gate (`host-role-contracts-unwritable`) and the SessionStart
// banner tells the orchestrator to state the role inline.
export function kiloGeneralAgentDeny(role: string, agentType: string): HookResult {
  return deny(block('kilo-general-agent-required', {
    ROLE: role,
    AGENT_TYPE: agentType || 'missing',
    AGENT_PATH: hostSpawnType('kilo', role).contractPath || `.kilo/agents/${role}.md`,
  }), { denyId: 'kilo-general-agent-required', denyTarget: role });
}

