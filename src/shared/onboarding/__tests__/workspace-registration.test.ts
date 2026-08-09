// Workspace onboarding: a member is registered by a PERSON running setup on it,
// and it inherits the container's shared answers instead of re-asking them.
//
// The load-bearing assertion in this file is not that a preference file appears
// somewhere. It is that `buildRunModelPolicy` FREEZES for a member — the
// production freeze whose `resolvedRunPolicyInputs` refuses without the
// member's OWN `performance.level`, and therefore the thing that decides
// whether a member can ever run at all. Every other assertion here is scaffolding
// around that one.
//
// FIXTURES LIVE IN os.tmpdir(), NOT under the repo's scratch dir, and that is
// forced rather than preferred: these tests mint `.traffic-one/.one.json` into
// their fixtures, and doing that anywhere inside this plugin authoring
// repository is what AGENTS.md forbids and the hooks enforce.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeOnboarding, applyAnswer } from '../../onboarding-server/flow';
import { buildRunModelPolicy } from '../../run-model-policy';
import { readEffectiveState, writeState } from '../../state';
import { readWorkspaceMemberRegistry } from '../../hook/workspace-members';
import {
  pluginUseDeclined,
  pluginUseEnabled,
  recordPluginUseChoice,
  resetPluginUseCache,
} from '../../state/plugin-use';
import { registerWorkspaceMember, writeWorkspaceMemberRegistry } from '../../state/workspace-members';
import { applyAgentTechClassification } from '../detection-stamp';
import { resolveWorkspaceMemberTarget } from '../workspace-member-target';
import { inheritWorkspacePrefsToMembers } from '../workspace-inherit';

const fixtures: string[] = [];

test.after(() => {
  for (const dir of fixtures) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

interface Fixture {
  readonly container: string;
  readonly env: NodeJS.ProcessEnv;
  member(rel: string): string;
}

function workspace(label: string): Fixture {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), `t1-ws-${label}-`));
  fixtures.push(created);
  const root = fs.realpathSync(created);
  const stateHome = path.join(root, 'state-home');
  fs.mkdirSync(stateHome, { recursive: true });
  const container = path.join(root, 'monorepo');
  fs.mkdirSync(container, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_STATE_HOME: stateHome,
    TRAFFIC_ONE_HOST: 'codex',
    TRAFFIC_ONE_AUTH: '0',
    TRAFFIC_ONE_ASK_USE_PLUGIN: '0',
  };
  delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  return {
    container,
    env,
    // A member with its own manifest: the shape the write fence admits. The
    // manifest-less shape is measured separately below.
    member(rel: string): string {
      const dir = path.join(container, ...rel.split('/'));
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        `${JSON.stringify({ name: rel.replace(/\//g, '-'), dependencies: { react: '18.0.0' } }, null, 2)}\n`,
      );
      fs.writeFileSync(path.join(dir, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
      return dir;
    },
  };
}

/** Answer every shared step ONCE, at the container, exactly as the wizard does. */
function answerSharedStepsAtContainer(container: string, env: NodeJS.ProcessEnv): void {
  for (const [step, value] of [
    ['open-code', false],
    ['performance', 'balanced'],
    ['team-confirmation', 'approve'],
    ['code-graph', 'gitnexus'],
  ] as const) {
    const outcome = applyAnswer(container, step, value, env);
    assert.equal(outcome.ok, true, `fixture guard: the container accepted the ${step} answer`);
  }
}

// A DISTINCT run id per call, always: the policy is FROZEN per run, so re-using
// one would answer the second question with the first answer and a re-pick test
// would pass without the re-pick reaching anything.
let runSeq = 0;
// One member, finished. The boolean is CHECKED by every caller: a fixture whose
// state write was silently refused would make "the container is not done" pass
// for the wrong reason.
function finishMember(dir: string): boolean {
  return writeState(dir, { mode: 'existing-codebase', onboardingComplete: true, stack: 'react-node' });
}

