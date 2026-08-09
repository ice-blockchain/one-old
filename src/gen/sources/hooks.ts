// src/gen/sources/hooks.ts
// THE single source for every hook wiring. Today the matcher token sets live in
// settings.json AND hooks/hooks.json AND (re-encoded) hooks-cursor.json — a
// triple hand-sync. Here they live once: the Claude PreToolUse/PostToolUse
// groups + the Cursor event→subcommand fan-out. The emitter renders every host
// config from this single, golden-verified source.
//
// settings.json and hooks/hooks.json are identical except UserPromptSubmit
// carries a statusMessage in settings.json only — modeled by the `promptStatus`
// parameter.

import { ONE_MCP_MANAGED_TOOLS, ONE_MCP_SERVER_NAME } from '../../config/one-mcp';

// v2 (1.0.44): adds the Stop → onboarding-stop group (appended LAST, so all 15
// v1 positional identities and their trusted hashes are unchanged; the one new
// entry arrives untrusted and Codex prompts once for it).
export const CODEX_HOOK_ABI_VERSION = 2;

function regexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ONE_MCP_CLAUDE_MATCHER = `^mcp__${regexLiteral(ONE_MCP_SERVER_NAME)}__(${ONE_MCP_MANAGED_TOOLS.map(regexLiteral).join('|')})$`;

// Claude/Codex and Windsurf expose different plugin-root environment variables.
// Resolve the same precedence chain inside Node instead of relying on POSIX
// `${VAR:-fallback}` expansion: these command strings must also run under cmd.exe
// and PowerShell. The generated runtime shim is require()d in the launcher
// process so stdin/stdout and async exit-code behavior stay identical to invoking
// `node <runtime> <subcommand>` directly.
export const PLUGIN_ROOT_ENV_KEYS = [
  'TRAFFIC_ONE_PLUGIN_ROOT',
  'CURSOR_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
] as const;

// Cursor replaces this exact literal before handing the command to the host
// shell. It is a host token, not shell parameter expansion, and remains portable
// after Cursor substitutes the installed path.
export const CURSOR_PLUGIN_ROOT_TOKEN = '${CURSOR_PLUGIN_ROOT}';

function portableNodeCommand(
  runtime: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): string {
  const safeToken = /^[A-Za-z0-9_.=-]+$/;
  if (!safeToken.test(runtime) || args.some((arg) => !safeToken.test(arg))) {
    throw new Error('portable hook command received an unsafe runtime or argument');
  }
  const rootKeys = PLUGIN_ROOT_ENV_KEYS.map((key) => `'${key}'`).join(',');
  const envAssignments = Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || !safeToken.test(value)) {
        throw new Error('portable hook command received an unsafe environment override');
      }
      return `e.${key}='${value}';`;
    })
    .join('');
  // NOTE (6co-codex, 2026-07-29): hosts freeze the plugin-root env at app
  // start, so a marketplace sync that replaces the version-keyed cache dir
  // mid-flight leaves this launcher pointing at a deleted path — require()
  // throws and EVERY hook dies silently (fail-open: no onboarding ask, no
  // gates for that session). A newest-sibling-version fallback belongs here,
  // but ANY byte change to this command changes every Codex trusted_hash
  // (see tests/codex-hook-abi.test.ts) and itself triggers the same
  // all-hooks-untrusted outage on update — ship it only as a deliberate
  // CODEX_HOOK_ABI_VERSION bump with the trust-state migration, never as a
  // drive-by edit. Operational remedy meanwhile: restart the host app after
  // a plugin sync before starting a session.
  const launcher = [
    "const p=require('path'),e=process.env;",
    `const r=p.resolve([${rootKeys}].map(k=>e[k]).find(Boolean)||process.cwd());`,
    'e.TRAFFIC_ONE_PLUGIN_ROOT=r;',
    envAssignments,
    "process.argv.splice(1,0,'traffic-one-launcher');",
    `require(p.join(r,'scripts','${runtime}'));`,
  ].join('');
  // The launcher deliberately contains only single-quoted JS strings. Wrapping
  // it in one double-quoted shell argument is portable across sh, cmd.exe, and
  // PowerShell (and avoids every shell-specific variable/env-assignment syntax).
  return `node -e "${launcher}" ${args.join(' ')}`;
}

