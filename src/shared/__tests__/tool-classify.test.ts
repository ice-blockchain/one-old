import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  canonicalToolName,
  commandFromToolInput,
  isMutatingPreToolUse,
  isOnboardingBootstrapCommand,
  isOnboardingSetTechCommand,
  isOnboardingWaitCommand,
  isReadOnlyOrientationToolUse,
  isShellToolName,
  isStateFileOnlyPatch,
  isStateFileOnlyWritePatch,
  isStateFilePath,
  isTrafficOneDoctorCommand,
  isWriteLikeToolName,
  normalizedToolName,
  parsedToolInput,
} from '../tool-classify';
import type { ToolInput } from '../../core/types';
import { doctorScriptPath, doctorShimPath, gateExemptDoctorScriptPaths, selfRelativePluginRoot } from '../doctor-command';
import { RUNNER_SHIMS, documentedBinDir } from '../runner-shims';
import { onboardingDeclineCommand, onboardingReconsiderCommand, onboardingSetTechCommand, onboardingSetTechCommandTemplate, onboardingUseBootstrapCommand, onboardingUseCommand, onboardingWaitCommand } from '../onboarding-server/wait-command';

const ENV_ROOT_KEYS = ['TRAFFIC_ONE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_PLUGIN_ROOT'] as const;
const SELF_ROOT = selfRelativePluginRoot();

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
  const patch = (filePath: string) => ({ patch: `*** Begin Patch\n*** Add File: ${filePath}\n+x\n*** End Patch` });
  assert.equal(isStateFileOnlyPatch('apply_patch', patch('.traffic-one/.one.json')), true);
  assert.equal(isStateFileOnlyPatch('apply_patch', patch('src/app.ts')), false);
  assert.equal(isStateFileOnlyPatch('apply_patch', {
    output: { args: { patch: `*** Begin Patch\n*** Add File: .traffic-one/.one.json\n+x\n*** Add File: src/app.ts\n+y\n*** End Patch` } },
  }), false);
  assert.equal(isStateFileOnlyPatch('Bash', { command: 'ls' }), false);
});

// The exemption-side predicate. It answers a NARROWER question than the one
// above, and the pair must stay a pair: isStateFileOnlyPatch is also what
// SELECTS the writes the team-mode guards inspect, so it deliberately keeps
// admitting the destructive shapes this one refuses.
test('isStateFileOnlyWritePatch admits add/update of the state file and refuses delete/move', () => {
  const add = '*** Begin Patch\n*** Add File: .traffic-one/.one.json\n+{}\n*** End Patch';
  const update = '*** Begin Patch\n*** Update File: .traffic-one/.one.json\n@@\n-{}\n+{"stack":"default"}\n*** End Patch';
  const remove = '*** Begin Patch\n*** Delete File: .traffic-one/.one.json\n*** End Patch';
  const move = '*** Begin Patch\n*** Update File: .traffic-one/.one.json\n'
    + '*** Move to: nested/.traffic-one/.one.json\n@@\n-{}\n+{"stack":"default"}\n*** End Patch';

  assert.equal(isStateFileOnlyWritePatch('apply_patch', { patch: add }), true);
  assert.equal(isStateFileOnlyWritePatch('apply_patch', { patch: update }), true);
  assert.equal(isStateFileOnlyWritePatch('apply_patch', { patch: remove }), false, 'deleting the state file is not writing it');
  assert.equal(isStateFileOnlyWritePatch('apply_patch', { patch: move }), false, 'a move is a delete at the source');
  assert.equal(isStateFileOnlyWritePatch('apply_patch', { patch: '*** Begin Patch\n*** Add File: src/app.ts\n+x\n*** End Patch' }), false);
  assert.equal(isStateFileOnlyWritePatch('Bash', { command: 'ls' }), false);

  // The wider predicate keeps its own answer: narrowing it in place would stop
  // the team-mode downgrade guard inspecting a move-with-hunks patch.
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: remove }), true);
  assert.equal(isStateFileOnlyPatch('apply_patch', { patch: move }), true);
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

// ── The agent tech-classification command (--set-tech) ──────────────────────

