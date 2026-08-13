// THE PIN FOR `anyAncestorHoldsState` (hook/paths.ts).
//
// The member-acceptance clause in `nearestOnboardedRoot` guards its
// `workspaceMembershipOf` walk behind a lean pre-scan, so a project that is not
// inside a workspace pays one `existsSync` per level instead of a full
// membership walk on every resolution. That is only correct because the
// pre-scan's bounds are a strict SUPERSET of the real walk's, and today that is
// true only by inspection: the pre-scan keeps the `$HOME` and ceiling stops,
// keeps `MAX_ROOT_WALK`, starts at the same parent, and omits exactly the two
// guards — `isMachineConfigRoot` and `hasPluginAuthoringMarkers` — that can only
// ever STOP or SKIP a level.
//
// WHY IT HAS TO BE A TEST rather than a comment. Break the relation — add a stop
// to the pre-scan, or teach the real walk a membership-granting path that is not
// an ancestor's `.one.json` — and the pre-scan starts answering `false` for a
// genuine member. Nothing throws. The acceptance clause is skipped, the member
// resolves with an empty container, `scope.workspace.kind` falls back to
// `'none'`, and the member fence goes quiet again in exactly the shape it was
// quiet in before it was fixed. A silent regression to the previous bug is the
// worst failure available here, so the implication is asserted directly:
//
//     workspaceMembershipOf(dir).kind !== 'not-member'  ⟹  anyAncestorHoldsState(dir)
//
// The `!== 'not-member'` form, rather than `=== 'member'`, is deliberate: it is
// the stronger claim the pre-scan's own docstring makes, covering the
// `indeterminate` arms (an illegible or opaque container registry) as well as
// the granting one.
//
// BOTH DEGENERACIES ARE PINNED TOO, because either would leave this file green
// while measuring nothing: a population with no members satisfies the
// implication vacuously, and a pre-scan rewritten to `return true` satisfies it
// trivially. The tallies at the bottom refuse both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { anyAncestorHoldsState, resolveProjectRootDetailed, workspaceMembershipOf } from '../hook/paths';
import { resetAuthoringRootCache } from '../authoring-root';

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function state(dir: string, body: unknown): void {
  write(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(body));
}

function pkg(dir: string, body: unknown): void {
  write(path.join(dir, 'package.json'), JSON.stringify(body));
}

/** A container registering `members`, plus each member's own tree. */
function container(dir: string, members: string[], opts: { pmWorkspaces?: boolean; onboardedMembers?: boolean } = {}): void {
  state(dir, { mode: 'workspace', onboardingComplete: true, workspaceMembers: members.map((p) => ({ path: p })) });
  pkg(dir, opts.pmWorkspaces ? { name: 'ws', workspaces: members } : { name: 'ws' });
  for (const member of members) {
    const abs = path.join(dir, member);
    pkg(abs, { name: path.basename(member) });
    write(path.join(abs, 'src', 'index.ts'), 'export const x = 1;\n');
    if (opts.onboardedMembers) state(abs, { mode: 'new-project', onboardingComplete: true, currentRunId: 'run-1' });
  }
}

interface Probe { readonly dir: string; readonly ceiling?: string }
interface Shape {
  readonly id: string;
  /** What this row is here to stress — named so a future reader can tell whether deleting it costs anything. */
  readonly stresses: string;
  readonly build: (root: string) => { probes: Probe[]; home?: string };
}