export function claudeCommand(subcommand: string): string {
  return portableNodeCommand('hook-runtime.cjs', [subcommand]);
}

export function cursorCommand(subcommand: string): string {
  return `node "${CURSOR_PLUGIN_ROOT_TOKEN}/scripts/cursor-hook-runtime.cjs" ${subcommand}`;
}

export function copilotCommand(subcommand: string): string {
  const cmd = `node "./scripts/copilot-hook-runtime.cjs" ${subcommand}`;
  return cmd;
}

export function windsurfCommand(subcommand: string): string {
  return portableNodeCommand(
    'windsurf-hook-runtime.cjs',
    [subcommand, '--host=windsurf'],
    { TRAFFIC_ONE_HOST: 'windsurf' },
  );
}

export interface CopilotHookEntry {
  subcommand: string;
}

// Copilot CLI + VS Code: coarse pre/post hooks (matchers are CLI-only optimization;
// pipeline must be correct when every tool fires these).
export const COPILOT_EVENTS: { event: string; subcommand: string }[] = [
  { event: 'SessionStart', subcommand: 'session-start' },
  { event: 'UserPromptSubmit', subcommand: 'user-prompt-submit' },
  { event: 'PreToolUse', subcommand: 'before-tool-use' },
  { event: 'PostToolUse', subcommand: 'after-tool-use' },
  { event: 'SubagentStart', subcommand: 'subagent-start' },
];

export interface HookEntry { subcommand: string; statusMessage?: string; }
export interface HookGroup { matcher?: string; entries: HookEntry[]; }

export const SESSION_START: HookGroup = {
  entries: [{ subcommand: 'session-start', statusMessage: 'Checking Traffic One auth...' }],
};

// Codex-only SubagentStart: bind the pending Traffic One role claim to the new
// subagent's thread id (`agent_id`) so the child's later tool-call hooks resolve
// their role by exact session match. Not tool-scoped → no matcher (like SessionStart).
// Hosts that do not emit SubagentStart simply never invoke this command.
export const SUBAGENT_START: HookGroup = {
  entries: [{ subcommand: 'subagent-start' }],
};

// Turn-end backstop (Claude + Codex): while onboarding is pending and a live
// wizard exists, the Stop hook blocks the turn end once (stop_hook_active guards
// the loop) and re-delivers the setup link — the last chance to put it in a
// message the user can see. Not tool-scoped → no matcher (Stop takes none on
// Codex). No statusMessage: keep the ABI identity minimal.
export const STOP: HookGroup = {
  entries: [{ subcommand: 'onboarding-stop' }],
};

export function promptSubmitGroup(withStatus: boolean): HookGroup {
  return {
    entries: [{ subcommand: 'user-prompt-submit', ...(withStatus ? { statusMessage: 'Applying traffic-one rules...' } : {}) }],
  };
}

export const PRE_TOOL_USE: HookGroup[] = [
  {
    // Codex SubagentStart is non-blocking. The child's first attempted tool is
    // therefore the universal enforcement point for the model observed in the
    // hook payload. Claude shares this manifest and no-ops the host-specific
    // handler; `.*` is intentional so an uncommon child tool cannot bypass it.
    matcher: '.*',
    entries: [{ subcommand: 'check-codex-child-model', statusMessage: 'Verifying Codex child model policy...' }],
  },
  {
    // The public endpoint is hook-owned. Never let either model-facing tool
    // bypass client-side payload validation or the per-project opt-in gate.
    matcher: ONE_MCP_CLAUDE_MATCHER,
    entries: [{ subcommand: 'check-one-mcp-tool', statusMessage: 'Blocking direct traffic-one-mcp tool call...' }],
  },
  {
    // Includes the subagent-spawn names (Task|Agent for Claude, spawn_agent for
    // Codex) so the onboarding gate blocks subagent spawns on a new project too —
    // not just the agent-model gate. Without Task|Agent, a Claude `Task` spawn
    // skipped the onboarding gate and surfaced onboarding inside the subagent.
    // One group per matcher: hooks sharing a matcher live in one entries list so
    // /hooks lists the matcher once; execution semantics are identical.
    matcher: 'Bash|Write|Edit|MultiEdit|Read|LS|Glob|Grep|exec_command|apply_patch|Task|Agent|spawn_agent|followup_task|send_message|send_input|wait_agent|multi_tool_use',
    entries: [
      { subcommand: 'check-onboarding-gate', statusMessage: 'Checking onboarding gate...' },
      { subcommand: 'check-model-choice-gate', statusMessage: 'Checking model choice gate...' },
    ],
  },
  {
    matcher: 'Task|Agent|spawn_agent',
    entries: [{ subcommand: 'check-agent-model', statusMessage: 'Checking agent model tier...' }],
  },
  {
    matcher: 'Bash|Write|Edit|exec_command|apply_patch',
    entries: [{ subcommand: 'check-plan-write', statusMessage: 'Validating plan gate...' }],
  },
  {
    matcher: 'Bash|exec_command',
    entries: [{ subcommand: 'check-library-allowlist', statusMessage: 'Checking library allowlist...' }],
  },
  {
    matcher: 'Glob|Grep',
    entries: [{ subcommand: 'pre-graphify-hint' }],
  },
];

