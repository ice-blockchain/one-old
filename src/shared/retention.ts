// src/shared/retention.ts
// Conservative .traffic-one retention sweep. Three classes of candidate:
// correlated run artefacts, clearly-ephemeral logs/locks/backups, and LEAKED
// nested state roots. Dry-run by default.
//
// That third class is the only rule here that reaches for a whole `.traffic-one`
// tree rather than a generated artefact inside one, and the product ruling on it
// is one sentence: NEVER DELETE DURABLE MEMORY. Nothing regenerates a
// hand-authored product.md, plan.md, ADR or local skill, and no other rule in
// this file deletes a file a human wrote.
//
// THE PROTECTION IS INVERTED, and three rounds of the other direction are why.
// It used to be a carve-out — an allowlist of the names the runtime treats as
// durable, matched through a fold and then through the filesystem's own answer
// about which entry a durable name resolves to — and every round widened the list
// after a reviewer found live data loss. That is the shape of the defect, not a
// gap in the list: "never delete durable memory" and "never delete these
// enumerated names" are not the same sentence, and the second one
// says nothing at all about a file a human wrote under a name nobody predicted.
// MEASURED on a leaked root holding exactly one hand-authored file: `notes.md`,
// `product.markdown`, an NFD-spelled `plán.md`, `product.md` followed by a
// zero-width space, and `KNOWN-İSSUES.MD` were EACH planned for deletion as a
// single `<WHOLE ROOT>` action — because with nothing spared the root is not
// emptied entry by entry, it goes in one go. A zero-width space is not a
// curiosity: it renders identically to `product.md` everywhere, and pasting a
// filename out of a document is an ordinary way to acquire one.
//
// So the question this file asks is the other one: not "is this durable
// memory" but "did the runtime write this", which the runtime can answer. The
// heal takes ONLY entries it can positively recognise as runtime artefacts and
// spares the remainder, whatever it is called. See recogniseEntries:
// recognition is a closed set of fourteen PATHS derived from the rule table
// rather than a hand-kept list, and it never reads a file's CONTENT.
//
// RECOGNITION IS A MINORITY OF WHAT THE RUNTIME WRITES, and this header claimed
// the opposite for seven rounds. ("ABOUT HALF" is what this heading said until it
// was checked against its own paragraph: fourteen paths over eleven top-level
// names against a derivation answering 55 is a fifth to a quarter, and the pin
// measures 44 unrecognised of 55. Nothing broke, because the pin below only ever
// required a MINORITY — but a number in a heading is exactly what the rest of this
// header stopped keeping, and the sentence it was heading refuted it.) It read
// "every top-level entry it emits into a
// state root is one this file's own rules name", which is FALSE and is the
// sentence that kept the residue unpriced. RUNTIME_ENTRY_PATHS is built from the
// paths the SCHEDULING RULES here name, and the runtime names many more.
// MEASURED, and no longer measured HERE: the derivation is a test rather than a
// number in this comment, because a number in this comment is what drifted. It
// walks every non-test TypeScript file in `src/` for every `.traffic-one/<name>`
// spelled in a string plus every `path.join(…, '.traffic-one', '<name>', …)`
// whose arguments resolve to literals, and it runs on every push —
// materialized-entries.test.ts, "the residue the retention header prices is
// recomputed here, not recited there". It holds a FLOOR, a MINORITY property and
// an ENUMERATION, and the third is the one carrying the weight: the floor is 45
// against a derivation that answers 55, and exactly 10 of those 55 reach it only
// through the instrument's `path.join` arm — so with that whole arm dead the
// derivation answers 45 and the floor still passes. What would red is the
// enumeration below, name by name (seven of those ten are in it). The floor's
// residual value is the other direction, and its vacuity is exact: 23 of the 55
// names are anchored by name, so up to 10 unanchored ones can be lost in silence.
//
// What it answered this round: 55 top-level names, THREE of which nothing writes
// at all — `x` and `x.json`, placeholder examples in comments, and `core.md`,
// whose every piece of evidence is one line of PROSE INSIDE A STRING
// (shared/packing.ts:23, a SessionStart bundle line telling an LLM that rules are
// "Materialized at `.traffic-one/rules/...` and `.traffic-one/core.md`"). So ~52
// real ones, against RECOGNITION's fourteen paths. `core.md` is labelled here
// because the alternative is a name sitting in none of the three groups below,
// which reads as an omission in the arithmetic rather than as an instrument
// artefact — `overrides` is labelled the same way, one level down, in the
// derivation's own commentary. It is the SAME class as `x.json` and a worse
// version of `overrides`: that name's evidence is prose in COMMENTS, this one's is
// prose the product SHIPS to a reader. Nothing writes `.traffic-one/core.md`, so
// that sentence points an LLM at a file the materializer does not produce — a
// defect in packing.ts, not here, and named rather than chased. Earlier rounds quoted 62 and 60 from hand-run drivers over
// slightly different tokenizers and one of them quoted a source-file count that
// went stale twice. The exact figure is a property of the instrument; the FLOOR is
// a property of the tree, and every difference between the three numbers is on
// the side of MORE residue, never less. The residue is not one class:
//
//   HAND-AUTHORED MEMORY the gates READ and must never delete — `plan.md`,
//     `product.md`, `stack.md`, `api.md`, `coding.md`, `database.md`,
//     `security.md`, `deployment.md`, `known-issues.md`, `environment-setup.md`,
//     `schema.sql`, `agent-log.md`, `architecture.md`, `decisions` (the ADR
//     directory the architect scope gate tells that role to write into) and
//     `tmp` (named in a shipped deny as a scratch location). Absent from the
//     table on purpose, and the largest single group: a widening keyed on "the
//     runtime names it" would take all fifteen.
//   THE HOME STATE ROOT's entries — `bin`, `projects`, `toolchains`, `one.json`,
//     `one.json.lock`, `machine.json`, `cursor-models.json`,
//     `windsurf-plugin-root`. listNestedTrafficOneDirs never leaves the project,
//     so no heal can reach them; they are in the enumeration because one string
//     spells both roots. `machine.json` appears in the next group as well for
//     exactly that reason, and is counted once there.
//   RUNTIME ARTEFACTS WITH NO RETENTION RULE. The names sit between two MARKERS
//     because the pin that keeps this list and materialized-entries.test.ts's
//     HEADER_RESIDUE in step reads the ENUMERATION, not the paragraph: everything
//     past the closing marker is prose, and three of these names are spelled in it
//     while telling the story of how they went missing from the list. A pin over the
//     paragraph is therefore satisfied by that story — measured, and it was
//     (materialized-entries.test.ts records the survivor). Anything backticked
//     between the markers is read as a NAME, so keep prose out of them, and refer to
//     the markers without SPELLING either one: each must occur exactly once, and
//     that assertion fired on the first sentence written about it.
//     RESIDUE-LIST: `.gitnexus`, `graphify-out`, `overrides`, `deployments.jsonl`,
//     `token-log.jsonl`, `one-mcp-report.json`, `graph-preview.md`,
//     `qa-build-identity.json`, `.agentignore`, `.onboarding-main-sessions.json`,
//     `onboarding-server.json`, `onboarding-complete.json`,
//     `onboarding-server.lock`, `onboarding`, `preferences.json`, `machine.json`,
//     `AGENTS.local.md`, `CLAUDE.local.md`, `.one.json.report-id.lock`,
//     `.one.json.corrupt` :RESIDUE-LIST-END
//     NO COUNT IS QUOTED HERE ANY MORE, and that is the fix rather than a
//     softening: this heading said EIGHTEEN with seventeen names under it, then
//     EIGHTEEN with `.one.json.report-id.lock` missing, then NINETEEN with
//     `.one.json.corrupt` missing — three times, each time short by a name some
//     writer ASSEMBLES, and each time the figure and the list agreed with each
//     other. A count over an enumeration cannot notice a name nobody wrote down,
//     so what is pinned instead is CORRESPONDENCE: every name here is a name
//     materialized-entries.test.ts holds, and the reverse (see "the residue the
//     retention header prices is recomputed here"). All three misses share one
//     shape — `${<a path the derivation can see>}<literal suffix>`:
//     `state/project-state-lock.ts:750` returns
//     `${path.join(path.resolve(cwd), STATE_FILE)}.report-id.lock`, so the token
//     `report-id` occurs NOWHERE in this file while the directory it names is a
//     genuine top-level entry of a project state root; `state/normalize.ts:332`
//     writes `${filePath}${CORRUPT_STATE_SUFFIX}` beside the state file, which is
//     the user's ONLY copy of state bytes nothing could parse. Both carry
//     sibling families whose spellings cannot be enumerated AT ALL —
//     `<lock>.<token>.pending`/`.released` with `<token>` being pid+time+random,
//     and fsjson's three temp shapes (`.one.json.<pid>.tmp`,
//     `.one.json.<pid>.<ms>.<rand>.tmp`, `.one.json.<pid>.<index>.set.tmp`), each
//     cleaned in a `finally` that a SIGKILL does not run. A list of names is the
//     wrong instrument for those by construction, which is why what covers them
//     is a DERIVED partition over a fixture's own listing
//     (materialized-entries.test.ts) with representatives planted by hand, and
//     not a fourth enumeration. What would actually bound the class is stated
//     there: the writers' EXPRESSIONS evaluated, which is a type-checker's job.
//     This is the group the cost lands in, and NONE of them joins the table this
//     round — see recogniseEntries for the per-name ruling, for what the decline
//     actually costs (re-measured) and for why "the runtime wrote it" is not
//     sufficient. A leaked root holding any of them is REDUCED rather than
//     healed and reports it, which is a leftover rather than a loss, and it is
//     now a DISCLOSED cost.
//
// The enumeration has TWO KNOWN BLIND SPOTS, named because a re-derivation whose
// limits are unstated is the inherited list again:
//
//   A NAME ASSEMBLED FROM A TABLE of path fragments joined in a loop is
//     invisible to it. `state/traffic-one-paths.ts`'s STRAY_PROJECT_ARTIFACTS and
//     `state/plugin-use.ts`'s DECLINE_ALWAYS_REMOVED are both that shape, and the
//     second one is why `.once` is the single carve-out in the producer census
//     (materialized-entries.test.ts).
//   A NAME COMPUTED BY AN EXPRESSION is too, and this is the blind spot to
//     DISTRUST rather than the one to note: every name this enumeration has been
//     short by — three of them now, over three rounds — went missing through it,
//     and each was found by reading a writer rather than by any instrument here.
//     `.one.json.report-id.lock` and `.one.json.corrupt` are template literals
//     over `STATE_FILE` and over the state file's path (see the
//     group above), and render-agents' `localContextName`
//     returns `'CLAUDE.local.md'` or `'AGENTS.local.md'` out of a conditional, and
//     the only other spelling of it reads a table — so the derivation sees the
//     twin, which is also written as a plain literal, and never sees this one.
//     MEASURED on this round's run: `AGENTS.local.md` is in the output and
//     `CLAUDE.local.md` is not, asserted as an ABSENCE by the pin named above.
//     That is the whole provenance of a list that enumerated seventeen names under
//     a heading that said eighteen — a producer the instrument cannot see, not a
//     name nothing writes, and the file it writes holds the user's bytes. (The
//     other hypothesis on offer — that the number was copied from the size of the
//     RETIRED durable allowlist described at the top of this header — is NOT
//     checkable: no revision in git carries that list, so its size cannot be
//     counted. That is also why the header no longer quotes a size for it.)
//
// So the derived count is a FLOOR, not a total, and its exact value is a property
// of the instrument as much as of the tree. The pin named above asserts exactly
// that shape — a floor, a minority, and the enumerated residue present in the
// derivation with the TWO blind-spot names asserted ABSENT — so the blind spots
// are checkable claims rather than a story about how a number went wrong.
//
// PATHS, not names, and the difference cost a round. Two of the fourteen are two
// segments long — `reports/qa` and `reports/lighthouse` — and the derivation
// used to truncate every path to its first segment, which manufactured a bare
// `reports` that no rule schedules and handed it authority over the whole
// directory. Measured: an archived token report and a security report, both
// written under paths the shipped product documents, destroyed in one
// `<WHOLE ROOT>` action with zero notices. See RUNTIME_ENTRY_PATHS.
//
// WHICH WAYS IT CAN BE WRONG, checked against the code rather than asserted —
// the function compares each entry name against that table, exactly, descending
// only where a rule spells a path deeper than one segment, so there are only
// two:
//
//   A PATH IT DOES NOT CARRY. The entry is unrecognised, therefore spared and
//     reported. Every incompleteness lands here — a runtime artefact added next
//     year, a renamed materialization output, any spelling variant at all (NFD,
//     Turkish İ, a trailing space) — and it leaves a file in place.
//   A PATH IT CARRIES, over an entry the USER authored. This one deletes, and it
//     is the residual exposure this design has: it needs a human to have created
//     `.traffic-one/<one of fourteen exact paths>` themselves. That is why every
//     row in the table has to answer "does anything shipped tell a user to
//     author this?", why `skills/`, `agents/` and `retention.json` are excluded
//     for failing it, and why the table is pinned by content — and its
//     DERIVATION pinned separately, since that is what failed — in
//     __tests__/materialized-entries.test.ts.
//
// The content arm that used to sit beside this had no such bound: the marker is
// public documentation, so ANY document quoting it was deleted. Measured, six
// were. See recogniseEntries.
//
// WHAT THAT COSTS, named rather than discovered: a leaked nested root is no
// longer fully healed. It is REDUCED to what the runtime does not recognise, and
// the leftovers are reported. That is the correct direction to fail under the
// ruling, and the report is bounded IN THE STATE WHERE THE REDUCTION LANDS: the
// heal takes `.one.json` with it, so the root retires from this rule and the
// same leftovers are not re-reported on the next SessionStart.
//
// It is NOT bounded where nothing is reclaimed, and this header claimed
// otherwise unconditionally for three rounds. A dry run reclaims nothing by
// definition, and so does an apply sweep on a project whose use-plugin question
// is unanswered: the write fence refuses every path, the `.one.json` that makes
// this a candidate stays, and the same line comes back every SessionStart until
// the question is answered. MEASURED on three consecutive apply sweeps with the
// question open — 0 removed, 0 failed, one notice on each. See
// leakedRootActions and announceReducedRoot, both of which carry the caveat.
//
// Deletion is a write, and this sweep is the single biggest one in the runtime
// (measured: 55 paths reclaimed in one SessionStart). It goes through fsjson's
// guarded removePath, so a project whose use-plugin question is unanswered is
// never reclaimed — the pending half of the product contract is byte-identity,
// and this half of breaking it is the irreversible one. Planning is unaffected:
// collectActions only reads, so a dry run still reports what WOULD go.
//
// The keep set is RECENCY plus LIVENESS. Recency alone deleted runs that agents
// were still working inside, because the newest-N window is blind to whether a
// run is alive: measured on a realistic 9-run tree, 5 runs were reclaimed and 2
// of those 5 still held live claims. See runIsLive — and note that liveness is
// built out of protections that EXPIRE, so ACTIVITY cannot renew one: every
// window here is measured from a run's own mint stamp or from a claim's own
// timestamp, never from a directory mtime that a write moves. It used to be
// otherwise — an id the runtime never mints fell back to the run directory's
// mtime, so a torn ledger plus one write inside the run bought protection
// again, indefinitely. MEASURED and closed; see runAgeMs.
//
// NOTHING HERE PROTECTS INDEFINITELY ON ACTIVITY, and this is everything that
// protects indefinitely at all — unnumbered on purpose, since the count in this
// sentence went stale the first time the list grew:
//
//   - a state file that will not parse, which suspends the RUN-HISTORY caps
//     until the user repairs it. A broken input only they can fix, announced
//     rather than absorbed, and deliberately not a blanket suspension — see
//     readPolicy for which caps stay on and why.
//   - an artefact whose AGE no clock on this host can establish, which no TTL can
//     ever fire for. It used to be the silent one — a single future mtime made
//     every ephemeral family immortal with nothing said — and it is now the
//     narrow residue of that: mtime, then birthtime/ctime as substitutes, and a
//     notice when even those disagree with the host. See entryAge.
//   - a run whose EVIDENCE no stat on this host can reach, which is the same
//     ignorance one question over: the newest-N rule reserves such an id outside
//     the budget rather than ranking it (keepRunIds), and the orphan TTL declines
//     to read a failed stat as "abandoned" (entryPresence). Both arms are bounded
//     by the same user action, and it is the one the notice above names — a mode
//     bit. Reserving rather than ranking is what keeps this protection from being
//     paid for by a genuine run, which is how it shipped for a round.
//   - a run id minted AHEAD of the clock, through both arms of runIsLive. The
//     deliberate skew trade, priced in the comment above runIsLive and pinned
//     by two tests so a guard fitted there can never land looking free.
//   - `currentRunId` and the caller's protectRunIds, which are RESERVATIONS
//     rather than expiries and are meant to be: they name the run being worked
//     in right now.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_DIR, STATE_FILE } from '../config/paths';
import { SUBAGENT_STALE_MS } from '../config/state';
import { agentVisibleName, agentVisiblePath } from './agent-visible-name';
import { trustworthyAgeSince } from './clock-skew';
import { readJson, readJsonResult, removePath, type JsonRead } from './fsjson';
import { resolveProjectRoot } from './hook/paths';
import { obj } from './obj';
import { runLiveClaimEvidence } from './run-settlement';
import { shellQuote } from './shell-quote';
import { runLedgerStatusRecord } from './state/run-agent/terminal-verdict';

interface RetentionPolicy {
  keepRuns: number;
  backupKeep: number;
  orphanTtlDays: number;
  /** Newest Lighthouse runs kept per route; older ones are superseded copies. */
  lighthouseKeepPerRoute: number;
}

interface RetentionAction {
  action: 'remove';
  path: string;
  reason: string;
}

interface RetentionResult {
  cwd: string;
  dryRun: boolean;
  policy: RetentionPolicy;
  keepRunIds: string[];
  /**
   * The subset of `keepRunIds` retained because the run is still ALIVE (live
   * claims, or a non-terminal ledger inside the mint window) rather than merely
   * recent. Reported so a dry run can say WHY a run survived — without it the
   * newest-N reason string is the only explanation on offer, and it is the wrong
   * one for these ids. Empty under a suspended policy (see collectActions):
   * there, every run survives for one reason and it is not this one.
   */
  liveRunIds: string[];
  actions: RetentionAction[];
  removed: number;
  /**
   * Planned paths whose removal THREW — a filesystem error, never the fence.
   *
   * Separated from `removed` because the two numbers do not subtract into
   * anything true otherwise: every caller that wanted "how many did not go"
   * computed `planned - removed` and called the answer a refusal, which on this
   * path names a remedy (answer the consent question) that cannot help.
   *
   * A throw is also the one outcome where `removed` UNDERSTATES what happened.
   * `rmSync` is recursive and destroys entries until it meets one it cannot
   * remove, then abandons the rest — so a throw leaves a PREFIX of the tree's
   * iteration order already gone. RE-MEASURED on a whole-root action over a
   * leaked root holding `.one.json`, `debug` (mode 0o111) and `runs`, identically
   * on node 22 and node 26: iteration order `[.one.json, debug, runs]`, EACCES
   * from `scandir` on `debug`, `before [.one.json, debug, runs] → after [debug,
   * runs]`, `removed: 0`. The state file was gone; the run history survived only
   * because it sorted behind the entry that threw. This block used to read "node
   * absorbed the child's EACCES, removed the other two entries, and threw
   * ENOTEMPTY on the root" — it stops AT the child, and which siblings die is the
   * filesystem's iteration order rather than anything this sweep decides, so no
   * caller may be told which. So this count means "one planned path is still
   * there and an unknown amount of what was inside it is not", and the per-path
   * notice carrying the errno is raised for exactly that reason.
   */
  failed: number;
  /**
   * The standing anomalies this sweep met, verbatim — a state file that will not
   * parse, a leaked root that cannot be listed, a leaked root reduced rather than
   * healed, an artefact whose age no clock can establish — one entry per
   * condition, in the order they were found.
   *
   * They are RETURNED as well as written to stderr because stderr is not a user
   * surface on the hosts this runs on: the full sweep's one scheduled caller is a
   * SessionStart hook that exits 0, and nothing shows a user its stderr. Every
   * one of these conditions suspends or reduces reclamation until the USER acts,
   * so a channel that reaches nobody is a remedy path that does not exist — see
   * announceSuspension and retentionAdvisory.
   *
   * ── THE CENSUS, because the reason stderr used to give for staying was FALSE ─
   * It read "the two per-tool-call callers (`pruneTrafficOneBackups`, the
   * page-speed sweep) compose no banner and legitimately need it". The page-speed
   * sweep composes one: modules/page-speed/handler.ts calls this sweep and
   * returns `context(...)` in the same branch. A user-visible surface existed
   * exactly where that sentence said none did. Verified caller by caller, the
   * question being STRUCTURAL — which callers CAN carry this. And it is worth
   * saying what THREE rounds of this census have now shown: every time a row
   * here has claimed a caller structurally cannot reach a user, the claim has
   * been false one or two call levels further out. So a row that declines is a
   * row that says what it is declining and what it costs, never one that denies
   * the surface exists.
   *
   *   session/session-start.ts    CAN, and does — retentionAdvisory onto the
   *                               advisory list. The only one that did.
   *   page-speed/handler.ts       CAN — it composes a banner. Now carries the
   *                               advisory on the branch that has one.
   *   runners/traffic-one-cleanup CAN — a CLI with stdout. It printed notices
   *                               only under `--json`, so a suspended project
   *                               read "0 candidate(s), 0 removed", which is a
   *                               clean bill of health for an unbounded
   *                               condition. Now printed in both modes.
   *   sweepAfterTerminalSettlement COULD NOT UNTIL THE TYPE CHANGED —
   *                               TerminalSweepReport dropped the field, so
   *                               neither caller (runners/run-status,
   *                               materialize/build-complete)
   *                               could propagate it if it wanted to. The report
   *                               now carries it; run-status surfaces it,
   *                               build-complete DECLINES it — that path CAN
   *                               reach a user (session/prompt-submit returns
   *                               `context(...)` on every exit below the call
   *                               site, post-stack-setup composes it at six),
   *                               and the cost of two widened return types is
   *                               declined at its call site rather than the
   *                               surface denied. Round 4 asserted the
   *                               inability; that was this census's own
   *                               falsehood a third time.
   *   pruneTrafficOneBackups      CARRIES its own, and DECLINES the last hop. It
   *                               now returns BackupPruneResult — removed,
   *                               failed, notices — because the argument for
   *                               folding a throw into silence here ("the
   *                               disclosure exists, one SessionStart later")
   *                               composes with a suspended policy into no
   *                               disclosure at all: `backupKeep` at
   *                               MAX_SAFE_INTEGER never re-plans the path that
   *                               failed. What is still declined is the last hop
   *                               to a user: backupConflicts
   *                               (runners/gitnexus/bootstrap-env:179) discards the
   *                               result inside a best-effort try/catch, and
   *                               reaching modules/graphify/post-build.ts's
   *                               `context(...)` means widening `Backups` and
   *                               bootstrap()'s return type on a path whose
   *                               question is "is the code graph built". The
   *                               surface exists, four levels up, and is named
   *                               rather than denied — the difference from the
   *                               old row is that the channel no longer stops at
   *                               this signature, so adopting it is a change in
   *                               ONE caller.
   *
   * That is why the disclosure channel is a correctness question here rather than
   * a presentation one: SUSPENSION IS UNBOUNDED GROWTH BY DESIGN (see
   * ILLEGIBLE_POLICY — 17.4 MB against 1.5 MB while reclaiming zero paths), and
   * the only bound is a user reading a notice and repairing a file. One caller in
   * five was the bound, and three of the other four are now surfaces rather than
   * impossibilities — two carrying, two declining for a stated cost.
   *
   * Independent of the once-per-process stderr dedupe, deliberately. A caller
   * asking "what is wrong with this project" must get the same answer whether or
   * not some earlier caller in this process already printed it.
   */
  notices: readonly string[];
}

// Tightened after the 12co audit: 5 retained runs held 113 files / 1.17 MB in
// `runs/` plus 9.5 MB of reports for a single settled run; backups were all
// byte-identical. One backup, three runs, and one Lighthouse pair per route
// cover every recovery path the runtime actually exercises.
const DEFAULT_POLICY: RetentionPolicy = {
  keepRuns: 3,
  backupKeep: 1,
  orphanTtlDays: 3,
  lighthouseKeepPerRoute: 1,
};

// ── THE PATHS THIS SWEEP'S OWN RULES NAME ────────────────────────────────────
// Spelled ONCE and read by BOTH consumers: the rules in collectActions that
// schedule them, and the leaked-root heal's recognition predicate
// (recogniseEntries). Two copies of this list is how the heal's idea of "what
// the runtime wrote" drifts away from what the sweep actually manages, and after
// the inversion that drift costs a deletion in one direction and a leftover in
// the other — so there is one list, and adding a rule extends recognition for
// free. "Free" is true of the RUNTIME and false of the PINS, and the difference
// is a footgun worth naming: a genuinely new two-segment rule reds two tests in
// materialized-entries.test.ts — the producer census, because nothing writes the
// path yet, and the authorityOver deepEqual for its parent. Both reds are
// correct, and both point the same way: land the writer with the rule. The
// cheapest green is to relax the census, and relaxing the census is the
// protection this lane keeps rebuilding, so it is the one repair that is wrong.
// The shared list is load-bearing and is not what the `reports` blocker
// broke: what broke was the FOLD applied to it on the way to the heal, and the
// fix keeps both consumers reading these same constants.
const LIGHTHOUSE_DIR = path.join('reports', 'lighthouse');
const RUN_SCOPED_DIRS: readonly string[] = ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')];
const ONCE_DIRS: readonly string[] = [path.join('runs', '.once'), '.once'];
const EPHEMERAL_LOCKS: readonly string[] = ['.codegraph-build-lock', '.opencode-heal-lock'];
// `logs` USED TO BE HERE, and nothing in the runtime has ever written it.
// MEASURED: `.traffic-one/logs` occurs nowhere in `src/` outside this table and
// two test fixtures that plant it themselves. It bought two deletion
// authorities over a generic name only a human could have created — the TTL
// rule below reclaims anything three days old inside it on EVERY project, and
// recognition let a leaked root holding it go in one whole-root action — and it
// bought them for a producer that does not exist. That is the `skills/` hazard
// with the mitigation absent, so it is gone rather than special-cased. If some
// future component starts writing there, its artefacts accumulate until it gets
// a rule here: a leftover, which is the direction this file fails in.
const TTL_ARTEFACT_DIRS: readonly string[] = [LIGHTHOUSE_DIR];
const DEBUG_DIR = 'debug';
const BACKUPS_DIR = 'backups';

// AN INPUT, NOT AN ARTEFACT, and it is deliberately outside the table above —
// which is why it is declared here rather than beside the paths
// RUNTIME_ENTRY_PATHS is derived from. Every path up there is one a RULE
// SCHEDULES; this is the file readPolicy READS, and no rule in this file has
// ever scheduled it. (That principle was true of every ROW and false of the
// derivation itself for three rounds — see RUNTIME_ENTRY_PATHS, where the fold
// that manufactured a name out of two scheduled paths is now gone and pinned.)
//
// IT USED TO BE IN THE RECOGNITION SET, and that was the `logs` shape with the
// authoring instruction added. Nothing in `src/` writes `retention.json` —
// readPolicy is its only reader and there is no writer at all — while a skill
// this product materializes into every project tells the user to author one:
// "Projects may override retention counts with `.traffic-one/retention.json`"
// (skills-catalog/senior-eng-orchestrator/SKILL.md). So the admission test
// recogniseEntries states ("does anything shipped tell a user to author
// something under this name?") answers YES here, uniquely among the names that
// were in the set, and the entry a leaked root holds under this name can only be
// the user's.
//
// MEASURED end to end through the apply sweep on a leaked `apps/web` root, with
// the name still recognised: a root holding `.one.json` plus a user's
// `retention.json` was planned as a single `<WHOLE ROOT>` action, 1 removed, the
// file destroyed and ZERO notices; with a `notes.md` beside them, 2 planned, 2
// removed, the file destroyed, and the ONE notice named `notes.md` — the file
// that survived. Worse than a bare loss twice over: the file is the
// configuration for THIS sweep, so losing it silently reverts to the stricter
// DEFAULT_POLICY and the next sweep reclaims MORE than the user asked for.
//
// WHAT SPARING IT COSTS, measured on the same fixture rather than assumed: the
// leaked root is REDUCED instead of emptied, so the user gets one REDUCED notice
// naming `retention.json` and a `.traffic-one` directory holding nothing but
// their own file. It is not a nag — the reduction still takes `.one.json`, which
// is what makes a directory a candidate (listNestedTrafficOneDirs), so sweeps 2
// and 3 plan nothing and say nothing. A leaked root holding ONLY this file and
// no `.one.json` is not a candidate in the first place.
const POLICY_FILE = 'retention.json';

// The two artefacts MATERIALIZATION writes into a state root that no rule here
// governs, so nothing above can supply them: `.traffic-one/manifest.json` and
// `.traffic-one/rules/**` (materialize/materialize.ts writes both; config/paths.ts
// records that both are COMMITTED, alongside `.one.json`). They are named here
// rather than imported because neither has an exported constant to import.
//
// Naming them is a WIDENING of deletion authority — which is the inverted list's
// only failure mode and the reason nothing else joins them casually. If
// materialization renames either one, this stops recognising the new name and
// the artefact is SPARED and reported: a leftover, never a loss. `skills/` and
// `agents/` are deliberately absent; see recogniseEntries.
//
// So is a THIRD top-level entry the same call chain can write, and it is absent
// on the strongest grounds of the three: materializeProjectAssets reaches
// render-agents' preserveManualRootContext, which writes
// `.traffic-one/AGENTS.local.md` (and `CLAUDE.local.md`) holding the user's
// hand-written root context, verbatim, as the only copy of it. The pin below
// does not see it because its fixture has no pre-existing root AGENTS.md to
// preserve; if a future fixture grows one, the answer is a leftover and not a
// row here.
//
// EXPORTED for one reason: this list is a claim ABOUT ANOTHER MODULE, and it was
// unpinned in both directions — nothing related it to what materialization
// actually writes, so a third entry would have become a silent leftover and a
// name materialization stopped writing would have silently kept deletion
// authority. __tests__/materialized-entries.test.ts runs the real writer against
// a real installed plugin root and compares its top-level output to this list.
export const MATERIALIZED_ENTRIES: readonly string[] = ['manifest.json', 'rules'];

// Every path above, AS THE RULES SPELL IT. This is the whole deletion authority
// of the leaked-root heal, and it is a list of PATHS rather than of names for a
// reason that cost a round: it used to end in
//
//   .map((rel) => rel.split(path.sep)[0]!)
//
// which truncated `reports/qa` and `reports/lighthouse` — the only two-segment
// paths in the table — to a bare `reports`, and a bare `reports` is deletion
// authority over the WHOLE directory. That name is not one this file's rules
// schedule; the fold MANUFACTURED it, and it was the only name the fold
// manufactured (`runs/.once` collapses onto `runs`, which RUN_SCOPED_DIRS
// already names, so no authority appeared there). The stated admission
// principle two comments up — every name here is one a RULE SCHEDULES — was
// therefore violated by the derivation itself rather than by any row.
//
// WHAT IT COST, measured end to end through the apply sweep on a leaked
// `apps/web` root: `reports/tokens-2026-08-11.md` (the archive
// token-usage-report/SKILL.md:105 tells the assistant to have the USER write,
// materialized into every project by SKILL_FILTERS._common) and
// `reports/security/report.json` (predeploy-security-check/SKILL.md:18,
// README.md:571) were BOTH destroyed by a single `<WHOLE ROOT>` action with
// ZERO notices; with a `notes.md` beside them the one notice named `notes.md`,
// the file that SURVIVED, while the destroyed archive went unmentioned. That is
// the mixed row this file's own docblock calls "worse served than by silence",
// reached through the derivation instead of through the content arm.
//
// So recognition is PATH-AWARE (see recogniseEntries): `reports/qa` and
// `reports/lighthouse` keep exactly the authority the rules give them, and
// `reports` as a bare entry has none of its own. Nothing is lost — those two
// subdirectories are precisely the QA and Lighthouse artefacts the heal was
// reclaiming — and no shipped instruction has to move.
//
// EXPORTED with MATERIALIZED_ENTRIES and for the same reason: a set no test
// could name was a set no test could review.
//
// WHAT THE PIN BUYS, stated exactly, because the sentence here used to overstate
// it. It read:
//
//   "The pin asserts the CONTENT of it, not just its size, so a name that joins
//    it has to be argued for in a test that already states the argument."
//
// It does not. The pin requires a new name to be TYPED TWICE — once here, once
// in the test's literal — with a comment beside it; it cannot check that the
// comment is true, which is exactly how a row citing a line rather than
// answering the question sat here for three rounds. MEASURED: adding `logs` to
// the constants above AND to that literal, in one commit, survived all five pin
// tests with both edited lines executed. What a diff in two files buys is a
// REVIEWER'S ATTENTION, which is worth having and is not an argument.
//
// Three checks are arguments, and they are what the table actually rests on:
//   - every recognised path must be one a rule here SCHEDULES, driven by
//     planting an artefact under it on an ORDINARY project (retention.test.ts).
//     This is the general property the truncation broke; a fabricated `reports`
//     fails it.
//   - every recognised path must be SPELLED UNDER A STATE ROOT somewhere in
//     `src/` outside this file, and the two names excluded for having no
//     producer (`logs`, `retention.json`) must still not be
//     (materialized-entries.test.ts). Spelled means one of two things and
//     nothing looser: the literal `.traffic-one/<path>` appears in a string, or
//     a `path.join`/`path.resolve` call has `.traffic-one` and then this path's
//     segments as consecutive arguments that resolve to literals. It used to be
//     satisfied by the bare quoted last segment anywhere in the tree, which is
//     a match on an English word: six plausible names the peer tried — `cache`,
//     `evidence`, `state`, `sessions`, `context`, `output` — were admitted with
//     nothing writing them at all.
//   - every recognised name must be ADMISSIBLE against the shipped corpus: no
//     document this product materializes may tell a human to author something
//     under it. Searched over the whole emitted bundle for the path beside an
//     authoring verb, which is the check that fails `retention.json` — and
//     which used to be six hand-written regexes over six named files while the
//     claim beside it said the census was pinned file by file.
// A row whose only support is its own comment has the weakest kind there is.
export const RUNTIME_ENTRY_PATHS: readonly string[] = [
  path.basename(STATE_FILE),
  DEBUG_DIR,
  BACKUPS_DIR,
  ...RUN_SCOPED_DIRS,
  ...ONCE_DIRS,
  ...EPHEMERAL_LOCKS,
  ...TTL_ARTEFACT_DIRS,
  ...MATERIALIZED_ENTRIES,
];

/**
 * One scheduled path, as a node in the recognition trie.
 *
 * `whole` is the authority: the rules name THIS path, so the heal may take the
 * entry outright, with whatever is inside it. A node that is only a `children`
 * branch — `reports`, and nothing else today — carries no authority at all: it
 * exists solely to be descended through.
 */
interface RecognitionNode {
  whole: boolean;
  readonly children: Map<string, RecognitionNode>;
}

function recognitionTrie(paths: readonly string[]): RecognitionNode {
  const root: RecognitionNode = { whole: false, children: new Map() };
  for (const rel of paths) {
    let node = root;
    for (const segment of rel.split(path.sep)) {
      let next = node.children.get(segment);
      if (!next) {
        next = { whole: false, children: new Map() };
        node.children.set(segment, next);
      }
      node = next;
    }
    node.whole = true;
  }
  return root;
}

const RECOGNITION = recognitionTrie(RUNTIME_ENTRY_PATHS);

