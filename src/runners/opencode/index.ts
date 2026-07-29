// src/runners/opencode/index.ts
// Headless OpenCode delegation runner (compiles to scripts/opencode-runner.cjs).
// The senior-eng-orchestrator calls this to hand a bounded, low-risk coding task
// to the installed OpenCode CLI INSTEAD of spawning a paid Traffic One subagent.
// It runs headless via `opencode run --format json`. By default it walks the
// free `opencode/*` gateway chain, advancing to the next free model when the
// gateway rejects one (the free ids are promotional and rotate) OR when a model
// stalls past the per-attempt timeout (bounded — see maxConsecutiveStalls()).
// When the project pins `openCode.model`, that explicit model is tried alone.
//
// Safety model: the task runs inside a throwaway git WORKTREE (sandbox cut from
// HEAD). Only a clean, error-free, non-empty result is applied back to the real
// working tree; then a handoff digest is written for the reviewer. ANY problem
// (not enabled, not installed, no git HEAD, opencode error/throttle/timeout, no
// changes, or a failed apply) returns ok:false with the main tree untouched, so
// the orchestrator falls back to a normal subagent.
//
// IMPORTANT: `opencode run` exits 0 even on errors (e.g. "Model not found",
// server errors) — failures surface as {"type":"error",...} events in the JSON
// stream. We detect failure by parsing the stream, never by exit code.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { OPENCODE_FREE_MODELS } from '../../config/model-tiers';
import { gatewayBreakerMs, maxConsecutiveStalls, opencodeUnitTimeoutMs } from '../../config/opencode-timeouts';
import { collapsedLineNumber, isCollapseCandidate } from '../../shared/collapsed-source';
import { exec } from '../../shared/exec';
import { spawnTool } from '../../shared/spawn-tool';
import { ensureInitialCommit } from '../../shared/git-init';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { matchesPattern, matchesScope, normalizeRelPath, type AssignedScope } from '../../shared/scope';
import {
  hasFreshArchitectQueueForRun,
  markOpenCodeGatewayOutage,
  markOpenCodePlanRoleCompleted,
  markOpenCodeRoleAttempted,
  openCodeGatewayOutageActive,
  type PlanDelegationUnit,
  parsePlanDelegationUnits,
  recordOpenCodeAttemptOutcome,
} from '../../shared/opencode-roles';
import {
  finalizePlanBatch,
  finalizePlanBatchOnly,
  markPlanBatchRunningIfNeeded,
} from '../../shared/opencode-plan-batch';
import {
  blockedByFailedDependencies,
  buildOpenCodeQueue,
  normalizeOpenCodeRole,
  opencodeAssignmentHash,
  openCodeQueuePolicyReport,
  parseAllowedFiles,
  readOpenCodeUnitStatuses,
  recordOpenCodeUnitStatus,
  reconcileStaleRunningUnits,
  statusFromDelegateAction,
  unsafeAllowedFilePatterns,
  writeOpenCodeQueue,
  type OpenCodeUnitStatus,
} from '../../shared/opencode-queue';
import { roleDigestName } from '../../shared/packing';
import { isMaintenancePhase, readEffectiveState, readRunAssignmentsResilient } from '../../shared/state';
import { nowIso } from '../../shared/text';
import { sha256 } from '../../shared/text';
import {
  ensureRunBootstrap,
  readActiveRunBootstrap,
  type RunBootstrapEnvelopeV2,
} from '../../shared/run-bootstrap-policy';
import { readRunModelPolicy } from '../../shared/run-model-policy';
import { readRunHostCapability } from '../../shared/host-capabilities';
import {
  captureMaintenanceFallbackBaseline,
  fallbackSourcePaths,
  workUnitAllowlistHash,
} from '../../shared/maintenance-fallback';
import { writeJson } from '../../shared/fsjson';
import { isMaintenanceTerminal } from '../../shared/maintenance-terminal';
import { writeRunSettlement } from '../../shared/run-settlement';
import { managedNpmBin, reconcileManagedToolStamp } from '../toolchain';

type Rec = Record<string, unknown>;
const which = exec.which;
const T1_DIR = '.traffic' + '-one';

// Absolute backstop only — NOT the routine bound. Bounded units finish in
// ~2 min; long-but-alive runs keep going while the orchestrator keeps polling,
// and the MCP server's poll-liveness watchdog cancels abandoned runs (parent
// stopped polling) long before this. This ceiling exists for the non-MCP shell
// path and as machine hygiene against a truly hung CLI.
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const DIGEST_HARD_BYTES = 3072;
// The free gateway models are non-deterministic and sometimes "chat" without
// editing. Allow ONE bounded retry (still free) on a clean no-op before falling
// back to a paid subagent — this measurably raises the delegation hit-rate.
const MAX_DELEGATE_ATTEMPTS = 2;
// A stalled model (spawn timeout with no gateway response — observed live as
// `spawnSync … opencode ETIMEDOUT` on the chain head) advances the chain like a
// retired promo id, so one hung free model no longer kills the whole delegation.
// But each stall burns the FULL unit timeout, so maxConsecutiveStalls()
// back-to-back stalls are treated as a gateway/network-wide outage: the walk
// stops AND the run-scoped gateway breaker trips (markOpenCodeGatewayOutage),
// so later units/role shards in the same run fast-fail instead of re-burning
// full-ceiling probes that would only delay the paid fallback the orchestrator has.

// Headless hardening for the spawned CLI (verified against the pinned 1.15.13
// binary, which supports all three env vars): never self-update mid-run, never
// share sessions, don't inject the user's global ~/.claude/CLAUDE.md into the
// delegation context, and pin the two ask-default permissions to a deterministic
// `deny`. `opencode run` already auto-rejects permission asks headlessly on the
// pinned version, but resolveBin() can fall back to an unpinned PATH binary —
// and an allowed `external_directory` would let the model write OUTSIDE the
// throwaway worktree, escaping the diff-capture sandbox entirely. Config layers
// merge key-by-key, so this overrides only these keys, not the user's config.
const OPENCODE_RUN_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_AUTOUPDATE: '1',
  OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    autoupdate: false,
    share: 'disabled',
    permission: { external_directory: 'deny', doom_loop: 'deny' },
  }),
};

// The host that MUST be reachable for any `opencode/*` free-chain model to answer.
const OPENCODE_GATEWAY_HOST = 'api.opencode.ai';
// Preflight ceiling. A reachable gateway answers the TLS/CONNECT handshake in well
// under 100ms (measured 75ms); a DENIED one answers just as fast (proxy 403 /
// connection reset). This only needs to outlast a slow DNS lookup.
const GATEWAY_PROBE_MS = 4000;

/**
 * Fast reachability preflight for the OpenCode gateway.
 *
 * WHY: an egress policy that DENIES the gateway does not make the CLI fail — it
 * makes it HANG, so each model burns the full unit timeout and a delegation
 * costs ~3.5min before falling back to the paid implementer (measured live in
 * cursor 14c: `startedAt 08:50:32 → finishedAt 08:54:05`, two 90s ETIMEDOUTs,
 * `delegated=0`). Cursor 3.12.30 ships exactly such a policy for tool execution
 * (`networkPolicy.default: "deny"` with a 101-domain package-registry allowlist
 * that does not include api.opencode.ai), so on that host EVERY delegation paid
 * the full stall. A ~4s probe turns that into an instant, actionable failure.
 *
 * Must be PROXY-AWARE: a sandbox typically blocks direct DNS and exports
 * HTTPS_PROXY (verified: Cursor exports `HTTPS_PROXY=http://127.0.0.1:<port>`),
 * so a direct socket probe reports ENOTFOUND for allowed and denied hosts alike
 * and would false-positive on a perfectly healthy gateway. Through the proxy the
 * CONNECT status separates them: 200 = allowed, anything else = denied.
 *
 * FAILS OPEN: anything inconclusive (no node, spawn error, unparseable output)
 * returns reachable, so a probe defect can never disable working delegation.
 */
