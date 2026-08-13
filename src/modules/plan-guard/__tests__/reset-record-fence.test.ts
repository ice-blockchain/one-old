// The reset record's fence, asserted at the GATE.
//
// ── WHY THIS FILE EXISTS AS A SEPARATE PIN ──────────────────────────────────
// `.traffic-one/runs/.resets.json` had no fence of its own for its entire
// history, and nobody noticed for a measurable reason: the tests that covered
// the path asserted what the write-target SCANNER extracted
// (`shellTrafficOneWriteTargets(...) === ['.traffic-one/runs/.resets.json']`)
// and never once asked what the gate decided about it. The scanner found the
// path; the gate then refused it for the wrong reason entirely — `.resets.json`
// parsed as a fabricated RUN ID, so every refusal on the path was
// `run-id-mismatch`, telling the writer to write under
// `.traffic-one/runs/<currentRunId>/` instead. Two consequences, both measured
// through `planWriteGate` on a materialized fixture before the fence existed:
//
//   with currentRunId set     20 of 27 erasure channels refused, 7 PERMITTED
//   with currentRunId ABSENT   0 of 27 refused — every one PERMITTED
//
// The second row is the whole point: `strayRunIdInText` returns null when no run
// id is minted, so the record's entire defence was conditional on a live run
// pointer, which is state an actor can damage. And because the refusal came from
// a MISPARSE, the fence was one correct narrowing away from silent removal.
//
// So every assertion here drives `planWriteGate` and reads its `denyId`. None
// matches source text, and none calls a predicate alone — the two instruments
// that were green while the path was open.
//
// ── WHAT MAKES THE ACCIDENT UNREPEATABLE ────────────────────────────────────
// The misparse is now GONE (`strayRunIdInText` skips dot-prefixed segments,
// shared/run-id-paths.ts), so this suite is not measuring a belt beside a brace:
// it is the only thing standing on this path, and every row below reds if the
// fence is removed. The narrowing is pinned from the other side too, in
// shared/__tests__/run-id-paths.test.ts ('a dot-prefixed segment is a
// project-level record, not a stray run id'), so the two cannot silently swap
// places again — one asserts the accident is gone, the other that the
// replacement holds.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';

import { planWriteGate } from '../plan-write';
import { modelExhaustionTerminalForRole } from '../../agent-model/exhausted-models';
import { RESETS_FILE, recordReset, readResetRecord } from '../../../runners/traffic-one-reset/resets';
import { RESET_RECORD_REL } from '../plan-readiness/context';
import { strayRunIdInText } from '../../../shared/run-id-paths';
import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';