// What the sweep obeys when it cannot read a file a cap is derived from. Each
// field in RetentionPolicy is a KEEP count or a KEEP window, so "we could not
// tell what you asked us to keep" has one conservative answer where the answer
// is affordable: keep everything that cap governs.
//
// WHICH caps, though, is a per-INPUT question, and answering it per-FILE was
// the leak. Two files feed the four numbers and they do not feed the same ones:
//
//   `.traffic-one/retention.json` — every cap. keepRuns, backupKeep,
//     orphanTtlDays, lighthouseKeepPerRoute are all written here and nowhere
//     else.
//   `.traffic-one/.one.json` — `currentRunId`, which is RESERVED outside the
//     newest-N budget, so losing it to a parse failure narrows that window by
//     one and evicts a run the legible file protected. It says nothing about
//     backups and nothing about Lighthouse.
//
// So an illegible `.one.json` costs the RUN caps and must cost nothing else.
// Suspending all four on it was a leak measured in megabytes: on five backups
// under `backupKeep: 1`, a corrupt `.one.json` took `pruneTrafficOneBackups`
// from "removed 4, 1 left" to "removed 0, 5 left"; on six Lighthouse pairs
// under `lighthouseKeepPerRoute: 1` it took the reports dir from 1.27 MB to
// 7.62 MB. Both of those rules fire on a per-tool-call path (gitnexus bootstrap
// and the page-speed hook), not at SessionStart, so the growth is per command.
//
// An illegible retention.json therefore still turns off ALL FOUR, and that half
// is unchanged. MEASURED on a tree whose retention.json asked for keepRuns 5 /
// backupKeep 3 / a 10-year TTL, replacing that file with git conflict markers
// took the plan from 1 deletion to 5 — two runs and two backups the user had
// explicitly asked to keep, reclaimed BECAUSE the file that said so would not
// parse. That is the whole defect, and it applies to `backupKeep` exactly as it
// does to `keepRuns`: the numbers are gone, and substituting the built-in ones
// deletes what the user asked to keep. The property test in __tests__ states it
// once for the whole sweep — degrading a state file may SHRINK a plan and must
// never GROW one — and exempting the two "floored" rules from the suspension
// breaks it for real (tried, measured, reverted: the fixture's fourth backup
// became a new deletion).
//
// It does NOT follow that an illegible `.one.json` should cost them, and that
// was the leak. Falling back to DEFAULT_POLICY is right for an ABSENT file —
// the ordinary case, and it legibly means "no preference recorded" — and only
// `corrupt` and `unreadable` reach either suspension.
//
// A suspension is one only the user can lift: nothing in this file rewrites or
// reclaims either input, so a corrupt one stays corrupt and the caps it feeds
// stay off until it parses again. That is why it is ANNOUNCED rather than left
// to be met as unexplained growth — fail-open, not fail-silent, the rule
// reportSweepAnomaly already follows below.
//
// The whole trade rests on that announcement, so it does not ride hook stderr
// alone. It is also RETURNED (RetentionResult.notices, retentionAdvisory) for the
// caller to put on a user-visible surface, because a SessionStart hook that exits
// 0 shows its stderr to nobody on the hosts we target — an unbounded condition
// disclosed only there is an unbounded condition with no user-visible cause.
//
// HOW FAR CAN THAT GROW BEFORE IT HURTS? Two different questions.
//
// DISK, MEASURED on an 8-run tree of the observed 12co shape (240 KB a run,
// three Lighthouse pairs, five backups), against a legible sweep that reclaims
// 4.01 MB of it:
//   - illegible `.one.json`: 2.63 MB still reclaimed, 1.38 MB residual — run
//     history only, ~172 KB per retained run, so a session minting a run every
//     ten minutes accrues about 1 MB an hour. Before the split this residual
//     was the whole 4.01 MB and it grew per TOOL CALL rather than per run,
//     because `pruneTrafficOneBackups` and the page-speed sweep are the two
//     callers on that path: 1.3 MB per Lighthouse report pair, one pair per
//     `lighthouse` command.
//   - illegible `retention.json`: the full 4.01 MB residual, unchanged and
//     deliberately so. One file, one repair, and the announcement below names
//     it and the command.
//
// A per-pass residual is a SNAPSHOT, and a snapshot of this invites "that is
// small". The number that decides the trade is the SLOPE: replay one session's
// worth of growth onto the same tree and the suspended sweep is holding 17.4 MB
// where the legible sweep holds 1.5 MB, and it reclaims ZERO paths doing it —
// nothing in the suspended plan ever catches up, because every cap that would
// have is off. Disclosure is what makes that acceptable, which is why the channel
// it rides is a correctness question and not a presentation one.
//
// LATENCY: claim resolution enumerates every run on disk per tool call, ~0.019
// ms per run (0.16 ms p95 at 3 runs, 2.60 ms at 100, 24.29 ms at 1,000), so it
// reaches this repo's 150 ms p95 pre-tool budget somewhere past 6,000 runs. The
// sweep itself was the nearer cliff and is answered directly rather than
// tolerated: see collectActions.
const ILLEGIBLE_POLICY: RetentionPolicy = {
  keepRuns: Number.MAX_SAFE_INTEGER,
  backupKeep: Number.MAX_SAFE_INTEGER,
  orphanTtlDays: Number.MAX_SAFE_INTEGER,
  lighthouseKeepPerRoute: Number.MAX_SAFE_INTEGER,
};

/**
 * The caps `.one.json` feeds, and only those. `currentRunId` is an input to the
 * newest-N window and to the orphan TTL's exemption list; it is an input to
 * nothing else, so nothing else goes off with it.
 */
