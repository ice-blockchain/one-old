// src/build/sync-hosts.ts
// Maintainer host sync (run via `npm run plugin:sync`). Always regenerates dist/,
// then refreshes ONE host — the one whose agent session invoked the command — or
// every host when no host can be resolved. Resolution order is
// `--host=<id>` › `TRAFFIC_ONE_HOST` › terminal env markers › all hosts.
//
// A single-host sync that succeeds prints exactly the success line plus the
// mandatory restart instruction, and nothing else; the full transcript is
// buffered and replayed only on failure. All-hosts mode keeps the verbose
// transcript.
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

// Mandatory, unmissable follow-up: hosts freeze their hook wiring at startup
// (see the launcher NOTE in src/gen/sources/hooks.ts and the "Uninstall"
// section of README.md), so every already-open session of a just-synced host
// keeps calling the OLD bundle path until that host restarts — silently
// disabling every Traffic One gate for the rest of the session. This must
// print on every success path, including the quiet single-host one.
export function restartLine(hosts: readonly HostId[]): string {
  const names = hosts.map((id) => HOST_LABELS[id]).join(', ');
  return [
    '>>> RESTART REQUIRED: ' + names,
    `${names} loaded Traffic One's hook wiring at startup and will not pick it up until it restarts.`,
    'Restart it now, before starting a new session — otherwise every Traffic One gate silently stops running.',
  ].join('\n');
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

// Every host CLI here is a network client (marketplace fetch, plugin-registry
// write) invoked while this host's cache is quarantined, so an unbounded wait is
// not a slow success — it holds the ONLY copy of a working install hostage, and
// once it outlives STALE_PRESYNC_MS a concurrent run's startup sweep becomes
// entitled to delete that copy. build-runtime.ts bounds `tsc` at the same
// figure for the same reason.
export const HOST_CLI_TIMEOUT_MS = 180_000;

// `npm run plugin:build` is gen plus a full `tsc`, and build-runtime.ts already
// allows that tsc 180s on its own, so the wrapper must be allowed to outlive
// it — a ceiling for a hang, not a budget.
export const PLUGIN_BUILD_TIMEOUT_MS = 900_000;

interface RunOptions {
  allowFailure?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

function run(label: string, args: readonly string[], opts: RunOptions = {}): { status: number | null } {
  const { allowFailure = false, cwd = REPO_ROOT, timeoutMs = HOST_CLI_TIMEOUT_MS } = opts;
  const bin = args[0];
  if (bin === undefined) throw new Error(`${label}: empty command`);
  out(`\n>> ${label}\n`);
  const r = spawnSync(bin, args.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: process.env,
    timeout: timeoutMs,
  });
  // A missing binary yields status null with empty streams, so without this the
  // failure below reads "failed with status null" and names no cause.
  if (r.error) out(`${label}: ${r.error.message}\n`);
  const merged = [r.stdout, r.stderr].filter(Boolean).join('').trim();
  if (merged) out(`${merged}\n`);
  // A timeout is never waved through by `allowFailure`. That option exists for
  // commands which fail routinely and harmlessly on a re-run ("marketplace
  // already exists" — see the header), and a killed-on-timeout command has not
  // failed in that sense: it stopped mid-flight, possibly having half-written
  // the registry, with this host's cache still quarantined. spawnSync reports
  // it as error.code ETIMEDOUT (status null, signal SIGTERM), which is
  // distinguishable from a missing binary's ENOENT.
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
    throw new Error(`${label} did not finish within ${timeoutMs}ms and was killed`);
  }
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`${label} failed with status ${r.status}`);
  }
  return { status: r.status };
}