const ROLE = 'senior-frontend';
const OBLIGED_RUN = 'run-1';

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
  tool: Record<string, unknown> = {},
): Outcome {
  const input: HookInput = {
    event: 'PreToolUse',
    host: 'claude' as HostId,
    cwd,
    raw: { tool_name: rawName, tool_input: toolInput },
    tool: { class: cls, rawName, ...tool },
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

/** The record's shape as `resetObligationFor` reads it: a live obligation
 *  against OBLIGED_RUN, and a count that prices the next reset. */
function writeRecord(dir: string): void {
  fs.writeFileSync(recordFile(dir), JSON.stringify({
    schemaVersion: 1,
    count: 5,
    events: [{ at: 'x', from: 'run-0', to: OBLIGED_RUN, status: 'failed', carried: [] }],
    obligations: { [OBLIGED_RUN]: { terminalRoles: [ROLE] } },
  }), 'utf8');
}

/** Assembled from the RUNNER's own constant, so renaming `RESETS_FILE` without
 *  moving the fence reds this suite instead of silently unfencing the file. */
function recordFile(dir: string): string {
  return path.join(dir, '.traffic-one', 'runs', RESETS_FILE);
}

interface FixtureOpts {
  /** `currentRunId` in `.one.json`, or null to omit it entirely. */
  readonly runId?: string | null;
  /** Create `runs/<OBLIGED_RUN>/` holding real runtime sidecars. */
  readonly runDir?: boolean;
}

function fixture(opts: FixtureOpts = {}): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-reset-fence-'));
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
  fs.writeFileSync(path.join(t1, '.one.json'), JSON.stringify({
    mode: 'new-project',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: { framework: 'none' },
    onboardingComplete: true,
    materializedStack: 'default|react-vite|supabase|none',
    ...(opts.runId ? { currentRunId: opts.runId } : {}),
  }), 'utf8');
  fs.writeFileSync(env.TRAFFIC_ONE_PROJECT_PREFS_PATH, JSON.stringify({
    performance: { level: 'low', source: 'prompted' },
    team: { mode: 'main-agent', source: 'prompted' },
  }), 'utf8');
  fs.mkdirSync(path.join(t1, 'runs'), { recursive: true });
  if (opts.runDir !== false) {
    const runDir = path.join(t1, 'runs', OBLIGED_RUN);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'scan-bound.json'), JSON.stringify({ bound: true }), 'utf8');
    fs.writeFileSync(
      path.join(runDir, 'run.json'),
      JSON.stringify({ schemaVersion: 1, runId: OBLIGED_RUN, status: 'planned' }),
      'utf8',
    );
  }
  writeRecord(dir);
  resetAuthoringRootCache();
  return {
    dir,
    cleanup: () => {
      if (prevPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
      else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prevPrefs;
      if (prevPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN;
      else env.TRAFFIC_ONE_USER_PLAN = prevPlan;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const RESETS = RESET_RECORD_REL;

/** Every erasure channel measured as reachable before the fence existed, plus
 *  the ones the shared write-primitive detector documents as invisible to it —
 *  this fence must not depend on that detector, because a fence that holds only
 *  while a detector is complete is the accident in a new place. */
const ERASURE_CHANNELS: ReadonlyArray<readonly [string, string]> = [
  ['rm -f', `rm -f ${RESETS}`],
  ['rm', `rm ${RESETS}`],
  ['mv away', `mv ${RESETS} parked.json`],
  ['truncate', `truncate -s 0 ${RESETS}`],
  ['redirect', `echo '{}' > ${RESETS}`],
  [': >', `: > ${RESETS}`],
  ['tee', `printf '{}' | tee ${RESETS}`],
  ['cp /dev/null', `cp /dev/null ${RESETS}`],
  ['install /dev/null', `install /dev/null ${RESETS}`],
  ['sed -i', `sed -i '' 's/senior-frontend//' ${RESETS}`],
  ['node unlinkSync', `node -e "require('fs').unlinkSync('${RESETS}')"`],
  ['node writeFileSync', `node -e "require('fs').writeFileSync('${RESETS}','{}')"`],
  ['python unlink', `python3 -c "import pathlib;pathlib.Path('${RESETS}').unlink()"`],
  ['nested bash -c', `bash -c 'rm -f ${RESETS}'`],
  ['bash -o pipefail -c', `bash -o pipefail -c 'rm -f ${RESETS}'`],
  ['interpreter heredoc', `python3 <<'PY'\nimport os\nos.remove('${RESETS}')\nPY`],
  ['perl -pi', `perl -pi -e 's/senior-frontend//' ${RESETS}`],
  ['piped stdin to node', `echo "require('fs').unlinkSync('${RESETS}')" | node`],
  ['computed verb', `node -e "const f=require('fs');f['un'+'link'+'Sync']('${RESETS}')"`],
  // Round 3: two verbs that were on the READ list and write with one flag.
  // `sort` and `yq` were both listed unconditionally, so `sort -o <record>` and
  // `yq -i` — each the documented in-place form of its tool — were PERMITTED by
  // the arm whose whole polarity is fail-closed. Found by asking which read-list
  // entries can write, which is the same question the eval vocabulary now
  // answers with a capability table rather than with a list of losses.
  ['sort -o', `sort -o ${RESETS} /dev/null`],
  ['yq -i', `yq -i '.count = 0' ${RESETS}`],
  // Replacing compressors: `gzip <record>` leaves `<record>.gz` and no record.
  ['gzip', `gzip -f ${RESETS}`],
  ['patch', `patch -p1 -i /dev/null ${RESETS}`],
  // A worktree-rewriting git spelling that NAMES the record. Held by the
  // fail-closed verb polarity even before round 3 — the directory-scoped
  // spellings, which had no such backstop, are in the ancestor test below.
  ['git checkout --', `git checkout -- ${RESETS}`],
];

test('reset record: every erasure channel is refused by reset-record-owner-gate', () => {
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    for (const [label, command] of ERASURE_CHANNELS) {
      const outcome = bash(f.dir, command);
      assert.ok(outcome.denied, `${label} was PERMITTED: ${command}`);
      assert.equal(outcome.denyId, 'reset-record-owner-gate', `${label} denied by the wrong gate`);
    }
    // The text tools reach the same gate through the ordinary target, so the
    // fence is not a shell-only fence.
    const written = gate(f.dir, 'Write', 'file-edit', { file_path: RESETS, content: '{}' });
    assert.equal(written.denyId, 'reset-record-owner-gate');
    const edited = gate(f.dir, 'Edit', 'file-edit', {
      file_path: RESETS,
      old_string: ROLE,
      new_string: '',
    });
    assert.equal(edited.denyId, 'reset-record-owner-gate');
  } finally {
    f.cleanup();
  }
});

test('reset record: the fence holds with no currentRunId at all', () => {
  // THE ROW THAT MATTERS MOST. Before the fence, this variant refused NOTHING:
  // the only refusal on the path came from `strayRunIdInText`, which stands down
  // when no run id is minted. A fence conditional on a live run pointer is a
  // fence an actor opens by damaging the pointer.
  const f = fixture({ runId: null });
  try {
    // First, the accident is really gone rather than merely bypassed: nothing in
    // the run-id guard answers for this path in EITHER variant.
    assert.equal(strayRunIdInText(`rm -f ${RESETS}`, OBLIGED_RUN), null);
    assert.equal(strayRunIdInText(`rm -f ${RESETS}`, ''), null);
    for (const [label, command] of ERASURE_CHANNELS) {
      const outcome = bash(f.dir, command);
      assert.ok(outcome.denied, `${label} was PERMITTED with no currentRunId: ${command}`);
      assert.equal(outcome.denyId, 'reset-record-owner-gate', `${label} denied by the wrong gate`);
    }
    const written = gate(f.dir, 'Write', 'file-edit', { file_path: RESETS, content: '{}' });
    assert.equal(written.denyId, 'reset-record-owner-gate');
  } finally {
    f.cleanup();
  }
});

// ── THE FIGURE THE FAIL-CLOSED ROW PRICES ITSELF ON ────────────────────────
// hooks/fail-closed.ts's `reset` row admits a residual and answers it by
// leaning on this fence, in a sentence carrying two numbers: "the same N
// channels now measure 0 escapes across all <n> pointer variants". Neither
// number had a line. The corpus above is driven in TWO of those cells, the
// tool channels are driven in one, `apply_patch` in none, and the counts lived
// only in the comment — a number in a sentence, which is the shape this tree
// has twice watched stop agreeing with itself.
//
// So the sentence is READ OUT OF THE ROW rather than restated here, and the
// corpus is measured against it. The numbers stay in one file, and a corpus
// that grows or a cell that opens reds the row that cites it.
//
// The cells are the two independent dimensions the fixture already carries,
// crossed: `currentRunId` present or absent, and the run DIRECTORY it points at
// present or absent. The cell that looked least interesting when the corpus was
// written matters most — a project with no run directory is what `finished` and
// post-reset look like, and it is exactly when the record is the only thing left
// in `runs/` to destroy.
const POINTER_VARIANTS: ReadonlyArray<readonly [string, FixtureOpts]> = [
  ['pointer, run dir', { runId: OBLIGED_RUN, runDir: true }],
  ['pointer, no run dir', { runId: OBLIGED_RUN, runDir: false }],
  ['no pointer, run dir', { runId: null, runDir: true }],
  ['neither', { runId: null, runDir: false }],
];

const NUMBER_WORDS: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };

/** The row's own sentence, with the comment markers stripped. */
function rowFigure(): { channels: number; escapes: number; variants: string } {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'hooks', 'fail-closed.ts'), 'utf8',
  );
  const prose = source.replace(/^[ \t]*\/\/ ?/gm, '').replace(/\s+/g, ' ');
  const found = /the same (\d+) channels now measure (\d+) escapes across all (\w+) pointer variants/
    .exec(prose);
  assert.ok(found, 'hooks/fail-closed.ts no longer states the figure this suite is the pin for. '
    + 'If the row stopped leaning on this fence, delete this test with it; if the sentence was '
    + 'reworded, reword this parser — do not leave the row citing a measurement nothing takes');
  return {
    channels: Number(found[1]),
    escapes: Number(found[2]),
    variants: String(found[3]),
  };
}

