// src/test-environment/assertions/workspace.ts
// What a WORKSPACE case's fixture claims to be, read back from disk before any
// workspace assertion reaches a verdict.
//
// The rule this file enforces is the one core/polyglot-workspace.ts already
// states for the unit tier, moved to the harness tier where a throw is the wrong
// shape: a builder that quietly stops being a workspace — a member that lost its
// manifest, a container that grew a `.traffic-one`, two members that ended up
// sharing one preferences bucket — must fail as a FIXTURE error naming what
// changed, never pass vacuously because the resolver happens to answer the same
// string anyway. INCONCLUSIVE is what the harness already reports for a spec it
// cannot evaluate, and `--strict` keeps failing the release verdict on it, so a
// fixture error is loud without being a product verdict.
//
// The readers here are LOCAL on purpose, exactly as they are in
// polyglot-workspace.ts: the resolvers and the registry reader are the code under
// test for every row that consults this fixture, and a precondition proved with
// them would pass for the same reason the assertion does.

import * as fs from 'fs';
import * as path from 'path';

import { defaultProjectPrefsPath } from '../../shared/state/local-prefs/prefs-store';
import type { AssertionContext, AssertionResult, CaseMemberContext } from '../core/types';
import { result } from './util';

// Re-derived rather than imported from shared/project-membership.ts for the
// reason above — `dirOwnsProject` is what the root-resolution rows measure. Kept
// to the manifests the harness's own fixtures actually write, so a marker added
// to the product's list cannot silently satisfy a precondition here.
const FIXTURE_MANIFESTS = ['package.json', 'go.mod', 'pyproject.toml'] as const;

function manifestsIn(dir: string): string[] {
  return FIXTURE_MANIFESTS.filter((manifest) => fs.existsSync(path.join(dir, manifest)));
}

function modeOf(dir: string): string {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8'),
    ) as { mode?: unknown };
    return typeof state.mode === 'string' ? state.mode : '';
  } catch {
    return '';
  }
}

/** An on-disk fact a workspace row depends on, checked BEFORE any verdict. */
export type FixtureCheck = readonly [label: string, actual: () => unknown, expected: unknown];

export function workspacePreconditions(ctx: AssertionContext): FixtureCheck[] {
  const { members, cwd: container, caseFolder } = ctx;
  const checks: FixtureCheck[] = [
    // A workspace of one is a project. Two would be enough to make the case
    // model's multiplicity real; the corpus uses three so that "the last member
    // wins" and "every member agrees" are distinguishable outcomes.
    ['the case materialized at least three members', () => members.length >= 3, true],
    [
      'every member directory exists',
      () => members.filter((m) => !fs.existsSync(m.cwd)).map((m) => m.id).join(','),
      '',
    ],
    [
      'the members are siblings directly under the container, not nested in each other',
      () => members.every((m) => path.dirname(path.resolve(m.cwd)) === path.resolve(container)),
      true,
    ],
    [
      'every member owns a project through a manifest of its own',
      () => members.filter((m) => manifestsIn(m.cwd).length === 0).map((m) => m.id).join(','),
      '',
    ],
    // The polyglot claim, as a falsifiable fact rather than as prose in the case
    // file: if every member ended up carrying the same manifest the case would
    // still pass every resolution row while no longer measuring a POLYGLOT
    // container at all.
    [
      'the members carry at least two DISTINCT manifests between them',
      () => new Set(members.flatMap((m) => manifestsIn(m.cwd))).size >= 2,
      true,
    ],
    [
      'every member carries a probe directory that is not the member root and owns no manifest',
      () => members.every((m) => (
        fs.existsSync(m.probeFile)
        && path.resolve(m.probeDir) !== path.resolve(m.cwd)
        && manifestsIn(m.probeDir).length === 0
      )),
      true,
    ],
    [
      'every member carries a mode-bearing .one.json of its own',
      () => members.filter((m) => !modeOf(m.cwd)).map((m) => m.id).join(','),
      '',
    ],
    // THE claim the whole tier rests on. A container that acquired a manifest is
    // a monorepo root, and a container that acquired a `.traffic-one` is an
    // onboarded project — either one changes what every resolution row below
    // means, and neither would make a row fail on its own.
    [
      'the container owns no manifest of its own',
      () => manifestsIn(container).join(','),
      '',
    ],
    [
      'the container carries no .traffic-one of its own',
      () => fs.existsSync(path.join(container, '.traffic-one')),
      false,
    ],
    // Isolation, not distinctness. Where a member's preferences bucket LIVES is
    // a precondition — a case that reached the maintainer's real
    // `~/.traffic-one/projects/<hash>` has stopped being an isolated case and
    // every row it reports is about the wrong machine. Whether the buckets are
    // DISTINCT is deliberately NOT here: that is the subject
    // workspace-member-state exists to judge, and a subject checked as a
    // precondition reports "I could not look" about the one thing it was
    // looking at — while blocking the two rows (roots, retention) that never
    // read preferences at all.
    [
      'every member preferences bucket is inside this case folder',
      () => members.filter((m) => !isInside(prefsPathOf(m), caseFolder)).map((m) => m.id).join(','),
      '',
    ],
  ];
  return checks;
}

export function prefsPathOf(member: CaseMemberContext): string {
  return path.resolve(member.env.TRAFFIC_ONE_PROJECT_PREFS_PATH || '.');
}

/**
 * The bucket production's own resolver would name for this member root, under
 * this member's environment. Used by the state-isolation row to prove the
 * harness reproduced the DERIVATION and not merely the distinctness.
 */
export function productionPrefsPathOf(member: CaseMemberContext): string {
  return path.resolve(defaultProjectPrefsPath(member.cwd, member.env));
}

function isInside(candidate: string, root: string): boolean {
  const resolved = path.resolve(root);
  return candidate === resolved || candidate.startsWith(resolved + path.sep);
}

/** Labels of every precondition that does not hold. Empty means the fixture is intact. */
export function failedWorkspacePreconditions(ctx: AssertionContext): string[] {
  const failures: string[] = [];
  for (const [label, actual, expected] of workspacePreconditions(ctx)) {
    let value: unknown;
    try {
      value = actual();
    } catch (error) {
      failures.push(`${label} (threw ${String(error)})`);
      continue;
    }
    if (value !== expected) {
      failures.push(`${label} (got ${JSON.stringify(value)}, want ${JSON.stringify(expected)})`);
    }
  }
  return failures;
}

/**
 * The verdict to return INSTEAD of judging the product, or null when the fixture
 * is what it claims and the row may proceed.
 *
 * Called FIRST in every workspace assertion, never last: a row that measured a
 * broken fixture and then reported PASS or FAIL would be reporting on a world
 * nobody built.
 */
export function workspaceFixtureStop(ctx: AssertionContext): AssertionResult | null {
  if (ctx.members.length === 0) {
    return result(ctx, 'INCONCLUSIVE',
      'FIXTURE: this case materialized no workspace members, so there is nothing to measure. A workspace '
      + 'assertion listed on a single-project case measures nothing and must not report a verdict about the product.');
  }
  const failures = failedWorkspacePreconditions(ctx);
  if (failures.length === 0) return null;
  return result(ctx, 'INCONCLUSIVE',
    `FIXTURE: the workspace this case claims to have built is not on disk — ${failures.join('; ')}. `
    + 'Every row below would be a verdict about a world nobody built, so none is reported.',
    { expected: 'a container of independently owned member projects', actual: failures });
}
