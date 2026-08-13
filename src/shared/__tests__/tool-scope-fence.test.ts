// The WORKSPACE MEMBER fence: "no gate may operate on a workspace root, and
// every call anchors to the member that owns its target."
//
// Four properties, and every test below is named in the mutation table in the
// lane report — each is the test that goes red when one specific guard is
// neutered on its own:
//
//   1. THE DEFAULT PATH IS UNCHANGED, BY CONSTRUCTION. Nothing in the world
//      carries `mode: 'workspace'`, so a non-workspace project must reach the
//      same answer through the same syscalls. Pinned as an equality between the
//      state-file read COUNTS of the plain and the detailed resolver, not as a
//      spot-check of one project shape.
//   2. THE CALL ANCHORS TO ITS TARGET'S MEMBER, including for read-class tools,
//      whose targets the adoption rule (`targetsMayReanchor`) deliberately
//      refuses — a refusal about adopting ANOTHER project, which a move from a
//      container down to its own member is not.
//   3. A CALL THAT NAMES NO SINGLE MEMBER IS REFUSED BY NAME, in all four
//      shapes, and the refusal reaches a real gate rather than only this API.
//   4. THE PROSE INTERPOLATES EVERY VARIABLE. A dropped variable collapses N
//      distinct inputs onto one render, which merges their deny-repeat
//      escalation buckets; the render-space test measures that directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import * as ts from 'typescript';

import { makeClaudeAdapter } from '../../adapters/claude';
import { dispatch } from '../../core/dispatch';
import type { Ctx, HookInput, ToolClass } from '../../core/types';
import { resetAuthoringRootCache } from '../authoring-root';
import { RUN_HOST_CAPABILITY_RELATIVE_FILE } from '../host/capabilities';
import { resolveProjectRoot, resolveProjectRootDetailed } from '../hook/paths';
import { extractBlock } from '../skill-block';
import { resolveToolScope, workspaceMemberRefusal } from '../tool-scope';
import { libraryAllowlistGate } from '../../modules/plan-guard/handler';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP_PREFIX = 't1-ws-fence-';

function withRoot(body: (root: string) => void): void {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  try {
    resetAuthoringRootCache();
    body(fs.realpathSync(created));
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
}

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function writeState(dir: string, state: unknown): void {
  write(path.join(dir, '.traffic-one', '.one.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/** A container onboarded as a workspace. `members` is the raw registry value. */
function container(root: string, members: unknown): string {
  const dir = path.join(root, 'ws');
  writeState(dir, { mode: 'workspace', onboardingComplete: true, workspaceMembers: members });
  return dir;
}

/** A member directory with a manifest and a source file, and NO state of its own. */
function memberDir(ws: string, id: string): string {
  const dir = path.join(ws, id);
  write(path.join(dir, 'package.json'), `${JSON.stringify({ name: id })}\n`);
  write(path.join(dir, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
  return dir;
}

/** An ordinary, non-workspace Traffic One project — the default path. */
function plainProject(root: string): string {
  const dir = path.join(root, 'plain');
  writeState(dir, { mode: 'existing-codebase', stack: 'custom-backend', onboardingComplete: true });
  write(path.join(dir, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
  return dir;
}

function ctx(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
  canonical: Partial<NonNullable<HookInput['tool']>> = {},
): Ctx {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'codex',
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput },
    tool: { class: cls, rawName, ...canonical },
  };
  return { input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx;
}

function writeTo(cwd: string, file: string): Ctx {
  return ctx(cwd, 'Write', 'file-write', { file_path: file, content: 'x' }, { filePath: file });
}

// ── 1. the default path ──────────────────────────────────────────────────────

// The by-construction argument, measured rather than asserted in prose: the
// detailed resolver reads the SAME state files as the plain one, because it
// hands back the record the walk already had instead of opening it again. An
// implementation that re-read `<root>/.traffic-one/.one.json` to answer "is this
// a container?" would show up here as one extra read per call, on every project
// in the world — which is the cost D5 forbids.
function countStateReads(body: () => void): number {
  // `import * as fs` yields an ESM namespace whose members are getter-only, so
  // the counter is installed on the CJS module object the runtime code actually
  // calls through.
  //
  // THE OPEN IS COUNTED AS WELL AS THE READ, and counting only the read made this
  // instrument BLIND — measured, in the direction that reports a clean lower
  // number. Every state read now goes through shared/bounded-read.ts, which opens
  // the path (O_RDONLY|O_NONBLOCK), asks `fstat` whether the DESCRIPTOR is a
  // regular file, and only then calls `readFileSync(fd)` — an FD, not a path — so
  // a spy keyed on a string argument saw ZERO reads for a fixture that reads the
  // state file twice. The equality this test asserts survived it (0 === 0); only
  // the `plain > 0` fixture guard noticed, which is the whole reason it is there.
  // The other three read-counting spies in this repo (retention.test.ts and both
  // plan-migration suites) already patch both, for the same reason.
  const fsModule = createRequire(__filename)('fs') as {
    openSync: typeof fs.openSync;
    readFileSync: typeof fs.readFileSync;
  };
  const realOpen = fsModule.openSync;
  const realRead = fsModule.readFileSync;
  let reads = 0;
  const isState = (file: unknown): boolean => typeof file === 'string' && file.endsWith('.one.json');
  // No double counting: a bounded read is one `openSync(path)` plus one
  // `readFileSync(fd)`, and only the first has a string to match.
  fsModule.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (isState(args[0])) reads += 1;
    return (realOpen as (...a: unknown[]) => number)(...args);
  }) as typeof fs.openSync;
  fsModule.readFileSync = ((
    file: Parameters<typeof fs.readFileSync>[0],
    options?: Parameters<typeof fs.readFileSync>[1],
  ) => {
    if (isState(file)) reads += 1;
    return (realRead as (...args: unknown[]) => unknown)(file, options);
  }) as typeof fs.readFileSync;
  try {
    body();
  } finally {
    fsModule.openSync = realOpen;
    fsModule.readFileSync = realRead;
  }
  return reads;
}

test('default path: the detailed resolver adds ZERO state reads on a non-workspace project', () => {
  withRoot((root) => {
    const project = plainProject(root);
    const target = path.join(project, 'src', 'main.ts');
    // Warm anything cacheable identically for both, so the comparison measures
    // the resolver rather than a first-call cache miss.
    resolveProjectRoot(project, target);
    resolveProjectRootDetailed(project, target);
    const plain = countStateReads(() => { resolveProjectRoot(project, target); });
    const detailed = countStateReads(() => { resolveProjectRootDetailed(project, target); });
    assert.ok(plain > 0, `the fixture must actually read a state file (read ${plain})`);
    assert.equal(detailed, plain,
      `resolveProjectRootDetailed read ${detailed} state files where resolveProjectRoot read ${plain} —`
      + ' the container question must be answered from the record the walk already holds, not a new read');
  });
});

test('default path: a non-workspace project reports no workspace and cannot be refused', () => {
  withRoot((root) => {
    const project = plainProject(root);
    const scope = resolveToolScope(writeTo(project, path.join(project, 'src', 'main.ts')));
    assert.equal(scope.workspace.kind, 'none');
    assert.equal(scope.projectRoot, project);
    assert.equal(workspaceMemberRefusal(scope), null);
    assert.equal(resolveProjectRootDetailed(project).workspaceRegistry, null);
    assert.equal(resolveProjectRootDetailed(project).workspaceContainer, '');
  });
});

// ── 2. the re-anchor ─────────────────────────────────────────────────────────

test('a write into a registered member anchors to that member, not the container', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }, { path: 'web' }]);
    const api = memberDir(ws, 'api');
    memberDir(ws, 'web');
    const scope = resolveToolScope(writeTo(ws, path.join(api, 'src', 'main.ts')));
    assert.equal(scope.projectRoot, api);
    assert.equal(scope.workspace.kind, 'member');
    assert.equal(workspaceMemberRefusal(scope), null);
  });
});

