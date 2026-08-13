// src/shared/tool-result.ts
// Reads a tool RESULT out of a host hook payload. The counterpart to
// tool-classify.ts, which reads the tool INPUT — and the reason this file exists
// is that the input side got that treatment years ago while the result side never
// did. Four readers were written against one host family each, and a census
// measured what each one actually sees:
//
//   - page-speed named the containers it knew (`stdout`, `output`, …) and missed
//     the hosts that keep a shell result somewhere else — including a GREEN audit,
//     which it then reported as unmeasured;
//   - record-agent's mid-run subagent-failure classifier reads the four wrapper
//     keys and nothing else, so on five of seven hosts a subagent that died is
//     re-recorded as LIVE;
//   - the token logger reads two of those four keys, so its byte accounting is a
//     silent zero almost everywhere;
//   - model-gate reads the flat top level, correct on Cursor only because a
//     capability flag happens to be Cursor-only.
//
// THE SHAPE SPACE IS FIVE FAMILIES, NOT TWO, and the host id does not determine
// which — `windsurf` spans two of them (Devin Local speaks Claude-style payloads;
// legacy Cascade nests everything under `tool_info`), and Copilot's result field
// is not established anywhere in this tree. That last fact is why the text reader
// below is a WALK and not a key list: no list could have covered a key nobody has
// written down.
//
// COPILOT'S RESULT SHAPE IS AN ASSUMPTION. This is the one place that says so, so
// that the constructed fixtures elsewhere can cite it instead of each implying a
// different fact. What it rests on: `src/adapters/__tests__/fixtures/copilot/
// SPIKE.md` states Copilot CLI was unavailable at spike time and that every wire
// shape came from documentation — and it names no result or output field at all;
// `PLATFORMS.md` records Copilot as `e2eSupported: false` with no unattended CLI
// entrypoint, so no recorded payload can exist here either. Four constructions
// exist in the tree, spanning three incompatible envelope FAMILIES — a
// `tool_response` wrapper (agent-model.test.ts's Copilot reuse test), an
// `execution_record` envelope (its Copilot stop tests, and the unnamed-envelope
// rows in shared/__tests__/tool-result.test.ts), a flat `tool_output` key (that
// same file and src/modules/page-speed/__tests__/page-speed.test.ts), and a bare
// top-level `toolTelemetry` with no envelope at all (agent-model.test.ts's direct
// unit call, which implies no fourth family because it is not a host payload) —
// and that spread is the evidence that nobody knows. Measured, the same evidence
// is read out of all of them by every reader that names the INPUT and takes
// whatever remains, or walks by shape. Do not tighten any reader onto one of
// them; establish the shape from a live Copilot install first.
//
// AND COPILOT IS NOT SPECIAL IN THAT RESPECT, which the paragraph above used to
// imply by singling it out. Searched: no recorded tool-result payload for ANY of
// the seven hosts exists in this tree — the adapter fixtures hold session-start
// and pre-tool inputs, not results — so every result payload under test anywhere
// here is CONSTRUCTED, Claude and Cursor included. What separates the hosts is
// how their container spelling was arrived at, not whether a payload was
// captured: `output`/`tool_info`/`tool_response` are DOCUMENTED spellings this
// file names from host documentation and installed wrappers, while Copilot's is
// named nowhere at all. Wherever a reader below says a sensitivity "does not rest
// on the Copilot guess", that is the claim being made and the only one available:
// it reproduces on documented containers too. Never read it as observed SHAPES.
//
// ONE CONSUMER IS SENSITIVE to which one is right, and this enumeration is what a
// future reader will trust, so it states the direction it fails in:
//
//   - the token logger, via `toolResultContainer`: a wrapper is measured, an
//     unnamed envelope is refused, so it books 0 output bytes where it would have
//     booked 565. An UNDERCOUNT, never a wrong count, and it reaches
//     `.traffic-one/token-log.jsonl` and nothing else — that file has no reader
//     anywhere in `src/` (the token-report runner parses host session JSONL) and
//     the writer is behind an opt-in env flag.
//
// TWO OTHERS WERE, and both were closed by giving them the shape instead of a
// container name — recorded here because the reasoning generalizes to the next
// reader that arrives:
//
//   - the mid-run subagent-failure classifier (`record-agent.ts`): its structured
//     verdict was legible under a wrapper and invisible under an envelope, which
//     recorded a dead child as this run's LIVE agent. It now reads
//     `toolResultVerdictSources` below;
//   - `modules/agent-model/model-gate.ts`'s `shellExitFailed`: on an unnamed
//     envelope it fell back to the payload, found no flat status, and answered
//     `false` — a FAILED model-gate command read as PASSING, so the STOP
//     directive was never delivered. FAIL-OPEN, and latent only because that gate
//     is keyed on `availableModelsMustBeCaptured`, which is Cursor-only and Cursor
//     is flat; latent is not fixed, so it reads the same sources now.
//
// THE EXPORTED SURFACE IS EXACTLY WHAT SHIPS. `toolResultFailed` and
// `toolResultExitCode` used to live here with no production consumer at all —
// only this file, its test, and prose that cited them as if they constrained
// something running — and they were deleted rather than left to be trusted. A
// reader added here arrives WITH its consumer.
//
// STRICT vs LENIENT is deliberate and must not be collapsed. `toolResultContainer`
// answers "which value carries the result, with the input stripped out of it" and
// returns null when it cannot tell — the token logger needs that, because the
// lenient fallback would count the tool INPUT into its output-byte total. The
// lenient `toolResultPayload` returns the payload itself when no container is
// named — page-speed needs THAT, because Cursor has no container at all and the
// result text is spread across sibling top-level fields.

