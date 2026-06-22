// src/modules/agent-model/model-gate.ts
// beforeShellExecution gate for the pre-spawn `model-gate.cjs` command (Cursor only). When the
// orchestrator runs it after capturing models, this checks whether any role's PICKED tier model
// is actually offered by the build. If one isn't, it returns a `permission:"ask"` result (askUser)
// — Cursor's hook-driven Approve/Reject dialog — so the USER can stop a blind auto-run. Approve
// only lets the command run (which still STOPs until chat consent). It does NOT record fallback.
// If every picked model is offered (or it's not the model-gate command / not a Cursor new-project
// build), it no-ops so the command runs.

import { asString } from '../../adapters/coerce';
import { noop } from '../../core/result';
import { askUser } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { obj } from '../../shared/obj';
import { cursorUnavailablePicks } from '../../shared/materialize/cursor-eligibility';
import { ensureCurrentRunId, readEffectiveState } from '../../shared/state';
import { canonicalToolName, isModelGateCommand, parsedToolInput } from '../../shared/tool-classify';

export function modelGateShell(ctx: Ctx): HookResult {
  if (ctx.host !== 'cursor') return noop();
  const raw = obj(ctx.input.raw) || {};
  // Cursor fixed shell hooks arrive as rawName="before-shell-execution", not "Bash".
  // Normalize via the canonical ToolInput class before feeding the shell allow-list.
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  if (!isModelGateCommand(toolName, toolInput)) return noop();

  const state = readEffectiveState(ctx.cwd);
  if (!state || (state as Record<string, unknown>).mode !== 'new-project') return noop();
  const picks = cursorUnavailablePicks(ctx.cwd, state as Record<string, unknown>);
  if (!picks.length) return noop(); // every picked model is offered → let the command run (allow)

  const rows = picks.map((p) => `  • ${p.role}: ${p.expected} → would run on ${p.fallback}`);
  const models = Array.from(new Set(picks.map((p) => p.expected))).join(', ');
  const question =
    `traffic-one — a model you picked for the senior team isn't available in this Cursor build `
    + `(disabled in Settings → Models, or not on your plan):\n${rows.join('\n')}\n\n`
    + `Approve → run the model-gate check (it will STOP until you reply **fallback** or **enable** in chat).   `
    + `Reject → stop, enable ${models} (Cmd/Ctrl+Shift+J → Models), then re-run the build.`;
  const agentMessage =
    `The user's picked model(s) ${models} are NOT offered by this build. If the user APPROVED this `
    + `command: run model-gate, then STOP — print the unavailable-model table to the user in chat and `
    + `wait for them to reply **fallback** or **enable** before spawning, scaffolding directly, or editing `
    + `project files (shell approval alone does NOT record consent). If the user REJECTED it: STOP — tell them to enable ${models} in Cursor Settings `
    + `→ Models, then re-run the build.`;
  return askUser(question, agentMessage);
}