function policyFrozen(dir: string, env: NodeJS.ProcessEnv): string | null {
  runSeq += 1;
  const policy = buildRunModelPolicy(dir, `run-ws-test-${runSeq}`, 'codex', readEffectiveState(dir, env), env);
  return policy ? policy.performanceLevel : null;
}

// ── The load-bearing half ────────────────────────────────────────────────────

test('a member registered BEFORE the container is answered still freezes a run policy', () => {
  const ws = workspace('before');
  const api = ws.member('api');
  ws.member('web');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['api', 'web']).outcome, 'written');

  // The failure this prevents, reproduced first: with the container unanswered,
  // there is nothing to inherit and the member cannot freeze.
  assert.equal(policyFrozen(api, ws.env), null,
    'baseline: an unanswered workspace freezes no run policy for its member');

  answerSharedStepsAtContainer(ws.container, ws.env);

  assert.equal(policyFrozen(api, ws.env), 'balanced',
    'a member freezes a run policy from the container\'s performance answer');
  const state = readEffectiveState(api, ws.env) as Record<string, unknown>;
  assert.equal((state.performance as { level?: string }).level, 'balanced',
    'performance reached the member through the production effective-state read');
  assert.equal((state.team as { approved?: boolean }).approved, true, 'team reached the member');
  assert.equal((state.openCode as { enabled?: boolean }).enabled, false, 'openCode reached the member');
  // Not inherited and not needing to be: the code-graph provider is MACHINE-wide.
  assert.equal(state.codeGraphProvider, 'gitnexus',
    'the code-graph answer is already visible at the member with nothing copied');
});

test('a member registered AFTER the container is answered is seeded on registration', () => {
  const ws = workspace('after');
  const api = ws.member('api');
  answerSharedStepsAtContainer(ws.container, ws.env);
  assert.equal(policyFrozen(api, ws.env), null,
    'baseline: a directory nobody has registered inherits nothing');

  const target = resolveWorkspaceMemberTarget(ws.container, 'api', ws.env);
  assert.equal(target.kind, 'member');
  assert.equal(target.kind === 'member' && target.registered, true, 'this call is what registered it');
  assert.equal(target.kind === 'member' && target.memberRoot, api);
  assert.equal(target.kind === 'member' && target.inheritance.outcome, 'inherited');

  assert.equal(policyFrozen(api, ws.env), 'balanced',
    'the seeding half covers the order the fan-out cannot: member joins last');
});

test('a re-pick at the container reaches every member', () => {
  const ws = workspace('repick');
  const api = ws.member('api');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['api']).outcome, 'written');
  answerSharedStepsAtContainer(ws.container, ws.env);
  assert.equal(policyFrozen(api, ws.env), 'balanced');

  assert.equal(applyAnswer(ws.container, 'performance', 'high', ws.env).ok, true);
  assert.equal(policyFrozen(api, ws.env), 'high',
    'the container is the single source of truth for a shared answer, including on a re-pick');
});

test('consent is SEEDED into a member, and a member\'s own "no" is never overwritten by the container\'s yes', () => {
  const ws = workspace('consent');
  const api = ws.member('api');
  const opted = ws.member('opted-out-locally');
  assert.equal(recordPluginUseChoice(ws.container, true, 'test', ws.env), true);
  // This member's own answer predates the container's, and it is a REFUSAL.
  assert.equal(recordPluginUseChoice(opted, false, 'test', ws.env), true);
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['api', 'opted-out-locally']).outcome, 'written');

  assert.equal(resolveWorkspaceMemberTarget(ws.container, 'api', ws.env).kind, 'member');
  resetPluginUseCache();
  assert.equal(pluginUseEnabled(api, ws.env), true,
    'a member takes the container\'s consent, so nobody is asked to consent twice to one workspace');

  inheritWorkspacePrefsToMembers(ws.container, ws.env);
  resetPluginUseCache();
  assert.equal(pluginUseDeclined(opted, ws.env), true,
    'the enclosing yes does not overrule the narrower no');
});

// ── Registration is a person naming a member, never an enumeration ───────────