import { obj, type Rec } from './obj';

// Claude, Codex and Devin Local. Any of the four spellings, whichever arrives.
const WRAPPER_KEYS = ['tool_response', 'toolResponse', 'tool_result', 'toolResult'] as const;

// OpenCode and Kilo forward `output: { title, output, metadata }`; Cursor puts the
// shell result text in a top-level `output` STRING; Cascade nests the whole tool
// record under `tool_info`. One list, because "does this host name a result
// container" is the only question these three answer.
const CONTAINER_KEYS = ['output', 'tool_info', 'toolInfo'] as const;

/**
 * The tool's INPUT, wherever a host keeps it.
 *
 * Exported because every reader below needs the same answer and a second copy
 * would drift: the walk skips these so a command cannot be read back as if the
 * tool had printed it, the container projection strips them so input bytes are
 * not counted as output bytes, and `toolResultWithoutInput` hands the same
 * exclusion to a caller that must serialize the result rather than flatten it.
 * `output.args` is the case that makes this load-bearing rather than tidy — on
 * OpenCode and Kilo `output` is the RESULT container and its `args` is the
 * INPUT, in the same object.
 *
 * WHEREVER THE KEY IS, at every depth and through arrays as well as records.
 * That used to be true of the value walk only: the projection and the container
 * recursed through `obj()`, which refuses an array, so a spelling one array
 * member down was not excluded by any of the three — measured, `{ content: [{
 * input: { prompt } }] }` handed a whole spawn prompt back as result evidence.
 * The three readers now agree about position as well as about vocabulary.
 *
 * A closed vocabulary, which is what makes naming it legitimate here: hosts have
 * a small, documented set of spellings for the arguments of a tool call, while
 * "result" demonstrably does not.
 *
 * WHERE IT STOPS, and why it must. `role-infer.ts` reads four more spawn-input
 * fields — `message`, `task`, `instructions`, `description` — and they are
 * deliberately absent here. They are not argument spellings; they are content
 * spellings a RESULT uses too (`{ status: 'error', message: 'API usage limit' }`
 * is an ordinary failure envelope), so admitting them would strip real evidence
 * and change what the classifier counts, which is the one thing no widening of
 * this set is allowed to do. The consequence that matters is unchanged and still
 * measured: `{ status: 'error', message: '…API usage limit' }` degrades from
 * `api-limit` to a bare `stopped`, and the run stops rotating off the exhausted
 * model.
 *
 * THE COUNT BESIDE IT WAS STALE, and is re-derived here rather than repeated.
 * "Admitting `message` alone reddens three rows: the membership literal below,
 * the row here recording what the omission costs, and the classifier row" was
 * true when the classifier had one such row. Measured this round with `message`
 * added to the set below: 22 rows across 6 tests in the classifier subset of
 * agent-model.test.ts, plus 2 tests in this file's own suite — the membership
 * literal and the row below. Scope stated because a count without one is how the
 * three happened: this file's suite in full, and the eleven classifier tests of
 * agent-model.test.ts, and nothing else in the repo.
 *
 * WHAT THAT LEAVES OPEN, stated as measured rather than as argued. Nested under
 * `tool_input`/`tool_args` the whole subtree goes by name, and that is how all
 * three hosts reaching the spawn recorder send a brief — `role-infer.ts` reads
 * those spellings out of `toolInput` and `toolInput.payload`, both by name. At
 * the payload's TOP LEVEL they are NOT covered, on Cursor and on the Copilot
 * envelope family both: `adapters/cursor.ts` and `adapters/copilot.ts` each read
 * a top-level `data.message` as prompt text and Cursor passes `raw: data` through
 * verbatim, so there is no structural barrier. Measured end to end, a brief there
 * under any of the four yielded the id a `[t1-replace-agent]` prompt was quoting
 * as retired, and the recorder wrote it into the run registry as the live agent.
 * The trigger is UNOBSERVED — no fixture or corpus entry has a top-level brief
 * field on either host — so the exposure is latent, not demonstrated live.
 *
 * A reader that needs the four covered must exclude them itself; it must not put
 * them here. TWO do, and their exclusions differ because they are asking
 * different questions — both live in `record-agent.ts`, both take the spellings
 * from `role-infer.ts` so neither can drift from what a brief is:
 *
 *   - the spawned-id extractor keeps only a STRUCTURED ID KEY inside a
 *     brief-named subtree and drops the prose around it;
 *   - the failure classifier drops a brief-named string outright, EXCEPT
 *     `message` in a record that reports a decisive verdict of its own, at one of
 *     the two positions `toolResultVerdictSources` reads a verdict from, and only
 *     when that string is not one of the spawn's own briefs VERBATIM. Which is the
 *     position rule this comment used to say did not exist. It does; it is a
 *     CO-LOCATION rule rather than a how-far-down rule, since a flat host puts
 *     the input and the result at one level. The echo half was CONTAINMENT
 *     against every string in the spawn input until it was measured suppressing
 *     genuine host limit messages — nine characters of overlap were enough — and
 *     is identity against the brief positions now. What neither covers is stated
 *     where it is implemented, not here.
 */
