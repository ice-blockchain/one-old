// src/runners/qa-evidence/__tests__/bounded-command-shim.test.ts
// WHICH FILE `runBoundedCommand` hands to `spawn` when the audit binary is a
// Windows batch shim.
//
// `projectLighthouseBin` selects `lighthouse.cmd` on win32 and nothing else, and
// node REFUSES that target: `IsWindowsBatchFile` in src/util-inl.h matches any
// file whose last extension is `cmd` or `bat`, and src/process_wrap.cc answers
// UV_EINVAL for it before libuv is reached (spawn_sync.cc does the same for the
// synchronous path, which is why shared/spawn-tool.ts exists). The check does not
// consult the shell option — `shell: true` escapes it only because the JS layer
// then makes cmd.exe the spawned FILE. So this spawn could not start an audit on
// Windows at all, and the EINVAL arrives at `runLighthouseOnOwnedServer`'s catch
// as text no branch of its regex matches: a `failed` performance run with a
// blocker naming a syscall.
//
// Reachable from POSIX the way __tests__/spawn-plan.test.ts reaches the same
// branch for the native path: the platform is a parameter, so the plan can be
// built for win32 from darwin without a `.cmd` file, a shell or a Windows box.
// What that proves here is the half a `.cmd` cannot survive — the spawned file
// is the SHELL rather than the shim — and it proves it from the spawn itself
// rather than from the plan, because the plan being right and the spawn using it
// are two claims. What it cannot prove is that Windows then executes the line
// correctly; that rests on it being spawn-tool's own line, which is the last
// test below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { escapeCmdArgument, escapeCmdCommand } from '../../../shared/spawn-tool';
import { runBoundedCommand } from '../lighthouse';
import { spawnPlan } from '../native-process';

/** The shell `spawnPlan` will name — read from the environment, as it does. */
const COMSPEC = process.env.ComSpec || 'cmd.exe';

// The audit's own argv, abbreviated to the two members that carry a Windows
// hazard: a flag whose VALUE contains a space, and an absolute output path.
const AUDIT_ARGV = [
  'http://127.0.0.1:4173/',
  '--chrome-flags=--headless --no-sandbox',
  '--output=json',
  '--output-path=C:\\proj\\.traffic-one\\runs\\r1\\qa\\lighthouse.raw.json',
  '--quiet',
];

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-qa-lh-shim-'));
}

/**
 * Ask for an audit that cannot possibly run, and report WHICH FILE libuv was
 * asked for.
 *
 * An absolute path with nothing behind it, so the win32 resolver keeps the name
 * it was given (its own branches are spawn-tool's, pinned there) and every row
 * below ends in the same ordinary ENOENT that `bounded-command-surface.test.ts`
 * already pins at the default platform. Nothing here could execute a `.cmd` if
 * one existed; the observable is the file NAME in that error.
 */
async function spawnFailure(
  binName: string,
  platform: NodeJS.Platform,
): Promise<{ message: string; binary: string }> {
  const dir = scratch();
  const binary = path.join(dir, 'node_modules', '.bin', binName);
  try {
    await runBoundedCommand(binary, AUDIT_ARGV, dir, 5_000, platform);
    return assert.fail('a binary that does not exist must reject rather than resolve');
  } catch (error) {
    assert.ok(error instanceof Error, `a rejection must be an Error, got ${typeof error}`);
    return { message: error.message, binary };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The FILE, which is the whole legality question.
 *
 * Read off a spawn that fails on purpose: nothing here can run cmd.exe, but the
 * ENOENT names the file libuv was asked for, and that name is the difference
 * between an audit that starts on Windows and a UV_EINVAL. A shim reaching
 * `spawn` unwrapped would leave `lighthouse.cmd` in this message.
 */
test('on win32 a .cmd audit binary is handed to the shell, never spawned as itself', async () => {
  const { message } = await spawnFailure('lighthouse.cmd', 'win32');
  assert.equal(message, `spawn ${COMSPEC} ENOENT`, 'the spawned file must be the shell');
  assert.doesNotMatch(
    message,
    /lighthouse\.cmd/,
    'the batch shim must not be the spawned file — node answers UV_EINVAL for one, whatever shell says',
  );
});

// `.CMD` upper-case, because Windows is case-insensitive and node's own check
// lower-cases the extension before comparing. A shim that escaped the extension
// test would be spawned directly and refused.
test('on win32 the extension test is case-insensitive, as node\'s own is', async () => {
  const { message } = await spawnFailure('lighthouse.CMD', 'win32');
  assert.equal(message, `spawn ${COMSPEC} ENOENT`);
});

/**
 * The POSIX side, unchanged and asserted so the win32 rows above cannot pass
 * vacuously.
 *
 * `spawnPlan` is a passthrough off win32, so the file spawned here is the
 * caller's own path — byte-identical to the `spawn(command, argv)` this function
 * did before the branch existed, which is the entire safety argument for adding
 * it. `bounded-command-surface.test.ts` pins the rest of that surface at the
 * default platform.
 */
test('off win32 the audit binary is spawned exactly as it came in', async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const { message, binary } = await spawnFailure('lighthouse', platform);
    assert.equal(message, `spawn ${binary} ENOENT`);
  }
});

/**
 * And the line the shell is given, for the argument that fails SILENTLY rather
 * than loudly: `--chrome-flags=--headless --no-sandbox` is one argv member
 * containing a space, so a line that let that space through would hand cmd.exe
 * two tokens and Lighthouse a `--no-sandbox` it never asked for. Compared
 * against spawn-tool's own escaping, because the claim is "identical to what
 * that module already executes on Windows" — a literal typed here could only pin
 * a copy of it.
 */
test('the win32 command line carries the audit argv with spawn-tool\'s escaping', () => {
  const shim = 'C:\\proj\\node_modules\\.bin\\lighthouse.cmd';
  const plan = spawnPlan([shim, ...AUDIT_ARGV], 'win32', () => shim);
  assert.equal(plan.file, COMSPEC);
  assert.equal(plan.verbatim, true, 'a pre-assembled command line must not be re-quoted by libuv');
  assert.equal(
    plan.args[3],
    `"${[escapeCmdCommand(shim), ...AUDIT_ARGV.map((arg) => escapeCmdArgument(arg))].join(' ')}"`,
  );
  assert.ok(
    !plan.args[3]!.includes('--headless --no-sandbox'),
    'the space inside --chrome-flags must be escaped, or the flag arrives as two arguments',
  );
});
