// The product contract, as a test.
//
//   A project whose "do you want to use Traffic One here?" question is
//   UNANSWERED stays byte-identical. A project that DECLINED is left untouched.
//
// It has been broken three times by three unrelated features — a generated
// .gitignore, an uncertified-host once-marker, and the decision log's hookSeq
// counter — and each time the fix was per-writer, so the next writer broke it
// again. This file is the thing that has to fail before a fourth one lands.
//
// Two properties are asserted, and the distinction matters:
//   * BYTE-IDENTITY, by full recursive listing + content hash of the whole
//     project tree, not `existsSync('.traffic-one')`. Every one of the three
//     regressions would have passed an existsSync check, because in each case
//     `.traffic-one/` was already there — what changed was its contents. The
//     seeded fixture therefore has an EXISTING, populated `.traffic-one/`.
//   * The hooks still WORK: consent pending is not the same as plugin off, so
//     each case also asserts the run produced output and did not crash.
//
// Everything is driven through runClaudeHook — the real host entry point, the
// real registry, the real pipeline (so the decision log runs too) — because a
// fence proven only against a directly-called module is a fence proven against
// the one call path that was remembered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runClaudeHook } from '../../../hooks/claude-entry';
import { appendTextFile, createJsonExclusive, ensureDir, movePath, removePath, writeJson, writeTextFile } from '../../fsjson';
import { drainStateWrites } from '../state-write-log';
import { materializeProjectAssets } from '../../materialize/materialize';
import { assertInstalledPluginRoot } from '../../materialize/__tests__/fixtures/installed-root';
import { writeOneSection } from '../../one-settings';
import {
  clearPluginUseChoice,
  projectRootForStatePath,
  projectStateWriteAllowed,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../plugin-use';

// ── tree snapshot ────────────────────────────────────────────────────────────

type Tree = Map<string, string>;

function snapshot(root: string): Tree {
  const out: Tree = new Map();
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out.set(`${relPath}/`, '<dir>');
        walk(abs, relPath);
      } else {
        let hash = '<unreadable>';
        try { hash = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); } catch { /* keep */ }
        out.set(relPath, hash);
      }
    }
  };
  walk(root, '');
  return out;
}

function describeDrift(before: Tree, after: Tree): string {
  const lines: string[] = [];
  for (const [p, h] of after) {
    if (!before.has(p)) lines.push(`  ADDED    ${p}`);
    else if (before.get(p) !== h) lines.push(`  CHANGED  ${p}`);
  }
  for (const p of before.keys()) if (!after.has(p)) lines.push(`  REMOVED  ${p}`);
  return lines.sort().join('\n');
}

function assertByteIdentical(label: string, before: Tree, after: Tree): void {
  const drift = describeDrift(before, after);
  assert.equal(
    drift,
    '',
    `${label}: the project tree must be byte-identical, but ${drift.split('\n').length} path(s) changed:\n${drift}`,
  );
}

// ── fixture ──────────────────────────────────────────────────────────────────

const OLD_MS = Date.now() - 40 * 24 * 60 * 60 * 1000; // past every retention TTL
const SESSION_ID = 'sess-fence-1';

/**
 * An ONBOARDED project carrying exactly the accumulated state the sweeps want
 * to reclaim: aged digests (sweepOldDigests), aged runs/backups/logs and stale
 * once-markers (sweepTrafficOneRetention), a per-run activity log, and the
 * retired project-local runtime files (removeLegacyProjectLocalTrafficOneRuntime).
 * A never-onboarded project would prove much less: it has nothing to delete.
 */
