// THE EXTRACTION CORPUS: every row driven through the REAL plan-write gate, and
// priced at a GATE OUTCOME rather than at a unit verdict.
//
// It exists because round 6 was measured merge-blocked on four escapes that a
// unit test could not have shown and a corpus of the matcher's own shapes did
// not contain. Each was the same defect wearing a different spelling: the
// read/write JUDGEMENT was right and the path never reached it, because a
// tokenizer or an extractor dropped it first. `(rm -rf .traffic-one/runs)`,
// `rm -rf "$PWD/.traffic-one/runs"`, `find <tree> -exec sh -c '…rm…'` and
// `if true; then find . -name run.json -delete; fi` each erased a live
// `run.json` at gate outcome `noop`.
//
// THREE CORPORA WITH THREE DIFFERENT JOBS.
//
//   DESTRUCTIVE — every row GROUND-TRUTHED against a real interpreter and a
//   real sidecar on disk (54 bytes before, absent or empty after) before it was
//   allowed in. Three rows were thrown out at that step for destroying nothing:
//   `((rm -rf …))` is arithmetic evaluation and not a nested subshell,
//   `rm -rf .` is refused by rm(1) itself, and one `xargs` row was a sandbox
//   artefact rather than a defence. A row that destroys nothing is not evidence
//   about a gate, whatever the gate answers.
//
//   PERMIT — ordinary work that destroys nothing, INCLUDING the five rows the
//   previous round's widening exists to permit. They are here so the narrowing
//   that closed blocker 1 is held to preserving them.
//
//   ORDINARY — 47 rows built by an ADVERSARIAL PEER from real repository
//   material, taken in verbatim. Round 6 reported over-refusal "measured ZERO"
//   from a 23-row corpus that contained no shell control flow at all, and the
//   corpus and the matcher shared an author. This one did not: it found 12
//   refusals, 5 disclosed nowhere. The ledger below is exact — a row moving in
//   EITHER direction reddens, so the next round cannot quietly buy a deny with
//   an over-refusal or the reverse.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { planWriteGate } from '../plan-write';
import type { Ctx, HookInput, HostId, ToolClass } from '../../../core/types';

// THE IDS ARE THE SHAPE PRODUCTION MINTS, and round 9 re-minted them because the
// shape decides an EXEMPTION. `plan-runid.ts strayNamesRealRun` exempts a stray
// run id from the id-mismatch refusal only when it matches /^\d{13}$/ AND names a
// real run directory, so a fixture whose runs are called `run-1` and `run-0`
// cannot reach that arm from either side: the exemption is pinned by nothing, and
// every row naming the FINISHED run was scored in the over-refusing direction by
// construction — `rm -rf .traffic-one/runs/run-0` measured deny:run-id-mismatch
// here and noop in production, which is the fixture disagreeing with the product
// rather than the product being measured.
//
// So the figures of rounds 6-8 taken on `run-1`/`run-0` are re-derived below on
// these two ids, and the prose sentence they support — "spell the id if you mean
// a finished run" — is now TRUE under the instrument that measures it. This is
// the same class round 8 fixed one layer down when it stopped scoring a
// truncating overwrite as a no-op: an instrument that cannot represent the
// distinction it is measuring.
const LIVE = '1715091785000';
const DONE = '1715005385000';
const RUN = `.traffic-one/runs/${LIVE}`;

interface Row { id: string; cmd: string; why: string }

/**
 * A post-onboarding project with a LIVE run, a FINISHED one, and the sidecars
 * both of them really hold. The gate reads `currentRunId` from `.one.json`, so
 * the run being protected is the run the rows name.
 *
 * ROUND 8 WIDENED THIS FIXTURE to the shape the two adversarial peers drove
 * their own corpora against — a second run, the debug decision log, the
 * bootstrap envelopes, and the sibling `digests`/`reports` trees. Their rows
 * name those paths, and a corpus row that lands on a file the fixture does not
 * have measures the absence rather than the gate. Round 7's three corpora were
 * re-measured under it before it was adopted and not one row moved: 36/36
 * destructions still refused, 18/18 permits still permitted, and the ordinary
 * ledger still exactly its seven.
 */
