// src/shared/state/deny-repeat.ts
// How many times THIS run has refused THIS write for THIS reason.
//
// Gates are pure functions of on-disk state, so an identical retry draws an
// identical deny forever: nothing counts, nothing backs off, nothing escalates.
// Measured in 17cl: 25 denies, 15 of them repeats of four (file, reason) pairs —
// one of them refused SEVEN times over 25 minutes on the same file, ending in a
// full replan for a one-line fix the deny text had already named. Every retry is
// a whole agent turn.
//
// The counter deliberately does NOT block. A hard cap here would strand runs
// whose next attempt was about to succeed, and the honest failure path already
// exists: report BLOCKED, or hand the finding to the role that owns the path.
// What was missing is the agent ever being TOLD it is looping.
//
// Consulted at the CHOKEPOINT — core/pipeline.ts's deny exits, the one place
// every refusal from every gate passes through — and nowhere else. It used to be
// wired into a single call site (plan-guard's plan-write aggregator) with the
// chokepoint uninstrumented, so ~120 other gates could draw an identical
// refusal forever in silence, which is the same failure the counter exists to
// name, one level up. This is the reasoning that already put the consent fence
// in fsjson.ts and the write log in state-write-log.ts: a per-call-site rule is
// one every future gate author has to remember, and forgetting it is silent.

import * as path from 'path';

import { isEscalatableDenyId } from '../../config/deny-ids';
import { readJson, writeJson } from '../fsjson';
import { isNonProjectRoot } from '../authoring-root';
import { pluginRoot } from '../paths';
import { safePathSegment } from './run-agent/run-paths';

/** Identical refusals before the deny starts saying so. */
export const DENY_REPEAT_ESCALATE_AT = 3;

// Bounded so a pathological run cannot grow this without limit; the tail is what
// matters and old keys are not worth carrying.
const MAX_TRACKED_KEYS = 64;

type Counts = Record<string, number>;

// `safePathSegment`, like every other `runs/<id>/` path this codebase builds
// (run-agent/run-paths.ts's runDir, decision-log.ts's log dir). This one used the
// run id RAW, and the id is read back off `.traffic-one/.one.json` — a file a
// cloned repo ships — so a `currentRunId` carrying `../..` addressed a path
// outside the state dir entirely, where the write fence (which resolves the
// project root from the FIRST `.traffic-one` segment) no longer recognises it as
// project state and lets it through.
function repeatsPath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', safePathSegment(runId), 'debug', 'deny-repeats.json');
}