function seedOnboardedProject(project: string): void {
  const w = (rel: string, body: string, age?: number): void => {
    const abs = path.join(project, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf8');
    if (age) fs.utimesSync(abs, new Date(age), new Date(age));
  };
  w('README.md', '# demo\n');
  w('package.json', `${JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2)}\n`);
  w('src/index.ts', 'export const x = 1;\n');
  w('.traffic-one/.one.json', `${JSON.stringify({
    mode: 'existing-codebase',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    realtime: 'none',
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-01-01T00:00:00Z',
    currentRunId: '9',
  }, null, 2)}\n`);
  w('.traffic-one/plan.md', '# plan\n');
  w('.traffic-one/product.md', '# product\n');
  // Retention/digest sweep candidates.
  for (let i = 1; i <= 12; i += 1) w(`.traffic-one/digests/${i}/digest.md`, `digest ${i}\n`, OLD_MS);
  for (let i = 1; i <= 12; i += 1) {
    w(`.traffic-one/runs/${i}/ledger.json`, `${JSON.stringify({ runId: String(i) })}\n`, OLD_MS);
    w(`.traffic-one/runs/${i}/debug/decisions.jsonl`, '{"decision":"deny"}\n', OLD_MS);
    w(`.traffic-one/runs/${i}/debug/deny-repeats.json`, '{"sig":2}\n', OLD_MS);
  }
  for (let i = 0; i < 4; i += 1) w(`.traffic-one/runs/.once/marker-${i}-shared`, 'x\n', OLD_MS);
  for (let i = 0; i < 3; i += 1) w(`.traffic-one/debug/decisions.jsonl`, '{"decision":"allow"}\n', OLD_MS);
  for (let i = 1; i <= 3; i += 1) w(`.traffic-one/backups/${i}/state.json`, '{}\n', OLD_MS);
  w('.traffic-one/logs/run.log', 'log\n', OLD_MS);
  // Retired project-local runtime — initializeTrafficOneEnv deletes these
  // before any consent check runs.
  w('.traffic-one/preferences.json', '{}\n');
  w('.traffic-one/machine.json', '{}\n');
  w('.traffic-one/onboarding-server.json', '{}\n');
}

/**
 * A PRISTINE project: ordinary source files, hand-written root context files, and
 * NO `.traffic-one/` at all. It proves what the onboarded fixture above cannot —
 * that nothing is CREATED, empty directories included. Every regression the
 * onboarded fixture catches is a content change inside a state dir that already
 * exists; the three raw `fs.mkdirSync` sites (project-state-lock, run-agent/locks,
 * run-agent/ledger) instead left `.traffic-one/`, `.traffic-one/runs/` and
 * `.traffic-one/runs/<id>/` behind with no files in them, which a hash-only
 * comparison of an already-populated tree would never notice.
 *
 * The root AGENTS.md/CLAUDE.md are hand-written and NOT marked generated on
 * purpose: they are the user's own files, and they are what materialization
 * destroyed — the delete landed while the fence refused the copy that was meant
 * to preserve the content.
 */
function seedPristineProject(project: string): void {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'README.md'), '# demo\n', 'utf8');
  fs.writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(project, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# My own agent notes\n\nHand-written, not generated.\n', 'utf8');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# My own claude notes\n\nHand-written, not generated.\n', 'utf8');
}

/**
 * An 'installed' plugin root (shared/paths.ts classifyPluginRootLayout: a compiled
 * runtime entry PLUS non-empty generated content), whose `rules/` and
 * `skills-catalog/` are symlinks to the real trees.
 *
 * Needed because the suite-wide root pinned by src/build/test-preload.mjs is this
 * SOURCE checkout, against which materializeProjectAssets refuses outright — so
 * every assertion about what it writes, or does not write, would pass vacuously.
 * The symlinks (the same trick materialize-writer.test.ts uses) make the resolved
 * skill set the real ~48, which is what turns "wrote nothing" into a claim worth
 * making: the unfenced writer created one directory per skill.
 */
function withInstalledPluginRoot<T>(base: string, fn: () => T): T {
  const plugin = path.join(base, 'plugin');
  const modules = path.resolve(__dirname, '..', '..', '..', 'modules');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'scripts', 'hook-runtime.cjs'), '// test fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.symlinkSync(path.join(modules, 'rules', 'rules'), path.join(plugin, 'rules'), 'dir');
  fs.symlinkSync(path.join(modules, 'skills', 'skills-catalog'), path.join(plugin, 'skills-catalog'), 'dir');
  fs.mkdirSync(path.join(plugin, 'agents'), { recursive: true });
  for (const role of ['senior-frontend', 'senior-backend', 'senior-architect']) {
    const source = path.join(modules, role, 'agent.md');
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(plugin, 'agents', `${role}.md`));
  }
  const saved = { root: process.env.TRAFFIC_ONE_PLUGIN_ROOT, host: process.env.TRAFFIC_ONE_HOST };
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  process.env.TRAFFIC_ONE_HOST = 'claude';
  try {
    // The doc comment above states why this fixture has to be installed; this is
    // that statement made load-bearing. "The fenced writer wrote nothing" is only
    // a claim about the fence while the writer would otherwise have written.
    assertInstalledPluginRoot('consent-write-fence fixture');
    return fn();
  } finally {
    if (saved.root === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved.root;
    if (saved.host === undefined) delete process.env.TRAFFIC_ONE_HOST;
    else process.env.TRAFFIC_ONE_HOST = saved.host;
  }
}

