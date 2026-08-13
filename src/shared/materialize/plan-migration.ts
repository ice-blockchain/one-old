import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { readFileNoFollow, realPathWithMissingTail } from '../fs-nofollow';
import { readJsonResult, removePath, stateWritePermitted, writeTextFile } from '../fsjson';
import { isRegisteredWorkspaceMember } from '../hook/paths';
import { statePath } from '../state/normalize';
import { hasStateFile } from '../tool-classify';

/** Why a candidate document was NOT folded and NOT removed. Every value is a
 *  refusal, so every value leaves the document exactly where it is. */
export type PlanMigrationRetainReason =
  | 'runtime-directive'
  | 'unembeddable'
  | 'symlink'
  | 'not-a-file'
  | 'unreadable'
  | 'blank'
  | 'not-carried'
  | 'changed'
  | 'remove-failed';

export interface RetainedLegacyDoc {
  relPath: string;
  reason: PlanMigrationRetainReason;
}

interface PlanMigrationResult {
  changed: boolean;
  migrated: string[];
  retained: RetainedLegacyDoc[];
  planPath: string;
}

interface LegacyDoc {
  absPath: string;
  /** Where `absPath` resolved to when it was found CONTAINED. The unlink re-
   *  establishes this rather than trusting the spelling; see `containedIn`. */
  realPath: string;
  relPath: string;
  /** VERBATIM. Never trimmed — see `migratedBlock`. */
  content: string;
  /** The FOLD key: this path carrying THESE bytes. See `contentMarker`. */
  marker: string;
  /** The DELETE key: the exact text the fold puts in the plan. See `migratedBlock`. */
  block: string;
}

const PLAN_TEMPLATE = `# Traffic One Plan

## Goal
Unverified. Review the migrated legacy plan notes below.

## Stack & rationale
Unverified. Review the migrated legacy plan notes below.

## Module map
Unverified. Review the migrated legacy plan notes below.

## Public contracts
Unverified. Review the migrated legacy plan notes below.

## Risks
- Unverified. Review the migrated legacy plan notes below.

## Cut-list
Unverified. Review the migrated legacy plan notes below.
`;

const SECTION_HEADING = '## Migrated Legacy Plan Notes';
const SECTION_HEADING_RE = /^## Migrated Legacy Plan Notes[ \t]*$/m;
const SECTION_PREAMBLE = 'The sections below were migrated from legacy `architecture.md` files. Keep future planning, package responsibilities, and public contracts in this `plan.md` file.';

/**
 * WHERE THE SECTION ENDS, written down because it cannot be inferred.
 *
 * Folded content is VERBATIM user markdown, so it carries its own `#` and `##`
 * headings, and the previous version located the end of the section by scanning
 * for the next top-level heading. MEASURED: a second fold spliced its block
 * between the FIRST document's heading/marker and that document's body, because
 * the body opened with `# v1`. The first document's file is already gone, so its
 * block in the plan was the only copy of it — and the block is also its delete
 * key, so a torn one strands any re-attempted unlink.
 *
 * An explicit sentinel is the only anchor folded content cannot move. IT IS NOT
 * UNFORGEABLE, and the previous version of this docblock said it was: it
 * reasoned that the string contains `traffic-one:migrated`, so a document
 * carrying it is refused as a candidate (`RUNTIME_PLAN_MARKERS`) and can never
 * reach the plan. That covers what the fold WRITES — content and, since
 * `FoldInputs`, path and every other field too — and says nothing about the file
 * the sentinel lives in. `plan.md` is the user's, and a second occurrence of this
 * string gets into it by hand, by a merge, or by an OLDER RELEASE's fold of a
 * document whose body quoted it, back before any of these refusals existed.
 * MEASURED with a package directory NAMED `zz<!-- traffic-one:migrated-notes:end
 * -->`, before the path was vetted: the plan's sentinel count went 1 -> 3.
 *
 * What actually holds is narrower and is the whole reason `foldIntoPlan` anchors
 * on `lastIndexOf`: the genuine sentinel is written LAST, after every block, so
 * the final occurrence is ours whatever else the file carries. `indexOf` there
 * survived the whole suite and resurrects the measured tear on a forged one —
 * pinned now by the two-sentinel row in plan-migration-fold-safety.test.ts.
 */
const SECTION_END = '<!-- traffic-one:migrated-notes:end -->';

/**
 * EVERY MARKER GRAMMAR THE RUNTIME PARSES OUT OF `plan.md`, enumerated — because
 * the fold copies a repository file VERBATIM into a file the runtime reads as
 * instructions, and a document that carries any of these steers it.
 *
 * MEASURED, before this list existed: a `packages/vendor/architecture.md`
 * carrying an `opencode-delegate:start`/`:end` block with three
 * `- role: … | files: … | task: …` rows folded into the plan and produced THREE
 * delegation units with attacker-chosen role, file scope and task prompt —
 * `parsePlanDelegationUnits` returned them, `missingOpenCodeDelegateBlock` went
 * false and `hasOpenCodeDelegateMarker` went true. `runners/opencode/from-plan.ts`
 * delegates exactly those rows and the spawn gate reads the same block, so an
 * ordinary repository file (a vendored package, a submodule, an outside pull
 * request) decided what got spawned and what it was allowed to touch.
 *
 * The three families, with the parser that reads each and what acts on it:
 *
 *   `opencode-delegate:start` / `opencode-delegate:end`
 *       shared/opencode-roles/plan-units.ts (parsePlanDelegationUnits, and the
 *       bare-substring hasOpenCodeDelegateMarker in plan-guard) plus
 *       shared/opencode-plan/preserve.ts. Consumed by the from-plan runner, the
 *       spawn gate's roleHasQueuedUnits, and two plan-guard gates.
 *
 *   `traffic-one-verification:`
 *       shared/verification-plan-intent.ts. The two exact `<!-- … :start/:end -->`
 *       markers carry a JSON body that lowers or raises the verification contract
 *       the whole run is judged against (measured: a folded document set
 *       `redesign` and an advisory Lighthouse floor of 1). The NAMESPACE is listed
 *       rather than the two markers because that parser fails CLOSED on the bare
 *       token — a document merely mentioning `traffic-one-verification:` made
 *       `readVerificationPlanIntent` THROW, which is a wedge and not a leak, but
 *       it is the same fold.
 *
 *   `traffic-one:migrated`
 *       this module's own fold key (`contentMarker`). A document carrying another
 *       document's marker put that marker into the plan, which is destruction
 *       route 3 of the delete below.
 *
 * WHAT IS DELIBERATELY NOT LISTED, and why it is not a gap: the delegation ROW
 * grammar (`- role: … | files: … | task: …`). A row is inert unless a start AND
 * an end marker bracket it, both markers are refused above, and the parser reads
 * only from the FIRST start to the FIRST end — so for a folded row to be seen,
 * the plan's own author has to bracket the migrated section with their own
 * markers. That is the plan owner directing the runtime, which is what the plan
 * is for. Listing the row grammar instead would refuse any legacy document with
 * a `- role: …` bullet in it, which is ordinary architecture prose.
 *
 * THAT EXCLUSION RESTS ENTIRELY ON "both markers are refused above", so it is
 * only as wide as the refusal is. It was not wide enough: the markers were
 * refused in the document's CONTENT and the fold also writes the document's
 * PATH, so two package directories NAMED for the two markers supplied the
 * bracketing that the excluded rows needed, and the rows came from prose. The
 * exclusion holds again because `FoldInputs` makes the refusal total over
 * everything the fold writes — not because the rows became safe.
 *
 * THE MECHANISM IS REFUSAL, not rewriting. Neutralising the grammar as it is
 * copied, or fencing it, both change the user's bytes on the way in — and a fold
 * that silently alters content while claiming to preserve it trades this defect
 * for the one the ruling exists to prevent. Fencing does not even work here:
 * every parser above is a bare `indexOf` over the whole file, so a code fence
 * around the block hides it from a markdown reader and from nobody else. So a
 * document carrying runtime marker grammar is not a candidate at all: it is left
 * byte-identical where it is, it is never deleted, and it is REPORTED
 * (`retained`, reason `runtime-directive`, surfaced by `planMigrationNotice`).
 *
 * REFUSAL RATHER THAN A VALIDATED EMBEDDING, and the cost is worth stating: an
 * attacker who controls a name or a file inside the tree can make THEIR OWN
 * package permanently unfoldable. That is the benign direction — the document
 * stays exactly where the user put it, byte for byte, nothing is deleted, and the
 * notice names it and says why. The other instrument, escaping or quoting the
 * value on the way in, would put a rewritten path in a heading that claims to say
 * where the bytes came from, and this phase's whole precedent is that the fold
 * leaves the document byte-identical and reports rather than editing it.
 */
const RUNTIME_PLAN_MARKERS = [
  'opencode-delegate:start',
  'opencode-delegate:end',
  'traffic-one-verification:',
  'traffic-one:migrated',
] as const;

function carriesRuntimeMarker(value: string): boolean {
  return RUNTIME_PLAN_MARKERS.some((marker) => value.includes(marker));
}

