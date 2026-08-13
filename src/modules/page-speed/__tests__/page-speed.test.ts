import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { postBuildPageSpeed } from '../handler';
import type { Ctx, HookInput, ToolClass } from '../../../core/types';
import { RUNNER_STATUSES } from '../../../runners/lighthouse/cli-args';
import { compileArchitecture } from '../../../shared/architecture-contract';
import { recordPluginUseChoice } from '../../../shared/state/plugin-use';
import { compileVerificationContract } from '../../../shared/verification-contract';

function withProject(stateObj: Record<string, unknown>, authed: boolean, fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-pagespeed-'));
  const env = process.env;
  const saved = { state: env.TRAFFIC_ONE_STATE_PATH, prefs: env.TRAFFIC_ONE_PROJECT_PREFS_PATH, auth: env.TRAFFIC_ONE_AUTH };
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.TRAFFIC_ONE_AUTH = '1';
  if (authed) {
    fs.writeFileSync(env.TRAFFIC_ONE_STATE_PATH, JSON.stringify({
      schemaVersion: 3,
      auth: {
        version: 1, authenticated: true, apiKey: 'sk-telemetry-123', updatedAt: '2099-01-01T00:00:00Z',
      },
      hosts: {},
    }), 'utf8');
  }
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify(stateObj), 'utf8');
  try {
    fn(dir);
  } finally {
    if (saved.state === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = saved.state;
    if (saved.prefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = saved.prefs;
    if (saved.auth === undefined) delete env.TRAFFIC_ONE_AUTH; else env.TRAFFIC_ONE_AUTH = saved.auth;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function ctxFor(cwd: string, command: string, raw: Record<string, unknown> = {}, workspaceRoot?: string): Ctx {
  const input: HookInput = {
    event: 'PostToolUse',
    host: 'claude',
    cwd,
    raw,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    tool: { class: 'shell' as ToolClass, rawName: 'Bash', command },
  };
  return { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
}

function writePerformanceContract(cwd: string, state: Record<string, unknown>, runId = 'R'): void {
  const architecture = compileArchitecture(cwd, runId, state, {
    schemaVersion: 1,
    routes: [],
    modules: [{ id: 'app-shell', name: 'App', kind: 'app-shell' }],
  });
  compileVerificationContract(cwd, runId, state, architecture, {
    changedPaths: [],
    performanceRisk: true,
  });
}

test('page-speed fires after a web production build (authed)', () => {
  const state = { stack: 'default', frontend: 'react-vite', currentRunId: 'R' };
  withProject(state, true, (cwd) => {
    writePerformanceContract(cwd, state);
    const r = postBuildPageSpeed(ctxFor(cwd, 'pnpm build'));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('Lighthouse'));
      assert.equal(r.systemMessage, 'traffic-one page-speed gate pending after build');
    }
  });
});

test('page-speed is silent after a normal web build without a performance contract', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed resolves a nested monorepo build to the onboarded workspace root', () => {
  const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', currentRunId: 'R' };
  withProject(state, true, (cwd) => {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }), 'utf8');
    const app = path.join(cwd, 'apps', 'web');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{}', 'utf8');
    writePerformanceContract(cwd, state);

    const r = postBuildPageSpeed(ctxFor(app, 'pnpm build', {}, cwd));

    assert.equal(r.kind, 'context');
    assert.equal(fs.existsSync(path.join(app, '.traffic-one')), false);
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one', 'runs', '.once', 'pagespeed-advisory-nosession')), true);
  });
});

test('page-speed surfaces structured Lighthouse blocked statuses after runner calls', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = [
      'BUILD_ID_PRESENT',
      JSON.stringify({
        status: 'blocked:sandbox',
        error: 'listen EPERM: operation not permitted "127.0.0.1"',
      }, null, 2),
    ].join('\n');
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('blocked:sandbox'));
      assert.ok(r.context.includes('"127.0.0.1"'));
      assert.ok(r.context.includes('unverified'));
      assert.equal(r.systemMessage, 'traffic-one page-speed blocked:sandbox');
    }
  });
});