// A state that materializes for real: `new-project` mode, because that is the one
// that reaches preserveManualRootContext — the writer that DELETED the user's root
// AGENTS.md/CLAUDE.md.
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

type Consent = 'pending' | 'declined' | 'consented';

interface Case { project: string; prefsPath: string; base: string }

interface ProjectOptions {
  /** Seed a pristine project (no `.traffic-one/`) instead of the onboarded one. */
  pristine?: boolean;
}

function withProject(consent: Consent, fn: (ctx: Case) => Promise<void>, opts: ProjectOptions = {}): Promise<void> {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-fence-')));
  const project = path.join(dir, 'project');
  const env = process.env;
  const saved = {
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    xdg: env.XDG_STATE_HOME,
    ask: env.TRAFFIC_ONE_ASK_USE_PLUGIN,
    auth: env.TRAFFIC_ONE_AUTH,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  const prefsPath = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefsPath;
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'xdg');
  env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1'; // the shipped default, pinned explicitly
  env.TRAFFIC_ONE_AUTH = '1';
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1'; // never spawn a real wizard server
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  resetPluginUseCache();
  writeOneSection('auth', {
    version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
  }, env);

  fs.mkdirSync(project, { recursive: true });
  if (opts.pristine) seedPristineProject(project); else seedOnboardedProject(project);
  // Consent is recorded BEFORE the tree snapshot, so the decline sweep that
  // recordPluginUseChoice triggers is not itself counted as drift — what is
  // being measured is what the HOOKS do afterwards.
  if (consent === 'declined') recordPluginUseChoice(project, false, 'test');
  if (consent === 'consented') recordPluginUseChoice(project, true, 'test');
  resetPluginUseCache();

  return fn({ project, prefsPath, base: dir }).finally(() => {
    for (const [k, v] of Object.entries({
      TRAFFIC_ONE_PROJECT_PREFS_PATH: saved.prefs,
      TRAFFIC_ONE_STATE_PATH: saved.state,
      XDG_STATE_HOME: saved.xdg,
      TRAFFIC_ONE_ASK_USE_PLUGIN: saved.ask,
      TRAFFIC_ONE_AUTH: saved.auth,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: saved.noSpawn,
      TRAFFIC_ONE_USER_PLAN: saved.plan,
    })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    resetPluginUseCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// What a run on a CONSENTED project measurably produces here. None of these are
// seeded by the fixture, so their presence is proof the run produced them, and
// each goes through a DIFFERENT guarded primitive: the once-marker through
// writeTextFile (shared/once.ts), the capability baseline through writeJson.
//
// Deliberately NOT the materialized tree (manifest.json, AGENTS.md, CLAUDE.md,
// the generated .gitignore): materializeProjectAssets refuses outright when the
// plugin root is a source checkout, which is exactly what src/build/test-preload.mjs
// pins for the whole suite, so its absence here says nothing about consent. The
// sweeps and the decision log below cover the write-heavy half of the run.
const CONSENTED_WRITES = [
  `.traffic-one/runs/.once/one-mcp-sync-claude-${SESSION_ID}`, // a once-marker was claimed
  '.traffic-one/runs/9/host-capability-v1.json',               // the run capability baseline
] as const;

function consentedMarkers(project: string): string[] {
  return CONSENTED_WRITES.filter((rel) => fs.existsSync(path.join(project, rel)));
}

// Every hook entry point a host can reach on a normal turn.
async function driveEveryEntryPoint(project: string): Promise<string[]> {
  const sessionId = SESSION_ID;
  const calls: [string, unknown][] = [
    ['session-start', { hook_event_name: 'SessionStart', cwd: project, session_id: sessionId }],
    ['user-prompt-submit', { hook_event_name: 'UserPromptSubmit', cwd: project, session_id: sessionId, prompt: 'add a login page with supabase auth' }],
    ['check-onboarding-gate', { hook_event_name: 'PreToolUse', cwd: project, session_id: sessionId, tool_name: 'Write', tool_input: { file_path: path.join(project, 'src/login.tsx'), content: 'export const Login = () => null;' } }],
    ['check-plan-write', { hook_event_name: 'PreToolUse', cwd: project, session_id: sessionId, tool_name: 'Write', tool_input: { file_path: path.join(project, 'src/login.tsx'), content: 'export const Login = () => null;' } }],
    ['check-library-allowlist', { hook_event_name: 'PreToolUse', cwd: project, session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } }],
    ['check-agent-model', { hook_event_name: 'PreToolUse', cwd: project, session_id: sessionId, tool_name: 'Task', tool_input: { subagent_type: 'senior-backend', prompt: 'do the thing' } }],
    // A second SessionStart: once-markers and seq counters behave differently on
    // the second call in the same session, which is where two of the three
    // historical regressions actually wrote.
    ['session-start', { hook_event_name: 'SessionStart', cwd: project, session_id: sessionId }],
  ];
  const out: string[] = [];
  for (const [subcommand, payload] of calls) {
    const result = await runClaudeHook(subcommand, JSON.stringify(payload));
    assert.equal(result.exitCode, 0, `${subcommand} must always exit 0`);
    if (result.stdout) assert.doesNotThrow(() => JSON.parse(result.stdout), `${subcommand} emitted invalid JSON`);
    out.push(result.stdout);
  }
  return out;
}

// ── the contract ─────────────────────────────────────────────────────────────

test('consent PENDING: every hook entry point leaves an onboarded project byte-identical', async () => {
  await withProject('pending', async ({ project }) => {
    const before = snapshot(project);
    assert.ok(before.size > 60, 'fixture must carry real accumulated state to reclaim');
    const outputs = await driveEveryEntryPoint(project);
    assertByteIdentical('consent pending', before, snapshot(project));
    // Pending is not "off": the user still has to be asked.
    assert.ok(outputs.some((text) => text.length > 0), 'a pending project must still get the question');
  });
});

test('consent DECLINED: every hook entry point leaves the project untouched', async () => {
  await withProject('declined', async ({ project }) => {
    const before = snapshot(project);
    await driveEveryEntryPoint(project);
    assertByteIdentical('consent declined', before, snapshot(project));
  });
});

// The 143/70 scenario: a mode-bearing .one.json with NO recorded answer. Reached
// by a repo cloned to a second machine, a moved directory, a pre-ask-first
// install, or a cleared choice. SessionStart used to sweep and re-materialize it.
test('consent PENDING on an ONBOARDED project: SessionStart neither reclaims nor materializes', async () => {
  await withProject('pending', async ({ project }) => {
    const before = snapshot(project);
    await runClaudeHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd: project, session_id: 's' }));
    const after = snapshot(project);
    assertByteIdentical('onboarded + pending', before, after);
    // Named explicitly, because these are the three the reviewer measured.
    assert.equal(fs.readdirSync(path.join(project, '.traffic-one/digests')).length, 12, 'sweepOldDigests must not run');
    assert.equal(fs.readdirSync(path.join(project, '.traffic-one/runs')).length, 13, 'sweepTrafficOneRetention must not run');
    assert.deepEqual(consentedMarkers(project), [], 'nothing a consented run writes may appear');
  });
});

