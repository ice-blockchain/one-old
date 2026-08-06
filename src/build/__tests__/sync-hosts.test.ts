import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HostId } from '../../core/types';
import {
  HOSTS,
  HOST_IDS,
  HOST_LABELS,
  STALE_PRESYNC_MS,
  UsageError,
  detectTerminalHost,
  expandSelection,
  isPidAlive,
  parseArgs,
  quarantineCachesFor,
  resolveTargetHost,
  restartLine,
  restoreQuarantine,
  runHostCommand,
  runSelection,
  successLine,
  sweepStalePresyncBackups,
} from '../sync-hosts';
import type { SyncUnit } from '../sync-hosts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const E = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t1-sync-hosts-${prefix}-`));
}

// A SyncUnit that never runs — fills out the unused slots of the `hosts` map
// `runSelection` requires, so a test can override just the one or two units
// it cares about without hand-typing all seven HostIds every time.
function noopUnit(): SyncUnit {
  return { requires: [], caches: [], available: () => false, sync: () => {}, verify: () => null };
}

function fakeHosts(overrides: Partial<Record<HostId, SyncUnit>>): Record<HostId, SyncUnit> {
  const all = {} as Record<HostId, SyncUnit>;
  for (const id of HOST_IDS) all[id] = noopUnit();
  return { ...all, ...overrides };
}

// HOST_IDS is a hand-maintained mirror of the HostId union — the type cannot
// reach into a runtime array, so this is the only thing keeping them equal.
test('HOST_IDS matches the HostId union in src/core/types.ts', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'core', 'types.ts'), 'utf8');
  const declaration = /export type HostId =([^;]+);/.exec(source);
  assert.ok(declaration, 'could not find the HostId declaration');
  const fromType = [...declaration[1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...HOST_IDS].sort(), fromType.sort());
});

test('every host has a display label', () => {
  for (const id of HOST_IDS) {
    assert.equal(typeof HOST_LABELS[id], 'string');
    assert.ok(HOST_LABELS[id].length > 0, `${id} has no label`);
  }
});

test('the success line is byte-exact', () => {
  assert.equal(
    successLine('cursor', '1.0.55'),
    'traffic one plugin was successfully synced to v1.0.55 on your Cursor',
  );
  assert.equal(
    successLine('claude', '1.0.55'),
    'traffic one plugin was successfully synced to v1.0.55 on your Claude Code',
  );
});

test('--host= is accepted for every known host, in both spellings', () => {
  for (const id of HOST_IDS) {
    assert.equal(parseArgs([`--host=${id}`]).host, id);
    assert.equal(parseArgs(['--host', id]).host, id);
  }
});

test('--host beats TRAFFIC_ONE_HOST beats terminal markers', () => {
  const env = E({ TRAFFIC_ONE_HOST: 'cursor', CLAUDECODE: '1' });
  assert.equal(resolveTargetHost(parseArgs(['--host=codex']), env).host, 'codex');
  assert.equal(resolveTargetHost(parseArgs([]), env).host, 'cursor');
  assert.equal(resolveTargetHost(parseArgs([]), E({ CLAUDECODE: '1' })).host, 'claude');
});

test('an unknown host is a usage error, never a silent fall-through to all hosts', () => {
  assert.throws(() => parseArgs(['--host=bogus']), (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /unknown host "bogus"/);
    assert.match(err.message, /claude, codex, cursor/);
    return true;
  });
  assert.throws(() => resolveTargetHost(parseArgs([]), E({ TRAFFIC_ONE_HOST: 'bogus' })), UsageError);
});

test('unknown flags and --host with --all are usage errors', () => {
  assert.throws(() => parseArgs(['--nope']), UsageError);
  assert.throws(() => parseArgs(['--host=claude', '--all']), UsageError);
});