function opencodeGatewayReachable(): { reachable: boolean; detail: string } {
  // Runs in a child because delegate() is synchronous end-to-end (spawnSync).
  const script = `
const net = require('net'), tls = require('tls'), url = require('url'), fs = require('fs');
const host = ${JSON.stringify(OPENCODE_GATEWAY_HOST)}, timeoutMs = ${GATEWAY_PROBE_MS};
const e = process.env;
const noProxy = String(e.NO_PROXY || e.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
const raw = noProxy.includes(host) ? '' : (e.HTTPS_PROXY || e.https_proxy || e.ALL_PROXY || e.all_proxy || '');
// fs.writeSync, NOT process.stdout.write: stdout is a PIPE here, and an async
// write followed immediately by process.exit() truncates — the verdict was lost
// and the caller then failed OPEN, which would silently restore the full stall
// this probe exists to avoid.
function done(msg, code) { try { fs.writeSync(1, msg); } catch {} process.exit(code); }
let proxy = null;
if (raw) { try { const u = new url.URL(raw); if (u.protocol === 'http:' || u.protocol === 'https:') proxy = u; } catch {} }
if (proxy) {
  const s = net.connect(Number(proxy.port || 80), proxy.hostname, () => {
    s.write('CONNECT ' + host + ':443 HTTP/1.1\\r\\nHost: ' + host + ':443\\r\\n\\r\\n');
  });
  let buf = '';
  s.setTimeout(timeoutMs, () => { s.destroy(); done('inconclusive proxy-timeout', 4); });
  s.on('data', (d) => {
    buf += d.toString('utf8');
    if (buf.indexOf('\\r\\n') < 0 && buf.length < 4096) return;
    const line = buf.split('\\r\\n')[0];
    s.destroy();
    if (/\\s2\\d\\d\\s/.test(line + ' ')) done('ok', 0);
    // 407 is "authenticate", not "denied" — we deliberately send no Proxy-Authorization,
    // so it says nothing about the gateway and must not disable delegation.
    if (/\\s407\\s/.test(line + ' ')) done('inconclusive proxy-auth-required', 4);
    done('blocked proxy-status:' + line.trim().slice(0, 120), 3);
  });
  s.on('error', (err) => done('inconclusive proxy-error:' + (err.code || err.message), 4));
  // A proxy that closes without ever answering leaves no verdict; without this the
  // process would exit silently with an empty stdout, which the caller reads as
  // "inconclusive" only by accident. Say so explicitly (and still fail open).
  s.on('close', () => done('inconclusive proxy-closed', 4));
} else {
  const s = tls.connect({ host, port: 443, servername: host }, () => { s.destroy(); done('ok', 0); });
  s.setTimeout(timeoutMs, () => { s.destroy(); done('inconclusive direct-timeout', 4); });
  // No proxy configured: a failure here is NOT proof of an egress policy. A sandbox that
  // blocks direct DNS returns ENOTFOUND for ALLOWLISTED hosts too (verified), and a
  // TLS-intercepting proxy returns a self-signed-cert error while the host is reachable.
  // Both must fail OPEN; only an affirmative proxy CONNECT denial blocks.
  s.on('error', (err) => done('inconclusive direct-error:' + (err.code || err.message), 4));
}
`;
  const r = spawnTool(process.execPath, ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GATEWAY_PROBE_MS + 2000,
  });
  const out = String(r.stdout || '').trim();
  if (r.error || !out || out.startsWith('inconclusive')) {
    return { reachable: true, detail: out || 'probe unavailable' };
  }
  if (out.startsWith('ok')) return { reachable: true, detail: 'ok' };
  return { reachable: false, detail: out };
}

// Actionable remediation for a denied gateway. Names the cause and the exact
// hosts, because the user cannot infer "egress allowlist" from a timeout.
function gatewayUnreachableError(detail: string): string {
  return 'OpenCode gateway ' + OPENCODE_GATEWAY_HOST + ' is UNREACHABLE from this process '
    + `(${detail}) — skipped the free-model walk and fell back to the paid implementer immediately `
    + 'instead of burning the per-model timeout. This is an egress/network policy on the HOST, not an '
    + 'OpenCode or Traffic One fault: sandboxed tool execution (e.g. Cursor\'s `networkPolicy` '
    + '`default: deny` allowlist) blocks it. To restore free delegation, allowlist '
    + `${OPENCODE_GATEWAY_HOST}, opencode.ai and models.dev for tool/terminal execution, or disable the `
    + 'egress sandbox for this workspace. Verify with: curl -sS -o /dev/null -w \'%{http_code}\' '
    + `https://${OPENCODE_GATEWAY_HOST}/`;
}

export interface DelegateOpts {
  role?: string;
  task?: string;
  runId?: string;
  model?: string;
  allowedFiles?: string;
  unitId?: string;
  expectedAssignmentHash?: string | null;
  fallbackAllowed?: boolean;
}

export type FailureKind =
  | 'provider-timeout'
  | 'verification-failed'
  | 'no-changes'
  | 'diff-rejected'
  | 'opencode-error'
  | 'environment'
  | 'skipped';

export interface DelegateResult {
  ok: boolean;
  // delegated = applied to the tree; skipped = precondition not met (fall back);
  // failed/no-changes = opencode could not deliver (fall back).
  action: 'delegated' | 'skipped' | 'failed' | 'no-changes';
  digest: string | null;
  touched: string[];
  error: string | null;
  model?: string;
  failureKind?: FailureKind;
}

function git(cwd: string, args: string[], timeout = 60_000, env?: NodeJS.ProcessEnv): { status: number; stdout: string; stderr: string } {
  const r = spawnTool('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return { status: typeof r.status === 'number' ? r.status : 1, stdout: r.stdout || '', stderr: (r.stderr || '').trim() };
}

// Snapshot the FULL working tree (tracked changes AND untracked files, minus
// .gitignore'd paths) into a throwaway dangling commit, without touching the
// user's index, stash list, or tree. `git stash create` is NOT enough here: it
// snapshots only TRACKED changes, so mid-build (when most new source is not
// yet committed) the sandbox worktree lacked those files entirely — OpenCode
// re-created them from scratch, the patch came back as "new file", plain apply
// collided with the real tree ("already exists in working directory") and the
// --3way fallback died with "does not exist in index" (untracked files have no
// index entry). Building the snapshot through a TEMPORARY index also puts the
// pre-image blobs in the object DB, so --3way has real ancestors when it IS
// needed. Falls back to plain HEAD on any failure (old behavior, still safe:
// worst case is the pre-fix sandbox). Exported for the regression test.
export function snapshotWorkingTree(cwd: string, headSha: string): string {
  // Clean tree (no staged/unstaged/untracked) → HEAD already IS the snapshot.
  const status = git(cwd, ['status', '--porcelain']);
  if (status.status === 0 && !status.stdout.trim()) return headSha;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-idx-'));
  const env: NodeJS.ProcessEnv = {
    GIT_INDEX_FILE: path.join(tmpDir, 'index'),
    // commit-tree needs an ident; don't depend on user.name/email being set.
    GIT_AUTHOR_NAME: 'traffic-one', GIT_AUTHOR_EMAIL: 'traffic-one@localhost',
    GIT_COMMITTER_NAME: 'traffic-one', GIT_COMMITTER_EMAIL: 'traffic-one@localhost',
  };
  try {
    if (git(cwd, ['read-tree', headSha], 60_000, env).status !== 0) return headSha;
    if (git(cwd, ['add', '-A'], 120_000, env).status !== 0) return headSha;
    const tree = git(cwd, ['write-tree'], 60_000, env);
    if (tree.status !== 0 || !tree.stdout.trim()) return headSha;
    const commit = git(cwd, ['commit-tree', tree.stdout.trim(), '-p', headSha, '-m', 'traffic-one opencode delegation snapshot'], 60_000, env);
    if (commit.status !== 0 || !commit.stdout.trim()) return headSha;
    return commit.stdout.trim();
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}


// Pathspecs for staging the worktree diff: install artifacts must never ride a
// delegated diff (observed live: a free-model unit ran `npm install` in the
// sandbox and its diff carried a package-local node_modules/ plus a
// package-lock.json into a pnpm workspace). node_modules is always excluded; all
// lockfiles are excluded because OpenCode is not trusted to mutate dependency
// state. Exported for tests.
export function stageExcludePathspecs(wt: string): string[] {
  const excludes = [
    ':(exclude,glob)**/node_modules/**',
    ':(exclude)node_modules',
    // Build/cache/test-output artifacts are never legitimate delegated source.
    // A model may run installs/builds/tests inside the throwaway worktree; those
    // outputs must not ride the patch back to the real project.
    ':(exclude,glob)**/dist/**',
    ':(exclude,glob)dist/**',
    ':(exclude)dist',
    ':(exclude,glob)**/build/**',
    ':(exclude,glob)build/**',
    ':(exclude)build',
    ':(exclude,glob)**/.turbo/**',
    ':(exclude,glob).turbo/**',
    ':(exclude).turbo',
    ':(exclude,glob)**/.next/**',
    ':(exclude,glob).next/**',
    ':(exclude).next',
    ':(exclude,glob)**/.vite/**',
    ':(exclude,glob).vite/**',
    ':(exclude).vite',
    ':(exclude,glob)**/.cache/**',
    ':(exclude,glob).cache/**',
    ':(exclude).cache',
    ':(exclude,glob)**/coverage/**',
    ':(exclude,glob)coverage/**',
    ':(exclude)coverage',
    ':(exclude,glob)**/playwright-report/**',
    ':(exclude,glob)playwright-report/**',
    ':(exclude)playwright-report',
    ':(exclude,glob)**/test-results/**',
    ':(exclude,glob)test-results/**',
    ':(exclude)test-results',
    ':(exclude,glob)**/*.tsbuildinfo',
    ':(exclude,glob)*.tsbuildinfo',
  ];
  // ALL lockfiles are excluded unconditionally regardless of package manager — OpenCode
  // is never trusted to mutate dependency state, so a regenerated lockfile must never
  // ride a delegated diff back into the real project.
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']) {
    excludes.push(`:(exclude,glob)**/${lock}`, `:(exclude)${lock}`);
  }
  return excludes;
}

type VerifyCommand = {
  label: string;
  command: string;
  args: string[];
  cwd: string;
};

function readJsonObject(file: string): Rec | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Rec : null;
  } catch {
    return null;
  }
}

function parseCommandLine(value: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const ch of value.trim()) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    if (';&|<>'.includes(ch)) return [];
    cur += ch;
  }
  if (escaped || quote) return [];
  if (cur) tokens.push(cur);
  return tokens;
}

function rootPackageManager(cwd: string): string {
  const pkg = readJsonObject(path.join(cwd, 'package.json'));
  const raw = typeof pkg?.packageManager === 'string' ? pkg.packageManager : '';
  const pm = raw.split('@')[0];
  return pm === 'pnpm' || pm === 'yarn' || pm === 'bun' || pm === 'npm' ? pm : 'npm';
}

function scriptArgs(pm: string, script: string): string[] {
  if (pm === 'npm') return ['run', script];
  if (pm === 'bun') return ['run', script];
  return [script];
}

