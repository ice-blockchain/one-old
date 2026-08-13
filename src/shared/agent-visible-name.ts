// src/shared/agent-visible-name.ts
// One question, asked in one place: may this FILESYSTEM-SUPPLIED name be
// interpolated into prose an agent reads?
//
// ── THE DEFECT, FOUND TWICE INDEPENDENTLY ────────────────────────────────────
// Several notices name the thing they are about, and the name comes off a disk
// this runtime does not own. `retention.ts`'s announceReducedRoot lists the
// entries a leaked state root holds; `materialize/plan-migration.ts`'s
// planMigrationNotice lists the documents a fold retained. Both sentences end up
// inside a `context(...)` an LLM reads as instructions — retention's through
// session-start's advisory list, the fold's through the onboarding gate. A
// directory name is attacker-controlled in the ordinary case, not the exotic
// one: `.traffic-one/` is COMMITTED state, so cloning a hostile monorepo and
// starting a session is the whole delivery path, and a pull request that adds a
// directory is the other.
//
// Three capabilities land through a raw name, all three measured on the plan
// migration lane before this leaf existed:
//   - a newline (or U+2028, U+2029, U+0085, \v, \f) MANUFACTURES A LINE in the
//     agent's context, which is the unit prose instructions come in;
//   - `<!--` / `-->` is the marker grammar this product's own directives are
//     written in (`<!-- T1BLOCK:BEGIN … -->`, the opencode delegate fences), so
//     a name carrying it can open or close a block the runtime wrote;
//   - the directive prefixes themselves, which several readers key on.
//
// THREE WAS THE COUNT FOR THE LLM ALONE, and the list below names four readers.
// Measured through the real retention notice from an attacker-named leftover in
// a committed `.traffic-one/`, the three above are what an LLM can be walked out
// of and the rest of the readers had nothing:
//   - `\u001b[2K\u001b[1G` (erase line, cursor to column 1) ERASES the
//     `REDUCED —` line on a terminal and rewrites it with the attacker's text.
//     A notice that can be erased is not a disclosure, and this file's whole
//     argument for tolerating an unbounded residue is that the disclosure is the
//     bound on it (see retention.ts's notices census). Every ANSI sequence
//     starts with ESC, so the class is CONTROL CHARACTERS, not a list of
//     sequences — OSC-8 hyperlinks (`ESC ] 8 ; ; url BEL`) ride the same byte.
//   - RLO/LRO/RLM and the isolate block make the DISPLAYED name differ from the
//     real one, which is the attack the header two paragraphs up already treats
//     as motivating: a name that renders as `product.md` and is not.
//   - NUL truncates for a C consumer, ZWSP/BOM/word joiner/soft hyphen render as
//     nothing at all, and a JSON consumer of `notices` re-emits every one of
//     them verbatim.
// So the refusal set is now the union of "can restructure the prose" and "can
// misrepresent what it says": line structure, the marker grammar, the directive
// prefixes, every control character, and the invisibles that change display
// without changing bytes. See the two regexes and their measured cost.
//
// ── REDACT, NOT REFUSE AND NOT ESCAPE ────────────────────────────────────────
// The decision, and why, since all three were live options:
//
// REFUSING the whole notice would drop the disclosure, and the disclosure is the
// entire remedy path on both call sites — a leaked root that is reduced rather
// than healed is only ever reported, never fixed. Dropping the sentence trades a
// prose-injection for a silent unbounded residue, which is the worse of the two.
//
// ESCAPING (backslashes, \u2028 sequences, entity refs) was declined for the
// reason the plan-migration lane declined it: the decoded value has to come back
// out identically for every reader downstream, and the readers here are an LLM,
// a terminal, a JSON consumer of `notices` and a markdown renderer. Four
// independent decoders agreeing is not a property this can hold, and a partial
// decode is a name that reads as a different file.
//
// REDACTING THE SEGMENT is what both lanes chose, for the same reason: the
// sentence carries two things a user can act on — WHICH entry, and WHY — and
// only the first half is compromised. `packages/<unnameable>/architecture.md`
// still says which tree and which document; overwriting the reason instead would
// keep a name nobody can use and lose the part that is actionable. A whole path
// collapses to the placeholder only when the ASSEMBLED value is unsafe after
// per-segment redaction, which no name can do today (no name holds a separator,
// so a grammar cannot straddle one) — written because the check is cheap, not
// because a hole is known.
//
// ── WHAT THE WIDENING COSTS ORDINARY NAMES, MEASURED ─────────────────────────
// A refusal set is only worth having if it refuses nothing a real user has, and
// a NON-LATIN NAME IS AN ORDINARY NAME: a Cyrillic, CJK, Hangul, Greek, Hebrew,
// Arabic or Thai directory is a directory, and redacting one would be a worse
// defect than the one this closes. Measured on two corpora rather than argued.
// EVERY FIGURE HERE IS PER-BASENAME — one count per entry name, which is the unit
// this leaf decides in (`agentVisibleName` takes a name; `agentVisiblePath`
// applies the same question per SEGMENT). The same corpora counted per path give
// different numbers for the same characters, and retention.ts's markdown census
// states both for the two it uses.
//   - 31 hand-built ordinary names — every script just listed, Persian carrying
//     ZWNJ, Devanagari carrying ZWJ, an emoji family sequence, NFD and NFC
//     accents, the Turkish dotted capital I, spaces, an apostrophe, and the
//     whole shell metacharacter set — 0 refused. 35 hostile rows, one per
//     capability above, all 35 refused. Those rows are hand-built, and what a
//     hand-built row can show is that a shape is admitted, never a RATE.
//   - REAL entry basenames in this checkout (node_modules included, `.git`
//     skipped), a corpus nobody chose: 12 refused, all 12 another lane's
//     adversarial fixtures carrying the marker grammar, and 0 of them newly
//     refused by the widening. The size was recorded as 402,608 and is 549,727
//     when re-measured (load 10.03) — the false version is kept because the
//     figure that carries the claim is the TWELVE, which is unchanged and is the
//     same twelve fixtures; a checkout's entry count is a fact about today's
//     `node_modules`, not about this rule.
// The one deliberate cost is TAB, refused as part of the whole C0 block so the
// claim can be "no control characters" rather than a list with an exception in
// it; a tab inside a filename is also a display spoof for a run of spaces.
//
// ── THE REAL COSTS THAT ARE NOT A TAB. FIRST: RTL NAMES CARRYING LRM/RLM ─────
// (The second is the joiner's BOUNDARY arm, below. This heading said "AND ONE REAL
// COST" while the paragraph after it described the joiner rule as free.)
// THE SENTENCE ABOVE USED TO BE THE WHOLE STORY, AND IT WAS TOO STRONG. It read
// as a claim that the widening costs non-Latin names nothing measurable, with two
// corpora behind it — and both corpora are SILENT about the class the claim is
// about. Of the 1,225,599 home-tree basenames, 125 are non-ASCII and NOT ONE
// carries a bidi mark; of the 549,727 in this checkout, 14 are non-ASCII and
// again ZERO carry one (measured, load 10.03). A corpus with no members of a
// class cannot price a refusal of that class.
//
// MEASURED, and it is a cost rather than a hypothesis: `DISPLAY_CONTROL_RE` takes
// LRM (U+200E) and RLM (U+200F) CATEGORICALLY, so 4/4 legitimate mixed-direction
// names render `<unnameable>` — `שלום‎.md`, `‏تقرير-2026.md`, `דוח‎-2026.md`,
// `مشروع‏‌جديد.md` (load 10.03, pinned in retention.test.ts beside the joiner
// rows). Those marks are exactly what an RTL user inserts to make a filename
// mixing Hebrew or Arabic with ASCII digits DISPLAY in the intended order, so
// this is an ordinary name losing its spelling in the one disclosure the residue
// argument rests on. The same names WITHOUT marks are admitted (3/3), so the cost
// is scoped to the mark and not to the script.
//
// THE RULE IS KEPT ANYWAY, and the reason is that the joiner's escape hatch only
// PARTLY transfers — which is less of a contrast than this paragraph used to draw.
// A joiner is refused positionally where the two uses really are disjoint: its
// orthographic job between two letters needs both of them, and a spoof needs an
// ASCII neighbour. It is ALSO refused against a name boundary, where they are not
// disjoint at all (a boundary joiner is Unicode's cursive-form request — see
// joinerSpoof), so the joiner rule has a residue of its own and the claim that its
// positions are disjoint was true of one arm out of two. LRM/RLM have no disjoint
// arm to begin with: they do their legitimate work at exactly the boundary a
// reordering spoof needs, between an RTL letter and an ASCII digit or Latin letter.
// No positional test separates
// them, so the choice really is binary here, and it is made the same way the rest
// of this leaf is: what survives is the notice's INTEGRITY, since a name that
// renders as a different name is worse for the reader than a name that renders as
// `<unnameable>`. What is lost is bounded and disclosed — the entry still occupies
// its own line and is still counted, so a reader learns an entry exists and is
// told they cannot be shown its name.
//
// THE FALSE-REFUSAL RATE ON A REAL RTL TREE IS UNDETERMINED, and no sentence in
// this file may say otherwise. Nobody here has a Hebrew or Arabic home directory
// to walk; how often a real RTL user's filenames carry LRM/RLM is the number that
// would price this trade, and it has not been measured. If it is ever measured
// and it is high, the answer is not a positional test (there isn't one) but a
// different rendering — quoting the name with its bidi marks stripped for DISPLAY
// while refusing to interpolate the original — which is a design this leaf does
// not have and should not grow on a guess.
//
// THE JOINER RULE IS A SECOND REAL COST, not the free narrowing this paragraph
// claimed, and the two halves of its reason are not the same kind of argument.
//
// The claim it replaced was that ZWNJ and ZWJ (U+200C/U+200D) are "NOT refused:
// they are orthographic in Persian, Devanagari and Bengali and structural in emoji
// sequences, so refusing them costs names real users have" — true about a
// CATEGORICAL refusal and false about the question, which is POSITIONAL. MEASURED
// against shipped code, this is what the carve-out was worth to an attacker:
// `product\u200c.md` and `READ\u200dME.md` in a leaked root produced a REDUCED line
// whose DISPLAY reads `'README.md', 'product.md'`. That much stands, and
// `joinerSpoof` refuses both.
//
// WHAT WAS TOO STRONG IS THE REASON: "a joiner with an ASCII neighbour, or one
// against a name BOUNDARY, is doing nothing but hiding." The first disjunct is
// genuinely disjoint — a joiner does orthographic work between two letters of a
// script that needs one, and every such script is outside ASCII. THE BOUNDARY
// DISJUNCT IS NOT. Unicode's joining-form convention puts a joiner exactly there:
// ZWJ before or after an Arabic-script letter requests its cursive initial, medial
// or final form (ZWJ+letter+ZWJ is the medial form, letter+ZWJ the initial). So a
// boundary joiner is BOTH the legitimate use and the spoof, and no positional test
// separates them — the same shape the RTL paragraph above describes for LRM/RLM.
//
// MEASURED through the real leaf (load 3.49): the three names this paragraph used
// to cite as the reason it could not be done are admitted — `می\u200cروم`,
// `क\u200dष.md`, the emoji family sequence, 3/3 — and 4/4 joining-form requests are
// REFUSED, including one inside an otherwise ordinary Arabic name
// (`تقرير-\u200dم\u200d`). So the cost is scoped to the boundary rather than to the
// script, which is the same shape as the RTL row and is why it is recorded beside
// it rather than folded into it.
//
// KEPT ANYWAY, on the same trade as LRM/RLM: what a boundary joiner buys an
// attacker is a name that DISPLAYS as another entry in the one line the whole
// residue argument rests on, and what it costs a user is an `<unnameable>` on a
// line that still exists and is still counted. THE RATE IS UNDETERMINED and no
// sentence here may say otherwise — nobody on this lane has an Arabic-script tree
// to walk, and how often a real filename carries a joining-form request has not
// been measured. The 1.2M-basename corpus below cannot price it either: 125 of
// those names are non-ASCII and NOT ONE carries a joiner at all.
//
// HOMOGLYPHS are the residue that stays, and cannot be closed — a Cyrillic `а` in
// `product.md` is display-identical and is also just a Cyrillic letter. This leaf
// is a defence of the notice's STRUCTURE and of what the notice can be made to
// SAY, and it is not, and cannot become, a proof that a name is what it looks
// like.
//
// Callers that hold a single NAME rather than a path use `agentVisibleName`;
// callers that hold a relative path use `agentVisiblePath`, which redacts
// segment by segment so the surviving segments still locate the entry. That
// asymmetry is deliberate and is what the retention lane needed: dropping the
// whole path would have taken the directory with the file.
//
// Dependency-free and importing nothing, including `path`: a leaf the hook
// runtime can carry, and one whose behaviour does not change with the host
// platform. Both separators are treated as separators for the same reason —
// `retention.ts` builds its relative paths with `path.join`, so they arrive
// spelled the way the platform spells them, while `plan-migration.ts` has
// already normalised to POSIX. A backslash inside a POSIX filename is legal and
// is split here, which changes nothing a reader sees (the parts are rejoined
// with the separator they came with) and cannot hide a grammar, because the
// second check below is over the assembled value.

