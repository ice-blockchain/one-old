// src/modules/graphify/handler.ts
// PreToolUse(search) hint: tell the agent to read the active codebase-graph
// artefact before grep/glob. Ported 1:1 from runPreGraphifyHint in
// scripts/hook-runtime/handlers/post.cjs. Non-blocking (context only),
// auth-gated, provider-aware, and throttled to once per process per cwd.

import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isAuthenticatedLocal } from '../../shared/auth';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL } from '../../shared/codegraph';
import { readEffectiveState } from '../../shared/state';

let graphifyHintSentForCwd: string | null = null;

// Test helper: reset the per-process throttle marker.
export function resetGraphifyHintThrottle(): void {
  graphifyHintSentForCwd = null;
}

export function preGraphifyHint(ctx: Ctx): HookResult {
  if (!isAuthenticatedLocal()) return noop();
  const cwd = ctx.cwd;
  if (graphifyHintSentForCwd === cwd) return noop();

  const state = readEffectiveState(cwd);
  const provider = typeof state.codeGraphProvider === 'string' ? state.codeGraphProvider : null;

  let label: string;
  let artefactPath: string;
  if (provider === 'gitnexus') {
    artefactPath = path.join(cwd, GITNEXUS_REL);
    label = '[graph: gitnexus] `.traffic-one/.gitnexus/` knowledge graph present';
  } else {
    artefactPath = path.join(cwd, GRAPHIFY_REPORT_REL);
    label = '[graph: graphify] `.traffic-one/graphify-out/GRAPH_REPORT.md` present';
  }
  if (!fs.existsSync(artefactPath)) return noop();

  graphifyHintSentForCwd = cwd;
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  const digestHint = runId ? ` Predecessor digests (if any) live under \`.traffic-one/digests/${runId}/\`.` : '';
  return context(`${label} — read it FIRST for module / file / call-site questions before grep/glob.${digestHint}`);
}