test('a lighthouse runner call sweeps superseded reports for that route', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    // Retention capped these correctly, but its only trigger was SessionStart,
    // so a run that measured repeatedly kept every pair (observed 10co: six
    // pairs for `home`, a 14.7 MB reports dir, inside one session).
    const t1 = '.traffic' + '-one';
    const lh = path.join(cwd, t1, 'reports', 'lighthouse');
    fs.mkdirSync(lh, { recursive: true });
    fs.writeFileSync(path.join(cwd, t1, 'retention.json'),
      JSON.stringify({ lighthouseKeepPerRoute: 2, orphanTtlDays: 3650 }), 'utf8');
    const stamps = [
      '2026-07-30T12-15-01-470Z', '2026-07-30T12-16-24-888Z',
      '2026-07-30T12-56-15-024Z', '2026-07-30T13-06-29-955Z',
    ];
    for (const stamp of stamps) {
      for (const ext of ['report.json', 'report.html']) {
        fs.writeFileSync(path.join(lh, `home-${stamp}.${ext}`), 'x', 'utf8');
      }
    }
    assert.equal(fs.readdirSync(lh).length, 8);

    postBuildPageSpeed(ctxFor(cwd, 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /'));

    const left = fs.readdirSync(lh).sort();
    assert.equal(left.length, 4, 'the sweep runs at the lighthouse boundary, not only at SessionStart');
    for (const stamp of stamps.slice(-2)) {
      assert.ok(left.includes(`home-${stamp}.report.json`), 'the newest pairs survive');
    }
  });
});

// The banner that existed while retention's census recorded that it did not.
// A sweep's notices name conditions only the USER can clear — here a `.one.json`
// that will not parse, which SUSPENDS the run-history caps and makes the state
// dir grow without bound until it is repaired — and this branch is one of the two
// surfaces in the runtime that can put such a line in front of somebody. It
// carried nothing, and the docblock in shared/retention.ts said so in the
// opposite direction ("the page-speed sweep composes no banner").
//
// Appended to the banner this branch ALREADY returns, never a banner of its own:
// SessionStart says the same thing once per session, and a second surface firing
// on every Lighthouse command would be prose nobody reads.
test('a lighthouse call carries the sweep advisory on the banner it already returns', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), '{ "currentRunId": ', 'utf8');
    const runnerOutput = JSON.stringify({
      status: 'blocked:sandbox',
      error: 'listen EPERM: operation not permitted "127.0.0.1"',
    }, null, 2);
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('blocked:sandbox'), 'the audit banner itself is unchanged');
      assert.ok(r.context.includes('SUSPENDED'), 'and it now carries the sweep notice as well');
      assert.ok(r.context.includes('.one.json'), 'naming the file only the user can repair');
    }
  });
});

test('codex blocked:sandbox prescribes the escalated re-run recipe', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = JSON.stringify({
      status: 'blocked:sandbox',
      error: 'listen EPERM: operation not permitted "127.0.0.1"',
    }, null, 2);
    const input: HookInput = {
      event: 'PostToolUse', host: 'codex', cwd,
      raw: { tool_response: { stdout: `${runnerOutput}\n` } },
      tool: { class: 'shell' as ToolClass, rawName: 'exec_command', command: 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /' },
    };
    const r = postBuildPageSpeed({ input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('require_escalated'), 'codex sandbox denial names the escalation recipe');
      assert.ok(r.context.includes('lighthouse-runner.cjs'));
      assert.ok(r.context.includes('unverified'));
    }
    // non-codex hosts keep the plain unverified message
    const claude = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(claude.kind, 'context');
    if (claude.kind === 'context') assert.ok(!claude.context.includes('require_escalated'));
  });
});

test('page-speed surfaces a Lighthouse runner timeout as blocked:timeout', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const runnerOutput = JSON.stringify({
      status: 'blocked:timeout',
      error: 'Lighthouse runner exceeded 240000ms budget; aborting to avoid a silent hang.',
    }, null, 2);
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${runnerOutput}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('blocked:timeout'));
      assert.ok(r.context.includes('unverified'));
      assert.equal(r.systemMessage, 'traffic-one page-speed blocked:timeout');
    }
  });
});