/**
 * A stable identity for "the same refusal" — the WHOLE message, byte for byte.
 *
 * Deliberately the strictest possible reading, arrived at by discarding two
 * looser ones that live evidence killed:
 *
 * An 80-char prefix (the first attempt) cannot see the subject. `filePath` is
 * the file being WRITTEN — for a completion gate that is the digest, the same
 * string on every attempt — while the file the deny is ABOUT appears inside the
 * message, and the collapse gate's prose does not reach it until char 77. Two
 * different collapsed files signed identically.
 *
 * Normalizing digits (the second attempt) cannot see position. Observed 16co:
 * `LessonPage.tsx:57` then `LessonPage.tsx:76` — one agent clearing collapse a
 * line at a time, which is progress on a real defect, and normalization merged
 * them into one count. Escalation exists to break loops; firing it at an agent
 * that is converging is worse than never firing it at all.
 *
 * So: a refusal is "the same" only when it is textually identical. That is
 * precisely 17cl's shape — seven byte-identical refusals of one file over 25
 * minutes. The cost is that a deny embedding a genuinely volatile detail (a
 * scanned-file count) may never escalate, and that is the right trade: a missed
 * escalation costs a replan the run was already heading for, while a false one
 * tells a working agent to report BLOCKED.
 *
 * Sorted so two gates firing in either order are one signature.
 *
 * ── WHY NOT KEY ON (denyId, denyTarget) AND DROP THE PROSE? ─────────────────
 *
 * Because it merges refusals that are not the same refusal, at all thirteen
 * measured sites. This is written down because it is the natural proposal to
 * make when you arrive here and find two folds below, and it has now been made
 * twice: the key is the rendered prose, the prose needs folding wherever a
 * volatile value reaches it, so retiring the prose from the key looks like it
 * retires both folds and the scans that pin them. It does. It also costs more
 * than they do.
 *
 * The proposal's usual premise is that the folds exist because ELEVEN
 * escalatable ids reach the chokepoint with an empty `denyTarget`, so for them
 * the prose is the only place the subject appears — give those eleven a target
 * and the edifice retires. The premise is a symptom, not the root. What the
 * tuple key actually needs is that the target FULLY DISCRIMINATES the refusal,
 * and it is not the eleven that fail that.
 *
 * MEASURED, by joining the shipped prose for every escalatable id (which names
 * everything the rendered reason varies on, as `{{PLACEHOLDER}}`s) against the
 * replay-corpus snapshot (the only record of what target really arrives here —
 * reading call sites does not work, because most gates push `block()` into a
 * violations array and an aggregator supplies the target much later).
 *
 * EVERY FIGURE BELOW IS RECOMPUTED by __tests__/deny-signature-plugin-root.test.ts
 * from those three artefacts, and that file fails with the current table printed
 * when one moves. The prose half is read from `skill-fallbacks.generated.ts`, a
 * generated MIRROR of the SKILL.md blocks rather than the blocks themselves; it
 * is kept honest by its own drift test rather than by anything here, which is
 * worth knowing before treating these figures as read straight off the shipped
 * files. This is not decoration: the numbers here were carried as prose
 * in two disagreeing copies and they were wrong — a partition that summed to 41
 * against a stated population of 56, one file saying 55 escalatable ids on one
 * line and 56 on another, a stale case count, and two figures (122 counted denies
 * and 24 of them) larger than any population the snapshot can produce. A record
 * that is wrong is a reason to make it derivable, not a reason to stop recording
 * it.
 *
 *     escalatable ids with shipped prose = 120
 *     of those, ids the corpus fires = 41
 *     of those, ids the corpus never fires = 79
 *     fired ids whose target is empty on every row = 8
 *     fired ids whose prose renders no placeholder at all = 20
 *     fired ids with a populated target AND placeholders = 13
 *     of those, ids whose target covers everything the prose renders = 0
 *     of those, ids whose every placeholder is frozen for the run = 0
 *     of those, ids whose prose can move WITHIN one run = 13
 *     escalatable deny rows in the corpus = 64
 *     escalatable deny rows carrying an empty target = 11
 *     ids the corpus fires with an empty target, prose or not = 10
 *     replay-corpus cases = 141
 *     distinct (denyId, target) pairs among the escalatable deny rows = 60
 *
 * The 79 that never fire are unprovable in either direction; the ten with an
 * empty target are the eight above plus two that ship no prose at all. The last
 * row is over the 64 escalatable deny ROWS, not over the 141 cases above it.
 *
 * THIRTEEN AND NOT NINE — a narrowing this docblock made and has now WITHDRAWN,
 * because its premise was false against the code it named. The narrowing was the
 * counter's own scale: the file is `runs/<id>/debug/deny-repeats.json`, per run,
 * so a placeholder that cannot change WITHIN a run cannot split a count, and
 * four of the thirteen were said to have only such a placeholder — three render
 * `{{PROFILE_SUMMARY}}`, "frozen with the run id", and `component-placement` a
 * two-literal `{{TARGET}}` "chosen by that same profile". The scale argument is
 * right. Both freeze claims are wrong, for two unrelated reasons:
 *
 *   - THE PROFILE IS NOT FROZEN WITH THE RUN ID. `capabilityProfileForRun`
 *     returns the run snapshot WHEN ONE EXISTS, and
 *     `ensureArchitectureRunSnapshot` — which `ensureCurrentRunId` calls on
 *     every read of an EXISTING run id — re-mints that snapshot through
 *     `supersedeBlockedRunSnapshot` whenever the frozen profile carried a
 *     blocking issue and live detection no longer does (architecture-contract/
 *     compile.ts; mint-once was wedging runs frozen before the hybrid UI
 *     question was answered). DRIVEN inside one run id: the rendered summary
 *     moved from `profile=unsupported-hybrid; framework=hybrid; … roots=apps/web/
 *     app, apps/web/src/app, app, src` to `profile=next-app; framework=nextjs; …
 *     roots=apps/web/app, apps/web/src/app` — the two native roots gone — and one
 *     unchanged `scaffold-stack-gate` loop signed TWO keys across the supersede.
 *     The trigger is narrow — the sole producer of blocking issues is the
 *     hybrid-UI-target requirement, resolved mid-run by setting
 *     `architectureTarget` — and it is exactly the new-project, pre-`plan.md`
 *     situation in which the three scaffold gates fire repeatedly.
 *   - `component-placement`'S TARGET WAS NEVER THE PROFILE'S. plan-static.ts
 *     picks between its two literals on `isNativeState(state)` — `.one.json`'s
 *     `mobile.framework`/`stack`, which the shipped set-tech command rewrites
 *     through `--mobile=` — and never consults the run snapshot at all. It moves
 *     for a reason unrelated to the freeze, so the mechanism the narrowing named
 *     was wrong independently of whether the freeze held.
 *
 * The tuple key therefore merges at every one of the thirteen, and no per-run
 * exemption is left to grant: the movable figure above IS the population, so no
 * edit to a declared list can move it. What survives the withdrawal is a record
 * of the four ids and of what moves each, DRIVEN — across a real supersede, and
 * across the state flip — in __tests__/deny-signature-plugin-root.test.ts rather
 * than asserted here.
 *
 * ZERO is the number that decides it, and it is the ONE figure in the table that
 * is a reviewed judgement rather than a computation — the snapshot records the
 * target, not the rendered reason, so nothing mechanical can decide whether a
 * target carries what its prose renders. An automated pass that tried scored
 * `absolute-traffic-one-path` as fully covered because its `{{BAD_PATHS}}`
 * placeholder resembles its `abs-path-outside-project` target; review found the
 * SCRIPT wrong, not this docblock — the target is the offending file and the
 * placeholder is the paths written inside it, and name similarity is not
 * coverage. The 13 are therefore pinned by NAME in that test, so a new member
 * has to be read against its own prose before it can join them.
 *
 * Not one observed escalatable id has a target carrying everything its prose
 * says, so the tuple is strictly coarser than this signature for every id that
 * renders a placeholder at all. Two of the thirteen, named so this is checkable
 * rather than re-countable:
 *
 *   - `cross-feature-import`: the target is the offending FILE; the prose names
 *     which feature imported which. Two different cross-imports in one file are
 *     two different fixes, and today they are two counts. Under the tuple they
 *     are one count that escalates on the third.
 *   - `performance-model-param`: the target is the ROLE; the prose names the
 *     expected model, the level, the host and the alternates. Three spawns of
 *     one role passing three DIFFERENT wrong models is an agent changing what it
 *     does every attempt, and it escalates on the third.
 *
 * Both are the digit-normalization failure above, arriving at thirteen ids
 * instead of one — the false positive this docblock already ranks as worse than
 * never firing at all.
 *
 * And populating the eleven empty targets does not touch any of it: those
 * thirteen ids have populated targets already. Removing the prose from the key
 * is a change to all 113 ids, not to the eleven. Populating a target is still
 * worth doing on its own merits — it is already half of this key, and it feeds
 * the decision log and the escalation prose — but it is not a step toward
 * retiring the folds, and the eleven-id table with a discriminating-and-stable
 * target proposed for each is kept in
 * `__tests__/deny-signature-plugin-root.test.ts`, beside the derivation of the
 * figures above, as a recorded dead end rather than as a plan.
 */
