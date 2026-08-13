// src/shared/state/state-loss.ts
// One advisory: this project HAD Traffic One state and the state directory is
// gone. Pure reads — nothing here writes, and nothing here decides a verdict.
//
// WHY IT EXISTS. A project's entire run-scoped bound set lives under
// `.traffic-one/runs/<runId>/`, so removing the directory removes all of it at
// once: the reset ladder and the count the next reset is priced at, an inherited
// terminal model exhaustion, role claims, the compiled architecture and its
// published verification contract, assignments, the decision log, deny-repeat
// records, the ledger. Measured on a project driven to all of those through the
// real writers, every one of them read back empty afterwards, and the product
// then said `traffic-one [setup required]` — the same sentence it gives a
// project it has never seen. A total loss presented as a fresh start is the
// defect this notice closes, and it closes it by SAYING SO, not by refusing:
// removing the directory is a supported thing for a user to do, the product's
// own tests assert it, and nothing here changes what any gate decides.
//
// WHY IT CAN TELL THE DIFFERENCE AT ALL. Two records survive a tree-wide wipe,
// both keyed to this project, both outside the wiped tree:
//   - the per-project preferences bucket,
//     `~/.traffic-one/projects/<sha256(realpath(cwd))>/preferences.json`, which
//     holds the answers to the setup questions (performance, team, OpenCode) and
//     the graph-run timestamps;
//   - git, because `.traffic-one/.one.json` is committed by design
//     (config/paths.ts) while `.traffic-one/runs/` is in the generated
//     `.gitignore` (architecture-contract/scaffold-content.ts).
// Either one proves the project was set up here. NEITHER proves what the bounds
// WERE — no run-scoped fact has a copy outside the tree — so this notice names
// the categories it knows the directory holds and states plainly that it cannot
// say which of them this project had reached. Every clause below is either read
// off a surviving record or phrased as "no longer binds", which is the only
// claim absence supports.
//
// WHAT IT DELIBERATELY DOES NOT USE. Consent alone (`pluginUse.enabled`) is NOT
// evidence: it is recorded when the user first says yes, BEFORE any setup step
// runs, so a brand-new project that has answered only that question would
// otherwise be told it had lost state it never had. Same for `toolchain`, which
// a pristine new project gets stamped on its first session. The evidence keys
// are the ones a setup step had to complete to write.

import * as path from 'path';
import { execFileSync } from 'child_process';

import { readRegularFileResult } from '../bounded-read';
import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { obj, type Rec } from '../obj';
import { projectPrefsPath, readProjectPrefs } from './local-prefs';
import { statePath } from './normalize';

/** Why the pointer is unusable. `null` when it is usable, or when the project
 *  carries a legacy state file that still holds its answers. */
export type PointerLoss = 'absent' | 'blank';

// The three shapes measured as PERMITTED against the pointer file — `rm -f`,
// `: >` (an empty file) and `printf "{}" >` (an empty object) — are exactly the
// three this recognises. A present file holding UNPARSEABLE non-empty bytes is
// deliberately not one of them: that is the degraded case, where
// `ensureCurrentRunId` refuses to mint and the session header already reports a
// refused state write, and a torn concurrent write must not be announced to the
// user as a wipe. It is a residual, and it is named in the report rather than
// hidden here.
export function pointerLoss(cwd: string): PointerLoss | null {
  // Bounded, and the three outcomes are exactly the three this function needs.
  // `absent` is a removal. `unreadable` is NOT: a FIFO, a device or a directory
  // planted at this path is something present that cannot be read, and calling
  // that a wipe would announce a loss on a project whose state may be intact —
  // besides which an unbounded `open(O_RDONLY)` on a FIFO never returns, and this
  // path is one an agent can create (shared/bounded-read.ts).
  const read = readRegularFileResult(statePath(cwd));
  // No legacy fallback to consult: `LEGACY_STATE_FILE` and `STATE_FILE` are the
  // same path (config/paths.ts), so the read above already asked both questions.
  if (read.kind === 'absent') return 'absent';
  if (read.kind === 'unreadable') return null;
  const raw = read.text;
  if (raw.trim().length === 0) return 'blank';
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null; // degraded, not wiped — see the note above
  }
  const state = obj(parsed);
  if (!state) return null;
  const identity = ['mode', 'stack', 'currentRunId', 'onboardingComplete', 'confirmed'];
  return identity.some((key) => state[key] !== undefined && state[key] !== null && state[key] !== '')
    ? null
    : 'blank';
}

