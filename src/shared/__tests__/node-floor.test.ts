// src/shared/node-floor.ts declares the Node major this plugin supports and
// emits the guard that says so at run time. Three properties are worth holding,
// and only one of them is about the number:
//
//   1. THE NUMBER IS NOT A SECOND OPINION. package.json's `engines.node` is the
//      product's statement of support; a constant in src/ that drifted from it
//      would enforce a floor the package does not declare, which is worse than
//      enforcing nothing. tests/readme-claims.test.ts already pins the README's
//      prose to `engines` this way; this pins the code.
//   2. THE GUARD PARSES UNDER THE RUNTIME IT JUDGES. A file is parsed whole
//      before its first statement runs, so a check written in newer syntax than
//      the floor never executes on the machine that needs it — the module dies
//      with a SyntaxError instead. Asserted as a token ban plus a real parse.
//   3. IT WARNS AND NEVER REFUSES. In this codebase a thrown hook handler
//      becomes a non-overridable `pipeline-handler-crashed` deny
//      (core/pipeline.ts), and a launcher that exits early emits no stdout,
//      which hosts read as "no verdict" — every gate silently off. So the
//      launcher must still run the target after warning, and that is measured
//      end to end below rather than reasoned about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

import { NODE_FLOOR_MAJOR, nodeFloorGuardSource } from '../node-floor';
import { RUNNER_SHIMS, ensureRunnerShims, runnerShimDirs } from '../runner-shims';
import { SHIMS, writeShims } from '../../build/build-runtime';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP_PREFIX = 't1-lane-nodefloor-';

// A preload that makes a child process CLAIM to be an old Node. The guard reads
// process.versions.node and nothing else, so this is the whole of the fixture —
// and it is a defineProperty rather than an assignment because plain assignment
// to process.versions.node is silently ignored (measured on the running
// runtime), which would make every case below vacuous.
function fakeVersionPreload(dir: string, version: string): string {
  const file = path.join(dir, `fake-node-${version}.js`);
  fs.writeFileSync(
    file,
    `Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });\n`,
    'utf8',
  );
  return file;
}

// The env a launcher sees on a user's machine, minus everything this suite's
// preload injected. Without this the child would inherit TRAFFIC_ONE_PLUGIN_ROOT
// pinned at the checkout and resolve real plugin code.
function bareEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

test('the enforced floor is package.json\'s declared engine range, not a second number', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
    engines?: { node?: string };
  };
  const declared = pkg.engines?.node;
  assert.ok(declared, 'package.json declares no engines.node, so there is no floor to track');
  const major = /(\d+)/.exec(declared)?.[1];
  assert.ok(major, `engines.node ${JSON.stringify(declared)} names no major version`);
  assert.equal(
    NODE_FLOOR_MAJOR,
    Number(major),
    `NODE_FLOOR_MAJOR is ${NODE_FLOOR_MAJOR} while package.json declares ${declared}`
      + ' — the launchers would warn about a floor the package does not promise',
  );
});

