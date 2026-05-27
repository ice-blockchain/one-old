'use strict';

// scripts/hook-runtime/state/constants.cjs
// Canonical id sets, alias maps, and staleness windows shared across the state
// module. Public id sets are re-exported from state.cjs.

const path = require('path');

const RUNS_REL_DIR = path.join('.traffic-one', 'runs');

const MOBILE_SOURCE_IDS = new Set(['explicit', 'prompted', 'none']);
const MOBILE_SOURCE_ALIASES = new Map([
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

const TEAM_MODE_IDS = new Set(['subagents', 'main-agent']);
const TEAM_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);

const PERFORMANCE_LEVEL_IDS = new Set(['low', 'balanced', 'high']);
const PERFORMANCE_SOURCE_IDS = new Set(['prompted', 'explicit']);

// OpenCode "token economy" opt-in. Same source vocabulary as team/performance.
const OPEN_CODE_SOURCE_IDS = new Set(['prompted', 'explicit', 'unavailable']);
const TEAM_MODE_ALIASES = new Map([
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
const TEAM_SOURCE_ALIASES = new Map([
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
const KNOWN_ADDONS = new Set([
  'storage', 'auth', 'realtime', 'vector', 'pg_cron', 'pg_net', 'edge_functions',
]);

// Subagent freshness windows.
const SUBAGENT_STALE_MS = 30 * 60 * 1000;
const PENDING_AGENT_CLAIM_STALE_MS = 5 * 60 * 1000;
const VALID_AGENT_ROLES = new Set([
  'senior-architect',
  'senior-frontend',
  'senior-backend',
  'senior-reviewer',
  'senior-tester',
  'senior-shipper',
]);

module.exports = {
  RUNS_REL_DIR,
  MOBILE_SOURCE_IDS,
  MOBILE_SOURCE_ALIASES,
  TEAM_MODE_IDS,
  TEAM_SOURCE_IDS,
  PERFORMANCE_LEVEL_IDS,
  PERFORMANCE_SOURCE_IDS,
  OPEN_CODE_SOURCE_IDS,
  TEAM_MODE_ALIASES,
  TEAM_SOURCE_ALIASES,
  KNOWN_ADDONS,
  SUBAGENT_STALE_MS,
  PENDING_AGENT_CLAIM_STALE_MS,
  VALID_AGENT_ROLES,
};
