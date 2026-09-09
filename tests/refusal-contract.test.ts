// tests/refusal-contract.test.ts
// Structural contract test (see deny-id-completeness.test.ts for the idiom and
// the scanner conventions this file follows). ONE property, stated once:
//
//     A MUTATION THAT REFUSED MUST STILL BE ABLE TO SAY SO AT THE CALLER.
//
// Two ways this codebase has broken it, so two rules over one parse:
//
//   RULE 1  no call answering with a `MutationResult` may sit in a TRUTHINESS
//           position — the object is always truthy, so the refusal is erased by
//           the coercion. Enforced absolutely: zero sites, no baseline.
//
//   RULE 2  no function may hand back a value after discarding the boolean of a
//           refusal-carrying WRITE — the refusal is erased by the discard, and
//           the value the caller consumes was minted regardless.
//
//   RULE 3  no function may `return true` after calling a VOID writer that
//           itself dropped a refusal — the refusal died one frame down, where
//           rule 2 cannot see it, and the literal is this function inventing an
//           answer nobody could have given it.
//
//   RULE 4  no function may drop TWO writes to different paths — either can land
//           without the other, and the failure is not a missing artifact but two
//           artifacts on disk that disagree.
//
// Rules 2-4 are ratchets over pinned baselines with a written verdict per site;
// rule 1 is absolute.
//
// They are the same defect at two layers: the mutation reported "no" and the
// answer the caller reads cannot express it. They share this file because they
// share the resolver — which function is a mutation, and does THIS call reach
// one through the imports, re-exports, barrels, namespace objects and local
// rebindings between here and there — and because a second scanner would be a
// second thing to keep honest. They also share the parse: rules 2-4 cost 2-4s
// together, against ~34s for the ts.createProgram version of rule 1 alone.
//
// ── RULE 1: the defect it exists for ────────────────────────────────────────
// The run-state mutations in src/shared/state/run-agent/** are being converted
// from `boolean` to the three-valued `MutationResult` (applied /
// precondition-failed / unavailable) so a caller can tell "the answer is no"
// from "I could not find out". A `MutationResult` is an OBJECT, and an object is
// always truthy. A call site left holding `if (mutate(...))` or
// `mutate(...) ? a : b` after its callee is converted therefore reports EVERY
// outcome — a contended lock, a refused write, a lost CAS — as success. That is
// strictly worse than the boolean it replaced, and `tsc --noEmit` (this repo's
// only static check: no ESLint, no Biome) cannot see it, because a truthiness
// test on an object is legal TypeScript.
//
// It has already destroyed something once. `retireCodexRegistryEntryIfMatches`
// was converted while the stale-retire site in codex-liveness.ts kept its
// ternary, so every attempt answered `stale-retired` — the ONE status the reuse
// gate does not deny on. The gate was told a role was free while the live
// child's registry row sat unretired on disk, and it spawned a duplicate. The
// fixed site is codex-liveness.ts's `if (retired.outcome === 'applied')`, and
// the exact ternary it replaced is pinned as a fixture below
// (HISTORICAL_STALE_RETIRE_BUG), so this test's non-vacuity does not depend on
// anyone remembering to re-break the real file.
//
// ── Why a parse, and NOT a type checker ─────────────────────────────────────
// The obvious implementation is ts.createProgram + checker.getTypeAtLocation on
// every CallExpression. That was built and measured against this repo first:
//
//   type-aware  ts.createProgram over tsconfig.json    ~34s (11s program build)
//   parse-only  ts.createSourceFile over src/ + tests/  ~2.4s
//   AGREEMENT   both find the SAME 173 call sites, file:line for file:line
//
// Equal power at a fourteenth of the cost decides it, and two things break the
// tie further:
//   - tsconfig.json EXCLUDES src/runners/lighthouse/**, so a checker keyed on
//     the program is structurally blind to a directory of this repo. This
//     scanner walks the filesystem and reads every .ts/.tsx/.mts under src/ and
//     tests/.
//   - A checker's answers come from the same resolution `tsc` uses, so a
//     half-finished conversion — the exact window this guard exists for — is
//     also the window where an unresolved import can widen a call site to `any`
//     and drop it from the scan. That risk is argued, not measured; it is a
//     tie-breaker here, not the reason.
// The trade is that resolution is a BINDING question here, not a type question:
// the scanner learns which functions answer with a MutationResult by reading
// their declared return-type annotations, then follows imports/re-exports/
// barrels to decide whether a given call reaches one. The site-set agreement
// above is the evidence that this is not weaker in practice; the shape fixtures
// at the bottom are what keep it that way.
//
// ── What is a violation, and what is deliberately NOT ───────────────────────
// A violation is a MutationResult VALUE coerced to a boolean: an `if`/`while`/
// `do`/`for` condition, a ternary condition, `!x`, an `&&`/`||` operand that is
// actually tested, `Boolean(x)`, `assert(x)`/`assert.ok(x)`. Every one of those
// is decidable from the parse tree with no false positives across all 173 sites
// today.
//
// DISCARDING a MutationResult is NOT a violation and must not become one.
// codex-liveness.ts calls `retireCodexRegistryEntryIfMatches` and ignores the
// answer on the authoritative-role-model-mismatch path, and that is correct: the
// very next line returns `{ status: 'conflict' }`, so the deny fires whether or
// not the retire took. A blanket discard ban would fire on legitimate code,
// and a gate that cries wolf gets switched off. If a sharp discard rule is ever
// found, it belongs here as a separate assertion — not as a widening of this
// one. RULE 2 below is that rule, and it is deliberately narrower than "no
// discards".
//
// ── RULE 2: the refusal-blind publisher ─────────────────────────────────────
// `writeJson` and its five siblings in src/shared/fsjson.ts return `boolean`,
// where `false` means the write was REFUSED — an unanswered consent question, a
// planted symlink, a path escaping the state dir. Every one of those refusals is
// DURABLE: nothing about waiting or retrying changes the answer, which is why
// this half is a boolean and not a `MutationResult` (there is no `unavailable`
// to distinguish, and a third value would walk straight into rule 1).
//
// THAT LIST IS EXHAUSTIVE, AND THE OMISSION IS THE POINT. `act` (fsjson.ts
// :207-219) answers `false` for exactly two things: `guard === 'refused'`, and
// `ELOOP` — a path that became a symlink inside the check→open window, which is
// the same refusal the pre-open check makes, only made by the kernel. Every
// other errno is RETHROWN, deliberately: its comment says EACCES, ENOSPC and
// EISDIR are the caller's problem because swallowing them "would turn a full
// disk into a silent no-op".
//
// So a refused write and a failed write are DIFFERENT CHANNELS, and the one
// this file watches is not always the more dangerous. A thrown errno leaves the
// hook pipeline, which converts it into the non-overridable fail-closed
// `pipeline-handler-crashed` deny — louder than any boolean, and it stops the
// spawn outright. The measured case: under EACCES a claim row can land under a
// run id `.one.json` does not carry, which no boolean anywhere reports, and the
// throw catches it regardless.
//
// A BLIND verdict below therefore means blind to the DURABLE REFUSAL channel.
// It is not a claim that nothing anywhere would notice, and a verdict that does
// not say which channel it examined has not finished the analysis. Two live
// hazards follow from the distinction: a site can be blind on the boolean and
// covered on the throw, which downgrades it, and a site can consume the boolean
// perfectly while an errno unwinds it through a half-applied sequence, which
// this instrument cannot see at all.
//
// 319 calls reach one of those writers. 98 discard the boolean in statement
// position. Banning that outright is RULE 1 OF THE PROPOSAL AND IS NOT WHAT THIS
// DOES: 71 of the 98 sit in functions that return nothing, where the refusal
// has nowhere to be lost to and the caller was never told anything. An invariant
// firing 98 times to describe maybe twenty real ones is an invariant somebody
// switches off, and then it protects nothing at all.
//
// What is flagged is the subset where the discard becomes a LIE: a function that
// discards the boolean and then RETURNS A VALUE. Traffic One telling a role that
// something passed while Traffic One's own gate denies the run for that same
// artifact being missing — the producer certifies, the consumer refuses, and
// neither message mentions the other. 27 such writes in 22 publishers, of which
// 3 are exempt below.
//
// The 98 is a POSITION count, not a line-shape count, and that distinction is
// load-bearing: 6 of the discards are `if (cond) write(…)` on a single line and
// 40 sit inside a `try` block. Neither shape needs anything special here — the
// discard test asks what the call's parent statement is, not what the line looks
// like — but a grep anchored on `^\s*write` misses both, and the site that hid
// behind that anchor (`if (options.persist !== false) …` in
// architecture-contract/compile.ts) was the most clearly defective one in the
// set it was hiding from.
//
// The historical instance is pinned below as HISTORICAL_PUBLISH_CONTRACT_BUG:
// publishVerificationContract used to be `writeJson(path, contract); return
// contract;`, so every caller received a contract that claimed to be published
// whether or not anything reached disk. It now returns `VerificationContractV2 |
// null` and routes the boolean into it, and that fixed shape is pinned too.
//
// ── What rule 2 does NOT test, on purpose ───────────────────────────────────
// It does not ask whether the return type has somewhere to PUT a refusal, which
// is how the rule was first proposed ("a return type neither nullable nor
// boolean"). A channel that exists is not a channel that is used, and
// writeRunSettlement was the proof: it already returned `RunSettlementV2 | null`
// while `| null` was reached only from its `catch`, never from the write — it
// handed back the object it had built one line EARLIER, refused or not. (It has
// since been fixed to `if (!writeJson(…)) return;`, which is why it is not in
// the baseline; the argument is what survives.) The type clause would have
// exempted it, along with supersedeSkippedDelegationFallback (`boolean`,
// `return true` after an unchecked write) and eleven others.
// Whether the channel is used is decided by where the boolean went, and the
// boolean is exactly what this rule already followed. So the clause is dropped
// rather than widened: a flagged nullable publisher and a flagged non-nullable
// one have the same defect and differ only in how much work the FIX is.
//
// Nor does it try to decide whether a publisher VERIFIED its write some other
// way — several do, by re-reading the path and failing on what came back. Two
// syntactic proxies for that were built and measured against the real tree, and
// both mis-sorted known sites:
//   - "a read-family call after the write" exempted writeLegacyProjection, whose
//     post-write read is of a DIFFERENT file (maintenance.json) for unrelated
//     work.
//   - "a binding made after the write that gates a return or throw" exempted
//     qa-evidence/browser.ts, which is the report-never-on-disk site itself.
// A proxy that mis-sorts in both directions is worse than none, because it fails
// SILENTLY and only ever in the direction of passing.
//
// A THIRD proxy was proposed and this one is adopted, because it is not a proxy:
// exempt a read-back only when it COMPARES A HASH FIELD (hashComparedAfter
// below). See that function for why the compare is a proof rather than a guess,
// and for why the baseline is what makes an exemption safe to have at all. It
// sorts the three known sites correctly, and the split it produces is not
// cosmetic: of the eight publishers previously filed as "re-reads, so probably
// fine", three compare a hash and five do not — and the shape of those five is
// the shape that was a live bug in shared/host/capabilities.ts.
//
// ── RULE 4, and the class it does NOT cover ─────────────────────────────────
// The worst defects in this effort were not lost writes, they were two artifacts
// disagreeing: a refused settlement whose legacy projection still described it,
// a refused ledger whose settlement still pinned the debt it recorded. No return
// value is involved anywhere, so rules 1-3 are all structurally blind to them.
//
// Rule 4 catches the part of that class a parse CAN see: two dropped writes to
// two different paths in one function, where either can land without the other.
// run-settlement/projection.ts#writeLegacyProjection is the archetype — it drops
// run.json and then drops maintenance.json with the same `settlement.status` and
// `settlement.settlementHash` — and it is a `void` function, so nothing else
// here could ever have reached it.
//
// IT DOES NOT COVER THE GENERAL CLASS, and no parse-only walk can. The case
// worth naming: fencing only `maintenance.json` lets a ledger write vanish while
// the settlement lands, pinning a `fallback: {state:'pending'}` debt whose only
// possible discharge is a completion record IN THE FILE THAT WAS REFUSED — so
// the re-read finds nothing and the run is held at `validating` forever. A
// wedge, from one refused write, with no null anywhere. The derivation there is
// semantic and crosses modules: no shared identifier, no shared path expression,
// nothing a syntax tree contains. Widening rule 4 with a name-similarity or
// same-run-directory heuristic would produce a rule that fires on unrelated
// pairs and misses this one anyway.
//
// RULE 4 DOES NOT REUSE RULE 2'S EXEMPTION, and the reason is the sharpest
// thing in this file. Rule 2 asks "did MY write land", and a read-back compared
// against the candidate answers it. Rule 4 asks "do the two artifacts AGREE",
// and a per-write check does not answer that — it can pass on one half while
// the other half is stale or absent. So rule 4 exempts only a CROSS-ARTIFACT
// compare: both operands hash properties, which means the compare is relating
// two read-backs to each other rather than a read-back to a candidate.
//
// The two sites decide it between them, and they disagree in exactly the way
// that proves the predicates must differ:
//   compile.ts#ensureArchitectureRunSnapshot re-reads BOTH paths and asks
//     `persisted.baselineHash !== persistedBaseline.baselineHash` — the two
//     artifacts, against each other. Exempt from both rules.
//   run-bootstrap-policy#ensureRunBootstrap asks
//     `verified.envelopeHash !== envelopeHash`, where the right side is a local
//     computed BEFORE the writes. That proves the active envelope landed and
//     says nothing about the immutable one. Exempt from rule 2, flagged by rule
//     4 — correctly, and the reason is worth stating precisely because the
//     obvious reading of it is wrong: the immutable twin IS re-read, one frame
//     down inside `readActiveRunBootstrap`, which resolves nothing unless the
//     copy keyed by the active hash is present and agrees. A parse cannot see
//     that, must not follow the call to find it (following calls is how rule 2's
//     exemption would start clearing sites it has not read), and would be wrong
//     to treat it as an exemption anyway — see that row's verdict at rule 4's
//     baseline for what the coverage did and did not buy.
// Rule 2's predicate applied to rule 4 would have exempted the second, which is
// how this was tested rather than assumed.
//
// What the exemption does NOT mean: it does not make the pair atomic. A partial
// landing still leaves two artifacts on disk disagreeing; the throw does not
// undo the write that succeeded. What it removes is the SILENCE — rule 4 exists
// because a divergent pair has no return value, no null, and no complaint
// anywhere, and a compare that throws turns that into a loud failure at the
// moment it happens. Atomicity is the fsjson-layer change below, not this.
//
// What would catch it is not a scanner:
//   - a WRITE-SET transaction at the fsjson layer — a caller declares the paths
//     an update spans and the layer refuses the set atomically, so a partial
//     landing is unrepresentable rather than merely discouraged;
//   - failing that, a runtime assertion at the read side: a consumer that
//     resolves a cross-artifact reference (a settlement's fallback debt, a
//     projection's settlementHash) checks that the artifact it points at exists
//     and agrees, and reports the divergence instead of wedging on it;
//   - the reviewer question, which is the only thing available today: "if this
//     write is refused and the next one is not, what does the pair say?"
// The first is the real fix and it is a design change, not a test.
//
// ── THE SECOND GAP: a void function whose EFFECT escapes ────────────────────
// Rules 2, 3 and 4 all need a return-position claim to contradict. This class
// has none, and publishes anyway.
//
// A function belongs to it when all three hold:
//   1. its declared return type is `void` or `Promise<void>`, so there is no
//      success value to falsify;
//   2. its body discards a refusal-carrying write;
//   3. at least one effect ESCAPES THE CALL — it mutates something it does not
//      own (a parameter, a captured variable, module state) to a value that is
//      only true if the write landed; or it performs an irreversible or
//      create-once act ordered around the write; or it is a harness builder
//      handing back a world that is later asserted against.
//
// The claim still exists in every case. It travels by side channel — a mutated
// parameter, a filesystem act, a directory path — instead of through a return.
// That is exactly why nothing here reaches it, and why no rule was added: a
// detector needs escape analysis plus a catalogue of which callees are
// irreversible, and neither is a parse-only walk. Two exculpations would have
// to be honoured or such a rule would fire on correct code, and both are live
// in this tree: a caller that reads back what the CONSUMER reads and branches
// on it (strictly stronger than any boolean it could have checked), and a call
// whose effects are wholly local where the consumer has an explicit no-signal
// floor for the write's absence.
//
// The sharpest instance the class produced, and the one that shows the remedy
// is not reporting: session/triage-directive.ts#beginFreshMaintenanceRun
// settled the outgoing run's ledger and released its claims BEFORE the dropped
// write that would have installed the new run id. The harm was not a lost
// field. It was an outgoing run dismantled to justify a new one that was never
// recorded. No return value could have helped, because the damage was already
// done by the time there was anything to return. It reads correctly now: the
// write moved above the irreversible work and `if (!rotated) return rotated;`
// fences it, with a comment naming the create-once acts below as the reason.
// So the fix was ORDERING first — a boolean alone would not have saved it —
// and consuming the boolean second.
//
// ── THE THIRD GAP, NOW CLOSED: the second writer LAYER ──────────────────────
// Everything above learns its writers from src/shared/fsjson.ts. That was a
// blind spot of the same species as the two this effort has already closed —
// the never-overridable deny-id (a guard that ITERATED the list, so an id
// absent from it was never examined) and the `fsjson-writers` name pin
// (`writeState` stopped being a writer the day its body said `writeJsonDurable`
// instead of `writeJson`, dropping thirty call sites in silence). Each time,
// A CENSUS KEYED ON NAMES WAS BLIND TO THE SITE WRITTEN DIFFERENTLY.
//
// Here the site was written through a different LAYER. state/plugin-use.ts's
// write fence lives inside fsjson.ts, so the sanctioned way to opt out of it is
// to "reach past those helpers to raw `fs` and say so" — which
// shared/auth/machine-sidecar.ts and shared/one-settings.ts both legitimately
// do. The unintended consequence was that the opt-out from the FENCE was also
// an opt-out from the INSTRUMENT.
//
// Proven by execution before anything was designed: two functions in one real
// file, both discarding a boolean and returning a count, one through the
// sidecar layer and one through `writeJson`. The fsjson one was reported by
// name; the sidecar one was not mentioned, and the suite stayed 17/17 green.
// Both halves are pinned as a test below.
//
// The fix is a SHAPE, not a second roster — see rawFsRefusalWriterNames. A
// roster would be the same defect a fourth time, and it would also break the
// FSJSON_WRITERS/FSJSON_NON_WRITERS completeness test's premise if the names
// were folded into those lists (that test asserts the two lists equal fsjson's
// EXPORTED SURFACE, so a non-fsjson name in either is a straight failure).
// Seeding a separate resolver leaves that test untouched and load-bearing.
//
// ── WHAT MAKES A MODULE AN AUTHORITY, and how each one audits itself ────────
// There are two writer authorities now and a third can be added the same way,
// so the entry criterion is written down rather than inferred from the two that
// exist. A module is an authority when all three hold:
//   1. it MUTATES the filesystem itself, rather than delegating to a module
//      that already does — fsjson.ts and machine-sidecar.ts both call the
//      syscall; state/normalize.ts does not, and is a wrapper the fixpoint
//      already reaches;
//   2. its failure answer is DURABLE REFUSAL rather than contention or
//      absence — `false` (or a union member spelled `'refused'`) that means
//      THE WRITE DID NOT LAND, so a caller dropping it has dropped the only
//      report there was. A `null` meaning "someone else holds the lock" is not
//      this, and admitting one would fire on every lock acquirer in the tree;
//   3. the answer is produced in a frame that SYNCHRONOUSLY DOMINATES the
//      mutation, so the seed can be decided from the module's text. The frame
//      that mutates satisfies this trivially; so does a frame whose `try` calls
//      a MODULE-LOCAL function that mutates, because a direct call runs inside
//      the caller and its throw is the throw the caller's `catch` converts. A
//      callback handed to somebody else does NOT, and a parse cannot tell a
//      synchronously-invoked one from a stored one.
//      This clause used to read "the callee's own frame", and one-settings.ts
//      failed it on that reading and only on that reading. It no longer does —
//      see the DESCENT clause on rawFsRefusalWriterNames — so it is a third
//      authority with its own pin rather than the named gap it was.
// A module that meets 1-3 gets a seed (a name list if its writers are a fixed
// exported surface, a shape if they are not) plus a completeness pin below. A
// module that meets none of them is not a writer layer at all, and wiring one
// in is how these rules would start firing on correct code.
//
// EACH AUTHORITY AUDITS ITS OWN MODULE, and the three pins are not the same
// assertion because the seeds are not the same kind of thing:
//   fsjson.ts — a NAME seed, so the pin asks that FSJSON_WRITERS plus
//     FSJSON_NON_WRITERS equal the module's exported function surface. It
//     catches an unclassified primitive.
//   machine-sidecar.ts — a SHAPE seed, so there is no roster to compare
//     against and the pin asks the sharper question instead: every exported
//     function that PERFORMS A RAW-FS MUTATION must be admitted by the shape,
//     and every name excused as a non-writer must be parse-checkably free of
//     any raw-fs mutation. That second clause is what the fsjson pin cannot
//     have — a prose reason is only as good as its author — and it means the
//     exculpation list cannot be used to silence a writer the shape missed.
//   one-settings.ts — the same SHAPE seed, but its exculpation list cannot be
//     "mutates nothing", because two of its exports DO mutate and are still
//     correct: `updateOneSettings` and `writeOneSection` answer with a path and
//     report failure by THROWING. That is the errno channel this file
//     deliberately leaves open (see the rethrow row in SHAPE_CASES_RAW_FS) and
//     there is no boolean for a caller to drop. So the excuse it checks is
//     "this frame CATCHES NOTHING", which is a parse-checkable proof that the
//     failure escapes rather than a sentence about intent.
// All three fail in the direction that matters: a writer nobody classified does
// not go quiet, it fails by name.
//
// ── TWO HOLES IN THE COLLECTOR, ONE CLOSED AND ONE PINNED ───────────────────
// The fsjson pin collected only `ts.isFunctionDeclaration`, so `export const
// writeJsonAtomic = (…): boolean => …` was exported, was a writer, and was in
// neither list — a hole in the one guard whose entire value is completeness.
// It is closed: the collector now also reads an exported `const` bound to an
// arrow, a function expression, or a function TYPE. Nothing in fsjson.ts is
// spelled that way today, so the lists did not move, and the new arm is held
// by a fixture rather than by a live instance.
//
// Closing it surfaced the OTHER shape an exported const can take, and this one
// is live. `export const fsjson: FsJson = { readText, readJson, writeJson }`
// (fsjson.ts:530) re-exports a real writer as an object MEMBER, and rules 2-4
// key a call on a bare `ts.Identifier` callee — so `x.writeJson(…)` resolves to
// nothing at all. Measured before deciding what to do about it: across src/ +
// tests/ there are ZERO member calls whose member name is any of the eight
// fsjson writers, and the object's only importer is core/context.ts, which
// feeds it to `Ctx`; the single member call through it anywhere is
// `ctx.fsjson.readJson(…)` at core/pipeline.ts:121, a READ.
//
// So the hole is real and empty, and it is pinned at empty rather than closed
// by resolution. Closing it properly means answering "what type is `ctx`",
// which is the type question this whole file is built to avoid — and the
// heuristic alternative ("any `.writeJson(…)` is a write") would fire on any
// future object that happens to expose a method by that name, which is the
// third rejected proxy wearing a hat. The pin costs one whole-tree walk over
// the files that mention the const, fires the moment the first such call is
// written, and names the call site. Its false-positive surface is a base
// expression spelled exactly `fsjson` or `….fsjson` that is NOT this object;
// there is none today and one would be a deliberately confusing name.
//
// ── LIMIT 3, and it is declared rather than half-built ──────────────────────
// The new layer feeds rules 2 and 3. RULE 4 DOES NOT SEE IT, because rule 4
// keys a destination on `arguments[0]` — exact for all eight fsjson writers,
// every one of which takes the path first, and false for a raw-fs writer whose
// destination is a constant in its own module. Measured: feeding the raw-fs
// layer to rule 4 reported 7 divergent pairs in updates-store.test.ts alone,
// all of them consecutive writes to THE SAME FILE. A genuine two-artifact
// divergence written through raw `fs` is therefore NOT reported, and that is a
// named gap on the same footing as the two above it.
//
// The shape itself is narrow on purpose and its cost is counted: 22 functions
// match, and 38 more perform a raw-fs mutation while reporting failure through
// some other value (`null`, `0`, `''`, a string union, a result object). Those
// are not admitted, because widening to "the catch returns anything falsy"
// pulls in every lock acquirer in the tree, whose `null` means CONTENTION and
// is legitimately discarded at many call sites. shared/one-settings.ts's
// `writeOneSection` is outside it for a different reason and stays outside: it
// answers with a PATH and reports failure by throwing, so it has no refusal
// boolean at all — the frames-below-the-boolean reading this paragraph used to
// give was wrong about it, and right only about `deleteOneSection`, which the
// descent clause now admits.
//
// ── COVERAGE EXPANSION, COUNTED BEFORE IT LANDED ────────────────────────────
// The property below applies to this change as much as to a void conversion,
// so the blast radius was measured on a copy first: 4 new rule-2 publishers,
// 0 new rule-3, 0 new rule-4, and no baseline entry stopped firing. All four
// are pre-existing, none newly broken, and each is pinned with a verdict in the
// ADMITTED BY THE RAW-FS SHAPE section. The writes denominator moved 319 -> 489
// and the discards 98 -> 131, which is why the raw-fs half now carries its own
// floor instead of hiding inside the global one.
//
// ── SEQUENCING THE REMAINING CONVERSIONS ────────────────────────────────────
// One property governs how the rest of this work should be ordered, and it is
// not obvious in the direction people assume: turning a `void` writer into a
// forwarding writer is COVERAGE-EXPANDING, NOT NEUTRAL, and its blast radius is
// exactly the callee's caller set. The moment the callee starts answering,
// every caller that drops the answer becomes visible to rule 2.
//
// Measured three times, and the third is the reason this paragraph exists.
// A rotation conversion exposed two callers, both already guarded, and the
// ratchet stayed green. `materializeIfNeeded` exposed one (a nine-caller
// estimate collapsed to one once the fixture builders were funnelled through a
// single void helper). `writeState` exposed FIFTEEN, all of them pre-existing
// and none of them newly broken; they were pinned with verdicts, then fixed by
// the lane that owned them, and survive here as the prose note in the baseline.
//
// The consequence for planning: a lane that converts a writer without fixing
// the callers it thereby exposes turns this ratchet red in files it may not
// own. Count the caller set before converting, not after. This matters now
// rather than later, because widening `MutationResult` across the rest of
// shared/state/** is this operation at scale.
//
// RULE 4 HAS THE SAME PROPERTY FROM THE OTHER DIRECTION, and it is about to be
// hit repeatedly. Adding a SECOND fenced write to a function that already drops
// one crosses this rule's threshold — the pair is what it counts, not the
// individual drop — so a fix can turn the ratchet red in the file it is fixing.
// The shape doing it is the one state/normalize.ts established and the
// fsjson-triage lanes are copying: preserve the unparseable bytes beside a file
// before replacing it. That quarantine IS a fenced write, and beside an existing
// dropped write it is a new divergent pair.
//
// Measured, not predicted: run-settlement/projection.ts#writeLegacyProjection —
// this rule's own archetype, fixed and removed from the baseline below — gained a
// `writeTextFile` quarantine for a corrupt `run.json`. With the quarantine's
// boolean DROPPED, the function reappeared here by name as a new entry, the
// archetype returning through a fix. With it CONSUMED (`if (corrupt &&
// !writeTextFile(…)) return;`) the ratchet stays green, and the two are not a
// choice: a base we could not preserve must not be replaced, so the boolean has
// somewhere real to go. Consume the preservation write, and rule 4 stays a report
// about divergence rather than about repairs in progress.

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';
import * as ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const TESTS_ROOT = path.join(REPO_ROOT, 'tests');
/** The interface every converted mutation answers with. */
const RESULT_TYPE = 'MutationResult';

