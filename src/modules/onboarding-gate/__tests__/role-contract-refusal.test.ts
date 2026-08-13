// THE PRODUCT RULING, at the gate: a host whose per-role contract directory
// cannot be written blocks FILE-CHANGING work and nothing else.
//
// Every assertion below is at a GATE OUTCOME — what the agent is actually told —
// rather than at the predicate that decides it, because the predicate was never
// the hard part. Round 1 reported the refusal into `MaterializeResult`, and the
// peer established that four of the five routes that reach the writer discard
// that value: the fact existed and nothing consumed it. So the properties are:
//
//   1. a mutating PreToolUse on a project whose role directory is refused is
//      DENIED, under its own id, with the host, the path and the errno in the
//      text, no retry prescribed, and the instruction to report it;
//   2. a READ-ONLY call on the same project is not denied — the ruling costs
//      file-changing work, not the session;
//   3. a HEALTHY project is not denied, which is what stops this from being a
//      predicate that fires on everything;
//   4. the condition is asked of DISK on every call, so it survives the steady
//      state where no materialization runs — and HEALS on the first call after a
//      human clears the path, contracts on disk, deny gone;
//   5. the read-only session, which the deny deliberately does not cover, gets
//      the same fact from the SessionStart banner instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { onboardingGate } from '../handler';
import { roleContractBanner } from '../../session/session-start-lib';
import { runSessionStartAuthed } from '../../session/session-start';
import { CURSOR_AGENTS_REL } from '../../../shared/materialize/cursor-agent-model';
import { writeMaterializedContent } from '../../../shared/materialize/__tests__/fixtures/materialized-content';
import { assertInstalledPluginRoot } from '../../../shared/materialize/__tests__/fixtures/installed-root';
import { writeGlobalCodeGraphProvider } from '../../../shared/state';
import { initializeToolchainState } from '../../../shared/state/toolchain';
import { hostScopedPerformancePrefs } from '../../../test-support/host-prefs';
import { writeSimpleAuth } from '../../../shared/auth';
import type { Ctx, HookInput, HookResult, ToolClass } from '../../../core/types';

// A project the wizard has FINISHED — `computeOnboarding` must answer
// `done: true`, or every gate below short-circuits into the setup deny long
// before the role-contract check. Measured while building this fixture: with
// `projectContext` absent the step is `project-context` and the verdict is
// `onboarding-server-deny-first`, which is why the state file is written in full
// rather than through the materialization fixture's smaller shape.
const COMPLETE_PROJECT: Record<string, unknown> = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
  projectContext: {
    source: 'prompted',
    originalPrompt: 'x',
    summary: 's',
    answers: { a: 1 },
    collectedAt: '2026-01-01T00:00:00Z',
  },
  confirmed: true,
  confirmedAt: '2026-01-01T00:00:00Z',
  onboardingComplete: true,
  materializedStack: 'default|react-vite|supabase|none',
  realtime: 'none',
  supabaseFunctionsAutoDeploy: 'ask',
};