export function denySignature(filePath: string, violations: readonly string[]): string {
  const reasons = [...violations]
    .map((violation) => violation.replace(/\s+/g, ' ').trim())
    .sort()
    .join('|');
  return `${filePath || '(shell)'}::${reasons}`;
}

/** What an install's own location is replaced by before the message is signed. */
export const PLUGIN_ROOT_SIGNATURE_TOKEN = '<plugin-root>';

/**
 * The signed text with THIS INSTALL'S OWN LOCATION folded out of it.
 *
 * The signature is the rendered message, which is the strictest reading
 * available and the right one — with one input that is volatile for a reason
 * that has nothing to do with the agent. Several escalatable denies interpolate
 * a runnable command built from `pluginRoot()`, an environment-supplied
 * absolute path: `tech-classify-required` carries
 * `onboardingSetTechCommandTemplate` (SET_TECH_TEMPLATE), `cursor-models-capture`
 * carries `modelCaptureCommand` (CAPTURE_CMD). Measured: all three command
 * builders in that family embed the root verbatim, and driving this counter
 * across a version bump gave counts 1,2,1,2,3 — the loop split into two keys and
 * the escalation arrived on the FIFTH identical refusal instead of the third.
 * Two hosts alternating over one project (Cursor imports the `~/.claude`
 * user-scope bundle, Codex keeps its own cache) gave 1,1,2,2,3,3,4,4: same
 * five-instead-of-three delay, permanently, with no version bump at all.
 *
 * That is precisely the class the docblock below already excludes — a detail the
 * agent did not cause and cannot act on — except that unlike a scanned-file
 * count it is not a property of the refusal at all. A version-keyed cache
 * directory, a `plugin:sync`, a restart onto a different host: none of them mean
 * the agent stopped looping, and the failure is silent in the one direction that
 * matters, since a count that never reaches the threshold reads exactly like an
 * agent making progress.
 *
 * Folded rather than fixed at the prose, because the prose is right: these
 * denies exist to hand the agent a command it can RUN, and an absolute path is
 * what makes it runnable from any cwd (see wait-command.ts's header). Each
 * process folds out the root IT would have interpolated, so two processes that
 * spell one install differently still agree — that is what makes this work
 * across the move rather than merely inside one process.
 *
 * Costs 18 µs (`pluginRoot()`, three fs calls) plus 0.57 µs for the substitution
 * on a 956-char reason, measured on this machine, once per COUNTED deny.
 *
 * NOT a claim that every signed reason is now install-independent. A deny that
 * echoes text the AGENT supplied — `claude-wait-background-denied` signs the
 * observed command — can carry a root this process never resolved, and folding
 * that would mean guessing at other installs' paths. It is out of reach here and
 * left alone rather than half-handled.
 *
 * EXPORTED ONLY TO BE PINNED. The degenerate-root guard below is unreachable
 * through `denyRepeat`: a plugin root of `/` puts every fixture inside the
 * authoring repo, so `isNonProjectRoot` declines to count before this runs, and
 * the case would go untested through the front door.
 */