test('a READ into a member anchors to it too, though adoption evidence is refused', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }, { path: 'web' }]);
    const api = memberDir(ws, 'api');
    memberDir(ws, 'web');
    const target = path.join(api, 'src', 'main.ts');
    // file-read is exactly the class `targetsMayReanchor` withholds: it refuses
    // to let a read ADOPT another project. Moving from a container down to a
    // member it registered is not adoption, and the fence's own anchoring is
    // what has to say so.
    const scope = resolveToolScope(ctx(ws, 'Read', 'file-read', { file_path: target }, { filePath: target }));
    assert.equal(scope.projectRoot, api, 'a read must still resolve to the member that owns its target');
    assert.equal(scope.workspace.kind, 'member');
    assert.equal(workspaceMemberRefusal(scope), null);
  });
});

test('a path OUTSIDE the container does not make a member-owned call unresolved', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }]);
    const api = memberDir(ws, 'api');
    // The member write is LAST so the resolver's own preference (the last
    // external target) still lands inside the workspace; `/etc/hosts` survives
    // in `targets`, which is where the fence would see it. Whether a call may
    // touch a foreign absolute path at all is the workspace-boundary guard's
    // question, and answering it here would refuse an owned member write.
    const command = `cat /etc/hosts && touch ${path.join(api, 'src', 'main.ts')}`;
    const scope = resolveToolScope(ctx(ws, 'Bash', 'shell', { command }, { command }));
    assert.ok(scope.targets.some((target) => target.path === '/etc/hosts'),
      'fixture guard: the foreign operand must actually reach the fence as a target');
    assert.equal(scope.workspace.kind, 'member',
      'a foreign operand alongside an owned member write must not unresolve the member');
    assert.equal(scope.projectRoot, api);
  });
});

// ── 3. the refusal, in all four shapes ───────────────────────────────────────

function refuse(scope: ReturnType<typeof resolveToolScope>): { reason: string; denyTarget: string } {
  const refusal = workspaceMemberRefusal(scope);
  assert.ok(refusal, 'expected the member fence to refuse this call');
  assert.equal(refusal!.denyId, 'workspace-member-unresolved');
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(refusal!.reason),
    `an un-substituted variable survived into the render: ${refusal!.reason}`);
  return { reason: refusal!.reason, denyTarget: refusal!.denyTarget };
}