const SHAPES: Shape[] = [
  {
    id: 'solo-project',
    stresses: 'the population this pre-scan exists to keep cheap: no workspace anywhere above it',
    build: (root) => {
      const proj = path.join(root, 'code', 'acme', 'proj');
      state(proj, { mode: 'existing-codebase', onboardingComplete: true });
      pkg(proj, { name: 'proj' });
      write(path.join(proj, 'src', 'a.ts'), 'export const a = 1;\n');
      return { probes: [{ dir: proj }, { dir: path.join(proj, 'src') }] };
    },
  },
  {
    id: 'member-onboarded-plain-container',
    stresses: 'one of the two member classes the acceptance clause changes — an onboarded member under a container with no package-manager declaration; the other is the declaring member below',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api', 'web'], { onboardedMembers: true });
      return { probes: [{ dir: path.join(ws, 'api') }, { dir: path.join(ws, 'web') }] };
    },
  },
  {
    id: 'member-stateless-plain-container',
    stresses: 'the member shape the container redirect already handled — it must still satisfy the implication',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api', 'web']);
      return { probes: [{ dir: path.join(ws, 'api') }, { dir: path.join(ws, 'web') }] };
    },
  },
  {
    id: 'member-onboarded-pm-workspaces-container',
    stresses: 'a container that ALSO declares package-manager workspaces, the shape that reaches the leak test first',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api', 'web'], { pmWorkspaces: true, onboardedMembers: true });
      return { probes: [{ dir: path.join(ws, 'api') }, { dir: path.join(ws, 'web') }] };
    },
  },
  {
    id: 'member-declares-pm-workspaces',
    stresses: 'the other class the clause changes: a member that is a package-manager monorepo itself, which now reaches the pre-scan BEFORE the declaration exit it used to leave through',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['frontend', 'backend'], { onboardedMembers: true });
      const frontend = path.join(ws, 'frontend');
      pkg(frontend, { name: 'frontend', workspaces: ['apps/*'] });
      pkg(path.join(frontend, 'apps', 'site'), { name: 'site' });
      return { probes: [{ dir: frontend }, { dir: path.join(frontend, 'apps', 'site') }] };
    },
  },
  {
    id: 'deep-member',
    stresses: 'a member several levels below its container, so a pre-scan that stopped early would be caught',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, [path.join('apps', 'nested', 'web')], { onboardedMembers: true });
      return { probes: [{ dir: path.join(ws, 'apps', 'nested', 'web') }, { dir: path.join(ws, 'apps') }] };
    },
  },
  {
    id: 'nested-workspaces',
    stresses: 'a container that is itself a member of an outer container — the nearest grant must still be reachable',
    build: (root) => {
      const outer = path.join(root, 'outer');
      container(outer, ['inner'], { onboardedMembers: false });
      const inner = path.join(outer, 'inner');
      container(inner, ['app'], { onboardedMembers: true });
      return { probes: [{ dir: inner }, { dir: path.join(inner, 'app') }] };
    },
  },
  {
    id: 'nested-below-member',
    stresses: 'membership is EXACT, so a dir inside a member is not-member while the pre-scan says true — the SAFE direction',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api'], { onboardedMembers: true });
      return { probes: [{ dir: path.join(ws, 'api', 'src') }] };
    },
  },
  {
    id: 'unregistered-sibling',
    stresses: 'a directory inside a container that the registry does not name',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api'], { onboardedMembers: true });
      const stray = path.join(ws, 'not-registered');
      pkg(stray, { name: 'stray' });
      return { probes: [{ dir: stray }] };
    },
  },
  {
    id: 'stray-state-in-a-real-repo',
    stresses: 'the mercury/strategies incident — state in a dir that owns no project, with no workspace registry anywhere',
    build: (root) => {
      const repo = path.join(root, 'mercury');
      pkg(repo, { name: 'mercury' });
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      const leaf = path.join(repo, 'strategies');
      state(leaf, { mode: 'new-project', onboardingComplete: true });
      return { probes: [{ dir: leaf }] };
    },
  },
  {
    id: 'opaque-container-registry',
    stresses: 'the `indeterminate` arm: a registry whose member list is not an array',
    build: (root) => {
      const ws = path.join(root, 'ws');
      state(ws, { mode: 'workspace', onboardingComplete: true, workspaceMembers: 'api' });
      const member = path.join(ws, 'api');
      pkg(member, { name: 'api' });
      return { probes: [{ dir: member }] };
    },
  },
  {
    id: 'illegible-container-state',
    stresses: 'the other `indeterminate` arm: a container `.one.json` holding bytes that are not JSON (the merge-conflict case)',
    build: (root) => {
      const ws = path.join(root, 'ws');
      write(path.join(ws, '.traffic-one', '.one.json'), '<<<<<<< HEAD\n{"mode":"workspace"}\n');
      const member = path.join(ws, 'api');
      pkg(member, { name: 'api' });
      return { probes: [{ dir: member }] };
    },
  },
  {
    id: 'container-is-home',
    stresses: 'both walks stop at $HOME, so a "container" at ~ grants nothing and the pre-scan agrees',
    build: (root) => {
      container(root, ['api'], { onboardedMembers: true });
      return { probes: [{ dir: path.join(root, 'api') }], home: root };
    },
  },
  {
    id: 'container-in-machine-config-space',
    // Measured `not-member`: `isMachineConfigRoot` BREAKS the real walk, so no
    // member can ever be granted through machine-config space, and re-adding that
    // stop to the pre-scan is therefore unfalsifiable by this property — it can
    // only ever narrow a `true` the real walk had already declined. Kept as the
    // documented safe direction, not counted as a pin. The row still earns its
    // place: it is the one that would start FAILING if the real walk ever traded
    // its `break` for a `continue`.
    stresses: 'the FIRST omitted guard, in the safe direction: the real walk stops here, so the pre-scan may over-admit',
    build: (root) => {
      // `<home>/.windsurf` is machine-config space (authoring-root HOME_STATE_DIRNAMES).
      // Deliberately not `.cursor`: the agent command sandbox refuses to mkdir that
      // name even inside a temp dir, which is what fails four rows of
      // root-resolution-table.test.ts under sandboxed runs.
      const ws = path.join(root, '.windsurf', 'ws');
      container(ws, ['api'], { onboardedMembers: true });
      return { probes: [{ dir: path.join(ws, 'api') }], home: root };
    },
  },
  {
    id: 'authoring-markers-between-member-and-container',
    // The markers sit on an INTERMEDIATE directory, not on the container. Putting
    // them on the container instead makes the real walk skip the only level that
    // could grant anything, so the verdict is `not-member` and the row proves
    // nothing — measured, and the reason this shape looks the way it does.
    // Here the real walk skips `mid` and still reaches the grant at `ws`, so a
    // pre-scan that learned to STOP at an authoring root would answer `false` for
    // a directory the real walk calls a member, and this row would fail.
    stresses: 'the SECOND omitted guard, discriminating: the real walk SKIPS a level and grants beyond it',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, [path.join('mid', 'app')], { onboardedMembers: true });
      const mid = path.join(ws, 'mid');
      // What hasPluginAuthoringMarkers reads: the source-tree entry plus the name.
      pkg(mid, { name: 'traffic-one' });
      write(path.join(mid, 'src', 'gen', 'index.ts'), 'export {};\n');
      return { probes: [{ dir: path.join(ws, 'mid', 'app') }] };
    },
  },
  {
    id: 'ceiling-cuts-the-container-off',
    stresses: 'the ceiling stop, which BOTH walks keep — the one bound the pre-scan may not widen',
    build: (root) => {
      const ws = path.join(root, 'ws');
      container(ws, ['api'], { onboardedMembers: true });
      const member = path.join(ws, 'api');
      return { probes: [{ dir: member, ceiling: member }, { dir: member, ceiling: ws }] };
    },
  },
];