/**
 * EVERYTHING THE FOLD PUTS IN `plan.md` THAT DID NOT COME FROM THIS MODULE, in
 * one record — because the refusal above used to be pointed at the DOCUMENT and
 * the fold writes more than the document.
 *
 * `carriesRuntimeMarker` was called on `content` alone. `migratedBlock` also
 * writes `### <relPath>` and `<!-- traffic-one:migrated <relPath> sha256:… -->`,
 * and `relPath` is a directory name under `packages/` — precisely the surface the
 * docblock above names ("a vendored package, a submodule, an outside pull
 * request"). Nothing checked it. MEASURED, byte for byte the exploit the marker
 * list was written to close:
 *
 *   two package directories named `aa<!-- opencode-delegate:start -->` and
 *   `zz<!-- opencode-delegate:end -->`, holding ordinary prose that carries the
 *   deliberately-excluded row grammar, folded clean — `hasOpenCodeDelegateMarker`
 *   true and `parsePlanDelegationUnits` returning attacker-chosen units. POSIX
 *   permits a newline in a name, so ONE directory suffices: the budget is
 *   NAME_MAX, 255 bytes on darwin, about six rows. And
 *   `packages/traffic-one-verification:notes/` needs no content at all — it made
 *   `readVerificationPlanIntent` THROW, the fail-closed wedge.
 *
 * THE REQUIREMENT IS A CLASS, not those two demonstrations: after a fold, no
 * parser reading `plan.md` may see a directive that originated in anything the
 * fold wrote — content, path, or a field added next year. So the vetting is TOTAL
 * OVER THIS RECORD rather than over a list of field names, and `migratedBlock`
 * takes the same record: a foreign value has nowhere else to enter the block, and
 * whichever half of the record it enters through is vetted for what that half can
 * do. Adding `- role:` rows to the refusal list would not have helped — the
 * exploit supplies its own bracketing markers — and refusing rows is the thing
 * `RUNTIME_PLAN_MARKERS` deliberately does not do.
 *
 * THE TWO HALVES ARE NOT SYMMETRIC, which is why they are separate fields:
 *
 *   `body`    the document's bytes, written on their own lines, verbatim. It is
 *             MEANT to be multi-line, and to carry `#` headings and HTML
 *             comments — that is ordinary markdown. Only marker grammar is
 *             refused of it.
 *   `inline`  values interpolated INTO a line this module composes. The block's
 *             grammar is line-oriented and every parser above is a substring
 *             scan, so such a value must not be able to END the line it is in or
 *             open or close a comment — independently of whether it happens to
 *             spell a marker anybody has thought of yet. A newline in a heading
 *             manufactures a whole new line of plan; a `-->` inside the marker
 *             comment closes it early and promotes the rest of the line to
 *             visible, parseable text.
 */
interface FoldInputs {
  readonly inline: { readonly relPath: string };
  readonly body: string;
}

/**
 * Line structure a value interpolated into a fold-authored LINE must not carry.
 *
 * THE CLASS, ENUMERATED, because the property above is stated as one ("must not
 * be able to END the line it is in") and the previous spelling was `/[\n\r]/` —
 * two terminators, not the class. `U+2028`, `U+2029`, `U+0085`, `\v` and `\f` all
 * passed. Two of them are not academic: `U+2028` and `U+2029` are line
 * terminators for JavaScript's own `m` flag, so a package name spelling
 * `v\u2028## Migrated Legacy Plan Notes\u2028INJECTED LINE` took
 * `SECTION_HEADING_RE`'s match count from 1 to 3 while the real `\n`-delimited
 * heading count stayed 1. The damage was bounded — that regex only decides
 * whether the fallback path emits the heading, and no enumerated plan parser
 * splits on anything but `\n` — but a value that can manufacture a line for ONE
 * reader is the capability being refused, not the reach of today's readers.
 *
 * Enumerated rather than `\s`: an interpolated value is allowed spaces and tabs
 * (a directory name may hold them and they change no structure), so the set is
 * exactly "can end a line for some reader we ship or might" plus the two comment
 * delimiters.
 */
const LINE_STRUCTURE_RE = /[\n\r\u2028\u2029\u0085\v\f]|<!--|-->/;

/**
 * HOW OFTEN EACH ARM IS ACTUALLY TAKEN, instrumented across the eight suites that
 * reach this function: the five the `fence-linux` job names (fsjson-symlink-fence,
 * plan-migration-{destruction,fold-safety,gate,window}) plus converge,
 * workspace-member-converge and materialize. NAMED rather than counted, because a
 * total over an unnamed population is not re-derivable: the next reader has to
 * infer the set from the import graph before the figure means anything, and a
 * reader who infers a different set gets a different number and no way to tell
 * which of them is wrong.
 *
 * `permit` 112-113, `runtime-directive` 10, `unembeddable` 3 — 125-126 decisions.
 *
 * A RANGE IN THE HEADLINE, not a figure with a range appended, because every
 * three-run set so far has agreed on the two small arms and disagreed on `permit`.
 * Six runs across two loads: 112/113/112 at load ~20, and 113/113/113 three times
 * on this tree at load ~11 (six test processes, summed per process, `permit`
 * counted separately from the two refusals). Identical runs mean the scheduler
 * landed the same way three times, not that the number is exact — a previous
 * version of this paragraph published its own set's 113 as the headline and called
 * it "identical all three times", which reads as a constant.
 *
 * The moving component is the rival-process row in plan-migration-window.test.ts,
 * whose own docblock accepts either outcome by design: a second writer that wins
 * the race removes a candidate this function would otherwise have been asked
 * about. That attribution was inherited for two rounds and is now OBSERVED: the
 * window suite run alone gives `permit` 7/6/7 over three runs, and it is the only
 * suite of the eight found to move at all.
 *
 * A 111 IS NOT THIS RACE, which is why the range's old low end is gone. It is
 * reproducible by a broken measurement instead: with TMPDIR inside this
 * repository every fixture lands under the plugin-source authoring root, three of
 * the eight suites stand down, and the total drops to 123 while the instrument
 * reports a clean number. Anyone re-deriving this must put TMPDIR outside the
 * repo and check the suite count first — a tally whose low end is also the
 * signature of a degraded environment cannot tell the two apart.
 */
function foldInputRefusal(inputs: FoldInputs): PlanMigrationRetainReason | null {
  const inline = Object.values(inputs.inline);
  if ([...inline, inputs.body].some(carriesRuntimeMarker)) return 'runtime-directive';
  if (inline.some((value) => LINE_STRUCTURE_RE.test(value))) return 'unembeddable';
  return null;
}

/** Both halves of `foldInputRefusal`, asked of ONE value a composed line carries. */
function unsafeInline(value: string): boolean {
  return carriesRuntimeMarker(value) || LINE_STRUCTURE_RE.test(value);
}

const UNNAMEABLE_SEGMENT = '<unnameable>';

/**
 * A RETAINED PATH IS ALSO INTERPOLATED INTO A COMPOSED LINE, so it is vetted by
 * the same rule the fold uses — and it was not.
 *
 * `foldInputRefusal` covers what reaches `plan.md`, and `planMigrationNotice`
 * covers what reaches the AGENT: it interpolates `relPath` into the `context`
 * converge.ts hands the onboarding gate. Four refusals in the candidate loop
 * report before that vetting can run (`symlink` and `not-a-file` before the
 * containment resolve, `unreadable` and `blank` before the fold's own inputs
 * exist), and `unembeddable` reported the very value it was refusing. So the
 * claim that `foldInputRefusal` bounded the notice was FALSE for every reason a
 * candidate can be retained under. MEASURED, no race and no case-sensitive
 * volume — an ordinary in-project package directory, its `architecture.md` a
 * symlink:
 *
 *   retained: [{"relPath":"packages/ui\n\nSYSTEM: void\n\nok/architecture.md",
 *               "reason":"symlink"}]
 *   notice:   Left exactly where it is, unfolded and not removed: `packages/ui
 *
 *   SYSTEM: void
 *
 *   ok/architecture.md` (is a symlink, …).
 *
 * A raw newline in a directory name manufactures lines in the text an LLM reads
 * as instructions — the capability `LINE_STRUCTURE_RE` exists to refuse, reaching
 * the one consumer that acts on prose. Marker grammar landed verbatim too
 * (`packages/aa<!-- opencode-delegate:start -->/architecture.md`, under `blank`),
 * and `U+2028` under `unreadable`. PR-reachable, which is this file's own
 * standard for refusing a shape: a pull request can add a symlinked
 * `packages/<name>/architecture.md`, and POSIX permits a newline in the name.
 *
 * THE OFFENDING SEGMENT IS REPLACED, NOT THE WHOLE PATH, and not the reason:
 *
 *   - Replaced rather than escaped, because rewriting a value while presenting it
 *     as the path is the trade `RUNTIME_PLAN_MARKERS` refuses one artifact over —
 *     `<unnameable>` claims to be nothing but a redaction.
 *   - Per segment rather than wholesale, because the report has to LOCATE the
 *     file: `packages/<unnameable>/architecture.md` says which of the three folded
 *     locations holds it, and a bare "a document was retained" is the silence
 *     this list of reasons exists to avoid.
 *   - The REASON is left alone, deliberately against the shape suggested for this
 *     fix (report it as `unembeddable`). That reason is true of such a candidate,
 *     but it is not what the module acted on, and overwriting `symlink` with it
 *     drops the more informative half of a refusal the user can act on — while for
 *     a path carrying marker grammar it would replace `runtime-directive`, the
 *     reason KNOWN-ISSUES item 10 names for exactly that shape.
 *
 * TOTAL OVER THE ASSEMBLED VALUE and not only over the segments: a grammar
 * straddling a separator would pass a per-segment check. It cannot be built from
 * two names today (no name can hold `/`, so the separator interrupts every
 * marker), which is the reason to write the second check rather than the reason
 * to leave it out.
 */
