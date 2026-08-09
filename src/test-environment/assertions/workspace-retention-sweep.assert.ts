// workspace-retention-sweep: repeated SessionStart retention sweeps run from the
// CONTAINER never delete a member's durable state.
//
// The failure this exists to catch is not hypothetical and it is not recoverable.
// `isLeakedNestedRoot` (shared/retention.ts) marks a nested `.traffic-one` for
// deletion whenever `resolveProjectRoot(dir) !== dir`, and a container of
// independent projects is exactly the shape that makes a member resolve upward:
// MEASURED, a container declaring `workspaces: ['packages/*']` with no
// `packages/` directory anywhere on disk made three independently onboarded
// projects climb past their own mode-bearing `.one.json`, and the sweep planned
// all three for deletion. Nothing heals that — a project's plan, digests, run
// history and project memory are gone.
//
// TEN sweeps, not one, and REAL ones rather than dry runs, because the two
// failure modes are different: a predicate that mis-fires shows up on the first
// sweep, while an ACCUMULATING one — state a sweep rewrites such that the next
// sweep now considers it leaked — shows up only on a later pass. The unit tier
// (core/polyglot-workspace.test.ts) asserts the planned actions of a single dry
// run; this row asserts the durable BYTES survive being swept over and over,
// which is the only claim a user cares about.
//
// A sweep from each MEMBER root is included for the same reason from the other
// direction: a member's own SessionStart runs this against its own tree, and a
// member that swept away its own state would be indistinguishable, at the
// container level, from one that was never seeded.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { sweepTrafficOneRetention } from '../../shared/retention';
import type { Assertion, AssertionContext, CaseMemberContext } from '../core/types';
import { result } from './util';
import { workspaceFixtureStop } from './workspace';

const SWEEPS = 10;

function stateDigest(member: CaseMemberContext): string {
  const file = path.join(member.cwd, '.traffic-one', '.one.json');
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return ''; // absent or unreadable — the failure this row is looking for
  }
}

export const assertion: Assertion = {
  id: 'workspace-retention-sweep',
  title: 'Ten retention sweeps from the container delete no member state',
  appliesTo: (c) => c.category === 'workspace',
  run: (ctx: AssertionContext) => {
    const stop = workspaceFixtureStop(ctx);
    if (stop) return stop;

    const before = new Map(ctx.members.map((m) => [m.id, stateDigest(m)]));
    const empty = [...before].filter(([, digest]) => !digest).map(([id]) => id);
    if (empty.length > 0) {
      return result(ctx, 'INCONCLUSIVE',
        `FIXTURE: ${empty.join(', ')} carried no readable \`.traffic-one/.one.json\` BEFORE any sweep ran, so a `
        + 'surviving-state claim about them would be vacuous.');
    }

    const plannedLeaks: string[] = [];
    const lost: string[] = [];
    const changed: string[] = [];

    for (let pass = 1; pass <= SWEEPS; pass += 1) {
      // The container first — a session opened on the whole workspace — then each
      // member, which is what that member's own SessionStart runs.
      for (const root of [ctx.cwd, ...ctx.members.map((m) => m.cwd)]) {
        const swept = sweepTrafficOneRetention(root, { dryRun: false });
        for (const action of swept.actions) {
          if (!action.reason.includes('leaked nested')) continue;
          plannedLeaks.push(`pass ${pass} from ${path.relative(ctx.cwd, root) || '<container>'}: ${action.path} (${action.reason})`);
        }
      }
      for (const member of ctx.members) {
        const digest = stateDigest(member);
        if (!digest) lost.push(`${member.id} after pass ${pass}`);
        else if (digest !== before.get(member.id)) changed.push(`${member.id} after pass ${pass}`);
      }
      if (lost.length > 0) break; // the state is gone; further passes measure nothing
    }

    if (lost.length > 0) {
      return result(ctx, 'FAIL',
        `A retention sweep DELETED a workspace member's durable state: ${lost.join(', ')}. Nothing heals this — the `
        + "member's plan, digests, run history and project memory are gone, and the next session offers onboarding "
        + 'as if the project had never been set up.',
        { expected: 'every member keeps its .one.json across 10 sweeps', actual: lost });
    }
    if (plannedLeaks.length > 0) {
      return result(ctx, 'FAIL',
        `The sweep reported workspace members as leaked nested state roots: ${plannedLeaks.join('; ')}. The bytes `
        + 'survived only because the fenced delete refused them; the verdict itself is already wrong.',
        { expected: 'no leaked-nested action for any member', actual: plannedLeaks });
    }
    if (changed.length > 0) {
      return result(ctx, 'FAIL',
        `A retention sweep REWROTE a workspace member's state file: ${changed.join(', ')}. A sweep is a reclamation `
        + 'pass over expired run artifacts and must never touch the state file itself.',
        { expected: 'byte-identical .one.json after every sweep', actual: changed });
    }

    return result(ctx, 'PASS',
      `${SWEEPS} real retention sweeps from the container and from each of the ${ctx.members.length} members planned no `
      + "leaked-nested deletion, and every member's `.one.json` is byte-identical to what it held before the first sweep.");
  },
};
