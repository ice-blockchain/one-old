// The reset command's argv grammar, judged adversarially.
//
// This grammar is the second row of the fail-closed recovery allowlist and the
// only MUTATING one, so a loose match here is not an inconvenience — it is a
// gate-bypass hole reachable from a damaged runtime. The table below is
// therefore written as a near-miss corpus rather than as a couple of happy
// paths: every row differs from the admitted spelling by one edit, and every
// row must be REFUSED.
//
// Precedent and shape: tests/doctor-callable.test.ts does the same job for the
// doctor grammar. What is deliberately NOT here is any assertion that a gate
// may not deny a command inside the plugin root — that rule would un-gate
// `run-status --status failed`, itself the fastest way to wedge a project, and
// the last test in this file pins that command as still gated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as path from 'path';

import {
  gateExemptResetScriptPaths,
  resetCommand,
  resetScriptPath,
  resetShimPath,
} from '../reset-command';
import { doctorScriptPath } from '../doctor-command';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand, trafficOneResetRunId } from '../tool-classify';
import { isFailClosedRecoveryExemption } from '../../hooks/fail-closed';

const SCRIPT = resetScriptPath();
const RUN = '1785169657252';
const admitted = (command: string): boolean => isTrafficOneResetCommand('Bash', { command });

test('the runner-root and shim spellings are admitted, and nothing else names the file', () => {
  assert.equal(admitted(`node ${SCRIPT} --run-id ${RUN}`), true);
  assert.equal(admitted(`node '${SCRIPT}' --run-id ${RUN}`), true, 'single quotes are inert');
  assert.equal(admitted(`node "${SCRIPT}" --run-id ${RUN}`), true, 'so are plain double quotes');
  assert.equal(admitted(`node ${resetShimPath()} --run-id ${RUN}`), true, 'the version-stable shim');
  assert.equal(trafficOneResetRunId('Bash', { command: `node ${SCRIPT} --run-id ${RUN}` }), RUN,
    'and a caller reads the id the grammar parsed rather than re-scanning the text');

  // Both anchors come from the RUNNING runtime or from HOME — never from a
  // *_PLUGIN_ROOT env var, which is an input to the hook process.
  for (const anchor of gateExemptResetScriptPaths()) {
    assert.ok(path.isAbsolute(anchor), `${anchor} must be absolute`);
    assert.equal(path.basename(anchor), 'traffic-one-reset.cjs');
  }
});

test('the documented shim path is reachable through a tilde, exactly as prose prints it', () => {
  const home = process.env.HOME || os.homedir();
  const tilde = resetShimPath().startsWith(home) ? `~${resetShimPath().slice(home.length)}` : '';
  if (!tilde) return; // a relocated HOME; the absolute spelling above already covers it
  assert.equal(admitted(`node ${tilde} --run-id ${RUN}`), true);
  assert.equal(admitted(`node ~root${tilde.slice(1)} --run-id ${RUN}`), false,
    "bash's other tilde form is never expanded here");
});

test('every near miss is refused', () => {
  const forged = path.join(os.tmpdir(), 't1-forged', 'scripts', 'traffic-one-reset.cjs');
  for (const [why, command] of [
    ['no flag at all', `node ${SCRIPT}`],
    ['the flag with no value', `node ${SCRIPT} --run-id`],
    ['a value with no flag', `node ${SCRIPT} ${RUN}`],
    ['an extra trailing word', `node ${SCRIPT} --run-id ${RUN} --force`],
    ['an extra leading word', `node --enable-source-maps ${SCRIPT} --run-id ${RUN}`],
    ['a repeated flag', `node ${SCRIPT} --run-id ${RUN} --run-id ${RUN}`],
    ['the equals spelling', `node ${SCRIPT} --run-id=${RUN}`],
    ['different case', `node ${SCRIPT} --Run-Id ${RUN}`],
    ['a different runner flag', `node ${SCRIPT} --status failed`],
    ['a chained command', `node ${SCRIPT} --run-id ${RUN}; rm -rf /`],
    ['a backgrounded chain', `node ${SCRIPT} --run-id ${RUN} & rm -rf /`],
    ['a piped chain', `node ${SCRIPT} --run-id ${RUN} | sh`],
    ['an && chain', `node ${SCRIPT} --run-id ${RUN} && rm -rf /`],
    ['a leading chain', `rm -rf /; node ${SCRIPT} --run-id ${RUN}`],
    ['command substitution in the id', `node ${SCRIPT} --run-id $(whoami)`],
    ['backtick substitution in the id', `node ${SCRIPT} --run-id \`whoami\``],
    ['substitution in the path', `node $(echo ${SCRIPT}) --run-id ${RUN}`],
    ['a redirect', `node ${SCRIPT} --run-id ${RUN} > /tmp/out`],
    ['an append redirect', `node ${SCRIPT} --run-id ${RUN} >> /tmp/out`],
    ['a quoted metacharacter payload as the id', `node ${SCRIPT} --run-id '${RUN}; rm -rf /'`],
    ['a quoted path traversal as the id', `node ${SCRIPT} --run-id '../../etc/passwd'`],
    ['a dot-dot id', `node ${SCRIPT} --run-id ..`],
    ['a flag-shaped id', `node ${SCRIPT} --run-id --bundle`],
    ['a dash-prefixed id', `node ${SCRIPT} --run-id -${RUN}`],
    ['a trailing-dot id', `node ${SCRIPT} --run-id ${RUN}.`],
    ['an id with a space', `node ${SCRIPT} --run-id '${RUN} ${RUN}'`],
    ['an empty id', `node ${SCRIPT} --run-id ''`],
    ['a glob in the path', `node ${SCRIPT.replace('reset', '*')} --run-id ${RUN}`],
    ['a newline', `node ${SCRIPT} --run-id ${RUN}\nrm -rf /`],
    ['a relative path', `node ./scripts/traffic-one-reset.cjs --run-id ${RUN}`],
    ['a forged plugin root', `node ${forged} --run-id ${RUN}`],
    ['another binary', `npx ${SCRIPT} --run-id ${RUN}`],
    ['a shell wrapper', `sh -c "node ${SCRIPT} --run-id ${RUN}"`],
    ['an env prefix', `HOME=/tmp node ${SCRIPT} --run-id ${RUN}`],
    ['a different runner at the same anchor', `node ${doctorScriptPath()} --run-id ${RUN}`],
  ] as const) {
    assert.equal(admitted(command), false, `the grammar now admits ${why}: ${command}`);
  }
});