function suspendRunCaps(policy: RetentionPolicy): RetentionPolicy {
  return {
    ...policy,
    keepRuns: Number.MAX_SAFE_INTEGER,
    orphanTtlDays: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * A filesystem-supplied path rendered for a COMMAND a notice asks someone to run,
 * or `null` when there is no such rendering — in which case the caller says what
 * to do in prose and offers no command at all.
 *
 * ── TWO QUESTIONS, IN ONE ORDER, IN ONE PLACE ────────────────────────────────
 * Every path in this file comes off a disk this runtime does not own (that is the
 * premise of the leaked-root rule: `.traffic-one/` is COMMITTED state, so cloning
 * a repository is the delivery path), and two of these notices ask for a shell
 * command. So the path is asked about twice:
 *
 *   PROSE first — agentVisiblePath, for the line and marker grammar the notice
 *     rides on. It has to be first: quoting the raw path would lose that
 *     protection, since a newline in a directory name breaks the notice's line
 *     structure whatever the shell thinks of it.
 *   SHELL second — shellQuote (shared/shell-quote.ts), the POSIX idiom, which
 *     produces its OWN surrounding quotes.
 *
 * THE QUOTES USED TO BE HAND-WRITTEN in announceSuspension, and that was the
 * defect: a single quote anywhere in an ancestor directory name closed them and
 * the rest was a command. `/Users/x/Bob's projects/app` is an ordinary macOS path
 * and produced an unbalanced-quote `rm` that errors; `…/pkg'; rm -rf ~; echo '…`
 * is the same hole aimed deliberately, and it produced a complete, valid command
 * that removes the user's home directory. The comment beside it asserted the
 * opposite in two clauses — that a name agentVisiblePath redacts "also stops
 * being a quote a reader could be walked out of", and that a redacted command
 * "fails harmlessly" — and the first was simply false: nothing in
 * agent-visible-name.ts refuses `'`, and nothing there should. It is a
 * prose-safety leaf, and folding shell semantics into it would make every
 * notice's rendering depend on whether some unrelated caller interpolates into a
 * shell.
 *
 * AND `null` WHEN ANYTHING WAS REDACTED, which is what makes the second clause
 * true by construction instead of by assertion. A redaction replaces a segment
 * with a placeholder, so the result is not the path any more: a command built out
 * of one either fails or names a DIFFERENT file, and for an `rm` a sentence is
 * strictly better than either. The test is "nothing was redacted" rather than
 * "the whole path collapsed to the placeholder" — a partially redacted path is
 * just as much not-the-path, and the notice's own first line already names the
 * file as far as it can be named.
 *
 * AND `null` ON A BACKTICK, which is a THIRD question this census used to skip —
 * see the markdown column below. A backtick is shell-safe inside the single
 * quotes shellQuote emits, so the row above says nothing about it, and it is the
 * one metacharacter that is also the DELIMITER THE COMMAND IS WRAPPED IN. It was
 * not turned into an injection (every truncation of these paths lands on a
 * directory prefix and `rm -f` refuses a directory), so this is a broken
 * DISCLOSURE rather than a hole: the reader who copies "the command" out of
 * `run \`rm -f '…/say "$HOME" & ` + '`id`' + ` $(id)/.traffic-one/retention.json'\``
 * gets an unbalanced quote. It costs nothing measurable to refuse — 0 of
 * 1,225,599 real entry BASENAMES on this machine's home tree carry a backtick,
 * and the unit matters for every figure in this docblock: these are per-basename
 * counts, because a basename is what a leftover LINE carries. The same corpus
 * counted per PATH gives different numbers for the same characters (157 `*`,
 * 706,807 `_` against the 78 and 363,394 below), and a figure whose unit is
 * unstated is two claims — see the reduced-notice column, which is the one place
 * a path rather than a name is rendered — and
 * the prose remedy the `null` arm already offers is a better answer than a
 * command that does not survive being copied.
 *
 * ── THE OTHER PLACES A FILESYSTEM VALUE MEETS A READER HERE, censused rather
 * than one address fixed ─────────────────────────────────────────────────────
 * TWO QUESTIONS PER SITE, because this census only ever asked the first one: is
 * there a COMMAND here (can the value become shell syntax), and does the value
 * land inside a MARKDOWN SPAN (can it cross a delimiter). The second question is
 * one question asked at three sites and it had no answer at any of them.
 *
 *   announceSuspension     — `rm -f <path>`, the defect above. Uses this.
 *     MARKDOWN: the command is inside a code span, so the value's delimiter is
 *     the backtick. Closed by construction — the backtick rule above means such
 *     a path gets no command at all.
 *   announceUnagedArtefacts — lists paths and asks for `touch`/`chmod` ON them,
 *     so the list is composed with this too: the paths are what the reader would
 *     paste after the verb.
 *     MARKDOWN: the paths sit on their own lines, not inside a span, but the
 *     prose around them carries `touch` and `chmod u+rx` in spans of their own, so
 *     a listed path holding a backtick would open one that runs into the remedy.
 *     Closed the same way: a path this function refuses is COUNTED in prose and
 *     never rendered into the list, which is also why the list no longer carries a
 *     bare `<unnameable>` for the reader to paste after `touch`.
 *   announceReducedRoot    — wraps each leftover NAME in `'…'`, and those are
 *     prose delimiters in a notice that offers no command and tells the user
 *     nothing will be deleted. Deliberately NOT shell-quoted: `'Bob'\''s notes'`
 *     is a worse rendering of a filename and buys no safety where there is no
 *     command.
 *     MARKDOWN: this is the one site with a RESIDUE rather than an answer, and it
 *     is recorded rather than closed. Single quotes are not markdown delimiters,
 *     and the LIST STRUCTURE is no longer forgeable (one leftover per line, see
 *     announceReducedRoot). What remains is that two leftover names carrying the
 *     same PAIRED INLINE DELIMITER can span the text between them — and this is
 *     wider than the backtick the minor was filed about, which is the reason it is
 *     recorded here as a class instead of patched as a character. Over the same
 *     1,225,599-BASENAME corpus (the unit stated at the backtick figure above): 0
 *     names carry a backtick, 0 carry a single quote, 78 carry `*` and 363,394
 *     carry `_` — so the emphasis delimiters are not hypothetical, they are in
 *     29.7% of ordinary filenames, and refusing them in a PROSE leaf is not on the
 *     table. What the residue cannot do bounds it: it cannot change the count, add
 *     a line, or hide a name FROM A PLAIN-TEXT READER, because the names ARE the
 *     delimiters and a delimiter that renders is still read.
 *     THAT LAST CLAUSE IS NARROWER THAN IT WAS, and the version it replaces
 *     ("cannot hide a name", unqualified) was false for exactly one reader. `<span
 *     hidden>` and `<div hidden>` are legal filenames and this leaf ADMITS them —
 *     only `<!--` and `-->` are refused — so an HTML-TOLERANT renderer handed the
 *     notice can swallow every name after such a leftover, and the remedy
 *     paragraph with it. The leaf is deliberately NOT widened for it: refusing `<`
 *     or a tag-shaped substring would redact ordinary names (`a<b>c.md` is in the
 *     admitted rows of the suite), and no reader we ship renders HTML — the four in
 *     the leaf's census are an LLM, a terminal, a JSON consumer and a markdown
 *     renderer, and markdown-with-raw-HTML is the tolerant case this sentence now
 *     scopes itself out of instead of claiming immunity from. Sanitizing HTML in a
 *     retention notice is the wrong layer for it; a claim narrow enough to be true
 *     is the fix available here. How a given renderer treats the emphasis pair is
 *     likewise not measured — nothing in this repo renders markdown, and the
 *     notice's own structure no longer depends on the answer.
 *   leakedRootActions, announceIllegibleNestedRoot, the per-path errno notice —
 *     name a path and mention `chmod u+rx` / `chmod -R u+rwX` / `ls -a` with NO
 *     argument, so nothing composes into a command; they stop at
 *     agentVisiblePath, which is the whole of what they need.
 *     MARKDOWN: same residue as the reduced notice and smaller — one path rather
 *     than a list, so there is no second value for a backtick to pair with.
 */
function agentRunnablePath(file: string): string | null {
  const rendered = agentVisiblePath(file);
  if (rendered !== file || file.includes('`')) return null;
  return shellQuote(rendered);
}

/**
 * The suspension above is indefinite and only the user can lift it, which makes
 * this line the entire remedy path. So it carries the whole of it: which file,
 * what is wrong with it, the single next action executable verbatim, and what
 * comes back once they have done it.
 *
 * The action DIFFERS by file, and the wrong one is expensive. `retention.json`
 * holds preferences and nothing else, so removing it is a legitimate way out —
 * an absent file legibly means DEFAULT_POLICY, which is where a project that
 * never wrote one already lives. `.one.json` is the project's identity, so the
 * same advice there would trade a stalled sweep for a lost project.
 *
 * `.traffic-one/` is a COMMITTED tree, so `rm -f` alone is not always the end of
 * it: an untracked file stays gone, a tracked one comes back on the next
 * checkout and the suspension with it. The line says so rather than leaving the
 * user to discover it a branch switch later.
 *
 * An EMPTY file is `corrupt` (readJsonResult reads a null value as corrupt, and
 * zero bytes is the signature of an O_TRUNC open that never got its write), so
 * `touch retention.json` or one torn write suspends the caps just as conflict
 * markers do. "Does not parse" is a confusing thing to read about a file with
 * nothing in it, so that case says what it actually is.
 *
 * AND THE ACTION IS SOMETIMES THAT THERE IS NO ACTION, which is the one shape
 * this docblock used to leave out. A TRANSIENT errno (TRANSIENT_READ_ERRNOS) is
 * ignorance about the read rather than a fact about the file, so the notice
 * announces the suspension and offers NO remedy at all — least of all an `rm` for
 * a file that is very probably byte-perfect.
 *
 * AND SOMETIMES THE ACTION IS THE ONE THE DURABLE ARM FORBIDS. When what is at the
 * path is not a file (NOT_A_FILE_ERRNO), "repair its JSON — do NOT remove it, it
 * carries this project's mode, currentRunId and onboarding stamps" is false in
 * every clause and forbids the only correct action. Third arm, one condition each;
 * see nonRegularRead.
 *
 * The SCOPE differs by file too, and saying so is not a detail: a user who
 * reads "every retention cap is off" about `.one.json` will go looking for the
 * backup preference they never wrote there.
 *
 * It is a remedy path only if it REACHES someone, which is why `notices` exists:
 * the line goes to hook stderr, and a SessionStart hook that exits 0 does not put
 * stderr in front of anyone on the hosts we target. See RetentionResult.notices.
 */
/**
 * Read failures that say NOTHING about the file, and everything about this
 * process's moment: descriptor exhaustion (EMFILE for this process, ENFILE for
 * the host table), a non-blocking read that would block, and an interrupted
 * syscall. All four are RETRYABLE, and the next sweep is the retry.
 *
 * THE DEFECT THEY CLOSE, reproduced rather than argued: under descriptor
 * exhaustion (61,417 held descriptors) a BYTE-PERFECT `retention.json` reads as
 * `unreadable` with EMFILE, and the notice announced SUSPENDED plus
 * ``run `rm -f '<path>/retention.json'` `` — a destructive remedy for a condition
 * that is transient and not the user's doing, reaching an LLM through
 * retentionAdvisory and session-start. This file already learned the general
 * lesson one function over: descendRecognition treats a failed syscall as
 * IGNORANCE rather than as an answer about the tree, and P3 of the previous round
 * built `Unenumerable` so ignorance one level down could not be spent as a
 * durable verdict. This sibling read was still folding ignorance into a durable
 * suspension AND handing it an `rm`.
 *
 * The suspension itself STAYS, and that is not a compromise: the caps are derived
 * from a file this sweep could not read, so keeping everything is the same
 * conservative answer it gives a corrupt one. What goes is the removal.
 *
 * TWO SITES CONSULT IT NOW, and for one round exactly one did — while the
 * docblock two paragraphs up cross-referenced the other one BY NAME as the place
 * this file had already learned the lesson. announceIllegibleNestedRoot, 350
 * lines down, built its `problem` string from the same read kind and then
 * appended an UNCONDITIONAL remedy: "Repair its JSON — do NOT remove it… If the
 * directory is a leftover you do not want, remove it yourself; nothing here
 * will." MEASURED through the real sweep with the ONE OPEN of a
 * nested `.one.json` answering EMFILE over 28 byte-perfect bytes: the notice
 * asked the reader to repair a file that parses and offered to have the
 * directory removed by hand, with no "retryable" anywhere in it, and EACCES
 * produced byte-identical text — so the two were indistinguishable in the
 * direction that matters. Same defect, same constant, one arm.
 */
const TRANSIENT_READ_ERRNOS: readonly string[] = ['EMFILE', 'ENFILE', 'EAGAIN', 'EINTR'];

/**
 * What a transient errno licenses instead of a remedy: NOTHING, said out loud.
 *
 * Spelled once and read by both sites, because they are one sentence about one
 * condition and two copies of it are two things to keep true. The `notices`
 * census one file over makes the same argument about the stderr and returned
 * copies of a notice; this is that argument applied to two callers.
 */
const TRANSIENT_REMEDY = 'That errno is about THIS PROCESS, not about the file: it is retryable, so there is'
  + ' nothing here to repair and nothing to remove. The usual cause is a coding-agent process holding many open'
  + ' descriptors (EMFILE/ENFILE) or a read that was interrupted, and the next sweep is the retry.';

/** Is this read IGNORANCE about a moment rather than a fact about the file? */
function transientRead(read: JsonRead<unknown>): boolean {
  return read.kind === 'unreadable' && TRANSIENT_READ_ERRNOS.includes(read.errno);
}

/**
 * The THIRD arm, and the one whose absence made both remedies below actively
 * wrong: what is at the path is NOT A FILE.
 *
 * A bounded read (shared/bounded-read.ts) classifies a FIFO, a device or a socket
 * from the descriptor without reading a byte and reports this errno — prose no
 * kernel produces, so an operator can tell our refusal from the filesystem's. It
 * arrives here through readJsonResult exactly as EACCES does, and BOTH notices
 * then composed a durable remedy that is false about it, verbatim: "Repair its
 * JSON — do NOT remove it, it carries this project's mode, currentRunId and
 * onboarding stamps". A FIFO carries none of those things, there is no JSON to
 * repair, and REMOVAL — the only correct action — is the one thing the sentence
 * forbids. This reaches an LLM through retentionAdvisory and SessionStart, which
 * is the same delivery path and the same defect class TRANSIENT_READ_ERRNOS closed
 * for EMFILE: a read outcome that is not a fact about broken CONTENT being handed
 * the broken-content remedy.
 *
 * THE SPELLING IS NAMED HERE AND NOT IMPORTED, deliberately: it is module-private
 * in bounded-read.ts, and reaching for an export would couple this file's notices
 * to that module's internals. What keeps the two in step is a BEHAVIOURAL pin
 * rather than a source-text comparison — __tests__/retention.test.ts drives a real
 * FIFO at `.one.json` through the product read path and requires the notice to
 * prescribe removal and not to forbid it — so a spelling drift reds instead of
 * silently reverting the advice to the wrong one, which is precisely what a
 * string comparison against the other file could not do.
 */
const NOT_A_FILE_ERRNO = 'not-a-regular-file';

/** Is there something at this path that is not a file at all? */
function nonRegularRead(read: JsonRead<unknown>): boolean {
  return read.kind === 'unreadable' && read.errno === NOT_A_FILE_ERRNO;
}

/**
 * What a non-file licenses: REMOVAL, and nothing else — the opposite of what both
 * sites said before.
 *
 * Spelled once and read by both, for the reason TRANSIENT_REMEDY is: one condition,
 * one sentence, and two copies of it are two things to keep true. It names no path
 * itself, because the two callers differ on what the path IS (a policy file, a
 * project's identity, a nested project's identity) and each already renders its own.
 */
function notAFileRemedy(removal: string): string {
  return 'What is at that path is NOT A FILE at all — a FIFO, a device or a socket — so there are no JSON bytes to'
    + ` repair and nothing there carries any project state: ${removal}. The read is refused from the descriptor`
    + ' before a byte is taken, so nothing is being read out from under a writer, and the runtime writes a real'
    + ' file in its place.';
}

/**
 * WHERE A SECOND COPY OF THE POINTER'S BYTES ACTUALLY IS — the clause the durable
 * remedy below got wrong for every round it has shipped.
 *
 * It read: "(a backup may exist under `<…>/.traffic-one/backups/`)". Nothing puts a
 * state pointer there, by any path. The ONLY writer of that directory is the
 * gitnexus bootstrap (runners/gitnexus/bootstrap-env.ts `backupConflicts`), it
 * copies exactly CONFLICT_PATHS — `AGENTS.md`, `CLAUDE.md`, `.claude/skills`
 * (config/gitnexus.ts) — and all three live OUTSIDE `.traffic-one`. MEASURED
 * (CLAIM1) on a project carrying all three beside a state root: the snapshot
 * tree is those three paths and nothing else, twice.
 * So the one sentence in this notice offering help sent the reader to a directory
 * that cannot hold what they were sent for, and — this being a retention notice —
 * said it to an LLM through retentionAdvisory and SessionStart.
 *
 * The copies that DO exist are named instead, each conditioned on what makes it
 * true:
 *
 *   THE QUARANTINE SIBLING, AND ONLY WHEN IT IS THERE. state/normalize.ts's
 *     `statePreservedBeforeReplace` writes `<state file>.corrupt` with the bytes
 *     that failed to parse — but only from writeState's REPLACEMENT path, which
 *     heals the pointer immediately afterwards. So it is not a promise this notice
 *     may make about the state it is describing: MEASURED (CLAIM2, NOTICE) on a
 *     corrupt pointer nothing has replaced yet, the sibling is absent, and the
 *     `unreadable` arms never produce one at all — bytes nobody could read are
 *     bytes nobody could copy. The filesystem is asked, per notice, for that
 *     reason. What it holds is therefore the LAST unparseable pointer a state write
 *     moved aside, which may be older than what is at the path now.
 *     THE SPELLING IS NAMED HERE AND NOT IMPORTED, for the reason NOT_A_FILE_ERRNO
 *     is: it is module-private there, and reaching for an export would couple this
 *     notice to that module's internals. What keeps the two in step is a
 *     BEHAVIOURAL pin — __tests__/retention.test.ts drives the real writeState over
 *     a torn pointer and requires this notice to name the file it left behind — so
 *     a spelling drift reds instead of silently dropping the clause.
 *   GIT, because the pointer is committed BY DESIGN: `.one.json` is not in the
 *     generated `.gitignore`, whose `.traffic-one` lines are `runs/`, `reports/`,
 *     `backups/`, `debug/` and `one-mcp-report.json`
 *     (architecture-contract/scaffold-content.ts, config/paths.ts). MEASURED
 *     (CLAIM3) on a fixture through `ensureProjectGitignore`: `git check-ignore`
 *     says the pointer is NOT ignored and `git add -A` stages it, while
 *     `backups/x` IS ignored — so the directory the old clause named is not even in
 *     the tree it was pointing the reader at. Conditioned on "has committed it",
 *     because this sweep runs no git and cannot answer for a project's history.
 *
 * AND EACH ROUTE NAMES ITS ACTOR, to stay consistent with state/state-loss.ts's
 * `recoveryClause`, the other notice on this channel about this same file:
 * rewriting the pointer is the AGENT's route (the write fence exempts this exact
 * path, which is what makes "Repair its JSON" executable at all) and reading
 * HEAD's copy is permitted, while restoring the state directory from git is
 * refused for an agent even on a healthy project. That notice fires for an ABSENT
 * or BLANK pointer and deliberately NOT for unparseable bytes (state-loss.ts,
 * `pointerLoss`), so the two never print together — which is exactly why the
 * division of powers must not be stated two ways.
 *
 * NO COMMAND IS PRINTED. A `git show` or `git restore` would be a verb with no
 * probe behind it, and this file's rule is that a printed command has been asked
 * whether it would run (REMEDY_PROBE). A path the reader can open is worth more
 * here than a command this sweep cannot answer for.
 */
const CORRUPT_POINTER_SUFFIX = '.corrupt';

function pointerCopies(file: string): string {
  const quarantine = `${file}${CORRUPT_POINTER_SUFFIX}`;
  const preserved = pathReachableBy(quarantine, false)
    ? ' The bytes a state write last moved aside for not parsing are on disk beside it, at'
      + ` ${agentVisiblePath(quarantine)} — nothing in the runtime reads that file, and being repaired FROM is`
      + ' what it is kept for.'
    : '';
  return `${preserved} Git has this file too: \`${STATE_FILE}\` is committed by design, so a project that has`
    + ' committed it has a copy at HEAD that parses. Reading that copy and rewriting this one are the AGENT\'s'
    + ' routes — the write fence exempts this exact path. Restoring the state directory from git is NOT one of'
    + ' them: that is refused for an agent even on a healthy project, and it belongs to the user, in their own'
    + ' terminal.';
}

/**
 * THE SAME DEFECT AT THE SECOND SITE, and it was found by the same instrument in
 * the same arm: a remedy naming a path the user cannot act on.
 *
 * `rm -f <file>` and "repair its JSON" are both actions ON THE FILE, and a read
 * that failed EACCES may have failed because of a DIRECTORY above it, in which case
 * neither is executable. MEASURED at `.traffic-one` 0o000: three commands
 * printed across the three notices, and all three failed — the two chmods the
 * RETAINED notice printed (the blocker) and this notice's
 * `rm -f <…>/retention.json`, "Permission denied". So the file-shaped remedy
 * is conditional on the file being reachable, and the condition is measurable.
 *
 * It reuses blameDirectory rather than repeating the walk, which is the same
 * argument TRANSIENT_REMEDY makes about two callers of one sentence: two copies of
 * a derivation are two things to keep true.
 */
function announceSuspension(
  file: string,
  read: JsonRead<unknown>,
  isPolicyFile: boolean,
  projectDir: string,
  notices?: string[],
): void {
  const problem = read.kind === 'unreadable'
    ? `cannot be read (${read.errno})`
    : read.kind === 'corrupt' && !read.text.trim()
      ? 'is empty, which does not parse'
      : 'does not parse';
  const scope = isPolicyFile
    ? 'every retention cap is off'
    : 'the run-history caps are off (the backup and Lighthouse caps are unaffected — neither number lives here)';
  // ── THE REMOVAL WAS OFFERED WHENEVER THE PATH COULD BE SPELLED ──────────────
  // MEASURED with `.traffic-one` at 0o555 and a corrupt `retention.json` (arm B,
  // load 3.35): an `lstat` of the FILE succeeds, so the nameability gate
  // this round-16 arm added answered TRUE, and the notice printed
  // `rm -f '<…>/retention.json'` — which FAILS "Permission denied", because
  // `unlink` needs the write bit on the DIRECTORY and 0o555 does not carry it. The
  // notice came back byte-identical. That is the "prints a command that cannot be
  // run" class at an ordinary mode bit on the parent, which is the axis round 16
  // reported exhaustively varied; it is now asked of the kernel per verb, and the
  // REPAIR half of this remedy is unaffected — editing the bytes of a writable file
  // inside a read-only directory works, and only the removal does not.
  const removalCommand = agentRunnableCommand('rm -f', file);
  const removal = removalCommand
    ? `run \`${removalCommand}\``
    : agentRunnablePath(file) === null
      ? 'remove that file yourself — its own name cannot be spoken in this notice, so no command here could name'
        + ' the right file, and this one is an `rm`'
      : 'remove that file yourself once you can — this sweep asked whether that entry could be removed and was'
        + ' refused, so an `rm` printed here would fail rather than help';
  const durable = isPolicyFile
    ? `Repair its JSON, or ${removal} — it holds preferences only, and an absent one means the`
      + ` built-in policy (keep ${DEFAULT_POLICY.keepRuns} runs, ${DEFAULT_POLICY.backupKeep} backup,`
      + ` ${DEFAULT_POLICY.orphanTtlDays}-day TTL). If it is tracked in git, commit the removal too, or the`
      + ' next checkout restores it.'
    : `Repair its JSON — do NOT remove it, it carries this project's mode, currentRunId and onboarding stamps.`
      + pointerCopies(file);
  // A read refused by a mode bit may have been refused by a mode bit on a
  // DIRECTORY, and then no action on the file is available to the reader: the
  // remedy is the one directory whose own access fails, walked to rather than
  // guessed at. Asked only for the errnos that can mean it, so a corrupt file pays
  // no syscalls for the discrimination.
  //
  // ── AND A MODE BIT IS NOT THE ONLY WAY THE FILE STOPS BEING NAMEABLE ────────
  // The condition used to be exactly MODE_BIT_ERRNOS, which is the set of ways a
  // DIRECTORY refuses a reader — and says nothing about a directory that is not a
  // directory. MEASURED with `.traffic-one` itself a regular FILE and again as a
  // symlink LOOP: the read fails ENOTDIR / ELOOP, this walk was never asked, and
  // the notice printed `rm -f <…>/.traffic-one/retention.json` — which fails
  // `Not a directory` and `Too many levels of symbolic links` respectively. Two
  // more printed commands that cannot be run at all, in the class round 15
  // reported closed, and neither is reachable by varying the modes of paths INSIDE
  // a state root.
  //
  // So the question asked is the one that decides it: can any verb NAME the file?
  // `rm` acts on the entry, so an `lstat` is exactly the capability it needs.
  //
  // DELIBERATELY NOT WIDENED to "would the removal run", which is the gate at
  // `removal` above and a DIFFERENT question. Conflating them was drafted and
  // measured wrong before it shipped: with `.traffic-one` at 0o555 the removal is
  // refused while the file is perfectly nameable, and the `!nameable` sentence below
  // — "nothing can name that path, because <dir> is not reachable" — would then have
  // been emitted about a directory that lists fine. That is this lane's own defect
  // committed by the repair for it, so both questions stay asked separately.
  const nameable = pathReachableBy(file, false);
  const directory = read.kind === 'unreadable' && (MODE_BIT_ERRNOS.includes(read.errno) || !nameable)
    ? directoryFault(path.dirname(file), projectDir)
    : null;
  const dirClass = directory === null ? null : faultClass(directory.errno);
  // The SAME question the RETAINED notice's mode branch asks, and it has to be
  // asked here too: this branch prints its OWN `chmod`, at the directory, and a
  // `chmod` that cannot follow to its target fails wherever it is printed from.
  // MEASURED before this guard: the symlinked-root arm printed three chmods, one
  // per notice; removing only the RETAINED one left TWO still failing.
  const unreachableDir = dirClass !== 'mode' ? null : agentRunnableCommand('chmod u+rx', directory!.dir);
  const remedy = transientRead(read)
    ? TRANSIENT_REMEDY
    : nonRegularRead(read)
      ? notAFileRemedy(removal)
      : unreachableDir
        ? `The FILE is not what has to change: ${agentVisiblePath(directory!.dir)} cannot be listed by this process,`
          + ` so nothing can read the file inside it and no \`rm\` or edit of it is even possible — run`
          + ` \`${unreachableDir}\` first, and this suspension lifts with it.`
        : !nameable
          ? `The FILE is not what has to change and THERE IS NO COMMAND HERE TO RUN: nothing can name that path,`
            + ` because ${agentVisiblePath(directory === null ? path.dirname(file) : directory.dir)} is`
            + `${dirClass === 'kind' ? ' NOT A DIRECTORY at all' : ' not reachable'}`
            + `${directory === null ? '' : ` (${directory.errno})`}, so there is no file at that path to repair`
            + ' and none to remove — an `rm` on it fails with that same errno. What has to change is that'
            + ' directory, which the RETAINED notice beside this one is about.'
          : durable;
  collectRetentionAnomaly(
    notices,
    `SUSPENDED — ${agentVisiblePath(file)} ${problem}, so ${scope} and .traffic-one keeps growing.\n`
    + `  ${remedy} The next sweep reclaims normally as soon as that file reads cleanly.`,
  );
}

/**
 * The disclosure half of the future-mtime fix: the artefacts no clock could
 * place, which are therefore kept indefinitely.
 *
 * This is the same category of statement announceSuspension makes — reclamation
 * is off for these paths until the USER does something — and it exists because
 * the version without it was the worst failure mode in the file: unbounded growth
 * with no notice anywhere, where a suspended sweep at least says it is suspended.
 *
 * The remedy is genuinely theirs and is stated in the two shapes it actually
 * takes. A future timestamp comes from a clock, so `touch` is the direct fix and
 * the underlying cause is a host or mount whose clock disagrees with this one. An
 * unreadable stat comes from a mode bit on the parent directory. Both are one
 * command; neither is something this sweep may guess at, because guessing here
 * means deleting an artefact whose age is unknown.
 *
 * Capped at eight paths for the same reason announceReducedRoot is: a notice
 * nobody can read is not a disclosure.
 *
 * ── ITS LAST SENTENCE WAS FALSE IN ONE OF THE STATES IT IS EMITTED IN ────────
 * It read, verbatim: "The next sweep reclaims them normally either way." Recorded
 * rather than reworded away, because it is the second notice in this file to be
 * true in the state it was written against and false in another, and the two
 * states are checked here rather than assumed:
 *
 *   isOlderThan pushes an entry whose age NO clock could establish — a future
 *     mtime with future substitutes, or a stat that failed. Once the user
 *     `touch`es it or restores the `+x`, the TTL compares and the entry is
 *     reclaimed if it is old enough. The sentence is true here, which is the state
 *     it was written in.
 *   THE ORPHAN TTL pushes a RUN DIRECTORY whose `architecture-v1.json` could not
 *     be stat-ed (see collectActions). Restore the `+x` and the ordinary answer is
 *     PRESENT — so the next sweep KEEPS that run, deliberately, because the rule
 *     that could not read the evidence is the one that would have called it
 *     abandoned. "Reclaims them normally" is the opposite of what happens, for the
 *     shape a reader is most likely to meet: a genuine run behind a mode bit.
 *
 * What both states share is what the sentence now says — the sweep gets its
 * decision back — and the divergence is named instead of averaged. The remedy is
 * unchanged in both, which is why this stays ONE notice.
 *
 * "EPHEMERAL" went with it, for the same reason: a run directory is not an
 * ephemeral artefact, and the orphan-TTL arm puts one in this list on every
 * emission of that state.
 */
function announceUnagedArtefacts(unaged: readonly string[], notices?: string[]): void {
  // The paths are the ARGUMENTS to the two commands this notice names, so they
  // are rendered the way agentRunnablePath renders an argument — quoted, and left
  // unquoted only when a redaction means the line is no longer a path to hand to
  // anything. A path with a space in it is the ordinary case here, not the exotic
  // one: every one of these is absolute and rooted in the user's home directory.
  // A path this notice cannot render as a command ARGUMENT is not put in the list
  // at all. It used to become a bare `<unnameable>` on its own line, in a list the
  // prose says to `touch` — and `touch <unnameable>` is a shell REDIRECTION, so
  // the one line meant to say "we cannot name this" was the one line a reader
  // could paste into something that truncates a file. The sibling site made the
  // same call one round earlier (announceSuspension offers prose rather than a
  // command it cannot spell); this one had not.
  //
  // ── AND WHETHER THE `touch` WOULD RUN, WHICH THIS SITE NEVER ASKED ──────────
  // The runnability gate the rest of this file routes every printed verb through
  // (agentRunnableCommand → REMEDY_PROBE) reached three sites and not this one, so
  // `touch` was declared a remedy verb, given a probe validated against
  // /usr/bin/touch in 28 cells, and then never asked here. MEASURED end to end
  // (load 1.42), on an ordinary permission bit and no exotic flag at all —
  // `reports/lighthouse/` at 0o400, which LISTS and does not SEARCH, so the
  // listing that found the artefacts succeeds and every stat under it fails
  // EACCES, which is this notice's own second cause:
  //
  //   artefacts in the UNAGED list        4
  //   `touch` commands printed            4
  //   of those that ran                   0 — all four "Permission denied"
  //   the notice on the next sweep        BYTE-IDENTICAL
  //
  // and the same at `debug/` 0o400, 1 of 1. The notice already named the true
  // remedy in prose — "an unreadable one means a mode bit on the directory holding
  // them (`chmod u+rx`)" — so it printed the command that cannot run and merely
  // described the one that can. That is the round-16 review's finding 4 at a
  // seventh address, found the same way the sixth was: by asking a site whether it
  // asks. It is fixed here the same way, by asking the kernel rather than by
  // classifying the obstacle.
  //
  // The un-touchable names are still printed, because this notice's whole claim is
  // that the user is the only one who can judge these artefacts — but at a DEEPER
  // INDENT than the touchable ones, so that "every two-space quoted line under this
  // notice is an argument to the `touch` it prescribes" stays exactly true. The
  // fence's command extractor keys on that indent.
  const runnable: string[] = [];
  const untouchable: string[] = [];
  let unspeakable = 0;
  for (const entry of unaged) {
    const quoted = agentRunnablePath(entry);
    if (quoted === null) { unspeakable += 1; continue; }
    if (commandWouldRun('touch', entry)) runnable.push(quoted);
    else untouchable.push(entry);
  }
  const lines = runnable.slice(0, 8).map((quoted) => `  ${quoted}`);
  if (runnable.length > 8) lines.push(`  ...and ${runnable.length - 8} more`);
  if (unspeakable) {
    lines.push(`  ${runnable.length ? '...and ' : ''}${unspeakable} of them cannot be named in this notice at all,`
      + ' so no command here could name the right path — they are kept indefinitely too');
  }

  const remedies: string[] = [];
  if (runnable.length > 0) {
    // BOTH CAUSES STAY NAMED FOR THIS GROUP, and the second one is why: a `touch`
    // that WOULD run still does not answer an unreadable stat of the evidence
    // INSIDE the entry, which is the other half of this notice's own header. The
    // orphan-TTL arm pushes a run DIRECTORY here whose `architecture-v1.json` could
    // not be stat-ed — the directory is perfectly writable and the `touch` is not
    // the fix — so dropping the `chmod` clause from this group loses the remedy for
    // the shape a reader is most likely to meet. (Measured: it reds "an
    // unanswerable stat is not abandoned before architecture compilation", which is
    // the row that owns that shape.) The group below is different in kind: there
    // the question WAS asked of the kernel and answered no.
    remedies.push('A future timestamp means a clock disagrees with this host (NTP stepping back, a restored'
      + ' archive, a network mount): `touch` the paths, or fix the clock that wrote them. An unreadable one means'
      + ' a mode bit on the directory holding them, or on the evidence inside them a rule has to read'
      + ' (`chmod u+rx`).');
  }
  if (untouchable.length > 0) {
    // WHAT REFUSES IS THE DIRECTORY, and it is named with a command rather than
    // with a parenthesis. One line per distinct directory holding them, each asked
    // the same question the `touch` was asked, so a `chmod` that would not run
    // either is not printed in its place.
    const dirs = [...new Set(untouchable.map((entry) => path.dirname(entry)))];
    const commands = dirs.map((dir) => agentRunnableCommand('chmod u+rx', dir)).filter((cmd) => cmd !== null);
    remedies.push(`${untouchable.length} of them cannot be TOUCHED at all: this sweep asked whether a \`touch\` on`
      + ' each would run and was refused, so a stamp is not what has to change for them. What refuses is the'
      + ` director${dirs.length > 1 ? 'ies' : 'y'} holding them — ${commands.length === dirs.length
        ? `run ${commands.map((cmd) => `\`${cmd}\``).join(', ')}`
        : 'and this sweep asked whether a `chmod` there would run and was told no, so no command here is the one'
          + ' and this notice will not print a guess'}. They are:\n`
      + untouchable.slice(0, 8).map((entry) => `    ${agentVisiblePath(entry)}`).join('\n')
      + (untouchable.length > 8 ? `\n    ...and ${untouchable.length - 8} more` : ''));
  }
  // The closing sentence starts a line of its own when the block above ended in a
  // list, so it does not read as part of the last artefact's name.
  const closing = 'With that fixed the next sweep can decide them again, which is reclamation for most — but a KEEP'
    + ' for a run whose evidence turns out to be there after all, since the rule that could not read it is the one'
    + ' that would have called that run abandoned.';

  collectRetentionAnomaly(
    notices,
    `UNAGED — ${unaged.length} artefact(s) have no timestamp this host can trust (a modification time`
    + ' in the future, or a stat this process is not allowed to make — of the entry itself, or of the evidence'
    + ' inside it a rule has to read), so no TTL can ever fire for them and they are kept indefinitely:\n'
    + `${lines.length > 0 ? `${lines.join('\n')}\n` : ''}`
    + `  ${remedies.join(' ')}${untouchable.length > 0 ? '\n  ' : ' '}${closing}`,
  );
}

/**
 * What this sweep could not READ, said once, about the DIRECTORIES rather than
 * about the artefacts inside them.
 *
 * TWO INDEPENDENT CAPABILITIES, and conflating them is the defect this arm was
 * rewritten to close. Enumerating a root needs the READ bit (`readdir`); reaching
 * the evidence inside `runs/<id>` needs the SEARCH bit (a stat of a path under it).
 * Those bits move independently, so each rule is asked the question IT needs — the
 * scheduling rules through listRoot, the run-evidence reads through
 * directoryEnterable — and this notice reports whichever of the two failed. The
 * previous version asked one question (`can I enter?`) on behalf of both, and the
 * round that wrote it left the read-bit half of the state space undisclosed. See
 * directoryEnterable for the two false sentences that came with it.
 *
 * IT IS NOT THE UNAGED CHANNEL, and the separation is the same one this file has
 * now made in four notices (the REDUCED wording, the dry-run wording, the
 * nested-illegible remedy, this): UNAGED says the artefacts "have no timestamp this
 * host can trust" and prescribes `touch` or `chmod` ON THEM. Here the unreadable
 * thing is the DIRECTORY, and the artefacts in it are not the problem — so folding
 * this in would buy a disclosure at the price of a false sentence and a remedy
 * naming the wrong path. That separation is now enforced at the CAUSE rather than
 * by wording: when `runs/` itself cannot be entered, collectActions attributes
 * every unreadable architecture stat under it to the directory and does NOT push
 * those run dirs into UNAGED, because their own timestamps were never consulted.
 * MEASURED before that attribution existed, at `runs/` 0o400, 0o444 and 0o600 (read
 * but no search): BOTH notices fired about the same four run directories, UNAGED
 * telling the user to `touch` four paths one line above this notice saying there was
 * nothing here to `touch`.
 *
 * WHAT EACH CLAUSE IS TRUE OF, since that is the property five rounds of this lane
 * have got wrong and it is now a suite artefact (see the permission-bit table in
 * __tests__/retention.test.ts, which asserts the notices AND the absent sentences
 * at ten modes of this one directory):
 *
 *   THE LISTING CLAUSE fires when a rule could not enumerate its root. Nothing
 *     under such a root is planned at any age — measured at ten roots, 0 notices
 *     each before this existed, `reports/lighthouse` dropping ten planned actions
 *     on its own (listRoot).
 *   THE ENTER CLAUSE fires when `runs/` cannot be traversed, which is what blinds
 *     runArtefactEvidence.
 *   THE RESERVATION SENTENCE fires only when the reservation actually CHANGED an
 *     id's fate, which is why the count is not `unknownEvidence` (see
 *     RunKeepSet.reservedBehindRunsDir).
 *
 * AND WHAT NO CLAUSE SAYS ANY MORE: that `.traffic-one` "keeps growing". Two rules
 * sit outside the run-cap guard by design, and MEASURED at `runs/` 0o000 with
 * backups and Lighthouse reports over cap, they reclaim 6 paths in the same sweep
 * that printed that sentence. The claim is now scoped to the directories named,
 * where it is what the plan shows.
 */
interface UnreachableStateDirs {
  /**
   * The directories at fault, each one walked to from a rule's failure and each
   * carrying the errno measured AT IT. Deduped by path, in rule order.
   *
   * NOT "the roots a rule enumerated and could not read", which is what this
   * field used to hold and what made the remedy name paths a user cannot act on.
   * See blameDirectory.
   */
  readonly unreachable: readonly UnreachableRoot[];
  /** The directory whose traversal blinded the run-evidence reads, when one did. */
  readonly runsUnenterable: UnreachableRoot | null;
  /** How many ids that reservation rescued; 0 when every one of them was kept anyway. */
  readonly reservedIds: number;
  /**
   * Whether the caps this notice promises reclamation from are switched off.
   *
   * The notice is about a listing failure and the promise at the end of it is
   * about the WINDOW, and those are two independent facts: with the caps
   * suspended, restoring the bit restores the enumeration and reclaims nothing.
   * See announceUnreachableStateDirs for the measurement.
   */
  readonly suspension: CapSuspension;
  /**
   * The inputs whose illegibility caused that suspension, by path.
   *
   * Carried because the promise is not decided by the suspension alone: when the
   * illegible file is BEHIND one of the directories named here, the one `chmod`
   * this notice prints lifts the suspension as well, and the pessimistic sentence
   * is false. `readPolicy` collects them. See unreachablePromise.
   */
  readonly illegibleInputs: readonly string[];
  /**
   * The project directory the sweep was HANDED, which bounds every walk this notice
   * takes and decides one sentence outright.
   *
   * Carried rather than re-derived because the `chmod`-unreachable arm's decline
   * used to assert that what a symlinked state root points at is "outside this
   * project's state" — measured false in the state this lane's own fence drives,
   * where the answer is the whole reclamation. See reachableModeRepair.
   */
  readonly projectDir: string;
}

/**
 * ONE REMEDY SENTENCE PER FAULT CLASS, each naming its own paths.
 *
 * Written as a per-class composition rather than one sentence with a `chmod` in it
 * because the classes are not variations on a theme: one is a permission bit, one
 * is the wrong kind of file, one is about THIS PROCESS and licenses no action at
 * all, and one is an errno this file has not classified. A single sentence covering
 * them is false for three of the four.
 */
/**
 * WHAT ACTUALLY REFUSES, WHEN A `chmod` ON THE ENTRY CANNOT WORK — walked to, not
 * asserted about.
 *
 * ── THE SENTENCE THIS REPLACES, RECORDED VERBATIM BECAUSE IT SHIPPED ──────────
 * The `chmod`-unreachable arm declined with a reason it had not measured:
 *
 *   "What has to change is access to what it points at, which is OUTSIDE THIS
 *    PROJECT'S STATE; this notice will not name a path outside the project, and
 *    `ls -l` on the path above shows the link plainly."
 *
 * MEASURED on the state this lane's own fence drives (rootKindArms builds the
 * relocation target as `path.join(dir, 'away-…')` — INSIDE the project directory),
 * section C, load 6.79:
 *
 *   the link resolves to        <project>/away-root/moved   — inside the project
 *   commands printed            0
 *   notices / plan              3 / 0   (healthy control: 21)
 *   `chmod u+rx <project>/away-root`    SUCCESS
 *   notices / plan after it     0 / 21
 *
 * So the notice declined to name a path on the grounds that it was outside the
 * project, in a state where it is inside the project, and the user paid the whole
 * reclamation — 21 planned actions and unbounded growth — for a policy that did not
 * apply. That is this lane's named failure mode: a DECLINE RESTING ON A FALSE
 * REASON while the verdict holds. The verdict does hold and is unchanged: no
 * `chmod` is printed on the LINK, because `chmod` follows it.
 *
 * ── WHY THIS IS NOT A CHANGE TO THE BLAME WALK ───────────────────────────────
 * `blameDirectory` stops AT the link, and that is correct for the question it
 * answers (an `lstat` of the link succeeds, so the fault is at it and not above it —
 * round 15's review established this and it is not reopened). This asks a different
 * question from a different starting point: not "which directory is at fault" but
 * "which directory would a reader have to change", which begins at what the link
 * RESOLVES to. The walk is reused rather than copied, and its project bound is what
 * makes the answer safe to print.
 *
 * The four outcomes are distinguished because the SENTENCE differs for each, and
 * three of them were one sentence before.
 */
type ModeRepair =
  | { kind: 'repair'; command: string; obstacle: string }
  | { kind: 'outside' }
  | { kind: 'unrepairable'; obstacle: string }
  | { kind: 'not-a-link' };

function reachableModeRepair(dir: string, projectDir: string): ModeRepair {
  let hop: string;
  try { hop = fs.readlinkSync(dir); } catch { return { kind: 'not-a-link' }; }
  const resolved = path.resolve(path.dirname(dir), hop);
  const root = path.resolve(projectDir);
  // The walk below is bounded at the project directory, so it may only be started
  // from inside it; and a path outside the project is the one case where the
  // original sentence's policy is the true reason rather than a false one.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return { kind: 'outside' };
  const obstacle = blameDirectory(resolved, listErrno(resolved) ?? 'EACCES', projectDir);
  const command = agentRunnableCommand('chmod u+rx', obstacle.dir);
  return command === null
    ? { kind: 'unrepairable', obstacle: agentVisiblePath(obstacle.dir) }
    : { kind: 'repair', command, obstacle: agentVisiblePath(obstacle.dir) };
}

function unreachableRemedies(
  roots: readonly UnreachableRoot[],
  projectDir: string,
): { text: string; commanded: Set<FaultClass> } {
  const byClass = new Map<FaultClass, UnreachableRoot[]>();
  for (const root of roots) {
    const key = faultClass(root.errno);
    byClass.set(key, [...(byClass.get(key) ?? []), root]);
  }
  const sentences: string[] = [];
  // WHICH CLASSES PRINTED A COMMAND, not whether ANY did. The outlook below is
  // composed per class, and "With that done" is a claim about the reader having
  // run something for THAT class: a `rm -rf` printed for a non-directory does not
  // license the mode sentence's "with that done", and one flag for four classes
  // is how a sentence ends up true of a path it is not about.
  const commanded = new Set<FaultClass>();

  // A MODE FAULT AT A PATH `chmod` CANNOT WORK ON IS NOT A `chmod` FAULT. Split
  // before the sentence is composed rather than hedged inside it: these two groups
  // get different advice, and the group that gets none has to be told so — with a
  // reason that was MEASURED. See REMEDY_PROBE, which asks the kernel whether the
  // command would succeed rather than whether the path resolves, and
  // reachableModeRepair for the walk that finds what a reader can actually change.
  const modeAll = byClass.get('mode') ?? [];
  const chmodable = (root: UnreachableRoot): boolean => agentRunnableCommand('chmod u+rx', root.dir) !== null;
  const mode = modeAll.filter(chmodable);
  for (const root of modeAll.filter((root) => !chmodable(root))) {
    const repair = reachableModeRepair(root.dir, projectDir);
    // ── "AND EVERY OTHER VERB THIS NOTICE KNOWS WOULD TOO" WAS FALSE FOR HALF OF
    // THEM, and it contradicted the docblock of the predicate written to gate it.
    // MEASURED at the entry the notice names, each verb on its own fresh tree so an
    // earlier one cannot decide a later one (section E): `chmod` FAILED "No such
    // file or directory", `touch` FAILED "Permission denied", `rm -f` SUCCESS,
    // `rm -rf` SUCCESS. `rm` acts on the ENTRY and the entry is perfectly
    // nameable. So the true statement is a DECISION and is said as one — an `rm`
    // here destroys the only reference to this project's state — and not an
    // impossibility the filesystem disagrees with.
    const rmIsPossible = ' An `rm` on that entry itself WOULD succeed, and this notice will not print one:'
      + ' removing it destroys the only reference to this project\'s state.';
    if (repair.kind === 'repair') {
      // AND THIS ARM COMMANDS, which the round that wrote it did not record — so
      // the outlook two lines below it closed with "there is no command here to run
      // for either", one line under the command it prints. MEASURED on the state
      // this same arm serves (arm B, load 2.93): the notice printed
      // `chmod u+rx '<project>/away-root'`, that command SUCCEEDED, notices went
      // 3 → 0 and the plan 0 → 21 — under a sentence saying no command was there.
      // `commanded` is what the promise is composed from, so a site that prints
      // and does not record is a site that contradicts itself in one notice.
      commanded.add('mode');
      sentences.push(`${agentVisiblePath(root.dir)} refused this process (${root.errno}) and a \`chmod\` ON IT`
        + ' cannot help: that entry is a SYMLINK, and `chmod` follows a link rather than changing it, so it acts on'
        + ` what the link points at. What refuses is ${repair.obstacle}, which this link resolves to INSIDE this`
        + ` project: run \`${repair.command}\`.${rmIsPossible}`);
    } else if (repair.kind === 'unrepairable') {
      sentences.push(`${agentVisiblePath(root.dir)} refused this process (${root.errno}) and NOTHING PRINTED HERE`
        + ' COULD REPAIR IT: that entry is a SYMLINK, and `chmod` follows a link rather than changing it, so it'
        + ` acts on what the link points at. What refuses is ${repair.obstacle}, and this sweep asked whether a`
        + ' `chmod` there would succeed and was told no — so no command here is the one, and this notice will not'
        + ` print a guess.${rmIsPossible}`);
    } else if (repair.kind === 'outside') {
      sentences.push(`${agentVisiblePath(root.dir)} refused this process (${root.errno}) and NOTHING PRINTED HERE`
        + ' COULD REPAIR IT: that entry is a SYMLINK, and `chmod` follows a link rather than changing it, so it'
        + ' acts on what the link points at. What has to change is access to the path ABOVE what this link'
        + ' resolves to, and this link resolves OUTSIDE this project — measured, not assumed — so this notice will'
        + ` not name it; \`ls -l\` on the path above shows the link plainly.${rmIsPossible}`);
    } else {
      // NOT A LINK, and this is the arm the old resolution-only predicate could not
      // produce at all: an ordinary directory, resolving perfectly well, whose mode
      // this process may not change. `chflags uchg` is the measured instance (round
      // 16's review, re-derived at arm A) and the causes below are offered to the
      // READER as things to look for — the VERDICT comes from the attempt in
      // REMEDY_PROBE, not from this list, which is why a cause nobody listed
      // cannot make this sentence wrong.
      sentences.push(`${agentVisiblePath(root.dir)} refused this process (${root.errno}) and NOTHING PRINTED HERE`
        + ' COULD REPAIR IT: that entry is an ordinary directory that resolves perfectly well, and this sweep'
        + ' asked the filesystem whether a `chmod` on it would succeed and was told NO. A mode bit is therefore'
        + ' not what is holding it. What does: a file flag (`chflags uchg` — Finder\'s "Locked" checkbox, and what'
        + ' an archive or Time Machine restore leaves behind — or `chattr +i` on Linux), an owner that is not this'
        + ' process, a read-only mount, or an access-control rule above the mode bits. `ls -ldO` on the path above'
        + ' shows a flag and an owner; nothing this notice could print would change any of them.');
    }
  }
  if (mode.length > 0) {
    const single = mode.length === 1 ? agentRunnablePath(mode[0]!.dir) : null;
    const speakable = mode.some((root) => agentRunnablePath(root.dir) !== null);
    if (single) commanded.add('mode');
    else if (speakable) commanded.add('mode');
    const verb = single
      ? `run \`chmod u+rx ${single}\``
      : speakable
        ? 'run `chmod u+rx` on each path named above'
        : 'restore read and search permission on those directories yourself — their own names cannot be spoken in'
          + ' this notice, so no command here could name the right path';
    sentences.push(`${verb} — ${mode.length > 1 ? 'those directories' : 'that ONE directory'}, not the artefacts`
      + ` inside ${mode.length > 1 ? 'them' : 'it'}: a mode bit is the whole problem for`
      + ` ${mode.length > 1 ? 'them' : 'it'}, and there is nothing that a \`touch\` would change.`);
  }

  // ── THE SENTENCE THIS REPLACES, RECORDED VERBATIM BECAUSE IT SHIPPED ────────
  //   "<path> is NOT A DIRECTORY at all (<errno>) — so no mode bit can make it
  //    listable and a `chmod` on it would report SUCCESS and change nothing:
  //    run `rm -rf '<path>'`, and the runtime writes a real directory in its place.
  //    Nothing of this project's state can be inside something that is not a
  //    directory."
  //
  // ONE SENTENCE OVER TWO ERRNOS, false on one of them, and false about the
  // contents in a state the axis can reach. `NOT_A_DIRECTORY_ERRNOS` is
  // ['ENOTDIR', 'ELOOP'] and the two do not behave alike. MEASURED with the
  // counterfactual `chmod` the sentence asserts about actually executed, and the
  // entries behind the path counted before and after the printed `rm -rf`
  // (arms D1–D3, load 6.79):
  //
  //   digests/ a regular FILE       ENOTDIR  `chmod u+rx` SUCCESS       — true
  //   digests/ a symlink LOOP       ELOOP    `chmod u+rx` FAILED,
  //                                          "No such file or directory"  — FALSE
  //   digests/ a 60-hop symlink     ELOOP    `chmod u+rx` FAILED, same  — FALSE
  //     CHAIN ending at this                 4 of this project's digest entries
  //     project's own digests                behind it BEFORE the printed
  //                                          `rm -rf`, and 4 AFTER it — the
  //                                          removal takes the LINK and ORPHANS
  //                                          the state the sentence says is not
  //                                          there. Two more false clauses.
  //
  // The false half is the whole reason the sentence existed: its argument is "a
  // `chmod` here is the trap, because it succeeds silently — so here is an `rm -rf`
  // instead", and on ELOOP the trap is the opposite one. A reader is told the safe
  // signal is absent exactly where it is present. Composed per measured fact now:
  // whether the path RESOLVES (which is what separates the two errnos), whether the
  // entry is a LINK (which is what decides what a removal takes), and whether the
  // removal would RUN at all.
  for (const root of byClass.get('kind') ?? []) {
    const removal = agentRunnableCommand('rm -rf', root.dir);
    if (removal) commanded.add('kind');
    const resolves = pathResolves(root.dir);
    const link = ((): boolean => {
      try { return fs.lstatSync(root.dir).isSymbolicLink(); } catch { return false; }
    })();
    const head = resolves
      ? `${agentVisiblePath(root.dir)} is NOT A DIRECTORY at all (${root.errno}) — so no mode bit can make it`
        + ' listable, and a `chmod` on it SUCCEEDS while changing nothing about that, which is the failure shape'
        + ' with no signal in it at all.'
      : `${agentVisiblePath(root.dir)} cannot be resolved at all (${root.errno}) — the entry is a symlink whose`
        + ' chain this host will not follow, so no mode bit can make it listable and a `chmod` on it does not'
        + ' reach anything to change: it FAILS with an errno rather than succeeding silently.';
    // WHAT THE REMOVAL TAKES, which is the clause that orphaned three run digests.
    // A link removal takes the link; what the chain ends at is a path this process
    // could not follow, so this notice does not claim to know whether anything is
    // there — it says so, and points at the one command that shows the first hop.
    const takes = link
      ? ' THE REMOVAL TAKES THE LINK ONLY: whatever the chain ends at stays on disk, and no rule here will reach'
        + ' it again. This sweep could not follow that chain, so it does not know whether anything of yours is'
        + ' behind it — `ls -l` on the path above shows the first hop, and it is worth reading before removing.'
      : ' What is there now is not a directory, so no tree of this project\'s is inside it and the removal loses'
        + ' nothing.';
    if (removal) {
      sentences.push(`${head} Run \`${removal}\` and the runtime writes a real directory in its place.${takes}`);
      continue;
    }
    // AND THE REMOVAL ITSELF CAN BE REFUSED, which nothing here asked before.
    // MEASURED: with `.traffic-one` at 0o555 the printed `rm -rf` fails "Permission
    // denied"; with the entry carrying `uchg` it fails "Operation not permitted";
    // in both the notice came back byte-identical (arms G, H). The second question
    // is asked of the kernel too, so the reason names what refused rather than
    // guessing which of the two it was.
    const parentRefuses = ((): boolean => {
      try { fs.accessSync(path.dirname(root.dir), fs.constants.W_OK | fs.constants.X_OK); return false; } catch { return true; }
    })();
    const why = agentRunnablePath(root.dir) === null
      ? 'its own name cannot be spoken in this notice, so no command here could name the right path'
      : parentRefuses
        ? `nothing may be removed from ${agentVisiblePath(path.dirname(root.dir))} by this process — this sweep`
          + ' asked and was refused, so an `rm` printed here would fail'
        : 'this sweep asked whether that entry could be removed and was refused, for something other than a mode'
          + ' bit: a file flag (`chflags uchg`, `chattr +i`), or a read-only mount. `ls -lO` on it shows a flag';
    sentences.push(`${head} THERE IS NO REMOVAL TO PRINT HERE: ${why}. Remove it yourself once that is no longer`
      + ` true and the runtime writes a real directory in its place.${takes}`);
  }

  const transient = byClass.get('transient') ?? [];
  if (transient.length > 0) {
    sentences.push(`${transient.map((root) => agentVisiblePath(root.dir)).join(', ')} could not be listed because of`
      + ` an errno about THIS PROCESS rather than about the directory (${transient.map((root) => root.errno).join(', ')}).`
      + ` ${TRANSIENT_REMEDY}`);
  }

  for (const root of byClass.get('opaque') ?? []) {
    sentences.push(`${agentVisiblePath(root.dir)} could not be listed and the errno is ${root.errno}, which is`
      + ' neither a permission bit nor a wrong kind of file — so no command here would be the right one, and this'
      + ' notice will not guess at one. What to do depends on the cause (a failing device, a name the filesystem'
      + ' will not accept, a mount that went away), and the sweep reclaims normally as soon as that directory'
      + ' lists.');
  }

  return { text: sentences.map((sentence) => `  ${sentence}`).join('\n'), commanded };
}

/**
 * WHAT COMES BACK, PER FAULT CLASS — one sentence each, for the same reason
 * unreachableRemedies is a per-class composition and not one sentence with a
 * `chmod` in it.
 *
 * ── THE SENTENCE THIS REPLACES, RECORDED VERBATIM BECAUSE IT SHIPPED ──────────
 * The outlook used to be a two-armed ternary: the window promise where a `mode`
 * root existed, and otherwise, unconditionally,
 *
 *   "The rules manage that path again as soon as a directory is what is there;
 *    nothing is reclaimed by this, because nothing of this project's can be
 *    inside what is there now."
 *
 * That is the NOT-A-DIRECTORY sentence, and `faultClass` has four values, so it
 * was also the closing sentence on `transient` and `opaque` faults. MEASURED
 * under real descriptor exhaustion (61,416 descriptors held until `open` refused
 * with EMFILE, load 9.80) the RETAINED notice ended:
 *
 *   "…/backups, …/reports/lighthouse could not be listed because of an errno
 *    about THIS PROCESS rather than about the directory (EMFILE, EMFILE). That
 *    errno is about THIS PROCESS, not about the file: it is retryable, so there
 *    is nothing here to repair and nothing to remove. […] The rules manage that
 *    path again as soon as a directory is what is there; nothing is reclaimed by
 *    this, because nothing of this project's can be inside what is there now."
 *
 * BOTH CLAUSES ARE FALSE THERE and they contradict the sentence directly above
 * them: those two paths ARE directories, this project's backups and Lighthouse
 * reports ARE inside them, and the true remedy — the next sweep is the retry —
 * is replaced by a condition that will never change, since nothing is going to
 * "become a directory". EMFILE inside a coding-agent process holding many
 * descriptors is an ORDINARY event and not the user's fault, so a transient
 * fault must not draw a destructive remedy or a repair instruction at all; this
 * one sent the reader to replace a directory that was fine.
 *
 * It reached an LLM as instructions, through retentionAdvisory and SessionStart.
 * It was also unpinned: deleting the string outright killed 0 of 175 fence rows
 * on a branch three arms execute (the peer's `mine_kindsentence`), which is the
 * finding underneath the finding. Each class's sentence is pinned by name now —
 * see "the outlook sentence of a RETAINED notice is TRUE OF ITS OWN FAULT CLASS"
 * in __tests__/retention.test.ts, which asserts the right one is present AND the
 * other three are absent, so a sentence pasted from one class onto another dies.
 *
 * ── WHY ONE SENTENCE PER CLASS PRESENT, RATHER THAN A WINNER ─────────────────
 * The old shape let `mode` win outright: a notice carrying a mode root and a
 * non-directory printed the window promise and said nothing at all about the
 * outlook for the non-directory. Each class is asked its own question here and
 * every class present answers, so a mixed notice is complete rather than
 * partially silent. Each sentence names its own SUBJECT ("what is not a
 * directory", "what failed on an errno about THIS PROCESS") instead of saying
 * "that path", because in a mixed notice a bare pronoun is a sentence that is
 * true of one path and false of the one beside it — which is the defect this
 * function exists to end, one level down.
 */
function unreachableOutlook(
  subjects: readonly UnreachableRoot[],
  commanded: ReadonlySet<FaultClass>,
  suspension: CapSuspension,
  liftsSuspension: boolean,
): string {
  const present = new Set(subjects.map((root) => faultClass(root.errno)));
  const sentences: string[] = [];
  if (present.has('mode')) {
    const modeRoots = subjects.filter((root) => faultClass(root.errno) === 'mode');
    sentences.push(unreachablePromise(suspension, commanded.has('mode'), modeRoots.length > 1, liftsSuspension));
  }
  if (present.has('kind')) {
    // ── TWO OUTLOOKS, BECAUSE THE TWO ERRNOS DISAGREE ABOUT WHAT IS BEHIND THE
    // PATH, and one sentence over both was the last surviving clause of the
    // not-a-directory falsehood this file has now corrected in three places.
    //
    // The remedy half above was already composed per measured fact and says, for a
    // link it could not follow, "This sweep could not follow that chain, so it does
    // not know whether anything of yours is behind it". This sentence then closed
    // the SAME NOTICE with "nothing of this project's can be inside what is there
    // now" — a contradiction two lines apart, and the second one is the one a
    // reader meets last. MEASURED (arm A3, load 2.93): `digests/` replaced by a
    // 60-hop symlink CHAIN ending at this project's own digests, ELOOP exactly as a
    // loop answers, **4 of this project's digest entries behind it before the
    // printed `rm -rf` and 4 after it** — the removal takes the link and orphans
    // them, under a sentence saying they cannot exist.
    //
    // A CHAIN IS NOT A LOOP and that is why the axis missed it: it is not circular,
    // it resolves to a real tree, and the only thing wrong with it is that it is
    // longer than this host follows. `pathResolves` is the discriminator both
    // halves now share, so they cannot answer it differently again.
    const kindRoots = subjects.filter((root) => faultClass(root.errno) === 'kind');
    const unresolved = kindRoots.filter((root) => !pathResolves(root.dir));
    if (unresolved.length < kindRoots.length) {
      sentences.push('What is not a directory comes back under the rules as soon as a directory is what is there;'
        + ' nothing is reclaimed by that, because nothing of this project\'s can be inside what is there now.');
    }
    if (unresolved.length > 0) {
      sentences.push('What cannot be RESOLVED comes back under the rules as soon as a directory is what is there,'
        + ' and nothing here is reclaimed by that either — but this notice does not claim the stronger thing:'
        + ' whatever that chain ends at was never followed by this sweep, so if it holds anything of yours it stays'
        + ' on disk, referenced by nothing here and reached by no rule again.');
    }
  }
  if (present.has('transient')) {
    // NOTHING IS OWED AND NOTHING WAS LOST. The plan is smaller and the bytes are
    // untouched, which is the whole difference between this class and every other
    // one here: there is no repair to promise the result of, so the outlook is
    // about the entries rather than about the reader.
    sentences.push('What failed on an errno about THIS PROCESS is still there and still this project\'s — this'
      + ' sweep planned nothing for it and removed nothing of it — and the caps rank it normally again on the'
      + ' first sweep whose listing succeeds. No action here is yours.');
  }
  if (present.has('opaque')) {
    sentences.push('What failed on an errno this notice cannot classify is kept meanwhile, in full: whether'
      + ' anything has to be repaired before a listing succeeds depends on the cause named above, and this notice'
      + ' does not know which it is.');
  }
  return sentences.join(' ');
}

function announceUnreachableStateDirs(state: UnreachableStateDirs, notices?: string[]): void {
  const { runsUnenterable, reservedIds, suspension, illegibleInputs } = state;
  // THE TWO CAPABILITIES DECIDE THE CLAUSE, at every level and not just at `runs/`.
  // A directory that lists perfectly well and cannot be TRAVERSED belongs in the
  // enter clause: putting it in the listing clause is a sentence that is false
  // about a `readdir` that works, which is what the mode table caught at `runs/`
  // 0o400/0o444/0o600 the first time the blame walk fed one channel for both.
  const unreachable = state.unreachable.filter((root) => !root.listable);
  const unenterable = state.unreachable.filter((root) => root.listable
    && (runsUnenterable === null || root.dir !== runsUnenterable.dir));
  if (unreachable.length === 0 && unenterable.length === 0 && runsUnenterable === null) return;

  // The same discipline announceUnagedArtefacts and announceSuspension use: a path
  // this notice cannot render as a command ARGUMENT is counted in prose rather than
  // printed, because a `chmod` line naming the wrong path is worse than no line.
  const runnable: string[] = [];
  let unspeakable = 0;
  for (const root of unreachable) {
    const quoted = agentRunnablePath(root.dir);
    if (quoted === null) { unspeakable += 1; continue; }
    // The errno is printed beside the path when it is not the ordinary mode bit,
    // because the remedy below differs by class and a reader matching a sentence to
    // a path needs the discriminator on the line.
    const fault = faultClass(root.errno);
    runnable.push(fault === 'mode' ? quoted : `${quoted} — ${root.errno}`);
  }
  const lines = runnable.slice(0, 8).map((quoted) => `  ${quoted}`);
  if (runnable.length > 8) lines.push(`  ...and ${runnable.length - 8} more`);
  if (unspeakable) {
    lines.push(`  ${runnable.length ? '...and ' : ''}${unspeakable} whose own name cannot be spoken in this notice,`
      + ' so no command here could name the right path — what is inside them is kept indefinitely too');
  }

  // The subjects are the directories this notice is about: the faults walked to
  // from each rule's failure, plus the one whose traversal blinded the evidence
  // reads. Deduped by path, because at 0o000 the same directory arrives through
  // both capabilities.
  const subjects: UnreachableRoot[] = [...unreachable, ...unenterable];
  if (runsUnenterable !== null && !subjects.some((root) => root.dir === runsUnenterable.dir)) {
    subjects.push(runsUnenterable);
  }
  const { text: remedies, commanded } = unreachableRemedies(subjects, state.projectDir);
  // DOES THIS NOTICE'S OWN REMEDY ALSO LIFT THE SUSPENSION? A measured question,
  // not a hedge: the file that suspended the caps is either behind one of these
  // directories or it is not, and the answer decides which promise is true. See
  // unreachablePromise for the arm that made the pessimistic sentence false.
  const liftsSuspension = subjects.some((root) => illegibleInputs.some((file: string) => file === root.dir
    || file.startsWith(root.dir + path.sep)));

  let detail = '';
  if (unreachable.length > 0) {
    detail += `RETAINED — this sweep could not LIST ${unreachable.length} of the directories its own rules prune, so`
      + ' it could not enumerate what is inside: no rule here planned anything under'
      + ` ${unreachable.length > 1 ? 'them' : 'it'}, whatever its age, and the paths this sweep reports removing do`
      + ` not include ${unreachable.length > 1 ? 'them' : 'it'}:\n`
      + `${lines.join('\n')}\n`;
  }
  for (const root of unenterable) {
    // A listing that works and a traversal that does not — the off-diagonal state
    // one level below the one `runs/` gets its own sentence for. What is retained
    // is what a rule could not READ THE EVIDENCE for, so the sentence is about the
    // evidence rather than about the enumeration.
    detail += detail === ''
      ? `RETAINED — ${agentVisiblePath(root.dir)} can be LISTED but not ENTERED by this process`
      : `  ${agentVisiblePath(root.dir)} can be LISTED but not ENTERED`;
    detail += ', so the artefacts a rule reads to decide what is inside it could not be reached, and nothing under'
      + ' it was decided on an age or on evidence at all.\n';
  }
  if (runsUnenterable !== null) {
    detail += detail === ''
      ? `RETAINED — ${agentVisiblePath(runsUnenterable.dir)} cannot be ENTERED by this process`
      : `  ${agentVisiblePath(runsUnenterable.dir)} cannot be ENTERED either`;
    detail += ', so whether a run id this project holds belongs to a run cannot be answered — the evidence a rule'
      + ' reads for that lives inside it, and no id can be ranked on evidence this sweep was not allowed to see.';
    if (reservedIds > 0) {
      detail += ` ${reservedIds} run id(s) are RESERVED rather than ranked because of it, so the run-history window`
        + ' cannot decide them and their same-named directories under digests/, fix-cycles/ and reports/qa/ are'
        + ' kept with them.';
    }
    detail += '\n';
  }
  detail += `${remedies}\n`;
  // THE PROMISE IS ABOUT THE WINDOW, so it is made only where restoring a mode bit
  // is what the reader is being asked for. A directory that is not a directory has
  // nothing inside it: its own sentence says the runtime writes a real one in its
  // place, and appending "reclamation for what falls outside the window" to that
  // promises bytes back from an empty path. MEASURED by the property below with the
  // sentence appended unconditionally: `reports/` replaced by a regular file
  // promised reclamation and moved the plan 15 → 15.
  //
  // AND THE OTHER SIDE OF THAT TERNARY WAS THE NOT-A-DIRECTORY SENTENCE ON ALL
  // THREE REMAINING CLASSES, which is false on two of them. See unreachableOutlook,
  // where the shipped sentence is recorded verbatim with the EMFILE measurement.
  detail += `  ${unreachableOutlook(subjects, commanded, suspension, liftsSuspension)}`;
  collectRetentionAnomaly(notices, detail);
}

/**
 * WHAT COMES BACK ONCE THE USER HAS DONE IT — which is a claim about the CAPS, and
 * was being made by a notice that only knows about a listing.
 *
 * It read, unconditionally and verbatim: "With the bit restored the next sweep
 * enumerates and ranks what is in there again, which is reclamation for what falls
 * outside the window and a keep for what falls inside it." Under a suspension there
 * IS no window — every cap is `MAX_SAFE_INTEGER` — so the sentence promised a
 * reclamation that cannot happen, in a notice printed one line from the SUSPENDED
 * notice that names the real cause.
 *
 * MEASURED (corrupt `retention.json` + `backups/` 0o000, dry runs only so no apply
 * sweep confounds the delta): the same notice with the same promise, and obeying
 * its `chmod` alone moves the plan 0 → 0, where the legible control moves 0 → 2.
 * Recorded rather than reworded away because the comment at the `unlistable`
 * declaration asserted this state does not exist ("A SUSPENSION collects nothing
 * here because it takes no listing it acts on"), which is why nobody looked: two
 * rules sit BELOW the suspension guard and call listRoot unconditionally.
 *
 * THE TWO SUSPENSIONS DIFFER AND THE SCOPED SENTENCE IS THE TRUE ONE. An illegible
 * `retention.json` takes all four caps, so nothing at all is reclaimed by restoring
 * a bit. An illegible `.one.json` takes the RUN caps only — the backup and
 * Lighthouse caps still carry the user's numbers and still fire — so reclamation
 * really does follow, for those two rules and no others. MEASURED on the same
 * fixture: 0 → 0 for the first, 0 → 2 for the second.
 *
 * ── AND THE PESSIMISTIC VERSION WAS ITSELF FALSE ONE STEP AWAY ───────────────
 * Recorded because it is this lane's disease caught inside the round that was
 * written to end it, by the property written to end it. The sentence above shipped
 * for the length of one test run as an unconditional consequence of the
 * suspension — "will still reclaim NOTHING here, because every retention cap is
 * off" — and it was measured true on the state it was written against (a corrupt
 * `retention.json` beside a `backups/` at 0o000, two independent faults) and FALSE
 * at `.traffic-one` 0o000, where the one `chmod` this notice prints also makes
 * `retention.json` readable: plan 0 → 21 under a sentence promising 0 → 0. A
 * falsely pessimistic remedy is not the harmless direction — it sends a reader to
 * repair a second thing that was never broken, and it tells them the command they
 * just ran did nothing.
 *
 * So the question is asked of the paths rather than of the policy: is the illegible
 * INPUT behind one of the directories this notice names? `readPolicy` collects
 * which files those were, and `liftsSuspension` is that comparison. It cannot be
 * inferred from the policy shape — a project that hand-writes MAX_SAFE_INTEGER caps
 * has the same shape and no illegible file at all.
 */
function unreachablePromise(
  suspension: CapSuspension,
  anyCommand: boolean,
  plural: boolean,
  liftsSuspension: boolean,
): string {
  const done = anyCommand ? 'With that done' : 'Once that is no longer true';
  const them = plural ? 'them' : 'it';
  if (suspension !== 'none' && liftsSuspension) {
    // "the one command above" is a claim about a command being there, and it is
    // false where the mode fault sits at a path no verb can reach: measured at a
    // `.traffic-one` symlinked to a tree whose parent is 0o000, where the notice
    // prints nothing at all and this sentence still promised a fix "above".
    const both = anyCommand
      ? 'so the one command above is the fix for both, and the reclamation the caps describe follows from it.'
      : 'so the one change is the fix for both, and the reclamation the caps describe follows from it — there is'
        + ' no command here to run for either, for the reason given above.';
    return `${done} the next sweep enumerates and ranks what is in there again, and the retention caps come back`
      + ` with it: the file the SUSPENDED notice names is INSIDE what this notice names, ${both}`;
  }
  if (suspension === 'every-cap') {
    return `${done} the next sweep can enumerate ${them} again — and will still reclaim NOTHING here, because every`
      + ' retention cap is off while the file the SUSPENDED notice names cannot be read. That file is the change'
      + ' that reclaims anything; this one only restores what the sweep can see.';
  }
  if (suspension === 'run-caps') {
    return `${done} the next sweep can enumerate ${them} again, and the backup and Lighthouse caps reclaim what`
      + ' falls outside them. The RUN-HISTORY window does not: it is off while the file the SUSPENDED notice names'
      + ' cannot be read, so no run, digest, fix-cycle or QA report is reclaimed by this alone.';
  }
  return `${done} the next sweep enumerates and ranks what is in there again, which is reclamation for what falls`
    + ' outside the window and a keep for what falls inside it.';
}

/**
 * The reduce-and-report half of the inversion, and the only place a user learns
 * that a leaked root was not fully healed.
 *
 * It names the entries verbatim because the user is the only one who can judge
 * them: this sweep's whole claim is that it does NOT know what they are. The
 * remedy is therefore theirs and is stated as such — nothing regenerates these
 * files, and nothing will delete them either.
 *
 * BOUNDED, not a standing nag, and the distinction is the difference between an
 * honest report and a product defect. A reduction that lands removes `.one.json`,
 * which is what made the directory a nested state root in the first place
 * (listNestedTrafficOneDirs), so the same leftovers are not re-reported on the
 * next SessionStart. The states that DO repeat are a dry run, a heal the consent
 * fence refused, and a heal whose `.one.json` removal THREW — none of which
 * retires the root, so a repeating line there is describing something that is
 * genuinely still true. The last of those is why the text below no longer offers
 * "refused" as the only explanation for an entry that is still on disk: the
 * `errored` split made a throw a distinct outcome with its own errno line, and a
 * user reading "the writes were refused" would go answer a consent question that
 * was never the problem.
 *
 * WHICH IS WHY THIS LINE DESCRIBES THE PLAN, NOT THE OUTCOME. It is composed
 * during collectActions, before a single `removePath` call, so it cannot know
 * whether the removals will land — and it used to say the leftovers "are LEFT IN
 * PLACE and the root is not fully reclaimed", which asserts a partial
 * reclamation. MEASURED on three consecutive apply sweeps with the use-plugin
 * question unanswered: 0 removed, one notice, repeated forever — the fence
 * refuses every path, so NOTHING was reclaimed and the sentence describing a
 * partly-healed root was false on all three. Worse, the remedy it offered ("move
 * them where you want them") is not the action that changes anything there;
 * answering the question is. Both are in the text below now, and the claim it
 * makes — these entries are not in the plan — is true in every state.
 *
 * MEASURED on a pnpm container with a leaked member root, both surfaces that
 * describe a leak, three consecutive apply-mode sweeps: with only runtime
 * artefacts inside, one whole-root action, 1 removed, no notice. With one
 * `notes.md` beside them, two actions, 2 removed, ONE notice, the file still on
 * disk — and then sweeps 2 and 3 plan zero and say nothing, while doctor's probe
 * stops listing the directory and its NESTED_TRAFFIC_ONE_ROOTS finding clears
 * (both key on `.one.json`, which the reduction took). The residue a user is left
 * with is a `.traffic-one` directory holding nothing but their own file, and the
 * honest cost of that is stated here rather than sold as free: nothing mentions
 * it again, so it is quiet rather than clean.
 *
 * Capped at eight names. A leaked root with fifty leftovers is a report about a
 * directory, not fifty reports about files, and an unreadable notice reaches
 * nobody just as surely as a notice on a channel nobody watches.
 *
 * ── ONE SENTENCE IN IT WAS SIMPLY FALSE, AND IT IS THE DISCLOSURE'S OWN ──────
 * It read, verbatim: "If they are ours, this sweep no longer knows how to name
 * them and that is a bug worth reporting." It is wrong for the MAJORITY of what
 * this notice lists. `agents` and `skills` are ours and are declined on purpose
 * (mixed directories — see recogniseEntries); the twenty residue names the
 * header enumerates are ours and have no retention rule; and
 * `.one.json.report-id.lock` is ours, has a reaper of its own in
 * state/project-state-lock.ts, and is the entry that made the falsehood
 * concrete — `report-id` occurs nowhere in this file, a leaked member root's
 * stale lock directory is a permanent leftover, and the one disclosure the whole
 * residue argument rests on told the user to file a bug about it. Recorded rather
 * than quietly reworded, because the sentence was load-bearing in the wrong
 * direction: it invited noise for the entries this design is proudest of
 * declining.
 *
 * ── AND ITS REPLACEMENT WAS TRUE ONLY OUTSIDE THE STATE IT IS PRINTED IN ─────
 * The reassuring clause that replaced it read "a lock with a reaper of its own",
 * offered as one of the classes a user need not worry about. The lock it means is
 * `.one.json.report-id.lock`, and the ONLY state this notice names it in is a
 * leaked member root — where that reaper cannot run at all, because it runs only
 * inside an acquisition on that same `cwd` and a hook in a leaked member resolves
 * to the workspace root. So the sentence pointed at a mechanism that is switched
 * off in the one place it was being invoked, and the directory (with its
 * `<token>.pending`/`.released` siblings) is permanent: MEASURED on the sweep
 * after the reduction — planned 0, notices 0, all of it still on disk. The
 * neighbouring sentence, "if they are yours there is nothing to do: they stay
 * exactly where they are", is true of them, which is what made the pair read as a
 * promise it did not make. The clause is now scoped to say the reaper does not run
 * here, which is the fact a reader can act on. THIS IS THE THIRD TIME THIS NOTICE
 * has shipped a sentence that was true in the state it was tested in — see the
 * dry-run split below and the "bug worth reporting" line above — so a new
 * reassurance here is owed a pass over every state the notice is emitted in: dry
 * run, a heal the fence refused, a heal that threw, and one that landed.
 *
 * EVERY NAME HERE IS ATTACKER-SUPPLIED, and this line is the one that proves it
 * matters: the leftovers are exactly the entries this sweep says it does NOT
 * recognise, so their names came off a disk this runtime does not own, and the
 * notice reaches `context(...)` through retentionAdvisory and
 * session/session-start.ts. `.traffic-one/` is COMMITTED state — that is the
 * premise of the whole leaked-root rule — so cloning a hostile repository and
 * starting a session is the entire delivery path. Both halves go through
 * agentVisiblePath (shared/agent-visible-name.ts): `nested`, whose ancestor
 * directory names are equally supplied, and each leftover.
 */
function announceReducedRoot(
  nested: string,
  leftovers: readonly string[],
  dryRun: boolean,
  notices?: string[],
): void {
  // ONE LEFTOVER PER LINE, which is what makes the list structure unforgeable
  // rather than merely defended. It used to be `', '`-joined on a single line, and
  // the delimiters were part of the sentence a name could write: MEASURED through
  // the real sweep with one planted leftover each, both surviving agentVisiblePath
  // legitimately (no line break, no marker grammar, no control character) —
  //   `x', 'product.md', 'plan.md`     forged TWO EXTRA list items against a
  //                                    count that said one;
  //   `notes.md' — everything else here is a runtime artefact and safe to delete: '`
  //                                    ADDED A SENTENCE to a notice an LLM reads
  //                                    as instructions.
  // The census one function up asked the SHELL question at this site and cleared
  // it; the question that matters here is whether the name can forge the LIST, and
  // it could. A newline is already refused, so a list whose items are LINES cannot
  // be restructured by any name the leaf admits — the structure stops depending on
  // a delimiter inside the item and starts depending on the one thing a name cannot
  // carry. The quotes stay, because a trailing space or a leading dot is invisible
  // without them, and they are no longer load-bearing.
  const lines = leftovers.slice(0, 8).map((name) => `  '${agentVisiblePath(name)}'`);
  if (leftovers.length > 8) lines.push(`  ...and ${leftovers.length - 8} more`);
  const shown = lines.join('\n');
  // The last paragraph explains why a PLANNED entry might still be on disk, and
  // in a dry run neither explanation is the reason: nothing was attempted. It
  // used to be printed unconditionally, so a reviewer reading a dry-run plan —
  // the state a reviewer is usually looking at — was told the fence may have
  // refused the writes and sent to answer a consent question that was already
  // answered. MEASURED: `removed: 0, failed: 0`, the two-causes sentence
  // printed. The suite already polices this exact principle one caller over (a
  // fence refusal must not be said about an ENOTEMPTY); it applies here.
  const stillThere = dryRun
    ? '  This describes the PLAN, and this sweep is a DRY RUN: nothing was removed, so the entries beside them are'
      + ' still there too. Nothing here has been attempted, let alone refused.'
    : '  This describes the PLAN. If the entries beside them are still there afterwards, the writes did not land'
      + ' rather than having been skipped, and there are two ways for that: the state-write fence REFUSED them — an'
      + ' unanswered use-plugin question refuses every one of them, and answering that question is what changes it —'
      + ' or a removal THREW, which the errno line printed beside this one names path by path.';
  collectRetentionAnomaly(
    notices,
    `REDUCED — ${agentVisiblePath(nested)} is a leaked Traffic One state root, and ${leftovers.length} of its entries are not`
    + ' artefacts this runtime recognises, so the heal SKIPS them and plans only the rest — the root will not be'
    + ' fully reclaimed:\n'
    + `${shown}\n`
    + '  Nothing here will delete them, so if they are yours there is nothing to do: they stay exactly where they'
    + ' are. Some of them are OURS and are skipped on purpose — a directory holding hand-authored files beside'
    + ' generated ones, an artefact no retention rule governs, a lock whose own reaper only runs inside the project'
    + ' it belongs to and so will never run here — so an entry you do not recognise is not by itself a bug.'
    + ' Removing the directory once you have judged them is yours to do.\n'
    + stillThere,
  );
}

function parsePolicy(read: JsonRead<unknown>): RetentionPolicy {
  const raw = obj(read.kind === 'ok' ? read.value : null);
  if (!raw) return DEFAULT_POLICY;
  const keepRuns = Number(raw.keepRuns);
  const backupKeep = Number(raw.backupKeep);
  const orphanTtlDays = Number(raw.orphanTtlDays);
  const lighthouseKeepPerRoute = Number(raw.lighthouseKeepPerRoute);
  return {
    keepRuns: Number.isFinite(keepRuns) && keepRuns >= 1 ? Math.floor(keepRuns) : DEFAULT_POLICY.keepRuns,
    backupKeep: Number.isFinite(backupKeep) && backupKeep >= 0 ? Math.floor(backupKeep) : DEFAULT_POLICY.backupKeep,
    orphanTtlDays: Number.isFinite(orphanTtlDays) && orphanTtlDays >= 0 ? orphanTtlDays : DEFAULT_POLICY.orphanTtlDays,
    lighthouseKeepPerRoute: Number.isFinite(lighthouseKeepPerRoute) && lighthouseKeepPerRoute >= 1
      ? Math.floor(lighthouseKeepPerRoute)
      : DEFAULT_POLICY.lighthouseKeepPerRoute,
  };
}

// Both files are read and BOTH are announced when both are broken: the remedy
// differs by file, so reporting only the first one leaves the user fixing half
// a problem and meeting the same suspension again. (`break`ing out of this loop
// after the first hit is what that defect looked like, and it is pinned.)
function readPolicy(cwd: string, notices?: string[], illegibleInputs?: string[]): RetentionPolicy {
  const stateFile = path.join(cwd, STATE_FILE);
  const policyFile = path.join(cwd, '.traffic-one', POLICY_FILE);
  const policyRead = readJsonResult(policyFile);
  let everyCapOff = false;
  let runCapsOff = false;
  for (const [file, read] of [
    [stateFile, readJsonResult(stateFile)],
    [policyFile, policyRead],
  ] as const) {
    if (read.kind !== 'corrupt' && read.kind !== 'unreadable') continue;
    const isPolicyFile = file === policyFile;
    // WHICH FILE, collected for a caller two functions away, in the out-param
    // idiom listRoot uses for the same reason: the unreachability notice has to
    // know whether the file that suspended the caps is BEHIND one of the
    // directories it is telling the user to fix, because that decides whether its
    // own remedy lifts the suspension too. Inferring it from the policy SHAPE
    // would be wrong for a project that hand-writes the caps: there the shape is
    // identical and there is no illegible file at all. See unreachablePromise.
    illegibleInputs?.push(file);
    announceSuspension(file, read, isPolicyFile, cwd, notices);
    if (isPolicyFile) everyCapOff = true;
    else runCapsOff = true;
  }
  if (everyCapOff) return ILLEGIBLE_POLICY;
  const policy = parsePolicy(policyRead);
  return runCapsOff ? suspendRunCaps(policy) : policy;
}

function listDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The listing every SCHEDULING RULE takes, with the failure kept as a fact.
 *
 * `[]` IS AN ANSWER AND A FAILED `readdir` IS NOT, which is the distinction
 * listEntries already carries for the leaked-root heal and which every rule in
 * collectActions was missing. A rule reading `[]` out of a directory it may not
 * read plans nothing there and reports success: the entries are unreachable to the
 * PLAN and perfectly reachable to `du`, so they are retained for as long as the
 * mode bit lasts and no surface says a word.
 *
 * MEASURED as a CLASS rather than as a `runs/` corner, which is why this helper
 * exists instead of a third predicate beside directoryEnterable. One fixture (4
 * runs with sidecars, aged once-markers, backups and Lighthouse pairs over cap,
 * aged debug logs), the read bit taken off ONE root at a time at 0o111 — still
 * traversable, so no evidence read is disturbed — against a control planning 28
 * actions (load 5.59 of 10 CPUs):
 *
 *   runs                 28 → 24 planned, 0 notices
 *   digests              28 → 26, 0 notices        fix-cycles     → 26, 0 notices
 *   reports/qa           28 → 26, 0 notices        runs/.once     → 26, 0 notices
 *   .once                28 → 26, 0 notices        backups        → 26, 0 notices
 *   debug                28 → 26, 0 notices        runs/<id>/debug → 26, 0 notices
 *   reports/lighthouse   28 → 18 planned, 0 notices
 *
 * TEN roots, ten silent partial reclaims, and the largest is the Lighthouse cap —
 * the rule that exists because one observed project held 13.6 MB of superseded
 * reports. So the answer is not to ask a second question about `runs/`: it is that
 * a rule which cannot enumerate its root must say so, wherever that root is.
 *
 * The failed root is APPENDED rather than thrown, because one unreadable directory
 * must not stop the other rules — the same best-effort shape the removal loop uses
 * — and ENOENT is excluded because an absent root is knowledge: there is nothing
 * there, which is what `[]` means.
 *
 * IT IS THE LISTING PATH FOR EVERY PRUNING RULE AND NOT FOR EVERY LISTING, and the
 * round that introduced it recorded the wider claim ("the only listing path for
 * every rule"). `collectRunIds` still reads its four roots through the swallowing
 * `listDirs`, so the KEEP SET is built from listings that cannot fail. No
 * behavioural consequence today, and the reason is a coincidence worth stating
 * rather than relying on: `collectActions` lists the same four RUN_SCOPED_DIRS
 * through this function, so every failure `collectRunIds` swallows is recorded by
 * another caller within the same sweep. A rule that ever reads a root ONLY through
 * `collectRunIds` would be silent again.
 */
function listRoot(root: string, unlistable: RootFailure[]): { dirs: string[]; files: string[] } {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    return {
      dirs: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      files: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (errno !== 'ENOENT') unlistable.push({ root, errno });
    return { dirs: [], files: [] };
  }
}

/**
 * ONE RULE'S FAILED LISTING, exactly as it was measured: which path, and which
 * errno. Both halves, because a remedy derived from the path alone was wrong
 * about the path and a remedy derived from nothing at all was wrong about the
 * verb.
 *
 * It is deliberately NOT the thing a notice reports. `root` is where a RULE
 * happened to look; the directory a user must act on is whatever the walk in
 * blameDirectory finds, and the two are the same path only when the fault is at
 * the exact level some rule enumerates.
 */
interface RootFailure {
  readonly root: string;
  readonly errno: string;
}

/**
 * The directory a user can actually act on, and what is wrong WITH IT.
 *
 * Distinct from RootFailure on purpose: this is an answer about the FILESYSTEM,
 * derived by asking it level by level, where that one is an answer about which
 * rule tripped first.
 */
interface UnreachableRoot {
  /** The directory whose own mode or kind is the fault. */
  readonly dir: string;
  /** The errno that is true of `dir` itself — re-measured there, not inherited. */
  readonly errno: string;
  /**
   * Can `dir` ITSELF be enumerated? `false` is the LIST clause; `true` means the
   * listing works and what was refused is traversal INTO it — a missing search
   * bit, which no listing errno reports.
   *
   * The two capabilities are the file's central distinction (see listRoot and
   * directoryEnterable) and this is where the distinction survives being carried
   * to a level nobody enumerated. Getting it wrong is not cosmetic: reporting a
   * traversal fault as a failed listing is a sentence that is false about a
   * directory `readdir` answers perfectly well, which the mode table caught at
   * `runs/` 0o400/0o444/0o600 the first time this walk fed the wrong channel.
   */
  readonly listable: boolean;
}

/**
 * Why a listing failed, walked to the directory that owns the failure.
 *
 * ── WHAT THIS REPLACED, AND WHY THE REPLACEMENT IS A DIFFERENT KIND OF ANSWER ─
 * `shallowestUnreachable(unlistable, untraversable)` claimed to name "the
 * shallowest unreachable directory". It named the shallowest member of THE SET OF
 * ROOTS SOME RULE HAPPENS TO ENUMERATE, because that is the only set it was
 * given: a failed listing was dropped when an ancestor of it was ALREADY IN THAT
 * REPORTED SET, so the culprit was named only when a rule happened to enumerate
 * the culprit's own level. `runs/` is in that set (three rules `readdir` it),
 * which is why the repair looked complete on a table that varies ten modes of
 * `runs/` and nothing else. `runs/<id>`, `reports/`, `digests/<id>` and
 * `.traffic-one` itself are enumerated by NO rule, so when one of THEM carried
 * the bad mode the notice reported that directory's CHILDREN and prescribed
 * `chmod` on paths whose own modes were `0o755`.
 *
 * MEASURED, by executing exactly the command the notice printed and re-measuring
 * the plan (18 arms, uid 502): at `runs/<id>` 0o000 the printed
 * `chmod u+rx <runs>/<id>/debug` FAILS with permission denied; at `reports/` 0o000
 * both printed chmods fail; at `.traffic-one` 0o000 all three printed commands
 * fail, including the `rm -f` the SUSPENDED notice beside it prints. Five of
 * eighteen arms printed a command that could not be run at all.
 *
 * DERIVING USER-FACING ADVICE FROM A LIST BUILT FOR ANOTHER JOB IS THE STRUCTURAL
 * MISTAKE, and it is worth naming as one rather than fixing as an instance: the
 * enumeration exists so rules can find work, and it is complete for that. Reading
 * it as "the directories that can be at fault" imports a bound that was never
 * about faults. So this asks the filesystem instead, and every level of the answer
 * is a syscall rather than a membership test.
 *
 * HOW THE WALK DECIDES, which is the part that has to be right level by level: a
 * `readdir` of X can fail because of X's own mode, or because X cannot be REACHED
 * at all — and reaching X is the PARENT's search bit, nothing to do with X. The
 * discriminator is therefore an `lstat` of X, which needs exactly that search bit
 * and does not follow a link: it succeeds ⇒ X exists and X is the fault, stop; it
 * fails with EACCES/EPERM/ENOTDIR/ELOOP ⇒ the obstacle is above X, so ascend and
 * ask again. `lstat` rather than `stat` because a self-referential symlink answers
 * ELOOP to `stat` at every level and would walk the blame straight past the link
 * that is the whole problem.
 *
 * THE ERRNO IS RE-MEASURED AT THE DIRECTORY THIS NAMES rather than inherited from
 * the rule's failure, because they are answers about different paths: at `runs/`
 * 0o400 a rule's `readdir` of `runs/<id>` fails EACCES while `readdir` of `runs/`
 * itself succeeds — the fault there is a missing SEARCH bit, which no listing
 * errno reports. When the re-measured listing succeeds, EACCES is what is left
 * (something refused us and it was not the listing), and `chmod u+rx` is exactly
 * right for it.
 *
 * BOUNDED AT THE PROJECT DIRECTORY. Above it the walk would be describing the
 * caller's environment rather than this project's state, and the sweep was HANDED
 * that path — it did not choose it. A fault at the bound names the bound, which is
 * still a directory the user can act on.
 */
const PARENT_OBSTACLE_ERRNOS: readonly string[] = ['EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'];

function listErrno(dir: string): string | null {
  try {
    fs.readdirSync(dir);
    return null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  }
}

/**
 * EVERY VERB THIS FILE CAN PRINT WITH A PATH AFTER IT, spelled once so that the
 * runnability question below can be asked of ALL of them rather than of the two
 * somebody remembered.
 *
 * That is the single named source the round-16 review asked for: not a list of
 * OBSTACLES, which is the thing nobody can enumerate, but a list of VERBS, which
 * the file itself knows.
 *
 * ── THE FENCE THIS SENTENCE PROMISED DID NOT EXIST, AND THE ABSENCE COST ONE
 * ── WHOLE ADDRESS. Recorded rather than reworded away, because it is this lane's
 * named failure mode in a docblock: the paragraph here read "__tests__/
 * retention.test.ts scans this file's own source for the verbs it interpolates a
 * rendered path after and asserts the set equals this one, so a fifth verb reds
 * here instead of shipping ungated." Grepped: the fence contained no such row and
 * no mention of this type. Meanwhile `touch` sat in this union with a probe below
 * validated against /usr/bin/touch, and ZERO call sites asking it — so the UNAGED
 * list printed four `touch` commands at a `reports/lighthouse/` of 0o400, none of
 * which ran, under a notice that came back byte-identical. A claimed fence is
 * worse than an absent one: it is why nobody looked.
 *
 * The row exists now — "every verb this file can PRINT goes through the
 * runnability gate" — and it asserts what is actually checkable rather than what
 * reads well: every verb declared here reaches the probe through
 * `agentRunnableCommand` or `commandWouldRun` at least once, and every verb this
 * file spells inline with a rendered argument after it is declared here. It reds
 * on a fifth verb in either direction, and it red on `touch` the moment it was
 * written.
 */
type RemedyVerb = 'chmod u+rx' | 'rm -f' | 'rm -rf' | 'touch';

/**
 * WOULD THIS COMMAND SUCCEED — asked of the KERNEL, by attempting the same
 * authorization the command needs, and not by reasoning about which obstacles this
 * file has heard of.
 *
 * ── WHY THE PREVIOUS SHAPE COULD NOT BE FIXED BY ADDING A CASE ───────────────
 * This replaces `pathReachableBy(target, followsLinks)`, which asked `stat`/`lstat`
 * — RESOLUTION — and answered as though resolution were the only way a verb fails.
 * Round 16 closed three addresses with it and reported the "prints a command that
 * cannot be run" class closed. It was not. Measured since, each one a printed
 * command executed through /bin/sh with the sweep re-run either side
 * (load 3.35–6.79):
 *
 *   backups/ at 0o000 AND `chflags uchg`   `stat` SUCCEEDS, so the old predicate
 *     — Finder's "Locked" checkbox, what   answered TRUE. Notice printed
 *     a Time Machine restore leaves        `chmod u+rx …/backups`, which FAILED
 *     behind, `chattr +i` on Linux         "Operation not permitted". 1 notice,
 *                                          BYTE-IDENTICAL after, plan 19 → 19
 *                                          against a healthy 21. (The round-16
 *                                          review's finding 4, re-derived.)
 *   `.traffic-one` at 0o555 with a         `lstat` of the FILE succeeds, so the old
 *     corrupt retention.json               predicate answered TRUE. SUSPENDED
 *                                          printed `rm -f …/retention.json`, which
 *                                          FAILED "Permission denied" — an
 *                                          ordinary mode bit on the PARENT, on the
 *                                          axis round 16 says it varies
 *                                          exhaustively. Found here, by hand.
 *   digests/ a regular file, with          `rm -rf` printed, FAILED "Permission
 *     `.traffic-one` at 0o555              denied", notice byte-identical.
 *   digests/ a regular file carrying       `rm -rf` printed, FAILED "Operation not
 *     `uchg`                               permitted", notice byte-identical.
 *   a `uchg` artefact in the UNAGED list   `touch` printed, FAILED "Operation not
 *                                          permitted". The one site with no gate
 *                                          of any kind.
 *
 * AND THAT LAST SITE WAS MEASURED AND THEN NOT FIXED, which is recorded here
 * because the omission is more instructive than the fix. The round that wrote this
 * probe routed three sites through it and left the fourth — so `touch` was
 * declared a remedy verb, given a probe validated against /usr/bin/touch, and
 * never asked. It needs no exotic flag to reach, either: `reports/lighthouse/` at
 * an ordinary 0o400 LISTS and does not SEARCH, so the listing that finds the
 * artefacts succeeds while every stat under it fails EACCES — this notice's own
 * second cause. Driven (load 1.42): 4 artefacts, 4 `touch` commands printed, 0 of
 * them ran, notice BYTE-IDENTICAL on the next sweep; and 1 of 1 at `debug/` 0o400.
 * announceUnagedArtefacts asks now, and the fence row named in RemedyVerb's
 * docblock is what makes a fifth omission red rather than wait for someone to
 * drive its address.
 *
 * SIX ADDRESSES WERE KNOWN AND FOUR MORE WERE FOUND BY HAND IN ONE SESSION, three
 * of them here and one by the review. A space where two independent hands each find
 * new members on first inspection is not a space an enumeration is tracking, and
 * the derivation cannot enumerate it in principle: `stat` cannot see a BSD file
 * flag, a Linux immutable attribute, an ACL, a mandatory-access-control label, a
 * read-only mount or an owner that is not this process. So the question asked here
 * is not "which obstacle is this" but "does this operation get permission", which
 * is one syscall and is obstacle-AGNOSTIC — a seventh obstacle class needs no edit
 * because it answers through the same call.
 *
 * ── WHAT EACH PROBE ASKS, AND WHY IT IS SAFE TO ASK IN A DRY RUN ─────────────
 * Every probe is a call the kernel authorizes exactly as the command does and then
 * performs NO change. Measured per obstacle against the real verb, 28 cells
 * (section I): the probe and `/bin/chmod`, `/bin/rm`, `/usr/bin/touch` agree on
 * all 28.
 *
 *   `chmod u+rx`  `chmod(target, the mode it already has)`. chmod's authorization
 *                 is "are you the owner", which does not depend on the bits
 *                 requested (no setgid/setuid bit is in `u+rx`), so a no-op mode
 *                 change is authorized exactly when the real one is. It resolves
 *                 the same way too — `chmod` follows a symlink, and so does this.
 *   `rm -f`       `lstat` (the entry must be nameable — `rm` acts on the ENTRY, so
 *   `rm -rf`      removing a dangling link is a perfectly good act and this file
 *                 relies on that), `access(parent, W_OK|X_OK)` (the capability
 *                 `unlink` needs from the directory it removes from), and
 *                 `rename(entry, entry)`, which POSIX requires to "return
 *                 successfully and perform no other action" for the same entry and
 *                 which macOS authorizes first: measured EACCES for a parent at
 *                 0o555 and EPERM for a `uchg` entry, matching `rm` exactly.
 *   `touch`       `access(target, W_OK)`, which is the permission `utimes` needs,
 *                 with ONE fallback: POSIX lets the OWNER set the stamps to now
 *                 without the write bit, so an EACCES on a path we own is still a
 *                 `touch` that runs (measured: an owned 0o444 file, `touch`
 *                 SUCCEEDS). `stat` and not `lstat` for that ownership question,
 *                 because `touch` follows the link — this was `lstat` in the first
 *                 draft of this probe and it was the ONE cell of 28 that disagreed
 *                 with the real verb, answering "yes, we own it" about a LINK whose
 *                 target we cannot reach.
 *
 * NOT ONE OF THEM WRITES, AND NOT ONE OF THEM MOVES A TIMESTAMP, with a single
 * exception that is fenced rather than argued: a `chmod` that SUCCEEDS moves the
 * target's ctime (measured; mtime is untouched, and a chmod that FAILS moves
 * nothing). ctime is read by exactly one thing in this file — `entryAge`'s
 * substitute clock, consulted ONLY when mtime is untrustworthy — so the attempt is
 * withheld under precisely that condition and the answer falls back to ownership.
 * The residue is then that on an entry whose own mtime is not behind this host's
 * clock, a flag or a read-only mount is NOT detected and a `chmod` may still be
 * printed for it. That is the state the UNAGED notice is already about, and the
 * direction of the error is a printed command rather than a lost artefact.
 *
 * ── WHAT IS STILL UNDETERMINED, because no host here can answer it ───────────
 * Every figure above is darwin 25.5.0, APFS, one uid. Two halves are platform
 * behaviour rather than POSIX and are NOT measured on Linux: `rename(p, p)`, whose
 * authorization Linux's `vfs_rename` appears to skip via an early `source ==
 * target` return (which would make that half of the `rm` probe fail OPEN there —
 * the `access(parent)` half still carries the parent-mode case), and `access`
 * answering EPERM for an immutable entry, which is how the `touch` and `rm` probes
 * see `uchg` here. On Linux those two obstacles would go undetected and the printed
 * command would fail as it does today; nothing gets WORSE, and the gap is a
 * measurement this repo cannot take. A foreign-OWNED directory is likewise
 * UNDETERMINED as a driven arm — it needs a second uid — but it is not a gap in the
 * instrument: the attempt returns EPERM for it by construction.
 */
const REMEDY_PROBE: Readonly<Record<RemedyVerb, (target: string) => boolean>> = {
  'chmod u+rx': (target) => {
    let stat: fs.Stats;
    try { stat = fs.statSync(target); } catch { return false; }
    // The attempt's only side effect is this target's ctime, and this is the exact
    // condition under which entryAge reads one. See the docblock.
    if (trustworthyAgeSince(stat.mtimeMs, Date.now()) === null) return processOwns(stat);
    try { fs.chmodSync(target, stat.mode & 0o7777); return true; } catch { return false; }
  },
  'rm -f': (target) => removalWouldRun(target),
  'rm -rf': (target) => removalWouldRun(target),
  touch: (target) => {
    try { fs.accessSync(target, fs.constants.W_OK); return true; } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES') return false;
      try { return processOwns(fs.statSync(target)); } catch { return false; }
    }
  },
};

function processOwns(stat: fs.Stats): boolean {
  // `getuid` is absent on Windows, where there is no answer to give: an unowned
  // question falls back to "we cannot establish it", which withholds the command.
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  return uid !== null && (uid === 0 || stat.uid === uid);
}

/**
 * Does this path RESOLVE — the one fact that separates the two errnos in the
 * not-a-directory class, asked once so the remedy sentence and the outlook
 * sentence in the same notice cannot answer it differently.
 *
 * They did. `NOT_A_DIRECTORY_ERRNOS` is ['ENOTDIR', 'ELOOP'] and the remedy half
 * was composed per this fact while the outlook half was not, so a notice could say
 * "this sweep could not follow that chain, so it does not know whether anything of
 * yours is behind it" and close, two lines later, with "nothing of this project's
 * can be inside what is there now". See unreachableOutlook for the measurement.
 */
function pathResolves(dir: string): boolean {
  try { fs.statSync(dir); return true; } catch { return false; }
}

/**
 * Can any verb NAME this entry — which is a smaller question than whether a verb
 * would succeed on it, and the two are kept apart on purpose. See announceSuspension,
 * where one sentence is about naming and a different one is about removing.
 */
function pathReachableBy(target: string, followsLinks: boolean): boolean {
  try {
    if (followsLinks) fs.statSync(target); else fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function removalWouldRun(target: string): boolean {
  try { fs.lstatSync(target); } catch { return false; }
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK | fs.constants.X_OK); } catch { return false; }
  try { fs.renameSync(target, target); return true; } catch { return false; }
}

/** Would this exact command, at this exact path, run? */
function commandWouldRun(verb: RemedyVerb, target: string): boolean {
  try { return REMEDY_PROBE[verb](target); } catch { return false; }
}

/**
 * THE RENDERING AND THE RUNNABILITY IN ONE CALL, so a site cannot take the first
 * and skip the second.
 *
 * `agentRunnablePath` answers "may this path be spoken as a shell argument at all"
 * (redaction, backticks); this answers "and would the command built out of it
 * work". Both have to hold before a notice prints a line a reader will paste, and
 * five rounds of this lane put those two questions at different sites.
 */
function agentRunnableCommand(verb: RemedyVerb, file: string): string | null {
  const quoted = agentRunnablePath(file);
  if (quoted === null) return null;
  return commandWouldRun(verb, file) ? `${verb} ${quoted}` : null;
}

/** Is the obstacle ABOVE this entry rather than the entry itself? */
function parentIsTheObstacle(dir: string): boolean {
  try {
    fs.lstatSync(dir);
    return false;
  } catch (err) {
    return PARENT_OBSTACLE_ERRNOS.includes((err as NodeJS.ErrnoException).code ?? '');
  }
}

function blameDirectory(dir: string, errno: string, projectDir: string): UnreachableRoot {
  const start = path.resolve(dir);
  const stop = path.resolve(projectDir);
  let current = start;
  while (current !== stop) {
    const parent = path.dirname(current);
    if (parent === current) break;
    if (!parentIsTheObstacle(current)) break;
    current = parent;
  }
  // The errno and the capability are measured AT the directory this names, because
  // the caller's errno is an answer about a different path once the walk has moved.
  const measured = listErrno(current);
  if (measured !== null) return { dir: current, errno: measured, listable: false };
  // It lists, so what refused the caller was the search bit — the only capability
  // left. A NON-mode errno is not re-diagnosed that way: re-measuring a transient
  // failure is a second sample of a flapping condition, not a correction of it, so
  // the rule's own measurement stands.
  return faultClass(errno) === 'mode'
    ? { dir: current, errno, listable: true }
    : { dir: current, errno, listable: false };
}

/**
 * Is THIS DIRECTORY the reason a read inside it failed, and if so which directory
 * is the one to act on? `null` means the directory is fine and whatever failed
 * failed for its own reasons.
 *
 * The second caller of the walk above, and the one that removes the last `runs/`
 * special case: the UNAGED channel used to decide "was the parent the cause?" by
 * comparing against `runs/` by name, which is true of one level of one directory.
 */
function directoryFault(dir: string, projectDir: string): UnreachableRoot | null {
  const errno = listErrno(dir);
  if (errno === null) return null;
  return blameDirectory(dir, errno, projectDir);
}

/**
 * WHAT A FAILED LISTING LICENSES SAYING, which is a question about the errno and
 * was being answered as though it were always a question about a mode bit.
 *
 * `listRoot` records a root on ANY non-ENOENT failure, and the notice then said "a
 * mode bit is the whole problem here" and printed a `chmod`. ENOENT was excluded
 * as knowledge and nothing else was classified — in a file that discriminates read
 * errnos at two other sites (TRANSIENT_READ_ERRNOS, NOT_A_FILE_ERRNO) and says
 * there, in writing, that a read failure is not one fact.
 *
 * MEASURED: with `runs/` replaced by a REGULAR FILE the notice printed
 * `chmod u+rx <runs>`, which SUCCEEDS and moves the plan 2 → 2 where a real
 * directory plans 14 — a remedy that reports success and changes nothing, which
 * is the worst of the three failure shapes because the reader has no signal at
 * all. With `runs/` a symlink LOOP the same `chmod` fails "No such file or
 * directory".
 *
 * THE FALLBACK IS THE HONEST ONE, and that is the whole point of writing it as an
 * enumeration: an errno this file has not thought about lands in `opaque`, where
 * the notice names it and prints NO command. The previous shape's default was
 * `mode`, so every unconsidered errno arrived pre-diagnosed as a permission bit —
 * EIO on a failing disk included.
 */
type FaultClass = 'mode' | 'kind' | 'transient' | 'opaque';

const MODE_BIT_ERRNOS: readonly string[] = ['EACCES', 'EPERM'];
/** Something is at that path and it is not a directory: no mode bit can fix it. */
const NOT_A_DIRECTORY_ERRNOS: readonly string[] = ['ENOTDIR', 'ELOOP'];

function faultClass(errno: string): FaultClass {
  if (MODE_BIT_ERRNOS.includes(errno)) return 'mode';
  if (NOT_A_DIRECTORY_ERRNOS.includes(errno)) return 'kind';
  if (TRANSIENT_READ_ERRNOS.includes(errno)) return 'transient';
  return 'opaque';
}

function listFiles(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// A nested `.traffic-one/.one.json` is a LEAK (safe to remove) ONLY when it does not
// belong to its OWN independent project. We delegate that judgement to
// resolveProjectRoot — the single source of truth the write-side and every gate use —
// so cleanup can never disagree with the resolver. A genuine independent onboarded
// project (a mode-bearing `.one.json` with NO workspace ancestor) resolves to ITSELF
// and is kept; a monorepo sub-package's stray/leaked state (the packages/ui incident)
// resolves UP to the enclosing workspace root, so it differs from its own dir and is a
// deletion candidate.
//
// It asks the resolver a STRICTER question than a gate does, and the asymmetry is the
// point. `workspaceAuthority: 'membership'` demands that an ancestor's workspace
// declaration actually CLAIM this directory — some declared pattern matches it, or
// matches an ancestor of it below the root — before that declaration may move it off
// its own root. Under the default `declared` authority the mere PRESENCE of a
// `workspaces` key is enough, which is right for resolution and catastrophic here.
// MEASURED on the polyglot workspace fixture: a container declaring
// `workspaces: ['packages/*']` with no `packages/` directory anywhere on disk made
// three independently onboarded projects — node, Go and Python — climb past their own
// mode-bearing `.one.json`, and this function reported all three as leaks. The Go and
// Python members are not npm packages at all and could not have been members of that
// declaration under any reading of it.
//
// So the leniency that is correct one line up is a data-loss bug one line down, and it
// is the DIRECTION of the failure that separates them. An unreadable or unparseable
// declaration still anchors resolution — a hook that guesses wrong there mints a stray
// `.traffic-one` into a sub-package, which the next sweep heals — and grants no
// deletion authority at all, because a hook that guesses wrong HERE destroys a
// project's whole run history and its state file, and nothing heals that. (The
// hand-authored documents survive it, but only because the delete path carves them
// out; the guess is still wrong and everything else is still gone.) "We could not
// tell" must never resolve to the irreversible act. That is why the reader in
// hook/workspace-declaration.ts answers `opaque` rather than guessing, and why every
// declaration shape it declines lands on the keep side.
//
// The membership arm of the resolver's leak rule is untouched, so stray state inside a
// real repository (the observed mercury/strategies case, which has no npm workspace
// anywhere in it) is still reported and still healed.
//
// POSITIVE EVIDENCE is a second keep, and it is the one this function used to
// lack. A nested directory that already carries a plan, run digests, a local
// consent record, or `onboardingComplete` is a PROJECT — leftover debris does
// not look like that. The resolver comparison still answers "this dir is not
// its own root" for an onboarded member sitting under a workspace declaration,
// and without this fence the next SessionStart deleted that member's history.
// Consent is read INSIDE this nested `.traffic-one/` only: remapping through
// prefsCapableRoot would inherit a consented parent's answer and disable the
// sweep for every leftover under it.
function isRegularEntry(target: string, kind: 'file' | 'dir'): boolean {
  try {
    const stat = fs.statSync(target);
    return kind === 'file' ? stat.isFile() : stat.isDirectory();
  } catch {
    return false;
  }
}

/** Exact basename, so APFS/NTFS case-folding cannot turn `PLAN.MD` into `plan.md`. */
function hasExactNamedEntry(dir: string, name: string, kind: 'file' | 'dir'): boolean {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => (
      entry.name === name && (kind === 'file' ? entry.isFile() : entry.isDirectory())
    ));
  } catch {
    return false;
  }
}

function digestTreeHasEntries(dir: string): boolean {
  if (!isRegularEntry(dir, 'dir')) return false;
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function nestedRootHasProjectEvidence(projectDir: string, state: unknown): boolean {
  const dir = path.resolve(projectDir);
  const traffic = path.join(dir, STATE_DIR);
  if (hasExactNamedEntry(traffic, 'plan.md', 'file')) return true;
  const runs = path.join(traffic, 'runs');
  if (hasExactNamedEntry(traffic, 'runs', 'dir')) {
    try {
      for (const entry of fs.readdirSync(runs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (digestTreeHasEntries(path.join(runs, entry.name, 'digests'))) return true;
      }
    } catch {
      // A runs/ we cannot list is not evidence; keep looking.
    }
  }
  // run-sim (and some hosts) write project-level digests here, not under runs/.
  // An empty leftover `digests/` directory is runtime debris, not a project.
  if (hasExactNamedEntry(traffic, 'digests', 'dir')
    && digestTreeHasEntries(path.join(traffic, 'digests'))) return true;
  const sessions = path.join(traffic, '.onboarding-main-sessions.json');
  if (hasExactNamedEntry(traffic, '.onboarding-main-sessions.json', 'file')) {
    const read = readJsonResult<unknown>(sessions);
    const recorded = obj(read.kind === 'ok' ? obj(read.value)?.sessions : null);
    if (recorded && Object.keys(recorded).length > 0) return true;
  }
  const prefs = path.join(traffic, 'preferences.json');
  if (hasExactNamedEntry(traffic, 'preferences.json', 'file')) {
    const read = readJsonResult<unknown>(prefs);
    const pluginUse = obj(read.kind === 'ok' ? obj(read.value)?.pluginUse : null);
    if (pluginUse && typeof pluginUse.enabled === 'boolean') return true;
  }
  const rec = obj(state);
  return rec !== null && rec.onboardingComplete === true;
}

function isLeakedNestedRoot(projectDir: string, notices?: string[]): boolean {
  const dir = path.resolve(projectDir);
  // The same ruling, applied one level closer to home: the STATE FILE must be
  // legible before the resolver's answer about it may license a deletion.
  // `resolveProjectRoot` reaches that answer through committedProjectState
  // (hook/paths.ts), which folds corrupt, unreadable and absent into one `null`
  // — right for a resolver, whose worst case is anchoring a level too high, and
  // fatal here. A nested `.one.json` that merely FAILED TO PARSE makes the walk
  // climb past this directory, so the comparison below reports a leak and the
  // nested project's entire tree is scheduled.
  //
  // The trigger is routine, not exotic. `.one.json` is a TRACKED file holding
  // `currentRunId`, so two branches that each ran Traffic One conflict on it and
  // `git merge-file` leaves non-parsing bytes behind — and SessionStart, which
  // sweeps in delete mode, is the first thing that runs after the merge.
  //
  // `absent` cannot reach here (listNestedTrafficOneDirs already required the
  // file to exist) and would be a legible answer anyway; only `corrupt` and
  // `unreadable` are ignorance, and refusing all three is the same posture the
  // catch below takes toward an indeterminate resolution.
  //
  // `kind === 'ok'` alone was a SYNTACTIC gate claiming a semantic one: JSON
  // parses `"hello"`, `[1,2]` and `7` perfectly well, and none of them is a
  // state record. `committedProjectState` reads such a file as no state at all
  // and the walk climbs past this directory, which is the same deletion the
  // corrupt case would have licensed — reached through a file we could read and
  // still could not understand. `obj` is the narrowing every other reader of
  // this file already uses, so "we could not tell" lands on keep here too.
  const state = readJsonResult<unknown>(path.join(dir, STATE_FILE));
  if (state.kind !== 'ok' || !obj(state.value)) {
    announceIllegibleNestedRoot(path.join(dir, STATE_FILE), state, notices);
    return false;
  }
  try {
    if (resolveProjectRoot(dir, undefined, { workspaceAuthority: 'membership' }) === dir) {
      return false;
    }
  } catch {
    return false; // never delete on an indeterminate resolution
  }
  if (nestedRootHasProjectEvidence(dir, state.value)) {
    announceKeptNestedProject(dir, notices);
    return false;
  }
  return true;
}

/**
 * The keep above, said out loud.
 *
 * It is the same category of statement announceSuspension makes — this sweep
 * will not touch something until the USER repairs a file only they can — and it
 * was the one place in this file that took a suspension WITHOUT announcing it.
 * MEASURED before this line existed, on a leaked `apps/web` root whose nested
 * `.one.json` held git conflict markers: `planned: [], notices: 0`. A
 * root-LEVEL illegible `.one.json` gets a notice from announceSuspension and a
 * nested one got nothing, while the header's whole argument for tolerating a
 * suspension is that disclosure is the bound on it.
 *
 * The keep itself is right and is not in question: an unparseable nested state
 * file makes the resolver climb past its own directory, so "we could not tell"
 * would otherwise license scheduling that project's entire tree. What was wrong
 * is that nobody was told the heal had stood down.
 *
 * It REPEATS every sweep until the file parses, exactly as the policy-input
 * suspensions do, because the condition is still true every time — the stderr
 * copy is deduped per process, the returned answer is not (see
 * collectRetentionAnomaly).
 *
 * ── AND A TRANSIENT ERRNO IS NOT A BROKEN FILE HERE EITHER ───────────────────
 * The remedy paragraph used to be UNCONDITIONAL, which made this the sibling of
 * the defect announceSuspension had already fixed — see TRANSIENT_READ_ERRNOS,
 * whose docblock names this function and the measurement. A nested `.one.json`
 * that is byte-perfect on disk and answers EMFILE on the ONE OPEN of it (the read
 * is bounded through shared/bounded-read.ts, so the errno arrives at `openSync`
 * rather than at a bare `readFileSync` — a distinction that mattered, see the
 * FIXTURE guard in withStubbedReadFailure) got "Repair its JSON — do NOT remove
 * it" plus an invitation to remove the
 * directory by hand, with the errno interpolated and nothing saying it was
 * retryable; EACCES, which really is a fact about the file, produced byte-
 * identical text. So a reader could not tell the two apart in the one direction
 * where the difference decides what they should do — and this notice reaches an
 * LLM through retentionAdvisory and session-start.
 *
 * The SKIP itself is unchanged in every arm, and that is not a compromise: a
 * state file this sweep could not read cannot show the directory to be a leak,
 * whether the reason is durable or momentary. What a transient errno loses is the
 * REPAIR instruction (the file is very probably perfect) and the REMOVAL
 * invitation (nothing about a failed read licenses suggesting a user delete a
 * project's state root). The corrupt and not-a-record arms keep both, verbatim.
 *
 * ── AND A FIFO IS NOT A BROKEN FILE EITHER, IN THE OTHER DIRECTION ───────────
 * The third arm lands here for the same reason it lands at the sibling site: a
 * non-regular file at a nested `.one.json` got "Repair its JSON — do NOT remove
 * it, it carries that project's mode, currentRunId and onboarding stamps" about a
 * FIFO that carries none of them, with the one correct action forbidden. Unlike the
 * transient arm this one KEEPS a removal instruction and makes it the whole remedy,
 * scoped to the non-file entry rather than to the directory around it — see
 * nonRegularRead, where the spelling and its behavioural pin are recorded.
 */
function announceIllegibleNestedRoot(file: string, read: JsonRead<unknown>, notices?: string[]): void {
  const problem = read.kind === 'unreadable'
    ? `cannot be read (${read.errno})`
    : read.kind === 'corrupt'
      ? (read.text.trim() ? 'does not parse' : 'is empty, which does not parse')
      : 'is not a state record (valid JSON, but not an object)';
  // Gated on the removal actually running, the same way the sibling site is: the
  // sentence this composes is the whole remedy, and a `rm -f` that the kernel would
  // refuse reads as an instruction. See REMEDY_PROBE.
  const removalCommand = agentRunnableCommand('rm -f', file);
  const removal = removalCommand
    ? `run \`${removalCommand}\``
    : agentRunnablePath(file) === null
      ? 'remove that entry yourself — its own name cannot be spoken in this notice, so no command here could name'
        + ' the right path, and this one is an `rm`'
      : 'remove that entry yourself once you can — this sweep asked whether it could be removed and was refused,'
        + ' so an `rm` printed here would fail rather than help';
  const remedy = transientRead(read)
    ? TRANSIENT_REMEDY
    : nonRegularRead(read)
      ? notAFileRemedy(removal)
      : 'Repair its JSON — do NOT remove it, it carries that project\'s mode, currentRunId and onboarding stamps.'
        + ' If the directory is a leftover you do not want, remove it yourself; nothing here will.';
  collectRetentionAnomaly(
    notices,
    `SKIPPED — ${agentVisiblePath(file)} ${problem}, so this nested state root is left exactly as it is. A directory whose state`
    + ' file cannot be read cannot be shown to be a leak rather than a project of its own, and the sweep never'
    + ' deletes on that doubt.\n'
    + `  ${remedy} The next sweep decides normally as soon as that file reads cleanly.`,
  );
}

function announceKeptNestedProject(dir: string, notices?: string[]): void {
  collectRetentionAnomaly(
    notices,
    `KEPT — ${agentVisiblePath(path.join(dir, STATE_FILE))} belongs to a project `
    + '(plan, run digests, a local consent record, or completed onboarding), not leftover debris. '
    + 'This sweep will not delete it. Leftovers inside a recognised module stay advisory: if the directory '
    + 'is one you do not want, remove it yourself.',
  );
}

function listNestedTrafficOneDirs(cwd: string, notices?: string[]): string[] {
  const out: string[] = [];
  const root = path.resolve(cwd);
  const trafficDir = '.traffic' + '-one';
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.pnpm-store']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 50) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.name === trafficDir) {
        if (path.dirname(abs) !== root
          && fs.existsSync(path.join(abs, '.one.json'))
          && isLeakedNestedRoot(path.dirname(abs), notices)) {
          out.push(abs);
        }
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * Every entry in this leaked root the RUNTIME wrote — the ONLY entries the heal
 * may take, and after the inversion the whole safety boundary.
 *
 * ── WHY THIS DIRECTION, ONE MORE TIME ────────────────────────────────────────
 * The question is NOT "is this durable memory". Nothing can answer that about a
 * file nobody predicted, and three rounds of trying produced three reviews that
 * each found a hand-authored file planned for deletion. The question is "did the
 * runtime write this", which the runtime can actually answer, and the answer is
 * used to DELETE rather than to spare — so an INCOMPLETE answer leaves a file on
 * disk. The one answer that still deletes a human's file is an exact collision
 * with one of the fourteen paths, which is the residual exposure the header
 * names and the admission test below is against. Recognition has ONE source, and
 * reads nothing but entry names:
 *
 *   PATH — RUNTIME_ENTRY_PATHS, derived by expression from the paths this
 *   file's OWN rules schedule, plus `.one.json` (config/paths STATE_FILE) and
 *   the two materialization outputs. Not a hand-kept list: a rule added to the
 *   table above is recognised here with no edit, and a rule deleted stops being
 *   recognised. Each SEGMENT is compared EXACTLY — see below. Fourteen paths
 *   granting thirteen authorities (`runs/.once` sits under `runs`, which is
 *   already whole), closed and reviewable in one screen, which is what lets the
 *   `skills/` question below be asked of every one of them.
 *
 * A NEW RUNTIME ARTEFACT ADDED NEXT YEAR, stated plainly because it is the
 * question this design has to survive: if it gets a retention rule, the table
 * above names it and recognition follows for free. If it does not, it is NOT
 * recognised — it is left in place in a leaked root and reported as a leftover,
 * which is a bug report, not a data loss. That is the failure mode incompleteness
 * produces, and it is the one the ruling asks for; the other one — a user's own
 * entry sharing one of these fourteen paths — is bounded by the admission test
 * below rather than by this direction.
 *
 * ── THERE IS NO CONTENT ARM, AND DELETING IT WAS THE FIX ─────────────────────
 * There used to be a second source: isGenerated (materialize/generated.ts), an
 * unanchored substring scan for the GENERATED marker, recognising "any FILE the
 * runtime stamped, at any spelling". It looked like the arm that catches an
 * artefact nobody enumerated. MEASURED, it caught none and destroyed six.
 *
 * ITS TRUE-POSITIVE POPULATION IN THE SHIPPED PRODUCT IS ZERO. Driven through
 * the real writers (materialized-entries.test.ts runs materialization against an
 * installed plugin root and reads the result), the top level of a materialized
 * `.traffic-one` is exactly `.one.json`, `manifest.json`, `rules/`, `skills/`,
 * plus `agents/` on Codex — and NONE of them carries the marker; the probe
 * asserts that too. Every marker-carrying file materialization writes sits one
 * level down, under `rules/**` (materialize.ts), `skills/<name>/SKILL.md`
 * (copySkillDir) and `agents/<role>.md` (codex-agents.ts), where this function
 * never looks: it inspects TOP-LEVEL entry names, and isGenerated answered
 * `false` for a directory. opencode, kilo, windsurf, copilot (`.github/agents`)
 * and cursor write their host agent files outside `.traffic-one` entirely.
 * CODEX DOES NOT, and this sentence used to say it did: `CODEX_AGENTS_REL =
 * path.join('.traffic-one', 'agents')` (materialize/codex-agents.ts:34), which
 * is the one host whose agent files land INSIDE a state root — one level down,
 * under a directory the table deliberately excludes, so the true-positive count
 * is unchanged and the same docblock states it correctly 70 lines below. A
 * sentence that is the argument for why the deleted arm had no true positives
 * has to be true even where its conclusion survives being wrong.
 *
 * render-agents is the ONE exception, and it cuts the other way rather than
 * widening anything: preserveManualRootContext writes `.traffic-one/AGENTS.local.md`
 * and `CLAUDE.local.md`, which ARE top-level entries the runtime wrote — and
 * whose CONTENT IS THE USER'S, the hand-written root context preserved verbatim
 * before the generated file took the root over. Neither name is in the table
 * below and neither may join it: "the runtime wrote this entry" and "the runtime
 * may delete this entry" come apart exactly here. A leaked root holding one is
 * reduced and reports it, which is the correct answer for a file whose only copy
 * this is.
 *
 * ITS FALSE-POSITIVE POPULATION IS ORDINARY DOCUMENTS. The marker is public: it
 * is quoted verbatim in this repo's own AGENTS.md and described as public by
 * tool-classify.ts. Any file that mentions it was recognised as a runtime
 * artefact and deleted. MEASURED end to end through the apply sweep, on a
 * leaked `apps/web` root, one hand-authored file per row:
 *
 *   notes.md explaining the marker to a teammate       destroyed, 0 notices
 *   a pasted support thread quoting it                 destroyed, 0 notices
 *   a hand-authored rule template ending with it       destroyed, 0 notices
 *   the marker as a bare substring mid-line            destroyed, 0 notices
 *   a copy of our OWN shipped senior-eng-orchestrator/
 *     SKILL.md (line 888 carries the marker)           destroyed, 0 notices
 *   that note BESIDE a plain product.md                notes.md destroyed and
 *                                                      the ONE notice named
 *                                                      product.md — the file
 *                                                      that survived
 *
 * The mixed row is the worst: a user told about the file that is still there
 * while the other one is gone is worse served than by silence.
 *
 * NARROWING IT WAS TRIED ON PAPER AND REFUTED, so it is recorded here rather
 * than re-litigated. An EXACT LINE match fails on the three rows where the
 * marker already is its own line. A CANONICAL POSITION does not exist:
 * materialize.ts writes it first, copySkillDir last, render-agents at line 3.
 * CORROBORATION BY manifest.json authenticates genuinely and helps not at all,
 * because the manifest only ever lists paths under `rules/` and `skills/` —
 * already name-recognised, or deliberately excluded. The marker is public
 * documentation, so any content test over it is satisfiable by quotation.
 *
 * ── EXACT SPELLINGS, DELIBERATELY, AND WHY THE FOLD IS GONE ──────────────────
 * The removed implementation folded case, trailing dots/spaces and NFC, and then
 * asked the filesystem which entry each durable name resolved to (an inode
 * backstop). Both layers existed to make an allowlist of DURABLE names reach MORE
 * spellings — and on a recognition table every extra spelling reached is a
 * spelling that may now be DELETED. Folding here would be the same defect
 * pointing at data: `RUNS` is spared as an unrecognised entry (a leftover on the
 * one platform where it could be the runtime's own directory), and that is the
 * cheap side of the trade.
 *
 * This is also what DISSOLVES the Turkish dotted capital I, rather than fixing
 * it: `'İ'.toLowerCase()` is `i` plus U+0307, so `KNOWN-İSSUES.MD` folded to
 * nothing on the list, APFS keeps it genuinely distinct from `known-issues.md`
 * so the identity pass had no inode to match either, and the root went whole.
 * Here it is unrecognised, therefore spared, with no rule about Unicode anywhere
 * in this file. U+017F, U+212A, NFD, trailing dots and every case variant are
 * spared by the same default. There is no fold left to have a bug in.
 *
 * ── THE ONE DISAGREEMENT LEFT, RECORDED RATHER THAN HIDDEN ───────────────────
 * `skills/` is deliberately absent from the name table: the directory is MIXED —
 * the shipped project-memory rule tells users to put local skills such as
 * `security-check` there — so naming the entry would authorise deleting a
 * hand-authored bundle in order to reclaim a generated one. A GENERATED skill
 * bundle in a leaked root is therefore not reclaimed by this rule, while
 * removeGeneratedSkillDir (materialize/generated.ts) holds that the same bundle
 * IS reclaimable on a live project. The two modules disagree about a generated
 * skill bundle inside a leaked root, in the direction of a leftover. Closing
 * that would mean a recursive marker walk living here, which is deletion
 * authority derived from file CONTENT — the thing this function no longer does
 * at all; declined for that reason rather than overlooked.
 *
 * `agents/` is absent for the same reason and was found by the same probe.
 * Materialization writes `.traffic-one/agents/<role>.md` on CODEX ONLY, and
 * codex-agents.ts overwrites a file there only when it already carries the
 * generated marker, because "user-authored agents win". A directory whose own
 * writer promises to preserve a user's file is a directory this rule may not
 * empty. The cost lands where the disagreement above lands: on a Codex project a
 * leaked nested root is REDUCED, not healed, and reports `agents` as a leftover.
 *
 * `skills/` is also the TEST the rest of the table has to pass, and now can be:
 * for each scheduled path, does anything shipped tell a user to author something
 * under it? Run over EVERY SHIPPED MARKDOWN DOCUMENT — skills-catalog, rules, every
 * agent.md, gen/static AND the root documents gen/emit/static.ts copies into the
 * bundle (README, SUPPORT, KNOWN-ISSUES, PLATFORMS, PRIVACY, ref) — rather than
 * over four directories. The narrower corpus is how the `reports` row survived
 * three rounds: README.md:571 documents a writer under it and the audit could
 * not see the file. __tests__/materialized-entries.test.ts now pins the census
 * itself, file by file, so the next sentence a shipped document writes about one
 * of these paths fails a test instead of waiting for a reviewer — and it states
 * what that corpus is NOT. This used to read "the SHIPPED FILE LIST", which
 * overstates it by one channel: the product also PRINTS prose (hook denials,
 * directives, and skill-fallbacks.generated.ts, which is SKILL.md blocks compiled
 * into the runtime).
 *
 * MEASURED THERE, AND THE FIGURE NAMES ITS INSTRUMENT, because four readings give
 * four answers over one corpus and a bare number invites the next reader to treat
 * the disagreement as a defect. Reading: the census's own mention regex,
 * AUTHORING_VERB and 60-character window, over the STRING LITERALS of each of the
 * 685 non-test `.ts` files under `src/`, that file's literals JOINED WITH `'\n'` and
 * then windowed — because printed prose is assembled from adjacent literals a reader
 * perceives as one string, so a window that stops at a literal boundary stops at a
 * boundary nobody sees, and `'\n'` is the joiner THE PRODUCT ITSELF USES
 * (materialize/cursor-agents.ts `out.join('\n')`, asserted from that source by the
 * driver rather than remembered). THIRTY-FIVE rows on FIVE paths — `.one.json`,
 * `digests`, `manifest.json`, `reports/qa` and `runs` (load 13.71 of 10 CPUs). It
 * was THIRTY-FOUR until the window's left edge was snapped to a word boundary in
 * the live census (see authoringContext in __tests__/materialized-entries.test.ts)
 * and this channel was re-run to match: the thirty-fifth row is
 * `runs :: src/test-environment/core/run-sim/index.ts`, whose verb the fixed
 * offset opened inside. Nothing is lost by the snap under this reading, and the
 * five paths asserted to have no row still have none.
 *
 * The same driver over the same corpus, for the neighbouring readings, so the spread
 * is on the record rather than in a disagreement between rounds:
 *   PER LITERAL (mention and verb inside ONE literal)      18 rows / 3 paths
 *   JOINED WITH `'\n'`, `${…}` expression source KEPT      35 rows / 5 paths
 *   JOINED WITH `''` — round 13's joiner                   30 rows / 5 paths
 *   COMMENT-STRIPPED WHOLE SOURCE                          26 rows / 5 paths
 * The last one over-counts identifiers and expression syntax nothing ever prints.
 *
 * TWO FIGURES RECORDED HERE WERE WRONG, and both were wrong in the JOINER rather
 * than in the corpus, which is the half two rounds never compared:
 *
 *   "THIRTY rows on FIVE paths" for the adopted reading. Round 13's driver joined
 *   the literals with the EMPTY string while its prose adopted the reading the
 *   product prints. Edge-to-edge welds the last word of one literal onto the first
 *   of the next: `…contract` + `Write ONLY within…` becomes `ctWrite`, and
 *   AUTHORING_VERB's leading `\b` then refuses the verb. That loses exactly four
 *   rows, all `runs ::` — cursor-agents, copilot-agents, kilo-agents and
 *   windsurf-agents, the four writers of that one block. So the instrument
 *   contradicted the reading its own docblock adopted, and 30 answers a question
 *   about a string nothing assembles.
 *
 *   "dropping the expression source moves this instrument's answer by zero rows, so
 *   that hypothesis is refuted rather than assumed". It moves it by ONE row, and
 *   that row is an artefact of the WINDOW rather than of the corpus:
 *   plan-readiness/contracts.ts lists `runs/${runId}/architecture-v1.json` directly
 *   under `…/architecture-input-v1.json`, and 60 characters back lands INSIDE the
 *   word "input", so the slice opens `put-v1.json` and `\bput\b` matches a fragment
 *   of a noun against a boundary that is the SLICE's, not the text's. Collapsing
 *   `${runId}` shifts the left edge off that syllable and the row goes. The sharper
 *   reading is sharper for a reason, and the count is no longer "UNDETERMINED to a
 *   few rows either way" — which is what this paragraph conceded while both of its
 *   numbers came from one swapped joiner. (34 was the figure until the left edge was
 *   snapped; snapping fixes this same artefact at its cause, and the artefact row
 *   disappears from the expression-KEPT reading too — 35 rows both ways, one row
 *   swapped for another. See the paragraph below.)
 *
 *   Round 12's "27 ROWS ON FOUR PATHS" stands corrected as it stood: the path set
 *   was short by `manifest.json` (from shared/materialize/converge.ts) under every
 *   reading that windows a whole file, and the count was the comment-stripped
 *   reading, which answers 26 here. Round 12 collapsed `${projectRoot}` to one
 *   character, which pulls the return type `Record<string, unknown>` into the window
 *   and buys the twenty-seventh row.
 *
 * THE MANUFACTURED BOUNDARY IS A PROPERTY OF THE CENSUS, not of this side channel,
 * so it was measured where it would matter rather than left as a curiosity here —
 * AND THE FIRST MEASUREMENT LOOKED IN ONE DIRECTION ONLY. Recorded verbatim,
 * because it is the shape this lane keeps producing: a true sentence about the half
 * that was checked, read as a conclusion about both halves.
 *
 *   "recomputing the LIVE census with each verb's word boundary checked against the
 *    full document instead of against the slice answers 44 rows either way, with
 *    ZERO manufactured matches to discard. The hole is real and today it is empty,
 *    which is why AUTHORING_WINDOW is left alone rather than snapped to a word
 *    boundary: the change would move a pinned literal for no row."
 *
 * Manufactured POSITIVES were the half it checked, and that half is the SAFE one: a
 * spurious row keeps a name OUT of the recognised table, and a name out of the table
 * is a file that survives. The same missing boundary manufactures NEGATIVES, where a
 * missed row is how a name gets admitted on a census that could not see the
 * instruction. Re-measured in both directions over the 224 shipped
 * documents: 44 rows shipped, 46 snapped, 0 rows only the shipped window finds, 2
 * it MISSES — one of them on `fix-cycles`, a RECOGNISED path. The window is
 * snapped now (authoringContext), both censuses re-run, and the empty half is
 * intact under the new reading.
 *
 * WHAT DOES NOT MOVE, across all three readings and both instruments: every path in
 * the set already carries a census row from a shipped DOCUMENT, so no path moves
 * from no-row to row and no admission hides in this channel today; and the FIVE
 * paths asserted to have no row at all (`.codegraph-build-lock`, `.once`,
 * `.opencode-heal-lock`, `backups`, `runs/.once`) gain nothing here either —
 * `gained = []` on all four readings and under the snapped window as well, which is
 * the half that would have mattered. The reason the channel is not folded in is
 * churn, priced at the corpus pin.
 *
 *   `.once` and the two locks — mentioned nowhere in the shipped corpus.
 *     Runtime producers only.
 *   `debug` — SUPPORT.md:451 tells the user to `create ~/.traffic-one/debug/
 *     hook-trace.on`, which IS an authoring instruction, and it is for the HOME
 *     state root; listNestedTrafficOneDirs never leaves the project, so no heal
 *     can reach it. The project-level mention beside it names
 *     `.traffic-one/debug/hook-trace.jsonl` as OUTPUT. (An earlier version of
 *     this row said `debug` was "NOT MENTIONED ANYWHERE", which is the absolute
 *     wording that invites the next reviewer to stop looking.)
 *   `rules` — project-memory/SKILL.md:65 ("`.traffic-one/rules/**` generated
 *     active rule files only") and :105 ("Do not hand-create active rule or
 *     skill bundles"). A prohibition, which is the opposite of what fails here.
 *   `backups` — :98-99, local/ephemeral (the name is on :98 and the word that
 *     rules on it is on :99). traffic-one-doctor/SKILL.md:248 also tells
 *     that role "never delete `.traffic-one/backups/`", unqualified, while
 *     `backupKeep` prunes the directory by policy on every bootstrap. A
 *     legitimate difference in authority — a role instruction is not a retention
 *     policy — but not what a user reading the shipped skill would expect, so it
 *     is recorded here rather than left to be discovered.
 *   `reports/qa`, `reports/lighthouse` — the two paths the rules schedule, and
 *     the reason recognition is path-aware. `reports` ITSELF is a mixed
 *     directory in the shipped product: project-memory/SKILL.md:98-100 keeps it
 *     "local/ephemeral UNLESS THE USER EXPLICITLY ASKS TO PRESERVE A REPORT",
 *     token-usage-report/SKILL.md:105 has the assistant offer the user
 *     `--out .traffic-one/reports/tokens-<date>.md` "for archiving", and
 *     predeploy-security-check/SKILL.md:18 with README.md:571 write
 *     `.traffic-one/reports/security/`. An earlier version of this row read
 *     "`reports` and `backups` — :98, local/ephemeral; the only writers named
 *     are the Lighthouse and QA-evidence runners", which quoted the first half
 *     of a sentence whose second half contemplates the entry it authorised
 *     deleting, and named two writers where there are at least four.
 *   `manifest.json` — described as something "the materializer also created"
 *     (:112).
 *   `.one.json` — mentioned constantly and always as a file NOT to write by
 *     hand (gen/static/plugin-instructions.md:75, rules/common/onboarding.md:21).
 *   `runs`, `digests`, `fix-cycles` — mentioned with authoring verbs, and the
 *     discriminator these rows used to carry was WHO WAS ADDRESSED: the
 *     instructions speak to an AGENT ROLE and name "regenerable" state. Half of
 *     that is a claim about a process, and after this sweep takes `runs/` the
 *     inputs may be gone. The checkable half is what the rows say now, and it is
 *     stronger: all three are members of RUN_SCOPED_DIRS, so a rule in THIS FILE
 *     prunes them by policy on EVERY project, and sweepOldDigests
 *     (modules/session/session-start-lib.ts:147) independently keeps only the
 *     newest five digest runs everywhere. A human who keeps content of their own
 *     under those names loses it with or without a leaked root, so recognising
 *     them here adds no exposure that the ordinary sweep does not already carry.
 *     Driven, not argued: see the pin in __tests__/retention.test.ts.
 *
 * So the question is sharper than "is this name mentioned": it is whether a
 * HUMAN is told to put CONTENT OF THEIR OWN under it, content nothing else in
 * this file would take anyway. `reports` is not saved by either reading of that
 * discriminator, which is why it is fixed structurally above instead.
 *
 * TWO NAMES FAILED THIS TEST AND ARE GONE, for the same reason arrived at from
 * opposite ends. `logs` had neither a producer nor an instruction — see
 * TTL_ARTEFACT_DIRS. `retention.json` had NO PRODUCER EITHER (readPolicy is its
 * only reference in `src/`, and it reads) while carrying the one authoring
 * instruction on this list: a skill this product materializes into every project
 * tells the user to write it. That is strictly worse than `logs`, which was
 * merely a name a user might invent, and it was measured destroying a user's
 * policy file with zero notices. See POLICY_FILE, which now sits outside the
 * derived table for that reason. "Nothing in `src/` writes it" is the half of
 * both arguments a test can hold, and __tests__/materialized-entries.test.ts
 * holds it: every scheduled path must be SPELLED UNDER A STATE ROOT somewhere in
 * the source tree, and these two must not be. What that check can and cannot
 * see is stated at the assertion rather than here, because the previous version
 * of this sentence described a stronger check than the one that ran.
 *
 * ── AND THE NAMES THAT ARE NOT HERE AT ALL ───────────────────────────────────
 * More top-level entries the runtime writes into a project state root have no row
 * here and no retention rule anywhere in this file, between the same markers the
 * header's copy carries and for the same reason:
 *
 *   NO-RULE-LIST: `.gitnexus`, `graphify-out`, `overrides`, `deployments.jsonl`,
 *   `token-log.jsonl`, `one-mcp-report.json`, `graph-preview.md`,
 *   `qa-build-identity.json`, `.agentignore`, `.onboarding-main-sessions.json`,
 *   `onboarding`, `onboarding-complete.json`, `onboarding-server.json`,
 *   `onboarding-server.lock`, `preferences.json`, `machine.json`,
 *   `AGENTS.local.md`, `CLAUDE.local.md`, `.one.json.report-id.lock`,
 *   `.one.json.corrupt` :NO-RULE-LIST-END
 *
 * The four `onboarding*` names ARE SPELLED OUT, where this list used to write "the
 * four `onboarding*` entries". That shorthand was correct prose and it was the
 * stated reason this second enumeration was left out of the correspondence pin —
 * a token match cannot see four names in it, so requiring both lists would have
 * red on a sentence that was true. An enumeration a test cannot read is an
 * enumeration that drifts, which is the failure the header's own three missing
 * names are a record of, so the shorthand lost. The header enumerates the same
 * names with how each was re-derived; neither list quotes a SIZE any more, because
 * three names went missing in turn while the size and the list agreed with each
 * other.
 *
 * ── THE QUARANTINE COPY, WHICH IS THE ONE WITH THE MOST TO LOSE ──────────────
 * `.one.json.corrupt` is the strongest decline in this docblock, and it is argued
 * because the shape invites the opposite: it is unmistakably ours, it is not
 * hand-authored, and it looks like a stale artefact of a heal that already
 * happened. What it actually is: `state/normalize.ts:332` writes
 * `${filePath}${CORRUPT_STATE_SUFFIX}` beside `.one.json` when a state write
 * REPLACES bytes nothing could parse, so the file exists only where such a write
 * has already moved the original aside — it is the only surviving copy of that
 * project's `mode`, `stack`, `onboardingComplete`, `currentRunId` and durable
 * one-mcp report id.
 *
 * Three facts from the code decide it, none of them a preference:
 *
 *   NOTHING IN `src/` READS IT. It has no runtime consumer at all, which is what
 *     makes it look reclaimable and is exactly why it is not: a file whose only
 *     reader is a HUMAN is the `AGENTS.local.md` case, where "the runtime wrote
 *     this entry" and "the runtime may delete this entry" come apart. The
 *     recogniseEntries test — is a human told to author it? — is the wrong question
 *     for a file a human is told to RECOVER from.
 *   THIS FILE'S OWN NOTICE SENDS THE USER LOOKING FOR THOSE BYTES.
 *     announceSuspension, on an illegible `.one.json`, says "Repair its JSON — do
 *     NOT remove it, it carries this project's mode, currentRunId and onboarding
 *     stamps". Recognising the quarantine copy would authorise deleting the nearest
 *     thing to what that sentence tells the user to repair, in the one state where
 *     it exists. AND IT NOW NAMES THE PATH OUTRIGHT when the file is there
 *     (pointerCopies), where it used to point at `backups/` instead — a directory
 *     that cannot hold a pointer — so this decline is what keeps the notice's own
 *     remedy reachable rather than merely consistent with it.
 *   ANOTHER MODULE ALREADY CLASSIFIED THE FAMILY, and not as junk:
 *     runners/traffic-one-reset/obligations.ts files `run.json.corrupt` and
 *     `agents.json.corrupt` as EVIDENCE — "unparseable bytes nothing can read a
 *     bound out of, kept only so the loss is auditable". Those two are inside
 *     `runs/<id>/` and die with the run they belong to, which the runtime accepts;
 *     this one sits beside a state file that is still there, and no rule here has
 *     any business outliving it.
 * So it stays a leftover, and the temp siblings fsjson leaves behind on a SIGKILL
 * (`.one.json.<pid>.tmp` and its two longer spellings) stay leftovers with it, for
 * the reason the lock's `<token>` family gives below: the names cannot be
 * enumerated, so the only thing that could reach them is a prefix over
 * `.one.json*`, which is authority over the state file's whole name space.
 *
 * THE SAME RULING READ IN THE LEAKED-ROOT VOICE IS ODDER, and it is stated rather
 * than left for a reviewer to notice: `.one.json` IS recognised, so in a leaked
 * root the heal takes the state file and SPARES the quarantine copy lying beside
 * it. The sweep therefore preserves an unreadable copy of bytes whose referent it
 * has just deleted, and leaves it in a directory it has retired from this rule (the
 * next SessionStart sees no `.one.json`, so nothing mentions the residue again).
 * The reason is the global one and it does not weaken here: recognition is a table
 * of paths, the same table on every root, and the question it answers is "did the
 * runtime write this" — not "is this copy still worth anything given what else this
 * sweep is about to do", which is a judgement about CONTENT that this function does
 * not make anywhere. A user who lost a project's state to a leak has the only
 * surviving bytes of it in that file, which is the strongest version of the
 * argument, not the weakest.
 *
 * ── THE LOCK IS THE ONE WHOSE ADMISSION LOOKED EASY, SO IT IS ARGUED ─────────
 * `.one.json.report-id.lock` is unlike the other nineteen in three ways that all
 * point at admitting it: it is unmistakably ours (`state/project-state-lock.ts`
 * derives it from STATE_FILE), it is EPHEMERAL by intent, and in a leaked member
 * root nothing will ever reap it — the reaper runs only inside an acquisition on
 * that same `cwd`, and hooks in a leaked member resolve to the workspace root, so
 * the directory outlives the root the reduction retires. It is still declined,
 * and not on the residue argument:
 *
 *   ADMITTING THE BASE NAME BUYS NOTHING THE MOTIVATION ASKED FOR ON A ROOT THAT
 *     WAS EVER MATERIALIZED, and this is the reason that binds — under the
 *     qualifier, which it did not carry and which is load-bearing. Two facts, both
 *     from code in this fence:
 *       A MATERIALIZED ROOT IS REDUCED ANYWAY. `skills` is mixed by design and can
 *         never be recognised (two paragraphs up), and materialization writes it
 *         into every state root it touches — `agents` too, on Codex. So a leaked
 *         root that was ever materialized has a leftover before this lock is
 *         considered at all, `leftovers.length > 0` is decided without it
 *         (leakedRootActions), and the REDUCED notice fires either way. Admitting
 *         the lock there cannot turn a reduced root into a healed one; it can only
 *         shorten a list that still has `skills` on it. That matches the recorded
 *         cost table below, where the only leftovers on two of three measured
 *         shapes are exactly those two.
 *         AND THE UNQUALIFIED VERSION OF THAT SENTENCE WAS FALSE, on the shape a
 *         killed state write actually leaves. It read: "Admitting the lock cannot
 *         turn a reduced root into a healed one; it can only shorten a list that
 *         still has `skills` on it." A root holding `.one.json` and this lock and
 *         NOTHING ELSE is the ordinary residue of the ordinary failure, not a
 *         corner: state/normalize.ts:255 writes `.one.json` inside
 *         withProjectStateLock, and that lock's protocol is mkdir-then-rename
 *         (project-state-lock.ts:1053-1092 stages `<lock>.<token>.pending`,
 *         :1301-1313 renames to `<lock>.<token>.released` and removes it), so a
 *         holder killed mid-hold leaves exactly `<lock>` — no `skills/`, no token
 *         sibling, no materialization anywhere. DRIVEN over four shapes against a
 *         mutant that admits the name through EPHEMERAL_LOCKS
 *         (load 4.40 of 10 CPUs):
 *           `.one.json` + lock only    pristine 1 planned entry, REDUCED, root
 *                                      survives holding the lock; MUTANT one
 *                                      `<WHOLE ROOT>` action, ZERO notices, root
 *                                      gone. The exception.
 *           + `skills/`                REDUCED both ways, root survives both ways,
 *           + `notes.md`               leftover list one shorter. Unaffected, which
 *           + `<lock>.<token>.pending` is what the qualified claim says.
 *         So on that one shape admitting the name buys precisely what the
 *         motivation asked for. The DECLINE is unchanged, because the two reasons
 *         below do not depend on this one — the `<token>` family stays out of reach
 *         and admission still means editing a rule constant, i.e. project-wide
 *         deletion authority for zero bytes — but this is the THIRD round running
 *         in which this decline rested on a reason that was false while its verdict
 *         held, and by this file's own standard that is worse than no reason.
 *       AND IT CANNOT REACH THE FAMILY, which is the thing that made the lock look
 *         worth admitting. `<lock>.<token>.pending` and `<lock>.<token>.released`
 *         are top-level entries too, `<token>` being pid+time+random, and they are
 *         a real population rather than a corner: project-state-lock.ts records 22
 *         of them on ONE observed run, left by exactly the kind of killed process
 *         that leaks a member root in the first place. Exact-path recognition
 *         cannot cover them, so the PERMANENT leftover survives the admission, and
 *         what could reach it is a NAME PATTERN rather than a path — a PREFIX over
 *         `.one.json*`, which is authority over the state file's whole name space,
 *         including whatever a user put beside it and now including
 *         `.one.json.corrupt`, whose bytes are the user's only copy.
 *         THE WORD "ONLY" STOOD IN FRONT OF THAT PREFIX and it was wrong, which is
 *         recorded rather than quietly deleted: a regex narrowed to this family
 *         alone (`.one.json.report-id.lock.<token>.pending`/`.released` and nothing
 *         else) reaches the leftover without taking the name space, and no one had
 *         ruled it out. It moves no verdict, and that is a measurement rather than
 *         an argument — driven as exactly that widening, it is REFUSED by "the
 *         heal's partition is derived from the fixture's own listing", the pin
 *         that exists for names no enumeration can see, with both `<token>`
 *         siblings admitted 2/2 under an execution probe so the kill is on the
 *         widening and not on an absent fixture. The first spelling of that arm
 *         matched nothing at all — `[0-9a-z]+` crosses neither the `-` nor the dots
 *         in `report-id.lock.<hex>` — and survived 129/129 with ZERO admits on 181
 *         executions of the branch it edited: a widening that widens nothing, and
 *         the reason every survivor in this lane is probed before it is believed.
 *     So the trade is: zero bytes reclaimed (an empty directory — the cost table
 *     below says this name moves the byte columns not at all), the notice unchanged,
 *     against either a scheduling rule or a fourth constant. That is what decides
 *     it, and it does not depend on which shape the admission takes.
 *   IF IT WERE ADMITTED THROUGH EPHEMERAL_LOCKS, the TTL would also be wrong on its
 *     own terms, and this half is unchanged. The two names already there are
 *     ADVISORY FLAGS (a file whose presence means "a build is in progress"); this is
 *     a real mutual-exclusion lock whose protocol is mkdir-then-rename with an owner
 *     file, and whose own reaper decides on evidence this sweep does not have and
 *     will not read: an owner pid, a token, a dev+ino identity, and an age taken
 *     from the FILESYSTEM's clock rather than this process's (project-state-lock.ts
 *     spells out why the difference destroyed a live acquirer 3/3 when it was got
 *     wrong). A TTL here would be a second, blinder reaper on a protocol that has a
 *     correct one, and its failure mode is removing a directory a live holder is
 *     inside.
 *
 * THE REASON THIS DECLINE USED TO REST ON IS FALSE, and it is recorded rather than
 * replaced in silence, because the round before it removed one false reason and
 * installed another. It read: "MEMBERSHIP HERE MEANS A SCHEDULING RULE, and the
 * only rule shaped for it is EPHEMERAL_LOCKS — a TTL over a name on EVERY project",
 * and the TTL argument above was the conclusion drawn from it. Membership does NOT
 * mean a scheduling rule: THREE of the fourteen shipped paths have none.
 * `.one.json`, `manifest.json` and `rules` are recognised, no rule in
 * collectActions prunes them on a live project, and __tests__/retention.test.ts
 * enumerates exactly those three as UNPRUNED_RECOGNITION for that reason — the
 * behavioural pin cannot drive them. This docblock also concedes the same point
 * about sixty lines down ("SO A THIRD SHAPE IS GENUINELY AUTHORITY-FREE"), so the
 * false premise was contradicted in its own file. A decline resting on a false
 * reason is worse than no decline; the verdict is unchanged and the reason is now
 * the one that binds.
 * So it stays a leftover, and the two obligations that follow from that are
 * discharged rather than assumed: the notice no longer calls it a bug worth
 * reporting (announceReducedRoot), and the pin that would catch it being admitted
 * is a DERIVED partition over a fixture's own listing, because a name assembled
 * from an expression is invisible to every enumeration in this lane.
 *
 * ── THE DECLINE, AND THE REASON THAT ACTUALLY BINDS ──────────────────────────
 * NONE of them joins the table this round. The reason recorded here was NOT the
 * constraint that binds, and a decline resting on a false reason is worse than no
 * decline. It read: recognition is derived from the paths this file's rules
 * schedule, so a name cannot be added without a rule, and "adding the RULE first
 * is a new deletion authority on EVERY project".
 *
 * That second half is FALSE ABOUT THE CONSTANT, and the consumer census is one
 * line each: RECOGNITION has exactly ONE production consumer (leakedRootActions),
 * and RUNTIME_ENTRY_PATHS has exactly ONE (the trie above). Every other
 * occurrence of either name in `src/` is a comment or a test. A name added to
 * RUNTIME_ENTRY_PATHS therefore reaches the leaked-root heal and NOTHING else; no
 * project-wide authority follows from the constant.
 *
 * WHAT BINDS IS ONE LEVEL DOWN: the MEMBERS of RUNTIME_ENTRY_PATHS are the rule
 * constants themselves — RUN_SCOPED_DIRS, ONCE_DIRS, EPHEMERAL_LOCKS,
 * TTL_ARTEFACT_DIRS — so adding a name THERE means editing the rules, and the
 * rules are what schedule deletion on every project. That constraint is real and
 * it is the one the pins hold: the behavioural pin in retention.test.ts plants an
 * artefact under each recognised path on an ORDINARY project and requires a rule
 * to plan it, so a name with no rule reds, and a name given a rule to green it
 * has bought project-wide authority in a diff a reviewer can see.
 *
 * AND THE CONVERSE IS PINNED SEPARATELY, because it was not pinned at all and the
 * record here said otherwise. The sentence that stood in this paragraph called two
 * pins "what make 'derived, not transformed' checkable"; one of them is a match on
 * ONE LINE of this file's source text, and MEASURED on byte-identical copies, a
 * HEAL_ONLY list wired in one statement BELOW that line, or consulted inside
 * recogniseEntries' own `if (!child)` arm, left the whole 100-test suite green
 * while planning `AGENTS.local.md`, `graphify-out` and `token-log.jsonl` for
 * deletion on a leaked member root. What holds it now is behavioural and lives
 * beside the forward pin: a root planted with names the table does not spell, run
 * through the real APPLY sweep, with every one required to be a leftover, none
 * planned, and the notice's count required to account for all of them. That is
 * downstream of the trie, of this function's arms, and of anything post-hoc — so a
 * HEAL_ONLY list is still a diff a reviewer sees, and it reds until the pin's own
 * list is edited to say so.
 *
 * SO A THIRD SHAPE IS GENUINELY AUTHORITY-FREE, and it is declined on a measured
 * cost instead of on the false reason: a HEAL_ONLY list feeding ONLY
 * recognitionTrie, leaving RUNTIME_ENTRY_PATHS and every scheduling rule
 * untouched.
 *
 * ── WHAT THAT WOULD ACTUALLY COST, RE-RUN RATHER THAN RECITED ────────────────
 * The price recorded here was wrong in BOTH directions, and both halves are
 * re-measured with the project's own instruments (`producers()` and
 * `admissionCensus()` from __tests__/materialized-entries.test.ts, over all
 * eighteen names — EIGHTEEN is the population that was measured, and the
 * enumeration is twenty now: `.one.json.report-id.lock` and `.one.json.corrupt`
 * joined it after these runs. The lock is argued separately above, where its
 * decline rests on the shape of EPHEMERAL_LOCKS rather than on any figure below):
 *
 *   "A PRODUCER FOR EACH IN THE SOURCE TREE" IS ALREADY PAID. Fifteen of the
 *     eighteen have one under the STRICT instrument. Only `overrides`,
 *     `qa-build-identity.json` and `CLAUDE.local.md` have none — and the last two
 *     are instrument artefacts rather than absences (`qa-report-v2/schema.ts`
 *     spells `/.traffic-one/qa-build-identity.json` with a leading slash, which
 *     `producers()` refuses on purpose and the derivation admits; `CLAUDE.local.md`
 *     is the expression blind spot this header already documents).
 *   SIX FAIL ADMISSION, NOT THREE, across nine document rows: `.gitnexus`,
 *     `graphify-out`, `overrides`, `deployments.jsonl`, `token-log.jsonl`,
 *     `.agentignore`.
 *   AND `.gitnexus` FAILS ON A DIFFERENT DOCUMENT THAN THE ONE RECORDED. It was
 *     credited to traffic-one-doctor/SKILL.md:248 ("Never delete
 *     `.traffic-one/.gitnexus/`"), which carries no authoring verb and produces no
 *     census row at all — and a PROHIBITION is the opposite of what fails this
 *     test, which is why `backups` sits IN the table on the strength of the same
 *     sentence. The row comes from senior-eng-orchestrator/resources/
 *     prompt-templates.md. Right answer, wrong reason.
 *   THE TWO `.local.md` FILES PRODUCE NO ROW AT ALL, so "three fail it outright"
 *     was false for two of its three names. They do not fail the admission
 *     question; they fail a stronger one this docblock states correctly elsewhere —
 *     "the runtime wrote this entry" and "the runtime may delete this entry" come
 *     apart exactly here, since preserveManualRootContext writes the user's
 *     hand-written root context there as the ONLY copy of it.
 *   WHAT THE NINE ROWS BEHIND THOSE SIX NAMES ACTUALLY SAY, read rather than
 *     counted, because the count alone overstates the work — every window below is
 *     the instrument's own 60 characters, replayed:
 *       TWO FAIL ON A VERB THAT IS NOT ONE. `.agentignore`
 *         (rules/common/project-memory.md:92) and `.gitnexus`
 *         (senior-eng-orchestrator/resources/prompt-templates.md:127) both match
 *         `provid\w*` against the NOUN "provider" — "provider versions, and
 *         important version pins" and "provider's location (per …)". Neither
 *         document tells anybody to author anything, and the verb is on a
 *         different line from the mention in both. So `.gitnexus` produces a row,
 *         as the review said, and the row is an INSTRUMENT ARTEFACT rather than a
 *         finding — a sharper version of the same correction: right answer, wrong
 *         reason, one level further down.
 *       THREE DESCRIBE THE RUNTIME OR A ROLE AS THE WRITER: `graphify-out` ("it
 *         writes only under"), `token-log.jsonl` ("the hook appends one JSONL line
 *         per Bash / Write / Edit call to"), and `deployments.jsonl` in three of
 *         its four rows ("shipper appends", "Append one JSON line to" twice). Its
 *         fourth borrows "write `Not applicable`" from the bullet above.
 *       ALL THREE `overrides` ROWS ARE ABOUT `~/.traffic-one/overrides` — the HOME
 *         state root, which listNestedTrafficOneDirs never leaves the project to
 *         reach, exactly as with `debug`.
 *     NONE of the nine is a `retention.json`-shaped instruction telling a HUMAN to
 *     author content of their own. That is not a decision to admit these names —
 *     the rows still have to be adjudicated and pinned, and the two `provid\w*`
 *     artefacts are a reason to distrust the instrument here rather than to trust
 *     the names — but it is the honest size of the job.
 * The DECLINE STANDS this round regardless: nothing above changes the reduction's
 * direction (a leftover, never a loss), and the cost figures below say the residue
 * is worth 0.7% of a realistic tree.
 *
 * ── WHAT THE DECLINE COSTS, RE-DERIVED RATHER THAN INHERITED ─────────────────
 * The figure that stood here — "34 bytes reclaimed of 5.0 MB on a leaked root
 * shaped like a real project", carried across two rounds and explicitly not
 * re-measured — is wrong by about four and a half orders of magnitude, and the
 * correction makes the decline look BETTER rather than worse. Driven through the
 * REAL materializer into a leaked member root of a real workspace container,
 * dry-run plan measured against the tree:
 *
 *   materialization only                       698 KB / 102 files   36.25% of
 *                                                                   bytes planned
 *   plus a run tree in the shapes this file's own header measures
 *     (three 240 KB runs, a 1.3 MB Lighthouse pair, two backups, a debug trace)
 *                                              3.07 MB / 126 files  85.51%
 *   plus all eighteen residue artefacts        3.09 MB / 144 files  84.89%
 *
 * The STRUCTURAL half is what the decline really turns on, and it reframes what
 * is being declined: on the first two shapes the ONLY leftovers are `agents` and
 * `skills` — the two MIXED directories excluded on purpose, for the reason two
 * paragraphs up — so the eighteen-name residue costs NOTHING AT ALL unless
 * gitnexus, graphify, MCP-reporting or onboarding artefacts really exist in the
 * nested root. On the third shape the eighteen leave 22 KB behind, 0.7% of the
 * tree, and reclamation is unchanged at 2.63 MB: the same bytes are planned with
 * them present as without. That shape is also where the count above was checked
 * rather than recited — planting the enumerated residue makes the notice name
 * TWENTY leftovers, the eighteen plus the two mixed directories. The TWO names the
 * enumeration has gained since are NOT in those figures and would make it
 * twenty-two: `.one.json.report-id.lock`, an empty lock directory that weighs
 * nothing and moves the byte columns not at all, and `.one.json.corrupt`, a
 * quarantined copy that weighs whatever the state file weighed. Neither was planted
 * in the run above, so neither is folded into the byte columns — a figure quoted
 * from a run that did not plant it is the drift this section exists to correct, and
 * the count is arithmetic on the fixture where the bytes would not be.
 *
 * The percentages are FIXTURE-DEPENDENT and are quoted as the shape of the cost
 * rather than as constants — the residue's weight is whatever the largest
 * unrecognised artefact happens to be, and a real `.gitnexus` code graph is
 * larger than this fixture's placeholder by any amount you like. What does not
 * depend on the fixture: the direction (a leftover, never a loss), and that the
 * reduction RETIRES the root by taking `.one.json`, so whatever residue there is
 * is permanent. The notice used to compound that by inviting a bug report about
 * files that are ours; it now says which classes are ours and skipped on purpose
 * — see announceReducedRoot, where the false sentence is recorded in place.
 *
 * ── WHAT THIS COSTS TO RUN, now that it is not a pure set lookup ─────────────
 * A set lookup per top-level entry, plus one `lstat` + `readdir` per entry that
 * matches a BRANCH node — `reports` and nothing else, since it is the only
 * multi-segment prefix in the table. A root with no `reports/` in it makes no
 * filesystem call at all, exactly as before.
 *
 * It still reads no file's CONTENT, and it still follows no link into a
 * decision: an entry matching a branch node must be a real directory by
 * `lstatSync`, so a SYMLINK named `reports` is unrecognised here (and
 * unremovable anyway — `removePath` refuses every symlink under a state dir
 * before `rmSync`, fsjson stateWriteGuard). A branch directory this process
 * cannot LIST is a different answer from either: not unrecognised, which would
 * reduce the root and retire it on a momentary error, but no answer about the
 * root at all — see announceUnenumerableRoot.
 */
interface Recognition {
  /** Entries the heal may take, relative to the root it was asked about. */
  readonly removable: readonly string[];
  /** Entries it does not recognise, relative to the same root. */
  readonly leftovers: readonly string[];
}

/**
 * The other answer: this sweep could not ENUMERATE part of the root, so it has no
 * answer about the root at all. Carries WHICH path it was (relative to the root,
 * `''` for the root itself) because the notice has to name it.
 */
interface Unenumerable {
  readonly unenumerable: string;
}

type RecognitionResult = Recognition | Unenumerable;

/** Is this the ignorance answer rather than a recognition? */
function isUnenumerable(result: RecognitionResult): result is Unenumerable {
  return 'unenumerable' in result;
}

function recogniseEntries(
  dir: string,
  entries: readonly string[],
  node: RecognitionNode,
  prefix: string,
): RecognitionResult {
  const removable: string[] = [];
  const leftovers: string[] = [];
  for (const name of entries) {
    const rel = prefix ? path.join(prefix, name) : name;
    const child = node.children.get(name);
    if (!child) {
      leftovers.push(rel);
      continue;
    }
    if (child.whole) {
      removable.push(rel);
      continue;
    }
    const inside = descendRecognition(path.join(dir, name), child, rel);
    // KNOWLEDGE that the entry is not a directory — a symlink wearing a branch
    // node's name — so it is simply unrecognised, and unrecognised is spared.
    if (inside === 'not-a-directory') {
      leftovers.push(rel);
      continue;
    }
    // IGNORANCE about what is inside it, which is not an answer about this entry
    // and therefore not an answer about the root: it goes all the way up. See
    // announceUnenumerableRoot for why a leftover here was permanent.
    if (isUnenumerable(inside)) return inside;
    // An EMPTY branch directory is neither. It has no leftovers, so the arm
    // below used to fold it into a whole-directory action — vacuously, on the
    // one kind of node the design says carries NO authority of its own, and for
    // nothing: there is nothing inside to reclaim. What it did buy was the
    // TOCTOU window named in leakedRootActions, widened over exactly the
    // directory the shipped product tells users to archive reports into. So an
    // empty `reports/` is skipped in both directions: not planned, and not
    // reported as a leftover either, because "we do not recognise this, it may
    // be yours" is the wrong sentence about an empty directory the runtime made.
    if (inside.removable.length === 0 && inside.leftovers.length === 0) continue;
    // Everything inside a branch directory is recognised, so the directory
    // itself may go in one action. This is what keeps the whole-root fast path
    // whole: an ordinary leaked root holding `reports/{qa,lighthouse}` collapses
    // back to a single `<WHOLE ROOT>` action exactly as it did before.
    if (inside.leftovers.length === 0) {
      removable.push(rel);
      continue;
    }
    removable.push(...inside.removable);
    leftovers.push(...inside.leftovers);
  }
  return { removable, leftovers };
}

/**
 * One BRANCH node's entry: what is inside it, that it is NOT A DIRECTORY, or that
 * this process could not find out — three answers where there used to be two, and
 * collapsing the last two into one was P3.
 *
 * `not-a-directory` is knowledge (an `lstat` answered, and the answer was a
 * symlink or a file), so the entry is unrecognised and spared. A FAILED `lstat`
 * is not: the reachable case is ENOENT, an entry that vanished between the
 * `readdir` and this call, which is evidence of a writer active inside the tree
 * this sweep is about to remove — the concurrent-writer race leakedRootActions
 * names — and standing down for one sweep is the right answer to it.
 */
type Descent = RecognitionResult | 'not-a-directory';

function descendRecognition(dir: string, node: RecognitionNode, rel: string): Descent {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return { unenumerable: rel };
  }
  if (!stat.isDirectory()) return 'not-a-directory';
  const entries = listEntries(dir);
  if (entries === null) return { unenumerable: rel };
  return recogniseEntries(dir, entries, node, rel);
}

/**
 * The refusal both arms of the heal now reach, and the ONE place the relationship
 * between them is written down — because the defect was that neither docblock
 * connected the two and they disagreed.
 *
 * The two arms: a leaked ROOT this process cannot list, and a BRANCH directory
 * inside one (`reports`, the only multi-segment prefix in the table) it cannot
 * list. They are the same fact — ignorance about what is in there — and they used
 * to have opposite consequences. The root arm planned nothing, so it re-planned on
 * the next sweep. The branch arm demoted the branch to a LEFTOVER, which reduces
 * the root, and a reduction takes `.one.json` with it: listNestedTrafficOneDirs
 * requires that file before it will consider a directory at all, so the root
 * RETIRED and everything under the unreadable branch survived every later sweep.
 * A momentary error produced a permanent residue.
 *
 * ROUND 8 LEFT THE COST UNDETERMINED — "an unlistable directory is one `rmSync`
 * cannot walk either, so the realized outcome is a throw rather than a deletion,
 * and no readdir failure that is not also an rmSync failure has been
 * constructed" — and it is now settled, but NOT in the column that argument was
 * about. Measured at two kinds of pressure, one branch per cell so no call is
 * helped by the one before it (driver this round, 61,417 held descriptors):
 *
 *                          readdir      rmSync -r        rmSync on a sibling
 *                          the branch   that branch      FILE (`.one.json`)
 *   chmod 000 the branch   EACCES       EACCES           OK
 *   descriptor exhaustion  EMFILE       fails (EMFILE,   OK
 *                                       unmapped errno)
 *
 * SO ROUND 8 WAS RIGHT ABOUT ITS OWN COLUMN and it was the wrong column: a
 * recursive removal has to scandir too, so it fails wherever the listing does,
 * under BOTH pressures. The cell that decides this is the third one. Demoting the
 * branch to a leftover does not plan the branch — it plans the SIBLINGS, and
 * `.one.json` is a single file whose removal needs nothing but a writable parent,
 * so it goes under either pressure, and with it the root's future. Round 8's own
 * fixture proves it end to end rather than by argument: restoring the demotion and
 * running a delete-mode sweep over a chmod-000 branch removes `.one.json` and reds
 * the two pins in __tests__/retention.test.ts that hold this behaviour.
 *
 * What descriptor exhaustion adds is that the tree was REMOVABLE THE WHOLE TIME —
 * measured directly: the same tree rmSync could not walk under pressure removes
 * cleanly once the descriptors are released — so no coincidence is protecting the
 * residue and nothing about the state licensed retiring the root. This runtime
 * lives inside a coding-agent process holding many descriptors, so EMFILE is an
 * event rather than a contrivance. The pin for that row stubs `readdirSync` to
 * fail with EMFILE rather than exhausting descriptors inside the test process,
 * which is the same syscall failure without a 61,417-descriptor fixture; the
 * pressure itself was measured in the driver above, not in the suite.
 *
 * AND THE EMFILE ROW IS NOT WHAT DEMONSTRATES THE PROPAGATION, which the table
 * above can be read as claiming. Under process-wide exhaustion the FIRST
 * `readdirSync` to fail is the one at the top of leakedRootActions, so the sweep
 * takes the ROOT arm and is blind before any branch is reached — the BRANCH arm,
 * the one this fix added, is unreachable under that pressure by code order. The two
 * chmod rows are what exercise it, because a mode bit is selective and a
 * descriptor limit is not.
 *
 * So ignorance about ANY part of the root stands the WHOLE root down, which is
 * what the root arm always did, and what `listEntries` returning `null` rather
 * than `[]` exists to make possible one level down as well.
 */
function announceUnenumerableRoot(nested: string, rel: string, notices?: string[]): void {
  const target = rel ? path.join(nested, rel) : nested;
  const scope = rel
    ? `the leaked-root heal planned nothing for ${agentVisiblePath(nested)} at all`
    : 'the leaked-root heal planned nothing for it';
  collectRetentionAnomaly(
    notices,
    `cannot list ${agentVisiblePath(target)}, so ${scope} — a root whose contents cannot be enumerated, in whole or`
    + ' in part, cannot be shown to hold only artefacts this runtime wrote. The part that CAN be read is not a'
    + ' consolation prize either: reclaiming it takes `.one.json` with it, which retires the root from this rule,'
    + ' so a momentary error would leave the rest behind permanently.\n'
    + '  Make it readable (`chmod u+rx`) and the next sweep reclaims it normally.',
  );
}

// Every entry name, whatever its type — deliberately not listDirs+listFiles,
// which between them drop a symlink child and would leave it stranded in a root
// this rule is otherwise emptying.
//
// `null` is not `[]`, and that distinction is the whole reason this is
// nullable. `readdirSync` failing is IGNORANCE; an empty array is KNOWLEDGE —
// and downstream, "every entry in here is a recognised runtime artefact" is
// exactly what licenses removing the whole root in ONE action, which an empty
// list vacuously satisfies. Folding the two together put ignorance on the DELETE
// side: a leaked root at 0o111 is traversable, so the leak verdict is still
// reached, but not listable, so the plan became the entire tree with the
// hand-written memory inside it. MEASURED: planned `<WHOLE ROOT>`, removed 0 of
// 1 — the memory survived only because `rmSync` could not read the directory
// either, the same errno saving it by coincidence rather than by design.
//
// It is not the ONLY ignorance in this file, and an earlier version of this
// comment claimed it was: isOlderThan cannot always establish an age either. That
// one lands on the KEEP side by construction and now says so out loud, in a
// notice, which is the property this one lacked.
//
// A `null` from HERE now travels all the way out of the heal whatever depth it
// came from, rather than being spent as a leftover one level down; the two arms
// are related in announceUnenumerableRoot.
function listEntries(root: string): string[] | null {
  try {
    return fs.readdirSync(root);
  } catch {
    return null;
  }
}

/**
 * The leaked-root heal, which after the inversion is a REDUCTION with a
 * whole-root fast path rather than a removal with a carve-out.
 *
 * The heal itself is deliberate and unchanged in intent: a leaked `.traffic-one`
 * inside an ancestor workspace (the packages/ui incident) or stray state inside a
 * real repository (mercury/strategies) is reclaimed. What it may take is now
 * exactly the entries recogniseEntries positively recognises, and the ruling for
 * everything else is to leave it EXACTLY WHERE IT IS — not prompted about,
 * because the trigger is SessionStart and several hosts drop a prompt request
 * outright, so the prompt would resolve to the delete on precisely the hosts that
 * cannot answer it; and not moved to a backup, because a backup is a new location
 * the user has to be told about by the same channel that could not carry the
 * prompt.
 *
 * When every entry is recognised — the ordinary case, and the one the membership
 * tests pin — the root goes in ONE action, exactly as it always has. An
 * unrecognised entry turns the plan into one action per recognised entry, and
 * THE COST IS NAMED HERE because it is the price of the ruling: the root is not
 * fully healed, it is reduced to its leftovers, and the leftovers are reported.
 *
 * That report is bounded rather than a standing nag, which is the property that
 * makes reduce-and-report survivable. `.one.json` is a recognised entry, so a
 * reduction that LANDS removes it, so the directory stops being a nested state
 * root: listNestedTrafficOneDirs requires `.one.json` to exist before it will
 * even ask about a leak. The next SessionStart sees no candidate here, plans
 * nothing, and says nothing. The leftovers are reported ONCE.
 *
 * The whole-root action carries a TOCTOU window — plan to `rmSync` — in which a
 * concurrent writer's new `product.md` is inside a directory already scheduled
 * whole. The window itself is not observable from outside this module; what is,
 * and what bounds it from above, is the whole apply sweep: 113 ms median of five
 * on a leaked root carrying three runs, `reports/lighthouse`, `backups` and the
 * materialized pair (min 68, max 141). Quote that number as the bound it is, not
 * as the window. It is reachable only for a root in which
 * every entry was recognised when the plan was taken, so the file at risk is one
 * that did not exist a moment earlier; closing it would mean holding a lock
 * across the heal, which is a larger cost than the shape justifies. Named, not
 * fixed.
 *
 * A heal that is REFUSED retires nothing, and that is not a property this
 * function can offer — on a project whose use-plugin consent is unanswered
 * `removePath` refuses every path, so the same root is re-planned every
 * SessionStart until the question is answered. That is the fence working: the
 * plan is a dry run in all but name until consent exists. A DRY RUN re-reports
 * for the same reason, and a dry run is what a reviewer measuring this rule is
 * usually looking at.
 *
 * And a root this function cannot ENUMERATE is not healed at all — nor is one
 * holding a BRANCH directory it cannot enumerate, which is the same fact and used
 * to have the opposite consequence. Ignorance about what is inside cannot license
 * removing the outside; see announceUnenumerableRoot, where the two arms and their
 * relationship are written down together, and listEntries for why `null` is not
 * `[]`.
 */
function leakedRootActions(nested: string, reason: string, dryRun: boolean, notices?: string[]): RetentionAction[] {
  const entries = listEntries(nested);
  if (entries === null) {
    announceUnenumerableRoot(nested, '', notices);
    return [];
  }
  const result = recogniseEntries(nested, entries, RECOGNITION, '');
  if (isUnenumerable(result)) {
    announceUnenumerableRoot(nested, result.unenumerable, notices);
    return [];
  }
  const { removable, leftovers } = result;
  if (leftovers.length === 0) return [{ action: 'remove', path: nested, reason }];
  announceReducedRoot(nested, leftovers, dryRun, notices);
  return removable.map((rel) => ({
    action: 'remove' as const,
    path: path.join(nested, rel),
    reason: `${reason} (reduced — ${leftovers.length} unrecognised entr${leftovers.length === 1 ? 'y' : 'ies'} left in place)`,
  }));
}

// Newest run id first, and TOTAL — which `localeCompare` alone is not.
//
// `numeric: true, sensitivity: 'base'` is a total PREORDER: it returns 0 for
// genuinely different ids. `01712345678901` and `1712345678901` are numerically
// equal, as is any pair differing only in case. `Array.prototype.sort` is stable,
// so a 0 leaves the pair in INPUT order, and the input is `readdir` order — so
// which of two tied ids took the last `keepRuns` slot differed between machines,
// between filesystems, and between two runs on the same tree after a rename. A
// retention budget handed out on an order that is not a function of its input is
// not a policy.
//
// The tie-break is UTF-16 code-unit order, descending, which is total by
// construction and needs no locale data: equal strings are the only pair left
// returning 0. It is deliberately NOT a second locale comparison — a tertiary
// `sensitivity: 'variant'` pass would order a case pair by ICU's rules, which is
// a different answer per ICU version, and this comparator's whole job is to be
// the same answer everywhere.
function numericDesc(a: string, b: string): number {
  const byValue = b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
  if (byValue !== 0) return byValue;
  if (a === b) return 0;
  return a < b ? 1 : -1;
}

// Does this id own an ENTRY that only a run writes?
//
// An EXISTENCE test, and the word "real" that used to describe it overstated
// what is checked: a zero-byte `run.json`, a directory NAMED `run.json` and a
// resolving symlink all count, and only a broken link does not. Counting a torn
// ledger is deliberate — a run with a damaged file is a run, and demoting it
// would be the retention-ledger defect arriving through this door — so the test
// is on the NAME being present, not on its content being sane.
//
// The separator guard is first, and it is defensive rather than load-bearing:
// `currentRunId` is attacker-controllable JSON, but every id that reaches the
// ranking either comes from `readdir` (one path segment by construction) or IS
// `currentRunId`, which keepRunIds RESERVES before any ranking happens — so no
// rank this function returns for it can change a plan. It stays because the next
// caller of this helper need not know that, and a traversal that steers an
// `existsSync` at an unrelated tree is not a thing to leave to a caller.
//
// AN UNANSWERABLE STAT IS ITS OWN ANSWER, and it is returned as one rather than
// folded into either neighbour — the same three-way split entryPresence makes, kept
// three-way all the way to the two decisions that consume it. `existsSync`
// answered FALSE for a run directory with no `+x`, so a genuine 13-digit run whose
// artefacts this process may not stat dropped from rank 0 to rank 1 and lost its
// keep slot to a run that could be read — an eviction decided by a mode bit.
// Evidence we cannot see is not evidence of absence.
//
// FOLDING IT INTO `present` WAS THE OTHER HALF OF THE SAME DEFECT, and it shipped
// for a round on a priced cost that was FALSE. Recorded verbatim, because that
// sentence is what hid it: "What it costs is that a STRAY directory with an
// unstattable interior rises from rank 3 to rank 2, which reorders strays among
// themselves and can never outrank a minted id." True of a name that is not
// thirteen digits — and false for exactly the shape that does damage. A 13-digit
// directory reached rank 0 on an unreadable interior, `numericDesc` sorts it ahead
// of every genuine stamp older than it, and it took the FIRST slot in the budget;
// the orphan TTL's own `unknown` arm then kept it forever, so nothing could
// release the slot. MEASURED at keepRuns 3 with four genuine runs and one such
// directory: TWO genuine runs planned where the policy alone plans one, the
// directory itself never planned, unchanged a day later. The two ignorance arms
// composed into a permanent eviction.
//
// So the fix is not in the polarity — the same shape reached through a GENUINE
// run's own unreadable interior is a run this sweep must not evict either — it is
// that an id whose evidence is unknowable is protected OUTSIDE the budget, where
// liveness already is. See keepRunIds. Rank is left saying only what it knows:
// `present` earns the front group and nothing else does.
function runArtefactEvidence(cwd: string, id: string): EntryPresence {
  if (/[\\/]/.test(id) || id === '.' || id === '..') return 'absent';
  const runDir = path.join(cwd, '.traffic-one', 'runs', id);
  const ledger = entryPresence(path.join(runDir, 'run.json'));
  if (ledger === 'present') return 'present';
  const compiled = entryPresence(path.join(runDir, 'architecture-v1.json'));
  if (compiled === 'present') return 'present';
  return ledger === 'unknown' || compiled === 'unknown' ? 'unknown' : 'absent';
}

// Which ids compete for a `keepRuns` slot FIRST. Lower rank wins; recency
// (`numericDesc`) decides inside a rank.
//
// `collectRunIds` admits ANY directory name it finds under `runs/`, `digests/`,
// `fix-cycles/` and `reports/qa/`, and `numericDesc` — `localeCompare` with
// `numeric: true`, descending — ranks a letter-leading name ABOVE every 13-digit
// mint stamp. So one stray `digests/zz-scratch` took the first slot in the
// newest-N budget and kept it: it is retained by having stolen the slot, and the
// window stays permanently one run narrower for the real runs. A LIVE run is
// never lost this way (liveness is reserved OUTSIDE the budget, see keepRunIds);
// what is lost is retained run history, the `digests/` handoff record included.
//
// The answer is ORDERING, not exclusion: every id still competes, so a foreign
// shape is never denied protection it would otherwise have earned — it just
// cannot take a slot AWAY from a run. THREE rounds of that ordering were wrong,
// each by treating one signal as sufficient:
//
//   - MINT SHAPE ALONE was sufficient, so an empty `digests/9999999999999` — a
//     directory with nothing in it — ranked at the very top, took a slot, was
//     retained for having taken it, and narrowed the window by one permanently.
//     That is the original slot-theft defect verbatim, reached through the digit
//     test instead of through `numericDesc`. MEASURED: 4 real runs under
//     keepRuns 3 kept 3 of 4 with the empty stamp present, 4 of 4 without it.
//   - AN ARTEFACT ALONE was sufficient, so a stray `runs/tmp-restore` holding a
//     COPIED `run.json` — a half-finished restore, a manual backup — sorted
//     above every mint stamp under `numericDesc` and evicted the NEWEST genuine
//     run. The evidence partition fixed MEMBERSHIP of the front group and left
//     order inside it to `localeCompare`, which is the thing that was wrong.
//   - ANY RUN OF DIGITS counted as a mint shape, and the two fixes above did NOT
//     close the defect they claimed to close — an earlier version of this comment
//     said they had. `/^\d+$/` admits a 14-digit name, `numericDesc` sorts a
//     larger number above every genuine 13-digit stamp, and a `run.json` inside
//     it is enough for rank 0: so `runs/17123456789012` took the FIRST slot in
//     the budget and was then retained for having taken it. MEASURED at keepRuns
//     3 with 4 genuine runs: 3 of 4 kept with the 14-digit directory present, 4
//     of 4 without it — the same shape, the same loss, reached through the digit
//     test rather than through the ordering.
//
// So the mint test is now the shape the runtime ISSUES, exactly as runAgeMs reads
// it: thirteen digits. The two functions agreeing is the point — an id runAgeMs
// refuses to age is an id this must refuse to promote, or a name nothing can
// place in time is competing for a slot on the strength of looking numeric.
// Nothing else writes a 13-digit directory name by accident.
//
// The EVIDENCE is passed in rather than read here, so it is read once per id
// (keepRunIds asks the same question to decide the reservation) instead of twice —
// and so this function has nothing to fold: it decides on the three-valued answer
// it is handed. `unknown` earns rank 1 for a minted id, NOT rank 0, because rank 0
// is a claim that this id has evidence of being a run and no such claim can be
// made from a stat that failed.
//
// THAT ARM IS NOT WHAT PREVENTS THE THEFT, and this comment said it was: "the rank
// is what stops it deciding SOMEBODY ELSE'S [survival]" — recorded here as false,
// because the mutant that restores rank 0 for an unknowable minted id (round 11's
// fold) leaves the whole fence GREEN at 114/114. It is a genuine equivalence and
// the loop below is why: a reserved id is already in `keep`, `keep.add` of a member
// does not grow `keep.size`, and the budget test is that size — so wherever the id
// sorts, it consumes nothing and displaces nobody. The RESERVATION is the entire
// fix; ranking cannot be pinned against it and no test in this file can distinguish
// the two, which is a proof rather than a missing fixture.
// It is written this way anyway, for the case a later round narrows that guard: an
// id whose evidence failed to read would then fall back to rank 1 — below evidence
// that was actually seen — rather than to the front of the budget.
//
// A non-minted id keeps the older behaviour (`unknown` ranks with `present`, at 2),
// which is the half of the recorded cost that was true: it reorders strays among
// themselves and can never outrank a minted id.
//
// "REORDERS STRAYS AMONG THEMSELVES" IS NOT THE SMALL THING IT SOUNDS LIKE, and
// this arm shipped for a round with nothing pinning it. Rank is the budget's order,
// the budget decides `keep`, and `keep.has(id)` is the pruning key for all three
// RUN_SCOPED_DIRS — so the rank of an id that is NOT reserved decides which OTHER
// id's bytes are reclaimed. The mutant collapsing this arm to rank 3 SURVIVED the
// whole fence (114/114, with the branch executed once, so an untested behaviour and
// not an equivalence: unlike the minted `unknown` arm above, nothing here is
// reserved, so nothing makes the ordering unobservable).
//
// KEPT AT 2 RATHER THAN COLLAPSED, for the reason the rest of this file gives for
// every three-valued read: rank 3 is the claim that this id holds NOTHING, and a
// stat that failed cannot make it. Sorting an id whose interior this uid cannot
// enter below one known to be empty spends ignorance in the deletion direction. It
// is bounded either way — both ranks are inside the budget, so a newer id pushes
// the directory out and the newest-N rule reclaims it — which is why the choice can
// be made on that principle alone. PINNED at last by 'a NON-minted id whose
// interior cannot be stat-ed outranks one known to hold nothing', which measures the
// flip a mode bit makes: one slot, an empty `runs/aaa-unreadable` and a
// `zzz-empty` with no run directory, and the slot goes to `zzz` at mode 0o755 and to
// `aaa` at 0o000 with `zzz`'s digests planned instead.
function runSlotRank(id: string, artefact: EntryPresence): number {
  const minted = /^\d{13}$/.test(id);
  if (minted) return artefact === 'present' ? 0 : 1;
  return artefact === 'absent' ? 3 : 2;
}

// `readJson`, not `readJsonResult`: this folds a CORRUPT `.one.json` into "no
// current run", which on its own would silently drop the one id reserved
// outside the budget. It is safe only because readPolicy reads the same file
// first and suspends the run caps on exactly that kind — so by the time this
// answers null, no rule that consumes the answer is still running. The two are
// a pair; changing either one alone re-opens the eviction readPolicy's
// suspension exists to prevent.
function readCurrentRunId(cwd: string): string | null {
  const state = obj(readJson(path.join(cwd, '.traffic-one', '.one.json'), null));
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return runId || null;
}

function collectRunIds(cwd: string): string[] {
  const t1 = path.join(cwd, '.traffic-one');
  const ids = new Set<string>();
  for (const rel of RUN_SCOPED_DIRS) {
    for (const name of listDirs(path.join(t1, rel))) {
      if (name === '.once') continue;
      ids.add(name);
    }
  }
  const current = readCurrentRunId(cwd);
  if (current) ids.add(current);
  return [...ids].sort(numericDesc);
}

// How old a run is, measured from the id itself: the runtime mints run ids as
// epoch-ms stamps, which is an IMMUTABLE birth time. Five independent sites
// agree that this is the only shape it mints — run-paths.ts adopts nothing else
// ("epoch-ms mint ids only"), identity-drift.ts skips every other name,
// build-complete.ts reads no creation signal from one, and plan-runid.ts
// refuses one "strictly epoch-ms so an ISO id can never qualify".
//
// An id of any OTHER shape is UNAGED. That is the fix, not a limitation left
// over. The fallback used to be the run DIRECTORY's mtime, which every child
// write moves, so a foreign or legacy id with a torn ledger renewed its own
// liveness protection for as long as anything kept writing inside it — an
// indefinite protection bought by ACTIVITY, which is precisely what the header
// of this file promises does not exist here. MEASURED: `runs/legacy-run` and
// `runs/1001`, each with a merge-torn `run.json` and a one-year-old directory,
// reported `live: false`; ONE write inside the directory reported `live: true`,
// while the same run with a legible ledger reported false throughout.
//
// What still protects such a run is bounded, and it is the same set that
// protects every run: `currentRunId` and the caller's protectRunIds reserve it
// outright, a claim the walk ACTUALLY SEES makes it live at any age (measured
// on the same fixture: one fresh claim, live and not reclaimable), and the
// newest-N budget keeps it while it is recent. Only the mtime GRACE is gone,
// and only for a shape the runtime does not mint.
//
// Nothing is read from disk here any more, so the separator guard that kept an
// attacker-controlled `currentRunId` from steering a `statSync` at an unrelated
// directory is no longer load-bearing — such an id simply fails the mint test.
function runAgeMs(runId: string, nowMs: number): number {
  if (/^\d{13}$/.test(runId)) {
    const minted = Number(runId);
    if (Number.isFinite(minted)) return nowMs - minted;
  }
  return Number.POSITIVE_INFINITY;
}

// The question this sweep never asked. Deleting a run is not just untidy while
// an agent is still inside it: claim resolution walks EVERY run on disk
// (runIdsForLookup, claims-pending.ts) to find the record that grants an agent
// its write authority, so reclaiming a live run's directory demotes a working
// agent to `no-claim` and the gates start refusing its writes.
//
// Both protection sources are deliberately SELF-LIMITING, because a keep-set
// that only ever grows is a worse bug than the one this fixes:
//
//   - Live claims decay on their own. The claim walk (run-settlement/io.ts)
//     already ignores any claim untouched for longer than SUBAGENT_STALE_MS, so
//     this borrows an expiry instead of inventing one.
//
//     It reads that walk through runLiveClaimEvidence and NOT through
//     activeRunClaimCount, and the difference is the whole reason the
//     three-valued reader exists. activeRunClaimCount folds a scan that could
//     not FINISH — the 2,048-entry bound, or one unreadable subdirectory — into
//     `Math.max(1, count)`: "at least one live claim". That sentinel is right
//     for the callers it was written for, which are settlement VETOES, and it
//     is wrong here, because the two directions only LOOK like the same
//     direction.
//
//     For a veto, ignorance-as-keep is SELF-LIMITING: the refusal lifts the
//     moment the scan succeeds. For a DELETER it is SELF-DEFEATING, because the
//     only thing that would remove the records the scan choked on is the sweep
//     the sentinel suppresses, so the condition never clears on its own.
//     MEASURED on a run holding 2,100 claims every one of which was 30 days
//     stale: the sentinel reported 1, the sweep filed the run under liveRunIds
//     — RESERVED outside the newest-N budget, see keepRunIds — and it held that
//     slot permanently while two NEWER runs were reclaimed around it.
//
//     So the ignorance is read as ignorance and answered on its own terms; the
//     `unknown` arm in runIsLive says how, and what bounds it.
//
//   - A non-terminal LEDGER decays not at all: the abandoned run described in
//     the orphan rule below sat at `status: active` indefinitely. Protecting
//     every non-terminal ledger would make that exact run immortal and re-open
//     the 8cl defect this file already closed, so the ledger alone only
//     protects a run still inside the mint window — long enough to cover a run
//     minted seconds ago that has not yet written its first claim, which is the
//     window in which it is most fragile and least provably alive.
//
// A TERMINAL ledger does not override a live claim. Settlement records a verdict
// about the PAST; a fresh claim is evidence about the PRESENT, and the two
// disagreeing means a claim outlived its settlement, not that the holder is
// gone. run-settle.ts and runCompletionEvidenceAllows both refuse to reach
// terminal at all while claims are live, so the combination is already an
// anomaly — and in an anomaly the reversible choice is to keep.
//
// Neither use of `runAgeMs` below is skew-guarded, and that is the deliberate
// choice rather than an oversight. A run id minted while the clock ran ahead
// gives `runAgeMs` a negative age, which is inside every window forever, so
// such a run is never reclaimed through either arm — an unbounded-disk bug, and
// a real one. Refusing to protect it would trade that for an IRREVERSIBLE one,
// and the trade is one-sided rather than balanced: `runAgeMs` is consumed in
// exactly two places, both spelled `age < WINDOW -> KEEP`, so a guard here can
// only ever ADD deletions and can never prevent one.
//
// It would also arrive at the worst possible moment. The claim walk USED to
// read a future stamp as maximally fresh exactly as this does; since
// `ageAttestsLiveness` landed in run-settlement/io.ts it no longer does, so a
// future-stamped claim has ALREADY lost its claim-side protection. MEASURED
// with a skew guard fitted here: a run whose ledger still says `active` and
// whose claims are future-stamped goes from protected to reclaimable — both
// protections gone at the same instant, for a run an agent may be working
// inside. The asymmetry decides it: keeping a dead run costs disk, deleting a
// live one demotes a working agent to `no-claim` and the gates start refusing
// its writes.
//
// So the cost is what it is, and it is named here rather than left to be
// rediscovered: a future-minted id is protected INDEFINITELY through both arms,
// the ledger one and the ignorance one. Accepted — it is the conservative
// direction, and the ignorance half is a strictly narrower shape than the
// status quo it replaces, which protected EVERY run with an unfinishable scan
// forever regardless of age. Both halves are pinned by name in
// __tests__/retention.test.ts ("the skew trade, made visible" and "the accepted
// cost") so a guard fitted here can never land looking free.
//
// The half of the exposure that is NOT ours, stated so the ledger above is not
// mistaken for full cover: a future-minted run whose ledger is terminal and
// whose claims are future-stamped is protected by nothing at all. That is
// decided in run-settlement/io.ts, not here.
function runIsLive(cwd: string, runId: string, nowMs: number): boolean {
  // Ledger first: one file read, and it settles the fresh-mint case without
  // paying for a recursive claim walk.
  //
  // An ILLEGIBLE ledger takes the same arm as a non-terminal one, and for the
  // reason the header of this file gives. `status` alone cannot carry the
  // difference: it is null for a run that has no ledger AND for a run whose
  // `run.json` was torn by a crashed write, half-flushed, or merged into
  // non-parsing bytes — so the arm below never fired for the torn one and a run
  // ninety seconds old was reclaimed with its architecture-input-v1.json inside
  // it. `legibility` is `readJsonResult`'s own kind, so `absent` stays what it
  // has always been — a legible "there is no ledger", which earns nothing here
  // and leaves such a run to the newest-N window and currentRunId, exactly as
  // before. Only `corrupt` and `unreadable` are ignorance, and ignorance is
  // answered the way every other ignorance in this file is: with the run's own
  // birth stamp, under the BORROWED SUBAGENT_STALE_MS window, which expires on
  // its own. A torn ledger therefore buys a young run the same grace a
  // `planned` one does, buys an old one nothing at all, and buys an id that
  // carries no birth stamp nothing at all either (see runAgeMs — that last case
  // used to be an indefinite protection renewable by writing in the directory).
  const ledger = runLedgerStatusRecord(cwd, runId);
  const illegible = ledger.legibility === 'corrupt' || ledger.legibility === 'unreadable';
  const status = ledger.status;
  if ((status === 'planned' || status === 'active' || illegible)
    && runAgeMs(runId, nowMs) < SUBAGENT_STALE_MS) return true;
  const claims = runLiveClaimEvidence(cwd, runId);
  if (claims === 'live') return true;
  if (claims === 'none') return false;
  // A scan that could not finish is ignorance, not evidence. Keeping on it is
  // right while the run could still be in use and self-defeating past that, so
  // it is answered with the one thing still legible about the run — its own
  // birth stamp — under a BORROWED window, never an invented one.
  // SUBAGENT_STALE_MS is already spent twice over on this exact question: by
  // the ledger arm above, and by the claim walk itself when it decides a claim
  // still attests liveness. Ignorance therefore protects for as long as the
  // live claim it stands in for could have, and no longer.
  return runAgeMs(runId, nowMs) < SUBAGENT_STALE_MS;
}

interface RunKeepSet {
  keep: Set<string>;
  live: Set<string>;
  /**
   * How many ids the unenterable-`runs/` reservation RESCUED: mint-shaped ids whose
   * evidence could not be read and which nothing else in this sweep was keeping.
   *
   * THE COUNT USED TO BE `unknownEvidence` AND WAS WRONG IN BOTH DIRECTIONS. Its
   * docblock read "0 in every other state, including the per-id one the UNAGED
   * channel already announces", and both halves are false: at `runs/` 0o400/0o444/
   * 0o600 it is non-zero in exactly the per-id state UNAGED was announcing (which is
   * why that double report is now cut at the cause, in collectActions), and it
   * over-counted the CURRENT run, which `keep.add(current)` had already taken
   * several lines earlier and which no window could ever evict. MEASURED on a fresh
   * project whose only run is the current one, `runs/` 0o000: `planned 0 removed 0
   * keep 1` and a notice reserving "1 run id" whose fate was never in question
   * (load 4.10 of 10 CPUs).
   *
   * So it counts ids the reservation CHANGED something for, and the notice's
   * reservation sentence is printed only when it is non-zero. The count rather than
   * the ids because the user's action is one `chmod` on one directory and naming ids
   * does not change it; see announceUnreachableStateDirs.
   */
  reservedBehindRunsDir: number;
  /**
   * What directoryEnterable answered about `runs/`, or `null` for NOT ASKED — which
   * is the honest third value: the question is only put when an evidence read
   * actually failed, so on a healthy project there is no answer here and no notice
   * may invent one.
   */
  runsEnterable: EntryPresence | null;
}

function keepRunIds(
  cwd: string,
  policy: RetentionPolicy,
  nowMs: number,
  protectRunIds: readonly string[] = [],
): RunKeepSet {
  const current = readCurrentRunId(cwd);
  const ids = collectRunIds(cwd);
  const keep = new Set<string>();
  if (current) keep.add(current);
  // Caller-protected ids (the run being settled) are unconditional: a settle
  // of an OLDER run must never reclaim the ledger it wrote milliseconds ago.
  for (const id of protectRunIds) if (id) keep.add(id);
  // Live runs are RESERVED outside the newest-N budget, exactly as the
  // caller-protected ids above are, and for the same reason: liveness is a
  // correctness requirement, not a retention preference. Charging it to the
  // budget would let a live OLD run evict a recent one — trading a wrong
  // deletion for a different wrong deletion — and would make how much history
  // a project retains depend on how many agents happen to be running right now.
  const live = new Set<string>();
  for (const id of ids) {
    if (!runIsLive(cwd, id, nowMs)) continue;
    live.add(id);
    keep.add(id);
  }
  // A MINT-SHAPED ID WHOSE EVIDENCE CANNOT BE READ is reserved here, beside
  // liveness and for the same reason: the answer to "is this a run" is a stat
  // this process is not allowed to make, and a budget slot may not be handed out
  // — or taken away — on the strength of a mode bit.
  //
  // Both directions of the fold were wrong, and this is what is left once neither
  // is available. Reading `unknown` as ABSENT evicts a genuine run whose interior
  // this uid cannot enter (pinned: 'a run whose artefacts cannot be stat-ed keeps
  // its keep-set slot'). Reading it as PRESENT put the id at rank 0, where
  // `numericDesc` sorts thirteen digits ahead of every older genuine stamp, so it
  // took the first slot in the budget and — because the orphan TTL's own `unknown`
  // arm can never plan it — held that slot for as long as the mode bit lasted
  // (pinned: 'an UNSTATTABLE mint-stamp directory is protected WITHOUT taking a
  // keepRuns slot', measured at TWO genuine runs planned instead of one).
  // Reserving it is the only arm that is conservative about BOTH: it can never be
  // planned, and it can never displace a run that can be.
  //
  // MINTED ONLY, and the boundary is deliberate rather than cautious. What earns
  // the reservation is that the id could BE a run — the runtime mints thirteen
  // digits and nothing else (runAgeMs, runSlotRank and this all read the one
  // shape) — so a name of any other spelling keeps the ranking it has always had
  // and stays reclaimable by the newest-N rule.
  //
  // WHAT WIDENING IT WOULD ACTUALLY BUY, corrected: the asymmetry recorded here
  // overstated itself. It read that reserving a non-minted name "would buy a junk
  // directory a permanent, un-plannable place in the keep set", as though rank 2
  // bought it nothing — and rank 2 already puts an unreadable junk directory ahead
  // of every rank-3 name, and while it HOLDS a slot the orphan TTL's own `unknown`
  // arm refuses to plan it just as it refuses a reserved one. The real difference
  // is one word: the slot is INSIDE the budget, so a newer id pushes the directory
  // out of it and the newest-N rule then reclaims it (pinned: 'a NON-minted stray
  // whose interior cannot be stat-ed stays reclaimable'). A reservation sits
  // outside the budget, where nothing can ever push it out — bounded immortality
  // against unbounded, not nothing against everything.
  //
  // IT ADDS NO INDEFINITE PROTECTION A RUN DID NOT ALREADY HAVE, which is the test
  // the header's list of indefinite protections sets. TWO SENTENCES THAT STOOD
  // HERE WERE FALSE, recorded rather than reworded away because this reservation is
  // one round old and both were written from the shape it was built for:
  //
  //   "what changes is only whose slot it holds" — FALSE. Keep-set membership is
  //     ALSO the pruning key for the three RUN_SCOPED_DIRS: the loop in
  //     collectActions asks nothing but `keep.has(id)`, so the reservation protects
  //     BYTES under `digests/`, `fix-cycles/` and `reports/qa/`, not just a slot in
  //     a window. MEASURED at `keepRuns: 1` with five genuine runs holding a 32 KB
  //     payload in each of those three directories: 480 KB → 192 KB with 9 sidecar
  //     removals when `runs/` is readable, and 0 of the 9 planned when it is not
  //     (load 5.71 of 10 CPUs).
  //   "it is announced — the UNAGED notice names the directory and the remedy" —
  //     TRUE ONLY where the id's OWN `runs/<id>` is the unreadable thing, which is
  //     the shape this arm was written against: there the orphan TTL walks `runs/`,
  //     meets `unknown` and pushes that run directory into UNAGED. Where `runs/`
  //     ITSELF cannot be entered, nothing walks it, the sidecars' own timestamps
  //     read perfectly, and NOTHING WAS ANNOUNCED — the same driver measured 0
  //     notices, `retentionAdvisory` null and `planned: 0` still at +400 days, so
  //     the retention was permanent and no surface said so. It now measures 1
  //     notice and a non-null advisory in that arm, with the bytes still retained:
  //     the KEEP was never the defect, the silence was. That shape has
  //     its own arm now (announceUnreachableStateDirs) rather than a share of this
  //     one, because the UNAGED sentence is false in it: it says the artefacts have
  //     no trustworthy timestamp and prescribes `touch`/`chmod` on them, and here
  //     the artefacts are fine and the unreadable thing is the directory beside
  //     them. Which is why UNAGED no longer takes a run directory whose evidence was
  //     blinded by the PARENT's mode (`runsUnenterable === null` guards the push):
  //     the round that split the notices claimed the two could not both fire
  //     "because the walk finds nothing to iterate at all", and that holds at 0o000
  //     and nowhere else — at 0o400/0o444/0o600 the walk iterates fine, every stat
  //     fails, and both notices fired about the same four directories with opposite
  //     advice about `touch`. The permission table in the fence suite is the pin.
  const evidence = new Map<string, EntryPresence>();
  let unknownEvidence = 0;
  let rescued = 0;
  for (const id of ids) {
    const artefact = runArtefactEvidence(cwd, id);
    evidence.set(id, artefact);
    if (artefact !== 'unknown') continue;
    unknownEvidence += 1;
    if (!/^\d{13}$/.test(id)) continue;
    // Counted only when this reservation is what keeps the id: `current`, the
    // caller's protected ids and the live set are already in `keep`, and an id
    // kept for one of those reasons has had nothing changed for it here. See
    // RunKeepSet.reservedBehindRunsDir for the notice this over-counted.
    if (!keep.has(id)) rescued += 1;
    keep.add(id);
  }
  // Asked ONCE, and only when an evidence read actually failed, so a healthy
  // project pays nothing for the discrimination: which of the two causes blinded
  // those reads decides which clause of the notice is true. See directoryEnterable
  // for why the question is about a path INSIDE `runs/` rather than about `runs/`
  // itself — and for why it is NOT the question the pruning rules ask.
  const runsEnterable = unknownEvidence > 0
    ? directoryEnterable(path.join(cwd, '.traffic-one', 'runs'))
    : null;
  const reservedBehindRunsDir = runsEnterable === 'unknown' ? rescued : 0;
  const reserved = keep.size;
  // Runs first, recency within each rank (the partition preserves the
  // `numericDesc` order it is fed). See runSlotRank for what a junk directory —
  // or a bare mint stamp, or a copied ledger — costs when the budget is handed
  // out on name order alone.
  const ranked: string[][] = [[], [], [], []];
  for (const id of ids) ranked[runSlotRank(id, evidence.get(id)!)]!.push(id);
  for (const id of [...ranked[0]!, ...ranked[1]!, ...ranked[2]!, ...ranked[3]!]) {
    if (keep.size >= policy.keepRuns + reserved) break;
    keep.add(id);
  }
  return { keep, live, reservedBehindRunsDir, runsEnterable };
}

function maybeAction(actions: RetentionAction[], filePath: string, reason: string): void {
  actions.push({ action: 'remove', path: filePath, reason });
}

/**
 * How old an entry is, or WHY that could not be established — the four lines
 * every TTL rule in this file runs through, and the reason they are no longer
 * four lines.
 *
 * ── A FUTURE MTIME USED TO MEAN IMMORTAL, SILENTLY ───────────────────────────
 * The test was `nowMs - mtimeMs >= ttlMs`, and an mtime AHEAD of now makes that
 * difference negative forever, so no TTL ever fires. MEASURED by restoring those
 * four lines under the current tests, with one artefact planted in each ephemeral
 * family at its real path: nine families then, 9 of 9 reclaimed at four days old
 * and 0 of 9 one day in the future. (A year ahead is the same arithmetic with a
 * larger negative, and was not separately reached — the four-line version fails
 * the run at the first skewed arm.) The current code reclaims every family in
 * every arm. The table is EIGHT families now: `logs` had no runtime producer at
 * all and left the rule table with its row. Unbounded growth with no notice at all — strictly worse than the
 * suspension this file works hard to disclose, because a suspended sweep at least
 * says so. Future mtimes are ordinary: NTP correcting a clock that ran ahead, an
 * archive restored with preserved timestamps, a network mount whose clock is
 * skewed against this host's.
 *
 * Clamping the difference at zero fixes nothing — it makes the age permanently
 * zero, which is immortality spelled differently. So there is a SUBSTITUTE CLOCK
 * and, where even that fails, a DISCLOSURE.
 *
 * mtime stays PRIMARY and the substitutes are consulted only when it is
 * untrustworthy, which is what keeps every existing behaviour intact: an artefact
 * restored from an archive with a 2019 mtime is reclaimed on that mtime, exactly
 * as before, and every fixture in this suite that backdates an mtime on a file
 * created seconds ago still ages that file. Substitutes are `birthtime` and
 * `ctime`; among them the YOUNGEST wins, so an artefact is reclaimed only when
 * every clock that can be trusted agrees it is past the TTL.
 *
 * ── AN EPOCH-0 BIRTHTIME IS NOT A STAMP, AND YOUNGEST-WINS DID NOT SAVE IT ───
 * Node reports `birthtimeMs === 0` where the filesystem cannot answer at all.
 * This docblock used to argue the sentinel was harmless because `ctime` — bumped
 * to now by the very `utimes` call that plants a future mtime — is the younger
 * answer and wins. TRUE ONLY WHILE CTIME IS TRUSTWORTHY, and the scenario this
 * file names three times breaks exactly that: a network mount whose clock is
 * skewed against this host carries mtime AND ctime forward together, and a
 * filesystem without birthtime is precisely where Node reports 0. With both real
 * clocks refused the sentinel became the SOLE substitute,
 * `trustworthyAgeSince(0, now)` answered ~56 years, and the artefact was
 * reclaimed with no notice — this rule's own defect class, re-entered through a
 * sentinel value.
 *
 * So a 0 is dropped before it can be aged. MEASURED through the sweep with
 * `statSync` stubbed per triple, nine rows, the last of which is the one that
 * moves (pinned in __tests__):
 *
 *   DELETE  mtime OLD, rest now                       control
 *   keep    mtime NOW                                 control
 *   keep    mtime FUTURE, ctime now, birthtime now
 *   keep    mtime FUTURE, ctime now, birthtime 0      the old argument, and it
 *                                                     does hold here
 *   keep    mtime FUTURE, ctime FUTURE, birthtime now
 *   keep    mtime/ctime/birthtime ALL FUTURE          → UNAGED notice
 *   keep    mtime FUTURE, ctime FUTURE, birthtime 0   → UNAGED notice; DELETED
 *                                                     silently before this
 *   DELETE  mtime FUTURE, ctime OLD, birthtime OLD    correct
 *   keep    mtime NOW, ctime OLD, birthtime OLD       mtime stays primary
 *
 * It costs nothing on a filesystem that genuinely has no birthtime: there `ctime`
 * is the answer this docblock already assumed wins, and it still is.
 *
 * `null` is still KEEP, at every call site, and it is now announced instead of
 * absorbed: see announceUnagedArtefacts. An entry no clock can place is the same
 * unbounded growth the suspension is, and the same remedy shape — only the user
 * can fix a clock.
 *
 * A VANISHED entry is kept apart from an unaskable one deliberately. Every TTL
 * rule here reads a `readdir` snapshot and then stats each name, so a concurrent
 * writer's cleanup lands an ENOENT between the two calls; reporting that as an
 * anomaly would put a notice in front of a user about a file that is already
 * gone. Any OTHER errno is a real refusal — a directory listable without `+x`
 * (mode 0o444) is the constructible shape: `readdir` answers, every stat inside
 * it does not — and that one is reported, because it holds artefacts this sweep
 * can never reclaim.
 */
type EntryAge =
  | { readonly kind: 'age'; readonly ageMs: number }
  | { readonly kind: 'vanished' }
  | { readonly kind: 'unaged' };

function entryAge(filePath: string, nowMs: number): EntryAge {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return { kind: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'vanished' : 'unaged' };
  }
  const byMtime = trustworthyAgeSince(stat.mtimeMs, nowMs);
  if (byMtime !== null) return { kind: 'age', ageMs: byMtime };
  // `birthtimeMs === 0` is Node's "this filesystem cannot answer", not a stamp —
  // it is dropped rather than aged. See the docblock's last section.
  const substitutes = [...(stat.birthtimeMs === 0 ? [] : [stat.birthtimeMs]), stat.ctimeMs]
    .map((stamp) => trustworthyAgeSince(stamp, nowMs))
    .filter((age): age is number => age !== null);
  if (substitutes.length === 0) return { kind: 'unaged' };
  return { kind: 'age', ageMs: Math.min(...substitutes) };
}

// `unaged` is REQUIRED rather than optional: it is the disclosure channel, and a
// new TTL rule that forgot to pass it would silently re-open the exact defect
// above. TypeScript asks for it at every call site instead.
function isOlderThan(filePath: string, ttlMs: number, nowMs: number, unaged: string[]): boolean {
  const age = entryAge(filePath, nowMs);
  if (age.kind !== 'age') {
    if (age.kind === 'unaged') unaged.push(filePath);
    return false;
  }
  return age.ageMs >= ttlMs;
}

/**
 * Is the EVIDENCE a rule reads from THERE, absent, or unanswerable? — the same
 * three-way split `entryAge` makes about a timestamp, made about existence.
 *
 * `fs.existsSync` cannot express the third answer: it returns FALSE for every
 * failure, so "nothing is there" and "this process may not look" arrive as one
 * value. That is the fail-open direction wherever absence licenses a DELETION,
 * and the orphan TTL is exactly such a rule — "abandoned before architecture
 * compilation" was decided from `existsSync(runDir/architecture-v1.json)`, so a
 * run holding a real compiled architecture under a run directory with no `+x`
 * (mode 0o000) was PLANNED for deletion with that reason and no notice anywhere.
 *
 * THE REALISED LOSS DOES NOT LAND TODAY, and the price is UNDETERMINED rather
 * than zero. DRIVEN on the real shape (`chmod 0o000` on a run directory holding a
 * genuine `architecture-v1.json`, load 16.64 before / 18.74 after):
 *
 *   before  PLAN 1 action — "abandoned before architecture compilation and older
 *           than 3 days" — and ZERO notices. APPLY removed 0 / failed 1, with the
 *           filesystem-error notice: the same missing `+x` blocks the recursive
 *           `rmSync`, so the bytes survive.
 *   after   PLAN 0 actions, ONE notice (the UNAGED disclosure naming the run
 *           directory), APPLY removed 0 / failed 0, bytes untouched.
 *
 * So what the defect costs on THIS shape is not the run: it is the dry-run report
 * a SessionStart hook puts in front of a user and an LLM, which said a run that
 * reached PLAN_READY was minted and abandoned, and said nothing else. Nobody has
 * constructed a cause that blinds this stat while leaving the removal able to
 * proceed (a network mount answering EIO on the stat and succeeding on the unlink
 * is the shape to look for), so the DATA-loss price stays undetermined. Note also
 * that the run is not saved by liveness — `liveRunIds` holds only the current run
 * in that fixture, measured — so the presence question really is the last thing
 * standing between it and the plan. It is fixed because the decision STRUCTURE is the one this
 * file corrects everywhere else — descendRecognition treats a failed syscall as
 * ignorance rather than as an answer about the tree, `Unenumerable` was built so
 * ignorance one level down could not be spent as a durable verdict, and
 * TRANSIENT_READ_ERRNOS exists because a read failure is not a fact about a file.
 * A rule that cannot tell must not delete, whether or not today's filesystem
 * happens to save it.
 *
 * ENOENT IS THE ONLY 'absent', and a dangling symlink still lands there (both
 * `stat` and `existsSync` follow links and answer ENOENT), so the one behaviour
 * this narrowing changes is the errno set nobody wants folded: EACCES, EIO,
 * ELOOP, ENAMETOOLONG, EPERM.
 */
type EntryPresence = 'present' | 'absent' | 'unknown';

function entryPresence(filePath: string): EntryPresence {
  try {
    fs.statSync(filePath);
    return 'present';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown';
  }
}

/**
 * Can this process TRAVERSE a directory — reach a path inside it — which is what
 * the run-evidence stats need and nothing else here does. Asked once per sweep, and
 * only when an evidence read actually failed and the cause has to be attributed.
 *
 * IT IS ONE OF TWO CAPABILITIES AND IT IS NOT THE ONE THE PRUNING RULES NEED. This
 * is the search bit; `readdir` needs the read bit; the two move independently, so
 * every consumer asks for its own (listRoot for the rules, this for the evidence).
 * Asking this on behalf of both is exactly how the read-bit half of the state space
 * went undisclosed, and the sentence that did it stood in this docblock. RECORDED
 * VERBATIM, because a disclosure resting on a false reason stops the next reader
 * looking:
 *
 *   "0o111 — traversable but not listable — is `present` here, and correctly: the
 *    evidence stats succeed there, nothing is reserved on unknown evidence, and no
 *    notice about a retained window would be true."
 *
 * The first two clauses are true and the third is FALSE, and the state it is false
 * in is one `chmod` from the state it was written to explain. MEASURED at `runs/`
 * 0o111 and 0o100, five runs holding 64 KB each with 32 KB in each of three sidecar
 * directories, `keepRuns: 1` (load 2.86 of 10 CPUs): `readdir` EACCES, every
 * evidence stat OK, so nothing reserved and nothing to explain — and the run
 * directories therefore invisible to the pruning loop and to the orphan TTL,
 * 320 KB → 320 KB, five of five surviving, `planned: 0` still at +400 days,
 * `removed: 9` reported as success on the sidecars alone, ZERO notices and a
 * null advisory. Permanent and silent, which is the shape the header of this
 * file calls its worst failure mode — reached through the OTHER bit.
 *
 * `entryPresence(runsDir)` IS STILL NOT THIS QUESTION, and asking it there would be
 * a silent no-op: `statSync` of a directory needs search permission on its PARENT,
 * not on itself, so `runs/` at 0o000 answers `present` exactly as a healthy one
 * does. MEASURED over ten modes (mode-census.ts, uid 502): a stat of the directory
 * answers `ok` at every one of them, while a stat of a path UNDER it answers EACCES
 * at 0o000, 0o200, 0o400, 0o444 and 0o600 — row for row what a stat of
 * `runs/<id>/run.json` answers on the same modes, which is the agreement this helper
 * exists to have.
 *
 * `${dir}${path.sep}.` rather than `path.join(dir, '.')`, which normalises the
 * `.` away and asks the useless question above.
 */
function directoryEnterable(dir: string): EntryPresence {
  return entryPresence(`${dir}${path.sep}.`);
}

function nestedLeakActions(cwd: string, dryRun: boolean, notices?: string[]): RetentionAction[] {
  const actions: RetentionAction[] = [];
  for (const nested of listNestedTrafficOneDirs(cwd, notices)) {
    const reason = 'leaked nested Traffic One state root inside ancestor workspace';
    for (const action of leakedRootActions(nested, reason, dryRun, notices)) {
      maybeAction(actions, action.path, action.reason);
    }
  }
  return actions;
}

/**
 * Are the two RUN-HISTORY caps off?
 *
 * Shape, not identity. This used to compare against a single module constant,
 * which was the honest witness while "suspended" was a whole-policy verdict;
 * now that a suspension turns off two fields and leaves the other two carrying
 * the user's real numbers, there is no constant left to point at.
 *
 * Nothing is lost by asking about the shape, because what the answer LICENSES
 * is plan-equivalence rather than a policy claim: with both of these at
 * MAX_SAFE_INTEGER the newest-N loop keeps every id it sees and every TTL
 * comparison in the run-scoped rules is false, so skipping them plans exactly
 * what running them would. A user who hand-writes both caps that large gets the
 * same empty plan the short way round instead of the long way round.
 */
function runCapsSuspended(policy: RetentionPolicy): boolean {
  return policy.keepRuns === Number.MAX_SAFE_INTEGER
    && policy.orphanTtlDays === Number.MAX_SAFE_INTEGER;
}

/**
 * WHICH caps are off — the same shape question, asked with the resolution the
 * notices need.
 *
 * `runCapsSuspended` answers what collectActions has to decide (may the run-scoped
 * rules be skipped), and that is a two-valued question. A notice promising
 * reclamation needs a three-valued one, because the two suspensions differ in
 * exactly the way the promise turns on: an illegible `retention.json` takes ALL
 * FOUR caps and nothing is reclaimable at all, while an illegible `.one.json` takes
 * the run caps and leaves the backup and Lighthouse numbers the user wrote. See
 * readPolicy for why the two files differ, and unreachablePromise for the 0 → 0 and
 * 0 → 2 measurements that separate them.
 *
 * Shape rather than identity, for the reason runCapsSuspended gives: with a cap at
 * MAX_SAFE_INTEGER nothing that cap governs can ever be planned, however the number
 * got there, and a user who hand-writes it gets the sentence that is true of their
 * project.
 */
type CapSuspension = 'none' | 'run-caps' | 'every-cap';

function capSuspension(policy: RetentionPolicy): CapSuspension {
  if (!runCapsSuspended(policy)) return 'none';
  return policy.backupKeep === Number.MAX_SAFE_INTEGER
    && policy.lighthouseKeepPerRoute === Number.MAX_SAFE_INTEGER
    ? 'every-cap'
    : 'run-caps';
}

function collectActions(cwd: string, policy: RetentionPolicy, nowMs: number, dryRun: boolean, protectRunIds: readonly string[] = [], notices?: string[], illegibleInputs: readonly string[] = []): { keep: Set<string>; live: Set<string>; actions: RetentionAction[] } {
  const t1 = path.join(cwd, '.traffic-one');
  const actions: RetentionAction[] = [];
  const suspended = runCapsSuspended(policy);

  // With the run caps off, none of the run-scoped rules below can schedule
  // anything: `keepRuns` at MAX_SAFE_INTEGER keeps every id the newest-N loop
  // sees, and `orphanTtlDays` at MAX_SAFE_INTEGER makes every TTL comparison
  // false. Walking the tree to establish that is work spent on a foregone
  // answer, and it is the work that grows with the very thing the suspension
  // permits to grow — keeping every run means asking the liveness question
  // about every run, once per run, at SessionStart. So the run-scoped rules are
  // skipped rather than computed, which is sound precisely BECAUSE the answer
  // is foregone: see runCapsSuspended for the plan-equivalence this rests on.
  // MEASURED (see __tests__ for the full table): the walk is what costs, and
  // not taking it is 158 ms p95 → 5.6 ms at 1,000 runs, 846 ms → 22.7 ms at
  // 4,000, against a 150 ms p95 SessionStart budget.
  //
  // What is NOT skipped is the two rules whose numbers can SURVIVE a
  // suspension — the backup cap and the per-route Lighthouse cap, both below
  // the guard. Neither reads `.one.json`, so an illegible one leaves their caps
  // exactly as the user wrote them and they must keep firing; an illegible
  // retention.json takes their numbers with everything else, and then they
  // no-op on their own (`slice(MAX_SAFE_INTEGER)` is empty) without needing to
  // be told. See readPolicy for why the two files differ here.
  //
  // This is the bound on a suspension that is otherwise indefinite, and it is
  // deliberately not a deletion: run history still grows, but the SessionStart
  // path stops paying a per-run price for it, which is where the 150 ms budget
  // was actually within reach. Liveness is reported empty because nothing is
  // being retained for being alive — every run is retained for the same one
  // reason, and it is not that.
  // A SUSPENSION reserves nothing on unreadable evidence, so it has nothing of
  // that kind to disclose: every id is kept for one reason and it is the one
  // announceSuspension already names.
  const { keep, live, reservedBehindRunsDir, runsEnterable } = suspended
    ? {
      keep: new Set<string>([...collectRunIds(cwd), ...protectRunIds]),
      live: new Set<string>(),
      reservedBehindRunsDir: 0,
      runsEnterable: null,
    }
    : keepRunIds(cwd, policy, nowMs, protectRunIds);

  // Every entry a TTL rule below could not place on any clock. Collected across
  // all of them and announced ONCE at the end: every ephemeral family times
  // however many artefacts each holds is not a report a user reads. See
  // isOlderThan.
  const unaged: string[] = [];
  // Every root a rule below had to ENUMERATE and could not, with the errno, for
  // the same reason UNAGED exists and announced the same way: a listing that
  // failed is not an empty directory. See listRoot for the ten-root measurement
  // that made this a channel rather than a `runs/` special case, blameDirectory
  // for the walk from a rule's failure to the directory a user can act on, and
  // announceUnreachableStateDirs for what is then true of the state.
  //
  // A SUSPENSION COLLECTS HERE TOO, and the sentence that stood in this comment
  // said it does not. Recorded verbatim, because it is why nobody looked: "A
  // SUSPENSION collects nothing here because it takes no listing it acts on:
  // `collectRunIds` reads the same roots to build a keep set nothing consumes,
  // and announceSuspension already names the one reason every id is kept." The
  // first clause is true of the rules INSIDE the `!suspended` guard and false of
  // the two below it — the backup cap and the per-route Lighthouse cap call
  // listRoot unconditionally, by the design three paragraphs up. So the notice
  // fires under a suspension, and what it may PROMISE there is not what it may
  // promise here: see unreachablePromise for the 0 → 0 measurement.
  const unlistable: RootFailure[] = [];
  // The directory whose traversal blinded the run-evidence reads. Attributed to a
  // directory rather than to the run directories inside it — see the UNAGED push
  // below, which is where the two notices used to contradict each other — and
  // walked to rather than assumed to be `runs/`: at `runs/` 0o400 the fault is
  // `runs/` itself, and at `.traffic-one` 0o000 it is `.traffic-one`, which is a
  // directory no rule here enumerates.
  const runsUnenterable = runsEnterable === 'unknown'
    ? blameDirectory(path.join(t1, 'runs'), 'EACCES', cwd)
    : null;

  if (!suspended) {
    for (const rel of RUN_SCOPED_DIRS) {
      const root = path.join(t1, rel);
      for (const id of listRoot(root, unlistable).dirs) {
        if (id === '.once') continue;
        if (!keep.has(id)) maybeAction(actions, path.join(root, id), `older than retained run set (${policy.keepRuns})`);
      }
    }

    // Runs that never reached a compiled architecture are not runs — they were
    // minted, captured a baseline, and abandoned. Observed 8cl: a run minted 3.5
    // minutes AFTER the previous one settled `agent-failed`, holding a 1.63 MB
    // baseline, still `status: active`, while `currentRunId` stayed on the earlier
    // run. Nothing reclaimed it because the keep-set counts it as one of the five
    // most recent. The TTL keeps an in-flight pre-PLAN_READY run untouched.
    //
    // This rule deletes runs the keep set RETAINED, so it needs the liveness
    // question asked separately — being inside `keep` is not what protects a run
    // here. A pre-PLAN_READY run that is still holding live claims is the very
    // shape the TTL was meant to spare, and the TTL alone does not spare it: a
    // long-lived or resumed run passes 3 days while an agent is working in it.
    const ttl = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
    const currentRunId = readCurrentRunId(cwd);
    for (const id of listRoot(path.join(t1, 'runs'), unlistable).dirs) {
      if (id === '.once' || id === currentRunId || protectRunIds.includes(id) || live.has(id)) continue;
      const runDir = path.join(t1, 'runs', id);
      if (actions.some((action) => action.path === runDir)) continue;
      // "No architecture" is a DELETION PREMISE, so it may not be inferred from a
      // failed stat: see entryPresence. `unknown` keeps the run and joins the
      // UNAGED disclosure, whose remedy (`chmod u+rx`) is precisely the cause and
      // whose outcome — kept, indefinitely, until the user acts — is the truth
      // about it. It is folded into that channel rather than given a fifth notice
      // because the sentence, the remedy and the outcome all already match; what
      // is bought by a separate notice is a second thing to keep true.
      //
      // UNLESS A DIRECTORY IS THE CAUSE, and this is where two notices used to
      // fire about the same run directories and contradict each other on the
      // remedy. When the directory holding the evidence cannot be read, EVERY stat
      // under it fails for that one reason: nothing was read about these
      // artefacts, so UNAGED's sentence ("no timestamp this host can trust ...
      // `touch` the paths") is false of all of them, and its remedy names the
      // wrong path. The directory is announced once, in its own words, by
      // announceUnreachableStateDirs.
      //
      // ASKED OF THE FILESYSTEM, not of `runs/` by name. The guard here was
      // `runsUnenterable === null`, which is the question "is the parent I thought
      // of the cause?" — true at `runs/` 0o400/0o444/0o600, where it was measured,
      // and false one level down. MEASURED at `runs/<id>` 0o000 with `runs/`
      // healthy: the contradiction came straight back, UNAGED naming the run
      // directory to `touch` beside RETAINED saying there was nothing a `touch`
      // would change, and the `touch` it printed SUCCEEDED while changing nothing
      // about a stat that fails on the directory's own mode. directoryFault
      // answers for whatever level actually holds the fault, and `null` — the run
      // directory reads fine — is what leaves the entry in UNAGED, where a stat
      // that failed for the FILE's own reasons belongs.
      const compiled = entryPresence(path.join(runDir, 'architecture-v1.json'));
      if (compiled === 'present') continue;
      if (compiled === 'unknown') {
        const fault = directoryFault(runDir, cwd);
        if (fault === null) unaged.push(runDir);
        else unlistable.push({ root: fault.dir, errno: fault.errno });
        continue;
      }
      if (!isOlderThan(runDir, ttl, nowMs, unaged)) continue;
      maybeAction(actions, runDir, `abandoned before architecture compilation and older than ${policy.orphanTtlDays} days`);
    }

    const ttlMs = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
    for (const rel of ONCE_DIRS) {
      const root = path.join(t1, rel);
      const entries = listRoot(root, unlistable);
      for (const name of [...entries.dirs, ...entries.files]) {
        const target = path.join(root, name);
        if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs, unaged)) {
          maybeAction(actions, target, `stale one-time marker older than ${policy.orphanTtlDays} days`);
        }
      }
    }

    for (const rel of EPHEMERAL_LOCKS) {
      const target = path.join(t1, rel);
      if (fs.existsSync(target) && (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs, unaged))) {
        maybeAction(actions, target, `stale lock older than ${policy.orphanTtlDays} days`);
      }
    }

    const debugRoot = path.join(t1, DEBUG_DIR);
    for (const name of listRoot(debugRoot, unlistable).files) {
      const target = path.join(debugRoot, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs, unaged)) {
        maybeAction(actions, target, `stale debug log older than ${policy.orphanTtlDays} days`);
      }
    }

    // Per-run diagnostic captures (claim-capture.jsonl, plan-guard-deny.jsonl)
    // live under runs/<id>/debug/ and were previously reclaimed only when the
    // whole run dir aged out of the keep set — RETAINED runs kept them forever.
    for (const id of listRoot(path.join(t1, 'runs'), unlistable).dirs) {
      if (id === '.once') continue;
      const runDebug = path.join(t1, 'runs', id, DEBUG_DIR);
      for (const name of listRoot(runDebug, unlistable).files) {
        const target = path.join(runDebug, name);
        if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs, unaged)) {
          maybeAction(actions, target, `stale run debug log older than ${policy.orphanTtlDays} days`);
        }
      }
    }

    for (const rel of TTL_ARTEFACT_DIRS) {
      const root = path.join(t1, rel);
      const entries = listRoot(root, unlistable);
      for (const name of [...entries.dirs, ...entries.files]) {
        const target = path.join(root, name);
        if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs, unaged)) {
          maybeAction(actions, target, `stale ${rel} artefact older than ${policy.orphanTtlDays} days`);
        }
      }
    }
  }

  // ── the two rules an IDENTITY suspension does not reach ────────────────────
  // Cost is O(entries in one directory) rather than O(runs), so running them
  // outside the guard does not reintroduce the walk it declines to take.
  const backups = listRoot(path.join(t1, BACKUPS_DIR), unlistable).dirs.sort(numericDesc);
  for (const name of backups.slice(policy.backupKeep)) {
    maybeAction(actions, path.join(t1, BACKUPS_DIR, name), `older than retained backup set (${policy.backupKeep})`);
  }

  // Lighthouse reports carry a timestamp in their filename, so no run ever
  // supersedes the previous one and a TTL-only sweep keeps every copy inside the
  // window. Observed 9co: 10 HTML+JSON pairs, 13.6 MB, one run — while the actual
  // evidence artefact is an 863-byte `lighthouse-evidence-v1.json` in the QA dir.
  // Keep the newest few per route; the rest are superseded duplicates.
  const lighthouseRoot = path.join(t1, LIGHTHOUSE_DIR);
  // Reports are written run-scoped (`reports/lighthouse/<runId>/…`); pre-1.0.40
  // artefacts sit flat in the root, so both layouts are swept.
  for (const dir of ['', ...listRoot(lighthouseRoot, unlistable).dirs]) {
    const root = dir ? path.join(lighthouseRoot, dir) : lighthouseRoot;
    const byRoute = new Map<string, string[]>();
    for (const name of listRoot(root, unlistable).files) {
      if (actions.some((action) => action.path === path.join(root, name))) continue;
      // `<route>[-<buildTag>]-<ISO timestamp>.report.{json,html}` — group on the
      // route+build prefix, so a new build never supersedes another build's file.
      const match = /^(.*?)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.report\.(?:json|html)$/.exec(name);
      if (!match) continue;
      const bucket = byRoute.get(match[1]!) || [];
      bucket.push(name);
      byRoute.set(match[1]!, bucket);
    }
    for (const [, names] of byRoute) {
      // Two files per run (json + html), so keeping 2 runs means 4 files.
      for (const name of names.sort().reverse().slice(policy.lighthouseKeepPerRoute * 2)) {
        maybeAction(
          actions,
          path.join(root, name),
          `superseded Lighthouse report (keeping ${policy.lighthouseKeepPerRoute} per route)`,
        );
      }
    }
  }

  if (unaged.length > 0) announceUnagedArtefacts(unaged, notices);
  // WHAT THIS SWEEP COULD NOT READ, announced AFTER every rule has run, because
  // the subject is the set of directories at fault and that set is not complete
  // until the last rule has tried. A KEEP nothing here can ever release, said out
  // loud — and in its own words rather than in the UNAGED ones, which are false
  // about it. See announceUnreachableStateDirs.
  //
  // EACH FAILURE IS WALKED TO ITS CAUSE FIRST, and the dedupe is on the answer
  // rather than on the question. `runs/` unreadable is three failures and one fact
  // because three rules enumerate it (the newest-N loop, the orphan TTL and the
  // per-run debug sweep); `.traffic-one` unreadable is NINE failures and one fact,
  // and no rule enumerates that directory at all — which is why deduping the
  // questions could never have found it. The walk also makes an ancestor filter
  // unnecessary: it has already ascended past every level a parent explains, so a
  // reported pair can never be an ancestor of another (pinned in __tests__).
  const blamed = new Map<string, UnreachableRoot>();
  for (const failure of unlistable) {
    const fault = blameDirectory(failure.root, failure.errno, cwd);
    if (!blamed.has(fault.dir)) blamed.set(fault.dir, fault);
  }
  announceUnreachableStateDirs({
    unreachable: [...blamed.values()],
    runsUnenterable,
    reservedIds: reservedBehindRunsDir,
    suspension: capSuspension(policy),
    illegibleInputs,
    projectDir: cwd,
  }, notices);

  actions.push(...nestedLeakActions(cwd, dryRun, notices));

  return { keep, live, actions };
}

