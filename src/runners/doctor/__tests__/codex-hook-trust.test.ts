import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CODEX_HOOK_EXPECTED_COUNT,
  CODEX_TRAFFIC_ONE_HOOK_KEYS,
  CODEX_TRAFFIC_ONE_PLUGIN_ID,
  probeCodexHookTrust,
  resolveCodexBinary,
  type CodexHookTrustStatus,
} from '../codex-hook-trust';

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `t1-codex-hook-trust-${prefix}-`));
}

function writeExecutable(filePath: string, source = '#!/usr/bin/env node\nprocess.stdin.resume();\n'): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, source, 'utf8');
  fs.chmodSync(filePath, 0o755);
  return filePath;
}

function makeCodexHome(root: string, config: string, withCache = true): string {
  const home = path.join(root, 'real-codex-home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), config, 'utf8');
  if (withCache) {
    const version = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '9.9.9');
    fs.mkdirSync(version, { recursive: true });
    fs.writeFileSync(path.join(version, 'cache-marker.txt'), 'traffic-one-only\n', 'utf8');
  }
  return home;
}

function hookEvent(key: string): string {
  if (key.includes(':post_tool_use:')) return 'postToolUse';
  if (key.includes(':session_start:')) return 'sessionStart';
  if (key.includes(':user_prompt_submit:')) return 'userPromptSubmit';
  if (key.includes(':subagent_start:')) return 'subagentStart';
  return 'preToolUse';
}

function hooks(status: (index: number) => CodexHookTrustStatus, disabledIndex = -1): Rec[] {
  return CODEX_TRAFFIC_ONE_HOOK_KEYS.map((key, index) => ({
    key,
    eventName: hookEvent(key),
    enabled: index !== disabledIndex,
    trustStatus: status(index),
    currentHash: `sha256:current-${index}`,
    pluginId: CODEX_TRAFFIC_ONE_PLUGIN_ID,
  }));
}

type Rec = Record<string, unknown>;

interface FakeServerOptions {
  hooks?: Rec[];
  responseErrors?: Rec[];
  hooksListError?: Rec;
  invalidJson?: boolean;
  timeout?: boolean;
  markerPath?: string;
  expectedConfig?: string;
  realHome?: string;
  cwd?: string;
  noisyStderr?: boolean;
  inheritedStdoutDescendant?: boolean;
  descendantPidPath?: string;
  descendantReleasedPath?: string;
  exitAfterHooksResponse?: boolean;
}