export const TOOL_INPUT_KEYS: ReadonlySet<string> = new Set([
  'tool_input', 'toolInput', 'input', 'args', 'arguments', 'tool_args', 'toolArgs',
  'tool_calls', 'toolCalls', 'parameters', 'command', 'cmd', 'shell_command', 'shellCommand',
  'command_line', 'commandLine', 'prompt',
]);

/**
 * The exclusion, applied wherever the key can be — INCLUDING through an array.
 *
 * Recursing only into `obj()` was the shape of a defect rather than a bound: a
 * named input key one array member down was never excluded at all, while the
 * value walk below (`collect`) has always recursed arrays, so the two halves of
 * one mechanism disagreed about whether `content[0].input.prompt` is input.
 * Measured through the real recorder, that gap handed a `[t1-replace-agent]`
 * prompt's quoted corpse back as this run's live agent from a Cursor
 * `content[]` block. `obj()` is engine-wide and refuses arrays on purpose —
 * other fences narrow through it deliberately — so the array case is handled
 * HERE, by the walk that needs it.
 */
function withoutInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutInput(item));
  const record = obj(value);
  if (!record) return value;
  const out: Rec = {};
  for (const key of Object.keys(record)) {
    if (TOOL_INPUT_KEYS.has(key)) continue;
    out[key] = withoutInput(record[key]);
  }
  return out;
}