test('pre-scan superset: every membership the real walk grants, the pre-scan admits', () => {
  let members = 0;
  let indeterminates = 0;
  let prescanFalse = 0;
  let probes = 0;

  for (const shape of SHAPES) {
    const created = fs.mkdtempSync(path.join(os.tmpdir(), `t1-prescan-${shape.id.slice(0, 12)}-`));
    const root = fs.realpathSync(created);
    const prevHome = process.env.HOME;
    try {
      const built = shape.build(root);
      if (built.home) process.env.HOME = built.home;
      // The fixtures reuse paths and both omitted guards memoize per start dir.
      resetAuthoringRootCache();

      for (const probe of built.probes) {
        probes += 1;
        // Called exactly as nearestOnboardedRoot calls them, which is the point of
        // the pairing: the walk resolves its ceiling ONCE at the top and hands the
        // SAME resolved bound to both. A superset argument is a claim about two
        // bounds, so it may not be read against two spellings of one.
        const ceiling = probe.ceiling ? path.resolve(probe.ceiling) : '';
        const verdict = workspaceMembershipOf(probe.dir, { ceiling });
        const admitted = anyAncestorHoldsState(probe.dir, ceiling);
        const where = `${shape.id} @ ${path.relative(root, probe.dir) || '.'}`
          + (probe.ceiling ? ` (ceiling ${path.relative(root, probe.ceiling) || '.'})` : '');

        if (verdict.kind !== 'not-member') {
          assert.equal(admitted, true,
            `${where}: the real walk answered '${verdict.kind}' but the pre-scan skipped it.`
            + ' The two walks have drifted: the pre-scan must visit a SUPERSET of the'
            + " directories workspaceMembershipOf reads, or the member fence silently stops engaging.");
        }
        if (verdict.kind === 'member') members += 1;
        if (verdict.kind === 'indeterminate') indeterminates += 1;
        if (!admitted) prescanFalse += 1;
      }
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      resetAuthoringRootCache();
      fs.rmSync(created, { recursive: true, force: true });
    }
  }

  // ── the two degeneracies ───────────────────────────────────────────────────
  // Without these the implication above is satisfiable by an empty population
  // and by `return true`, which are precisely the two ways this pin could rot
  // into a test that passes while measuring nothing.
  assert.ok(probes >= 20, `expected a real population, got ${probes} probes`);
  assert.ok(members >= 8,
    `only ${members} probes were granted membership — the implication is close to vacuous.`
    + ' A fixture change that stopped producing members would leave this file green while measuring nothing.');
  assert.ok(indeterminates >= 2,
    `only ${indeterminates} probes were indeterminate — the illegible/opaque arms of the claim are unpinned`);
  assert.ok(prescanFalse >= 3,
    `the pre-scan never answered false (${prescanFalse} times) — a pre-scan that always says "maybe"`
    + ' satisfies the implication trivially and buys none of the syscalls it exists to save');
});