// The same shape reached from the other direction: a project that HAS been
// materialized, whose recorded answer then goes away. In production that is a
// clone on a second machine, a moved directory, a pre-ask-first install or a
// lost prefs file — the answer lives in the per-user prefs, never in the repo,
// so the project's own state dir survives an answer that does not. (Not
// `--reconsider`: runners/onboarding-wait/consent.ts records `true` there
// rather than clearing, so it lands in the consented case above.) This is the
// one a "we already materialized it, so they must have said yes" assumption
// would miss.
test('a CLEARED choice returns an onboarded project to the pending fence', async () => {
  await withProject('consented', async ({ project }) => {
    // Prove the consented run is the one that writes, so the cleared run below
    // is a real before/after and not a project nothing ever touches.
    await runClaudeHook('session-start', JSON.stringify({ hook_event_name: 'SessionStart', cwd: project, session_id: 's' }));
    assert.ok(consentedMarkers(project).length > 0, 'a consented project DOES materialize');

    clearPluginUseChoice(project);
    const before = snapshot(project);
    await driveEveryEntryPoint(project);
    assertByteIdentical('choice cleared', before, snapshot(project));
  });
});

test('consent CONSENTED: the hooks still write exactly as before the fence', async () => {
  await withProject('consented', async ({ project }) => {
    const before = snapshot(project);
    await driveEveryEntryPoint(project);
    const after = snapshot(project);
    assert.notEqual(describeDrift(before, after), '', 'a consented project must still be written to');
    assert.deepEqual(consentedMarkers(project), [...CONSENTED_WRITES], 'every consented write still lands');
    assert.ok(
      fs.readdirSync(path.join(project, '.traffic-one/digests')).length < 12,
      'the digest sweep runs once consent exists',
    );
    assert.ok(
      fs.readdirSync(path.join(project, '.traffic-one/runs')).length < 13,
      'the retention sweep runs once consent exists',
    );
    assert.ok(
      fs.readFileSync(path.join(project, '.traffic-one/runs/9/debug/decisions.jsonl'), 'utf8').split('\n').length > 2,
      'the decision log records once consent exists',
    );
  });
});

