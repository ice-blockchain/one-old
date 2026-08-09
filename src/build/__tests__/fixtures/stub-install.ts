// src/build/__tests__/fixtures/stub-install.ts
// A plugin root that classifies as a real 'installed' tree and whose four
// legacy-path shims are stubs: they RECORD what they were handed (argv, stdin,
// the complete environment, cwd) and answer from a canned reply the test owns.
//
// Why stubs and not a compiled bundle. Producing one means a full `tsc` per
// case, which is `npm run smoke`'s job and takes seconds; the smoke already
// proves the exercise against real compiled bytes on every run. What is NOT
// provable there is the property these stubs exist for — that a caller's
// ambient environment cannot reach the children — because a real runtime
// answers the same way whether or not HOME leaked. A recording stub is the only
// witness that can tell those two apart.
//
// The 'installed' classification is asserted HERE, in the builder, before the
// tree is handed back. materialize's fixture (src/shared/materialize/__tests__/
// fixtures/installed-root.ts) makes the same call for the same reason: a
// fixture that quietly stopped classifying does not fail, it makes every
// assertion downstream pass over a refusal — and here the refusal would be
// exerciseInstalledRuntime declining to spawn anything at all, which reads as a
// tidy `problem` string that a careless test could mistake for the one it meant
// to provoke.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { AUTH_DENY, EXERCISED_SHIMS } from '../../exercise-runtime';
import { classifyPluginRootLayout } from '../../../shared/paths';

export interface StubAnswer { stdout?: string; stderr?: string; exit?: number; }
/** One canned reply per value of TRAFFIC_ONE_AUTH, so the auth-off control leg
 *  can be answered differently from the enforced one — which is the whole
 *  point of that control. */
export interface StubAnswers { on: StubAnswer; off: StubAnswer }

export interface StubCall {
  shim: string;
  subcommand: string;
  stdin: string;
  env: Record<string, string>;
}

export interface StubInstall {
  readonly root: string;
  readonly scripts: string;
  /** Every shim invocation, in the order they happened. */
  calls(): StubCall[];
  /** Replace one shim's canned reply. */
  answer(shim: string, answers: StubAnswers): void;
  /** Delete one shim, to exercise the missing-shim precheck. */
  removeShim(shim: string): void;
  cleanup(): void;
}

const CALLS_FILE = '.calls.jsonl';
const ANSWERS_DIR = '.answers';

// Sequential by construction (exerciseRuntime spawns one child at a time and
// waits), so an append per call keeps the order without a counter.
const STUB_SOURCE = [
  "'use strict';",
  "const fs = require('node:fs');",
  "const path = require('node:path');",
  'const shim = path.basename(__filename);',
  "const stdin = (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } })();",
  'fs.appendFileSync(',
  `  path.join(__dirname, ${JSON.stringify(CALLS_FILE)}),`,
  "  `${JSON.stringify({ shim, subcommand: process.argv[2], stdin, env: process.env })}\\n`,",
  ");",
  `const answers = JSON.parse(fs.readFileSync(path.join(__dirname, ${JSON.stringify(ANSWERS_DIR)}, \`\${shim}.json\`), 'utf8'));`,
  "const answer = process.env.TRAFFIC_ONE_AUTH === 'on' ? answers.on : answers.off;",
  "if (answer.stdout) process.stdout.write(answer.stdout);",
  "if (answer.stderr) process.stderr.write(answer.stderr);",
  'process.exitCode = answer.exit || 0;',
  '',
].join('\n');

// The healthy tree: every host denies through its own wire shape, and every
// deny carries the auth gate's own words. The auth-off column answers with
// something that is NOT that wording — which is exactly what the control leg
// checks, and what makes the four denies above attributable to auth at all.
export function healthyAnswers(): Record<string, StubAnswers> {
  const denyReason = `${AUTH_DENY} — sign in first.`;
  return {
    'hook-runtime.cjs': {
      on: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: denyReason } }) },
      off: { stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: 'allow' } }) },
    },
    'cursor-hook-runtime.cjs': {
      on: { stdout: JSON.stringify({ permission: 'deny', user_message: denyReason }) },
      off: { stdout: JSON.stringify({ permission: 'allow' }) },
    },
    'windsurf-hook-runtime.cjs': {
      on: { stderr: denyReason, exit: 2 },
      off: { exit: 0 },
    },
    'devin-hook-runtime.cjs': {
      on: { stdout: JSON.stringify({ decision: 'block', reason: denyReason }) },
      off: { stdout: JSON.stringify({}) },
    },
  };
}

export function makeStubInstall(label: string): StubInstall {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stub-install-'));
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(path.join(scripts, ANSWERS_DIR), { recursive: true });
  // The CONTENT half of the 'installed' predicate in shared/paths.ts. An empty
  // rules/ classifies 'unverified' there on purpose (a dist/ caught mid-gen), so
  // this file is load-bearing rather than decorative.
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'rules', 'stub.md'), '# stub rule\n', 'utf8');

  const answers = healthyAnswers();
  for (const shim of EXERCISED_SHIMS) {
    fs.writeFileSync(path.join(scripts, shim), STUB_SOURCE, 'utf8');
    fs.writeFileSync(path.join(scripts, ANSWERS_DIR, `${shim}.json`), JSON.stringify(answers[shim]), 'utf8');
  }

  assert.equal(
    classifyPluginRootLayout(root),
    'installed',
    `${label}: the stub plugin root ${root} did not classify 'installed'. exerciseInstalledRuntime refuses `
    + 'every other layout, so the assertions after this point would be describing a refusal that spawned nothing.',
  );

  return {
    root,
    scripts,
    calls(): StubCall[] {
      const raw = (() => {
        try { return fs.readFileSync(path.join(scripts, CALLS_FILE), 'utf8'); } catch { return ''; }
      })();
      return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as StubCall);
    },
    answer(shim: string, next: StubAnswers): void {
      fs.writeFileSync(path.join(scripts, ANSWERS_DIR, `${shim}.json`), JSON.stringify(next), 'utf8');
    },
    removeShim(shim: string): void {
      fs.rmSync(path.join(scripts, shim), { force: true });
    },
    cleanup(): void {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A throwaway workspace: the pinned HOME plus the four project cwds. */
export function makeExerciseWorkspace(): { root: string; home: string; projects: Record<'claude' | 'cursor' | 'windsurf' | 'devin', string>; cleanup(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-stub-workspace-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const projects = {
    claude: path.join(root, 'project-claude'),
    cursor: path.join(root, 'project-cursor'),
    windsurf: path.join(root, 'project-windsurf'),
    devin: path.join(root, 'project-devin'),
  };
  for (const project of Object.values(projects)) fs.mkdirSync(project, { recursive: true });
  return { root, home, projects, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
