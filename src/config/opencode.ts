// src/config/opencode.ts
// OpenCode delegation config.
//
// `delegateRoles` is the configurable set of senior roles that MUST run on
// OpenCode (instead of a paid subagent) WHEN ELIGIBLE — i.e. when
// `openCode.enabled` is true and the current host can use the selected model.
// Users override it per project via
// `openCode.delegateRoles` in local preferences; this is the default.
export const DEFAULT_OPENCODE_DELEGATE_ROLES: readonly string[] = [
  'senior-tester',
  'senior-frontend',
  'quick-fix',
];

// ── Delegation policy: UNIT KINDS, not roles ─────────────────────────────────
// The real delegation axis is the UNIT, not the role (measured: bounded units
// succeed in ~2 min on the free chain; whole-role passes are 0-for-3 lifetime).
// This catalog is the canonical, visible list of what the architect may queue
// (plan.md `opencode-delegate` block) and what an orchestrator may hand to
// `opencode_delegate` ad hoc. Each unit must name 1–2 files and concrete
// acceptance criteria. Prose in the architect/orchestrator docs mirrors this
// list — when they disagree, THIS file wins.
export interface OpenCodeUnitKind {
  readonly id: string;
  readonly summary: string;
  readonly examples: readonly string[];
}

export const OPENCODE_DELEGATE_UNIT_KINDS: readonly OpenCodeUnitKind[] = [
  { id: 'fixtures-seed-data', summary: 'Pure demo/seed/fixture data, no logic, no imports outside the file', examples: ['typed course/catalog fixture objects', 'SQL seed rows (no schema/RLS changes)'] },
  { id: 'pure-helpers', summary: 'Dependency-free pure functions with stated signatures', examples: ['formatting/slug/date helpers', 'small parsing utilities'] },
  { id: 'i18n-catalogs', summary: 'Source-language catalog objects for named namespaces', examples: ['locales/en/common.ts', 'locales/en/nav.ts'] },
  { id: 'i18n-translations-draft', summary: 'DRAFT translations of existing source catalogs to additional locales (reviewer verifies wording)', examples: ['locales/ro/common.ts from en/common.ts'] },
  { id: 'test-scaffolding', summary: 'Test skeletons and simple specs against stated contracts', examples: ['happy-path unit specs', 'SEO metadata route tests'] },
  { id: 'qa-report-sweep', summary: 'Scripted verification producing a report file, no source edits', examples: ['route/console/overflow sweep into .traffic-one/reports/qa/<runId>/', 'curl-level endpoint checks'] },
  { id: 'reviewer-input-sweeps', summary: 'Mechanical audit reports CONSUMED by the paid reviewer (never replaces its judgment)', examples: ['npm audit summary', 'unused-deps/dead-code inventory', 'TODO/FIXME/console.log inventory', 'i18n key-completeness diff', 'SEO meta presence per route'] },
  { id: 'docs-draft', summary: 'Draft documentation from existing facts (verified by architect/reviewer before landing)', examples: ['README sections', 'API docs from public contracts', 'deploy manifests/CI files WITHOUT secrets'] },
  { id: 'storybook-stories', summary: 'Story stubs for existing components', examples: ['one story per shadcn-derived component'] },
  { id: 'mechanical-refactor', summary: 'Codemods, renames, and formatting with exact before/after rules', examples: ['rename a symbol across named files', 'apply a lint autofix class'] },
];

// What must NEVER be delegated to the free tier, regardless of size: the cost
// of a subtle mistake exceeds any token saving, and review burden explodes.
export const OPENCODE_NEVER_DELEGATE: readonly string[] = [
  'architecture and module boundaries',
  'public contracts / API shapes',
  'security, auth, RLS policies',
  'data-model and migrations',
  'cross-file invariants',
  'deploys or anything touching credentials',
  'entire role implementations (whole-role passes are 0-for-3 lifetime; bounded units are ~2 min each)',
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