function ctx(cwd: string, rawName: string, cls: ToolClass, toolInput: Record<string, unknown>): Ctx {
  const raw = { tool_name: rawName, tool_input: toolInput, session_id: 'cursor-main', workspace_roots: [cwd], transcript_path: path.join(cwd, 't.jsonl') };
  const input: HookInput = { event: 'PreToolUse', host: 'cursor', cwd, raw, tool: { class: cls, rawName }, workspaceRoot: cwd };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

function sessionCtx(cwd: string): Ctx {
  const input: HookInput = { event: 'SessionStart', host: 'cursor', cwd, raw: {}, workspaceRoot: cwd };
  return { input, host: 'cursor', cwd, now: () => 'x' } as unknown as Ctx;
}

const write = (cwd: string): HookResult => onboardingGate(ctx(cwd, 'Write', 'file-write', { file_path: path.join(cwd, 'src', 'app.ts'), content: 'x' }));
const read = (cwd: string): HookResult => onboardingGate(ctx(cwd, 'Read', 'file-read', { file_path: path.join(cwd, 'src', 'app.ts') }));
const denyId = (result: HookResult): string => ('denyId' in result ? String(result.denyId ?? '') : '');
const reason = (result: HookResult): string => ('reason' in result ? String(result.reason ?? '') : '');

/** An installed plugin root, enough of one for materialization to resolve. */
function installedPluginRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-deny-plugin-'));
  const modules = path.resolve(__dirname, '..', '..', '..', 'modules');
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'hook-runtime.cjs'), '// fixture stub\n', 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'traffic-one', version: '9.9.9' }), 'utf8');
  fs.symlinkSync(path.join(modules, 'rules', 'rules'), path.join(root, 'rules'), 'dir');
  fs.symlinkSync(path.join(modules, 'skills', 'skills-catalog'), path.join(root, 'skills-catalog'), 'dir');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  for (const role of ['senior-frontend', 'senior-backend']) {
    fs.copyFileSync(path.join(modules, role, 'agent.md'), path.join(root, 'agents', `${role}.md`));
  }
  return root;
}

/** A fully materialized Cursor project, host cursor, with contracts on disk. */
function withCursorProject(fn: (cwd: string) => void): void {
  const plugin = installedPluginRoot();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-deny-proj-')));
  const env = process.env;
  const previous = {
    plugin: env.TRAFFIC_ONE_PLUGIN_ROOT,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    host: env.TRAFFIC_ONE_HOST,
    plan: env.TRAFFIC_ONE_USER_PLAN,
    auth: env.TRAFFIC_ONE_AUTH,
    noSpawn: env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_HOST = 'cursor';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  env.TRAFFIC_ONE_AUTH = '1';
  env.TRAFFIC_ONE_ONBOARDING_NO_SPAWN = '1';
  try {
    assertInstalledPluginRoot('role-contract refusal gate');
    writeSimpleAuth('sk-test');
    writeMaterializedContent(dir, { stack: 'default', state: { ...COMPLETE_PROJECT } });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ctx\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(COMPLETE_PROJECT), 'utf8');
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      ...hostScopedPerformancePrefs(
        { level: 'low', source: 'prompted' },
        { mode: 'main-agent', source: 'prompted' },
        'pro',
      ),
      // The toolchain step is one of the wizard's own: without it
      // `computeOnboarding` is not `done` and the setup deny wins the race.
      toolchain: Object.fromEntries(
        Object.keys(initializeToolchainState({})).map((key) => [key, { installedVersion: '1', installedAt: 'now' }]),
      ),
    }), 'utf8');
    writeGlobalCodeGraphProvider('graphify');
    fn(dir);
  } finally {
    for (const [key, value] of Object.entries({
      TRAFFIC_ONE_PLUGIN_ROOT: previous.plugin,
      TRAFFIC_ONE_PROJECT_PREFS_PATH: previous.prefs,
      TRAFFIC_ONE_STATE_PATH: previous.state,
      TRAFFIC_ONE_HOST: previous.host,
      TRAFFIC_ONE_USER_PLAN: previous.plan,
      TRAFFIC_ONE_AUTH: previous.auth,
      TRAFFIC_ONE_ONBOARDING_NO_SPAWN: previous.noSpawn,
    })) {
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plugin, { recursive: true, force: true });
  }
}

/** `.cursor/agents` occupied by a plain file: the cheapest reachable refusal. */
function plantFileAtRoleDirectory(cwd: string): string {
  const dir = path.join(cwd, CURSOR_AGENTS_REL);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'my own notes, not a directory\n', 'utf8');
  return dir;
}