function reportablePath(relPath: string): string {
  const rendered = relPath.split('/').map((segment) => (unsafeInline(segment) ? UNNAMEABLE_SEGMENT : segment)).join('/');
  return unsafeInline(rendered) ? UNNAMEABLE_SEGMENT : rendered;
}

/**
 * CONTAINMENT IS A PERMISSION HERE, WHICH IS WHY IT DOES NOT FOLD CASE — and the
 * previous version of this module got that exactly backwards by reusing
 * `pathWithin` from the consent fence.
 *
 * `pathEquals` in state/plugin-use.ts is `a.toLowerCase() === b.toLowerCase()`,
 * unconditionally, on every platform, and its own docblock justifies that
 * (`plugin-use.ts:195-202`): folding widens what counts as STATE, so it widens a
 * REFUSAL, and "on a genuinely case-sensitive filesystem the only cost is
 * refusing a directory Traffic One never creates, which is the fail-closed
 * side". THIS call site runs the same predicate in the OPPOSITE POLARITY:
 * folding widens what counts as CONTAINED, and contained means the fold may
 * read, fold and DELETE. The safety argument was made for the other direction
 * and does not transfer.
 *
 * MEASURED, on a project `<vol>/Repo` with a distinct sibling `<vol>/repo` and
 * `Repo/packages -> ../repo/packages` — the peer drove it on a case-sensitive
 * APFS volume, and it reproduces here against an emulated one (this machine's
 * default APFS collapses all five fold-collision pairs, so no distinct-on-disk
 * pair exists to build the fixture from):
 *
 *   migrated: ["architecture.md", "packages/sibling-repo/architecture.md"]
 *   victim still there:          false
 *   plan carries sibling secret: true
 *
 * Byte for byte the escape the containment test was added to close, resurrected
 * through the predicate, and reported under the same innocent relative path that
 * was the tell of the original defect. ext4 and xfs are case-sensitive by
 * default and PLATFORMS.md:116 calls Linux the most thoroughly exercised
 * platform, so this is reachable where the product tests hardest.
 *
 * EXACT COMPARISON, AND NOT BECAUSE REALPATH CANONICALISES CASE — that was the
 * hypothesis and it is FALSE for the resolver this module actually uses.
 * MEASURED on darwin 25.5 / node 26.5, resolving a case-variant spelling of a
 * real directory on the default case-insensitive volume:
 *
 *   fs.realpathSync         -> .../Repo   for `Repo`,  .../repo   for `repo`
 *   fs.realpathSync.native  -> .../Repo   for BOTH
 *
 * `realPathWithMissingTail` calls the first one, Node's JS resolver, which walks
 * the components and re-emits the CALLER'S spelling for everything that is not a
 * symlink. So an exact compare is not made safe by canonicalisation. What makes
 * it safe is that both sides descend from the same `cwd` string: `projectRoot` is
 * `realpath(cwd)` and every target is `path.join(cwd, …)`, so the shared prefix
 * is character-identical unless a symlink's STORED TARGET TEXT re-spells it.
 *
 * THAT SENTENCE IS THE WHOLE RULE, and the per-shape list that used to follow it
 * contradicted it: the list exonerated relative targets as a class ("a non-link,
 * a relative target and an absolute target spelled like the root all keep the
 * prefix exactly; only an ABSOLUTE target diverges"), and a purely relative
 * `../repo/real` re-spells the root with no absolute spelling anywhere and
 * diverges. So do a chain ending at a re-cased absolute link, and a missing tail
 * under one. Measured across nine shapes on both volume kinds, the divergence is
 * exactly "the stored target text re-spells a shared prefix segment", plus
 * anything downstream of such a link — the general rule, not a list of routes to
 * it. On a case-sensitive volume such a link names a different directory and
 * refusing it is the whole point; on a case-insensitive one it names the same
 * directory and the cost is a refusal — the fold does not happen, the document
 * stays byte-identical where it is, which is the fail-closed side of a
 * permission, and every one of the four divergent shapes refuses on BOTH volume
 * kinds. `.native` is not substituted here
 * because `realPathWithMissingTail` is shared (fs-nofollow.ts) and six other
 * lanes read it; the polarity problem is this call site's, so the fix is too.
 *
 * RESOLVE, THEN OPERATE ON WHAT WAS RESOLVED — returning the resolved path
 * rather than a boolean, because the boolean version was a TOCTOU on the gate
 * this docblock used to call total. `withinProject(projectRoot, packagesRoot)`
 * and the `readdirSync` that trusted its answer were separated by
 * `fs.existsSync(packagesRoot)`. MEASURED on the DEFAULT macOS filesystem, no
 * case-sensitive volume required, swapping `packages` for a symlink at that
 * instant: the same destruction as above, window two syscalls wide.
 *
 * So the gate is no longer the only check. It stays — it is what keeps the
 * `readdir` itself off a directory outside the project — but EVERY CANDIDATE is
 * resolved and contained again immediately before it is read, and the resolved
 * path is re-established immediately before the unlink (`stillTheFileWeRead`).
 * A swap landing in the gate's window is therefore caught by the per-candidate
 * resolve, which by then sees the symlink; nothing outside is read, folded or
 * removed.
 *
 * IT IS STILL NAMED, THOUGH, and this docblock claimed the opposite ("nothing
 * outside is NAMED either, since reporting it would put an outside path under an
 * innocent relative spelling in this project's own notice"). MEASURED with the
 * swap scheduled at the gate's `existsSync`, per shape of the outside candidate:
 * a symlink is named (`symlink`), a FIFO is named (`not-a-file`), a directory is
 * named (`not-a-file`), and only a REGULAR FILE is silent — it is the one shape
 * that reaches the per-candidate resolve, which refuses it without reporting.
 * Three of four shapes therefore do put an outside path under an innocent
 * relative spelling, which is the concealment pattern the original defect was
 * recognised by.
 *
 * NOT CLOSED BY REORDERING, which is the obvious fix and the wrong one: moving
 * the containment resolve ahead of those two refusals would silence them for a
 * document whose link points OUT of the project, and that is the case where the
 * user most needs to be told why their document was not migrated. The refusal
 * list below exists because "a document the user expects to be migrated and which
 * is not is exactly where silence reads as data loss". So this stays a priced
 * residual of the gate window rather than a closed leak: reaching it needs the
 * swap, and what it discloses is a name, not bytes.
 *
 * WHAT IS STILL OPEN, disclosed rather than argued away: Node has no `openat`,
 * so every check is `realpath(p)` then `open(p)` and a component swapped between
 * those two syscalls is followed. This is the same residual the read → unlink
 * guard discloses, now bounded the same way — two adjacent syscalls per path
 * instead of the whole fan-out. MEASURED: the per-candidate window is ~6-107 µs
 * (min/p95, 40 and 400 candidates) against 0.34-7.4 s for the directory-level
 * gate it replaced — four to five orders of magnitude, and no longer scaling with
 * the fan-out. A real second process flipping `packages` between an inside and an
 * outside target won 0 of 309 folds at 41 flips/s, which is consistent with a
 * window that narrow and is NOT a proof of unwinnability: the expected number of
 * hits over that many attempts was ~0.25. One narrower leak survives it: a swap
 * inside the gate's window still lets ONE `readdirSync` list an outside
 * directory, and three of the four candidate shapes built from those names are
 * reported — see the paragraph above, which is where that leak is priced.
 *
 * A HARDLINK is outside what any realpath test can see, and the previous version
 * of this docblock called it "also not an escape" without qualification. That is
 * true of the DELETE and false of the READ; see `legacyArchitectureDocs`.
 *
 * The project root is compared as ITS OWN realpath: a checkout under
 * `/var -> /private/var` is ordinary on macOS, and comparing a resolved candidate
 * against an unresolved root would refuse every document in it.
 *
 * A COPY OF shared/fsjson.ts's `withinExactly`, which is the same predicate at the
 * write fence's own containment check — and the reason it is still a copy is
 * recorded THERE, because it is a fact about that module's exports rather than
 * about this one: `tests/refusal-contract.test.ts` censuses every function fsjson.ts
 * exports and reds on one it cannot classify, so sharing needs one entry in a file
 * neither of these modules owns. Not a cycle, which is what this docblock used to
 * claim — this module already imports fsjson.ts four times over.
 *
 * The cost of the copy is not hypothetical and has already been paid once: a
 * project rooted at the volume root splits to a trailing empty segment that no real
 * child segment equals, and NEITHER copy handled it, so both refused every
 * candidate in such a project until the fix was applied twice. Each side now has a
 * row that reds when only that side is reverted — the predicate row in
 * plan-migration-fold-safety.test.ts for this copy, the volume-root row in
 * fsjson-symlink-fence.test.ts for that one.
 *
 * EXPORTED for the predicate row in plan-migration-fold-safety.test.ts.
 */
export function containedIn(realRoot: string, realTarget: string): boolean {
  const rootSegments = realRoot.split(path.sep);
  // A root that IS the volume root splits with a trailing EMPTY segment (`'/'` →
  // `['', '']`) that no real child segment can equal. See fsjson.ts's copy for the
  // measurement; the two must stay in step, and each is pinned separately.
  if (rootSegments.length > 1 && rootSegments[rootSegments.length - 1] === '') rootSegments.pop();
  const targetSegments = realTarget.split(path.sep);
  if (targetSegments.length < rootSegments.length) return false;
  // Segment by segment and never a string prefix: `<root>/../rootless` shares
  // `<root>`'s characters. Exact, for the polarity reason above.
  return rootSegments.every((segment, i) => targetSegments[i] === segment);
}