/**
 * EVERY status the runner declares reaches the agent.
 *
 * This hook used to recognise three literal statuses, which made it a partial
 * function in front of the runner's total one: `blocked:lighthouse-missing` was
 * printed and dropped here for as long as it existed, so a host with no Lighthouse
 * binary produced a `noop()` and the agent was told nothing — the same silence,
 * one layer along, as the runner exiting with empty stdout. Measured before the
 * change: sandbox, usage-limit and timeout surfaced; lighthouse-missing,
 * preview-command-missing, failed:project and failed:unclassified all returned
 * `noop`.
 *
 * The list is imported from the RUNNER, deliberately across trees. The shipped
 * hook must not depend on the runner's module graph, but a test may — and this is
 * the only place the two vocabularies can be held together, so a status added over
 * there reddens here instead of being discovered by an agent that got no advisory.
 */
test('every status the lighthouse runner declares surfaces as an advisory', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.ok(RUNNER_STATUSES.length >= 7, 'fixture guard: the runner must actually declare its statuses');
    for (const status of RUNNER_STATUSES) {
      const r = postBuildPageSpeed(ctxFor(
        cwd,
        'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
        { tool_response: { stdout: `${JSON.stringify({ status, error: 'the runner said so' }, null, 2)}\n` } },
      ));
      assert.equal(r.kind, 'context', `${status} must not be dropped`);
      if (r.kind === 'context') {
        assert.ok(r.context.includes(status), 'the advisory must name the status the runner reported');
        assert.ok(r.context.includes('unverified'), 'and must never let page speed read as verified');
        assert.equal(r.systemMessage, `traffic-one page-speed ${status}`);
      }
    }
  });
});

/**
 * The generic label is for the genuinely unforeseen, not a resting place for
 * statuses we already know about.
 *
 * The prefix match accepts any well-shaped status, so an unrecognised one still
 * reaches the agent — but it arrives described as "could not produce a result",
 * which names no repair. Every status the runner DECLARES must therefore have its
 * own sentence here. Read through the public advisory rather than by exporting the
 * label function: the label is what a caller sees when the runner reported no
 * `error` text, which is exactly this shape.
 */
const GENERIC_LABEL = 'could not produce a result';

test('no status the runner declares falls back to the generic label', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const advise = (status: string): string => {
      const r = postBuildPageSpeed(ctxFor(
        cwd,
        'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
        { tool_response: { stdout: `${JSON.stringify({ status }, null, 2)}\n` } },
      ));
      assert.equal(r.kind, 'context', `${status} must not be dropped`);
      return r.kind === 'context' ? r.context : '';
    };
    for (const status of RUNNER_STATUSES) {
      assert.ok(
        !advise(status).includes(GENERIC_LABEL),
        `${status} is declared by the runner and has no label here — add one to lighthouseStatusLabel`,
      );
    }
    // And the fallback is reachable, so the row above is a real constraint: a
    // status this build has never heard of is still surfaced, just unhelpfully.
    assert.ok(advise('blocked:something-invented-later').includes(GENERIC_LABEL));
  });
});

/**
 * A project fault gets a different repair. "Use a staging URL" is the way around
 * an environment gap and is wrong advice for a project with no build — no URL
 * fixes that — and the Codex escalation recipe is wronger still, since it
 * prescribes a permissions retry for what needs a `build`.
 */