test('reset record: the fail-closed row\'s figure holds — every channel, every pointer variant', () => {
  const figure = rowFigure();
  assert.equal(NUMBER_WORDS[POINTER_VARIANTS.length], figure.variants,
    `the row prices itself on ${figure.variants} pointer variants and this suite drives `
    + `${POINTER_VARIANTS.length}`);

  // The row names Write/Edit/apply_patch, which the shell corpus does not
  // carry. `apply_patch` is spelled as a DELETE: an Update patch whose context
  // does not match the record's one-line JSON is refused upstream as
  // `apply-patch-reconstruction-failed`, a verdict this fence never gets asked
  // for — a channel that reds for the wrong reason is not a channel.
  const toolChannels = (dir: string): ReadonlyArray<readonly [string, Outcome]> => [
    ['Write', gate(dir, 'Write', 'file-edit', { file_path: RESETS, content: '{}' })],
    ['Edit', gate(dir, 'Edit', 'file-edit', { file_path: RESETS, old_string: ROLE, new_string: '' })],
    ['apply_patch', (() => {
      const patchText = `*** Begin Patch\n*** Delete File: ${RESETS}\n*** End Patch\n`;
      return gate(dir, 'apply_patch', 'file-edit', { patchText }, { patchText });
    })()],
  ];

  let measured = 0;
  const escaped: string[] = [];
  for (const [cell, opts] of POINTER_VARIANTS) {
    const f = fixture(opts);
    try {
      const channels: Array<readonly [string, Outcome]> = [
        ...ERASURE_CHANNELS.map(([label, command]) => [label, bash(f.dir, command)] as const),
        ...toolChannels(f.dir),
      ];
      assert.equal(channels.length, figure.channels,
        `the row cites ${figure.channels} channels and this suite drives ${channels.length}. `
        + 'A corpus that grew without the row noticing leaves the row pricing a smaller measurement '
        + 'than the one that exists');
      for (const [label, outcome] of channels) {
        measured += 1;
        if (!outcome.denied) { escaped.push(`${cell} :: ${label} PERMITTED`); continue; }
        assert.equal(outcome.denyId, 'reset-record-owner-gate',
          `${cell} :: ${label} was refused by ${outcome.denyId}, not by the record's own fence — `
          + 'the row leans on THIS gate, and a refusal from elsewhere is one a narrowing can remove');
      }
    } finally {
      f.cleanup();
    }
  }
  assert.deepEqual(escaped, [], `the row states ${figure.escapes} escapes`);
  assert.equal(measured, figure.channels * POINTER_VARIANTS.length, 'every cell must be driven');
});

