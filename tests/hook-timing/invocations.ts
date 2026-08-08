// tests/hook-timing/invocations.ts
// The measurable surface of the hook runtime: one entry per (host family,
// hook subcommand) the dispatcher can be invoked with, carrying a REAL host
// wire payload and the project state to run it against.
//
// WHY A SUBCOMMAND MATRIX AND NOT AN EVENT MATRIX. A hook invocation is one OS
// process, and the host decides how many of them one canonical event costs.
// Reading dist/hooks/hooks.json: Claude/Codex fire up to EIGHT separate
// PreToolUse commands (matcher-filtered — four of them for a `Write`, five for
// a `Bash`), while Cursor fires exactly one command per event and lets the
// pipeline fan out inside it. "The PreToolUse budget" is therefore not one
// number on Claude; it is a per-subcommand number plus a fan-out. Measuring per
// event only would average that away, and the average is not what any host
// waits for.
//
// WHY THESE PAYLOADS ARE AUTHORED HERE AND NOT TAKEN FROM tests/replay-corpus/.
// The replay corpus does not hold recorded host payloads. It holds CANONICAL
// case specs — {host, event, tool: {class, rawName, …}} — and run-case.ts
// assembles a HookInput from them directly, so a corpus replay never runs
// `adapter.parse` and never enters through `dispatch`. That is the right shape
// for characterizing verdicts and the wrong one for measuring latency: the
// wire parse, the host-entry fail-closed pre-checks, per-invocation module
// discovery (`loadModules` runs inside every `runClaudeHook` call) and
// `observeCurrentRunHostCapabilityFromHook` all live on the far side of the
// seam the corpus skips. So these payloads are the host wire shapes, handed to
// the same exported entry function the compiled `scripts/*.cjs` main() calls.
//
// The PROJECT STATES are reused from the corpus (fixtures.ts) rather than
// rebuilt, so a timing row and a verdict row are talking about the same world.

import '../replay-corpus/env';

import type { CanonicalEvent, HostId } from '../../src/core/types';
import { collectHandlers, defaultModulesDir, loadModules } from '../../src/core/registry';
import { onboardedMidRun, onboardedNotMaterialized, scaffoldedGreenfield } from '../replay-corpus/fixtures';
import { runClaudeHook } from '../../src/hooks/claude-entry';
import { runCursorHook } from '../../src/hooks/cursor-entry';
import { runWindsurfHook } from '../../src/hooks/windsurf-entry';

export type HostFamily = 'claude' | 'cursor' | 'windsurf';

export interface HookInvocation {
  /** Stable row id; also the label a verdict line is printed under. */
  readonly key: string;
  readonly event: CanonicalEvent;
  readonly host: HostId;
  readonly family: HostFamily;
  /** The argv word the host's hooks config passes to the runtime. */
  readonly subcommand: string;
  /** The compiled entry a real host invokes for this row. */
  readonly shim: 'hook-runtime.cjs' | 'cursor-hook-runtime.cjs' | 'windsurf-hook-runtime.cjs';
  /** Exact host wire JSON, as a function of the resolved fixture root. */
  readonly stdin: (cwd: string) => string;
  readonly project: (host: HostId) => string;
}

const j = (value: unknown): string => JSON.stringify(value);
const writeToolInput = (cwd: string): Record<string, unknown> => ({
  file_path: `${cwd}/src/features/timing/Timing.tsx`,
  content: 'export const Timing = () => null;\n',
});

// Claude and Codex speak the same nested wire shape and share one adapter, so
// one row per subcommand covers both; `host` selects which id detectHost lands
// on and the Codex-only rows say so.
function nested(event: CanonicalEvent, extra: Record<string, unknown>, cwd: string): string {
  return j({ hook_event_name: event, cwd, session_id: 'hook-timing-session', ...extra });
}

function flat(cwd: string, extra: Record<string, unknown>): string {
  return j({ cwd, workspace_roots: [cwd], conversation_id: 'hook-timing-parent', ...extra });
}