/** One surviving record's worth of evidence, already rendered as the clause the
 *  notice prints. Facts only: every string here was read off disk. */
export interface StateLossEvidence {
  readonly prefs: string | null;
  readonly committed: string | null;
}

function nonEmptyString(value: unknown, max = 64): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // Rendered into a user-facing block, so the same bound the update feed uses
  // applies: one line, no structure, nothing that can open a fence.
  if (!trimmed || trimmed.length > max || /[\s`\n]/.test(trimmed)) return null;
  return trimmed;
}

// The preferences bucket, read for the questions that only a completed setup
// STEP can have written. `pluginUse` and `toolchain` are excluded on purpose
// (see the header).
function prefsEvidence(cwd: string, env: NodeJS.ProcessEnv): string | null {
  let prefs: Rec;
  try {
    prefs = readProjectPrefs(cwd, env);
  } catch {
    return null;
  }
  // Deduplicated across hosts on purpose: the bucket keys these answers per
  // host, and a project a user has opened in three of them would otherwise
  // render the same two questions six times in the middle of a notice whose
  // whole job is to be read.
  const answered = new Set<string>();
  const hosts = obj(prefs.hosts) || {};
  for (const host of Object.keys(hosts).sort()) {
    const hostPrefs = obj(hosts[host]);
    if (!hostPrefs) continue;
    if (obj(hostPrefs.performance)?.target) answered.add('Performance');
    if (obj(hostPrefs.team)) answered.add('the team question');
  }
  if (obj(prefs.openCode)) answered.add('the OpenCode question');
  if (nonEmptyString(prefs.graphifyLastRunAt) || nonEmptyString(prefs.gitnexusLastRunAt)) {
    answered.add('a completed code-graph run');
  }
  if (answered.size === 0) return null;
  let bucket = '';
  try {
    bucket = projectPrefsPath(cwd, env);
  } catch {
    bucket = '';
  }
  return `the per-project preferences Traffic One keeps OUTSIDE this tree${bucket ? ` (\`${bucket}\`)` : ''}`
    + ` still hold this project's answers to ${[...answered].join(', ')}`;
}

// git's copy of the committed pointer. `HEAD:./<rel>` is resolved relative to
// `-C`, so a project nested inside a larger repository asks about its own file
// rather than the repository root's. One invocation does both jobs: existence
// (a non-zero exit means HEAD has no such path) and the three fields below.
function committedEvidence(cwd: string): string | null {
  const rel = `${STATE_DIR}/${path.basename(STATE_FILE)}`;
  let out = '';
  try {
    out = execFileSync('git', ['-C', cwd, 'show', `HEAD:./${rel}`], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 256 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not a repo, no commit, or the pointer was never committed
  }
  const facts: string[] = [];
  const committed = (() => {
    try { return obj(JSON.parse(out) as unknown); } catch { return null; }
  })();
  if (committed) {
    const mode = nonEmptyString(committed.mode);
    const stack = nonEmptyString(committed.stack);
    const runId = nonEmptyString(committed.currentRunId, 32);
    if (mode) facts.push(`mode \`${mode}\``);
    if (stack) facts.push(`stack \`${stack}\``);
    if (runId) facts.push(`run \`${runId}\``);
  }
  return `git still has the committed \`${rel}\` at HEAD${facts.length ? ` (${facts.join(', ')})` : ''}`;
}

export function stateLossEvidence(cwd: string, env: NodeJS.ProcessEnv = process.env): StateLossEvidence {
  return { prefs: prefsEvidence(cwd, env), committed: committedEvidence(cwd) };
}

// Does HEAD carry the run directories, or only the pointer and the rule bundle?
// The recovery sentence turns on this and nothing else, so it is ASKED rather
// than inferred from the `.gitignore` Traffic One converges: that file names
// `.traffic-one/runs/` (architecture-contract/scaffold-content.ts) and normally
// keeps them untracked, but git never untracks what is already committed, so a
// project that was committed before the block landed — or forced past it — has
// them in HEAD and really does get its bounds back from a restore. Telling that
// user the bounds are unrecoverable would be false, and telling the ordinary
// user they are recoverable would be worse. Only called once the notice is
// certain to print.
export function committedRunState(cwd: string): boolean {
  try {
    const out = execFileSync('git', ['-C', cwd, 'ls-tree', '-r', '--name-only', 'HEAD', '--', `${STATE_DIR}/runs`], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// The categories, not a claim about this project. Kept as one list so the two
// halves of the sentence that follows it cannot drift apart: everything named
// here lives under `.traffic-one/runs/`, and nothing named here has a copy
// outside the tree.
const RUN_SCOPED_BOUNDS = 'the reset ladder and the count the next reset is priced at, an inherited '
  + 'terminal model-exhaustion obligation, role claims, the compiled architecture and its published '
  + 'verification contract, the run\'s assignments, the decision log, deny-repeat records, and the run ledger';

/**
 * The notice, or `null` when there is nothing to say — which is the answer for
 * every project whose pointer is usable, and for every project with no
 * surviving record of a completed setup step (a fresh checkout, a project that
 * never onboarded, a project that has answered only the use-plugin question).
 *
 * Composed, never emitted, here: the caller merges it as SessionStart advisory
 * context beside the one-mcp, auth and uncertified-host advisories, so it can
 * never become a refusal and can never replace one.
 *
 * NOT throttled with a `shared/once.ts` marker, unlike its neighbours, and the
 * reason is the subject: those markers live under
 * `.traffic-one/runs/.once/`, so throttling this notice would re-create part of
 * the very directory whose absence it is reporting, and put a fresh `runs/`
 * tree in front of every reader that scans one. SessionStart fires once per
 * session on the hosts that have one; the hosts whose system transform can fire
 * repeatedly may see it more than once per chat, which is the cheaper half of
 * that trade.
 */
export function stateLossNotice(cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const loss = pointerLoss(cwd);
  if (!loss) return null;
  const evidence = stateLossEvidence(cwd, env);
  const clauses = [evidence.prefs, evidence.committed].filter((clause): clause is string => Boolean(clause));
  if (clauses.length === 0) return null;

  const missing = loss === 'absent' ? 'is missing' : 'holds nothing';
  return `[traffic-one] STATE WAS RESET — this project had Traffic One state and it is gone. `
    + `\`${STATE_DIR}/.one.json\` ${missing}, so Traffic One is about to treat this project as `
    + `un-onboarded and take it through setup from the start. It is not un-onboarded: ${clauses.join(', and ')}.\n`
    + `GONE WITH THE DIRECTORY: everything keyed to a run under \`${STATE_DIR}/runs/\` — ${RUN_SCOPED_BOUNDS}. `
    + 'Traffic One cannot tell you WHICH of those this project had, or how far the reset ladder had climbed: '
    + 'those facts were only ever recorded inside the directory that is missing, and nothing outside it keeps a '
    + 'copy. What it can tell you is that none of them bind any more, so work starting now starts unbounded.\n'
    + 'IF THIS WAS DELIBERATE nothing is wrong — finish setup when the link appears and carry on.\n'
    + `IF IT WAS NOT — ${recoveryClause(cwd, Boolean(evidence.committed))}\n`;
}

// What to actually DO — and the two readers of this notice do NOT have the same
// powers, which is the whole reason this clause is shaped the way it is.
//
// This text is injected into an AGENT's session context, and an agent's shell goes
// through PreToolUse. Measured on mkdtemp fixtures through the full hook pipeline,
// with controls (`echo`/`ls`/`cat`/`git status` permitted in every state, and
// `rm -rf .traffic-one` refused in the intact state, so the fences were live):
// with the pointer absent or blank, EVERY git restore spelling is refused for the
// agent by the onboarding gate — `git restore`, `git checkout --`,
// `git checkout HEAD --`, `git checkout -- .`, `git stash pop`, `git reset --hard`,
// `git clean -fdx` — and the whole-directory restore is refused even on a healthy
// project, there by the plan gate's sidecar fence. Printing `git restore` as THE
// remedy therefore hands an agent a command it will be denied, and a denied
// command in a notice is a retry loop the user watches.
//
// So each clause names its actor. What the AGENT is given is the one route
// measured to work: `git show HEAD:<pointer>` is a read and is permitted in every
// state, and Write/apply_patch to the state path is exempted from the write fence
// (the state gate's own deny prose instructs the agent to author that file, and
// the control — Write to `src/x.ts` in the same state — is refused by both gates,
// so the exemption is path-shaped rather than a hole). Restoring the committed
// bytes that way put a wiped fixture back into ordinary operation: the onboarding
// gate stopped denying, the verdict on an unrelated write returned to the
// intact-project baseline, and the next session rebuilt the manifest, 45 rule
// files and the run's capability baseline from the pointer alone. It recovered no
// bound and no compiled architecture.
//
// The USER is not gated at all — a human in their own terminal never meets
// PreToolUse — so the git route is still the better one, and it is still printed.
// It is just addressed to the person who can actually run it.
function recoveryClause(cwd: string, pointerCommitted: boolean): string {
  const pointer = `${STATE_DIR}/.one.json`;
  if (!pointerCommitted) {
    return `nothing here is restorable, by either of you: git has no committed \`${pointer}\` at HEAD, so there `
      + 'is no copy to put back and no restore command worth running (they are refused for the agent anyway '
      + 'while the pointer is missing). The way back is forward — relay the setup link when it appears, then '
      + 're-run the architect to PLAN_READY on the next build so architecture, verification and assignments are '
      + 'compiled again. The bounds above stay gone either way.';
  }
  const userRoute = `THE USER, in their own terminal, is not gated by any of this: \`git restore ${STATE_DIR}\` `
    + `(older git: \`git checkout -- ${STATE_DIR}\`) brings back everything this project committed`;
  const bounds = committedRunState(cwd)
    ? ` — and HEAD carries \`${STATE_DIR}/runs/\` as well, which is unusual (Traffic One's generated `
      + '`.gitignore` excludes it) and means the run directories and whatever they recorded come back with it. '
      + 'Check `git status` afterwards: anything the restore did not bring back was never committed and is gone.'
    : ' — the pointer, the materialized rule bundle, project memory and digests. Not the bounds above: HEAD '
      + `carries no \`${STATE_DIR}/runs/\` (Traffic One's generated \`.gitignore\` excludes it), so those run `
      + 'directories were never in git.';
  return 'the two of you have different powers here, so read the labels.\n'
    + `  · YOU, THE AGENT, CANNOT RESTORE THIS FROM GIT. With the pointer gone, \`git restore ${STATE_DIR}\`, `
    + `\`git checkout -- ${STATE_DIR}\`, \`git checkout HEAD -- ${STATE_DIR}\`, \`git checkout -- .\`, `
    + '`git stash pop`, `git reset --hard` and `git clean -fdx` are all refused for you by the setup gate, and '
    + 'the whole-directory restore is refused even on a healthy project. Do not run them and do not retry them. '
    + 'Relay this notice and ask the user whether the removal was intended.\n'
    + '  · IF THE USER SAYS IT WAS NOT, you have one route that works, in two steps: read the committed pointer '
    + `with \`git show HEAD:${pointer}\` (a read — permitted in this state), then write those exact bytes to `
    + `\`${pointer}\` with Write or apply_patch (the one path the write fence exempts, because the state gate `
    + 'instructs you to author it). The next session rebuilds the rule bundle, the manifest and the run\'s '
    + 'capability baseline from that pointer — but no bound above comes back, and neither does the compiled '
    + 'architecture: re-run the architect to PLAN_READY on your next build.\n'
    + `  · ${userRoute}${bounds}`;
}