function packageScriptCommand(cwd: string, packageDir: string, pkg: Rec, pm: string): VerifyCommand | null {
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : null;
  if (typeof scripts?.typecheck !== 'string') return null;
  const name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : '';
  if (pm === 'pnpm' && name && packageDir !== cwd) {
    return {
      label: `pnpm --filter ${name} typecheck`,
      command: 'pnpm',
      args: ['--filter', name, 'typecheck'],
      cwd,
    };
  }
  return {
    label: `${pm} ${scriptArgs(pm, 'typecheck').join(' ')}${packageDir === cwd ? '' : ` (${path.relative(cwd, packageDir)})`}`,
    command: pm,
    args: scriptArgs(pm, 'typecheck'),
    cwd: packageDir,
  };
}

function findNearestPackageDirs(cwd: string, touched: string[]): string[] {
  const root = path.resolve(cwd);
  const dirs: string[] = [];
  for (const rel of touched) {
    let dir = path.dirname(path.resolve(cwd, rel));
    while (dir.startsWith(root)) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        if (!dirs.includes(dir)) dirs.push(dir);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  return dirs;
}

function findNearestTsconfigFiles(cwd: string, touched: string[]): string[] {
  const root = path.resolve(cwd);
  const files: string[] = [];
  for (const rel of touched) {
    let dir = path.dirname(path.resolve(cwd, rel));
    while (dir.startsWith(root)) {
      const typecheck = path.join(dir, 'tsconfig.typecheck.json');
      const standard = path.join(dir, 'tsconfig.json');
      const file = fs.existsSync(typecheck) ? typecheck : (fs.existsSync(standard) ? standard : '');
      if (file) {
        if (!files.includes(file)) files.push(file);
        break;
      }
      if (dir === root) break;
      dir = path.dirname(dir);
    }
  }
  return files;
}

function verificationCommands(cwd: string, tsTouched: string[]): VerifyCommand[] {
  const commands: VerifyCommand[] = [];
  const state = readEffectiveState(cwd) as Rec;
  const openCode = state.openCode && typeof state.openCode === 'object' ? state.openCode as Rec : null;
  const configured = typeof openCode?.verifyCommand === 'string' ? openCode.verifyCommand.trim() : '';
  if (configured) {
    const argv = parseCommandLine(configured);
    if (argv.length > 0) {
      commands.push({ label: 'openCode.verifyCommand', command: argv[0] as string, args: argv.slice(1), cwd });
    }
  }

  const pm = rootPackageManager(cwd);
  for (const dir of findNearestPackageDirs(cwd, tsTouched)) {
    const pkg = readJsonObject(path.join(dir, 'package.json'));
    if (!pkg) continue;
    const command = packageScriptCommand(cwd, dir, pkg, pm);
    if (command) commands.push(command);
  }

  const rootPkg = readJsonObject(path.join(cwd, 'package.json'));
  const rootCommand = rootPkg ? packageScriptCommand(cwd, cwd, rootPkg, pm) : null;
  if (rootCommand && !commands.some((c) => c.label === rootCommand.label && c.cwd === rootCommand.cwd)) {
    commands.push(rootCommand);
  }

  const tsc = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
  if (fs.existsSync(tsc)) {
    for (const config of findNearestTsconfigFiles(cwd, tsTouched).slice(0, 3)) {
      commands.push({
        label: `tsc -p ${path.relative(cwd, config) || '.'}`,
        command: tsc,
        args: ['--noEmit', '-p', config],
        cwd,
      });
    }
  }

  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = `${command.cwd}\0${command.command}\0${command.args.join('\0')}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function outputMentionsTouched(out: string, cwd: string, tsTouched: string[]): boolean {
  const normalized = out.replace(/\\/g, '/');
  return tsTouched.some((f) => {
    const rel = f.replace(/\\/g, '/');
    const abs = path.resolve(cwd, f).replace(/\\/g, '/');
    return normalized.includes(rel) || normalized.includes(abs) || normalized.includes(path.basename(f));
  });
}

// Best-effort post-apply verification: a delegated diff that APPLIED but broke
// the build is worse than a declined unit (the paid roles inherit silent
// breakage). Prefer the project's own verification contract: configured
// `openCode.verifyCommand`, nearest package/root `typecheck` scripts, then a
// tsconfig fallback. Pre-existing breakage elsewhere, missing tooling, and
// verifier crashes/timeouts all SKIP verification; absence of verification is
// the status quo, never a reason to reject good work. Exported for tests.
export function postApplyTypecheck(cwd: string, touched: string[]): string | null {
  const tsTouched = touched.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f) && !/\.d\.ts$/.test(f));
  if (tsTouched.length === 0) return null;
  for (const command of verificationCommands(cwd, tsTouched)) {
    const r = spawnTool(command.command, command.args, { cwd: command.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
    if (r.status === 0) return null;
    if (r.error || r.status === null) continue;
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    if (!outputMentionsTouched(out, cwd, tsTouched)) continue; // pre-existing breakage elsewhere — not this unit's fault
    const firstLines = out.trim().split('\n').filter(Boolean).slice(0, 4).join(' | ').slice(0, 400);
    return `${command.label}: ${firstLines}`;
  }
  return null;
}

/**
 * Quality twin of postApplyTypecheck: reject a delegated unit whose landed
 * source is collapsed onto one line. OpenCode writes by applying a git diff, so
 * its output never passes through the structural write gate — observed 7co, the
 * free model returned a `CourseCard.tsx` packing four JSX elements per line,
 * `DELEGATED_OK` was recorded, and the paid frontend then integrated against it.
 * Typecheck alone cannot see this (collapsed code compiles), and the owning
 * role's completion gate only runs much later, at its digest.
 *
 * Returns an error string so the caller rolls the apply back exactly the way a
 * failed typecheck does and falls back to the paid implementer with a clean tree.
 */
export function postApplyQuality(cwd: string, touched: string[]): string | null {
  for (const rel of touched) {
    if (!isCollapseCandidate(rel)) continue;
    let text: string;
    try {
      text = fs.readFileSync(path.join(cwd, rel), 'utf8');
    } catch {
      continue; // deleted or unreadable — not this check's concern
    }
    const line = collapsedLineNumber(rel, text);
    if (line !== null) {
      return `${rel}:${line} packs an entire function/component onto one line`;
    }
  }
  return null;
}

function classifyFailureKind(action: DelegateResult['action'], error: string | null): FailureKind | undefined {
  if (action === 'delegated') return undefined;
  if (action === 'skipped') return 'skipped';
  if (action === 'no-changes') return 'no-changes';
  const msg = error || '';
  if (/\bETIMEDOUT\b|timed out|stalled/i.test(msg)) return 'provider-timeout';
  if (/typecheck failed/i.test(msg)) return 'verification-failed';
  if (/outside|apply|delegated diff|assignment scope|generated\/internal/i.test(msg)) return 'diff-rejected';
  if (/opencode/i.test(msg)) return 'opencode-error';
  return 'environment';
}

function bootstrapRole(role: string): string {
  if (role.startsWith('senior-') || role === 'quick-fix') return role;
  if (role === 'frontend') return 'senior-frontend';
  if (role === 'backend') return 'senior-backend';
  if (role === 'tester') return 'senior-tester';
  if (role === 'docs') return 'senior-architect';
  return role;
}

interface MaintenanceContractPreflight {
  required: boolean;
  bootstrap: RunBootstrapEnvelopeV2 | null;
  error: string | null;
}

function exactMaintenancePaths(value: unknown): string[] | null {
  const parsed = parseAllowedFiles(value);
  if (parsed.length === 0) return null;
  const exact: string[] = [];
  for (const entry of parsed) {
    const normalized = entry.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
    if (!normalized
      || normalized.startsWith('/')
      || normalized === '.'
      || normalized.split('/').includes('..')
      || normalized.includes('\0')
      || /[*?[\]{}]/.test(normalized)
      || normalized === '.traffic-one'
      || normalized.startsWith('.traffic-one/')) return null;
    exact.push(normalized);
  }
  return [...new Set(exact)].sort();
}

function maintenanceContractPreflight(
  cwd: string,
  state: Rec,
  runId: string,
  roleInput: string,
  allowedFiles: unknown,
): MaintenanceContractPreflight {
  if (!runId || !isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined)) {
    return { required: false, bootstrap: null, error: null };
  }
  const role = bootstrapRole(roleInput);
  const existing = readActiveRunBootstrap(cwd, runId, role);
  const requested = exactMaintenancePaths(allowedFiles);
  if (!requested) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance delegation requires a nonempty exact-file allowlist; globs and directories cannot authorize a paid fallback.',
    };
  }
  if (existing) {
    const activeSources = fallbackSourcePaths(existing);
    if (activeSources && JSON.stringify(activeSources) === JSON.stringify(requested)) {
      return { required: true, bootstrap: existing, error: null };
    }
  }
  const boundedRole = ['quick-fix', 'senior-frontend', 'senior-backend'].includes(role);
  if (!boundedRole) {
    return {
      required: true,
      bootstrap: null,
      error: `OpenCode maintenance delegation for ${role} has no exact active WorkUnit and this role cannot mint an ad-hoc bounded fallback contract.`,
    };
  }
  const policy = readRunModelPolicy(cwd, runId);
  if (!policy || !policy.roles[role]) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance delegation has no immutable parent model policy for this role.',
    };
  }
  const capability = readRunHostCapability(cwd, runId, policy.host);
  const bootstrap = ensureRunBootstrap(cwd, runId, role, state, {
    host: policy.host,
    hostAgentType: capability?.typedSubagents ? role : null,
    evidenceSource: 'opencode-maintenance-preflight',
    modelPolicyId: policy.policyId,
    boundedOutputs: requested,
    boundedAllowlist: requested,
    boundedAllowlistExclude: [],
  });
  const sources = bootstrap ? fallbackSourcePaths(bootstrap) : null;
  if (!bootstrap || !sources || JSON.stringify(sources) !== JSON.stringify(requested)) {
    return {
      required: true,
      bootstrap: null,
      error: 'OpenCode maintenance preflight could not publish the exact bounded WorkUnit before delegation.',
    };
  }
  return { required: true, bootstrap, error: null };
}

function recordMaintenanceDelegationOutcome(
  cwd: string,
  state: Rec,
  runId: string,
  role: string,
  result: DelegateResult,
  startedAt: number,
  fallbackAllowed: boolean,
  publishedBootstrap?: RunBootstrapEnvelopeV2 | null,
): void {
  if (!runId || !isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined)) return;
  try {
    const file = path.join(cwd, T1_DIR, 'runs', runId, 'maintenance.json');
    const canonicalRole = bootstrapRole(role);
    const bootstrap = publishedBootstrap === undefined
      ? readActiveRunBootstrap(cwd, runId, canonicalRole)
      : publishedBootstrap;
    const boundContract = Boolean(bootstrap);
    const workUnitContractHash = bootstrap?.workUnit.contractHash;
    const allowlistHash = bootstrap ? workUnitAllowlistHash(bootstrap) : undefined;
    const fallbackSourceBaseline = bootstrap && result.ok !== true && fallbackAllowed
      ? captureMaintenanceFallbackBaseline(cwd, bootstrap)
      : null;
    const fallbackBound = boundContract && Boolean(fallbackSourceBaseline);
    const opencodeOutcome = result.ok ? 'success' : (result.action === 'skipped' ? 'skipped' : 'failed');
    const overallOutcome = !boundContract
      ? 'failed'
      : result.ok
      ? 'code-delivered'
      : fallbackAllowed && fallbackBound
        ? 'fallback-pending'
        : 'failed';
    const terminalOutcome = isMaintenanceTerminal({ overallOutcome });
    writeJson(file, {
      version: 1,
      kind: 'opencode-delegation',
      role: canonicalRole,
      outcome: opencodeOutcome,
      opencodeOutcome,
      overallOutcome,
      fallbackAllowed: fallbackBound && result.ok !== true && fallbackAllowed,
      ...(workUnitContractHash ? { workUnitContractHash } : {}),
      ...(allowlistHash ? { allowlistHash } : {}),
      ...(fallbackSourceBaseline ? { fallbackSourceBaseline } : {}),
      action: result.action,
      failureKind: result.failureKind ?? null,
      model: result.model ?? null,
      error: !boundContract
        ? 'OpenCode maintenance delegation has no valid parent-published WorkUnitContract; fallback is forbidden.'
        : result.ok !== true && fallbackAllowed && !fallbackSourceBaseline
          ? 'OpenCode maintenance fallback source pre-image could not be captured completely; fallback is forbidden.'
        : result.error
          ? String(result.error).slice(0, 500)
          : null,
      touched: result.touched,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
    });
    writeRunSettlement(cwd, runId, !boundContract
      ? {
          status: 'failed',
          reason: 'OpenCode maintenance delegation has no valid parent-published WorkUnitContract',
        }
      : result.ok
      ? {
          status: 'code-delivered',
          workUnitContractHash: workUnitContractHash!,
          allowlistHash: allowlistHash!,
          incompleteChecks: ['verification-not-started'],
        }
      : !terminalOutcome
        ? {
            status: 'active',
            reason: 'fallback-pending',
            workUnitContractHash: workUnitContractHash!,
            allowlistHash: allowlistHash!,
            fallback: {
              state: 'pending',
              workUnitContractHash: workUnitContractHash!,
              allowlistHash: allowlistHash!,
            },
            incompleteChecks: ['fallback-pending'],
          }
        : {
            status: 'failed',
            reason: result.error || 'OpenCode delegation failed and fallback is not allowed',
            workUnitContractHash: workUnitContractHash!,
            allowlistHash: allowlistHash!,
          });
  } catch {
    // best-effort diagnostics; never change delegation behavior
  }
}

function resolveBin(): string | null {
  const managed = managedNpmBin('opencode', 'opencode');
  if (fs.existsSync(managed)) return managed;
  return which('opencode');
}

// The free-model chain is walked per delegation; remember (for this process —
// the MCP server is long-lived, and --from-plan loops units in one process) how
// far we got, so a retired promo model is not re-tried on every single unit.
// Never persisted: a plugin update with a fresh chain resets it naturally.
let freeChainStart = 0;

// Test-only: the memo is module-level process state, so in-process tests must
// reset it between cases to stay order-independent.
export function resetOpenCodeModelMemo(): void {
  freeChainStart = 0;
}

// Model resolution. An EXPLICIT model (opts.model or openCode.model in local
// preferences) is the user's choice: it is tried alone, with NO fallback — we
// never silently swap a model someone pinned. Only the default free chain
// falls back, advancing on model-class errors.
function resolveModels(state: Rec, opts: DelegateOpts): { models: string[]; fromChain: boolean } {
  if (opts.model) return { models: [opts.model], fromChain: false };
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode && typeof openCode.model === 'string' && openCode.model) {
    return { models: [openCode.model], fromChain: false };
  }
  const start = Math.min(freeChainStart, OPENCODE_FREE_MODELS.length - 1);
  return { models: OPENCODE_FREE_MODELS.slice(start), fromChain: true };
}

// `opencode run` emits NDJSON. Pull out error events + the assistant text.
// Non-JSON lines (e.g. a first-run DB-migration banner) are ignored. The error
// name AND message are both kept: classification needs the raw class name
// (e.g. "ProviderModelNotFoundError") when the message is empty.
function parseStream(stdout: string): { errored: boolean; errName: string; errorMsg: string; summary: string } {
  let errored = false;
  let errName = '';
  let errorMsg = '';
  const texts: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj: Rec;
    try { obj = JSON.parse(line) as Rec; } catch { continue; }
    if (obj.type === 'error') {
      errored = true;
      const err = obj.error && typeof obj.error === 'object' ? (obj.error as Rec) : {};
      const data = err.data && typeof err.data === 'object' ? (err.data as Rec) : {};
      if (typeof data.message === 'string' && data.message) errorMsg = data.message;
      if (typeof err.name === 'string' && err.name) errName = err.name;
    }
    if (obj.type === 'text') {
      const part = obj.part && typeof obj.part === 'object' ? (obj.part as Rec) : {};
      const txt = typeof part.text === 'string' ? part.text : (typeof obj.text === 'string' ? obj.text : '');
      if (txt) texts.push(txt);
    }
  }
  return { errored, errName, errorMsg, summary: texts.join(' ').replace(/\s+/g, ' ').trim() };
}

// Decide whether the NEXT free model in the chain should be tried after an
// opencode-reported error. LIVE-VERIFIED on the pinned 1.15.13: a RETIRED or
// unknown gateway model is reported as a generic "Unexpected server error.
// Check server logs for details." — no model name, no "not found", no 401 in
// the message — so a positive match on model-error vocabulary would miss the
// exact case the chain exists for (promo rotation). Inverted policy instead:
// advance on EVERY server/model-side error, and fail fast ONLY on clearly
// environmental failures (DNS, refused/reset connections, TLS, proxy, offline)
// where a different model cannot possibly help. The asymmetry is deliberate:
// a false advance costs at most two fast-failing extra runs before the paid
// fallback; a false fail-fast kills delegation until the next plugin update.
const ENVIRONMENTAL_ERROR_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket|TLS|certificate|proxy|offline/i;
function shouldTryNextModel(errName: string, errorMsg: string): boolean {
  return !ENVIRONMENTAL_ERROR_RE.test(`${errName}: ${errorMsg}`);
}

function runStamp(): string {
  // Matches the orchestrator's run-id shape (YYYY-MM-DDTHH-MM-SSZ); only used
  // when the caller doesn't pass --run-id (standalone/tests).
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

function writeDigest(cwd: string, runId: string, role: string, model: string, touched: string[], summary: string, opts?: { planUnit?: boolean }): string {
  const dir = path.join(cwd, '.traffic-one', 'digests', runId);
  fs.mkdirSync(dir, { recursive: true });
  const touchedLines = touched.slice(0, 20).map((f) => `- ${f}        # delegated edit`).join('\n')
    + (touched.length > 20 ? `\n- … +${touched.length - 20} more` : '');
  // The runner cannot honestly claim a role's canonical verdict (TESTS_GREEN /
  // IMPLEMENTED) — it applied a diff, it did not verify anything. Delegated
  // digests therefore carry DELEGATED_OK plus an explicit normalization hint,
  // so the orchestrator does the one-line verdict edit itself after ITS
  // verification passes (observed live: without the hint it spawned a whole
  // paid agent just to rewrite this line).
  const canonical = roleDigestName(role) === 'tester' ? 'TESTS_GREEN' : 'IMPLEMENTED';
  const digestRole = opts?.planUnit ? `opencode-${roleDigestName(role)}` : roleDigestName(role);
  const body = [
    `# ${role} digest — run ${runId}`,
    '',
    'verdict: DELEGATED_OK',
    `normalize_to: ${canonical} — once the orchestrator's own verification passes, edit the verdict line above to this canonical token (one-line edit; do NOT spawn an agent for it)`,
    `finished_at: ${nowIso()}`,
    `delegated_to: opencode (${model})`,
    '',
    '## Touched',
    touchedLines || '- (none)',
    '',
    '## Summary',
    (summary || 'OpenCode applied the delegated change.').slice(0, 400),
    '',
    '## Open questions / blockers / assumptions',
    '- Changes produced by OpenCode (free model). Reviewer MUST verify the diff before commit.',
    '',
  ].join('\n');
  // Same filename rule as every other digest writer/reader (senior-frontend →
  // frontend.md): successor roles and the build-complete verification heuristic
  // look for the stripped name, so the full role string would hide the digest.
  const p = path.join(dir, `${digestRole}.md`);
  fs.writeFileSync(p, body.slice(0, DIGEST_HARD_BYTES), 'utf8');
  return p;
}

function removeWorktree(cwd: string, parent: string, wt: string): void {
  try { git(cwd, ['worktree', 'remove', '--force', wt]); } catch { /* best-effort */ }
  try { fs.rmSync(parent, { recursive: true, force: true }); } catch { /* best-effort */ }
}

type ApplyTargetBackup = {
  rel: string;
  abs: string;
  existed: boolean;
  backupPath?: string;
  createdParentDirs: string[];
};

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseNulPaths(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean);
}

