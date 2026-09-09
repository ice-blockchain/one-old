import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  convertToContainerCommand,
  convertToContainerYesCommand,
  gateExemptWorkspaceScriptPaths,
  workspaceScriptPath,
  workspaceShimPath,
} from '../workspace-command';
import { isTrafficOneDoctorCommand, isTrafficOneResetCommand, isTrafficOneWorkspaceCommand } from '../tool-classify';
import { resetCommand } from '../reset-command';
import { doctorCommand } from '../doctor-command';
import { ensureRunnerShims, shimSource } from '../runner-shims';

const SCRIPT = workspaceScriptPath();
const admitted = (command: string): boolean => isTrafficOneWorkspaceCommand('Bash', { command });

function writeDocumentedWorkspaceShim(): void {
  const dest = workspaceShimPath();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, shimSource('scripts/traffic-one-workspace.cjs'));
}

writeDocumentedWorkspaceShim();
ensureRunnerShims();

test('the printed convert commands are the ones the gate admits', () => {
  writeDocumentedWorkspaceShim();
  assert.match(convertToContainerCommand(), /--convert-to-container$/);
  assert.match(convertToContainerYesCommand(), /--convert-to-container --yes$/);
  assert.equal(admitted(convertToContainerCommand()), true);
  assert.equal(admitted(convertToContainerYesCommand()), true);
  assert.equal(admitted(`node ${SCRIPT} --convert-to-container`), true);
  assert.equal(admitted(`node ${SCRIPT} --convert-to-container --yes`), true);
  assert.equal(admitted(`node ${workspaceShimPath()} --convert-to-container`), true);
  for (const anchor of gateExemptWorkspaceScriptPaths()) {
    assert.ok(path.isAbsolute(anchor));
    assert.equal(path.basename(anchor), 'traffic-one-workspace.cjs');
  }
});

test('workspace convert does not widen doctor or reset, and they do not admit it', () => {
  const convert = convertToContainerCommand();
  const reset = resetCommand('1785169657252');
  const doctor = doctorCommand();
  assert.equal(isTrafficOneWorkspaceCommand('Bash', { command: reset }), false);
  assert.equal(isTrafficOneWorkspaceCommand('Bash', { command: doctor }), false);
  assert.equal(isTrafficOneResetCommand('Bash', { command: convert }), false);
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: convert }), false);
});

test('every near miss of the convert grammar is refused', () => {
  for (const [why, command] of [
    ['no flag', `node ${SCRIPT}`],
    ['unknown flag', `node ${SCRIPT} --convert-to-container --force`],
    ['yes first', `node ${SCRIPT} --yes --convert-to-container`],
    ['json is CLI-only', `node ${SCRIPT} --convert-to-container --json`],
    ['cwd is CLI-only', `node ${SCRIPT} --convert-to-container --cwd /tmp`],
    ['a chain', `node ${SCRIPT} --convert-to-container; rm -rf /`],
    ['a relative path', 'node ./scripts/traffic-one-workspace.cjs --convert-to-container'],
    ['another binary', `npx ${SCRIPT} --convert-to-container`],
  ] as const) {
    assert.equal(admitted(command), false, `the grammar now admits ${why}: ${command}`);
  }
});
