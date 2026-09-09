// src/test-environment/core/run-sim/write.ts
// The primitive the whole tier rests on: put one scripted write through the REAL
// check-plan-write pipeline, record the verdict, and only then let the write land.
//
// Why the pipeline and not planWriteGate directly: the host entry
// (hooks/claude-entry.ts) loads every module handler and routes
// `check-plan-write` through dispatchSubcommand → handlersForSubcommand →
// runPipeline. That set is session.auth, session.workspace-boundary,
// session.authoring-guard, then plan-guard.write — not the write gate alone.
// Going through the same handler set also exercises stampDeny (gateId / denyId)
// so a thrown handler becomes `pipeline-handler-crashed` instead of looking like
// correct enforcement.
//
// The gate is PreToolUse: it never writes. In production the host applies the
// tool after the hook allows it, so this module reproduces that order exactly —
// a denied write must leave nothing on disk, or the next gate in the chain would
// judge a file that production would never have had.

import * as fs from 'fs';
import * as path from 'path';

import { buildContext } from '../../../core/context';
import { handlersForSubcommand } from '../../../core/dispatch';
import { runPipeline } from '../../../core/pipeline';
import { collectHandlers, defaultModulesDir, loadModules } from '../../../core/registry';
import type { Ctx, Handler, HookInput, HostId, ToolClass } from '../../../core/types';
import { readEffectiveState } from '../../../shared/state';
import { claimThreadRole } from '../../../shared/state/run-agent';
import { listClaimedAgents, nextSpawnIndex } from '../../../shared/state/run-agent/claims-store';

import { expectDenyGap } from './expect-deny';
import type { RunSimTranscript, ScriptedWrite, WriteOutcome } from './types';

const CHECK_PLAN_WRITE = 'check-plan-write';

// Same handler objects the host entry would pass to dispatchSubcommand for
// this subcommand. Cached: loadModules require()s are already module-cached,
// and a run-sim issues dozens of writes.
let cachedPlanWriteHandlers: Handler[] | undefined;

export function checkPlanWriteHandlers(): readonly Handler[] {
  if (!cachedPlanWriteHandlers) {
    cachedPlanWriteHandlers = handlersForSubcommand(
      collectHandlers(loadModules(defaultModulesDir(), { strict: true })),
      CHECK_PLAN_WRITE,
    );
  }
  return cachedPlanWriteHandlers;
}

// Real Ctx via buildContext — the force-cast `{ input, host, cwd, now }` is
// what the host never hands a handler. filePath/content are populated the way
// adapters/claude.ts parse() does, so gates that read ctx.input.tool see them.
export function writeCtx(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
  rawExtra: Record<string, unknown> = {},
  host: HostId = 'claude',
): Ctx {
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path
    : typeof toolInput.filePath === 'string' ? toolInput.filePath
      : '';
  const content = typeof toolInput.content === 'string' ? toolInput.content
    : typeof toolInput.new_string === 'string' ? toolInput.new_string
      : '';
  const input: HookInput = {
    event: 'PreToolUse',
    host,
    cwd,
    raw: { ...rawExtra, tool_name: rawName, tool_input: toolInput },
    tool: {
      class: cls,
      rawName,
      ...(filePath ? { filePath } : {}),
      ...(content ? { content } : {}),
    },
  };
  return buildContext(input);
}

// Bind a role the way a real spawned child does: a per-agent run claim keyed by
// a thread/session id, which subsequent writes carry as `session_id`.
//
// This is NOT decoration. runTeamEnforcementViolation refuses feature-source
// writes on a `team.mode: "subagents"` project unless they come from a session
// holding a claim — setting `state.activeAgentRole` alone is treated (correctly)
// as the parent editing owned artifacts, and is denied. Binding for real means
// the tier exercises resolveRunAgentContext / roleForRunSessionId / the claims
// store rather than only the activeAgentRole fallback.
//
// The session id is deterministic per role so a fix cycle re-binding the SAME
// thread is distinguishable from a respawn — which is exactly what the
// subagent-reuse assertion measures.
export function sessionIdFor(role: string): string {
  return `run-sim-${role}`;
}

export function bindRole(cwd: string, role: string): string | null {
  const state = readEffectiveState(cwd);
  const claimed = claimThreadRole(cwd, state, sessionIdFor(role), role, {
    parentSessionId: 'run-sim-orchestrator',
    recordAgent: true,
  });
  return claimed ? sessionIdFor(role) : null;
}

function currentRunId(cwd: string): string {
  const state = readEffectiveState(cwd);
  return typeof state.currentRunId === 'string' ? state.currentRunId : '';
}

function resultDenyId(result: { kind: string; denyId?: string }): string | undefined {
  return typeof result.denyId === 'string' && result.denyId ? result.denyId : undefined;
}