test('a failed:* status is told to fix the project, not to find another URL', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const input: HookInput = {
      event: 'PostToolUse', host: 'codex', cwd,
      raw: { tool_response: { stdout: `${JSON.stringify({ status: 'failed:project', error: 'Next production build metadata is missing' }, null, 2)}\n` } },
      tool: { class: 'shell' as ToolClass, rawName: 'exec_command', command: 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /' },
    };
    const r = postBuildPageSpeed({ input, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('fix the cause in the project'));
      assert.ok(r.context.includes('unverified'));
      assert.ok(!r.context.includes('staging/already-running'), 'a staging URL does not answer an unbuilt project');
      assert.ok(!r.context.includes('require_escalated'), 'escalation is for a denied bind, not for a missing build');
    }
    // The sandbox recipe is unchanged for the status that earns it.
    const sandbox: HookInput = {
      ...input,
      raw: { tool_response: { stdout: `${JSON.stringify({ status: 'blocked:sandbox', error: 'listen EPERM' }, null, 2)}\n` } },
    };
    const s = postBuildPageSpeed({ input: sandbox, host: 'codex', cwd, now: () => 'x' } as unknown as Ctx);
    assert.equal(s.kind, 'context');
    if (s.kind === 'context') assert.ok(s.context.includes('require_escalated'));
  });
});

/**
 * The FINAL line wins, which is also what proves the structured parser is the one
 * doing the work.
 *
 * Four parsers sit in this function — whole-text JSON, a balanced-brace scan
 * walked in REVERSE, a line scan walked in reverse, and a raw `"status": "…"`
 * match that takes the FIRST hit in the text. They disagree only when a response
 * carries more than one status-shaped object, and then the disagreement matters:
 * the runner's contract is one FINAL status line, so an earlier object is stale by
 * construction. Widening only the fallback would have looked like a working fix on
 * every single-object response — this row is the one that can tell the two apart,
 * and without it the whitelist could come back to the parsers above unnoticed.
 */
test('the last status object in a response is the verdict, not the first', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const stdout = [
      JSON.stringify({ status: 'blocked:timeout', error: 'a stale line from an earlier attempt' }, null, 2),
      'preview aborted; retrying without preview',
      JSON.stringify({ status: 'failed:project', error: 'Next production build metadata is missing' }, null, 2),
    ].join('\n');
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: `${stdout}\n` } },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.equal(r.systemMessage, 'traffic-one page-speed failed:project');
      assert.ok(!r.context.includes('blocked:timeout'), 'the earlier line is stale and must not be reported');
    }
  });
});

/**
 * The last-resort path, which is the one a truncated tool response takes.
 *
 * Three parsers sit in front of it — whole-text JSON, balanced-brace scan,
 * line-by-line — and all three need a complete object, so a host that clipped the
 * runner's output mid-line reaches only the raw `"status": "…"` match. That match
 * carried the same three-literal whitelist as the parsers above it and would have
 * gone on dropping the new statuses after they were fixed everywhere else.
 */
test('a truncated runner response still yields its status', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const clipped = '{\n  "status": "failed:project",\n  "error": "Next production build metadata is missing at /app/.next/BUILD_ID"';
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { tool_response: { stdout: clipped } },
    ));
    assert.equal(r.kind, 'context', 'a clipped response must not silently become a passing gate');
    if (r.kind === 'context') {
      assert.ok(r.context.includes('failed:project'));
      assert.ok(r.context.includes('BUILD_ID'), 'the error text is recovered by the same last-resort match');
    }
  });
});

/**
 * The prefix is a SHAPE, and it is still a guard. A tool response mentioning some
 * other subsystem's status must not be read as a Lighthouse verdict, or the hook
 * would report page speed unverified on the strength of an unrelated line.
 */
test('a status that is not the runner vocabulary is never read as a verdict', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    for (const status of ['passed', 'blocked-environment', 'blocked:', 'BLOCKED:SANDBOX', 'failed', 'failed:Project']) {
      const r = postBuildPageSpeed(ctxFor(
        cwd,
        'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
        { tool_response: { stdout: `${JSON.stringify({ status, error: 'x' }, null, 2)}\n` } },
      ));
      // Not a verdict — and since the runner reported no summary either, what this
      // response actually shows is a run with no result, which is what gets said.
      // The distinction matters: the wrong answer here would be QUOTING the foreign
      // status back as a Lighthouse verdict.
      assert.equal(
        r.kind === 'context' ? r.systemMessage : '',
        'traffic-one page-speed no-result',
        `${status} is not a lighthouse runner status`,
      );
      // The systemMessage is the precise instrument here: a misread would spell it
      // `traffic-one page-speed <that status>`. Substring-checking the prose is not,
      // since the advisory legitimately contains the word "passed".
      if (r.kind === 'context') assert.ok(!r.context.includes('mobile gate reported'), 'nothing was reported to quote');
    }
  });
});

