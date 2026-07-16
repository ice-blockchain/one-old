import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalToolName,
  commandFromToolInput,
  isMutatingPreToolUse,
  isOnboardingBootstrapCommand,
  isOnboardingWaitCommand,
  isReadOnlyOrientationToolUse,
  isShellToolName,
  isStateFileOnlyPatch,
  isStateFilePath,
  isWriteLikeToolName,
  normalizedToolName,
  parsedToolInput,
} from '../tool-classify';
import type { ToolInput } from '../../core/types';
import { onboardingDeclineCommand, onboardingReconsiderCommand, onboardingUseBootstrapCommand, onboardingUseCommand, onboardingWaitCommand } from '../onboarding-server/wait-command';

test('tool-name classification (host-prefixed names normalized)', () => {
  assert.equal(normalizedToolName('mcp.Bash'), 'Bash');
  assert.equal(isShellToolName('Bash'), true);
  assert.equal(isShellToolName('exec_command'), true);
  assert.equal(isShellToolName('Write'), false);
  assert.equal(isWriteLikeToolName('Edit'), true);
  assert.equal(isWriteLikeToolName('apply_patch'), true);
  assert.equal(commandFromToolInput({ command: 'ls' }), 'ls');
  assert.equal(commandFromToolInput({ cmd: 'ls' }), 'ls');
  // Windsurf/Devin pre_run_command payloads carry the command as `command_line`.
  assert.equal(commandFromToolInput({ command_line: 'npm run dev' }), 'npm run dev');
  assert.equal(commandFromToolInput({ commandLine: 'npm run dev' }), 'npm run dev');
});

test('isOnboardingWaitCommand recognizes the wait command from Windsurf command_line shape', () => {
  const waitCmd = onboardingWaitCommand('/proj', 'windsurf');
  // Windsurf shape: the onboarding gate passes canonicalToolName (→ "Bash") + the
  // raw tool_input, which carries the command as `command_line`. Previously the empty
  // command extraction made this false, wrongly denying the wait command.
  assert.equal(isOnboardingWaitCommand('Bash', { command_line: waitCmd, cwd: '/proj' }), true);
  // Claude shape (command) still works.
  assert.equal(isOnboardingWaitCommand('Bash', { command: waitCmd }), true);
  assert.equal(isOnboardingWaitCommand('Bash', { command: 'npm run dev' }), false);
});

test('the use/decline/reconsider choice commands share the wait allow-list grammar', () => {
  for (const cmd of [
    onboardingUseCommand('/proj', 'claude'),
    onboardingDeclineCommand('/proj', 'cursor'),
    onboardingReconsiderCommand('/proj', 'codex'),
  ]) {
    assert.equal(isOnboardingWaitCommand('Bash', { command: cmd }), true, cmd);
  }
  // The exit-fast modes never take the wait-only flags.
  const declineBase = onboardingDeclineCommand('/proj', 'claude');
  assert.equal(isOnboardingWaitCommand('Bash', { command: `${declineBase} '--quiet-url'` }), false);
  // Arbitrary flags stay rejected.
  assert.equal(isOnboardingWaitCommand('Bash', { command: declineBase.replace('--decline', '--nuke') }), false);
});

test('--use --bootstrap-only parses as an exit-fast bootstrap invocation', () => {
  const useBootstrap = onboardingUseBootstrapCommand('/proj', 'claude');
  assert.equal(isOnboardingWaitCommand('Bash', { command: useBootstrap }), true);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: useBootstrap }), true);
  // The plain yes command stays a waiter, not a bootstrap.
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: onboardingUseCommand('/proj', 'claude') }), false);
  // Exit-fast: the wait-only flags stay rejected on the combined form.
  assert.equal(isOnboardingWaitCommand('Bash', { command: `${useBootstrap} '--quiet-url'` }), false);
  // Only --use composes with --bootstrap-only, and only in that order.
  assert.equal(isOnboardingWaitCommand('Bash', { command: useBootstrap.replace('--use', '--decline') }), false);
  assert.equal(isOnboardingWaitCommand('Bash', { command: useBootstrap.replace("'--use' '--bootstrap-only'", "'--bootstrap-only' '--use'") }), false);
});

test('--seed-prompt rides the yes commands, inertly quoted, and only there', () => {
  // The ask-first flow writes nothing pre-decision: the triggering request is
  // carried on the yes command and seeded by the runner AFTER the recorded yes.
  const seed = "build the user's learning platform (v2); make it responsive";
  const seeded = onboardingUseBootstrapCommand('/proj', 'claude', seed);
  assert.ok(seeded.includes('--seed-prompt='), 'seed argument is embedded');
  assert.equal(isOnboardingWaitCommand('Bash', { command: seeded }), true);
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: seeded }), true);
  const seededUse = onboardingUseCommand('/proj', 'cursor', seed);
  assert.equal(isOnboardingWaitCommand('Bash', { command: seededUse }), true);
  // A non-coding control prompt is never embedded — the command stays seedless.
  assert.equal(onboardingUseBootstrapCommand('/proj', 'claude', 'ok').includes('--seed-prompt='), false);
  // The seed is only valid on a --use invocation, at most once.
  const declineSeeded = `${onboardingDeclineCommand('/proj', 'claude')} '--seed-prompt=x'`;
  assert.equal(isOnboardingWaitCommand('Bash', { command: declineSeeded }), false);
  const waitSeeded = `${onboardingWaitCommand('/proj', 'claude')} '--seed-prompt=x'`;
  assert.equal(isOnboardingWaitCommand('Bash', { command: waitSeeded }), false);
  const doubleSeed = `${seeded} '--seed-prompt=again'`;
  assert.equal(isOnboardingWaitCommand('Bash', { command: doubleSeed }), false);
});

