import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  HOST_IDS,
  HOST_LABELS,
  UsageError,
  detectTerminalHost,
  expandSelection,
  parseArgs,
  resolveTargetHost,
  successLine,
} from '../sync-hosts';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const E = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...over });

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