// Exported under a descriptive name purely so the timeout contract above can be
// exercised directly — a hung host CLI must throw, and `allowFailure` must not
// swallow it. Internal call sites keep the short local name.
export { run as runHostCommand };

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// "This path holds an install", the one observation that separates a sync which
// repopulated its quarantined cache from one that returned cleanly having
// written nothing. An existing-but-empty dir counts as nothing: that is exactly
// what a host CLI leaves when it creates the cache directory and then fails to
// fill it.
function isPopulatedDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function dirEntriesLabel(dir: string): string {
  try {
    return `[${fs.readdirSync(dir).join(', ')}]`;
  } catch {
    return '[unreadable]';
  }
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
  run('plugin:build (gen + build)', ['npm', 'run', 'plugin:build'], { timeoutMs: PLUGIN_BUILD_TIMEOUT_MS });
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

export interface SyncUnit {
  /** Hosts that must be synced first for this one to work. */
  requires: readonly HostId[];
  /**
   * Cache dirs quarantined (renamed out of the way, not deleted) immediately
   * before this host installs — `claude plugin install` skips re-copying
   * content into a cache dir that already exists at the target version, which
   * is exactly what a same-version local-dev re-sync looks like, so the path
   * must be empty going into `sync()`.
   *
   * A dir may be listed here ONLY if this unit's own `sync()` writes it back.
   * That is a hard precondition, not a preference. `cursor`'s sync never
   * writes cursorCache() (Cursor imports Claude's user-scope bundle at
   * runtime), and `codex`'s only reaches codexCache() through `codex plugin
   * add`, which runs allowFailure — so listing either one here emptied a
   * working install that nothing put back, while both units' `verify()` read
   * a DIFFERENT path and therefore still reported success. Those dirs belong
   * in `unstageableCaches`.
   *
   * The backup is released only once `sync()` has returned AND the dir is back
   * and non-empty (commitQuarantine). A throw, or an empty dir, restores it
   * and reports a problem: leaving a host stale is the outcome this quarantine
   * exists to allow, leaving it with no install at all is strictly worse than
   * stale. A `verify()` problem alone keeps the newly synced state and is just
   * reported — `sync()` can already have pointed the host's plugin registry at
   * the new bundle, so rolling back on verify would leave cache and registry
   * disagreeing, which is worse than either consistent state.
   */
  caches: readonly (() => string)[];
  /**
   * Cache dirs this command must never stage, but whose parents the startup
   * sweep still visits. Two reasons they have to be named somewhere: earlier
   * versions DID quarantine them, so a maintainer's machine can be holding the
   * only copy of a real install in a `.presync-*` sibling right now; and a
   * future unit could gain the ability to repopulate one, at which point it
   * moves to `caches` in one edit.
   */
  unstageableCaches?: readonly (() => string)[];
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

// Both the staged marketplace copy AND the cache Codex actually serves from.
// `codexStaged()` alone is structurally near-unfailable: it is the rsync target
// of the one command in syncCodex that is NOT allowFailure, so it is populated
// whenever sync() returns at all. `codex plugin add` — the step that moves those
// bytes into codexCache() — is exactly the allowFailure one, so the cache is
// where a sync silently fails to land, and it is the dir the quarantine used to
// delete without anything ever reading it.
//
// Read layout-agnostically, because this cache's shape is NOT verified against a
// live Codex: claude's equivalent is version-keyed (`<cache>/<version>/`, see
// verifyClaude) while a staged plugin dir carries package.json at its root, and
// either reading counts as "serving this version". Only a cache that EXISTS
// while matching neither is reported. An ABSENT cache is not a problem: that is
// what a first-time add looks like before Codex materializes it from the staged
// copy this same function has just confirmed is current, and calling it a
// failure would turn a healthy first sync red.
function verifyCodex(version: string): string | null {
  const staged = pkgVersionAt(codexStaged());
  if (staged !== version) {
    return `codex staged plugin is ${staged ?? 'absent'}, expected ${version} (${codexStaged()})`;
  }
  const cache = codexCache();
  if (!fs.existsSync(cache)) return null;
  if (fs.existsSync(path.join(cache, version)) || pkgVersionAt(cache) === version) return null;
  return `codex staged ${version} but its plugin cache still holds ${pkgVersionAt(cache) ?? dirEntriesLabel(cache)}`
    + ` (${cache}) — re-run \`codex plugin add traffic-one@traffic-one-local\``;
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

// cursorCache() is deliberately absent from these checks, and from this unit's
// `caches`: nothing in Cursor's sync path writes it (the bundle it serves is
// Claude's, checked below), so it is neither this command's to stage nor its to
// verify.
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

// Exported so the `caches` precondition can be asserted against the REAL units,
// not only against fakes: a test that only ever drives hand-written units is
// exactly how `cursor`/`codex` came to stage a cache no sync of theirs writes.
export const HOSTS: Record<HostId, SyncUnit> = {
  claude: {
    requires: [], caches: [claudeCache], available: () => onPath('claude'),
    sync: syncClaude, verify: verifyClaude,
  },
  codex: {
    requires: [], caches: [], unstageableCaches: [codexCache], available: () => onPath('codex'),
    sync: syncCodex, verify: verifyCodex,
  },
  cursor: {
    requires: ['claude'], caches: [], unstageableCaches: [cursorCache], available: () => true,
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

export interface CacheQuarantine { dir: string; backup: string; }
export interface QuarantineOutcome { quarantined: CacheQuarantine[]; error: string | null; }

// Renames each of this host's cache dirs out of the way instead of deleting
// them, so `sync()` still sees the empty path it needs (see the `caches` doc
// on SyncUnit) while a failed sync can be rolled back instead of leaving the
// host with a deleted, unrecoverable install. Never throws: a rename failure
// (EPERM/EBUSY/a concurrent host process) unwinds anything already quarantined
// in this same call and comes back as `error` so the caller can report it for
// this host and move on to the rest of the selection, instead of aborting the
// whole run.
//
// `caches` is a parameter, not a `HOSTS[id]` lookup, so this can be exercised
// directly against real temp directories in tests without touching an actual
// host's cache under $HOME; `id` is only ever used for the log line's label.
export function quarantineCachesFor(id: HostId, caches: readonly (() => string)[]): QuarantineOutcome {
  const quarantined: CacheQuarantine[] = [];
  if (caches.length === 0) return { quarantined, error: null };
  out(`\n>> clear ${id} plugin cache\n`);
  for (const cacheOf of caches) {
    const dir = cacheOf();
    if (!fs.existsSync(dir)) {
      out(`absent ${dir}\n`);
      continue;
    }
    const backup = `${dir}.presync-${process.pid}-${Date.now()}`;
    try {
      fs.renameSync(dir, backup);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Every current host has at most one cache dir, so this loop is a
      // no-op in practice; kept correct in case a future host has more than
      // one.
      for (const already of quarantined) {
        try { fs.renameSync(already.backup, already.dir); } catch { /* surfaced by the error below either way */ }
      }
      out(`could not clear ${dir}: ${message}\n`);
      return { quarantined: [], error: `could not clear ${dir} cache before sync (${message}) — left untouched` };
    }
    quarantined.push({ dir, backup });
    out(`cleared ${dir} (kept as ${backup} until sync() returns)\n`);
  }
  return { quarantined, error: null };
}

/** How old a `.presync-*` backup must be before a later run may sweep it. */
export const STALE_PRESYNC_MS = 60 * 60 * 1000;

// `<cache>.presync-<pid>-<epoch-ms>` — the exact shape quarantineCachesFor
// creates. The embedded timestamp, not mtime, is the creation time: renaming a
// months-old cache dir does not touch its mtime.
const PRESYNC_SUFFIX = /\.presync-(\d+)-(\d+)$/;

// Is the process that created a `.presync-*` backup still running? Signal 0
// runs the permission/existence check without delivering anything: ESRCH means
// no process owns that pid, EPERM means one does but it is not ours — alive
// either way, so EPERM must never read as dead.
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Sweep pre-sync backups an earlier run left behind. commitQuarantine and
// restoreQuarantine between them remove or re-home every backup on all paths
// that reach them — but a SIGKILL (or a power cut) between the renameSync and
// either of those leaves a full copy of a plugin cache sitting next to the
// live one, which nothing swept and no message ever named. Never throws: a
// backup that cannot be removed is reported and left alone.
//
// Deletion requires BOTH an age past STALE_PRESYNC_MS and a dead creator pid.
// Age alone is not abandonment: a `claude plugin install` that runs longer than
// the window is unusual, not impossible, and its backup is the only copy of
// that host's install, so an age-only rule lets one run delete another live
// run's sole rollback copy. `pidAlive` is injectable purely so a test can pin
// both answers without spawning processes; the default is the real check.
export function sweepStalePresyncBackups(
  caches: readonly (() => string)[],
  nowMs: number = Date.now(),
  pidAlive: (pid: number) => boolean = isPidAlive,
): string[] {
  const swept: string[] = [];
  for (const cacheOf of caches) {
    const dir = cacheOf();
    const parent = path.dirname(dir);
    const prefix = `${path.basename(dir)}.presync-`;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const stamp = PRESYNC_SUFFIX.exec(entry.name);
      // Unparseable name: never guess an age, never delete.
      if (!stamp) continue;
      if (nowMs - Number(stamp[2]) < STALE_PRESYNC_MS) continue;
      const abandoned = path.join(parent, entry.name);
      if (pidAlive(Number(stamp[1]))) {
        out(`kept pre-sync backup ${abandoned}: its sync (pid ${stamp[1]}) is still running\n`);
        continue;
      }
      try {
        rmrf(abandoned);
        out(`swept abandoned pre-sync backup ${abandoned}\n`);
        swept.push(abandoned);
      } catch (err) {
        out(`could not sweep abandoned pre-sync backup ${abandoned}: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
  }
  return swept;
}

// `sync()` returned without throwing — which is NOT the same as "the install
// worked", and treating the two as equivalent is what permanently deleted
// working installs. Every command that could repopulate a quarantined cache
// runs with allowFailure (they fail routinely on a re-run — see the header), so
// a sync can return perfectly cleanly having written nothing at all; the real
// `cursor` and `codex` units could not repopulate their quarantined cache under
// ANY circumstances, and neither one's verify() inspected it.
//
// So the backup is released only once the dir is back and non-empty. Otherwise
// it is restored and the host is reported as a problem: a stale install is the
// outcome this quarantine exists to allow, no install at all is strictly worse
// than stale, and the difference has to reach the user.
//
// Releasing a backup still never fails a sync: a leftover `.presync-*` dir is
// inert disk litter, not a broken install, so only that step is logged and
// swallowed, and a later run's sweepStalePresyncBackups clears whatever
// survives.
//
// Returns null when every quarantined cache came back populated, else a
// description of the ones that did not.
export function commitQuarantine(quarantined: readonly CacheQuarantine[]): string | null {
  const problems: string[] = [];
  for (const entry of quarantined) {
    if (isPopulatedDir(entry.dir)) {
      try {
        rmrf(entry.backup);
      } catch (err) {
        out(`could not remove pre-sync backup ${entry.backup}: ${err instanceof Error ? err.message : String(err)} (safe to delete by hand)\n`);
      }
      continue;
    }
    const state = fs.existsSync(entry.dir) ? 'empty' : 'missing';
    const restoreProblem = restoreQuarantine([entry]);
    problems.push(restoreProblem
      ? `sync() left ${entry.dir} ${state} — ${restoreProblem}`
      : `sync() returned but left ${entry.dir} ${state}, so this host would have had no install at all`
        + ' — the pre-sync copy was restored, untouched (this host is stale, not broken)');
  }
  return problems.length ? problems.join('; ') : null;
}

// Put every quarantined cache back exactly as it was found, discarding whatever
// the sync left at that path, so this host is left no worse than before the
// attempt. Called when `sync()` threw, and from commitQuarantine when it
// returned without repopulating. Returns null when every cache was restored;
// otherwise a message naming the backup path the user can move back by hand —
// the backup itself is never deleted on this path, so a failed restore never
// loses data, it only requires a manual last step.
export function restoreQuarantine(quarantined: readonly CacheQuarantine[]): string | null {
  const failures: string[] = [];
  for (const { dir, backup } of quarantined) {
    try {
      rmrf(dir);
      fs.renameSync(backup, dir);
      out(`restored ${dir} from its pre-sync backup: the sync left no install there\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      out(`could not restore ${dir}: ${message} — its pre-sync backup is untouched at ${backup}\n`);
      failures.push(`could not restore ${dir} (${message}); its pre-sync backup is intact — move it back by hand: mv "${backup}" "${dir}"`);
    }
  }
  return failures.length ? failures.join('; ') : null;
}

// Runs the whole selection in TWO passes instead of interleaving sync+verify
// per host:
//
//   Pass 1 — quarantine, sync(), commit-or-restore, per host.
//
//   Pass 2 — verify() every host pass 1 TOUCHED, only after every unit in
//   the selection has finished mutating shared state.
//
// This split matters because a host's verify() can depend on filesystem
// state another unit's sync() owns: verifyClaude()'s cursorLocal() check
// reports a duplicate that only the `cursor` unit's sync() removes (see its
// comment). `requires` (`SyncUnit.requires`) has NO bearing on this — it only
// orders sync() prerequisites (cursor requires claude to sync first so its
// own install has something to import), and pass 1 already honours that
// because callers pass selections built by `expandSelection`, which returns
// dependencies before dependents. The claude→cursor read happens in the
// OPPOSITE direction (a dependent's sync fixing up state its dependency's
// verify inspects), which `requires` cannot express and pass 1's ordering
// does not help with. Deferring every verify() to a second pass that starts
// only after ALL of pass 1 is done fixes it independent of any `requires`
// edge, because by then every host's sync-time side effects are already
// final. Exported with an injectable `hosts` map (default: the real `HOSTS`)
// so the pass split itself — not just the pure quarantine helpers — can be
// exercised with fake units that throw or race on demand.
//
// The two returned lists answer two DIFFERENT questions and must not be one
// list (they were, and it was wrong in both directions):
//
//   `mutated` — "whose session is now stale?". Appended BEFORE the first
//   state-changing call for that host, so a sync() that throws PART WAY
//   still lands here. Under-reporting this is the dangerous error: a host
//   that is not named in the restart instruction keeps running the old
//   bundle and silently stops enforcing every gate. Over-reporting it costs
//   one unnecessary restart, so this list is deliberately conservative.
//
//   `synced` — "who is actually serving this version?". Decided from
//   verify()'s observed filesystem state, ANDed with pass 1 completing.
//   "sync() didn't throw" cannot answer it: the marketplace-add commands run
//   with `allowFailure` because they fail routinely on a re-run (see the
//   header), so a completely no-op sync returns cleanly. verify() alone
//   cannot answer it either — a host whose quarantine failed may already
//   have had a same-version (but stale) cache on disk, which is the exact
//   local-dev case the quarantine exists for.
export function runSelection(
  selection: readonly HostId[],
  version: string,
  hosts: Record<HostId, SyncUnit> = HOSTS,
): { problems: string[]; synced: HostId[]; mutated: HostId[] } {
  const problems: string[] = [];
  const synced: HostId[] = [];
  const mutated: HostId[] = [];
  const completed: HostId[] = [];

  // Before anything else touches disk: clear pre-sync backups an earlier run
  // was killed before it could resolve. EVERY known host, not just this
  // selection — a crashed `--host=codex` leaves a backup that no later
  // `--host=claude` run would ever revisit, and nothing else in the system
  // sweeps it, so a single-host sweep means those copies accumulate forever.
  // `unstageableCaches` is swept too: this command no longer stages those dirs,
  // but earlier versions did, so their backups still exist in the field.
  //
  // Driven off the injected `hosts` map (the real HOSTS by default), so a test's
  // fake units keep the sweep inside their own temp dirs instead of reaching
  // into $HOME.
  for (const id of HOST_IDS) {
    const unit = hosts[id];
    sweepStalePresyncBackups([...unit.caches, ...(unit.unstageableCaches ?? [])]);
  }

  for (const id of selection) {
    const unit = hosts[id];
    if (!unit.available()) {
      out(`\n>> ${id}: skipped (not installed)\n`);
      continue;
    }
    // Everything past this line can change this host's on-disk state, so the
    // restart claim is recorded first — including for the paths below that
    // report a failure and `continue`.
    mutated.push(id);
    // Quarantine (not delete) before sync: sync() needs the empty path, and
    // this host is rolled back whenever the install did not land — sync()
    // throwing, or returning without repopulating the dir. A verify() problem
    // is reported as-is; see the `caches` doc on SyncUnit for why rolling back
    // on verify would be worse, not safer.
    const { quarantined, error: quarantineError } = quarantineCachesFor(id, unit.caches);
    if (quarantineError) {
      // All-hosts mode reports every broken host instead of stopping at the first.
      problems.push(`${id}: ${quarantineError}`);
      continue;
    }
    let syncError: string | null = null;
    try {
      unit.sync(version);
    } catch (err) {
      syncError = err instanceof Error ? err.message : String(err);
    }
    if (syncError) {
      const restoreProblem = restoreQuarantine(quarantined);
      const suffix = quarantined.length === 0
        ? ''
        : (restoreProblem ? ` — ${restoreProblem}` : ' — previous install restored, untouched');
      problems.push(`${id}: ${syncError}${suffix}`);
      continue;
    }
    // sync() returning is not proof it installed anything: a cache it was
    // supposed to repopulate and did not is a host with NO install, which must
    // be reported (and rolled back) rather than counted as completed.
    const commitProblem = commitQuarantine(quarantined);
    if (commitProblem) {
      problems.push(`${id}: ${commitProblem}`);
      continue;
    }
    completed.push(id);
  }

  // Pass 2: verify every host pass 1 touched, not just the ones that got
  // through it. A host dropped from pass 1 is exactly the one whose state a
  // LATER unit may still have changed — cursor's sync() mutates the shared
  // user-scope bundle claude's verify() inspects — so skipping it would make
  // the two-pass split conditional on the failure that most needs it.
  for (const id of mutated) {
    const verifyProblem = hosts[id].verify(version);
    if (verifyProblem) problems.push(`${id}: ${verifyProblem}`);
    else if (completed.includes(id)) synced.push(id);
  }

  return { problems, synced, mutated };
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

  try {
    pluginBuild();
  } catch (err) {
    flushSink();
    process.stdout.write(`\nsync ABORTED: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  out(`\nsync ${version} from ${DIST}\n`);

  const { problems, synced, mutated } = runSelection(selection, version);

  if (problems.length === 0) {
    if (quiet && target.host) {
      discardSink();
      process.stdout.write(`${successLine(target.host, version)}\n`);
      if (mutated.length > 0) process.stdout.write(`${restartLine(mutated)}\n`);
    } else {
      if (mutated.length > 0) out(`\n${restartLine(mutated)}\n`);
      out('DONE\n');
    }
    return 0;
  }

  flushSink();
  process.stdout.write(`\nsync FAILED (${problems.length}):\n`);
  for (const problem of problems) process.stdout.write(`  - ${problem}\n`);
  const unverified = mutated.filter((id) => !synced.includes(id));
  if (unverified.length > 0) {
    process.stdout.write(`\nnot serving v${version}: ${unverified.join(', ')}\n`);
  }
  // Named, not just implied: a failed run can leave a full copy of a plugin
  // cache beside the live one, and until now no message ever told the user
  // what to look for. A later run sweeps these automatically once they are an
  // hour old.
  process.stdout.write(
    'Pre-sync backups of the caches above are kept as `<cache-dir>.presync-<pid>-<epoch-ms>`;'
    + ' a later sync sweeps any older than an hour, and they are safe to delete by hand.\n',
  );
  // The restart claim covers everything that was TOUCHED, including hosts
  // whose sync failed part way: those sessions are stale too, and saying
  // nothing about them is how a gate silently stops running.
  if (mutated.length > 0) {
    process.stdout.write(`\n${restartLine(mutated)}\n`);
  }
  return 1;
}

// Buffered stdout to a pipe drains asynchronously, so process.exit() here would
// truncate the replayed transcript. Setting exitCode lets it flush normally.
if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
