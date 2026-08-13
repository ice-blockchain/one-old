// Six host role-contract writers each swallowed a failed `mkdirSync(dir,
// {recursive:true})` and returned a plain count — seeded from their own DELETION
// sweep — which materialize.ts folded into `written`. A project whose role
// directory could not be created therefore reported a complete materialization,
// stamped its state, and never tried again.
//
// The three facts these tests hold:
//   1. an inability is reported as one, per host, with the errno;
//   2. a sweep count is never returned as a write count;
//   3. NO file under `shared/materialize/**` creates a directory of its own —
//      read from the directory listing, matched on the AST callee, with three
//      audited exemptions — so a SEVENTH host writer is covered on the day it is
//      added. Demonstrated against the peer's own `zed-agents.ts` bypass, which
//      the filename-list rule this replaces passed.
//
// The complement to (3) lives in role-contract-seal.test.ts: the outcome type is
// unconstructible outside its own module, so a new writer cannot report a sweep
// count as a write count even without touching mkdir at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { writeCursorAgentFiles } from '../cursor-agents';
import { writeCopilotAgentFiles, COPILOT_AGENTS_REL } from '../copilot-agents';
import { writeKiloAgentFiles } from '../kilo-agents';
import { writeCodexAgentFiles, CODEX_AGENTS_REL } from '../codex-agents';
import { writeWindsurfAgentFiles, WINDSURF_AGENTS_REL } from '../windsurf-agents';
import { KILO_HOST_AGENTS_REL } from '../../../config/kilo-host';
import { CURSOR_AGENTS_REL } from '../cursor-agent-model';
import { roleContractFailures, roleContractsWritten, type RoleContractOutcome } from '../role-contracts';
import { cursorSpawnContractWarning, syncCursorSpawnAgentFiles } from '../cursor-spawn-map';
import { materializeProjectFromState } from '../converge';
import { writeGlobalCodeGraphProvider } from '../../state';
import { writeMaterializedContent } from './fixtures/materialized-content';
import { assertInstalledPluginRoot } from './fixtures/installed-root';

type Rec = Record<string, unknown>;

const FULL_STATE: Rec = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

const HOSTS: readonly { id: string; rel: string; write: (cwd: string, state: Rec) => RoleContractOutcome }[] = [
  { id: 'cursor', rel: CURSOR_AGENTS_REL, write: writeCursorAgentFiles },
  { id: 'copilot', rel: COPILOT_AGENTS_REL, write: writeCopilotAgentFiles },
  { id: 'kilo', rel: KILO_HOST_AGENTS_REL, write: writeKiloAgentFiles },
  { id: 'codex', rel: CODEX_AGENTS_REL, write: writeCodexAgentFiles },
  { id: 'windsurf', rel: WINDSURF_AGENTS_REL, write: writeWindsurfAgentFiles },
];

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-contract-'));
}

function contractCount(dir: string): number {
  let total = 0;
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(d, entry.name));
      else if (entry.name.endsWith('.md')) total += 1;
    }
  };
  walk(dir);
  return total;
}

// ── 1. the inability, per host ───────────────────────────────────────────────

test('every host reports a refused role directory instead of returning a count', () => {
  for (const host of HOSTS) {
    // BASELINE FIRST, so the refusal below cannot pass for a writer that never
    // writes anything on this machine at all.
    const healthy = tmp();
    try {
      const ok = host.write(healthy, FULL_STATE);
      assert.equal(ok.kind, 'complete', `${host.id}: baseline must materialize`);
      assert.ok(roleContractsWritten(ok) >= 6, `${host.id}: baseline wrote contracts`);
      assert.equal(roleContractFailures(ok).length, 0, `${host.id}: baseline has no failures`);
    } finally {
      fs.rmSync(healthy, { recursive: true, force: true });
    }

    // A PLAIN FILE at the role directory path. The cheapest reachable shape —
    // a user's own notes file, a checked-in placeholder, an editor artifact —
    // and it needs no permissions, no mount and no second process.
    const blocked = tmp();
    try {
      const dir = path.join(blocked, host.rel);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      fs.writeFileSync(dir, 'a file, not a directory\n', 'utf8');

      const outcome = host.write(blocked, FULL_STATE);
      assert.equal(outcome.kind, 'unwritable', `${host.id}: a refused role directory is reported as unwritable`);
      assert.equal(roleContractsWritten(outcome), 0, `${host.id}: nothing was written and nothing is claimed`);
      const failures = roleContractFailures(outcome);
      assert.equal(failures.length, 1, `${host.id}: the one refused path is named`);
      assert.equal(failures[0]?.path, dir, `${host.id}: and it is the role directory`);
      assert.ok(failures[0]?.errno, `${host.id}: with the errno the filesystem gave`);
      assert.equal(contractCount(path.join(blocked, host.rel)), 0, `${host.id}: fixture: genuinely no contracts on disk`);
    } finally {
      fs.rmSync(blocked, { recursive: true, force: true });
    }
  }
});

