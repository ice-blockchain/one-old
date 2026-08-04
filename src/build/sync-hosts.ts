// src/build/sync-hosts.ts
// Maintainer host sync (run via `npm run plugin:sync`). Always regenerates dist/,
// then refreshes ONE host — the one whose agent session invoked the command — or
// every host when no host can be resolved. Resolution order is
// `--host=<id>` › `TRAFFIC_ONE_HOST` › terminal env markers › all hosts.
//
// A single-host sync that succeeds prints exactly one line and nothing else; the
// full transcript is buffered and replayed only on failure. All-hosts mode keeps
// the verbose transcript.
//
// Claude is the Cursor source (Imported). Never install
// ~/.cursor/plugins/local/traffic-one when Claude user-scope is enabled — that
// duplicates every hook. thirdPartyExtensibility must stay enabled so hooks fire.
//
// Success is decided from FILESYSTEM STATE, not exit codes: `claude plugin
// marketplace add` and `codex plugin marketplace add` both fail routinely on a
// re-run ("already exists"), so exit status alone cannot tell a healthy sync from
// a broken one. Copilot in particular copies dist/ wholesale rather than caching
// it by version, and has been observed sitting many versions stale.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { HostId } from '../core/types';

const HOME = os.homedir();
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(REPO_ROOT, 'dist');

// Mirrors the HostId union in src/core/types.ts. A test parses that file and
// asserts the two stay equal — the type cannot reach across into this list.
export const HOST_IDS: readonly HostId[] = [
  'claude', 'codex', 'cursor', 'opencode', 'copilot', 'windsurf', 'kilo',
];

// Product names as the user knows them. Matches the wording already used by
// uninstallDirective() in src/shared/uninstall-intent.ts; kept local because that
// file compiles into dist/scripts and must never import from src/build.
export const HOST_LABELS: Record<HostId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  copilot: 'Copilot',
  windsurf: 'Windsurf',
  kilo: 'Kilo',
};

export function successLine(host: HostId, version: string): string {
  return `traffic one plugin was successfully synced to v${version} on your ${HOST_LABELS[host]}`;
}