export function withoutInstallLocation(text: string): string {
  if (!text) return text;
  const root = pluginRoot();
  // A root that IS a filesystem root would match the leading separator of every
  // absolute path in the message and collapse unrelated refusals into one key.
  // `pluginRoot()` resolves, so it is never empty and never relative — but it
  // can still be `/`, and on Windows it can be a drive root (`C:\`) or a UNC
  // share root (`\\srv\share`), which the old `root === path.sep` spelling did
  // not recognise on a platform this product supports. Asked as the
  // root-EQUALITY test the sentence above describes, through both parsers
  // rather than the running platform's, so the Windows shapes are decidable —
  // and pinnable — from a POSIX test run.
  if (isFilesystemRoot(root)) return text;
  return text.split(root).join(PLUGIN_ROOT_SIGNATURE_TOKEN);
}

/** `value` is a filesystem root under EITHER path grammar — `/`, `C:\`, `C:/`,
 *  `\\srv\share`. Exported to be pinned; see withoutInstallLocation's guard. */
export function isFilesystemRoot(value: string): boolean {
  if (value.length <= 1) return true;
  return value === path.posix.parse(value).root || value === path.win32.parse(value).root;
}

/** What a live onboarding wizard's own address is replaced by before signing. */
export const WIZARD_LINK_SIGNATURE_TOKEN = '<setup-link>';

// A wizard token as config/dashboard.ts emits it: the onboarding server mints
// 32 random bytes and hex-encodes them (runners/onboarding-server/server.ts), so
// 64 characters, and `localWizardUrl` percent-encodes before interpolating.
//
// The 16-character FLOOR separates it from ONE family, and the claim is worth
// stating narrowly because it used to be stated as "room on both sides" of the
// whole problem. `t=` is one of the most common cache-buster names there is and
// the values that arrive under it are usually timestamps — Vite's HMR query is
// `?t=${Date.now()}`, thirteen digits, and a seconds epoch is ten. Those the
// floor excludes, and __tests__/deny-signature-plugin-root.test.ts pins the
// boundary from BOTH sides (15 survives, 16 folds) so the constant cannot drift
// in either direction unobserved.
//
// It excludes NOTHING ELSE. Measured against this pattern: a git SHA (40 hex), a
// content hash, a microsecond epoch (16 digits), a nanosecond epoch (19), a
// UUID, a build id, a percent-encoded ISO timestamp and a JWT-shaped dev token
// all clear the floor. What keeps those out of the fold is the HOST and PATH
// anchors below, not this number — a `?t=<sha>` on a non-loopback host, or on any
// path other than `/` and `/local`, does not match at all. Both anchors are
// pinned with ABOVE-floor tokens for that reason; the rows that used a ten-digit
// token were killed by the floor alone and never reached them.
//
// Raising the floor toward the 64 the product actually mints is unavailable
// rather than merely unchosen: `localWizardUrl` percent-encodes, and the pattern
// has to keep matching a token that has been truncated or re-minted shorter by a
// future server without silently starting to split loops. The residual is stated
// rather than closed: a 16-plus-character `?t=` value on a LOOPBACK host at
// exactly `/` or `/local` folds even when it is not a wizard link. Nothing the
// product or a dev server emits has that shape today.
const WIZARD_TOKEN = '[A-Za-z0-9%._~-]{16,}';

