// src/modules/materialize/post-stack-setup.ts
// PostToolUse dispatcher (priority ~60): auth gate → supabase function-edit
// auto-deploy → digest-size warning → write-triggered materialization (project
// memory / tool-input hints / generic convergence) → state-file write
// materialization. Ported 1:1 from runPostStackSetup (post.cjs). Runner
// couplings (token log, supabase deploy, one-mcp report) are INJECTED via deps
// (default no-op) — they wire to the compiled runners at the Step-7 cutover.
//
// TODO (cutover reconcile): the legacy state-file branch emits per-validation-
// issue systemMessages + a gitnexus node-warning + the exact "rules loaded for
// stack X" wording. Here it delegates to materializeProjectFromState (which
// strips local prefs via writeState + validates + materializes); reconcile the
// exact wording against the legacy when both are side-by-side.

import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isAuthenticatedLocal } from '../../shared/auth';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { logToolUse } from '../../shared/token-logger';
import { makeSkillBlock } from '../../shared/skill-block';
import { isStateFilePath } from '../../shared/tool-classify';
import { readEffectiveState } from '../../shared/state';
import { inferTrafficOneSpawnRole } from '../agent-model/role-infer';
import {
  type MaterializeOutcome,
  materializeProjectFromState,
  materializeProjectIfNeeded,
} from '../../shared/materialize';
import { materializeFromProjectMemoryWrite, materializeFromToolInputHints, type ReportOneMcp } from './converge-from-write';
import { DIGEST_HARD_BYTES, DIGEST_PATH_RE, FUNCTION_PATH_RE, projectRootFromStateFilePath } from './post-helpers';

type Rec = Record<string, unknown>;
const skillBlock = makeSkillBlock(pluginRoot);
const PLAN_READY_RE = /(?:^|\n)\s*(?:verdict:\s*)?PLAN_READY\s*(?:\n|$)/i;
const SPAWN_TOOL_RE = /^(Task|Agent|spawn_agent|send_input|wait_agent)$/i;

export interface PostStackSetupDeps {
  logTokenUse?: (cwd: string, payload: unknown) => void;
  functionEditDeploy?: (filePath: string) => string | null;
  reportOneMcp?: ReportOneMcp;
}

function obj(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null;
}
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function stringifySearchValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
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

function planReadyText(value: unknown): boolean {
  return PLAN_READY_RE.test(stringifySearchValue(value));
}

function architectDigestProjectRoot(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const match = normalized.match(/^(.*)\/\.traffic-one\/digests\/[^/]+\/architect\.md$/);
  return match?.[1] ?? null;
}

function isArchitectPlanReadyDigest(filePath: string): boolean {
  if (!filePath || !architectDigestProjectRoot(filePath)) return false;
  try {
    return planReadyText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return false;
  }
}

function agentResponseText(raw: Rec): string {
  return [
    raw.tool_response,
    raw.tool_result,
    raw.toolResponse,
    raw.toolResult,
    raw.response,
    raw.result,
    raw.output,
  ].map(stringifySearchValue).filter(Boolean).join('\n');
}

function isArchitectPlanReadyAgentResult(ctx: Ctx, raw: Rec, toolInput: Rec): boolean {
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  if (!SPAWN_TOOL_RE.test(toolName)) return false;

  const responseText = agentResponseText(raw);
  if (!PLAN_READY_RE.test(responseText)) return false;

  const role = inferTrafficOneSpawnRole(toolInput);
  if (role) return role === 'senior-architect';

  // `wait_agent` returns may not carry the original spawn prompt, so the
  // terminal PLAN_READY token is enough to identify the architect phase.
  return /^wait_agent$/i.test(toolName);
}

function triggerArchitectPlanReadyReport(cwd: string, state: Rec, reportOneMcp: ReportOneMcp | undefined): void {
  if (!reportOneMcp) return;
  reportOneMcp(cwd, state, 'architect PLAN_READY');
}

export function runPostStackSetup(ctx: Ctx, deps: PostStackSetupDeps = {}): HookResult {
  const cwd = ctx.cwd;
  const raw = obj(ctx.input.raw) || {};
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const filePath = asString(toolInput.file_path);
  const cwdAbs = path.resolve(cwd);
  const targetPath = filePath ? (path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(cwd, filePath)) : '';
  const targetInsideCwd = Boolean(targetPath && (targetPath === cwdAbs || targetPath.startsWith(`${cwdAbs}${path.sep}`)));
  if (isPluginAuthoringRoot(cwd) && (!targetPath || targetInsideCwd)) return noop();

  const fp = filePath.replace(/\\/g, '/');
  const reportOneMcp = deps.reportOneMcp;
  const digestRoot = architectDigestProjectRoot(targetPath || filePath);
  const reportRoot = digestRoot || cwd;
  const state = readEffectiveState(reportRoot);
  const isSpawnAgentLifecycleTool = ctx.input.tool?.class === 'spawn-agent' || SPAWN_TOOL_RE.test(asString(raw.tool_name ?? raw.toolName));

  if (isArchitectPlanReadyDigest(targetPath || filePath) || isArchitectPlanReadyAgentResult(ctx, raw, toolInput)) {
    triggerArchitectPlanReadyReport(reportRoot, state, reportOneMcp);
  }

  if (!isAuthenticatedLocal()) return noop();

  // Opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1). Real
  // logger by default; tests inject a spy/no-op via deps.
  (deps.logTokenUse ?? logToolUse)(cwd, raw);

  if (isSpawnAgentLifecycleTool) return noop();

  // 1. Supabase Edge Function edit → auto-deploy (injected; skip when no hook).
  if (FUNCTION_PATH_RE.test(fp)) {
    const result = deps.functionEditDeploy ? deps.functionEditDeploy(filePath) : null;
    return result ? context(result) : noop();
  }

  // 2. Soft digest-size warning (never blocks the write).
  const digestMatch = fp.match(DIGEST_PATH_RE);
  if (digestMatch && fs.existsSync(filePath)) {
    let bytes = 0;
    try { bytes = fs.statSync(filePath).size; } catch { bytes = 0; }
    if (bytes > DIGEST_HARD_BYTES) {
      const role = digestMatch[1] as string;
      const kb = Math.round((bytes / 1024) * 10) / 10;
      return context(digestWarning(role, kb), { systemMessage: `traffic-one — digest ${role}.md is ${kb} KB; trim to ≤2 KB` });
    }
    return noop();
  }

  // 3. Non-state-file write → write-triggered convergence.
  if (!isStateFilePath(filePath)) {
    const mem = materializeFromProjectMemoryWrite(cwd, filePath, { reportOneMcp });
    if (mem) return outcomeToResult(mem);
    const hint = materializeFromToolInputHints(cwd, toolInput, { reportOneMcp });
    if (hint) return outcomeToResult(hint);
    return outcomeToResult(materializeProjectIfNeeded(cwd, { trigger: 'generic post-tool convergence', reportOneMcp }));
  }

  // 4. State-file write → validate + materialize (writeState strips local prefs).
  if (!fs.existsSync(filePath)) return noop();
  return outcomeToResult(materializeProjectFromState(projectRootFromStateFilePath(filePath), { trigger: 'post-stack-setup', reportOneMcp }));
}