test('isOnboardingSetTechCommand round-trips the generated command and enforces the id vocabularies', () => {
  const full = onboardingSetTechCommand('/proj', 'claude', {
    frontend: 'none',
    backend: 'node',
    realtime: 'light',
    evidence: 'express + mongoose in package.json',
  }, 'sess-1');
  assert.equal(isOnboardingSetTechCommand('Bash', { command: full }), true, full);
  // A set-tech command is also a recognized runner invocation (gates admit it).
  assert.equal(isOnboardingWaitCommand('Bash', { command: full }), true);
  // But it is NOT a bootstrap.
  assert.equal(isOnboardingBootstrapCommand('Bash', { command: full }), false);

  const withMobile = onboardingSetTechCommand('/proj', 'codex', {
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: 'react-native-expo',
  });
  assert.equal(isOnboardingSetTechCommand('Bash', { command: withMobile }), true, withMobile);

  const template = onboardingSetTechCommandTemplate('/proj', 'claude');
  // The bare template misses the REQUIRED surfaces — never allowed as-is.
  assert.equal(isOnboardingSetTechCommand('Bash', { command: template }), false);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${template} '--frontend=none' '--backend=node'` }), true);
  // Frontend AND backend are both required.
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${template} '--backend=node'` }), false);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${template} '--frontend=none'` }), false);
});

test('set-tech rejects unknown ids, duplicates, oversized evidence, and cross-mode flags', () => {
  const base = onboardingSetTechCommandTemplate('/proj', 'claude');
  // Unknown ids never reach the runner.
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=reactjs' '--backend=node'` }), false);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--backend=express'` }), false);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--backend=node' '--mobile=cordova'` }), false);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--backend=node' '--realtime=heavy'` }), false);
  // Duplicate flags are rejected.
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--frontend=none' '--backend=node'` }), false);
  // Oversized evidence is rejected.
  const bigEvidence = 'x'.repeat(401);
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--backend=node' '--evidence=${bigEvidence}'` }), false);
  // Wait-only flags stay rejected on the exit-fast set-tech mode.
  assert.equal(isOnboardingSetTechCommand('Bash', { command: `${base} '--frontend=none' '--backend=node' '--quiet-url'` }), false);
  // Surface flags never leak onto OTHER modes.
  const wait = onboardingWaitCommand('/proj', 'claude');
  assert.equal(isOnboardingWaitCommand('Bash', { command: `${wait} '--frontend=none'` }), false);
  const decline = onboardingDeclineCommand('/proj', 'claude');
  assert.equal(isOnboardingWaitCommand('Bash', { command: `${decline} '--backend=node'` }), false);
});

// ── isTrafficOneDoctorCommand: bounded exact argv grammar ────────────────────
// Every documented invocation, in both shipped path spellings, then an
// adversarial table of every bypass shape the work item enumerates. Each MUST
// print its own line so the report can paste real `node --test` output as the
// adversarial table.