export const POST_TOOL_USE: HookGroup[] = [
  {
    matcher: 'Bash|exec_command',
    entries: [
      { subcommand: 'post-build-page-speed', statusMessage: 'Checking page-speed gate...' },
      { subcommand: 'post-build-graphify' },
    ],
  },
  {
    // Record the spawned agent id per role (agents.json) so the reuse gate can
    // route the role's next task to the SAME agent instead of a fresh spawn.
    matcher: 'Task|Agent|spawn_agent',
    entries: [{ subcommand: 'post-agent-spawned' }],
  },
  {
    matcher: '.*',
    entries: [{ subcommand: 'post-stack-setup', statusMessage: 'Ensuring project materialization...' }],
  },
];

// Cursor: one entry per canonical host event → subcommand.
export interface CursorHookEvent {
  event: string;
  subcommand: string;
  loopLimit?: number;
  /**
   * Cursor's per-hook-definition `failClosed` (cursor.com/docs/agent/hooks,
   * "Per-Script Configuration Options", read 2026-08-09). Default FALSE: a hook
   * that crashes, times out, prints invalid JSON, or exits anything other than
   * 0 or 2 is a hook FAILURE, and Cursor lets the action through. Set true here
   * and the same failure blocks that one action instead.
   *
   * Only ever `true`, never `false`. The eight events that do not carry it omit
   * the key rather than stating `false`: the two produce identical behaviour, so
   * the only difference is what the manifest CLAIMS, and `failClosed: false` on
   * an event Cursor never blocks reads as a considered trade where there was no
   * trade to make. The calibration below is where that decision lives.
   */
  failClosed?: true;
}

