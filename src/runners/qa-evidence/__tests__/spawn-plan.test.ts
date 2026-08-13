// src/runners/qa-evidence/__tests__/spawn-plan.test.ts
// How `runBoundedProcess` addresses a command that may be a Windows batch shim.
//
// This is the least observable correctness path in the runner and the one with
// the worst failure mode. Node >= 22 refuses to spawn a `.cmd`/`.bat` without a
// shell and throws EINVAL; `runBoundedProcess` reports a failed spawn as "the
// command could not be executed"; and that is the exact prose
// `validateQaReportV2` accepts as a justified exemption for `stack-test`. So a
// mistake here does not produce a red on Windows — it produces a SETTLED GREEN
// RUN with no test evidence, which is the defect the rest of this lane exists
// to close, reintroduced on the one platform no machine here runs.
//
// `spawnPlan` therefore takes its platform and its on-disk resolution as
// parameters, so the plan can be asserted for win32 from darwin without a
// shell, a spawn, or a `.cmd` file. What cannot be proved from here is that
// Windows then EXECUTES that plan correctly; what can be proved is that the
// plan is the one shared/spawn-tool.ts already executes correctly there, which
// is why the escaping below is compared against that module's own functions
// rather than against literals typed out here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeCmdArgument, escapeCmdCommand } from '../../../shared/spawn-tool';
import { spawnPlan } from '../native-process';

/** A resolver standing in for a Windows PATH lookup, with no disk behind it. */
const resolvesTo = (target: string) => (): string => target;

const NEVER_CALLED = (file: string): string => {
  assert.fail(`the POSIX path must not resolve anything on disk, but it looked up ${file}`);
};

// The passthrough. Byte-identical to the `spawn(command[0], command.slice(1))`
// this file did before Windows was considered, which is the entire safety
// argument for adding the branch: on every platform the tests here run, the
// new code path is the old one.
test('on POSIX the plan is the raw command, resolved against nothing', () => {
  assert.deepEqual(
    spawnPlan(['npm', 'run', 'test', '--silent'], 'darwin', NEVER_CALLED),
    { file: 'npm', args: ['run', 'test', '--silent'], verbatim: false },
  );
  assert.deepEqual(
    spawnPlan(['./gradlew', 'connectedAndroidTest'], 'linux', NEVER_CALLED),
    { file: './gradlew', args: ['connectedAndroidTest'], verbatim: false },
  );
  // A command with no arguments still yields an args array, not undefined.
  assert.deepEqual(spawnPlan(['pytest'], 'darwin', NEVER_CALLED), { file: 'pytest', args: [], verbatim: false });
});

// The EINVAL-avoidance itself, for every package manager `resolveStackCommand`
// can emit plus the Gradle wrapper `configuredNativeCommand` admits. The load
// -bearing assertion is `file`: spawning cmd.exe is what makes the call legal,
// and handing `spawn` the `.cmd` directly is what throws.
test('on win32 a batch shim is run through cmd.exe rather than spawned directly', () => {
  for (const [name, shim] of [
    ['npm', 'C:\\Program Files\\nodejs\\npm.cmd'],
    ['pnpm', 'C:\\Program Files\\nodejs\\pnpm.CMD'],
    ['yarn', 'C:\\Users\\dev\\AppData\\Roaming\\npm\\yarn.cmd'],
    ['gradlew.bat', 'C:\\proj\\gradlew.bat'],
  ] as const) {
    const plan = spawnPlan([name, 'run', 'test'], 'win32', resolvesTo(shim));
    assert.equal(plan.file, process.env.ComSpec || 'cmd.exe', `${name} must be handed to the shell, not spawned`);
    assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c'], `${name} must use the AutoRun-free run-and-exit form`);
    assert.equal(plan.verbatim, true, 'a pre-assembled command line must not be re-quoted by libuv');
    assert.equal(plan.args.length, 4, 'the whole command must arrive as ONE argument');
    // `.CMD` in the middle row: the extension test is case-insensitive because
    // Windows is, and a shim that escaped it would be spawned directly and
    // throw EINVAL.
    assert.match(plan.args[3]!, /npm|pnpm|yarn|gradlew/i);
  }
});

// A `.exe` needs no shell, and routing one through cmd.exe would add a quoting
// layer with nothing to gain and a new way to be wrong.
test('on win32 an executable target is spawned directly, at its resolved path', () => {
  assert.deepEqual(
    spawnPlan(['node', '-e', ''], 'win32', resolvesTo('C:\\Program Files\\nodejs\\node.exe')),
    { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['-e', ''], verbatim: false },
  );
});

// A command Windows cannot find must keep producing the ordinary ENOENT the
// caller already classifies as "never started" — the honest exemption. A plan
// built around a guessed path would turn that into a spawn of the wrong thing.
test('on win32 an unresolvable command is left exactly as it came in', () => {
  assert.deepEqual(
    spawnPlan(['t1-no-such-binary-9d3f1a', '--check'], 'win32', (file) => file),
    { file: 't1-no-such-binary-9d3f1a', args: ['--check'], verbatim: false },
  );
});

// The quoting, which is the half that fails SILENTLY rather than loudly: libuv
// quotes for CommandLineToArgvW, which leaves every cmd.exe metacharacter live,
// so an unescaped `&` in an argument becomes a command separator. Compared
// against spawn-tool's own functions rather than literals, because the claim
// being made is "identical to the escaping that module already ships", and a
// hand-typed expectation could only ever pin a copy of it.
test('the win32 command line carries spawn-tool\'s escaping, not raw text', () => {
  const shim = 'C:\\Program Files\\nodejs\\npm.cmd';
  const hostile = ['run', 'test:e2e & calc.exe', 'a"b', 'c^d', '%PATH%'];
  const plan = spawnPlan(['npm', ...hostile], 'win32', resolvesTo(shim));
  const line = plan.args[3]!;

  assert.equal(
    line,
    `"${[escapeCmdCommand(shim), ...hostile.map((arg) => escapeCmdArgument(arg))].join(' ')}"`,
    'the assembled line must be exactly spawn-tool\'s escaping of the same tokens',
  );
  // And independently of that equality, so a change to BOTH sides at once is
  // still caught: none of the metacharacters may reach cmd.exe bare.
  assert.doesNotMatch(line, /(?<!\^)&/, 'an unescaped & would split the command line in two');
  assert.doesNotMatch(line, /(?<!\^)\^(?![()[\]%!^"`<>&|;, *?])/, 'a stray caret escapes the wrong character');
  assert.ok(
    line.includes(escapeCmdCommand(shim)),
    'the spaced program path must survive as one token — an unescaped space would run "C:\\Program"',
  );
});

// ComSpec is read from the environment because a Windows host may not have
// cmd.exe where the default expects it, and because spawn-tool does the same.
test('the shell is taken from ComSpec when the host sets one', () => {
  const previous = process.env.ComSpec;
  try {
    process.env.ComSpec = 'D:\\Windows\\System32\\cmd.exe';
    assert.equal(
      spawnPlan(['npm'], 'win32', resolvesTo('C:\\npm.cmd')).file,
      'D:\\Windows\\System32\\cmd.exe',
    );
    delete process.env.ComSpec;
    assert.equal(spawnPlan(['npm'], 'win32', resolvesTo('C:\\npm.cmd')).file, 'cmd.exe');
  } finally {
    if (previous === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = previous;
  }
});