function resultGateId(result: { kind: string; gateId?: string }): string | undefined {
  return typeof result.gateId === 'string' && result.gateId ? result.gateId : undefined;
}

// The bound role's current spawn index, read the same way index.ts
// `claimSnapshot` does (listClaimedAgents + nextSpawnIndex).
//
// Runtime spawnIndex is 1-based (`nextSpawnIndex` uses Math.max(..., 1)). The
// plan's "spawnIndex 0" means first spawn / first attempt = `spawnIndex === 1`
// or the first write of this role. Parent writes (no role) omit the field.
export function roleSpawnIndex(cwd: string, role: string | null): number | undefined {
  if (!role) return undefined;
  const runId = currentRunId(cwd);
  if (!runId) return undefined;
  const state = readEffectiveState(cwd);
  const session = sessionIdFor(role);
  const claims = listClaimedAgents(cwd, runId).filter((claim) => claim.role === role);
  const claim = claims.find((entry) => entry.sessionId === session) ?? claims[claims.length - 1];
  if (claim && typeof claim.spawnIndex === 'number' && Number.isInteger(claim.spawnIndex) && claim.spawnIndex > 0) {
    return claim.spawnIndex;
  }
  // After bind, nextSpawnIndex is the NEXT slot (disk count + 1). Before any
  // claim exists it is 1 — the first attempt.
  const next = nextSpawnIndex(cwd, state, runId, role);
  return claims.length > 0 ? Math.max(1, next - 1) : next;
}

// The slot a NEW spawn of `role` would receive. Spawn-gate recording uses this
// rather than the already-bound claim: a maintenance re-spawn is not attempt 1.
export function nextRoleSpawnIndex(cwd: string, role: string): number | undefined {
  const runId = currentRunId(cwd);
  if (!runId) return undefined;
  return nextSpawnIndex(cwd, readEffectiveState(cwd), runId, role);
}

export async function applyScriptedWrite(
  cwd: string,
  phase: string,
  role: string | null,
  write: ScriptedWrite,
  transcript: RunSimTranscript,
  host: HostId = 'claude',
): Promise<WriteOutcome> {
  const toolName = write.tool ?? 'Write';
  const toolClass: ToolClass = toolName === 'Edit' ? 'file-edit' : 'file-write';
  const toolInput = toolName === 'Edit'
    ? { file_path: write.path, new_string: write.content }
    : { file_path: write.path, content: write.content };
  // The child session id is what binds this write to its claim, exactly as a
  // real host hook payload carries it.
  const rawExtra = role ? { session_id: sessionIdFor(role) } : {};

  const result = await runPipeline(checkPlanWriteHandlers(), writeCtx(
    cwd, toolName, toolClass, toolInput, rawExtra, host,
  ));
  const denied = result.kind === 'deny';
  const denyId = resultDenyId(result);
  const gateId = resultGateId(result);
  const spawnIndex = roleSpawnIndex(cwd, role);
  const outcome: WriteOutcome = {
    ordinal: transcript.writes.length + 1,
    phase,
    role,
    path: write.path,
    bytes: Buffer.byteLength(write.content, 'utf8'),
    denied,
    host,
    ...(denied ? { reason: (result as { reason: string }).reason } : {}),
    ...(write.expectDeny ? { expected: true } : {}),
    ...(write.denyMatch ? { denyMatch: write.denyMatch } : {}),
    ...(write.expectHandler ? { expectHandler: write.expectHandler } : {}),
    ...(denyId ? { denyId } : {}),
    ...(gateId ? { gateId } : {}),
    ...(spawnIndex !== undefined ? { spawnIndex } : {}),
  };
  transcript.writes.push(outcome);

  if (!denied) {
    const abs = path.join(cwd, write.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, write.content, 'utf8');
  }
  return outcome;
}

function scriptedWriteFailed(write: ScriptedWrite, outcome: WriteOutcome): boolean {
  if (write.expectDeny) return expectDenyGap(outcome) !== null;
  return outcome.denied;
}

// Apply a sequence, stopping at the first UNEXPECTED deny, unexpected allow,
// crash-deny, or unnamed/mismatched handler. Returns the offending outcome so
// the caller can name the phase in `transcript.failure`.
export async function applyAll(
  cwd: string,
  phase: string,
  role: string | null,
  writes: readonly ScriptedWrite[],
  transcript: RunSimTranscript,
  host: HostId = 'claude',
): Promise<WriteOutcome | null> {
  for (const write of writes) {
    const outcome = await applyScriptedWrite(cwd, phase, role, write, transcript, host);
    if (scriptedWriteFailed(write, outcome)) return outcome;
  }
  return null;
}