test('a call at the container itself is refused, naming the workspace and its members', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }, { path: 'web' }]);
    memberDir(ws, 'api');
    memberDir(ws, 'web');
    const { reason, denyTarget } = refuse(resolveToolScope(writeTo(ws, path.join(ws, 'README.md'))));
    assert.ok(reason.includes(ws), 'the workspace root is named');
    assert.ok(reason.includes(path.join(ws, 'README.md')) || reason.includes(ws), 'the target is named');
    assert.ok(reason.includes('api') && reason.includes('web'), 'the registered members are listed');
    assert.match(reason, /Re-issue this call against exactly one of them/);
    assert.ok(denyTarget.length > 0, 'the refusal carries a denyTarget');
  });
});

// A CONTAINER NESTED IN A CONTAINER, which is reachable rather than exotic:
// `blockingCommittedMode` returns '' for a directory whose only mode is
// `workspace`, so registering members inside a directory that is itself a
// registered member is permitted, and flow.ts's container onboarding carries a
// `depth` parameter because the nesting is anticipated. Report the inner one
// with the OUTER's registry and `workspaceAnchoring` finds it in the outer's
// member list and answers `member` — a workspace root that every gate would
// then mint a plan, run state and role claims at, which is the exact state
// `writeWorkspaceMemberRegistry` refuses to create ("a container is not an
// upgrade of a project").
//
// TWO different guards answer this, at two different points in the same walk,
// and they are pinned SEPARATELY below rather than by one shared assertion —
// the previous arrangement ran three shapes through one `assert` line, so both
// guards failed at the same file:line and a regression could not say which door
// had opened. Each door now has its own test, its own message, and a fixture
// guard pinning the precondition that routes its shapes to it.
//
//   DOOR A — the acceptance clause's `!container` skip, taken when the walk
//     STOPS at the inner container. It stops there when the inner container
//     would be returned by the leak test on its own terms, i.e. it owns a
//     project marker and no enclosing declaration disqualifies it.
//   DOOR B — `handDownToMember`'s own-registry arm, taken when the walk climbs
//     PAST the inner container and the outer's redirect hands it back down.
//     Two ways to force that: the outer declaring package-manager workspaces
//     (so the inner fails the leak test), or the inner owning no project marker.

/** Everything both doors assert about a container registered inside a container. */
function nestedContainers(root: string, opts: { outerDeclares: boolean; innerMarker: boolean }): {
  outer: string; inner: string; app: string;
} {
  const outer = path.join(root, 'outer');
  writeState(outer, { mode: 'workspace', onboardingComplete: true, workspaceMembers: [{ path: 'inner' }] });
  write(path.join(outer, 'package.json'),
    `${JSON.stringify(opts.outerDeclares ? { name: 'outer', workspaces: ['inner'] } : { name: 'outer' })}\n`);
  fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
  const inner = path.join(outer, 'inner');
  writeState(inner, { mode: 'workspace', onboardingComplete: true, workspaceMembers: [{ path: 'app' }] });
  if (opts.innerMarker) write(path.join(inner, 'package.json'), `${JSON.stringify({ name: 'inner' })}\n`);
  return { outer, inner, app: memberDir(inner, 'app') };
}

/** The half both doors share: the inner container is answered by ITS OWN registry. */
function assertInnerAnsweredByItsOwnRegistry(inner: string, app: string, door: string): void {
  const atInner = resolveToolScope(writeTo(inner, path.join(inner, 'README.md')));
  assert.equal(atInner.projectRoot, inner,
    `${door}: the ROOT must not move — retention asks resolveProjectRoot(dir) !== dir and deletes on a yes`);
  const { reason } = refuse(atInner);
  assert.ok(reason.includes('app'),
    `${door}: refused against ITS OWN registry — naming the outer's members would mean the outer answered`);

  // And the fence still works INSIDE it: the inner container owns `app`, so a
  // write there anchors to `app` with the inner container carried, not the outer.
  const intoApp = resolveToolScope(writeTo(inner, path.join(app, 'src', 'main.ts')));
  assert.equal(intoApp.projectRoot, app);
  assert.equal(intoApp.workspace.kind, 'member');
  assert.equal(intoApp.workspace.kind === 'member' ? intoApp.workspace.container : '', inner,
    `${door}: the member belongs to the container that registered it, which is the inner one`);
  assert.equal(workspaceMemberRefusal(intoApp), null);
}