// The file set the scanner reads. The fixtures below overlay synthetic files on
// the real tree, so a fixture still resolves the REAL
// src/shared/state/run-agent/mutation-result.ts and proves the resolver reaches
// it. Caches hang off the tree, not off the module, so a fixture run can never
// poison the whole-repo run (or the reverse).
interface SourceTree {
  read(absPath: string): string | null;
  parse(absPath: string): ts.SourceFile | null;
}

function sourceTree(overrides: Readonly<Record<string, string>> = {}): SourceTree {
  const text = new Map<string, string | null>();
  const ast = new Map<string, ts.SourceFile | null>();
  const tree: SourceTree = {
    read(absPath: string): string | null {
      const override = overrides[absPath];
      if (override !== undefined) return override;
      if (!text.has(absPath)) {
        let content: string | null = null;
        try {
          content = fs.statSync(absPath).isFile() ? fs.readFileSync(absPath, 'utf8') : null;
        } catch {
          content = null; // does not exist / not readable — an unresolvable specifier
        }
        text.set(absPath, content);
      }
      return text.get(absPath) ?? null;
    },
    parse(absPath: string): ts.SourceFile | null {
      if (!ast.has(absPath)) {
        const content = tree.read(absPath);
        // setParentNodes: true — the truthiness test walks UPWARDS from a call to
        // ask what its parent does with the value. .tsx needs ScriptKind.TSX or
        // every JSX element is a parse error and the statements after it are
        // lost, which is how a whole file could hold violations and yield none.
        ast.set(absPath, content === null ? null : ts.createSourceFile(
          absPath,
          content,
          ts.ScriptTarget.Latest,
          true,
          absPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        ));
      }
      return ast.get(absPath) ?? null;
    },
  };
  return tree;
}

// Resolve a relative import specifier to a file the tree can read. Only relative
// specifiers can name a module in this repo, so a bare package specifier ends
// the walk immediately. Handles `./x` → `./x.ts`, the ESM-style `./x.js` →
// `./x.ts`, and `./dir` → `./dir/index.ts` (barrel) spellings.
function resolveSpecifier(tree: SourceTree, fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.endsWith('.ts') || base.endsWith('.tsx') ? base : `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    base.replace(/\.[cm]?jsx?$/, '.ts'),
    base.replace(/\.[cm]?jsx?$/, '.mts'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const candidate of candidates) {
    if (tree.read(candidate) !== null) return candidate;
  }
  return null;
}

function moduleSpecifierText(node: { moduleSpecifier?: ts.Expression }): string | null {
  const specifier = node.moduleSpecifier;
  return specifier && ts.isStringLiteral(specifier) ? specifier.text : null;
}

// ── reading return-type annotations ─────────────────────────────────────────
// Every mutation converted so far declares its return type explicitly, so "does
// this function answer with a MutationResult?" is a question about the
// annotation. Type ARGUMENTS are searched too, so a future `Promise<
// MutationResult<T>>` or `Readonly<MutationResult<T>>` is recognised rather
// than silently dropped.
function isResultType(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName)
      ? node.typeName.text
      : (ts.isQualifiedName(node.typeName) ? node.typeName.right.text : '');
    if (name === RESULT_TYPE) return true;
    return (node.typeArguments ?? []).some(isResultType);
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.some(isResultType);
  if (ts.isParenthesizedTypeNode(node)) return isResultType(node.type);
  return false;
}

/** A TYPE that is "a function answering with a MutationResult" — `() => MutationResult<T>`. */
function isResultFnType(node: ts.TypeNode | undefined): boolean {
  if (!node) return false;
  if (ts.isFunctionTypeNode(node)) return isResultType(node.type);
  if (ts.isParenthesizedTypeNode(node)) return isResultFnType(node.type);
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) return node.types.some(isResultFnType);
  if (ts.isTypeLiteralNode(node)) {
    return node.members.some((member) => ts.isCallSignatureDeclaration(member) && isResultType(member.type));
  }
  return false;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

/**
 * Shared by both resolvers, because "is this function a thin wrapper for one
 * of those" is one question asked about two sets of callees.
 *
 * Two shapes count. `return f(…)` is the obvious one. The second is
 * `let ok = false; lock(() => { ok = f(…) }); return ok;` — the same forward,
 * spelled through a local because the call happens inside a lock callback.
 *
 * That second shape earns its place from one function.
 * shared/state/normalize.ts#writeState is written exactly that way; ~30
 * modules call it; and when it stopped being `void` and started answering
 * `boolean`, its callers did not become guarded — they became INVISIBLE. They
 * left rule 3 (the callee reports for itself now) without entering rule 2 (the
 * callee was not recognised as a writer, so discarding its answer looked like
 * discarding nothing). A fix that silently narrows the instrument is the exact
 * thing this file exists to make impossible, so the resolver follows the
 * shape rather than waiting to be told about the next one.
 *
 * Assignments are collected THROUGH nested functions, since that is the entire
 * point. Returns are not: a callback's `return` belongs to the callback.
 */
function bodyForwards(fn: FunctionLike, known: ReadonlySet<string>): boolean {
  const isKnownCall = (expression: ts.Expression | undefined): boolean => {
    if (!expression) return false;
    const value = unwrapExpression(expression);
    if (!ts.isCallExpression(value)) return false;
    const callee = unwrapExpression(value.expression);
    return ts.isIdentifier(callee) && known.has(callee.text);
  };
  if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) return isKnownCall(fn.body);
  if (!fn.body) return false;

  let forwards = false;
  const returned = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) {
      if (isKnownCall(node.expression)) forwards = true;
      if (node.expression) {
        const value = unwrapExpression(node.expression);
        if (ts.isIdentifier(value)) returned.add(value.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (forwards || returned.size === 0) return forwards;

  const assignedFromCall = new Set<string>();
  const scanAssignments = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)
      && isKnownCall(node.right)) {
      assignedFromCall.add(node.left.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isKnownCall(node.initializer)) {
      assignedFromCall.add(node.name.text);
    }
    ts.forEachChild(node, scanAssignments);
  };
  scanAssignments(fn.body);
  return [...returned].some((name) => assignedFromCall.has(name));
}

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

// Strip the wrappers that change nothing about which value an expression is.
function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current) || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression(current)) {
      current = current.expression;
      continue;
    }
    // `(0, mutate)` — the comma operator's value is its LAST operand.
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      current = current.right;
      continue;
    }
    return current;
  }
}

// ── the scanner ─────────────────────────────────────────────────────────────
// One closure per tree so every cache is scoped to that tree.

interface Site {
  readonly relFile: string;
  readonly line: number;
  readonly text: string;
}

interface Violation extends Site {
  /** Which coercion — named in the failure message so the author sees the rule. */
  readonly position: string;
}

interface ScanResult {
  /** Every call reaching a MutationResult-returning function. The non-vacuity denominator. */
  readonly calls: readonly Site[];
  readonly violations: readonly Violation[];
}