test('each marker row resolves to its host', () => {
  assert.equal(detectTerminalHost(E({ CLAUDECODE: '1' }))?.host, 'claude');
  assert.equal(detectTerminalHost(E({ CLAUDE_CODE_SESSION_ID: 'x' }))?.host, 'claude');
  assert.equal(detectTerminalHost(E({ CODEX_THREAD_ID: 'x' }))?.host, 'codex');
  assert.equal(detectTerminalHost(E({ CURSOR_TRACE_ID: 'x' }))?.host, 'cursor');
  assert.equal(detectTerminalHost(E({ WINDSURF_SESSION_ID: 'x' }))?.host, 'windsurf');
  assert.equal(detectTerminalHost(E({ OPENCODE_SESSION_ID: 'x' }))?.host, 'opencode');
  assert.equal(detectTerminalHost(E({ KILO_SESSION_ID: 'x' }))?.host, 'kilo');
  assert.equal(detectTerminalHost(E({ COPILOT_CLI_SESSION_ID: 'x' }))?.host, 'copilot');
});

test('an empty marker value does not count as detection', () => {
  assert.equal(detectTerminalHost(E({ CLAUDECODE: '' })), null);
  assert.equal(detectTerminalHost(E({ CLAUDECODE: '   ' })), null);
});

// Claude Code running inside Cursor's integrated terminal sets both hosts'
// markers; the CLI executing the command is the one that asked for the sync.
test('the agent CLI wins over the editor chrome it runs inside', () => {
  const both = E({ CLAUDECODE: '1', CURSOR_TRACE_ID: 'x' });
  assert.equal(detectTerminalHost(both)?.host, 'claude');
});

test('no markers means all hosts, not a defaulted claude', () => {
  assert.equal(detectTerminalHost(E()), null);
  const resolved = resolveTargetHost(parseArgs([]), E());
  assert.equal(resolved.host, null);
  assert.match(resolved.source, /no host detected/);
});

test('--all overrides a detected session', () => {
  assert.equal(resolveTargetHost(parseArgs(['--all']), E({ CLAUDECODE: '1' })).host, null);
});

test('cursor pulls in claude, once, in canonical order', () => {
  assert.deepEqual(expandSelection(['cursor']), ['claude', 'cursor']);
  assert.deepEqual(expandSelection(['claude', 'cursor']), ['claude', 'cursor']);
  assert.deepEqual(expandSelection(['cursor', 'claude']), ['claude', 'cursor']);
});

test('every other host selects only itself', () => {
  for (const id of HOST_IDS) {
    if (id === 'cursor') continue;
    assert.deepEqual(expandSelection([id]), [id]);
  }
});

test('selecting everything yields each host exactly once', () => {
  const all = expandSelection(HOST_IDS);
  assert.deepEqual(all, [...HOST_IDS]);
  assert.equal(new Set(all).size, all.length);
});

test('the restart line is byte-exact', () => {
  assert.equal(
    restartLine(['claude']),
    [
      '>>> RESTART REQUIRED: Claude Code',
      "Claude Code loaded Traffic One's hook wiring at startup and will not pick it up until it restarts.",
      'Restart it now, before starting a new session — otherwise every Traffic One gate silently stops running.',
    ].join('\n'),
  );
  assert.equal(
    restartLine(['claude', 'cursor']),
    [
      '>>> RESTART REQUIRED: Claude Code, Cursor',
      "Claude Code, Cursor loaded Traffic One's hook wiring at startup and will not pick it up until it restarts.",
      'Restart it now, before starting a new session — otherwise every Traffic One gate silently stops running.',
    ].join('\n'),
  );
});