/**
 * Everything that can END A LINE for some reader we ship or might, plus the two
 * comment delimiters. Deliberately not `\s`: an ordinary space is not a line
 * break and a name holding one is perfectly reportable.
 */
const LINE_STRUCTURE_RE = /[\n\r\u2028\u2029\u0085\v\f]|<!--|-->/;

/**
 * Every C0 control, every C1 control, and DEL. The whole block rather than the
 * interesting members, because "no control characters at all" is a claim a
 * reader can check and "no ESC, no NUL, no BEL, and \t is fine actually" is not.
 * U+001B is the one that motivated it — ESC is the first byte of every ANSI
 * sequence, including the erase-line and the OSC-8 hyperlink — and tab rides
 * along for the simplicity of the sentence, at a cost measured below.
 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Characters that change what a reader SEES without changing what the name IS:
 * the bidi controls (ALM, LRM/RLM, the LRE/RLE/PDF/LRO/RLO block, the isolate
 * block) and the invisibles that have no orthographic job (soft hyphen, ZWSP,
 * word joiner, the invisible math operators, BOM/ZWNBSP).
 *
 * U+200C/U+200D are NOT here, and are not admitted outright either: see
 * `joinerSpoof`, which refuses them in the POSITIONS where they can only spoof.
 *
 * LRM/RLM ARE HERE CATEGORICALLY, AND THAT REFUSES ORDINARY NAMES. 4/4 legitimate
 * mixed-direction RTL filenames are redacted by this line; the header's RTL
 * paragraph carries the measurement, why no positional rule is available for these
 * two the way it is for the joiners, and the fact that the rate on a real RTL tree
 * is undetermined. It is the one row in this leaf whose cost is a real name rather
 * than a tab.
 */