function firstPresent(record: Rec, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/**
 * STRICT: the value a host uses to carry this tool's result, with the tool input
 * stripped out of it — or null when no host in the known space named one.
 *
 * Null is an admission, not a verdict: a caller that measures a result (the token
 * logger) must report zero rather than measure the payload's input, and a sixth
 * payload family would land here as null until its container is named.
 */
export function toolResultContainer(raw: unknown): unknown {
  const record = obj(raw);
  if (!record) return null;
  const wrapper = firstPresent(record, WRAPPER_KEYS);
  if (wrapper !== undefined) return withoutInput(wrapper);
  const container = firstPresent(record, CONTAINER_KEYS);
  if (container === undefined) return null;
  return withoutInput(container);
}

/**
 * LENIENT: the wrapper when a host sends one, otherwise the payload itself.
 *
 * Cursor and every other flat host spread a result across sibling top-level
 * fields with no container to point at, so a reader that only looked where a
 * container was named would see nothing there — measured, that is precisely how
 * no structured Lighthouse status ever surfaced on Cursor.
 */
export function toolResultPayload(raw: unknown): unknown {
  const record = obj(raw);
  if (!record) return null;
  const wrapper = firstPresent(record, WRAPPER_KEYS);
  return wrapper !== undefined ? wrapper : record;
}

/**
 * The same value with the tool INPUT taken out of it, wherever a host kept it.
 *
 * The third caller of the one exclusion, and the reason it is a projection here
 * rather than a fourth walk elsewhere: a reader that needs the payload with the
 * input removed — not the strings inside it — can use neither of the two above.
 * Two such readers exist, both in record-agent.ts and both narrowed for the same
 * fault in opposite directions: the mid-run failure classifier, which read a
 * spawn prompt's incident vocabulary as the child's, and the spawned-id
 * extractor, which read a prompt's quoted `agent_id` as the child's.
 * Not `toolResultText`, because that walk collects VALUES and a limit can arrive
 * as a KEY (`{ rate_limit_exceeded: true }`); not `toolResultContainer`, because
 * a host that names no container answers null there and a flat host is exactly
 * the case that needs this. Sharing `TOOL_INPUT_KEYS` is what keeps all three
 * readers unable to disagree about what "input" means.
 *
 * A SCALAR is returned unchanged — an unstructured failure STRING is a result
 * legacy hosts really send and there is nothing in one to strip.
 *
 * AN ARRAY IS WALKED, and used not to be. The argument for passing one through
 * was that every spelling in the vocabulary is an object KEY and the one whose
 * value is an array (`tool_calls`) is dropped by name before any member is
 * reached — true of `tool_calls` and false as a general claim, because an array
 * can sit ABOVE a named key just as easily as below one. Measured, `{ content:
 * [{ input: { prompt } }] }` kept the whole prompt, and through the recorder
 * that is a retired agent id coming back as live. A payload that IS an array is
 * walked for the same reason rather than as a special case: it is the degenerate
 * position of the same class, and Claude-family results are content-block lists.
 * The cost is identity — a walked array is a new array — which no consumer of
 * this function depends on.
 */
export function toolResultWithoutInput(value: unknown): unknown {
  return withoutInput(value);
}

/**
 * The records a verdict about THIS tool call can honestly be read out of, split
 * by DEPTH because the two depths do not admit the same evidence.
 *
 * `own` is the result's own top level; `nested` is one level in, the record
 * children that survived the input exclusion. An envelope no host names is
 * ordinary here rather than special: `execution_record`, `tool_output`, `output`
 * and `tool_info` are all just record children, so nothing about this projection
 * depends on knowing which one carried the result. That is the whole reason the
 * classifier stopped being sensitive to the Copilot guess — measured, its
 * structured verdict was legible under `tool_response` and invisible under every
 * other envelope, and a dead child was written back as the run's LIVE agent.
 *
 * ONE LEVEL, and no further. A verdict two levels down belongs to some nested
 * child, and reading it as the tool's own is the mistake this bound exists to
 * refuse; measured, removing the bound reddens a row for every envelope family.
 *
 * AN ARRAY IS TRANSPARENT TO POSITION, and used to be a wall. `obj()` refuses an
 * array, so an array-VALUED child yielded null and was filtered out, and a
 * result that IS an array made `own` null outright — no member of `content[]`
 * was a verdict source anywhere. That is Claude's own result shape and one of
 * Copilot's (`steps[]`), and the co-located brief exclusion in `record-agent.ts`
 * keys off exactly these positions, so the wall had a second consequence one
 * function up: in `{ content: [{ status: 'error', message: '…API usage limit' }] }`
 * the member was not a source, so `message` was dropped as brief prose, so
 * nothing reached the text classifier. Measured end to end through
 * `recordSpawnedAgent` on materialized fixtures, that payload answered null: the
 * dead child stayed registered as this run's LIVE agent and the exhaustion
 * ledger stayed empty, while the byte-identical payload spelling the limit `text`
 * — not a brief spelling, and the value walk has always recursed arrays —
 * retired the agent and condemned the model. A bare top-level array did the
 * same. One rule, observed from two sides.
 *
 * So a LIST COSTS NO LEVEL: a record member of an array sits where the array
 * sits. What it may not do is occupy the OWN position — a member of a list is
 * never the result's own top level — so a member of an own-level array is a
 * NESTED source, and a member of an array deeper than that (an array inside an
 * envelope, or inside another array) is below the sources, exactly as a record
 * two levels down is. That is what keeps the widening away from the fault it
 * looks like: the whole reason the position rule exists is that admitting a bare
 * `error` at every depth let an echoed spawn brief retire a live agent, and a
 * nested source is precisely the depth at which `sourceVerdict` refuses a bare
 * `error`. `{ content: [{ error: 'a deprecation warning' }] }` is still not this
 * tool call failing.
 *
 * The SPLIT is what a caller must not collapse, and it is the difference between
 * this and the single flat list it replaced. A field that names the tool's own
 * outcome at the top level does not automatically name it one level in: measured,
 * treating a nested `error` as the tool's verdict classified
 * `{ metadata: { error: 'a deprecation warning' } }`, `{ results: { error: '1
 * file skipped' } }` and a nested child's own death as THIS tool call failing,
 * and made the answer depend on which child the host happened to serialize
 * first. Each consumer decides what each depth admits and says so; this function
 * only answers WHERE.
 */
export interface ToolResultVerdictSources {
  own: Rec | null;
  nested: Rec[];
}

// The RECORD members of a list, and only those: a member that is itself a list
// is one position further in, which is what keeps this from flattening an
// arbitrarily deep tree into the one level above it.
function listSources(value: unknown): Rec[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => obj(item))
    .filter((child): child is Rec => Boolean(child));
}

