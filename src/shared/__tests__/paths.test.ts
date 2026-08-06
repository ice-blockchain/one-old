import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HookInput } from '../../core/types';
import {
  classifyPluginRootLayout,
  isInPluginCache,
  isManagedPluginCachePath,
  pluginRoot,
  pluginRootInfo,
  type PluginRootEnvVar,
  type PluginRootLayout,
  projectRoot,
} from '../paths';

// ── pluginRootInfo / classifyPluginRootLayout ───────────────────────────────
// Untested until now, which is how BOTH halves of the "materialization deleted
// the project's rules and skills" incident shipped: `existsSync` called an
// EMPTY `rules/` dir (and a plain FILE named `rules`) a complete install, and a
// relative env value was never absolutized. Every row below is a shape that a
// real machine produces — an interrupted marketplace install, a `dist/` caught
// mid-`npm run gen`, a half-finished `rsync`/`cp -R`, a stale exported env var.
// Two things are asserted for each: the layout, and that nothing throws. The
// no-throw half is load-bearing, not politeness: under tsx the resolved root is
// this checkout, so a throwing accessor breaks `npm test`, `npm run gen` and
// `npm run golden:update` rather than degrading one diagnostic.

const PLUGIN_ROOT_ENV_VARS: readonly PluginRootEnvVar[] = [
  'TRAFFIC_ONE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CURSOR_PLUGIN_ROOT',
];

// Every *_PLUGIN_ROOT var cleared, and any test's value restored afterwards, so
// a row never inherits the suite-wide pin from src/build/test-preload.mjs.
function withPluginRootEnv(fn: (set: (key: PluginRootEnvVar, value: string) => void) => void): void {
  const saved = new Map<PluginRootEnvVar, string | undefined>();
  for (const key of PLUGIN_ROOT_ENV_VARS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    fn((key, value) => { process.env[key] = value; });
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function file(target: string, body = 'x\n'): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body, 'utf8');
}

interface LayoutCase {
  readonly name: string;
  readonly expected: PluginRootLayout;
  // Returns the path to classify (usually `dir`, but a row may point elsewhere).
  readonly build: (dir: string) => string;
  readonly skip?: () => boolean;
}