test("DOOR A — the acceptance clause's `!container` skip: the walk STOPS at the inner container", () => {
  withRoot((root) => {
    const { outer, inner, app } = nestedContainers(root, { outerDeclares: false, innerMarker: true });
    // FIXTURE GUARD for this door: nothing may disqualify the inner container
    // from being returned where the walk meets it, or the shape silently
    // migrates to door B and this test stops measuring its own guard.
    assert.equal(resolveProjectRootDetailed(inner).workspaceContainer, inner,
      'FIXTURE the walk must reach the inner container itself, not be handed down to it');
    assert.equal(fs.existsSync(path.join(inner, 'package.json')), true,
      'FIXTURE the inner container owns a project marker, which is what lets the walk stop there');
    assert.equal(JSON.parse(fs.readFileSync(path.join(outer, 'package.json'), 'utf8')).workspaces, undefined,
      'FIXTURE the outer declares no package-manager workspaces, so the inner survives the leak test');

    const atInner = resolveToolScope(writeTo(inner, path.join(inner, 'README.md')));
    assert.notEqual(atInner.workspace.kind, 'member',
      'the `!container` skip is the guard here: without it the acceptance clause reports the inner container'
      + ' with the OUTER registry, workspaceAnchoring finds it in the outer\'s member list, and every gate'
      + ' mints a plan, run state and role claims at a workspace root');
    assertInnerAnsweredByItsOwnRegistry(inner, app, 'door A');
  });
});

const HANDED_DOWN_SHAPES = [
  { id: 'outer declares package-manager workspaces', outerDeclares: true, innerMarker: true },
  { id: 'inner owns no project marker', outerDeclares: false, innerMarker: false },
] as const;

for (const shape of HANDED_DOWN_SHAPES) {
  test(`DOOR B — handDownToMember's own-registry arm: the walk climbs PAST the inner container (${shape.id})`, () => {
    withRoot((root) => {
      const { inner, app } = nestedContainers(root, shape);
      // FIXTURE GUARD for this door: the walk must NOT be able to stop at the
      // inner container, so the outer's redirect is the only thing that can
      // name it — which is the arm this test exists for.
      const disqualified = shape.outerDeclares || !fs.existsSync(path.join(inner, 'package.json'));
      assert.equal(disqualified, true,
        'FIXTURE this shape must prevent the walk from stopping at the inner container');

      const atInner = resolveToolScope(writeTo(inner, path.join(inner, 'README.md')));
      assert.notEqual(atInner.workspace.kind, 'member',
        'the own-registry arm is the guard here: without it the hand-down reports the inner container with'
        + ' the OUTER registry, and the fence answers `member` for a workspace root');
      assertInnerAnsweredByItsOwnRegistry(inner, app, `door B (${shape.id})`);
    });
  });
}

// The hand-down asks `committedProjectState` and NOT `readWorkspaceMemberRegistry`,
// and the difference is visible on exactly one input: a member whose own
// `.one.json` is ILLEGIBLE. Pinned because the argument for the choice was
// written down at length and held to account by nothing — swapping the two reads
// left every test in this tree green, so the reasoning was decoration.
//
// With `committedProjectState`, an unreadable member state answers "not a
// container" and the member is handed down normally, carrying the container that
// registered it. With the registry reader it answers `illegible`, which is not
// `none`, so the member would be reported as a container in its own right and
// every call inside it refused — a new deny for a merge conflict in a member's
// state file, which is a routine event.
test('a member whose own state is ILLEGIBLE is still a member, not a container nobody can write in', () => {
  withRoot((root) => {
    const outer = path.join(root, 'outer');
    writeState(outer, { mode: 'workspace', onboardingComplete: true, workspaceMembers: [{ path: 'inner' }] });
    write(path.join(outer, 'package.json'), `${JSON.stringify({ name: 'outer', workspaces: ['inner'] })}\n`);
    fs.mkdirSync(path.join(outer, '.git'), { recursive: true });
    const inner = memberDir(outer, 'inner');
    write(path.join(inner, '.traffic-one', '.one.json'), '{ "mode": "new-pro\n');

    const detailed = resolveProjectRootDetailed(inner);
    assert.equal(detailed.root, inner, 'the root is the member, as it is for any other member');
    assert.equal(detailed.workspaceContainer, outer,
      'and the container carried is the one that REGISTERED it — reading the registry here instead would'
      + ' report the member as its own container on the strength of a file nobody could read');
    assert.equal(detailed.workspaceRegistry?.kind, 'members',
      'the registry carried is the outer\'s member list, never an `illegible` verdict about the member itself');

    const scope = resolveToolScope(writeTo(inner, path.join(inner, 'src', 'main.ts')));
    assert.equal(scope.projectRoot, inner);
    assert.equal(scope.workspace.kind, 'member');
    assert.equal(workspaceMemberRefusal(scope), null,
      'a torn `.one.json` in a member must not refuse every write inside it');
  });
});

test('a target in an UNREGISTERED subdirectory is refused with the same shape', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }]);
    memberDir(ws, 'api');
    const stray = path.join(ws, 'docs', 'notes.md');
    const { reason } = refuse(resolveToolScope(writeTo(ws, stray)));
    assert.ok(reason.includes(stray) || reason.includes(path.dirname(stray)), 'the stray path is named');
    assert.ok(reason.includes('api'), 'the members it could have used are listed');
  });
});

test('a call spanning two members is refused, counting and naming both', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }, { path: 'web' }]);
    const api = memberDir(ws, 'api');
    const web = memberDir(ws, 'web');
    const scope = resolveToolScope(ctx(ws, 'Write', 'file-write', {
      paths: [path.join(api, 'src', 'a.ts'), path.join(web, 'src', 'b.ts')],
    }));
    const { reason } = refuse(scope);
    assert.match(reason, /spans 2 members/);
    assert.ok(reason.includes('api') && reason.includes('web'), 'both members are named');
    assert.match(reason, /Split it into one call per member/);
  });
});