test('the grammar is reachable only through a shell tool', () => {
  const command = `node ${SCRIPT} --run-id ${RUN}`;
  assert.equal(isTrafficOneResetCommand('Bash', { command }), true);
  assert.equal(isTrafficOneResetCommand('exec_command', { command }), true);
  for (const toolName of ['Write', 'Edit', 'MultiEdit', 'apply_patch', 'Read', 'Task']) {
    assert.equal(isTrafficOneResetCommand(toolName, { command }), false,
      `${toolName} must never reach the reset exemption`);
  }
});

test('the two grammars do not admit each other, so widening one cannot widen the other', () => {
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${SCRIPT} --run-id ${RUN}` }), false);
  assert.equal(admitted(`node ${doctorScriptPath()}`), false);
  assert.equal(admitted(`node ${doctorScriptPath()} --run ${RUN}`), false);
});

test('the command the runtime PRINTS is one the grammar admits', () => {
  // The same structural property doctor-command.ts exists to guarantee: a
  // product that prints a recovery command it then blocks has no escape hatch.
  assert.equal(admitted(resetCommand(RUN)), true, `printed but denied: ${resetCommand(RUN)}`);
});

// ── the fail-closed recovery allowlist ──────────────────────────────────────

const nested = (command: string): string => JSON.stringify({
  cwd: '/tmp/project',
  tool_name: 'Bash',
  tool_input: { command },
});

test('reset clears the fail-closed boundary, and only in a batch of nothing but recovery', () => {
  assert.equal(isFailClosedRecoveryExemption(nested(`node ${SCRIPT} --run-id ${RUN}`), undefined, 'nested'), true,
    'the recovery command must survive a runtime too damaged to judge it — that is when it is needed');
  assert.equal(isFailClosedRecoveryExemption(nested(`node ${SCRIPT} --run-id ${RUN}; rm -rf /`), undefined, 'nested'), false);

  const batch = (commands: readonly string[]): string => JSON.stringify({
    cwd: '/tmp/project',
    tool_calls: commands.map((command) => ({ name: 'Bash', args: { command } })),
  });
  const reset = `node ${SCRIPT} --run-id ${RUN}`;
  assert.equal(isFailClosedRecoveryExemption(batch([reset]), undefined, 'copilot'), true);
  assert.equal(isFailClosedRecoveryExemption(batch([reset, 'rm -rf /']), undefined, 'copilot'), false,
    'a batch is exempt only if there is nothing in it but recovery commands');
  assert.equal(isFailClosedRecoveryExemption(batch(['rm -rf /', reset]), undefined, 'copilot'), false,
    'and the order must not matter');
});

test('the commands that WEDGE a project are still gated', () => {
  // `run-status --status failed` is the fastest way into the state reset exists
  // to recover from, and `doctor --unblock` mints an operator override. Neither
  // is on any allowlist, and adding the reset row must not have changed that.
  const runStatus = `node ${path.join(path.dirname(resetShimPath()), 'run-status.cjs')} `
    + `--run-id ${RUN} --status failed --outcome agent-failed`;
  assert.equal(admitted(runStatus), false);
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: runStatus }), false);
  assert.equal(isFailClosedRecoveryExemption(nested(runStatus), undefined, 'nested'), false,
    'un-gating run-status would make the wedge reachable, which is the whole reason reset had to be written');

  const unblock = `node ${doctorScriptPath()} --unblock plan-guard.write`;
  assert.equal(isFailClosedRecoveryExemption(nested(unblock), undefined, 'nested'), false,
    'the one doctor invocation that WRITES stays absent from both grammars');
});