function scanner(tree: SourceTree) {
  const declaredCache = new Map<string, ReadonlySet<string>>();
  const memberCache = new Map<string, ReadonlySet<string>>();
  const exportsCache = new Map<string, boolean>();

  // Does the body of `fn` hand back a call to something already known to answer
  // with a MutationResult? This is the one place inference is re-derived rather
  // than read off an annotation, and it is what makes an ordinary
  // extract-a-wrapper refactor (`const annotate = (x) => annotateClaimRoleSourceResult(…)`)
  // stay visible. Nested functions are not read: their returns are theirs.
  function bodyForwardsResult(fn: FunctionLike, known: ReadonlySet<string>): boolean {
    return bodyForwards(fn, known);
  }


  /** Names `file` DECLARES as MutationResult-returning, run to a fixpoint over the file. */
  function declaredNames(file: string): ReadonlySet<string> {
    const cached = declaredCache.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    declaredCache.set(file, names); // seed before recursing: a self-import must terminate
    const source = tree.parse(file);
    if (!source) return names;
    for (let pass = 0; pass < 8; pass += 1) {
      const before = names.size;
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name
          && (isResultType(node.type) || bodyForwardsResult(node, names))) {
          names.add(node.name.text);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
          const initializer = node.initializer;
          if (initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
            && (isResultType(initializer.type) || bodyForwardsResult(initializer, names))) {
            names.add(node.name.text);
          }
          if (isResultFnType(node.type)) names.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (names.size === before) break; // a pass that adds nothing ends the walk
    }
    return names;
  }

  // Member names `file` declares as MutationResult-returning function-typed
  // properties (`interface Row { invoke: (cwd: string) => MutationResult<T> }`).
  // Whether `row` is a `Row` is a TYPE question a parse cannot answer, so the
  // member name is honoured only inside the file that DECLARES it — a file that
  // writes such an interface is a file that deals in mutation results.
  function resultMemberNames(file: string): ReadonlySet<string> {
    const cached = memberCache.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    memberCache.set(file, names);
    const source = tree.parse(file);
    if (!source) return names;
    const visit = (node: ts.Node): void => {
      const named = (name: ts.PropertyName | undefined): string => (
        name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : ''
      );
      if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) && isResultFnType(node.type)) {
        const name = named(node.name);
        if (name) names.add(name);
      }
      if (ts.isMethodSignature(node) && isResultType(node.type)) {
        const name = named(node.name);
        if (name) names.add(name);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  }

  // Does `file` export `name`, and is that export (transitively) a
  // MutationResult-returning function? Covers `export { x } from '…'`,
  // `export { x as y } from '…'`, `export * from '…'` (barrel), and a bare
  // `export { x }` re-exporting an imported binding — the shapes that stand
  // between src/modules/** and src/shared/state/run-agent/**, which is four
  // barrels deep.
  function exportsResultFn(file: string, name: string, seen: Set<string> = new Set()): boolean {
    const key = `${file}#${name}`;
    const cached = exportsCache.get(key);
    if (cached !== undefined) return cached;
    if (seen.has(key)) return false; // import cycle — stop rather than recurse forever
    seen.add(key);
    const source = tree.parse(file);
    if (!source) return false;
    let answer = declaredNames(file).has(name);

    if (!answer) {
      // Local name → (module, original name), so a bare `export { x }` can be
      // followed back to whatever the file imported under that name.
      const importedFrom = new Map<string, { file: string; name: string }>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = moduleSpecifierText(statement);
        const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
        const bindings = statement.importClause?.namedBindings;
        if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          importedFrom.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
        }
      }
      for (const statement of source.statements) {
        if (answer) break;
        if (!ts.isExportDeclaration(statement)) continue;
        const specifier = moduleSpecifierText(statement);
        const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
        if (!statement.exportClause) { // `export * from '…'` — a barrel
          if (target && exportsResultFn(target, name, seen)) answer = true;
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue;
          const original = (element.propertyName ?? element.name).text;
          if (target) {
            if (exportsResultFn(target, original, seen)) { answer = true; break; }
            continue;
          }
          const local = importedFrom.get(original);
          if (local && exportsResultFn(local.file, local.name, seen)) { answer = true; break; }
        }
      }
    }
    exportsCache.set(key, answer);
    return answer;
  }

  /** Does `file` export `name` as a NAMESPACE (`export * as store from '…'`)? */
  function exportsNamespace(file: string, name: string, seen: Set<string> = new Set()): string | null {
    const key = `${file}#*#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const source = tree.parse(file);
    if (!source) return null;
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
      if (!target) continue;
      const clause = statement.exportClause;
      if (clause && ts.isNamespaceExport(clause)) {
        if (clause.name.text === name) return target;
        continue;
      }
      if (!clause) {
        const nested = exportsNamespace(target, name, seen);
        if (nested) return nested;
      }
    }
    return null;
  }

  interface Bindings {
    /** Local identifiers that ARE a MutationResult-returning function. */
    readonly direct: Set<string>;
    /** Local identifier → the module whose exports its members resolve against. */
    readonly namespaces: Map<string, string>;
    /** Member names this file declared as MutationResult-returning properties. */
    readonly members: ReadonlySet<string>;
  }

  function fileBindings(file: string, source: ts.SourceFile): Bindings {
    const direct = new Set<string>(declaredNames(file));
    const namespaces = new Map<string, string>();

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
      if (!target) continue;
      if (ts.isNamespaceImport(bindings)) { // import * as store from '…'
        namespaces.set(bindings.name.text, target);
        continue;
      }
      for (const element of bindings.elements) {
        // `{ x }` → propertyName undefined, name 'x';
        // `{ x as y }` → propertyName 'x', name 'y'.
        const original = (element.propertyName ?? element.name).text;
        if (exportsResultFn(target, original)) {
          direct.add(element.name.text);
          continue;
        }
        const nested = exportsNamespace(target, original);
        if (nested) namespaces.set(element.name.text, nested);
      }
    }

    // require/dynamic-import destructuring can appear anywhere, including inside
    // a function body, so this half walks the whole tree.
    const visitRequire = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const expression = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
        const argument = ts.isCallExpression(expression) ? expression.arguments[0] : undefined;
        const isRequire = ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
          && expression.expression.text === 'require';
        const isDynamicImport = ts.isCallExpression(expression)
          && expression.expression.kind === ts.SyntaxKind.ImportKeyword;
        const target = (isRequire || isDynamicImport) && argument && ts.isStringLiteral(argument)
          ? resolveSpecifier(tree, file, argument.text)
          : null;
        if (target) {
          if (ts.isIdentifier(node.name)) {
            namespaces.set(node.name.text, target);
          } else if (ts.isObjectBindingPattern(node.name)) {
            for (const element of node.name.elements) {
              const original = element.propertyName && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : (ts.isIdentifier(element.name) ? element.name.text : '');
              if (original && ts.isIdentifier(element.name) && exportsResultFn(target, original)) {
                direct.add(element.name.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visitRequire);
    };
    visitRequire(source);

    // How a mutation is IMPORTED is resolved above; how it is BOUND locally
    // afterwards is resolved here. `const retire = retireCodexRegistryEntryIfMatches;`
    // is what an ordinary extract-a-helper refactor produces, and without this
    // every call site in the file would vanish while the file itself stayed
    // "scanned". Run to a fixpoint because a rebinding can chain and can be
    // declared after its use in source order.
    for (let pass = 0; pass < 16; pass += 1) {
      const before = direct.size;
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const value = unwrapExpression(node.initializer);
          if (ts.isIdentifier(value) && direct.has(value.text)) direct.add(node.name.text);
          if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression)) {
            const target = namespaces.get(value.expression.text);
            if (target && exportsResultFn(target, value.name.text)) direct.add(node.name.text);
          }
          if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
            if (bodyForwardsResult(value, direct)) direct.add(node.name.text);
          }
        }
        // `let retire; … retire = retireCodexRegistryEntryIfMatches;`
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(node.left)) {
          const value = unwrapExpression(node.right);
          if (ts.isIdentifier(value) && direct.has(value.text)) direct.add(node.left.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (direct.size === before) break;
    }

    return { direct, namespaces, members: resultMemberNames(file) };
  }

  // Is this expression's VALUE coerced to a boolean by whatever encloses it?
  // Named rather than boolean so the failure message can quote the rule.
  function truthinessPosition(node: ts.Node): string | null {
    const parent = node.parent;
    if (!parent) return null;
    if (ts.isParenthesizedExpression(parent)) return truthinessPosition(parent);
    if (ts.isIfStatement(parent) && parent.expression === node) return 'an `if` condition';
    if (ts.isWhileStatement(parent) && parent.expression === node) return 'a `while` condition';
    if (ts.isDoStatement(parent) && parent.expression === node) return 'a `do…while` condition';
    if (ts.isForStatement(parent) && parent.condition === node) return 'a `for` condition';
    if (ts.isConditionalExpression(parent) && parent.condition === node) return 'a ternary condition';
    if (ts.isPrefixUnaryExpression(parent) && parent.operator === ts.SyntaxKind.ExclamationToken) {
      return 'the operand of `!`';
    }
    if (ts.isBinaryExpression(parent)) {
      const operator = parent.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
        const spelling = operator === ts.SyntaxKind.AmpersandAmpersandToken ? '`&&`' : '`||`';
        // The LEFT operand is always tested. The RIGHT operand BECOMES the value
        // of the expression, so it is tested only if the whole expression is —
        // which is why `cond && mutate()` as a statement is a discard, not a
        // violation.
        if (parent.left === node) return `the left operand of ${spelling}`;
        const outer = truthinessPosition(parent);
        return outer ? `the right operand of ${spelling} in ${outer}` : null;
      }
    }
    if (ts.isCallExpression(parent) && parent.arguments[0] === node) {
      const callee = parent.expression;
      if (ts.isIdentifier(callee) && callee.text === 'Boolean') return 'a `Boolean(…)` coercion';
      // A MutationResult handed to assert() is an object, so the assertion holds
      // no matter what happened — a vacuous test, the same defect wearing a
      // different hat.
      if (ts.isIdentifier(callee) && callee.text === 'assert') return 'an `assert(…)` argument';
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'ok'
        && ts.isIdentifier(callee.expression) && callee.expression.text === 'assert') {
        return 'an `assert.ok(…)` argument';
      }
    }
    return null;
  }

  function scanFile(absFile: string): ScanResult {
    const source = tree.parse(absFile);
    if (!source) return { calls: [], violations: [] };
    const bindings = fileBindings(absFile, source);
    // Cheap bail, and it must not become a blind spot: a file can hold a
    // mutation without importing one, by taking a `() => MutationResult<T>`
    // CALLBACK (every lock helper does) or by declaring a result-typed member.
    // Both require the literal `MutationResult` in the text — nothing else the
    // scanner recognises does — so the text check is exactly as wide as the
    // detection below, and no wider.
    const mentionsResultType = (tree.read(absFile) ?? '').includes(RESULT_TYPE);
    if (!mentionsResultType && bindings.direct.size === 0 && bindings.namespaces.size === 0) {
      return { calls: [], violations: [] };
    }
    const relFile = path.relative(REPO_ROOT, absFile);
    const calls: Site[] = [];
    const violations: Violation[] = [];
    const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const quote = (node: ts.Node): string => node.getText(source).split('\n')[0]!.trim().slice(0, 100);

    // A parameter typed `() => MutationResult<T>` is a mutation for the length of
    // the function that declares it, and NOT beyond — the lock helpers all take
    // one, and a file-wide binding for a name as generic as `mutate` would be a
    // false positive waiting to happen. Locals initialized from a mutation call
    // are scoped the same way, so `const retired = retire(…); if (retired)` — one
    // refactor away from the historical bug and just as silent — is caught
    // without a same-name local elsewhere in the file being mistaken for one.
    const scopes: Array<{ params: Set<string>; locals: Set<string> }> = [
      { params: new Set(), locals: new Set() },
    ];
    const inScope = (name: string): boolean => (
      bindings.direct.has(name) || scopes.some((scope) => scope.params.has(name))
    );
    const isResultLocal = (name: string): boolean => scopes.some((scope) => scope.locals.has(name));

    const isResultCall = (node: ts.CallExpression): boolean => {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee)) return inScope(callee.text);
      if (ts.isPropertyAccessExpression(callee)) {
        if (ts.isIdentifier(callee.expression)) {
          const target = bindings.namespaces.get(callee.expression.text);
          if (target) return exportsResultFn(target, callee.name.text);
        }
        return bindings.members.has(callee.name.text);
      }
      if (ts.isElementAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const target = bindings.namespaces.get(callee.expression.text);
        const argument = callee.argumentExpression;
        if (target && ts.isStringLiteralLike(argument)) return exportsResultFn(target, argument.text);
      }
      return false;
    };

    const visit = (node: ts.Node): void => {
      const opensScope = isFunctionLike(node);
      if (opensScope) {
        const params = new Set<string>();
        for (const parameter of node.parameters) {
          if (ts.isIdentifier(parameter.name) && isResultFnType(parameter.type)) params.add(parameter.name.text);
        }
        scopes.push({ params, locals: new Set() });
      }

      if (ts.isCallExpression(node) && isResultCall(node)) {
        calls.push({ relFile, line: at(node), text: quote(node) });
        const position = truthinessPosition(node);
        if (position) violations.push({ relFile, line: at(node), text: quote(node), position });
        // `const retired = retire(…)` / `retired = retire(…)` — remember the name.
        const parent = node.parent;
        const here = scopes[scopes.length - 1]!;
        if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)
          && parent.initializer && unwrapExpression(parent.initializer) === node) {
          here.locals.add(parent.name.text);
        }
        if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && ts.isIdentifier(parent.left) && unwrapExpression(parent.right) === node) {
          here.locals.add(parent.left.text);
        }
      } else if (ts.isIdentifier(node) && isResultLocal(node.text)) {
        const position = truthinessPosition(node);
        if (position) {
          violations.push({
            relFile,
            line: at(node),
            text: `${node.text} (a MutationResult held in a local)`,
            position,
          });
        }
      }

      ts.forEachChild(node, visit);
      if (opensScope) scopes.pop();
    };
    visit(source);
    return { calls, violations };
  }

  return { scanFile };
}

// ── rule 2's scanner ────────────────────────────────────────────────────────
// Same tree, same resolver shapes, different subject: rule 1 learns its
// functions from a return-TYPE annotation, rule 2 from a fixed set of names in a
// fixed module, then grows that set through local forwarding wrappers the same
// way rule 1 does (materialize/render-agents.ts calls `writeTextIfChanged`, and
// tests/replay-corpus/fixtures.ts calls `writeModelChoice`; neither names a
// writer, and both are found through the wrapper they forward to).

const FSJSON_MODULE = path.join(SRC_ROOT, 'shared', 'fsjson.ts');

/**
 * The mutation primitives whose `false` means REFUSED. Pinned by name, like the
 * deny-id scanner pins its origin module, because "returns boolean" is far too
 * wide a net and the refusal semantics are what makes these special.
 *
 * `createJsonExclusive` is here despite answering with a string union: one of
 * its three values IS `'refused'`, so dropping its answer drops a refusal.
 * `stateWritePermitted` and `projectStateWritable` are NOT: they are questions,
 * they mutate nothing, and discarding an answer to a question is not this bug.
 *
 * `writeJsonSet` is here for the ordinary reason — its `false` means the set was
 * REFUSED — but it is invisible to RULE 4 rather than merely uncovered by it,
 * and that is by construction rather than a gap. Rule 4 keys a destination on
 * `arguments[0]`, which for this writer is the whole SET; two members of one
 * call are one call, so a pair can never form. That is the correct answer:
 * refusing the set atomically is precisely what makes the two artifacts unable
 * to disagree, so a rule about divergent pairs has nothing left to report. What
 * it does NOT mean is that the pair became crash-atomic — see the bound on the
 * function itself, which commits N paths with N renames and says so.
 */
const FSJSON_WRITERS: readonly string[] = [
  'appendTextFile',
  // `appendTextFile`'s durable sibling. It is here for the same reason and not
  // for a durability-specific one: its `false` means the append was REFUSED
  // (consent fence, planted symlink, a path escaping the state dir), exactly
  // like its non-durable sibling's, and a caller that discards it has certified
  // a ledger line that is not on disk. The docblock above records what a MISSING
  // row costs — `writeJsonDurable`'s arrival silently dropped thirty call sites
  // from the scanner — so a durable writer added without one is the same defect
  // a second time.
  'appendTextFileDurable',
  'createJsonExclusive',
  'ensureDir',
  'movePath',
  'removePath',
  'writeJson',
  'writeJsonDurable',
  'writeJsonSet',
  'writeTextFile',
];

/**
 * Every other function fsjson.ts exports, with the reason it carries no refusal.
 * Pinned so the two lists TOGETHER account for the module's whole exported
 * surface — see the completeness test at the bottom of this file.
 *
 * Without that test the name-pinning above fails SILENTLY and in the worst
 * direction. `writeJsonDurable` arrived and `writeState` stopped being
 * recognised as a writer, because a wrapper is found by the writer name its
 * body mentions: the discard count fell 98 -> 73 and thirty call sites left the
 * scanner's view. Only the `> 80` floor caught it, and only because that
 * wrapper happened to have thirty callers — a writer wrapped by a function with
 * five would have shrunk the denominator quietly and stayed green.
 */
const FSJSON_NON_WRITERS: readonly string[] = [
  'parseJson',            // pure
  'projectStateWritable', // a question; mutates nothing
  'readJson',             // read
  'readJsonResult',       // read
  'readText',             // read
  'stateWritePermitted',  // a question; mutates nothing
];

// ── the SECOND writer layer: sanctioned raw-`fs` writers ────────────────────
// state/plugin-use.ts's write fence is addressed by path and enforced inside
// shared/fsjson.ts, so "a writer that wants to bypass it has to reach past
// those helpers to raw `fs` and say so". That opt-out is documented and
// legitimate — shared/one-settings.ts and shared/auth/machine-sidecar.ts both
// take it, because for a session rooted at $HOME the machine dir IS that
// "project's" state dir and a guarded write there deadlocks on the consent
// question. What was NOT intended is that the same opt-out also leaves the
// instrument, which learned its writer set by NAME from fsjson.ts and so could
// not see a refusal that never passed through it.
//
// Measured, not argued. Two functions were put in ONE file, both discarding a
// boolean and then returning a count — one through `recordUpdatesPage` (the
// sidecar layer) and one through `writeJson`. The fsjson one was reported by
// name; the sidecar one was not mentioned at all. Same defect, same shape, same
// file, and the only difference was which layer the write went through.
//
// The fix is keyed on SHAPE rather than on another name list, because a name
// list is the thing that failed: `FSJSON_WRITERS` went blind the day `writeState`
// forwarded to `writeJsonDurable` instead of `writeJson`, and a
// `SANCTIONED_RAW_FS_WRITERS` roster would go blind the day someone adds a
// second sidecar writer and forgets the roster. A shape cannot be forgotten.
//
// A shape CAN be outgrown, though, which is what the completeness pins below
// are for — see WHAT MAKES A MODULE AN AUTHORITY.
//
// THE SHAPE, and it is deliberately one shape and not a family:
//
//     try { …raw fs mutation…; return true } catch { …; return false }
//
// That is a function whose `false` can only mean THE WRITE DID NOT LAND, which
// is the same contract fsjson.ts's writers carry, established by the code
// rather than by a list. writeMachineSidecar is written exactly this way.
//
// Once a base case is recognised the EXISTING machinery does the rest: the
// forwarding-wrapper fixpoint carries it through `writeStore` to
// `recordUpdatesPage` / `markUpdatesShown` / `clearUpdatesStore` with no new
// resolution code, which is the whole reason this is a seed and not a rule.
//
// ── the channel, and why this one is STRONGER than fsjson's ─────────────────
// fsjson's `act` answers false for exactly `refused` and ELOOP and RETHROWS
// every other errno, on purpose, so EACCES on a state write still unwinds into
// the fail-closed `pipeline-handler-crashed` deny. A `catch { return false }`
// has no such second channel: it collapses refusal AND every errno into one
// boolean. So for a raw-fs writer the boolean is not the weaker of two signals
// the way it is for fsjson — it is the ONLY signal, and a caller that drops it
// has dropped everything. The distinction at the top of this file still holds,
// it just runs the other way here.
const RAW_FS_MUTATORS: ReadonlySet<string> = new Set([
  'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'cpSync', 'ftruncateSync',
  'linkSync', 'mkdirSync', 'mkdtempSync', 'openSync', 'renameSync', 'rmSync', 'rmdirSync',
  'symlinkSync', 'truncateSync', 'unlinkSync', 'utimesSync', 'writeFileSync', 'writeSync',
]);

/**
 * Local names bound to the `fs` MODULE — `import * as fs`, `import fs`.
 *
 * Only the namespace spellings, because the shape is about a raw mutation and a
 * bare `writeFileSync(…)` identifier import is not used anywhere in this tree
 * for a mutation; requiring the namespace keeps a same-named local helper from
 * being mistaken for the real thing, which is the lookalike protection rule 2
 * already has for fsjson.
 */
function fsNamespaces(source: ts.SourceFile): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier) || !/^(node:)?fs$/.test(specifier.text)) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
  }
  return names;
}

/** `fs.writeFileSync(…)` and friends. `openSync(p, 'r')` is a READ and is not one. */
function isRawFsMutation(node: ts.Node, namespaces: ReadonlySet<string>): boolean {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || !RAW_FS_MUTATORS.has(callee.name.text)) return false;
  if (!ts.isIdentifier(callee.expression) || !namespaces.has(callee.expression.text)) return false;
  if (callee.name.text === 'openSync') {
    const flag = node.arguments[1];
    // Five functions in this tree open a file read-only to sniff its first line
    // (role-evidence.ts, token-report/discovery.ts, host/plan.ts …). Admitting
    // those would make every `catch { return false }` around a READ a writer.
    if (flag && ts.isStringLiteral(flag) && flag.text === 'r') return false;
  }
  return true;
}

/** Does `node` contain a match, WITHOUT descending into a nested function? */
function containsHere(node: ts.Node, predicate: (child: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (child !== node && isFunctionLike(child)) return;
    if (predicate(child)) { found = true; return; }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * Module-local function bodies by NAME — the descent table for the clause
 * below. Collected over the whole tree rather than the top-level statements
 * because that is how every other resolver in this file reads a module, and
 * the cost of the difference is a name declared in two scopes being conflated:
 * the same name-based approximation `bodyForwards` and `writerNames` already
 * make, and the same one they are held to by fixtures rather than by argument.
 */
function localFunctionBodies(source: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const bodies = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) bodies.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      bodies.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bodies;
}

/**
 * The module-local names whose OWN FRAME reaches a raw-fs mutation, directly or
 * through another module-local name, to a fixpoint.
 *
 * `containsHere` at every level, so a nested function is never descended into
 * at any depth — the descent follows CALLS, not scopes, which is what keeps the
 * `withLock(() => fs.writeFileSync(…))` fixture below a non-writer. A direct
 * call to a module-local function runs synchronously inside the caller's frame,
 * so a throw from it is a throw the enclosing `catch` converts; a callback
 * handed to somebody else has no such guarantee and a parse cannot supply one.
 *
 * The bound is a true fixpoint rather than this file's usual fixed pass count:
 * a pass either adds a name or ends the walk, so `bodies.size + 1` passes
 * cannot truncate a deep chain the way a literal 8 could.
 */
function rawFsMutatingLocals(
  source: ts.SourceFile,
  namespaces: ReadonlySet<string>,
): ReadonlySet<string> {
  const bodies = localFunctionBodies(source);
  const reaching = new Set<string>();
  const frameReaches = (node: ts.Node): boolean => containsHere(node, (child) => {
    if (isRawFsMutation(child, namespaces)) return true;
    if (!ts.isCallExpression(child)) return false;
    const callee = unwrapExpression(child.expression);
    return ts.isIdentifier(callee) && reaching.has(callee.text);
  });
  for (let pass = 0; pass < bodies.size + 1; pass += 1) {
    const before = reaching.size;
    for (const [name, body] of bodies) {
      if (!reaching.has(name) && frameReaches(body)) reaching.add(name);
    }
    if (reaching.size === before) break;
  }
  return reaching;
}

/**
 * Names `source` declares that carry a raw-`fs` refusal, by the shape above.
 *
 * 22 functions in src/ + tests/ match today. THE LIMIT IS DECLARED RATHER THAN
 * PAPERED OVER: 38 further functions perform a raw-fs mutation and report the
 * failure through some OTHER value — `null` (acquirePolicyLock), `0`
 * (copyActiveSkills), `''` (ensureAgentTeamsEnv), a string union
 * (ensureCodexMcpServerRegistered), a result object (mintOverride,
 * runDelegate). None of those is admitted, and widening to "the catch returns
 * anything falsy" was rejected on measurement: it pulls in `withStoreLock<T>`
 * and every lock acquirer in the tree, whose `null` is CONTENTION rather than
 * refusal and is legitimately discarded at many call sites. An instrument that
 * fires on those is an instrument someone switches off, and then the sidecar
 * layer is uncovered again along with everything else.
 *
 * ── the DESCENT clause, and what it cost ────────────────────────────────────
 * The mutation no longer has to sit in the try block's own frame: a call to a
 * MODULE-LOCAL function that reaches one counts, transitively. That is what
 * closes shared/one-settings.ts#deleteOneSection, whose write sits two local
 * hops down (`withSettingsLock` → `acquireSettingsLock`'s lock `mkdirSync`, and
 * `writeWholeFile` below the lock body), and it is a resolver change rather
 * than a list edit for exactly that reason.
 *
 * Measured over src/ + tests/ before it landed, by running both seeds side by
 * side: the admitted census moves 21 -> 22 and the ONLY addition is
 * `deleteOneSection`. Nothing left the set. A variant that ALSO descended into
 * function expressions passed as call arguments was measured in the same run
 * and admitted the same 22, so it buys nothing and costs the nested-callback
 * fixture below — which is why the descent follows calls only.
 *
 * TWO LIMITS, declared rather than half-built:
 *   - the descent is INTRA-MODULE. This function is handed a `ts.SourceFile`
 *     and no tree, so a helper imported from another file ends the walk. A
 *     writer whose mutation is one IMPORT away is therefore still not admitted,
 *     and the fixture below pins that rather than leaving it to be discovered.
 *   - a mutation whose own failure is swallowed by an INNER `try`/`catch` still
 *     counts, so the outer `false` can be attributed to a write the outer catch
 *     could never have seen. The pre-existing direct clause has always had this
 *     hole (`try { try { fs.x() } catch {} return true } catch { return false }`
 *     matches today), and closing it in the descent alone would make the two
 *     halves of one shape disagree.
 */
function rawFsRefusalWriterNames(source: ts.SourceFile): ReadonlySet<string> {
  const namespaces = fsNamespaces(source);
  const names = new Set<string>();
  if (namespaces.size === 0) return names;
  const mutatingLocals = rawFsMutatingLocals(source, namespaces);
  const reachesMutation = (node: ts.Node): boolean => containsHere(node, (child) => {
    if (isRawFsMutation(child, namespaces)) return true;
    if (!ts.isCallExpression(child)) return false;
    const callee = unwrapExpression(child.expression);
    return ts.isIdentifier(callee) && mutatingLocals.has(callee.text);
  });
  const returnsLiteral = (node: ts.Node, kind: ts.SyntaxKind): boolean => containsHere(node, (child) =>
    ts.isReturnStatement(child) && child.expression !== undefined
    && unwrapExpression(child.expression).kind === kind);
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node) && node.catchClause
      && reachesMutation(node.tryBlock)
      && returnsLiteral(node.tryBlock, ts.SyntaxKind.TrueKeyword)
      && returnsLiteral(node.catchClause.block, ts.SyntaxKind.FalseKeyword)) {
      let owner: ts.Node | undefined = node;
      while (owner && !isFunctionLike(owner)) owner = owner.parent;
      if (owner) {
        const fn = owner as FunctionLike;
        if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
          names.add(fn.name.getText(source));
        } else if (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
          names.add(fn.parent.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

interface WriteSite {
  readonly relFile: string;
  readonly line: number;
  readonly text: string;
}

interface RefusalBlindSite extends WriteSite {
  /** `<relFile>#<publisher>` — the baseline key. Deliberately not line-keyed. */
  readonly key: string;
  readonly returnType: string;
}

interface RefusalScanResult {
  /** Every call reaching a refusal-carrying writer. Rule 2's non-vacuity denominator. */
  readonly writes: readonly WriteSite[];
  /**
   * The subset reaching the RAW-FS layer. Counted separately for the reason
   * `writeJsonDurable` exists in this file: a resolver that goes dark inside a
   * global floor is a resolver nobody notices. 125 of the 500 writes are these,
   * so the fsjson half alone would still clear `> 200` on its own.
   *
   * That split MOVES, and not only when writes are added: a name both resolvers
   * reach is attributed to fsjson, so the fsjson fixpoint growing a wrapper
   * shifts calls out of this bucket without anything going dark. Re-measured
   * across two commits it went 170/489 -> 125/500 while the SEED census stayed
   * at exactly 21 functions. So the number here is a measurement with a date on
   * it; the invariants are the floor below, the per-file pin, and that census.
   */
  readonly rawFsWrites: readonly WriteSite[];
  /** Those whose boolean is dropped in statement position — the proposal's rule 1. */
  readonly discarded: readonly WriteSite[];
  /** Those discards that sit inside a function handing a value back. Rule 2. */
  readonly refusalBlind: readonly RefusalBlindSite[];
  /** Rule 2's exemptions: a read-back that HASH-COMPARES. Counted to keep it honest. */
  readonly hashVerified: readonly RefusalBlindSite[];
  /** Rule 3: `return true` about a call that could not have reported a refusal. */
  readonly falseSuccess: readonly RefusalBlindSite[];
  /** Rule 4: two dropped writes to different paths — one may land, one may not. */
  readonly divergentPairs: readonly RefusalBlindSite[];
}

/**
 * The writer resolver, parameterised by its SEED — the base case that makes a
 * name a writer before any forwarding is considered.
 *
 * A factory rather than one resolver with a union seed, because rule 4 must be
 * able to ask about the fsjson writers ALONE. See `rawFsWriters` in
 * refusalScanner for why, and `LIMIT 3` in the header for the measurement.
 * Each instance keeps its own caches; sharing them across seeds is exactly the
 * bug this shape prevents.
 */
function writerResolver(tree: SourceTree, seed: (file: string, source: ts.SourceFile) => Iterable<string>) {
  const writerCache = new Map<string, ReadonlySet<string>>();
  const exportsCache = new Map<string, boolean>();

  /** Does `fn` hand back a call to something already known to be a writer? */
  function bodyForwardsWrite(fn: FunctionLike, known: ReadonlySet<string>): boolean {
    return bodyForwards(fn, known);
  }

  /** Names `file` declares that are refusal-carrying writers, to a fixpoint. */
  function writerNames(file: string): ReadonlySet<string> {
    const cached = writerCache.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    writerCache.set(file, names); // seed before recursing — a self-import must terminate
    const source = tree.parse(file);
    if (!source) return names;
    for (const name of seed(file, source)) names.add(name);

    const imported = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
      const bindings = statement.importClause?.namedBindings;
      if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (exportsWriter(target, (element.propertyName ?? element.name).text)) imported.add(element.name.text);
      }
    }
    // A local forwarding wrapper needs a base case. A file that neither imports
    // a writer nor SEEDS one can therefore declare none, and the walk below —
    // the expensive part, and it would otherwise run over every file in the
    // repo — is skipped outright. Keyed on `names.size` rather than on
    // `file !== FSJSON_MODULE`: with a shape seed the base case is no longer one
    // known module, and the old spelling would have skipped the fixpoint in
    // every file whose only writer is a raw-fs one — i.e. it would have found
    // writeMachineSidecar and then missed a local wrapper around it.
    if (imported.size === 0 && names.size === 0) return names;

    for (let pass = 0; pass < 8; pass += 1) {
      const before = names.size;
      const known = new Set<string>([...names, ...imported]);
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name && bodyForwardsWrite(node, known)) {
          names.add(node.name.text);
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
          && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
          && bodyForwardsWrite(node.initializer, known)) {
          names.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (names.size === before) break;
    }
    return names;
  }

  /** Does `file` export `name` as a writer — through re-exports and barrels? */
  function exportsWriter(file: string, name: string, seen: Set<string> = new Set()): boolean {
    const key = `${file}#${name}`;
    const cached = exportsCache.get(key);
    if (cached !== undefined) return cached;
    if (seen.has(key)) return false;
    seen.add(key);
    const source = tree.parse(file);
    if (!source) return false;
    let answer = writerNames(file).has(name);

    if (!answer) {
      const importedFrom = new Map<string, { file: string; name: string }>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const specifier = moduleSpecifierText(statement);
        const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
        const bindings = statement.importClause?.namedBindings;
        if (!target || !bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
          importedFrom.set(element.name.text, { file: target, name: (element.propertyName ?? element.name).text });
        }
      }
      for (const statement of source.statements) {
        if (answer) break;
        if (!ts.isExportDeclaration(statement)) continue;
        const specifier = moduleSpecifierText(statement);
        const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
        if (!statement.exportClause) { // `export * from '…'`
          if (target && exportsWriter(target, name, seen)) answer = true;
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        for (const element of statement.exportClause.elements) {
          if (element.name.text !== name) continue;
          const original = (element.propertyName ?? element.name).text;
          if (target) {
            if (exportsWriter(target, original, seen)) { answer = true; break; }
            continue;
          }
          const local = importedFrom.get(original);
          if (local && exportsWriter(local.file, local.name, seen)) { answer = true; break; }
        }
      }
    }
    exportsCache.set(key, answer);
    return answer;
  }

  // Memoized because rule 3 asks for it a second time (voidSwallowerNames needs
  // to know which calls in a file are writes before it can say which of its
  // functions swallow one), and the local-rebinding fixpoint below is the most
  // expensive thing in this scanner. Without the memo, adding rule 3 cost 12s.
  const bindingCache = new Map<string, ReadonlySet<string>>();
  function writerBindings(file: string, source: ts.SourceFile): ReadonlySet<string> {
    const cached = bindingCache.get(file);
    if (cached) return cached;
    const direct = new Set<string>(writerNames(file));
    bindingCache.set(file, direct);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
      if (!target) continue;
      for (const element of bindings.elements) {
        if (exportsWriter(target, (element.propertyName ?? element.name).text)) direct.add(element.name.text);
      }
    }
    if (direct.size === 0) return direct;
    // `const save = writeJson;` — the same local-rebinding fixpoint rule 1 runs.
    for (let pass = 0; pass < 16; pass += 1) {
      const before = direct.size;
      const visit = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          const value = unwrapExpression(node.initializer);
          if (ts.isIdentifier(value) && direct.has(value.text)) direct.add(node.name.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (direct.size === before) break;
    }
    return direct;
  }

  return { writerNames, exportsWriter, writerBindings };
}