// ── OVERLAPPING ENTRIES, OVER THE WHOLE MATRIX ───────────────────────────────
//
// A workspace may register both a directory and a subdirectory of it, and the
// deeper entry wins for anything inside it. One fixture is not enough to say
// that, and the single fixture that used to stand here is the reason this is a
// matrix now: it wrote `workspaces: ['apps']` at the container, and that one key
// is what let the resolution walk climb past the shallower member after the
// deeper-member guard declined. Delete the key and the same test shape becomes
// a REGRESSED one — the walk stopped at the shallower member, and the two exits
// below the guard both answer with `container: ''`, so `scope.workspace.kind`
// came back `'none'` and the fence could not refuse anything:
//
//   overlapping entry  root   container  kind        cross-member span
//   absent             apps   ws         unresolved  REFUSED
//   present            apps   ''         none        ALLOWED
//
// Over the four axes below, the guard as first written moved 6 of 12 rows: 3
// fixed and 3 regressed. Each cell therefore asserts BOTH halves — the root
// (attribution: which member owns the plan, the run state and the role claims)
// and the fence (whether a genuinely cross-member call is refused) — because the
// defect was to get one right while silently dropping the other.
//
// THE AXES. `memberDeclares` implies `memberMarker`, since a `workspaces` array
// lives inside package.json; that is what makes 2 x 3 x 2 twelve rows and not
// sixteen. Every row registers `apps`, `apps/web` and `other`, onboards `apps`
// and `other`, and asks about a file inside `apps/web`.
const OVERLAP_SHAPES = [false, true].flatMap((containerDeclares) => (
  ([[false, false], [true, false], [true, true]] as const).flatMap(([memberMarker, memberDeclares]) => (
    [false, true].map((deeperOnboarded) => ({
      label: `container${containerDeclares ? '' : ' does not'} declare`
        + `, member ${memberMarker ? 'owns a marker' : 'owns none'}${memberDeclares ? ' and declares' : ''}`
        + `, deeper member ${deeperOnboarded ? 'onboarded' : 'stateless'}`,
      containerDeclares,
      memberMarker,
      memberDeclares,
      deeperOnboarded,
    }))
  ))
));