export function sweepTrafficOneRetention(cwd: string, opts: { dryRun?: boolean; nowMs?: number; protectRunIds?: readonly string[] } = {}): RetentionResult {
  const dryRun = opts.dryRun !== false;
  const notices: string[] = [];
  const illegibleInputs: string[] = [];
  const policy = readPolicy(cwd, notices, illegibleInputs);
  const { keep, live, actions } = collectActions(cwd, policy, opts.nowMs ?? Date.now(), dryRun, opts.protectRunIds ?? [], notices, illegibleInputs);
  let removed = 0;
  let failed = 0;
  if (!dryRun) {
    for (const action of actions) {
      try {
        if (removePath(action.path)) removed += 1;
      } catch (error) {
        // Best-effort: never abort cleanup because one path is busy. But a THROW
        // is not the same as the fence's `false`, and folding them together made
        // this the one deletion outcome nothing reported. `rmSync` throws when the
        // tree holds a child directory it cannot read — a `0o111` subdirectory is
        // the constructible shape, and the errno that surfaces is EACCES from
        // `scandir` on THAT subdirectory: the walk stops at the entry it cannot
        // read rather than absorbing it and failing on the parent.
        //
        // It is COUNTED, and the count used to be the false part of this comment:
        // "the path is still there either way, so the count stays honest". The
        // path is, and the count is not. Driven against the whole-root action the
        // `0o111` shape above describes, the recursive rm took `.one.json` before
        // it threw — `before [.one.json, debug, runs] → after [debug, runs]`, the
        // casualty list being the iteration order's prefix and so the
        // filesystem's business — and the sweep reported `removed: 0`, which reads as
        // "nothing was reclaimed" about a project whose state file had just been
        // destroyed. `removed` counts paths this sweep can attest went completely;
        // `failed` is where the rest of that story is, and every consumer of
        // `planned - removed` now subtracts it before calling the remainder a
        // refusal.
        failed += 1;
        collectRetentionAnomaly(
          notices,
          // The errno TEXT carries the path too — node spells it into every
          // `EACCES: … scandir '<path>'` / `ENOTEMPTY: … rmdir '<path>'` — so the
          // rendering is applied to the whole sentence rather than to
          // `action.path` alone, and note the path it names is the entry that
          // threw, which on a recursive walk is USUALLY NOT `action.path`.
          // Redaction is
          // per separator-delimited run, so an ordinary message keeps its errno
          // and its verb and loses only the segment that could not be spoken.
          agentVisiblePath(
            `could not remove ${action.path}: ${error instanceof Error ? error.message : String(error)}`,
          ) + '\n'
          + '  This is an error from the filesystem rather than a refusal by the state-write fence — commonly a'
          + ' directory inside it that this process may not read (`chmod -R u+rwX` on that tree) or a file another'
          + ' process is holding open. Removal is recursive, so part of what was inside this path may already be'
          + ' gone; what is left is listed by `ls -a`. Nothing else was skipped because of it.',
        );
      }
    }
  }
  return {
    cwd,
    dryRun,
    policy,
    keepRunIds: [...keep].sort(numericDesc),
    liveRunIds: [...live].sort(numericDesc),
    actions,
    removed,
    failed,
    notices,
  };
}

