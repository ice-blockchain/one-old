import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { modelGateAfterShell, modelGateShell } from '../model-gate';
import { isModelCaptureCommand, isModelGateCommand } from '../../../shared/tool-classify';
import { modelCaptureCommand, modelGateCommand } from '../../../shared/model-gate-command';
import { modelGatePromptFresh, readModelChoice, writeModelChoice } from '../model-choice';
import { runModelGate } from '../../../runners/model-gate';
import type { Ctx, ToolClass } from '../../../core/types';
import { hostScopedPerformancePrefs, withCursorAvailableModels } from '../../../test-support/host-prefs';
import { ensureRunModelPolicy } from '../../../shared/run-model-policy';
import { readEffectiveState } from '../../../shared/state';
import { resolveModel } from '../../../shared/model-tiers';

// Derived, never hardcoded: which family anchors a tier is editable policy.
const CURSOR_HIGHEST_SLUG = `${resolveModel('highest', 'cursor', 'pro')}-thinking-high`;

function withProj(opts: { models: string[] | null; overrides?: Record<string, string> }, fn: (cwd: string) => void): void {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-mgate-')));
  const env = process.env;
  const pp = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const pl = env.TRAFFIC_ONE_USER_PLAN;
  const ps = env.TRAFFIC_ONE_STATE_PATH;
  const px = env.XDG_STATE_HOME;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_STATE_PATH = path.join(dir, 'one.json');
  env.XDG_STATE_HOME = path.join(dir, 'state');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  fs.mkdirSync(path.join(dir, '.traffic-one'), { recursive: true });
  const prefs = hostScopedPerformancePrefs(
    { level: 'high', source: 'prompted' },
    { mode: 'subagents', source: 'prompted', approved: true, overrides: opts.overrides || {} },
    'pro',
  );
  if (opts.models !== null) withCursorAvailableModels(prefs, opts.models, 'pro');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  fs.writeFileSync(path.join(dir, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none',
  }), 'utf8');
  try { fn(dir); } finally {
    if (pp === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = pp;
    if (pl === undefined) delete env.TRAFFIC_ONE_USER_PLAN; else env.TRAFFIC_ONE_USER_PLAN = pl;
    if (ps === undefined) delete env.TRAFFIC_ONE_STATE_PATH; else env.TRAFFIC_ONE_STATE_PATH = ps;
    if (px === undefined) delete env.XDG_STATE_HOME; else env.XDG_STATE_HOME = px;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function freezeCursorPolicy(cwd: string, runId: string): void {
  const env = { ...process.env, TRAFFIC_ONE_HOST: 'cursor' };
  const state = readEffectiveState(cwd, env);
  assert.ok(
    ensureRunModelPolicy(cwd, runId, 'cursor', state, env),
    'the parent fixture must freeze the Cursor policy before simulating after-shell',
  );
}

function ctxFor(cwd: string, command: string, host: 'cursor' | 'claude' = 'cursor'): Ctx {
  const rawName = host === 'cursor' ? 'before-shell-execution' : 'Bash';
  return {
    input: { event: 'PreToolUse', host, cwd, raw: { command }, tool: { class: 'shell' as ToolClass, rawName, command } },
    host, cwd, now: () => 'x',
  } as unknown as Ctx;
}

function afterCtxFor(cwd: string, command: string, rawExtra: Record<string, unknown> = {}): Ctx {
  return {
    input: {
      event: 'PostToolUse',
      host: 'cursor',
      cwd,
      raw: { command, ...rawExtra },
      tool: { class: 'shell' as ToolClass, rawName: 'after-shell-execution', command },
    },
    host: 'cursor', cwd, now: () => 'x',
  } as unknown as Ctx;
}

function captureStdout(fn: () => number): { code: number; out: string } {
  const original = process.stdout.write;
  let out = '';
  (process.stdout.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk: string | Uint8Array): boolean => {
    out += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    return true;
  };
  try {
    return { code: fn(), out };
  } finally {
    process.stdout.write = original;
  }
}

test('isModelGateCommand recognizes the model-gate command (and rejects others)', () => {
  const root = '/proj';
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand(root, 'cursor') }, root), true);
  assert.equal(isModelCaptureCommand('Bash', { command: modelCaptureCommand(root, 'cursor') }, root), true);
  assert.equal(isModelGateCommand('Bash', { command: 'node /p/onboarding-wait.cjs /cwd' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: 'node /p/model-gate.cjs /proj --host=cursor' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: 'echo node /p/model-gate.cjs /proj --host=cursor' }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: `${modelGateCommand(root, 'cursor')} && rm -rf /` }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand('/sibling', 'cursor') }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: modelGateCommand(root, 'claude') }, root), false);
  assert.equal(isModelGateCommand('Bash', { command: `node '/p/model-gate.cjs' '/proj' '--host=cursor' '--unknown'` }, root), false);
  assert.equal(isModelCaptureCommand('Bash', { command: `${modelGateCommand(root, 'cursor')} '--capture-models'` }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'valid-model' '--unknown'`,
  }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'duplicate' 'duplicate'`,
  }, root), false);
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' 'invalid model prose'`,
  }, root), false);
  const tooManyModels = Array.from({ length: 257 }, (_, index) => `'model-${index}'`).join(' ');
  assert.equal(isModelCaptureCommand('Bash', {
    command: `${modelGateCommand(root, 'cursor')} '--capture-models' ${tooManyModels}`,
  }, root), false);
});