/**
 * A run that reported NOTHING is reported as such.
 *
 * The runner prints exactly one of two things: an audit summary, or one JSON status
 * line. Neither observed means no result was observed — and silence there is the
 * fail-open direction, the same silence the runner's total failure path and the
 * prefix match above exist to end, reached by a third route. The advisory is
 * therefore an OBSERVATION and not a diagnosis: a killed runner and a response that
 * never arrived are both consistent with what this hook can see, so it names both
 * and asserts neither.
 */
const NO_RESULT_SYSTEM_MESSAGE = 'traffic-one page-speed no-result';

test('a runner call that reported neither a summary nor a status is reported as no result', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const shapes: { label: string; raw: Record<string, unknown> }[] = [
      { label: 'empty stdout', raw: { tool_response: { stdout: '' } } },
      { label: 'killed from outside, stderr only', raw: { tool_response: { stdout: '', stderr: 'Killed: 9' } } },
      { label: 'no tool response at all', raw: {} },
    ];
    for (const shape of shapes) {
      const r = postBuildPageSpeed(ctxFor(cwd, 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /', shape.raw));
      assert.equal(r.kind, 'context', `${shape.label} must not pass in silence`);
      if (r.kind === 'context') {
        assert.equal(r.systemMessage, NO_RESULT_SYSTEM_MESSAGE);
        assert.ok(r.context.includes('NO RESULT'));
        assert.ok(r.context.includes('unverified'));
        // An observation, not a diagnosis: both causes named, neither asserted.
        assert.ok(r.context.includes('killed from outside'));
        assert.ok(r.context.includes('did not reach this hook'));
        assert.ok(r.context.includes('cannot tell which'));
        assert.ok(!r.context.includes('fix the cause in the project'), 'neither cause is repaired in the project');
      }
    }
  });
});

/**
 * A REAL success stays silent, which is the constraint that makes the row above
 * safe. This fixture is captured stdout from the actual runner (driven to a green
 * audit against a stub Lighthouse that writes the report Lighthouse writes), with
 * only the absolute report path shortened — an invented fixture could have agreed
 * with the detector by accident.
 *
 * Both response shapes are checked because they are read by different paths: the
 * `tool_response` wrapper is Claude's and Codex's, while Cursor delivers the shell
 * result at the top level.
 */
const REAL_SUCCESS_STDOUT = `{
  "url": "http://127.0.0.1:9/",
  "buildMode": "production-preview",
  "previewKind": "vite",
  "appDir": ".",
  "reports": {
    "json": ".traffic-one/reports/lighthouse/home-2026-08-11T06-04-57-691Z.report.json",
    "html": null
  },
  "metrics": {
    "performance": 97,
    "accessibility": 95,
    "bestPractices": 95,
    "seo": 95,
    "fcp": "0.9 s",
    "lcp": "1.2 s",
    "tbt": "50 ms",
    "cls": "0.01",
    "speedIndex": "1.1 s"
  },
  "failures": [],
  "withinTolerance": [],
  "warnings": [],
  "topOpportunities": []
}
`;

test('a successful audit stays silent, in either host response shape', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const command = 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /';
    assert.equal(postBuildPageSpeed(ctxFor(cwd, command, { tool_response: { stdout: REAL_SUCCESS_STDOUT } })).kind, 'noop');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, command, { output: REAL_SUCCESS_STDOUT, exit_code: 0 })).kind, 'noop');
    // Clipped mid-object by a host output cap: still a success, still silent. The
    // summary detector needs its own raw fallback for this, exactly as the status
    // parser does.
    const clipped = REAL_SUCCESS_STDOUT.slice(0, 220);
    assert.ok(!clipped.includes('topOpportunities'), 'fixture guard: the clip must actually remove the closing brace');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, command, { tool_response: { stdout: clipped } })).kind, 'noop');
    // `--help` prints usage and audits nothing; it is not a missing result.
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'node ~/.traffic-one/bin/lighthouse-runner.cjs --help', { tool_response: { stdout: 'Usage: lighthouse-runner ...' } })).kind, 'noop');
  });
});