/**
 * Where `target` really lands, or `null` when that is not inside the project.
 *
 * THE PREDICATE THIS CALLS IS THE WHOLE BLOCKER, and it is pinned three ways
 * (plan-migration-fold-safety.test.ts) because no one of them covers every
 * filesystem or every mutation:
 *
 *   the predicate itself, directly — dies on a folding revert, and cannot see
 *     which predicate THIS body calls;
 *   this body's TEXT — `containedIn(` present, folding spellings and call-site
 *     `require`/`import` absent. A denylist of spellings, so it cannot see a
 *     DISJUNCTION that keeps the required call and adds a folding one beside it;
 *   BEHAVIOUR, twice — a re-cased link target wherever the filesystem folds case,
 *     and the sibling-checkout escape itself wherever it does not. The second is
 *     what catches the disjunction, and the `fence-linux` CI job is what runs it.
 *
 * "NOT REACHABLE BEHAVIOURALLY HERE" WAS ONE STEP SHORT TWICE, and both
 * corrections are why the list above is three rows rather than one. The escape
 * cannot be BUILT on a case-folding volume, but the difference between the two
 * predicates is observable from the refusal side there (a link target that
 * re-spells the project segment: one directory, one inode, no special volume);
 * and the escape itself is ordinary to build on a case-SENSITIVE one, which is
 * where the defect lives and where this suite now runs in CI. The four CALL SITES
 * of this function are each pinned behaviourally (removing the state-dir gate
 * kills 2, the per-candidate resolve 1, the pre-unlink re-establish 1).
 */