function contractsOnDisk(cwd: string): number {
  try {
    return fs.readdirSync(path.join(cwd, CURSOR_AGENTS_REL)).filter((name) => name.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

test('a refused role-contract directory denies file-changing work, under its own id, naming the path and the errno', () => {
  withCursorProject((cwd) => {
    // BASELINE FIRST. A predicate that denied everything would satisfy every
    // assertion below, and this is the only thing that rules it out. This first
    // call converges the fixture, so its verdict is the pre-existing
    // `repaired-materialization` notice — measured, and NOT this refusal.
    const healthyWrite = write(cwd);
    assert.notEqual(denyId(healthyWrite), 'host-role-contracts-unwritable',
      `a healthy project must not be refused (got ${healthyWrite.kind}/${denyId(healthyWrite)})`);
    assert.ok(contractsOnDisk(cwd) >= 6, 'fixture: the healthy run has contracts on disk');

    const planted = plantFileAtRoleDirectory(cwd);
    const denied = write(cwd);
    assert.equal(denied.kind, 'deny', 'a file-changing tool must be refused');
    assert.equal(denyId(denied), 'host-role-contracts-unwritable',
      'under its own id — never materialization-not-converged, whose cause is a broken plugin root');
    const text = reason(denied);
    assert.match(text, /host `cursor`/, 'the HOST whose contracts are missing');
    assert.match(text, /\.cursor\/agents/, 'the REFUSED PATH, project-relative');
    assert.match(text, /EEXIST/, 'and the ERRNO, which is what says which of the four causes it is');
    assert.match(text, /Do NOT retry/, 'no retry is prescribed');
    assert.match(text, /REPORT IT TO THE USER/, 'the agent is told to hand it to the user');
    assert.match(text, /`rm`, `mv`, `chmod`, `chown`, `ln`/,
      'and told why it cannot fix it itself — every repair is a mutating call this same deny refuses');

    // The path is project-relative in the DENY TARGET too, not just the prose:
    // shared/state/deny-repeat.ts signs the escalation counter on it, and an
    // absolute machine-local path would split one refusal across two sessions of
    // the same project and stop escalation arriving.
    assert.equal('denyTarget' in denied ? denied.denyTarget : '', CURSOR_AGENTS_REL,
      'the deny target is the project-relative path, so the escalation counter is stable');
    assert.ok(!path.isAbsolute(String('denyTarget' in denied ? denied.denyTarget : '')));

    // Read-only work continues. THE RULING, stated exactly.
    const readOnly = read(cwd);
    assert.notEqual(denyId(readOnly), 'host-role-contracts-unwritable',
      `read-only work must be unaffected (got ${readOnly.kind}/${denyId(readOnly)})`);

    // Fixture: the planted file is still there, so all of the above was measured
    // against a project that genuinely has no role contracts.
    assert.equal(fs.statSync(planted).isDirectory(), false);
    assert.equal(contractsOnDisk(cwd), 0);
  });
});

test('the refusal repeats while the path is occupied, and HEALS on the first call after it is cleared', () => {
  withCursorProject((cwd) => {
    const planted = plantFileAtRoleDirectory(cwd);

    // Twice, with no materialization in between: the answer comes from disk, so
    // the steady state — where `materializeProjectIfNeeded` short-circuits an
    // already-materialized project and returns null — is covered. A deny keyed on
    // a run's own result would fire once here and then go quiet forever while the
    // contracts stayed absent, which is round 1's defect with an extra step.
    assert.equal(denyId(write(cwd)), 'host-role-contracts-unwritable');
    assert.equal(denyId(write(cwd)), 'host-role-contracts-unwritable', 'and again — this is what escalation needs');
    assert.equal(reason(write(cwd)), reason(write(cwd)),
      'byte-identically, or the deny-repeat signature would not group the attempts');

    // A human clears the path. Nothing else happens: no reset, no re-onboarding,
    // no explicit materialize.
    fs.rmSync(planted, { force: true });
    const afterRepair = write(cwd);
    assert.notEqual(denyId(afterRepair), 'host-role-contracts-unwritable',
      `the very next call must not be refused (got ${afterRepair.kind}/${denyId(afterRepair)})`);
    assert.ok(contractsOnDisk(cwd) >= 6,
      'and that same call must have WRITTEN the contracts — the convergence term is what makes this self-healing');
  });
});

test('the read-only session, which the deny does not cover, is told by the SessionStart banner', () => {
  withCursorProject((cwd) => {
    const state = { ...COMPLETE_PROJECT };
    assert.equal(roleContractBanner(cwd, state), '', 'a healthy project says nothing');

    plantFileAtRoleDirectory(cwd);
    const banner = roleContractBanner(cwd, state);
    assert.match(banner, /host `cursor`/, 'the host');
    assert.match(banner, /\.cursor\/agents` \(EEXIST\)/, 'the path and the errno');
    assert.match(banner, /host-role-contracts-unwritable/, 'what will refuse file-changing work');
    assert.match(banner, /do NOT tell it to read a contract file/,
      'and the one thing the orchestrator must change: spawn with the role inline');
    assert.match(banner, /^\[role contracts\]/, 'labelled, on the channel the session header already carries');

    // A project that never onboarded gets nothing: the banner is about a
    // materialization that fell short, and a pre-onboarding session has no
    // contracts to be short of.
    assert.equal(roleContractBanner(cwd, { mode: 'new-project' }), '');
  });
});

// A banner nobody reads is this repo's most repeated failure, so the ROUTE is
// pinned too, not only the string. `sessionStart` builds `header` and returns it
// as the session context; both branches that build one are branches this
// condition can be true on — the already-materialized path (where no writer runs
// at all, so the run's own result cannot report anything) and the
// auto-detected-existing-project path (where `stampMaterialization` runs the
// writer and discards its outcome).
test('the banner arrives in the context SessionStart actually returns', () => {
  withCursorProject((cwd) => {
    // BASELINE on the same project, so this cannot pass by returning the banner
    // unconditionally — which is the shape that would make every session shout
    // about a healthy install.
    const healthy = runSessionStartAuthed(sessionCtx(cwd));
    assert.equal(healthy.kind, 'context', 'fixture: the session must produce a context at all');
    const healthyText = healthy.kind === 'context' ? healthy.context : '';
    assert.doesNotMatch(healthyText, /\[role contracts\]/, 'a healthy project is not told about role contracts');

    plantFileAtRoleDirectory(cwd);
    const refused = runSessionStartAuthed(sessionCtx(cwd));
    assert.equal(refused.kind, 'context');
    const text = refused.kind === 'context' ? refused.context : '';
    // THE ROUTE, not the renderer: `roleContractBanner` is asserted directly
    // above, and this is the only assertion that the string reaches the value the
    // hook HANDS BACK to the host. A banner folded into a local that is discarded
    // reads identically at the unit boundary.
    assert.match(text, /\[role contracts\]/, 'the session context carries the disclosure');
    assert.match(text, /host `cursor`/);
    assert.match(text, /\.cursor\/agents` \(EEXIST\)/, 'with the path and the errno the user has to act on');
    assert.match(text, /host-role-contracts-unwritable/, 'and what will refuse file-changing work');
  });
});

// The SECOND header is a route this suite cannot reach behaviourally — it is the
// auto-detect branch for a project with no Traffic One state, which by
// construction is not a materialized project — so it is pinned by source count
// instead. Read as: the behavioural row above proves the banner reaches a
// returned context; this row proves no OTHER header was left without it.
test('both SessionStart headers carry the banner, so neither route is silent', () => {
  const file = path.resolve(__dirname, '..', '..', 'session', 'session-start.ts');
  const source = fs.readFileSync(file, 'utf8');
  // LIVE CODE ONLY. A commented-out call matches the same regex, and a mutant
  // that commented one out survived this row until the trim check was added
  // (measured: M7, .tmp/materialize2 campaign).
  const calls = source.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^header \+= roleContractBanner\(cwd, state\);$/.test(line));
  assert.equal(calls.length, 2,
    'session-start.ts must fold the banner into BOTH session headers it builds; found '
    + `${calls.length}. A route that omits it is a session where a refused role directory is invisible.`);
  const headers = source.split('\n').filter((line) => /^\s*let header = `═══ traffic-one/.test(line));
  assert.equal(headers.length, calls.length,
    `session-start.ts builds ${headers.length} headers and only ${calls.length} carry the banner`);
});