/**
 * The sweep's standing anomalies as ONE block, or `null` when it met none.
 *
 * Byte-identical to what went to stderr, prefix included, so there is one text to
 * read and one text to grep for — a second wording of the same remedy is a second
 * thing to keep true. The caller decides the SURFACE: session-start merges this
 * onto its advisory list beside the uncertified-host banner and the one-mcp
 * warning, which is the mechanism this codebase already uses for "an operational
 * condition the user may need to act on".
 *
 * ── WHO ACTUALLY READS IT, MEASURED, BECAUSE THIS DOCBLOCK SAID OTHERWISE ─────
 * The sentence above used to open "as ONE block a host can put in front of a
 * user". Driven end to end through the real hook on a materialized project with
 * `runs/` at 0o111: the SessionStart payload is `kind=context`, 1852 bytes,
 * `systemMessage: **null**`, with this advisory as the prefix of the context —
 * and a second consecutive session carries it byte for byte again. So:
 *
 *   IT REACHES THE MODEL, NOT THE HUMAN. `systemMessage` is the only human-visible
 *   channel a hook has and no retention notice uses it; the user sees this text
 *   only if the model chooses to relay it. Every remedy in this file is written for
 *   a reader with a shell, and the reader who gets it is an agent.
 *
 *   IT REPEATS FOR AS LONG AS THE CONDITION LASTS. The dedupe in this file is
 *   stderr-only. The three neighbours on that same advisory list are throttled by
 *   `firstEmitThisSession` (auth revalidation, the updates feed, the uncertified-host
 *   banner) and this one is not, so a permanent condition — which is exactly what an
 *   unreachable directory is until someone runs the `chmod` — re-injects ~817 bytes
 *   into every session forever.
 *
 * BOTH ARE DECLINED HERE AND NAMED RATHER THAN LEFT AS A SURPRISE, because the fix
 * for each is a call in modules/session/session-start.ts (a `systemMessage` on the
 * authed branch; a `firstEmitThisSession(cwd, 'retention-advisory', sessionId)`
 * around the merge at the `retentionNotice` assignment) and that file is outside
 * this lane's fence. What is fixed here is the false claim about it: this function
 * cannot put anything in front of a user, and no caller currently does.
 */