test('reset record: destruction of a directory containing it is refused when nothing else in runs/ is', () => {
  // The channels that name no file. With a live run present these are already
  // refused by `runtime-sidecar-owner-gate`, which enumerates the run's own
  // sidecars — so the gap is precisely the state where `runs/` holds the record
  // and no run directory, which retention reaches on its own (it sweeps run
  // DIRECTORIES and leaves this file). The record still prices the next reset in
  // that state, which is what makes the gap worth closing.
  const f = fixture({ runId: null, runDir: false });
  try {
    for (const command of [
      'rm -rf .traffic-one/runs',
      'rm -rf .traffic-one',
      'rm -rf .traffic-one/*',
      'git clean -fdx',
      "find .traffic-one/runs -name '*.json' -delete",
      'git stash push -u',
      // ROUND 3. This arm used to refuse only `stash -u/-a` and a forced
      // `clean`, on the premise that the record is "untracked by construction
      // (`.traffic-one` is gitignored)". Gitignore never untracks what is
      // already committed, and `scaffold-content.ts` records that state
      // shipping in the field; in it, each of these rolls `count` and
      // `terminalRoles` back to a committed version, which by this module's own
      // opening measurement ADMITS a spawn that should be denied.
      'git checkout -- .traffic-one/runs',
      'git checkout .',
      'git restore .',
      'git reset --hard',
      'git stash push .traffic-one/runs',
      'git rm -r .traffic-one/runs',
      'gzip -r .traffic-one',
      'unzip -o /dev/null -d .traffic-one/runs',
    ]) {
      const outcome = bash(f.dir, command);
      assert.ok(outcome.denied, `PERMITTED: ${command}`);
      assert.equal(outcome.denyId, 'reset-record-owner-gate', `wrong gate for: ${command}`);
    }
  } finally {
    f.cleanup();
  }
});