test('model-gate generation and strict parsing preserve shell-punctuation project paths', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-model path-')));
  const root = path.join(base, "project ($draft); it's literal");
  fs.mkdirSync(root);
  try {
    const gate = modelGateCommand(root, 'cursor');
    const capture = modelCaptureCommand(root, 'cursor');
    assert.equal(isModelGateCommand('Bash', { command: gate }, root), true);
    assert.equal(isModelCaptureCommand('Bash', { command: capture }, root), true);
    assert.match(gate, /'\\''/, 'an apostrophe is emitted with an inert single-quote splice');
    assert.ok(gate.includes('$draft'), 'the literal dollar text is preserved inside inert quotes');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('modelGateShell always allows the internal capture command to refresh stale availability', () => {
  withProj({ models: ['composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelCaptureCommand(cwd, 'cursor'))).kind, 'noop');
  });
});

test('modelGateShell: a PICKED model not offered → askUser (permission:ask) naming the model + fallback', () => {
  // architect overridden to balanced (GPT-5.6 Terra), which the captured list LACKS.
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const r = modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor')));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') {
      assert.equal((r as { askUser?: boolean }).askUser, true, 'is a user APPROVE/REJECT prompt, not a hard deny');
      assert.ok(r.reason.includes('gpt-5.6-terra'), 'names the unavailable picked model');
      assert.ok(r.reason.includes('claude-sonnet-5'), 'names the fallback it would use');
      assert.ok(/approve/i.test(r.reason) && /reject/i.test(r.reason), 'offers approve/reject');
      assert.ok(/fallback.*enable/i.test(r.reason), 'directs chat consent before spawn');
      assert.ok((r as { agentMessage?: string }).agentMessage, 'carries per-branch agent instructions');
    }
  });
});

test('modelGate runner fails closed until explicit chat consent (use-fallback)', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-model-gate';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const closed = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(closed.code, 2, 'without explicit consent the runner refuses');
    assert.match(closed.out, /STOP|model choice required/i);
    assert.equal(readModelChoice(cwd, 'run-model-gate'), null, 'fail-closed path writes no fallback choice');
    assert.equal(modelGatePromptFresh(cwd, 'run-model-gate'), true, 'runner marks that a user-visible choice is required');

    writeModelChoice(cwd, 'run-model-gate', 'use-fallback');
    const approved = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(approved.code, 0);
    assert.match(approved.out, /fallback confirmed/i);
    assert.equal(readModelChoice(cwd, 'run-model-gate'), 'use-fallback', 'explicit chat consent unblocks the runner');
  });
});

test('modelGate after-shell surfaces exit-2 STOP as a Cursor user-visible message', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-after-shell';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    freezeCursorPolicy(cwd, 'run-after-shell');

    const r = modelGateAfterShell(afterCtxFor(cwd, modelGateCommand(cwd, 'cursor'), { exit_code: 2 }));
    assert.equal(r.kind, 'context');
    if (r.kind === 'context') {
      assert.ok(/model choice required/i.test(r.context), 'context carries the STOP table');
      assert.ok(/fallback/i.test(String(r.systemMessage)) && /enable/i.test(String(r.systemMessage)), 'systemMessage is visible to Cursor as user_message');
      assert.ok(String(r.systemMessage).includes('gpt-5.6-terra'), 'visible message names the unavailable picked model');
    }
  });
});

