// src/test-environment/core/env.ts
// Per-case environment. The harness reuses real src/ state functions that read
// process.env (writeState has no env param), so to isolate a case we apply its
// env to process.env around in-process state ops and restore afterwards. With
// the default concurrency of 1 this is safe; raising concurrency requires care.

import * as path from 'path';

import { defaultProjectPrefsPath } from '../../shared/state/local-prefs/prefs-store';
import type { HostId, RootTestConfig } from './types';
import {
  readDistRuntimeProof,
  RUNTIME_PROOF_ENTRY_ENV,
  RUNTIME_PROOF_FILE_ENV,
  RUNTIME_PROOF_TOKEN_ENV,
} from './current-dist';

export interface CaseEnv {
  [key: string]: string;
}

// Build the env block for one case run. `caseFolder` holds the isolated prefs +
// machine state alongside the live project and captured logs.
export function buildCaseEnv(
  config: RootTestConfig,
  caseFolder: string,
  distRoot: string,
  host: HostId | 'pure-node',
): CaseEnv {
  const env: CaseEnv = {
    // Per-case prefs isolation — never writes ~/.traffic-one/projects/<hash>.
    TRAFFIC_ONE_PROJECT_PREFS_PATH: path.join(caseFolder, 'state', 'preferences.json'),
    // Never pop the onboarding HTTP wizard during a headless/seeded run.
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
    // Pin the auth mode even when it is off. Production defaults auth to on
    // when this variable is absent, and the harness must not inherit that
    // default (or an ambient maintainer setting) for isolated cases.
    TRAFFIC_ONE_AUTH: config.auth,
    // Pure-node runs execute inside whichever host launched the maintainer test
    // process. Pin them to Claude so Codex/Cursor ambient markers cannot seed
    // preferences under the wrong host. Host-E2E runs overwrite this below.
    TRAFFIC_ONE_HOST: 'claude',
  };

  // Force runtime scripts to resolve to the freshly built dist tree (e2e only;
  // empty for pure-node, where an empty value is correctly ignored by pluginRoot()).
  if (distRoot) {
    env.TRAFFIC_ONE_PLUGIN_ROOT = distRoot;
    const proof = readDistRuntimeProof(distRoot);
    if (proof && host !== 'pure-node') {
      const entry = proof.entries[host];
      if (entry) {
        env[RUNTIME_PROOF_FILE_ENV] = path.join(caseFolder, 'runtime-proof.json');
        env[RUNTIME_PROOF_TOKEN_ENV] = proof.token;
        env[RUNTIME_PROOF_ENTRY_ENV] = entry;
      }
    }
  }

  // `pytest` and `ruff` are spawned by BARE NAME from the qa-evidence stack
  // runner (runners/qa-evidence/stack.ts), so they are resolved from the check
  // process's PATH — which is this process's, since run-sim calls the runner
  // in-process. macOS ships neither, and its system `python3` is 3.9, too old
  // for the annotations the compiled Python shape emits. The toolchain therefore
  // installs once at the runs root, exactly like the Playwright Chromium, and
  // its `bin` is prepended here so the suite needs no PATH prefix at the command
  // line. A runs root with no venv contributes a directory that does not exist,
  // which PATH resolution skips.
  env.PATH = [
    path.join(config.runsRoot, '.venv', 'bin'),
    process.env.PATH || '',
  ].join(path.delimiter);

  if (config.isolateStateHome) {
    // Redirects ~/.traffic-one (machine settings incl. codeGraphProvider, one-uid)
    // to a per-case dir so global state never bleeds between cases or pollutes
    // the maintainer's real machine.
    env.XDG_STATE_HOME = path.join(caseFolder, 'xdg-state');
    // OpenCode/Kilo user-level wrappers, auth/model caches, logs, and databases
    // must be case-local too. Claude/Codex keep their existing HOME/CODEX_HOME
    // auth paths because these XDG variables do not redirect them on macOS.
    env.XDG_CONFIG_HOME = path.join(caseFolder, 'xdg-config');
    env.XDG_DATA_HOME = path.join(caseFolder, 'xdg-data');
  }

  if (host !== 'pure-node') {
    // Honoured by the host runner subprocesses for model-tier host selection.
    env.TRAFFIC_ONE_HOST = host;
  }

  for (const [k, v] of Object.entries(config.envOverrides)) env[k] = v;

  return env;
}

/**
 * The environment block for ONE MEMBER of a workspace case.
 *
 * THE SEMANTIC COLLAPSE THIS EXISTS TO CLOSE. `buildCaseEnv` pins
 * `TRAFFIC_ONE_PROJECT_PREFS_PATH` to one file per CASE, and `projectPrefsPath`
 * (shared/state/local-prefs/prefs-store.ts) returns that path for EVERY cwd it
 * is asked about. One project per case made that identical to production; N
 * members do not. In production each member root gets its own bucket —
 * `<machine dir>/projects/<sha256(realpath(root))>/preferences.json` — so the
 * consent answer, the host performance/team block and the toolchain stamps of
 * three members are three files. Sharing one file is not a wiring detail: it is
 * a world where the last member seeded silently overwrites the other two, and a
 * harness measuring per-member isolation against it would certify isolation that
 * does not exist.
 *
 * So the path is DERIVED, by production's own `defaultProjectPrefsPath`, from
 * this member's root — not merely made distinct by appending the member id. A
 * hand-rolled distinct path would reproduce the count and not the DERIVATION,
 * and the derivation is the part every production reader re-computes: anything
 * that resolves a bucket from a root rather than from the variable would then
 * disagree with the harness while both looked right.
 *
 * The variable is still SET rather than deleted, and that is load-bearing:
 * `withCaseEnv` restores by key, so a member env that merely OMITTED the
 * variable would inherit whatever an enclosing scope had already applied —
 * silently reinstating the shared file this function exists to remove.
 *
 * `isolateStateHome` off is the one shape where the derivation would name the
 * maintainer's REAL `~/.traffic-one/projects/<hash>`. A case must never write
 * there, so that configuration keeps a case-folder path instead and loses only
 * the bucket spelling — the distinctness, which is what the assertions measure,
 * is preserved either way.
 */
export function memberCaseEnv(
  base: CaseEnv,
  caseFolder: string,
  member: { id: string; root: string },
): CaseEnv {
  const env: CaseEnv = { ...base };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = base.XDG_STATE_HOME
    ? defaultProjectPrefsPath(member.root, env)
    : path.join(caseFolder, 'state', 'members', member.id, 'preferences.json');
  return env;
}

// Temporarily apply `env` to process.env, run `fn`, then restore. Used around
// every in-process call into src/ state functions and around assertions.
export function withCaseEnv<T>(env: CaseEnv, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    saved.set(key, process.env[key]);
    process.env[key] = env[key];
  }
  try {
    return fn();
  } finally {
    for (const [key, prev] of saved) {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
  }
}
