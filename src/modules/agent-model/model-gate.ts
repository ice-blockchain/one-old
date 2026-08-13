// src/modules/agent-model/model-gate.ts
// beforeShellExecution gate for the pre-spawn `model-gate.cjs` command (Cursor only). When the
// orchestrator runs it after capturing models, this checks whether any role's PICKED tier model
// is actually offered by the build. If one isn't, it returns a `permission:"ask"` result (askUser)
// — Cursor's hook-driven Approve/Reject dialog — so the USER can stop a blind auto-run. Approve
// only lets the command run (which still STOPs until chat consent). It does NOT record fallback.
// If every picked model is offered (or it's not the model-gate command / not a Cursor new-project
// build), it no-ops so the command runs.

import { asString } from '../../adapters/coerce';
import { context, noop } from '../../core/result';
import { askUser } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { hostFlags } from '../../shared/host/capability-flags';
import { obj } from '../../shared/obj';
import { toolResultNumeric, toolResultVerdictSources } from '../../shared/tool-result';
import { cursorPickedModelUnavailableNotice, cursorUnavailablePicks, formatModelChoiceRequiredStop } from '../../shared/materialize/cursor-eligibility';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { isNewProjectMode, readEffectiveState } from '../../shared/state';
import { canonicalToolName, isModelCaptureCommand, isModelGateCommand, parsedToolInput } from '../../shared/tool-classify';

/**
 * Did the pre-spawn `model-gate.cjs` command fail?
 *
 * FAIL-CLOSED IS THE REQUIREMENT FOR A VERDICT THIS READER COULD HAVE READ, and
 * that is the whole of it — the sentence used to say "fail-closed is the
 * requirement" flatly, while the code answered `false` for a payload carrying no
 * verdict at all and always had. Which is the right answer: firing on silence
 * would fire on the two shapes this reader deliberately does NOT read (a verdict
 * two levels down, a word status that is not an exit code), making the one-level
 * bound decorative, and a STOP is a directive that halts the build until the user
 * replies. The rule is: where a verdict is present anywhere this reader looks, a
 * failure must never be read as a pass; where none is, the command is treated as
 * having passed. The ruling and its corpus are pinned in model-gate.test.ts.
 *
 * Where a verdict WAS present, this read was not fail-closed, and that was a
 * defect. It used to resolve one
 * source — `toolResultContainer(payload) ?? payload` — and a container is refused
 * wherever no host NAMED one, which is the honest answer for byte accounting and
 * the wrong one here: measured, `{ execution_record: { exit_code: 2 } }` and
 * `{ execution_record: { stdout: '…model-gate: STOP…' } }` both fell back to the
 * payload, found no flat status on it, and reported a FAILED gate as PASSING, so
 * the STOP directive was never delivered and a blind auto-run continued. That was
 * recorded as a latent residual on the grounds that this gate is keyed on
 * `availableModelsMustBeCaptured` — Cursor-only, and Cursor is flat — but latent
 * is not fixed, and the flag widening is a one-line change in a different file.
 *
 * So it reads the SHAPE instead: the payload's own top level and one level into
 * each record child, `toolResultVerdictSources`, which is the same projection the
 * subagent-failure classifier uses and needs no envelope to be named. Cursor is
 * byte-identical — its container is a top-level `output` STRING, which was never a
 * record and is now simply one of the payload's own fields.
 *
 * The one-level bound admits MORE than the classifier's does, deliberately and in
 * the other direction: an `exit_code` or a `traffic-one model-gate: STOP` line one
 * level in is this command's own, because the command is a shell invocation with
 * no nested children to confuse it with, and the STOP text is Traffic One's own
 * sentinel rather than a vocabulary a report could quote. Over-firing costs a STOP
 * directive nobody needed; under-firing costs the gate.
 *
 * WHICH SOURCE WINS IS A HIERARCHY, and it used to be a serialization accident.
 * Reading sources in order and RETURNING at the first one that SPOKE meant the
 * answer was whichever verdict the host happened to write first: measured through
 * this hook, `{ metadata: { exit_code: 0 }, execution_record: { exit_code: 2 } }`
 * delivered no STOP while the same two children in the other key order did, a
 * failing envelope beside a sibling's `{ ok: true }` read as a pass, and a passing
 * sibling ahead of the STOP sentinel swallowed it. Three resolutions in one
 * function, none of them chosen. The order now is:
 *
 *   1. Traffic One's OWN sentinel, anywhere in the sources. `traffic-one
 *      model-gate: STOP` is text this repo writes and no shell echoes by accident,
 *      so it is the strongest evidence available and outranks even a passing exit
 *      code — a gate that printed it has demanded a stop whatever the exit status;
 *   2. the payload's OWN exit status, which on a flat host IS the shell's. This
 *      is a real discriminator rather than a tie-break: a command has exactly one
 *      exit status, so where the payload reports one, an envelope reporting a
 *      different one is not this command's. Unchanged, and the row pinning it
 *      stays green;
 *   3. otherwise ANY envelope reporting a failure, in no order at all. This is
 *      the fail-closed direction the paragraph above asks for and the first-match
 *      return did not implement: over-firing costs a STOP directive nobody
 *      needed, under-firing costs the gate.
 *
 * Cursor, the only host this gate runs on, reports at the payload's own level and
 * is byte-identical under all three.
 */