const DISPLAY_CONTROL_RE = /[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]|[\u2066-\u2069]/;

/** ZWNJ and ZWJ, the two invisibles a living orthography actually needs. */
const JOINERS = '\u200c\u200d';

/**
 * Is a joiner sitting where it cannot be doing orthographic work?
 *
 * THE CARVE-OUT WAS NOT AS FORCED AS THE HEADER ABOVE USED TO SAY. It read that
 * refusing U+200C/U+200D "would redact ordinary directory names", framed as a
 * binary between a spoof and a Persian filename — and the choice is not binary.
 * MEASURED on shipped code before this existed: a leaked root holding
 * `product\u200c.md` and `READ\u200dME.md` produced a REDUCED line whose raw
 * bytes are two attacker names and whose DISPLAY reads `'README.md',
 * 'product.md'` — the attack this file's own header calls motivating, in the one
 * line the whole residue argument rests on.
 *
 * A joiner does its orthographic job BETWEEN TWO LETTERS OF THE SCRIPT THAT
 * NEEDS IT, and every script that needs one is outside ASCII: Persian, Arabic,
 * Devanagari, Bengali, and the emoji sequences ZWJ assembles. So the refusal is
 * positional rather than categorical — a joiner with an ASCII neighbour is
 * refused; one between two non-ASCII code units is admitted exactly as before.
 *
 * THE BOUNDARY ARM IS A DIFFERENT ARGUMENT AND HAS A REAL COST, which the reason
 * recorded here used to hide by joining the two with an "or": "a joiner with an
 * ASCII neighbour, OR one against a name boundary, is doing nothing but hiding."
 * The ASCII half is disjoint from the orthographic use. The boundary half is not:
 * Unicode's joining-form convention is exactly a joiner against a boundary — ZWJ
 * before or after an Arabic-script letter requests its medial, initial or final
 * cursive form. MEASURED through this function (load 3.49): 4/4 such requests
 * refused, including one inside an ordinary Arabic name; 3/3 between-letters names
 * admitted. It is kept for the reason LRM/RLM are kept — a leading joiner is also
 * how a name is made to display as another entry in the notice the residue argument
 * rests on — and it is the header's SECOND disclosed cost rather than a free
 * narrowing. The rate on a real Arabic-script tree is UNDETERMINED.
 *
 * WHAT THE NARROWING COSTS, measured rather than argued (see the round record for
 * the files):
 *   - 20 ordinary names including the three the header used to cite as the reason
 *     it could not be done — `می\u200cروم`, `क\u200dष.md`, `👨\u200d👩\u200d👧-photos`
 *     — 0 refused, and 5 spoof spellings all refused.
 *   - 1,225,599 real entry BASENAMES off this machine's home tree (the unit, as
 *     everywhere in this file — per-PATH counts of the same corpus differ), a
 *     corpus nobody chose: ONE refusal in total (`Icon\r`, by the pre-existing
 *     control rule, correctly), and ZERO newly refused by this rule.
 * THE LIMIT ON THAT SECOND FIGURE, stated because a corpus's shape is part of its
 * result: 125 of those names are non-ASCII and NOT ONE carries a joiner at all.
 * So it is strong evidence the narrowing is free on a Western tree, and it is no
 * evidence whatever about an Arabic or Hebrew filename carrying LRM/RLM, or about
 * any real Persian or Devanagari tree. The three script rows in the suite are
 * hand-built, and they are the only evidence in that direction.
 *
 * A surrogate half counts as non-ASCII, which is what admits the emoji family
 * sequence; two adjacent joiners each see the other as a non-ASCII neighbour, so
 * a run of them between non-ASCII letters is admitted too. HOMOGLYPHS remain out
 * of scope and cannot be closed: a Cyrillic `а` is display-identical to an ASCII
 * one and is also just a letter.
 */
