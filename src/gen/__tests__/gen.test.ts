import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { distRoot, runGen, sourceRepoRoot } from '../index';
import { GenRun } from '../lib/run';
import { emitManifests, emitMcp } from '../emit/manifests';
import { emitStaticPluginFiles } from '../emit/static';
import { CURSOR_EVENTS, CURSOR_PLUGIN_ROOT_TOKEN, cursorCommand } from '../sources/hooks';
import { HOST_MODELS } from '../../config/model-tiers';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAX_CURSOR_TIER_LENGTH = Math.max(
  ...Object.values(HOST_MODELS.cursor.tiers).map((row) => row.length),
  ...Object.values(HOST_MODELS.cursor.plans ?? {})
    .flatMap((plan) => Object.values(plan).map((row) => row?.length ?? 0)),
);

test('runGen writes a generated plugin root and --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-plugin-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.ok(write.written.length > 250, `expected generated plugin files, got ${write.written.length}`);
    assert.ok(fs.existsSync(path.join(dir, '.codex-plugin', 'plugin.json')));
    // The auth gate ships as the generated kernel rule; no static 00- seed copy.
    assert.ok(!fs.existsSync(path.join(dir, '.cursor', 'rules', '00-auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', 'auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, '.devin', 'rules', 'auth-required.md')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks-copilot.json')));
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks-windsurf.json')));
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'src')));
    const copilotHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-copilot.json'), 'utf8'));
    assert.equal(copilotHooks.hooks.SessionStart[0].env.TRAFFIC_ONE_HOST, 'copilot');
    const windsurfHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-windsurf.json'), 'utf8'));
    assert.ok(windsurfHooks.hooks.pre_user_prompt[0].command.includes('windsurf-hook-runtime.cjs'));
    assert.ok(windsurfHooks.hooks.pre_user_prompt[0].command.includes('TRAFFIC_ONE_HOST=windsurf'));
    assert.ok(windsurfHooks.hooks.post_mcp_tool_use[0].command.includes('post_mcp_tool_use'));
    const cursorHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-cursor.json'), 'utf8'));
    assert.equal(CURSOR_PLUGIN_ROOT_TOKEN, '${CURSOR_PLUGIN_ROOT}');
    assert.equal(CURSOR_EVENTS.length, 11);
    assert.deepEqual(Object.keys(cursorHooks.hooks), CURSOR_EVENTS.map(({ event }) => event));
    for (const { event, subcommand } of CURSOR_EVENTS) {
      const entries = cursorHooks.hooks[event];
      assert.equal(entries.length, 1, `${event} must emit exactly one Cursor hook`);
      const entry = entries[0];
      assert.equal(
        entry.command,
        `node "${CURSOR_PLUGIN_ROOT_TOKEN}/scripts/cursor-hook-runtime.cjs" ${subcommand}`,
      );
      assert.doesNotMatch(entry.command, /\.\/scripts|:-|TRAFFIC_ONE_PLUGIN_ROOT/);
      const lifecycle = event === 'stop' || event === 'subagentStop';
      assert.deepEqual(
        Object.keys(entry).sort(),
        lifecycle ? ['command', 'loop_limit'] : ['command'],
        `${event} emitted unsupported Cursor hook fields`,
      );
      if (lifecycle) {
        assert.equal(entry.loop_limit, 8);
        assert.ok(
          entry.loop_limit > MAX_CURSOR_TIER_LENGTH,
          `${event} loop_limit must exceed the longest configured Cursor tier (${MAX_CURSOR_TIER_LENGTH})`,
        );
      }
    }
    assert.deepEqual(cursorHooks.hooks.stop, [{
      command: 'node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" cursor-stop',
      loop_limit: 8,
    }]);
    assert.deepEqual(cursorHooks.hooks.subagentStop, [{
      command: 'node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" cursor-subagent-stop',
      loop_limit: 8,
    }]);
    const expectedVersion = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    ).version;
    const generatedPackage = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const claudePlugin = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const codexPlugin = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8'));
    const cursorPlugin = JSON.parse(fs.readFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'));
    const copilotPlugin = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert.equal(generatedPackage.version, expectedVersion, 'generated package version must follow package.json');
    assert.equal(claudePlugin.version, expectedVersion, 'Claude plugin version must follow package.json');
    assert.equal(claudeMarketplace.plugins[0]?.version, expectedVersion, 'Claude marketplace version must follow package.json');
    assert.equal(codexPlugin.version, expectedVersion, 'Codex plugin version must follow package.json');
    assert.equal(cursorPlugin.version, expectedVersion, 'Cursor plugin version must follow package.json');
    assert.equal(copilotPlugin.version, expectedVersion, 'Copilot plugin version must follow package.json');
    const frontendAgent = fs.readFileSync(path.join(dir, 'agents', 'senior-frontend.agent.md'), 'utf8');
    assert.match(frontendAgent, /^tools: \["view", "search", "bash", "edit"\]$/m);
    assert.doesNotMatch(frontendAgent, /^tools: Read,/m);

    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift, [], `generated plugin drifted: ${check.drift.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated non-test documentation contains no concrete claimable Traffic One role marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-role-markers-'));
  const concreteMarker = /\[t1-role:\s*(?:(?:senior[-_](?:architect|frontend|backend|reviewer|tester|shipper)|quick[-_]fix)(?:[-_]\d+)?)\s*\]/i;
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = write.written.filter((relPath) => /\.(?:md|mdc)$/i.test(relPath));
    assert.ok(docs.length > 0, 'expected generated documentation to scan');
    for (const relPath of docs) {
      const content = fs.readFileSync(path.join(dir, relPath), 'utf8');
      assert.doesNotMatch(content, concreteMarker, `${relPath} contains a claimable concrete role marker`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated orchestrator contract preserves every canonical Codex task name and incident motivation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-codex-role-contract-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const relPath = write.written.find((candidate) => (
      candidate.endsWith('senior-eng-orchestrator/SKILL.md')
    ));
    assert.ok(relPath, 'expected the orchestrator skill in generated output');
    const content = fs.readFileSync(path.join(dir, relPath!), 'utf8');
    for (const taskName of [
      'senior_architect',
      'senior_frontend',
      'senior_backend',
      'senior_reviewer',
      'senior_tester',
      'senior_shipper',
    ]) assert.match(content, new RegExp(`\\b${taskName}\\b`));
    assert.match(content, /spawn `message` is encrypted at rest/i);
    assert.match(content, /only usable Codex identity evidence/i);
    assert.match(content, /incident already used `task_name: "senior_architect"`/i);
    assert.match(content, /codifies existing orchestrator behavior/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor hook commands resolve the installed runtime from a foreign cwd and fail closed without token replacement', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-hook-command-')));
  const pluginRoot = path.join(dir, 'installed plugin with spaces');
  const foreignCwd = path.join(dir, 'foreign workspace');
  const pluginRuntime = path.join(pluginRoot, 'scripts', 'cursor-hook-runtime.cjs');
  const decoyRuntime = path.join(foreignCwd, 'scripts', 'cursor-hook-runtime.cjs');
  const decoyMarker = path.join(dir, 'project-decoy-ran');
  try {
    fs.mkdirSync(path.dirname(pluginRuntime), { recursive: true });
    fs.mkdirSync(path.dirname(decoyRuntime), { recursive: true });
    fs.writeFileSync(pluginRuntime, [
      "'use strict';",
      "process.stdout.write(JSON.stringify({ runtime: 'plugin', subcommand: process.argv[2], cwd: process.cwd() }));",
    ].join('\n'), 'utf8');
    fs.writeFileSync(decoyRuntime, [
      "'use strict';",
      `require('node:fs').writeFileSync(${JSON.stringify(decoyMarker)}, 'ran', 'utf8');`,
      'process.exitCode = 91;',
    ].join('\n'), 'utf8');

    for (const { subcommand } of CURSOR_EVENTS) {
      const expanded = cursorCommand(subcommand).replaceAll(CURSOR_PLUGIN_ROOT_TOKEN, pluginRoot);
      const result = spawnSync(expanded, {
        cwd: foreignCwd,
        encoding: 'utf8',
        input: '{}',
        shell: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        runtime: 'plugin',
        subcommand,
        cwd: foreignCwd,
      });
    }
    assert.equal(fs.existsSync(decoyMarker), false, 'foreign workspace runtime must never execute');

    const env = { ...process.env };
    delete env.CURSOR_PLUGIN_ROOT;
    const unresolved = spawnSync(cursorCommand('cursor-stop'), {
      cwd: foreignCwd,
      encoding: 'utf8',
      env,
      input: '{}',
      shell: true,
    });
    assert.notEqual(unresolved.status, 0, 'an unreplaced plugin-root token must fail closed');
    assert.equal(fs.existsSync(decoyMarker), false, 'missing token replacement must not fall back to the project runtime');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gen sweeps orphaned files in managed output dirs (deleted source content)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-orphan-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const orphanRule = path.join(dir, 'rules', 'common', 'retired-rule.md');
    const orphanMdc = path.join(dir, '.cursor', 'rules', 'retired-rule.mdc');
    const orphanWindsurf = path.join(dir, '.devin', 'rules', 'retired-rule.md');
    const retiredModelCatalog = path.join(dir, 'public', 'model-status-catalog.json');
    fs.writeFileSync(orphanRule, '# Retired\n', 'utf8');
    fs.writeFileSync(orphanMdc, '---\nalwaysApply: false\n---\n', 'utf8');
    fs.writeFileSync(orphanWindsurf, '---\ntrigger: model_decision\n---\n# Retired\n', 'utf8');
    fs.mkdirSync(path.dirname(retiredModelCatalog), { recursive: true });
    fs.writeFileSync(retiredModelCatalog, '{}\n', 'utf8');

    // check mode reports orphans as drift without touching them.
    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift.sort(), [
      '.cursor/rules/retired-rule.mdc (orphan: no longer generated)',
      '.devin/rules/retired-rule.md (orphan: no longer generated)',
      'public/model-status-catalog.json (orphan: no longer generated)',
      'rules/common/retired-rule.md (orphan: no longer generated)',
    ]);
    assert.ok(fs.existsSync(orphanRule));

    // write mode prunes them.
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(write.pruned.sort(), [
      '.cursor/rules/retired-rule.mdc',
      '.devin/rules/retired-rule.md',
      'public/model-status-catalog.json',
      'rules/common/retired-rule.md',
    ]);
    assert.ok(!fs.existsSync(orphanRule));
    assert.ok(!fs.existsSync(orphanMdc));
    assert.ok(!fs.existsSync(orphanWindsurf));
    assert.ok(!fs.existsSync(retiredModelCatalog));

    // and the tree round-trips clean again.
    const recheck = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(recheck.drift, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifests produces all host manifests including Copilot plugin.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-manifests-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(write);
    emitMcp(write);
    assert.equal(write.written.length, 7);

    const check = new GenRun({ check: true, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(check);
    emitMcp(check);
    assert.deepEqual(check.drift, []);
    assert.equal(check.written.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('distRoot points generation at dist under the source checkout by default', () => {
  assert.equal(distRoot(REPO_ROOT), path.join(REPO_ROOT, 'dist'));
});

test('codegen ignores runtime plugin-root env vars and still reads the source checkout', () => {
  const saved = {
    traffic: process.env.TRAFFIC_ONE_PLUGIN_ROOT,
    codex: process.env.CODEX_PLUGIN_ROOT,
    claude: process.env.CLAUDE_PLUGIN_ROOT,
    cursor: process.env.CURSOR_PLUGIN_ROOT,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-env-'));
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CODEX_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CLAUDE_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CURSOR_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');

    assert.equal(sourceRepoRoot(), REPO_ROOT);
    assert.equal(distRoot(), path.join(REPO_ROOT, 'dist'));
    const write = runGen({ check: false, root: dir });
    assert.ok(write.written.includes('AGENTS.md'));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  } finally {
    if (saved.traffic === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved.traffic;
    if (saved.codex === undefined) delete process.env.CODEX_PLUGIN_ROOT; else process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.claude === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = saved.claude;
    if (saved.cursor === undefined) delete process.env.CURSOR_PLUGIN_ROOT; else process.env.CURSOR_PLUGIN_ROOT = saved.cursor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GenRun.json writes canonical 2-space JSON with a trailing newline; --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-'));
  try {
    const sample = { b: 1, a: [1, 2] };
    const write = new GenRun({ check: false, root: dir });
    write.json('nested/x.json', sample);
    assert.deepEqual(write.written, ['nested/x.json']);
    const onDisk = fs.readFileSync(path.join(dir, 'nested', 'x.json'), 'utf8');
    assert.equal(onDisk, `${JSON.stringify(sample, null, 2)}\n`);
    // Re-checking the just-written file reports no drift (idempotent).
    const check = new GenRun({ check: true, root: dir });
    check.json('nested/x.json', sample);
    assert.deepEqual(check.drift, []);
    // A different value drifts.
    const check2 = new GenRun({ check: true, root: dir });
    check2.json('nested/x.json', { b: 2 });
    assert.deepEqual(check2.drift, ['nested/x.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dist AGENTS.md/CLAUDE.md ship the end-user plugin instructions, not the maintainer guide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-agents-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gen', 'static', 'plugin-instructions.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), source);
    // The maintainer guide (repo root AGENTS.md) must never ship.
    assert.ok(!fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('Stand Down'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static emitter recovers when sourceRoot points at dist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-distroot-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: path.join(REPO_ROOT, 'dist') });
    emitStaticPluginFiles(write);
    assert.ok(write.written.includes('AGENTS.md'));
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gen', 'static', 'plugin-instructions.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), source);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
