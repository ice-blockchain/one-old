// The files Traffic One takes over at the PROJECT ROOT, and the invariant that
// governs all of them: no byte the user wrote may become unreachable, and a
// takeover nobody asked for may not be silent.
//
// Three measured failures are covered here, each of which destroyed content:
//
//   1. A pre-existing repository misclassified as greenfield had its
//      hand-written root AGENTS.md replaced (a 3-file Terraform stack with
//      committed history reads `new-project` — detectMode counts files whose
//      extension is in SOURCE_EXTS, and `.tf` is not one of them; measured
//      56 bytes -> 8790 generated ones).
//   2. A project taken over a SECOND time lost the new content outright: the
//      delete's precondition was that a file EXISTED at
//      `.traffic-one/AGENTS.local.md`, and the stale copy from the first
//      takeover satisfied it. Measured: preserved copy still carried
//      "VERSION ONE (stale)", the new content recoverable nowhere.
//   3. Root `api.md`/`database.md`/… were MOVED into `.traffic-one/` for every
//      consenting project on no evidence at all, and a re-migration deleted the
//      root file while skipping the append that was supposed to carry it
//      (the `&&` short-circuit on the `## Migrated From Root` marker).
//
// The materialization cases run against a REAL 'installed' plugin root, because
// the suite-wide root pinned by src/build/test-preload.mjs is this SOURCE
// checkout and materializeProjectAssets refuses one outright — every assertion
// about what it writes would otherwise pass vacuously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { cleanupPrevious } from '../cleanup';
import { detectMode } from '../../detection';
import { materializeProjectAssets } from '../materialize';
import { pluginRootInfo } from '../../paths';
import { preserveManualRootContext, renderAgentsWithLocalContext } from '../render-agents';
import { resetPluginUseCache } from '../../state/plugin-use';

const HAND_WRITTEN = '# Ops notes\n\nAsk @sre before applying anything to prod.\n';

interface Fixture {
  project: string;
  base: string;
}

/**
 * An 'installed' plugin root (shared/paths.ts classifyPluginRootLayout: a
 * compiled runtime entry as a FILE plus non-empty generated content) whose
 * `rules/` and `skills-catalog/` are symlinks to the real source trees, so the
 * resolved content set is the real ~45 rules and ~48 skills rather than a stub
 * pair. That is what makes these tests exercise the whole ~97-write
 * materialization — the path that deletes a hand-written root AGENTS.md — instead
 * of a refusal.
 */
