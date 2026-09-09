// Composition of Layers A–D: a marker-less child under an enclosing project
// must not become its own consent subject. The deadlock is pending child +
// enclosing parent + mutating Write (often with the host ceiling at the child):
// ask-first named the child, prefs CREATE refused that bucket, and the question
// never settled. These cases drive the real functions together; they do not
// re-pin a single layer.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { onboardingGate } from '../../modules/onboarding-gate/handler';
import { runSessionStart, runSessionStartAuthed } from '../../modules/session/session-start';
import { sessionProjectRoot } from '../../modules/session/session-start-setup';
import { applyUseChoice, declineOutput } from '../../runners/onboarding-wait/wizard-output';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../core/types';
import { isOnboardedProjectRoot, resolveProjectRoot } from '../hook/paths';
import { usePluginQuestionPending } from '../onboarding-server/flow';
import {
  onboardingDeclineCommand,
  onboardingUseBootstrapCommand,
  usePluginQuestion,
} from '../onboarding-server/wait-command';
import { shellQuote } from '../shell-quote';
import { defaultProjectPrefsPath } from '../state/local-prefs';
import {
  pluginUseDeclined,
  projectWritesPermitted,
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../state/plugin-use';
import { resolveToolScope } from '../tool-scope';

const ASK_KEYS = [
  'HOME',
  'XDG_STATE_HOME',
  'TRAFFIC_ONE_PROJECT_PREFS_PATH',
  'TRAFFIC_ONE_ASK_USE_PLUGIN',
  'TRAFFIC_ONE_AUTH',
  'TRAFFIC_ONE_ONBOARDING_NO_SPAWN',
] as const;

type IsolatedFn = (ctx: {
  root: string;
  env: NodeJS.ProcessEnv;
  parent: string;
  child: string;
}) => void;

function writeLeak(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

function childStateDir(child: string): string {
  return path.join(child, '.traffic-one');
}

function gitLayout(root: string): { parent: string; child: string } {
  const parent = path.join(root, 'mercury');
  const child = path.join(parent, 'strategies');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(path.join(parent, '.git'), { recursive: true });
  return { parent, child };
}

function pkgLayout(root: string): { parent: string; child: string } {
  const parent = path.join(root, 'pkg');
  const child = path.join(parent, 'src');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, 'package.json'), '{"name":"pkg"}\n', 'utf8');
  return { parent, child };
}

function plantExistingCodebase(dir: string): void {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'mercury',
    dependencies: { next: '15.0.0', react: '19.0.0' },
  }), 'utf8');
  const app = path.join(dir, 'app');
  fs.mkdirSync(app, { recursive: true });
  for (let i = 0; i < 6; i += 1) {
    fs.writeFileSync(path.join(app, `file-${i}.tsx`), `export const v${i} = ${i};\n`, 'utf8');
  }
}