function project(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-extraction-'));
  const env = process.env;
  const previousPrefs = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  const previousPlan = env.TRAFFIC_ONE_USER_PLAN;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  env.TRAFFIC_ONE_USER_PLAN = 'pro';
  const state = path.join(dir, '.traffic-one');
  fs.mkdirSync(path.join(state, 'rules', 'common'), { recursive: true });
  fs.mkdirSync(path.join(state, 'skills', 'project-memory'), { recursive: true });
  fs.writeFileSync(path.join(state, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
  fs.writeFileSync(path.join(state, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
  fs.writeFileSync(path.join(state, 'manifest.json'), JSON.stringify({
    generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'],
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'see agents', 'utf8');
  fs.writeFileSync(path.join(state, 'plan.md'), 'plan', 'utf8');
  fs.writeFileSync(path.join(state, '.one.json'), JSON.stringify({
    mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' }, onboardingComplete: true,
    materializedStack: 'default|react-vite|supabase|none', currentRunId: LIVE,
  }), 'utf8');
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({
    performance: { level: 'low', source: 'prompted' }, team: { mode: 'main-agent', source: 'prompted' },
  }), 'utf8');
  for (const runId of [LIVE, DONE]) {
    const runDir = path.join(state, 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'debug'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'bootstrap', 'senior-frontend'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'bootstrap', 'senior-backend'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({
      schemaVersion: 1, runId, status: 'planned',
    }), 'utf8');
    fs.writeFileSync(path.join(runDir, 'scan-bound.json'), JSON.stringify({ bound: true }), 'utf8');
    fs.writeFileSync(path.join(runDir, 'verification-v2.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runDir, 'assignments.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runDir, 'debug', 'decisions.jsonl'), '{"e":1}\n', 'utf8');
    fs.writeFileSync(path.join(runDir, 'bootstrap', 'senior-frontend', 'active.json'), '{}', 'utf8');
    fs.writeFileSync(path.join(runDir, 'bootstrap', 'senior-backend', 'active.json'), '{}', 'utf8');
  }
  fs.mkdirSync(path.join(state, 'digests', LIVE), { recursive: true });
  fs.writeFileSync(path.join(state, 'digests', LIVE, 'architect.md'), 'd', 'utf8');
  fs.mkdirSync(path.join(state, 'reports', 'qa', LIVE), { recursive: true });
  fs.writeFileSync(path.join(state, 'reports', 'qa', LIVE, 'report-v2.json'), '{}', 'utf8');
  return {
    dir,
    cleanup: () => {
      if (previousPrefs === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
      else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = previousPrefs;
      if (previousPlan === undefined) delete env.TRAFFIC_ONE_USER_PLAN;
      else env.TRAFFIC_ONE_USER_PLAN = previousPlan;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The gate outcome of one command against a fresh project: `noop`, `ok` or `deny:<id>`. */
function outcome(command: string): string {
  const fixture = project();
  try {
    const input: HookInput = {
      event: 'PreToolUse',
      host: 'claude' as HostId,
      cwd: fixture.dir,
      raw: { tool_name: 'Bash', tool_input: { command } },
      tool: { class: 'shell' as ToolClass, rawName: 'Bash' },
    };
    const result = planWriteGate({ input, host: 'claude', cwd: fixture.dir, now: () => 'x' } as unknown as Ctx);
    if (result.kind !== 'deny') return result.kind;
    return `deny:${(result as { denyId?: string }).denyId || '?'}`;
  } finally {
    fixture.cleanup();
  }
}

/**
 * One double-quoted `bash -c` level, escaping BACKSLASHES as well as quotes.
 *
 * Escaping only the quotes — the obvious spelling, and the one the first driver
 * written for this used — produces `\\"` at depth 3, which bash reads as a
 * LITERAL backslash followed by the end of the string. That is a different
 * command from the one intended, and it made the gate look as though it went
 * `noop` on a deep nest. It does not: the malformed string was scored, the
 * well-formed one is refused, and the difference is recorded here so the next
 * driver does not re-derive the artefact. Both spellings were run against a
 * real bash over a real sidecar tree; only these are destructive.
 */
function nestDouble(inner: string, depth: number): string {
  let out = inner;
  for (let level = 0; level < depth; level += 1) out = `bash -c "${out.replace(/(["\\])/g, '\\$1')}"`;
  return out;
}

const DESTRUCTIVE: Row[] = [
  // An interpolated FIRST segment with a complete runs literal after it. The
  // operand used to be discarded on what its first segment looked like.
  { id: 'p1-pwd-tree', cmd: 'rm -rf "$PWD/.traffic-one/runs"', why: 'whole runs tree' },
  { id: 'p1-pwd-run', cmd: `rm -rf "$PWD/.traffic-one/runs/${LIVE}"`, why: 'live run dir' },
  { id: 'p1-pwdsub-run', cmd: `rm -rf "$(pwd)/.traffic-one/runs/${LIVE}"`, why: 'live run dir' },
  { id: 'p1-brace-run', cmd: `rm -rf "\${PWD}/.traffic-one/runs/${LIVE}"`, why: 'live run dir' },
  { id: 'p1-file', cmd: `rm -f "$PWD/.traffic-one/runs/${LIVE}/run.json"`, why: 'the sidecar itself' },
  { id: 'p1-dotslash', cmd: `rm -rf "$PWD/./.traffic-one/runs/${LIVE}"`, why: 'live run dir' },
  { id: 'p1-t1-root', cmd: 'rm -rf "$PWD/.traffic-one"', why: 'the whole state dir' },
  { id: 'p1-mv', cmd: `mv "$PWD/.traffic-one/runs/${LIVE}" ./gone`, why: 'moves the run away' },
  { id: 'p1-cp-over', cmd: `cp /dev/null "$PWD/.traffic-one/runs/${LIVE}/run.json"`, why: 'overwrites the sidecar' },
  { id: 'p1-var-root', cmd: 'rm -rf "$ROOT/.traffic-one/runs"', why: 'unresolvable root, complete suffix' },

  // A SUBSHELL, whose body is a command list and not a grouped expression.
  { id: 'p2-subshell-tree', cmd: '(rm -rf .traffic-one/runs)', why: 'whole runs tree' },
  { id: 'p2-subshell-run', cmd: `(rm -rf .traffic-one/runs/${LIVE})`, why: 'live run dir' },
  { id: 'p2-subshell-file', cmd: `(rm -f ${RUN}/run.json)`, why: 'the sidecar itself' },
  { id: 'p2-subshell-spaced', cmd: '( rm -rf .traffic-one/runs )', why: 'whole runs tree' },
  { id: 'p2-subshell-and', cmd: 'cd . && (rm -rf .traffic-one/runs)', why: 'whole runs tree' },
  { id: 'p2-subshell-two', cmd: `(cat ${RUN}/run.json; rm -rf .traffic-one/runs)`, why: 'read THEN destroy' },
  { id: 'p2-cmdsub', cmd: 'echo $(rm -rf .traffic-one/runs)', why: 'destruction inside a substitution' },
  { id: 'p2-brace-control', cmd: '{ rm -rf .traffic-one/runs; }', why: 'CONTROL: a brace group denied before' },

  // A find sweep whose ACTION is an interpreter, a prefix, or a bare writer.
  { id: 'p3-exec-sh', cmd: `find .traffic-one/runs -name "run.json" -exec sh -c 'rm -f "$1"' _ {} \\;`, why: 'sh -c wrapper' },
  { id: 'p3-exec-bash', cmd: `find .traffic-one/runs -name "run.json" -exec bash -c 'rm -f "$1"' _ {} \\;`, why: 'bash -c wrapper' },
  { id: 'p3-exec-py', cmd: 'find .traffic-one/runs -name "run.json" -exec python3 -c "import sys,os; os.unlink(sys.argv[1])" {} \\;', why: 'interpreter wrapper' },
  { id: 'p3-exec-tee', cmd: 'find .traffic-one/runs -name "run.json" -exec tee {} \\; < /dev/null', why: 'tee, in no verb set at all' },
  { id: 'p3-exec-env-rm', cmd: 'find .traffic-one/runs -name "run.json" -exec env rm -f {} \\;', why: 'transparent prefix' },
  { id: 'p3-execdir-sh', cmd: `find .traffic-one/runs -name "run.json" -execdir sh -c 'rm -f "$1"' _ {} \\;`, why: '-execdir wrapper' },
  { id: 'p3-xargs-sh', cmd: `find .traffic-one/runs -name "run.json" | xargs -I{} sh -c 'rm -f {}'`, why: 'xargs through a wrapper' },
  { id: 'p3-exec-truncate', cmd: 'find .traffic-one/runs -name "run.json" -exec truncate -s 0 {} \\;', why: 'CONTROL: denied before' },

  // A shell KEYWORD, an assignment or a transparent prefix in command position.
  { id: 'k-then-find-del', cmd: 'if true; then find . -name run.json -delete; fi', why: 'destroys the sidecar, names no runtime path' },
  { id: 'k-do-find-del', cmd: 'for i in 1; do find . -name run.json -delete; done', why: 'destroys the sidecar, names no runtime path' },
  { id: 'k-bare-find-del', cmd: 'find . -name run.json -delete', why: 'CONTROL: the same sweep with no keyword' },
  { id: 'k-do-rm-named', cmd: 'for i in 1; do rm -rf .traffic-one/runs; done', why: 'whole runs tree' },
  { id: 'k-then-rm', cmd: 'if true; then rm -rf .traffic-one/runs; fi', why: 'whole runs tree' },
  { id: 'k-for-bind-rm', cmd: `for f in ${RUN}/run.json; do rm -f "$f"; done`, why: 'loop BINDS the sidecar and deletes it' },
  { id: 'k-glob-bind-rm', cmd: 'for f in .traffic-one/runs/*/run.json; do rm -f "$f"; done', why: 'glob-bound deletion' },
  { id: 'k-assign-rm', cmd: 'LC_ALL=C rm -rf .traffic-one/runs', why: 'assignment before the verb' },
  { id: 'k-env-rm', cmd: 'env rm -rf .traffic-one/runs', why: 'env before the verb' },
  { id: 'k-nohup-rm', cmd: 'nohup rm -rf .traffic-one/runs', why: 'nohup before the verb' },

  // ROUND 8. Three families, each of which reached gate `noop` while a COMPLETE
  // `.traffic-one` literal stood in the command text — so all three were outside
  // the residue the shipped prose discloses, which is conditioned on there being
  // no such literal. Every row below was run against real bash 3.2.57 on a
  // fixture holding real sidecars before it was allowed in.
  //
  // A PARAMETER EXPANSION whose default word is the path.
  { id: 'r8-default-tree', cmd: 'rm -rf "${RUNS:-.traffic-one/runs}"', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-default-nocolon', cmd: 'rm -rf "${RUNS-.traffic-one/runs}"', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-default-file', cmd: `rm -f "\${F:-${RUN}/run.json}"`, why: 'the named sidecar, gone' },
  { id: 'r8-default-assign', cmd: 'rm -rf "${RUNS:=.traffic-one/runs}"', why: 'assign-default; denied before, pinned now' },
  { id: 'r8-default-alt', cmd: 'rm -rf "${RUNS:+.traffic-one/runs}"', why: 'alternate: erases the tree when RUNS is set' },
  { id: 'r8-default-nested', cmd: 'rm -rf "${A:-${B:-.traffic-one/runs}}"', why: 'a default inside a default' },

  // A NAME BOUND IN A SHELL. The prose says a shell binding is resolved; it was
  // resolved for `for` and not for an assignment, and `=(` put the whole
  // statement on `callSitesIn`'s grouping branch — round 6's subshell blocker
  // one character over.
  { id: 'r8-array-tree', cmd: 'd=(.traffic-one/runs); rm -rf "${d[0]}"', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-array-spaced', cmd: 'd=( .traffic-one/runs ); rm -rf "${d[@]}"', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-scalar-tree', cmd: 'd=.traffic-one/runs; rm -rf "$d"', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-scalar-brace', cmd: 'd=.traffic-one/runs; rm -rf "${d}"', why: 'the braced reference spelling' },
  { id: 'r8-scalar-file', cmd: `f=${RUN}/run.json; rm -f "$f"`, why: 'the named sidecar, gone' },
  { id: 'r8-array-list', cmd: `d=(${RUN}/run.json ${RUN}/scan-bound.json); rm -f "\${d[@]}"`, why: 'BOTH sidecars, 4 files to 2' },
  { id: 'r8-bind-then-use', cmd: 'd=.traffic-one; e="$d/runs"; rm -rf "$e"', why: 'a binding built from a binding' },

  // AN ESCAPED QUOTE inside a double-quoted `-c` body. Depth 1: this is not the
  // nesting bound, it is the body arriving with its escapes still in it.
  { id: 'r8-escq-tree', cmd: 'bash -c "rm -rf \\".traffic-one/runs\\""', why: '54 bytes to absent, 0 files left' },
  { id: 'r8-escq-file', cmd: `bash -c "rm -rf \\"${RUN}/run.json\\""`, why: 'the named sidecar, gone' },
  { id: 'r8-escq-sh', cmd: 'sh -c "rm -rf \\".traffic-one/runs\\""', why: 'sh flavour, same erasure' },
  { id: 'r8-escq-nested', cmd: 'bash -c "bash -c \\"rm -rf .traffic-one/runs\\""', why: 'two levels, escaped' },
  { id: 'r8-escq-control', cmd: 'bash -c \'rm -rf ".traffic-one/runs"\'', why: 'CONTROL: the same body, single-quoted outside' },

  // Aimed by the mutation campaign at branches whose mutant SURVIVED with no
  // fixture: `case`'s pattern list, and xargs' SEPARATE-word option argument.
  { id: 'r8-case-rm', cmd: `case x in a) rm -f ${RUN}/run.json ;; esac`, why: 'the sidecar, gone' },
  { id: 'r8-xargs-spaced-I', cmd: 'find .traffic-one/runs -name run.json | xargs -I {} sh -c "rm -f {}"', why: '4 files to 3; ground-truthed OUTSIDE the sandbox' },
  { id: 'r8-xargs-rm', cmd: 'find .traffic-one/runs -name run.json | xargs rm -f', why: '4 files to 3; ground-truthed OUTSIDE the sandbox' },

  // THE NESTING CLAIM, deny half. Each of these erased the tree under a real
  // bash (45 bytes and 3 files to nothing). Before round 8 the double-quoted
  // alternation went `noop` from depth 2 UP, so these five rows are the
  // measurement behind the corrected figure in the prose, not decoration.
  { id: 'r8-nest-d2', cmd: nestDouble('rm -rf .traffic-one/runs', 2), why: 'depth 2, was noop before round 8' },
  { id: 'r8-nest-d3', cmd: nestDouble('rm -rf .traffic-one/runs', 3), why: 'depth 3, was noop before round 8' },
  { id: 'r8-nest-d4', cmd: nestDouble('rm -rf .traffic-one/runs', 4), why: 'depth 4, the extraction bound' },
  { id: 'r8-nest-file-d2', cmd: nestDouble(`rm -f ${RUN}/run.json`, 2), why: 'the named sidecar at depth 2' },
  { id: 'r8-nest-file-d3', cmd: nestDouble(`rm -f ${RUN}/run.json`, 3), why: 'the named sidecar at depth 3' },

  // ROUND 9. Three blockers, each attributed to a NAMED STAGE of the pipeline
  // contract, and every row here ground-truthed against bash 3.2.57 over a real
  // 12-file sidecar tree (144B/12f before) with a per-file content hash rather
  // than a byte total, because a truncating overwrite that GROWS is a destruction
  // a byte total scores as a no-op.
  //
  // STAGE 2, SCOPE AND ROOT RESOLUTION. A closing quote followed by a relative
  // remainder is ONE WORD, and the absolute-path recognizer read the remainder as
  // a path of its own: `/1715091785000/run.json` became the project root, both
  // judgements ran against a root that does not exist, and the erasure went out
  // at `noop`. The discriminator was one token wide — `rm -rf "$R"` and unquoted
  // `$R/<id>/run.json` were both refused — which is why nothing upstream noticed.
  { id: 'r9-quoted-remainder', cmd: `R=.traffic-one/runs; rm -f "$R"/${LIVE}/run.json`, why: '144B/12f → 137B/11f; root was /1715091785000' },
  { id: 'r9-braced-remainder', cmd: `R=.traffic-one/runs; rm -f "\${R}"/${LIVE}/run.json`, why: 'the braced spelling of the same word' },
  { id: 'r9-loop-remainder', cmd: 'R=.traffic-one/runs; for f in "$R"/*/run.json; do rm -f "$f"; done', why: '144B/12f → 130B/10f, both runs' },
  { id: 'r9-remainder-dir', cmd: `R=.traffic-one/runs; rm -rf "$R"/${LIVE}`, why: 'the live run directory' },
  { id: 'r9-remainder-t1', cmd: 'R=.traffic-one; rm -rf "$R"/runs', why: 'whole runs tree through a shorter binding' },
  { id: 'r9-remainder-deep', cmd: `R=.traffic-one/runs; rm -rf "$R"/${LIVE}/debug`, why: 'the debug decision log' },

  // STAGE 4, EXPANSION AND BINDING RESOLUTION. Round 8 fixed defaults and
  // bindings as two sequential textual rewrites, and the first destroyed the
  // input of the second: `"${RUNS:-nosuch}"` became `nosuch` and the NAME was
  // gone before any binding was read. Nine whole-tree erasures at `noop`, plus
  // the modifier operators the rewrite did not model at all. One value model now
  // resolves both together, so a value's ORIGIN survives to be judged.
  { id: 'r9-bound-default', cmd: 'RUNS=.traffic-one/runs; rm -rf "${RUNS:-nosuch}"', why: '144B/12f → 0B/0f' },
  // The spelling the SHIPPED prose uses, and it is lowercase for a reason worth
  // recording: a gen guard forbids an uppercase POSIX default expansion in any
  // generated doc, so the paragraph could not quote the row above verbatim.
  // Ground-truthed separately (144B/12f → 0B/0f) rather than assumed equal.
  { id: 'r9-bound-default-lower', cmd: 'runs=.traffic-one/runs; rm -rf "${runs:-nosuch}"', why: 'the prose spelling, 144B/12f → 0B/0f' },
  { id: 'r9-bound-assign', cmd: 'RUNS=.traffic-one/runs; rm -rf "${RUNS:=nosuch}"', why: '144B/12f → 0B/0f' },
  { id: 'r9-bound-nocolon', cmd: 'RUNS=.traffic-one/runs; rm -rf "${RUNS-nosuch}"', why: '144B/12f → 0B/0f' },
  { id: 'r9-bound-remainder', cmd: `R=.traffic-one/runs; rm -rf "\${R:-nosuch}"/${LIVE}`, why: 'stage 2 and stage 4 in one word' },
  { id: 'r9-indirect', cmd: 'p=.traffic-one/runs; n=p; rm -rf "${!n}"', why: 'the value of the name held BY another' },
  { id: 'r9-substring', cmd: 'R=.traffic-one/runs; rm -rf "${R:0}"', why: 'a substring that is the whole value' },
  { id: 'r9-substring-len', cmd: 'R=.traffic-one/runsZZ; rm -rf "${R:0:17}"', why: 'offset and length' },
  { id: 'r9-suffix', cmd: 'R=.traffic-one/runsX; rm -rf "${R%X}"', why: 'suffix removal' },
  { id: 'r9-suffix-glob', cmd: 'R=.traffic-one/runsXtail; rm -rf "${R%%X*}"', why: 'greedy suffix removal over a glob' },
  { id: 'r9-prefix', cmd: 'R=xx.traffic-one/runs; rm -rf "${R#xx}"', why: 'prefix removal' },
  { id: 'r9-replace', cmd: 'R=.traffic-one/RUNS; rm -rf "${R/RUNS/runs}"', why: 'pattern replacement' },
  { id: 'r9-error-word', cmd: 'R=.traffic-one/runs; rm -rf "${R:?nope}"', why: 'the WORD is a message, the VALUE still destroys' },
  { id: 'r9-alt-set', cmd: 'RUNS=x; rm -rf "${RUNS:+.traffic-one/runs}"', why: 'alternate word when the name IS set' },
  { id: 'r9-chain', cmd: 'a=.traffic-one; b="$a/runs"; rm -rf "${b:-nosuch}"', why: 'a binding built from a binding, through a default' },

  // STAGE 5, PATH EXTRACTION. Only a trailing run of `/*` segments was unwrapped,
  // so every other glob metacharacter resolved to a path that exists nowhere and
  // enumerated nothing. Both of the review's rows are here and so are six more
  // spellings of the same two characters.
  { id: 'r9-glob-question', cmd: 'rm -rf .traffic-one/run?', why: '144B/12f → 0B/0f' },
  { id: 'r9-glob-class', cmd: 'rm -rf .traffic-one/[r]uns', why: '144B/12f → 0B/0f' },
  { id: 'r9-glob-range', cmd: 'rm -rf .traffic-one/[a-z]uns', why: 'a class RANGE' },
  { id: 'r9-glob-negated', cmd: 'rm -rf .traffic-one/[!x]uns', why: 'a NEGATED class' },
  { id: 'r9-glob-suffix', cmd: 'rm -rf .traffic-one/ru*', why: 'a `*` that is not a whole segment' },
  { id: 'r9-glob-mid', cmd: 'rm -f .traffic-one/*/*/run.json', why: 'globs in the MIDDLE of the path' },
  { id: 'r9-glob-id-prefix', cmd: 'rm -rf .traffic-one/runs/1715*', why: 'an id prefix, which reaches both runs' },
  { id: 'r9-glob-file-question', cmd: 'rm -f .traffic-one/runs/*/run.jso?', why: 'a `?` in the FILE name' },

  // WORD ASSEMBLY, the last step of stage 3, and a DISCLOSURE the shipped prose
  // had wrong: it listed a path with no complete literal surviving as unseen, an
  // INTERPRETER-level statement, while these two are reassembled by the shell
  // before any interpreter exists.
  { id: 'r9-ansi-c', cmd: "rm -rf $'.traffic-one/run\\x73'", why: 'ANSI-C quoting: 144B/12f → 0B/0f' },
  { id: 'r9-concat-single', cmd: "rm -rf .traffic-'one'/runs", why: 'quote concatenation mid-word' },
  { id: 'r9-concat-double', cmd: 'rm -rf ".traffic-one"/runs', why: 'the double-quoted spelling' },
  { id: 'r9-concat-tail', cmd: "rm -rf .traffic-one/'runs'", why: 'the quoted segment LAST' },

  // ROUND 10. Three families, each ground-truthed against real bash over a
  // 15-file tree (`.resets.json` included, which is the only record of a
  // project's reset history) with a path→sha256 census before and after. Every
  // one was `noop` at round 9 and every one erased ALL FIFTEEN files.
  //
  // FAMILY 1 IS A COMPOSITION FAILURE IN WHICH EVERY STAGE HONOURED ITS OWN ROW,
  // which is why nine rounds of per-stage work did not reach it. The closing
  // quote moves ONE character — from after the path to after the VARIABLE — and
  // the word `"$PWD"/.traffic-one/runs` was tokenized as TWO operands by an
  // alternation whose first branch is a quoted span. Stage 2 then correctly
  // refused to re-root, stage 3 correctly declined to unquote a span holding a
  // `$`, and stage 5 correctly read the residue `/.traffic-one/runs` as a
  // complete literal — an ABSOLUTE path resolving outside the project, naming
  // nothing. Both controls (the quote after the PATH, and no quotes at all) were
  // refused throughout, so no corpus row priced at a gate outcome could see it.
  // The unit is now the shell WORD (`shellWordsOf`), shared by both judgements.
  { id: 'w10-quote-after-var', cmd: 'rm -rf "$PWD"/.traffic-one/runs', why: '15f → 0f; the residue was one operand of its own' },
  { id: 'w10-quote-after-var-braced', cmd: 'rm -rf "${PWD}"/.traffic-one/runs', why: '15f → 0f; the spelling the shipped prose named as refused' },
  { id: 'w10-quote-after-var-subst', cmd: 'rm -rf "$(pwd)"/.traffic-one/runs', why: '15f → 0f; the other spelling the prose named' },
  { id: 'w10-quote-after-var-oldpwd', cmd: 'cd /; rm -rf "$OLDPWD"/.traffic-one/runs', why: '15f → 0f through a shell-provided head' },
  { id: 'w10-quote-after-var-t1', cmd: 'rm -rf "$PWD"/.traffic-one', why: '15f → 0f one directory up' },
  { id: 'w10-quote-after-var-file', cmd: `rm -f "$PWD"/${RUN}/run.json`, why: '15f → 14f, the live run record' },
  { id: 'w10-quote-after-quoted-head', cmd: 'rm -rf ".traffic-one"/runs/../runs', why: 'a literal quoted head glued to a relative remainder' },

  // FAMILY 2, AN UNOWNED SUB-LANGUAGE RATHER THAN AN OMITTED SPELLING. `\-` is
  // `-` to bash, so each row below names exactly `.traffic-one/runs`, while
  // stage 3 kept both characters unconditionally and the literal carried a `\`
  // the tree never has. A stage-suite mutant that strips the pair in the
  // bash-correct direction was measured by the round-9 peer at reachability ZERO
  // in the stage arm: no row of either suite evaluated that line.
  { id: 'w10-backslash-mid', cmd: 'rm -rf .traffic\\-one/runs', why: '15f → 0f' },
  { id: 'w10-backslash-tail', cmd: 'rm -rf .traffic-one/run\\s', why: '15f → 0f' },
  { id: 'w10-backslash-head', cmd: 'rm -rf .traffic-one/\\runs', why: '15f → 0f' },
  { id: 'w10-backslash-dot', cmd: 'rm -rf .\\traffic-one/runs', why: '15f → 0f' },
  { id: 'w10-backslash-quoted', cmd: 'rm -rf ".traffic-one"/run\\s', why: 'quote removal and escape resolution in one word' },
  { id: 'w10-backslash-verb', cmd: '\\find . -name run.json -delete', why: '15f → 13f; the alias escape hid the VERB, not the path' },
  { id: 'w10-backslash-find-pattern', cmd: 'find . -name \\*.json -delete', why: '15f → 2f; the kept backslash made the -name filter match NOTHING' },

  // FAMILY 3, `~+` AND `~-`, which are `$PWD` and `$OLDPWD` to bash and
  // therefore name THIS project under any HOME at all — re-measured with HOME
  // pointed away from the fixture to separate the escape from a harness
  // artifact. These two are not a variant of the HOME-relative tilde round 9
  // recorded as unseen: that one needs an assumption about HOME and these need
  // none. The `~` residue is retracted in the same change (see 'one root spelled
  // eight ways gets one verdict'), so a tilde head is unresolved wherever it
  // appears and this pair is refused by the general rule rather than by its own
  // row — which is the difference between closing the class and closing three
  // inputs.
  { id: 'w10-tilde-plus', cmd: 'rm -rf ~+/.traffic-one/runs', why: '15f → 0f with HOME pointed away' },
  { id: 'w10-tilde-minus', cmd: 'cd /; rm -rf ~-/.traffic-one/runs', why: '15f → 0f with HOME pointed away' },
];

const PERMIT: Row[] = [
  // The five the widening exists to permit. None carries a `.traffic-one`
  // literal at all, which is why narrowing on the REMAINDER of a literal keeps
  // them by construction rather than by measurement — measured anyway.
  { id: 'p5-dist', cmd: 'rm -rf "$(pwd)/dist"', why: 'ordinary build clean' },
  { id: 'p5-var-file', cmd: 'rm -f "$f"', why: 'ordinary loop body' },
  { id: 'p5-tmpdir', cmd: 'rm -rf "$TMPDIR/scratch"', why: 'ordinary scratch clean' },
  { id: 'p5-mv-var', cmd: 'mv "$src" dist/out.js', why: 'ordinary build move' },
  { id: 'p5-cp-var', cmd: 'cp assets/logo.svg "$dest"', why: 'ordinary asset copy' },
  { id: 'p5-pwd-dist', cmd: 'rm -rf "$PWD/dist"', why: 'ordinary build clean' },
  { id: 'p5-pwd-cache', cmd: 'rm -rf "$PWD/node_modules/.cache"', why: 'ordinary cache clean' },
  // Read sweeps, which the inverted find judgement must keep.
  { id: 'p3-permit-cat', cmd: `find .traffic-one/runs -name '*.json' -exec cat {} \\;`, why: 'prose names this permitted' },
  { id: 'p3-permit-grep', cmd: `find .traffic-one/runs -name '*.json' -exec grep -l bound {} \\;`, why: 'read-only sweep' },
  { id: 'p3-permit-sh-cat', cmd: `find .traffic-one/runs -name '*.json' -exec sh -c 'cat "$1"' _ {} \\;`, why: 'read-only sweep through a wrapper' },
  { id: 'p3-permit-xargs-wc', cmd: `find .traffic-one/runs -name '*.json' | xargs wc -l`, why: 'read-only sweep' },
  // Reads inside the grammar the subshell fix re-enters.
  { id: 'p2-permit-cat', cmd: `(cat ${RUN}/run.json)`, why: 'a read in a subshell' },
  { id: 'p2-permit-cd-cat', cmd: `(cd . && cat ${RUN}/run.json)`, why: 'a read in a subshell' },
  { id: 'p2-permit-cmdsub', cmd: `echo $(cat ${RUN}/run.json)`, why: 'a read in a substitution' },
  // Reads behind the words the head scan skips.
  { id: 'k-permit-do-cat', cmd: `for i in 1; do cat ${RUN}/run.json; done`, why: 'a read in a loop body' },
  { id: 'k-permit-assign-cat', cmd: `LC_ALL=C cat ${RUN}/run.json`, why: 'assignment before a read' },
  { id: 'k-permit-env-cat', cmd: `env cat ${RUN}/run.json`, why: 'env before a read' },
  // Ground-truthed as destroying nothing: `(( … ))` is arithmetic evaluation.
  { id: 'p2-arith', cmd: '((rm -rf .traffic-one/runs))', why: 'arithmetic, not a nested subshell' },

  // ROUND 8. THE OTHER SIDE OF EVERY ROW ADDED TO `DESTRUCTIVE` ABOVE, and the
  // pairing is the point: each fix below is a NARROWING of what the extraction
  // layer discards, and a narrowing that is not held to preserving the read
  // spelling of the same construct buys a blocker with an over-refusal. Every
  // row is a no-op on disk (54→54, all four sidecars present).
  { id: 'r8-permit-default-read', cmd: `cat "\${F:-${RUN}/run.json}"`, why: 'a read through a parameter default' },
  { id: 'r8-permit-default-ls', cmd: 'ls "${RUNS:-.traffic-one/runs}"', why: 'a read through a parameter default' },
  { id: 'r8-permit-default-dist', cmd: 'rm -rf "${BUILD:-dist}"', why: 'ordinary build clean through a default' },
  { id: 'r8-permit-default-quoted', cmd: "rm -rf '${RUNS:-.traffic-one/runs}'", why: 'SINGLE-quoted: the shell expands nothing' },
  { id: 'r8-permit-default-error', cmd: 'rm -rf "${RUNS:?.traffic-one/runs}"', why: 'the word is an ERROR MESSAGE; unset exits 1 and destroys nothing' },
  { id: 'r8-permit-array-read', cmd: 'd=(.traffic-one/runs); ls "${d[0]}"', why: 'a read through an array binding' },
  { id: 'r8-permit-scalar-read', cmd: `f=${RUN}/run.json; cat "$f"`, why: 'a read through a scalar binding' },
  { id: 'r8-permit-scalar-du', cmd: 'd=.traffic-one/runs; du -sh "$d"', why: 'a read through a scalar binding' },
  { id: 'r8-permit-bare-assign', cmd: 'RUNS=.traffic-one/runs', why: 'an assignment writes nothing' },
  { id: 'r8-permit-escq-read', cmd: `bash -c "cat \\"${RUN}/run.json\\""`, why: 'a read behind an escaped quote' },
  { id: 'r8-permit-lookalike', cmd: 'rm -rf "$PWD/mydir.traffic-one/runs"', why: 'a DIFFERENT directory that merely ends the same way' },
  { id: 'r8-permit-case-read', cmd: `case x in a) cat ${RUN}/run.json ;; esac`, why: 'the prose names `case` among the words skipped' },
  { id: 'r8-permit-case-glob', cmd: `case x in *) cat ${RUN}/run.json;; esac`, why: 'a glob pattern list' },
  { id: 'r8-permit-case-subject', cmd: `case \${mode} in a) cat ${RUN}/run.json ;; esac`, why: 'an expanded case subject' },
  { id: 'r8-permit-xargs-n', cmd: 'find .traffic-one/runs -name run.json | xargs -n 1 cat', why: 'a separate-word xargs option around a read' },
  // The nine read sweeps round 7's `-exec` inversion refused. Each is an
  // ordinary reading verb whose short flag happens to end in c/e/E/p/r.
  { id: 'r8-permit-exec-jq-r', cmd: 'find .traffic-one/runs -name run.json -exec jq -r .status {} \\;', why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-grep-c', cmd: "find .traffic-one/runs -name '*.jsonl' -exec grep -c BLOCKED {} \\;", why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-grep-E', cmd: "find .traffic-one/runs -name '*.jsonl' -exec grep -E BLOCKED {} \\;", why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-grep-e', cmd: "find .traffic-one/runs -name '*.jsonl' -exec grep -e BLOCKED {} \\;", why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-head-c', cmd: 'find .traffic-one/runs -name run.json -exec head -c 100 {} \\;', why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-wc-c', cmd: 'find .traffic-one/runs -name run.json -exec wc -c {} \\;', why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-sort-r', cmd: 'find .traffic-one/runs -name run.json -exec sort -r {} \\;', why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-exec-tail-c', cmd: 'find .traffic-one/runs -name run.json -exec tail -c 20 {} +', why: 'reading verb, [ceEpr] flag, `+` terminator' },
  { id: 'r8-permit-xargs-jq-r', cmd: 'find .traffic-one/runs -name run.json | xargs jq -r .status', why: 'reading verb, [ceEpr] flag' },
  { id: 'r8-permit-xargs-grep-c', cmd: 'find .traffic-one/runs -name run.json | xargs grep -c x', why: 'reading verb, [ceEpr] flag' },

  // THE NESTING CLAIM, permit half, and the reason the deny half above cost
  // nothing. Resolving a nest deeper also EXPOSES the read inside it: the body
  // was appended as a sibling command while a copy stayed in the wrapper, so one
  // path occurred twice — once on its real verb and once on `bash`, which owns
  // no read arm — and every-occurrence read tests failed on the second copy.
  // Round 8 empties the handed-over body, and these rows are what stops a future
  // narrowing from re-introducing the refusal it fixed.
  { id: 'r8-permit-nest-d2', cmd: nestDouble(`cat ${RUN}/run.json`, 2), why: 'a read at depth 2' },
  { id: 'r8-permit-nest-d3', cmd: nestDouble(`cat ${RUN}/run.json`, 3), why: 'a read at depth 3' },
  { id: 'r8-permit-nest-d4', cmd: nestDouble(`cat ${RUN}/run.json`, 4), why: 'a read at depth 4' },
  { id: 'r8-permit-nest-jq', cmd: nestDouble(`jq -r .status ${RUN}/run.json`, 2), why: 'the P2 verb, nested' },
  { id: 'r8-permit-nest-ls', cmd: nestDouble('ls -la .traffic-one/runs', 3), why: 'a listing at depth 3' },
  // These five were written to PIN the emptying and DO NOT, which is recorded
  // here rather than quietly dropped. A mutant that keeps every handed-over body
  // in its wrapper (`M17`) survives all of them, at 363 executions of the
  // mutated line — so the emptying changes nothing any of these rows can see.
  // Its measured effect is three rows of a nesting sweep that no natural command
  // spells (a wrapper carrying a SECOND quoted token beside the nest), and the
  // opposite mutant `M18`, which empties every body, is killed by five wrapper
  // destructions. So the destructive side of that rule is pinned by the corpus
  // and the permitted side is pinned only by the sweep in the round report.
  // Round 9: a row that kills M17 is worth more here than another read.
  { id: 'r8-permit-nest-escq-d2', cmd: nestDouble(`cat "${RUN}/run.json"`, 2), why: 'a quoted read at depth 2' },
  { id: 'r8-permit-nest-escq-d3', cmd: nestDouble(`cat "${RUN}/run.json"`, 3), why: 'a quoted read at depth 3' },
  { id: 'r8-permit-nest-escq-d4', cmd: nestDouble(`cat "${RUN}/run.json"`, 4), why: 'a quoted read at depth 4' },
  { id: 'r8-permit-nest-two-d2', cmd: nestDouble(`cat ${RUN}/run.json "${RUN}/scan-bound.json"`, 2), why: 'two operands, one quoted, at depth 2' },
  { id: 'r8-permit-nest-two-d3', cmd: nestDouble(`cat ${RUN}/run.json "${RUN}/scan-bound.json"`, 3), why: 'two operands, one quoted, at depth 3' },

  // ROUND 9: THE ROWS THAT PIN THE EMPTYING RULE (`M17`), which round 8 declined
  // to pin and should not have. MAX_SHELL_NESTING is 4, so emptying versus not
  // emptying is unobservable BY CONSTRUCTION at depth <= 4 — round 8's five rows
  // above are all shallow, so no content they could have held would have
  // distinguished it. The rule is observable exactly where a residual wrapper
  // still spelling `.traffic-one` survives the unwrap loop, which is depth >= 5:
  // these two are `noop` at HEAD and `deny` under M17 (504 executions of the
  // mutated line), and they are ordinary reads, so the mutant's survival was
  // costing a real over-refusal rather than nothing.
  { id: 'r9-permit-nest-d5', cmd: nestDouble(`cat ${RUN}/run.json`, 5), why: 'a read one level past the unwrap bound; KILLS M17' },
  { id: 'r9-permit-nest-d6', cmd: nestDouble(`cat ${RUN}/run.json`, 6), why: 'a read two levels past it; KILLS M17' },
  // The permitted side of every round-9 closure. Each one is the shape whose
  // destructive twin is refused above, and a no-op on disk (144B/12f unchanged).
  { id: 'r9-permit-remainder-read', cmd: `R=.traffic-one/runs; cat "$R"/${LIVE}/run.json`, why: 'stage 2: the same word, read' },
  { id: 'r9-permit-remainder-loop', cmd: 'R=.traffic-one/runs; for f in "$R"/*/run.json; do cat "$f"; done', why: 'stage 2: the loop, read' },
  { id: 'r9-permit-remainder-dist', cmd: 'D=dist; rm -rf "$D"/assets', why: 'stage 2: a remainder naming no runtime path' },
  { id: 'r9-permit-default-read', cmd: 'RUNS=.traffic-one/runs; ls "${RUNS:-nosuch}"', why: 'stage 4: the same expansion, read' },
  { id: 'r9-permit-default-dist', cmd: 'B=dist; rm -rf "${B:-nosuch}"', why: 'stage 4: an ordinary build clean' },
  { id: 'r9-permit-prefix-away', cmd: 'R=zz/.traffic-one/runs; rm -rf "${R##*/.}"', why: 'stage 4: greedy prefix removal leaves `traffic-one/runs`, which is NOT the tree (ground-truthed no-op)' },
  { id: 'r9-permit-replace-away', cmd: 'R=.traffic-one/XunsX; rm -rf "${R//X/r}"', why: 'stage 4: replacement yields `runsr` (ground-truthed no-op)' },
  { id: 'r9-permit-length', cmd: 'R=.traffic-one/runs; rm -rf "${#R}"', why: 'stage 4: a LENGTH is never a path (ground-truthed no-op)' },
  { id: 'r9-permit-glob-cache', cmd: 'rm -rf .traffic-one/c?che', why: 'stage 5: a glob that CANNOT match `runs` (ground-truthed: cache goes, tree survives)' },
  { id: 'r9-permit-glob-bare', cmd: 'rm -rf *', why: 'stage 5: `*` does not expand over dotfiles (ground-truthed no-op)' },
  { id: 'r9-permit-glob-dist', cmd: 'rm -rf dist/*', why: 'stage 5: an ordinary build clean' },
  // PREDICTED BY THE MUTATION CAMPAIGN RATHER THAN FOUND AFTERWARDS: a mutant
  // that makes `globCoversPath` answer true for every sidecar survives the whole
  // destructive corpus, because a glob that reaches the tree at all is refused
  // whichever run it names. The row that sees the difference is a glob naming
  // ONLY the finished run — permitted housekeeping, and the same rotation
  // exemption the ids were re-minted for.
  { id: 'r9-permit-glob-finished', cmd: `rm -rf .traffic-one/runs/${DONE.slice(0, 8)}*`, why: 'stage 5: a glob matching only a FINISHED run is housekeeping' },

  // ROUND 10, and the permitted half is where an inverted predicate is paid for.
  // Making unreadability the DEFAULT can only be honest if the characters
  // admitted to the allowlist are admitted with a cost measured, so each row
  // here is a shape whose readability the inversion decides. All are ground-
  // truthed no-ops (15f unchanged) except where the row says otherwise.
  { id: 'w10-permit-space-dir', cmd: 'rm -rf ".traffic-one/my cache"', why: 'a quoted SPACE is data: real directories have them, and the prefix fallback would refuse this as the whole tree' },
  { id: 'w10-permit-nonascii', cmd: 'rm -rf .traffic-one/cache/café', why: 'every special character of the shell grammar is ASCII, so a byte above it is readable without being enumerated' },
  { id: 'w10-permit-tilde-suffix', cmd: 'rm -rf dist/app.js~', why: 'a tilde that is not a word HEAD is data, not an expansion' },
  { id: 'w10-permit-closer', cmd: 'rm -rf "dist/out}"', why: 'a CLOSER without its opener is data; the openers `{` and `[` are what make an expansion unreadable' },
  { id: 'w10-permit-home-download', cmd: 'rm -rf ~/Downloads/tmp', why: 'an unreadable tilde head is only refused when the REMAINDER spells this tree' },
  // The reads the round-9 peer measured as undisclosed over-refusals, three of
  // them PURE READS and one a DRY RUN — the command a cautious agent reaches for
  // precisely to avoid destroying anything, which is the worst row an
  // over-refusal ledger can hold.
  { id: 'w10-permit-xattr', cmd: `xattr -l ${RUN}/run.json`, why: 'extended attributes LISTED; `-w`/`-d`/`-c` still refuse' },
  { id: 'w10-permit-fd-read', cmd: `exec 3< ${RUN}/run.json; cat <&3`, why: 'a pure read through a file descriptor; `3<>` is excluded because it opens for write too' },
  { id: 'w10-permit-lsof', cmd: 'lsof +D .traffic-one/runs | head -5', why: 'who holds a sidecar open — the first diagnostic a stuck publish needs' },
  { id: 'w10-permit-rsync-dry', cmd: 'rsync -an .traffic-one/runs .tmp/runs-backup', why: 'a DRY RUN writes nothing by construction; the real copy stays refused' },
  { id: 'w10-permit-alias-cat', cmd: `\\cat ${RUN}/run.json`, why: 'the alias escape resolves to the verb `cat`, so a read reads' },
];

interface OrdinaryRow { id: string; cmd: string; src: string }

const ORDINARY: OrdinaryRow[] = [
  { id: 'r-arch-ls', cmd: 'ls .traffic-one .traffic-one/rules .traffic-one/decisions/*.md', src: 'senior-architect/agent.md' },
  { id: 'r-digest-prune', cmd: 'ls -t .traffic-one/digests | tail -n +4 | xargs -I{} rm -rf .traffic-one/digests/{}', src: 'prompt-templates.md' },
  { id: 'r-doctor-run', cmd: `node ~/.traffic-one/bin/doctor.cjs --run ${LIVE}`, src: 'SUPPORT.md' },
  { id: 'r-token-out', cmd: 'node ~/.traffic-one/bin/token-report.cjs --out .traffic-one/reports/tokens.md', src: 'token-usage-report/SKILL.md' },
  { id: 'r-runstatus', cmd: `node ~/.traffic-one/bin/run-status.cjs --run-id "${LIVE}" --status active --reason user-authorized-extra-cycle`, src: 'prompt-templates.md' },
  { id: 'r-reviewer-digest', cmd: `cat > .traffic-one/digests/${LIVE}/reviewer.md <<'EOF'\nverdict: APPROVED\nEOF`, src: 'senior-reviewer/agent.md' },
  { id: 'r-probe-pytest', cmd: "python3 -c 'import pytest; print(pytest.__version__)'", src: 'test:env toolchain probe' },
  { id: 'r-probe-which', cmd: 'python3 -c "import shutil; print(shutil.which(\'go\'))"', src: 'test:env toolchain probe' },
  { id: 'o-cat', cmd: `cat ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-jq', cmd: `jq -r '.status' ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-tail', cmd: `tail -n 50 ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-wc', cmd: `wc -c ${RUN}/scan-bound.json`, src: 'ordinary read' },
  { id: 'o-grep', cmd: `grep -c bound ${RUN}/scan-bound.json`, src: 'ordinary read' },
  { id: 'o-stat', cmd: `stat -f %z ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-sed-n', cmd: `sed -n '1,5p' ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-cut', cmd: `cut -c1-40 ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-md5', cmd: `md5 ${RUN}/run.json`, src: 'ordinary read' },
  { id: 'o-pipe', cmd: `cat ${RUN}/run.json | jq -r '.runId'`, src: 'ordinary read, piped' },
  { id: 'o-sort-uniq', cmd: `sort ${RUN}/run.json | uniq -c`, src: 'ordinary read, piped' },
  { id: 'o-glob-head', cmd: `head -c 200 ${RUN}/*.json`, src: 'ordinary read over a glob' },
  { id: 'o-bash-c', cmd: `bash -c 'cat ${RUN}/run.json'`, src: 'ordinary read inside a -c body' },
  { id: 'o-git-log', cmd: `git log --oneline -- ${RUN}/run.json`, src: 'prose names this permitted' },
  { id: 'o-git-diff', cmd: `git diff -- ${RUN}/run.json`, src: 'prose names this permitted' },
  { id: 'o-find-cat', cmd: `find .traffic-one/runs -name '*.json' -exec cat {} \\;`, src: 'prose names this permitted' },
  { id: 'o-find-xargs-wc', cmd: `find .traffic-one/runs -name '*.json' | xargs wc -l`, src: 'ordinary read sweep' },
  { id: 'o-procsub-diff', cmd: `diff <(jq -S . ${RUN}/run.json) <(jq -S . ${RUN}/scan-bound.json)`, src: 'process substitution' },
  { id: 'o-var-then-read', cmd: `RUN=${LIVE}; cat .traffic-one/runs/$RUN/run.json`, src: 'read via a variable id' },
  { id: 'o-and-read', cmd: `rm -rf node_modules/.cache && ls ${RUN}`, src: 'build cleanup beside a read' },
  { id: 'o-test-and', cmd: `test -f ${RUN}/run.json && jq -r .status ${RUN}/run.json`, src: 'guarded read' },
  { id: 'o-bracket-or', cmd: `[ -s ${RUN}/scan-bound.json ] || echo missing`, src: 'guarded read' },
  { id: 'o-if-then', cmd: `if [ -f ${RUN}/run.json ]; then echo present; fi`, src: 'control flow around a read' },
  { id: 'o-for-do', cmd: `for f in ${RUN}/run.json ${RUN}/scan-bound.json; do cat "$f"; done`, src: 'loop over sidecars' },
  { id: 'o-while-redirect', cmd: `while read -r l; do echo "$l"; done < ${RUN}/run.json`, src: 'line loop' },
  { id: 'o-case', cmd: `case $(cat ${RUN}/run.json) in *planned*) echo planned;; esac`, src: 'dispatch on a sidecar' },
  { id: 'o-py-read', cmd: `python3 -c "import json; print(json.load(open('${RUN}/run.json'))['status'])"`, src: 'read in an eval body' },
  { id: 'o-node-read', cmd: `node -e "console.log(JSON.parse(require('fs').readFileSync('${RUN}/run.json','utf8')).status)"`, src: 'read in an eval body' },
  { id: 'o-py-read-write-elsewhere', cmd: `python3 -c "import json; d=json.load(open('${RUN}/run.json')); open('status.txt','w').write(d['status'])"`, src: 'read a sidecar, write elsewhere, ONE statement' },
  { id: 'o-node-read-write-elsewhere', cmd: `node -e "const fs=require('fs'); const d=JSON.parse(fs.readFileSync('${RUN}/run.json','utf8')); fs.writeFileSync('summary.json', JSON.stringify(d))"`, src: 'read a sidecar, write elsewhere, ONE statement' },
  { id: 'o-py-read-unrelated-rm', cmd: `python3 -c "import os; os.remove('scratch.tmp'); print(open('${RUN}/run.json').read())"`, src: 'an unrelated write in the same statement' },
  { id: 'o-awk-read', cmd: `awk '{print $1}' ${RUN}/run.json`, src: 'awk with no redirect' },
  { id: 'o-awk-compare', cmd: `awk 'length($0) > 10 {print}' ${RUN}/run.json`, src: 'awk with a COMPARISON operator' },
  { id: 'o-sort-no-o', cmd: `sort -u ${RUN}/run.json`, src: 'sort with no -o' },
  { id: 'd-echo', cmd: `echo "see ${RUN}/run.json"`, src: 'prose: refused' },
  { id: 'd-cp-backup', cmd: `cp ${RUN}/run.json backup.json`, src: 'prose: refused' },
  { id: 'd-tar-c', cmd: 'tar -cf backup.tgz .traffic-one/runs', src: 'prose: refused' },
  { id: 'd-argv-read', cmd: `python3 -c 'import sys; print(open(sys.argv[1]).read())' ${RUN}/run.json`, src: 'prose: refused' },
  { id: 'd-printf', cmd: `printf '%s\\n' ${RUN}/run.json`, src: 'prose: refused (echo family)' },
];

/**
 * WHY THIS CORPUS IS TWO CORPORA BY TWO AUTHORS, AND WHY ROUND 9 MUST ADD A
 * THIRD RATHER THAN REPLACE THESE. This is the durable half of round 8, and it
 * is here rather than in a report because the report is not what round 9 reads.
 *
 * The over-refusal figure has now been wrong twice in a row, in the same shape
 * both times:
 *
 *   ROUND 6 measured "over-refusal: ZERO" on 23 rows it wrote itself. A peer
 *   drove 47 rows of its own and found 12 refusals, 5 disclosed nowhere.
 *   ROUND 7 adopted those 47 rows verbatim and measured 7 refusals, all
 *   disclosed — a true statement about those 47 rows. A second peer drove 60
 *   rows of its own and found 9, including two undisclosed classes (`cd`/
 *   `pushd`, `case`) and one round 7 had just introduced (`-exec <read> -c`).
 *
 * The failure is STRUCTURAL, not diligence, and it survives adopting the peer's
 * rows because adoption is what breaks the independence. Once round N's matcher
 * is built to satisfy round N-1's corpus, that corpus can no longer measure
 * round N: it has become a REGRESSION suite, which is a different instrument
 * with a different job. Regression suites answer "did the rows I already know
 * about move?"; only a corpus written by somebody who has not read the matcher
 * answers "which rows did nobody think of?". A corpus authored beside the
 * matcher — even one generation removed, even in good faith — is a sample from
 * the space of shapes the matcher's author can imagine, and the escapes live by
 * definition outside that space.
 *
 * The three classes the second peer found were all invisible to the 47 rows for
 * exactly this reason: nobody who had read `shellStatementHead` wrote a `case`
 * row, because reading it makes reserved words feel handled.
 *
 * So: KEEP BOTH SETS AND ADD. `ORDINARY` is the wd6 peer's 47 and
 * `PEER_ORDINARY` is the wd7 peer's 60; round 8 added neither and edited
 * neither. What round 8 DID add is `PERMIT`/`DESTRUCTIVE` rows aimed by the
 * mutation campaign at branches with no fixture, which is the other instrument
 * and answers a different question — see the mutation table in the round
 * report. Round 9's obligation is a THIRD independent corpus, written before
 * reading this file, and its ledger recorded beside these two.
 */
const PEER_ORDINARY: OrdinaryRow[] = [
  { id: 'q01', cmd: 'cat .traffic-one/runs/1715091785000/run.json', src: 'SUPPORT.md run-ledger table row' },
  { id: 'q02', cmd: 'jq . .traffic-one/runs/1715091785000/run.json', src: 'ordinary ledger inspection' },
  { id: 'q03', cmd: "jq -r '.status' .traffic-one/runs/1715091785000/run.json", src: 'doctor skill: ledger status' },
  { id: 'q04', cmd: 'ls -la .traffic-one/runs/', src: 'listing runs root' },
  { id: 'q05', cmd: 'ls .traffic-one/runs/1715091785000/', src: 'listing one run' },
  { id: 'q06', cmd: 'ls -t .traffic-one/runs | head -5', src: 'newest runs first' },
  { id: 'q07', cmd: "find .traffic-one/runs -name 'run.json'", src: 'locating ledgers' },
  { id: 'q08', cmd: "find .traffic-one/runs -type f -name '*.json' -newer package.json", src: 'recently-written sidecars' },
  { id: 'q09', cmd: "grep -n 'ARCHITECTURE_CONTRACT_MISSING' .traffic-one/runs/1715091785000/debug/decisions.jsonl", src: 'SUPPORT.md: deny id is greppable' },
  { id: 'q10', cmd: "rg 'traffic-one ref' .traffic-one/runs/*/debug/decisions.jsonl", src: 'SUPPORT.md: find the correlation ref' },
  { id: 'q11', cmd: 'tail -n 20 .traffic-one/runs/1715091785000/debug/decisions.jsonl', src: 'decision log is append-only' },
  { id: 'q12', cmd: 'wc -l .traffic-one/runs/1715091785000/debug/decisions.jsonl', src: 'how many decisions' },
  { id: 'q13', cmd: 'du -sh .traffic-one/runs', src: 'retention/size question' },
  { id: 'q14', cmd: 'stat .traffic-one/runs/1715091785000/run.json', src: 'freshness question' },
  { id: 'q15', cmd: 'node ~/.traffic-one/bin/doctor.cjs --run 1715091785000', src: 'SUPPORT.md: exact spelling admitted by gates' },
  { id: 'q16', cmd: 'node ~/.traffic-one/bin/run-status.cjs --run-id 1715091785000 --status blocked --outcome review-cycle-cap', src: 'prompt-templates.md run-ledger settlement' },
  { id: 'q17', cmd: 'node ~/.traffic-one/bin/traffic-one-reset.cjs --run-id 1715091785000', src: 'SUPPORT.md: admitted spelling' },
  { id: 'q18', cmd: 'for f in .traffic-one/runs/*/run.json; do cat "$f"; done', src: 'round 7 loop-binding resolution' },
  { id: 'q19', cmd: 'for f in .traffic-one/runs/*/run.json; do echo "$f"; jq -r .status "$f"; done', src: 'loop body with two reads' },
  { id: 'q20', cmd: 'for id in $RUN_IDS; do cat .traffic-one/runs/$id/run.json; done', src: 'UNRESOLVABLE binding' },
  { id: 'q21', cmd: 'RUN=$(jq -r .currentRunId .traffic-one/.one.json); cat .traffic-one/runs/$RUN/run.json', src: 'currentRunId protocol' },
  { id: 'q22', cmd: 'cat .traffic-one/runs/$(jq -r .currentRunId .traffic-one/.one.json)/run.json', src: 'inline $( ) inside the path' },
  { id: 'q23', cmd: 'ls "$(dirname .traffic-one/runs/1715091785000/run.json)"', src: 'substitution supplies the whole operand' },
  { id: 'q24', cmd: 'diff <(jq -S . .traffic-one/runs/a/run.json) <(jq -S . .traffic-one/runs/b/run.json)', src: 'comparing two ledgers' },
  { id: 'q25', cmd: 'git diff --name-only HEAD', src: 'prompt-templates reviewer step 3' },
  { id: 'q26', cmd: 'npm run typecheck', src: 'AGENTS.md command chain' },
  { id: 'q27', cmd: 'which go && go version', src: 'test:env toolchain probe' },
  { id: 'q28', cmd: 'pytest --version; ruff --version', src: 'test:env toolchain probe' },
  { id: 'q29', cmd: 'command -v npx >/dev/null && npx playwright --version', src: 'test:env Playwright probe' },
  { id: 'q30', cmd: 'rm -rf node_modules/.cache', src: 'ordinary build hygiene' },
  { id: 'q31', cmd: 'rm -f dist/scripts/stale.js', src: 'ordinary dist hygiene' },
  { id: 'q32', cmd: 'mkdir -p src/features/auth && touch src/features/auth/index.ts', src: 'implementer scaffolding' },
  { id: 'q33', cmd: "echo '{}' > src/features/auth/config.json", src: 'implementer write to a feature target' },
  { id: 'q34', cmd: 'cat .traffic-one/plan.md', src: 'prompt-templates: read plan.md' },
  { id: 'q35', cmd: 'cat .traffic-one/digests/1715091785000/architect.md', src: 'implementer reads architect digest' },
  { id: 'q36', cmd: 'head -50 .traffic-one/runs/1715091785000/bootstrap/senior-frontend/active.json', src: 'read bootstrap envelope' },
  { id: 'q37', cmd: "jq -r '.outputs[]' .traffic-one/runs/1715091785000/bootstrap/senior-backend/active.json", src: 'obey envelope outputs' },
  { id: 'q38', cmd: 'cat .traffic-one/reports/qa/1715091785000/report-v2.json | jq .schemaVersion', src: 'tester: QaReportV2 check' },
  { id: 'q39', cmd: 'test -f .traffic-one/runs/1715091785000/verification-v2.json && echo present', src: 'tester: read verification-v2' },
  { id: 'q40', cmd: '[ -d .traffic-one/runs ] && ls .traffic-one/runs | wc -l', src: 'how many runs exist' },
  { id: 'q41', cmd: 'if [ -f .traffic-one/runs/$RUN/assignments.json ]; then jq . .traffic-one/runs/$RUN/assignments.json; fi', src: 'run-team gate debugging' },
  { id: 'q42', cmd: 'env | grep TRAFFIC_ONE', src: 'SUPPORT.md hook-trace env' },
  { id: 'q43', cmd: 'shasum -a 256 .traffic-one/runs/1715091785000/run.json', src: 'hash check of a sidecar' },
  { id: 'q44', cmd: 'cd .traffic-one/runs && ls', src: 'navigating to the runs root' },
  { id: 'q45', cmd: 'cat .traffic-one/runs/1715091785000/run.json > .tmp/run-copy.json', src: 'read a sidecar into an output' },
  { id: 'q46', cmd: 'jq . .traffic-one/runs/1715091785000/run.json > pretty.json', src: 'read a sidecar into an output' },
  { id: 'q47', cmd: 'cat .traffic-one/runs/1715091785000/run.json | tee run-copy.json', src: 'read a sidecar into an output' },
  { id: 'q48', cmd: "awk '{print}' .traffic-one/runs/1715091785000/debug/decisions.jsonl > summary.txt", src: 'read a sidecar into an output' },
  { id: 'q49', cmd: 'grep BLOCKED .traffic-one/runs/1715091785000/debug/decisions.jsonl > denies.txt', src: 'read a sidecar into an output' },
  { id: 'q50', cmd: 'tar -cf runs-backup.tgz .traffic-one/runs', src: 'round 7: tar -c is NOT refused' },
  { id: 'q51', cmd: 'cp -r .traffic-one/runs .tmp/runs-backup', src: 'backing up before a reset' },
  { id: 'q52', cmd: 'rsync -a .traffic-one/runs/ .tmp/runs-backup/', src: 'backing up before a reset, rsync flavour' },
  { id: 'q53', cmd: "awk 'length($0) > 10 {print}' .traffic-one/runs/1715091785000/debug/decisions.jsonl", src: 'awk read form' },
  { id: 'q54', cmd: "sed -n '1,20p' .traffic-one/runs/1715091785000/run.json", src: 'bounded read of a sidecar' },
  { id: 'q55', cmd: 'node -e "console.log(require(\'./.traffic-one/runs/1715091785000/run.json\').status)"', src: 'node one-liner ledger read' },
  { id: 'q56', cmd: 'git -C . status --porcelain .traffic-one/runs', src: 'git -C, ordinary intent' },
  { id: 'q57', cmd: 'xargs -I{} cat {} < runlist.txt', src: 'reading a list of ledgers' },
  { id: 'q58', cmd: 'find .traffic-one/runs -name run.json -exec jq -r .status {} \\;', src: 'the -exec read sweep round 7 refused' },
  { id: 'q59', cmd: 'find .traffic-one/runs -maxdepth 1 -type d -mtime +7', src: 'retention question, no action' },
  { id: 'q60', cmd: 'timeout 30 node ~/.traffic-one/bin/doctor.cjs --bundle', src: 'SUPPORT.md bundle, wrapped in timeout' },
];

/**
 * EXACTLY the ordinary rows this gate refuses, each one a cost the shipped
 * `runtime-sidecar-owner-gate` prose names out loud. Round 6 refused twelve and
 * disclosed seven; the five it disclosed nowhere were `if [ -f <sidecar> ]`,
 * `for f in <sidecar>`, `while … done < <sidecar>`, `case $(cat <sidecar>) in`
 * and awk with a comparison operator — every one of them ordinary work around a
 * READ, and every one of them refused by an extraction defect rather than by a
 * judgement anyone had made.
 *
 * A row LEAVING this set is as red as a row joining it: the disclosure is the
 * product, and prose that over-states a refusal teaches an agent to work around
 * a gate that would have let it through.
 */
const REFUSED_ORDINARY: readonly string[] = [
  'd-argv-read',
  'd-cp-backup',
  'd-echo',
  'd-printf',
  'o-node-read-write-elsewhere',
  'o-py-read-unrelated-rm',
  'o-py-read-write-elsewhere',
];

test('every ground-truthed destruction of a live sidecar is refused at the gate', () => {
  const missed: string[] = [];
  for (const row of DESTRUCTIVE) {
    const got = outcome(row.cmd);
    if (!got.startsWith('deny')) missed.push(`${row.id} (${row.why}) -> ${got}: ${row.cmd}`);
  }
  assert.deepEqual(missed, [], 'these commands erase a runtime-owned sidecar and the gate did not refuse them');
  assert.ok(DESTRUCTIVE.length >= 62, `the corpus shrank to ${DESTRUCTIVE.length} rows`);
});

/**
 * A deny is only evidence if it is the deny this module is responsible for.
 * Some of these rows are refused by an arm that predates the round, and a
 * corpus that counts any refusal cannot tell a fix from a coincidence.
 *
 * TWO IDS ARE ACCEPTED AND THE SECOND ONE IS A DEFECT THIS TEST NOW RECORDS
 * RATHER THAN HIDES. Both are per-target runtime-ownership denies raised from
 * the SAME enumerated target list, and which paragraph renders is decided by
 * which target sorts FIRST — so the assertion is still "the owner gate refused
 * it", not "any refusal will do".
 *
 * Round 7 asserted the single id `runtime-sidecar-owner-gate` and was green,
 * but only because its fixture's run directory held two files. A real run holds
 * `assignments.json`, which sorts ahead of `bootstrap/`, `debug/`, `run.json`
 * and `scan-bound.json` — so on any project with a run team, EVERY whole-tree
 * destruction renders `runtime-assignments-owner-gate`, whose remedy is "change
 * ArchitectureInputV1 and re-run PLAN_READY compilation", for an `rm -rf`. The
 * previous peer filed the id selection as a MINOR on the strength of one
 * directory-scoped row; enriching the fixture to a realistic run shows it is
 * the COMMON case for the destructions this module exists to catch. The fix is
 * in the deny-id selection rather than in this fence, so round 8 measured it,
 * widened the assertion to the truth, and left the selection alone.
 */
const OWNER_DENY_IDS = ['deny:runtime-sidecar-owner-gate', 'deny:runtime-assignments-owner-gate'];

test('the destruction corpus is refused by the OWNER gate, not by something else', () => {
  for (const row of DESTRUCTIVE) {
    const got = outcome(row.cmd);
    assert.ok(OWNER_DENY_IDS.includes(got), `${row.id}: ${row.cmd} -> ${got}`);
  }
});

/**
 * THE RUN-ROTATION EXEMPTION, from both sides, which no fixture in this lane had
 * ever reached (round 9's P4).
 *
 * `strayNamesRealRun` exempts a stray run id from the id-mismatch refusal only
 * when the id matches /^\d{13}$/ AND names a real run directory on disk. Every
 * fixture in this lane called its runs `run-1` and `run-0`, so the FIRST half
 * could never hold: the exemption was unreachable, `rm -rf <finished run>`
 * measured deny:run-id-mismatch here while being permitted in production, and the
 * shipped sentence "spell the id if you mean a finished run" was true of the
 * product and false of the instrument. Both halves are pinned here now, so a
 * future round cannot lose either the exemption or the refusals around it.
 */
test('the run-rotation exemption is reachable, and only for the shape it is written for', () => {
  assert.equal(outcome(`rm -rf .traffic-one/runs/${DONE}`), 'noop', 'a finished run named by its real id is housekeeping');
  assert.ok(outcome(`rm -rf .traffic-one/runs/${LIVE}`).startsWith('deny'), 'the LIVE run is not housekeeping');
  assert.ok(outcome('rm -rf .traffic-one/runs/1799999999999').startsWith('deny'), 'a well-shaped id naming no run on disk is a mismatch');
  assert.ok(outcome('rm -rf .traffic-one/runs/run-0').startsWith('deny'), 'an id that is not a run id is a mismatch — this is the shape the old fixture used');
  assert.ok(outcome('rm -rf .traffic-one/runs').startsWith('deny'), 'the whole tree reaches the live run whatever the ids are');
});

test('ordinary work that destroys nothing is permitted', () => {
  const refused: string[] = [];
  for (const row of PERMIT) {
    const got = outcome(row.cmd);
    if (got.startsWith('deny')) refused.push(`${row.id} (${row.why}) -> ${got}: ${row.cmd}`);
  }
  assert.deepEqual(refused, [], 'these commands destroy no sidecar and were refused anyway');
  assert.ok(PERMIT.length >= 53, `the permit corpus shrank to ${PERMIT.length} rows`);
});

/**
 * Refusals this round MEASURED, DECLINED to fix, and disclosed in the gate's
 * prose in the same commit. Each is an ordinary action; each is refused by a
 * rule that is right about the shape it was written for.
 *
 * The redirect rows are one class and not five: the command as a whole writes,
 * and the target extractor reports every `.traffic-one` literal standing inside
 * it without regard for which side of the `>` the path is on. Narrowing it to
 * "only the redirect's own target" is a fail-OPEN move in the one lane whose
 * every regression has been fail-open, and there was no evidence to price it
 * against — the peer's 47-row corpus contains no row of this shape at all. So
 * it is written down instead, with the remedy that measures (two commands).
 */
test('the declined refusals are still refused, and still disclosed', () => {
  const declined = [
    `cat ${RUN}/run.json > out.txt`,
    `jq . ${RUN}/run.json > pretty.json`,
    `awk '{print}' ${RUN}/run.json > summary.txt`,
    `cat ${RUN}/run.json | tee out.txt`,
    `cat ${RUN}/run.json | jq . > pretty.json`,
    'rm -rf "$HOME/.traffic-one/runs"',
    `for f in ${RUN}/run.json`,
    `find .traffic-one/runs -name run.json -exec python3 -c "print(open(sys.argv[1]).read())" {} \\;`,
    // ROUND 8, and both are the OPERAND-ROLE limit rather than a destruction.
    // Ground-truthed as no-ops on the sidecars: `sort -o out.json {}` writes
    // `out.json`, and `-exec env \;` prints the environment. The first is
    // refused because this fence cannot tell which operand of the action is the
    // destination; the second because an action with no readable command word
    // is not a read, and fail-closed is the direction to be arbitrary in.
    'find .traffic-one/runs -name run.json -exec sort -o out.json {} \\;',
    'find .traffic-one/runs -name run.json -exec env \\;',
    // `cd` into the runs tree: an over-refusal this round declined, and the
    // same line as the family-1 residue. See `REFUSED_PEER_ORDINARY`.
    'cd .traffic-one/runs && ls',
    // ROUND 10: FOUR OF THE PEER'S EIGHT UNDISCLOSED OVER-REFUSALS, now
    // disclosed rather than fixed, each with what the disclosure costs. The
    // other four were fixed (three pure reads and a dry run) and are in
    // `PERMIT`.
    //
    // METADATA ON A SIDECAR (`chmod`, `touch -r`). Neither changes content, and
    // both were measured as no-ops. They stay refused because ownership of a
    // runtime sidecar is not only ownership of its bytes: a mode of 000 breaks
    // the next publish as surely as a truncation, and `touch` on a MISSING
    // sidecar fabricates one the runtime never wrote. The cost is that an agent
    // fixing permissions after a bad umask is refused; the remedy is to leave
    // the sidecar alone and let the runtime rewrite it.
    `chmod 644 ${RUN}/run.json`,
    `touch -r package.json ${RUN}/run.json`,
    // OPERAND ROLE (`ln -s <run> latest-run`, `mkdir -p <run>/debug`). The
    // convenience symlink writes at `latest-run` and reads the run; the mkdir is
    // idempotent on a directory that already exists. Both are refused by the
    // same limit that refuses `cp -r <runs tree> <backup>` and `-exec cp {}
    // /backup`: this fence reports the runtime paths a statement NAMES outside a
    // read, and it cannot tell which operand of a two-operand verb is the
    // destination. Fixing the class means per-verb operand roles, which is the
    // same feature `cd` needs and is declined here for the same reason. Cost:
    // two ordinary conveniences refused; remedy is to name the run directory
    // itself, which every rule above can read.
    //
    // The SYMLINK is the row where operand roles are the shallow reason and the
    // decline is load-bearing, measured in `.tmp/wd10/symlink-price.ts`: with the
    // link in place, `rm -f latest-run/run.json`, `truncate -s 0
    // latest-run/run.json` and `find -L latest-run -name run.json -delete` are
    // all `noop` and all destroy the sidecar (census 15 -> 14, and a content
    // change for the truncate), because a path through the link spells no
    // `.traffic-one` literal for either rule to judge. Permitting the link buys
    // a laundering route for every command after it. A per-verb operand role
    // would fix the over-refusal and open that route in the same move, so this
    // one should stay refused even when `cd` and `cp` get their roles.
    `ln -s ${RUN} latest-run`,
    `mkdir -p ${RUN}/debug`,
  ];
  for (const command of declined) {
    assert.ok(
      outcome(command).startsWith('deny'),
      `this is disclosed in the runtime-sidecar-owner-gate prose as refused and it is not: ${command}`,
    );
  }
});

/**
 * ONE ROOT, ONE VERDICT — the round-9 claim this round falsified.
 *
 * Round 9 recorded `rm -rf ~/.traffic-one/runs` as `noop` and unseen, `rm -rf
 * "$HOME/.traffic-one/runs"` as refused, and the pair as a DISTINCTION ("`~` is
 * another root, not this project's"). It was an inconsistency instead: `~` and
 * `$HOME` expand to the same directory, so a permit and a refusal for the same
 * path cannot both be right, and the defence offered for the tilde applied
 * verbatim to the spelling it conceded was refused.
 *
 * Round 10 corrected the BEHAVIOUR rather than the claim, for a reason that is
 * measured rather than aesthetic (`.tmp/wd10/home-quad.ts`): with HOME pointed
 * away from the fixture the tilde row destroys nothing, but with HOME pointing
 * AT the project it erases all 15 files, and `~+` needs no assumption about HOME
 * at all — it is `$PWD`. A rule that reads a tilde head as a path is a rule that
 * has guessed the value of a variable it does not hold.
 *
 * The price is stated in the prose and it is the same one `$HOME` already
 * carried: a deletion of ANOTHER project's runs tree is refused too. That costs
 * a rewording; the other direction costs a run.
 */
test('one root spelled eight ways gets one verdict', () => {
  const spellings = [
    'rm -rf ~/.traffic-one/runs',
    'rm -rf ~/".traffic-one/runs"',
    'rm -rf ~nobody/.traffic-one/runs',
    'rm -rf "$HOME/.traffic-one/runs"',
    'rm -rf "$HOME"/.traffic-one/runs',
    'rm -rf $HOME/.traffic-one/runs',
    'rm -rf "${HOME}"/.traffic-one/runs',
    'rm -rf ~+/.traffic-one/runs',
  ];
  const verdicts = new Map<string, string>();
  for (const command of spellings) verdicts.set(command, outcome(command).startsWith('deny') ? 'deny' : 'permit');
  assert.deepEqual(
    [...new Set(verdicts.values())], ['deny'],
    'these spellings all name the same directory, so a split verdict is an inconsistency rather than a policy: '
    + `${[...verdicts].map(([command, verdict]) => `${command} -> ${verdict}`).join('; ')}`,
  );
});

/**
 * The wd7 peer's 60 rows, measured. THREE CLASSES, each disclosed in the
 * `runtime-sidecar-owner-gate` block in the same commit that recorded it here:
 *
 *   `cd` into the runs tree (q44). An over-refusal — `cd` navigates and writes
 *   nothing (ground-truthed) — and it CANNOT be paid off on its own. `cd` is
 *   also the first member of the module's family-1 residue, so admitting it as
 *   a read without tracking the working directory turns a false refusal into a
 *   live escape: `cd <runs tree> && rm -rf run-1` is refused TODAY only by this
 *   over-refusal. Round 8 declined it deliberately and says so in the prose,
 *   because the honest fix is a workdir tracked across pieces and that is a
 *   feature, not a narrowing. What round 8 did NOT do is pretend the refusal is
 *   about ownership.
 *
 *   READ-INTO-OUTPUT (q45–q49). The redirect class, declined by round 7 with
 *   its measurement and upheld by the peer on all three legs (attribution,
 *   pre-existence, remedy). Unchanged here.
 *
 *   READ-INTO-BACKUP (q51, q52). `cp -r <runs tree> <dest>` and `rsync -a
 *   <runs tree>/ <dest>/` read the tree and write elsewhere; both are no-ops on
 *   the sidecars. Refused because `destroyedScopes` cannot tell a copy FROM a
 *   path from a copy ONTO it, which is the same operand-role limit `-exec cp {}
 *   /backup` is refused under. Disclosed rather than fixed: the product's own
 *   answer to "snapshot state before a reset" is `doctor.cjs --bundle`, which
 *   is permitted (measured).
 *
 *   ECHO OF THE PATH (q19), new in round 9 and a DISCLOSURE rather than a new
 *   ruling. `for f in <runs glob>; do echo "$f"; jq -r .status "$f"; done` is
 *   refused on its `echo`, which the prose has listed as refused since round 6
 *   ("`echo "see <sidecar>"` … which write nothing at all") and which
 *   `GROUPING_HEADS` records as a standing ruling. It read as permitted here for
 *   three rounds for the SAME reason round 9's P1 escape existed: a value
 *   substituted INSIDE its double quotes left the piece spelling
 *   `echo ".traffic-one/runs/…/run.json"`, quotes included, which matched no
 *   sidecar literal — so the row was not permitted by a judgement, it was unseen
 *   by one. Stage 4 now drops the quotes with the reference (it must: `"$R"/<id>`
 *   is one word), the occurrence becomes visible, and the standing `echo` ruling
 *   applies to it. THE RECORD IT FALSIFIES: rounds 7 and 8 both scored q19 as an
 *   ordinary permitted read. Paying it off means admitting `echo` as a shell read
 *   verb, which is a live ruling with its own reasons (`> <path>` and
 *   `echo "<code>" | node` sit on the same verb) and not something to flip as a
 *   side effect of a quoting fix. Remedy for the agent: drop the `echo`, or print
 *   something that is not the path.
 *
 * q58 was the ninth refusal the peer measured and it is GONE: it is the
 * `-exec jq -r` regression round 8 paid off.
 */
const REFUSED_PEER_ORDINARY: readonly string[] = [
  'q19', 'q44', 'q45', 'q46', 'q47', 'q48', 'q49', 'q51', 'q52',
];

test('the over-refusal cost on the peer corpus is exactly the disclosed set', () => {
  assert.equal(ORDINARY.length, 47, `the wd6 peer corpus is 47 rows; this one has ${ORDINARY.length}`);
  const refused = ORDINARY.filter((row) => outcome(row.cmd).startsWith('deny')).map((row) => row.id);
  assert.deepEqual(
    [...refused].sort(), [...REFUSED_ORDINARY].sort(),
    'the over-refusal ledger moved. A row ADDED is an ordinary agent action this gate now refuses without '
    + 'saying so; a row REMOVED is shipped prose promising a refusal that no longer happens. Re-measure, then '
    + 'move the disclosure in the runtime-sidecar-owner-gate block in the same commit.',
  );
});

test('the over-refusal cost on the SECOND peer corpus is exactly the disclosed set', () => {
  assert.equal(PEER_ORDINARY.length, 60, `the wd7 peer corpus is 60 rows; this one has ${PEER_ORDINARY.length}`);
  const refused = PEER_ORDINARY.filter((row) => outcome(row.cmd).startsWith('deny')).map((row) => row.id);
  assert.deepEqual(
    [...refused].sort(), [...REFUSED_PEER_ORDINARY].sort(),
    'the second over-refusal ledger moved. Same rule as the first: a row ADDED is an ordinary agent action '
    + 'refused without disclosure, a row REMOVED is prose promising a refusal that no longer happens.',
  );
});
