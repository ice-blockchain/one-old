// THE CONSUMERS THAT PAY FOR AN OVERLAPPING REGISTRY.
//
// `resolveToolScope` is not the only reader of the resolution walk, and it is not
// even the majority one. Twenty-one sites across production source resolve a
// working directory DIRECTLY — session start, the model gate, subagent bind, the
// agent recorder, the Cursor failure paths, graphify, page-speed, the
// onboarding-gate stop, the workspace boundary guard, the Devin/Windsurf entry,
// the two materialize write paths, the two OpenCode delegation entries and the
// reset runner — and every one of them takes the answer as "the project this call
// is operating on": where the plan lives, where run state is minted, which
// manifest is read, whose role claims are staked. Prompt submit still resolves,
// but through `sessionProjectRoot` (census row: `session-start-setup.ts`), not a
// direct `resolveProjectRoot(ctx.cwd)` of its own. None of them builds a tool
// scope, so no fence test covers them, and until this file existed NO test
// exercised any of them against a registry with overlapping entries — the one
// registry shape where the walk's answer moved.
//
// ── WHAT THE ENUMERATION COVERS, since the enumeration is the claim ──────────
//
// IT SEES THROUGH A LOCAL ALIAS, and it did not: the pattern used to require the
// literal `ctx.cwd` at the call, so `src/hooks/devin-entry.ts` — which lifts the
// hook payload's cwd into a local and resolves through THAT, then uses the
// answer for an onboarding read, a phase decision and a state read — was a
// member of the population that the census of that population could not see. The
// behaviour was covered by the shapes below; the count was not, and the count is
// what this test asserts.
//
// IT NOW SCANS ALL OF `src/**`, which is a widening from `src/hooks/**` plus
// `src/modules/**`. That narrower scope was chosen while a runner lane was
// mid-flight — pinning the remainder would have listed a file that lane was about
// to land — and the reason expired when it did. The three sites it was hiding are
// real consumers of the same answer: `runners/opencode/index.ts`,
// `runners/opencode/from-plan.ts` and `runners/traffic-one-reset/index.ts` each
// resolve a CLI-supplied or `process.cwd()` directory and then mint, read or
// DELETE run state under it. All three use the bare `no options` shape, which
// property 2 below already drives.
//
// TWO THINGS ARE STILL EXCLUDED, and each for a stated reason rather than for
// convenience:
//
//   - THE ARGUMENT SHAPE. Production source holds 48 `resolveProjectRoot*` calls;
//     21 of them pass `ctx.cwd` or a local holding it, and those are the ones this
//     file drives. The rest resolve an explicit path that is not the caller's own
//     working directory (`shared/tool-scope.ts` resolves a re-anchored target, and
//     the fence tests own it), so "which project is this call operating in" is not
//     the question they ask.
//   - THE RESOLVER ITSELF. `shared/hook/paths.ts` matches the pattern once, on
//     `resolveProjectRoot`'s own delegation to `resolveProjectRootDetailed`. That
//     is the definition, not a consumer, and counting it would make the census
//     assert against its own subject.
//
// Two properties, because a list and a behaviour rot in different directions:
//
//   1. THE POPULATION IS PINNED. A twenty-second site added later is not covered by
//      anything below unless it uses one of the argument shapes this file drives,
//      so the enumeration fails on a new site and names it.
//   2. EVERY ARGUMENT SHAPE ANSWERS THE DEEPER MEMBER. The sites differ only in
//      whether they pass a ceiling and a file hint, so those three shapes are
//      driven directly rather than by importing fourteen handlers with fourteen
//      sets of preconditions — and the composition is then checked once, for
//      real, through `dispatch`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { dispatch } from '../../core/dispatch';
import { makeClaudeAdapter } from '../../adapters/claude';
import { resetAuthoringRootCache } from '../authoring-root';
import { RUN_HOST_CAPABILITY_RELATIVE_FILE } from '../host/capabilities';
import { resolveProjectRoot, resolveProjectRootDetailed } from '../hook/paths';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const TMP_PREFIX = 't1-direct-root-';

// ── 1. the population ────────────────────────────────────────────────────────