function parseNameStatusZ(stdout: string): string[] {
  const fields = parseNulPaths(stdout);
  const paths: string[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!status) continue;
    const first = fields[i++];
    if (first) paths.push(first);
    if (/^[RC]/.test(status)) {
      const second = fields[i++];
      if (second) paths.push(second);
    }
  }
  return uniquePaths(paths);
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function isInsideRoot(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + path.sep);
}

function resolveRepoPath(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  return abs !== root && isInsideRoot(root, abs) ? abs : null;
}

function pathExists(abs: string): boolean {
  try {
    fs.lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function copyPath(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(src), dst);
    return;
  }
  if (stat.isDirectory()) {
    fs.cpSync(src, dst, { recursive: true, force: true });
    return;
  }
  fs.copyFileSync(src, dst);
}

function backupApplyTargets(cwd: string, targetPaths: string[], parent: string): ApplyTargetBackup[] {
  const root = path.resolve(cwd);
  const backupRoot = path.join(parent, 'pre-apply-backup');
  const backups: ApplyTargetBackup[] = [];
  for (const rel of uniquePaths(targetPaths)) {
    const abs = resolveRepoPath(root, rel);
    if (!abs) throw new Error(`unsafe patch path: ${rel}`);

    const createdParentDirs: string[] = [];
    if (!pathExists(abs)) {
      for (let cur = path.dirname(abs); cur !== root && isInsideRoot(root, cur) && !pathExists(cur); cur = path.dirname(cur)) {
        createdParentDirs.push(cur);
      }
      backups.push({ rel, abs, existed: false, createdParentDirs });
      continue;
    }

    const backupPath = path.join(backupRoot, String(backups.length));
    copyPath(abs, backupPath);
    backups.push({ rel, abs, existed: true, backupPath, createdParentDirs });
  }
  return backups;
}

