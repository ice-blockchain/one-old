// workspace-member-state: each member of a workspace keeps its OWN onboarding
// state and its OWN preferences bucket — the two halves that make N members N
// projects rather than one project written N times.
//
// THIS ROW IS THE PREFS-PATH COLLAPSE, MEASURED. `buildCaseEnv` pins
// `TRAFFIC_ONE_PROJECT_PREFS_PATH` to one file per CASE, and `projectPrefsPath`
// returns that path for every cwd it is asked about — identical to production
// while a case held ONE project, and a different world the moment it holds
// three. In production each root gets `<machine dir>/projects/<sha256(realpath
// (root))>/preferences.json`, so the consent answer, the host performance/team
// block and the toolchain stamps of three members are three files. Under one
// shared file the last member seeded overwrites the other two and every earlier
// member reads back the last one's answers.
//
// So the case gives its three members three DIFFERENT performance levels, and
// this row reads each member's back through the real effective-state merge. That
// turns the collapse from a divergence someone has to remember into a red row:
// with one shared bucket all three read `high` (or whichever member seeded last)
// and this assertion names it. The fix is in core/env.ts memberCaseEnv, and the
// derivation is checked here too — reproducing the COUNT of buckets without
// reproducing how production NAMES them would leave any reader that resolves a
// bucket from a root disagreeing with the harness while both looked right.

import * as fs from 'fs';

import { readEffectiveState } from '../../shared/state/local-prefs';
import { isWorkspaceFixture } from '../core/fixtures';
import type { Assertion, AssertionContext, PreSeed } from '../core/types';
import { rec, result, str } from './util';
import { prefsPathOf, productionPrefsPathOf, workspaceFixtureStop } from './workspace';

function declaredPreSeed(ctx: AssertionContext, memberId: string): PreSeed {
  const fixture = ctx.testCase.fixture;
  if (!isWorkspaceFixture(fixture)) return ctx.testCase.preSeed;
  return fixture.members.find((m) => m.id === memberId)?.preSeed ?? ctx.testCase.preSeed;
}

export const assertion: Assertion = {
  id: 'workspace-member-state',
  title: 'Every workspace member keeps its own onboarding state and its own preferences bucket',
  appliesTo: (c) => c.category === 'workspace',
  run: (ctx: AssertionContext) => {
    const stop = workspaceFixtureStop(ctx);
    if (stop) return stop;

    const problems: string[] = [];
    const observed: Record<string, unknown> = {};

    // The count, before anything else: N members sharing one bucket is the
    // collapse itself, and stating it as its own problem means the failure names
    // the cause rather than only its three symptoms.
    const buckets = new Set(ctx.members.map((m) => prefsPathOf(m)));
    if (buckets.size !== ctx.members.length) {
      problems.push(
        `${ctx.members.length} members share only ${buckets.size} preferences bucket(s) (${[...buckets].join(', ')}) `
        + '— every member reads and writes the same file, so the last one seeded silently owns all of their answers',
      );
    }

    for (const member of ctx.members) {
      const bucket = prefsPathOf(member);
      const production = productionPrefsPathOf(member);
      if (bucket !== production) {
        problems.push(
          `${member.id}: its preferences bucket is ${bucket}, but production would name ${production} for this root`,
        );
      }
      if (!fs.existsSync(bucket)) {
        problems.push(`${member.id}: nothing was ever written to its preferences bucket ${bucket}`);
      }

      const declared = declaredPreSeed(ctx, member.id);
      const state = readEffectiveState(member.cwd, member.env);
      const mode = str(state.mode);
      const level = str(rec(state.performance).level);
      observed[member.id] = { mode, performance: level, prefs: bucket };

      if (mode !== declared.mode) {
        problems.push(`${member.id}: state mode is ${JSON.stringify(mode)}, declared ${JSON.stringify(declared.mode)}`);
      }
      if (declared.performance && level !== declared.performance) {
        problems.push(
          `${member.id}: performance level reads back as ${JSON.stringify(level)} but this member declared `
          + `${JSON.stringify(declared.performance)} — a member reading a SIBLING's answer is the shared-bucket collapse`,
        );
      }
    }

    // The distinctness claim stated directly, so it fails even if a future case
    // stops declaring per-member levels: as many distinct observed levels as the
    // case declared. One shared bucket collapses this to 1.
    const declaredLevels = new Set(ctx.members.map((m) => declaredPreSeed(ctx, m.id).performance).filter(Boolean));
    const observedLevels = new Set(
      ctx.members.map((m) => str(rec(readEffectiveState(m.cwd, m.env).performance).level)).filter(Boolean),
    );
    if (declaredLevels.size !== observedLevels.size) {
      problems.push(
        `the case declared ${declaredLevels.size} distinct performance levels across its members but only `
        + `${observedLevels.size} survive on disk — the members are sharing a preferences bucket`,
      );
    }

    if (problems.length > 0) {
      return result(ctx, 'FAIL',
        `Workspace members do not hold independent state: ${problems.join('; ')}.`,
        { expected: 'one .one.json and one preferences bucket per member', actual: observed });
    }

    return result(ctx, 'PASS',
      `All ${ctx.members.length} members hold their own onboarding state and their own preferences bucket, each at the `
      + `path production's own defaultProjectPrefsPath names for that root, and each reads back its own declared `
      + `performance level (${ctx.members.map((m) => `${m.id}=${declaredPreSeed(ctx, m.id).performance}`).join(', ')}).`);
  },
};
