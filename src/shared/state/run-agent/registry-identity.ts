// src/shared/state/run-agent/registry-identity.ts
// Where the per-run agent registry lives, and the id set that identifies the
// agent one of its rows names.
//
// A leaf on purpose. Both halves are needed by the CLAIM side (claims-pending's
// supersession check asks who owns a role), and registry.ts cannot be imported
// there: its own imports reach back into the claim stores. Keeping the two
// definitions here means "which ids are this row's agent" stays ONE definition
// rather than a copy that can drift from the registry's.

import * as path from 'path';
import { obj, type Rec } from '../../obj';
import type { RunAgentEntry } from './registry';
import { runDir } from './run-paths';

export function agentRegistryFile(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), 'agents.json');
}

export function idsForRunAgent(entry: RunAgentEntry | Rec | null | undefined): string[] {
  const e = obj(entry);
  if (!e) return [];
  return [e.agentId, e.resumeId, e.toolCallId]
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
}