// ── Cursor fail-closed calibration ──────────────────────────────────────────
//
// THE FAILURE THIS GUARDS. Not a gate deciding to allow: a gate that never got
// to decide. cursor-entry.ts catches everything it can reach and still emits a
// deny with a remediation sentence (see hooks/fail-closed.ts), so by the time
// our code runs we are already fail-closed. What it cannot cover is the process
// dying BEFORE that: the launcher NOTE at the top of this file documents the
// real outage — a sync replaces the version-keyed cache dir mid-flight, the
// runtime path no longer resolves, node exits non-zero having written nothing.
// On Claude that surfaces as a blocked tool call. On Cursor, at the default, it
// surfaces as nothing at all: every gate silently off for the rest of the
// session, with no line anywhere saying so.
//
// THE SET, and it is derived rather than chosen. `failClosed: true` is emitted
// on exactly the events whose subcommand adapters/cursor.ts maps to canonical
// PreToolUse — because that is the only canonical event for which its
// serialize() emits `permission: 'deny'`. On every other Cursor event Traffic
// One CANNOT block on success (a deny is downgraded to a warning, or the event
// takes no permission field at all), so asking Cursor to block there on our
// FAILURE would be asking it to enforce something we never enforce. The same
// four subcommands are already isCursorPreToolSubcommand() in
// hooks/fail-closed.ts, which is what cursor-entry.ts fails closed on
// in-process; this closes the identical boundary one layer out, at the host.
// __tests__/cursor-fail-closed.test.ts pins the two sets equal in BOTH
// directions, so neither a quiet downgrade nor a blanket application survives.
//
// THE EVIDENCE IS NOT UNIFORM ACROSS THE FOUR, and the difference is recorded
// per row below. Cursor documents `failClosed` by name on beforeShellExecution,
// beforeMCPExecution and beforeReadFile. It does not mention it on preToolUse.
// The option table it lives in is not event-scoped the way `loop_limit`'s
// entry is ("for stop/subagentStop hooks"), so preToolUse is inside the
// documented schema and outside the documented behaviour: if the flag is inert
// there, that event is exactly where it is today, fail-open. That is a bounded
// downside, which is why it is set anyway.
//
// THE WEDGE, named rather than gestured at. Cursor blocks THE ACTION, not the
// turn and not the session, so a broken runtime produces a stream of denied
// tool calls the agent reports, not a dead window. Two cases, and they differ:
// the documented mid-sync outage is TRANSIENT and self-heals when the host
// restarts onto the new bundle (the restart is already mandatory —
// build/sync-hosts.ts restartLine), while a torn install is DURABLE. Durable is
// the case that decides this, and it decides it toward blocking: Cursor is a
// certified host, `tier` means Traffic One can guarantee enforcement here, and
// a durable silent gap is the one outcome that claim cannot survive. A durable
// block is loud, and loud is what gets an install fixed.
//
// THE ESCAPE HATCH IS THE TERMINAL, not the doctor exemption. Traffic One's
// recovery allowlist (hooks/fail-closed.ts, RECOVERY_RUNNERS) runs INSIDE the
// hook process, so it is unreachable precisely when the process cannot start —
// under host-level failClosed the agent cannot shell out to doctor either. What
// still works is what has always been the documented escape: the user's own
// terminal, where no hook fires at all.
//
// WHAT THIS IS NOT. It is not the node-floor trade resolved the other way (see
// shared/node-floor.ts). That guard warns instead of exiting because an early
// exit emits no stdout, which every host reads as "no verdict" — i.e. it
// chooses warn over an action that would turn gates OFF. This is the opposite
// direction on a different axis: the process is already dead and already
// producing no verdict, and the only question left is what the host does with
// that silence.

