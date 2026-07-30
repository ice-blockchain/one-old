// src/test-environment/core/run-sim/write.ts
// The primitive the whole tier rests on: put one scripted write through the REAL
// plan-write gate, record the verdict, and only then let the write land.
//
// Why the gate and not the readiness function directly: planWriteGate is the
// production dispatcher (plan-write/index.ts:57), so going through it also
// exercises materializeProjectIfNeeded convergence, runIdPathViolation,
// runTeamEnforcementViolation (where the claim/spawnIndex machinery lives) and
// planStaticViolations — and it returns the exact deny STRING a model would read.
//
// The gate is PreToolUse: it never writes. In production the host applies the
// tool after the hook allows it, so this module reproduces that order exactly —
// a denied write must leave nothing on disk, or the next gate in the chain would
// judge a file that production would never have had.

import * as fs from 'fs';
import * as path from 'path';

import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';
import { planWriteGate } from '../../../modules/plan-guard/plan-write';
import { readEffectiveState } from '../../../shared/state';
import { writeState } from '../../../shared/state/normalize';

import type { RunSimTranscript, ScriptedWrite, WriteOutcome } from './types';

// Mirrors src/modules/plan-guard/__tests__/plan-write.test.ts:68-84 — the
// established way to invoke the dispatcher without a live host.
export function writeCtx(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
  rawExtra: Record<string, unknown> = {},
  host: HostId = 'claude',
): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host,
    cwd,
    raw: { ...rawExtra, tool_name: rawName, tool_input: toolInput },
    tool: { class: cls, rawName },
  };
  return { input, host, cwd, now: () => 'run-sim' } as unknown as Ctx;
}

// Bind the acting role for subsequent writes. Real parallel subagents bind via
// bindThreadRole (which deliberately declines writeState so siblings cannot
// clobber .one.json); a serial simulator has no such contention, so it uses the
// activeAgentRole fallback branch of assignmentWriterRole. That difference is a
// documented limit of this tier, not an accident — see the plan's risk 3.
export function setActiveRole(cwd: string, role: string | null): void {
  const state = readEffectiveState(cwd) as Record<string, unknown>;
  if (role) state.activeAgentRole = role;
  else delete state.activeAgentRole;
  writeState(cwd, state);
}

export function applyScriptedWrite(
  cwd: string,
  phase: string,
  role: string | null,
  write: ScriptedWrite,
  transcript: RunSimTranscript,
  host: HostId = 'claude',
): WriteOutcome {
  const toolName = write.tool ?? 'Write';
  const toolClass: ToolClass = toolName === 'Edit' ? 'file-edit' : 'file-write';
  const toolInput = toolName === 'Edit'
    ? { file_path: write.path, new_string: write.content }
    : { file_path: write.path, content: write.content };

  const result = planWriteGate(writeCtx(cwd, toolName, toolClass, toolInput, {}, host));
  const denied = result.kind === 'deny';
  const outcome: WriteOutcome = {
    ordinal: transcript.writes.length + 1,
    phase,
    role,
    path: write.path,
    bytes: Buffer.byteLength(write.content, 'utf8'),
    denied,
    ...(denied ? { reason: (result as { reason: string }).reason } : {}),
    ...(write.expectDeny ? { expected: true } : {}),
  };
  transcript.writes.push(outcome);

  if (!denied) {
    const abs = path.join(cwd, write.path);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, write.content, 'utf8');
  }
  return outcome;
}

// Apply a sequence, stopping at the first UNEXPECTED deny. Returns the offending
// outcome so the caller can name the phase in `transcript.failure`.
export function applyAll(
  cwd: string,
  phase: string,
  role: string | null,
  writes: readonly ScriptedWrite[],
  transcript: RunSimTranscript,
  host: HostId = 'claude',
): WriteOutcome | null {
  for (const write of writes) {
    const outcome = applyScriptedWrite(cwd, phase, role, write, transcript, host);
    if (outcome.denied !== Boolean(write.expectDeny)) return outcome;
  }
  return null;
}