test('a throwing sync() restores the quarantined cache byte-for-byte and leaves no .presync-* dir', () => {
  const root = tmp('throw');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'original content', 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'nested', 'inner.txt'), 'nested content', 'utf8');

    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => {
          // A realistic partial write before the throw — the whole point of
          // the rollback is to discard exactly this.
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'partial garbage from a failed sync');
          throw new Error('boom');
        },
        verify: () => null,
      },
    });

    const { problems, synced, mutated } = runSelection(['claude'], '9.9.9', hosts);

    assert.deepEqual(synced, []);
    // ...but the session IS stale: sync() ran, wrote, and only then threw.
    // Leaving claude out of the restart instruction is how a host keeps
    // serving the old bundle with every gate silently disabled.
    assert.deepEqual(mutated, ['claude']);
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^claude: boom — previous install restored, untouched$/);

    assert.equal(fs.readFileSync(path.join(cacheDir, 'file.txt'), 'utf8'), 'original content');
    assert.equal(fs.readFileSync(path.join(cacheDir, 'nested', 'inner.txt'), 'utf8'), 'nested content');
    assert.deepEqual(fs.readdirSync(root), ['cache']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// This fake REPOPULATES the cache, which is what `claude plugin install` does —
// and, for a long time, the only shape any quarantine test had. Every real
// non-claude unit violates that assumption, so the two tests below cover the
// shape those units actually have.
test('a successful sync() commits the quarantine and leaves no .presync-* dir behind', () => {
  const root = tmp('commit');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'old version', 'utf8');

    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => {
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'new version');
        },
        verify: () => null,
      },
    });

    const { problems, synced, mutated } = runSelection(['claude'], '9.9.9', hosts);

    assert.deepEqual(problems, []);
    assert.deepEqual(synced, ['claude']);
    assert.deepEqual(mutated, ['claude']);
    assert.equal(fs.readFileSync(path.join(cacheDir, 'file.txt'), 'utf8'), 'new version');
    assert.deepEqual(fs.readdirSync(root), ['cache']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The real `cursor` and `codex` units, in the one respect that mattered:
// sync() does not throw, and nothing in it writes the cache that was
// quarantined (syncCursor toggles sqlite state and removes cursorLocal();
// syncCodex rsyncs to the marketplace dir and reaches codexCache() only through
// an allowFailure `codex plugin add`). verify() looks at a DIFFERENT path and so
// still comes back clean. That combination used to delete a working install and
// report `synced` with zero problems.
test('a non-throwing sync() that cannot repopulate its quarantined cache is a reported problem, not a silent deletion', () => {
  const root = tmp('no-repopulate');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(path.join(cacheDir, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'a working install', 'utf8');
    fs.writeFileSync(path.join(cacheDir, 'nested', 'inner.txt'), 'nested content', 'utf8');

    const hosts = fakeHosts({
      cursor: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => { /* mutates other state entirely; never writes cacheDir */ },
        verify: () => null,
      },
    });

    const { problems, synced, mutated } = runSelection(['cursor'], '9.9.9', hosts);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^cursor: sync\(\) returned but left .*cache missing, so this host would have had no install at all/);
    assert.match(problems[0]!, /restored, untouched \(this host is stale, not broken\)$/);
    // A host with no install must never be reported as serving the version...
    assert.deepEqual(synced, []);
    // ...but its session is stale either way, so the restart claim still stands.
    assert.deepEqual(mutated, ['cursor']);

    // The install is back, byte-for-byte, and the backup is gone (restored, not
    // left as litter the user has to find).
    assert.equal(fs.readFileSync(path.join(cacheDir, 'file.txt'), 'utf8'), 'a working install');
    assert.equal(fs.readFileSync(path.join(cacheDir, 'nested', 'inner.txt'), 'utf8'), 'nested content');
    assert.deepEqual(fs.readdirSync(root), ['cache']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The same failure one step further along: a host CLI that creates its cache
// directory and then fails to fill it. `existsSync` alone would call that a
// success and drop the only copy of the previous install.
test('a cache the sync recreated but left EMPTY counts as no install and is rolled back', () => {
  const root = tmp('empty-after-sync');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'a working install', 'utf8');

    const hosts = fakeHosts({
      codex: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => { fs.mkdirSync(cacheDir, { recursive: true }); },
        verify: () => null,
      },
    });

    const { problems, synced } = runSelection(['codex'], '9.9.9', hosts);

    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^codex: sync\(\) returned but left .*cache empty, so this host would have had no install at all/);
    assert.deepEqual(synced, []);
    assert.equal(fs.readFileSync(path.join(cacheDir, 'file.txt'), 'utf8'), 'a working install');
    assert.deepEqual(fs.readdirSync(root), ['cache']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The structural half of the same defect, asserted against the REAL units
// instead of fakes: a dir may only be staged by the unit whose own sync() puts
// it back. Neither of these two can, at all, under any circumstances — so
// re-adding them to `caches` must fail here rather than in the field, where the
// symptom is a deleted install reported as a success.
test('no real unit stages a cache its own sync() cannot repopulate', () => {
  assert.deepEqual(HOSTS.cursor.caches, [], 'syncCursor never writes cursorCache()');
  assert.deepEqual(HOSTS.codex.caches, [], 'syncCodex reaches codexCache() only through an allowFailure command');
  // Still named, so the sweep keeps visiting them: earlier versions DID stage
  // these, so a `.presync-*` copy of a real install can exist there today.
  const unstageable = (id: HostId): string[] => (HOSTS[id].unstageableCaches ?? []).map((of) => of());
  assert.match(unstageable('cursor')[0] ?? '', /\.cursor\/plugins\/cache\/traffic-one\/traffic-one$/);
  assert.match(unstageable('codex')[0] ?? '', /\.codex\/plugins\/cache\/traffic-one-local\/traffic-one$/);
  // claude is the one host whose sync (`claude plugin install`, the only
  // non-allowFailure command in it) does repopulate, so it keeps staging.
  assert.equal(HOSTS.claude.caches.length, 1);
  assert.match(HOSTS.claude.caches[0]!(), /\.claude\/plugins\/cache\/traffic-one\/traffic-one$/);
  assert.equal(HOSTS.claude.unstageableCaches, undefined);
});

test('a renameSync failure during quarantine is reported for that host and lets the rest of the selection proceed', () => {
  const root = tmp('renamefail');
  try {
    const lockedParent = path.join(root, 'locked');
    const cacheDir = path.join(lockedParent, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'x', 'utf8');
    // No write bit on the parent: renameSync(cacheDir, backup) must fail, since
    // the backup is a new sibling entry in this same directory.
    fs.chmodSync(lockedParent, 0o555);

    let codexRan = false;
    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => { throw new Error('claude sync must never run when its quarantine failed'); },
        verify: () => null,
      },
      codex: {
        requires: [], caches: [], available: () => true,
        sync: () => { codexRan = true; },
        verify: () => null,
      },
    });

    try {
      const { problems, synced, mutated } = runSelection(['claude', 'codex'], '9.9.9', hosts);
      assert.equal(problems.length, 1);
      assert.match(problems[0]!, /^claude: could not clear .*cache before sync \(.*\) — left untouched$/);
      // claude never completed pass 1, so it cannot claim to be serving the
      // version — even though its (fake) verify() is clean, which is exactly
      // the same-version stale cache the quarantine exists to defeat.
      assert.deepEqual(synced, ['codex']);
      assert.deepEqual(mutated, ['claude', 'codex']);
      assert.equal(codexRan, true);
    } finally {
      fs.chmodSync(lockedParent, 0o755);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a restore failure reports honestly and names the manual recovery command instead of losing data', () => {
  const root = tmp('restorefail');
  try {
    const parent = path.join(root, 'parent');
    const dir = path.join(parent, 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'file.txt'), 'irreplaceable original', 'utf8');

    const { quarantined, error } = quarantineCachesFor('claude', [() => dir]);
    assert.equal(error, null);
    assert.equal(quarantined.length, 1);
    const { backup } = quarantined[0]!;
    assert.equal(fs.existsSync(backup), true);

    // Simulate sync() having recreated `dir` with partial output before it
    // threw, then take away write access to `parent` so restoreQuarantine's
    // rmrf(dir) + renameSync(backup, dir) cannot complete.
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'garbage.txt'), 'partial', 'utf8');
    fs.chmodSync(parent, 0o555);
    let result: string | null;
    try {
      result = restoreQuarantine(quarantined);
    } finally {
      fs.chmodSync(parent, 0o755);
    }

    assert.ok(result, 'expected restoreQuarantine to report a failure, not swallow it');
    assert.ok(result!.includes(`mv "${backup}" "${dir}"`), `expected a manual recovery command, got: ${result}`);
    // The backup itself is never touched on a failed restore — no data lost.
    assert.equal(fs.existsSync(backup), true);
    assert.equal(fs.readFileSync(path.join(backup, 'file.txt'), 'utf8'), 'irreplaceable original');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The Blocker-1 scenario: `--host=cursor` with a pre-existing cursorLocal()
// duplicate is exactly the migration this command exists to run. claude syncs
// first (canonical `requires` order), cursor's sync then removes the
// duplicate verifyClaude would otherwise flag — but only pass 2, which runs
// after every pass-1 sync in the selection, sees that final state.
test('claude appears in the restart instruction even though cursor is the one that resolves what claude verify would flag mid-run', () => {
  const root = tmp('claude-cursor');
  try {
    const cursorLocalStandIn = path.join(root, 'cursor-local');
    fs.mkdirSync(cursorLocalStandIn, { recursive: true });

    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [], available: () => true,
        sync: () => {},
        verify: () => (fs.existsSync(cursorLocalStandIn)
          ? `a Cursor local install shadows this one and will double every hook: ${cursorLocalStandIn}`
          : null),
      },
      cursor: {
        requires: ['claude'], caches: [], available: () => true,
        sync: () => { fs.rmSync(cursorLocalStandIn, { recursive: true, force: true }); },
        verify: () => null,
      },
    });

    const { problems, synced, mutated } = runSelection(['claude', 'cursor'], '9.9.9', hosts);

    // Bonus, not the goal: the pre-existing false FAILED is gone too, because
    // verify now runs after cursor's sync instead of before it.
    assert.deepEqual(problems, []);
    assert.deepEqual(synced, ['claude', 'cursor']);
    const restart = restartLine(mutated);
    assert.match(restart, /Claude Code/);
    assert.match(restart, /Cursor/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The same claude←cursor read as above, but with claude's sync THROWING.
// Pass 2 used to iterate the hosts that got through pass 1, so claude's
// verify never ran — even though cursor then went on to mutate the very
// user-scope state that verify inspects. The two-pass split existed to catch
// cross-host interference and was skipped for the host most exposed to it.
test('a host whose sync throws is still verified in pass 2, after later hosts have finished mutating shared state', () => {
  const root = tmp('verify-after-throw');
  try {
    const cursorLocalStandIn = path.join(root, 'cursor-local');
    fs.mkdirSync(cursorLocalStandIn, { recursive: true });
    let claudeVerified = false;

    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [], available: () => true,
        sync: () => { throw new Error('claude install failed'); },
        verify: () => {
          claudeVerified = true;
          return fs.existsSync(cursorLocalStandIn) ? 'a Cursor local install shadows this one' : null;
        },
      },
      cursor: {
        requires: ['claude'], caches: [], available: () => true,
        sync: () => { fs.rmSync(cursorLocalStandIn, { recursive: true, force: true }); },
        verify: () => null,
      },
    });

    const { problems, synced, mutated } = runSelection(['claude', 'cursor'], '9.9.9', hosts);

    assert.equal(claudeVerified, true, 'claude must be verified even though its sync threw');
    assert.deepEqual(problems, ['claude: claude install failed']);
    assert.deepEqual(synced, ['cursor'], 'a host whose sync threw never claims to be serving the version');
    assert.deepEqual(mutated, ['claude', 'cursor'], 'both sessions are stale and must be restarted');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a host that completes sync but fails verify is stale-but-unproven: restart yes, `synced` no', () => {
  const hosts = fakeHosts({
    claude: {
      requires: [], caches: [], available: () => true,
      sync: () => {},
      verify: () => 'claude cache is missing 9.9.9',
    },
  });

  const { problems, synced, mutated } = runSelection(['claude'], '9.9.9', hosts);

  // `synced` answers "is it serving 9.9.9?" from verify()'s observed state,
  // not from "sync() didn't throw" — the marketplace-add commands run with
  // allowFailure, so a completely no-op sync also returns cleanly.
  assert.deepEqual(synced, []);
  assert.deepEqual(mutated, ['claude']);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /^claude: claude cache is missing 9\.9\.9$/);
});