test('a role directory whose PARENT is unwritable is reported, not swallowed', () => {
  const cwd = tmp();
  const parent = path.dirname(path.join(cwd, CURSOR_AGENTS_REL));
  fs.mkdirSync(parent, { recursive: true });
  fs.chmodSync(parent, 0o500);
  try {
    // HARD fixture guard: root walks straight through mode 0500, which would
    // make this a vacuous pass on a writable directory.
    let writable = true;
    try { fs.mkdirSync(path.join(parent, 'probe')); } catch { writable = false; }
    assert.equal(writable, false, 'fixture: the parent must be unwritable to THIS process');

    const outcome = writeCursorAgentFiles(cwd, FULL_STATE);
    assert.equal(outcome.kind, 'unwritable');
    assert.equal(roleContractFailures(outcome)[0]?.errno, 'EACCES');
  } finally {
    fs.chmodSync(parent, 0o755);
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 2. deletions are not writes ──────────────────────────────────────────────

test('a sweep count is never returned as a write count', () => {
  const cwd = tmp();
  const dir = path.join(cwd, CURSOR_AGENTS_REL);
  const marker = '<!-- GENERATED BY traffic-one — per-role Cursor subagent -->';
  try {
    // A materialized project, so the role set comes from the writer rather than
    // from a hard-coded list that could drift out of eligibility.
    assert.equal(writeCursorAgentFiles(cwd, FULL_STATE).kind, 'complete', 'fixture: a healthy first run');
    const roles = fs.readdirSync(dir).filter((name) => name.endsWith('.md'));
    assert.ok(roles.length >= 6, 'fixture: the healthy run produced the role set');

    // Every contract is now STALE (so a rewrite is genuinely due) and read-only
    // (so the rewrite is refused). Marker kept: without it the writer would
    // treat them as user-authored and skip them, which is not a failure.
    for (const role of roles) {
      const file = path.join(dir, role);
      fs.writeFileSync(file, `${marker}\nsuperseded stub\n`, 'utf8');
      fs.chmodSync(file, 0o444);
    }
    // One generated contract for a role that is no longer eligible: the sweep
    // removes it, and THAT removal is what used to be returned as a write.
    fs.writeFileSync(path.join(dir, 'senior-obsolete.md'), `${marker}\nstale\n`, 'utf8');

    const outcome = writeCursorAgentFiles(cwd, FULL_STATE);
    assert.equal(outcome.kind, 'partial', 'some contracts could not be written');
    assert.equal(roleContractsWritten(outcome), 0, 'and NONE of them may be counted as written');
    assert.equal(outcome.kind === 'partial' ? outcome.removed : -1, 1, 'the sweep is reported as a removal, separately');
    assert.equal(roleContractFailures(outcome).length, roles.length, 'every refused contract is named');
    assert.ok(
      roleContractFailures(outcome).every((failure) => failure.errno === 'EACCES'),
      'with the errno the filesystem gave',
    );
    for (const role of roles) {
      assert.match(fs.readFileSync(path.join(dir, role), 'utf8'), /superseded stub/,
        'fixture: the stale bytes are genuinely still there');
    }
  } finally {
    try {
      for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o644);
    } catch { /* the fixture may not have got that far */ }
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 3. the class, not the six instances ──────────────────────────────────────

// Round 1 named the six writers it had just converted, which is a rule that can
// only forbid the past: a review added a SEVENTH (`zed-agents.ts`) carrying the
// original swallow and the rule passed 6/6. It was also spelling-bound — it
// matched the text `fs.mkdirSync(`, so a destructured `mkdirSync(dir)` or an
// aliased `nodeFs.mkdirSync(dir)` walked straight through it, which is the same
// defect the peer demonstrated against the OpenCode arm.
//
// Both are closed by inverting the rule: EVERY production file under
// `shared/materialize/**` is read from the DIRECTORY LISTING and must create no
// directory of its own, unless it is named in `DIR_CREATION_EXEMPT` with a
// reason. A new file is covered on the day it is added, and the two audited
// creators are the two rows below. Matching is by AST, on the CALLEE, with `fs`
// import aliases resolved, so a rename of the import does not change the answer.
const DIR_CREATION_EXEMPT: Record<string, string> = {
  // The owner. Its whole purpose is to make this one mkdir report its errno,
  // which `ensureDir`'s boolean cannot carry.
  'role-contracts.ts': 'the shared role-contract writer — this is the audited mkdir',
  // Fenced creation through shared/fsjson.ts `ensureDir`, whose false return is
  // checked and aborts the copy (generated.ts copySkillDir).
  'generated.ts': 'creates skill directories through the fenced ensureDir, and honours its refusal',
  // Copies a code-graph preview next to the project's own file; not a role
  // contract and not part of any host contract count.
  'graph-preview.ts': 'graph preview copy, unrelated to role contracts',
};

/** Local names that would create a directory if called, `fs` aliasing included. */
function directoryCreators(source: ts.SourceFile): Set<string> {
  const names = new Set(['ensureDir']);
  const namespaces = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = statement.moduleSpecifier.text;
    const isFs = from === 'fs' || from === 'node:fs' || from === 'fs/promises' || from === 'node:fs/promises';
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      if (isFs) namespaces.add(clause.namedBindings.name.text);
      continue;
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName || element.name).text;
        if ((isFs && (imported === 'mkdirSync' || imported === 'mkdir')) || imported === 'ensureDir') {
          names.add(element.name.text);
        }
      }
    }
  }
  for (const namespace of namespaces) names.add(`${namespace}.mkdirSync`);
  for (const namespace of namespaces) names.add(`${namespace}.mkdir`);
  return names;
}

/** Every line in `file` that creates a directory, by callee rather than by text. */
function directoryCreations(file: string): number[] {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const creators = directoryCreators(source);
  const hits: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // `mkdirSync(…)` (destructured or aliased) and `<anything>.mkdirSync(…)`:
      // the property name is checked without caring what object it hangs off, so
      // `fs.`, `nodeFs.` and `fs.promises.` are one case.
      const spelled = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? `${callee.expression.getText(source)}.${callee.name.text}`
          : '';
      const bare = ts.isPropertyAccessExpression(callee) ? callee.name.text : spelled;
      if (creators.has(spelled) || bare === 'mkdirSync' || (bare === 'mkdir' && spelled !== 'mkdir')) {
        hits.push(source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return hits;
}

test('no file under shared/materialize creates a directory outside the two audited creators', () => {
  const dir = path.resolve(__dirname, '..');
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
    .map((entry) => entry.name)
    .sort();

  // Fixture guards. Without the first, a broken readdir reads as a clean pass;
  // without the second, an AST walk that finds nothing anywhere does too.
  assert.ok(files.length >= 20, `fixture: expected the materialize directory, found ${files.length} files`);
  // COUNT, not line numbers: the walk has to be proven to find something, and a
  // line-number pin in the file most likely to be edited would fail for a reason
  // that has nothing to do with the property under test.
  const owned = directoryCreations(path.join(dir, 'role-contracts.ts'));
  assert.equal(owned.length, 2,
    `fixture: the walk must still find the two known mkdirs in the shared writer (found ${owned.join(', ') || 'none'})`);

  const offenders: string[] = [];
  for (const name of files) {
    const lines = directoryCreations(path.join(dir, name));
    if (lines.length > 0 && !(name in DIR_CREATION_EXEMPT)) offenders.push(`${name}:${lines.join(',')}`);
  }
  assert.deepEqual(offenders, [],
    `${offenders.length} file(s) under shared/materialize create a directory of their own:\n  `
    + `${offenders.join('\n  ')}\n`
    + 'A role-contract writer must call writeRoleContracts (role-contracts.ts), which reports the errno the '
    + 'filesystem refused with instead of swallowing it. Anything else that genuinely needs a directory adds a '
    + 'row to DIR_CREATION_EXEMPT with the reason its refusal is handled.');

  // And the exemptions stay honest: a row that no longer creates anything is a
  // hole waiting for the next writer to be dropped into.
  const stale = Object.keys(DIR_CREATION_EXEMPT)
    .filter((name) => !files.includes(name) || directoryCreations(path.join(dir, name)).length === 0);
  assert.deepEqual(stale, [], `stale DIR_CREATION_EXEMPT row(s): ${stale.join(', ')} — remove them`);
});

// The seventh-writer bypass, executed rather than argued: the peer's zed-agents.ts
// is planted in the real directory, with round 1's exact swallow, and the rule
// above must fail on it. Restored in `finally`, and the assertion is on the
// scanner's verdict rather than on a suite re-run, so nothing can leak.
test('a NEW host writer carrying the original swallow is caught the day it is added', () => {
  const dir = path.resolve(__dirname, '..');
  const planted = path.join(dir, 'zed-agents.ts');
  assert.equal(fs.existsSync(planted), false, 'fixture: the planted writer must not already exist');
  const swallow = [
    "import * as nodeFs from 'fs';",
    '',
    'export function writeZedAgentFiles(dir: string): number {',
    '  let written = 0;',
    '  try { nodeFs.mkdirSync(dir, { recursive: true }); } catch { return written; }',
    '  return written;',
    '}',
    '',
  ].join('\n');
  try {
    fs.writeFileSync(planted, swallow, 'utf8');
    // An ALIASED namespace import, which is exactly what walked through the
    // text-matching rule this replaced.
    assert.deepEqual(directoryCreations(planted), [5], 'the aliased mkdirSync must be found');
    assert.equal('zed-agents.ts' in DIR_CREATION_EXEMPT, false, 'and it is not exempt, so the rule fails on it');
  } finally {
    fs.rmSync(planted, { force: true });
  }
});

// ── 4. end to end: the run REPORTS it, and does not fold it into `written` ───
//
// The measurement this replaces, taken on the shipped code before the fix, with
// an 'installed' plugin root and host cursor: healthy run `written: 102` and six
// contracts on disk; the same run with `.cursor/agents` planted as a plain file
// `written: 96`, ZERO contracts, and status/systemMessage/`materializedAt`/
// `hasMaterializedProjectAssets` byte-identical to the healthy one — including
// `materializeProjectIfNeeded` returning null on the next hook, which is what
// makes the absence permanent rather than transient.

function installedPluginRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-contract-plugin-'));
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

const MATERIALIZED_STATE = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
  onboardingComplete: true,
  materializedStack: 'default|react-vite|supabase|none',
};

function withCursorProject(fn: (cwd: string) => void): void {
  const plugin = installedPluginRoot();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-role-contract-proj-'));
  const env = process.env;
  const previous = {
    plugin: env.TRAFFIC_ONE_PLUGIN_ROOT,
    prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH,
    state: env.TRAFFIC_ONE_STATE_PATH,
    host: env.TRAFFIC_ONE_HOST,
    plan: env.TRAFFIC_ONE_USER_PLAN,
  };
  env.TRAFFIC_ONE_PLUGIN_ROOT = plugin;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_HOST = 'cursor';
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  try {
    assertInstalledPluginRoot('role-contract shortfall');
    writeMaterializedContent(dir, { state: { ...MATERIALIZED_STATE } });
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ctx\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
    fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
      ...MATERIALIZED_STATE,
      mobile: { enabled: false, framework: 'none', source: 'prompted' },
      technologies: { frontend: ['react'], backend: ['supabase'], mobile: [] },
      projectContext: { source: 'prompted', originalPrompt: 'x', summary: 'x', answers: {}, collectedAt: '2026-01-01T00:00:00Z' },
      confirmed: true,
      confirmedAt: '2026-01-01T00:00:00Z',
      realtime: 'none',
      supabaseFunctionsAutoDeploy: 'ask',
    }), 'utf8');
    fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
      openCode: { enabled: false, source: 'prompted', decidedAt: '2026-01-01T00:00:00Z' },
      hosts: {
        cursor: {
          performance: { level: 'low', source: 'prompted', target: { plan: 'pro', appliedFingerprint: 'a'.repeat(64), configVersion: 0 } },
          team: { mode: 'main-agent', source: 'prompted' },
        },
      },
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
    })) {
      if (value === undefined) delete env[key]; else env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(plugin, { recursive: true, force: true });
  }
}