function resolveWithinProject(projectRoot: string, target: string): string | null {
  const real = realPathWithMissingTail(target);
  return real !== null && containedIn(projectRoot, real) ? real : null;
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * A no-follow read that reports "I could not read it" as `null` — never as an
 * empty string, which is the collapse that once folded a placeholder claiming a
 * `chmod 000` document was empty and then deleted bytes nobody had read.
 *
 * `readFileNoFollow` rather than fsjson's `readText`, which FOLLOWS a symlink at
 * the path: see fs-nofollow.ts for the measured exfiltration row this closes.
 * The property is the one that matters and the one that survives — `readText` is
 * no longer the bare `readFileSync` this sentence used to name, since it now goes
 * through shared/bounded-read.ts, which deliberately omits `O_NOFOLLOW` because
 * its job there is boundedness rather than identity. Following is still what it
 * does.
 *
 * NO BEHAVIOURAL ROW IN THE SUITE DISTINGUISHES THE TWO, and that is worth a
 * sentence rather than leaving the next reader to conclude the no-follow open is
 * decoration. The `lstat` arm refuses a symlinked candidate before anything reads
 * it, so the symlink row passes with a FOLLOWING read too; what `O_NOFOLLOW` buys
 * is the two syscalls between that `lstat` and this open, which no fixture can
 * schedule. The suite therefore pins the PRIMITIVE by calling it directly
 * (plan-migration-fold-safety.test.ts, MAJOR B's second row) — a row that cannot
 * die from a change to this line, since it does not go through here. MEASURED:
 * swapping this call for `readFileSync` kills exactly one test, and it is the
 * concurrent-plan-rewrite row in plan-migration-window.test.ts, which dies
 * incidentally — it intercepts `fs.openSync` to schedule its rival and asserts the
 * interception fired.
 */
function readTextNoFollow(filePath: string): string | null {
  try {
    return readFileNoFollow(filePath);
  } catch {
    return null;
  }
}

/**
 * THE FOLD KEY, and it is deliberately not the heading.
 *
 * `### <relPath>` is permanent once a project migrates, and the migration runs on
 * essentially every hook, so a heading key answers "has this path ever been
 * folded?" while what the fold needs is "are THESE bytes in the plan?". Those two
 * questions diverge the moment the file comes back — by hand, by a revert, by a
 * merge from a branch that still has it — and the heading key answered "yes,
 * already migrated" about a document whose new content nothing had read. MEASURED
 * on a project that migrated once and then had `architecture.md` re-created:
 * heading key => the new bytes existed NOWHERE on disk, and the return value
 * reported the path as migrated. A plan that merely MENTIONS the heading in prose
 * did the same to a document that was never migrated at all.
 *
 * Truncated to 16 hex chars: this is a "did I already write this text" key, not a
 * security boundary, and the whole marker has to stay readable in a file a human
 * edits. An HTML comment because that file is markdown the user owns.
 *
 * IT IS THE FOLD KEY AND NOT THE DELETE KEY, and that split is the whole of this
 * round's blocker. The marker lives in `plan.md`, a file the user owns and edits,
 * and it survives edits that destroy the content it stands for: deleting the
 * migrated prose while leaving the comment (invisible in every rendered markdown
 * view) is one keystroke, and a formatter re-wrapping the folded paragraph is
 * none. The delete is therefore keyed on the BLOCK — marker AND bytes — see
 * `migratedBlock` and the loop at the bottom of this file.
 */
function contentMarker(relPath: string, content: string): string {
  const digest = crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
  return `<!-- traffic-one:migrated ${relPath} sha256:${digest} -->`;
}

/**
 * THE DELETE KEY: the exact text the fold puts into the plan for this document.
 * Computed ONCE and used for three things — the fold's "is this already there",
 * the text that gets written, and the licence to unlink — so the three cannot
 * disagree about what "the plan carries these bytes" means.
 *
 * VERBATIM CONTENT, untrimmed. The previous version stored `content.trim()` while
 * keying on the untrimmed bytes, so the relocation was not byte-for-byte and the
 * two halves disagreed about a document whose leading or trailing whitespace was
 * part of it. A whitespace-only document is not folded at all now (reason
 * `blank`): it used to be replaced by a `_Empty legacy file._` placeholder and
 * then unlinked, which is the ruling's own prohibition at small scale — bytes
 * removed that were never stored.
 *
 * The body is given a trailing newline when it lacks one, which is the only byte
 * this function adds: without it the next `###` heading would be glued onto the
 * last line of the previous document. `includes(block)` still holds for the
 * verbatim content either way, because the added newline is at the END.
 *
 * IT TAKES `FoldInputs` AND NOT LOOSE STRINGS, which is the whole of this round's
 * class fix: every value here that did not come from this module arrives in that
 * record, and `foldInputRefusal` is total over it. A field added to the block
 * later has to be added to the record to be reachable from here, and is vetted
 * the moment it is. `marker` is not in the record because it is not foreign — it
 * is this module's own text, computed by `contentMarker` from values that are.
 */
function migratedBlock(inputs: FoldInputs, marker: string): string {
  const body = inputs.body.endsWith('\n') ? inputs.body : `${inputs.body}\n`;
  return `### ${inputs.inline.relPath}\n${marker}\n\n${body}`;
}

/**
 * OWNERSHIP, per candidate directory — the check the `packages/*` fan-out did not
 * have.
 *
 * The fan-out enumerates sub-directories of the project's own `packages/`, and
 * without this it read the CONTAINER's state and then deleted inside whatever it
 * found there. MEASURED converging a container that registers `packages/web`,
 * where the member is itself an onboarded project with its own `.one.json`: the
 * member's hand-written `architecture.md` was deleted and its bytes moved across
 * a project boundary into the CONTAINER's plan, where the member's own plan gate
 * will never look. The round-3 refusal in converge.ts only covers convergence
 * called ON the member; nothing covered the container walking in.
 *
 * Both arms name a directory whose documents belong to someone else: a state file
 * of its own makes it a project (existence is enough here — this is a refusal, so
 * the widest reading is the safe one, unlike the gate below which licenses a
 * delete), and a registry entry makes it a member the container itself declared
 * separate. A stateless, unregistered sub-package is NOT refused, because for
 * that directory the container genuinely is the project: `resolveProjectRoot`
 * anchors its files at the container and `isStatelessWorkspaceSubPackage` refuses
 * to converge it on its own, so the container's plan is the only plan its content
 * can live in.
 *
 * Not reported in `retained`: a document inside someone else's project was never
 * this project's candidate, and naming it in the CONTAINER's notice would put a
 * member's paths in a message about the container.
 */
function ownsSeparateProject(dir: string): boolean {
  return hasStateFile(dir) || isRegisteredWorkspaceMember(dir);
}

/**
 * The candidate documents, and the fan-out's exact reach: `<cwd>/architecture.md`,
 * `<cwd>/.traffic-one/architecture.md`, and `<cwd>/packages/<p>/architecture.md`
 * for packages this project owns. `packages/` is the ONLY folder name enumerated —
 * `apps/`, `services/` and a `pnpm-workspace.yaml`'s own globs are not consulted,
 * so a legacy document in those keeps sitting where it is and the project's plan
 * gate asks for a plan that does not carry it. That is a deliberate under-reach,
 * not an oversight: everything this function returns is a deletion candidate, and
 * widening the reach with the workspace-declaration reader would license deletes
 * in directories no measurement here covers. Measured, it is also not a wedge:
 * with only `apps/web/architecture.md` present there is no candidate, nothing is
 * minted, and the plan gate asks only that `.traffic-one/plan.md` EXIST — which
 * `architectMayWrite` permits the architect to create.
 *
 * FIVE REFUSALS, and each one leaves the document byte-identical where it is
 * rather than folding it. Every one of them is reported rather than silently
 * skipped, because a document the user expects to be migrated and which is not is
 * exactly the case where silence reads as data loss:
 *
 *   `symlink`           a link is not evidence of what it names. MEASURED with
 *                       `architecture.md` -> `../outside-secret.md`: the outside
 *                       file's bytes landed in `plan.md` and the link was
 *                       unlinked (peer row R11). The state-ownership gate below
 *                       already refuses a symlinked `.one.json` on exactly this
 *                       ground; the read side had no equivalent until
 *                       `readFileNoFollow`. `lstat` FIRST and the no-follow open
 *                       as well: O_NOFOLLOW degrades to 0 on Windows, where this
 *                       check is the whole protection.
 *   `not-a-file`        a directory (or fifo, or socket) at a candidate path.
 *                       NOT a second spelling of the read's own refusal, which
 *                       is how it came to be unpinned: removing it survived all
 *                       81 tests, and it is not equivalent. A directory answers
 *                       EISDIR and a symlink ELOOP, but a CHARACTER DEVICE reads
 *                       as `''` (refused later, by the content comparison) and a
 *                       FIFO BLOCKS THE OPEN FOREVER — a permanently hung hook
 *                       from a file nobody has to be able to write. Pinned by two
 *                       rows in plan-migration-fold-safety.test.ts, the FIFO one
 *                       from a child process with a timeout.
 *   `unreadable`        `readText(...) ?? ''` folded a placeholder saying the
 *                       legacy file was empty and then deleted bytes nobody had
 *                       ever read (measured with a `chmod 000` document). There
 *                       is nothing to carry, so there is nothing to delete — the
 *                       same direction fsjson's `JsonRead` takes for
 *                       `unreadable`, where "something IS there and we cannot see
 *                       it" is the one case where overwriting is least
 *                       defensible.
 *   `blank`             a whitespace-only document. Nothing to carry, and the
 *                       placeholder that used to stand in for it licensed a
 *                       delete of bytes the plan never stored.
 *   `runtime-directive` something the fold would WRITE carries marker grammar
 *                       this runtime parses out of `plan.md` — the document's
 *                       bytes or its path. See `RUNTIME_PLAN_MARKERS` and
 *                       `FoldInputs`.
 *   `unembeddable`      the path cannot go into a line this module composes
 *                       without changing the plan's line structure. See
 *                       `FoldInputs`.
 *
 * The `packages/` fan-out is skipped WHOLESALE when that directory does not
 * realpath inside the project (`withinProject`), rather than per candidate: the
 * `readdir` is itself a read of a directory outside the project, and the paths it
 * would return are outside paths that would then be named — as innocent-looking
 * relative ones — in this project's own notice.
 *
 * BOTH THAT SKIP AND THE PER-CANDIDATE `continue` ARE SILENT, AND THE COST OF
 * THAT FALLS ON A LEGITIMATE PROJECT — disclosed here because the exact predicate
 * containment now uses widens it and nothing else says so. MEASURED on the
 * DEFAULT case-insensitive volume, with a `packages` symlink whose ABSOLUTE
 * target re-spells the project segment (`<base>/PROJ/pkgs-real` for a project at
 * `<base>/Proj`) — verified the same directory by inode, so this is one real
 * package tree and not an escape:
 *
 *   result: null      notice: ""      the document: still there, forever
 *
 * Fail-closed and correct — the alternative is a folding compare, which is the
 * blocker — but the user gets no signal at all while the plan gate keeps asking
 * for a plan that will never carry that document. It cannot be reported from
 * here for the reason the wholesale skip exists: the only name available is the
 * one that must not be spoken. It is a documented cost instead (KNOWN-ISSUES item
 * 10), and it is the same class of silence as the fold's missing audit trail —
 * see `planMigrationNotice`.
 *
 * A HARDLINK IS NOT REFUSED, AND THAT IS A DECISION RATHER THAN A LIMITATION —
 * the containment docblock used to dispose of it in half a sentence ("also not an
 * escape"), which is true of the DELETE and false of the READ. Both halves,
 * measured with `architecture.md` hardlinked to `../outside-secret.md`:
 *
 *   the delete    CONFIRMED not an escape. The unlink removes THIS project's
 *                 name for the inode; the outside name survives, and the outside
 *                 file is still there afterwards.
 *   the read      an escape, and the docblock covered it without measuring it.
 *                 The outside bytes land in `plan.md`, which is committed and
 *                 read into an agent's context — the same exfiltration as the
 *                 symlink row, by a route no realpath test can see, since a
 *                 hardlink IS the file and every syscall says so.
 *
 * REFUSING IT WOULD BUY NOTHING, which is why the read is accepted rather than
 * closed. `st_nlink > 1` is observable and the refusal would be one line, but the
 * capability it removes is not a capability anybody gains by it: git cannot carry
 * a hardlink, so unlike a symlink it cannot arrive in a pull request. It takes a
 * local process — a build script, a postinstall — and a local process can write
 * the outside bytes straight into `architecture.md` with one `copyFileSync`. The
 * link is a spelling of an ability the actor already has, not an escalation, and
 * the refusal's cost falls on legitimate documents (a hardlinked doc in a
 * deduplicated checkout would silently stop migrating). The symlink is refused
 * precisely because it IS PR-reachable; that is the whole difference between the
 * two, and it is the reachability and not the mechanism.
 *
 * The explicit `isDirectory()` guard the previous version had before its read is
 * gone: `readTextNoFollow` returns null for a directory anyway, so it was a
 * second spelling of a decision the read already made. It is replaced by the
 * `lstat` above, which is here for the symlink refusal and answers existence and
 * file-ness on the way past — and, separately, by the `not-a-file` refusal, which
 * is NOT a second spelling of the read; see the reason list above.
 */
function legacyArchitectureDocs(cwd: string, projectRoot: string): { docs: LegacyDoc[]; retained: RetainedLegacyDoc[] } {
  const candidates = [
    path.join(cwd, '.traffic-one', 'architecture.md'),
    path.join(cwd, 'architecture.md'),
  ];
  const packagesRoot = path.join(cwd, 'packages');
  if (resolveWithinProject(projectRoot, packagesRoot) !== null && fs.existsSync(packagesRoot)) {
    for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkg = path.join(packagesRoot, entry.name);
      if (ownsSeparateProject(pkg)) continue;
      candidates.push(path.join(pkg, 'architecture.md'));
    }
  }

  const docs: LegacyDoc[] = [];
  const retained: RetainedLegacyDoc[] = [];
  for (const absPath of candidates) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      continue; // nothing there: not a candidate, and nothing to tell anyone about
    }
    const relPath = toPosix(path.relative(cwd, absPath));
    // REPORTED THROUGH `reportablePath`, every reason, including the two below
    // that refuse before the fold's own vetting can run. `relPath` itself stays
    // raw for the fold, which needs the real path or nothing.
    const keep = (reason: PlanMigrationRetainReason): void => { retained.push({ relPath: reportablePath(relPath), reason }); };
    if (stat.isSymbolicLink()) { keep('symlink'); continue; }
    if (!stat.isFile()) { keep('not-a-file'); continue; }
    // AFTER the two refusals above, so a symlinked or non-file candidate is still
    // REPORTED as such rather than disappearing into the silent skip below, and
    // BEFORE the read, which is the thing containment is protecting. Silent
    // deliberately: naming an escaped path here would put an outside path under
    // an innocent relative spelling in this project's own notice, which is the
    // concealment the original defect was recognised by.
    const realPath = resolveWithinProject(projectRoot, absPath);
    if (realPath === null) continue;
    const content = readTextNoFollow(absPath);
    if (content === null) { keep('unreadable'); continue; }
    if (content.trim() === '') { keep('blank'); continue; }
    const inputs: FoldInputs = { inline: { relPath }, body: content };
    const refusal = foldInputRefusal(inputs);
    if (refusal !== null) { keep(refusal); continue; }
    const marker = contentMarker(relPath, content);
    docs.push({ absPath, realPath, relPath, content, marker, block: migratedBlock(inputs, marker) });
  }
  docs.sort((a, b) => a.relPath.localeCompare(b.relPath));
  retained.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { docs, retained };
}