export function retentionAdvisory(notices: readonly string[]): string | null {
  if (notices.length === 0) return null;
  return notices.map((notice) => `${RETENTION_ANOMALY_PREFIX}${notice}\n`).join('');
}

/**
 * What the post-settlement sweep achieved. It exists because the three answers
 * below used to be ONE answer — `void` — and the two that are not "all fine"
 * are the ones a caller most needs:
 *
 *   - `swept`, `planned === removed`: the sweep ran and got what it planned.
 *     `planned === 0` says there was nothing to reclaim, which is a DIFFERENT
 *     fact from the next one and used to be indistinguishable from it.
 *   - `swept`, `refused > 0`: the sweep ran, planned N deletions, and the state-
 *     write fence REFUSED some of them. `removePath` answers `false` for exactly
 *     two things — a refused guard (unanswered use-plugin consent, a planted
 *     symlink, a path escaping the state dir) and `ELOOP` — so this count is
 *     refusals and nothing else. That sentence used to be false: `refused` was
 *     `planned - removed`, and a removal that THREW landed in it, so a user was
 *     told verbatim about consent and symlinks when what had happened was an
 *     ENOTEMPTY. The throw has its own count now (see `errored`) and is
 *     subtracted out before this one is computed, which is what makes the
 *     sentence true again. It is still the reachable failure here: a project
 *     whose consent question is unanswered refuses EVERY path, so every terminal
 *     settlement reclaims nothing, forever, and said so to nobody.
 *   - `swept`, `errored > 0`: a planned removal threw. Distinguished because the
 *     remedy is a different one and because a recursive removal that throws may
 *     have destroyed most of a tree first — see RetentionResult.failed for the
 *     measured shape of that.
 *   - `failed`: an exception escaped. How much had been reclaimed first is NOT
 *     reported, because it is not knowable from out here — claiming `removed: 0`
 *     would be inventing the one number the failure destroyed.
 */