function joinerSpoof(value: string): boolean {
  for (let at = 0; at < value.length; at += 1) {
    if (!JOINERS.includes(value[at]!)) continue;
    if (at === 0 || at === value.length - 1) return true;
    if (value.charCodeAt(at - 1) < 0x80 || value.charCodeAt(at + 1) < 0x80) return true;
  }
  return false;
}

/**
 * Directive grammar this runtime's own readers key on. The comment delimiters
 * above already refuse the well-formed spellings; these refuse the bare
 * prefixes, which several call sites match without the fence around them.
 */
const RUNTIME_DIRECTIVE_MARKERS: readonly string[] = [
  'T1BLOCK:',
  'opencode-delegate:',
  'traffic-one-verification:',
  'traffic-one:migrated',
];

/** The one thing this module ever says instead of a name. */
export const UNNAMEABLE = '<unnameable>';

/**
 * Is this value unsafe to interpolate into a line an agent reads?
 *
 * Exported because a caller sometimes needs the QUESTION rather than the
 * rendering — a refusal path that must decide whether to report at all, or a
 * test asserting that an ordinary name is not being redacted for nothing.
 */
export function unsafeInAgentProse(value: string): boolean {
  if (LINE_STRUCTURE_RE.test(value)) return true;
  if (CONTROL_RE.test(value) || DISPLAY_CONTROL_RE.test(value)) return true;
  if (joinerSpoof(value)) return true;
  return RUNTIME_DIRECTIVE_MARKERS.some((marker) => value.includes(marker));
}

