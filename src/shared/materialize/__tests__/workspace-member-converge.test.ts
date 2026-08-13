// The convergence guard's refusal of a workspace sub-package that holds no
// state of its own.
//
// THE PROPERTY THESE TESTS PIN, stated once so the assertions below are read as
// instances of it rather than as a list: A WORKSPACE SUB-PACKAGE WITH NO STATE
// OF ITS OWN IS LEFT ALONE, WHETHER THE WORKSPACE MERELY GLOBBED IT OR ACTUALLY
// REGISTERED IT — AND A DIRECTORY THAT HOLDS STATE IS NOT. That is a property
// of the composed decision, and it is deliberately NOT a pin on what
// `isUnclaimedWorkspaceSubPackage` itself answers: that predicate says `true`
// about a registered member, which is a gap somebody may close, and a test
// asserting today's raw answer would go red when they do. Phrased as the
// composition, the assertions hold before and after such a fix.
//
// AND A BEHAVIOURAL PIN, which the previous version of this file said could not
// exist. It said converge "returns null for every one of the four cells anyway,
// so a behavioural assertion would pass in both worlds and prove nothing". The
// return value is null in both worlds; the DISK is not, and `convergeEffects`
// below reads three rows of it.
//
// `architectureSurvives` and `planMinted` are the rows that found the defect:
// `materializeProjectIfNeeded` called `migrateArchitectureDocsToPlan` a few
// lines past the refusal, and that helper deleted a hand-written
// `architecture.md` and minted `.traffic-one/plan.md` in its place.
// `migrateArchitectureDocsToPlan` now gates itself on readable state, so those
// two rows have a SECOND defender and no longer die on their own when this
// refusal is removed.
//
// AND THE ROW THAT MEASURES THIS GUARD IS THE RETURN, not the disk. The previous
// version of this file claimed `stateMinted` was that row — that past the refusal
// converge would `writeState` a stray shallow `<member>/.traffic-one/.one.json`.
// MEASURED with the refusal mutated off, it does not: `readEffectiveState`
// answers `{}` for a stateless directory, `normalizeState` finds nothing to
// canonicalize, and the unknown-stack branch returns null before any writer, so
// all three disk rows were byte-identical with the refusal deleted. It was
// unmeasured, and a pin that cannot see a guard's removal is not a pin on that
// guard.
//
// The shape that DOES move is the one directory with state and no state FILE: a
// member carrying the pre-`.one.json` legacy lock naming `new-project`. See the
// last test in this file — it is the only assertion here that dies when the
// refusal goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { isStatelessWorkspaceSubPackage, materializeProjectIfNeeded } from '../converge';
import { resetAuthoringRootCache } from '../../authoring-root';
import { resetPluginUseCache } from '../../state/plugin-use';
import { WORKSPACE_PROJECT_MODE } from '../../hook/workspace-members';

// The write fence refuses every `.traffic-one/**` write while the use-plugin
// question is pending. It is not what these tests are about, and leaving it up
// would mask the state-file cases behind a refusal that is not the guard.
process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '0';

const TMP_PREFIX = 't1-member-converge-';