function restoreApplyTargets(backups: ApplyTargetBackup[]): string | null {
  const errors: string[] = [];
  for (const backup of backups) {
    try {
      fs.rmSync(backup.abs, { recursive: true, force: true });
      if (backup.existed && backup.backupPath) {
        copyPath(backup.backupPath, backup.abs);
      } else {
        for (const dir of backup.createdParentDirs) {
          try { fs.rmdirSync(dir); } catch { /* non-empty or already gone */ }
        }
      }
    } catch (err) {
      errors.push(`${backup.rel}: ${formatError(err)}`);
    }
  }
  return errors.length ? errors.join('; ') : null;
}

interface DelegatedDiffPolicy {
  cwd: string;
  role: string;
  runId: string;
  allowedPatterns: string[];
  assignmentScopes: AssignedScope[];
  assignmentRequired: boolean;
  expectedAssignmentHash: string | null;
}

const GENERATED_DIFF_PATTERNS = [
  '**/node_modules/**',
  'node_modules/**',
  '**/dist/**',
  'dist/**',
  '**/build/**',
  'build/**',
  '**/.turbo/**',
  '.turbo/**',
  '**/.next/**',
  '.next/**',
  '**/.vite/**',
  '.vite/**',
  '**/.cache/**',
  '.cache/**',
  '**/coverage/**',
  'coverage/**',
  '**/playwright-report/**',
  'playwright-report/**',
  '**/test-results/**',
  'test-results/**',
  '**/*.tsbuildinfo',
  '*.tsbuildinfo',
  '.traffic-one/**',
];

function roleNeedsAssignment(role: string): boolean {
  const normalized = normalizePlanRole(role);
  return normalized === 'frontend' || normalized === 'backend';
}

function buildDelegatedDiffPolicy(cwd: string, runId: string, role: string, allowedFiles: unknown, expectedAssignmentHash?: string | null): DelegatedDiffPolicy {
  const normalizedRole = normalizePlanRole(role);
  const manifest = readRunAssignmentsResilient(cwd, runId);
  const assignmentScopes = manifest
    ? manifest.assignments
      .filter((assignment) => normalizePlanRole(assignment.role) === normalizedRole)
      .map((assignment) => assignment.scope)
    : [];
  return {
    cwd,
    role,
    runId,
    allowedPatterns: parseAllowedFiles(allowedFiles),
    assignmentScopes,
    assignmentRequired: Boolean(manifest && roleNeedsAssignment(role)),
    expectedAssignmentHash: expectedAssignmentHash === undefined ? opencodeAssignmentHash(cwd, runId) : expectedAssignmentHash,
  };
}

function pathList(paths: string[]): string {
  return paths.slice(0, 8).join(', ') + (paths.length > 8 ? `, ... +${paths.length - 8} more` : '');
}

function validateDelegatedDiff(paths: string[], policy: DelegatedDiffPolicy): string | null {
  const targets = uniquePaths(paths.map((p) => normalizeRelPath(p)).filter(Boolean));
  if (policy.expectedAssignmentHash) {
    const current = opencodeAssignmentHash(policy.cwd, policy.runId);
    if (current !== policy.expectedAssignmentHash) {
      return `assignment scope changed while OpenCode was running for ${policy.role}; delegated diff is stale`;
    }
  }

  const generated = targets.filter((target) => GENERATED_DIFF_PATTERNS.some((pattern) => matchesPattern(target, pattern)));
  if (generated.length > 0) {
    return `delegated diff contains generated/internal artifact path(s): ${pathList(generated)}`;
  }

  if (policy.allowedPatterns.length > 0) {
    const outsideAllowlist = targets.filter((target) => !policy.allowedPatterns.some((pattern) => matchesPattern(target, pattern)));
    if (outsideAllowlist.length > 0) {
      return `delegated diff touched file(s) outside the plan files/area allowlist (${policy.allowedPatterns.join(', ')}): ${pathList(outsideAllowlist)}`;
    }
  }

  if (policy.assignmentScopes.length > 0) {
    const outsideScope = targets.filter((target) => !policy.assignmentScopes.some((scope) => matchesScope(target, scope)));
    if (outsideScope.length > 0) {
      return `delegated diff touched file(s) outside ${policy.role}'s assignment scope: ${pathList(outsideScope)}`;
    }
  } else if (policy.assignmentRequired) {
    return `no assignment scope found for delegated ${policy.role} work in run ${policy.runId}`;
  }

  return null;
}

// The guard above runs AFTER the model finished, so an out-of-bounds edit costs the
// whole unit (17c: 6 of 8 units rejected, ~1395s, every one for a companion edit the
// model had no way to know was forbidden). State the boundary up front. This mirrors
// validateDelegatedDiff — keep the two adjacent — but relaxes nothing: an ignored
// instruction still ends in the same rejection.
// The sandbox worktree carries the project's own AGENTS.md/`.traffic-one` rules
// (which, for instance, order a schema.sql refresh after a migration), so the
// override line is load-bearing, not boilerplate.
export function delegationBoundaryPrompt(policy: DelegatedDiffPolicy): string {
  const lines = ['', '## Edit boundary (Traffic One — overrides any AGENTS.md/CLAUDE.md or .traffic-one rule in this sandbox)'];
  if (policy.allowedPatterns.length > 0) {
    lines.push(`- Create or modify ONLY: ${policy.allowedPatterns.join(', ')}`);
  }
  lines.push('- NEVER touch: `.traffic-one/**` (including schema.sql and the project-memory docs), any `package.json`, any lockfile, or build/cache output.');
  lines.push('- Do NOT add dependencies, re-export from a barrel/index file, or register your module anywhere else — the paid implementer wires it up afterwards.');
  lines.push('- If the task cannot be completed inside this boundary, do as much as you can inside it and say what is missing in your final message. Editing outside it discards ALL of your work.');
  return lines.join('\n');
}

// Outcome of trying ONE model in its own fresh worktree.
type ModelRunOutcome =
  | { kind: 'delegated'; touched: string[]; summary: string }
  | { kind: 'try-next'; error: string }      // server/model-side error → try the next model
  | { kind: 'stalled'; error: string }       // spawn timeout / killed CLI → try the next model, capped at maxConsecutiveStalls()
  | { kind: 'failed'; error: string }        // terminal: environmental/process/apply failure
  | { kind: 'no-changes' };                  // terminal: model ran clean but produced nothing