test('reset record: reads stay permitted and ordinary housekeeping is not refused', () => {
  // The cost side of a fail-closed fence. The named arm refuses any verb it does
  // not recognise as a read, so the read vocabulary has to be real, and the
  // housekeeping idioms the impact lane added PERMIT rows for must survive —
  // trading a fail-open for a false refusal is not a fix.
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    for (const command of [
      `cat ${RESETS}`,
      `head -c 200 ${RESETS}`,
      `tail -n 5 ${RESETS}`,
      `wc -c ${RESETS}`,
      `grep -c count ${RESETS}`,
      `jq -r .count ${RESETS}`,
      `sed -n '1p' ${RESETS}`,
      `test -f ${RESETS}`,
      `ls -la ${RESETS}`,
      `cat ${RESETS} | jq .count`,
      `node -e "console.log(require('fs').readFileSync('${RESETS}','utf8'))"`,
      `python3 -c "print(open('${RESETS}').read())"`,
      `bash -c 'cat ${RESETS}'`,
      'rm -rf node_modules',
      'rm -rf dist build',
      'rm -rf .traffic-one/runs/run-0',
      'rm -rf .traffic-one/runs/run-0/scan-bound.json',
      'git clean -fdx src',
      "find . -name '*.log' -delete",
      'mv README.md docs/README.md',
      // The reads the round-3 conditionals must keep: `sort`/`yq` without their
      // writing flag, and git spellings scoped away from the record or not
      // touching the worktree at all.
      `sort ${RESETS}`,
      `yq '.count' ${RESETS}`,
      'git checkout -- src',
      'git checkout main',
      'git restore --staged .traffic-one',
      'git reset --soft HEAD~1',
      'git rm --cached -r .traffic-one/runs',
    ]) {
      const outcome = bash(f.dir, command);
      assert.ok(
        !outcome.denied || outcome.denyId !== 'reset-record-owner-gate',
        `FALSE REFUSAL of ${command}: ${outcome.message.slice(0, 160)}`,
      );
    }
  } finally {
    f.cleanup();
  }
});

test('reset record: the fail-closed cost is a mention in a shell string, and it is paid knowingly', () => {
  // The price of the inverse rule, pinned so it is a decision rather than a
  // surprise. `echo` cannot join the read vocabulary: the piece an interpreter
  // runs off a pipe carries no filename of its own, so `echo "<code>" | node`
  // erases the record with the MENTION as the only visible trace — measured as a
  // live channel. Refusing echo therefore closes a real erasure and costs a real
  // false refusal, and this row is which way that was traded. If a future round
  // reverses it, the pipe channel in the erasure list above must red instead.
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    const mention = bash(f.dir, `echo "see ${RESETS} for the reset ladder" >> notes.md`);
    assert.equal(mention.denyId, 'reset-record-owner-gate');
    // The remedy the deny leans on: prose ABOUT the record, written through the
    // tool that writes prose, is untouched — the fence keys on the write target.
    const note = gate(f.dir, 'Write', 'file-edit', {
      file_path: 'notes.md',
      content: `the ladder lives in ${RESETS}\n`,
    });
    assert.ok(
      !note.denied || note.denyId !== 'reset-record-owner-gate',
      'writing a note that MENTIONS the record must not hit the record\'s fence',
    );
  } finally {
    f.cleanup();
  }
});

// THE PIN THAT MAKES THE NARROWING RED. Read this before "fixing" the row above.
//
// The obvious follow-up to the false refusal pinned above is to stop treating
// `echo`/`printf` segments as writers. A peer built exactly that narrowing on a
// copy and measured it: ONE over-refusal bought, FOUR fail-opens sold. Then it
// built the fix a future author writes on seeing the single red row that
// resulted — keep an `echo` segment that CONTAINS a redirect — and the suite
// came back 35 pass / 0 fail while three of these four reached noop. A cost
// recorded in prose that no assertion reads is a cost the next round will
// re-trade without noticing.
//
// So each row below states what the narrowing would cost, and asserts the deny.
// They are deliberately spelled both at the top level and inside a `bash -c`
// body, because the narrowing that looked safe was scoped to the nested body.
const ECHO_NARROWING_WOULD_REOPEN: ReadonlyArray<readonly [string, (record: string) => string]> = [
  ['command substitution runs the rm before echo ever sees a word',
    (record) => `echo $(rm -f ${record})`],
  ['the backtick spelling of the same substitution',
    (record) => `echo \`rm -f ${record}\``],
  ['echo is the LEFT side of a redirect ONTO the record — the verb reads, the line writes',
    (record) => `echo hi > ${record}`],
  ['the echoed text is the program, and `sh` is the writer',
    (record) => `echo 'rm -f ${record}' | sh`],
  ['the same, with an interpreter: the piece node runs carries no filename of its own',
    (record) => `echo "require('fs').unlinkSync('${record}')" | node`],
];