export const HOOK_INVOCATIONS: readonly HookInvocation[] = [
  // ── Claude/Codex: SessionStart ────────────────────────────────────────────
  {
    key: 'claude · session-start',
    event: 'SessionStart', host: 'claude', family: 'claude',
    subcommand: 'session-start', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('SessionStart', {}, cwd),
  },
  // ── Claude/Codex: UserPromptSubmit ────────────────────────────────────────
  {
    key: 'claude · user-prompt-submit',
    event: 'UserPromptSubmit', host: 'claude', family: 'claude',
    subcommand: 'user-prompt-submit', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('UserPromptSubmit', { prompt: 'Continue implementing the feature.' }, cwd),
  },
  // ── Claude/Codex: PreToolUse, one row per command in hooks.json ───────────
  // A `Write` fires the first four of these; a `Bash` fires those plus
  // check-library-allowlist; a `Task` swaps check-plan-write for
  // check-agent-model; a `Grep` swaps it for pre-graphify-hint.
  {
    key: 'claude · check-codex-child-model',
    event: 'PreToolUse', host: 'codex', family: 'claude',
    subcommand: 'check-codex-child-model', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Write', tool_input: writeToolInput(cwd) }, cwd),
  },
  {
    key: 'claude · check-onboarding-gate',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-onboarding-gate', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Write', tool_input: writeToolInput(cwd) }, cwd),
  },
  {
    key: 'claude · check-model-choice-gate',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-model-choice-gate', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Write', tool_input: writeToolInput(cwd) }, cwd),
  },
  {
    key: 'claude · check-plan-write',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-plan-write', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Write', tool_input: writeToolInput(cwd) }, cwd),
  },
  {
    key: 'claude · check-library-allowlist',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-library-allowlist', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, cwd),
  },
  {
    key: 'claude · check-agent-model',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-agent-model', shim: 'hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => nested('PreToolUse', {
      tool_name: 'Task',
      tool_input: { description: 'implement', prompt: 'do the thing', subagent_type: 'senior-backend' },
    }, cwd),
  },
  // Declared by agent-model's descriptor but registered in NO generated host
  // config (`rg check-model-gate dist/` finds only the module descriptor and
  // its compiled index): it is reached through the standalone
  // `scripts/model-gate.cjs` runner, not through a host hook. Timed anyway,
  // because the dispatcher routes it like any other subcommand and a
  // subscription no host fires is a fact worth having a number next to.
  {
    key: 'claude · check-model-gate',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-model-gate', shim: 'hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, cwd),
  },
  // The manual remediation command every materialization deny points the agent
  // at. It parses to a PreToolUse carrying NO tool, which is the exact shape
  // materialize.materialize-project keys on, so it is the one invocation that
  // makes that handler act rather than no-op.
  {
    key: 'claude · materialize-project',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'materialize-project', shim: 'hook-runtime.cjs',
    project: onboardedNotMaterialized,
    stdin: (cwd) => nested('PreToolUse', {}, cwd),
  },
  {
    key: 'claude · pre-graphify-hint',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'pre-graphify-hint', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', { tool_name: 'Grep', tool_input: { pattern: 'useEffect' } }, cwd),
  },
  // check-one-mcp-tool is answered by the entry BEFORE any module loads (it is
  // wired to exactly one managed MCP matcher and denies unconditionally), so it
  // is the floor of the whole surface: an entry with no dispatch behind it.
  {
    key: 'claude · check-one-mcp-tool',
    event: 'PreToolUse', host: 'claude', family: 'claude',
    subcommand: 'check-one-mcp-tool', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PreToolUse', {
      tool_name: 'mcp__traffic-one-mcp__get_config', tool_input: {},
    }, cwd),
  },
  // ── Claude/Codex: PostToolUse ─────────────────────────────────────────────
  {
    key: 'claude · post-stack-setup',
    event: 'PostToolUse', host: 'claude', family: 'claude',
    subcommand: 'post-stack-setup', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, cwd),
  },
  {
    key: 'claude · post-build-graphify',
    event: 'PostToolUse', host: 'claude', family: 'claude',
    subcommand: 'post-build-graphify', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, cwd),
  },
  {
    key: 'claude · post-build-page-speed',
    event: 'PostToolUse', host: 'claude', family: 'claude',
    subcommand: 'post-build-page-speed', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, cwd),
  },
  {
    key: 'claude · post-agent-spawned',
    event: 'PostToolUse', host: 'claude', family: 'claude',
    subcommand: 'post-agent-spawned', shim: 'hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => nested('PostToolUse', {
      tool_name: 'Task', tool_input: { subagent_type: 'senior-backend' },
    }, cwd),
  },
  // ── Codex-only SubagentStart, Claude-family Stop ──────────────────────────
  {
    key: 'claude · subagent-start',
    event: 'SubagentStart', host: 'codex', family: 'claude',
    subcommand: 'subagent-start', shim: 'hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => nested('SubagentStart', { agent_id: 'hook-timing-child-thread' }, cwd),
  },
  {
    key: 'claude · onboarding-stop',
    event: 'Stop', host: 'claude', family: 'claude',
    subcommand: 'onboarding-stop', shim: 'hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => nested('Stop', {}, cwd),
  },
  // ── Cursor: one process per event, full pipeline fan-out inside it ────────
  {
    key: 'cursor · session-start',
    event: 'SessionStart', host: 'cursor', family: 'cursor',
    subcommand: 'session-start', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, {}),
  },
  {
    key: 'cursor · user-prompt-submit',
    event: 'UserPromptSubmit', host: 'cursor', family: 'cursor',
    subcommand: 'user-prompt-submit', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { prompt: 'Continue implementing the feature.' }),
  },
  {
    key: 'cursor · before-tool-use',
    event: 'PreToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'before-tool-use', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { tool_name: 'Write', tool_input: writeToolInput(cwd) }),
  },
  {
    key: 'cursor · before-shell-execution',
    event: 'PreToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'before-shell-execution', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { command: 'npm run build' }),
  },
  {
    key: 'cursor · before-read-file',
    event: 'PreToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'before-read-file', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { file_path: `${cwd}/package.json` }),
  },
  {
    key: 'cursor · before-mcp-execution',
    event: 'PreToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'before-mcp-execution', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { mcp_server_name: 'context7', mcp_tool_name: 'resolve-library-id' }),
  },
  {
    key: 'cursor · after-tool-use',
    event: 'PostToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'after-tool-use', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { tool_name: 'Write', tool_input: writeToolInput(cwd) }),
  },
  {
    key: 'cursor · after-shell-execution',
    event: 'PostToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'after-shell-execution', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, { command: 'npm run build', exit_code: 0 }),
  },
  {
    key: 'cursor · after-file-edit',
    event: 'PostToolUse', host: 'cursor', family: 'cursor',
    subcommand: 'after-file-edit', shim: 'cursor-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => flat(cwd, {
      file_path: `${cwd}/src/features/timing/Timing.tsx`,
      edits: [{ new_string: 'export const Timing = () => null;\n' }],
    }),
  },
  {
    key: 'cursor · subagent-start',
    event: 'SubagentStart', host: 'cursor', family: 'cursor',
    subcommand: 'subagent-start', shim: 'cursor-hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => flat(cwd, { subagent_id: 'hook-timing-child' }),
  },
  {
    key: 'cursor · cursor-subagent-stop',
    event: 'SubagentStop', host: 'cursor', family: 'cursor',
    subcommand: 'cursor-subagent-stop', shim: 'cursor-hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => flat(cwd, {
      parent_conversation_id: 'hook-timing-parent', subagent_id: 'hook-timing-child',
      status: 'completed', loop_count: 0,
    }),
  },
  {
    key: 'cursor · cursor-stop',
    event: 'Stop', host: 'cursor', family: 'cursor',
    subcommand: 'cursor-stop', shim: 'cursor-hook-runtime.cjs',
    project: onboardedMidRun,
    stdin: (cwd) => flat(cwd, { status: 'completed', loop_count: 0 }),
  },
  // ── Windsurf: the one module subscription neither nested nor flat covers ──
  // one-mcp-tool-gate declares `pre_mcp_tool_use`, which only Cascade's event
  // list (gen/sources/hooks.ts's WINDSURF_EVENTS) registers. Its own family,
  // its own wire shape (agent_action_name + tool_info), its own entry.
  {
    key: 'windsurf · pre_mcp_tool_use',
    event: 'PreToolUse', host: 'windsurf', family: 'windsurf',
    subcommand: 'pre_mcp_tool_use', shim: 'windsurf-hook-runtime.cjs',
    project: scaffoldedGreenfield,
    stdin: (cwd) => j({
      agent_action_name: 'pre_mcp_tool_use',
      workspace_root: cwd,
      tool_info: { cwd, mcp_server_name: 'context7', mcp_tool_name: 'resolve-library-id' },
    }),
  },
];