test('overlapping entries: every shape anchors to the deeper member AND keeps the fence armed', () => {
  assert.equal(OVERLAP_SHAPES.length, 12, 'the matrix must still be the full 12 shapes');
  for (const shape of OVERLAP_SHAPES) {
    withRoot((root) => {
      const ws = container(root, [{ path: 'apps' }, { path: 'apps/web' }, { path: 'other' }]);
      write(path.join(ws, 'package.json'),
        `${JSON.stringify(shape.containerDeclares ? { name: 'ws', workspaces: ['apps'] } : { name: 'ws' })}\n`);
      fs.mkdirSync(path.join(ws, '.git'), { recursive: true });

      const apps = path.join(ws, 'apps');
      if (shape.memberMarker) {
        write(path.join(apps, 'package.json'),
          `${JSON.stringify(shape.memberDeclares ? { name: 'apps', workspaces: ['web'] } : { name: 'apps' })}\n`);
      }
      write(path.join(apps, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
      writeState(apps, { mode: 'new-project', stack: 'default', onboardingComplete: true });

      const web = memberDir(apps, 'web');
      if (shape.deeperOnboarded) writeState(web, { mode: 'new-project', stack: 'default', onboardingComplete: true });
      const other = memberDir(ws, 'other');
      writeState(other, { mode: 'new-project', stack: 'default', onboardingComplete: true });

      // ATTRIBUTION. Asked of the resolver directly as well as through the tool
      // scope, because the 16 hook entry points that call
      // `resolveProjectRoot(ctx.cwd, …)` — session start, prompt submit, the
      // model gate, subagent bind, graphify, page-speed, the onboarding-gate
      // stop, doctor, the cleanup and reset runners — never build a scope at all,
      // and it is their answer the regression moved.
      const detailed = resolveProjectRootDetailed(path.join(web, 'src'));
      assert.equal(detailed.root, web, `${shape.label}: the deeper member owns work inside it`);
      assert.equal(detailed.workspaceContainer, ws,
        `${shape.label}: the container must be carried, or every consumer of the fence goes quiet`);
      assert.equal(detailed.workspaceRegistry?.kind, 'members', shape.label);

      const intoWeb = resolveToolScope(writeTo(ws, path.join(web, 'src', 'main.ts')));
      assert.equal(intoWeb.projectRoot, web, shape.label);
      assert.equal(intoWeb.workspace.kind, 'member', shape.label);
      assert.equal(intoWeb.workspace.kind === 'member' ? intoWeb.workspace.container : '', ws, shape.label);
      assert.equal(workspaceMemberRefusal(intoWeb), null, `${shape.label}: a single-member call is not refused`);

      const intoApps = resolveToolScope(writeTo(ws, path.join(apps, 'src', 'main.ts')));
      assert.equal(intoApps.projectRoot, apps,
        `${shape.label}: and the shallower member still owns everything else under it`);

      // THE FENCE. Two genuinely different members, in both target orders — the
      // resolver anchors on the LAST target, so a one-order assertion passes
      // while half the population is unfenced.
      for (const targets of [
        [path.join(web, 'src', 'main.ts'), path.join(other, 'src', 'main.ts')],
        [path.join(other, 'src', 'main.ts'), path.join(web, 'src', 'main.ts')],
      ]) {
        const { reason } = refuse(resolveToolScope(ctx(ws, 'Write', 'file-write', { paths: targets })));
        assert.match(reason, /spans 2 members/, `${shape.label}: ${path.basename(path.dirname(targets[1]!))} last`);
      }

      // And the deepest-match rule the registry side implements: reverse the
      // scan and both targets collapse onto the shallower member, so a call
      // crossing them looks single-member and is allowed.
      const { reason } = refuse(resolveToolScope(ctx(ws, 'Write', 'file-write', {
        paths: [path.join(apps, 'src', 'main.ts'), path.join(web, 'src', 'main.ts')],
      })));
      assert.match(reason, /spans 2 members/, shape.label);
    });
  }
});

// The COUNTING side of the identity rule the matcher applies. Two spellings of
// one directory are one member, so a call touching both spans one member and is
// not refused — and the count in the refusal text, when there is one, is a count
// of directories rather than of strings.
test('two spellings of ONE member directory are one member, not a span of two', () => {
  withRoot((root) => {
    const probe = path.join(root, 'CaseProbe');
    fs.mkdirSync(probe, { recursive: true });
    const folds = fs.existsSync(path.join(root, 'caseprobe'));
    fs.rmSync(probe, { recursive: true, force: true });

    const ws = container(root, [{ path: 'api' }, { path: 'web' }]);
    const api = memberDir(ws, 'api');
    const web = memberDir(ws, 'web');
    const spanOneDir = ctx(ws, 'Write', 'file-write', {
      paths: [path.join(api, 'src', 'main.ts'), path.join(ws, 'Api', 'src', 'other.ts')],
    });
    if (folds) {
      const scope = resolveToolScope(spanOneDir);
      assert.equal(scope.workspace.kind, 'member',
        'both targets are in one directory on this volume, so the call names exactly one member');
      assert.equal(workspaceMemberRefusal(scope), null,
        'the fence counted two spellings as two members and refused a single-member call');
    } else {
      // On a case-sensitive volume `<ws>/Api` really is a second, unregistered
      // directory, and the refusal is the correct answer — the same one rule.
      const { reason } = refuse(resolveToolScope(spanOneDir));
      assert.match(reason, /not part of any member/);
    }
    // And two genuinely different members are still two, whatever the volume does.
    const { reason } = refuse(resolveToolScope(ctx(ws, 'Write', 'file-write', {
      paths: [path.join(api, 'src', 'main.ts'), path.join(web, 'src', 'main.ts')],
    })));
    assert.match(reason, /spans 2 members/);
  });
});

test('a workspace that registers nobody is refused, and does not tell the agent to retry', () => {
  withRoot((root) => {
    const ws = container(root, []);
    const { reason } = refuse(resolveToolScope(writeTo(ws, path.join(ws, 'README.md'))));
    assert.ok(reason.includes(ws));
    assert.match(reason, /registered no member projects/);
    assert.match(reason, /Report it to the user as BLOCKED/);
    // The trap this shape exists to avoid: prescribing a retry that cannot
    // succeed, because registering a member is not something a tool call does.
    assert.ok(!/Re-issue this call against/.test(reason));
  });
});

test('an unenumerable registry names the WORKSPACE, not the subpath it cannot attribute', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: '../escape' }]);
    const deep = path.join(ws, 'docs', 'notes.md');
    const { reason, denyTarget } = refuse(resolveToolScope(writeTo(ws, deep)));
    // With nobody enumerable, no claim about a SUBPATH is warranted — the
    // workspace is the whole of what is known. The other three shapes name the
    // anchors instead, and in the common shape anchor and container coincide,
    // so only a deep target can tell the two behaviours apart.
    assert.equal(denyTarget, ws, 'the refusal must name the workspace it could not read');
    assert.ok(!reason.includes(path.join(ws, 'docs')), 'a subpath it cannot attribute must not be named');
  });
});

test('an unenumerable registry is refused with WHY, and never tells an agent to edit the sidecar', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: '../escape' }]);
    const { reason } = refuse(resolveToolScope(writeTo(ws, path.join(ws, 'README.md'))));
    assert.match(reason, /member registry could not be read/);
    assert.ok(reason.includes('workspaceMembers'), 'the registry key that failed is quoted');
    assert.match(reason, /runtime-owned state/);
    assert.match(reason, /Report this to the user as BLOCKED/);
    assert.ok(!/edit|repair it yourself|fix .one.json/i.test(reason.split('Report this')[0] ?? '')
      || /nothing here for you to repair/.test(reason),
    'the prose must not prescribe hand-editing a runtime-owned sidecar');
  });
});

// ── the refusal reaches a real gate ──────────────────────────────────────────