function withMaterializableProject(fn: (fixture: Fixture) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-root-takeover-')));
  const plugin = path.join(base, 'plugin');
  const modules = path.resolve(__dirname, '..', '..', '..', 'modules');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.symlinkSync(path.join(modules, 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
  fs.symlinkSync(path.join(modules, 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });

  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });

  const env = process.env;
  const saved = {
    root: env.TRAFFIC_ONE_PLUGIN_ROOT,
    host: env.TRAFFIC_ONE_HOST,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    home: env.HOME,
    xdg: env.XDG_STATE_HOME,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_HOST = 'claude';
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(base, 'prefs.json');
  env.HOME = path.join(base, 'home');
  env.XDG_STATE_HOME = path.join(base, 'xdg');
  resetPluginUseCache();
  try {
    fn({ project, base });
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: saved.root,
      TRAFFIC_ONE_HOST: saved.host,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      HOME: saved.home,
      XDG_STATE_HOME: saved.xdg,
    })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function withProject(fn: (project: string) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-root-files-')));
  const project = path.join(base, 'project');
  fs.mkdirSync(project, { recursive: true });
  try {
    fn(project);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function git(cwd: string, args: string): void {
  cp.execSync(`git ${args}`, { cwd, stdio: 'pipe' });
}

// A REAL pre-existing repository: three Terraform files and a commit. This is
// the misclassification, not a contrived state — nothing here is a Traffic One
// fixture, and `detectMode` still answers `new-project`.
function seedMisclassifiedRepo(project: string): void {
  write(path.join(project, 'main.tf'), 'resource "aws_s3_bucket" "b" {}\n');
  write(path.join(project, 'variables.tf'), 'variable "region" { default = "eu-west-1" }\n');
  write(path.join(project, 'outputs.tf'), 'output "arn" { value = "x" }\n');
  write(path.join(project, 'AGENTS.md'), HAND_WRITTEN);
  git(project, 'init -q');
  git(project, 'config user.email fixture@example.com');
  git(project, 'config user.name fixture');
  git(project, 'add -A');
  git(project, 'commit -qm "real history"');
}

const MATERIALIZABLE_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
  realtime: 'none',
  confirmed: true,
  onboardingComplete: true,
  mode: 'new-project',
} as const;

// ── the fixture itself ──────────────────────────────────────────────────────
// Asserted before it is relied on: a fixture that quietly stopped classifying
// 'installed' would make every materialization case below pass by refusing.

test('the fixture plugin root really is installed, and materialization really runs', () => {
  withMaterializableProject(({ project }) => {
    assert.equal(pluginRootInfo().layout, 'installed');
    const result = materializeProjectAssets(project, { ...MATERIALIZABLE_STATE });
    assert.equal(result.skipped, undefined, `materialization must not be skipped, got ${result.skipped}`);
    assert.ok(result.rules > 20, `expected the real rule spine, got ${result.rules}`);
    assert.ok(result.skills > 20, `expected the real skill set, got ${result.skills}`);
    assert.ok(result.written > 50, `expected a full materialization, got ${result.written} writes`);
  });
});

// ── 1. the misclassified repository ─────────────────────────────────────────

test('a misclassified pre-existing repo keeps its hand-written root AGENTS.md reachable, and is told so', () => {
  withMaterializableProject(({ project }) => {
    seedMisclassifiedRepo(project);
    assert.equal(detectMode(project), 'new-project', 'the misclassification is the premise of this test');

    const result = materializeProjectAssets(project, { ...MATERIALIZABLE_STATE, mode: detectMode(project) });
    assert.equal(result.skipped, undefined);

    const generated = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    assert.ok(generated.includes('GENERATED BY traffic-one'), 'the takeover is deliberate product behaviour and still happens');
    // Two independent copies, both reachable without a backup or a git object.
    assert.ok(
      fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8').includes('Ask @sre before applying'),
      'the preserved copy carries the user bytes',
    );
    assert.ok(generated.includes('Ask @sre before applying'), 'and the generated file reproduces them verbatim');
    // …and it SAYS what it did. Nothing else in the project does: an untracked
    // root AGENTS.md does not even produce a `git status` line.
    assert.ok(
      generated.includes('Traffic One generated this file over a hand-written root'),
      'the takeover must not be silent',
    );
    assert.ok(generated.includes('.traffic-one/AGENTS.local.md'), 'and it must name where the original went');
  });
});

test('a repeat materialization does not append the preserved content a second time', () => {
  withMaterializableProject(({ project }) => {
    seedMisclassifiedRepo(project);
    materializeProjectAssets(project, { ...MATERIALIZABLE_STATE });
    const first = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');
    materializeProjectAssets(project, { ...MATERIALIZABLE_STATE });
    const second = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');
    assert.equal(second, first, 'the preserved copy is a converged file, not an append-on-every-run log');
    assert.equal(second.split('Ask @sre before applying').length - 1, 1);
  });
});

// ── 2. the second takeover ──────────────────────────────────────────────────

test('a stale preserved copy does not license the delete: the CURRENT content is carried first', () => {
  withProject((project) => {
    write(path.join(project, '.traffic-one', 'AGENTS.local.md'), '# Preserved AGENTS.md\n\nVERSION ONE (stale)\n');
    write(path.join(project, 'AGENTS.md'), '# VERSION TWO\n\nWritten by hand after the first takeover.\n');

    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { mode: 'new-project' }), true);

    const preserved = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');
    assert.ok(preserved.includes('VERSION ONE (stale)'), 'the earlier content is not overwritten either');
    assert.ok(preserved.includes('Written by hand after the first takeover.'), 'and the current content is carried');
    assert.equal(fs.existsSync(path.join(project, 'AGENTS.md')), false, 'only then is the root file removed');
    // Reachable from the generated context too, which is what an agent reads.
    assert.ok(
      renderAgentsWithLocalContext(project, { mode: 'new-project' }, [], [], {}).includes('Written by hand after the first takeover.'),
      'the new content reaches the rendered root context',
    );
  });
});

test('preserving is idempotent: an unchanged root file is not re-appended on every run', () => {
  withProject((project) => {
    write(path.join(project, 'AGENTS.md'), HAND_WRITTEN);
    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { mode: 'new-project' }), true);
    const once = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');

    write(path.join(project, 'AGENTS.md'), HAND_WRITTEN);
    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { mode: 'new-project' }), true);
    assert.equal(fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8'), once);
  });
});

