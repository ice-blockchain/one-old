// tests/replay-corpus/run-case.ts
// The replay primitive: build a real Ctx from a canonical HookInput, run it
// through the REAL, dynamically-loaded handler set (handlers.ts), and reduce
// the returned HookResult to the {decision, gate, denyId, denyTarget} record the
// plan asks for. Deliberately reads runPipeline's RETURN VALUE only — never the
// decision log (shared/state/decision-log.ts) — because the return value
// already carries gateId/denyId/denyTarget unconditionally (core/pipeline.ts's
// stampDeny) and needs no run-id/consent-fence bookkeeping to get at them.
// `decisionKind` below is a deliberate, tiny, verbatim copy of
// core/pipeline.ts's own (unexported) `decisionKind` — see that file's
// comment for why 'allow' only ever means "PreToolUse, no deny".

import { resetCorpusEnv } from './env';

import * as path from 'path';

import { buildContext } from '../../src/core/context';
import { isDeny } from '../../src/core/result';
import { runPipeline } from '../../src/core/pipeline';
import type { CanonicalEvent, Handler, HookInput, HostId, ToolClass } from '../../src/core/types';
import { resetPluginUseCache } from '../../src/shared/state/plugin-use';
import { readState } from '../../src/shared/state';
import { replayHandlers } from './handlers';

export interface CaseToolSpec {
  readonly class: ToolClass;
  readonly rawName: string;
  readonly command?: string;
  readonly workdir?: string;
  readonly filePath?: string;
  readonly content?: string;
  readonly patchText?: string;
}

