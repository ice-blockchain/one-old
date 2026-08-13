// THE DIRECTIVES THAT HAND THE ORCHESTRATOR A PATH: they must not name a
// contract file that is not there.
//
// Four sites tell a child to read its role contract, and until now all four did
// so unconditionally while only ONE host on ONE runner
// (`cursorSpawnContractWarning`, shared/materialize/cursor-spawn-map.ts) checked
// first. On Kilo and Windsurf — the two hosts whose spawn goes through a BUILT-IN
// generic worker, so the contract file is the only thing that carries the role —
// a refused `.kilo/agents` or `.devin/agents` therefore produced an instruction
// to open a file that does not exist. The child then either fails a read or, on
// hosts that swallow it, proceeds with no contract at all.
//
// Both directives now check, and both say the same thing when the file is
// absent: state the role inline, the `[t1-role: …]` marker is what binds it, and
// report the path to the user. The other two sites are ruled on rather than
// changed, with the reason recorded at each — spawn-shape.ts's `kiloGeneralAgentDeny`
// (its reason string is part of a deny-repeat signature, which must not move with
// disk state) and shared/windsurf-rules.ts (a pure renderer whose output is
// byte-pinned by the golden manifest). The rows below pin that ruling too, so
// dropping either reason means editing this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildOrchestrationDirective } from '../build-orchestration-directive';
import { preSpawnArchitectDirective } from '../../../runners/onboarding-wait/pre-spawn-directives';
import { hostSpawnType } from '../../../shared/host/spawn-types';

const SUBAGENTS_STATE: Record<string, unknown> = {
  mode: 'new-project',
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { enabled: false, framework: 'none', source: 'prompted' },
  onboardingComplete: true,
  team: { mode: 'subagents', source: 'prompted', approved: true },
  performance: { level: 'high', source: 'prompted' },
};

function withProject(fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-spawn-contract-')));
  const env = process.env;
  const previous = { state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH };
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  // `preSpawnArchitectDirective` reads the project's own state rather than
  // taking one, and returns '' for anything that is not a new-project build.
  // (`dir` is an os.tmpdir() scratch project; this repo is never touched.)
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(SUBAGENTS_STATE), 'utf8');
  try {
    fn(dir);
  } finally {
    if (previous.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = previous.state;
    if (previous.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previous.prefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Materialize just the one contract the directive names, and nothing else. */
function placeContract(cwd: string, host: 'kilo' | 'windsurf'): string {
  const rel = hostSpawnType(host, 'senior-architect', cwd).contractPath;
  assert.ok(rel, `${host}: the spawn table must declare a contract path`);
  const file = path.join(cwd, String(rel));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '# senior-architect\ncontract\n', 'utf8');
  return file;
}

test('the Kilo build directive names the contract only while the contract exists', () => {
  withProject((cwd) => {
    const contract = placeContract(cwd, 'kilo');
    const present = buildOrchestrationDirective(cwd, 'kilo', { ...SUBAGENTS_STATE });
    assert.ok(present, 'fixture: the directive must be emitted at all for a pre-plan subagents build');
    assert.match(present, /tell the child to read `\.kilo\/agents\/senior-architect\.md`/,
      'with the contract on disk, the instruction stands');

    fs.rmSync(contract, { force: true });
    const absent = buildOrchestrationDirective(cwd, 'kilo', { ...SUBAGENTS_STATE });
    assert.match(absent, /Do NOT tell the child to read `\.kilo\/agents\/senior-architect\.md`/,
      'with it absent, the instruction is withdrawn by name');
    assert.match(absent, /State the role's task and scope inline/, 'and replaced with what does work');
    assert.match(absent, /\[t1-role: …\] marker is what binds the role|`\[t1-role: …\]` marker is what binds the role/,
      'naming the marker, which is the mechanism that survives a missing contract');
    assert.match(absent, /Report to the user/, 'and the fact reaches the user');
    assert.ok(!/Immediately after the role marker, tell the child to read/.test(absent),
      'the two clauses must not both appear — an orchestrator told both does the wrong one');
  });
});

test('the Windsurf architect directive names the contracts only while they exist', () => {
  withProject((cwd) => {
    const contract = placeContract(cwd, 'windsurf');
    const present = preSpawnArchitectDirective(cwd, 'windsurf');
    assert.ok(present, 'fixture: the directive must be emitted at all on a new-project Windsurf build');
    assert.match(present, /tell the child to read `\.devin\/agents\/senior-architect\/AGENT\.md`/);
    assert.match(present, /an instruction to read the matching `\.devin\/agents\/<role>\/AGENT\.md` contract/,
      'both clauses, the architect one and the implementer one');

    fs.rmSync(path.dirname(contract), { recursive: true, force: true });
    const absent = preSpawnArchitectDirective(cwd, 'windsurf');
    assert.match(absent, /Do NOT tell the child to read/, 'the architect clause is withdrawn');
    assert.match(absent, /state the task and scope inline/i);
    assert.match(absent, /task and scope stated INLINE/, 'and so is the implementer clause');
    assert.ok(!/and an instruction to read the matching/.test(absent),
      'the implementer clause must not survive alongside its own withdrawal');
    assert.match(absent, /report the unwritable `\.devin\/agents` to the user/i);
  });
});

// The two sites ruled on rather than changed. Pinned so the ruling cannot be
// silently reversed in either direction: removing the reason from the code means
// this row fails, and so does quietly conditioning them after all.
test('the two unconditional contract references each carry their recorded reason', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const rows: { file: string; must: RegExp[] }[] = [
    {
      file: path.join(root, 'modules', 'agent-model', 'spawn-shape.ts'),
      must: [/deny-repeat/, /part of the deny-repeat signature|deny-repeat signature/, /hostSpawnType\('kilo', role\)\.contractPath/],
    },
    {
      file: path.join(root, 'shared', 'windsurf-rules.ts'),
      must: [/DISCLOSED residual/, /golden manifest/, /roleContractBanner/],
    },
  ];
  for (const { file, must } of rows) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of must) {
      assert.match(source, pattern, `${path.basename(file)} must keep its recorded reason: ${pattern}`);
    }
  }
});