// ── the pristine project: nothing may be CREATED ─────────────────────────────
// The onboarded cases above prove no CONTENT changes. This proves no PATHS
// appear, which is a different failure: three raw `fs.mkdirSync` calls left
// `.traffic-one/`, `.traffic-one/runs/` and `.traffic-one/runs/<id>/` behind on
// every pending run — empty, so no hash changed and no file existed to notice.

test('consent PENDING on a PRISTINE project: a full hook drive creates ZERO paths, empty directories included', async () => {
  await withProject('pending', async ({ project }) => {
    const before = snapshot(project);
    const outputs = await driveEveryEntryPoint(project);
    const after = snapshot(project);
    assertByteIdentical('pristine + pending', before, after);
    assert.equal(after.size, before.size, 'not one path may appear');
    // Named individually, because these three are the residue the reviewer
    // measured and a count alone would not say which one came back.
    for (const rel of ['.traffic-one', '.traffic-one/runs']) {
      assert.equal(fs.existsSync(path.join(project, rel)), false, `${rel} must not be created`);
    }
    // The user still gets asked — pending is not "plugin off".
    assert.ok(outputs.some((text) => text.length > 0), 'a pending project must still get the question');
  }, { pristine: true });
});

test('consent DECLINED on a PRISTINE project: a full hook drive creates ZERO paths', async () => {
  await withProject('declined', async ({ project }) => {
    const before = snapshot(project);
    await driveEveryEntryPoint(project);
    assertByteIdentical('pristine + declined', before, snapshot(project));
    assert.equal(fs.existsSync(path.join(project, '.traffic-one')), false);
  }, { pristine: true });
});

// ── the materializer: the writes the PATH fence cannot see ───────────────────
// materializeProjectAssets is the one writer whose output the path-addressed
// fence in shared/fsjson.ts cannot describe. Called directly on a pending
// project it produced 51 empty `.traffic-one/skills/<name>/` directories (raw
// `fs.mkdirSync` in materialize/generated.ts copySkillDir) AND rewrote root
// AGENTS.md + CLAUDE.md, which are not under `.traffic-one/` at all.
//
// Driven DIRECTLY, not through a hook: every hook path already stands down
// earlier, so a fence proven only through them is proven against the callers
// that were remembered — and this function has five callers.

for (const consent of ['pending', 'declined'] as const) {
  test(`consent ${consent.toUpperCase()}: a DIRECT materializeProjectAssets call writes nothing at all`, async () => {
    await withProject(consent, async ({ project, base }) => {
      const before = snapshot(project);
      const agentsBefore = fs.readFileSync(path.join(project, 'AGENTS.md'));
      const claudeBefore = fs.readFileSync(path.join(project, 'CLAUDE.md'));

      const result = withInstalledPluginRoot(base, () => materializeProjectAssets(project, { ...MATERIALIZABLE_STATE }));

      assert.equal(result.skipped, 'plugin-use-not-permitted', 'it must refuse for the consent reason, not a plugin-root one');
      assert.equal(result.written, 0);
      assert.equal(result.removed, 0);
      assertByteIdentical(`direct materialize + ${consent}`, before, snapshot(project));
      // Spelled out separately from the tree comparison: these are the user's
      // OWN files, in their repo root, and rewriting them is the most visible
      // possible violation of the contract.
      assert.ok(agentsBefore.equals(fs.readFileSync(path.join(project, 'AGENTS.md'))), 'root AGENTS.md is byte-identical');
      assert.ok(claudeBefore.equals(fs.readFileSync(path.join(project, 'CLAUDE.md'))), 'root CLAUDE.md is byte-identical');
      assert.equal(fs.lstatSync(path.join(project, 'CLAUDE.md')).isSymbolicLink(), false, 'root CLAUDE.md was not replaced by a symlink');
      assert.equal(fs.existsSync(path.join(project, '.gitignore')), false, 'no generated .gitignore');
      assert.equal(fs.existsSync(path.join(project, '.traffic-one')), false, 'not even an empty state dir');
    }, { pristine: true });
  });
}

