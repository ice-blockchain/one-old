// src/test-environment/config/test-config.ts
// Root config for the test environment. Hand-edit defaults here; CLI flags in
// run.ts override per invocation.

import * as os from 'os';
import * as path from 'path';

import type { Category, HostId, RootTestConfig } from '../core/types';
import { HOST_COMMANDS } from './hosts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const ALL_HOSTS: HostId[] = ['claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo'];
const DEFAULT_E2E_HOSTS: HostId[] = ['claude', 'codex', 'cursor'];

export const ALL_CATEGORIES: Category[] = [
  'new-project',
  'project-lifecycle',
  'existing-project',
  'feature-auth',
  'feature-onboarding',
  // Deterministic full-run simulation. MUST be listed here: run.ts filters
  // --category values against this array and silently drops anything missing,
  // which would turn `--category=run-sim` into "run the whole matrix".
  'run-sim',
];

export function defaultConfig(): RootTestConfig {
  return {
    enabledHosts: [...DEFAULT_E2E_HOSTS],
    enabledCategories: [...ALL_CATEGORIES],
    // Fast deterministic default: only the free, fully-deterministic pure-node
    // layer runs. Host-CLI E2E (real LLM spend) is opt-in via --e2e.
    includeHostE2E: false,
    build: { refreshDist: true, updateHosts: true },
    auth: 'off', // explicit harness opt-out; production AUTH_ENABLED defaults to true
    verdictHost: 'none',
    concurrency: 1, // in-process state isolation (withCaseEnv) assumes serial; see README
    // A full senior-team orchestrated build (scaffold + install + build + review)
    // runs long headlessly; 15 min wasn't enough. 30 min default; tune with --timeout.
    defaultTimeoutMs: 1_800_000,
    // Outside the repo on purpose: in-repo project writes no-op at the authoring
    // root. Each run gets its own <runsRoot>/<timestamp>/ folder; all are kept.
    runsRoot: path.join(os.homedir(), 'traffic-one-test-runs'),
    isolateStateHome: true, // per-case XDG_STATE_HOME so the real ~/.traffic-one is never touched
    strict: false,
    dryRun: false,
    hosts: HOST_COMMANDS,
    envOverrides: {},
  };
}

export const REPO_ROOT_PATH = REPO_ROOT;