/**
 * WHERE the model-gate command's result is, rather than where Cursor happens to
 * keep it. The reads were all flat, which is right for Cursor and inert on every
 * other host only because this gate is keyed on a Cursor-only capability flag —
 * coupling that is invisible at the read site, so the day the flag widens the gate
 * goes SILENT rather than erroring. Four properties, in one fixture:
 *
 *   - Cursor is byte-for-byte unchanged, including the case that distinguishes the
 *     candidate spellings: a flat `output` STRING is the named container here, so a
 *     reader that narrowed to the container and stopped would stop reading Cursor's
 *     own STOP text;
 *   - a result carried inside a wrapper/container is legible, and a SUCCESSFUL one
 *     there is still not read as a failure;
 *   - a result carried in an envelope NOTHING names is legible too. An earlier round
 *     recorded that as a disclosed fail-open and pinned the broken answer, which is
 *     a row that can only detect an accidental fix; the reader is fixed here and the
 *     rows now red on a revert;
 *   - and the one-level bound holds: a status two levels down is a nested child's,
 *     and the payload's own verdict outranks any envelope it carries.
 *
 * One assertion over the whole table, so a revert of the reader shows EVERY family
 * it broke rather than stopping at the first.
 */
test('modelGate after-shell reads the command result wherever the payload carries it', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-after-shell-families';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
    freezeCursorPolicy(cwd, 'run-after-shell-families');

    const STOP = 'traffic-one model-gate: STOP — model choice required';
    const OK = 'all picked models are available';
    // One assertion over the whole table rather than a row at a time, so a reader
    // (or a mutation) sees EVERY family that was read wrongly instead of stopping
    // at the first.
    const rows: { label: string; raw: Record<string, unknown>; failed: boolean }[] = [
      // Cursor, unchanged.
      { label: 'flat: exit_code 2', raw: { exit_code: 2 }, failed: true },
      { label: 'flat: exit_code 0', raw: { exit_code: 0 }, failed: false },
      { label: 'flat: STOP in the output STRING, no code', raw: { output: STOP }, failed: true },
      { label: 'flat: output STRING beside exit_code 0', raw: { output: OK, exit_code: 0 }, failed: false },
      { label: 'flat: success:false', raw: { success: false }, failed: true },
      // Wrapper and container families, previously unreadable.
      { label: 'wrapper: exit_code 2 inside', raw: { tool_response: { exit_code: 2 } }, failed: true },
      { label: 'wrapper (camel): STOP in stdout', raw: { toolResponse: { stdout: STOP } }, failed: true },
      { label: 'wrapper: exit_code 0 inside', raw: { tool_response: { exit_code: 0, stdout: OK } }, failed: false },
      { label: 'output container (OpenCode/Kilo)', raw: { output: { title: 'bash', args: { command: 'x' }, exit_code: 2 } }, failed: true },
      { label: 'cascade tool_info', raw: { tool_info: { command_line: 'x', exit_code: 2 } }, failed: true },
      // The families an earlier round recorded as a latent FAIL-OPEN and left at
      // `failed: false`, which was a defect written down rather than fixed — and
      // two rows that could only ever detect an accidental FIX, since they pinned
      // the broken answer. `shellExitFailed` reached these through
      // `toolResultContainer`, which refuses to GUESS an envelope no host has
      // named: the honest answer for byte accounting, and the wrong one for a
      // gate, because it fell back to the payload, found no flat status, and
      // reported a FAILED model-gate command as PASSING. The STOP directive was
      // never delivered and a blind auto-run continued.
      //
      // It now reads `toolResultVerdictSources` — the payload's own top level and
      // one level into each record child — so the envelope needs no name.
      //
      // What a revert reds, measured against both earlier readers rather than
      // asserted, because the two do not fail the same way. Back to the container
      // read this replaced (`obj(toolResultContainer(payload)) ?? payload`, which
      // was byte-identical in HEAD and in the round that disclosed the fail-open):
      // THREE rows red, and they are the three below that expect `true` —
      // `exit_code 2`, `STOP in stdout` and `success:false inside`. Back further, to
      // the flat-only read that named no container at all: SEVEN, those three plus
      // the four wrapper/container rows above, which is what makes both layers of
      // this read load-bearing rather than only the newer one.
      { label: 'unnamed envelope: exit_code 2', raw: { execution_record: { exit_code: 2 } }, failed: true },
      { label: 'unnamed envelope: STOP in stdout', raw: { execution_record: { stdout: STOP } }, failed: true },
      { label: 'unnamed envelope: exit_code 0 inside is still a pass', raw: { execution_record: { exit_code: 0, stdout: OK } }, failed: false },
      { label: 'unnamed envelope: success:false inside', raw: { tool_output: { success: false } }, failed: true },
      // The bound this widening does NOT cross: two levels down is some nested
      // child's status, not this command's.
      { label: 'two levels down is not this command result', raw: { execution_record: { child: { exit_code: 2 } } }, failed: false },
      // And the ORDER, which only a payload reporting both can pin: the outermost
      // report is the shell's own exit status, so an envelope never overrides it.
      // The same precedence the subagent-failure classifier documents.
      { label: 'the payload own code outranks an envelope code', raw: { exit_code: 0, execution_record: { exit_code: 2 } }, failed: false },
      { label: 'and the other way round', raw: { exit_code: 2, execution_record: { exit_code: 0 } }, failed: true },
      // And a word status is still not an exit code, one level in as at the top.
      { label: 'unnamed envelope: a word status is not a code', raw: { execution_record: { status: 'completed' } }, failed: false },
      // TWO SIBLINGS DISAGREEING, which is the only shape that can pin how they
      // are resolved — and this read used to resolve it by serialization order,
      // because it RETURNED at the first source that spoke. Measured through this
      // hook before the fix: no STOP here, a STOP with the same two children
      // written the other way round, no STOP with a passing sibling ahead of the
      // sentinel, and no STOP when a sibling's success FLAG came first. Failure
      // outranks, in every order: over-firing costs a STOP nobody needed,
      // under-firing costs the gate.
      { label: 'siblings disagree: passing child first', raw: { metadata: { exit_code: 0 }, execution_record: { exit_code: 2 } }, failed: true },
      { label: 'siblings disagree: failing child first', raw: { execution_record: { exit_code: 2 }, metadata: { exit_code: 0 } }, failed: true },
      { label: 'a passing sibling may not swallow the STOP sentinel', raw: { metadata: { exit_code: 0 }, execution_record: { stdout: STOP } }, failed: true },
      { label: 'a sibling success FLAG may not mask a failing envelope', raw: { metadata: { ok: true }, execution_record: { exit_code: 2 } }, failed: true },
      // The sentinel is Traffic One's OWN text and no shell echoes it by
      // accident, so it outranks even a passing exit code at the own level. The
      // row below it is the precedence that does NOT move: a command has one exit
      // status, and where the payload reports one it is this command's.
      { label: 'the STOP sentinel outranks a passing own exit code', raw: { exit_code: 0, execution_record: { stdout: STOP } }, failed: true },
      // THE RULING, not an omission: a payload carrying no verdict information at
      // all answers PASS. Fail-closed governs a verdict this reader could have
      // read and did not; it cannot govern a payload with nothing to say, because
      // "nothing to say" is also what the two rows above it look like — a verdict
      // two levels down and a word status are deliberately NOT read, and firing
      // on silence would deliver a STOP for exactly those and make the one-level
      // bound decorative. Measured over the corpus this file drives: 3 of 24 rows
      // carry no readable verdict, and all three are pinned as passes on purpose.
      { label: 'no verdict information anywhere is a pass', raw: { conversation_id: 'c1' }, failed: false },
    ];
    const misread = rows
      .filter((row) => (modelGateAfterShell(afterCtxFor(cwd, modelGateCommand(cwd, 'cursor'), row.raw)).kind === 'context') !== row.failed)
      .map((row) => row.label);
    assert.deepEqual(misread, [], 'these payload families were read wrongly');

    // Key order is not evidence, asserted as a property rather than as two rows:
    // the same three children in four serializations must answer identically.
    const children: [string, unknown][] = [
      ['metadata', { exit_code: 0 }],
      ['execution_record', { exit_code: 2 }],
      ['results', { ok: true }],
    ];
    const byOrder = new Set([[0, 1, 2], [2, 1, 0], [1, 0, 2], [1, 2, 0]].map((order) => String(
      modelGateAfterShell(afterCtxFor(
        cwd,
        modelGateCommand(cwd, 'cursor'),
        Object.fromEntries(order.map((index) => children[index]!)),
      )).kind,
    )));
    assert.deepEqual([...byOrder], ['context'], 'the gate answered differently depending on which child the host serialized first');
  });
});