test('a materialization that could not write its role contracts says so, and counts none of them', () => {
  let healthyWritten = 0;
  withCursorProject((cwd) => {
    const outcome = materializeProjectFromState(cwd, { trigger: 'unit' });
    assert.equal(outcome.status, 'materialized', 'baseline: a healthy run materializes');
    assert.equal(outcome.result?.roleContracts, undefined, 'baseline: nothing to report');
    assert.equal(
      fs.readdirSync(path.join(cwd, CURSOR_AGENTS_REL)).filter((n) => n.endsWith('.md')).length >= 6,
      true,
      'baseline: the contracts are on disk',
    );
    healthyWritten = outcome.result?.written ?? 0;
    assert.ok(healthyWritten > 0);
  });

  withCursorProject((cwd) => {
    fs.mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.cursor', 'agents'), 'my own notes\n', 'utf8');

    const outcome = materializeProjectFromState(cwd, { trigger: 'unit' });
    const shortfall = outcome.result?.roleContracts;
    assert.ok(shortfall, 'the run must report that the role contracts are missing');
    assert.equal(shortfall?.host, 'cursor', 'and name the host whose contracts they are');
    assert.equal(shortfall?.kind, 'unwritable');
    assert.equal(shortfall?.failures[0]?.path, path.join(cwd, CURSOR_AGENTS_REL));

    // The two places a human or an agent actually reads.
    assert.match(outcome.systemMessage, /per-role contracts were NOT written/);
    assert.match(outcome.context, /host `cursor`'s per-role contracts were written/,
      'the context names the host whose contracts they are');
    assert.match(outcome.context, /\.cursor\/agents` \(EEXIST\)/,
      'the refused path AND the errno, which is what distinguishes the four causes');
    // The remedy is a HUMAN clearing the path, and the ruling that followed from
    // that: no retry is prescribed to the agent, because every repair for an
    // occupied path (`rm`, `mv`, `chmod`, `ln`) is itself a mutating call that the
    // deny below refuses. An earlier draft told the agent to re-run
    // `materialize-project`, which cannot work and is the false-remedy shape
    // deny-ids.ts records having had to fix once already.
    assert.match(outcome.context, /Clear the path/, 'and what a human has to do');
    assert.doesNotMatch(outcome.context, /materialize-project/,
      'and does NOT prescribe a retry the agent cannot perform');
    assert.match(outcome.context, /host-role-contracts-unwritable/,
      'and names the deny that will refuse file-changing work meanwhile');

    // …and the count that used to absorb them silently.
    assert.ok(
      (outcome.result?.written ?? 0) < healthyWritten,
      'the six unwritten contracts must not be counted as written',
    );
    assert.equal(
      fs.statSync(path.join(cwd, CURSOR_AGENTS_REL)).isDirectory(),
      false,
      'fixture: the planted file is still there, so there is genuinely no role directory',
    );
    assert.equal(contractCount(path.join(cwd, CURSOR_AGENTS_REL)), 0, 'and genuinely no contracts');
  });
});

// ── 5. the call site that had no channel at all ──────────────────────────────

test('the model-gate spawn sync stops pointing children at a file it could not write', () => {
  const healthy = tmp();
  try {
    assert.equal(cursorSpawnContractWarning(syncCursorSpawnAgentFiles(healthy, FULL_STATE)), '',
      'a healthy sync warns about nothing');
  } finally {
    fs.rmSync(healthy, { recursive: true, force: true });
  }

  const blocked = tmp();
  try {
    fs.mkdirSync(path.join(blocked, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(blocked, '.cursor', 'agents'), 'notes\n', 'utf8');
    const warning = cursorSpawnContractWarning(syncCursorSpawnAgentFiles(blocked, FULL_STATE));
    assert.match(warning, /could not be written/);
    assert.match(warning, /do NOT tell a child to read/,
      'the spawn map instructs the orchestrator to point children at this file; it must be told not to');
    assert.match(warning, /t1-role/, 'and told what still binds the role instead');
  } finally {
    fs.rmSync(blocked, { recursive: true, force: true });
  }
});