/**
 * ONE `## Migrated Legacy Plan Notes` SECTION, not one per fold.
 *
 * MEASURED before this: 25 re-creations of a 2 KB document produced a 55,708-byte
 * plan with 25 separate H2 sections, 25 copies of the preamble and 25 `###`
 * blocks. `plan.md` is both the architect's deliverable and a machine-parsed
 * file, so a plan with 25 identically-named H2 sections is a mangled deliverable
 * on top of the growth.
 *
 * WHAT A RE-FOLD OF THE SAME PATH DOES TO THE BLOCK ALREADY THERE: nothing. The
 * new version is appended as a further `### <relPath>` block INSIDE the one
 * section and the existing block is never rewritten, reordered or removed. The
 * earlier block is the only copy of a version of that document — its file is
 * gone — so replacing it would delete durable memory, which is the ruling this
 * whole path exists to enforce. Every version the migration ever saw stays.
 *
 * THE BOUND that follows: bytes added = the sum of the DISTINCT contents that path
 * has ever had, plus about 80 bytes of heading and marker each. It is not one per
 * hook and not one per re-creation — a document re-created with bytes the plan
 * already carries is keyed out by `contentMarker` and appends nothing at all. It
 * IS unbounded in the same sense a file a user keeps editing is unbounded, and
 * that is the floor: the alternative is deleting a version, which is forbidden.
 *
 * THE SIZE THAT BOUND ACTUALLY PRODUCES, measured rather than left to the
 * reader: 200 successive one-line edits of a 5,044-byte document — an ordinary
 * editing session, since the fold deletes the file and the editor's next save
 * re-creates it — produced a 1,028,179-byte plan with 200 blocks and one section.
 * That is the document's own size plus about 97 bytes of heading and marker, per
 * distinct version, and it is LINEAR in saves rather than in anything the user
 * would think of as a migration. Re-folding identical bytes appended nothing over
 * five further passes, byte for byte, which is the other half of the law.
 * DELIBERATELY NOT CAPPED. A cap is a rule for deleting a version, and every
 * version in there is the only copy of a document whose file the fold removed;
 * "the oldest ones are probably fine to lose" is exactly the reasoning this whole
 * path exists to refuse.
 *
 * THE COST OF NOT CAPPING IS WORSE THAN THIS DOCBLOCK USED TO SAY, and the
 * correction matters more than the number. It said "nothing that reads `plan.md`
 * has a size limit, so the cost is a large deliverable and a slow render, both
 * visible to the user, rather than a failure". That is an argument about CODE,
 * and the consumer this file is written for is an LLM whose budget this plugin
 * has already written down: `senior-architect/agent.md` ships the instruction
 * "Keep `.traffic-one/plan.md` under roughly 250 lines", and
 * `rules/common/project-memory.md` tells every agent in every materialized
 * project to read `plan.md`. 40 saves is already past 250 lines with a
 * single-line document, and a realistic multi-line one passes it in two or three.
 * A 1.0 MB plan is roughly 250k tokens and does not fit a 200k-token context at
 * all. So the plan stops being READABLE BY THE AGENTS THAT DEPEND ON IT long
 * before it reaches the measured size, and that is a failure of the deliverable
 * rather than a slow render.
 *
 * It still does not make a cap right — deleting a version is forbidden whatever
 * it costs to keep — so this stays a disclosure. The user has the release valve
 * the fold does not: the plan is theirs, and deleting a block they no longer want
 * is an edit they can see and undo.
 *
 * THE INSERTION POINT is the `SECTION_END` sentinel, so a new block always lands
 * inside the section and always after every block already there. `lastIndexOf`,
 * never `indexOf`, and that is load-bearing rather than incidental: the plan is
 * the user's file and can carry an earlier occurrence of the sentinel string — by
 * hand, by a merge, or from an older release's fold of a document whose body
 * quoted it. The genuine sentinel is written LAST, after every block, so the FINAL
 * occurrence is the only one this module can vouch for; anchoring on the first
 * splices the new block through whatever the earlier occurrence sits in, which is
 * the measured tear `SECTION_END` exists to prevent. Two fallbacks, both of which
 * append at the very end of the plan and neither of which can tear an existing
 * block: a plan carrying the section from an EARLIER release has no sentinel (one
 * is added, and later folds anchor on it), and a plan whose sentinel the user
 * deleted is treated the same way. The cost of the fallback is that a section the
 * user wrote below the notes ends up above the newest block once — untidy, and
 * the alternative was guessing where the section ends, which is the measured tear
 * above.
 *
 * ONLY ADDS BYTES. The separator is computed from what is already there, so no
 * `trimEnd` ever runs over the user's plan or over a previously folded document's
 * own trailing newlines. That is not tidiness: those newlines are part of the
 * `block` that licenses the earlier document's delete, and trimming them would
 * strand a document whose unlink had to be re-attempted.
 */
function foldIntoPlan(basePlan: string, blocks: readonly string[]): string {
  const added = blocks.join('\n');
  const anchor = basePlan.lastIndexOf(SECTION_END);
  const next = anchor >= 0
    ? (() => {
      const head = basePlan.slice(0, anchor);
      const gap = head.endsWith('\n\n') ? '' : head.endsWith('\n') ? '\n' : '\n\n';
      return `${head}${gap}${added}\n${basePlan.slice(anchor)}`;
    })()
    : `${basePlan}\n\n${SECTION_HEADING_RE.test(basePlan) ? '' : `${SECTION_HEADING}\n\n${SECTION_PREAMBLE}\n\n`}${added}\n${SECTION_END}`;
  return next.endsWith('\n') ? next : `${next}\n`;
}

/**
 * OWNERSHIP OF `cwd`, and it is keyed on state this function can actually READ.
 *
 * Existence was the previous key, and existence is not evidence of anything: a
 * regular file holding `x`, an EMPTY file, a DIRECTORY named `.one.json`, a
 * symlink to an unrelated file and a symlink to `/dev/null` all granted ownership
 * and licensed the delete (measured — all five deleted the document). A symlink at
 * that path is refused by fsjson's own state writer, so it cannot be the thing
 * that licenses a delete here; it is refused first, before any read, because
 * `readJsonResult` would happily parse whatever the link points at.
 *
 * The cost is a TORN `.one.json`, which used to count as an invitation and now
 * does not. That is a DEFERRAL and not a strand: the document stays exactly where
 * it is, nothing is written, and the migration re-opens the moment the state file
 * is legible again (state repair is a different module's job and runs on the same
 * hooks). The inverse trade — accepting an unparseable file as a licence to delete
 * a user's document — is the one that cannot be undone.
 *
 * NOT the same question as "is this an onboarded project". A project mid-onboarding
 * with `{ mode }` and no stack still migrates, and it has to: the migration exists
 * for a project that WAS onboarded by a release that wrote `architecture.md`, and
 * the plan gate below denies its feature writes until the plan exists.
 */
function ownsReadableState(cwd: string): boolean {
  const file = statePath(cwd);
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const read = readJsonResult<unknown>(file);
  return read.kind === 'ok' && typeof read.value === 'object' && read.value !== null && !Array.isArray(read.value);
}

/**
 * A mutation that FAILS is a fact, not an exception to throw at a hook.
 *
 * The guarded primitives report a fence refusal as `false` and RETHROW everything
 * else (only ELOOP is folded in), and no caller of this module catches. Measured,
 * both ends of the migration wedge on an ordinary permission fault:
 *
 *   a document in a read-only parent dir   EACCES from `removePath` — and it
 *                                          escaped AFTER the root document was
 *                                          deleted and the plan written
 *   `.traffic-one/plan.md` is a DIRECTORY  EISDIR from `writeTextFile`
 *   a read-only `.traffic-one/`            EACCES from `writeTextFile`
 *
 * In each case nothing was returned, the caller's hook died, and the next hook
 * repeated it — a permanent fail-closed deny over a chmod. The refusal this
 * module's docblock called survivable was only ever the FENCE's; this is the other
 * half. Reported as "it did not happen", which is what happened, and the content
 * key makes the retry cheap and quiet: a write that failed folds again next time,
 * and a delete that failed re-attempts against a plan that already carries the
 * bytes.
 */
function acted(mutate: () => boolean): boolean {
  try {
    return mutate();
  } catch {
    return false;
  }
}

/**
 * IS THIS STILL THE FILE WE READ — asked immediately before the unlink, because
 * the migration reads every document, then writes the plan, then unlinks each
 * one, and a document that changed inside that window would be destroyed carrying
 * bytes the plan never folded.
 *
 * MEASURED window: 58 ms for one document, 3.7 s for 400. This codebase states
 * elsewhere that parallel hook processes are normal, so the window is not
 * theoretical — and see `__tests__/plan-migration-window.test.ts`, which drives a
 * SECOND PROCESS through it.
 *
 * It also answers the delete primitive's shape. `removePath` is
 * `rmSync(recursive: true, force: true)`, so a candidate path that became a
 * DIRECTORY inside the window would take its whole tree; a path that became a
 * symlink would have the link removed rather than the file we read. `lstat` says
 * regular file and the re-read says the same bytes, so what gets unlinked is the
 * file that was read.
 *
 * NOT a closed race, and it must not be reported as one: `lstat` -> re-read ->
 * `rmSync` is three syscalls and POSIX offers no compare-and-unlink, so a writer
 * that lands between the re-read and the unlink still loses. What the check does
 * is shrink the exposed window from "the whole migration, including every other
 * document's read and the plan write" to the gap between two adjacent syscalls on
 * one path.
 *
 * AND THE RESIDUAL GAP IS STILL TREE-SHAPED, which the previous version of this
 * docblock denied in the same breath as disclosing the gap ("read it as a file,
 * delete it as one" is true of the guard and NOT of what happens after it).
 * MEASURED by swapping the candidate for a directory in that gap: `removePath`
 * took the directory and a nested file with it. Bounding the residual to one
 * inode needs a file-scoped guarded primitive — `unlinkSync` behind the same
 * consent fence and state-write ledger `removePath` carries — which belongs in
 * fsjson.ts beside the other guarded primitives, not hand-rolled here past the
 * fence. `removePath` itself cannot become it: every other caller legitimately
 * removes a TREE (materialize/generated.ts, state/traffic-one-paths.ts,
 * retention.ts). That primitive is also where the fold's missing audit trail
 * belongs — see `planMigrationNotice` for why the record cannot sensibly be
 * written from here. Until then the disclosure is the honest half: the gap is two
 * syscalls wide and what fits through it is a whole tree, not a file.
 *
 * NEITHER HALF OF THIS GUARD IS PINNED BY THE OTHER'S FIXTURE, and the previous
 * version of this docblock claimed the `lstat` was "the one guard in this file
 * whose mutant survives" — which was true of the `lstat` and false as a
 * description of the pair. Dropping the RE-READ survived too, because the only
 * fixture that entered the guard was the directory swap, which the `lstat` alone
 * answers: the suite pinned "not a regular file" and never pinned "different
 * bytes", the comparison the guard exists for. The doc-rival row cannot pin it
 * either — it accepts `changed|blank|not-carried` or `migrated`, by design, since
 * which one happens is the scheduler's choice. There is a deterministic row for
 * it now (plan-migration-window.test.ts, the different-bytes swap at the plan
 * write's `mkdirSync`), and dropping the re-read destroys the newer bytes there.
 *
 * THE `lstat` MUTANT STILL SURVIVES, with the reasoning it always had, now that
 * it is the only one: on POSIX the re-read subsumes it for most shapes a test can
 * plant — a directory answers EISDIR and a symlink ELOOP, both arriving as `null`
 * and refusing. THAT ENUMERATION WAS INCOMPLETE and is corrected here: a
 * CHARACTER DEVICE reads as `''`, not `null`, and is refused by the content
 * comparison rather than by the read. What the `lstat` buys is two further cases.
 * On Windows `O_NOFOLLOW` degrades to 0, so a path swapped for a link pointing at
 * identical bytes would pass the re-read and this is the only refusal left —
 * untried rather than untrue. And a path swapped for a FIFO would BLOCK the
 * re-read until someone opened the other end: a hung hook rather than a lost
 * document. That second case was called "unkillable by a test" here, and that was
 * WRONG — a child process with a timeout measures it exactly, which is how the
 * candidate loop's `not-a-file` refusal is now pinned
 * (plan-migration-fold-safety.test.ts). Unreachable through THIS guard's own
 * window still holds; unmeasurable did not.
 */