function fakeServerSource(options: FakeServerOptions): string {
  const responseHooks = options.hooks || [];
  const cwd = options.cwd || '/workspace/project';
  return `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const markerPath = ${JSON.stringify(options.markerPath || '')};
const expectedConfig = ${JSON.stringify(options.expectedConfig ?? '')};
const realHome = ${JSON.stringify(options.realHome || '')};
const cwd = ${JSON.stringify(cwd)};
const faults = [];
if (markerPath) fs.writeFileSync(markerPath, process.env.CODEX_HOME || '', 'utf8');
if (process.argv.slice(2).join(' ') !== 'app-server --listen stdio://') faults.push('spawn was not direct app-server --listen stdio://');
if (!process.env.CODEX_HOME || process.env.CODEX_HOME !== process.env.HOME || process.env.USERPROFILE !== process.env.CODEX_HOME) faults.push('shadow home env mismatch');
if (realHome && Object.values(process.env).some((value) => typeof value === 'string' && value.includes(realHome))) faults.push('real home leaked through child env');
if ((fs.statSync(process.env.CODEX_HOME).mode & 0o777) !== 0o700) faults.push('shadow home mode');
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
if ((fs.statSync(configPath).mode & 0o777) !== 0o600) faults.push('config mode');
if (fs.readFileSync(configPath, 'utf8') !== expectedConfig) faults.push('config bytes changed');
const top = fs.readdirSync(process.env.CODEX_HOME).sort().join(',');
if (top !== 'config.toml,plugins') faults.push('unexpected shadow state: ' + top);
const pluginCache = path.join(process.env.CODEX_HOME, 'plugins', 'cache');
if (fs.readdirSync(pluginCache).join(',') !== 'traffic-one-local') faults.push('non-Traffic-One cache copied');
${options.noisyStderr ? "process.stderr.write('diagnostic-only\\n' + 'x'.repeat(70 * 1024));" : ''}
let buffer = '';
let stage = 0;
function fragmented(message) {
  const wire = JSON.stringify(message) + '\\n';
  process.stdout.write(wire.slice(0, 3));
  setTimeout(() => process.stdout.write(wire.slice(3, 17)), 2);
  setTimeout(() => process.stdout.write(wire.slice(17)), 4);
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\\n')) >= 0) {
    const raw = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (${options.timeout === true ? 'true' : 'false'}) continue;
    if (stage === 0) {
      if (message.method !== 'initialize' || message.id !== 1) faults.push('initialize was not first');
      stage = 1;
      ${options.invalidJson === true
    ? "process.stdout.write('not-json\\n');"
    : "fragmented({ id: 1, result: { userAgent: 'traffic-one-doctor/9.8.7 (test)' } });"}
      continue;
    }
    if (stage === 1) {
      if (message.method !== 'initialized' || Object.prototype.hasOwnProperty.call(message, 'id')) faults.push('initialized notification was not second');
      stage = 2;
      continue;
    }
    if (stage === 2) {
      if (message.method !== 'hooks/list' || message.id !== 2 || JSON.stringify(message.params) !== JSON.stringify({ cwds: [cwd] })) faults.push('hooks/list was not third');
      stage = 3;
      ${options.inheritedStdoutDescendant === true
    // IT HOLDS THE INHERITED STDOUT FOR THIRTY SECONDS, where it used to hold for
    // 2.5, and that duration is what makes the row next door decidable without a
    // clock in it. The claim there is that the probe resolves on its direct
    // child's EXIT and not on stdio closing. Thirty seconds is longer than the
    // probe's own protocol timeout for these fixtures (5 s), so a probe that
    // waited for the pipe CANNOT come back `verified` — it must come back
    // `indeterminate: timeout` — and that is an ordering between two of the
    // fixture's own numbers rather than a race against the machine: no amount of
    // scheduler delay makes 30 s fit inside 5 s. The old form asserted `elapsed <
    // 1_400` against a 2.5 s hold instead, which is a bet on the whole probe
    // finishing quickly; inside the full suite it took 3860 ms and the row failed
    // while the probe was perfectly correct.
    //
    // It also announces its RELEASE, as a fixture-drift guard rather than as the
    // discriminator — see `descendantStillHolding`.
    //
    // THE RELEASE IS A FILE AND NOT A PID CHECK, because the pid answers wrongly:
    // `process.kill(pid, 0)` succeeds against a ZOMBIE, and this holder's parent
    // never waits for it. Measured, that is not hypothetical — with a pid check
    // the guard reported "still holding" for a holder that had been told to exit
    // after 1 ms.
    ? `const held = spawn(process.execPath, ['-e', ${JSON.stringify(
      `setTimeout(() => { require('fs').writeFileSync(process.argv[1], 'released'); }, 30000)`,
    )}, ${JSON.stringify(options.descendantReleasedPath || '')}], { stdio: ['ignore', 'inherit', 'ignore'] });
      fs.writeFileSync(${JSON.stringify(options.descendantPidPath || '')}, String(held.pid));
      held.unref();`
    : ''}
      ${options.hooksListError
    ? `fragmented({ id: 2, error: ${JSON.stringify(options.hooksListError)} });`
    : options.exitAfterHooksResponse === true
      ? `process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ cwd, hooks: ${JSON.stringify(responseHooks)}, warnings: faults, errors: ${JSON.stringify(options.responseErrors || [])} }] } }) + '\\n', () => process.exit(0));`
      : `fragmented({ id: 2, result: { data: [{ cwd, hooks: ${JSON.stringify(responseHooks)}, warnings: faults, errors: ${JSON.stringify(options.responseErrors || [])} }] } });`}
    }
  }
});
`;
}

function probeEnv(root: string, codexHome: string, binary: string): NodeJS.ProcessEnv {
  return {
    HOME: path.join(root, 'real-user-home'),
    CODEX_HOME: codexHome,
    TRAFFIC_ONE_CODEX_BIN: binary,
    PATH: process.env.PATH,
    LANG: 'C.UTF-8',
  };
}

async function runFakeProbe(
  prefix: string,
  options: Omit<
    FakeServerOptions,
    'markerPath' | 'expectedConfig' | 'realHome' | 'cwd' | 'descendantPidPath' | 'descendantReleasedPath'
  >,
): Promise<{
  result: Awaited<ReturnType<typeof probeCodexHookTrust>>;
  shadowHome: string;
  root: string;
  /**
   * Had the descendant still not released the inherited stdout when the probe
   * resolved?
   *
   * A FIXTURE-DRIFT GUARD, not the discriminator, and it is worth being exact
   * about which: what proves the probe did not wait for the pipe is that it
   * returned `verified` at all, because the holder outlasts the probe's own
   * protocol timeout (see the holder's comment). This one covers the case that
   * argument rests on — if a future edit raises `timeoutMs` above the hold, a
   * probe that waited would produce a `verified` result 30 s late and every other
   * assertion in the row would accept it. Sampled here rather than in the row
   * because the holder is reaped immediately afterwards, so every row that asks
   * for one is cleaned up whether or not it looks at this.
   *
   * It is deliberately not read as "the holder is alive": the release marker is
   * only reliable in the direction that matters (a released holder has written
   * it), since on the passing path the sample lands within milliseconds of the
   * holder's spawn, before it has finished booting.
   */
  descendantStillHolding: boolean;
}> {
  const root = tmp(prefix);
  const config = '# byte-for-byte sentinel\n[plugins."traffic-one@traffic-one-local"]\n  enabled=true\n';
  const codexHome = makeCodexHome(root, config);
  const marker = path.join(root, 'shadow-home.txt');
  const descendantPidPath = path.join(root, 'descendant.pid');
  const descendantReleasedPath = path.join(root, 'descendant.released');
  const binary = writeExecutable(path.join(root, 'fake-codex'), fakeServerSource({
    ...options,
    markerPath: marker,
    descendantPidPath,
    descendantReleasedPath,
    expectedConfig: config,
    realHome: root,
    cwd: '/workspace/project',
  }));
  let preparedShadowHome = '';
  const result = await probeCodexHookTrust(
    '/workspace/project',
    probeEnv(root, codexHome, binary),
    // The full repository suite runs almost 2,000 tests concurrently and can
    // starve short-lived fake processes for well over a second. Keep the
    // production default at eight seconds; only this deterministic fixture gets
    // enough headroom to avoid classifying scheduler delay as protocol timeout.
    {
      timeoutMs: options.timeout ? 1_200 : 5_000,
      onShadowHomePrepared: (shadowHome) => { preparedShadowHome = shadowHome; },
    },
  );
  const holder = Number(fs.existsSync(descendantPidPath) ? fs.readFileSync(descendantPidPath, 'utf8') : 0);
  const descendantStillHolding = holder > 0 && !fs.existsSync(descendantReleasedPath);
  // Reaped whatever the sample said: it is holding a thirty-second handle, and no
  // row wants to pay for it or leave it behind.
  if (holder > 0) {
    try { process.kill(holder, 'SIGKILL'); } catch { /* already gone */ }
  }
  const childReportedShadowHome = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  if (childReportedShadowHome) assert.equal(childReportedShadowHome, preparedShadowHome);
  const shadowHome = preparedShadowHome;
  return { result, shadowHome, root, descendantStillHolding };
}

test('probeCodexHookTrust handles fragmented JSONL + stderr, copies config bytes, isolates home, and cleans up', async () => {
  const run = await runFakeProbe('success', { hooks: hooks(() => 'trusted'), noisyStderr: true });
  try {
    assert.equal(run.result.evaluation, 'verified');
    if (run.result.evaluation !== 'verified') return;
    assert.deepEqual(run.result.counts, {
      discovered: CODEX_HOOK_EXPECTED_COUNT,
      trusted: CODEX_HOOK_EXPECTED_COUNT,
      managed: 0,
      modified: 0,
      untrusted: 0,
      disabled: 0,
      runnable: CODEX_HOOK_EXPECTED_COUNT,
    });
    assert.deepEqual(run.result.missingKeys, []);
    assert.deepEqual(run.result.unexpectedKeys, []);
    assert.equal(run.result.codexVersion, '9.8.7');
    assert.equal(run.result.warnings.length, 0);
    assert.equal(run.result.errors.length, 0);
    assert.ok(run.shadowHome);
    assert.equal(fs.existsSync(run.shadowHome), false, 'shadow CODEX_HOME must be removed after child close');
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('probeCodexHookTrust counts disabled hooks and the modified + 2 untrusted regression exactly', async () => {
  const disabled = await runFakeProbe('disabled', { hooks: hooks(() => 'trusted', 4) });
  try {
    assert.equal(disabled.result.evaluation, 'verified');
    if (disabled.result.evaluation === 'verified') {
      assert.equal(disabled.result.counts.disabled, 1);
      assert.equal(disabled.result.counts.runnable, CODEX_HOOK_EXPECTED_COUNT - 1);
    }
  } finally {
    fs.rmSync(disabled.root, { recursive: true, force: true });
  }

  const modifiedCount = CODEX_HOOK_EXPECTED_COUNT - 2;
  const stale = await runFakeProbe('stale', { hooks: hooks((index) => index < modifiedCount ? 'modified' : 'untrusted') });
  try {
    assert.equal(stale.result.evaluation, 'verified');
    if (stale.result.evaluation === 'verified') {
      assert.deepEqual(stale.result.counts, {
        discovered: CODEX_HOOK_EXPECTED_COUNT,
        trusted: 0,
        managed: 0,
        modified: modifiedCount,
        untrusted: 2,
        disabled: 0,
        runnable: 0,
      });
    }
  } finally {
    fs.rmSync(stale.root, { recursive: true, force: true });
  }
});

test('probeCodexHookTrust classifies missing binary and missing/invalid Traffic One cache', async () => {
  const root = tmp('missing');
  try {
    const home = makeCodexHome(root, '', false);
    const missingBinary = await probeCodexHookTrust('/workspace/project', { HOME: root, CODEX_HOME: home }, { binaryPath: null });
    assert.deepEqual(missingBinary, {
      evaluation: 'indeterminate', source: 'structural-config', reason: 'codex-not-found', detail: null,
    });

    const binary = writeExecutable(path.join(root, 'fake-codex'));
    const missingCache = await probeCodexHookTrust('/workspace/project', probeEnv(root, home, binary), { binaryPath: binary });
    assert.deepEqual(missingCache, {
      evaluation: 'indeterminate', source: 'structural-config', reason: 'plugin-cache-missing', detail: null,
    });

    const invalidCache = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one');
    fs.mkdirSync(path.dirname(invalidCache), { recursive: true });
    fs.writeFileSync(invalidCache, 'not-a-directory', 'utf8');
    const invalid = await probeCodexHookTrust('/workspace/project', probeEnv(root, home, binary), { binaryPath: binary });
    assert.equal(invalid.evaluation, 'indeterminate');
    if (invalid.evaluation === 'indeterminate') assert.equal(invalid.reason, 'plugin-cache-missing');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('probeCodexHookTrust classifies unsupported API, invalid JSON/schema/errors, and timeout with cleanup', async () => {
  const unsupported = await runFakeProbe('unsupported', { hooksListError: { code: -32601, message: 'Method not found' } });
  try {
    assert.equal(unsupported.result.evaluation, 'indeterminate');
    if (unsupported.result.evaluation === 'indeterminate') assert.equal(unsupported.result.reason, 'unsupported-api');
  } finally {
    fs.rmSync(unsupported.root, { recursive: true, force: true });
  }

  const invalidJson = await runFakeProbe('invalid-json', { invalidJson: true });
  try {
    assert.equal(invalidJson.result.evaluation, 'indeterminate');
    if (invalidJson.result.evaluation === 'indeterminate') assert.equal(invalidJson.result.reason, 'invalid-response');
  } finally {
    fs.rmSync(invalidJson.root, { recursive: true, force: true });
  }

  const hookErrors = await runFakeProbe('hook-errors', {
    hooks: hooks(() => 'trusted'),
    responseErrors: [{ path: '/shadow/hooks.json', message: 'hook load failed' }],
  });
  try {
    assert.equal(hookErrors.result.evaluation, 'indeterminate');
    if (hookErrors.result.evaluation === 'indeterminate') assert.equal(hookErrors.result.reason, 'invalid-response');
  } finally {
    fs.rmSync(hookErrors.root, { recursive: true, force: true });
  }

  const timedOut = await runFakeProbe('timeout', { timeout: true });
  try {
    assert.equal(timedOut.result.evaluation, 'indeterminate');
    if (timedOut.result.evaluation === 'indeterminate') assert.equal(timedOut.result.reason, 'timeout');
    assert.ok(timedOut.shadowHome);
    assert.equal(fs.existsSync(timedOut.shadowHome), false, 'timeout cleanup waits for process close');
  } finally {
    fs.rmSync(timedOut.root, { recursive: true, force: true });
  }
});

// WHAT MADE THIS ROW FAIL ON A BUSY BOX, and what it asserts instead.
//
// The claim is that the probe resolves on its DIRECT CHILD'S EXIT and does not
// wait for stdio that a descendant inherited and is still holding. That was
// asserted as `elapsed < 1_400` against a descendant that held for 2500 ms, so
// the row really said "this machine got through the whole probe in under 1.4 s" —
// and inside the full suite it did not: observed at 3860 ms, with the probe
// perfectly correct. A ceiling between two fixture durations is decided by the
// scheduler, not by the mechanism.
//
// What replaces it is an ordering between two of the FIXTURE'S OWN numbers: the
// descendant holds the inherited stdout for 30 s, and this probe is given a 5 s
// protocol timeout, so a probe that waits for the pipe cannot produce a `verified`
// result at any machine speed — it must report `indeterminate: timeout`. The
// verdict below therefore decides the mechanism, load or no load, and it decides
// it in five seconds rather than by hanging. `descendantStillHolding` guards the
// premise of that argument for the day someone raises the fixture's timeout.
test('probeCodexHookTrust resolves on direct-child exit when a descendant inherits stdout', async () => {
  const run = await runFakeProbe('inherited-stdout', {
    hooks: hooks(() => 'trusted'),
    inheritedStdoutDescendant: true,
  });
  try {
    assert.equal(run.result.evaluation, 'verified');
    assert.equal(
      run.descendantStillHolding,
      true,
      'probe must not wait for descendant-held stdio — the descendant had already released it when the '
      + 'probe returned, so this verdict was reached by waiting for the pipe. (If this fires alone, check '
      + "that the fixture's timeoutMs is still shorter than the descendant's hold: the assertion above "
      + 'stops being able to see a waiting probe once it is not.)',
    );
    assert.equal(fs.existsSync(run.shadowHome), false);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('probeCodexHookTrust drains a hooks/list response when the direct child exits immediately', async () => {
  const run = await runFakeProbe('immediate-exit', {
    hooks: hooks(() => 'trusted'),
    inheritedStdoutDescendant: true,
    exitAfterHooksResponse: true,
  });
  try {
    assert.equal(run.result.evaluation, 'verified');
    if (run.result.evaluation === 'verified') assert.equal(run.result.counts.runnable, CODEX_HOOK_EXPECTED_COUNT);
    assert.equal(fs.existsSync(run.shadowHome), false);
  } finally {
    fs.rmSync(run.root, { recursive: true, force: true });
  }
});

test('probeCodexHookTrust rejects symlinks instead of copying cache targets outside the shadow home', async (context) => {
  const root = tmp('cache-symlink');
  try {
    const config = '[plugins."traffic-one@traffic-one-local"]\nenabled=true\n';
    const home = makeCodexHome(root, config);
    const cacheVersion = path.join(home, 'plugins', 'cache', 'traffic-one-local', 'traffic-one', '9.9.9');
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'must-not-be-copied\n', 'utf8');
    try {
      fs.symlinkSync(outside, path.join(cacheVersion, 'escape'));
    } catch (error) {
      context.skip(`symlink creation is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const marker = path.join(root, 'spawned.txt');
    const binary = writeExecutable(path.join(root, 'fake-codex'), `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned');\n`);
    const result = await probeCodexHookTrust('/workspace/project', probeEnv(root, home, binary), { binaryPath: binary });
    assert.equal(result.evaluation, 'indeterminate');
    if (result.evaluation === 'indeterminate') {
      assert.equal(result.reason, 'temp-unavailable');
      assert.match(result.detail || '', /symlink/i);
    }
    assert.equal(fs.existsSync(marker), false, 'app-server must not start after unsafe cache discovery');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCodexBinary honors overrides and Desktop-aware versus PATH ordering', () => {
  const root = tmp('resolution');
  try {
    const trafficOverride = writeExecutable(path.join(root, 'traffic-override'));
    const cliOverride = writeExecutable(path.join(root, 'cli-override'));
    const codexHome = path.join(root, 'codex-home');
    const hostOwned = writeExecutable(path.join(codexHome, 'plugins', '.plugin-appserver', process.platform === 'win32' ? 'codex.exe' : 'codex'));
    const pathDir = path.join(root, 'bin');
    const pathBinary = writeExecutable(path.join(pathDir, process.platform === 'win32' ? 'codex.exe' : 'codex'));

    assert.equal(resolveCodexBinary({
      TRAFFIC_ONE_CODEX_BIN: trafficOverride, CODEX_CLI_PATH: cliOverride, CODEX_HOME: codexHome, PATH: pathDir,
    }), trafficOverride);
    assert.equal(resolveCodexBinary({ CODEX_CLI_PATH: cliOverride, CODEX_HOME: codexHome, PATH: pathDir }), cliOverride);
    assert.equal(resolveCodexBinary({ CODEX_HOME: codexHome, PATH: pathDir }), pathBinary);
    assert.equal(resolveCodexBinary({
      CODEX_HOME: codexHome, PATH: pathDir, CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop',
    }), hostOwned);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