function refusalScanner(tree: SourceTree) {
  // Two seeds, two resolvers, and the split is load-bearing rather than tidy.
  const fsjson = writerResolver(tree, (file) => (file === FSJSON_MODULE ? FSJSON_WRITERS : []));
  const rawFs = writerResolver(tree, (_file, source) => rawFsRefusalWriterNames(source));

  /** Every writer visible in `file`, from BOTH layers. Rules 2 and 3. */
  const allBindingCache = new Map<string, ReadonlySet<string>>();
  function allWriterBindings(file: string, source: ts.SourceFile): ReadonlySet<string> {
    const cached = allBindingCache.get(file);
    if (cached) return cached;
    const names = new Set<string>(fsjson.writerBindings(file, source));
    for (const name of rawFs.writerBindings(file, source)) names.add(name);
    allBindingCache.set(file, names);
    return names;
  }

  /**
   * Is this call's value THROWN AWAY — the whole call is a statement?
   * `void writeJson(…)` counts: spelling the discard out loud does not undo it.
   * Anything else — assigned, returned, tested, passed as an argument — has been
   * consumed by something, and what that something does with it is not this
   * rule's business.
   */
  function isDiscarded(node: ts.Node): boolean {
    let parent = node.parent;
    while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent)
      || ts.isNonNullExpression(parent) || ts.isVoidExpression(parent))) {
      parent = parent.parent;
    }
    return Boolean(parent && ts.isExpressionStatement(parent));
  }

  /** Does `fn` hand a value back? A bare `return;` and falling off the end do not. */
  function returnsAValue(fn: FunctionLike): boolean {
    if (ts.isArrowFunction(fn) && fn.body && !ts.isBlock(fn.body)) return true;
    if (!fn.body) return false;
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (node !== fn && isFunctionLike(node)) return; // a nested function's returns are its own
      if (ts.isReturnStatement(node) && node.expression) { found = true; return; }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return found;
  }

  /**
   * The OUTERMOST enclosing function that hands a value back, or null.
   *
   * Outermost, not innermost, because the callback is almost never the
   * publisher: writeRunSettlement's write is three frames down inside a
   * `withProjectStateLock(…, () => { … })` whose own callback returns void,
   * while the value a caller receives is minted by the exported function
   * wrapped around it. Attributing the write to the arrow would report the site
   * as harmless and name a function no caller has ever seen.
   */
  function enclosingPublisher(node: ts.Node): FunctionLike | null {
    let publisher: FunctionLike | null = null;
    let parent = node.parent;
    while (parent) {
      if (isFunctionLike(parent) && returnsAValue(parent)) publisher = parent;
      parent = parent.parent;
    }
    return publisher;
  }

  /**
   * The outermost enclosing function that HAS a name — rule 4's key. Rule 2 keys
   * on the publisher, but a divergent pair can sit in a void function, and its
   * writes are usually inside an unnamed lock callback. Keying on the named
   * function around it puts both rules' entries in the same vocabulary.
   */
  function owningFunction(node: ts.Node): FunctionLike | null {
    let named: FunctionLike | null = null;
    let innermost: FunctionLike | null = null;
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (!isFunctionLike(parent)) continue;
      if (!innermost) innermost = parent;
      if (!publisherName(parent, 0).startsWith('<anonymous>')) named = parent;
    }
    return named ?? innermost;
  }

  /**
   * The title of the enclosing `test(…)`/`it(…)`/`describe(…)`, when there is
   * one — a name for an unnamed function that survives a line shift.
   *
   * This is the fix for a harness defect that reddened another lane. The
   * baselines below are keyed `<file>#<function>` and their docblocks say
   * "never by line", but a function with no name fell through to
   * `<anonymous>@<line>`, so for those entries the claim was not true: an
   * unrelated edit ANYWHERE ABOVE the site renumbered its key, the old key
   * stopped firing (a failure, "prune the baseline") and the new one was
   * reported as a fresh violation (a failure, "you added one"). Two reds, one
   * line moved, nothing about the refusal contract changed. Measured: a
   * one-line temp-dir migration in src/core/__tests__/pipeline.test.ts did
   * exactly this to `pipeline.test.ts#<anonymous>@378`.
   *
   * Every anonymous publisher in the baselines is a callback inside a test, and
   * a test title is the most stable name such a site has: it is written by hand,
   * it is what a maintainer greps for, and moving the test does not change it.
   * Renaming the test does — deliberately. A renamed test is an edit to the
   * thing itself, and the baseline should be re-read then.
   */
  function enclosingTestTitle(fn: FunctionLike): string | null {
    for (let parent: ts.Node | undefined = fn.parent; parent; parent = parent.parent) {
      if (!ts.isCallExpression(parent)) continue;
      if (!/^(?:test|it|describe|suite)(?:\.\w+)*$/.test(parent.expression.getText())) continue;
      const title = parent.arguments[0];
      if (title && ts.isStringLiteralLike(title)) return title.text;
    }
    return null;
  }

  function publisherName(fn: FunctionLike, line: number): string {
    if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) return fn.name.getText();
    const parent = fn.parent;
    if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    const title = enclosingTestTitle(fn);
    // The `<anonymous>` prefix is load-bearing beyond the message: owningFunction
    // above asks whether a function is named by testing for it.
    if (title) return `<anonymous> in test "${title}"`;
    return `<anonymous>@${line}`;
  }

  /**
   * Does an escape — a `throw`, a bare `return`, or a `return null|undefined` —
   * lie on this branch? The shape a publisher uses to refuse rather than answer.
   */
  function escapesWithoutValue(node: ts.Node): boolean {
    let found = false;
    const visit = (child: ts.Node): void => {
      if (found) return;
      if (ts.isThrowStatement(child)) { found = true; return; }
      if (ts.isReturnStatement(child)) {
        if (!child.expression) { found = true; return; }
        const value = unwrapExpression(child.expression);
        if (value.kind === ts.SyntaxKind.NullKeyword
          || (ts.isIdentifier(value) && value.text === 'undefined')) { found = true; return; }
      }
      if (isFunctionLike(child)) return;
      ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  }

  /**
   * THE ONE EXEMPTION, and the only one that survived contact with the tree.
   *
   * After the write, an `if` whose condition compares a *…hash…* PROPERTY with
   * `===`/`!==` and whose branch escapes without a value. That is not a guess
   * about intent, it is a proof: every hash field in this codebase is derived
   * from the content (`contractHash`, `settlementHash`, `evidenceHash`,
   * `assignmentsHash`, `snapshotHash`), so a refused write leaves disk holding
   * either nothing or different bytes, the hashes disagree, and the branch
   * fires. The only way they can agree is if disk ALREADY held the candidate —
   * in which case the write was a no-op and handing the value back is right.
   *
   * A read-back WITHOUT the compare is not exempt, and that distinction is not
   * pedantry: shared/host/capabilities.ts had exactly that shape and returned
   * the stale record it had failed to replace, so a host that lost a blocking
   * point mid-run kept a record saying it still had one. Its fix reads
   * `if (!writeJson(file, candidate)) return;` and its comment names the
   * missing compare as the cause. A null check is not a compare either:
   * `!persisted` is satisfied by any stale file at that path.
   *
   * Two earlier proxies for "this publisher verified itself" were built and
   * thrown away (see the header) because they exempted on evidence that did not
   * bear on the write. What makes this one safe to adopt where those were not
   * is not only that it is narrower — it is that the baseline below now audits
   * it. A wrongly-exempted site DISAPPEARS from the flagged set, and a site
   * disappearing from the flagged set is a test failure with its name in it.
   */
  function hashComparedAfter(fn: FunctionLike, writeEnd: number, bothSides = false): boolean {
    if (!fn.body) return false;
    let verified = false;
    // Names bound AFTER the write — i.e. things that can only have come off
    // disk since. `bothSides` requires the compare's two operands to be hash
    // properties of two of these, which is what distinguishes "the artifacts
    // agree with each other" from "an artifact agrees with the candidate I was
    // about to write", the latter being true of one half of a torn pair.
    let boundAfter: Set<string> | null = null;
    const boundAfterWrite = (): ReadonlySet<string> => {
      if (boundAfter) return boundAfter;
      const names = new Set<string>();
      const walk = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.pos >= writeEnd) {
          names.add(node.name.text);
        }
        ts.forEachChild(node, walk);
      };
      if (fn.body) walk(fn.body);
      boundAfter = names;
      return names;
    };
    const visit = (node: ts.Node): void => {
      if (verified) return;
      if (ts.isIfStatement(node) && node.pos >= writeEnd) {
        let comparesHash = false;
        const inspect = (child: ts.Node): void => {
          if (comparesHash) return;
          if (ts.isBinaryExpression(child)
            && (child.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
              || child.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)) {
            const hashy = [child.left, child.right].map((side) => {
              const value = unwrapExpression(side);
              if (!ts.isPropertyAccessExpression(value) || !/hash/i.test(value.name.text)) return false;
              if (!bothSides) return true;
              const base = unwrapExpression(value.expression);
              return ts.isIdentifier(base) && boundAfterWrite().has(base.text);
            });
            // `bothSides` is the difference between "did my write land" and "do
            // the two artifacts agree" — see hasCrossArtifactCompare below.
            if (bothSides ? hashy[0] && hashy[1] : hashy.includes(true)) comparesHash = true;
          }
          ts.forEachChild(child, inspect);
        };
        inspect(node.expression);
        if (comparesHash
          && (escapesWithoutValue(node.thenStatement)
            || (node.elseStatement !== undefined && escapesWithoutValue(node.elseStatement)))) {
          verified = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
    return verified;
  }

  /**
   * Names `file` declares that DROP a refusal and can never report it, because
   * they hand nothing back. `writeState` is the one that matters: 30+ call sites
   * funnel through it, its return type is `void`, and rule 2 is structurally
   * blind to it — there is no value for the refusal to be lost from.
   */
  const swallowerCache = new Map<string, ReadonlySet<string>>();
  function voidSwallowerNames(file: string): ReadonlySet<string> {
    const cached = swallowerCache.get(file);
    if (cached) return cached;
    const names = new Set<string>();
    swallowerCache.set(file, names);
    const source = tree.parse(file);
    if (!source) return names;
    const writers = allWriterBindings(file, source);
    if (writers.size === 0) return names;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isIdentifier(callee) && writers.has(callee.text) && isDiscarded(node)) {
          let parent: ts.Node | undefined = node.parent;
          while (parent) {
            if (isFunctionLike(parent)) {
              if (returnsAValue(parent)) break; // a publisher — rule 2's business
              const name = publisherName(parent, 0);
              if (!name.startsWith('<anonymous>')) names.add(name);
            }
            parent = parent.parent;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return names;
  }

  /**
   * Every void-swallower name reachable through `file`'s exports.
   *
   * A SET per file rather than the per-name question the writer resolver asks,
   * because rule 3's lookups are dominated by one module: `writeState` lives
   * behind shared/state's barrel, and asking that barrel about each of the ~50
   * names a caller imports walked it ~50 times. That, plus memoizing
   * writerBindings, is what took rules 2-4 back from 13s to ~4s together.
   */
  const swallowerExportCache = new Map<string, ReadonlySet<string>>();
  function exportedSwallowers(file: string, seen: Set<string> = new Set()): ReadonlySet<string> {
    const cached = swallowerExportCache.get(file);
    if (cached) return cached;
    if (seen.has(file)) return new Set<string>(); // import cycle
    seen.add(file);
    const names = new Set<string>(voidSwallowerNames(file));
    const source = tree.parse(file);
    if (source) {
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement)) continue;
        const specifier = moduleSpecifierText(statement);
        const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
        if (!target) continue;
        if (!statement.exportClause) { // `export * from '…'` — the state barrel
          for (const name of exportedSwallowers(target, seen)) names.add(name);
          continue;
        }
        if (!ts.isNamedExports(statement.exportClause)) continue;
        const reachable = exportedSwallowers(target, seen);
        for (const element of statement.exportClause.elements) {
          if (reachable.has((element.propertyName ?? element.name).text)) names.add(element.name.text);
        }
      }
    }
    swallowerExportCache.set(file, names);
    return names;
  }

  function swallowerBindings(file: string, source: ts.SourceFile): ReadonlySet<string> {
    const bound = new Set<string>(voidSwallowerNames(file));
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      const specifier = moduleSpecifierText(statement);
      const target = specifier ? resolveSpecifier(tree, file, specifier) : null;
      if (!target) continue;
      const reachable = exportedSwallowers(target);
      for (const element of bindings.elements) {
        if (reachable.has((element.propertyName ?? element.name).text)) bound.add(element.name.text);
      }
    }
    return bound;
  }

  function scanFile(absFile: string): RefusalScanResult {
    const empty: RefusalScanResult = {
      writes: [], rawFsWrites: [], discarded: [], refusalBlind: [], hashVerified: [],
      falseSuccess: [], divergentPairs: [],
    };
    const source = tree.parse(absFile);
    if (!source) return empty;
    const writers = allWriterBindings(absFile, source);
    // ── LIMIT 3, and it is MEASURED ──────────────────────────────────────────
    // Rule 4 keys a "destination" on `arguments[0]`, and that is exact for the
    // fsjson writers: all eight take the path FIRST (writeJson(filePath, …),
    // ensureDir(dirPath), removePath(target), movePath(fromPath, toPath) …), so
    // two calls with different first arguments really are two artifacts.
    //
    // It is FALSE for a raw-fs writer, whose destination is usually a constant
    // inside its own module. `recordUpdatesPage(page, nowMs, env)` writes one
    // fixed sidecar file; its first argument is the PAGE. Feeding the raw-fs
    // layer to rule 4 reported 7 divergent pairs in updates-store.test.ts alone,
    // every one of them consecutive writes to THE SAME FILE read as a torn pair
    // because the pages differ textually. All 7 were false.
    //
    // So rule 4 asks only the fsjson resolver, and the gap is declared rather
    // than closed: a genuine two-artifact divergence written through the raw-fs
    // layer is NOT reported. Closing it needs a way to know a writer's
    // destination that does not assume the calling convention — the callee's
    // own path expression — which is a resolution this scanner does not do. A
    // "does argument[0] look like a path" heuristic is the third proxy this
    // file would have refused, and it would mis-sort in both directions.
    const pairWriters = fsjson.writerBindings(absFile, source);
    const swallowers = swallowerBindings(absFile, source);
    if (writers.size === 0 && swallowers.size === 0) return empty;

    const relFile = path.relative(REPO_ROOT, absFile);
    const writes: WriteSite[] = [];
    const rawFsWrites: WriteSite[] = [];
    const discarded: WriteSite[] = [];
    const refusalBlind: RefusalBlindSite[] = [];
    const hashVerified: RefusalBlindSite[] = [];
    const falseSuccess: RefusalBlindSite[] = [];
    const divergentPairs: RefusalBlindSite[] = [];
    const at = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const quote = (node: ts.Node): string => node.getText(source).split('\n')[0]!.trim().slice(0, 100);
    const describe = (fn: FunctionLike, site: WriteSite): RefusalBlindSite => ({
      ...site,
      key: `${relFile}#${publisherName(fn, at(fn))}`,
      returnType: fn.type ? fn.type.getText(source).replace(/\s+/g, ' ') : '(inferred)',
    });
    // Rule 4's accumulator: every dropped write, grouped by the function it is
    // in, so a pair can be recognised once the whole body has been walked.
    const droppedByFunction = new Map<ts.Node, ts.CallExpression[]>();

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);

        if (ts.isIdentifier(callee) && writers.has(callee.text)) {
          const site: WriteSite = { relFile, line: at(node), text: quote(node) };
          writes.push(site);
          if (!pairWriters.has(callee.text)) rawFsWrites.push(site);
          if (isDiscarded(node)) {
            discarded.push(site);
            if (pairWriters.has(callee.text)) { // rule 4 only — see LIMIT 3 above
              let owner: ts.Node | undefined = node.parent;
              while (owner && !isFunctionLike(owner)) owner = owner.parent;
              if (owner) {
                const siblings = droppedByFunction.get(owner) ?? [];
                siblings.push(node);
                droppedByFunction.set(owner, siblings);
              }
            }
            const publisher = enclosingPublisher(node);
            if (publisher) {
              // Walk the whole enclosing chain: the compare can live in the lock
              // callback (publishRuntimeAssignments) or in the exported function.
              let verified = false;
              for (let scope: ts.Node | undefined = node.parent; scope; scope = scope.parent) {
                if (isFunctionLike(scope) && hashComparedAfter(scope, node.end)) { verified = true; break; }
              }
              (verified ? hashVerified : refusalBlind).push(describe(publisher, site));
            }
          }
        }

        // Rule 3. The callee hands nothing back, so the refusal died inside it;
        // the literal `true` afterwards is this function inventing an answer.
        if (ts.isIdentifier(callee) && swallowers.has(callee.text) && isDiscarded(node)) {
          const publisher = enclosingPublisher(node);
          if (publisher?.body) {
            let claimsSuccess = false;
            const seek = (child: ts.Node): void => {
              if (claimsSuccess) return;
              if (child !== publisher && isFunctionLike(child)) return;
              if (ts.isReturnStatement(child) && child.expression && child.pos >= node.end
                && unwrapExpression(child.expression).kind === ts.SyntaxKind.TrueKeyword) {
                claimsSuccess = true;
                return;
              }
              ts.forEachChild(child, seek);
            };
            seek(publisher.body);
            if (claimsSuccess) {
              falseSuccess.push(describe(publisher, { relFile, line: at(node), text: quote(node) }));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    for (const [owner, calls] of droppedByFunction) {
      if (calls.length < 2) continue;
      // Different DESTINATIONS. Two drops at one path are one artifact that may
      // or may not be there; two drops at two paths are two artifacts that can
      // disagree with each other, which is the failure this rule is about.
      const targets = new Set(calls.map((call) => (call.arguments[0]?.getText(source) ?? '?')));
      if (targets.size < 2) continue;
      // Rule 4's OWN exemption, and deliberately not rule 2's — see the header.
      // Both operands of the compare must be hash properties, which means it is
      // relating two read-backs to EACH OTHER rather than one read-back to the
      // candidate that was written. Positioned after the last write of the pair.
      const lastWrite = Math.max(...calls.map((call) => call.end));
      let crossChecked = false;
      for (let scope: ts.Node | undefined = owner; scope; scope = scope.parent) {
        if (isFunctionLike(scope) && hashComparedAfter(scope, lastWrite, true)) { crossChecked = true; break; }
      }
      if (crossChecked) {
        hashVerified.push(describe(owningFunction(calls[0]!) ?? (owner as FunctionLike), {
          relFile, line: at(calls[0]!), text: 'cross-artifact hash compare over the pair',
        }));
        continue;
      }
      const named = owningFunction(calls[0]!) ?? (owner as FunctionLike);
      divergentPairs.push(describe(named, {
        relFile,
        line: at(calls[0]!),
        text: [...targets].map((target) => target.split('\n')[0]!.trim().slice(0, 44)).join('  +  '),
      }));
    }

    return { writes, rawFsWrites, discarded, refusalBlind, hashVerified, falseSuccess, divergentPairs };
  }

  return { scanFile };
}

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listTsFiles(full, out);
      continue;
    }
    // Every source extension the repo compiles, and __tests__ as well as
    // production: a vacuous `assert.ok(mutate())` in a test is the same defect
    // as a wrong `if` in a gate, and a non-.test.ts helper beside a test
    // (state/__tests__/claims-cas-race-child.ts) is real code that runs.
    if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// Production files that yield at least one MutationResult call site today. This
// is the zero-drop guard: a file falling silent now fails BY NAME, instead of
// hiding inside a global floor that one missing file cannot move. Adding a NEW
// caller needs no edit here — it is covered by the violation assertion itself.
// Test files are deliberately not pinned; they churn, and the floor covers them.
const FILES_WITH_RESULT_CALLS: readonly string[] = [
  // The gate layer — the only caller outside src/shared/state/**, and the one
  // that turns an outcome into a HookResult. When MutationResult widens past
  // run-agent/**, this is the list that grows.
  'src/modules/agent-model/gate-enforcement.ts',
  'src/shared/state/run-agent/claim-thread-role.ts',
  'src/shared/state/run-agent/claims-store.ts',
  // The file the destroy-branch bug lived in.
  'src/shared/state/run-agent/codex-liveness.ts',
  'src/shared/state/run-agent/context-resolve.ts',
  'src/shared/state/run-agent/fallback-claims.ts',
  'src/shared/state/run-agent/identity-drift.ts',
  'src/shared/state/run-agent/ledger.ts',
  'src/shared/state/run-agent/locks.ts',
  'src/shared/state/run-agent/mutation-result.ts',
  'src/shared/state/run-agent/registry-refresh.ts',
  'src/shared/state/run-agent/registry.ts',
];

test('no MutationResult-returning call sits in a truthiness position', () => {
  const files = [...listTsFiles(SRC_ROOT), ...listTsFiles(TESTS_ROOT)];
  assert.ok(files.length > 500, `expected well over 500 source files, found ${files.length} — is SRC_ROOT wrong?`);

  const scan = scanner(sourceTree());
  const results = files.map((file) => scan.scanFile(file));
  const calls = results.flatMap((result) => result.calls);
  const violations = results.flatMap((result) => result.violations);

  // Non-vacuity. A scanner that reports zero because it never looked is the
  // failure mode that matters most here: the assertion below passes trivially on
  // an empty result. 173 call sites resolve today (the same 173 a full
  // ts.createProgram type checker finds), so a collapse to a handful means the
  // binding resolver broke, not that the conversion was reverted.
  assert.ok(
    calls.length > 120,
    `expected well over 120 MutationResult call sites across src/ and tests/, found ${calls.length} — `
    + 'the binding resolver or the AST walk is broken, not that every mutation was deleted',
  );

  const scannedFiles = new Set(calls.map((call) => call.relFile));
  const wentSilent = FILES_WITH_RESULT_CALLS.filter((file) => !scannedFiles.has(file));
  assert.deepEqual(
    wentSilent,
    [],
    `${wentSilent.length} file(s) that used to yield MutationResult call sites now yield ZERO — either the calls `
    + 'really were removed (then delete the line from FILES_WITH_RESULT_CALLS in the same commit) or the scanner '
    + `has gone blind to that file's import/call shape:\n${wentSilent.map((file) => `  ${file}`).join('\n')}`,
  );

  assert.deepEqual(
    violations.map((violation) => `${violation.relFile}:${violation.line}`),
    [],
    `${violations.length} MutationResult value(s) coerced to a boolean. A MutationResult is an OBJECT and is `
    + 'ALWAYS truthy, so each of these reports every outcome — a contended lock, a refused write, a lost CAS — as '
    + 'success. Read the `.outcome` instead (`=== \'applied\'`), or use mutationApplied()/isApplied() when only the '
    + `bit is wanted:\n${violations.map((v) => `  ${v.relFile}:${v.line} — ${v.text}\n      sits in ${v.position}`).join('\n')}`,
  );
});

// ── scanner coverage: the positions that coerce a value to a boolean ─────────
// Every row must be FOUND. A position the scanner cannot see is a place the bug
// can come back, and the whole-repo assertion above would stay green through it.

const FIXTURE_DIR = path.join(SRC_ROOT, 'shared', 'state', 'run-agent', '__mr-scanner-fixture__');
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'caller.ts');
const FIXTURE_HELPER = path.join(FIXTURE_DIR, 'helpers.ts');
const FIXTURE_BARREL = path.join(FIXTURE_DIR, 'barrel', 'index.ts');
const FIXTURE_TSX = path.join(FIXTURE_DIR, 'panel.tsx');
// Resolves the REAL mutation-result.ts, so every fixture proves the resolver
// reaches the actual origin module rather than a stub of it.
const REAL_ORIGIN = "'../mutation-result'";

/** A fixture file that calls the real `retryWhileUnavailable` in `%POS%`. */
function positionFixture(body: string): Record<string, string> {
  return {
    [FIXTURE_FILE]: `import { retryWhileUnavailable, applied } from ${REAL_ORIGIN};\n`
      + 'declare const other: boolean;\n'
      + 'const mutate = () => applied(1);\n'
      + `export function gate(): unknown {\n  ${body}\n}\n`,
  };
}

const POSITION_CASES: ReadonlyArray<{ label: string; body: string; position: RegExp }> = [
  { label: 'if condition', body: 'if (retryWhileUnavailable(mutate)) return 1; return 0;', position: /`if` condition/ },
  { label: 'negated if condition', body: 'if (!retryWhileUnavailable(mutate)) return 1; return 0;', position: /operand of `!`/ },
  { label: 'while condition', body: 'while (retryWhileUnavailable(mutate)) return 1; return 0;', position: /`while` condition/ },
  { label: 'do…while condition', body: 'do { return 1; } while (retryWhileUnavailable(mutate));', position: /`do…while` condition/ },
  { label: 'for condition', body: 'for (;retryWhileUnavailable(mutate);) return 1; return 0;', position: /`for` condition/ },
  // The historical shape.
  { label: 'ternary condition', body: 'return retryWhileUnavailable(mutate) ? 1 : 0;', position: /ternary condition/ },
  { label: 'left operand of &&', body: 'return retryWhileUnavailable(mutate) && other;', position: /left operand of `&&`/ },
  { label: 'left operand of ||', body: 'return retryWhileUnavailable(mutate) || other;', position: /left operand of `\|\|`/ },
  {
    label: 'right operand of && that is itself tested',
    body: 'if (other && retryWhileUnavailable(mutate)) return 1; return 0;',
    position: /right operand of `&&`/,
  },
  { label: 'Boolean() coercion', body: 'return Boolean(retryWhileUnavailable(mutate));', position: /`Boolean\(…\)`/ },
  { label: 'parenthesized if condition', body: 'if (((retryWhileUnavailable(mutate)))) return 1; return 0;', position: /`if` condition/ },
  {
    label: 'a local holding the result, tested one line later',
    body: 'const retired = retryWhileUnavailable(mutate);\n  if (retired) return 1;\n  return 0;',
    position: /`if` condition/,
  },
];