test('a real gate refuses at the container and mints no state there', () => {
  withRoot((root) => {
    const ws = container(root, [{ path: 'api' }]);
    memberDir(ws, 'api');
    const command = 'npm install left-pad';
    const before = fs.readdirSync(path.join(ws, '.traffic-one')).sort();
    const result = libraryAllowlistGate(ctx(ws, 'Bash', 'shell', { command }, { command }));
    assert.equal(result.kind, 'deny');
    assert.equal((result as { denyId?: string }).denyId, 'workspace-member-unresolved');
    assert.deepEqual(fs.readdirSync(path.join(ws, '.traffic-one')).sort(), before,
      'a refused gate must not create run state in the container it refused to operate on');
    // The same command inside the member is the fence's own prescribed recovery,
    // and it must not draw this refusal.
    const inMember = libraryAllowlistGate(
      ctx(path.join(ws, 'api'), 'Bash', 'shell', { command }, { command }),
    );
    assert.notEqual((inMember as { denyId?: string }).denyId, 'workspace-member-unresolved');
  });
});

// ── the request path, which runs BEFORE any gate can refuse ──────────────────

// The census found the one place the handler-level fence cannot reach:
// core/dispatch.ts records host capability into `.traffic-one/runs/<id>/` from
// the request path, before runPipeline, so a fence living only in the gates
// would leave a run sidecar minted in the container anyway — and afterwards it
// is indistinguishable from a member's own. The member case is asserted FIRST,
// so a fixture that quietly stopped observing at all (a missing currentRunId is
// enough) fails loudly instead of passing this vacuously.
//
// The DECISION LOG is the deliberate exception, and it is asserted as present
// rather than left unmentioned: a refusal has to be recorded to be a refusal —
// deny-repeat escalation keys on it — and there is by definition no member to
// attribute the record to, since not naming one is the thing being refused. So
// the container may hold the evidence that enforcement RAN, and must not hold
// the evidence that a project run EXISTS there.
async function dispatchWrite(cwd: string): Promise<void> {
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: path.join(cwd, 'src', 'main.ts'), content: 'x' },
    cwd,
  });
  await dispatch(makeClaudeAdapter('claude'), [], { stdin, argv: [] });
}

test('dispatch records host capability in a member, and NOT in the container', async () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const root = fs.realpathSync(created);
  try {
    resetAuthoringRootCache();
    const ws = container(root, [{ path: 'api' }]);
    const api = memberDir(ws, 'api');
    // Both roots carry a run, because the observation no-ops without one.
    writeState(api, { onboardingComplete: true, currentRunId: 'run-member' });
    writeState(ws, {
      mode: 'workspace', onboardingComplete: true, workspaceMembers: [{ path: 'api' }], currentRunId: 'run-ws',
    });

    const capability = (root: string, runId: string): string =>
      path.join(root, '.traffic-one', 'runs', runId, RUN_HOST_CAPABILITY_RELATIVE_FILE);

    await dispatchWrite(api);
    assert.ok(fs.existsSync(capability(api, 'run-member')),
      'baseline: dispatch must observe host capability in an ordinary member run');

    await dispatchWrite(ws);
    assert.equal(fs.existsSync(capability(ws, 'run-ws')), false,
      'dispatch must not mint run state in a workspace container the pipeline would refuse');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
});

// ── 4. the render space ──────────────────────────────────────────────────────

// A dropped variable is invisible in a single-render test and fatal in
// aggregate: it collapses N distinct inputs onto one text, and deny-repeat.ts
// signs a refusal as denyTarget PLUS the whole rendered reason, so two inputs
// that render identically share one escalation bucket and an agent making real
// progress across them gets told it is looping. Measure the collapse directly.
function renderCells(root: string): string[] {
  const cells: string[] = [];
  for (const wsName of ['ws-one', 'ws-two']) {
    const base = path.join(root, wsName);
    fs.mkdirSync(base, { recursive: true });
    const cases: Array<{ members: unknown; targets: string[] }> = [
      { members: [{ path: 'api' }, { path: 'web' }], targets: ['README.md'] },
      { members: [{ path: 'api' }, { path: 'web' }], targets: ['docs/notes.md'] },
      { members: [{ path: 'api' }, { path: 'web' }], targets: ['api/src/a.ts', 'web/src/b.ts'] },
      { members: [{ path: 'api' }, { path: 'svc' }], targets: ['README.md'] },
      { members: [{ path: 'api' }, { path: 'svc' }], targets: ['api/src/a.ts', 'svc/src/b.ts'] },
      { members: [], targets: ['README.md'] },
      { members: [], targets: ['docs/notes.md'] },
      { members: [{ path: '../escape' }], targets: ['README.md'] },
      { members: 'not-an-array', targets: ['README.md'] },
    ];
    for (const [index, spec] of cases.entries()) {
      const ws = path.join(base, `c${index}`);
      writeState(ws, { mode: 'workspace', onboardingComplete: true, workspaceMembers: spec.members });
      for (const member of ['api', 'web', 'svc']) memberDir(ws, member);
      const abs = spec.targets.map((rel) => path.join(ws, rel));
      const scope = resolveToolScope(abs.length === 1
        ? writeTo(ws, abs[0]!)
        : ctx(ws, 'Write', 'file-write', { paths: abs }));
      const refusal = workspaceMemberRefusal(scope);
      assert.ok(refusal, `case ${wsName}/${index} must be refused`);
      cells.push(refusal!.reason);
    }
  }
  return cells;
}