// The onboarding wizard's link shapes, and ONLY those. Anchored on the product's
// own PATHS as well as on the port+token pair, because the pair alone was not an
// anchor: `[?&]t=` matched any URL carrying a `t` query parameter, so an echoed
// development-server URL (`http://localhost:5173/?t=1699999999`) lost its line
// from the signature and two distinct refusals merged into one count. Two arms:
//
//   - the hosted deep link, `<origin>/onboarding/agent#p=<port>&t=<token>`
//     (config/dashboard.ts agentOnboardingUrl). The fragment pair is matched in
//     EITHER order: nothing in the URL grammar fixes it, a reader reordering the
//     two would not think of this file, and the old pattern silently stopped
//     folding on the token-first spelling.
//   - the loopback fallback and the loopback root it redirects from,
//     `http://127.0.0.1:<port>/local?t=<token>` and `.../?t=<token>`
//     (agentOnboardingUrls). Constrained to a loopback HOST and to those two
//     paths, so a dev server on `localhost` keeps every URL that is not one of
//     the two shapes this product itself emits. Those two anchors are what
//     exclude every ABOVE-floor `?t=` value (a git SHA, a UUID, a content hash —
//     see WIZARD_TOKEN), so each is pinned separately, with a token the floor
//     cannot kill; the rows that used a ten-digit token never reached them.
const WIZARD_LINK = new RegExp(
  `https?://\\S*/onboarding/agent#(?:p=\\d+&t=${WIZARD_TOKEN}|t=${WIZARD_TOKEN}&p=\\d+)`
  + `|https?://(?:127\\.0\\.0\\.1|\\[::1\\]|localhost):\\d+/(?:local)?\\?t=${WIZARD_TOKEN}`,
);
const WIZARD_LINK_ALL = new RegExp(WIZARD_LINK.source, 'g');

/**
 * The label texts this product's own renderers put on a link line, normalized to
 * one space and trimmed.
 *
 * A CLOSED LIST, and that is a correction rather than a preference. The previous
 * rule read the SHAPE of the remaining text — under 100 characters, no backtick,
 * no path separator, no `{{` — on the stated premise that "every deny that names
 * a file, a role or a command renders it either backticked or as a path". That
 * premise is measurably false in the shipped prose: `{{ROLE}}` appears bare five
 * times against 38 backticked, across `agent-reuse-scope-regrant`,
 * `cursor-agent-type-required`, `kilo-general-agent-required` and
 * `opencode-named-agent-required`. And it cannot be repaired by adding
 * characters, because it is not a lexical property: measured, a role name, a run
 * id, a member id, a bare filename, a host name and a stack id each read as a
 * bare label and folded to `""`, merging genuinely different refusals — the false
 * escalation this module's header ranks as worse than never firing. A bare
 * identifier and a prose label are the same shape. Six substitutions found six;
 * the seventh is a prose rewrite away.
 *
 * So the question stops being "does this text look like a label" and becomes "is
 * this one of the labels we ship", which is what the fold was always claiming.
 * The list is small because the product renders exactly four forms, and every row
 * names its renderer so the next reader can check it.
 *
 * The failure mode of a closed list is the SAFE one, and it is the same trade
 * this module's header already makes. A prose rewrite that changes a label stops
 * the line being dropped, so the live and dead-server renders sign differently
 * and one loop becomes two keys: a MISSED escalation, costing a replan the run
 * was heading for anyway. The old rule's failure mode was the other one — a
 * discriminating subject erased, telling a working agent to report BLOCKED. And
 * the missed direction is not silent: `__tests__/deny-signature-plugin-root.test.ts`
 * drives every `{{URL}}`-bearing line in the SHIPPED prose table through this
 * predicate, so the rewrite fails there with the block named.
 */
