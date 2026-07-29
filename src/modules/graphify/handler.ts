// src/modules/graphify/handler.ts
// PreToolUse(search) hint: tell the agent to read the active codebase-graph
// artefact before grep/glob. Non-blocking (context only), auth-gated,
// provider-aware, and throttled to once per SESSION via a disk marker — hooks
// run one process per tool call, so an in-memory throttle alone would re-inject
// the hint on every Glob/Grep.

import * as fs from 'fs';
import * as path from 'path';

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { GITNEXUS_REL, GRAPHIFY_REPORT_REL } from '../../shared/codegraph';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { firstEmitThisSession } from '../../shared/once';
import { hookSessionIdentity, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';

let graphifyHintSentForCwd: string | null = null;

// Test helper: reset the per-process throttle marker.
export function resetGraphifyHintThrottle(): void {
  graphifyHintSentForCwd = null;
}

export function preGraphifyHint(ctx: Ctx): HookResult {
  if (isNonProjectRoot(ctx.cwd)) return noop();
  const cwd = resolveProjectRoot(ctx.cwd, ctx.input.tool?.filePath, { ceiling: ctx.input.workspaceRoot });
  if (isNonProjectRoot(cwd) || pluginUseDeclined(cwd)) return noop();
  if (!authSatisfied()) return noop();
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
  if (!firstEmitThisSession(cwd, 'graphify-hint', hookSessionIdentity(ctx.input.raw).sessionId)) return noop();
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  const digestHint = runId ? ` Predecessor digests (if any) live under \`.traffic-one/digests/${runId}/\`.` : '';
  return context(`${label} — read it FIRST for module / file / call-site questions before grep/glob.${digestHint}`);
}