function writeGateCtx(cwd: string, workspaceRoot: string | undefined, filePath: string): Ctx {
  const toolInput = { file_path: filePath, content: 'x' };
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude',
    cwd,
    workspaceRoot,
    raw: { tool_name: 'Write', tool_input: toolInput },
    tool: { class: 'file-write' as ToolClass, rawName: 'Write', filePath },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function sessionCtx(cwd: string, workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'SessionStart',
    host: 'claude',
    cwd,
    workspaceRoot,
    raw: {},
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as Ctx;
}

function silenceStderr<T>(fn: () => T): T {
  const original = process.stderr.write;
  process.stderr.write = ((() => true) as unknown) as typeof process.stderr.write;
  try {
    return fn();
  } finally {
    process.stderr.write = original;
  }
}

function denyReason(result: HookResult): string {
  return result.kind === 'deny' ? result.reason : '';
}

function contextText(result: HookResult): string {
  return result.kind === 'context' ? (result.context || '') : '';
}

function assertAskFirstNamesParent(result: HookResult, parent: string, child: string): void {
  assert.equal(result.kind, 'deny');
  assert.equal(result.kind === 'deny' ? result.denyId : '', 'onboarding-use-plugin-question');
  const reason = denyReason(result);
  assert.ok(reason.includes(shellQuote(parent)), 'deny reason --use/--decline argv names the parent');
  assert.ok(!reason.includes(shellQuote(child)), 'deny reason argv is not the marker-less child');
  assert.ok(reason.includes(onboardingUseBootstrapCommand(parent, 'claude')));
  assert.ok(reason.includes(onboardingDeclineCommand(parent, 'claude')));
}

function assertCommandsBakeParent(child: string, parent: string, env: NodeJS.ProcessEnv): void {
  const question = usePluginQuestion(child, 'claude', undefined, undefined, env);
  const decline = onboardingDeclineCommand(child, 'claude', env);
  const useBootstrap = onboardingUseBootstrapCommand(child, 'claude', undefined, undefined, env);
  assert.equal(decline, onboardingDeclineCommand(parent, 'claude', env));
  assert.equal(useBootstrap, onboardingUseBootstrapCommand(parent, 'claude', undefined, undefined, env));
  for (const text of [question, decline, useBootstrap]) {
    assert.ok(text.includes(shellQuote(parent)), 'waiter cwd argv is the enclosing parent');
    assert.ok(!text.includes(shellQuote(child)), 'waiter cwd argv is not the marker-less child');
  }
}

function withIsolatedTree(
  prefix: string,
  layout: (root: string) => { parent: string; child: string },
  fn: IsolatedFn,
): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const saved: Record<string, string | undefined> = {};
  for (const key of ASK_KEYS) saved[key] = process.env[key];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: path.join(root, 'home'),
    XDG_STATE_HOME: path.join(root, 'xdg'),
    TRAFFIC_ONE_ASK_USE_PLUGIN: '1',
    TRAFFIC_ONE_AUTH: '0',
    TRAFFIC_ONE_ONBOARDING_NO_SPAWN: '1',
  };
  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.HOME = env.HOME;
  process.env.XDG_STATE_HOME = env.XDG_STATE_HOME;
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  process.env.TRAFFIC_ONE_AUTH = '0';
  process.env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  resetPluginUseCache();
  try {
    const { parent, child } = layout(root);
    fn({ root, env, parent, child });
  } finally {
    for (const key of ASK_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('enclosed-folder consent deadlock (A–D composition)', { concurrency: 1 }, () => {
  test('1. git parent, marker-less child, hook cwd = child: ask-first names the parent', () => {
    withIsolatedTree('t1-deadlock-git-', gitLayout, ({ parent, child, env }) => {
      const filePath = path.join(child, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      assert.equal(resolveProjectRoot(child), parent);
      assert.equal(resolveProjectRoot(child, filePath, { ceiling: child }), parent);
      assert.equal(sessionProjectRoot(sessionCtx(child)), parent);
      assert.equal(sessionProjectRoot(sessionCtx(child, child)), parent);
      assertCommandsBakeParent(child, parent, env);

      assert.equal(usePluginQuestionPending(parent, env), true);
      assert.equal(usePluginQuestionPending(child, env), true);
      assert.equal(projectWritesPermitted(child, env), false);
      assert.equal(readPluginUseChoice(child, env), null);

      const denied = onboardingGate(writeGateCtx(child, child, filePath));
      assertAskFirstNamesParent(denied, parent, child);
    });
  });

  test('2. package.json-only parent (no .git): same cwd-fallback hole', () => {
    withIsolatedTree('t1-deadlock-pkg-', pkgLayout, ({ parent, child, env }) => {
      const filePath = path.join(child, 'index.ts');
      fs.writeFileSync(filePath, 'export {}\n', 'utf8');
      assert.equal(fs.existsSync(path.join(parent, '.git')), false, 'fixture guard: no VCS');

      assert.equal(resolveProjectRoot(child), parent);
      assert.equal(resolveProjectRoot(child, filePath), parent);
      assert.equal(sessionProjectRoot(sessionCtx(child)), parent);
      assertCommandsBakeParent(child, parent, env);

      const denied = onboardingGate(writeGateCtx(child, child, filePath));
      assertAskFirstNamesParent(denied, parent, child);
      assert.equal(usePluginQuestionPending(parent, env), true);
    });
  });

  test('3. parent already pluginUse.enabled=true: child write is not ask-first deny', () => {
    withIsolatedTree('t1-deadlock-parent-yes-', gitLayout, ({ parent, child, env }) => {
      const filePath = path.join(child, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      assert.equal(recordPluginUseChoice(parent, true, 'command', env), true);
      resetPluginUseCache();

      assert.equal(readPluginUseChoice(child, env)?.enabled, true);
      assert.equal(projectWritesPermitted(child, env), true);
      assert.equal(usePluginQuestionPending(child, env), false);
      assert.equal(usePluginQuestionPending(parent, env), false);

      const result = onboardingGate(writeGateCtx(child, child, filePath));
      assert.notEqual(result.kind === 'deny' ? result.denyId : '', 'onboarding-use-plugin-question');
      assert.ok(!denyReason(result).includes('Do you want to use the Traffic One plugin'));
      assert.ok(!denyReason(result).includes(usePluginQuestion(child, 'claude', undefined, undefined, env)));
    });
  });

  test('4. --decline child while parent pending: veto, write nothing, parent still pending', () => {
    withIsolatedTree('t1-deadlock-decline-child-', gitLayout, ({ parent, child, env }) => {
      const parentPrefs = defaultProjectPrefsPath(parent, env);
      const childPrefs = defaultProjectPrefsPath(child, env);
      assert.equal(fs.existsSync(parentPrefs), false, 'fixture guard: no parent bucket');
      assert.equal(fs.existsSync(childPrefs), false, 'fixture guard: no child bucket');

      const out = silenceStderr(() => declineOutput(child, 'claude'));
      assert.match(out, /^TRAFFIC_ONE_DISABLED\n/);
      assert.ok(out.includes('The decline was NOT saved'));
      const parentDecline = onboardingDeclineCommand(parent, 'claude', env);
      assert.ok(out.includes(parentDecline), 'unrecorded body embeds the exact parent --decline command');
      assert.equal(onboardingDeclineCommand(child, 'claude', env), parentDecline);

      assert.equal(fs.existsSync(childPrefs), false, 'child bucket still absent');
      assert.equal(fs.existsSync(parentPrefs), false, 'parent bucket still absent');
      assert.equal(readPluginUseChoice(parent, env), null);
      assert.equal(usePluginQuestionPending(parent, env), true);
      assert.equal(usePluginQuestionPending(child, env), true);
    });
  });

  test('5. --decline parent: child writes stand down via pluginUseDeclined, not re-asked', () => {
    withIsolatedTree('t1-deadlock-decline-parent-', gitLayout, ({ parent, child, env }) => {
      const filePath = path.join(child, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      const out = silenceStderr(() => declineOutput(parent, 'claude'));
      assert.match(out, /^TRAFFIC_ONE_DISABLED\n/);
      assert.ok(out.includes('Traffic One is disabled for this project'));
      assert.equal(readPluginUseChoice(parent, env)?.enabled, false);
      assert.equal(pluginUseDeclined(parent, env), true);
      assert.equal(pluginUseDeclined(child, env), true);
      assert.equal(usePluginQuestionPending(parent, env), false);
      assert.equal(usePluginQuestionPending(child, env), false);

      const result = onboardingGate(writeGateCtx(child, child, filePath));
      assert.equal(result.kind, 'noop', 'declined parent stands the gate down for the child write');
      assert.ok(!denyReason(result).includes('Do you want to use the Traffic One plugin'));
    });
  });

  test('6. --decline child must not flip a parent that is already yes', () => {
    withIsolatedTree('t1-deadlock-no-flip-yes-', gitLayout, ({ parent, child, env }) => {
      assert.equal(recordPluginUseChoice(parent, true, 'command', env), true);
      const parentPrefs = defaultProjectPrefsPath(parent, env);
      const childPrefs = defaultProjectPrefsPath(child, env);
      const parentBefore = fs.readFileSync(parentPrefs, 'utf8');
      assert.equal(fs.existsSync(childPrefs), false, 'fixture guard: no child bucket');

      const out = silenceStderr(() => declineOutput(child, 'claude'));
      assert.match(out, /^TRAFFIC_ONE_DISABLED\n/);
      assert.ok(out.includes(onboardingDeclineCommand(parent, 'claude', env)));
      assert.equal(fs.existsSync(childPrefs), false, 'child bucket still absent');
      assert.equal(fs.readFileSync(parentPrefs, 'utf8'), parentBefore, 'parent bucket unchanged');
      assert.equal(readPluginUseChoice(parent, env)?.enabled, true);
      assert.equal(pluginUseDeclined(parent, env), false);
      assert.equal(projectWritesPermitted(child, env), true);
    });
  });

  test('7. ceiling === child on a real git parent: decline-child still pending, decline-parent stands down', () => {
    withIsolatedTree('t1-deadlock-ceiling-', gitLayout, ({ parent, child, env }) => {
      const filePath = path.join(child, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });

      assert.equal(resolveProjectRoot(child, filePath, { ceiling: child }), parent);
      assert.equal(sessionProjectRoot(sessionCtx(child, child)), parent);
      assertAskFirstNamesParent(onboardingGate(writeGateCtx(child, child, filePath)), parent, child);

      silenceStderr(() => declineOutput(child, 'claude'));
      resetPluginUseCache();
      assert.equal(usePluginQuestionPending(parent, env), true, 'child --decline does not flip the parent');
      assert.equal(readPluginUseChoice(parent, env), null);
      assertAskFirstNamesParent(onboardingGate(writeGateCtx(child, child, filePath)), parent, child);

      silenceStderr(() => declineOutput(parent, 'claude'));
      resetPluginUseCache();
      assert.equal(pluginUseDeclined(parent, env), true);
      assert.equal(pluginUseDeclined(child, env), true);
      const afterParent = onboardingGate(writeGateCtx(child, child, filePath));
      assert.equal(afterParent.kind, 'noop');
    });
  });

  test('8. leaked mode-bearing .one.json in the child: consent follows parent; SessionStart sweeps; child decline does not onboard the leak', () => {
    withIsolatedTree('t1-deadlock-leak-', gitLayout, ({ parent, child, env }) => {
      writeLeak(child, { mode: 'new-project' });
      assert.equal(resolveProjectRoot(child), parent);
      assert.equal(resolveProjectRoot(child, '', { ceiling: child }), parent);
      assert.equal(sessionProjectRoot(sessionCtx(child, child)), parent);

      const childPrefs = defaultProjectPrefsPath(child, env);
      const parentPrefs = defaultProjectPrefsPath(parent, env);
      const declined = silenceStderr(() => declineOutput(child, 'claude'));
      assert.match(declined, /^TRAFFIC_ONE_DISABLED\n/);
      assert.ok(declined.includes('The decline was NOT saved'));
      assert.ok(declined.includes(onboardingDeclineCommand(parent, 'claude', env)));
      assert.equal(fs.existsSync(childPrefs), false, 'leak is not a prefs bucket');
      assert.equal(fs.existsSync(parentPrefs), false, 'child --decline does not write the parent');
      assert.equal(readPluginUseChoice(parent, env), null);
      assert.equal(usePluginQuestionPending(parent, env), true);
      assert.equal(resolveProjectRoot(child), parent, 'leak still remaps; it is not a consent identity');

      assert.equal(recordPluginUseChoice(parent, true, 'command', env), true);
      resetPluginUseCache();
      assert.equal(projectWritesPermitted(parent, env), true);
      writeLeak(child, { mode: 'new-project' });
      assert.equal(fs.existsSync(childStateDir(child)), true, 'fixture guard: leak replanted for the sweep');

      silenceStderr(() => runSessionStartAuthed(sessionCtx(child)));
      silenceStderr(() => runSessionStartAuthed(sessionCtx(child, child)));
      assert.equal(
        fs.existsSync(childStateDir(child)) && isOnboardedProjectRoot(child),
        false,
        'SessionStart sweep heals the leak: child .traffic-one gone or no longer a kept onboarded root',
      );
      assert.equal(resolveProjectRoot(child), parent);
    });
  });

  test('9. Write to a /tmp scratch file from a pending child is not judged as the child', () => {
    withIsolatedTree('t1-deadlock-tmp-', gitLayout, ({ parent, child }) => {
      const filePath = path.join(child, 'src', 'app.ts');
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-deadlock-scratch-')));
      const scratchFile = path.join(scratch, 'file.ts');
      try {
        assert.notEqual(path.resolve(scratch), path.resolve(os.tmpdir()), 'fixture guard: scratch is a tmp SUBDIR');
        assert.equal(resolveProjectRoot(child), parent, 'cwd identity is still the enclosing parent');
        assert.notEqual(resolveProjectRoot(child, scratchFile), child);
        assert.notEqual(resolveProjectRoot(child, scratchFile, { ceiling: child }), child);

        const ctx = writeGateCtx(child, child, scratchFile);
        const scope = resolveToolScope(ctx);
        assert.notEqual(scope.projectRoot, child, 'tool scope is not the enclosed child');

        const result = onboardingGate(ctx);
        const reason = denyReason(result);
        assert.ok(!reason.includes(shellQuote(child)), 'deny reason argv is not the enclosed child');
        // A deny that names the scratch dir as a new pending project is the
        // pre-existing /tmp-subdir hole (isMachineConfigRoot is exact-root only).
        // Do not fail the suite on it and do not widen that predicate here.
        if (result.kind === 'deny' && result.denyId === 'onboarding-use-plugin-question') {
          const namesParent = reason.includes(shellQuote(parent));
          const namesScratch = reason.includes(shellQuote(scratch));
          assert.ok(namesParent || namesScratch, 'ask-first names parent, or records the /tmp-subdir hole');
        }
      } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    });
  });

  test('10. waiter with no positional path after cd into the child vetoes and does not write the parent', () => {
    withIsolatedTree('t1-deadlock-waiter-cwd-', gitLayout, ({ parent, child, env }) => {
      const parentPrefs = defaultProjectPrefsPath(parent, env);
      const childPrefs = defaultProjectPrefsPath(child, env);
      const parentDecline = onboardingDeclineCommand(parent, 'claude', env);

      const declined = silenceStderr(() => declineOutput(child, 'claude'));
      assert.match(declined, /^TRAFFIC_ONE_DISABLED\n/);
      assert.ok(declined.includes(parentDecline));
      assert.equal(fs.existsSync(parentPrefs), false, 'cwd-as-child --decline does not write the parent');
      assert.equal(fs.existsSync(childPrefs), false);
      assert.equal(usePluginQuestionPending(parent, env), true);

      const used = silenceStderr(() => applyUseChoice(child, ['--use', child], env));
      assert.equal(used, false);
      assert.equal(fs.existsSync(childPrefs), false);
      assert.equal(fs.existsSync(parentPrefs), false, 'cwd-as-child --use does not write the parent');
      assert.equal(readPluginUseChoice(parent, env), null);
    });
  });

  test('11. SessionStart from a pending child must not stamp the child (or announce detection for it)', () => {
    withIsolatedTree('t1-deadlock-session-stamp-', (root) => {
      const { parent, child } = gitLayout(root);
      plantExistingCodebase(parent);
      return { parent, child };
    }, ({ parent, child, env }) => {
      assert.equal(usePluginQuestionPending(parent, env), true);
      assert.equal(projectWritesPermitted(parent, env), false);

      const fromStart = silenceStderr(() => runSessionStart(sessionCtx(child, child)));
      const fromAuthed = silenceStderr(() => runSessionStartAuthed(sessionCtx(child, child)));

      assert.equal(fs.existsSync(childStateDir(child)), false, 'no child/.traffic-one from SessionStart');
      assert.equal(fs.existsSync(path.join(parent, '.traffic-one', '.one.json')), false,
        'pending parent does not receive a detection stamp');

      const texts = [contextText(fromStart), contextText(fromAuthed)].join('\n');
      assert.ok(!texts.includes('auto-detected'), 'no existing-codebase detection announcement for the child');
      assert.ok(!texts.includes('stack auto-detected'));
      if (fromAuthed.kind === 'context') {
        assert.match(fromAuthed.context, /Do you want to use the Traffic One plugin/);
        assert.ok(fromAuthed.context.includes(shellQuote(parent)));
        assert.ok(!fromAuthed.context.includes(shellQuote(child)));
      }
    });
  });
});
