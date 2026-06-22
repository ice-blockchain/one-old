// src/core/types.ts
// Canonical engine types shared by core, adapters, shared services, and modules.
// The whole point of this file: feature code speaks ONLY these types and never
// branches on host. Adapters translate each host's raw shape to/from here.

export type HostId = 'claude' | 'codex' | 'cursor';

export type CanonicalEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  // Codex-only: fired when a subagent (worker) thread spawns. Its input carries the
  // child thread id (`agent_id`) — the deterministic hook-time signal Codex provides
  // for binding a Traffic One role claim to the new subagent session.
  | 'SubagentStart';

// Gates match these classes, never raw per-host tool names.
export type ToolClass =
  | 'shell'
  | 'file-write'
  | 'file-edit'
  | 'file-read'
  | 'spawn-agent'
  | 'search'
  | 'other';

export interface ToolInput {
  readonly class: ToolClass;
  readonly rawName: string;
  readonly command?: string;
  readonly workdir?: string;
  readonly filePath?: string;
  readonly content?: string;
}

// The canonical, host-agnostic hook input. `raw` carries the original host
// payload for adapters/diagnostics; feature code should not read it.
export interface HookInput {
  readonly event: CanonicalEvent;
  readonly host: HostId;
  readonly cwd: string;
  // The host's AUTHORITATIVE workspace root, when it declares one (Cursor's
  // `workspace_roots`). Project-root resolution never climbs above it, so a hook
  // touching a path above the opened workspace (or a stray onboarded ancestor)
  // cannot re-root Traffic One to the parent. Unset for hosts with no workspace
  // boundary (Claude/Codex), where cwd may legitimately be a monorepo sub-package.
  readonly workspaceRoot?: string;
  readonly tool?: ToolInput;
  readonly prompt?: string;
  readonly raw: unknown;
}

// Optional extras a result may carry alongside its context/decision:
//   systemMessage — a host "system message" line (legacy `systemMessage`).
//   promptRequest — a host modal/popup-input spec (legacy `promptRequest`);
//     Claude/Codex pass it through; Cursor (no equivalent) drops it.
export interface ResultMeta {
  readonly systemMessage?: string;
  readonly promptRequest?: unknown;
  // Cursor only: on a PreToolUse (beforeShellExecution) deny, emit `permission:"ask"` instead of
  // `"deny"` — a user approve/reject dialog. This is the ONLY hook-driven user prompt Cursor
  // supports (preToolUse-tool "ask" is documented-but-not-enforced). `agentMessage` carries the
  // agent_message branch text. Inert on Claude/Codex (they serialize it as a plain deny).
  readonly askUser?: boolean;
  readonly agentMessage?: string;
}

// The canonical decision. The adapter serialises it to each host's wire shape;
// e.g. a Cursor afterFileEdit (a post-event) downgrades `deny` to a warning.
export type HookResult =
  | { readonly kind: 'noop' }
  | ({ readonly kind: 'context'; readonly context: string } & ResultMeta)
  | ({ readonly kind: 'deny'; readonly reason: string; readonly context?: string } & ResultMeta);

export type MaybeAsync<T> = T | Promise<T>;

// A unified runnable. A PreToolUse gate (which may deny) and a SessionStart /
// UserPromptSubmit / PostToolUse action (context + side-effects) are both
// Handlers — the pipeline treats them uniformly.
export interface Handler {
  readonly id: string;
  readonly event: CanonicalEvent;
  // For PreToolUse: the tool classes this handler applies to. Empty/undefined
  // means "all tools for this event".
  readonly tools?: readonly ToolClass[];
  // The hook subcommand entry point(s) this handler participates in — the
  // host-config invocation names (e.g. 'check-onboarding-gate'). The auth gate
  // participates in all four PreToolUse gate subcommands; most handlers list
  // exactly one. The entry routes an incoming subcommand to the handlers that
  // include it, then runs them through the priority-ordered pipeline (so the
  // priority-0 auth gate runs first, matching the legacy per-gate auth check).
  // Undefined means the handler is not directly hook-invoked by a subcommand.
  readonly subcommands?: readonly string[];
  // Lower runs first; a deny short-circuits the rest.
  readonly priority: number;
  run(ctx: Ctx): MaybeAsync<HookResult>;
}

// ── Module descriptor (authored as module.json; handlers come from code) ──
export interface SkillRef {
  readonly id: string;
  readonly path: string; // relative to the module dir, e.g. "skill/SKILL.md"
  readonly shipped?: boolean; // gathered into skills/ + skills-catalog/ by gen
  readonly bootstrap?: boolean; // an always-present bootstrap skill (traffic-one-doctor)
}

export interface Subscription {
  readonly event: CanonicalEvent;
  readonly subcommand: string; // hook subcommand name (drives generated configs)
  readonly tools?: readonly ToolClass[];
  readonly statusMessage?: string;
}

export interface ModuleDescriptor {
  readonly id: string;
  readonly kind: 'runtime' | 'content';
  // Runtime modules: the file (relative to the module dir, extensionless) that
  // exports `handlers: Handler[]`. Defaults to "index".
  readonly entry?: string;
  readonly skills?: readonly SkillRef[];
  readonly rules?: readonly string[];
  readonly agents?: readonly string[];
  readonly subscriptions?: readonly Subscription[];
}

// ── Service interfaces (implemented in src/shared, wired by buildContext) ──
export interface Logger {
  debug(msg: string): void;
  warn(msg: string): void;
}

export interface FsJson {
  readText(filePath: string): string | null;
  readJson<T = unknown>(filePath: string, fallback: T): T;
  writeJson(filePath: string, value: unknown): void;
}

export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Exec {
  which(bin: string): string | null;
  run(cmd: string, args: readonly string[], opts?: { cwd?: string }): ExecResult;
}

export interface Paths {
  pluginRoot(): string;
  projectRoot(input: HookInput): string;
  stateFile(projectRoot: string): string;
}

// Generalised auth `T1AUTH` bridge: read a directive PROSE block from a module's
// skill/SKILL.md, substitute {{vars}}, fall back to `fallback` if missing.
export type SkillBlockFn = (
  moduleId: string,
  blockName: string,
  vars?: Record<string, string | number | null | undefined>,
  fallback?: string,
) => string;

// The DI root passed to every handler — assembled once per invocation by
// buildContext(). Services are added here (not require()d ad hoc), which is what
// removes the duplicated helpers and the circular "hoisted forwarder" requires.
export interface Ctx {
  readonly input: HookInput;
  readonly host: HostId;
  readonly cwd: string;
  now(): string;
  readonly log: Logger;
  readonly fsjson: FsJson;
  readonly exec: Exec;
  readonly paths: Paths;
  readonly skillBlock: SkillBlockFn;
}