export function toolResultVerdictSources(value: unknown): ToolResultVerdictSources {
  const projected = toolResultWithoutInput(value);
  const own = obj(projected);
  // A result that IS a list has no own top level to read a verdict from — an
  // array carries no `status` — but its members are still one position in.
  if (!own) return { own: null, nested: listSources(projected) };
  const nested: Rec[] = [];
  for (const key of Object.keys(own)) {
    const child = obj(own[key]);
    if (child) nested.push(child);
    else nested.push(...listSources(own[key]));
  }
  return { own, nested };
}

function collect(value: unknown, depth: number, out: string[]): void {
  if (depth > 4 || value == null) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, depth + 1, out);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Rec;
  for (const key of Object.keys(record)) {
    if (TOOL_INPUT_KEYS.has(key)) continue;
    collect(record[key], depth + 1, out);
  }
}

/**
 * Every string a tool result carries, in payload order, joined by newlines.
 *
 * A SHAPE, not a list of keys: the one property here that survives a sixth
 * payload family arriving is that an unknown container is still walked, because
 * nothing about the walk depends on what the container is called. Only the tool
 * input is named, and only to keep it OUT.
 */
export function toolResultText(raw: unknown): string {
  const out: string[] = [];
  collect(toolResultPayload(raw), 0, out);
  return out.join('\n');
}

/**
 * A numeric field, or null when the value is a word rather than a number.
 *
 * Exported for the one reader that needs an exit STATUS out of a result
 * (`model-gate.ts`'s `shellExitFailed`): hosts spell `status` and `code` with
 * word statuses (`"completed"`) and error names (`"ENOENT"`) too, and reading
 * either as a number invents one. Shared rather than copied so the reader and
 * this file's own vocabulary cannot disagree about what a code is.
 */
export function toolResultNumeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