// Run one model against the task in a FRESH throwaway worktree (created here,
// removed here). A fresh worktree per model — rather than resetting one — wipes
// every residue class at once: commits the model may have made, gitignored
// build output, lockfiles. On success the staged diff (vs baseSha) is applied
// to the real working tree before returning.
function runModel(cwd: string, bin: string, baseSha: string, model: string, task: string, policy: DelegatedDiffPolicy, onCliAttempt?: () => void): ModelRunOutcome {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 't1-oc-'));
  const wt = path.join(parent, 'wt');
  const added = git(cwd, ['worktree', 'add', '--detach', wt, baseSha], 60_000);
  if (added.status !== 0) {
    removeWorktree(cwd, parent, wt);
    return { kind: 'failed', error: `git worktree add failed: ${added.stderr || 'non-zero exit'}` };
  }

  try {
    // `opencode run` resolves its project directory from $PWD, NOT the spawn cwd:
    // Node's spawnSync sets the child's real cwd but leaves PWD pointing at the
    // parent (only a shell `cd` updates PWD). Without pinning the directory,
    // opencode edits the CALLER's tree (the user's real repo) instead of the
    // sandbox worktree, the worktree diff comes back empty, and EVERY delegation
    // falsely returns "no-changes" while stray edits leak into the real tree.
    // Pin both the explicit --dir flag and PWD to the worktree so the sandbox
    // actually contains the work.
    const runArgs = ['run', task, '--dir', wt, '-m', model, '--format', 'json'];
    const timeoutMs = Math.min(opencodeUnitTimeoutMs(), RUN_TIMEOUT_MS);
    let summary = '';
    // Retry only a CLEAN no-op (the weak model occasionally produces nothing). A
    // gateway error or process failure won't fix itself on retry, so bail at once.
    for (let attempt = 1; attempt <= MAX_DELEGATE_ATTEMPTS; attempt++) {
      onCliAttempt?.();
      // spawnTool: `bin` is the managed opencode.cmd shim on Windows (Node >=22
      // refuses a bare .cmd without it); an absolute .exe/PATH bin passes through.
      const run = spawnTool(bin, runArgs, {
        cwd: wt,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        env: { ...process.env, ...OPENCODE_RUN_ENV, PWD: wt },
      });
      if (run.error || run.status === null) {
        // A stall — our spawn timeout fired (ETIMEDOUT) or the CLI died to a
        // signal without ever answering — is MODEL-CLASS: the hosted free models
        // hang individually (observed live: the chain head ETIMEDOUT while other
        // free models answered), so the walk must advance instead of failing the
        // whole delegation. delegate() caps back-to-back stalls at
        // maxConsecutiveStalls() because a stalled GATEWAY makes every probe
        // burn the full unit timeout.
        const code = (run.error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ETIMEDOUT' || (!run.error && run.status === null)) {
          const detail = run.error ? `ETIMEDOUT after ${timeoutMs}ms` : `killed with ${run.signal || 'unknown signal'}`;
          return { kind: 'stalled', error: `opencode run stalled: ${detail}` };
        }
        // Genuine spawn failure (ENOENT/EACCES/…): a different model cannot help.
        return { kind: 'failed', error: `opencode run failed: ${(run.error as Error).message}` };
      }
      const parsed = parseStream(run.stdout || '');
      if (parsed.errored) {
        const msg = parsed.errorMsg || parsed.errName || 'error';
        if (shouldTryNextModel(parsed.errName, parsed.errorMsg)) {
          return { kind: 'try-next', error: msg };
        }
        return { kind: 'failed', error: `opencode: ${msg}` };
      }
      // Stage everything opencode changed; non-empty staged diff vs the BASE sha
      // ⇒ we have work. Diffing against baseSha (not symbolic HEAD) keeps the
      // work visible even when the model `git commit`ed inside the detached
      // worktree (which moves HEAD and would make a HEAD-relative diff empty).
      git(wt, ['add', '-A', '--', '.', ...stageExcludePathspecs(wt)]);
      if (git(wt, ['diff', '--cached', '--quiet', baseSha]).status !== 0) { summary = parsed.summary; break; }
      if (attempt >= MAX_DELEGATE_ATTEMPTS) {
        return { kind: 'no-changes' };
      }
      // Reset the throwaway worktree to the pristine base before the free retry
      // (-x also drops gitignored residue the first attempt may have written).
      git(wt, ['reset', '--hard', '-q', baseSha]);
      git(wt, ['clean', '-fdxq']);
    }

    // Capture the patch + touched list from the winning attempt (vs baseSha).
    const touched = parseNulPaths(git(wt, ['diff', '--cached', '--name-only', '-z', baseSha]).stdout);
    const applyTargets = uniquePaths([
      ...touched,
      ...parseNameStatusZ(git(wt, ['diff', '--cached', '--name-status', '-z', baseSha]).stdout),
    ]);
    const validationError = validateDelegatedDiff(applyTargets, policy);
    if (validationError) {
      return { kind: 'failed', error: validationError };
    }
    const patch = git(wt, ['diff', '--cached', '--binary', baseSha]).stdout;
    const patchPath = path.join(parent, 'delegated.patch');
    fs.writeFileSync(patchPath, patch, 'utf8');

    // Apply to the real working tree (unstaged, like a subagent edit). Same base,
    // so a clean tree applies cleanly; a conflict → fail → fallback.
    let backups: ApplyTargetBackup[];
    try {
      backups = backupApplyTargets(cwd, applyTargets, parent);
    } catch (err) {
      return { kind: 'failed', error: `could not prepare atomic delegated diff apply: ${formatError(err)}` };
    }
    let applied = git(cwd, ['apply', '--whitespace=nowarn', patchPath]);
    if (applied.status !== 0) {
      const rollbackError = restoreApplyTargets(backups);
      if (rollbackError) {
        return {
          kind: 'failed',
          error: `could not roll back failed delegated diff apply: ${rollbackError}`,
        };
      }
      applied = git(cwd, ['apply', '--3way', patchPath]);
    }
    if (applied.status !== 0) {
      const rollbackError = restoreApplyTargets(backups);
      const rollbackSuffix = rollbackError ? `; rollback failed: ${rollbackError}` : '';
      return { kind: 'failed', error: `could not apply delegated diff to the working tree: ${applied.stderr || 'apply failed'}${rollbackSuffix}` };
    }
    const verifyError = postApplyTypecheck(cwd, touched);
    if (verifyError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but typecheck failed${suffix}: ${verifyError}` };
    }
    const qualityError = postApplyQuality(cwd, touched);
    if (qualityError) {
      const rollbackError = restoreApplyTargets(backups);
      const suffix = rollbackError ? `; rollback failed: ${rollbackError}` : ' — reverted, tree untouched';
      return { kind: 'failed', error: `delegated diff applied but landed collapsed source${suffix}: ${qualityError}` };
    }
    return { kind: 'delegated', touched, summary };
  } finally {
    removeWorktree(cwd, parent, wt);
  }
}

export function delegate(cwd: string = process.cwd(), opts: DelegateOpts = {}): DelegateResult {
  cwd = resolveProjectRoot(cwd);
  const state = readEffectiveState(cwd);
  const role = (opts.role || 'opencode').trim() || 'opencode';
  const stateRunId = typeof state.currentRunId === 'string'
    ? state.currentRunId.trim()
    : (typeof state.currentRunId === 'number' && Number.isFinite(state.currentRunId) ? String(Math.trunc(state.currentRunId)) : '');
  const runId = (opts.runId || '').trim() || stateRunId || runStamp();
  const policy = buildDelegatedDiffPolicy(cwd, runId, role, opts.allowedFiles, opts.expectedAssignmentHash);
  const startedAt = Date.now();
  const maintenancePreflight = maintenanceContractPreflight(cwd, state, runId, role, opts.allowedFiles);
  const maintenanceEarlyResult = (result: DelegateResult): DelegateResult => {
    const failureKind = result.failureKind ?? classifyFailureKind(result.action, result.error);
    const enriched: DelegateResult = failureKind ? { ...result, failureKind } : result;
    recordMaintenanceDelegationOutcome(
      cwd,
      state,
      runId,
      role,
      enriched,
      startedAt,
      opts.fallbackAllowed !== false,
      maintenancePreflight.bootstrap,
    );
    return enriched;
  };
  if (maintenancePreflight.required && !maintenancePreflight.bootstrap) {
    return maintenanceEarlyResult({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: maintenancePreflight.error || 'OpenCode maintenance contract preflight failed closed',
      failureKind: 'diff-rejected',
    });
  }
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode?.enabled !== true) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode delegation is not enabled' });
  }
  const bin = resolveBin();
  if (!bin) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'OpenCode CLI is not installed' });
  }
  // We resolved a real binary — self-heal a stale/missing toolchain stamp so the
  // orchestrator + tier logic stop treating OpenCode as "not installed" on the
  // next run. Best-effort; never blocks delegation.
  reconcileManagedToolStamp(cwd, 'opencode');
  const task = (opts.task || '').trim();
  if (!task) {
    return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'No task provided to delegate' });
  }
  // Reject an allowlist the post-run diff validator can never accept BEFORE
  // paying for a model run. `validateDelegatedDiff` discards the entire diff for
  // one generated/internal path, so a digest listed in `allowedFiles` cost four
  // full delegations and returned nothing (1cu-cursor). The runner writes the
  // handoff digest itself — callers never need it in scope.
  const unsafeAllowed = unsafeAllowedFilePatterns(policy.allowedPatterns);
  if (unsafeAllowed.length > 0) {
    return maintenanceEarlyResult({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: `allowedFiles contains generated/internal path(s) the delegated diff can never include: ${unsafeAllowed.join(', ')}. Remove them and delegate only product files — the runner writes the handoff digest itself.`,
      failureKind: 'diff-rejected',
    });
  }
  // Sandbox requires a committed HEAD to branch the worktree from. Pin the exact
  // sha once: every worktree, reset, and diff below is relative to it.
  let head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0) {
    // NEW-PROJECT case: a fresh scaffold has no commit (and may not be a git repo at
    // all) until the build-completion flip — but the orchestrator delegates to
    // OpenCode DURING the build, so declining here forces a paid fallback for the
    // whole build. Self-heal: initialize (new-project only) + initial-commit the
    // scaffold, then retry. Still skips when no HEAD can be produced (a non-git folder
    // outside new-project mode, or nothing to commit) → caller falls back as before.
    ensureInitialCommit(cwd, { initIfNeeded: state.mode === 'new-project' });
    head = git(cwd, ['rev-parse', '--verify', 'HEAD']);
    if (head.status !== 0) {
      return maintenanceEarlyResult({ ok: false, action: 'skipped', digest: null, touched: [], error: 'No git HEAD to sandbox the delegation; run a normal subagent' });
    }
  }
  // Sandbox from the CURRENT WORKING TREE — uncommitted tracked changes AND
  // untracked files — not just committed HEAD. Without this, sequential
  // delegations each branch the worktree from a stale base and silently ignore
  // prior uncommitted edits, and any task touching a not-yet-committed file
  // fails on apply with "does not exist in index" (see snapshotWorkingTree).
  const baseSha = snapshotWorkingTree(cwd, head.stdout.trim());

  const { models, fromChain } = resolveModels(state, opts);
  let markedAttempt = false;
  const markCliAttempt = (): void => {
    if (markedAttempt || !runId || !role) return;
    markedAttempt = true;
    markOpenCodeRoleAttempted(cwd, runId, role);
  };
  // Terminal-outcome diagnostics into the attempt marker (append-only JSON lines;
  // the spawn gate only checks existence). Failed delegations were undiagnosable
  // from the 0-byte flag alone.
  const record = (result: DelegateResult): DelegateResult => {
    const failureKind = result.failureKind ?? classifyFailureKind(result.action, result.error);
    const enriched: DelegateResult = failureKind ? { ...result, failureKind } : result;
    recordOpenCodeAttemptOutcome(cwd, runId, role, {
      action: enriched.action,
      model: enriched.model ?? null,
      error: enriched.error,
      failureKind: enriched.failureKind ?? null,
      durationMs: Date.now() - startedAt,
      touched: enriched.touched.length,
    });
    if (opts.unitId) {
      recordOpenCodeUnitStatus(cwd, runId, {
        id: opts.unitId,
        role: normalizePlanRole(role),
        status: statusFromDelegateAction(enriched.action, enriched.error),
        action: enriched.action,
        model: enriched.model ?? null,
        error: enriched.error,
        failureKind: enriched.failureKind ?? null,
        touched: enriched.touched,
        allowedFiles: policy.allowedPatterns,
        assignmentHash: policy.expectedAssignmentHash,
      });
    }
    recordMaintenanceDelegationOutcome(
      cwd,
      state,
      runId,
      role,
      enriched,
      startedAt,
      opts.fallbackAllowed !== false,
      maintenancePreflight.bootstrap,
    );
    return enriched;
  };

  // Gateway-outage circuit breaker: once a delegation in THIS run concluded the
  // free gateway itself is down (maxConsecutiveStalls() back-to-back stalls),
  // later units — and later per-role runner PROCESSES — must not re-burn the
  // unit timeout re-detecting it. Fail instantly with the same provider-timeout
  // contract the stall terminal returns; the attempt marker keeps the spawn
  // gate from denying the paid fallback spawn. Free-chain only: an explicitly
  // pinned model is the user's choice and is never breaker-skipped.
  if (fromChain && openCodeGatewayOutageActive(cwd, runId, gatewayBreakerMs())) {
    markCliAttempt();
    return record({
      ok: false,
      action: 'failed',
      digest: null,
      touched: [],
      error: 'OpenCode gateway breaker is active for this run (repeated stalls) — skipped the free-model probe; proceed with the paid fallback',
      model: models[0] as string,
      failureKind: 'provider-timeout',
    });
  }

  // Egress preflight (free chain only — a pinned model is the user's explicit
  // choice). A DENIED gateway hangs rather than erroring, so without this every
  // model burns the full unit timeout to rediscover the same blocked host. Trip
  // the run breaker too so sibling units/shards skip even the 4s probe.
  if (fromChain) {
    const probe = opencodeGatewayReachable();
    if (!probe.reachable) {
      // Deliberately do NOT trip the run-scoped gateway breaker here. The probe costs
      // ~120ms, so every sibling unit can afford its own; tripping a 120s run-wide breaker
      // off one cheap signal would silence a chain that a re-probe might find healthy.
      markCliAttempt();
      return record({
        ok: false,
        action: 'failed',
        digest: null,
        touched: [],
        error: gatewayUnreachableError(probe.detail),
        model: models[0] as string,
        failureKind: 'environment',
      });
    }
  }

  // Walk the models: a fresh worktree per model; advance on server/model-side
  // errors (see shouldTryNextModel) AND on per-model stalls (capped at
  // maxConsecutiveStalls()). Environmental failures are terminal.
  const modelErrors: string[] = [];
  let consecutiveStalls = 0;
  let lastModel = models[models.length - 1] as string;
  // Appended AFTER the task (a boundary read first competes with the work itself)
  // and below the MCP task-file layer, so the caller's recorded task text is intact.
  const boundedTask = `${task}\n${delegationBoundaryPrompt(policy)}\n`;
  for (const model of models) {
    lastModel = model;
    const outcome = runModel(cwd, bin, baseSha, model, boundedTask, policy, markCliAttempt);
    if (outcome.kind === 'delegated') {
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        if (idx >= 0) freeChainStart = idx;
      }
      const digest = writeDigest(cwd, runId, role, model, outcome.touched, outcome.summary, { planUnit: Boolean(opts.unitId) });
      return record({ ok: true, action: 'delegated', digest, touched: outcome.touched, error: null, model });
    }
    if (outcome.kind === 'try-next' || outcome.kind === 'stalled') {
      modelErrors.push(`${model}: ${outcome.error}`);
      if (fromChain) {
        const idx = OPENCODE_FREE_MODELS.indexOf(model);
        // Skip the dead/stalling id for the rest of this process (a --from-plan
        // batch must not burn the unit timeout on it per unit), but always keep
        // at least the LAST chain entry tryable so delegation degrades to one
        // failing probe per unit instead of disappearing silently.
        if (idx >= 0) freeChainStart = Math.min(idx + 1, OPENCODE_FREE_MODELS.length - 1);
      }
      if (outcome.kind === 'stalled') {
        consecutiveStalls += 1;
        if (consecutiveStalls >= maxConsecutiveStalls()) {
          // Gateway-wide outage concluded — trip the run-scoped breaker so
          // every later unit/role shard in this run fast-fails (see the check
          // above the walk) instead of paying this detection again.
          markOpenCodeGatewayOutage(cwd, runId);
          return record({
            ok: false,
            action: 'failed',
            digest: null,
            touched: [],
            error: `OpenCode models stalled ${consecutiveStalls}x in a row (gateway or network likely down) — ${modelErrors.join('; ')}`,
            model,
          });
        }
      } else {
        consecutiveStalls = 0;
      }
      continue;
    }
    if (outcome.kind === 'no-changes') {
      return record({ ok: false, action: 'no-changes', digest: null, touched: [], error: 'OpenCode produced no file changes', model });
    }
    return record({ ok: false, action: 'failed', digest: null, touched: [], error: outcome.error, model });
  }
  return record({
    ok: false,
    action: 'failed',
    digest: null,
    touched: [],
    error: `no usable OpenCode model — ${modelErrors.join('; ')}`,
    model: lastModel,
  });
}

export interface PlanDelegationResult {
  total: number;
  delegated: number;
  units: Array<{ id?: string; role: string; task: string; action: DelegateResult['action']; status?: string; touched: string[]; model?: string; failureKind?: FailureKind | null; error?: string | null }>;
}

// Parse the architect's plan.md delegation queue. The architect emits a
// machine-readable block listing ONLY bounded/low-risk units (senior work is
// never queued), so delegation does not depend on the orchestrator re-deciding
// per unit mid-flight:
//   <!-- opencode-delegate:start -->
//   - role: backend | files: src/lib/seed.ts | task: <self-contained task>
//   <!-- opencode-delegate:end -->
export { finalizePlanBatchOnly } from '../../shared/opencode-plan-batch';

export function parsePlanDelegationQueue(planText: string): PlanDelegationUnit[] {
  return parsePlanDelegationUnits(planText);
}

// Deterministically delegate EVERY queued bounded unit to OpenCode. Reuses
// delegate() per unit (each in its own worktree from HEAD); the free-model
// chain position is memoized across units, so a retired promo id is skipped
// after the first unit discovers it. A unit that opencode can't deliver
// (skipped/failed/no-changes) simply isn't applied — the orchestrator then
// spawns a normal subagent for it. Never throws.
// Normalize role labels for comparisons ("senior-frontend" ≡ "frontend").
export function normalizePlanRole(role: string): string {
  return normalizeOpenCodeRole(role);
}

export function delegateFromPlan(cwd: string = process.cwd(), opts: { runId?: string; model?: string; roles?: readonly string[] } = {}): PlanDelegationResult {
  cwd = resolveProjectRoot(cwd);
  const state = (readEffectiveState(cwd) || {}) as Rec;
  const stateRunId = typeof state.currentRunId === 'string'
    ? state.currentRunId.trim()
    : (typeof state.currentRunId === 'number' && Number.isFinite(state.currentRunId) ? String(Math.trunc(state.currentRunId)) : '');
  const runId = (opts.runId || '').trim() || stateRunId;
  let planText = '';
  try { planText = fs.readFileSync(path.join(cwd, '.traffic-one', 'plan.md'), 'utf8'); } catch { /* no plan → empty queue */ }
  // In maintenance, plan.md is a durable artifact from the last build, so from-plan
  // is a no-op — UNLESS the architect wrote a fresh run-scoped queue for THIS run
  // (a complex maintenance build). `hasFreshArchitectQueueForRun` gates that: it
  // requires `runs/<runId>/assignments.json` PLUS architect-run evidence (digest
  // or agent-registry entry) for the same run — small/triage maintenance runs
  // never produce those, and a hand-copied manifest alone doesn't count, so a
  // stale plan.md is never re-delegated.
  const maintenanceQueueSuppressed =
    isMaintenancePhase(state, typeof state.mode === 'string' ? state.mode : undefined) &&
    !hasFreshArchitectQueueForRun(cwd, runId);
  const queue = maintenanceQueueSuppressed ? [] : parsePlanDelegationQueue(planText);
  const formalQueue = buildOpenCodeQueue(cwd, runId, queue);
  writeOpenCodeQueue(cwd, formalQueue);
  let entries = queue.map((unit, index) => ({ unit, formal: formalQueue.units[index]! }));
  // Role shard filter: the MCP layer parallelizes the batch ACROSS roles (units
  // within one role stay sequential — they share a digest file).
  if (opts.roles && opts.roles.length > 0) {
    const allowed = new Set(opts.roles.map((r) => normalizePlanRole(r)));
    entries = entries.filter((entry) => allowed.has(normalizePlanRole(entry.unit.role)));
  }
  const units: PlanDelegationResult['units'] = [];
  let delegated = 0;
  const totalByRole = new Map<string, number>();
  const processedByRole = new Map<string, number>();
  for (const entry of entries) {
    const normalizedRole = normalizePlanRole(entry.unit.role);
    totalByRole.set(normalizedRole, (totalByRole.get(normalizedRole) || 0) + 1);
  }
  if (entries.length === 0) {
    const unit = {
      id: '__no_units__',
      role: 'batch',
      task: 'No runnable OpenCode units were queued for this batch.',
      action: 'skipped' as const,
      status: 'skipped_no_units',
      touched: [] as string[],
      error: 'No runnable OpenCode units were queued for this batch or role shard.',
    };
    if (runId) {
      recordOpenCodeUnitStatus(cwd, runId, {
        id: unit.id,
        role: unit.role,
        status: 'skipped_no_units',
        action: 'skipped-no-units',
        error: unit.error,
        touched: [],
        assignmentHash: formalQueue.assignmentHash,
      });
    }
    return { total: 0, delegated: 0, units: [unit] };
  }
  if (runId) markPlanBatchRunningIfNeeded(cwd, runId);
  try {
    const scopeManifest = runId ? readRunAssignmentsResilient(cwd, runId) : null;
    const policyReport = openCodeQueuePolicyReport(queue, scopeManifest ? { assignments: scopeManifest.assignments } : {});
    const rejectAll = policyReport.violations.length > 0 && policyReport.byUnitId.size === 0;
    // Seed from the PERSISTED ledger: role shards are separate runner processes, so a
    // dependency may already have failed in an earlier shard (17c: a tester unit
    // depended on a backend unit rejected 3 minutes earlier, then burned 303s
    // rebuilding what that unit never delivered). Kept current as units settle below.
    const unitOutcomes = new Map<string, OpenCodeUnitStatus>();
    if (runId) {
      for (const status of readOpenCodeUnitStatuses(cwd, runId)) unitOutcomes.set(status.id, status.status);
    }

    for (const entry of entries) {
      const u = entry.unit;
      const formal = entry.formal;
      const normalizedRole = normalizePlanRole(u.role);
      const blockedBy = blockedByFailedDependencies(formal.dependsOn, unitOutcomes);
      if (blockedBy.length > 0) {
        const error = `skipped: dependency ${blockedBy.map((d) => `\`${d}\``).join(', ')} did not land, so this unit's prerequisites are missing`;
        if (runId) {
          recordOpenCodeUnitStatus(cwd, runId, {
            id: formal.id,
            role: formal.role,
            status: 'skipped',
            action: 'skipped-dependency-failed',
            failureKind: 'skipped',
            error,
            touched: [],
            allowedFiles: formal.allowedFiles,
            assignmentHash: formalQueue.assignmentHash,
          });
        }
        unitOutcomes.set(formal.id, 'skipped');
        units.push({ id: formal.id, role: u.role, task: u.task, action: 'skipped', status: 'skipped', touched: [], failureKind: 'skipped', error });
        processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
        continue;
      }
      const unitPolicyViolations = rejectAll ? policyReport.violations : (policyReport.byUnitId.get(formal.id) || []);
      if (unitPolicyViolations.length > 0) {
        const error = unitPolicyViolations.join('; ');
        if (runId) {
          recordOpenCodeUnitStatus(cwd, runId, {
            id: formal.id,
            role: formal.role,
            status: 'rejected_policy',
            action: 'failed',
            failureKind: 'diff-rejected',
            error,
            touched: [],
            allowedFiles: formal.allowedFiles,
            assignmentHash: formalQueue.assignmentHash,
          });
        }
        unitOutcomes.set(formal.id, 'rejected_policy');
        units.push({ id: formal.id, role: u.role, task: u.task, action: 'failed', status: 'rejected_policy', touched: [], failureKind: 'diff-rejected', error });
        processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
        continue;
      }
      if (runId) {
        recordOpenCodeUnitStatus(cwd, runId, {
          id: formal.id,
          role: formal.role,
          status: 'running',
          action: 'running',
          touched: [],
          allowedFiles: formal.allowedFiles,
          assignmentHash: formalQueue.assignmentHash,
        });
      }
      const task = u.files ? `${u.task}\n\nFiles/area: ${u.files}` : u.task;
      let r: DelegateResult;
      try {
        r = delegate(cwd, {
          role: u.role,
          task,
          runId,
          model: opts.model,
          allowedFiles: u.files,
          unitId: formal.id,
          expectedAssignmentHash: formalQueue.assignmentHash,
        });
      } catch (err) {
        r = {
          ok: false,
          action: 'failed',
          digest: null,
          touched: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const failureKind = r.failureKind ?? classifyFailureKind(r.action, r.error);
      const status = statusFromDelegateAction(r.action, r.error);
      if (runId) {
        recordOpenCodeUnitStatus(cwd, runId, {
          id: formal.id,
          role: formal.role,
          status,
          action: r.action,
          model: r.model ?? null,
          failureKind: failureKind ?? null,
          error: r.error,
          touched: r.touched,
          allowedFiles: formal.allowedFiles,
          assignmentHash: formalQueue.assignmentHash,
        });
      }
      unitOutcomes.set(formal.id, status);
      if (r.ok) delegated += 1;
      units.push({ id: formal.id, role: u.role, task: u.task, action: r.action, status, touched: r.touched, ...(r.model ? { model: r.model } : {}), ...(failureKind ? { failureKind } : {}), error: r.error });
      processedByRole.set(normalizedRole, (processedByRole.get(normalizedRole) || 0) + 1);
    }
  } finally {
    if (runId) reconcileStaleRunningUnits(cwd, runId);
  }
  const summary = { total: entries.length, delegated, units };
  if (runId) {
    // Role shards (--roles) are merged and finalized by the MCP wrapper; only the
    // full-batch shell path writes terminal batch.json here.
    if (opts.roles && opts.roles.length > 0) {
      for (const [role, total] of totalByRole) {
        if ((processedByRole.get(role) || 0) >= total) markOpenCodePlanRoleCompleted(cwd, runId, role);
      }
    } else {
      finalizePlanBatch(cwd, runId, summary);
    }
  }
  return summary;
}