// The other half of the same measurement, and the reason the two above are not
// vacuous: with consent recorded, this exact fixture writes ~150 paths and DOES
// take the root files. If a change ever makes the refusal unconditional, this
// fails instead of quietly disabling materialization for everyone.
test('consent CONSENTED: the same direct call still materializes the full tree and takes the root files', async () => {
  await withProject('consented', async ({ project, base }) => {
    const result = withInstalledPluginRoot(base, () => materializeProjectAssets(project, { ...MATERIALIZABLE_STATE }));

    assert.equal(result.skipped, undefined, 'a consented project materializes for real');
    assert.ok(result.rules > 20, `expected the real rule spine, got ${result.rules}`);
    assert.ok(result.skills > 20, `expected the real skill set, got ${result.skills}`);
    assert.ok(result.written > 50, `expected a full materialization, got ${result.written} writes`);
    // The skill directories whose empty husks were the pending-case residue.
    const skillDirs = fs.readdirSync(path.join(project, '.traffic-one', 'skills'));
    assert.ok(skillDirs.length > 20, `expected the skills tree, got ${skillDirs.length} dirs`);
    assert.ok(
      fs.readdirSync(path.join(project, '.traffic-one', 'skills', skillDirs[0]!)).includes('SKILL.md'),
      'and the directories have their files, not just the husk',
    );
    // Root context is taken over, and the hand-written original is preserved
    // rather than destroyed — the write the pending case had refused while the
    // delete still landed.
    assert.ok(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8').includes('GENERATED BY traffic-one'));
    assert.ok(
      fs.readFileSync(path.join(project, '.traffic-one', 'AGENTS.local.md'), 'utf8').includes('Hand-written, not generated.'),
      'the user\'s own AGENTS.md content survives, in the preserved copy',
    );
  }, { pristine: true });
});

// ── the decline sweep ────────────────────────────────────────────────────────

test('declining an ONBOARDED project removes the activity log but keeps the answers', async () => {
  await withProject('pending', async ({ project }) => {
    const stateDir = path.join(project, '.traffic-one');
    assert.ok(fs.existsSync(path.join(stateDir, 'runs/1/debug/decisions.jsonl')));
    assert.ok(fs.existsSync(path.join(stateDir, 'debug/decisions.jsonl')));
    assert.ok(fs.existsSync(path.join(stateDir, 'runs/.once/marker-0-shared')));

    recordPluginUseChoice(project, false, 'test');

    // The activity log is a record of every tool call, file path and shell
    // command. "Don't use Traffic One here" has to mean that goes.
    assert.equal(fs.existsSync(path.join(stateDir, 'debug')), false, 'root activity log removed');
    assert.equal(fs.existsSync(path.join(stateDir, 'runs/.once')), false, 'once-markers removed');
    for (let i = 1; i <= 12; i += 1) {
      assert.equal(fs.existsSync(path.join(stateDir, `runs/${i}/debug`)), false, `runs/${i} activity log removed`);
    }
    // The user's own work survives — they may change their mind.
    assert.ok(fs.existsSync(path.join(stateDir, '.one.json')), 'answers kept');
    assert.ok(fs.existsSync(path.join(stateDir, 'plan.md')), 'plan kept');
    assert.ok(fs.existsSync(path.join(stateDir, 'runs/1/ledger.json')), 'run ledgers kept');
  });
});

test('declining a NEVER-onboarded project removes the whole state dir', async () => {
  await withProject('pending', async ({ project }) => {
    fs.rmSync(path.join(project, '.traffic-one/.one.json'));
    recordPluginUseChoice(project, false, 'test');
    assert.equal(fs.existsSync(path.join(project, '.traffic-one')), false);
  });
});

// ── the primitive ────────────────────────────────────────────────────────────

test('the fence is addressed by path, and never fences per-user or ordinary paths', () => {
  const home = path.join(os.tmpdir(), 't1-fence-home');
  const saved = { home: process.env.HOME, xdg: process.env.XDG_STATE_HOME, ask: process.env.TRAFFIC_ONE_ASK_USE_PLUGIN };
  process.env.HOME = home;
  delete process.env.XDG_STATE_HOME;
  // Pinned, not inherited: the machine-owned assertions below turn on the $HOME
  // project's question being PENDING, and the bundled default plus whatever an
  // earlier test in this process left behind are two different answers.
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1';
  resetPluginUseCache();
  try {
    assert.equal(projectRootForStatePath('/repo/.traffic-one/runs/1/debug/x.json'), '/repo');
    assert.equal(projectRootForStatePath('/repo/.traffic-one'), '/repo');
    // The OUTER project owns a nested state dir.
    assert.equal(projectRootForStatePath('/repo/.traffic-one/x/.traffic-one/y'), '/repo');
    // Not project state at all.
    assert.equal(projectRootForStatePath('/repo/src/index.ts'), null);
    assert.equal(projectRootForStatePath('/repo/.traffic-one-backup/x'), null);
    // The per-user dir holds the consent answer itself — fencing it would
    // make recording an answer impossible.
    assert.equal(projectRootForStatePath(path.join(home, '.traffic-one/projects/abc/preferences.json')), null);
    assert.equal(projectStateWriteAllowed(path.join(home, '.traffic-one/one.json')), true);
    assert.equal(projectStateWriteAllowed('/repo/src/index.ts'), true);

    // The machine-owned allowlist carries two SHAPES and only one of them needs
    // the `<entry>.<suffix>` sidecar wildcard.
    //
    // FILES need it, and fencing their sidecars is the deadlock this carve-out
    // exists to prevent: `one.json.lock/` guards the machine-wide settings
    // file, so on the default $HOME layout — where the machine dir IS the $HOME
    // project's state dir — a fenced lock means that file can never be written
    // while the $HOME project's use-plugin question is pending.
    const md = (entry: string): string => path.join(home, '.traffic-one', entry);
    for (const owned of ['one.json.lock', 'one.json.lock/owner-ab.json', 'one.json.1234.tmp',
      'one-mcp.json.1.2.ff.tmp', 'secret.env.lock', 'windsurf-plugin-root.tmp']) {
      assert.equal(projectStateWriteAllowed(md(owned)), true, `${owned} is a machine-owned file's sidecar`);
    }

    // DIRECTORIES do not: the first segment under the machine dir is what is
    // matched, so an exact match already covers everything inside them —
    // including the lock and temp files prefs-store.ts writes BESIDE
    // `projects/<hash>/preferences.json`, which still resolve to `projects`.
    for (const owned of ['projects', 'projects/abc/preferences.json',
      'projects/abc/preferences.json.lock', 'projects/abc/preferences.json.9.tmp',
      'bin', 'bin/doctor.cjs', 'toolchains', 'overrides', 'overrides/ledger.jsonl']) {
      assert.equal(projectStateWriteAllowed(md(owned)), true, `${owned} is machine-owned`);
    }
    // …so a sibling of a directory entry is NOT machine state, and while it was
    // one the fence did not apply to it at all (measured: `root=null,
    // allowed=true` for `bin.evil` on a $HOME project whose question was
    // PENDING). No writer produces these, which is exactly why an over-broad
    // allowlist entry here goes unnoticed.
    for (const stray of ['projects.evil', 'bin.evil', 'toolchains.evil', 'overrides.evil']) {
      assert.equal(projectRootForStatePath(md(stray)), home, `${stray} is not machine-owned`);
      assert.equal(projectStateWriteAllowed(md(stray)), false, `${stray} is fenced while pending`);
    }
  } finally {
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
    if (saved.xdg === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = saved.xdg;
    if (saved.ask === undefined) delete process.env.TRAFFIC_ONE_ASK_USE_PLUGIN; else process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = saved.ask;
    resetPluginUseCache();
  }
});

// Every guarded primitive, not just the two the hooks happen to exercise above:
// a fence with a hole in one of seven writers is a fence with a hole.
//
// createJsonExclusive was the hole: this table listed six and shared/fsjson.ts
// exports seven, and its consent refusal was killed by NOTHING in the suite
// (measured — the whole of `npm test` stayed green with that one primitive's
// consent branch removed). Its product caller is the role-keyed pending claim in
// state/run-agent/claims-store.ts, which is a compare-and-swap: it is the one
// primitive whose refusal shares a return value with a NORMAL outcome
// ('exists', the losing side of the CAS), so a fence that stopped applying here
// would not merely write — it would be indistinguishable from a rival winning.
test('every guarded primitive refuses project state while the question is pending', async () => {
  await withProject('pending', async ({ project }) => {
    const stateDir = path.join(project, '.traffic-one');
    const seeded = path.join(stateDir, 'plan.md');
    const fresh = (name: string): string => path.join(stateDir, 'runs', '1', name);

    // writeJson reports its refusal like every sibling — it used to return
    // `void`, which made the refusal undetectable to a caller whose next step
    // depended on the write having landed (decision-log.ts's nextHookSeq).
    // The collector is drained by the pipeline, not per test, so an earlier test
    // in this process leaves its own records behind. Cleared here so the
    // assertion at the end of this test describes only these calls.
    drainStateWrites();

    assert.equal(writeJson(fresh('a.json'), { x: 1 }), false);
    assert.equal(fs.existsSync(fresh('a.json')), false, 'writeJson refused');
    assert.equal(writeTextFile(fresh('b.txt'), 'x'), false);
    assert.equal(fs.existsSync(fresh('b.txt')), false, 'writeTextFile refused');
    assert.equal(appendTextFile(fresh('c.jsonl'), 'x\n'), false);
    assert.equal(fs.existsSync(fresh('c.jsonl')), false, 'appendTextFile refused');
    // 'refused', never 'exists': the CAS's losing side means "someone else holds
    // this slot", and a caller told that about a slot NOBODY holds stands down
    // from work it was entitled to do — while believing the fence let it through.
    assert.equal(createJsonExclusive(fresh('d.json'), { x: 1 }), 'refused');
    assert.equal(fs.existsSync(fresh('d.json')), false, 'createJsonExclusive refused');
    assert.equal(ensureDir(path.join(stateDir, 'brand-new')), false);
    assert.equal(fs.existsSync(path.join(stateDir, 'brand-new')), false, 'ensureDir refused');
    assert.equal(removePath(seeded), false);
    assert.equal(fs.existsSync(seeded), true, 'removePath refused — deleting is a write');
    // A move is a write at the destination AND a delete at the source, so a
    // refusal must leave BOTH ends alone: a half-move is data loss, not a
    // skipped write. Both directions are checked — a root file being migrated
    // INTO the state dir has an unfenced source and a fenced destination.
    const outside = path.join(project, 'api.md');
    fs.writeFileSync(outside, '# root api notes\n', 'utf8');
    assert.equal(movePath(outside, path.join(stateDir, 'api.md')), false);
    assert.equal(fs.existsSync(outside), true, 'movePath refused: the source survives');
    assert.equal(fs.existsSync(path.join(stateDir, 'api.md')), false, 'movePath refused: nothing landed');
    assert.equal(movePath(seeded, path.join(stateDir, 'plan-moved.md')), false);
    assert.equal(fs.existsSync(seeded), true, 'movePath refused inside the state dir too');

    // Every one of those refusals is EVIDENCE, not silence: the chokepoint
    // reports it to the per-invocation collector the decision log drains, so a
    // `stateWrites` reader sees the writes that did not happen and why. That is
    // the whole reason the field exists, and it was the one event it could not
    // see — the collector was wired into two call sites and not into here.
    const refusals = drainStateWrites();
    assert.deepEqual(
      [...new Set(refusals.map((record) => record.errno))], ['consent-fence'],
      `every refusal above is recorded as a consent-fence refusal: ${JSON.stringify(refusals)}`,
    );
    assert.deepEqual(refusals.filter((record) => record.ok), [], 'and not one of them claims to have landed');
    assert.deepEqual(
      refusals.map((record) => record.op).sort(),
      ['append-text', 'create-json', 'mkdir', 'move-to', 'move-to', 'remove', 'write-json', 'write-text'],
      'each guarded primitive names its own operation',
    );

    // …and every one of them acts the moment the answer is yes.
    recordPluginUseChoice(project, true, 'test');
    assert.equal(writeJson(fresh('a.json'), { x: 1 }), true);
    assert.equal(fs.existsSync(fresh('a.json')), true);
    assert.equal(writeTextFile(fresh('b.txt'), 'x'), true);
    assert.equal(appendTextFile(fresh('c.jsonl'), 'x\n'), true);
    assert.equal(createJsonExclusive(fresh('d.json'), { x: 1 }), 'created');
    // …and 'exists' still means what it means, so the assertion above is about
    // the fence rather than about the CAS never succeeding twice.
    assert.equal(createJsonExclusive(fresh('d.json'), { x: 2 }), 'exists');
    assert.equal(ensureDir(path.join(stateDir, 'brand-new')), true);
    assert.equal(movePath(outside, path.join(stateDir, 'api.md')), true);
    assert.equal(fs.existsSync(outside), false, 'the source is gone once the move lands');
    assert.equal(fs.readFileSync(path.join(stateDir, 'api.md'), 'utf8'), '# root api notes\n', 'byte-preserving');
    assert.equal(removePath(seeded), true);
    assert.equal(fs.existsSync(seeded), false);
  });
});

test('recording consent takes effect immediately, in-process, despite the memo', async () => {
  await withProject('pending', async ({ project }) => {
    const target = path.join(project, '.traffic-one/runs/1/debug/x.json');
    assert.equal(projectStateWriteAllowed(target), false, 'pending refuses');
    recordPluginUseChoice(project, true, 'test');
    assert.equal(projectStateWriteAllowed(target), true, 'the memo must not outlive the answer it cached');
    recordPluginUseChoice(project, false, 'test');
    assert.equal(projectStateWriteAllowed(target), false);
    clearPluginUseChoice(project);
    assert.equal(projectStateWriteAllowed(target), false, 'cleared is pending again');
  });
});
