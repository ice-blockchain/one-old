// src/config/opencode.ts
// OpenCode delegation config.
//
// `delegateRoles` is the configurable set of senior roles that MUST run on
// OpenCode (instead of a paid subagent) WHEN ELIGIBLE — i.e. when
// `openCode.enabled` is true and the current host can use the selected model.
// Users override it per project via
// `openCode.delegateRoles` in local preferences; this is the default.
export const DEFAULT_OPENCODE_DELEGATE_ROLES: readonly string[] = [
  'senior-shipper',
  'senior-tester',
  'senior-frontend',
  // The maintenance quick-fix worker handles trivial edits — exactly the bounded,
  // low-risk work OpenCode is meant to absorb. When OpenCode is active the
  // spawn gate forces an OpenCode attempt first, then falls back to the cheapest paid model.
  'quick-fix',
];

// Free OpenCode Zen gateway models, in fallback order. These need ZERO user
// setup: with no API key configured, the OpenCode CLI auto-enables its
// `opencode` provider with only the cost-0 models and a public key, so a fresh
// managed install can run them with no account, no sign-in, and no env vars —
// identically on every host (Claude, Cursor, Codex). OpenCode is a local CLI
// invoked the same way everywhere; the model choice is its internal concern.
//
// They are PROMOTIONAL and rotate: the runner walks this chain in order,
// advancing on any server/model-side error (live-verified: the pinned CLI
// reports a retired id only as a generic "Unexpected server error", so the
// runner cannot rely on model-error vocabulary — see shouldTryNextModel in
// runners/opencode). Keep the entries DISTINCT deployments —
// `big-pickle` is deliberately absent because it is an alias of the same
// DeepSeek deployment as `deepseek-v4-flash-free` (verified live 2026-06-09)
// and would be a no-op fallback.
//
// When bumping: verify each id through the PINNED CLI, not just the gateway
// list — the CLI resolves models against its own bundled registry, and a model
// the gateway already serves can still error "Model not found" locally
// (live-verified: qwen3.6-plus-free / minimax-m3-free are on the gateway but
// unknown to CLI 1.15.13). Probe: `opencode run "Reply ok" -m opencode/<id>`.
//
// Per-project override: `openCode.model` in local preferences pins a single
// model and DISABLES the fallback chain (an explicit choice is never silently
// swapped) — e.g. a paid gateway model like `opencode/gpt-5.1-codex`, which
// additionally requires `opencode auth login`. This is a generic escape hatch,
// not a host requirement: the free chain above is the default on all hosts.
export const OPENCODE_FREE_MODELS: readonly string[] = [
  'opencode/deepseek-v4-flash-free',
  'opencode/north-mini-code-free',
  'opencode/nemotron-3-ultra-free',
];