export type TerminalSweepReport =
  | {
    readonly status: 'swept';
    /** Paths the sweep decided to reclaim. */
    readonly planned: number;
    /** Paths it actually reclaimed. */
    readonly removed: number;
    /** `planned - removed - errored` — deletions the write chokepoint refused. */
    readonly refused: number;
    /**
     * Planned paths whose removal threw a filesystem error — never a refusal.
     * `status: 'failed'` is the OTHER thing: there the exception escaped the
     * sweep entirely and there are no counts at all.
     */
    readonly errored: number;
    /**
     * The sweep's standing anomalies, verbatim — see RetentionResult.notices.
     *
     * CARRIED rather than dropped, and the drop was a type-level gap with a
     * behavioural cost: this report used to end at `refused`, so a suspended or
     * reduced project reported `planned: 0, removed: 0, refused: 0` here — a
     * clean bill of health — and NEITHER caller could have propagated the
     * remedy if it had wanted to. A disclosure channel that stops at a type is
     * still a disclosure channel that reaches nobody.
     *
     * Only the `swept` arm carries it. On `failed` the result object never came
     * back, so there is no list to report and inventing an empty one would say
     * "no anomalies" about a sweep that threw.
     */
    readonly notices: readonly string[];
  }
  | {
    readonly status: 'failed';
    /** The swallowed error, as text. Never prose the caller should parse. */
    readonly reason: string;
  };