test('modelGate runner fails closed when Cursor model capture is missing', () => {
  withProj({ models: null, overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const statePath = path.join(cwd, '.traffic-one', '.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.currentRunId = 'run-missing-capture';
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const closed = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(closed.code, 2, 'missing capture must never be treated as all models available');
    assert.match(closed.out, /STOP|cursor-models\.json|model capture/i);
    assert.doesNotMatch(closed.out, /all picked models are available/i);
    assert.equal(readModelChoice(cwd, 'run-missing-capture'), null, 'missing capture writes no fallback choice');
  });
});

test('modelGateShell: recognizes the real Cursor before-shell-execution shape', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    const r = modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor')));
    assert.equal(r.kind, 'deny');
    if (r.kind === 'deny') assert.equal((r as { askUser?: boolean }).askUser, true);
  });
});

test('modelGateShell: every picked model offered → noop (the command runs, no prompt)', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'gpt-5.6-terra-medium', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor'))).kind, 'noop');
  });
});

/**
 * This row is environment-sensitive, and NOT coupled to the after-shell row above.
 * A peer saw it red only when a `shellExitFailed` revert was applied and read that
 * as state pollution between the two tests. Measured on a copy: with `model-gate.ts`
 * PRISTINE and the after-shell row PASSING, this row still fails in the same process
 * (twice of two), and with the revert applied in a different process it passes
 * (twice of two). So the discriminator is the process environment, not the other
 * test and not the reader. What fails is the agent-contract read at the end:
 * `runModelGate` printed the map and every assertion before it passed, but
 * `.cursor/agents/**` was never written into the temp project, so the read is ENOENT.
 * The temp project lives under `os.tmpdir()`, and both processes that reproduced it
 * had their filesystem writes confined to this repository — so treat a failure here
 * as an unmet fixture precondition and re-run without that confinement before
 * reading it as a defect. Recorded rather than fixed: moving the fixture into the
 * repo would make a materialization test write into the plugin source tree, which
 * this repo forbids.
 */