// CLI entry. Either:
//   --from-plan                         delegate every bounded unit in plan.md's queue
//   --role <r> (--task <t>|--task-file <p>)   delegate one explicit unit
// plus --run-id <id> [--model <provider/model>]. Prints a one-line JSON result.
export function main(): number {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  if (args.includes('--finalize-only')) {
    const runId = (get('--run-id') || '').trim();
    if (!runId) {
      process.stderr.write('opencode-runner: --finalize-only requires --run-id\n');
      return 1;
    }
    const summary = finalizePlanBatchOnly(process.cwd(), runId);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }

  if (args.includes('--from-plan')) {
    const rolesCsv = get('--roles');
    const summary = delegateFromPlan(process.cwd(), {
      runId: get('--run-id'),
      model: get('--model'),
      ...(rolesCsv ? { roles: rolesCsv.split(',').map((r) => r.trim()).filter(Boolean) } : {}),
    });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0; // batch is best-effort: un-delegated units fall back to subagents, never fail the run
  }

  const taskFile = get('--task-file');
  let task = get('--task');
  if (!task && taskFile && fs.existsSync(taskFile)) task = fs.readFileSync(taskFile, 'utf8');

  const result = delegate(process.cwd(), {
    role: get('--role'),
    task,
    runId: get('--run-id'),
    model: get('--model'),
    allowedFiles: get('--allowed-files'),
    unitId: get('--unit-id'),
    expectedAssignmentHash: get('--expected-assignment-hash'),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  const code = main();
  if (typeof code === 'number') process.exitCode = code;
}