test('every position that coerces a MutationResult to a boolean is reported', () => {
  for (const positionCase of POSITION_CASES) {
    const scan = scanner(sourceTree(positionFixture(positionCase.body)));
    const { violations } = scan.scanFile(FIXTURE_FILE);
    assert.equal(violations.length, 1, `${positionCase.label}: expected exactly 1 violation, found ${violations.length}`);
    assert.match(violations[0]!.position, positionCase.position, positionCase.label);
  }
});

// ── the exact bug, pinned ────────────────────────────────────────────────────
// The stale-retire ternary as it stood in codex-liveness.ts when it told the
// reuse gate a live role was free. Reverting the real file and watching this
// test fail is the proof that was run once; keeping the shape here is what makes
// the proof permanent, and survives a future rewrite of that function.
const HISTORICAL_STALE_RETIRE_BUG =
  "import { retireCodexRegistryEntryIfMatches } from './retire';\n"
  + 'declare const cwd: string, runId: string, requestedRole: string, entry: never;\n'
  + 'export function validateCodexLiveRunAgent(): unknown {\n'
  + "  return retireCodexRegistryEntryIfMatches(cwd, runId, requestedRole, entry, 'codex-session-meta-missing-stale')\n"
  + "    ? { status: 'stale-retired' }\n"
  + "    : { status: 'conflict', entry, reason: 'codex-stale-retire-cas-lost' };\n"
  + '}\n';

// The fixed shape, verbatim from codex-liveness.ts. It must NOT be reported, or
// the guard would demand the bug back.
const FIXED_STALE_RETIRE =
  "import { retireCodexRegistryEntryIfMatches } from './retire';\n"
  + 'declare const cwd: string, runId: string, requestedRole: string, entry: never;\n'
  + 'export function validateCodexLiveRunAgent(): unknown {\n'
  + "  const retired = retireCodexRegistryEntryIfMatches(cwd, runId, requestedRole, entry, 'codex-session-meta-missing-stale');\n"
  + "  if (retired.outcome === 'applied') return { status: 'stale-retired' };\n"
  + '  return {\n'
  + "    status: 'conflict',\n"
  + '    entry,\n'
  + "    reason: retired.outcome === 'unavailable'\n"
  + '      ? `codex-stale-retire-${retired.reason}`\n'
  + "      : 'codex-stale-retire-cas-lost',\n"
  + '  };\n'
  + '}\n';

const RETIRE_MODULE = path.join(FIXTURE_DIR, 'retire.ts');
const RETIRE_SOURCE = `import { type MutationResult } from ${REAL_ORIGIN};\n`
  + 'export function retireCodexRegistryEntryIfMatches(\n'
  + '  cwd: string, runId: string, role: string, entry: unknown, reason: string,\n'
  + '): MutationResult<void> { return { outcome: \'applied\', value: undefined, reason: \'\' }; }\n';

test('the destroy-branch bug — the stale-retire ternary — is caught, and its fix is not', () => {
  const buggy = scanner(sourceTree({ [RETIRE_MODULE]: RETIRE_SOURCE, [FIXTURE_FILE]: HISTORICAL_STALE_RETIRE_BUG }));
  const reported = buggy.scanFile(FIXTURE_FILE);
  assert.equal(reported.calls.length, 1, 'the retire call must resolve at all');
  assert.equal(reported.violations.length, 1, 'the stale-retire ternary must be reported');
  assert.match(reported.violations[0]!.position, /ternary condition/);

  const fixed = scanner(sourceTree({ [RETIRE_MODULE]: RETIRE_SOURCE, [FIXTURE_FILE]: FIXED_STALE_RETIRE }));
  const clean = fixed.scanFile(FIXTURE_FILE);
  assert.equal(clean.calls.length, 1, 'the fixed site still has to RESOLVE, or this row proves nothing');
  assert.deepEqual(clean.violations, [], 'reading .outcome is the fix — it must not be reported');
});

// ── scanner coverage: the shapes a call can reach a mutation through ─────────
// Each row resolves the REAL mutation-result.ts. The whole-repo assertion writes
// only the direct-import shape today; these keep the resolver honest for the
// shapes the next conversion may introduce.

interface ShapeCase {
  readonly label: string;
  readonly files: Record<string, string>;
  readonly entry: string;
}

const SHAPE_CASES: readonly ShapeCase[] = [
  {
    label: 'direct named import',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { retryWhileUnavailable, applied } from ${REAL_ORIGIN};\n`
        + 'export const gate = () => (retryWhileUnavailable(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'aliased import — import { retryWhileUnavailable as retry }',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { retryWhileUnavailable as retry, applied } from ${REAL_ORIGIN};\n`
        + 'export const gate = () => (retry(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 're-export wrapper',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_HELPER]: `export { retryWhileUnavailable, applied } from ${REAL_ORIGIN};\n`,
      [FIXTURE_FILE]: "import { retryWhileUnavailable, applied } from './helpers';\n"
        + 'export const gate = () => (retryWhileUnavailable(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'barrel — export * from',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_BARREL]: "export * from '../../mutation-result';\n",
      [FIXTURE_FILE]: "import { retryWhileUnavailable, applied } from './barrel';\n"
        + 'export const gate = () => (retryWhileUnavailable(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'namespace import — result.retryWhileUnavailable(...)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import * as result from ${REAL_ORIGIN};\n`
        + 'export const gate = () => (result.retryWhileUnavailable(() => result.applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'namespace re-export — export * as result',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_HELPER]: `export * as result from ${REAL_ORIGIN};\n`,
      [FIXTURE_FILE]: "import { result } from './helpers';\n"
        + 'export const gate = () => (result.retryWhileUnavailable(() => result.applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'require destructuring',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `const { retryWhileUnavailable, applied } = require(${REAL_ORIGIN});\n`
        + 'export const gate = () => (retryWhileUnavailable(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'dynamic import destructuring, inside a function body, aliased',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: 'export async function gate() {\n'
        + `  const { retryWhileUnavailable: retry, applied } = await import(${REAL_ORIGIN});\n`
        + '  return retry(() => applied(1)) ? 1 : 0;\n}\n',
    },
  },
  {
    label: 'local rebinding — const retry = retryWhileUnavailable',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { retryWhileUnavailable, applied } from ${REAL_ORIGIN};\n`
        + 'const retry = retryWhileUnavailable;\n'
        + 'export const gate = () => (retry(() => applied(1)) ? 1 : 0);\n',
    },
  },
  {
    label: 'inferred-return wrapper — const annotate = (x) => someResultFn(x)',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { applied } from ${REAL_ORIGIN};\n`
        + 'const annotate = (n: number) => applied(n);\n'
        + 'export const gate = () => (annotate(1) ? 1 : 0);\n',
    },
  },
  {
    label: 'callback parameter typed () => MutationResult<T>',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { type MutationResult } from ${REAL_ORIGIN};\n`
        + 'export function withLock<T>(mutate: () => MutationResult<T>): number {\n'
        + '  return mutate() ? 1 : 0;\n}\n',
    },
  },
  {
    label: 'interface member typed as a MutationResult-returning function',
    entry: FIXTURE_FILE,
    files: {
      [FIXTURE_FILE]: `import { type MutationResult } from ${REAL_ORIGIN};\n`
        + 'interface Row { readonly invoke: (cwd: string) => MutationResult<unknown>; }\n'
        + 'declare const row: Row;\n'
        + 'export const gate = () => (row.invoke("/tmp") ? 1 : 0);\n',
    },
  },
  {
    label: 'a .tsx file — JSX must not eat the statements after it',
    entry: FIXTURE_TSX,
    files: {
      [FIXTURE_TSX]: `import { retryWhileUnavailable, applied } from ${REAL_ORIGIN};\n`
        + "export const Panel = () => <div className='x'>{'hi'}</div>;\n"
        + 'export const gate = () => (retryWhileUnavailable(() => applied(1)) ? 1 : 0);\n',
    },
  },
];

test('the scanner reaches a mutation through every binding shape a call site can use', () => {
  for (const shapeCase of SHAPE_CASES) {
    const scan = scanner(sourceTree(shapeCase.files));
    const { calls, violations } = scan.scanFile(shapeCase.entry);
    assert.ok(calls.length >= 1, `${shapeCase.label}: the call must resolve, found ${calls.length}`);
    assert.equal(violations.length, 1, `${shapeCase.label}: expected 1 violation, found ${violations.length}`);
  }
});

// ── what must NOT be reported ────────────────────────────────────────────────
// A gate that fires on correct code gets disabled, and then it protects nothing.
test('the scanner leaves correct MutationResult handling alone', () => {
  const cases: ReadonlyArray<{ label: string; body: string }> = [
    {
      // The legitimate discard, codex-liveness.ts's authoritative-role-model-mismatch
      // path: the answer cannot change the verdict, so it is not read.
      label: 'the result is discarded entirely',
      body: 'retryWhileUnavailable(mutate);\n  return 0;',
    },
    {
      label: 'the result is discarded as the right operand of && (a statement, not a test)',
      body: 'other && retryWhileUnavailable(mutate);\n  return 0;',
    },
    { label: 'the outcome is read', body: "return retryWhileUnavailable(mutate).outcome === 'applied' ? 1 : 0;" },
    {
      label: 'the outcome is read off a local',
      body: "const r = retryWhileUnavailable(mutate);\n  if (r.outcome !== 'applied') return 0;\n  return 1;",
    },
    { label: 'the result is returned', body: 'return retryWhileUnavailable(mutate);' },
    { label: 'the result is an argument', body: 'return mutationApplied(retryWhileUnavailable(mutate)) ? 1 : 0;' },
    { label: 'the VALUE is tested, which is nullable and means what it says', body: 'return mutationValue(retryWhileUnavailable(mutate)) ? 1 : 0;' },
    { label: 'a boolean helper is tested', body: 'return isApplied(retryWhileUnavailable(mutate)) ? 1 : 0;' },
  ];
  for (const okCase of cases) {
    const files = {
      [FIXTURE_FILE]: 'import { retryWhileUnavailable, applied, mutationApplied, mutationValue, isApplied }'
        + ` from ${REAL_ORIGIN};\n`
        + 'declare const other: boolean;\n'
        + 'const mutate = () => applied(1);\n'
        + `export function gate(): unknown {\n  ${okCase.body}\n}\n`,
    };
    const scan = scanner(sourceTree(files));
    const { calls, violations } = scan.scanFile(FIXTURE_FILE);
    assert.ok(calls.length >= 1, `${okCase.label}: the call must still RESOLVE, or this row proves nothing`);
    assert.deepEqual(
      violations.map((violation) => `${violation.text} in ${violation.position}`),
      [],
      `${okCase.label}: correct handling must not be reported`,
    );
  }
});

test('a boolean-returning lookalike is not mistaken for a mutation', () => {
  const files = {
    // `mutationApplied` answers with a boolean, and testing a boolean is the
    // whole point of a boolean. Nothing here may be reported — including the
    // same-named local helper, which resolves to no mutation at all.
    [FIXTURE_FILE]: 'const retryWhileUnavailable = (): boolean => true;\n'
      + 'export const gate = () => (retryWhileUnavailable() ? 1 : 0);\n',
  };
  const scan = scanner(sourceTree(files));
  const { calls, violations } = scan.scanFile(FIXTURE_FILE);
  assert.deepEqual(calls, [], 'a local boolean helper of the same name is not a mutation');
  assert.deepEqual(violations, []);
});

