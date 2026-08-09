// workspace-member-roots: in a container of N independent projects, every member
// resolves to ITSELF from every entry point a hook can arrive through, and the
// container adopts none of them.
//
// This is the composition half of what core/polyglot-workspace.test.ts measures
// at the unit tier. The difference is not redundancy: the unit tier builds the
// members with raw `fs` and asks the resolver directly, while this row measures
// the members a CASE materialized — through the same `materializeFixture` every
// other case uses, seeded through the real consent fence by the real state
// writers, with each member carrying its own preferences bucket. A resolver that
// stayed correct while the seeding path silently re-rooted a member would pass
// there and fail here, and that composition is the only thing this tier exists
// to check.
//
// The four entry points are the four ways a hook actually arrives, and they fail
// independently:
//   - cwd AT the member                      (a terminal opened in the member)
//   - cwd in a marker-less subdirectory      (a tool editing a source file)
//   - cwd at the CONTAINER with a file hint  (the multi-project editor window —
//     and the moment onboarding is offered, so this one decides which directory
//     a member's `.one.json` is written into)
//   - the same, with the container as the host workspace ceiling (Cursor's
//     `workspace_roots` on a container opened as one window)

import * as path from 'path';

import { resolveProjectRoot } from '../../shared/hook/paths';
import type { Assertion, AssertionContext, CaseMemberContext } from '../core/types';
import { result } from './util';
import { workspaceFixtureStop } from './workspace';

interface Probe {
  readonly label: string;
  readonly answer: (member: CaseMemberContext, container: string) => string;
}

const PROBES: readonly Probe[] = [
  { label: 'cwd at the member', answer: (m) => resolveProjectRoot(m.cwd) },
  { label: 'cwd in a marker-less subdirectory of the member', answer: (m) => resolveProjectRoot(m.probeDir) },
  {
    label: 'cwd at the CONTAINER with a file hint into the member',
    answer: (m, container) => resolveProjectRoot(container, m.probeFile),
  },
  {
    label: 'cwd at the member with the container as the host workspace ceiling',
    answer: (m, container) => resolveProjectRoot(m.cwd, m.probeFile, { ceiling: container }),
  },
];

export const assertion: Assertion = {
  id: 'workspace-member-roots',
  title: 'Every workspace member resolves to itself, and the container adopts none of them',
  appliesTo: (c) => c.category === 'workspace',
  run: (ctx: AssertionContext) => {
    const stop = workspaceFixtureStop(ctx);
    if (stop) return stop;

    const container = path.resolve(ctx.cwd);
    const wrong: string[] = [];
    for (const member of ctx.members) {
      for (const probe of PROBES) {
        const answer = probe.answer(member, container);
        if (path.resolve(answer) !== path.resolve(member.cwd)) {
          wrong.push(`${member.id} · ${probe.label} → ${answer}`);
        }
      }
    }
    if (wrong.length > 0) {
      return result(ctx, 'FAIL',
        `A workspace member did not resolve to itself: ${wrong.join('; ')}. A member that resolves to the container `
        + 'shares one project root, one run, one plan and one set of digests with every sibling — and a member that '
        + 'resolves ABOVE its own mode-bearing state is what shared/retention.ts reads as a leaked nested root.',
        { expected: ctx.members.map((m) => m.cwd), actual: wrong });
    }

    // The container's own answer, checked separately: a container that resolved
    // to one of its members would hand every container-level hook that member's
    // project, which is the same defect pointing the other way.
    const containerRoot = path.resolve(resolveProjectRoot(container));
    const adopted = ctx.members.find((m) => path.resolve(m.cwd) === containerRoot);
    if (adopted) {
      return result(ctx, 'FAIL',
        `The container resolved to its member \`${adopted.id}\` (${containerRoot}). A container-level session would `
        + "then run inside one arbitrary member's project.",
        { expected: container, actual: containerRoot });
    }

    return result(ctx, 'PASS',
      `All ${ctx.members.length} members (${ctx.members.map((m) => m.id).join(', ')}) resolve to themselves from `
      + `all ${PROBES.length} entry points, and the container resolves to ${containerRoot === container ? 'itself' : containerRoot}, `
      + 'adopting no member.');
  },
};