function isHostId(value: string): value is HostId {
  return (HOST_IDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Output sink
// ---------------------------------------------------------------------------

// null = write straight through (all-hosts / --verbose). An array buffers every
// line so a successful single-host sync can discard it and print one line
// instead, while any failure replays the whole transcript unchanged.
let sink: string[] | null = null;

function out(text: string): void {
  if (sink) sink.push(text);
  else process.stdout.write(text);
}

function flushSink(): void {
  if (!sink) return;
  const buffered = sink;
  sink = null;
  for (const chunk of buffered) process.stdout.write(chunk);
}

function discardSink(): void {
  sink = null;
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

interface RunOptions {
  allowFailure?: boolean;
  cwd?: string;
}

function run(label: string, args: readonly string[], opts: RunOptions = {}): { status: number | null } {
  const { allowFailure = false, cwd = REPO_ROOT } = opts;
  const bin = args[0];
  if (bin === undefined) throw new Error(`${label}: empty command`);
  out(`\n>> ${label}\n`);
  const r = spawnSync(bin, args.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: process.env,
  });
  // A missing binary yields status null with empty streams, so without this the
  // failure below reads "failed with status null" and names no cause.
  if (r.error) out(`${label}: ${r.error.message}\n`);
  const merged = [r.stdout, r.stderr].filter(Boolean).join('').trim();
  if (merged) out(`${merged}\n`);
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`${label} failed with status ${r.status}`);
  }
  return { status: r.status };
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function onPath(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

function pkgVersionAt(dir: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

function pluginBuild(): void {
  run('plugin:build (gen + build)', ['npm', 'run', 'plugin:build']);
  if (!fs.existsSync(DIST)) {
    throw new Error(`plugin:build finished but dist is missing at ${DIST}`);
  }
}

// ---------------------------------------------------------------------------
// Host paths
// ---------------------------------------------------------------------------

const claudeCache = (): string => path.join(HOME, '.claude', 'plugins', 'cache', 'traffic-one', 'traffic-one');
const codexCache = (): string => path.join(HOME, '.codex', 'plugins', 'cache', 'traffic-one-local', 'traffic-one');
const codexMarketplace = (): string => path.join(HOME, '.codex', 'local-marketplaces', 'traffic-one-local');
const codexStaged = (): string => path.join(codexMarketplace(), 'plugins', 'traffic-one');
const cursorCache = (): string => path.join(HOME, '.cursor', 'plugins', 'cache', 'traffic-one', 'traffic-one');
const cursorLocal = (): string => path.join(HOME, '.cursor', 'plugins', 'local', 'traffic-one');
const cursorStateDb = (): string => path.join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
const copilotCopy = (): string => path.join(HOME, '.copilot', 'installed-plugins', '_direct', path.basename(DIST));
const wrapperScript = (host: HostId): string => path.join(DIST, 'scripts', `${host}-host.cjs`);

// ---------------------------------------------------------------------------
// Per-host sync units
// ---------------------------------------------------------------------------

interface SyncUnit {
  /** Hosts that must be synced first for this one to work. */
  requires: readonly HostId[];
  /** Cleared before this host installs. Only the selected hosts' caches are touched. */
  caches: readonly (() => string)[];
  /** False when the host is not present on this machine. */
  available: () => boolean;
  sync: (version: string) => void;
  /** Returns null when the host now serves `version`, else a problem description. */
  verify: (version: string) => string | null;
}

function syncClaude(): void {
  run('claude marketplace add', ['claude', 'plugin', 'marketplace', 'add', DIST, '--scope', 'user'], { allowFailure: true });
  run('claude uninstall', ['claude', 'plugin', 'uninstall', 'traffic-one@traffic-one', '--scope', 'user'], { allowFailure: true });
  run('claude install', ['claude', 'plugin', 'install', 'traffic-one@traffic-one', '--scope', 'user']);
  run('claude enable', ['claude', 'plugin', 'enable', 'traffic-one@traffic-one', '--scope', 'user'], { allowFailure: true });
  run('claude list', ['claude', 'plugin', 'list'], { allowFailure: true });
}

function verifyClaude(version: string): string | null {
  const problems: string[] = [];
  const versioned = path.join(claudeCache(), version);
  if (!fs.existsSync(versioned)) problems.push(`claude cache is missing ${version} (${versioned})`);
  // Read-only duplicate check. A stray Cursor local install makes every hook fire
  // twice, and a Claude sync is exactly what turns it into a duplicate — but
  // deleting it belongs to the cursor unit, not here.
  if (fs.existsSync(cursorLocal())) {
    problems.push(`a Cursor local install shadows this one and will double every hook: ${cursorLocal()} — run \`npm run plugin:sync -- --host=cursor\` to remove it`);
  }
  return problems.length ? problems.join('; ') : null;
}

function syncCodex(): void {
  const mkt = codexMarketplace();
  const staged = codexStaged();
  fs.mkdirSync(staged, { recursive: true });
  run('codex rsync', ['rsync', '-a', '--delete', `${DIST}/`, `${staged}/`]);
  fs.writeFileSync(path.join(mkt, 'marketplace.json'), `${JSON.stringify({
    name: 'traffic-one-local',
    interface: { displayName: 'Traffic One Local' },
    plugins: [{
      name: 'traffic-one',
      source: { source: 'local', path: './plugins/traffic-one' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Engineering',
    }],
  }, null, 2)}\n`);
  run('codex marketplace remove', ['codex', 'plugin', 'marketplace', 'remove', 'traffic-one-local'], { allowFailure: true });
  run('codex marketplace add', ['codex', 'plugin', 'marketplace', 'add', mkt], { allowFailure: true });
  run('codex plugin add', ['codex', 'plugin', 'add', 'traffic-one@traffic-one-local'], { allowFailure: true });
  run('codex list', ['codex', 'plugin', 'list'], { allowFailure: true });
}

function verifyCodex(version: string): string | null {
  const got = pkgVersionAt(codexStaged());
  return got === version ? null : `codex staged plugin is ${got ?? 'absent'}, expected ${version} (${codexStaged()})`;
}

// Cursor has no scriptable install — it auto-imports Claude's user-scope plugin,
// which the `requires: ['claude']` edge below guarantees is already current. This
// unit only owns the Cursor-side state: the import switch and the duplicate trap.
function syncCursor(): void {
  const db = cursorStateDb();
  if (fs.existsSync(db)) {
    run('enable Cursor third-party import', [
      'sqlite3', db,
      "INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('thirdPartyExtensibilityEnabled', 'true');",
    ], { allowFailure: true });
  }
  out('\n>> cursor local install\n');
  if (fs.existsSync(cursorLocal())) {
    rmrf(cursorLocal());
    out(`removed Cursor local install (prevents Local+Imported duplicate): ${cursorLocal()}\n`);
  } else {
    out('Cursor local install already absent\n');
  }
}

function verifyCursor(version: string): string | null {
  const problems: string[] = [];
  if (fs.existsSync(cursorLocal())) problems.push(`local install still present — duplicate hooks: ${cursorLocal()}`);
  const versioned = path.join(claudeCache(), version);
  if (!fs.existsSync(versioned)) problems.push(`imported source is stale: claude cache is missing ${version}`);
  return problems.length ? problems.join('; ') : null;
}

function syncCopilot(): void {
  run('copilot install', ['copilot', 'plugin', 'install', DIST], { allowFailure: true });
}

function verifyCopilot(version: string): string | null {
  const got = pkgVersionAt(copilotCopy());
  return got === version ? null : `copilot copy is ${got ?? 'absent'}, expected ${version} (${copilotCopy()})`;
}

function syncWrapper(host: HostId): () => void {
  return () => {
    run(`${host}-host install`, ['node', wrapperScript(host), 'install', '--yes'], { allowFailure: true });
  };
}

function verifyWrapper(host: HostId): () => string | null {
  return () => {
    const r = run(`${host}-host doctor`, ['node', wrapperScript(host), 'doctor'], { allowFailure: true });
    return r.status === 0 ? null : `${host}-host doctor exited ${r.status}`;
  };
}

const HOSTS: Record<HostId, SyncUnit> = {
  claude: {
    requires: [], caches: [claudeCache], available: () => onPath('claude'),
    sync: syncClaude, verify: verifyClaude,
  },
  codex: {
    requires: [], caches: [codexCache], available: () => onPath('codex'),
    sync: syncCodex, verify: verifyCodex,
  },
  cursor: {
    requires: ['claude'], caches: [cursorCache], available: () => true,
    sync: syncCursor, verify: verifyCursor,
  },
  opencode: {
    requires: [], caches: [], available: () => fs.existsSync(wrapperScript('opencode')),
    sync: syncWrapper('opencode'), verify: verifyWrapper('opencode'),
  },
  copilot: {
    requires: [], caches: [], available: () => onPath('copilot'),
    sync: syncCopilot, verify: verifyCopilot,
  },
  windsurf: {
    requires: [], caches: [], available: () => fs.existsSync(wrapperScript('windsurf')),
    sync: syncWrapper('windsurf'), verify: verifyWrapper('windsurf'),
  },
  kilo: {
    requires: [], caches: [], available: () => fs.existsSync(wrapperScript('kilo')),
    sync: syncWrapper('kilo'), verify: verifyWrapper('kilo'),
  },
};

// Pulls in each host's prerequisites and returns them in canonical order, deduped.
// This is what keeps `--host=cursor` from installing Claude twice: the dependency
// is an edge, not a nested call.
export function expandSelection(ids: readonly HostId[]): HostId[] {
  const wanted = new Set<HostId>();
  const visit = (id: HostId): void => {
    if (wanted.has(id)) return;
    for (const dep of HOSTS[id].requires) visit(dep);
    wanted.add(id);
  };
  for (const id of ids) visit(id);
  return HOST_IDS.filter((id) => wanted.has(id));
}

function clearCachesFor(id: HostId): void {
  const caches = HOSTS[id].caches;
  if (caches.length === 0) return;
  out(`\n>> clear ${id} plugin cache\n`);
  for (const cacheOf of caches) {
    const dir = cacheOf();
    if (fs.existsSync(dir)) {
      rmrf(dir);
      out(`cleared ${dir}\n`);
    } else {
      out(`absent ${dir}\n`);
    }
  }
}

// ---------------------------------------------------------------------------
// Arguments and host resolution
// ---------------------------------------------------------------------------

export class UsageError extends Error {}

export const USAGE = `usage: npm run plugin:sync [-- <options>]

  --host=<id>    sync only this host (${HOST_IDS.join(', ')})
  --all          sync every host, even inside a detected agent session
  --verbose, -v  keep the full transcript in single-host mode
  --print-host   print the host that would be targeted, then exit; changes nothing

With no options the host is taken from TRAFFIC_ONE_HOST or the surrounding agent
session's environment, and every host is synced when neither resolves.`;

export interface SyncArgs {
  host: HostId | null;
  all: boolean;
  verbose: boolean;
  printHost: boolean;
}

export function parseArgs(argv: readonly string[]): SyncArgs {
  const args: SyncArgs = { host: null, all: false, verbose: false, printHost: false };
  let rawHost: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--all') { args.all = true; continue; }
    if (a === '--verbose' || a === '-v') { args.verbose = true; continue; }
    if (a === '--print-host') { args.printHost = true; continue; }
    if (a === '--host') { rawHost = (argv[i + 1] ?? '').trim(); i += 1; continue; }
    if (a.startsWith('--host=')) { rawHost = a.slice('--host='.length).trim(); continue; }
    throw new UsageError(`unknown argument: ${a}`);
  }
  if (rawHost !== null) {
    if (!isHostId(rawHost)) {
      throw new UsageError(`unknown host "${rawHost}" — expected one of: ${HOST_IDS.join(', ')}`);
    }
    args.host = rawHost;
  }
  if (args.host && args.all) throw new UsageError('--host and --all are mutually exclusive');
  return args;
}

// TERMINAL env markers of the surrounding agent session — deliberately NOT the
// hook-process markers detectHost() uses in src/shared/host/index.ts.
// CLAUDE_PLUGIN_ROOT / CURSOR_PLUGIN_ROOT / CODEX_PLUGIN_ROOT are set for hook
// subprocesses only, never for a shell the agent runs commands in, and
// detectHost() floors to 'claude' where this must be able to answer "nobody".
//
// Ordered agent-session-first: Claude Code running inside Cursor's integrated
// terminal must resolve to `claude` (the CLI running this command), not `cursor`
// (the window it happens to live in). Cursor's own agent never sets CLAUDECODE.
//
// Only the `claude` row is verified against a live session. Every other row is a
// best-effort guess, which is safe by construction: a marker that never fires
// falls through to all-hosts (today's behavior), and a maintainer who hits a
// wrong guess overrides it with `--host=`. Confirm a row with
// `npm run plugin:sync -- --print-host` from inside that host.
export const TERMINAL_MARKERS: readonly (readonly [HostId, readonly string[]])[] = [
  // VERIFIED live in a Claude Code terminal.
  ['claude', ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID']],
  // UNVERIFIED. CODEX_PLUGIN_ROOT/CODEX_THREAD_ID are documented as hook-scoped
  // and may never appear in a terminal; CODEX_SANDBOX* show up on sandboxed exec.
  ['codex', ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_THREAD_ID', 'CODEX_PLUGIN_ROOT']],
  // UNVERIFIED.
  ['copilot', ['COPILOT_CLI_SESSION_ID', 'COPILOT_AGENT_ID', 'GITHUB_COPILOT_CLI']],
  // UNVERIFIED.
  ['opencode', ['OPENCODE_SESSION_ID', 'OPENCODE_SERVER']],
  // UNVERIFIED.
  ['kilo', ['KILO_SESSION_ID', 'KILO_SERVER']],
  // Editor shells last, and only when no agent CLI claimed the session.
  // UNVERIFIED: CURSOR_AGENT is reported for the `cursor-agent` CLI,
  // CURSOR_TRACE_ID for Cursor's integrated terminal.
  ['cursor', ['CURSOR_AGENT', 'CURSOR_TRACE_ID', 'CURSOR_PLUGIN_ROOT']],
  // UNVERIFIED.
  ['windsurf', ['WINDSURF_SESSION_ID', 'WINDSURF_USER_ID', 'CODEIUM_EDITOR']],
];

export function detectTerminalHost(env: NodeJS.ProcessEnv): { host: HostId; marker: string } | null {
  for (const [host, keys] of TERMINAL_MARKERS) {
    for (const key of keys) {
      const value = env[key];
      if (typeof value === 'string' && value.trim() !== '') return { host, marker: key };
    }
  }
  return null;
}

export function resolveTargetHost(args: SyncArgs, env: NodeJS.ProcessEnv): { host: HostId | null; source: string } {
  if (args.host) return { host: args.host, source: `--host=${args.host}` };
  if (args.all) return { host: null, source: '--all' };
  const fromEnv = (env.TRAFFIC_ONE_HOST ?? '').trim();
  if (fromEnv !== '') {
    if (!isHostId(fromEnv)) throw new UsageError(`TRAFFIC_ONE_HOST="${fromEnv}" is not a known host — expected one of: ${HOST_IDS.join(', ')}`);
    return { host: fromEnv, source: 'TRAFFIC_ONE_HOST' };
  }
  const detected = detectTerminalHost(env);
  if (detected) return { host: detected.host, source: `terminal env ${detected.marker}` };
  return { host: null, source: 'no host detected' };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  let args: SyncArgs;
  let target: { host: HostId | null; source: string };
  try {
    args = parseArgs(argv);
    target = resolveTargetHost(args, env);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`sync-hosts: ${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }

  if (args.printHost) {
    process.stdout.write(`${target.host ?? 'all hosts'}\t${target.source}\n`);
    return 0;
  }

  const version = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version);
  const selection = target.host ? expandSelection([target.host]) : HOST_IDS.slice();
  const quiet = target.host !== null && !args.verbose;
  if (quiet) sink = [];

  if (target.host && !HOSTS[target.host].available()) {
    discardSink();
    process.stderr.write(`sync-hosts: ${target.host} is not installed on this machine — nothing to sync\n`);
    return 2;
  }

  out(`sync-hosts ${version}\n`);
  out(`target: ${target.host ?? 'all hosts'} (${target.source})\n`);
  out(`selection: ${selection.join(', ')}\n`);

  const problems: string[] = [];
  try {
    pluginBuild();
  } catch (err) {
    flushSink();
    process.stdout.write(`\nsync ABORTED: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  out(`\nsync ${version} from ${DIST}\n`);

  for (const id of selection) {
    const unit = HOSTS[id];
    if (!unit.available()) {
      out(`\n>> ${id}: skipped (not installed)\n`);
      continue;
    }
    clearCachesFor(id);
    try {
      unit.sync(version);
    } catch (err) {
      // All-hosts mode reports every broken host instead of stopping at the first.
      problems.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const problem = unit.verify(version);
    if (problem) problems.push(`${id}: ${problem}`);
  }

  if (problems.length === 0) {
    if (quiet && target.host) {
      discardSink();
      process.stdout.write(`${successLine(target.host, version)}\n`);
    } else {
      out('DONE\n');
    }
    return 0;
  }

  flushSink();
  process.stdout.write(`\nsync FAILED (${problems.length}):\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  return 1;
}

// Buffered stdout to a pipe drains asynchronously, so process.exit() here would
// truncate the replayed transcript. Setting exitCode lets it flush normally.
if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