const BARE_LINK_LABELS: ReadonlySet<string> = new Set([
  // modules/onboarding-gate/handler.ts's `urlLine`, shared/onboarding-server/
  // codex-setup.ts, and the `Open Traffic One setup: {{URL}}` line in five
  // onboarding-gate SKILL.md blocks — one of them indented four spaces, which
  // the normalization below is what folds.
  'Open Traffic One setup:',
  // onboarding-gate :: server-deny-reason-repeat, the one block that spells the
  // instruction out instead of using the short label. It was NOT in the
  // hand-written first draft of this list — the mechanical scan over the shipped
  // prose found it on the first run, which is the whole argument for having the
  // scan rather than four rows somebody enumerated by eye.
  'Post this setup link to the user in a chat message — the user opens it, not you:',
  // shared/onboarding-server/windsurf-setup.ts and the two windsurf blocks,
  // where the link is a markdown target rather than trailing text.
  '[Open Traffic One setup]()',
  // shared/onboarding-server/wizard-links.ts `localFallbackSection`.
  'If the hosted page is unavailable or returns 404, open the local wizard directly:',
  // …and `localFallbackLine`, the one-line spelling of the same fragment.
  'Direct local fallback:',
]);

/**
 * Is this line, once the URL is replaced by the token, nothing but a LABEL for
 * that URL — so that removing it entirely removes no discriminator?
 *
 * The whole line has to be removable for the liveness half of the fold to work
 * (see `withoutWizardLink`), and whole-line removal is exactly what can erase a
 * subject. Driven: a render of `… setup required for src/a.ts. Open Traffic One
 * setup: <url>` and the same line naming `src/b.ts` folded to the SAME empty
 * string, so two refusals about two different files signed identically.
 *
 * Two things are removable. A line the link is ALL of, where "removing it removes
 * no discriminator" is an identity rather than a claim; and a line carrying one
 * of the labels this product ships (`BARE_LINK_LABELS` above, with the argument
 * for a closed list). Everything else keeps its content with the URL
 * substituted — conservative in the SPLIT direction, which can cost a missed
 * escalation and can never merge two refusals.
 */
export function isBareLinkLine(lineWithToken: string): boolean {
  const rest = lineWithToken.split(WIZARD_LINK_SIGNATURE_TOKEN).join('').replace(/\s+/g, ' ').trim();
  return rest === '' || BARE_LINK_LABELS.has(rest);
}

/**
 * The signed text with a LIVE WIZARD SERVER'S IDENTITY folded out of it.
 *
 * The second volatile input, found by auditing the escalatable ids rather than
 * by waiting for it: `claude-wait-background-denied` interpolates
 * `URL_LINE` — `Open Traffic One setup: <dashboardUrl>` — and that URL carries
 * an EPHEMERAL PORT and a PER-SERVER-INSTANCE TOKEN. The wizard server restarts
 * routinely (a timed-out launch, a killed host, the user closing the tab), so a
 * restart between two draws of one unchanged loop rewrites the key: exactly the
 * install-location failure above, with the identical silent direction, since a
 * count that never reaches the threshold reads as an agent making progress.
 *
 * The whole LINE goes, not just the URL, because this input has a second
 * spelling the substitution above does not have: `urlLine` is `''` when no
 * server is alive (`liveWizardLink` returns null on a dead pid), so the same
 * refusal renders WITH the line and WITHOUT it depending on whether a process
 * happens to be running. Substituting the URL would fold the restart and leave
 * the liveness flip, which is the same defect one layer down. Dropping the line
 * makes both spellings equal after `denySignature`'s whitespace normalization —
 * the absent case already renders as blank there.
 *
 * Dropping is safe on a line the link is ALL of, and would not be for the
 * install location: the plugin root arrives inside the runnable command that is
 * the point of the message, where dropping the line would merge two genuinely
 * different commands. That distinction is now enforced rather than assumed —
 * see `isBareLinkLine` for what happens to a line the link shares.
 */
export function withoutWizardLink(text: string): string {
  if (!text || !WIZARD_LINK.test(text)) return text;
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    if (!WIZARD_LINK.test(line)) { kept.push(line); continue; }
    const substituted = line.replace(WIZARD_LINK_ALL, WIZARD_LINK_SIGNATURE_TOKEN);
    if (!isBareLinkLine(substituted)) kept.push(substituted);
  }
  return kept.join('\n');
}

/**
 * Every fold, applied in one place — the text a refusal is IDENTIFIED by.
 *
 * Two members today, and they are the whole set: this install's own location
 * and a live wizard server's address. Both are the same shape — an input that
 * moves for a reason the agent did not cause and cannot act on — and the shape,
 * not the list, is what a new escalatable deny has to be checked against.
 * __tests__/deny-signature-plugin-root.test.ts scans every escalatable id's
 * prose for a third one and fails with the id named, so the list stops being a
 * thing somebody has to remember.
 */
