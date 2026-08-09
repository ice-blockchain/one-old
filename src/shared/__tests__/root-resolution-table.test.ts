// Table-driven coverage of every root-resolution incident layout documented in
// the resolver sources. `src/shared/hook/paths.ts` records its incidents INLINE,
// in the comment above each guard, so the table below is harvested from those
// comments (line references are to that file unless another file is named) plus
// `src/shared/project-membership.ts`. Each row names the guard it exercises so a
// guard that is deleted or weakened can be traced to the rows it kills.
//
// Two rules this table lives by:
//
//  1. EVERY ROW READS ITS OWN FIXTURE BACK before the verdict is asserted. A
//     layout builder that stops building what it claims (a renamed marker file,
//     a mkdir that silently no-ops) must fail as a FIXTURE error, not pass
//     vacuously because the resolver happens to return the same string anyway.
//     `readback` is a list of on-disk facts the row's claim depends on.
//
//  2. EVERY ROW MUST BE KILLABLE. A row that no mutation of the walk can turn
//     red is decoration. `guard` records which guard the row is pinning; the
//     mutation matrix in the work-item report lists the mutation that kills it.
//
// This file deliberately overlaps `hook-paths.test.ts`, which asserts the same
// resolver behaviour prose-first, one test per incident. The value here is the
// SHAPE: one row per layout, uniform inputs, a fixture contract, and a single
// place to add the next incident.
//
// NON-CANONICAL INPUTS. The runner realpaths the temp root before a row builds,
// which made every row measure an ALREADY-CANONICAL input — a structural blind
// spot, because most of the spelling-sensitive guards in the resolver family
// (isMachineConfigRoot's symlink-resolved compare, nearestOnboardedRoot's $HOME
// break, and the whole "resolveProjectRoot never realpaths" contract) can only
// be wrong when the input is NOT canonical. `canonicalRoot: false` opts a row
// out of that realpath: the runner builds it an explicit `alias -> real` symlink
// and hands the row the alias. Those rows are marked `[non-canonical]` in their
// incident text and each carries a readback proving the root really is a second
// spelling of one inode, so a fixture that stopped being non-canonical fails as
// a FIXTURE error rather than passing vacuously. Building the symlink ourselves
// is what makes the rows portable — an earlier version leaned on `mkdtempSync`
// returning macOS's `/var/folders/…` alias of `/private/var/folders/…`, which
// FIXTURE-failed all four rows on the ubuntu half of the CI matrix, where `/tmp`
// is already canonical. The canonicalization CONTRACT itself (which resolver
// realpaths and which does not, and why) lives in path-spelling-contract.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveProjectRoot } from '../hook/paths';
import { makeCursorAdapter } from '../../adapters/cursor';
import { workspaceBoundaryGuard } from '../../modules/session/workspace-boundary-guard';
import type { Ctx } from '../../core/types';

const TMP_PREFIX = 't1-rootres-table-';

function writeState(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(json), 'utf8');
}

function writePkg(dir: string, json: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json), 'utf8');
}

function writeFile(file: string, body = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
}

/** An on-disk fact the row's claim depends on. Checked BEFORE the verdict. */
type Readback = readonly [label: string, actual: () => unknown, expected: unknown];

interface Layout {
  /** cwd handed to the resolver. */
  readonly cwd: string;
  /** Optional tool target file. */
  readonly file?: string;
  /** Optional host workspace ceiling, supplied directly. */
  readonly ceiling?: string;
  /**
   * A host `workspace_roots` list instead of a literal ceiling. The row is then
   * driven through the REAL cursor adapter, so the ceiling under test is the one
   * the adapter selects — which is what makes multi-root rows sensitive to the
   * selector rather than to a hand-written ceiling.
   */
  readonly hostRoots?: readonly string[];
  /** With `hostRoots`, the ceiling the adapter is required to select. */
  readonly expectedCeiling?: string;
  /** The root resolution must return. */
  readonly expected: string;
  readonly readback: readonly Readback[];
  /** Env pins this layout needs (restored by the runner). */
  readonly env?: Readonly<Record<string, string>>;
}

interface Row {
  readonly id: string;
  /** Where the incident is documented. */
  readonly incident: string;
  /** The guard this row pins — the thing a mutation must break to kill it. */
  readonly guard: string;
  /**
   * Rows are handed a REALPATH'd temp root by default. Set false to hand the row
   * `mkdtempSync`'s output verbatim — on macOS that is `/var/folders/…`, a
   * symlink to `/private/var/folders/…`, i.e. a non-canonical absolute path for
   * free. See the NON-CANONICAL INPUTS note above the table for why a row would
   * want that.
   */
  readonly canonicalRoot?: false;
  readonly build: (root: string) => Layout;
}