function stillTheFileWeRead(projectRoot: string, doc: LegacyDoc): boolean {
  try {
    if (!fs.lstatSync(doc.absPath).isFile()) return false;
  } catch {
    return false;
  }
  // AND IS IT STILL THE SAME PLACE — the containment half, re-established rather
  // than inherited from the candidate loop. `removePath` is `rmSync`, which
  // resolves every intermediate component at unlink time, so a `packages` swapped
  // for a symlink after the read would send the delete out of the project on a
  // path this loop already vetted. Requiring the SAME resolved path (not merely
  // a contained one) also refuses a candidate re-pointed at a different file
  // inside the project.
  if (resolveWithinProject(projectRoot, doc.absPath) !== doc.realPath) return false;
  return readTextNoFollow(doc.absPath) === doc.content;
}

const RETAIN_PROSE: Record<PlanMigrationRetainReason, string> = {
  'runtime-directive': 'carries Traffic One runtime marker grammar, which the plan is parsed for',
  unembeddable: 'has a path that cannot be written into `.traffic-one/plan.md` without changing the structure of that file',
  symlink: 'is a symlink, and a link is not evidence of what it names',
  'not-a-file': 'is not a regular file',
  unreadable: 'could not be read',
  blank: 'holds no content to carry',
  'not-carried': 'is not carried by `.traffic-one/plan.md` on disk',
  changed: 'changed on disk after it was read',
  'remove-failed': 'could not be removed',
};

/**
 * The migration's own account of itself, for the caller that reports it — and the
 * reason this module's return value is no longer written to nobody.
 *
 * `migrated` and `retained` were reasoned about at length in a docblock while
 * BOTH `converge.ts` call sites discarded the result, so the reasoning defended
 * nothing a reader could see. Both call sites now feed this into the
 * materialization outcome's `context` (converge.ts), which is the text
 * onboarding-gate/handler.ts puts in front of the agent.
 *
 * WHAT IT DOES NOT REACH, and this is MEASURED now rather than read — the
 * previous version of this docblock labelled it "a reading, not a measurement" on
 * the premise that a fixture would have to sit inside this repository, and that
 * premise is false: `isNonProjectRoot(<an os.tmpdir() fixture>)` is `false`, and
 * every suite in this fence already uses tmpdir fixtures. Driven on the quiet
 * steady state (an already-materialized project, the shape converge.test.ts uses
 * for "returns null"):
 *
 *   control, no legacy doc   outcome null, the one-mcp reporter fires
 *   with a legacy doc        outcome null
 *   document DELETED         true
 *   plan carries the bytes   true
 *
 * A DOCUMENT IS DESTROYED AND ITS BYTES RELOCATED WITH NO OUTCOME, NO NOTICE AND
 * NOTHING IN THE TRANSCRIPT. When convergence has other work the notice IS
 * threaded and the fold is reported; the quiet path is the common one and it is
 * silent.
 *
 * The structural reason, stated so the gap is not closed the wrong way:
 * `materializeProjectIfNeeded` returns `null` on the hook-time paths where
 * nothing else needed doing, and onboarding-gate turns a non-null outcome on a
 * MUTATING PreToolUse into a deny. Returning an outcome to announce the fold
 * would therefore deny the tool call that triggered it — ONE deny per fold, not
 * "a permanent deny loop" as this docblock used to say: the fold happens once,
 * the document is gone, and the next call returns `null` again. One wrongful deny
 * is still the wrong trade for a notice.
 *
 * WHERE THE TRACE BELONGS INSTEAD, and it is not here: on the DELETE. fsjson's
 * `act()` records to the state-write ledger only when the target classifies as
 * project state, so today `.traffic-one/architecture.md` is recorded and
 * `architecture.md` and `packages/<p>/architecture.md` — the two the user is most
 * likely to miss — are not. THAT SPLIT HAS A REASON, and this docblock said it
 * had none: fsjson.ts's own guard comment states it, and the correction changes
 * the remedy rather than only the sentence. `stateWrites` in the decision log
 * MEANS state writes, and the generator emitting `dist/**` goes through the same
 * helpers — so relaxing `act()`'s guard to record plain writes too would flood a
 * 64-entry buffer with generator output and, by the eviction rule in
 * shared/state/state-write-log.ts, evict exactly the refusals the collector
 * exists to explain.
 *
 * The file-scoped guarded delete primitive this module wants anyway (see
 * `stillTheFileWeRead`) is still the right home, and it is the right home ONLY IF
 * IT RECORDS UNCONDITIONALLY. Built like `removePath` — `act(target, op, guard,
 * …)`, which records `if (guard === 'state')` — the same split reappears one level
 * down and the chokepoint is exactly as silent as this call site for the two paths
 * that matter. It has to call `recordStateWrite` itself rather than inherit
 * `act()`'s classification, which is still a per-PRIMITIVE record and so does not
 * contradict the ledger's argument against per-call-site ones (that argument, and
 * the two records it has already removed, is why writing this from HERE was
 * considered and rejected).
 *
 * AND THE LEDGER IS NOT THE DURABLE TRACE WHATEVER IT RECORDS, so the primitive
 * does not retire this disclosure. It is a 64-entry per-invocation buffer that
 * evicts SUCCESSES first — and a completed delete is a success — where one
 * materialization is ~190 state writes by the ledger's own docblock; it is drained
 * per invocation and persisted only when logging is on, and `T1_DECISION_LOG=off`
 * is a documented opt-out. `StateWriteRecord` also has no field for where the
 * bytes went, so it cannot say a removal was a RELOCATION. What the primitive must
 * record is the absolute path for state and plain alike, an `op` distinguishing a
 * single-file unlink from `removePath`'s recursive tree removal (both are
 * `'remove'` today), `ok`, and the symbolic errno. The durable witness to the
 * relocation stays what it is now: the plan's `### <relPath>` heading and the
 * marker naming the path and a digest of the bytes.
 *
 * THE OTHER DIRECTION IS PROMPT-INJECTION SURFACE, and calling it a transcript
 * residual under-rates it. This function interpolates a retained path — an
 * attacker-supplied directory name — into the `context` that onboarding-gate puts
 * in front of the agent. "No enumerated parser reads the transcript" answers the
 * wrong question: the LLM is the parser, and it is the one consumer that acts on
 * prose. `foldInputRefusal` was cited as the bound and DID NOT BOUND THIS: four
 * refusals report before it runs and a fifth reported the value it was refusing.
 * What bounds it is `reportablePath`, which asks the same two questions of every
 * path this sentence carries, whichever reason carried it here.
 */