/**
 * Every canonical event, spelled out so the compiler is the thing that notices
 * a new one.
 *
 * A plain `string[]` here would let a future eighth CanonicalEvent ship with no
 * timing row and no failure anywhere — the coverage assertion would simply
 * never ask about it. Keying a Record by the union makes `tsc` refuse the
 * addition until this list grows, which is the only mechanism available that
 * does not depend on someone remembering.
 */
const EVENT_IS_MEASURABLE: Readonly<Record<CanonicalEvent, true>> = {
  SessionStart: true,
  UserPromptSubmit: true,
  PreToolUse: true,
  PostToolUse: true,
  SubagentStart: true,
  SubagentStop: true,
  Stop: true,
};

export const ALL_CANONICAL_EVENTS = Object.keys(EVENT_IS_MEASURABLE) as readonly CanonicalEvent[];

/**
 * The subcommands the module descriptors actually declare, read back through
 * the real registry rather than listed here. This is the denominator the
 * coverage assertion divides by, so it has to come from the same discovery the
 * dispatcher uses: a hand-maintained copy would drift the moment a module
 * gains a subscription, and would drift SILENTLY, since a missing row can only
 * ever make the coverage number look complete.
 *
 * Cursor's subcommands are NOT in here — they are adapter-side names
 * (adapters/cursor.ts's SUB_TO_EVENT), not module subscriptions — so the
 * assertion covers them through the event axis instead.
 */
export function declaredModuleSubcommands(): ReadonlySet<string> {
  const subcommands = new Set<string>();
  for (const handler of collectHandlers(loadModules(defaultModulesDir(), { strict: true }))) {
    for (const subcommand of handler.subcommands ?? []) subcommands.add(subcommand);
  }
  return subcommands;
}

/** Drive one row through the same exported entry the compiled shim's main() calls. */
export async function invoke(row: HookInvocation, stdin: string): Promise<string> {
  if (row.family === 'cursor') return (await runCursorHook(row.subcommand, stdin)).stdout;
  if (row.family === 'windsurf') return (await runWindsurfHook(row.subcommand, stdin)).stdout;
  return (await runClaudeHook(row.subcommand, stdin)).stdout;
}
