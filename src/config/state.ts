// src/config/state.ts
// Canonical id sets, alias maps, and staleness windows for the state machine.
// THE state-vocabulary knobs (known frontends/backends, team/performance/mobile
// vocabularies, freshness windows). The functions that read/validate against this
// data live in src/shared/state/**. PERFORMANCE_LEVEL_IDS is the single source
// (the resolver functions in shared/performance-config.ts read it from here).

import * as path from 'path';

export const RUNS_REL_DIR = path.join('.traffic-one', 'runs');

export const FRONTEND_IDS = new Set(['none', 'react-vite', 'nextjs', 'vue', 'svelte', 'angular', 'astro', 'solid', 'remix', 'other']);
export const BACKEND_IDS = new Set([
  'none', 'supabase', 'external-api', 'node', 'nestjs', 'python', 'django', 'fastapi',
  'go', 'rust', 'java', 'kotlin', 'php', 'laravel', 'dotnet', 'firebase', 'mongo', 'other',
]);
export const MOBILE_FRAMEWORK_IDS = new Set(['ionic-capacitor', 'react-native-expo', 'none']);

export const MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);
export const MOBILE_SOURCE_ALIASES = new Map<string, string>([
  ['asked', 'prompted'],
  ['chat', 'prompted'],
  ['fallback-chat', 'prompted'],
  ['onboarding', 'prompted'],
  ['popup', 'prompted'],
  ['prompt', 'prompted'],
  ['user-onboarding', 'prompted'],
  ['user-prompted', 'prompted'],
  ['disabled', 'none'],
  ['n/a', 'none'],
  ['na', 'none'],
  ['not-applicable', 'none'],
  ['web', 'none'],
  ['web-only', 'none'],
  ['explicit-user-request', 'explicit'],
  ['explicitly-requested', 'explicit'],
  ['requested', 'explicit'],
  ['user-requested', 'explicit'],
]);

export const TEAM_MODE_IDS = new Set(['subagents', 'main-agent']);
export const TEAM_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);

export const PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);
export const PERFORMANCE_SOURCE_IDS = new Set(['prompted', 'explicit']);

// OpenCode "token economy" opt-in. Same source vocabulary as team/performance.
export const OPEN_CODE_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);

// Project lifecycle phase. `building` = initial scaffold in progress; `maintenance`
// = main build complete and the user is iterating (post-build triage applies).
// Existing codebases are `maintenance` from first detection; new projects flip
// once the initial build finishes. Absence of `lifecycle` is valid → inferred from mode.
export const LIFECYCLE_PHASE_IDS = new Set(['building', 'maintenance']);
export const LIFECYCLE_SOURCE_IDS = new Set(['existing-detected', 'orchestrator', 'heuristic', 'manual']);

export const TEAM_MODE_ALIASES = new Map<string, string>([
  ['enabled', 'subagents'],
  ['true', 'subagents'],
  ['yes', 'subagents'],
  ['run-team', 'subagents'],
  ['team', 'subagents'],
  ['traffic-one', 'subagents'],
  ['traffic-one-team', 'subagents'],
  ['subagent', 'subagents'],
  ['subagents-only', 'subagents'],
  ['disabled', 'main-agent'],
  ['false', 'main-agent'],
  ['no', 'main-agent'],
  ['main', 'main-agent'],
  ['main-agent-only', 'main-agent'],
  ['manual', 'main-agent'],
  ['same-thread', 'main-agent'],
]);

export const TEAM_SOURCE_ALIASES = new Map<string, string>([
  ['chat', 'prompted'],
  ['fallback-chat', 'prompted'],
  ['onboarding', 'prompted'],
  ['popup', 'prompted'],
  ['prompt', 'prompted'],
  ['user-onboarding', 'prompted'],
  ['blocked', 'unavailable'],
  ['not-available', 'unavailable'],
  ['runtime-unavailable', 'unavailable'],
  ['explicit-user-request', 'explicit'],
  ['requested', 'explicit'],
  ['user-requested', 'explicit'],
]);

// Supabase add-on approval gate vocabulary. Statuses: "pending" | "approved" | "skipped".
export const KNOWN_ADDONS = new Set([
  'storage', 'auth', 'realtime', 'vector', 'pg_cron', 'pg_net', 'edge_functions',
]);

// Subagent freshness windows.
export const SUBAGENT_STALE_MS = 30 * 60 * 1000;
export const PENDING_AGENT_CLAIM_STALE_MS = 5 * 60 * 1000;

export const VALID_AGENT_ROLES = new Set([
  'senior-architect',
  'senior-frontend',
  'senior-backend',
  'senior-reviewer',
  'senior-tester',
  'senior-shipper',
  // Post-build maintenance worker for trivial tasks (css/copy/rename/config). Not
  // part of the senior roster (AGENT_ROLES); it is recognized here so the spawn
  // gate enforces the cheapest model for it in EVERY mode (not just new-project)
  // and the OpenCode delegation gate can route it free first. Mapped to the
  // `cheapest` tier in config/performance.ts; team.overrides cannot lift the pin.
  'quick-fix',
]);
