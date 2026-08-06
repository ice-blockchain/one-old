// src/core/types.ts
// Canonical engine types shared by core, adapters, shared services, and modules.
// The whole point of this file: feature code speaks ONLY these types and never
// branches on host. Adapters translate each host's raw shape to/from here.

import type { DenyId } from '../config/deny-ids';

export type HostId = 'claude' | 'codex' | 'cursor' | 'opencode' | 'copilot' | 'windsurf' | 'kilo';

// A deny whose handler declared no `denyId` still gets ONE, so it is
// attributable rather than anonymous — synthesized by the pipeline from the
// handler's own `id` (see core/pipeline.ts). Deliberately NOT a member of
// DenyId: a fallback firing at all is a gap (a call site the completeness
// test should have caught, or a genuinely new gate that has not been given a
// real id yet), and keeping it out of the declared union is what makes that
// gap visible to anything that iterates DENY_IDS instead of silently
// counting toward it.
export type FallbackDenyId = `unattributed-handler:${string}`;

export type CanonicalEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  // Codex-only: fired when a subagent (worker) thread spawns. Its input carries the
  // child thread id (`agent_id`) — the deterministic hook-time signal Codex provides
  // for binding a Traffic One role claim to the new subagent session.
  | 'SubagentStart'
  // Cursor-only lifecycle events. Both may return `followup_message` to enqueue
  // another parent/subagent turn; hosts without these events never invoke them.
  | 'SubagentStop'
  | 'Stop';

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
  // Canonical freeform apply_patch payload. Kept separate from `content` so
  // gates can parse per-file operations instead of treating the whole diff as
  // one file's proposed contents.
  readonly patchText?: string;
}

// The canonical, host-agnostic hook input. `raw` carries the original host
// payload for adapters/diagnostics; feature code should not read it.
export interface HookInput {
  readonly event: CanonicalEvent;
  readonly host: HostId;
  // Adapter-authenticated native hook/wrapper point. This stays distinct from
  // the canonical event because several hosts collapse multiple concrete
  // before/after hooks into PreToolUse/PostToolUse.
  readonly hostHookPoint?: string;
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
//   followupMessage — Cursor stop/subagentStop continuation text. It is emitted
//     only for those two events and ignored by all other event/host serializers.
export interface ResultMeta {
  readonly systemMessage?: string;
  readonly promptRequest?: unknown;
  readonly followupMessage?: string;
  // Cursor only: on a PreToolUse (beforeShellExecution) deny, emit `permission:"ask"` instead of
  // `"deny"` — a user approve/reject dialog. This is the ONLY hook-driven user prompt Cursor
  // supports (preToolUse-tool "ask" is documented-but-not-enforced). `agentMessage` carries the
  // agent_message branch text. Inert on Claude/Codex (they serialize it as a plain deny).
  readonly askUser?: boolean;
  readonly agentMessage?: string;
  // Claude only: replace the tool call's input before it runs (PreToolUse
  // `hookSpecificOutput.updatedInput` — a FULL replacement of tool_input, so it
  // must carry every field, not a patch). Carried on an allow-path context
  // result; every other host/event serializer ignores it.
  readonly updatedToolInput?: Record<string, unknown>;
  // A declared, stable, machine-readable identifier for the distinct REASON
  // this call was refused — never derived from rendered prose. Prose is
  // resolved from SKILL.md at runtime and interpolates paths/counts/ids, so a
  // text key never repeats and an unresolvable block makes every deny render
  // as `''`, collapsing all gates into one bucket; a declared id is the only
  // thing that stays stable across a prose rewrite or a broken skill file. A
  // handler that omits it gets a synthetic FallbackDenyId from the pipeline
  // (see core/pipeline.ts) rather than being left anonymous. Consumers: a
  // later deny budget and decision log key on `(runId, gateId, denyId,
  // denyTarget)`.
  //
  // Deliberately `DenyId` ALONE, not `DenyId | FallbackDenyId`: this is the
  // CALL-SITE contract (what deny()/context() accept), and with the fallback
  // in the union a gate could hand-write `denyId:
  // 'unattributed-handler:whatever'` — a string that compiles, satisfies the
  // completeness test, and is indistinguishable in the log from the
  // pipeline's own synthesized fallback, i.e. it could fake attribution.
  // Only the pipeline may mint that shape; it widens on the way out through
  // StampedDenyMeta below.
  readonly denyId?: DenyId;
  // The handler `id` that produced this deny. Only the pipeline can supply
  // this (a handler does not know its own registration id), so the pipeline
  // stamps it unconditionally on every deny it returns — never set this on a
  // result you construct in a handler.
  readonly gateId?: string;
  // Optional discriminator for WHAT this refusal is about — a file path, an
  // agent id, a role — whatever the gate is refusing about, when there is a
  // single natural one. Deliberately separate from `denyId` (the CAUSE):
  // `denySignature(filePath, violations)` in shared/state/deny-repeat.ts
  // already keys its at-most-once check per-target for a reason, and a
  // budget keyed on `(gateId, denyId)` alone would let a fifth write through
  // to a file the agent does not own once earlier ones on other files used up
  // the same bucket. Left unset where a gate has no single target (e.g. a
  // pure policy/config denial).
  readonly denyTarget?: string;
}

// ResultMeta as it exists on a deny that has LEFT the pipeline: identical in
// every field except that `denyId` may also be the synthetic
// `unattributed-handler:<gateId>` the pipeline mints for a handler that
// declared none (see stampDeny in core/pipeline.ts). Splitting the two is what
// keeps that shape un-writable at a call site while still being a legal value
// on the result a consumer reads.
export type StampedDenyMeta = Omit<ResultMeta, 'denyId'> & {
  readonly denyId?: DenyId | FallbackDenyId;
};

// The canonical decision. The adapter serialises it to each host's wire shape;
// e.g. a Cursor afterFileEdit (a post-event) downgrades `deny` to a warning.
export type HookResult =
  | { readonly kind: 'noop' }
  | ({ readonly kind: 'context'; readonly context: string } & ResultMeta)
  | ({ readonly kind: 'deny'; readonly reason: string; readonly context?: string } & StampedDenyMeta);

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
  // priority-0 auth gate runs first).
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
  /** Whether the write landed. `false` is a refusal (the consent or symlink
   *  fence in shared/fsjson.ts declined the path), never a thrown failure — a
   *  caller whose next step depends on the write having persisted must branch on
   *  this rather than assume it. */
  writeJson(filePath: string, value: unknown): boolean;
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