// Property 2. The token ban is the operative half: `new vm.Script` only proves
// the guard parses on the runtime running this suite, which is by definition NOT
// the runtime the guard exists for.
test('the emitted guard is ES5, so it parses on the old runtime it is judging', () => {
  const guard = nodeFloorGuardSource();
  assert.ok(guard.includes('process.versions.node'), 'the guard no longer reads the running version');

  for (const [label, pattern] of [
    ['const declarations', /\bconst\s/],
    ['let declarations', /\blet\s/],
    ['arrow functions', /=>/],
    ['template literals', /`/],
    ['spread/rest', /\.\.\./],
    ['optional chaining', /\?\./],
    ['nullish coalescing', /\?\?/],
    ['optional catch binding', /catch\s*\{/],
    ['exponentiation', /\*\*/],
    ['class syntax', /\bclass\s/],
    ['async/await', /\b(?:async|await)\b/],
  ] as const) {
    assert.doesNotMatch(guard, pattern, `the guard uses ${label}, which an old runtime cannot parse`);
  }

  // Non-ASCII would be inert here but the launchers it is stamped into are
  // otherwise pure ASCII; keep them so.
  assert.match(guard, /^[\x20-\x7e\n]*$/, 'the guard must stay ASCII, like the launchers it is stamped into');
  assert.doesNotThrow(() => new vm.Script(guard), 'the guard does not parse at all');
});

// Property 3, measured on the guard itself: below the floor it writes ONE stderr
// line naming the version, the floor and the GUI-PATH cause, exits 0, and writes
// nothing to stdout (a hook's stdout is its verdict channel).
test('below the floor the guard warns on stderr, names the GUI-PATH cause, and exits 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}guard-`));
  try {
    const guard = nodeFloorGuardSource();
    const old = String(NODE_FLOOR_MAJOR - 4);
    const preload = fakeVersionPreload(dir, `${old}.20.4`);

    const low = spawnSync(process.execPath, ['--require', preload, '-e', guard], { encoding: 'utf8', env: bareEnv() });
    assert.equal(low.status, 0, `the guard must never refuse: ${low.stderr}`);
    assert.equal(low.stdout, '', 'the guard must not write to a hook\'s verdict channel');
    assert.match(low.stderr, new RegExp(`Node ${old}\\.20\\.4`), 'the warning must name the version actually running');
    assert.match(low.stderr, new RegExp(`floor of Node ${NODE_FLOOR_MAJOR}`));
    assert.match(low.stderr, /nvm/, 'the warning must name the GUI-PATH cause a user can act on');
    assert.match(low.stderr, /relaunch it from a terminal/);
    assert.match(low.stderr, /doctor\.cjs/, 'the warning must name the diagnostic command');
    assert.match(low.stderr, /Continuing anyway/, 'the warning must say it did not block anything');

    // The control leg. Without it, "no warning at or above the floor" could be
    // true because the guard never runs at all.
    const high = spawnSync(process.execPath, ['-e', guard], { encoding: 'utf8', env: bareEnv() });
    assert.equal(high.status, 0);
    assert.equal(high.stderr, '', `a supported runtime must stay silent, got: ${high.stderr}`);
    assert.ok(
      Number(process.versions.node.split('.')[0]) >= NODE_FLOOR_MAJOR,
      `this suite runs on Node ${process.versions.node}, below the floor — the control leg above proves nothing`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The documentation half. tests/readme-claims.test.ts already pins the README's
// "Node.js 22 or newer" to `engines.node`; what it cannot see is the DIAGNOSTIC
// the same section tells a reader to look for. A finding code renamed in
// findings.ts would leave the README sending users hunting for a string doctor
// never prints — the exact failure mode that whole test file exists to prevent,
// one field over.
test('the doctor code the README tells a stuck user to look for is the code doctor emits', () => {
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
  const emitted = fs.readFileSync(path.join(REPO_ROOT, 'src', 'runners', 'doctor', 'findings.ts'), 'utf8');
  const quoted = [...readme.matchAll(/`(HOOK_RUNTIME_[A-Z_]+)`/g)].map((match) => match[1] as string);
  assert.ok(quoted.length > 0, 'the README no longer names the hook-runtime finding — did the Node section move?');
  for (const code of new Set(quoted)) {
    assert.ok(
      emitted.includes(`code: '${code}'`),
      `the README tells the reader to look for ${code}, which findings.ts does not emit`,
    );
  }
  // And the floor in the prose is the floor in the code, stated as a number the
  // reader will compare against `node -v`.
  assert.ok(
    readme.includes(`Node.js ${NODE_FLOOR_MAJOR} or newer`),
    `the README does not state the enforced floor of Node ${NODE_FLOOR_MAJOR}`,
  );
});

// ── placement: ahead of the require() that can fail to parse ─────────────────

// The hook launch chain is: host command (`node -e "… require(root/scripts/
// <name>.cjs)"`) → that shim → the compiled tree, which tsc emits at ES2022. The
// guard has to sit in the shim, ABOVE its require, or the SyntaxError from the
// compiled tree arrives first and the guard never runs.
test('every generated dist/scripts launcher carries the guard above its require of the compiled tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}dist-shims-`));
  try {
    const written = writeShims(dir);
    assert.equal(written.length, Object.keys(SHIMS).length, 'the fixture did not emit the full shim set');
    const guard = nodeFloorGuardSource();
    for (const name of written) {
      const body = fs.readFileSync(path.join(dir, name), 'utf8');
      const guardAt = body.indexOf(guard);
      assert.notEqual(guardAt, -1, `${name} does not carry the node floor guard`);
      assert.ok(guardAt < body.indexOf('require('), `${name} requires the compiled tree before checking the runtime`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every stable ~/.traffic-one/bin shim carries the guard above its first require', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}bin-shims-`));
  try {
    // ensureRunnerShims() writes to the machine state root, which the suite's
    // preload has already pinned to a per-process scratch dir; point it at this
    // case's own dir so nothing is shared with a sibling test file.
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = dir;
    try {
      const result = ensureRunnerShims();
      assert.ok(runnerShimDirs().includes(result.dir));
      const guard = nodeFloorGuardSource();
      for (const { shim } of RUNNER_SHIMS) {
        const body = fs.readFileSync(path.join(result.dir, shim), 'utf8');
        const guardAt = body.indexOf(guard);
        assert.notEqual(guardAt, -1, `${shim} does not carry the node floor guard`);
        assert.ok(guardAt < body.indexOf('require('), `${shim} requires before checking the runtime`);
        assert.ok(body.startsWith('#!/usr/bin/env node\n'), `${shim} must stay directly executable`);
      }
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── end to end: an old runtime is TOLD, and still served ─────────────────────

// The property that separates a diagnostic from a lockout, on a real launcher
// rather than on the guard in isolation: the shim warns AND still runs the
// runner it was asked to run.
test('a stable shim on an unsupported runtime warns and still executes the runner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TMP_PREFIX}e2e-`));
  try {
    const state = path.join(dir, 'state');
    const pluginRoot = path.join(dir, 'plugin');
    const saved = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = state;
    let shimPath: string;
    try {
      shimPath = path.join(ensureRunnerShims().dir, 'doctor.cjs');
    } finally {
      if (saved === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved;
    }

    const rel = RUNNER_SHIMS.find((entry) => entry.shim === 'doctor.cjs')?.rel;
    assert.ok(rel, 'doctor.cjs is no longer a stable shim, so this case targets nothing');
    const target = path.join(pluginRoot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "process.stdout.write('RAN');\n", 'utf8');

    const old = `${NODE_FLOOR_MAJOR - 4}.20.4`;
    const preload = fakeVersionPreload(dir, old);
    const ran = spawnSync(process.execPath, ['--require', preload, shimPath], {
      encoding: 'utf8',
      env: bareEnv({ TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot }),
    });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, 'RAN', 'the shim refused to serve an old runtime instead of warning about it');
    assert.match(ran.stderr, new RegExp(`Node ${old.replace(/\./g, '\\.')}`));
    assert.match(ran.stderr, new RegExp(`floor of Node ${NODE_FLOOR_MAJOR}`));

    // Same shim, supported runtime: served with no warning at all.
    const quiet = spawnSync(process.execPath, [shimPath], {
      encoding: 'utf8',
      env: bareEnv({ TRAFFIC_ONE_PLUGIN_ROOT: pluginRoot }),
    });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.equal(quiet.stdout, 'RAN');
    assert.equal(quiet.stderr, '', `a supported runtime must stay silent, got: ${quiet.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