export function signatureText(text: string): string {
  return withoutWizardLink(withoutInstallLocation(text));
}

/**
 * Record one refusal and return how many times it has now happened in this run.
 * Best-effort: a diagnostic that throws must never change a gate's verdict.
 *
 * The counter file is `runs/<id>/debug/deny-repeats.json` — the sibling of the
 * decision log — so writeJson's consent fence refuses it while the use-plugin
 * question is unanswered. The count then stays at 1, which is below
 * DENY_REPEAT_ESCALATE_AT: pre-consent denies read exactly as they did before
 * this counter existed, and the project stays byte-identical.
 *
 * The count also becomes the decision log's `repeatCount`. It is RETURNED for
 * that rather than announced through a module-level slot, which is what this
 * used to do: the count was computed deep inside one gate's call stack, so it
 * had to reach core/pipeline.ts out of band. With the counter running AT the
 * pipeline's deny exit, the site that computes the number is the site that
 * builds the record, and the slot had no sender left — see this file's header
 * and the parameter core/pipeline.ts's recordDecision now takes.
 */
export function recordDenyRepeat(
  cwd: string,
  runId: string | null | undefined,
  signature: string,
): number {
  return countDenyRepeat(cwd, runId, signature);
}

function countDenyRepeat(
  cwd: string,
  runId: string | null | undefined,
  signature: string,
): number {
  if (!runId || isNonProjectRoot(cwd)) return 1;
  const file = repeatsPath(cwd, runId);
  try {
    const counts = readJson<Counts>(file, {} as Counts) || {};
    const next = (typeof counts[signature] === 'number' ? counts[signature] : 0) + 1;
    counts[signature] = next;
    const keys = Object.keys(counts);
    if (keys.length > MAX_TRACKED_KEYS) {
      // Drop the coldest half; the loop we care about is always among the hottest.
      const ranked = keys.sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
      const kept: Counts = {};
      for (const key of ranked.slice(0, MAX_TRACKED_KEYS / 2)) kept[key] = counts[key] as number;
      kept[signature] = next;
      return writeJson(file, kept) ? next : 1;
    }
    // A count that did not PERSIST is not a count, and the number it would
    // otherwise report is not ours: the base comes from reading the file, reads
    // follow symlinks (deliberately), and this number decides whether the agent is
    // told to STOP RETRYING and report BLOCKED. A `deny-repeats.json` shipped as a
    // link to a file claiming 9999 escalates the first deny of the run — against
    // an agent that is working correctly — while the write that would have made
    // the count ours is refused. So escalate only on a count we actually wrote.
    //
    // `1` is also exactly what a pre-consent deny reported before this counter
    // existed, and it is below DENY_REPEAT_ESCALATE_AT, so that deny reads as it
    // always did. (With the fence closed nothing persists AND nothing reads back,
    // so both spellings return 1 there — this branch earns its keep on the
    // partially-persisted and planted-file cases, not on that one.)
    //
    // Asking projectStateWritable() FIRST is what this used to do, so that a
    // refused write was never described as a successful one; writeJson reporting
    // its own outcome — to the caller here, and to the decision log from inside
    // the chokepoint — replaces both halves of that, and unlike the pre-check it
    // also covers a refusal the fence itself did not make.
    return writeJson(file, counts) ? next : 1;
  } catch {
    // The write's own failure is already recorded by the chokepoint, with the
    // real errno; a diagnostic counter must never throw into a gate's verdict.
    return 1;
  }
}

/**
 * The paragraph appended to a deny that has now fired `count` times unchanged.
 * Empty below the threshold, so an ordinary first or second attempt reads exactly
 * as it does today.
 */
export function denyRepeatEscalation(count: number, filePath: string): string {
  if (count < DENY_REPEAT_ESCALATE_AT) return '';
  const target = filePath || 'this target';
  return `\n\nSTOP RETRYING — this run has now refused \`${target}\` ${count} times for the same reason, and each attempt costs a full turn. Re-issuing it again will produce this identical message. Do exactly one of: (a) apply the remedy above literally, in full, and only then re-issue; (b) if the remedy names a path or file your work unit does not own, report it in your digest and let the orchestrator route it to the role that owns it; (c) if you cannot satisfy it at all, write your digest with verdict \`BLOCKED <one-line reason>\` naming this refusal. A repeated identical attempt is not one of the options.`;
}