test('a host skipped as unavailable is neither a problem nor named in the restart instruction', () => {
  const hosts = fakeHosts({
    claude: {
      requires: [], caches: [], available: () => false,
      sync: () => { throw new Error('must never be called for an unavailable host'); },
      verify: () => { throw new Error('must never be called for an unavailable host'); },
    },
    codex: {
      requires: [], caches: [], available: () => true,
      sync: () => {}, verify: () => null,
    },
  });

  const { problems, synced, mutated } = runSelection(['claude', 'codex'], '9.9.9', hosts);

  assert.deepEqual(problems, []);
  assert.deepEqual(synced, ['codex']);
  assert.deepEqual(mutated, ['codex']);
  assert.doesNotMatch(restartLine(mutated), /Claude Code/);
});

// `pidAlive` is injected as `() => false` throughout: with the real check, this
// test's verdict would depend on whether pid 4242 happens to exist on the
// machine running it. The real check gets its own test below.
test('an abandoned .presync-* backup is swept once it is an hour old, and never before', () => {
  const root = tmp('presync-sweep');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = Date.now();
    // A SIGKILL between renameSync and commitQuarantine leaves exactly this.
    const abandoned = path.join(root, `cache.presync-4242-${now - STALE_PRESYNC_MS - 1}`);
    const fresh = path.join(root, `cache.presync-4243-${now - 1000}`);
    // Not ours: no parseable timestamp, so its age is unknowable — never delete.
    const foreign = path.join(root, 'cache.presync-handwritten');
    for (const dir of [abandoned, fresh, foreign]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'file.txt'), 'x', 'utf8');
    }

    const swept = sweepStalePresyncBackups([() => cacheDir], now, () => false);

    assert.deepEqual(swept, [abandoned]);
    assert.equal(fs.existsSync(abandoned), false);
    assert.equal(fs.existsSync(fresh), true, 'a concurrent sync of the same host must never be swept out from under');
    assert.equal(fs.existsSync(foreign), true);
    assert.equal(fs.existsSync(cacheDir), true, 'the live cache is not a backup');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Age alone said "abandoned", and a `claude plugin install` slower than the