function sourceExitVerdict(raw: Record<string, unknown>): boolean | null {
  const code = toolResultNumeric(raw.exit_code ?? raw.exitCode ?? raw.status ?? raw.code);
  if (code !== null) return code !== 0;
  const success = raw.success ?? raw.ok;
  if (typeof success === 'boolean') return !success;
  return null;
}

function carriesStopSentinel(raw: Record<string, unknown>): boolean {
  const stderr = asString(raw.stderr ?? raw.error);
  const stdout = asString(raw.stdout ?? raw.output);
  return /traffic-one model-gate:\s*STOP/i.test(`${stdout}\n${stderr}`);
}

function shellExitFailed(payload: Record<string, unknown>): boolean {
  const { own, nested } = toolResultVerdictSources(payload);
  const sources = own ? [own, ...nested] : nested;
  if (sources.some(carriesStopSentinel)) return true;
  const ownVerdict = own ? sourceExitVerdict(own) : null;
  if (ownVerdict !== null) return ownVerdict;
  return nested.some((source) => sourceExitVerdict(source) === true);
}

// Both halves gate the model-gate COMMAND, which exists only on a host whose
// subagent model ids have to be captured from the UI before a run's policy can be
// frozen (runners/onboarding-wait/pre-spawn-directives.ts already keys the
// capture requirement itself on the same flag). Where the ids are enumerable
// there is no capture step, no command, and nothing for these hooks to watch.
export function modelGateShell(ctx: Ctx): HookResult {
  if (!hostFlags(ctx.host).availableModelsMustBeCaptured) return noop();
  const raw = obj(ctx.input.raw) || {};
  // Cursor fixed shell hooks arrive as rawName="before-shell-execution", not "Bash".
  // Normalize via the canonical ToolInput class before feeding the shell allow-list.
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const root = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (!isModelGateCommand(toolName, toolInput, root)) return noop();
  if (isModelCaptureCommand(toolName, toolInput, root)) return noop();

  const state = readEffectiveState(root, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  if (!isNewProjectMode(state)) return noop();
  const picks = cursorUnavailablePicks(root, state as Record<string, unknown>);
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

export function modelGateAfterShell(ctx: Ctx): HookResult {
  if (!hostFlags(ctx.host).availableModelsMustBeCaptured) return noop();
  const raw = obj(ctx.input.raw) || {};
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName);
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};
  const root = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  if (!isModelGateCommand(toolName, toolInput, root)) return noop();
  if (isModelCaptureCommand(toolName, toolInput, root)) return noop();
  if (!shellExitFailed(raw)) return noop();

  const state = readEffectiveState(root, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  if (!isNewProjectMode(state)) return noop();
  const stop = formatModelChoiceRequiredStop(root, state as Record<string, unknown>);
  const visible = cursorPickedModelUnavailableNotice(root, state as Record<string, unknown>) || stop;
  if (!stop && !visible) return noop();
  return context(stop || visible, { systemMessage: visible || stop });
}
