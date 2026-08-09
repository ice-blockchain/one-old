// src/test-environment/core/polyglot-workspace.ts
// The multi-project WORKSPACE fixture: one container directory holding several
// independent projects in different languages, each of which would on its own be
// a Traffic One project. It exists for the pending P4 "workspace" block — the
// items that change how project roots resolve, how gates anchor, and how
// onboarding branches when one editor window holds several projects — and it is
// the INSTRUMENT for that block, not the feature.
//
// Deliberately NOT a `FixtureKind`. `materializeFixture` (core/fixtures.ts:92)
// returns ONE directory and `runCase` threads exactly one `tmpDir` into the
// seed, the run-sim driver and every assertion (core/case-runner.ts:66-71,
// 299-308), so a multi-project case is not expressible in the case model as it
// stands. Wiring a second project in belongs to the lane that changes those
// types; until then this builds the shape directly so the CURRENT behaviour of
// the resolvers against it is measurable.
//
// TOOLCHAIN COST: zero. Every member is node, Go or Python — the three the
// harness already runs for real (`go` on PATH, and the runs-root venv whose
// `bin` buildCaseEnv prepends for `pytest`/`ruff`, core/env.ts:59-71). No member
// needs `composer` or `php`, so this fixture adds no machine prerequisite to
// `npm run test:env -- --strict`. See HARNESS_TOOLCHAINS below.

import * as fs from 'fs';
import * as path from 'path';

// The toolchains a `--strict` run may assume, and nothing else. A missing
// toolchain is reported INCONCLUSIVE, and under `--strict` an INCONCLUSIVE
// reddens the release verdict — so a member whose toolchain is absent would turn
// the release gate red on every machine that lacks it. Adding an entry here is
// therefore a change to the machine prerequisites in AGENTS.md, not a detail.
export const HARNESS_TOOLCHAINS = ['node', 'go', 'python3'] as const;
export type HarnessToolchain = (typeof HARNESS_TOOLCHAINS)[number];

export interface WorkspaceMemberSpec {
  readonly id: string;
  readonly toolchain: HarnessToolchain;
  /** The manifest that makes this directory own a project (MANIFEST_MARKERS). */
  readonly manifest: string;
  readonly manifestBody: string;
  /**
   * A source file in a subdirectory that owns NO marker of its own. The nesting
   * is load-bearing: it is the only shape that reaches the membership fallback
   * in resolveProjectRoot, which is where a polyglot member's language stops
   * mattering and only version control counts.
   */
  readonly nestedSource: { rel: string; body: string };
}

// Three languages, three manifest markers, one shape each — chosen so the set is
// distinguishable by `MANIFEST_MARKERS` alone and so no two members could be
// mistaken for packages of one npm workspace.
export const POLYGLOT_MEMBERS: readonly WorkspaceMemberSpec[] = [
  {
    id: 'storefront-web',
    toolchain: 'node',
    manifest: 'package.json',
    manifestBody: `${JSON.stringify({ name: 'storefront-web', version: '1.0.0', private: true }, null, 2)}\n`,
    nestedSource: { rel: 'src/main.ts', body: 'export const boot = (): number => 0;\n' },
  },
  {
    id: 'ledger-api',
    toolchain: 'go',
    manifest: 'go.mod',
    manifestBody: 'module ledger-api\n\ngo 1.22\n',
    nestedSource: { rel: 'internal/ledger/ledger.go', body: 'package ledger\n\nfunc Balance() int { return 0 }\n' },
  },
  {
    id: 'reporting-etl',
    toolchain: 'python3',
    manifest: 'pyproject.toml',
    manifestBody: '[project]\nname = "reporting-etl"\nversion = "0.1.0"\n',
    nestedSource: { rel: 'reporting_etl/pipeline.py', body: 'def run() -> None:\n    return None\n' },
  },
];

export interface PolyglotWorkspaceOptions {
  /** Give every member a mode-bearing `.one.json` of its own. */
  readonly onboardMembers?: boolean;
  /** Give every member a `.git` marker — the only ancestor-absorbing signal. */
  readonly memberVcs?: boolean;
  /** Write a container `package.json` with this exact body. */
  readonly containerPackageJson?: Record<string, unknown>;
  /** Give the container a `.git` marker (an umbrella repo holding the members). */
  readonly containerVcs?: boolean;
  /** Give the container a mode-bearing `.one.json`. */
  readonly onboardContainer?: boolean;
  /**
   * Onboard the container as a Traffic One WORKSPACE PROJECT (`mode: 'workspace'`)
   * whose members registry lists every member by name.
   *
   * The real form of what mutation M9 used to SIMULATE. Written with raw `fs`
   * like every other option here — a fixture that built itself through
   * shared/state/workspace-members.ts would be proving the reader with the
   * writer, and the registry is untrusted data whose whole point is that a hand
   * written `.one.json` reaches it. Applied AFTER `onboardContainer`, so a
   * caller that sets both gets the workspace mode.
   */
  readonly registerMembers?: boolean;
}