// window is unusual rather than impossible — so an age-only rule let one run
// delete another LIVE run's only rollback copy, which is the exact data loss
// the quarantine exists to prevent. Both conditions now, and this uses the real
// isPidAlive with this process's own pid, which is alive by definition.
test('a backup whose creating sync is still running is never swept, however old', () => {
  const root = tmp('presync-live-pid');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const now = Date.now();
    const live = path.join(root, `cache.presync-${process.pid}-${now - STALE_PRESYNC_MS * 24}`);
    fs.mkdirSync(live, { recursive: true });
    fs.writeFileSync(path.join(live, 'file.txt'), 'the only copy of a live run\'s install', 'utf8');

    assert.deepEqual(sweepStalePresyncBackups([() => cacheDir], now), []);
    assert.equal(fs.readFileSync(path.join(live, 'file.txt'), 'utf8'), 'the only copy of a live run\'s install');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('isPidAlive answers for a real running process and for one that cannot exist', () => {
  assert.equal(isPidAlive(process.pid), true);
  // A permission error means somebody else owns the pid — alive, not dead.
  assert.equal(isPidAlive(1), true, 'pid 1 always exists (EPERM must not read as dead)');
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(Number.NaN), false);
});

test('runSelection sweeps stale pre-sync backups before touching anything', () => {
  const root = tmp('presync-startup');
  try {
    const cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const abandoned = path.join(root, `cache.presync-4242-${Date.now() - STALE_PRESYNC_MS - 1}`);
    fs.mkdirSync(abandoned, { recursive: true });

    let sweptBeforeSync = false;
    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [() => cacheDir], available: () => true,
        sync: () => {
          sweptBeforeSync = !fs.existsSync(abandoned);
          fs.mkdirSync(cacheDir, { recursive: true });
          fs.writeFileSync(path.join(cacheDir, 'file.txt'), 'new version');
        },
        verify: () => null,
      },
    });

    runSelection(['claude'], '9.9.9', hosts);

    assert.equal(sweptBeforeSync, true);
    assert.equal(fs.existsSync(abandoned), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A crashed `--host=codex` leaves a backup beside codex's cache. Sweeping only
// the SELECTION means no later `--host=claude` run ever revisits it, and nothing
// else in the system does either — so those copies accumulated forever, holding
// a full plugin cache each. `unstageableCaches` is swept too: this command no
// longer stages those dirs, but earlier versions did, so their backups are on
// maintainers' machines right now.
test('the startup sweep visits every known host, including hosts outside the selection and dirs no longer staged', () => {
  const root = tmp('presync-all-hosts');
  try {
    const stamp = Date.now() - STALE_PRESYNC_MS - 1;
    const make = (name: string): { cache: string; backup: string } => {
      const cache = path.join(root, name);
      fs.mkdirSync(cache, { recursive: true });
      const backup = path.join(root, `${name}.presync-4242-${stamp}`);
      fs.mkdirSync(backup, { recursive: true });
      return { cache, backup };
    };
    const claude = make('claude-cache');
    const codex = make('codex-cache');
    const cursor = make('cursor-cache');

    const hosts = fakeHosts({
      claude: {
        requires: [], caches: [() => claude.cache], available: () => true,
        sync: () => { fs.writeFileSync(path.join(claude.cache, 'file.txt'), 'new version'); },
        verify: () => null,
      },
      // Not selected below, and stages nothing — exactly the real codex unit.
      codex: {
        requires: [], caches: [], unstageableCaches: [() => codex.cache], available: () => true,
        sync: () => {}, verify: () => null,
      },
      cursor: {
        requires: [], caches: [], unstageableCaches: [() => cursor.cache], available: () => true,
        sync: () => {}, verify: () => null,
      },
    });

    runSelection(['claude'], '9.9.9', hosts);

    assert.equal(fs.existsSync(claude.backup), false);
    assert.equal(fs.existsSync(codex.backup), false, 'a crashed --host=codex run left this; no later run ever revisited it');
    assert.equal(fs.existsSync(cursor.backup), false, 'staged by an earlier version of this command, so it still needs sweeping');
    for (const live of [claude.cache, codex.cache, cursor.cache]) {
      assert.equal(fs.existsSync(live), true, 'the live cache is not a backup');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// No host CLI had any timeout, while the cache it was installing into sat
// quarantined: a hung `claude plugin install` hung `plugin:sync` forever, and
// once it outlived STALE_PRESYNC_MS a concurrent run's sweep was entitled to
// delete its only rollback copy.
test('a host command that does not finish in time is killed and reported, and allowFailure does not swallow it', () => {
  assert.throws(
    () => runHostCommand('hang', ['sleep', '30'], { timeoutMs: 250 }),
    /hang did not finish within 250ms and was killed/,
  );
  // allowFailure exists for commands that fail routinely and harmlessly on a
  // re-run ("marketplace already exists"); a killed-on-timeout command has not
  // failed in that sense, it stopped mid-flight with the cache still staged.
  assert.throws(
    () => runHostCommand('hang', ['sleep', '30'], { timeoutMs: 250, allowFailure: true }),
    /hang did not finish within 250ms and was killed/,
  );
  // Control: a fast non-zero exit is still exactly what allowFailure is for.
  assert.equal(runHostCommand('exit 3', ['sh', '-c', 'exit 3'], { allowFailure: true }).status, 3);
});
