// The run-id the sidecar fence narrows by, asserted at the GATE.
//
// ── THE DEFECT THIS PINS ────────────────────────────────────────────────────
// `shellRuntimeSidecarDestruction` (plan-write/sidecar-shell.ts) narrows its
// enumeration to the LIVE run so that `rm -rf .traffic-one/runs/<finished id>`
// stays ordinary housekeeping. It used to compute the live id as
//
//   const live = typeof currentRunId === 'string' ? currentRunId.trim() : '';
//
// which validates nothing but emptiness. So a pointer no run directory can ever
// equal narrows the enumeration to NOTHING, and the fence then finds nothing to
// protect. Measured through `planWriteGate` on the fixture below, both
// `rm -rf .traffic-one` and `rm -rf .traffic-one/runs` went from DENY to PERMIT
// for every pointer in `DISARMING_POINTERS` — the only measured way to make the
// whole-tree wipe succeed. Nothing escapes the project: the fence is switched
// OFF, which is why this is fence-disarming rather than path traversal.
//
// ── WHY THE SHAPE TEST ALONE WOULD NOT HAVE BEEN A FIX ──────────────────────
// Six path-flavoured literals (`..`, `.`, `/tmp/x`, `a/b`, a NUL, a deep `../`
// escape) are the reported values, and a grammar check closes all six. It leaves
// `currentRunId: 'no-such-run'` — well-shaped, names no run — disarming the
// fence exactly as before. That row is in the table below for that reason, and
// so is a CASE-ONLY mismatch, which is the same hole on a case-insensitive
// filesystem. A fix that closed the six literals and left those two is the
// spelling war this repository has lost elsewhere.
//
// ── THE MEASUREMENT TRAP ────────────────────────────────────────────────────
// A gate-behaviour fixture CANNOT live inside the plugin source checkout: every
// path under it is a non-project (authoring-root stand-down), so a fixture built
// there measures the product turning itself off and reads as "no fence". Hence
// `os.tmpdir()`, and hence the CONTROL rows: every row that expects a DENY also
// asserts a deny from an UNRELATED fence (the reset record) and a deny on an
// ordinary `src` write. If a control permits, the fixture is measuring the
// stand-down and every other row in that run is void. The run artifacts go in
// through real product writers (`writeState`, `ensureRunLedger`,
// `recordScanBoundHit`), each of which refuses outright on a non-project root,
// so `writersHonoured` is a third, independent stand-down control.
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';

import { planWriteGate } from '../plan-write';
import { recordScanBoundHit } from '../plan-readiness/context';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import { isDoctorIdArgument } from '../../../shared/doctor-command';
import { writeState } from '../../../shared/state/normalize';
import { ensureRunLedger } from '../../../shared/state/run-agent/ledger';
import { runIdNow } from '../../../shared/state/run-agent/run-paths';
import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';

/** An epoch-ms id of the shape `runIdNow()` mints. */
const LIVE = '1785169657252';
/** A finished run: deleting its directory is on the gate's permitted list. */
const FINISHED = '1785169000000';

const SIDECAR_DENY = 'runtime-sidecar-owner-gate';

interface Outcome {
  readonly denied: boolean;
  readonly denyId: string;
  readonly message: string;
}

function gate(
  cwd: string,
  rawName: string,
  cls: ToolClass,
  toolInput: Record<string, unknown>,
): Outcome {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude' as HostId,
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput },
    tool: { class: cls, rawName },
  };
  const ctx = { input, host: 'claude', cwd, now: () => 'x' } as unknown as Ctx;
  const result = planWriteGate(ctx);
  if (!result || result.kind !== 'deny') return { denied: false, denyId: '', message: '' };
  const deny = result as { denyId?: string; reason?: string };
  return { denied: true, denyId: deny.denyId ?? '', message: deny.reason ?? '' };
}

function bash(cwd: string, command: string): Outcome {
  return gate(cwd, 'Bash', 'shell', { command });
}