/** Every production `.ts` under src/, skipping tests and test-only trees. */
function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test-environment' || entry.name === 'test-support') continue;
      out.push(...productionFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

// `ctx.cwd` OR a local holding it, and the trailing `[,)]` is what keeps the
// widening from reading prose: a doc comment writes `resolveProjectRoot(cwd=member)`
// and the resolver's own signature writes `resolveProjectRoot(\n  cwd: string,`,
// neither of which is a call.
const DIRECT_SITE_RE = /resolveProjectRoot(?:Detailed)?\(\s*(?:ctx\.cwd|cwd)\s*[,)]/g;

// Recorded as file → count, so both a new file and a second site inside a known
// file are visible. The reason the list is written down rather than merely
// counted: the failure it guards against is a new consumer resolving a root and
// silently attributing a deeper member's work to the shallower one, which
// nothing else in the suite would notice.
// The resolver's own delegation, excluded by path rather than by pattern: see
// the header. A pattern narrow enough to miss it would also miss a real consumer
// spelled the same way.
const RESOLVER_ITSELF = 'src/shared/hook/paths.ts';

const DIRECT_SITES: Readonly<Record<string, number>> = {
  'src/hooks/devin-entry.ts': 1,
  'src/modules/agent-model/choice-reply.ts': 1,
  'src/modules/agent-model/cursor-failure-persist.ts': 1,
  'src/modules/agent-model/cursor-failures.ts': 2,
  'src/modules/agent-model/handler.ts': 1,
  'src/modules/agent-model/model-gate.ts': 2,
  'src/modules/agent-model/record-agent.ts': 1,
  'src/modules/agent-model/subagent-bind.ts': 1,
  'src/modules/graphify/handler.ts': 1,
  'src/modules/graphify/post-build.ts': 1,
  'src/modules/materialize/converge-from-write.ts': 1,
  'src/modules/materialize/post-stack-setup.ts': 1,
  'src/modules/onboarding-gate/stop.ts': 1,
  'src/modules/page-speed/handler.ts': 1,
  'src/modules/session/session-start-setup.ts': 1,
  'src/modules/session/workspace-boundary-guard.ts': 1,
  'src/runners/opencode/from-plan.ts': 1,
  'src/runners/opencode/index.ts': 1,
  'src/runners/traffic-one-reset/index.ts': 1,
};

test('direct resolution sites: the population that reads the walk without a tool scope is pinned', () => {
  const found: Record<string, number> = {};
  for (const file of productionFiles(path.join(REPO_ROOT, 'src'))) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join('/');
    if (relative === RESOLVER_ITSELF) continue;
    const matches = fs.readFileSync(file, 'utf8').match(DIRECT_SITE_RE);
    if (!matches) continue;
    found[relative] = matches.length;
  }
  const total = Object.values(found).reduce((sum, count) => sum + count, 0);
  assert.equal(total, 21, `expected 21 direct resolution sites, found ${total} — the scan may be broken`);
  assert.deepEqual(found, DIRECT_SITES,
    'a hook now resolves the project root directly and is not covered by the shapes below. Add it to this list,'
    + ' and if it passes arguments no row here drives, add the row: an uncovered site attributes a deeper'
    + " member's plan, run state and role claims to the shallower member registered above it.");
});

// ── 2. every argument shape ──────────────────────────────────────────────────

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