/**
 * One filesystem entry NAME, rendered for prose: itself, or the placeholder.
 *
 * A name cannot be redacted "partially" — there is no smaller unit that still
 * identifies the entry — so this is the whole-or-nothing case, and the caller
 * keeps its reason string either way.
 */
export function agentVisibleName(name: string): string {
  return unsafeInAgentProse(name) ? UNNAMEABLE : name;
}

/**
 * A RELATIVE PATH, rendered for prose SEGMENT BY SEGMENT, so a hostile name deep
 * in a tree does not cost the user the part of the path that locates it.
 *
 * The second check is over the ASSEMBLED value, not only over its segments: a
 * grammar straddling a separator would pass a per-segment pass. It cannot be
 * built out of two names today, which is the reason to write the check rather
 * than the reason to leave it out.
 *
 * SO IT IS AN UNREACHABLE LINE, deliberately, and that is recorded here because
 * the alternative is someone measuring it as a hole. Replacing the return with a
 * bare `return rendered;` leaves the whole fence green, and no fixture can red
 * it: every member of the refusal set is either a single character (which lands
 * inside one segment) or `<!--`/`-->`/a directive prefix, none of which contains
 * a separator, so no assembled value can be unsafe once every segment is safe.
 * A mutation survivor here is the check being cheap insurance against a future
 * member that DOES straddle, not a missing test.
 */
export function agentVisiblePath(relPath: string): string {
  const rendered = relPath
    .split(/([/\\])/)
    .map((part) => (part === '/' || part === '\\' ? part : agentVisibleName(part)))
    .join('');
  return unsafeInAgentProse(rendered) ? UNNAMEABLE : rendered;
}