export interface CaseSpec {
  /** Stable, human-chosen id — the snapshot's diff key. Never reuse or renumber. */
  readonly id: string;
  /** One-line human-readable intent; not asserted on, purely for readability. */
  readonly notes: string;
  readonly host: HostId;
  readonly event: CanonicalEvent;
  /** Builds the case's project state with the PRODUCTION writers and returns
   * its absolute root, which also becomes the hook's `cwd`. Called once per
   * replay, so every case gets its own tree and no case can observe another's
   * side effects (fixtures.ts). Identity of this function is what the coverage
   * test counts as a distinct "project state". */
  readonly project: (host: HostId) => string;
  /**
   * The gate this case exists to characterize: a handler `id` when the case is
   * expected to DENY, or null when it is a control case expected to get
   * through (allow / context / noop).
   *
   * REQUIRED, and asserted per case by replay.test.ts BEFORE the snapshot is
   * compared. Without it, a case whose fixture stops satisfying a higher-
   * priority gate silently starts characterizing THAT gate instead, keeps a
   * green snapshot, and quietly protects nothing — which is exactly what
   * happened to all ten original plan-guard cases (every one of them landed on
   * onboarding-gate's priority-10 convergence deny). The gate is asserted and
   * the denyId is left to the snapshot on purpose: a gate change is a
   * mis-specified case, while a denyId change is a real verdict change that
   * deserves a reviewable diff.
   */
  readonly expectGate: string | null;
  /** A function receives the RESOLVED fixture root, for the handful of gates
   * whose exact-argv grammar only recognizes a command naming this project
   * (`modelGateInvocation` compares the command's project-root word against the
   * resolved root). Fixture roots are per-run mkdtemp paths, so those commands
   * cannot be literals. */
  readonly tool?: CaseToolSpec | ((cwd: string) => CaseToolSpec);
  readonly prompt?: string;
  /** Extra raw wire fields a specific gate reads directly off ctx.input.raw
   * (session/agent identity, run_in_background, …). Most cases need none —
   * canonical `tool` fields already reach every gate via parsedToolInput(). */
  readonly raw?: Record<string, unknown>;
  /** 'cwd' pins ctx.input.workspaceRoot to the resolved project root (Cursor's
   * authoritative workspace boundary); a literal string pins it elsewhere. */
  readonly workspaceRoot?: 'cwd' | string;
  /**
   * Env overrides scoped to this ONE case, applied around BOTH the fixture
   * build and the pipeline run, then restored (including back to *unset*).
   *
   * Both phases, not just the run: the two seams that need this
   * (`TRAFFIC_ONE_USER_PLAN`, which every model-tier read resolves through, and
   * `TRAFFIC_ONE_AUTH`) are read by the production WRITERS a fixture calls as
   * well as by the gates. A plan visible only at replay time would make the
   * gate read a different plan bucket than the one the fixture captured models
   * into, and the case would characterize a capture-missing state instead of the
   * state it names. env.ts wipes both variables process-wide, so a case that
   * does not declare them cannot be affected by either.
   */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ReplayOutcome {
  readonly id: string;
  readonly decision: 'allow' | 'deny' | 'context' | 'noop';
  readonly gate: string;
  readonly denyId: string;
  /** Reduced shape token — see denyTargetShape. Never the raw value. */
  readonly denyTarget: string;
}

/**
 * Near-verbatim copy of core/pipeline.ts's private decisionKind — see that
 * file's header for why 'deny' always wins and every other event's non-deny
 * outcome is 'context'/'noop' rather than a fabricated 'allow'.
 *
 * ONE deliberate divergence, and it is the difference between this corpus
 * characterizing behaviour and characterizing nothing. The pipeline collapses
 * every non-deny PreToolUse outcome to 'allow' because that is the answer the
 * HOST needs. Here it made a `context` result and a `noop` byte-identical
 * rows — and `context` is how every advisory in the plugin reaches the agent.
 * Confirmed by neutering `advisory()` to return `[]`: the snapshot did not
 * move and `replay.test.ts` stayed 4/4 green, so the corpus could not tell a
 * plugin that advises from one that says nothing at all.
 *
 * Testing `context` FIRST keeps the deny ordering intact and separates the two.
 * Deliberately a token and not a content shape: `mergeResults` drops per-handler
 * ids on context results, so there is nothing stable to key on, and the payloads
 * carry mkdtemp roots that would re-break determinism.
 */
function decisionKind(event: CanonicalEvent, result: { kind: string }): ReplayOutcome['decision'] {
  if (result.kind === 'deny') return 'deny';
  if (result.kind === 'context') return 'context';
  if (event === 'PreToolUse') return 'allow';
  return result.kind === 'noop' ? 'noop' : 'context';
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Reduces a deny's `denyTarget` to a deterministic SHAPE token.
 *
 * denyTarget is load-bearing for a later per-target deny budget (see
 * core/types.ts: a budget keyed on `(gateId, denyId)` alone lets a write
 * through to a file the agent does not own), so "was a target carried, and
 * WHICH of the call's inputs was it?" has to be in the baseline. The RAW value
 * cannot be: across the gates that set it (`rg 'denyTarget:' src`) it is
 * variously a project ROOT (an mkdtemp absolute path — different every run), a
 * freshly minted RUN ID (Date.now-based — different every run), a role, a
 * command, or a file path. Storing it raw would make the snapshot
 * machine-specific and re-break the determinism the corpus is built on.
 *
 * So each value is named by WHERE it came from, comparing against the inputs
 * this harness itself supplied plus the fixture's own run id, and only
 * project-RELATIVE paths are echoed literally (those are authored constants in
 * the case, not machine state). `opaque` is the deliberate catch-all; a real
 * value landing there is a signal to extend this vocabulary, not to widen it.
 * replay.test.ts additionally asserts no row contains a temp path, so a future
 * `opaque`-shaped leak fails instead of quietly poisoning the baseline.
 */
function denyTargetShape(target: string | undefined, tool: CaseToolSpec | undefined, cwd: string): string {
  if (!target) return '-';
  if (target === cwd || path.resolve(target) === path.resolve(cwd)) return 'project-root';
  if (tool?.command && target === tool.command) return 'tool-command';
  if (tool?.rawName && target === tool.rawName) return 'tool-name';

  // The run id the fixture is carrying, read with the production reader. Every
  // `denyTarget: runId` site (onboarding-gate's model-policy denies,
  // agent-model's spawn ladder, model-rotation) hands back whichever id the
  // state already holds, or mints one — so an exact match names it as the run
  // id without the snapshot ever storing the id itself.
  const runId = readState(cwd).currentRunId;
  if (runId && target === runId) return 'run-id';

  if (path.isAbsolute(target)) {
    return isInside(target, cwd) ? `project-path:${toPosix(path.relative(cwd, target))}` : 'abs-path-outside-project';
  }
  // Relative and looks like a path the case authored (plan-write/authoring-guard
  // pass the tool's own project-relative filePath through).
  if (target === tool?.filePath || /[\\/.]/.test(target)) return `project-path:${toPosix(target)}`;
  // Roles ('architect', 'coder', …) and other short bare tokens: the value is
  // an authored constant, deterministic, and worth reading in a diff.
  if (/^[a-z][a-z0-9-]*$/.test(target)) return `token:${target}`;
  return 'opaque';
}

export async function replayCase(spec: CaseSpec, handlers?: Handler[]): Promise<ReplayOutcome> {
  // Undo any process.env mutation the PREVIOUS case's handlers performed before
  // this one builds its fixture — see env.ts's resetCorpusEnv. This is what makes
  // the corpus order-independent, and it runs before the per-case overrides
  // below so a `spec.env` value is never wiped by it.
  resetCorpusEnv();
  // Same for the process-lifetime consent memo (state/plugin-use.ts): its key
  // includes HOME and XDG_STATE_HOME, so an entry cached while a handler had
  // moved either one would otherwise answer for a state dir this case does not
  // use. Cheap — the answer is one JSON read.
  resetPluginUseCache();
  const restore = new Map<string, string | undefined>();
  const set = (key: string, value: string): void => {
    if (!restore.has(key)) restore.set(key, process.env[key]);
    process.env[key] = value;
  };
  set('TRAFFIC_ONE_HOST', spec.host);
  for (const [key, value] of Object.entries(spec.env ?? {})) set(key, value);
  try {
    const cwd = spec.project(spec.host);
    const tool = typeof spec.tool === 'function' ? spec.tool(cwd) : spec.tool;
    const input: HookInput = {
      event: spec.event,
      host: spec.host,
      cwd,
      ...(spec.workspaceRoot ? { workspaceRoot: spec.workspaceRoot === 'cwd' ? cwd : spec.workspaceRoot } : {}),
      ...(tool ? { tool } : {}),
      ...(spec.prompt !== undefined ? { prompt: spec.prompt } : {}),
      raw: spec.raw ?? {},
    };
    const ctx = buildContext(input);
    const result = await runPipeline(handlers ?? replayHandlers(), ctx);
    return {
      id: spec.id,
      decision: decisionKind(spec.event, result),
      gate: isDeny(result) ? (result.gateId ?? '') : '',
      denyId: isDeny(result) ? (result.denyId ?? '') : '',
      denyTarget: isDeny(result) ? denyTargetShape(result.denyTarget, tool, cwd) : '-',
    };
  } finally {
    for (const [key, previous] of restore) {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  }
}