test('modelGate runner prints the local spawn map while project agent contracts stay model-agnostic', () => {
  withProj({ models: [CURSOR_HIGHEST_SLUG, 'gpt-5.6-terra-medium', 'composer-2.5-fast'], overrides: {} }, (cwd) => {
    const approved = captureStdout(() => runModelGate([cwd, '--host=cursor']));
    assert.equal(approved.code, 0);
    assert.match(approved.out, /spawn map/i);
    // Map lines recommend the role-named type. generalPurpose is the accepted
    // fallback in the enum-check note, not the preview type.
    assert.ok(approved.out.includes(`senior-architect → subagent_type: "senior-architect", model: ${CURSOR_HIGHEST_SLUG}`));
    assert.match(approved.out, /if that type is in this session's Task enum/);
    assert.match(approved.out, /\[t1-role: senior-<role>\]/);
    assert.doesNotMatch(approved.out, /→ subagent_type: "generalPurpose"/);
    const architect = fs.readFileSync(path.join(cwd, '.cursor', 'agents', 'senior-architect.md'), 'utf8');
    assert.doesNotMatch(architect, /^model:/m);
    assert.match(architect, /senior-architect/);
  });
});

test('modelGateShell: non-cursor host and non-model-gate commands → noop', () => {
  withProj({ models: ['claude-sonnet-5-thinking-high', 'composer-2.5-fast'], overrides: { 'senior-architect': 'balanced' } }, (cwd) => {
    assert.equal(modelGateShell(ctxFor(cwd, modelGateCommand(cwd, 'cursor'), 'claude')).kind, 'noop', 'claude → inert');
    assert.equal(modelGateShell(ctxFor(cwd, 'ls -la')).kind, 'noop', 'unrelated command → inert');
  });
});