function writeState(dir: string, state: unknown): void {
  write(path.join(dir, '.traffic-one', '.one.json'), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * A container registering `apps`, `apps/web` and `other`, with `apps` onboarded
 * and `apps/web` NOT — the arrangement in which the walk stops at the shallower
 * member and never reaches the container's redirect.
 */
function overlapping(root: string, opts: { declares: boolean; deeperOnboarded?: boolean }): {
  ws: string; apps: string; web: string;
} {
  const ws = path.join(root, 'ws');
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  write(path.join(ws, 'package.json'),
    `${JSON.stringify(opts.declares ? { name: 'ws', workspaces: ['apps'] } : { name: 'ws' })}\n`);
  writeState(ws, {
    mode: 'workspace',
    onboardingComplete: true,
    workspaceMembers: [{ path: 'apps' }, { path: 'apps/web' }, { path: 'other' }],
    currentRunId: 'run-ws',
  });
  const apps = path.join(ws, 'apps');
  write(path.join(apps, 'package.json'), `${JSON.stringify({ name: 'apps' })}\n`);
  write(path.join(apps, 'src', 'main.ts'), 'export const boot = (): number => 0;\n');
  writeState(apps, { mode: 'new-project', stack: 'default', onboardingComplete: true, currentRunId: 'run-apps' });
  const web = path.join(apps, 'web');
  write(path.join(web, 'package.json'), `${JSON.stringify({ name: 'web' })}\n`);
  write(path.join(web, 'src', 'main.ts'), 'export const boot = (): number => 1;\n');
  if (opts.deeperOnboarded) {
    writeState(web, { mode: 'new-project', stack: 'default', onboardingComplete: true, currentRunId: 'run-web' });
  }
  return { ws, apps, web };
}

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

test('direct resolution sites: every argument shape resolves a cwd inside the deeper member TO it', () => {
  for (const declares of [false, true]) {
    withRoot((root) => {
      const { ws, web } = overlapping(root, { declares });
      const label = `container ${declares ? 'declares' : 'declares no'} package-manager workspaces`;
      // The three shapes every site above uses, spelled exactly as they spell
      // them. The `ceiling` one is the host-authoritative form (Cursor supplies
      // `workspaceRoot`); `onboarding-gate/stop.ts` and all three runner entries
      // pass nothing; `graphify/handler.ts` adds the tool's file hint.
      for (const [shape, resolve] of [
        ['no options', (cwd: string) => resolveProjectRoot(cwd)],
        ['a ceiling at the host workspace root', (cwd: string) => resolveProjectRoot(cwd, undefined, { ceiling: ws })],
        ['a file hint plus a ceiling',
          (cwd: string) => resolveProjectRoot(cwd, path.join(web, 'src', 'main.ts'), { ceiling: ws })],
      ] as const) {
        for (const cwd of [web, path.join(web, 'src')]) {
          assert.equal(resolve(cwd), web,
            `${label}, ${shape}, cwd ${path.relative(ws, cwd)}: a hook operating here must be told it is in the`
            + ' deeper member — every plan read, run state write and role claim follows this one answer');
        }
      }
      // The same fact the fence needs, which these sites do not read but the
      // gates layered above them do.
      assert.equal(resolveProjectRootDetailed(web, undefined, { ceiling: ws }).workspaceContainer, ws, label);
    });
  }
});

// ── 3. the composition, once, for real ───────────────────────────────────────

async function dispatchWriteInto(cwd: string, target: string): Promise<void> {
  const stdin = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: target, content: 'x' },
    cwd,
  });
  await dispatch(makeClaudeAdapter('claude'), [], { stdin, argv: [] });
}

test('direct resolution sites: a write in the deeper member mints no run state in the shallower one', async () => {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  const root = fs.realpathSync(created);
  try {
    resetAuthoringRootCache();
    const { apps, web } = overlapping(root, { declares: false });
    const capability = (dir: string, runId: string): string =>
      path.join(dir, '.traffic-one', 'runs', runId, RUN_HOST_CAPABILITY_RELATIVE_FILE);

    // BASELINE, so the row cannot pass by the pipeline doing nothing at all: a
    // write in the shallower member does accrue its run state there.
    await dispatchWriteInto(apps, path.join(apps, 'src', 'main.ts'));
    assert.ok(fs.existsSync(capability(apps, 'run-apps')),
      'baseline: dispatch must observe host capability for a write in an onboarded member');
    fs.rmSync(path.join(apps, '.traffic-one', 'runs'), { recursive: true, force: true });

    // The property: work inside the deeper registered member is the deeper
    // member's, so nothing about it may be recorded against `apps`'s run.
    await dispatchWriteInto(web, path.join(web, 'src', 'main.ts'));
    assert.equal(fs.existsSync(capability(apps, 'run-apps')), false,
      "a write inside `apps/web` was attributed to `apps` — its run state, and with it every role claim and"
      + ' plan read, landed in the member registered ABOVE the one that owns the file');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(created, { recursive: true, force: true });
  }
});