export const CURSOR_EVENTS: CursorHookEvent[] = [
  // Documented fire-and-forget: "the agent loop does not wait for or enforce a
  // blocking response", and `continue: false` is accepted by the schema but not
  // honoured. Nothing to fail closed ON. The fail-open cost is real but is not
  // this flag's to fix: a dead runtime drops the injected context (auth banner,
  // pending updates, onboarding notice) with nothing said in the session.
  { event: 'sessionStart', subcommand: 'session-start' },
  // Cursor CAN block here (`continue: false`), but Traffic One never does:
  // adapters/cursor.ts serialize() emits `continue` on no event, and a deny on
  // UserPromptSubmit degrades to a message. failClosed would make a broken
  // runtime block the user from SENDING A PROMPT — the one channel left for
  // asking what is wrong — to enforce a decision we never make.
  { event: 'beforeSubmitPrompt', subcommand: 'user-prompt-submit' },
  // failClosed named explicitly in Cursor's own beforeShellExecution /
  // beforeMCPExecution paragraph. Fail-open cost: every handler subscribed to
  // the `shell` tool class stops guarding — the auth gate, the workspace
  // boundary guard, the onboarding gate, plan-write, and the scaffold, deploy
  // and library allowlist gates. Fail-wedged cost: the agent runs no commands.
  // This is the row whose escape hatch is clearest — the user's own terminal
  // fires no hooks, which is the escape the recovery allowlist in
  // hooks/fail-closed.ts already documents for a wedged run.
  { event: 'beforeShellExecution', subcommand: 'before-shell-execution', failClosed: true },
  // Post-event: the command already ran, serialize() downgrades a deny to a
  // warning. Blocking after the fact enforces nothing and only withholds the
  // result the user is waiting for.
  { event: 'afterShellExecution', subcommand: 'after-shell-execution' },
  // The contested one. failClosed is named explicitly in Cursor's own
  // beforeReadFile paragraph, and this subcommand is ALREADY in
  // isCursorPreToolSubcommand() — cursor-entry.ts denies a malformed read
  // payload in-process today — so leaving the host layer open was an
  // inconsistency rather than a position.
  //
  // The case against is that a read is not a mutation, and a wedge here costs
  // the agent its cheapest and most frequent action. What decides it the other
  // way is what actually rides this event: `before-read-file` is the ONLY
  // Cursor subcommand carrying the file-read tool class (the generic preToolUse
  // path drops file-read to 'other' to avoid double-firing), and the handlers
  // subscribed to it are the auth gate, the onboarding gate and the workspace
  // boundary guard. The last of those is the one that settles it — it is what
  // stops a run in one workspace reading a sibling workspace's files — so
  // fail-open here is a confidentiality gap, not only a policy one.
  { event: 'beforeReadFile', subcommand: 'before-read-file', failClosed: true },
  // Post-event, same as afterShellExecution: the edit is on disk already.
  { event: 'afterFileEdit', subcommand: 'after-file-edit' },
  // Dedicated blocking MCP hook. Cursor currently puts the configured server
  // key in `command` and the bare tool name in `tool_name`. failClosed named
  // explicitly, and Cursor's docs go further here than anywhere else — it is
  // the one event they call it "recommended" on. Fail-open cost: the hook-owned
  // one-mcp endpoint loses its client-side payload validation and its
  // per-project opt-in gate, which cursor-entry.ts blocks before dispatch even
  // reaches the pipeline.
  { event: 'beforeMCPExecution', subcommand: 'before-mcp-execution', failClosed: true },
  // Generic tool hooks (fire for ALL tool types). The cursor adapter derives the
  // tool class from the payload tool_name and excludes classes the fixed events
  // above already own, so no gate double-fires. These close the pre-WRITE deny, the
  // pre-search graphify hint, and the spawn-agent model-tier gate on Cursor.
  //
  // The WEAKEST-EVIDENCE row: preToolUse is the primary blocking point
  // (HOST_CAPABILITIES.cursor) and the only Cursor event carrying the pre-WRITE
  // deny and the spawn-agent tier gate, so fail-open here is the largest gap in
  // the table — but Cursor documents failClosed in its general per-script option
  // table without ever naming this event. Set anyway because the downside is
  // bounded in one direction only: if the flag is honoured the gap closes, and
  // if it is inert this event stays exactly where it is today.
  { event: 'preToolUse', subcommand: 'before-tool-use', failClosed: true },
  { event: 'postToolUse', subcommand: 'after-tool-use' },
  // Cursor accepts a permission decision here, but Traffic One does not make
  // one: this event is the role-claim bind only (see adapters/cursor.ts) and
  // tier gating rides preToolUse(Task) instead, so serialize() never emits a
  // permission for it. Blocking spawns on our failure would enforce a gate that
  // does not live on this event.
  { event: 'subagentStart', subcommand: 'subagent-start' },
  // Cursor consumes `followup_message` only from these lifecycle events. Bound
  // both loops above the longest model tier while still preventing runaway retries.
  // No failClosed: the only thing a failure can cost here is one re-delivered
  // follow-up, while blocking would wedge the end of every turn — the state a
  // session cannot act its way out of.
  { event: 'subagentStop', subcommand: 'cursor-subagent-stop', loopLimit: 8 },
  { event: 'stop', subcommand: 'cursor-stop', loopLimit: 8 },
];

export const WINDSURF_EVENTS: { event: string; subcommand: string }[] = [
  { event: 'pre_user_prompt', subcommand: 'pre_user_prompt' },
  { event: 'pre_read_code', subcommand: 'pre_read_code' },
  { event: 'post_read_code', subcommand: 'post_read_code' },
  { event: 'pre_write_code', subcommand: 'pre_write_code' },
  { event: 'pre_run_command', subcommand: 'pre_run_command' },
  { event: 'pre_mcp_tool_use', subcommand: 'pre_mcp_tool_use' },
  { event: 'post_write_code', subcommand: 'post_write_code' },
  { event: 'post_run_command', subcommand: 'post_run_command' },
  { event: 'post_mcp_tool_use', subcommand: 'post_mcp_tool_use' },
];