// ── the chokepoint entry point ───────────────────────────────────────────────

/** The fields of a stamped deny this counter reads. Deliberately structural
 *  rather than `HookResult`: shared/ does not depend on core/ for a shape this
 *  small, and it keeps the counter callable from a test without a pipeline. */
export interface DenyRepeatInput {
  readonly reason: string;
  readonly denyTarget?: string;
  readonly denyId?: string;
  readonly askUser?: boolean;
}

export interface DenyRepeat {
  /** How many times this refusal has now fired, or null when it is not tracked
   *  at all (see denyRepeatCounted). Null, not 0 or 1: "no count exists" and
   *  "the count is 1" are different facts to an operator reading the decision
   *  log, and only the first one means "this id is excluded by policy". */
  readonly count: number | null;
  /** Appended to the deny's reason. '' below the threshold and for anything
   *  untracked, so those refusals stay byte-identical to today's text. */
  readonly suffix: string;
}

const UNTRACKED: DenyRepeat = { count: null, suffix: '' };

/**
 * Is this refusal one an agent could break out of by ACTING? Only those are
 * counted — see NEVER_ESCALATED_DENY_IDS (config/deny-ids.ts) for the rule and
 * for why it is not the never-overridable list.
 *
 * Excluded refusals are not counted at ALL, not merely left un-escalated. The
 * counter tracks at most MAX_TRACKED_KEYS signatures and evicts the coldest
 * half when it overflows, so a run that spends forty turns waiting on a human
 * would otherwise fill the table with the one refusal that is behaving
 * correctly and evict the loop this exists to catch. It also keeps a waiting
 * project free of a write per turn.
 */
export function denyRepeatCounted(deny: DenyRepeatInput): boolean {
  // Both spellings of an approval prompt, exactly as core/pipeline.ts's
  // stampDeny already treats it: the id names the prompt class, `askUser` is the
  // structural signal, and core/result.ts sets them together.
  if (deny.askUser) return false;
  return isEscalatableDenyId(deny.denyId);
}

/**
 * Count one refusal at the chokepoint and hand back the paragraph it earns.
 *
 * The signature is the deny's own RENDERED reason, byte for byte — the same
 * strictest-possible reading denySignature was built for, now reading the whole
 * message instead of the violation list one gate happened to assemble. That is
 * strictly MORE discriminating than the per-gate key it replaces (the violations
 * are inside the reason, and `denyTarget` carries the subject the reason may not
 * name), and it adds nothing COARSER: `gateId`/`denyId` are deliberately NOT in
 * the key, because both are coarser than the message and can only SPLIT counts
 * that identical text says are one loop. Identical text is also all the agent
 * can see, and whose loop this is measures.
 *
 * It did add one volatile thing, which the wording here used to deny outright:
 * the rendered prose interpolates runnable commands built from `pluginRoot()`.
 * That is folded out below rather than tolerated.
 *
 * MUST be called with the deny's reason BEFORE the pipeline stamps its suffixes
 * on it. The correlation ref carries a hook sequence number and a pid, so
 * signing a stamped reason would make every refusal unique and nothing would
 * ever reach 2 — and this function's own escalation is part of that same suffix
 * chain, so signing it would reset the count at exactly the attempt that
 * escalated.
 *
 * TWO inputs are folded out before signing, and the fold is the CLASS rather
 * than a list of members: an input that moves for reasons the agent did not
 * cause, arriving through the rendered prose instead of after it, the same
 * hazard as the stamped suffix. This install's own location is one
 * (withoutInstallLocation); a live wizard server's port and token are the other
 * (withoutWizardLink). See those two for the measurements, `signatureText` for
 * the composition, and __tests__/deny-signature-plugin-root.test.ts both for
 * the pins and for the scan that names a THIRD member if one appears.
 */
export function denyRepeat(
  cwd: string,
  runId: string | null | undefined,
  deny: DenyRepeatInput,
): DenyRepeat {
  if (!denyRepeatCounted(deny)) return UNTRACKED;
  const target = deny.denyTarget || '';
  // The TARGET is folded too. It is normally a project-relative path, but the
  // signature is `target::reason` and a gate refusing a path inside the plugin
  // tree (authoring-guard's population) would otherwise reintroduce through the
  // subject exactly what the reason no longer carries.
  const count = recordDenyRepeat(
    cwd,
    runId,
    denySignature(signatureText(target), [signatureText(deny.reason)]),
  );
  return { count, suffix: denyRepeatEscalation(count, target) };
}