// ════════════════════════════════════════════════════════════════════════════
// RULE 2 — a publisher that hands back a value after discarding a write's
// refusal.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Every publisher that does this TODAY, with the verdict that was reached on it.
 * A RATCHET, not a clean sheet: rule 2 has a non-empty baseline, and pretending
 * otherwise would mean either a red suite or thirty production changes made
 * blind by the lane that only built the instrument.
 *
 * Keyed `<file>#<function>`, never by line, so an edit above a site does not
 * churn this list — and a publisher with two such writes is one entry, because
 * the verdict is about the function.
 *
 * Both directions fail. A NEW key is the ratchet. A key that no longer fires is
 * also a failure, with "delete this line": a baseline nobody prunes rots into a
 * list of things that used to be true, and then the next person deletes all of
 * it at once.
 *
 * ── verdict classes ────────────────────────────────────────────────────────
 * BLIND    the returned value is minted whether or not the write landed, and a
 *          consumer acts on it. The defect, live.
 * RE-READ  the function verifies by reading the path back and fails on what it
 *          finds, so the refusal IS detected — by disk state rather than by the
 *          boolean. Shape wrong, consequence nil. Rule 2 cannot see this and
 *          deliberately does not try (see the header).
 * REFUSAL  the value handed back is itself a no, or the write is a best-effort
 *          diagnostic beside one. A lost write cannot turn a no into a yes.
 * INERT    a harness/fixture path where a lost write costs a stray file or a
 *          test that fails loudly on its next assertion.
 *
 * Fixing production sites is out of scope for the lane that built this; the
 * BLIND rows are the hand-off.
 *
 * Five entries were removed from this list while it was being written, because
 * a parallel lane fixed those publishers in the same working tree — including
 * writeRunSettlement, whose new comment reaches the same diagnosis this rule
 * did ("`written` was assigned before the write, so a refused settlement came
 * back as a non-null, hash-bearing record"). That is the best evidence the
 * calibration is right, and the "no longer fires" assertion below is what makes
 * a list this live safe to keep.
 *
 * Better evidence arrived later, and it is the only measurement here taken on
 * code the rules were not tuned against: rule 2 caught a lane's own fixture
 * helper, written mid-task, handing back a project after discarding writeState
 * — by an author who knew the rule existed. A tuned rule passing its tuning set
 * proves very little. Catching new code is the result that matters, and it is
 * also the argument for the ratchet running on tests/ as well as src/, which
 * costs a handful of INERT rows in this list and is worth them.
 */
const REFUSAL_BLIND_PUBLISHERS: readonly string[] = [
  // ── BLIND ────────────────────────────────────────────────────────────────
  // The QA evidence write is dropped and the exit code is decided from the
  // in-memory report. This is the `ok: true`, exit 0, report-never-on-disk
  // shape. browser.ts#browserCommand and lighthouse.ts#lighthouseCommand sat
  // here until their evidence writes were routed into the verdict; the live
  // OwnedServer Lighthouse path and the native siblings still carry the defect.
  'src/runners/qa-evidence/lighthouse.ts#runLighthouseOnOwnedServer',
  'src/runners/qa-evidence/native.ts#publishNativeResult',
  'src/runners/qa-evidence/native.ts#runXcodeNative',
  // The write at :462 is dropped and `removePendingClaim` runs on the next line
  // regardless — half of a move, which is how fsjson's own movePath comment
  // describes a role going missing. (The boolean LOCK at :425 in this file is a
  // separate, already-settled question and is not what this row is about.)
  'src/shared/state/run-agent/context-resolve.ts#resolveRunAgentContext',
  // Returns a PATH after an unchecked write. Every caller discards it today, so
  // no test can prove a behaviour change — which is exactly why they are pinned
  // rather than exempted: "all callers discard it" is a fact with a shelf life,
  // and the day one stops, nothing else changes and nothing else fires.
  'src/modules/plan-guard/react-structure/scan.ts#writeStructureReport',
  'src/test-environment/manual-host-certification.ts#writeManualHostCertification',

  // The writeState cohort that sat here — all fifteen of it — is FIXED, so the
  // rows are gone with the code that earned them. Two of the fifteen are worth
  // remembering, because they were reported here as losses of a field and were
  // something worse:
  //
  //   claims-store.ts#ensureRunAgentClaimResult minted `applied` over the write
  //   that records which run the claim belongs to — the truthiness defect's own
  //   shape through the OTHER door, a MutationResult FABRICATED rather than
  //   misread. It answers `unavailable('run-state-write-refused')` now, which is
  //   the outcome gate-enforcement.ts already denies a spawn on.
  //
  //   This is also the site the two-channel distinction at the top of this file
  //   was measured on, and it cuts the other way: the SAME torn state — a claim
  //   row under a run id .one.json does not carry — is reachable by EACCES,
  //   where there is no boolean at all, and there the throw unwinds into the
  //   fail-closed `pipeline-handler-crashed` deny and the spawn never happens.
  //   The errno half was covered before the fix; the refusal half was not. Every
  //   BLIND verdict in this list should be read that narrowly.
  //
  //   run-paths.ts#ensureCurrentRunId returned an id `.one.json` did not carry,
  //   so the id kept being re-derived from `runs/` for exactly as long as the run
  //   stayed adoptable and then a SIBLING was minted beside it — the incident its
  //   own :49-55 comment exists to prevent. It returns `''` on a refused persist
  //   now, the fail-closed exit its callers already handle.
  //
  // Kept as prose rather than rows because rule 2 fails in both directions: a row
  // for a fixed site fails as loudly as a missing row for a broken one.

  // ── WEAK READ-BACK ───────────────────────────────────────────────────────
  // These re-read the path they wrote and then DO NOT compare a hash, so the
  // exemption above does not reach them — and it should not. A null check is
  // satisfied by any stale file at that path, which is precisely how
  // shared/host/capabilities.ts returned a record it had failed to replace.
  //
  // `if (!persisted) throw` — a superseding write that is refused leaves the
  // BLOCKED snapshot on disk, which is non-null, so it is returned as though the
  // supersede took. The audit lane reached the same site independently, called
  // it benign, and marked it the one verdict it could not prove. It is the
  // weakest row in this list and the one to look at first.
  'src/shared/architecture-contract/compile.ts#supersedeBlockedRunSnapshot',
  // The compare exists but lives one call away, inside `acceptanceAttests`,
  // which re-reads the attestation and checks reportHash/evidenceHash/
  // buildFingerprint. Safe in effect; the detector is in-function by design and
  // will not follow a call, because following calls is how it would start
  // exempting things it has not read.
  'src/shared/qa-report-v2/artifacts.ts#writeAcceptanceAttestation',
  // Its own doc says it: "Re-reading after the write is deliberate rather than
  // trusting the writer's return value", because writeTextIfChanged also
  // answers false for "already identical". Compares CONTENT rather than a hash
  // (`normalizeBody(readText(…)).includes(body)`) — as strong here, but not the
  // shape the exemption recognises.
  'src/shared/materialize/render-agents.ts#preserveBody',
  // `completeAuthoritativeRebindJournalUnlocked` was the sharpest row in this
  // section and is FIXED, so it is gone from here as well as from rule 4. Its
  // read-back was not merely weak, it was inverted: the claim file is keyed by
  // THREAD, so a refused rewrite left the SOURCE claim at that path, the
  // null-check found it, and the function returned `{ status: 'complete' }`
  // carrying the un-rebound role — a wrong answer manufactured out of the
  // artifact the write had failed to replace, which is the same shape as
  // shared/host/capabilities.ts and the reason this section exists.
  'src/shared/state/run-agent/rebind-journal.ts#authoritativeRebindThreadRole',
  'src/shared/state/run-agent/claim-thread-role.ts#claimThreadRole',

  // ── REFUSAL ──────────────────────────────────────────────────────────────
  // The dropped write is a best-effort conflict diagnostic and the value handed
  // back is `preconditionFailed('cross-role-agent-conflict')`. Its comment
  // states the rule: "The REFUSAL is the outcome, whether or not its diagnostic
  // persisted." (Note the return type — `MutationResult<void>`. This publisher
  // is where rule 1 and rule 2 meet, and it is on the right side of both.)
  'src/shared/state/run-agent/registry.ts#recordRunAgentUnlocked',
  // "best-effort lock; never block the writer on a lock-write failure", and the
  // answer is `{ blocked: false }` when the lock was not taken.
  'src/shared/state/run-agent/fallback-claims.ts#tryFallbackClaim',
  // The dropped write is the fail-closed RESTORE of a pending marker, inside the
  // branch returning `{ status: 'invalid' }`.
  'src/shared/maintenance/fallback.ts#finalizePaidMaintenanceFallback',
  // Only the `ensureDir` is dropped; the writeJson beside it IS consumed
  // (`persisted = writeJson(file, { seq })`) and gates the return. A refused
  // mkdir surfaces as the refused write into it.
  'src/shared/state/decision-log.ts#nextHookSeq',
  // Diagnostic sidecar / best-effort rename. The caller already has a verdict
  // (auth probe, fold notice text, override path names) that does not depend
  // on these writes landing; a refused persist costs a repeat notice or a
  // leftover miscased folder, never a certified artifact.
  'src/runners/auth/revalidate.ts#runAuthRevalidation',
  'src/runners/auth/validate-key.ts#probeAuthenticatedUpdates',
  'src/shared/materialize/plan-migration.ts#consumeArchitectureFoldNotice',
  'src/shared/override/paths.ts#overrideProjectPaths',

  // ── ADMITTED BY THE RAW-FS SHAPE ─────────────────────────────────────────
  // Four sites the instrument could not see until the second writer layer was
  // admitted. All four are PRE-EXISTING and none is newly broken; they are the
  // whole measured blast radius of the resolution change, and each carries a
  // verdict rather than a path.
  //
  // REFUSAL. Both `bootstrap`s drop `writeGraphPreview(cwd, …)` inside a try
  // whose comment already says "best-effort; never fail the run because preview
  // write glitched", and the `ok: true` they return is the verdict on the
  // gitnexus/graphify RUN, not on the preview. The exculpation is the stronger
  // one the header names for the void-writer class: the CONSUMER floors on
  // absence — session-start-lib.ts#readGraphPreview is `if
  // (!fs.existsSync(previewPath)) return ''` — so a refused preview costs a
  // subagent a full Read of the graph artefact and claims nothing false. Worth
  // keeping pinned rather than exempting, because the boolean is genuinely
  // available and `writeGraphPreview` is one edit away from meaning something.
  'src/runners/gitnexus/bootstrap.ts#bootstrap',
  'src/runners/graphify/index.ts#bootstrap',
  // WEAK — and it belongs in the section above it in spirit. `ensureProject-
  // Gitignore`'s false is OVERLOADED exactly the way writeTextIfChanged's is
  // (see preserveBody): it answers false for a refused write AND for
  // `next === null || next === existing`, i.e. "the block is already correct".
  // So the dropped boolean here is not purely a dropped refusal, and routing it
  // into MaterializeResult would report a no-op as a failure. That is the
  // reason it is pinned and not fixed, and it is also the reason it is not
  // exempt: a genuinely refused .gitignore update leaves the state dir
  // untracked while materialization reports success, and nothing distinguishes
  // that from the no-op today. The fix is at the callee — a three-valued answer
  // — and that file is not this lane's.
  'src/shared/materialize/materialize.ts#materializeProjectAssets',
  // INERT. A fixture builder in the auth lane's own test that hands back a
  // populated machine after discarding recordUpdatesPage. A refused write here
  // fails the very next assertion, loudly.
  'src/modules/session/__tests__/session-updates-surface.test.ts#populated',

  // ── INERT ────────────────────────────────────────────────────────────────
  // `if (landed) removePath(probeTarget)` — the cleanup of a harness probe,
  // guarded by the probe write's own boolean. Costs a stray file.
  'src/test-environment/core/consent.ts#establishCaseConsent',
  'tests/replay-corpus/fixtures.ts#cursorModelChoice',
  // The gate callback in the fence's OWN test, which drops two writes on
  // purpose and then reads the decision log to check both were recorded.
  // The publisher is an anonymous arrow, so its name comes from the test around
  // it rather than from itself. It used to come from its LINE, which made this
  // the one entry an edit above it would churn — see publisherName.
  'src/core/__tests__/pipeline.test.ts#<anonymous> in test '
  + '"stateWrites carries the chokepoint\'s own writes, refusals included"',
];

/**
 * Publishers rule 2 sees and the hash-compare exemption clears. Pinned as its
 * OWN list rather than simply dropped, because an exemption nobody counts is an
 * exemption that can quietly widen: if one of these stops comparing its hash it
 * reappears in REFUSAL_BLIND_PUBLISHERS and fails as a new site, and if the
 * detector breaks the other way this list empties and fails here.
 */
const HASH_VERIFIED_PUBLISHERS: readonly string[] = [
  // Writes, re-reads via readRuntimeAssignments, and throws unless
  // `persisted.assignmentsHash === candidate.assignmentsHash`. The worked
  // example of a read-back that is genuinely load-bearing.
  'src/shared/architecture-contract/index.ts#publishRuntimeAssignments',
  // Exempt from BOTH rules, and the only site here that earns the second one.
  // It writes baseline (:152) and snapshot (:153), re-reads both (:154, :155),
  // and throws unless both came back and
  // `persisted.baselineHash === persistedBaseline.baselineHash` (:156-158).
  // That last clause is a cross-artifact compare — the two files against each
  // other, not against the candidate — so a refusal of EITHER half is caught,
  // which is what rule 4 needs and what a per-write check does not give.
  //
  // It reached this list by being wrong somewhere else first: it sat in
  // DIVERGENT_PAIR_FUNCTIONS under a verdict claiming nothing re-read the first
  // path. A neighbouring lane read the source, found both halves of that false,
  // and could not simply delete the row, because the ratchet fails in both
  // directions and the shape still fires. Rule 4's exemption is the operation
  // that row needed, and it exists because this site demanded it.
  'src/shared/architecture-contract/compile.ts#ensureArchitectureRunSnapshot',
  // `if (!verified || verified.envelopeHash !== envelopeHash) return null;`
  'src/shared/run-bootstrap-policy/index.ts#ensureRunBootstrap',
];

/**
 * RULE 3 — `return true` after a void writer that already dropped a refusal.
 *
 * Six of the seven original entries are gone, fixed rather than exempted. Five
 * of them shared ONE callee: `writeState`, the funnel 30-odd state writers use,
 * which was `void` — so the refusal died one frame below every caller and each
 * of the five invented its own answer. It now returns whether `.one.json` holds
 * the state, and the five forward it. The sixth (`migrateLegacyProject-
 * LocalTrafficOneState`) is worth reading in full at its fix: it was the
 * asymmetry this rule caught without being able to see it, and the `true` was
 * standing over a DELETED legacy copy.
 *
 * What is left is the one entry that was always aimed at the wrong line.
 */
const FALSE_SUCCESS_PUBLISHERS: readonly string[] = [
  // Fires on `sweepStale(dir)`, but the defect was the line above it:
  // `if (writeTextFile(marker, …)) sweepStale(dir)` consulted the boolean only
  // to decide whether to sweep, never to decide the ANSWER, and `return true`
  // ran either way. A refused marker made the next call a "first" emit too — the
  // once-per-session throttle reduced to a coin toss, which is the same defect
  // decision-log.ts's nextHookSeq was fixed for. Recorded honestly: the rule
  // found a real site through a shape that is not the reason it is real.
  //
  // FIXED, and still firing — deliberately, because the fix does not change
  // either line the rule looks at. `return true` STAYS: a marker the fence
  // refuses pre-consent must not silence the product (that is the whole point of
  // eight of the nine call sites being in the onboarding gate), so the first
  // emit is always true. What changed is that an unpersisted marker now falls
  // back to a process-scoped mirror of the same throttle, so the SECOND call
  // answers false. `sweepStale` stays void because a best-effort sweep of
  // expired markers has no caller-visible answer to give.
  //
  // Left pinned rather than deleted: the shape is still exactly what the rule
  // describes, so deleting it would make the ratchet's own staleness check
  // report a blind spot that is not there. Do not "fix" this by routing the
  // write's boolean into the return value — that reintroduces the silencing this
  // module's header comment exists to forbid.
  'src/shared/once.ts#firstEmitThisSession',
];

/**
 * RULE 4 — two dropped writes, two paths, one function. Ordered worst first.
 */
const DIVERGENT_PAIR_FUNCTIONS: readonly string[] = [
  // The archetype this rule was built from — `writeLegacyProjection`, dropping
  // run.json and then dropping maintenance.json with the SAME `settlement.status`
  // and `settlement.settlementHash` — is FIXED and gone from this list. run.json
  // is the primary (every legacy reader consults it through
  // `effectiveLegacyRunStatus`), so its refusal now returns before the sidecar
  // write, which leaves one dropped write and takes the pair below this rule's
  // threshold. Exactly the fix the rule pointed at.
  //
  // The two rebind pairs this rule named next — claimFile + registryFile in
  // `completeAuthoritativeRebindJournalUnlocked`, and the journal + the same two
  // in `authoritativeRebindThreadRole` — are FIXED and gone from this list. Both
  // now guard on the write, and neither needed a new channel: `blocked` (and
  // `null` from the outer function) is the answer a MALFORMED journal already
  // produces, and every consumer refuses conservatively on it.
  //
  // Worth keeping as the rule's best evidence that the divergence is not the
  // only cost. In the io.ts pair the two paths could diverge, yes — a role bound
  // in the claim and free in the registry — but the refused CLAIM write did
  // something worse on its own: the read-back at the end of the function found
  // the source claim the write had failed to replace and reported
  // `{ status: 'complete' }` for a rebind that had not happened, with the
  // journal already deleted. In rebind-journal.ts the second path IS the
  // journal, so a refusal there ran the transaction with no recovery record at
  // all and left `replayAuthoritativeRebindJournal` answering `none` — "nothing
  // to replay" — over a half-applied rebind.
  //
  // The immutable + active envelope pair in `ensureRunBootstrap` is FIXED and
  // gone from this list — the immutable write is guarded and returns null on
  // refusal, which leaves one dropped write and takes the pair below this rule's
  // threshold. `ensureArchitectureRunSnapshot` used to sit beside it under a
  // verdict that was wrong in both halves, and moving that one to
  // HASH_VERIFIED_PUBLISHERS is what produced rule 4's own exemption; this row's
  // own verdict was wrong in one half, and the correction is worth keeping
  // because it is the sharpest illustration of what rule 4 can and cannot see.
  //
  // What the verdict said: refuse the immutable write, land the active one, and a
  // child resolves an active envelope whose immutable twin is not there. MEASURED
  // FALSE, by construction — a dangling symlink planted at the twin's
  // hash-named path with the rest of the role directory asserted writable. The
  // twin is re-read one frame down, inside `readActiveRunBootstrap`, which
  // resolves nothing unless the copy keyed by the active hash is present and
  // hash-identical, and every consumer of an envelope goes through it. No
  // consumer can see the two artifacts disagree, so the divergence this rule is
  // named for was unreachable at this site.
  //
  // What the shape cost instead, also measured: the refused twin did not stop
  // the active write, so `active.json` was advanced to a hash that resolves for
  // nobody — destroying the pointer to the PREVIOUS envelope, which was still
  // resolving. The role went from bootstrapped to unresolvable, a retry on the
  // same inputs recomputed the same hash and refused again, and the function
  // returned exactly the null it would have returned without touching anything.
  // A dropped pair whose two artifacts cannot disagree can still be worth fixing
  // for the write it spends getting to its own failure, and that is not something
  // a shape rule can rank — which is the argument for reading every row rather
  // than ordering them worst-first and trusting the order.
  //
  // Pinned in src/shared/__tests__/run-bootstrap-immutable-twin.test.ts: one test
  // per half, the unresolvable-without-twin invariant and the survival of the
  // previous envelope across a refused publish.
  // The fences' own tests, each dropping a permitted write and a refused one on
  // purpose. Both assert on what reached disk (`existsSync`) rather than on the
  // return value, which is why the discard is the point rather than an
  // oversight. Both enclosing `test(…)` callbacks are anonymous, so both are
  // keyed by the TITLE of the test they sit in.
  //
  // These two entries were line-keyed, and a line key ROTATES when anything is
  // inserted above it: adding a test to one of these files reddened the ratchet
  // twice over — the site appeared as NEW at its moved line and the old key read
  // as stale — with no defect anywhere. Measured twice: the normalize entry moved
  // 228 -> 309 when the prompt-privacy tests landed above it, and the pipeline
  // entry moved again this week under a one-line temp-dir migration.
  //
  // The objection recorded here against title-keying was that a RENAME would go
  // silent. It does not: `ratchet` asserts on `stale` as well as on `added`, so a
  // renamed test fails with "this baseline entry no longer fires" and the new key
  // fails as an addition — the same two reds a line shift used to produce, now
  // only when someone edits the test itself.
  'src/core/__tests__/pipeline.test.ts#<anonymous> in test '
  + '"stateWrites carries the chokepoint\'s own writes, refusals included"',
  'src/shared/state/__tests__/normalize.test.ts#<anonymous> in test '
  + '"writeState refuses to CREATE state in a directory that belongs to an enclosing project"',
];

/**
 * The zero-drop guard for the RAW-FS half of the writer set — the same idiom
 * FILES_WITH_RESULT_CALLS uses for rule 1, and for the same reason: a magnitude
 * floor cannot tell "this layer stopped resolving" from "the tree shrank".
 *
 * Deliberately a handful of DISTINCT base cases rather than every file, so it
 * does not churn. These are CALL SITES, not definitions — machine-sidecar.ts is
 * absent for that reason: it declares `writeMachineSidecar` and calls only raw
 * `fs`, so it reaches no writer of its own. What is pinned instead is one file
 * per hop the resolution has to survive:
 *   updates-store.ts / revalidation-state.ts  the direct importers, i.e. the
 *       shape seed itself still fires on machine-sidecar.ts;
 *   revalidate.ts  two hops out, through `writeStore` — the forwarding fixpoint
 *       still carries a raw-fs seed across modules, which is the mechanism the
 *       whole design rests on, and this is the file the lane's defect was in;
 *   materialize.ts  a completely unrelated raw-fs writer, so the seed is not
 *       quietly reduced to the auth layer.
 */
const FILES_WITH_RAW_FS_WRITES: readonly string[] = [
  'src/runners/auth/revalidate.ts',
  'src/shared/auth/revalidation-state.ts',
  'src/shared/auth/updates-store.ts',
  'src/shared/materialize/materialize.ts',
];

test('rule 2: no NEW publisher hands back a value after discarding a write refusal', () => {
  const files = [...listTsFiles(SRC_ROOT), ...listTsFiles(TESTS_ROOT)];
  const scan = refusalScanner(sourceTree());
  const results = files.map((file) => scan.scanFile(file));
  const writes = results.flatMap((result) => result.writes);
  const rawFsWrites = results.flatMap((result) => result.rawFsWrites);
  const discarded = results.flatMap((result) => result.discarded);
  const refusalBlind = results.flatMap((result) => result.refusalBlind);
  const hashVerified = results.flatMap((result) => result.hashVerified);
  const falseSuccess = results.flatMap((result) => result.falseSuccess);
  const divergentPairs = results.flatMap((result) => result.divergentPairs);

  // Non-vacuity, and it is two claims, not one. The first says the WRITERS
  // resolve — 319 calls reach one today, through direct imports, aliases,
  // barrels, forwarding wrappers that never name a writer, and the
  // capture-into-a-local shape writeState uses. The second says the POSITION
  // test works — 98 of those discard the boolean. A scanner that quietly
  // stopped resolving would report zero new publishers and pass.
  //
  // These floors are deliberately far below the counts. They exist to catch a
  // resolver that has gone dark, not to track the tree: writeState alone moved
  // them by 62 and 49 when it stopped being `void`, and a floor that has to be
  // edited on every such change is a floor people edit without reading.
  assert.ok(
    writes.length > 200,
    `expected well over 200 calls to a refusal-carrying writer, found ${writes.length} — the writer resolver is `
    + 'broken, not that the writes were deleted',
  );
  assert.ok(
    discarded.length > 80,
    `expected well over 80 discarded write refusals, found ${discarded.length} — the statement-position test is broken`,
  );

  // The SECOND layer's own floor, and it is separate on purpose. 125 of the 500
  // writes reach a raw-fs writer; folded into the global floor above, the whole
  // raw-fs resolver could stop resolving and `> 200` would still pass on the
  // fsjson half alone. That is precisely how the `writeJsonDurable` regression
  // hid, and the lesson was to floor each half of a denominator that can move
  // independently.
  //
  // Re-measured rather than copied forward: the pair read 170/489 when the layer
  // landed and reads 125/500 two commits later, with the shape seed still
  // admitting exactly the same 21 functions. A name both resolvers reach is
  // attributed to fsjson, so this bucket shrinks when the fsjson fixpoint grows
  // — which is why the floor sits far below the count and why the per-file pin
  // below, not the magnitude, is what catches the layer falling silent.
  assert.ok(
    rawFsWrites.length > 60,
    `expected well over 60 calls reaching a SANCTIONED RAW-FS writer, found ${rawFsWrites.length} — the shape `
    + 'seed (rawFsRefusalWriterNames) or its forwarding fixpoint has gone dark, and the machine-sidecar layer is '
    + 'unwatched again',
  );
  // …and by FILE, so a layer falling silent fails by name rather than inside a
  // magnitude. These four are the distinct base cases the shape has to keep
  // recognising: the sidecar (the layer this was built for), a plain
  // best-effort writer, a lock reaper, and a fd-based rewriter.
  const rawFsFiles = new Set(rawFsWrites.map((site) => site.relFile));
  const rawFsWentSilent = FILES_WITH_RAW_FS_WRITES.filter((file) => !rawFsFiles.has(file));
  assert.deepEqual(
    rawFsWentSilent,
    [],
    `${rawFsWentSilent.length} file(s) that used to reach a raw-fs writer now reach ZERO. Either the calls really `
    + 'went away (delete the line in the same commit) or the shape seed no longer recognises that writer — check '
    + `it still reads \`try { …fs…; return true } catch { return false }\`:\n${rawFsWentSilent.join('\n  ')}`,
  );

  // One ratchet, applied four times. BOTH directions fail: a new key is the
  // guard, and a key that stops firing is what keeps the baseline from rotting
  // into a list of things that used to be true — and what audits the one
  // exemption, since a wrongly-exempted site leaves the flagged list by name.
  const ratchet = (
    label: string,
    sites: readonly RefusalBlindSite[],
    baseline: readonly string[],
    advice: string,
  ): void => {
    const found = new Map(sites.map((site) => [site.key, site]));
    const added = [...found.keys()].filter((key) => !baseline.includes(key)).sort();
    assert.deepEqual(
      added,
      [],
      `${added.length} NEW ${label}. ${advice}\n${added
        .map((key) => `  ${key} -> ${found.get(key)!.returnType}\n      `
          + `${found.get(key)!.relFile}:${found.get(key)!.line} — ${found.get(key)!.text}`)
        .join('\n')}`,
    );
    const stale = baseline.filter((key) => !found.has(key)).sort();
    assert.deepEqual(
      stale,
      [],
      `${stale.length} ${label} baseline entr(y/ies) no longer fire. If the site was fixed or removed, delete the `
      + 'line in the same commit; if it went quiet while the code stands, the scanner has gone blind to it:\n'
      + stale.map((key) => `  ${key}`).join('\n'),
    );
  };

  ratchet(
    'publisher(s) hand back a value after throwing away a write\'s refusal',
    refusalBlind,
    REFUSAL_BLIND_PUBLISHERS,
    'fsjson.ts answers `false` for a refused write (consent fence, planted symlink, a path escaping the state '
    + 'dir) and each of these returns something a caller will act on regardless — which is Traffic One certifying '
    + 'an artifact its own gate will then deny the run for. Route the boolean into the value the caller already '
    + 'consumes (publishVerificationContract is the worked example: `writeJson(…) ? contract : null`), or re-read '
    + 'and compare the hash. If the site is genuinely safe, add it to REFUSAL_BLIND_PUBLISHERS with the verdict:',
  );

  ratchet(
    'publisher(s) are exempt because they hash-compare a read-back',
    hashVerified,
    HASH_VERIFIED_PUBLISHERS,
    'This is the exemption widening. Confirm the compare really covers the write — it must be a `…hash…` property '
    + 'on the value the READ returned, guarding a throw or a valueless return — then add it to '
    + 'HASH_VERIFIED_PUBLISHERS:',
  );

  ratchet(
    'function(s) `return true` after a void writer that dropped a refusal',
    falseSuccess,
    FALSE_SUCCESS_PUBLISHERS,
    'The callee hands nothing back, so the refusal died inside it and this `true` is invented. Give the callee a '
    + 'boolean and forward it, or return what the caller can check:',
  );

  ratchet(
    'function(s) drop two writes to two different paths',
    divergentPairs,
    DIVERGENT_PAIR_FUNCTIONS,
    'Either write can be refused without the other, and the result is not a missing artifact but two artifacts '
    + 'that disagree — each writer individually looking fine. Check both booleans and make the pair all-or-'
    + 'nothing, or record which half landed:',
  );
});

// ── rule 2 scanner coverage ─────────────────────────────────────────────────
// Overlaid on the real tree, importing the REAL src/shared/fsjson.ts, so every
// row proves the resolver reaches the actual writers rather than a stub.

const WRITE_FIXTURE_DIR = path.join(SRC_ROOT, 'shared', '__refusal-fixture__');
const WRITE_FIXTURE = path.join(WRITE_FIXTURE_DIR, 'publisher.ts');
const WRITE_FIXTURE_BARREL = path.join(WRITE_FIXTURE_DIR, 'barrel', 'index.ts');
const REAL_FSJSON = "'../fsjson'";

function publisherFixture(source: string): Record<string, string> {
  return { [WRITE_FIXTURE]: source };
}

const BLIND_CASES: ReadonlyArray<{ label: string; source: string }> = [
  {
    label: 'the historical shape: write, then return the in-memory object',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  writeJson(p, c);\n  return c;\n}\n',
  },
  {
    label: 'returns the PATH it wrote to',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: unknown): string {\n  writeJson(p, c);\n  return p;\n}\n',
  },
  {
    label: 'a boolean publisher returning an unconditional true',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: unknown): boolean {\n  writeJson(p, c);\n  return true;\n}\n',
  },
  {
    // writeRunSettlement's shape: the nullable channel exists and the write
    // never reaches it. The rule must not be fooled by the `| null`.
    label: 'a nullable return whose null is only ever the catch',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } | null {\n'
      + '  try {\n    writeJson(p, c);\n  } catch {\n    return null;\n  }\n  return c;\n}\n',
  },
  {
    // The write is three frames down inside a lock callback whose own body
    // returns void. Attributing it to the arrow would call the site harmless.
    label: 'the write is inside a callback, the publisher is outside it',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'declare function withLock(run: () => void): void;\n'
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  withLock(() => { writeJson(p, c); });\n  return c;\n}\n',
  },
  {
    label: 'the writer is imported under an alias',
    source: `import { writeJson as persist } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  persist(p, c);\n  return c;\n}\n',
  },
  {
    label: 'the writer is reached through a local forwarding wrapper',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'function save(p: string, c: unknown) { return writeJson(p, c); }\n'
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  save(p, c);\n  return c;\n}\n',
  },
  {
    label: 'the writer is reached through a barrel re-export',
    source: "import { writeJson } from './barrel';\n"
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  writeJson(p, c);\n  return c;\n}\n',
  },
  {
    label: 'the discard is spelled out with `void`',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  void writeJson(p, c);\n  return c;\n}\n',
  },
  {
    label: 'a fenced delete, not a write',
    source: `import { removePath } from ${REAL_FSJSON};\n`
      + 'export function drop(p: string): string {\n  removePath(p);\n  return p;\n}\n',
  },
];

test('rule 2: every shape of a refusal-blind publisher is reported', () => {
  for (const blindCase of BLIND_CASES) {
    const overrides: Record<string, string> = publisherFixture(blindCase.source);
    overrides[WRITE_FIXTURE_BARREL] = "export { writeJson } from '../../fsjson';\n";
    const scan = refusalScanner(sourceTree(overrides));
    const { writes, refusalBlind } = scan.scanFile(WRITE_FIXTURE);
    // At least one: the forwarding-wrapper row has two, since the wrapper's own
    // `return writeJson(…)` is a resolved write as well (a consumed one).
    assert.ok(writes.length >= 1, `${blindCase.label}: the write must RESOLVE, or this row proves nothing`);
    assert.equal(
      refusalBlind.length,
      1,
      `${blindCase.label}: expected exactly 1 refusal-blind publisher, found ${refusalBlind.length}`,
    );
    assert.match(refusalBlind[0]!.key, /#(publish|drop)$/, blindCase.label);
  }
});

const HANDLED_CASES: ReadonlyArray<{ label: string; source: string }> = [
  {
    // publishVerificationContract as it stands today.
    label: 'the fix: the boolean chooses between the value and null',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } | null {\n'
      + '  return writeJson(p, c) ? c : null;\n}\n',
  },
  {
    label: 'the boolean is tested and the publisher bails',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } | null {\n'
      + '  if (!writeJson(p, c)) return null;\n  return c;\n}\n',
  },
  {
    label: 'the boolean is held in a local and consulted later',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: { id: string }): { id: string } | null {\n'
      + '  const landed = writeJson(p, c);\n  return landed ? c : null;\n}\n',
  },
  {
    label: 'the boolean is forwarded straight to the caller',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function publish(p: string, c: unknown): boolean {\n  return writeJson(p, c);\n}\n',
  },
  {
    // 51 of the 88 discards look like this. Banning them is the proposal's rule
    // 1, and firing on all 88 to describe ~20 is how an invariant gets switched
    // off. Nothing was promised to a caller here, so nothing was lied to.
    label: 'a discard in a function that hands nothing back',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function record(p: string, c: unknown): void {\n  writeJson(p, c);\n}\n',
  },
  {
    label: 'a discard beside an early bare return',
    source: `import { writeJson } from ${REAL_FSJSON};\n`
      + 'export function record(p: string, c: unknown): void {\n  if (!p) return;\n  writeJson(p, c);\n}\n',
  },
];

test('rule 2: a publisher that consulted the refusal is not reported', () => {
  for (const handled of HANDLED_CASES) {
    const scan = refusalScanner(sourceTree(publisherFixture(handled.source)));
    const { writes, refusalBlind } = scan.scanFile(WRITE_FIXTURE);
    assert.equal(writes.length, 1, `${handled.label}: the write must still RESOLVE, or this row proves nothing`);
    assert.deepEqual(
      refusalBlind.map((site) => `${site.key} — ${site.text}`),
      [],
      `${handled.label}: correct handling must not be reported`,
    );
  }
});

// ── the exact bug, pinned ────────────────────────────────────────────────────
// publishVerificationContract as it stood when it handed every caller a contract
// that claimed to be published whether or not anything reached disk. Reverting
// the real file and watching this fail is a proof somebody runs once; the shape
// pinned here is what makes it permanent, and it survives that function being
// rewritten — or living in a directory this lane may not touch.
const HISTORICAL_PUBLISH_CONTRACT_BUG =
  `import { writeJson } from ${REAL_FSJSON};\n`
  + 'declare function verificationContractPath(projectRoot: string, runId: string): string;\n'
  + 'interface VerificationContractV2 { runId: string }\n'
  + 'export function publishVerificationContract(\n'
  + '  projectRoot: string,\n'
  + '  contract: VerificationContractV2,\n'
  + '): VerificationContractV2 {\n'
  + '  writeJson(verificationContractPath(projectRoot, contract.runId), contract);\n'
  + '  return contract;\n'
  + '}\n';

// The fixed shape, verbatim from verification-contract/index.ts. It must NOT be
// reported, or the guard would be demanding the bug back.
const FIXED_PUBLISH_CONTRACT =
  `import { writeJson } from ${REAL_FSJSON};\n`
  + 'declare function verificationContractPath(projectRoot: string, runId: string): string;\n'
  + 'interface VerificationContractV2 { runId: string }\n'
  + 'export function publishVerificationContract(\n'
  + '  projectRoot: string,\n'
  + '  contract: VerificationContractV2,\n'
  + '): VerificationContractV2 | null {\n'
  + '  return writeJson(verificationContractPath(projectRoot, contract.runId), contract) ? contract : null;\n'
  + '}\n';

test('the published-but-never-written bug is caught, and its fix is not', () => {
  const buggy = refusalScanner(sourceTree(publisherFixture(HISTORICAL_PUBLISH_CONTRACT_BUG)));
  const reported = buggy.scanFile(WRITE_FIXTURE);
  assert.equal(reported.writes.length, 1, 'the writeJson call must resolve at all');
  assert.equal(reported.discarded.length, 1, 'its boolean must be seen to be discarded');
  assert.equal(reported.refusalBlind.length, 1, 'the publisher must be reported');
  assert.match(reported.refusalBlind[0]!.key, /#publishVerificationContract$/);
  assert.equal(reported.refusalBlind[0]!.returnType, 'VerificationContractV2');

  const fixed = refusalScanner(sourceTree(publisherFixture(FIXED_PUBLISH_CONTRACT)));
  const clean = fixed.scanFile(WRITE_FIXTURE);
  assert.equal(clean.writes.length, 1, 'the fixed site still has to RESOLVE, or this row proves nothing');
  assert.deepEqual(clean.discarded, [], 'the fixed site consumes the boolean');
  assert.deepEqual(clean.refusalBlind, [], 'the fix must not be reported');
});

// ── the hash-compare exemption, pinned from both sides ──────────────────────
// The three real sites this had to sort are pinned as shapes, because the
// exemption is the only place in this file where a scanner DECIDES something is
// fine, and the cost of it being wrong is silence.

const HASH_COMPARED_READBACK = // publishRuntimeAssignments — exempt
  `import { writeJson } from ${REAL_FSJSON};\n`
  + 'declare function pathFor(root: string): string;\n'
  + 'declare function readBack(root: string): { hash: string } | null;\n'
  + 'export function publish(root: string, candidate: { hash: string }): { hash: string } {\n'
  + '  writeJson(pathFor(root), candidate);\n'
  + '  const persisted = readBack(root);\n'
  + '  if (!persisted || persisted.hash !== candidate.hash) throw new Error("not persisted");\n'
  + '  return persisted;\n'
  + '}\n';

const NULL_CHECKED_READBACK = // compile.ts#supersedeBlockedRunSnapshot — NOT exempt
  `import { writeJson } from ${REAL_FSJSON};\n`
  + 'declare function pathFor(root: string): string;\n'
  + 'declare function readBack(root: string): { hash: string } | null;\n'
  + 'export function publish(root: string, candidate: { hash: string }): { hash: string } {\n'
  + '  writeJson(pathFor(root), candidate);\n'
  + '  const persisted = readBack(root);\n'
  + '  if (!persisted) throw new Error("not persisted");\n'
  + '  return persisted;\n'
  + '}\n';

const BARE_READBACK = // shared/host/capabilities.ts before its fix — NOT exempt
  `import { writeJson } from ${REAL_FSJSON};\n`
  + 'declare function pathFor(root: string): string;\n'
  + 'declare function readBack(root: string): { hash: string } | null;\n'
  + 'export function publish(root: string, candidate: { hash: string }): { hash: string } | null {\n'
  + '  writeJson(pathFor(root), candidate);\n'
  + '  return readBack(root);\n'
  + '}\n';

test('a read-back is exculpatory only when it compares a hash', () => {
  const verdict = (source: string): 'exempt' | 'flagged' | 'missed' => {
    const result = refusalScanner(sourceTree(publisherFixture(source))).scanFile(WRITE_FIXTURE);
    if (result.hashVerified.length === 1 && result.refusalBlind.length === 0) return 'exempt';
    if (result.refusalBlind.length === 1 && result.hashVerified.length === 0) return 'flagged';
    return 'missed';
  };
  // The lane proved this read-back load-bearing by deleting it and pinning the
  // failure. This row is the same claim from the scanner's side.
  assert.equal(verdict(HASH_COMPARED_READBACK), 'exempt', 'a hash-compared read-back detects the refusal');
  // A stale file at the path satisfies `!persisted`, so the null check proves
  // nothing about THIS write.
  assert.equal(verdict(NULL_CHECKED_READBACK), 'flagged', 'a null check is not a compare');
  // The shape that returned the record it had failed to replace.
  assert.equal(verdict(BARE_READBACK), 'flagged', 'a read-back with no check at all is not exculpatory');

  // …and the exemption must not be reachable when the compare cannot have seen
  // the write, or it becomes the silent proxy this file twice refused to ship.
  const beforeTheWrite = refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'declare function pathFor(root: string): string;\n'
    + 'declare function readBack(root: string): { hash: string } | null;\n'
    + 'export function publish(root: string, candidate: { hash: string }): { hash: string } {\n'
    + '  const before = readBack(root);\n'
    + '  if (before && before.hash === candidate.hash) return before;\n'
    + '  writeJson(pathFor(root), candidate);\n'
    + '  return candidate;\n}\n',
  ))).scanFile(WRITE_FIXTURE);
  assert.equal(beforeTheWrite.hashVerified.length, 0, 'a compare BEFORE the write exempts nothing');
  assert.equal(beforeTheWrite.refusalBlind.length, 1, 'and the site is still flagged');
});

// ── rule 3 ──────────────────────────────────────────────────────────────────

test('rule 3: `return true` after a void writer that swallowed the refusal', () => {
  // scrubProjectStateLocalPrefs' shape: a void writer in one module, a boolean
  // claim about it in another, resolved across the import.
  const swallower = path.join(WRITE_FIXTURE_DIR, 'state.ts');
  const files: Record<string, string> = {
    [swallower]: `import { writeJson } from '../fsjson';\n`
      + 'export function writeState(cwd: string, state: unknown): void {\n  writeJson(cwd, state);\n}\n',
    [WRITE_FIXTURE]: "import { writeState } from './state';\n"
      + 'export function scrub(cwd: string, raw: unknown): boolean {\n'
      + '  writeState(cwd, raw);\n  return true;\n}\n',
  };
  const reported = refusalScanner(sourceTree(files)).scanFile(WRITE_FIXTURE);
  assert.equal(reported.falseSuccess.length, 1, 'the invented `true` must be reported');
  assert.match(reported.falseSuccess[0]!.key, /#scrub$/);
  // Rule 2 must NOT also fire here: no refusal-carrying writer is called in this
  // file at all, and double-reporting one defect under two rules would make both
  // baselines lie about their size.
  assert.deepEqual(reported.refusalBlind, [], 'rule 2 has nothing to say about a void callee');

  // The fix: the callee reports, the caller forwards.
  const fixed = refusalScanner(sourceTree({
    [swallower]: `import { writeJson } from '../fsjson';\n`
      + 'export function writeState(cwd: string, state: unknown): boolean {\n  return writeJson(cwd, state);\n}\n',
    [WRITE_FIXTURE]: "import { writeState } from './state';\n"
      + 'export function scrub(cwd: string, raw: unknown): boolean {\n  return writeState(cwd, raw);\n}\n',
  })).scanFile(WRITE_FIXTURE);
  assert.deepEqual(fixed.falseSuccess, [], 'a forwarded boolean is not an invented one');
  assert.deepEqual(fixed.refusalBlind, [], 'nor is it refusal-blind');
});

test('a writer that captures its answer in a local is still a writer', () => {
  // shared/state/normalize.ts#writeState, reduced. The refusal is produced
  // inside a lock callback and returned through a local, which is not the
  // `return writeJson(…)` shape the resolver originally knew.
  //
  // Pinned because of how this was found. writeState went from `void` to
  // `boolean` — a real fix, made for the right reason — and its ~30 callers did
  // not become guarded, they became UNWATCHED: out of rule 3, and not into rule
  // 2, because nothing recognised the callee as a writer any more. Fifteen
  // publishers sat in that gap. An instrument that quietly narrows when the code
  // it watches improves is worse than one that never covered the ground, so the
  // shape is a test rather than a comment.
  const files: Record<string, string> = {
    [path.join(WRITE_FIXTURE_DIR, 'state.ts')]: `import { writeJson } from '../fsjson';\n`
      + 'declare function withLock(cwd: string, run: () => void): void;\n'
      + 'export function writeState(cwd: string, state: unknown): boolean {\n'
      + '  let persisted = false;\n'
      + '  withLock(cwd, () => { persisted = writeJson(cwd, state); });\n'
      + '  return persisted;\n}\n',
    [WRITE_FIXTURE]: "import { writeState } from './state';\n"
      + 'export function stamp(cwd: string, state: { id: string }): string {\n'
      + '  writeState(cwd, state);\n  return state.id;\n}\n',
  };
  const reported = refusalScanner(sourceTree(files)).scanFile(WRITE_FIXTURE);
  assert.equal(reported.refusalBlind.length, 1, 'the discarded refusal must reach rule 2 through the local');
  assert.match(reported.refusalBlind[0]!.key, /#stamp$/);

  // The local must actually carry the write. A function returning some OTHER
  // local is not a writer, or every lock-and-return helper in the tree would be.
  const unrelated = refusalScanner(sourceTree({
    [path.join(WRITE_FIXTURE_DIR, 'state.ts')]: `import { writeJson } from '../fsjson';\n`
      + 'declare function withLock(cwd: string, run: () => void): void;\n'
      + 'declare function readBack(cwd: string): string;\n'
      + 'export function writeState(cwd: string, state: unknown): string {\n'
      + '  let seen = "";\n'
      + '  withLock(cwd, () => { if (!writeJson(cwd, state)) return; seen = readBack(cwd); });\n'
      + '  return seen;\n}\n',
    [WRITE_FIXTURE]: "import { writeState } from './state';\n"
      + 'export function stamp(cwd: string, state: { id: string }): string {\n'
      + '  writeState(cwd, state);\n  return state.id;\n}\n',
  })).scanFile(WRITE_FIXTURE);
  assert.deepEqual(unrelated.refusalBlind, [], 'a returned local that is not the write result carries no refusal');
});

// ── rule 4 ──────────────────────────────────────────────────────────────────

test('rule 4: two dropped writes to two paths, including in a void function', () => {
  // writeLegacyProjection's shape — void, so no other rule here can reach it.
  const pair = refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'export function project(file: string, other: string, value: { status: string }): void {\n'
    + '  writeJson(file, value);\n'
    + '  writeJson(other, { status: value.status });\n}\n',
  ))).scanFile(WRITE_FIXTURE);
  assert.equal(pair.divergentPairs.length, 1, 'the pair must be reported');
  assert.match(pair.divergentPairs[0]!.key, /#project$/);
  assert.deepEqual(pair.refusalBlind, [], 'a void function returns nothing for rule 2 to judge');

  // Two drops at ONE path are one artifact that may or may not be there — that
  // is rule 2's question where a value is returned, and nothing here.
  const samePath = refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'export function project(file: string, a: unknown, b: unknown): void {\n'
    + '  writeJson(file, a);\n  writeJson(file, b);\n}\n',
  ))).scanFile(WRITE_FIXTURE);
  assert.deepEqual(samePath.divergentPairs, [], 'one destination is not a divergence');

  // Checking the first write makes the pair all-or-nothing.
  const guarded = refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'export function project(file: string, other: string, value: { status: string }): void {\n'
    + '  if (!writeJson(file, value)) return;\n'
    + '  writeJson(other, { status: value.status });\n}\n',
  ))).scanFile(WRITE_FIXTURE);
  assert.deepEqual(guarded.divergentPairs, [], 'a guarded first write cannot diverge from the second');
});

test('rule 4 exempts a cross-artifact compare, not a per-write one', () => {
  const pairWith = (guard: string): RefusalScanResult => refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'declare function readOne(root: string): { hash: string } | null;\n'
    + 'declare function readTwo(root: string): { hash: string } | null;\n'
    + 'export function publish(root: string, a: string, b: string, candidate: { hash: string }) {\n'
    + '  writeJson(a, candidate);\n'
    + '  writeJson(b, candidate);\n'
    + '  const one = readOne(root);\n'
    + '  const two = readTwo(root);\n'
    + `  ${guard}\n`
    + '  return one;\n}\n',
  ))).scanFile(WRITE_FIXTURE);

  // compile.ts#ensureArchitectureRunSnapshot: the two artifacts against each
  // other, so a refusal of either half is caught.
  const cross = pairWith('if (!one || !two || one.hash !== two.hash) throw new Error("torn");');
  assert.deepEqual(cross.divergentPairs, [], 'a cross-artifact compare closes the divergence');
  assert.ok(
    cross.hashVerified.some((site) => site.text.startsWith('cross-artifact')),
    'and the pair is counted as an exemption rather than silently dropped',
  );

  // The shape run-bootstrap-policy#ensureRunBootstrap had when rule 4 was built:
  // one read-back against the candidate. Proves ONE write landed and says nothing
  // about the other, so the pair is still flagged. That is the shape which forced
  // rule 4 to have its own predicate instead of borrowing rule 2's — under rule
  // 2's, this would pass — and it is kept synthetic here precisely so the
  // predicate stays pinned now that the site itself is fixed.
  const perWrite = pairWith('if (!one || one.hash !== candidate.hash) throw new Error("not persisted");');
  assert.equal(perWrite.divergentPairs.length, 1, 'a per-write compare does not close the divergence');
  assert.ok(
    !perWrite.hashVerified.some((site) => site.text.startsWith('cross-artifact')),
    'and must not reach rule 4\'s exemption, though rule 2 still exempts the same function',
  );
});

test('rule 2 does not fire on a writer lookalike, or on a question about writing', () => {
  const lookalike = refusalScanner(sourceTree(publisherFixture(
    'const writeJson = (p: string, c: unknown): boolean => Boolean(p && c);\n'
    + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
    + '  writeJson(p, c);\n  return c;\n}\n',
  )));
  const local = lookalike.scanFile(WRITE_FIXTURE);
  assert.deepEqual(local.writes, [], 'a local helper of the same name is not the fenced writer');

  // stateWritePermitted mutates nothing — it ASKS whether a write would be
  // allowed. Discarding an answer to a question is not this defect, and pulling
  // it in would add noise with no refusal behind it.
  const question = refusalScanner(sourceTree(publisherFixture(
    `import { stateWritePermitted } from ${REAL_FSJSON};\n`
    + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
    + '  stateWritePermitted(p);\n  return c;\n}\n',
  )));
  assert.deepEqual(question.scanFile(WRITE_FIXTURE).writes, [], 'a permission question is not a write');
});

// ── the second writer layer ─────────────────────────────────────────────────

/**
 * THE MEASUREMENT THIS LANE WAS BUILT FROM, made permanent.
 *
 * Two functions were put in one real file, both discarding a boolean and then
 * returning a count — one through the sidecar layer and one through
 * `writeJson`. The fsjson one was reported by name and the sidecar one was not
 * mentioned at all, with the ratchet fully green. Both halves are pinned here,
 * because the A is worthless without the B: a scanner that reports the sidecar
 * site and has quietly stopped reporting the fsjson site has not been fixed.
 *
 * Deliberately over the REAL src/shared/auth/updates-store.ts, so this fails if
 * ANY link in the chain breaks — the shape seed on machine-sidecar.ts, the
 * cross-module import, or the two hops of forwarding fixpoint through
 * `writeStore` that carry the seed out to `recordUpdatesPage`. A stub would
 * prove only that the scanner can read a stub.
 */
test('a discarded refusal in the raw-fs sidecar layer is reported, exactly as the fsjson one is', () => {
  const publisher = (call: string): string => 'export function persistFeed(page: { items: unknown[] }, '
    + `now: number): number {\n  ${call}\n  return page.items.length;\n}\n`;

  const sidecar = refusalScanner(sourceTree({
    [WRITE_FIXTURE]: "import { recordUpdatesPage } from '../auth/updates-store';\n"
      + publisher('recordUpdatesPage(page, now);'),
  })).scanFile(WRITE_FIXTURE);
  assert.equal(
    sidecar.writes.length,
    1,
    'the sidecar write must RESOLVE through machine-sidecar.ts -> writeStore -> recordUpdatesPage, or every '
    + 'assertion below is vacuous',
  );
  assert.equal(sidecar.rawFsWrites.length, 1, 'and it must be attributed to the RAW-FS layer, not the fsjson one');
  assert.equal(sidecar.refusalBlind.length, 1, 'the discarded sidecar refusal must be reported');
  assert.match(sidecar.refusalBlind[0]!.key, /#persistFeed$/);

  // The control. Same shape, same position, the other layer.
  const viaFsjson = refusalScanner(sourceTree({
    [WRITE_FIXTURE]: `import { writeJson } from ${REAL_FSJSON};\n` + publisher('writeJson("p", page);'),
  })).scanFile(WRITE_FIXTURE);
  assert.equal(viaFsjson.refusalBlind.length, 1, 'the fsjson half must still be reported');
  assert.deepEqual(viaFsjson.rawFsWrites, [], 'and must NOT be attributed to the raw-fs layer');

  // revalidate.ts#persistFeed as it reads today: the boolean decides the count.
  const fixed = refusalScanner(sourceTree({
    [WRITE_FIXTURE]: "import { recordUpdatesPage } from '../auth/updates-store';\n"
      + 'export function persistFeed(page: { items: unknown[] }, now: number): number {\n'
      + '  if (!recordUpdatesPage(page, now)) return 0;\n  return page.items.length;\n}\n',
  })).scanFile(WRITE_FIXTURE);
  assert.equal(fixed.writes.length, 1, 'the fixed site still has to RESOLVE, or this row proves nothing');
  assert.deepEqual(fixed.refusalBlind, [], 'consuming the boolean must not be reported');
});

const SHAPE_CASES_RAW_FS: ReadonlyArray<{ label: string; source: string; writer: boolean }> = [
  {
    label: 'writeMachineSidecar itself — the shape, reduced',
    writer: true,
    source: "import * as fs from 'fs';\n"
      + 'export function writeSidecar(p: string, body: string): boolean {\n'
      + '  try {\n    fs.writeFileSync(p, body);\n    return true;\n'
      + '  } catch {\n    return false;\n  }\n}\n',
  },
  {
    label: 'a rename, and a best-effort cleanup inside the catch',
    writer: true,
    source: "import * as fs from 'node:fs';\n"
      + 'export function place(tmp: string, dst: string): boolean {\n'
      + '  try {\n    fs.renameSync(tmp, dst);\n    return true;\n'
      + '  } catch {\n    try { fs.rmSync(tmp, { force: true }); } catch { /* best-effort */ }\n'
      + '    return false;\n  }\n}\n',
  },
  {
    // The refusal channel is what makes a writer, so a function that answers
    // `null` is not one. Admitting it would pull in every lock acquirer in the
    // tree, whose null is CONTENTION — see the note on rawFsRefusalWriterNames.
    label: 'the catch answers null rather than false — a lock acquirer, not a writer',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'export function acquire(p: string): number | null {\n'
      + '  try {\n    fs.mkdirSync(p);\n    return 1;\n  } catch {\n    return null;\n  }\n}\n',
  },
  {
    // The errno channel, deliberately left open. This is the STRONGER signal
    // (it becomes the fail-closed pipeline-handler-crashed deny), and there is
    // no boolean for a caller to drop.
    label: 'the catch rethrows — the errno channel, which is not this rule',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    fs.writeFileSync(p, body);\n    return true;\n'
      + '  } catch (error) {\n    throw error;\n  }\n}\n',
  },
  {
    label: 'no try at all — the errno propagates',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  fs.writeFileSync(p, body);\n  return true;\n}\n',
  },
  {
    // role-evidence.ts, host/plan.ts, token-report/discovery.ts and two others
    // sniff a file's first line this way. A read that failed refused nothing.
    label: 'openSync in READ mode — a read, not a write',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'export function readable(p: string): boolean {\n'
      + "  try {\n    fs.openSync(p, 'r');\n    return true;\n  } catch {\n    return false;\n  }\n}\n",
  },
  {
    label: 'openSync with an EXCLUSIVE CREATE flag — a write',
    writer: true,
    source: "import * as fs from 'fs';\n"
      + 'export function claim(p: string): boolean {\n'
      + "  try {\n    fs.openSync(p, 'wx');\n    return true;\n  } catch {\n    return false;\n  }\n}\n",
  },
  {
    // The `return true` clause is what makes the boolean THE WRITE'S OUTCOME
    // rather than merely a value the catch can also produce. Here `true` means
    // "it was stale" and the unlink is incidental, so `false` is not a refusal
    // report and a caller discarding it is not this defect. Without the clause
    // the shape would admit it, which is why the clause is pinned by this row
    // rather than only by the comment on rawFsRefusalWriterNames.
    label: 'the try path returns a COMPUTED boolean, so false is not the write\'s answer',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'export function reclaimIfStale(p: string, deadline: number): boolean {\n'
      + '  try {\n    fs.unlinkSync(p);\n    return Date.now() > deadline;\n'
      + '  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // The lookalike protection rule 2 already has for fsjson, at this layer.
    label: 'a local object called `fs` that is not the module',
    writer: false,
    source: 'const fs = { writeFileSync: (_p: string, _b: string): void => {} };\n'
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    fs.writeFileSync(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // The write is in a nested callback handed to a function this module cannot
    // see, so nothing here proves it ran inside the `try` at all — a stored
    // callback would make `return true` a lie for an entirely different reason.
    // The descent clause follows CALLS, not scopes, and `withLock` is `declare`d
    // with no body, so there is no local frame to descend into either.
    label: 'the mutation is inside a nested function, not in the try itself',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'declare function withLock(run: () => void): void;\n'
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    withLock(() => { fs.writeFileSync(p, body); });\n    return true;\n'
      + '  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // The DESCENT clause, reduced to one hop. Without it this is the
    // deleteOneSection defect: a real refusal boolean nothing recognises.
    label: 'the mutation is one MODULE-LOCAL call below the try',
    writer: true,
    source: "import * as fs from 'fs';\n"
      + 'function place(p: string, body: string): void { fs.writeFileSync(p, body); }\n'
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    place(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // deleteOneSection's actual depth: the try calls a lock helper, and the
    // helper calls the thing that mutates. A one-hop-only clause would miss it.
    label: 'the mutation is TWO module-local calls below the try',
    writer: true,
    source: "import * as fs from 'fs';\n"
      + 'function place(p: string, body: string): void { fs.writeFileSync(p, body); }\n'
      + 'function guarded(p: string, body: string): void { place(p, body); }\n'
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    guarded(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // The same chain in REVERSE declaration order, and it is what actually pins
    // the fixpoint. Function declarations hoist, so this is ordinary code — and
    // a single forward pass over the declarations resolves nothing from it,
    // because each caller is visited before the callee it depends on. Measured:
    // capping rawFsMutatingLocals at one pass leaves the row above GREEN (both
    // trees declare helper-before-caller, so one pass happens to suffice) and
    // turns only this row red.
    label: 'the two-hop chain declared AFTER its caller — one pass cannot resolve it',
    writer: true,
    source: "import * as fs from 'fs';\n"
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    guarded(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n'
      + 'function guarded(p: string, body: string): void { place(p, body); }\n'
      + 'function place(p: string, body: string): void { fs.writeFileSync(p, body); }\n',
  },
  {
    // The descent is INTRA-MODULE and that is a declared limit, not an
    // oversight: this seed is handed a SourceFile and no tree, so it cannot
    // read the imported module to find out. Pinned so the limit is a fixture
    // rather than a sentence somebody has to remember.
    label: 'the mutation is below an IMPORTED call — outside this module, so outside the descent',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + "import { place } from './elsewhere';\n"
      + 'export function persist(p: string, body: string): boolean {\n'
      + '  try {\n    place(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n',
  },
  {
    // The descent must not degrade into "a local call in a try makes a writer".
    // Nothing below `audit` mutates, so `false` reports no refusal.
    label: 'a module-local call that reaches no mutation is still not a write',
    writer: false,
    source: "import * as fs from 'fs';\n"
      + 'function audit(p: string): number { return p.length; }\n'
      + 'export function persist(p: string): boolean {\n'
      + '  try {\n    audit(p);\n    return true;\n  } catch {\n    return false;\n  }\n}\n',
  },
];

test('the raw-fs writer SHAPE admits a refusal contract and nothing else', () => {
  const fixture = path.join(WRITE_FIXTURE_DIR, 'raw-fs.ts');
  for (const shapeCase of SHAPE_CASES_RAW_FS) {
    const source = sourceTree({ [fixture]: shapeCase.source }).parse(fixture);
    assert.ok(source, `${shapeCase.label}: the fixture must parse`);
    const names = rawFsRefusalWriterNames(source);
    assert.equal(
      names.size > 0,
      shapeCase.writer,
      `${shapeCase.label}: expected ${shapeCase.writer ? 'a writer' : 'NO writer'}, got [${[...names].join(', ')}]`,
    );
  }
});

/**
 * A raw-fs writer must grow LOCAL wrappers the way an fsjson one does.
 *
 * This exists because a mutation survived without it. The resolver used to skip
 * its forwarding fixpoint whenever a file imported no writer AND was not
 * fsjson.ts — correct while fsjson.ts was the only base case, and wrong the
 * moment a file can DECLARE one. Reverting that condition left every test green,
 * because no file in the tree today happens to hold both a raw-fs writer and a
 * local wrapper around it. "No instance today" is exactly the property that
 * expires quietly, and machine-sidecar.ts growing one helper is all it takes.
 */
test('a local wrapper around a raw-fs writer is a writer too', () => {
  const fixture = path.join(WRITE_FIXTURE_DIR, 'raw-local.ts');
  const scanned = refusalScanner(sourceTree({
    [fixture]: "import * as fs from 'fs';\n"
      + 'function writeSidecar(p: string, body: string): boolean {\n'
      + '  try {\n    fs.writeFileSync(p, body);\n    return true;\n  } catch {\n    return false;\n  }\n}\n'
      // `save` names no fs call at all; it is reachable only through the fixpoint.
      + 'function save(p: string, c: unknown): boolean { return writeSidecar(p, JSON.stringify(c)); }\n'
      + 'export function publish(p: string, c: { id: string }): { id: string } {\n'
      + '  save(p, c);\n  return c;\n}\n',
  })).scanFile(fixture);
  assert.ok(
    scanned.writes.length >= 1,
    'the wrapper call must RESOLVE through the local fixpoint, or this test proves nothing',
  );
  assert.equal(scanned.refusalBlind.length, 1, 'the publisher that dropped the wrapper\'s boolean must be reported');
  assert.match(scanned.refusalBlind[0]!.key, /#publish$/);
});

/**
 * LIMIT 3, pinned from both sides so it stays a DECLARED gap rather than an
 * accident somebody closes by widening the writer set into rule 4.
 *
 * Rule 4 keys a destination on `arguments[0]`. That is exact for all eight
 * fsjson writers, every one of which takes the path first, and false for a
 * raw-fs writer whose destination is a constant in its own module. Measured on
 * the real tree: feeding the raw-fs layer to rule 4 produced 7 pairs in
 * updates-store.test.ts, all of them consecutive writes to THE SAME file.
 */
test('rule 4 does not consult the raw-fs layer, because argument[0] is not its destination', () => {
  // updates-store.test.ts's shape: two `recordUpdatesPage` calls, one file.
  const sidecarPair = refusalScanner(sourceTree({
    [WRITE_FIXTURE]: "import { recordUpdatesPage } from '../auth/updates-store';\n"
      + 'export function seed(a: unknown, b: unknown, now: number): void {\n'
      + '  recordUpdatesPage(a, now);\n  recordUpdatesPage(b, now);\n}\n',
  })).scanFile(WRITE_FIXTURE);
  // Non-vacuity FIRST: if the writer stopped resolving, the empty pair list
  // below would be true for the wrong reason, which is how a limit becomes a
  // blind spot.
  assert.equal(sidecarPair.rawFsWrites.length, 2, 'both sidecar writes must RESOLVE as raw-fs writes');
  assert.equal(sidecarPair.discarded.length, 2, 'and both must be seen to be discarded');
  assert.deepEqual(
    sidecarPair.divergentPairs,
    [],
    'two writes to one fixed sidecar file are not a divergent pair, whatever their first arguments say',
  );

  // …and the same two-drop shape through fsjson, where argument[0] IS the
  // destination, must still be reported. This half is what stops the exclusion
  // from being implemented as "rule 4 off".
  const fsjsonPair = refusalScanner(sourceTree(publisherFixture(
    `import { writeJson } from ${REAL_FSJSON};\n`
    + 'export function seed(a: string, b: string, value: unknown): void {\n'
    + '  writeJson(a, value);\n  writeJson(b, value);\n}\n',
  ))).scanFile(WRITE_FIXTURE);
  assert.equal(fsjsonPair.divergentPairs.length, 1, 'rule 4 must still fire on an fsjson pair');
});

// ── completeness: each authority audits its own module ──────────────────────
// See WHAT MAKES A MODULE AN AUTHORITY in the header for the entry criterion
// these two pins enforce, and for why they ask different questions.

/**
 * Every name `source` exports AS A FUNCTION.
 *
 * Both spellings, and the second one is why this is a function rather than the
 * one-line filter it used to be. `export function f()` was the only shape
 * collected, so `export const writeJsonAtomic = (…): boolean => …` would have
 * been an exported writer in neither list, silently — a completeness hole in
 * the guard whose whole job is completeness. A `const` counts when it is bound
 * to an arrow or a function expression, or annotated with a function TYPE
 * (`export const f: (p: string) => boolean = impl`), which covers the
 * indirection an author reaches for when the implementation is chosen at
 * module load.
 *
 * A `const` bound to an OBJECT is deliberately not a function and not here.
 * That is fsjson.ts:530, and it is a different hole with its own pin below.
 */
function exportedFunctionNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const isExported = (node: ts.Node): boolean => (
    (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0
  );
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (statement.name && isExported(statement)) names.push(statement.name.text);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      // getCombinedModifierFlags walks a VariableDeclaration up to its
      // statement, so the `export` on the statement is read from the binding.
      if (!ts.isIdentifier(declaration.name) || !isExported(declaration)) continue;
      const initializer = declaration.initializer ? unwrapExpression(declaration.initializer) : undefined;
      const bindsAFunction = Boolean(initializer
        && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)));
      if (bindsAFunction || (declaration.type !== undefined && ts.isFunctionTypeNode(declaration.type))) {
        names.push(declaration.name.text);
      }
    }
  }
  return names.sort();
}

test('every function fsjson.ts exports is classified as a writer or as a non-writer', () => {
  const source = ts.createSourceFile(
    FSJSON_MODULE,
    fs.readFileSync(FSJSON_MODULE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const exported = exportedFunctionNames(source);
  assert.ok(exported.length > 0, 'the parse found fsjson.ts — an empty set would make this vacuous');

  // The `const` arm has no live instance in fsjson.ts, so it is held by a
  // fixture. Without this the arm could be deleted, or never have worked, and
  // every assertion below would go on passing — which is the exact failure
  // mode the arm was added to prevent.
  const constArm = ts.createSourceFile(
    path.join(SRC_ROOT, 'shared', '__fsjson-const-fixture__.ts'),
    'export function writeJson(p: string, v: unknown): boolean { return Boolean(p && v); }\n'
    + 'export const writeJsonAtomic = (p: string, v: unknown): boolean => writeJson(p, v);\n'
    + 'export const writeJsonVia: (p: string, v: unknown) => boolean = writeJsonAtomic;\n'
    + 'const notExported = (p: string): boolean => Boolean(p);\n'
    + 'export const fsjson = { writeJson };\n',
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(
    exportedFunctionNames(constArm),
    ['writeJson', 'writeJsonAtomic', 'writeJsonVia'],
    'the collector must read an exported const bound to a function, and must not read an object or a local',
  );

  const classified = [...FSJSON_WRITERS, ...FSJSON_NON_WRITERS].sort();
  assert.deepEqual(
    exported,
    classified,
    'fsjson.ts exports a function neither list names. Add it to FSJSON_WRITERS if its'
    + ' false (or its union) can mean REFUSED, or to FSJSON_NON_WRITERS with the reason it'
    + ' cannot. Leaving it out does not fail loudly: it makes every wrapper that forwards'
    + ' only to the new primitive stop being a writer, so those call sites vanish from'
    + ' rules 2-4 and the ratchets go green over a hole.',
  );

  // The two lists must stay DISJOINT: a name in both would let a real writer be
  // excused by its own exculpation, and the union check above cannot see it.
  const overlap = FSJSON_WRITERS.filter((name) => FSJSON_NON_WRITERS.includes(name));
  assert.deepEqual(overlap, [], 'a name cannot be both a writer and a non-writer');
});

/**
 * The OTHER shape an exported const can take, pinned at the count it has today.
 *
 * `export const fsjson: FsJson = { readText, readJson, writeJson }` re-exports a
 * real writer as an object MEMBER, and rules 2-4 recognise a write only when the
 * callee is a bare identifier — so `x.writeJson(…)` reaches no rule at all. The
 * object is live: core/context.ts hands it to `Ctx`, and core/types.ts#FsJson
 * documents that member's `false` as a refusal ("a caller whose next step
 * depends on the write having persisted must branch on this").
 *
 * Measured across src/ + tests/ before this was written: ZERO member calls whose
 * member name is any of the eight writers, and exactly one call through this
 * object anywhere — `ctx.fsjson.readJson(…)` at core/pipeline.ts:121, a read.
 * So the hole is empty, and it is pinned at empty rather than resolved: deciding
 * that `ctx` is a `Ctx` is the type question this file exists to avoid, and the
 * heuristic version ("any `.writeJson(…)` is a write") is the fourth proxy that
 * would mis-sort. See the header.
 *
 * The failure this prevents is a `ctx.fsjson.writeJson(…)` landing in a handler
 * and being invisible to every rule here — the same blindness the raw-fs layer
 * had, through the third door.
 */
test('a writer re-exported as an object MEMBER is reached by no call in the tree', () => {
  const tree = sourceTree();
  const fsjsonSource = tree.parse(FSJSON_MODULE);
  assert.ok(fsjsonSource, 'the parse found fsjson.ts');

  // Which exported const objects carry a writer, and under what member name —
  // read off the module rather than named here, so a writer added to (or taken
  // out of) that literal moves this guard with it.
  const carriers = new Map<string, Set<string>>();
  for (const statement of fsjsonSource.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      // On a VariableDeclaration this walks up to the statement, so the
      // `export` is read from the binding rather than from the node type.
      if ((ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) === 0) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) continue;
      const members = new Set<string>();
      for (const property of initializer.properties) {
        const name = property.name && ts.isIdentifier(property.name) ? property.name.text : '';
        // `{ writeJson }` is shorthand — its name IS the writer's name.
        const shorthand = ts.isShorthandPropertyAssignment(property) ? property.name.text : '';
        for (const candidate of [name, shorthand]) {
          if (candidate && FSJSON_WRITERS.includes(candidate)) members.add(candidate);
        }
      }
      if (members.size > 0) carriers.set(declaration.name.text, members);
    }
  }
  assert.deepEqual(
    [...carriers.keys()],
    ['fsjson'],
    'fsjson.ts re-exports its writers through a const object other than `fsjson`, or has stopped re-exporting '
    + 'them at all. Either way this guard is now aimed at the wrong name — re-derive it before editing anything '
    + 'else, because it silently passes when it is aimed at nothing',
  );

  // A call whose base is that const — spelled bare (`fsjson.writeJson`) or as
  // the last hop of a property access (`ctx.fsjson.writeJson`). Anything else
  // is an object that merely shares the name, and there is none.
  const reached: string[] = [];
  for (const file of [...listTsFiles(SRC_ROOT), ...listTsFiles(TESTS_ROOT)]) {
    const text = tree.read(file);
    if (!text || ![...carriers.keys()].some((name) => text.includes(name))) continue;
    const source = tree.parse(file);
    if (!source) continue;
    const relFile = path.relative(REPO_ROOT, file);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const base = unwrapExpression(callee.expression);
          const baseName = ts.isIdentifier(base)
            ? base.text
            : (ts.isPropertyAccessExpression(base) ? base.name.text : '');
          if (carriers.get(baseName)?.has(callee.name.text)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            reached.push(`  ${relFile}:${line} — ${node.getText(source).split('\n')[0]!.trim().slice(0, 100)}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(
    reached,
    [],
    `${reached.length} call(s) reach a refusal-carrying writer through the re-exported object rather than through `
    + 'an imported identifier. Rules 2-4 key a write on a bare identifier callee, so NONE of them can see these — '
    + 'the refusal is invisible, not merely unchecked. Import the writer directly (`import { writeJson } from '
    + "'../fsjson'`) and rules 2-4 resolve it as they do everywhere else:\n"
    + reached.join('\n'),
  );
});