// The pairing above is asserted against ONE bound because `nearestOnboardedRoot`
// hands one to both: it resolves the ceiling at the top of the walk and passes
// that value to the walk's own stop, to the pre-scan and to the membership walk
// alike. Swapping any of the three back to the caller's raw spelling is currently
// an EQUIVALENT change — `workspaceMembershipOf` resolves whatever it is given,
// so no input can tell the two spellings apart, which is why the mutation sweep
// cannot kill that swap and why nothing here pretends it did.
//
// This row pins the equivalence itself rather than the call site. The superset
// argument is a claim about two bounds being the same bound; if that internal
// resolve ever went away, the claim would quietly become a claim about two
// spellings that merely usually coincide, and a relatively-spelled ceiling would
// start answering differently. That is the failure this row would catch.
test('pre-scan superset: the ceiling is one bound, however the caller spells it', () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 't1-prescan-ceiling-'));
  const root = fs.realpathSync(created);
  try {
    const ws = path.join(root, 'ws');
    container(ws, ['api'], { onboardedMembers: true });
    const member = path.join(ws, 'api');

    const absolute = resolveProjectRootDetailed(member, undefined, { ceiling: root });
    assert.equal(absolute.root, member);
    assert.equal(absolute.workspaceContainer, ws, 'the member carries its container under an absolute ceiling');

    const relative = path.relative(process.cwd(), root);
    assert.ok(!path.isAbsolute(relative), 'the point of the row is that this spelling is relative');
    const spelled = resolveProjectRootDetailed(member, undefined, { ceiling: relative });
    assert.deepEqual(
      { root: spelled.root, container: spelled.workspaceContainer },
      { root: absolute.root, container: absolute.workspaceContainer },
      'the same bound spelled relatively must answer identically — if it does not, the ceiling is'
      + ' two bounds wearing one name, and the superset argument above is reading whichever it was handed',
    );
  } finally {
    fs.rmSync(created, { recursive: true, force: true });
  }
});