function withContainer(body: (container: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  resetAuthoringRootCache();
  resetPluginUseCache();
  try {
    body(fs.realpathSync(created));
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
    resetAuthoringRootCache();
    resetPluginUseCache();
  }
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

/**
 * A container that is BOTH a package-manager workspace root and a Traffic One
 * workspace registering `members`. The declaration is what makes
 * `isUnclaimedWorkspaceSubPackage` answer `true` about the sub-directories at
 * all; the registry is what the second arm reads.
 */
function container(dir: string, members: readonly string[]): void {
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
  registry(dir, members);
}

/** The registry half alone: a container that declares NO package-manager workspaces. */
function registry(dir: string, members: readonly string[]): void {
  write(path.join(dir, '.traffic-one', '.one.json'), `${JSON.stringify({
    mode: WORKSPACE_PROJECT_MODE,
    onboardingComplete: true,
    workspaceMembers: members.map((member) => ({ path: member })),
  }, null, 2)}\n`);
}

/** A sub-directory with a manifest of its own and NO Traffic One state. */
function subPackage(dir: string, rel: string): string {
  const sub = path.join(dir, ...rel.split('/'));
  write(path.join(sub, 'package.json'), `${JSON.stringify({ name: path.basename(sub) }, null, 2)}\n`);
  return sub;
}

/** What converge did to a directory, beyond what it returned. */
function convergeEffects(dir: string): Record<string, unknown> {
  write(path.join(dir, 'architecture.md'), '# Design\n\nHand written by the team.\n');
  const outcome = materializeProjectIfNeeded(dir, { trigger: 'test' });
  return {
    returned: outcome === null ? 'null' : `outcome:${(outcome as { status: string }).status}`,
    architectureSurvives: fs.existsSync(path.join(dir, 'architecture.md')),
    planMinted: fs.existsSync(path.join(dir, '.traffic-one', 'plan.md')),
    stateMinted: fs.existsSync(path.join(dir, '.traffic-one', '.one.json')),
  };
}

test('converge: a registered workspace member with no state is refused, exactly like a stranger', () => {
  withContainer((dir) => {
    container(dir, ['packages/web']);
    const member = subPackage(dir, 'packages/web');
    const stranger = subPackage(dir, 'packages/ui');

    assert.equal(isStatelessWorkspaceSubPackage(member), true,
      'the registry records this directory as a member, and a member with no state has nothing to converge');
    assert.equal(isStatelessWorkspaceSubPackage(stranger), true,
      'and a sibling nobody registered is refused for the incumbent reason');
  });
});

test('converge: the refusal is keyed on holding NO STATE — a member that owns state still converges', () => {
  // This is what keeps the second arm a refusal of nothing anybody wanted. A
  // member that has committed state is a project; both arms decline, and
  // convergence proceeds for it exactly as it does today.
  withContainer((dir) => {
    container(dir, ['packages/web']);
    const member = subPackage(dir, 'packages/web');
    write(path.join(member, '.traffic-one', '.one.json'), `${JSON.stringify({
      mode: 'existing-codebase', stack: 'minimal', onboardingComplete: true,
    }, null, 2)}\n`);

    assert.equal(isStatelessWorkspaceSubPackage(member), false,
      'a directory with a state file is never refused by either arm');
  });
});

test('converge: the exemption is EXACT — a directory inside a member is not a member', () => {
  withContainer((dir) => {
    container(dir, ['packages/web']);
    subPackage(dir, 'packages/web');
    const inside = subPackage(dir, 'packages/web/tools');

    assert.equal(isStatelessWorkspaceSubPackage(inside), true,
      '`<member>/tools` must keep resolving to the member, so it stays refused');
  });
});

test('converge: an ILLEGIBLE registry leaves the incumbent rule in charge', () => {
  // `isRegisteredWorkspaceMember` folds `indeterminate` to false, so a registry
  // nobody can read grants nothing — which now means it withdraws no refusal
  // either. The incumbent glob rule still decides.
  withContainer((dir) => {
    write(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }, null, 2)}\n`);
    write(path.join(dir, '.traffic-one', '.one.json'), '{ mode: broken\n');
    const sub = subPackage(dir, 'packages/web');

    assert.equal(isStatelessWorkspaceSubPackage(sub), true);
  });
});

test('converge: outside a workspace of either kind the guard decides nothing', () => {
  withContainer((dir) => {
    const solo = subPackage(dir, 'packages/web');
    assert.equal(isStatelessWorkspaceSubPackage(solo), false,
      'no ancestor declares workspaces and no registry names it, so nothing was ever refused');
  });
});

// ── the behavioural pin ──────────────────────────────────────────────────────

test('converge: a registered member keeps its architecture.md, byte for byte with a stranger', () => {
  // The measurement that refuted "this exemption changes no outcome today". The
  // container DECLARES package-manager workspaces, so the incumbent arm is what
  // decides — and the exemption spelling switched that arm off for the member
  // alone, letting execution reach `migrateArchitectureDocsToPlan`. Registered
  // and unregistered must now be indistinguishable on disk.
  withContainer((dir) => {
    container(dir, ['packages/web']);
    const registered = convergeEffects(subPackage(dir, 'packages/web'));
    const stranger = convergeEffects(subPackage(dir, 'packages/ui'));

    assert.deepEqual(registered, {
      returned: 'null', architectureSurvives: true, planMinted: false, stateMinted: false,
    }, 'the exempt directory is LEFT ALONE — an exemption whose effect is that more code runs is not an exemption');
    assert.deepEqual(registered, stranger, 'and the two columns agree on every row, not only on the return value');
  });
});

test('converge: a stateless member carrying the LEGACY LOCK is still refused, and that is what this guard holds', () => {
  // `.claude-plugin-mode` is the pre-`.one.json` spelling of "Traffic One was
  // here". `readEffectiveState` honours it and `hasStateFile` does not, so this is
  // the one directory where "has state" and "has a state file" disagree — and
  // with `new-project` in it the mode branch below the refusal is satisfied, so
  // `materializeProjectFromState` runs against a directory that is not a project
  // and returns `incomplete` about its missing fields. That return is not
  // cosmetic: onboarding-gate/handler.ts turns any non-null outcome on a mutating
  // PreToolUse into a deny, and a non-converged one into
  // `materialization-not-converged`, which repeats byte-identically for as long
  // as the file is there. Measured, refusal on vs off: null vs
  // `outcome:incomplete`, with all three disk rows unchanged either way.
  withContainer((dir) => {
    container(dir, ['packages/web']);
    const member = subPackage(dir, 'packages/web');
    fs.writeFileSync(path.join(member, '.claude-plugin-mode'), 'new-project\n', 'utf8');

    assert.equal(isStatelessWorkspaceSubPackage(member), true,
      'a legacy lock file is not state of its own, so the member still belongs to its container');
    assert.deepEqual(convergeEffects(member), {
      returned: 'null', architectureSurvives: true, planMinted: false, stateMinted: false,
    }, 'and converge declines to report anything about it, which is what stops the gate denying its writes');
  });
});

test('converge: a registered member of a container that declares NO globs keeps it too', () => {
  // The shape the incumbent arm never covered: a Go or Maven container
  // registers members without any package-manager declaration, so
  // `isUnclaimedWorkspaceSubPackage` answers false and the stateless member
  // walked all the way down to the deletion with no exemption involved at all.
  // The registry arm is the only thing standing between this member and its
  // file.
  withContainer((dir) => {
    registry(dir, ['services/api']);
    const member = path.join(dir, 'services', 'api');
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, 'go.mod'), 'module api\n', 'utf8');

    assert.equal(isStatelessWorkspaceSubPackage(member), true);
    assert.deepEqual(convergeEffects(member), {
      returned: 'null', architectureSurvives: true, planMinted: false, stateMinted: false,
    });
  });
});