const ROWS: readonly Row[] = [
  {
    id: 'kilo-rootless-target',
    incident: 'paths.ts:21-23 — Kilo\'s OpenCode bridge drops the leading slash from an absolute macOS path',
    guard: 'normalizeHookTargetPath',
    build: (root) => {
      // The enclosing dir is deliberately NOT onboarded: if it were, dropping the
      // repair would still land on it through the cwd walk and the row would pass
      // for the wrong reason.
      const proj = path.join(root, 'proj');
      writeState(proj, { mode: 'new-project' });
      const target = path.join(proj, 'src', 'a.ts');
      writeFile(target);
      return {
        cwd: root,
        file: target.slice(1), // the leading slash Kilo drops
        expected: proj,
        readback: [
          ['target exists', () => fs.existsSync(target), true],
          ['the target path handed in is rootless', () => path.isAbsolute(target.slice(1)), false],
          ['the cwd is NOT onboarded', () => fs.existsSync(path.join(root, '.traffic-one')), false],
          ['only the nested project is', () => JSON.parse(fs.readFileSync(path.join(proj, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'sibling-name-prefix',
    incident: 'paths.ts:46-47 — a sibling dir sharing a name prefix (/repo vs /repo2) must not be treated as inside',
    guard: 'isPathWithin (segment-aware containment)',
    build: (root) => {
      const repo = path.join(root, 'repo');
      const repo2 = path.join(root, 'repo2');
      writeState(repo, { mode: 'new-project' });
      writePkg(repo2, { name: 'repo2' });
      // Ceiling is `repo`; the cwd is the string-prefixed SIBLING `repo2`. A
      // prefix-based containment test would call repo2 "inside" repo and walk it.
      return {
        cwd: repo2,
        ceiling: repo,
        expected: repo, // cwd is out of tree → the ceiling itself (paths.ts:236-241)
        readback: [
          ['repo2 starts with repo as a string', () => repo2.startsWith(repo), true],
          ['repo2 is a sibling, not a child', () => fs.existsSync(path.join(repo, 'repo2')), false],
          ['repo is onboarded', () => JSON.parse(fs.readFileSync(path.join(repo, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'shallow-stray-substate',
    incident: 'paths.ts:60-64 — a sub-package accrues a SHALLOW state file (one-uid only, no mode)',
    guard: 'isOnboardedProjectRoot requires a committed `mode`',
    build: (root) => {
      writeState(root, { mode: 'new-project', onboardingComplete: true });
      const app = path.join(root, 'apps', 'web');
      writeState(app, { 'one-uid': 'stray' });
      const target = path.join(app, 'src', 'main.ts');
      writeFile(target);
      return {
        cwd: app,
        file: target,
        expected: root,
        readback: [
          ['sub-package state has NO mode', () => 'mode' in JSON.parse(fs.readFileSync(path.join(app, '.traffic-one', '.one.json'), 'utf8')), false],
          ['root state HAS a mode', () => JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'state-dir-drift',
    incident: 'paths.ts:80-84 — an agent cd\'d into .traffic-one/skills/<name> and stayed there',
    guard: 'stripStateDirSuffix',
    build: (root) => {
      const drifted = path.join(root, '.traffic-one', 'skills', 'senior-eng-orchestrator');
      fs.mkdirSync(drifted, { recursive: true });
      writeFile(path.join(root, 'src', 'a.ts'));
      return {
        cwd: drifted,
        file: path.join(root, 'src', 'a.ts'),
        expected: root,
        readback: [
          ['cwd is inside the state dir', () => drifted.split(path.sep).includes('.traffic-one'), true],
          ['project is NOT onboarded', () => fs.existsSync(path.join(root, '.traffic-one', '.one.json')), false],
        ],
      };
    },
  },
  {
    id: 'home-stray-state',
    incident: 'paths.ts:95-98 — a stray mode-bearing ~/.traffic-one/.one.json from running the plugin in ~ once',
    guard: 'nearestOnboardedRoot stops at $HOME',
    build: (root) => {
      writeState(root, { mode: 'new-project', onboardingComplete: true }); // root IS the fake home
      const proj = path.join(root, 'work', 'myapp');
      const file = path.join(proj, 'src', 'a.ts');
      writeFile(file);
      return {
        cwd: proj,
        file,
        expected: proj,
        env: { HOME: root },
        readback: [
          ['os.homedir() honours $HOME', () => os.homedir(), root],
          ['home carries a mode-bearing state', () => JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the project has none of its own', () => fs.existsSync(path.join(proj, '.traffic-one')), false],
        ],
      };
    },
  },
  {
    id: 'machine-config-subtree',
    incident: 'paths.ts:106-109 — a stray .traffic-one minted into machine-config space (the stale-bootstrap incident)',
    guard: 'nearestOnboardedRoot stops at isMachineConfigRoot',
    build: (root) => {
      // `<home>/.cursor` is machine-config space (authoring-root.ts HOME_STATE_DIRNAMES).
      const hostState = path.join(root, '.cursor');
      writeState(hostState, { mode: 'new-project', onboardingComplete: true });
      const inside = path.join(hostState, 'projects', 'x', 'terminals');
      fs.mkdirSync(inside, { recursive: true });
      return {
        cwd: inside,
        expected: inside, // never adopts the stray above it
        env: { HOME: root },
        readback: [
          ['os.homedir() honours $HOME', () => os.homedir(), root],
          ['the machine-config dir carries a stray onboarded state', () => JSON.parse(fs.readFileSync(path.join(hostState, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['cwd is inside it', () => inside.startsWith(hostState + path.sep), true],
        ],
      };
    },
  },
  {
    id: 'cursor-double-onboarding',
    incident: 'paths.ts:110-114, 208-211 — a stray onboarded ancestor re-rooted Traffic One above the opened workspace',
    guard: 'opts.ceiling bounds nearestOnboardedRoot',
    build: (root) => {
      writeState(root, { mode: 'new-project', onboardingComplete: true }); // the stray parent
      const ws = path.join(root, 'sub');
      fs.mkdirSync(ws, { recursive: true });
      const outOfTree = path.join(root, '.traffic-one', 'rules', 'common', 'x.md');
      writeFile(outOfTree, '# rules');
      return {
        cwd: ws,
        file: outOfTree,
        ceiling: ws,
        expected: ws,
        readback: [
          ['the parent is onboarded', () => JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the tool target is ABOVE the workspace', () => outOfTree.startsWith(ws + path.sep), false],
          ['the workspace is not onboarded', () => fs.existsSync(path.join(ws, '.traffic-one')), false],
        ],
      };
    },
  },
  {
    id: 'authoring-repo-stray',
    incident: 'paths.ts:115-117 — a mode-bearing .one.json INSIDE the plugin authoring repo',
    guard: 'hasPluginAuthoringMarkers skip',
    build: (root) => {
      writeState(root, { mode: 'existing-codebase', stack: 'minimal' });
      const repo = path.join(root, 'one');
      writeFile(path.join(repo, 'src', 'gen', 'index.ts'), '// gen');
      writePkg(repo, { name: 'traffic-one' });
      writeState(repo, { mode: 'existing-codebase', stack: 'minimal' });
      return {
        cwd: root,
        file: path.join(repo, 'src', 'shared', 'x.ts'),
        expected: root,
        readback: [
          ['the nested repo looks like the plugin source', () => JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).name, 'traffic-one'],
          ['and carries a mode-bearing state', () => JSON.parse(fs.readFileSync(path.join(repo, '.traffic-one', '.one.json'), 'utf8')).mode, 'existing-codebase'],
        ],
      };
    },
  },
  {
    id: 'digests-at-parent',
    incident: 'paths.ts:119-123 — the tests/claude/3 digests-at-parent incident',
    guard: 'nearestOnboardedRoot returns the NEAREST onboarded workspace root',
    build: (root) => {
      writePkg(root, { private: true, workspaces: ['one', 'tests/*'] });
      writeState(root, { mode: 'existing-codebase', onboardingComplete: true });
      const project = path.join(root, 'tests', 'claude', '3');
      writePkg(project, { private: true, workspaces: ['apps/*', 'packages/*'] });
      writeState(project, { mode: 'new-project', onboardingComplete: true });
      const target = path.join(project, 'apps', 'web', 'src', 'main.ts');
      writeFile(target);
      return {
        cwd: path.join(project, 'apps', 'web'),
        file: target,
        expected: project,
        readback: [
          ['the umbrella declares workspaces AND is onboarded', () => Array.isArray(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces) && Boolean(JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode), true],
          ['the nested project does too', () => Array.isArray(JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8')).workspaces) && Boolean(JSON.parse(fs.readFileSync(path.join(project, '.traffic-one', '.one.json'), 'utf8')).mode), true],
        ],
      };
    },
  },
  {
    id: 'packages-ui-leak',
    incident: 'paths.ts:124-127 — the packages/ui incident: a leaked mode-bearing state below the workspace root',
    guard: 'nearestWorkspaceRoot(parent) climb-past',
    build: (root) => {
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
      writeState(root, { mode: 'new-project', onboardingComplete: true });
      const ui = path.join(root, 'packages', 'ui');
      writeState(ui, { mode: 'new-project' }); // the leak
      const target = path.join(ui, 'src', 'index.ts');
      writeFile(target);
      return {
        cwd: ui,
        file: target,
        expected: root,
        readback: [
          ['the sub-package state DOES carry a mode (it looks like a root)', () => JSON.parse(fs.readFileSync(path.join(ui, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the root declares workspaces', () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces.length > 0, true],
        ],
      };
    },
  },
  {
    id: 'go-package-membership',
    incident: 'paths.ts:129-135, 242-249 — mercury/strategies got its own new-project wizard',
    guard: 'projectMembershipRoot fallback',
    build: (root) => {
      const repo = path.join(root, 'mercury');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      writeFile(path.join(repo, 'go.mod'), 'module mercury\n');
      const pkg = path.join(repo, 'strategies');
      const file = path.join(pkg, 'strategy.go');
      writeFile(file, 'package strategies\n');
      return {
        cwd: pkg,
        file,
        expected: repo,
        readback: [
          ['the repo has version control', () => fs.existsSync(path.join(repo, '.git')), true],
          ['nothing is onboarded anywhere', () => fs.existsSync(path.join(repo, '.traffic-one')), false],
          ['the package owns no marker of its own', () => fs.existsSync(path.join(pkg, 'go.mod')), false],
        ],
      };
    },
  },
  {
    id: 'go-deep-package-membership',
    incident: 'paths.ts:129-135, 242-249 — agora/handlers/strategies, the same leak two levels down',
    guard: 'projectMembershipRoot fallback (depth-independent)',
    build: (root) => {
      const repo = path.join(root, 'agora');
      fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
      writeFile(path.join(repo, 'go.mod'), 'module agora\n');
      const deep = path.join(repo, 'handlers', 'strategies');
      const file = path.join(deep, 'h.go');
      writeFile(file, 'package strategies\n');
      return {
        cwd: deep,
        file,
        expected: repo,
        readback: [
          ['the package sits two levels below the repo', () => path.relative(repo, deep).split(path.sep).length, 2],
          ['the repo has version control', () => fs.existsSync(path.join(repo, '.git')), true],
        ],
      };
    },
  },
  {
    id: 'stray-ancestor-manifest',
    incident: 'project-membership.ts:59-63 — a leftover go.mod in ~/Documents hijacked an unrelated multi-repo workspace',
    guard: 'projectMembershipRoot: only VCS lets an ANCESTOR absorb a child',
    build: (root) => {
      writeFile(path.join(root, 'go.mod'), 'module leftover\n'); // manifest, no VCS
      const workspace = path.join(root, 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      return {
        cwd: workspace,
        expected: workspace,
        readback: [
          ['the ancestor has a manifest', () => fs.existsSync(path.join(root, 'go.mod')), true],
          ['but NO version control', () => fs.existsSync(path.join(root, '.git')), false],
          ['the child owns nothing', () => fs.existsSync(path.join(workspace, 'go.mod')), false],
        ],
      };
    },
  },
  {
    id: 'pnpm-workspace-yaml',
    incident: 'paths.ts:147-150 — dirDeclaresWorkspace is lenient: pnpm-workspace.yaml counts too',
    guard: 'dirDeclaresWorkspace (pnpm-workspace.yaml branch)',
    build: (root) => {
      writePkg(root, { name: 'mono2', private: true }); // NO workspaces key
      fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
      const api = path.join(root, 'packages', 'api');
      fs.mkdirSync(api, { recursive: true });
      return {
        cwd: api,
        expected: root,
        readback: [
          ['package.json declares NO workspaces', () => 'workspaces' in JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), false],
          ['pnpm-workspace.yaml is the only signal', () => fs.existsSync(path.join(root, 'pnpm-workspace.yaml')), true],
          ['the sub-package owns no package.json', () => fs.existsSync(path.join(api, 'package.json')), false],
        ],
      };
    },
  },
  {
    id: 'mid-onboarding-workspace-anchor',
    incident: 'paths.ts:162-164, 199-204 — mid-onboarding, before the workspace root has committed a mode',
    guard: 'nearestWorkspaceRoot anchor',
    build: (root) => {
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*', 'apps/*'] });
      const ui = path.join(root, 'packages', 'ui');
      const target = path.join(ui, 'src', 'index.ts');
      writeFile(target);
      return {
        cwd: ui,
        file: target,
        expected: root,
        readback: [
          ['NOTHING is onboarded yet', () => fs.existsSync(path.join(root, '.traffic-one')), false],
          ['the root declares workspaces', () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces.length, 2],
        ],
      };
    },
  },
  {
    id: 'out-of-tree-file-hint',
    incident: 'paths.ts:224-227 — a target file OUTSIDE the authoritative workspace root must not re-root resolution',
    guard: 'fileStart dropped when outside the ceiling',
    build: (root) => {
      const ws = path.join(root, 'ws');
      writePkg(ws, { name: 'ws', private: true, workspaces: ['packages/*'] });
      writeState(ws, { mode: 'new-project', onboardingComplete: true });
      const sibling = path.join(root, 'sibling');
      writeState(sibling, { mode: 'new-project', onboardingComplete: true });
      const foreign = path.join(sibling, 'src', 'a.ts');
      writeFile(foreign);
      return {
        cwd: ws,
        file: foreign,
        ceiling: ws,
        expected: ws,
        readback: [
          ['the sibling is a separate onboarded project', () => JSON.parse(fs.readFileSync(path.join(sibling, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the target is outside the ceiling', () => foreign.startsWith(ws + path.sep), false],
        ],
      };
    },
  },
  {
    id: 'workspace-root-above-ceiling',
    incident: 'paths.ts:173 — nearestWorkspaceRoot must not anchor above the host workspace root either',
    guard: 'the ceiling break inside nearestWorkspaceRoot (distinct from the one in nearestOnboardedRoot)',
    build: (root) => {
      // A monorepo the user did NOT open; Cursor opened only one folder inside it.
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
      const opened = path.join(root, 'packages', 'ui');
      writeFile(path.join(opened, 'src', 'index.ts'));
      return {
        cwd: opened,
        ceiling: opened,
        expected: opened,
        readback: [
          ['an ancestor declares workspaces', () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces.length, 1],
          ['the ancestor is ABOVE the ceiling', () => root.startsWith(opened + path.sep), false],
          ['nothing is onboarded', () => fs.existsSync(path.join(root, '.traffic-one')), false],
        ],
      };
    },
  },
  {
    id: 'cursor-terminals-cwd',
    incident: 'paths.ts:232-236 — a Cursor subagent shell runs with cwd under ~/.cursor/.../terminals',
    guard: 'ceiling fallback when cwdStart is out of tree (paths.ts:236-241)',
    build: (root) => {
      const ws = path.join(root, 'ws');
      writeState(ws, { mode: 'new-project', onboardingComplete: true });
      const terminals = path.join(root, '.cursor', 'projects', 'Users-u-Projects-ws', 'terminals');
      fs.mkdirSync(terminals, { recursive: true });
      return {
        cwd: terminals,
        ceiling: ws,
        expected: ws,
        readback: [
          ['the shell cwd is outside the workspace', () => terminals.startsWith(ws + path.sep), false],
          ['the workspace is onboarded', () => JSON.parse(fs.readFileSync(path.join(ws, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'ceiling-at-monorepo-root',
    incident: 'paths.ts:208-214 — a ceiling AT the monorepo root must not block the sub-package climb TO it',
    guard: 'isPathWithin(current, ceil) admits current === ceil',
    build: (root) => {
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
      writeState(root, { mode: 'new-project', onboardingComplete: true });
      const ui = path.join(root, 'packages', 'ui');
      const target = path.join(ui, 'src', 'index.ts');
      writeFile(target);
      return {
        cwd: ui,
        file: target,
        ceiling: root,
        expected: root,
        readback: [
          ['the ceiling IS the monorepo root', () => fs.existsSync(path.join(root, '.traffic-one', '.one.json')), true],
          ['the cwd is strictly below it', () => ui.startsWith(root + path.sep), true],
        ],
      };
    },
  },
  {
    id: 'multi-root-foreign-ceiling',
    incident: 'NEW — a multi-root window resolved to workspace_roots[0], a DIFFERENT project',
    guard: 'adapters/*.ts activeWorkspaceRoot picks the root containing the cwd',
    build: (root) => {
      const alpha = path.join(root, 'alpha');
      const beta = path.join(root, 'beta');
      for (const p of [alpha, beta]) {
        writeState(p, { mode: 'existing-codebase', 'one-uid': path.basename(p) });
        writePkg(p, { name: path.basename(p) });
        writeFile(path.join(p, 'src', 'x.ts'));
      }
      return {
        cwd: beta,
        file: path.join(beta, 'src', 'x.ts'),
        hostRoots: [alpha, beta],
        expectedCeiling: beta,
        expected: beta,
        readback: [
          ['alpha and beta are separate onboarded projects', () => [alpha, beta].every((p) => JSON.parse(fs.readFileSync(path.join(p, '.traffic-one', '.one.json'), 'utf8')).mode === 'existing-codebase'), true],
          ['alpha is listed FIRST but holds no part of the work', () => path.basename(alpha) < path.basename(beta), true],
        ],
      };
    },
  },
  {
    id: 'multi-root-nested-outermost',
    incident: 'NEW — a multi-root window holding a monorepo AND one of its packages',
    guard: 'adapters/*.ts activeWorkspaceRoot prefers the OUTERMOST containing root',
    build: (root) => {
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
      writeState(root, { mode: 'new-project', onboardingComplete: true });
      const ui = path.join(root, 'packages', 'ui');
      writePkg(ui, { name: 'ui' });
      writeFile(path.join(ui, 'src', 'index.ts'));
      return {
        cwd: ui,
        file: path.join(ui, 'src', 'index.ts'),
        // Listed innermost-first, so a selector that took either the first element
        // or the longest match would pick `ui` and mint a stray root there.
        hostRoots: [ui, root],
        expectedCeiling: root,
        expected: root,
        readback: [
          ['the monorepo root is onboarded and declares workspaces', () => Boolean(JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode) && JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces.length > 0, true],
          ['the sub-package owns a package.json of its own', () => JSON.parse(fs.readFileSync(path.join(ui, 'package.json'), 'utf8')).name, 'ui'],
        ],
      };
    },
  },

  // ── rows measured on NON-CANONICAL inputs ──────────────────────────────────
  // Everything above is measured on a realpath'd root. These are the same
  // resolver, asked the same questions, on the spelling a host actually hands a
  // hook. See the NON-CANONICAL INPUTS note at the top of the file.

  {
    id: 'noncanonical-machine-config-subtree',
    incident: 'authoring-root.ts:125-126 [non-canonical] — "macOS spells the same dir /var/… and /private/var/…, and a symlinked $HOME must not dodge the guard on spelling"',
    guard: 'isMachineConfigRoot compares REALPATHS, not the spelling it was handed',
    canonicalRoot: false,
    build: (root) => {
      // The canonical twin of this layout is `machine-config-subtree` above. The
      // difference is the whole point: with a canonical root the guard's
      // symlink-resolved compare is indistinguishable from a plain string
      // compare, so that row cannot tell whether the resolution survives.
      const hostState = path.join(root, '.cursor');
      writeState(hostState, { mode: 'new-project', onboardingComplete: true });
      const inside = path.join(hostState, 'projects', 'x', 'terminals');
      fs.mkdirSync(inside, { recursive: true });
      return {
        cwd: inside,
        expected: inside, // the stray above it is machine-config space, never adopted
        env: { HOME: root },
        readback: [
          ['the fixture root is NOT canonical', () => root === fs.realpathSync(root), false],
          ['…but names the same inode as its canonical spelling', () => fs.statSync(root).ino === fs.statSync(fs.realpathSync(root)).ino, true],
          ['os.homedir() honours the non-canonical $HOME', () => os.homedir(), root],
          ['the machine-config dir carries a stray onboarded state', () => JSON.parse(fs.readFileSync(path.join(hostState, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'noncanonical-home-stray-state',
    incident: 'paths.ts:95-98 [non-canonical] — the stray mode-bearing ~/.traffic-one/.one.json, reached through a $HOME that is not its own realpath',
    guard: 'nearestOnboardedRoot stops at $HOME when the walk and $HOME are spelled the same way the host spelled them',
    canonicalRoot: false,
    build: (root) => {
      writeState(root, { mode: 'new-project', onboardingComplete: true }); // root IS the fake home
      const proj = path.join(root, 'work', 'myapp');
      const file = path.join(proj, 'src', 'a.ts');
      writeFile(file);
      return {
        cwd: proj,
        file,
        expected: proj,
        env: { HOME: root },
        readback: [
          ['the fixture root is NOT canonical', () => root === fs.realpathSync(root), false],
          ['os.homedir() honours $HOME verbatim', () => os.homedir(), root],
          ['home carries a mode-bearing state', () => JSON.parse(fs.readFileSync(path.join(root, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the project has none of its own', () => fs.existsSync(path.join(proj, '.traffic-one')), false],
        ],
      };
    },
  },
  {
    id: 'noncanonical-packages-ui-leak',
    incident: 'paths.ts:124-127 [non-canonical] — the packages/ui leak, resolved from a cwd the host spelled non-canonically',
    guard: 'nearestWorkspaceRoot(parent) climb-past, AND the exit returning the caller\'s spelling',
    canonicalRoot: false,
    build: (root) => {
      writePkg(root, { name: 'mono', private: true, workspaces: ['packages/*'] });
      writeState(root, { mode: 'new-project', onboardingComplete: true });
      const ui = path.join(root, 'packages', 'ui');
      writeState(ui, { mode: 'new-project' }); // the leak
      const target = path.join(ui, 'src', 'index.ts');
      writeFile(target);
      return {
        cwd: ui,
        file: target,
        // The NON-canonical spelling, not the realpath. shared/retention.ts's
        // isLeakedNestedRoot deletes a nested .traffic-one when
        // resolveProjectRoot(dir) !== dir, so an exit that canonicalized here
        // would make every project reached this way a deletion candidate.
        expected: root,
        readback: [
          ['the fixture root is NOT canonical', () => root === fs.realpathSync(root), false],
          ['the expected root is the alias, and its realpath is a sibling of it', () => path.dirname(fs.realpathSync(root)) === path.dirname(root), true],
          ['the sub-package state DOES carry a mode (it looks like a root)', () => JSON.parse(fs.readFileSync(path.join(ui, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
          ['the root declares workspaces', () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces.length > 0, true],
        ],
      };
    },
  },
  {
    id: 'noncanonical-ceiling-fallback',
    incident: 'paths.ts:232-241 [non-canonical] — the three ceiling exits hand back `opts.ceiling`, which is the HOST\'s spelling of its workspace root',
    guard: 'the ceiling fallback returns the ceiling as supplied',
    canonicalRoot: false,
    build: (root) => {
      const ws = path.join(root, 'ws');
      writeState(ws, { mode: 'new-project', onboardingComplete: true });
      const terminals = path.join(root, '.cursor', 'projects', 'Users-u-Projects-ws', 'terminals');
      fs.mkdirSync(terminals, { recursive: true });
      return {
        cwd: terminals,
        ceiling: ws,
        expected: ws,
        readback: [
          ['the fixture root is NOT canonical', () => root === fs.realpathSync(root), false],
          ['the shell cwd is outside the workspace', () => terminals.startsWith(ws + path.sep), false],
          ['the workspace is onboarded', () => JSON.parse(fs.readFileSync(path.join(ws, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
  {
    id: 'symlinked-project-spelling',
    incident: 'paths.ts:214+ [symlinked input] — a checkout reached through a symlink (a worktree alias, an /etc/auto_home mount, a container bind). Builds its own non-canonical spelling, so it needs no canonicalRoot opt-out',
    guard: 'no exit realpaths: one inode reached by two spellings answers in the spelling it was asked in',
    build: (root) => {
      const proj = path.join(root, 'proj');
      writeState(proj, { mode: 'new-project', onboardingComplete: true });
      writePkg(proj, { name: 'proj' });
      const link = path.join(root, 'link');
      fs.symlinkSync(proj, link);
      const target = path.join(link, 'src', 'index.ts');
      writeFile(target);
      return {
        cwd: link,
        file: target,
        expected: link,
        readback: [
          ['the two spellings are ONE inode', () => fs.statSync(proj).ino === fs.statSync(link).ino, true],
          ['the link is a symlink, not a copy', () => fs.lstatSync(link).isSymbolicLink(), true],
          ['the state file is reachable through the link', () => JSON.parse(fs.readFileSync(path.join(link, '.traffic-one', '.one.json'), 'utf8')).mode, 'new-project'],
        ],
      };
    },
  },
];

// One test per row, so a mutation of the walk names the rows it kills instead of
// stopping at whichever happens to run first.
for (const row of ROWS) {
  test(`root resolution [${row.id}]`, () => {
    const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)));
    let root = created;
    if (row.canonicalRoot === false) {
      const real = path.join(created, 'real');
      fs.mkdirSync(real);
      root = path.join(created, 'alias');
      fs.symlinkSync(real, root);
    }
    const saved: Record<string, string | undefined> = {};
    try {
      const layout = row.build(root);
      for (const [key, value] of Object.entries(layout.env || {})) {
        saved[key] = process.env[key];
        process.env[key] = value;
      }
      // (1) The fixture is what the row claims it is.
      for (const [label, actual, expected] of layout.readback) {
        assert.deepEqual(actual(), expected, `FIXTURE [${row.id}] ${label}`);
      }
      // (2) Only then, the verdict — through the real adapter when the row is
      // about which of several host roots becomes the ceiling.
      let resolved: string;
      if (layout.hostRoots) {
        const parsed = makeCursorAdapter().parse({
          stdin: JSON.stringify({
            workspace_roots: layout.hostRoots,
            cwd: layout.cwd,
            ...(layout.file ? { file_path: layout.file } : {}),
          }),
          argv: ['node', 'cursor-hook-runtime', 'before-read-file'],
        });
        assert.equal(parsed.workspaceRoot, layout.expectedCeiling,
          `[${row.id}] the adapter must select this ceiling from workspace_roots`);
        assert.equal(parsed.cwd, layout.cwd,
          `[${row.id}] the adapter must not replace the cwd`);
        resolved = resolveProjectRoot(parsed.cwd, parsed.tool?.filePath,
          parsed.workspaceRoot ? { ceiling: parsed.workspaceRoot } : {});
      } else {
        resolved = resolveProjectRoot(layout.cwd, layout.file,
          layout.ceiling ? { ceiling: layout.ceiling } : {});
      }
      assert.equal(resolved, layout.expected,
        `[${row.id}] ${row.incident}\n  guard: ${row.guard}`);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      fs.rmSync(created, { recursive: true, force: true });
    }
  });
}

test('root resolution table: rows are unique and every row names a guard', () => {
  // Cheap structural guard so a copy-pasted row cannot silently shadow another.
  const ids = ROWS.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'row ids must be unique');
  for (const row of ROWS) {
    assert.ok(row.guard.trim(), `${row.id} must name the guard it pins`);
    assert.ok(row.incident.trim(), `${row.id} must cite where the incident is documented`);
    assert.equal(
      row.canonicalRoot === false, row.incident.includes('[non-canonical]'),
      `${row.id}: a row that opts out of the realpath must say so in its incident text, and only such a row may`,
    );
  }
  // The blind spot this table had: EVERY row measured an already-canonical
  // input. Keep at least one that does not, so the opt-out cannot rot away.
  assert.ok(
    ROWS.filter((r) => r.canonicalRoot === false).length >= 4,
    'the table must keep measuring some rows on non-canonical inputs',
  );
});

// ── the multi-root defect, end to end through the real adapter ────────────────
// The rows above hand resolveProjectRoot a ceiling directly. This one proves the
// ADAPTER produces that ceiling from a real host payload, and that the two other
// consumers of the same value — the cwd fold and workspaceBoundaryGuard — follow.

test('multi-root window: the adapter, the resolver and the boundary guard all target the working folder', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX)));
  try {
    const alpha = path.join(root, 'alpha');
    const beta = path.join(root, 'beta');
    for (const p of [alpha, beta]) {
      writeState(p, { mode: 'existing-codebase', 'one-uid': path.basename(p) });
      writePkg(p, { name: path.basename(p) });
      writeFile(path.join(p, 'src', 'x.ts'));
    }
    const target = path.join(beta, 'src', 'x.ts');

    // FIXTURE READBACK
    assert.equal(JSON.parse(fs.readFileSync(path.join(alpha, '.traffic-one', '.one.json'), 'utf8'))['one-uid'], 'alpha');
    assert.equal(JSON.parse(fs.readFileSync(path.join(beta, '.traffic-one', '.one.json'), 'utf8'))['one-uid'], 'beta');
    assert.equal(fs.existsSync(target), true);

    const parsed = makeCursorAdapter().parse({
      stdin: JSON.stringify({ workspace_roots: [alpha, beta], cwd: beta, file_path: target }),
      argv: ['node', 'cursor-hook-runtime', 'before-read-file'],
    });

    assert.equal(parsed.workspaceRoot, beta, 'the ceiling must be the folder the hook is working in');
    assert.equal(parsed.cwd, beta, 'the genuine cwd must not be replaced by the foreign root');
    assert.equal(
      resolveProjectRoot(parsed.cwd, parsed.tool?.filePath, { ceiling: parsed.workspaceRoot }),
      beta,
      'resolution must not land in the sibling project',
    );
    assert.equal(
      workspaceBoundaryGuard({ input: parsed, cwd: parsed.cwd } as unknown as Ctx).kind,
      'noop',
      'reading a file in the second folder of a multi-root window must not be denied',
    );

    // …and the boundary is still a boundary. Selecting the root that contains the
    // TARGET instead of the cwd would make it self-satisfying: every target would
    // sit inside the ceiling derived from it, and this guard could never refuse.
    //
    // NOTE on what this pins and what it does not: `HookInput.workspaceRoot` is a
    // single path, so a genuinely cross-folder operation inside one multi-root
    // window is refused here even though both folders are open. That is today's
    // behaviour and it is the safe direction (sibling Traffic One projects stay
    // isolated); carrying the whole list would need a `workspaceRoots` field on
    // HookInput and a guard that accepts any of them.
    const crossRoot = makeCursorAdapter().parse({
      stdin: JSON.stringify({
        workspace_roots: [alpha, beta],
        cwd: path.join(alpha, 'src'),
        file_path: target,
      }),
      argv: ['node', 'cursor-hook-runtime', 'before-read-file'],
    });
    assert.equal(crossRoot.workspaceRoot, alpha, 'the ceiling follows the cwd, not the target');
    assert.equal(
      workspaceBoundaryGuard({ input: crossRoot, cwd: crossRoot.cwd } as unknown as Ctx).kind,
      'deny',
      'a target in another folder must still be judged against the folder the agent is in',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