/**
 * The SECOND authority auditing its own module — the shape-seed counterpart to
 * the fsjson completeness pin above, and a sharper assertion than it can make.
 *
 * machine-sidecar.ts is the sanctioned opt-out from the consent write fence
 * (its :22-42 comment is the "and say so"), which is exactly what made it
 * invisible here until the raw-fs shape was seeded. The shape has no roster to
 * compare against, so completeness is asked the other way round: every exported
 * function that PERFORMS A RAW-FS MUTATION must be admitted by the seed, and
 * every name excused below must be parse-checkably free of one.
 *
 * That second clause is the part the fsjson pin cannot have. There, an
 * unclassified primitive can be silenced by adding it to FSJSON_NON_WRITERS
 * with a plausible sentence; here the excuse is checked against the code, so a
 * mutating function cannot be listed as a non-writer at all. A new sidecar
 * writer written in a shape the seed does not recognise — `catch { return null }`,
 * a mutation pushed below a helper — therefore fails by name rather than being
 * born invisible, which is the whole failure this lane exists for.
 *
 * shared/one-settings.ts, the other raw-fs opt-out, has its own pin below now
 * that the descent clause reaches it. It cannot share this one: two of its
 * exports mutate and are still correct, so "excused means mutates nothing" is
 * an excuse it could not pass and must not be loosened to accommodate it.
 */