test('isTrafficOneDoctorCommand accepts every documented form', () => {
  const script = doctorScriptPath();
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script}` }), true, 'bare');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script} --run 1785169657252` }), true, '--run <id>');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script} --bundle` }), true, '--bundle');
  // `--session <id>` is a live, shipped flag (runners/doctor/lib.ts) and is as
  // read-only as the rest; a UUID-shaped Codex session id must pass.
  assert.equal(
    isTrafficOneDoctorCommand('Bash', { command: `node ${script} --session 019fbca1-2222-4333-8444-555566667777` }),
    true,
    '--session <uuid>',
  );
  // The one accepted flag COMBINATION — what the operator report prints for a
  // bug report against a specific run.
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${script} --run 1785169657252 --bundle` }), true, '--run <id> --bundle');
  // exec_command (Codex) and case-insensitive tool-name matching both work —
  // isTrafficOneDoctorCommand only cares that it is A shell tool.
  assert.equal(isTrafficOneDoctorCommand('exec_command', { cmd: `node ${script}` }), true, 'exec_command tool name');
  // Quoting the script path changes nothing: cleanShellWords unquotes before
  // this function ever sees the words.
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node '${script}' --bundle` }), true, 'single-quoted path');
  // Outer whitespace is inert (commandFromToolInput/callers already trim,
  // and this function trims again).
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `  node ${script}  ` }), true, 'leading/trailing whitespace');
  // Not a shell tool at all — a file write named exactly the same string is
  // never doctor, whatever its `content` says.
  assert.equal(isTrafficOneDoctorCommand('Write', { command: `node ${script}` }), false, 'non-shell tool name');
});

test('isTrafficOneDoctorCommand adversarial table: every bypass attempt is rejected', () => {
  const script = doctorScriptPath();
  const cases: Array<[string, string]> = [
    ['extra trailing argument after --bundle', `node ${script} --bundle extra`],
    ['extra trailing argument after bare form', `node ${script} extra`],
    ['unknown flag', `node ${script} --verbose`],
    ['--run with a path-shaped value (traversal attempt)', `node ${script} --run /etc/passwd`],
    ['--run with a value starting with a dot (parent-dir shape)', `node ${script} --run ../../etc`],
    ['--run with no value', `node ${script} --run`],
    ['--run with a flag-shaped value (flag/value confusion)', `node ${script} --run --bundle`],
    ['&& chaining', `node ${script} && rm -rf /`],
    ['; chaining', `node ${script}; rm -rf /`],
    ['| piping', `node ${script} | tee /tmp/x`],
    ['output redirection', `node ${script} > /tmp/out.txt`],
    ['input redirection', `node ${script} < /etc/passwd`],
    ['command substitution ($())', `node $(echo ${script})`],
    ['command substitution (backticks)', `node \`echo ${script}\``],
    ['leading environment-variable assignment', `FOO=bar node ${script}`],
    ['npx wrapper instead of node', `npx ${script}`],
    ['node with an interpreter flag before the script', `node --experimental-vm-modules ${script}`],
    ['a different absolute path merely ending in doctor.cjs', 'node /tmp/evil/doctor.cjs'],
    ['uppercase Node (case-sensitive binary)', `Node ${script}`],
    ['uppercase --Bundle flag (case-sensitive flag)', `node ${script} --Bundle`],
    ['duplicate --bundle flags', `node ${script} --bundle --bundle`],
    ['glob character in argv', `node ${script} --run *`],
    ['unterminated quote', `node ${script} --run 'abc`],
    // DOCTOR_ID_PATTERN: alnum runs joined by SINGLE separators, so every
    // traversal-flavoured spelling a flat character class used to admit fails.
    ['--run with doubled dots between separators', `node ${script} --run a..-..-..`],
    ['--run with a bare double dot', `node ${script} --run ..`],
    ['--run with a trailing separator', `node ${script} --run 1785169657252-`],
    ['--run with a leading separator', `node ${script} --run _1785169657252`],
    ['--run with a doubled separator', `node ${script} --run a__b`],
    ['--session with doubled dots', `node ${script} --session a..b`],
    ['--session with no value', `node ${script} --session`],
    ['--session with a flag-shaped value', `node ${script} --session --bundle`],
    ['--bundle before --run (order is exact)', `node ${script} --bundle --run 1785169657252`],
    ['--run <id> --session <id> (unaccepted combination)', `node ${script} --run 1785169657252 --session abc`],
    // cleanShellWords splits on [ \t] only, matching the shell: a NBSP or
    // U+3000 stays inside the word, so `node<NBSP><script>` is one word that
    // names no binary — exactly what bash/zsh/sh do (exit 127).
    ['NBSP instead of a space', `node\u00a0${script}`],
    ['ideographic space instead of a space', `node\u3000${script}`],
    ['vertical tab instead of a space', `node\v${script}`],
    ['form feed instead of a space', `node\f${script}`],
    ['line separator instead of a space', `node\u2028${script}`],
    // Tilde: only `~`/`~/…` for the CURRENT user expands; ~user does not.
    ['~user tilde form', 'node ~root/.traffic-one/bin/doctor.cjs'],
    ['tilde mid-word', `node x~${script}`],
    ['bare tilde as the script', 'node ~'],
  ];
  for (const [label, command] of cases) {
    assert.equal(isTrafficOneDoctorCommand('Bash', { command }), false, `${label}: ${command}`);
  }
});

// ── the grammar's trust anchor ───────────────────────────────────────────────
// BLOCKER 2: `doctorScriptPath()` used to resolve through pluginRootInfo(),
// which prefers four *_PLUGIN_ROOT env vars over its self-relative default.
// That made the exemption's identity check env-controlled — a forged root got
// its arbitrary `scripts/doctor.cjs` exempted, and (the likelier, benign
// failure) a user with a STALE override got the stale doctor exempted and the
// running one denied. Both halves are self-relative now: the path the runtime
// PRINTS and the path the gate ACCEPTS are the same two constants, so no env
// var can make us advertise a command the gate then blocks.