test('registration refuses a selector that is not a registered member or a real directory', () => {
  const ws = workspace('refuse');
  ws.member('api');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['api']).outcome, 'written');

  const missing = resolveWorkspaceMemberTarget(ws.container, 'nope', ws.env);
  assert.equal(missing.kind, 'refused');
  assert.match(missing.kind === 'refused' ? missing.why : '', /neither a registered member/);
  assert.deepEqual(readWorkspaceMemberRegistry(ws.container).kind === 'members'
    ? (readWorkspaceMemberRegistry(ws.container) as { members: readonly string[] }).members
    : [], ['api'], 'a refused selector registered nothing');
});

test('registration preserves the ids and opt-outs of members already in the registry', () => {
  const ws = workspace('preserve');
  ws.member('api');
  ws.member('web');
  ws.member('legacy');
  const seeded = writeWorkspaceMemberRegistry(ws.container, [
    'api',
    { dir: 'web', id: 'web-pinned' },
    { dir: 'legacy', optOut: true },
  ]);
  assert.equal(seeded.outcome, 'written');

  const registration = registerWorkspaceMember(ws.container, 'api');
  assert.equal(registration.outcome, 'already', 'an existing member is not re-registered');

  ws.member('docs');
  assert.equal(registerWorkspaceMember(ws.container, 'docs').outcome, 'registered');

  const after = readWorkspaceMemberRegistry(ws.container);
  assert.equal(after.kind, 'members');
  const identities = after.kind === 'members' ? after.identities : [];
  assert.equal(identities.find((e) => e.path === 'web')?.id, 'web-pinned',
    'a recorded id survives another member registering — a re-derive would orphan its run records');
  assert.equal(identities.find((e) => e.path === 'legacy')?.optOut, true,
    'an opted-out entry survives, opted out');
  assert.equal(after.kind === 'members' && after.members.includes('legacy'), false,
    'and stays out of the managed list');
});

// ── Product ruling: a committed member opt-out is FINAL ──────────────────────

test('running setup on an opted-out member refuses instead of re-enabling it', () => {
  const ws = workspace('optout');
  const excluded = ws.member('excluded');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, [{ dir: 'excluded', optOut: true }]).outcome, 'written');
  answerSharedStepsAtContainer(ws.container, ws.env);

  const direct = registerWorkspaceMember(ws.container, 'excluded');
  assert.equal(direct.outcome, 'opted-out');

  const target = resolveWorkspaceMemberTarget(ws.container, 'excluded', ws.env);
  assert.equal(target.kind, 'refused', 'the --project= path refuses it too, not only the writer');
  assert.match(target.kind === 'refused' ? target.why : '', /opted out/);

  const after = readWorkspaceMemberRegistry(ws.container);
  assert.equal(after.kind === 'members' && after.identities.every((e) => e.optOut), true,
    'the committed exclusion is unchanged');
  assert.equal(policyFrozen(excluded, ws.env), null,
    'and nothing was seeded into the directory the repository excluded');
});

test('the container fan-out writes nothing into an opted-out member', () => {
  const ws = workspace('fanout-optout');
  const kept = ws.member('kept');
  const excluded = ws.member('excluded');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['kept', { dir: 'excluded', optOut: true }]).outcome, 'written');
  answerSharedStepsAtContainer(ws.container, ws.env);

  const fanOut = inheritWorkspacePrefsToMembers(ws.container, ws.env);
  assert.deepEqual(fanOut.results.map((r) => r.member), [kept],
    'the fan-out addresses the managed members and nobody else');
  assert.equal(policyFrozen(excluded, ws.env), null);
});

// ── A container is not an upgrade of a project ───────────────────────────────

test('a directory already onboarded as a project is refused as a workspace container', () => {
  const ws = workspace('already-project');
  ws.member('api');
  writeState(ws.container, { mode: 'existing-codebase', onboardingComplete: true });

  const written = writeWorkspaceMemberRegistry(ws.container, ['api']);
  assert.equal(written.outcome, 'rejected');
  assert.match(written.outcome === 'rejected' ? written.why : '', /already onboarded as a existing-codebase/);

  const state = readEffectiveState(ws.container, ws.env) as Record<string, unknown>;
  assert.equal(state.mode, 'existing-codebase', 'the project kept its identity');
  assert.equal(readWorkspaceMemberRegistry(ws.container).kind, 'none', 'and registered nobody');
});