const MACHINE_SIDECAR_MODULE = path.join(SRC_ROOT, 'shared', 'auth', 'machine-sidecar.ts');

/** Exported names in that module that mutate nothing — each checked, not trusted. */
const MACHINE_SIDECAR_NON_WRITERS: readonly string[] = [
  'isoNoMs',            // pure: a timestamp format
  'machineSidecarPath', // pure: path arithmetic
  'readMachineSidecar', // read
];

test('every raw-fs mutation machine-sidecar.ts exports is admitted by the shape seed', () => {
  const tree = sourceTree();
  const source = tree.parse(MACHINE_SIDECAR_MODULE);
  assert.ok(source, `the parse found ${path.relative(REPO_ROOT, MACHINE_SIDECAR_MODULE)}`);

  const exported = exportedFunctionNames(source);
  assert.ok(exported.length > 0, 'an empty exported surface would make every assertion here vacuous');

  const admitted = rawFsRefusalWriterNames(source);
  const admittedExports = exported.filter((name) => admitted.has(name)).sort();
  // Non-vacuity, and only that. Deliberately NOT `deepEqual(admittedExports,
  // ['writeMachineSidecar'])`: a second sidecar writer written in the right
  // shape is the outcome this pin wants, and failing on it would be the
  // instrument firing on correct code — the one thing that gets a ratchet
  // switched off. The completeness check below is what catches a wrong one.
  assert.ok(
    admitted.has('writeMachineSidecar'),
    'the shape seed no longer admits writeMachineSidecar. This module IS the second writer authority; if the seed '
    + 'stops recognising it, every call site behind it leaves rules 2-3 silently — check the function still reads '
    + '`try { …fs…; return true } catch { return false }`',
  );

  assert.deepEqual(
    exported,
    [...admittedExports, ...MACHINE_SIDECAR_NON_WRITERS].sort(),
    'machine-sidecar.ts exports a function that is neither admitted by the raw-fs shape nor listed as a '
    + 'non-writer. This module is the sanctioned raw-fs opt-out from the consent write fence, so a writer here '
    + 'that the shape does not admit is INVISIBLE to rules 2 and 3 — not unchecked, unseen. Give it the shape '
    + '(`try { …fs…; return true } catch { return false }`), or add it to MACHINE_SIDECAR_NON_WRITERS if it '
    + 'mutates nothing',
  );

  // The exculpation list is CHECKED rather than believed: a name here must
  // contain no raw-fs mutation of its own. Without this clause the list is an
  // off switch for the assertion above, which is how a hand-maintained
  // exemption stops meaning anything.
  const namespaces = fsNamespaces(source);
  const mutating: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && MACHINE_SIDECAR_NON_WRITERS.includes(node.name.text)
      && node.body && containsHere(node.body, (child) => isRawFsMutation(child, namespaces))) {
      mutating.push(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual(
    mutating,
    [],
    'a name excused as a machine-sidecar NON-writer performs a raw-fs mutation. It cannot be excused: either it '
    + 'carries a refusal (give it the shape, and let the seed admit it) or the mutation belongs somewhere else:\n'
    + mutating.map((name) => `  ${name}`).join('\n'),
  );
});

/**
 * The THIRD authority auditing its own module.
 *
 * one-settings.ts owns ~/.traffic-one/one.json and takes the same sanctioned
 * opt-out machine-sidecar.ts takes — for a session rooted at $HOME the guarded
 * write would deadlock on the consent question — so it reaches raw `fs`
 * directly and was invisible here for exactly as long as the shape required the
 * mutation to sit in the frame that answers. The descent clause on
 * rawFsRefusalWriterNames closes that, and this pin is the other half: a seed
 * without a completeness check is a seed that goes quiet without saying so.
 *
 * TWO EXCULPATION LISTS, because this module needs an excuse the sidecar does
 * not have, and the difference is the whole reason it gets its own test.
 * `updateOneSettings` and `writeOneSection` DO mutate — they are the write path
 * for the auth key — and they are still correct: they answer with a PATH and
 * report failure by THROWING, which is the errno channel this file deliberately
 * leaves open (the rethrow row in SHAPE_CASES_RAW_FS) and which the hook
 * pipeline turns into the non-overridable `pipeline-handler-crashed` deny. A
 * caller cannot drop a refusal that was never a value.
 *
 * Both lists are CHECKED against the code rather than believed, the way
 * MACHINE_SIDECAR_NON_WRITERS is, and the throwing list is checked in BOTH
 * directions: a name on it must really reach a mutation (or it is a
 * non-mutator being filed in the wrong place, and the wrong list would stop
 * asking the question that matters) and must really catch nothing.
 */
const ONE_SETTINGS_MODULE = path.join(SRC_ROOT, 'shared', 'one-settings.ts');

/** Exported names that reach NO raw-fs mutation, by the widened reach. */
const ONE_SETTINGS_NON_MUTATORS: readonly string[] = [
  'oneSettingsPath',          // pure: path arithmetic
  // Pure: the schema predicate `updateOneSettings` throws on, asked off a read
  // the caller already has. Refusal-SHAPED (a reason string, or null when the
  // envelope would accept a write) and reaching no `fs` at all, which is the
  // point of it — override/mint-counter.ts asks whether its own bookkeeping
  // write can land instead of discovering the answer by failing.
  'oneSettingsSchemaError',
  // Pure: classifies an error VALUE the caller already caught, by comparing its
  // `code` to this module's lock-timeout sentinel. It sits on the READING side
  // of the errno channel the paragraph above leaves open — the discriminator a
  // caller uses to recognise the refusal `withMachineFileLock` threw, rather
  // than a refusal of its own that a caller could drop — so it reaches no `fs`
  // by construction: there is no path in it to reach one with.
  'isOneSettingsLockTimeout',
  'readCanonicalOneSettings', // read + validate
  'readOneSettings',          // read
];

/**
 * Exported names that mutate and answer with a path, letting the errno escape.
 * Each is checked to reach a mutation, to declare a non-boolean return, and to
 * contain no `catch` of its own that could turn a failure into a value.
 */
const ONE_SETTINGS_THROWING_MUTATORS: readonly string[] = [
  'updateOneSettings', // the single low-level mutator; throws on lock/schema failure
  'writeOneSection',   // forwards updateOneSettings
  // The lock protocol, lent to a caller whose file is not one.json — today the
  // override audit ledger, which needs the mint's append and its take-back
  // serialised against each other. It reaches a mutation (the lock's own
  // `mkdir`, through the same module-local descent `deleteOneSection` needs),
  // returns whatever its body returns, and catches NOTHING: a lock it cannot
  // take throws at the deadline, exactly like every other write here, and
  // override/token.ts converts that into a refused mint rather than dropping
  // it. There is no refusal boolean for a caller to discard.
  'withMachineFileLock',
];

test('every raw-fs mutation one-settings.ts exports is admitted, excused as a read, or thrown', () => {
  const source = sourceTree().parse(ONE_SETTINGS_MODULE);
  assert.ok(source, `the parse found ${path.relative(REPO_ROOT, ONE_SETTINGS_MODULE)}`);

  const exported = exportedFunctionNames(source);
  assert.ok(exported.length > 0, 'an empty exported surface would make every assertion here vacuous');

  const namespaces = fsNamespaces(source);
  assert.ok(namespaces.size > 0, 'one-settings.ts must still import `fs` as a namespace, or the seed sees nothing');
  const reaches = rawFsMutatingLocals(source, namespaces);
  const admitted = rawFsRefusalWriterNames(source);
  const admittedExports = exported.filter((name) => admitted.has(name)).sort();

  // Non-vacuity, and the reason this pin exists: deleteOneSection is the
  // module's ONE refusal boolean, and it is the site the descent clause was
  // built for. If it stops being admitted, `clearAuthentication` — which
  // consumes it precisely so a rejected key is not silently kept trusted —
  // drops out of rules 2 and 3 without a word.
  assert.ok(
    admitted.has('deleteOneSection'),
    'the shape seed no longer admits deleteOneSection. Its raw write sits BELOW a module-local call, so it needs '
    + 'the descent clause on rawFsRefusalWriterNames; if that clause narrowed, every caller of this module\'s only '
    + 'refusal boolean left rules 2-3 silently',
  );

  assert.deepEqual(
    exported,
    [...admittedExports, ...ONE_SETTINGS_NON_MUTATORS, ...ONE_SETTINGS_THROWING_MUTATORS].sort(),
    'one-settings.ts exports a function that is neither admitted by the raw-fs shape, nor excused as reaching no '
    + 'mutation, nor excused as letting the errno escape. This module is a sanctioned raw-fs opt-out from the '
    + 'consent write fence, so a refusal-carrying writer here that the shape does not admit is INVISIBLE to rules '
    + '2 and 3 — not unchecked, unseen. Give it the shape (`try { …fs…; return true } catch { return false }`), or '
    + 'put it in the list its code can actually pass',
  );

  const wronglyExcused = ONE_SETTINGS_NON_MUTATORS.filter((name) => reaches.has(name));
  assert.deepEqual(
    wronglyExcused,
    [],
    'a name excused as reaching NO raw-fs mutation reaches one. It cannot be excused: either it carries a refusal '
    + '(give it the shape) or the mutation belongs somewhere else:\n'
    + wronglyExcused.map((name) => `  ${name}`).join('\n'),
  );

  // The throwing list, both directions. A name that reaches no mutation does
  // not belong here (it belongs above, where the stricter check applies), and
  // a name that catches something is answering with a value after all.
  const declarations = new Map<string, FunctionLike>();
  const collect = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) declarations.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      declarations.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const notThrowing: string[] = [];
  for (const name of ONE_SETTINGS_THROWING_MUTATORS) {
    const fn = declarations.get(name);
    if (!fn) { notThrowing.push(`${name} — no declaration found`); continue; }
    if (!reaches.has(name)) { notThrowing.push(`${name} — reaches no raw-fs mutation`); continue; }
    if (fn.type && fn.type.kind === ts.SyntaxKind.BooleanKeyword) {
      notThrowing.push(`${name} — declares \`boolean\`, so it HAS a refusal channel`);
      continue;
    }
    if (fn.body && containsHere(fn.body, (child) => ts.isCatchClause(child))) {
      notThrowing.push(`${name} — catches in its own frame, so a failure can become a value`);
    }
  }
  assert.deepEqual(
    notThrowing,
    [],
    'a name excused as letting the errno ESCAPE does not. The excuse is that there is no refusal value for a '
    + 'caller to drop, so a `catch` in its own frame or a `boolean` return retires it — give it the shape and let '
    + 'the seed admit it instead:\n'
    + notThrowing.map((entry) => `  ${entry}`).join('\n'),
  );
});