// Rendered for prose at the point it becomes text, because both of this value's
// destinations are agent-visible: `reportSweepAnomaly` writes it to stderr and
// the `failed` arm RETURNS it as `reason`, which run-status surfaces. A node
// filesystem error spells the offending path into its own message, so the name
// arrives here even though nothing interpolates one deliberately.
function sweepErrorText(error: unknown): string {
  return agentVisiblePath(error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error));
}

// Fail-open, not fail-silent — the rule state/decision-log.ts already spells out
// for its own swallowed failures. A returned report only reaches a caller that
// consults it, and one of the two callers here DECLINES to (see
// materialize/build-complete.ts: its own callers do compose user-visible text,
// and widening two return types to reach them is the cost being declined), so
// the anomaly is also announced at the point it is swallowed. Both branches are
// anomalous by construction, so this is not a per-settlement log line.
const RETENTION_ANOMALY_PREFIX = '[traffic-one] retention sweep ';

function reportRetentionAnomaly(detail: string): void {
  try {
    process.stderr.write(`${RETENTION_ANOMALY_PREFIX}${detail}\n`);
  } catch {
    // stderr itself can fail in exotic hosts; there is nowhere left to report this.
  }
}

function reportSweepAnomaly(detail: string): void {
  reportRetentionAnomaly(`after settlement ${detail}`);
}

/**
 * One process, one copy of each line.
 *
 * The conditions announced through here are STANDING ones — a state file that
 * will not parse, a leaked root that will not list — so every reader of them
 * says the same thing again on the next call, and the sweep is not the only
 * caller. `pruneTrafficOneBackups` reads the policy on every gitnexus
 * bootstrap, and a bootstrap runs many times in a session (measured: 9 in 18
 * minutes), so an undeduped remedy line was repeated once per bootstrap to a
 * user who needed to read it once. MEASURED before this: four bootstraps in one
 * process, four identical SUSPENDED lines.
 *
 * Keyed on the WHOLE message, so two different files — or one file failing two
 * different ways — are still each said once. Bounded because a set that only
 * grows is a leak even in a short-lived hook process, and clearing it costs at
 * most one repeated line in a process that has already produced 32 distinct
 * anomalies.
 */
const announcedAnomalies = new Set<string>();

function reportRetentionAnomalyOnce(detail: string): void {
  if (announcedAnomalies.has(detail)) return;
  if (announcedAnomalies.size >= 32) announcedAnomalies.clear();
  announcedAnomalies.add(detail);
  reportRetentionAnomaly(detail);
}

/**
 * Both channels, and only one of them is deduped.
 *
 * stderr is deduped per PROCESS because it is a stream a human might be tailing
 * and the conditions are standing ones. The returned list is not, because it is
 * an ANSWER to a caller that asked: a sweep that reports "nothing wrong" because
 * some earlier caller in this process already printed the line would hand a host
 * a clean bill of health for a suspended project.
 */
function collectRetentionAnomaly(notices: string[] | undefined, detail: string): void {
  notices?.push(detail);
  reportRetentionAnomalyOnce(detail);
}

// Post-settlement trigger: reclaim superseded artefacts the moment a run reaches
// a terminal ledger state instead of waiting for the next SessionStart (observed
// 12co: 113 run files + 9.5 MB of reports sat untouched until a later session
// swept). Runs strictly AFTER the terminal ledger write. The settled run id is
// protected EXPLICITLY: `currentRunId` alone is not enough — the deny remedies
// legitimately settle OLDER runs (blocked/failed cleanup), and an adversarial
// review proved the keep-window could reclaim the very ledger such a settle
// wrote milliseconds earlier.
//
// Still never THROWS: settlement must not fail because cleanup did, and that
// property is the correct one. What it no longer does is stay silent about it.
export function sweepAfterTerminalSettlement(cwd: string, settledRunId?: string): TerminalSweepReport {
  // A run ID is not a path, and this one is usually one the runtime minted — but
  // `runners/run-status/index.ts:140` passes `args.runId` straight off a CLI, and
  // the channel these lines ride is stderr, the reader whose erase-line attack
  // motivated CONTROL_RE in the first place. `sweepErrorText` below is already
  // wrapped whole; this value was the one interpolation here that was not.
  const forRun = settledRunId ? ` for run ${agentVisibleName(settledRunId)}` : '';
  try {
    const result = sweepTrafficOneRetention(cwd, {
      dryRun: false,
      ...(settledRunId ? { protectRunIds: [settledRunId] } : {}),
    });
    const planned = result.actions.length;
    const refused = planned - result.removed - result.failed;
    // Two reasons, two lines, and only the ones that happened. Folding the throw
    // into the refusal count made this sentence — consent, a planted symlink, a
    // path escaping the state dir — reach a user on a run where none of those
    // occurred, beside the true errno line the NIT fix had already added.
    if (refused > 0) {
      reportSweepAnomaly(
        `reclaimed ${result.removed} of ${planned} path(s)${forRun} — ${refused} refused by the state-write `
        + 'fence (unanswered use-plugin consent, a planted symlink, or a path escaping the state dir)',
      );
    }
    if (result.failed > 0) {
      reportSweepAnomaly(
        `reclaimed ${result.removed} of ${planned} path(s)${forRun} — ${result.failed} could not be removed by the `
        + 'filesystem (see the per-path errno above); a recursive removal that fails may already have reclaimed '
        + 'part of what was inside the path',
      );
    }
    return {
      status: 'swept', planned, removed: result.removed, refused, errored: result.failed, notices: result.notices,
    };
  } catch (error) {
    const reason = sweepErrorText(error);
    reportSweepAnomaly(`failed${forRun}: ${reason} — how much it had reclaimed first is unknown`);
    return { status: 'failed', reason };
  }
}

// Enforce the backup cap at WRITE time. The full sweep only runs at SessionStart,
// so a session that re-bootstraps the code graph N times accumulates N snapshots
// (measured: 9 in 18 minutes under `backupKeep: 3`, all byte-identical). `keepName`
// is the snapshot the caller may still restore from — never a candidate — and at
// least one snapshot always survives even when the policy asks for zero.
//
// The ONE caller that stays on stderr, and the caller the notices docblock's
// census should have named. `readPolicy` is called without a notices array on
// purpose — DECLINED, not impossible, and the difference matters because the
// census claimed the latter and was wrong. This returns to bootstrap-env's
// backupConflicts (best-effort try/catch), which returns `Backups` to
// gitnexus/bootstrap's bootstrap(), which is entered from the gitnexus CLI (JSON
// on stdout) and from modules/graphify/post-build.ts, which composes
// `context(...)`. So there IS a surface, four levels up, and reaching it means
// widening two result types on a path whose question is "is the code graph
// built". Declined for that cost: this path reads the policy the full sweep also
// reads, so a suspension here is announced by that sweep, to a caller that
// already shows it, at the next SessionStart.
//
// That argument is sound for the SUSPENSION and unsound for the throw below, and
// the difference is what round 6 missed: the sweep's suspension notice does not
// depend on the suspension being over, while the sweep's disclosure of a failed
// backup does — the same suspension is what stops it being re-planned.
//
// THE THROW BELOW IS NO LONGER SWALLOWED, and the argument that used to decline
// it was refuted by COMPOSITION rather than by exotic input. It read:
//
//   "So the disclosure exists, one SessionStart later, from the surface that
//    already carries it"
//
// resting on a measurement of one state — a legible policy, where the next full
// sweep re-plans the path that failed and reports the ENOTEMPTY. Compose it with
// the other state this same file documents as ROUTINE (`retention.json`
// illegible: a tracked JSON file merged on two branches) and the premise is
// gone. A suspension sets `backupKeep` to MAX_SAFE_INTEGER, `slice(keep)` is
// then empty, the failed path is never planned, and the errno never reaches the
// caller's channel at all. MEASURED on five backups with `002` unremovable and
// the policy file conflict-marked: `planned: [] removed: 0 failed: 0`, no notice
// carrying the errno, and the one notice the user does get names a different
// problem with a remedy that says nothing about the broken backup. "One
// SessionStart later" becomes "one SessionStart after the user happens to repair
// an unrelated file, if ever" — inside the state the header calls unbounded
// growth bounded only by disclosure.
//
// So a throw is COUNTED as a throw here, which is the pattern RetentionResult
// .failed and TerminalSweepReport.errored already established in this file, and
// it is announced on both channels the rest of the file uses.
//
// THE RESIDUAL ROUND 6 DISCLOSED WAS WORSE THAN THE CODE, and correcting it is
// part of this change. It read: "`rmSync` is recursive, so a snapshot the caller
// still believes in may already be partly gone". A partly-destroyed snapshot
// cannot become a bad restore: gitnexus/bootstrap-env's snapshotMatchesLive
// (:143) re-hashes EVERY recorded path before a snapshot may be reused, so a
// half-emptied backup root fails that check and is not reused. The real cost is
// the dull one — a backup slot that fails, silently, forever — and that is what
// the count and the notice are for.
//
// WHAT IS STILL DECLINED, precisely: the notices are RETURNED and the caller
// does not read them. `backupConflicts` (runners/gitnexus/bootstrap-env:179) calls this
// inside `try { … } catch {}` and discards the result; carrying the line to the
// nearest user-visible surface means widening `Backups` and bootstrap's return
// type to reach modules/graphify/post-build.ts's `context(...)`, four levels up,
// on a path whose question is "is the code graph built". The census in
// RetentionResult.notices is explicit that a decline must not deny the surface
// exists — so the channel is here, at the type, and adopting it is now a change
// in ONE caller rather than a change to this signature.
export interface BackupPruneResult {
  /** Snapshots reclaimed. */
  readonly removed: number;
  /**
   * Snapshots whose removal THREW — a filesystem error, never the fence.
   * `removePath` answering `false` is a refusal and is neither of these counts.
   */
  readonly failed: number;
  /** One entry per failure, verbatim — see RetentionResult.notices. */
  readonly notices: readonly string[];
}

export function pruneTrafficOneBackups(cwd: string, keepName?: string): BackupPruneResult {
  const root = path.join(cwd, '.traffic-one', 'backups');
  const keep = Math.max(1, readPolicy(cwd).backupKeep);
  const notices: string[] = [];
  let removed = 0;
  let failed = 0;
  for (const name of listDirs(root).sort(numericDesc).slice(keep)) {
    if (keepName && name === keepName) continue;
    try {
      if (removePath(path.join(root, name))) removed += 1;
    } catch (error) {
      failed += 1;
      collectRetentionAnomaly(
        notices,
        agentVisiblePath(
          `could not remove the superseded backup ${path.join(root, name)}: `
          + `${error instanceof Error ? error.message : String(error)}`,
        ) + '\n'
        + '  This is an error from the filesystem rather than a refusal by the state-write fence — commonly a'
        + ' directory inside it that this process may not read (`chmod -R u+rwX` on that tree). The removal is'
        + ' recursive, so this snapshot may now be incomplete; it is not restored from in that state (every'
        + ' recorded path is re-hashed before a snapshot is reused), it simply occupies a slot until it goes.\n'
        + '  Nothing else was skipped because of it, and the retention sweep will not re-plan it while'
        + ' .traffic-one/retention.json is unreadable — every cap is off in that state, this one included.',
      );
    }
  }
  return { removed, failed, notices };
}