/**
 * The no-result advisory is evidence about a RUNNER call and nothing else. A silent
 * response to any other command says nothing about page speed, and reporting it
 * would put this sentence on ordinary shell output.
 */
test('no result is only reported for a lighthouse runner command', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    for (const command of ['ls', 'pnpm build', 'node scripts/other-runner.cjs']) {
      const r = postBuildPageSpeed(ctxFor(cwd, command, { tool_response: { stdout: '' } }));
      assert.notEqual(
        r.kind === 'context' ? r.systemMessage : '',
        NO_RESULT_SYSTEM_MESSAGE,
        `${command} is not a lighthouse runner call`,
      );
    }
  });
});

/**
 * Cursor delivers the shell result at the TOP level of the payload — which is why
 * `model-gate.ts` reads `raw.exit_code` and not `raw.tool_response` — so the four
 * wrapper keys this hook looked under found nothing there. Measured before the
 * fallback: a `blocked:sandbox` line in a Cursor-shaped response reached this
 * handler as `noop`, meaning none of the structured statuses had EVER surfaced on
 * that host, including the three that were supposedly working.
 */
test('a status in a Cursor-shaped top-level response is surfaced too', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const r = postBuildPageSpeed(ctxFor(
      cwd,
      'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      { output: `${JSON.stringify({ status: 'blocked:sandbox', error: 'listen EPERM' }, null, 2)}\n`, exit_code: 1 },
    ));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') assert.equal(r.systemMessage, 'traffic-one page-speed blocked:sandbox');
  });
});

/**
 * The Cursor row above fixed ONE shape. These are the rest of the shape space, as
 * the seven adapters actually deliver a shell result to a handler: the
 * `tool_response` wrapper (Claude, Codex), Cursor's top-level `output`, the
 * `output: { title, output, metadata }` object the OpenCode and Kilo wrappers
 * forward, Cascade's `tool_info` (windsurf, Devin), and Copilot's own key. The
 * last row is a key no host uses today — the point of reading the result by SHAPE
 * rather than by name is that a host does not have to be known in advance.
 */
const RUNNER_STATUS_LINE = `${JSON.stringify({ status: 'blocked:lighthouse-missing', error: 'no lighthouse binary' }, null, 2)}\n`;

const HOST_RESULT_SHAPES: { label: string; raw: (text: string) => Record<string, unknown> }[] = [
  { label: 'claude/codex wrapper', raw: (text) => ({ tool_name: 'Bash', tool_input: {}, tool_response: { stdout: text } }) },
  { label: 'codex camel wrapper', raw: (text) => ({ toolResponse: { output: text } }) },
  { label: 'cursor top level', raw: (text) => ({ command: 'x', output: text, exit_code: 1 }) },
  { label: 'opencode/kilo nested output', raw: (text) => ({ tool_name: 'bash', input: {}, output: { title: 'bash', output: text, metadata: {} } }) },
  { label: 'cascade tool_info (windsurf, devin)', raw: (text) => ({ agent_action_name: 'post_run_command', tool_info: { command_line: 'x', output: text, exit_code: 1 } }) },
  { label: 'copilot tool_output', raw: (text) => ({ tool_name: 'shell', tool_calls: [{ id: '1', name: 'shell', args: {} }], tool_output: text }) },
  { label: 'a key no host uses today', raw: (text) => ({ some_future_result_field: { body: text } }) },
];

