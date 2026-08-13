// The state-loss notice's one surface: SessionStart's advisory list.
//
// The notice is composed in shared/state/state-loss.ts and priced row by row
// there. What these tests pin is the half that decides whether it is safe: it
// rides the same merge as the one-mcp, auth and uncertified-host advisories, so
// it can never become a refusal, it reaches the user on the exits a wiped
// project actually takes, and it stays out of every gate verdict.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runSessionStart } from '../session-start';
import type { Ctx, HookInput } from '../../../core/types';
import { runClaudeHook } from '../../../hooks/claude-entry';
import { stateLossNotice } from '../../../shared/state/state-loss';
import { statePath, writeState } from '../../../shared/state/normalize';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { mergeProjectPrefs } from '../../../shared/state/local-prefs';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';

process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

const NOTICE_MARKER = 'STATE WAS RESET';
const created: string[] = [];

function ctx(cwd: string): Ctx {
  const input: HookInput = { event: 'SessionStart', host: 'claude', cwd, raw: {} };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function onboardedProject(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `t1-sl-session-${label}-`)));
  created.push(dir);
  resetAuthoringRootCache();
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
  execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
  writeGlobalCodeGraphProvider('graphify');
  recordPluginUseChoice(dir, true, 'session-state-loss-test');
  mergeProjectPrefs(dir, hostScopedPerformancePrefs(
    { level: 'low', source: 'prompted' },
    { mode: 'main-agent', source: 'prompted' },
    'pro',
  ) as Record<string, unknown>);
  mergeProjectPrefs(dir, { openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' } });
  assert.equal(writeState(dir, {
    mode: 'existing-codebase', stack: 'minimal', frontend: 'none', backend: 'other', realtime: 'none',
    confirmed: true, onboardingComplete: true, confirmedAt: '2026-01-01T00:00:00Z', currentRunId: 'SL-1',
  }), true, 'fixture guard: the real writer accepted the state file');
  execFileSync('git', ['-C', dir, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', dir, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-qm', 'state'], { stdio: 'ignore' });
  return dir;
}

function wipe(dir: string): void {
  fs.rmSync(path.join(dir, '.traffic-one'), { recursive: true, force: true });
}

test('a wiped project gets the notice on the SessionStart context, and the exit is still not a refusal', () => {
  const dir = onboardedProject('wiped');
  wipe(dir);
  const notice = stateLossNotice(dir);
  assert.ok(notice, 'fixture guard: the notice is composable for this project');
  const result = runSessionStart(ctx(dir));
  assert.equal(result.kind, 'context', 'SessionStart still returns context — never a deny');
  assert.ok((result as { context: string }).context.includes(notice!), 'the verbatim notice reaches the user-visible context');
});

test('the notice leads the context — it is not buried under the rule bundle', () => {
  const dir = onboardedProject('leads');
  wipe(dir);
  const result = runSessionStart(ctx(dir)) as { kind: string; context: string };
  assert.equal(result.kind, 'context');
  assert.ok(result.context.startsWith('[traffic-one] STATE WAS RESET'), 'first advisory in the list, so first in the merged context');
});

test('a healthy onboarded project gets no state-loss prose at all', () => {
  const dir = onboardedProject('healthy');
  const result = runSessionStart(ctx(dir));
  const text = result.kind === 'context' ? (result as { context: string }).context : '';
  assert.ok(!text.includes(NOTICE_MARKER), 'nothing is said about a loss that did not happen');
});

test('a project that declined Traffic One stays silent even after a wipe', () => {
  const dir = onboardedProject('declined');
  wipe(dir);
  recordPluginUseChoice(dir, false, 'session-state-loss-test');
  const result = runSessionStart(ctx(dir));
  assert.equal(result.kind, 'noop', 'a decline stands the whole hook down, and this notice does not reopen it');
});

test('no gate verdict carries the notice — it exists only on the session context', async () => {
  const dir = onboardedProject('gates');
  wipe(dir);
  assert.ok(stateLossNotice(dir), 'fixture guard: this project would be disclosed at SessionStart');
  const calls: Array<[string, string, Record<string, unknown>]> = [
    ['check-onboarding-gate', 'Bash', { command: 'npm install lodash' }],
    ['check-plan-write', 'Bash', { command: 'rm -rf .traffic-one' }],
    ['check-plan-write', 'Write', { file_path: 'src/rogue.ts', content: 'export const x = 1;\n' }],
    ['check-onboarding-gate', 'Task', { subagent_type: 'senior-frontend', description: 'w', prompt: 'w' }],
    ['check-agent-model', 'Task', { subagent_type: 'senior-frontend', description: 'w', prompt: 'w' }],
  ];
  for (const [subcommand, tool, toolInput] of calls) {
    const result = await runClaudeHook(subcommand, JSON.stringify({
      hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, cwd: dir,
    }));
    assert.ok(!result.stdout.includes(NOTICE_MARKER), `${subcommand}/${tool} must not carry the notice`);
  }
});

test('cleanup', () => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});