test('the doctor grammar accepts the version-stable ~/.traffic-one/bin shim, including the ~ spelling', () => {
  const shim = doctorShimPath();
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${shim}` }), true, 'absolute shim path');
  assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${shim} --bundle` }), true, 'absolute shim path + --bundle');
  // The shim is a real entry in runner-shims.ts's RUNNER_SHIMS, not a path
  // this grammar invented — if that entry ever disappears, the exemption
  // would be admitting a path nothing writes.
  assert.ok(RUNNER_SHIMS.some((entry) => entry.shim === 'doctor.cjs'), 'doctor.cjs is a shipped runner shim');
  // documentedBinDir(), not stableBinDir(). This line asserted stableBinDir()
  // and passed only by COINCIDENCE: the two resolve to the same directory on a
  // machine with neither XDG_STATE_HOME nor TRAFFIC_ONE_TOOLCHAIN_ROOT set, and
  // until the suite pinned its own state root (src/build/test-preload.mjs) that
  // was every test run. It is the wrong expectation on its merits, not just
  // fragile: doctor-command.ts's doctorShimPath() documents at length that it
  // uses documentedBinDir() DELIBERATELY, because `~/.traffic-one/bin/doctor.cjs`
  // is the literal ~60 shipped prose sites hardcode, and following XDG there
  // would make the printed path diverge from the documented one on exactly the
  // machines (Linux) that set it. So the old assertion would have failed on a
  // real relocated-state install while passing in CI.
  // The divergence itself is covered deliberately, not lost: the HOME/XDG/
  // TOOLCHAIN_ROOT matrix in shared/__tests__/doctor-command.test.ts.
  assert.equal(shim, path.join(documentedBinDir(), 'doctor.cjs'));
  const home = process.env.HOME || os.homedir();
  if (shim.startsWith(`${home}/`)) {
    const tilde = `~${shim.slice(home.length)}`;
    assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${tilde}` }), true, `~ spelling: node ${tilde}`);
    assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${tilde} --session abc-123` }), true, '~ spelling + --session');
  }
});

test('the doctor grammar rejects a forged plugin root even when it classifies as installed', () => {
  const forged = fs.mkdtempSync(path.join(os.tmpdir(), 'forged-plugin-root-'));
  const saved = ENV_ROOT_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    // The reviewer's forge, in its STRONGER form: real content under rules/ and
    // a file at scripts/hook-runtime.cjs, so the tightened layout classifier
    // reports 'installed' for it. Neither half of the doctor contract may move.
    fs.mkdirSync(path.join(forged, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(forged, 'rules'), { recursive: true });
    fs.writeFileSync(path.join(forged, 'scripts', 'doctor.cjs'), 'ARBITRARY\n', 'utf8');
    fs.writeFileSync(path.join(forged, 'scripts', 'hook-runtime.cjs'), '', 'utf8');
    fs.writeFileSync(path.join(forged, 'rules', 'core.md'), '# forged rule\n', 'utf8');
    for (const [key] of saved) delete process.env[key];
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = forged;

    const forgedScript = path.join(forged, 'scripts', 'doctor.cjs');
    // The prose side does not follow the forge either: a user is never told to
    // run a script an env var pointed at, so the two halves cannot diverge.
    assert.equal(doctorScriptPath(), path.join(SELF_ROOT, 'scripts', 'doctor.cjs'), 'prose stays self-relative');
    assert.notEqual(doctorScriptPath(), forgedScript, 'prose never names the forged script');
    assert.equal(
      isTrafficOneDoctorCommand('Bash', { command: `node ${forgedScript}` }),
      false,
      'a forged/foreign plugin root is never gate-exempt',
    );
    // …and the doctor that actually ships with the RUNNING runtime stays
    // exempt while the forge is in place. This is the half the old anchor got
    // backwards: it exempted the forged path and denied the real one.
    const real = path.join(SELF_ROOT, 'scripts', 'doctor.cjs');
    assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${real}` }), true, 'the running runtime\'s own doctor stays exempt');
    // The shim is anchored on HOME, not on any plugin-root env var.
    assert.equal(isTrafficOneDoctorCommand('Bash', { command: `node ${doctorShimPath()}` }), true, 'the HOME shim stays exempt');
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(forged, { recursive: true, force: true });
  }
});

test('the gate-exempt doctor paths never come from a *_PLUGIN_ROOT env var', () => {
  const saved = ENV_ROOT_KEYS.map((key) => [key, process.env[key]] as const);
  try {
    const baseline = gateExemptDoctorScriptPaths();
    for (const key of ENV_ROOT_KEYS) {
      for (const [k] of saved) delete process.env[k];
      process.env[key] = '/tmp/some/other/root';
      assert.deepEqual(gateExemptDoctorScriptPaths(), baseline, `${key} must not move the anchor`);
    }
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