test('isStateFilePath matches the .one.json state files anywhere', () => {
  const legacyRootState = ['.traffic-one', 'json'].join('.');
  assert.equal(isStateFilePath('.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath('a/b/.traffic-one/.one.json'), true);
  assert.equal(isStateFilePath(legacyRootState), false);
  assert.equal(isStateFilePath('src/x.ts'), false);
});

test('isMutatingPreToolUse flags writes/edits/mutating shell, allows read-only', () => {
  assert.equal(isMutatingPreToolUse('Write', { file_path: 'x' }), true);
  assert.equal(isMutatingPreToolUse('Edit', { old_string: 'a', new_string: 'b' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'rm -rf x' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'echo hi > f' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ls -la' }), false);
  assert.equal(isMutatingPreToolUse('Read', { file_path: 'x' }), false);

  // Hardened write vectors that previously slipped through the read-only allowance.
  assert.equal(isMutatingPreToolUse('Bash', { command: 'dd if=/dev/zero of=out.bin' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ln -s a b' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'chmod +x build.sh' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'truncate -s 0 log' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git checkout -- src/app.ts' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git restore .' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'pip install requests' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'cargo add serde' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'find . -name x -delete' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'find . -type f -exec rm {} ;' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'find . -type f -execdir sh {} ;' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'rg stale | xargs rm' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'echo $(rm -rf x)' }), true);
  // Inline interpreter eval (the named bypass): writes without a visible redirect.
  assert.equal(isMutatingPreToolUse('Bash', { command: `python -c "open('x','w').write('y')"` }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: `node -e "require('fs').writeFileSync('x','y')"` }), true);

  // fd-to-fd and discard redirects are NOT writes (B6): `ls -la … 2>/dev/null`
  // is routine read-only orientation and was falsely denied during onboarding.
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ls -la /p 2>/dev/null' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'cat f 2>&1' }), false);
  assert.equal(isMutatingPreToolUse('Bash', {
    command: 'ls -la /p 2>/dev/null; echo "---"; ls -la /p/.traffic-one 2>/dev/null | head -40',
  }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ls > out.txt' }), true);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'make build 2>/dev/null > log.txt' }), true);

  // Read-only diagnostics MUST still pass (the WebStorm-style investigation case).
  assert.equal(isMutatingPreToolUse('Bash', { command: 'cat /var/log/app.log' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'grep -r error src' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'ps aux | grep webstorm' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'git status' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'node --version' }), false);
  assert.equal(isMutatingPreToolUse('Bash', { command: 'python analyze.py' }), false);
});

test('isReadOnlyOrientationToolUse allows orientation, not mutation/spawns', () => {
  assert.equal(isReadOnlyOrientationToolUse('Read', {}), true);
  assert.equal(isReadOnlyOrientationToolUse('Bash', { command: 'pwd' }), true);
  assert.equal(isReadOnlyOrientationToolUse('Bash', { command: 'rm x' }), false);
  assert.equal(isReadOnlyOrientationToolUse('Task', {}), false);
});

test('isStateFileOnlyPatch detects an apply_patch touching only the state file', () => {
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: '*** Update File: .traffic-one/.one.json\n+x' }), true);
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: '*** Update File: src/app.ts\n+x' }), false);
  assert.equal(isStateFileOnlyPatch('Bash', { command: 'ls' }), false);
});

// Cursor parses tool events into a canonical ToolInput whose rawName is a COARSE
// subcommand (before-shell-execution …) the classifiers don't recognize, and whose
// command/path live on the parsed tool — NOT raw.tool_input. canonicalToolName +
// parsedToolInput bridge that so the gate's allow-checks work on Cursor.
const cursorTool = (over: Partial<ToolInput>): ToolInput => ({ class: 'shell', rawName: 'before-shell-execution', ...over });

test('canonicalToolName maps Cursor coarse subcommands to recognized names; keeps known names', () => {
  assert.equal(canonicalToolName(cursorTool({ class: 'shell', rawName: 'before-shell-execution' })), 'Bash');
  assert.equal(canonicalToolName(cursorTool({ class: 'file-read', rawName: 'before-read-file' })), 'Read');
  assert.equal(canonicalToolName(cursorTool({ class: 'file-edit', rawName: 'after-file-edit' })), 'Edit');
  // Already-canonical rawName (Claude/Codex) is preserved unchanged.
  assert.equal(canonicalToolName(cursorTool({ class: 'shell', rawName: 'Bash' })), 'Bash');
  assert.equal(canonicalToolName(cursorTool({ class: 'file-edit', rawName: 'apply_patch' })), 'apply_patch');
  assert.equal(canonicalToolName(undefined), '');
});

test('parsedToolInput lifts command/path/content off the parsed tool (Cursor has no raw.tool_input)', () => {
  assert.deepEqual(parsedToolInput(cursorTool({ command: 'node x/onboarding-wait.cjs /p' })), { command: 'node x/onboarding-wait.cjs /p' });
  assert.deepEqual(parsedToolInput(cursorTool({ class: 'file-read', filePath: '/p/a.ts' })), { file_path: '/p/a.ts' });
  assert.equal(parsedToolInput(cursorTool({})), null);
});

test('REGRESSION: a Cursor wait command + orientation read now classify as allowed', () => {
  const waitTool = cursorTool({ command: onboardingWaitCommand('/proj', 'cursor') });
  assert.equal(isOnboardingWaitCommand(canonicalToolName(waitTool), parsedToolInput(waitTool) || {}), true);
  const readTool = cursorTool({ class: 'file-read', rawName: 'before-read-file', filePath: '/proj/x.ts' });
  assert.equal(isReadOnlyOrientationToolUse(canonicalToolName(readTool), parsedToolInput(readTool) || {}), true);
});