export interface WorkspaceMember extends WorkspaceMemberSpec {
  readonly dir: string;
  readonly manifestPath: string;
  readonly nestedSourcePath: string;
  readonly nestedSourceDir: string;
}

/** An on-disk fact the fixture's claim depends on, checked BEFORE any verdict. */
export type FixturePrecondition = readonly [label: string, actual: () => unknown, expected: unknown];

export interface PolyglotWorkspace {
  /** The container directory holding the members. */
  readonly container: string;
  readonly members: readonly WorkspaceMember[];
  readonly options: PolyglotWorkspaceOptions;
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function writeModeState(dir: string): void {
  write(
    path.join(dir, '.traffic-one', '.one.json'),
    `${JSON.stringify({ mode: 'existing-codebase', onboardingComplete: true }, null, 2)}\n`,
  );
}

/**
 * Materialize the workspace under `container` (created if absent) and return the
 * members. `container` is used VERBATIM — the caller decides whether it is a
 * canonical path, because that decision changes what the resolvers answer and
 * must therefore be visible at the call site rather than made in here.
 */
export function buildPolyglotWorkspace(
  container: string,
  options: PolyglotWorkspaceOptions = {},
): PolyglotWorkspace {
  fs.mkdirSync(container, { recursive: true });
  if (options.containerPackageJson) {
    write(path.join(container, 'package.json'), `${JSON.stringify(options.containerPackageJson, null, 2)}\n`);
  }
  if (options.containerVcs) fs.mkdirSync(path.join(container, '.git'), { recursive: true });
  if (options.onboardContainer) writeModeState(container);

  const members = POLYGLOT_MEMBERS.map((spec): WorkspaceMember => {
    const dir = path.join(container, spec.id);
    const manifestPath = path.join(dir, spec.manifest);
    const nestedSourcePath = path.join(dir, ...spec.nestedSource.rel.split('/'));
    write(manifestPath, spec.manifestBody);
    write(nestedSourcePath, spec.nestedSource.body);
    if (options.memberVcs) fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    if (options.onboardMembers) writeModeState(dir);
    return { ...spec, dir, manifestPath, nestedSourcePath, nestedSourceDir: path.dirname(nestedSourcePath) };
  });

  if (options.registerMembers) {
    write(
      path.join(container, '.traffic-one', '.one.json'),
      `${JSON.stringify({
        mode: 'workspace',
        onboardingComplete: true,
        workspaceMembers: members.map((member) => ({ path: member.id })),
      }, null, 2)}\n`,
    );
  }

  return { container, members, options };
}

/**
 * The facts that make this fixture the thing it claims to be. Read BEFORE any
 * verdict: a builder that stops building a polyglot workspace (a renamed
 * manifest, a member that quietly became an npm workspace package, a container
 * that grew a `workspaces` key) must fail as a FIXTURE error naming what
 * changed, never pass vacuously because the resolver happens to answer the same
 * string anyway.
 *
 * Returned as data rather than asserted here so the same list can be read by a
 * `node:test` assertion today and by a harness assertion (which reports
 * INCONCLUSIVE rather than throwing) when a later lane wires this into a case.
 */
export function polyglotPreconditions(workspace: PolyglotWorkspace): readonly FixturePrecondition[] {
  const { container, members, options } = workspace;
  const checks: FixturePrecondition[] = [
    ['the workspace holds three members', () => members.length, 3],
    [
      'the members are three DISTINCT languages',
      () => new Set(members.map((m) => m.toolchain)).size,
      3,
    ],
    // Read from DISK, not from the specs above: a spec-only distinctness check
    // still passes when a builder writes the wrong file, which is exactly the
    // way a fixture stops being polyglot without saying so.
    [
      'each member directory carries exactly one manifest, and the three are DISTINCT',
      () => members
        .map((m) => POLYGLOT_MEMBERS.map((spec) => spec.manifest)
          .filter((manifest) => fs.existsSync(path.join(m.dir, manifest)))
          .join('+'))
        .join(','),
      members.map((m) => m.manifest).join(','),
    ],
    [
      'every member still carries the manifest its spec declares',
      () => members.every((m) => fs.existsSync(m.manifestPath)),
      true,
    ],
    [
      'every member carries source in a subdirectory that owns no marker of its own',
      () => members.every((m) => (
        fs.existsSync(m.nestedSourcePath)
        && m.nestedSourceDir !== m.dir
        && !POLYGLOT_MEMBERS.some((spec) => fs.existsSync(path.join(m.nestedSourceDir, spec.manifest)))
      )),
      true,
    ],
    [
      'no member needs a toolchain outside the ones a --strict run already has',
      () => members.filter((m) => !HARNESS_TOOLCHAINS.includes(m.toolchain)).map((m) => m.id).join(','),
      '',
    ],
    [
      'the members are siblings under one container, not nested in each other',
      () => members.every((m) => path.dirname(m.dir) === path.resolve(container)),
      true,
    ],
  ];

  // The container's own shape decides which resolver branch the fixture
  // exercises, so each option is read back rather than trusted.
  checks.push([
    'the container declares an npm/pnpm workspace',
    () => containerDeclaresWorkspace(container),
    Boolean(
      options.containerPackageJson
      && Array.isArray((options.containerPackageJson as { workspaces?: unknown }).workspaces)
      && ((options.containerPackageJson as { workspaces: unknown[] }).workspaces.length > 0),
    ),
  ]);
  checks.push([
    'the container owns version control',
    () => fs.existsSync(path.join(container, '.git')),
    Boolean(options.containerVcs),
  ]);
  checks.push([
    'every member carries a mode-bearing .one.json of its own',
    () => members.every((m) => modeOf(m.dir) === 'existing-codebase'),
    Boolean(options.onboardMembers),
  ]);
  checks.push([
    'every member owns version control',
    () => members.every((m) => fs.existsSync(path.join(m.dir, '.git'))),
    Boolean(options.memberVcs),
  ]);
  // Read back as the LIST, not as a boolean: a registry that lost an entry, or
  // gained one naming a directory that is not a member, is a fixture that has
  // stopped describing this workspace while still answering "yes, registered".
  checks.push([
    'the container is a workspace project registering exactly these members',
    () => registeredMemberPaths(container).join(','),
    options.registerMembers ? members.map((m) => m.id).join(',') : '',
  ]);

  return checks;
}

/** Labels of every precondition that does not hold. Empty means the fixture is intact. */
export function failedPreconditions(workspace: PolyglotWorkspace): string[] {
  const failures: string[] = [];
  for (const [label, actual, expected] of polyglotPreconditions(workspace)) {
    let value: unknown;
    try {
      value = actual();
    } catch (error) {
      failures.push(`${label} (threw ${String(error)})`);
      continue;
    }
    if (value !== expected) failures.push(`${label} (got ${JSON.stringify(value)}, want ${JSON.stringify(expected)})`);
  }
  return failures;
}

// Local readers, so the fixture never depends on a resolver internal to describe
// itself — a precondition proved with the code under test proves nothing.
function containerDeclaresWorkspace(container: string): boolean {
  if (fs.existsSync(path.join(container, 'pnpm-workspace.yaml'))) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(container, 'package.json'), 'utf8')) as { workspaces?: unknown };
    return Array.isArray(pkg.workspaces) ? pkg.workspaces.length > 0 : false;
  } catch {
    return false;
  }
}

function modeOf(dir: string): string {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, '.traffic-one', '.one.json'), 'utf8')) as { mode?: unknown };
    return typeof state.mode === 'string' ? state.mode : '';
  } catch {
    return '';
  }
}

// Deliberately re-derived here rather than imported from
// shared/hook/workspace-members.ts: the reader is the code under test for every
// row that consults this fixture, and a precondition proved with it would pass
// for the same reason the assertion does.
function registeredMemberPaths(container: string): string[] {
  if (modeOf(container) !== 'workspace') return [];
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(container, '.traffic-one', '.one.json'), 'utf8'),
    ) as { workspaceMembers?: unknown };
    if (!Array.isArray(state.workspaceMembers)) return [];
    return state.workspaceMembers.map((entry) => {
      const value = (entry as { path?: unknown } | null)?.path;
      return typeof value === 'string' ? value : '';
    });
  } catch {
    return [];
  }
}