const LAYOUT_CASES: readonly LayoutCase[] = [
  {
    name: 'healthy installed plugin (runtime file + populated rules/)',
    expected: 'installed',
    build: (dir) => {
      file(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// compiled\n');
      file(path.join(dir, 'rules', 'core.md'), '# core\n');
      return dir;
    },
  },
  {
    name: 'healthy installed plugin whose only content dir is skills-catalog/',
    expected: 'installed',
    build: (dir) => {
      file(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// compiled\n');
      file(path.join(dir, 'skills-catalog', 'project-memory', 'SKILL.md'), '# skill\n');
      return dir;
    },
  },
  {
    name: 'healthy source checkout (plugin-instructions.md + package.json)',
    expected: 'source',
    build: (dir) => {
      file(path.join(dir, 'src', 'gen', 'static', 'plugin-instructions.md'), '# stub\n');
      file(path.join(dir, 'package.json'), '{}\n');
      return dir;
    },
  },
  {
    // BLOCKER: existsSync said yes here, so this classified 'installed'.
    name: 'runtime + EMPTY rules/ (a dist caught mid-gen, an interrupted install)',
    expected: 'unverified',
    build: (dir) => {
      file(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// compiled\n');
      fs.mkdirSync(path.join(dir, 'rules'), { recursive: true });
      return dir;
    },
  },
  {
    name: 'runtime + rules/ holding only a dotfile is not content',
    expected: 'unverified',
    build: (dir) => {
      file(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// compiled\n');
      file(path.join(dir, 'rules', '.DS_Store'), 'junk\n');
      return dir;
    },
  },
  {
    // BLOCKER: `rules` as a plain FILE also satisfied existsSync.
    name: 'rules is a FILE, runtime is a DIRECTORY',
    expected: 'unverified',
    build: (dir) => {
      fs.mkdirSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), { recursive: true });
      file(path.join(dir, 'rules'), '');
      return dir;
    },
  },
  {
    name: 'hook-runtime.cjs is a DIRECTORY next to populated content',
    expected: 'unverified',
    build: (dir) => {
      fs.mkdirSync(path.join(dir, 'scripts', 'hook-runtime.cjs'), { recursive: true });
      file(path.join(dir, 'rules', 'core.md'), '# core\n');
      return dir;
    },
  },
  {
    name: 'dist mid-build: content written, scripts/ not compiled yet',
    expected: 'unverified',
    build: (dir) => {
      file(path.join(dir, 'rules', 'core.md'), '# core\n');
      file(path.join(dir, 'plugin.json'), '{}\n');
      return dir;
    },
  },
  {
    name: 'dist mid-build: no content dirs at all',
    expected: 'unverified',
    build: (dir) => {
      file(path.join(dir, 'agents', 'senior-frontend.md'), '# role\n');
      file(path.join(dir, 'plugin.json'), '{}\n');
      return dir;
    },
  },
  {
    name: 'source markers where package.json is a DIRECTORY',
    expected: 'unverified',
    build: (dir) => {
      file(path.join(dir, 'src', 'gen', 'static', 'plugin-instructions.md'), '# stub\n');
      fs.mkdirSync(path.join(dir, 'package.json'), { recursive: true });
      return dir;
    },
  },
  {
    name: 'nonexistent path',
    expected: 'unverified',
    build: (dir) => path.join(dir, 'nope', 'still-nope'),
  },
  {
    name: 'empty directory',
    expected: 'unverified',
    build: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
  },
  {
    name: 'the root path is itself a file',
    expected: 'unverified',
    build: (dir) => {
      file(dir, 'not a plugin\n');
      return dir;
    },
  },
  {
    // readdirSync raises EACCES, which must read as "no content", not throw.
    // Root ignores mode bits, so the row cannot prove anything as root.
    name: 'unreadable rules/ (mode 000) next to a real runtime',
    expected: 'unverified',
    skip: () => (typeof process.getuid === 'function' ? process.getuid() === 0 : true),
    build: (dir) => {
      file(path.join(dir, 'scripts', 'hook-runtime.cjs'), '// compiled\n');
      file(path.join(dir, 'rules', 'core.md'), '# core\n');
      fs.chmodSync(path.join(dir, 'rules'), 0o000);
      return dir;
    },
  },
  {
    name: 'symlink loop (ELOOP on every probe)',
    expected: 'unverified',
    build: (dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(path.join(dir, 'b'), path.join(dir, 'a'));
      fs.symlinkSync(path.join(dir, 'a'), path.join(dir, 'b'));
      return path.join(dir, 'a');
    },
  },
];

function withLayoutFixtures(fn: (rows: Array<{ name: string; expected: PluginRootLayout; root: string }>) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-layout-')));
  const rows: Array<{ name: string; expected: PluginRootLayout; root: string }> = [];
  try {
    for (const [index, layoutCase] of LAYOUT_CASES.entries()) {
      if (layoutCase.skip?.()) continue;
      rows.push({
        name: layoutCase.name,
        expected: layoutCase.expected,
        root: layoutCase.build(path.join(base, `case-${index}`)),
      });
    }
    fn(rows);
  } finally {
    for (const row of rows) {
      try { fs.chmodSync(path.join(row.root, 'rules'), 0o755); } catch { /* not every row has one */ }
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// A thrown error is reported as a value rather than through assert.doesNotThrow,
// so a failure names the row AND carries the error instead of just "threw".
function attempt<T>(fn: () => T): { ok: true; value: T } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

test('classifyPluginRootLayout: every hazardous root shape classifies correctly and nothing throws', () => {
  withLayoutFixtures((rows) => {
    assert.ok(rows.length >= 14, 'the table must actually cover the hazard list');
    for (const row of rows) {
      const outcome = attempt(() => classifyPluginRootLayout(row.root));
      assert.equal(outcome.ok, true, `${row.name} must not throw: ${outcome.ok ? '' : String(outcome.error)}`);
      assert.equal(outcome.ok && outcome.value, row.expected, row.name);
    }
  });
});

test('pluginRootInfo: the same shapes classify identically through all four env vars, and never throw', () => {
  withLayoutFixtures((rows) => {
    withPluginRootEnv((set) => {
      for (const key of PLUGIN_ROOT_ENV_VARS) {
        for (const row of rows) {
          set(key, row.root);
          const outcome = attempt(() => pluginRootInfo());
          assert.equal(outcome.ok, true, `${key} + ${row.name} must not throw: ${outcome.ok ? '' : String(outcome.error)}`);
          if (!outcome.ok) continue;
          assert.equal(outcome.value.layout, row.expected, `${key} + ${row.name}`);
          assert.equal(outcome.value.source, key, 'the winning env var is reported');
          assert.equal(outcome.value.root, row.root, 'an absolute value is returned unchanged');
        }
        delete process.env[key];
      }
    });
  });
});

test('pluginRootInfo: env precedence is TRAFFIC_ONE > CODEX > CLAUDE > CURSOR', () => {
  withLayoutFixtures((rows) => {
    const installed = rows.find((row) => row.expected === 'installed');
    const source = rows.find((row) => row.expected === 'source');
    assert.ok(installed && source);
    withPluginRootEnv((set) => {
      set('CURSOR_PLUGIN_ROOT', source.root);
      assert.equal(pluginRootInfo().source, 'CURSOR_PLUGIN_ROOT');
      set('CLAUDE_PLUGIN_ROOT', source.root);
      assert.equal(pluginRootInfo().source, 'CLAUDE_PLUGIN_ROOT');
      set('CODEX_PLUGIN_ROOT', source.root);
      assert.equal(pluginRootInfo().source, 'CODEX_PLUGIN_ROOT');
      set('TRAFFIC_ONE_PLUGIN_ROOT', installed.root);
      const info = pluginRootInfo();
      assert.equal(info.source, 'TRAFFIC_ONE_PLUGIN_ROOT');
      assert.equal(info.layout, 'installed', 'the winning var also decides the layout');
    });
  });
});

// A RELATIVE env value (`TRAFFIC_ONE_PLUGIN_ROOT=dist`, routine in a
// maintainer shell) left every downstream path.join to interpret it against
// whatever cwd the CONSUMER happened to have, and left the diagnostics naming a
// root that means nothing on its own. Absolutizing here anchors it once, at the
// moment it is read, in the one place whose contract is being honest about the
// root. What it deliberately does NOT do is pretend a bare relative value is
// cwd-independent: a hook whose cwd is the project resolves `dist` under the
// PROJECT — and the point is that such a root then classifies 'unverified',
// which materializeProjectAssets refuses instead of resolving zero rules and
// sweeping the project's copies (see materialize-writer.test.ts).
test('pluginRootInfo: a relative env value is absolutized at read time, never passed through raw', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-relroot-')));
  const cwd = process.cwd();
  try {
    file(path.join(base, 'plugin-dist', 'scripts', 'hook-runtime.cjs'), '// compiled\n');
    file(path.join(base, 'plugin-dist', 'rules', 'core.md'), '# core\n');
    const project = path.join(base, 'project');
    fs.mkdirSync(path.join(project, 'plugin-dist'), { recursive: true });

    process.chdir(base);
    withPluginRootEnv((set) => {
      set('TRAFFIC_ONE_PLUGIN_ROOT', 'plugin-dist');
      const info = pluginRootInfo();
      assert.equal(info.root, path.join(base, 'plugin-dist'), 'anchored, not the raw "plugin-dist"');
      assert.equal(path.isAbsolute(info.root), true, 'a bare relative value must not survive as the root');
      assert.equal(info.layout, 'installed');
      assert.equal(pluginRoot(), path.join(base, 'plugin-dist'));

      // Same env value, hook cwd is now the project: the root still comes back
      // ABSOLUTE (so no downstream join silently invents `<project>/dist/rules`
      // out of a bare relative string), and the empty `<project>/plugin-dist`
      // it lands on is refused as 'unverified' rather than trusted.
      process.chdir(project);
      const inProject = pluginRootInfo();
      assert.equal(path.isAbsolute(inProject.root), true);
      assert.equal(inProject.root, path.join(project, 'plugin-dist'));
      assert.equal(inProject.layout, 'unverified', 'a relative value landing in the wrong place is not an install');
    });
  } finally {
    process.chdir(cwd);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('pluginRootInfo: blank and whitespace-only env values fall through instead of pinning a bogus root', () => {
  withLayoutFixtures((rows) => {
    const installed = rows.find((row) => row.expected === 'installed');
    assert.ok(installed);
    withPluginRootEnv((set) => {
      // An empty and a whitespace-only value both mean "unset": the next var
      // gets its turn, and a lone blank falls through to the __dirname default
      // (this checkout under tsx) rather than to a root literally named "   ".
      set('TRAFFIC_ONE_PLUGIN_ROOT', '   ');
      set('CODEX_PLUGIN_ROOT', installed.root);
      let info = pluginRootInfo();
      assert.equal(info.source, 'CODEX_PLUGIN_ROOT');
      assert.equal(info.root, installed.root);

      set('TRAFFIC_ONE_PLUGIN_ROOT', '');
      info = pluginRootInfo();
      assert.equal(info.source, 'CODEX_PLUGIN_ROOT');

      delete process.env.CODEX_PLUGIN_ROOT;
      set('TRAFFIC_ONE_PLUGIN_ROOT', ' \t ');
      info = pluginRootInfo();
      assert.equal(info.source, 'default', 'no env var supplied a usable value');
      assert.equal(path.isAbsolute(info.root), true);
      assert.notEqual(info.root.trim(), '');

      // Surrounding whitespace is trimmed rather than baked into the path.
      set('TRAFFIC_ONE_PLUGIN_ROOT', `  ${installed.root}  `);
      info = pluginRootInfo();
      assert.equal(info.root, installed.root);
      assert.equal(info.layout, 'installed');
    });
  });
});

test('isManagedPluginCachePath detects both Claude and Codex managed cache installs', () => {
  const claude = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  const codex = ['', 'home', 'u', '.codex', 'plugins', 'cache', 'traffic-one'].join(path.sep);
  assert.equal(isManagedPluginCachePath(claude), true);
  assert.equal(isManagedPluginCachePath(codex), true);
  // A normal project checkout is NOT a managed cache path (so materialization runs).
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', 'projects', 'myapp'].join(path.sep)), false);
  // A .claude dir that is not the plugins/cache subtree is not flagged.
  assert.equal(isManagedPluginCachePath(['', 'home', 'u', '.claude', 'projects', 'x'].join(path.sep)), false);
});

test('isInPluginCache reflects the resolved plugin root', () => {
  const saved = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', '.claude', 'plugins', 'cache', 'traffic-one'].join(path.sep);
    assert.equal(pluginRoot(), process.env.TRAFFIC_ONE_PLUGIN_ROOT);
    assert.equal(isInPluginCache(), true);
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = ['', 'home', 'u', 'dev', 'traffic-one'].join(path.sep);
    assert.equal(isInPluginCache(), false);
  } finally {
    if (saved === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved;
  }
});

function withWrapperProject(fn: (root: string, child: string) => void): void {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-paths-')));
  const child = path.join(root, 'one-nextjs');
  fs.mkdirSync(path.join(root, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(root, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(child, 'src'), { recursive: true });
  fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ dependencies: { next: '15.0.0' } }), 'utf8');
  try { fn(root, child); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function input(cwd: string, patch: Partial<HookInput>): HookInput {
  return { event: 'UserPromptSubmit', host: 'codex', cwd, raw: {}, ...patch } as HookInput;
}

test('projectRoot: prompt-mentioned inner app beats wrapper .traffic-one state', () => {
  withWrapperProject((root, child) => {
    assert.equal(projectRoot(input(root, { prompt: 'in "one-nextjs" add an about page' })), child);
  });
});

test('projectRoot: tool workdir and file paths resolve the inner app', () => {
  withWrapperProject((root, child) => {
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'shell', rawName: 'exec_command', command: 'npm test', workdir: 'one-nextjs' },
    })), child);
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'file-write', rawName: 'Write', filePath: 'one-nextjs/src/page.tsx' },
    })), child);
    assert.equal(projectRoot(input(root, {
      event: 'PreToolUse',
      tool: { class: 'file-write', rawName: 'Write', workdir: 'one-nextjs', filePath: 'src/page.tsx' },
    })), child);
  });
});

test('projectRoot: workspaceRoot ceiling prevents climbing above opened workspace', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-ws-ceiling-')));
  const workspace = path.join(root, 'workspace');
  const inner = path.join(workspace, 'apps', 'web');
  const strayParent = path.join(root, 'stray-parent');
  fs.mkdirSync(path.join(strayParent, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(strayParent, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(path.join(workspace, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.traffic-one', '.one.json'), '{}', 'utf8');
  fs.mkdirSync(inner, { recursive: true });
  try {
    assert.equal(projectRoot(input(inner, { workspaceRoot: workspace })), workspace);
    assert.equal(projectRoot(input(inner, { workspaceRoot: workspace, cwd: inner })), workspace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
