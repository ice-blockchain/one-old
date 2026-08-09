// workspace.cases.ts — pure-node. A repository that CONTAINS several independent
// projects: one bare container directory holding three members in three
// languages, each of which would on its own be an ordinary Traffic One project.
//
// WHAT THIS CASE IS FOR. The P4 workspace block changes how project roots
// resolve, how gates anchor and how onboarding branches when one editor window
// holds several projects. Every item in it needs an end-to-end subject, and
// until this case existed the harness had none: `Case.fixture` was ONE
// `FixtureKind`, `materializeFixture` returned ONE directory, and one project
// dir threaded into the seed, the run-sim driver and every assertion — so a
// multi-project case was not expressible in the case model at all.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not onboard the container as a
// Traffic One WORKSPACE PROJECT (`mode: 'workspace'`). Nothing in the product
// writes that mode yet: the branch in `computeOnboarding` that would is a
// separate, not-yet-built item, and a case that hand-wrote the mode into
// `.one.json` would be certifying a producer that does not exist. The registry
// READER is already exercised against a hand-written state at the unit tier
// (core/polyglot-workspace.test.ts, `registerMembers`), which is the right tier
// for it: there the hand-written file IS the subject, because the registry is
// data the product may never take on faith — its whole point is that an agent's
// Write tool can reach it.
//
// So what this case measures is everything about a multi-project container that
// is true TODAY, with the workspace mode dormant:
//   - each member resolves to itself from all four hook entry points, and the
//     container adopts none of them;
//   - each member holds its own onboarding state and its OWN preferences bucket,
//     at the path production's own resolver names for that root;
//   - each member answered the ask-first consent question for itself;
//   - ten real retention sweeps from the container destroy no member's state.
// When the workspace-onboarding producer lands, the case that becomes possible
// is this one plus `container: 'empty-git'` and a preSeed whose mode is
// `workspace` — the fixture and the runner already carry it.

import type { Case } from '../../core/types';

// Three languages, three manifest markers. The polyglot shape matters for the
// same reason it does in core/polyglot-workspace.ts: it is what makes the
// members impossible to mistake for packages of one npm workspace, and two of
// them could not be members of a `workspaces` declaration under any reading of
// it. It adds no machine prerequisite — nothing here executes a member.
//
// The performance levels are DELIBERATELY all different. They are the only
// declared field that lands in the per-project PREFERENCES file rather than in
// the project's own `.one.json`, so they are what makes a shared preferences
// bucket observable: under one file the last member seeded overwrites the other
// two and all three read back `high`. See workspace-member-state.assert.ts.
const MEMBER_SEED = {
  mode: 'existing-codebase' as const,
  stack: 'default',
  team: { mode: 'main-agent' as const },
};

export const WORKSPACE_CASES: Case[] = [
  {
    id: 'ws-polyglot-members',
    category: 'workspace',
    layer: 'pure-node',
    fixture: {
      // No `container` fixture: the container owns no manifest and is nobody's
      // project. That is the shape the P4 items are about, and it is what makes
      // "the container adopts no member" a real question rather than one
      // answered by the container's own state file.
      members: [
        { id: 'storefront-web', fixture: 'existing-react-vite', preSeed: { ...MEMBER_SEED, performance: 'low' } },
        { id: 'ledger-api', fixture: 'existing-go-api', preSeed: { ...MEMBER_SEED, performance: 'balanced' } },
        { id: 'reporting-etl', fixture: 'existing-python-api', preSeed: { ...MEMBER_SEED, performance: 'high' } },
      ],
    },
    // Never applied to anything: this workspace's container is bare, so there is
    // no root project to seed and every member declares its own selection above.
    // Present because `Case.preSeed` is the default a member inherits when it
    // declares none, and because assertions read it through `appliesTo`.
    preSeed: MEMBER_SEED,
    assertions: [
      { id: 'workspace-member-roots' },
      { id: 'workspace-member-state' },
      { id: 'workspace-retention-sweep' },
    ],
    notes: 'A bare container holding three independently onboarded projects (React/Vite, Go, Python). '
      + 'The workspace MODE is dormant; this measures the container shape as it behaves today.',
  },
];