test('reset record: narrowing the echo refusal would reopen four measured channels', () => {
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    for (const [cost, build] of ECHO_NARROWING_WOULD_REOPEN) {
      for (const command of [build(RESETS), `bash -c ${JSON.stringify(build(RESETS))}`]) {
        const outcome = bash(f.dir, command);
        assert.ok(outcome.denied, `PERMITTED — ${cost}: ${command}`);
        assert.equal(
          outcome.denyId, 'reset-record-owner-gate',
          `denied by the wrong gate — ${cost}: ${command}`,
        );
      }
    }
  } finally {
    f.cleanup();
  }
});

test('reset record: the refusal names no run directory to write it under', () => {
  // The misparse did not only fail to hold — it MIS-INSTRUCTED. Its message told
  // the writer to "read `currentRunId` and write under
  // `.traffic-one/runs/<currentRunId>/` instead", a remedy no writer of this
  // path can follow, and a refusal whose remedy cannot be followed teaches an
  // agent to work around the fence rather than stop.
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    const outcome = bash(f.dir, `rm -f ${RESETS}`);
    assert.equal(outcome.denyId, 'reset-record-owner-gate');
    // The misparse's exact instruction, which must not appear: a run directory
    // to put this file in.
    assert.ok(
      !outcome.message.includes(`.traffic-one/runs/${OBLIGED_RUN}/`),
      'the refusal points at a run directory, which is the misparse\'s unfollowable remedy',
    );
    assert.ok(!/currentRunId/.test(outcome.message), 'the refusal must not send the reader to currentRunId');
    assert.ok(
      /no correct run directory/i.test(outcome.message),
      'the refusal must say outright that there is no run directory for this file',
    );
    assert.ok(/READING it is allowed/.test(outcome.message), 'the refusal must say that reading is allowed');
    // And the target is attributed, so the reader is not left guessing which of
    // several paths in a compound command was refused.
    assert.ok(outcome.message.includes(RESETS));
  } finally {
    f.cleanup();
  }
});

test('reset record: the fence protects the exhaustion answer it exists for', () => {
  // The price, end to end, on the fixture the gate was just driven on: this is
  // the answer `correlatedCursorFailureGate` denies `cursor-api-limit-terminal`
  // on, and it is what erasing the record buys. A role whose model is exhausted
  // respawning with no user answer is the outcome on the far side.
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    assert.equal(modelExhaustionTerminalForRole(f.dir, OBLIGED_RUN, ROLE), true);
    // Unlinked and truncated both admit — so both must be refused above, and
    // truncation is why the fence cannot be a delete-only fence.
    fs.rmSync(recordFile(f.dir), { force: true });
    assert.equal(modelExhaustionTerminalForRole(f.dir, OBLIGED_RUN, ROLE), false);
    fs.writeFileSync(recordFile(f.dir), '', 'utf8');
    assert.equal(modelExhaustionTerminalForRole(f.dir, OBLIGED_RUN, ROLE), false);
    writeRecord(f.dir);
    assert.equal(modelExhaustionTerminalForRole(f.dir, OBLIGED_RUN, ROLE), true);
  } finally {
    f.cleanup();
  }
});

test('reset record: the one legitimate writer is not fenced out by its own gate', () => {
  // `recordReset` writes through `writeJson`, in-process, and never crosses the
  // plan gate — the fence refuses TOOL CALLS, not the product. If that ever
  // stopped being true the recovery command would start failing to count its own
  // reset, and the ladder would silently stop pricing.
  const f = fixture({ runId: OBLIGED_RUN });
  try {
    const before = readResetRecord(f.dir).count;
    const wrote = recordReset(
      f.dir,
      { at: 'now', from: OBLIGED_RUN, to: 'run-2', status: 'failed', carried: [ROLE] },
      { terminalRoles: [ROLE] },
    );
    assert.equal(wrote, true, 'recordReset was refused — the fence has caught the product');
    assert.equal(readResetRecord(f.dir).count, before + 1);
  } finally {
    f.cleanup();
  }
});