// ── A registered member is a project in its own right ────────────────────────

test('registration is what lets an npm workspace sub-package be classified at all', () => {
  const ws = workspace('sub-package');
  fs.writeFileSync(
    path.join(ws.container, 'package.json'),
    `${JSON.stringify({ name: 'monorepo', private: true, workspaces: ['packages/*'] }, null, 2)}\n`,
  );
  const api = ws.member('packages/api');
  // Past detectMode's ≤5-file "this is a new project" rule, so the classifier
  // reaches the ownership guards instead of stopping at `not-existing-mode`.
  for (let i = 0; i < 8; i += 1) {
    fs.writeFileSync(path.join(api, 'src', `mod-${i}.ts`), `export const v${i} = ${i};\n`);
  }
  answerSharedStepsAtContainer(ws.container, ws.env);

  // The heuristic is RIGHT about what it measured — `packages/api` matches the
  // container's own workspaces glob — and its conclusion is what registration
  // overturns.
  const before = applyAgentTechClassification(api, { frontend: 'none', backend: 'node' });
  assert.equal(before.ok, false);
  assert.equal(before.ok === false ? before.reason : '', 'workspace-sub-package');

  const target = resolveWorkspaceMemberTarget(ws.container, 'packages/api', ws.env);
  assert.equal(target.kind, 'member');
  assert.equal(target.kind === 'member' && target.id, 'api', 'the id derives from the last segment');

  const after = applyAgentTechClassification(api, { frontend: 'none', backend: 'node' });
  assert.equal(after.ok, true,
    `a RECORDED membership outranks a guess made from a glob (got ${after.ok === false ? after.reason : ''})`);
});

// ── The wizard branch ────────────────────────────────────────────────────────

test('an empty container asks the shared steps, then REFUSES rather than offering a chooser', () => {
  const ws = workspace('empty');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, []).outcome, 'written');

  // The shared steps come FIRST, so a person who registers their first member
  // finds these already answered rather than meeting them one directory later.
  assert.equal(computeOnboarding(ws.container, ws.env).step, 'open-code');
  answerSharedStepsAtContainer(ws.container, ws.env);

  const view = computeOnboarding(ws.container, ws.env);
  assert.equal(view.done, false, 'a container that manages nobody is never complete');
  assert.equal(view.step, null, 'and no question can make it complete — registering a member is a person\'s act');
  assert.equal(view.meta.kind, 'waiting');
  assert.equal(view.meta.workspace?.reason, 'empty-registry');
  assert.deepEqual(view.meta.workspace?.members, [], 'the refusal enumerates nothing it could register');
  assert.match(String(view.meta.question), /run setup in that directory|inside the member/i);
});

test('a container whose every member opted out is the SAME refusal, not a done project', () => {
  const ws = workspace('all-opted-out');
  ws.member('api');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, [{ dir: 'api', optOut: true }]).outcome, 'written');
  answerSharedStepsAtContainer(ws.container, ws.env);

  const view = computeOnboarding(ws.container, ws.env);
  assert.equal(view.done, false, 'vacuous truth is not completion');
  assert.equal(view.meta.workspace?.reason, 'empty-registry');
});

test('a container is done only when every member is done', () => {
  const ws = workspace('done-when-all');
  const api = ws.member('api');
  const web = ws.member('web');
  assert.equal(writeWorkspaceMemberRegistry(ws.container, ['api', 'web']).outcome, 'written');
  answerSharedStepsAtContainer(ws.container, ws.env);
  assert.equal(computeOnboarding(ws.container, ws.env).done, false);

  assert.equal(finishMember(api), true, 'fixture guard: api\'s state write landed');
  assert.equal(computeOnboarding(ws.container, ws.env).done, false, 'one member done is not every member done');

  assert.equal(finishMember(web), true, 'fixture guard: web\'s state write landed');
  assert.equal(computeOnboarding(ws.container, ws.env).done, true);
});