// CRLF is the shape that defeats a naive `includes`: the same notes saved by an
// editor that normalizes line endings would read as "not preserved yet" and
// append a byte-identical copy on every single run, forever.
test('a line-ending rewrite of the same notes does not grow the preserved copy', () => {
  withProject((project) => {
    write(path.join(project, 'AGENTS.md'), '# Ops\r\n\r\nAsk @sre first.\r\n');
    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { mode: 'new-project' }), true);
    const once = fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8');
    assert.ok(once.includes('Ask @sre first.'));

    write(path.join(project, 'AGENTS.md'), '# Ops\n\nAsk @sre first.\n');
    assert.equal(preserveManualRootContext(project, 'AGENTS.md', { mode: 'new-project' }), true);
    assert.equal(fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8'), once);
  });
});

// ── 3. the root documentation files ─────────────────────────────────────────

test('a documentation repository keeps its root docs; only a copy is taken', () => {
  withProject((project) => {
    const names = ['api.md', 'database.md', 'deployment.md', 'environment-setup.md', 'security.md'];
    for (const name of names) write(path.join(project, name), `# ${name}\n\nPublished reference page.\n`);
    git(project, 'init -q');
    git(project, 'config user.email fixture@example.com');
    git(project, 'config user.name fixture');
    git(project, 'add -A');
    git(project, 'commit -qm docs');

    const removed = cleanupPrevious(project, {}, new Set<string>(), new Set<string>());

    assert.equal(removed, 0, 'copying is not removing, and must not be counted as one');
    for (const name of names) {
      assert.equal(fs.existsSync(path.join(project, name)), true, `root ${name} survives`);
      assert.ok(
        fs.readFileSync(path.join(project, '.traffic-one', name), 'utf8').includes('Published reference page.'),
        `${name} content is carried into .traffic-one/`,
      );
    }
    assert.equal(
      cp.execSync('git status --porcelain', { cwd: project }).toString().trim(),
      '?? .traffic-one/',
      'the only thing git sees is the state dir Traffic One owns',
    );
  });
});

test('re-created root documentation is carried, not skipped on the marker and deleted', () => {
  withProject((project) => {
    write(path.join(project, '.traffic-one', 'api.md'), '# api\n\nmigrated notes v1\n');
    write(path.join(project, 'api.md'), 'old root text\n');
    cleanupPrevious(project, {}, new Set<string>(), new Set<string>());
    assert.ok(fs.readFileSync(path.join(project, '.traffic-one', 'api.md'), 'utf8').includes('old root text'));

    // The user rewrites the root file. The target now carries the
    // `## Migrated From Root` marker, which is what the old short-circuit
    // mistook for "already carried" before deleting the source.
    write(path.join(project, 'api.md'), 'BRAND NEW ROOT TEXT the user just wrote\n');
    cleanupPrevious(project, {}, new Set<string>(), new Set<string>());

    assert.equal(fs.existsSync(path.join(project, 'api.md')), true, 'the source survives');
    const target = fs.readFileSync(path.join(project, '.traffic-one', 'api.md'), 'utf8');
    assert.ok(target.includes('old root text'), 'the earlier carry is not replaced');
    assert.ok(target.includes('BRAND NEW ROOT TEXT the user just wrote'), 'and the new text is carried');

    const again = fs.readFileSync(path.join(project, '.traffic-one', 'api.md'), 'utf8');
    cleanupPrevious(project, {}, new Set<string>(), new Set<string>());
    assert.equal(fs.readFileSync(path.join(project, '.traffic-one', 'api.md'), 'utf8'), again, 'and a third pass is a no-op');
  });
});

// A root file whose entire content is its H1 is the one shape the compaction
// step can empty. It must not be reduced to `_Empty legacy file._` and then
// treated as carried.
test('a heading-only root doc is carried whole rather than compacted to nothing', () => {
  withProject((project) => {
    write(path.join(project, '.traffic-one', 'api.md'), '# Internal API notes\n\nkeep me\n');
    write(path.join(project, 'api.md'), '# Public API\n');

    cleanupPrevious(project, {}, new Set<string>(), new Set<string>());

    const target = fs.readFileSync(path.join(project, '.traffic-one', 'api.md'), 'utf8');
    assert.ok(target.includes('keep me'), 'the existing target content stays');
    assert.ok(target.includes('# Public API'), 'and the heading-only root file is not dropped');
    assert.ok(!target.includes('_Empty legacy file._'));
  });
});