interface Fixture {
  readonly dir: string;
  readonly cleanup: () => void;
  readonly writersHonoured: boolean;
}

interface FixtureOpts {
  /** `currentRunId` as published, verbatim. `null` omits it. */
  readonly pointer: unknown;
  /** Run directories to create, each with a real ledger and a real sidecar. */
  readonly runs?: readonly string[];
  /**
   * Write `runs/.resets.json`. Default true, because it is this suite's
   * unrelated-fence control. `false` isolates the sidecar fence: `rm -rf
   * .traffic-one` covers the reset record too, so in a project that HAS been
   * reset a neighbour fence refuses the whole-tree wipe whatever this one
   * decides — see `assertControls` and the bare-project test below.
   */
  readonly resetRecord?: boolean;
}

function fixture(opts: FixtureOpts): Fixture {
  const runs = opts.runs ?? [LIVE, FINISHED];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-runid-shape-'));
  const env = process.env;
  const prevPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const prevPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const t1 = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
  fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({
    generatedBy: 'traffic-one',
    stack: 'default',
    rules: ['rules/common/auth-gate.md'],
    skills: ['project-memory'],
  }), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'AGENTS.md'),
    'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n',
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
  fs.writeFileSync(path.join(t1, 'plan.md'), 'plan', 'utf8');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const a = 1;\n', 'utf8');
  // The project-level reset record, whose own fence is a CONTROL below. Its
  // FENCE is path-based and refuses whether or not the file exists, so removing
  // the file keeps the control while taking the record out of the runs tree.
  fs.mkdirSync(path.join(t1, 'runs'), { recursive: true });
  if (opts.resetRecord !== false) {
    fs.writeFileSync(path.join(t1, 'runs', '.resets.json'), JSON.stringify({
      schemaVersion: 1, count: 1, events: [], obligations: {},
    }), 'utf8');
  }
  resetAuthoringRootCache();

  const state: Record<string, unknown> = {
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { framework: 'none' },
    onboardingComplete: true,
    materializedStack: 'default|react-vite|supabase|none',
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
  };
  const wroteBase = writeState(dir, state);
  const ledgers = runs.map((id) => Boolean(
    ensureRunLedger(dir, id, { status: 'planned', kind: 'spawn-gate' }),
  ));
  for (const id of runs) recordScanBoundHit(dir, id, 'fixture');
  const sidecars = runs.every((id) => (
    fs.existsSync(path.join(t1, 'runs', id, 'run.json'))
    && fs.existsSync(path.join(t1, 'runs', id, 'scan-bound.json'))
  ));
  // The pointer last, so no earlier writer can normalize it away.
  const wrotePointer = opts.pointer === null
    ? true
    : writeState(dir, { ...state, currentRunId: opts.pointer });

  return {
    dir,
    writersHonoured: wroteBase && ledgers.every(Boolean) && sidecars && wrotePointer,
    cleanup: () => {
      if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
      else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
      if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN;
      else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The two stand-down controls, asserted inside the fixture that is about to be
 * measured. A fixture measuring the authoring-root stand-down permits both.
 */
function assertControls(fx: Fixture, label: string): void {
  assert.equal(fx.writersHonoured, true,
    `${label}: CONTROL — a real product writer refused, so this fixture is not a project`);
  const record = bash(fx.dir, 'rm -f .traffic-one/runs/.resets.json');
  assert.equal(record.denyId, 'reset-record-owner-gate',
    `${label}: CONTROL — an unrelated fence permitted, so this fixture measures the stand-down`);
  const source = gate(fx.dir, 'Write', 'file-write', {
    file_path: path.join(fx.dir, 'src', 'app.ts'),
    content: 'export const a = 2;\n',
  });
  assert.equal(source.denied, true,
    `${label}: CONTROL — an ordinary src write permitted, so this fixture measures the stand-down`);
}

/** The two whole-tree wipes the defect flipped to PERMIT. */
const WIPES = ['rm -rf .traffic-one', 'rm -rf .traffic-one/runs'] as const;

/**
 * Every pointer that must route into the branch protecting EVERY run.
 *
 * The first three are already-shipped behaviour (absent/empty/whitespace all
 * deny today) and are here as the false-positive baseline the rest match. The
 * six after them are the reported values. The last four are the corruption
 * shapes a fix aimed only at the reported six would have left open.
 */
const DISARMING_POINTERS: ReadonlyArray<readonly [string, unknown]> = [
  ['absent (shipped baseline)', null],
  ['empty (shipped baseline)', ''],
  ['whitespace (shipped baseline)', '   '],
  ['parent traversal', '..'],
  ['current directory', '.'],
  ['absolute path', '/tmp/x'],
  ['relative path', 'a/b'],
  ['NUL', '\u0000'],
  ['deep escape', '../../../../../../tmp/t1-escape'],
  ['well-shaped, names no run', 'no-such-run'],
  ['400 characters', 'a'.repeat(400)],
  ['trailing slash', `${LIVE}/`],
  ['leading dot', `.${LIVE}`],
  ['dot-dot inside', `a..${LIVE}`],
];

test('a currentRunId that is not a live run id protects every run at the gate', () => {
  for (const [label, pointer] of DISARMING_POINTERS) {
    for (const command of WIPES) {
      // A FRESH fixture per row: the gate's own deny-capture writers create
      // `runs/<pointer>/debug/` on the first refusal, so a second measurement in
      // the same fixture would be asking a different question.
      const fx = fixture({ pointer });
      try {
        assertControls(fx, `${label} / ${command}`);
        const out = bash(fx.dir, command);
        assert.equal(out.denied, true, `${label}: \`${command}\` was PERMITTED`);
        assert.equal(out.denyId, SIDECAR_DENY, `${label}: \`${command}\` denied by the wrong fence`);
        assert.match(out.message, /scan-bound\.json|run\.json/,
          `${label}: the refusal names no runtime sidecar`);
      } finally {
        fx.cleanup();
      }
    }
  }
});

/**
 * The defect in its sharpest form: a project that has never been RESET.
 *
 * `rm -rf .traffic-one` covers `runs/.resets.json` as well as the runs tree, so
 * in a project carrying a reset record the whole-tree wipe is refused by
 * `reset-record-owner-gate` whatever this fence decides — which is why the rows
 * above assert the sidecar fence's OWN deny id rather than merely "denied", and
 * why they red on the wrong-fence answer rather than on a permit. With no reset
 * record on disk there is no neighbour, and the disarmed fence let the whole tree
 * go: measured PERMIT for every pointer in `DISARMING_POINTERS` before the fix.
 */
test('with no reset record to fall back on, a damaged pointer still cannot wipe the tree', () => {
  for (const [label, pointer] of DISARMING_POINTERS) {
    for (const command of WIPES) {
      const fx = fixture({ pointer, resetRecord: false });
      try {
        assertControls(fx, `bare project / ${label} / ${command}`);
        const out = bash(fx.dir, command);
        assert.equal(out.denyId, SIDECAR_DENY,
          `bare project / ${label}: \`${command}\` → ${out.denied ? out.denyId : 'PERMIT'}`);
      } finally {
        fx.cleanup();
      }
    }
  }
});

// A case-ONLY mismatch needs the directory to exist under the other spelling,
// which the table above cannot express. `existsSync` answers YES for `RUN-ALPHA`
// when only `run-alpha` exists on a case-insensitive filesystem, so an existence
// check spelled that way would let this row disarm the fence while the
// comparison inside `otherRun` stayed case-sensitive.
test('a pointer differing from the run directory only by case protects every run', () => {
  const fx = fixture({ pointer: 'RUN-ALPHA', runs: ['run-alpha', FINISHED] });
  try {
    assertControls(fx, 'case-only mismatch');
    for (const command of WIPES) {
      const out = bash(fx.dir, command);
      assert.equal(out.denyId, SIDECAR_DENY, `case-only mismatch: \`${command}\` was PERMITTED`);
    }
  } finally {
    fx.cleanup();
  }
});

/**
 * The shape the grammar and the existence test pass TOGETHER and still get
 * wrong: a runs entry that is a SYMLINK, pointing at a run directory outside the
 * project. The id is well-formed and the entry is really there, so a fix that
 * asked only those two questions permitted both wipes again (measured) — the
 * narrowing fired on the link's name while `sidecarsUnder`, which walks
 * `isDirectory()` entries, could see nothing under it to protect.
 *
 * This is also the answer to "an id that is valid but points outside the
 * project": a value the grammar admits carries no separator and no `..`, so a
 * symlink is the only way it can name anything outside, and this closes it.
 */
test('a runs entry that is a symlink out of the project is not a live run', () => {
  const fx = fixture({ pointer: 'run-linked' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 't1-outside-run-'));
  try {
    fs.writeFileSync(path.join(outside, 'run.json'), '{"status":"planned"}', 'utf8');
    fs.writeFileSync(path.join(outside, 'scan-bound.json'), '{"bound":true}', 'utf8');
    fs.symlinkSync(outside, path.join(fx.dir, '.traffic-one', 'runs', 'run-linked'));
    assertControls(fx, 'symlinked run dir');
    for (const command of WIPES) {
      const out = bash(fx.dir, command);
      assert.equal(out.denyId, SIDECAR_DENY,
        `symlinked run dir: \`${command}\` → ${out.denied ? out.denyId : 'PERMIT'}`);
    }
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fx.cleanup();
  }
});

// The narrowing's whole reason for existing. If this reds, the fix has bought
// its closure by refusing ordinary housekeeping, which is the trade the
// narrowing was added to avoid.
test('a live run id still narrows the fence to the run being protected', () => {
  const fx = fixture({ pointer: LIVE });
  try {
    assertControls(fx, 'live id');
    const finished = bash(fx.dir, `rm -rf .traffic-one/runs/${FINISHED}`);
    assert.equal(finished.denied, false,
      `deleting a finished run's directory must stay permitted: ${finished.denyId}`);
    for (const command of WIPES) {
      assert.equal(bash(fx.dir, command).denyId, SIDECAR_DENY,
        `a whole-tree wipe reaches the live run and must be refused: ${command}`);
    }
    assert.equal(bash(fx.dir, `rm -rf .traffic-one/runs/${LIVE}`).denyId, SIDECAR_DENY,
      "the live run's own directory is refused");
  } finally {
    fx.cleanup();
  }
});

/**
 * A validator stricter than the MINTERS would refuse real runs, which is worse
 * than the defect. Both minters are exercised here, plus the legacy ids
 * `ensureCurrentRunId` hands back verbatim (it validates nothing), plus the ids
 * the shipped fence suites drive the gate with.
 *
 * `/^\d{13}$/` — the shape five other call sites use for SCANNING runs/ — is
 * what this row rules out: it rejects the reset runner's `${runIdNow()}-r`
 * successor, which is a real live run id.
 */
test('every id the product actually mints or carries is accepted as live', () => {
  const minted = runIdNow();
  const ids = [
    minted,                 // runIdNow()
    `${minted}-r`,          // traffic-one-reset/reset.ts's successor id
    'run-1',                // the id the shipped sidecar-fence suites use
    'legacy-current',       // ensureCurrentRunId returns an existing id verbatim
    'R',
    '1785169657252.2',
  ];
  for (const id of ids) {
    assert.equal(isDoctorIdArgument(id), true, `${id}: the grammar rejects a real run id`);
    const fx = fixture({ pointer: id, runs: [id, FINISHED] });
    try {
      assertControls(fx, `minted ${id}`);
      assert.equal(bash(fx.dir, `rm -rf .traffic-one/runs/${FINISHED}`).denied, false,
        `${id}: a real run id must still narrow the fence`);
      assert.equal(bash(fx.dir, 'rm -rf .traffic-one/runs').denyId, SIDECAR_DENY,
        `${id}: and the live run must still be protected`);
    } finally {
      fx.cleanup();
    }
  }
});