test('a runner status is read out of every host result shape', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    for (const shape of HOST_RESULT_SHAPES) {
      const r = postBuildPageSpeed(ctxFor(
        cwd,
        'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
        shape.raw(RUNNER_STATUS_LINE),
      ));
      assert.equal(r.kind, 'context', `${shape.label}: a printed status must not be dropped`);
      if (r.kind === 'context') {
        assert.equal(
          r.systemMessage,
          'traffic-one page-speed blocked:lighthouse-missing',
          `${shape.label}: the status must be the verdict, not a no-result advisory`,
        );
      }
    }
  });
});

/**
 * The other half, and the reason the row above is not merely tidier: a shape this
 * hook cannot read makes a GREEN audit indistinguishable from a run that reported
 * nothing, so the no-result advisory fires on a passing audit. Measured on the two
 * shapes that were unread — Cascade and Copilot both reported NO RESULT for this
 * exact successful stdout.
 */
test('a successful audit stays silent in every host result shape', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    for (const shape of HOST_RESULT_SHAPES) {
      const r = postBuildPageSpeed(ctxFor(
        cwd,
        'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
        shape.raw(REAL_SUCCESS_STDOUT),
      ));
      assert.equal(r.kind, 'noop', `${shape.label}: a measured audit must not be reported as unmeasured`);
    }
  });
});

/**
 * What the shape-blind walk must NOT read: the tool's own INPUT. A runner
 * invocation quotes routes and flags, and an agent may echo a status line
 * verbatim; treating that as the runner's output would let the COMMAND decide the
 * verdict. The input containers are therefore excluded by name — the one place
 * where a list is right, because "input" is a fixed, small vocabulary while
 * "result" is not.
 */
test('a status quoted in the tool input is never read as the runner result', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    const echoed = JSON.stringify({ status: 'blocked:sandbox', error: 'listen EPERM' });
    const raws: { label: string; raw: Record<string, unknown> }[] = [
      { label: 'tool_input.command', raw: { tool_input: { command: `echo '${echoed}'` }, tool_response: { stdout: '' } } },
      { label: 'top-level command', raw: { command: `echo '${echoed}'`, output: '', exit_code: 0 } },
      { label: 'cascade command_line', raw: { tool_info: { command_line: `echo '${echoed}'`, output: '' } } },
      { label: 'copilot tool_calls args', raw: { tool_calls: [{ id: '1', name: 'shell', args: { command: `echo '${echoed}'` } }] } },
      // The one collision in the shape space: `output` is the RESULT text on
      // Cursor but a CONTAINER on OpenCode and Kilo, and that container holds the
      // tool's `args` — the input. Written content is the case a command-key
      // exclusion does not cover: a file the agent writes may quote a status line
      // (a fixture, a doc, this test), and echoing it back as the runner's verdict
      // would report a blocked audit for a successful write.
      { label: 'opencode output.args written content', raw: { output: { title: 'write', args: { content: `example: ${echoed}` }, output: '' } } },
    ];
    for (const entry of raws) {
      const r = postBuildPageSpeed(ctxFor(cwd, 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /', entry.raw));
      assert.equal(r.kind, 'context', `${entry.label}: an empty result is still a missing result`);
      if (r.kind === 'context') {
        assert.equal(
          r.systemMessage,
          NO_RESULT_SYSTEM_MESSAGE,
          `${entry.label}: the command must not be quoted back as the runner's verdict`,
        );
      }
    }
  });
});

test('page-speed is silent for non-build commands', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm install build-tools')).kind, 'noop');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'ls')).kind, 'noop');
  });
});

test('page-speed is silent for React Native-only stacks', () => {
  withProject({ stack: 'custom-frontend', frontend: 'none', mobile: { framework: 'react-native-expo' } }, true, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed stands down when pluginUse is declined', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, true, (cwd) => {
    recordPluginUseChoice(cwd, false, 'test');
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});

test('page-speed is silent when unauthenticated AND auth is enforced', () => {
  withProject({ stack: 'default', frontend: 'react-vite' }, false, (cwd) => {
    assert.equal(postBuildPageSpeed(ctxFor(cwd, 'pnpm build')).kind, 'noop');
  });
});
