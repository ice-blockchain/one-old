// src/modules/agent-model/gate-context.ts
// The accumulator agentModelGate threads through its extracted phases. Every
// field is computed once in the prologue (handler.ts) and read-only in the
// phase modules; allowSpawn is the single closure every ALLOW exit must flow
// through, so it is carried here rather than re-derived.

import type { Ctx, HookResult } from '../../core/types';
import type { readRunModelPolicy } from '../../shared/run-model-policy';
import type { inferTrafficOneSpawnRoleEvidence } from './role-infer';

type Rec = Record<string, unknown>;

export type SpawnRoleEvidence = Extract<
  ReturnType<typeof inferTrafficOneSpawnRoleEvidence>,
  { kind: 'evidence' }
>['evidence'];

export type RunPolicy = ReturnType<typeof readRunModelPolicy>;

export interface GateContext {
  ctx: Ctx;
  cwd: string;
  state: Rec;
  raw: Rec;
  toolName: string | undefined;
  toolInput: Rec;
  role: string;
  roleEvidence: SpawnRoleEvidence;
  spawnRunId: string;
  runPolicy: RunPolicy;
  subagentTeam: boolean;
  spawnPromptText: string;
  allowSpawn: (result: HookResult) => HookResult;
}