export function planMigrationNotice(result: PlanMigrationResult | null): string {
  if (result === null) return '';
  const parts: string[] = [];
  if (result.migrated.length > 0) {
    parts.push(`Legacy \`architecture.md\` folded into \`.traffic-one/plan.md\` and removed: ${result.migrated.map((rel) => `\`${rel}\``).join(', ')}.`);
  }
  if (result.retained.length > 0) {
    parts.push(`Left exactly where it is, unfolded and not removed: ${result.retained.map((doc) => `\`${doc.relPath}\` (${RETAIN_PROSE[doc.reason]})`).join(', ')}.`);
  }
  return parts.join(' ');
}

/**
 * Fold a legacy `architecture.md` into `.traffic-one/plan.md` and remove it.
 *
 * ONLY FOR A DIRECTORY TRAFFIC ONE ALREADY OWNS, and only for bytes the plan
 * PROVABLY carries. Ungated, this ran for every directory that got past
 * `isNonProjectRoot` in materializeProjectIfNeeded — `readEffectiveState` returns a
 * `Rec` and never the `null` its caller tests for, so the migration was effectively
 * unconditional. MEASURED across seven shapes, before the gate and now:
 *
 *                                        BEFORE          NOW
 *   NO .traffic-one at all               DELETED/MINTED  kept/none
 *   NO .traffic-one, doc in .traffic-one DELETED/MINTED  kept/none
 *   state file unreadable (torn json)    DELETED/MINTED  kept/none
 *   state, unknown stack, not onboarded  DELETED/MINTED  DELETED/MINTED
 *   state, known stack, incomplete       DELETED/MINTED  DELETED/MINTED
 *   legacy ONBOARDED project             DELETED/MINTED  DELETED/MINTED
 *   legacy onboarded, doc in state dir   DELETED/MINTED  DELETED/MINTED
 *
 * The first two rows are a hand-authored file destroyed in a directory the user has
 * not yet been asked about; the third is a file destroyed on the authority of a
 * state file nothing could parse (see `ownsReadableState`). The four rows that
 * remain are the shape the migration is FOR — a project that was onboarded by a
 * release that wrote architecture.md — and they must stay, or the plan gate denies
 * that project's feature writes for a `plan.md` that will never appear.
 *
 * ── THE DELETE IS KEYED ON THE BLOCK, NOT ON THE MARKER ──────────────────────
 *
 * The fold key is the marker (`contentMarker`); the delete key is the BLOCK the
 * fold writes — that heading, that marker, and the document's verbatim bytes
 * (`migratedBlock`). Round 4 moved the fold to a content key and left the delete
 * on `persistedPlan.includes(doc.marker)`, and the marker is not the content: it
 * lives in `plan.md`, which the user owns and edits, and it survives every edit
 * that destroys what it stands for. THREE MEASURED ROUTES to a document unlinked
 * with its bytes in no file under the project root, all three now `retained` with
 * reason `not-carried`:
 *
 *   1. the user's own editor — fold, delete the migrated prose from the plan but
 *      leave the HTML comment (invisible in every rendered markdown view), then
 *      restore the document. Measured: unlinked, bytes in zero files. The control,
 *      with the comment removed too, re-folds and keeps everything — so the entire
 *      difference between preservation and destruction was whether an edit
 *      happened to keep one comment line.
 *   2. a formatter re-wrapping only the folded prose, comment untouched.
 *   3. ANOTHER document's content carrying the marker for this one. The marker's
 *      path field is honoured, so a marker for A could not delete B — but its
 *      PROVENANCE was never checked, and a `packages/<p>/architecture.md` whose
 *      bytes include the root document's marker got the root document deleted.
 *      Closed twice over now: such a document is not a candidate at all
 *      (`RUNTIME_PLAN_MARKERS`), and even if the marker reached the plan by some
 *      other route the block does not follow it.
 *
 * The docblock this replaces reasoned only about the user DELETING the marker
 * ("folds again, duplicates a block, loses nothing"). The inverse — content
 * deleted, marker kept — is the destructive direction and was not considered.
 *
 * WHY THE OLD CHECK WAS INERT, so the same shape is not written again: with
 * `planChanged === false` every candidate marker is already in `basePlan`, and
 * with `planChanged === true` the guarded write returned true, which puts every
 * candidate marker in the file. `persistedPlan.includes(doc.marker)` was therefore
 * a tautology in every reachable state — removing it outright and reverting it to
 * the round-3 heading key both survived the whole suite. Three bullets credited it
 * with having closed three destruction routes; they were crediting a no-op, and the
 * protection came from the fold key and the write-success check.
 *
 * THE BLOCK KEY IS NOT A TAUTOLOGY, and this is the reachability rather than a
 * claim: a document whose marker is already in `basePlan` is NOT folded, so its
 * block is never written, so whether the plan carries it is a fact about the
 * user's file and not about anything this function just did. That is precisely
 * routes 1-3, and each of them now reddens on all three mutants (check deleted,
 * check reverted to the heading key, check reverted to the marker key) —
 * `__tests__/plan-migration-destruction.test.ts`.
 *
 * ── THE CONSENT FENCE IS ASKED ON THE DELETE PATH ────────────────────────────
 *
 * Not only through the write. The fence covers `<project>/.traffic-one/**` and has
 * no opinion at all about the two locations that hold the USER'S file — measured,
 * per path, in all three consent states:
 *
 *                                  pending  declined  granted
 *   architecture.md                permit   permit    permit
 *   packages/<p>/architecture.md   permit   permit    permit
 *   .traffic-one/architecture.md   REFUSE   REFUSE    permit
 *   .traffic-one/plan.md           REFUSE   REFUSE    permit
 *
 * So routing the write through `writeTextFile` covers the delete only while there
 * is a write to route. Skip the write — a plan that already carries every marker,
 * which is what a fresh clone of a migrated project produces, since `.one.json`
 * and `plan.md` are both TRACKED files — and the fence was never consulted:
 * measured on that shape, a pending project and a declined project both lost the
 * document while the permission check was returning false. `stateWritePermitted`
 * asks the same question the write would have asked, which is what this branch
 * needs and what its docblock reserves it for: work that must be decided before a
 * different path is touched. A pending project stays byte-identical, which is the
 * product contract's pending half.
 *
 * NOTHING IS FOLDED means NOTHING IS WRITTEN: `nextPlan` is `existingPlan` itself
 * rather than a re-normalized copy of it. The previous version rebuilt the file
 * from `existingPlan.trimEnd()` on every pass, which rewrote a plan whose only
 * fault was trailing blank lines — and would now also trim the trailing newlines
 * of the last folded document out of the block that licenses its delete, stranding
 * any document whose unlink had to be retried. That hazard was argued here and
 * pinned nowhere, so reinstating the re-normalization survived the whole suite;
 * it reddens now on the sentinel-deleted row in
 * plan-migration-destruction.test.ts, where the strand is permanent rather than
 * deferred — every later pass trims an already-trimmed plan, so the block never
 * comes back.
 *
 * `migrated` lists what was REMOVED — never what was folded, never what was
 * merely a candidate — so a caller cannot read a refusal, a fence refusal or a
 * failed unlink as a completed move. `retained` is the other half and names every
 * candidate deliberately left alone, with the reason; `planMigrationNotice` turns
 * the pair into the sentence converge.ts reports.
 */
export function migrateArchitectureDocsToPlan(cwd: string): PlanMigrationResult | null {
  // CONTAINMENT FIRST, ahead of the state read: `.traffic-one` is where the plan
  // is written AND where the state file that licenses every delete is read from,
  // so a state dir that resolves out of the project has to refuse before anything
  // opens a file through it. fsjson's own containment rule already refuses the
  // plan WRITE on that shape, which is what kept it from being a leak — but it
  // refuses it after this module has read the outside document into the candidate
  // list. See `withinProject` for why these two directories are the whole set.
  const projectRoot = realPathWithMissingTail(cwd);
  if (projectRoot === null) return null;
  if (resolveWithinProject(projectRoot, path.join(cwd, '.traffic-one')) === null) return null;
  if (!ownsReadableState(cwd)) return null;

  const { docs, retained } = legacyArchitectureDocs(cwd, projectRoot);
  if (docs.length === 0 && retained.length === 0) return null;

  const planPath = path.join(cwd, '.traffic-one', 'plan.md');
  if (docs.length === 0) return { changed: false, migrated: [], retained, planPath };

  const existingPlan = readTextNoFollow(planPath);
  const basePlan = (existingPlan && existingPlan.trim()) ? existingPlan.trimEnd() : PLAN_TEMPLATE.trimEnd();
  const unfolded = docs.filter((doc) => !basePlan.includes(doc.marker));
  const nextPlan = unfolded.length > 0
    ? foldIntoPlan(basePlan, unfolded.map((doc) => doc.block))
    : (existingPlan ?? `${basePlan}\n`);

  const planChanged = nextPlan !== existingPlan;
  if (planChanged) {
    if (!acted(() => writeTextFile(planPath, nextPlan))) return null;
  } else if (!stateWritePermitted(planPath)) {
    return null;
  }

  const migrated: string[] = [];
  for (const doc of docs) {
    // FROM DISK, not from `nextPlan`: for a document we just folded the two agree
    // by construction, and for a document we did NOT fold — routes 1-3 above — the
    // plan is the only witness. It is also the read a concurrent plan rewrite has
    // to get past; see `__tests__/plan-migration-window.test.ts`.
    //
    // PER DOCUMENT, and not once before the loop. One read licensed every unlink
    // that followed it, and the loop is 3.7 s long for 400 documents — so a plan
    // rewrite landing anywhere in it (another hook process, an editor, a formatter)
    // took 399 documents on evidence that was already stale. MEASURED with a rival
    // process rewriting the plan in a loop: with one read, documents were removed
    // whose bytes the plan no longer carried. This is the only place in the round
    // where a re-read per iteration buys correctness rather than tidiness.
    // THROUGH `reportablePath` LIKE EVERY OTHER `retained` ROW, even though a doc
    // reaching this loop cannot carry unsafe grammar: `relPath` is the sole inline
    // value of `FoldInputs`, and `foldInputRefusal` is asked of it before the doc
    // is pushed, so it is vetted already and this call is the identity. Routing it
    // anyway keeps the property a fact about THIS site rather than an argument
    // about a caller — a fourth reason added here, or the vetting moving upstream,
    // would otherwise put a raw path back into the notice with nothing red.
    const persistedPlan = readTextNoFollow(planPath) ?? '';
    const reported = reportablePath(doc.relPath);
    if (!persistedPlan.includes(doc.block)) { retained.push({ relPath: reported, reason: 'not-carried' }); continue; }
    if (!stillTheFileWeRead(projectRoot, doc)) { retained.push({ relPath: reported, reason: 'changed' }); continue; }
    if (!acted(() => removePath(doc.absPath))) { retained.push({ relPath: reported, reason: 'remove-failed' }); continue; }
    migrated.push(doc.relPath);
  }

  return { changed: planChanged || migrated.length > 0, migrated, retained, planPath };
}