test('render space: every distinct input renders a distinct refusal', () => {
  withRoot((root) => {
    const cells = renderCells(root);
    const distinct = new Set(cells);
    assert.equal(distinct.size, cells.length,
      `${cells.length} distinct inputs collapsed to ${distinct.size} distinct texts — a variable is not`
      + ' interpolated, which merges the deny-repeat escalation buckets of the inputs that collapsed');
    for (const cell of cells) {
      assert.ok(!/\{\{[A-Z_]+\}\}/.test(cell), `un-substituted variable in: ${cell}`);
    }
  });
});

// ── the verbatim fallback contract ───────────────────────────────────────────

// A MISSING T1BLOCK must never disable enforcement, which the fallback already
// guarantees. A DIVERGENT one is the subtler failure: an install with src/
// stripped would then refuse with different words than the authoring checkout,
// and no test would notice. Read both and require them equal.
function fallbackConstants(): Map<string, string> {
  const file = path.join(REPO_ROOT, 'src', 'shared', 'tool-scope.ts');
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Expression): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literal(node.left);
      const right = literal(node.right);
      return left === null || right === null ? null : left + right;
    }
    return null;
  };
  const out = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && /^MEMBER_[A-Z]+_FALLBACK$/.test(node.name.text) && node.initializer) {
      const text = literal(node.initializer);
      if (text !== null) out.set(node.name.text, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

test('every member-fence T1BLOCK matches its TypeScript fallback verbatim', () => {
  const skillFile = path.join(REPO_ROOT, 'src', 'modules', 'session', 'skill', 'SKILL.md');
  const skill = fs.readFileSync(skillFile, 'utf8');
  const fallbacks = fallbackConstants();
  const pairs: Array<[string, string]> = [
    ['workspace-member-unresolved-outside', 'MEMBER_OUTSIDE_FALLBACK'],
    ['workspace-member-unresolved-split', 'MEMBER_SPLIT_FALLBACK'],
    ['workspace-member-unresolved-empty', 'MEMBER_EMPTY_FALLBACK'],
    ['workspace-member-unresolved-registry', 'MEMBER_REGISTRY_FALLBACK'],
  ];
  assert.equal(fallbacks.size, pairs.length,
    `found ${fallbacks.size} MEMBER_*_FALLBACK constants, expected ${pairs.length} — add the new one here`);
  for (const [blockName, constant] of pairs) {
    const block = extractBlock(skill, blockName);
    assert.ok(block, `SKILL.md has no T1BLOCK named ${blockName}`);
    assert.equal(block, fallbacks.get(constant),
      `${blockName} in SKILL.md and ${constant} in tool-scope.ts have drifted apart`);
  }
});

// ── the enumeration ──────────────────────────────────────────────────────────

// "Nothing warns you" is the failure mode this whole item exists to close, and
// a fence added to nine gates by hand is exactly the shape that grows a tenth
// gate without one. Read the call graph rather than trusting the diff: every
// production file that CALLS resolveToolScope must also call
// workspaceMemberRefusal, and each exception has to be listed BY NAME with its
// reason, so a tenth consumer fails here instead of shipping unfenced.
const FENCE_EXEMPT: Record<string, string> = {
  // Defines both; the fence is resolved here.
  'src/shared/tool-scope.ts': 'the definition site',
  // Enforces the HOST workspace boundary, never the project root — see the
  // comment at its own resolveToolScope call.
  'src/modules/session/workspace-boundary-guard.ts': 'boundary guard, does not operate on the project root',
};

function productionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionFiles(full, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function callees(file: string): Set<string> {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

test('every gate that resolves a tool scope also asks the member fence', () => {
  const consumers: string[] = [];
  const unfenced: string[] = [];
  for (const file of productionFiles(path.join(REPO_ROOT, 'src'))) {
    const names = callees(file);
    if (!names.has('resolveToolScope')) continue;
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    consumers.push(rel);
    if (!names.has('workspaceMemberRefusal') && !(rel in FENCE_EXEMPT)) unfenced.push(rel);
  }
  assert.ok(consumers.length >= 10,
    `expected at least 10 resolveToolScope consumers, found ${consumers.length} — the AST walk may be broken`);
  assert.deepEqual(unfenced, [],
    `${unfenced.length} gate(s) resolve a tool scope without asking the member fence, so they would operate on a`
    + ` workspace container:\n  ${unfenced.join('\n  ')}\n`
    + 'Add the two-line refusal after the standsDown check, or list the file in FENCE_EXEMPT with its reason.');
  // Non-vacuity: an exemption that no longer names a real consumer is a stale
  // hole, not a harmless line.
  for (const exempt of Object.keys(FENCE_EXEMPT)) {
    assert.ok(consumers.includes(exempt), `FENCE_EXEMPT lists ${exempt}, which no longer resolves a tool scope`);
  }
});
