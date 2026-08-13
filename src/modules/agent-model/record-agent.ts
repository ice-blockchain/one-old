// src/modules/agent-model/record-agent.ts
// PostToolUse spawn recorder: capture the agent id the host's spawn tool
// returned and persist it in the per-run registry
// (.traffic-one/runs/<runId>/agents.json). The PreToolUse reuse gate reads the
// registry to deny duplicate same-role spawns, so a role's later tasks continue
// the SAME agent instead of re-loading rules+skills per spawn.
// Claude's Agent tool result footer prints `agentId: <id> (use SendMessage …)`;
// Copilot is ASSUMED to report `agent_id` in tool telemetry — see the Copilot
// disclosure in shared/tool-result.ts, which is why no reader here is allowed to
// name the envelope: the id extractor takes whatever is left after the input and
// the spawn brief are excluded BY NAME, and the failure classifier reads a
// structured verdict at the payload top level or one level inside whatever
// envelope carried it. The result is matched tolerantly (string, content blocks,
// or nested object).

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { context, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { exhaustedModelsForRole, markModelExhaustionTerminal, recordExhaustedModel } from './exhausted-models';
import { classifyModelFailureText, type ModelFailureKind } from './failure-classify';
import { modelMatchesExpected } from '../../shared/model-tiers';
import { modelUnavailablePromptRequest } from '../../shared/prompt-request';
import {
  REPLACE_AGENT_MARKER,
  hookSessionIdentity,
  isCursorToolSubagentId,
  isResumeCapableAgentId,
  markRunAgentReplaced,
  readEffectiveState,
  recordRunAgent,
  subagentContinuationAvailable,
} from '../../shared/state';
import { SPAWN_BRIEF_KEYS, inferTrafficOneSpawnRoleEvidence } from './role-infer';
import { markModelChoicePrompted, readModelChoice } from './model-choice';
import { persistCorrelatedCursorPostToolFailure } from './cursor-failures';
import { readRunModelPolicy, resolveRunPolicyFallback } from '../../shared/run-model-policy';
import { toolResultPayload, toolResultVerdictSources, toolResultWithoutInput } from '../../shared/tool-result';

// The id Claude prints in the Agent tool result footer (`agentId: <id>`), ALSO
// matching the structured-JSON spelling (`"agentId":"<id>"`) since the payload
// is scanned as serialized JSON. Anchored on the labelled form only — a bare
// hex scan would false-positive on shas in the agent's reply.
// `agent_?id` covers Codex's snake_case spawn result (`{"agent_id":"…"}`) —
// camelCase-only matching left the registry empty on Codex, disabling the
// duplicate-spawn gate exactly where collaboration continuation is native.
// Leading `\b` so `subagent_id`/`subagentId` (a spawn-INPUT key Cursor may echo in the
// post payload) cannot match via the `agent_id` substring and capture the wrong id.
const AGENT_ID_RE = /\bagent[_ ]?id['"]?\s*[:=]\s*['"`]?([A-Za-z0-9][A-Za-z0-9._-]{5,63})/i;
const CURSOR_AGENT_UUID_RE = /\bAgent ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const CURSOR_LINK_UUID_RE = /\]\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i;

function collectResponseText(response: unknown): string {
  if (typeof response === 'string') return response;
  const direct = obj(response);
  if (!direct) {
    if (response == null) return '';
    try { return JSON.stringify(response); } catch { return ''; }
  }
  const chunks: string[] = [];
  if (typeof direct.text === 'string') chunks.push(direct.text);
  const content = direct.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      const b = obj(block);
      if (b && typeof b.text === 'string') chunks.push(b.text);
    }
  }
  try { chunks.push(JSON.stringify(direct)); } catch { /* ignore */ }
  return chunks.join('\n');
}

// The classifier's text: the SAME collection, over the payload with the tool
// input AND the spawn brief's prose removed. Composed rather than reimplemented,
// so every evidence path the collector above has survives byte for byte — a bare
// failure STRING (the documented text fallback for a legacy host, which stays a
// string through both projections), a `text` field, `content[].text` blocks, and
// vocabulary carried by a KEY rather than a value (`{ rate_limit_exceeded: true }`),
// which only the serialized form ever shows.
//
// Handing the classifier `toolResultText` instead would have been one line and
// would have closed the same false positive, but measured it also answers '' for
// the string (its walk starts by demanding a record) and drops the key (its walk
// collects values), and both of those are failure detections that ship today.
// `echo` is REQUIRED rather than defaulted. Both callers have the spawn input in
// hand, and a default would let a third one ship with the echo discriminator
// silently unwired — a shape only a call-site mutant can find, since the
// discriminator's own tests keep passing. A missing argument is a compile error.
function collectResultText(response: unknown, echo: ReadonlySet<string>): string {
  return collectResponseText(withoutBriefProse(toolResultWithoutInput(response), 'own', echo));
}

/**
 * The spawn input's BRIEFS, normalized — the second copy that makes an ECHO
 * detectable, and not the input's every string, which is what the previous round
 * compared against.
 *
 * The classifier's last residual is a brief the host echoes into the result,
 * under `message`, beside a genuine failure: `{ status: 'error', message: '<a
 * brief that mentions a limit>' }` is byte-identical to the envelope every host
 * spells a real limit in, so no rule reading the RESULT alone can separate them.
 * The premise that puts the brief there is that the host echoed it, and an echo
 * has an original: the same payload carries the tool input, which the recorder
 * already reads to infer the role. That premise stands and is kept — it is the
 * same principle as the `[t1-replace-agent]` marker, evidence from OUTSIDE the
 * ambiguous string. The INSTRUMENT built on it did not, and this is that
 * correction; a denylist of spellings can only forbid what someone was already
 * defeated by, and bare containment over every input string is one.
 *
 * WHAT SHIPPED, AND WHAT IT COST — with the falsified claim recorded beside the
 * correction, because the previous round wrote the opposite down as measured. It
 * collected every string in `tool_input` to depth 4 and asked whether the result
 * string was CONTAINED in one, and recorded that as safe because "a genuine
 * failure message is only ever suppressed when the prompt already contained that
 * message verbatim, which is the ambiguity itself". Both halves are false:
 *
 *   - containment is not verbatim, and NINE normalized characters are enough.
 *     Measured: `message: 'API limit'` is suppressed by the ordinary brief
 *     'Refactor the API limit banner component.', and so are
 *     'rate_limit_exceeded', 'quota exceeded', 'rate-limited' and 'API usage
 *     limit' by product briefs that merely name them — 5 of 81 (brief ×
 *     message) pairs over a 9 × 9 matrix of each. Whitespace folding alone flips
 *     a raw-false containment to true, and `model-unavailable` is suppressible
 *     on the same rule, so a child whose TASK IS ABOUT rate limiting had
 *     api-limit classification disabled for its whole life;
 *   - and the haystack was never the brief. Measured, suppression fired from
 *     `model`, from `agent_type`, from a key no reader names, from a nested
 *     object at depths 2, 3 and 4, and from inside an array.
 *
 * WHICH LANDS ON THE RESPAWN THE PRODUCT PRESCRIBES, which is what makes it a
 * blocker rather than a rough edge. Driven end to end through
 * `recordSpawnedAgent` on a materialized Copilot project: limit #1 with an
 * ordinary brief classified `api-limit` and entered the run's exhaustion ledger;
 * limit #2 with a byte-identical result and a respawn brief quoting the incident
 * ('The previous senior-frontend hit an API usage limit' — this suite's own
 * REPLACEMENT_BRIEF, and what the recorder's directive tells the orchestrator to
 * re-send) classified `stopped`, and the ledger did not grow. Rotation degraded
 * with every rotation, which is the one direction it may not degrade in.
 *
 * SO THE TEST IS IDENTITY AND THE HAYSTACK IS THE BRIEF. A result string is an
 * echo when it EQUALS, normalized, one of the strings `role-infer.ts` reads as
 * this spawn's brief — `toolInput[key]` and `toolInput.payload[key]` over
 * `SPAWN_BRIEF_KEYS`, the same positions and the same vocabulary as the role
 * reader, so the two cannot drift about what a brief is. No host failure
 * sentence equals a whole spawn brief, so nothing a host reports is suppressible
 * by this; what is suppressible is a verbatim copy of the brief, re-indented and
 * re-cased or not, which is what an echo IS.
 *
 * WHAT NARROWING IT COSTS, stated as a row and not as a hope: a TRUNCATED echo
 * is no longer detected. Containment matched one and identity does not, so the
 * row that pinned it now expects `api-limit`. That costs the KIND on a child the
 * result already reports dead — never a live agent, which the decisive-position
 * gate below owns — while the containment that bought it cost the classification
 * of every genuine limit on a rotation respawn.
 *
 * AND WHAT THE NORMALIZATION COSTS, which is the half identity cannot argue away.
 * Folding whitespace and case is what makes a re-indented, re-cased echo still an
 * echo, and it is also what lets a SHORT GENERIC brief collide with a host failure
 * sentence: a spawn whose whole brief is "The model gpt-5.6-terra-medium is not
 * enabled" makes a genuine host report of exactly that string an echo, and the
 * limit degrades to `stopped`. The suite pins that cell deliberately — it is the
 * same row that proves the mechanism works — so this is a declared price, not a
 * surprise.
 *
 * IT IS ALSO IRREDUCIBLE FROM THE RESULT, and the alternatives were measured
 * against that rather than assumed away. Requiring the brief to be longer than
 * some floor buys nothing: the colliding case is precisely the short brief, and no
 * length constant in this tree could be grounded in anything. Refusing to suppress
 * a brief that is ITSELF only limit vocabulary inverts the ambiguity rather than
 * resolving it — in that cell the two readings are byte-identical, which is what
 * being an echo of that brief MEANS. What is left is the direction, and it is the
 * one this file argues for everywhere else: identity errs toward `stopped`
 * (under-condemning a model on a child the result already reports dead) rather
 * than toward `api-limit`, and a wrongly exhausted model can drive a role to
 * terminal exhaustion and stop the build.
 */
function normalizeEcho(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

const NO_SPAWN_BRIEF: ReadonlySet<string> = new Set();

function spawnInputEcho(toolInput: unknown): ReadonlySet<string> {
  const record = obj(toolInput);
  if (!record) return NO_SPAWN_BRIEF;
  const payload = obj(record.payload) || {};
  const briefs = new Set<string>();
  for (const key of SPAWN_BRIEF_KEYS) {
    for (const value of [record[key], payload[key]]) {
      if (typeof value !== 'string') continue;
      const normalized = normalizeEcho(value);
      if (normalized) briefs.add(normalized);
    }
  }
  return briefs;
}

function isEchoOfInput(value: string, echo: ReadonlySet<string>): boolean {
  return echo.has(normalizeEcho(value));
}

// The markers Traffic One puts in its OWN spawn briefs. No host result contains
// one, which is what makes a string carrying one a brief no matter where it sits.
const TRAFFIC_ONE_SPAWN_MARKER_RE = /\[t1-replace-agent\]|\[t1-role:/i;

// What a brief-named SUBTREE is allowed to contribute, shared by the two readers
// below because the recursion is the same and only the surviving leaves differ.
// The record SHELL and its keys always survive — `{ rate_limit_exceeded: true }`
// is the API-limit vocabulary with no string value anywhere, and only the
// serialized keys carry it — as do non-string primitives. Prose does not: a
// string inside a brief is part of the brief, at any depth and inside any array,
// which is the respelling that reopened the id defect.
//
// THE OUTER WALKS NOW AGREE WITH THIS ONE ABOUT ARRAYS, and their disagreement
// was the defect that reopened it a second time. This half mapped into arrays
// from the day it was written while both callers below recursed through `obj()`,
// which refuses one — so a brief-named key one array member down was never
// reached by the exclusion that was supposed to find it, and the subtree rule
// here never ran. Measured through the recorder, a brief inside
// `execution_record.steps[]` handed its quoted corpse to the registry as this
// run's live agent, and an ordinary first-spawn brief in the same position
// retired a live one.
function briefSubtree(value: unknown, keepString: (key: string) => boolean): unknown {
  if (typeof value === 'string') return null;
  if (Array.isArray(value)) return value.map((item) => briefSubtree(item, keepString));
  const record = obj(value);
  if (!record) return value;
  const out: Rec = {};
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (typeof child === 'string') {
      if (keepString(key)) out[key] = child;
      continue;
    }
    out[key] = briefSubtree(child, keepString);
  }
  return out;
}

/**
 * The projection the failure CLASSIFIER reads its text out of: the spawn brief's
 * PROSE removed, its structure left alone.
 *
 * The shared vocabulary stops one step short of covering these four spellings on
 * purpose — `message`, `task`, `instructions` and `description` are content
 * spellings a RESULT uses too, so admitting them to `TOOL_INPUT_KEYS` would
 * delete evidence page-speed and this classifier both read. The remedy the head
 * of `shared/tool-result.ts` names is that a reader needing them covered excludes
 * them itself, and the reason this reader now does is that NOT doing so fires on
 * an ordinary first-spawn product brief:
 *
 *   Build the billing screen. If the provider returns an API usage limit
 *   error, show a retry banner and back off.
 *
 * Measured end to end on materialized fixtures, that brief at the payload's TOP
 * LEVEL under any of `message`/`task`/`instructions`/`description`, with the
 * result explicitly reporting `execution_record: { status: 'running' }`,
 * classified `api-limit` on Copilot: the LIVE subagent was retired from
 * `.traffic-one/runs/<runId>/agents.json`, the orchestrator was told to respawn,
 * and `composer-2.5-fast` — a model that never hit a limit — was written into the
 * run's exhaustion ledger. On Cursor the mirror landed in the DURABLE observation
 * ledger: two runs byte-identical but for where the brief sat classified `generic`
 * nested and `api-limit` at the top level.
 *
 * A CO-LOCATION rule, and the previous round was wrong that no position rule
 * exists. It is not a DEPTH rule in the sense of "how far down" — a flat host puts
 * the input and the result at one level, and `toolResultPayload` destroys that
 * distinction anyway by unwrapping a wrapper — but a record either reports a
 * decisive verdict OF ITS OWN or it does not, and that is a position fact this
 * reader can check:
 *
 *   - a brief-named string in a record with no decisive verdict is dropped. The
 *     previous round justified that with "there is nothing for a `message` to be
 *     the message OF", and that sentence was FALSE: measured, `{ message: 'you
 *     have hit your API usage limit' }` with no status anywhere is a status-less
 *     failure record that this reader used to classify and now answers null for.
 *     The rule is kept anyway, as a TRADE rather than a definition — see the
 *     status-less rows in agent-model.test.ts, which price both directions;
 *   - with one, only `message` survives: it is the one of the four that names an
 *     error envelope's own text (`{ status: 'error', message: 'API usage limit' }`
 *     is the shape every host spells a failure in), and nothing in this tree
 *     reports a failure through `task`, `instructions` or `description`. Defaulting
 *     to DROP is deliberate — a spelling added to `role-infer.ts` is closed here
 *     without a second edit, which is the opposite of the denylist this would be
 *     if the exception set were the default;
 *   - never a string carrying one of Traffic One's OWN spawn markers, which no
 *     host result contains. That is the discriminator that keeps a
 *     `[t1-replace-agent]` replacement brief out even where it is co-located;
 *   - and never a string that IS one of this spawn's briefs, because an echo has
 *     an original. Identity against the brief positions, not containment against
 *     every input string: see `spawnInputEcho` above for what the containment
 *     version suppressed, measured, and what identity costs instead.
 *
 * DECISIVE MEANS WHAT `structuredOutcome` MEANS BY IT, at the same two positions,
 * which is the second half of this round's fix and was the sharper defect. This
 * test used to admit a bare `error` at EVERY depth while the classifier one
 * function down refuses one at every depth but its own — so the two halves of one
 * classifier disagreed about what a verdict IS, in the fail-open direction.
 * Measured end to end, `{ metadata: { error: 'a deprecation warning', message:
 * '<a first-spawn brief>' }, execution_record: { status: 'running' } }` retired a
 * LIVE Copilot agent and wrote `composer-2.5-fast` into the run's exhaustion
 * ledger, with nothing failed anywhere and the child explicitly running. The
 * shipped fix mirrors the split exactly — `own` admits a bare error, a nested
 * source does not, and anything below the sources is not decisive at all. A LIST
 * COSTS NO LEVEL: a record member of an own-level array is a nested source (so a
 * bare `error` in one is still not a verdict), and a member of an array deeper
 * than that is below the sources. That last clause used to read "including
 * everything under an ARRAY, which is never a verdict source", and it was the
 * defect rather than the bound — see the corpus paragraph below.
 *
 * That is what makes the boundedness claim TRUE rather than hopeful, and it did
 * not hold before: brief prose can now only survive in a record whose verdict
 * `structuredOutcome` itself reads, so whenever a surviving brief reaches the
 * text classifier the payload's structured outcome is `failure` — the child is
 * dead by its own report — and where the outcome is success or silence no brief
 * is left to read. A brief cannot retire a live agent from any position. What the
 * residual still costs is the KIND: `stopped` upgraded to `api-limit`, which
 * condemns the dead agent's model in the run's exhaustion ledger.
 *
 * "LOSES ONLY THE KIND" IS NOT A LESSER COST, and this paragraph used to be built
 * on the opposite claim: it priced 98 of 119 moved rows as losing "the KIND ONLY",
 * offered as materially cheaper than losing the classification, on the reasoning
 * that the agent is retired and the orchestrator told to respawn either way.
 * FALSIFIED, in this tree, at `model-rotation.ts`: the rotation is resolved from
 * `exhaustedModelsForRole` — the ledger — and that file's own comment records why
 * resolving it any other way "would hand back the very model we're rotating off".
 * A missing ledger entry does not cost a label; it removes the only input that
 * stops the resolver re-selecting the model that just died. Driven end to end on a
 * materialized Copilot fixture: a limit under `task` beside `status:'error'`
 * retires the agent with an EMPTY ledger, and `resolveRunPolicyFallback` then
 * resolves the highest tier to `gpt-5.4` — the model that had just hit the limit —
 * where the same limit under `message` condemns it and routes to `gpt-5.3-codex`.
 * (Figures from this repo's own frozen policy fixture; a different tier row gives
 * different slugs and the same mechanism.)
 *
 * SO THE SPLIT IS RE-DERIVED, and the two costs it separates are NOT the same
 * rule. Over a 1,680-row corpus — position (10 structural positions) × verdict
 * signal in the same record (6) × the key the limit arrives under (the four brief
 * spellings plus `text` as the non-brief control) × sibling verdict (3) ×
 * strictness (2), which is what the count is a count OF and nothing more general —
 * comparing every brief-carried row against the byte-identical row carrying the
 * same limit under `text`:
 *
 *   - the POSITION rule (carrier `message`) costs 60 rows, and every one of the 60
 *     loses the CLASSIFICATION ENTIRELY. None loses "the kind only", and that is
 *     the equivalence rather than a coincidence: a `message` is dropped exactly
 *     where its record's own verdict is unread, and a payload with no verdict
 *     anywhere classifies null. So the position rule's price is a dead child left
 *     registered as live — visible, and never a quiet ledger gap;
 *   - the brief VOCABULARY rule (`task`, `instructions`, `description`) costs 450
 *     rows, 270 of which lose the kind only — retired, ledger empty, rotation free
 *     to re-select the dead model — and 180 the whole classification. This is
 *     where the previous round's "98 lose the kind only" actually lived: it was
 *     pricing the vocabulary rule and attributing the number to the position rule.
 *     Nothing in this tree reports a failure through those three spellings, which
 *     is the reason they default to DROP; the cost is now stated as what it is.
 *
 * And the positions are NOT confined to hosts that never reach this recorder,
 * which an earlier round's reachability note claimed by naming only `output` and
 * `tool_info`. `content[]` is Claude's own result shape and `steps[]` is one of
 * Copilot's; both reach here, and both are now verdict positions rather than blind
 * spots. What remains lost is a limit under `message` in a record this reader will
 * not take a verdict from — below the sources, or a list inside one — because
 * attributing a nested child's limit to the parent in the KIND dimension is the
 * same mistake as attributing its `error` in the RETIREMENT dimension.
 *
 * A brief-named subtree that is not a string keeps its structure and its keys and
 * loses every string leaf. That is the same respelling this reader's sibling
 * closed for ids: a brief arriving as `{ text: … }`, `[ … ]` or `content[]`
 * blocks is still a brief. The cost is stated where the id extractor states its
 * mirror: a genuine result envelope named `task` — Copilot's tool is itself called
 * `task` — keeps its structured verdict, which `structuredOutcome` reads
 * independently, and loses its prose. No shape in this tree reports through one.
 */
/**
 * WHERE a record can be decisive: exactly the positions `toolResultVerdictSources`
 * reads a verdict from, spelled the same way so the two cannot drift.
 *
 * `own` is the result's own top level and admits a bare `error`; `nested source`
 * is one record deeper and does not; everything else is BELOW the sources and is
 * never decisive at all.
 *
 * A LIST COSTS NO LEVEL, mirroring the same rule in `toolResultVerdictSources`.
 * A record member of an array sits where the array sits, except at the payload's
 * own level, where it is demoted to a nested source — a member of a list is
 * never the result's own top level. A member that is itself a list is below the
 * sources, which is where a record two levels down already is. That demotion is
 * what makes recovering `content[]` safe rather than a reopening of the fault the
 * position rule exists for: at a nested source `sourceVerdict` refuses a bare
 * `error`, so a brief co-located with one inside `content[]`/`steps[]` is still
 * not decisive and still cannot retire a live agent.
 */
type ProseDepth = 'own' | 'nested source' | 'below the sources';

function recordIsDecisive(record: Rec, depth: ProseDepth): boolean {
  if (depth === 'below the sources') return false;
  return sourceVerdict(record, depth === 'own') !== null;
}

function withoutBriefProse(value: unknown, depth: ProseDepth, echo: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    const memberDepth: ProseDepth = depth === 'own' ? 'nested source' : depth;
    return value.map((item) => withoutBriefProse(item, Array.isArray(item) ? 'below the sources' : memberDepth, echo));
  }
  const record = obj(value);
  if (!record) return value;
  const decisive = recordIsDecisive(record, depth);
  const childDepth: ProseDepth = depth === 'own' ? 'nested source' : 'below the sources';
  const out: Rec = {};
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (!SPAWN_BRIEF_KEYS.includes(key)) {
      out[key] = withoutBriefProse(child, childDepth, echo);
      continue;
    }
    if (typeof child === 'string') {
      const kept = decisive
        && key === 'message'
        && !TRAFFIC_ONE_SPAWN_MARKER_RE.test(child)
        && !isEchoOfInput(child, echo);
      if (kept) out[key] = child;
      continue;
    }
    out[key] = briefSubtree(child, () => false);
  }
  return out;
}

/**
 * The projection the spawned-ID extractor reads: a brief's prose removed, a
 * STRUCTURED ID KEY inside one kept.
 *
 * Losing nothing is what makes the divergence from the shared vocabulary
 * affordable HERE. Of the three hosts that reach this recorder, none reports a
 * spawned id in one of these fields: Claude sends `agentId` and the `agentId:`
 * footer inside `content[]`, Cursor an `Agent ID:` line in the top-level
 * `output`, Copilot an `agent_id` in its telemetry record. What they DO carry is
 * the brief — measured, a Cursor or Copilot payload with the brief at the TOP
 * LEVEL under any of the four yielded the id the `[t1-replace-agent]` prompt was
 * quoting as retired, and the recorder wrote that corpse in as the run's live
 * agent.
 *
 * Dropping the four only when the value was a STRING reopened exactly that
 * defect at a respelling. Measured, all sixteen combinations of the four
 * spellings against `{ text: … }`, `[ … ]`, `content[]` blocks and one record
 * deeper leaked the quoted corpse: the exclusion did not fire, the walk recursed
 * into the subtree, and `collectResponseText`'s `JSON.stringify` handed the
 * quoted id straight to `AGENT_ID_RE`.
 *
 * And covering every SPELLING while walking only records left the same defect at
 * every POSITION behind an array. Measured pristine against patched over 111 id
 * rows, 50 moved and all 50 were a quoted corpse becoming null: the four brief
 * spellings times five shapes, inside a top-level array and inside a `content[]`
 * tool_use block, on Cursor — whose adapter passes `raw: data` through verbatim,
 * so `content[]` is the one array shape this tree documents arriving there. No
 * control moved: every result spelling that reported an id still reports it,
 * including one inside an array.
 *
 * The two obvious remedies are both traps, and both were measured before this
 * one was written. Dropping the subtree regardless of type breaks the row that
 * `task: { agent_id: 'senior-frontend-2' }` must stay readable — Copilot's tool
 * is itself called `task`, so a record under a brief name is an envelope.
 * Stripping only the subtree's string LEAVES breaks the same row, because that id
 * IS a string leaf. What separates them is not the type: it is that an id a
 * result REPORTS arrives under a key that names it, while an id a brief QUOTES
 * arrives inside prose. So inside a brief-named subtree this keeps a string only
 * under `agent_id`/`agentId`, and drops every other leaf at every depth.
 *
 * The residual is the mirror of that rule and cannot be closed by it: a brief
 * whose subtree carries a literal `agent_id` KEY would be read as a report. No
 * host sends one, and a brief that Traffic One itself wrote quotes a retired id
 * in prose, which is the shape this closes.
 */
const BRIEF_ID_KEYS: ReadonlySet<string> = new Set(['agent_id', 'agentId']);

function withoutSpawnBrief(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutSpawnBrief(item));
  const record = obj(value);
  if (!record) return value;
  const out: Rec = {};
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (!SPAWN_BRIEF_KEYS.includes(key)) {
      out[key] = withoutSpawnBrief(child);
      continue;
    }
    if (typeof child === 'string') continue;
    out[key] = briefSubtree(child, (nestedKey) => BRIEF_ID_KEYS.has(nestedKey));
  }
  return out;
}

/**
 * The id the RESULT reports — never one the spawn prompt merely quotes.
 *
 * Scanning the whole payload was defended as safe because the regex is anchored
 * on a labelled `agent[_ ]id:` form, so only text that literally quotes a
 * labelled id could false-positive. That text exists and is routine: a
 * `[t1-replace-agent]` prompt quotes the dead id the orchestrator has just been
 * told to retire. Measured through each host's real adapter, a Cursor spawn whose
 * prompt quoted `Agent ID: aaaaaaaa-…` yielded that id out of a result carrying
 * none, and a Copilot spawn whose prompt said `agent_id: senior-frontend-old`
 * yielded the corpse — which the recorder re-registers as the LIVE agent, so the
 * reuse gate then demands continuation of an agent that is already dead.
 *
 * Narrowing loses no real extraction. Of the hosts that reach the recorder at all
 * (Claude with agent teams, Cursor, Copilot — every other host is refused by
 * `subagentContinuationAvailable`, and Codex by the branch below), none reports a
 * spawned id only in the input. Copilot's input CAN carry `agent_id`, but that is
 * its continuation primitive: an id the prompt REQUESTS, handed back from the
 * registry the reuse gate just read, and accepting it is precisely how a row
 * retired by `[t1-replace-agent]` comes back to life. Measured across twenty-five
 * rows built per host and pushed through that host's adapter, nine ids moved and
 * every one of them had come from the input subtree.
 *
 * The by-name input exclusion is not the whole brief, and the gap is not
 * theoretical: on the two flat reachable hosts a brief can arrive at the
 * payload's TOP LEVEL, where `tool_input`/`tool_args` never covered it, in any of
 * the four spellings and as any VALUE — `withoutSpawnBrief` above is the second,
 * reader-private half, and the reason it may not live in the shared vocabulary.
 *
 * Only where this reader LOOKS changes; what counts as an id does not. Every
 * result spelling the tree names still yields one — structured `agentId` and
 * `agent_id`, the Claude footer, Cursor's `Agent ID:` line and its markdown-link
 * form, a bare result STRING, Copilot's telemetry record, and an envelope nothing
 * names.
 */
export function extractSpawnedAgentId(response: unknown): string | null {
  const result = toolResultWithoutInput(response);
  // Claude's PostToolUse payload carries the id as a STRUCTURED field:
  // tool_response = { status, agentId, agentType, content: [...], usage }.
  // Read it directly; the serialized-text regex below is the fallback for
  // hosts that only surface the `agentId: <id>` footer as text.
  const direct = obj(result);
  if (direct && typeof direct.agentId === 'string' && direct.agentId.trim()) {
    const id = direct.agentId.trim();
    return isCursorToolSubagentId(id) ? null : id;
  }
  // Codex spawn_agent returns snake_case: { agent_id, nickname }.
  if (direct && typeof direct.agent_id === 'string' && direct.agent_id.trim()) {
    return direct.agent_id.trim();
  }
  const text = collectResponseText(withoutSpawnBrief(result));
  if (!text) return null;
  const cursorUuid = CURSOR_AGENT_UUID_RE.exec(text)?.[1]
    || CURSOR_LINK_UUID_RE.exec(text)?.[1];
  if (cursorUuid) return cursorUuid;
  const match = AGENT_ID_RE.exec(text);
  if (!match?.[1]) return null;
  const id = match[1];
  return isCursorToolSubagentId(id) ? null : id;
}

// Conservative mid-run failure classifier for a spawn-tool RESULT. A successful
// summary can casually contain the word "stopped", so bare verbs only count via
// the structured status field; free text must name a limit/quota explicitly.
const RESULT_STOP_STATUSES = new Set(['stopped', 'aborted', 'cancelled', 'canceled', 'failed', 'error', 'errored']);
const RESULT_SUCCESS_STATUSES = new Set(['completed', 'complete', 'success', 'succeeded', 'done', 'ok']);

/**
 * What ONE record says about the tool call's own outcome, or null when it says
 * nothing decisive. Success is decided before failure, so
 * `{ status: 'completed', error: 'a handled glitch' }` stays a success.
 *
 * `admitBareError` is the difference between the two depths, and it is the whole
 * reason `toolResultVerdictSources` splits them. At the result's OWN top level a
 * non-empty `error` is the tool reporting a failure. ONE LEVEL IN it is not:
 * measured against the single-source reader this replaced,
 * `{ metadata: { error: 'a deprecation warning' } }`,
 * `{ results: { error: '1 file skipped' } }` and
 * `{ child_reports: { error: 'the sub-sub agent died' } }` were all read as THIS
 * tool call failing — a new false positive in the direction that RETIRES A LIVE
 * AGENT — and `{ metadata: { error: … }, execution_record: { status: 'completed' } }`
 * answered success or failure depending on which child the host serialized first.
 * A nested child's `error` is that child's. A nested `status`/`is_error`/`success`
 * is not: an envelope is where the tool's own verdict lives on the five hosts
 * that name no wrapper, which is the defect this whole read exists to close.
 *
 * THE STATUS SPELLINGS ARE `status` AND `state`, AND THAT SET IS NOW BOUNDED BY
 * EVIDENCE rather than by symmetry. `resultType`/`result_type` were read here for
 * one round, added on the argument that omitting a spelling is not neutral: a
 * success marker not read as success is the one direction this function must never
 * fail in, since success is what leaves the agent registered, and measured,
 * `{ result_type: 'success', error: 'I backed off after an API usage limit and
 * finished the screen' }` read as a FAILURE and condemned the model where the same
 * payload spelling it `status` answered null.
 *
 * The argument is sound and the KEY IS NOT GROUNDED. Searched: `resultType` and
 * `result_type` appear nowhere in this tree except that reader and the test
 * written for it — no adapter, no fixture, no wrapper — and nowhere in the host
 * wrappers installed on this machine either. So the arm decided 8 rows in the
 * whole suite, all of them its own, and closed a case that previously classified.
 * That is a row built from a guess, held to the same standard as the constructed
 * Copilot shapes: it must be grounded or not exist. It is deleted.
 *
 * WHAT DECLINING IT COSTS, pinned in agent-model.test.ts rather than left here as
 * a hope: if a host does report success as `result_type: 'success'`, the marker is
 * unread and a non-empty `error` beside it is read as this tool call failing — the
 * exact direction above. Re-adding the arm is one line plus its rows, and the day
 * a payload with that spelling is observed, that is the change to make. `state`
 * stays because this tree's own completion records spell it (`maintenance/
 * fallback.ts`, `run-settlement/reconcile.ts`, `state/run-agent/ledger.ts`); no
 * host tool-result payload is recorded for ANY spelling, which is the standing
 * disclosure at the head of `shared/tool-result.ts` and not a claim about
 * Copilot's wire format.
 */
function statusWord(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sourceVerdict(source: Rec, admitBareError: boolean): 'success' | 'failure' | null {
  const status = statusWord(source.status) || statusWord(source.state);
  if ((status && RESULT_SUCCESS_STATUSES.has(status)) || source.success === true || source.ok === true) return 'success';
  if (status && RESULT_STOP_STATUSES.has(status)) return 'failure';
  if (source.is_error === true || source.isError === true || source.success === false || source.ok === false) return 'failure';
  if (admitBareError && source.error !== undefined && source.error !== null && source.error !== false && source.error !== '') return 'failure';
  return null;
}

/**
 * The tool call's structured verdict, read where one can honestly be.
 *
 * `toolResultPayload` unwraps the four WRAPPER spellings and NEVER a container,
 * so a result that reports `status:'error'` while naming no incident vocabulary
 * was legible under `tool_response` and invisible everywhere else. Measured end
 * to end on a materialized fixture, the byte-identical payload under
 * `execution_record` or `tool_output` (Copilot's other two constructed shapes)
 * classified null and the recorder wrote the dead child back into the run
 * registry as this run's LIVE reusable agent — the exact defect this recorder's
 * mid-run branch exists to prevent, surviving on an envelope nobody names. The
 * sensitivity does not rest on the Copilot guess: it reproduces identically on
 * `output` and `tool_info`, two containers this tree names from host
 * documentation rather than from a guess.
 *
 * The payload's own verdict is decided FIRST, so a host that reports one there
 * keeps the answer it had and an envelope can never override it. Across the
 * envelopes there is no order at all: success outranks failure, so the answer no
 * longer depends on which child the host happened to serialize first — the
 * key-order dependence the flat single-list version introduced. Outranking in
 * that direction is the conservative one: `success` returns null here and leaves
 * the agent registered, while `failure` retires it.
 */
function structuredOutcome(response: unknown): 'success' | 'failure' | null {
  const { own, nested } = toolResultVerdictSources(response);
  // A result that IS a list has no own record — a bare failure STRING has none
  // either, and answers null through an empty `nested` rather than through this
  // branch, which is why the early return that used to sit here was doing two
  // jobs and got the list case wrong.
  const ownVerdict = own ? sourceVerdict(own, true) : null;
  if (ownVerdict) return ownVerdict;
  const verdicts = nested.map((source) => sourceVerdict(source, false));
  if (verdicts.includes('success')) return 'success';
  return verdicts.includes('failure') ? 'failure' : null;
}

/**
 * `spawnInput` is OPTIONAL and its absence is a real answer, not a default to be
 * tidied away: a caller that has the tool input hands it over and gets the echo
 * discriminator, and a caller that does not gets the same classification the
 * result alone supports. Only the recorder has it, and only the recorder needs
 * it — everywhere else in this tree the question is what a given result MEANS,
 * with no spawn call to compare it against.
 *
 * KEPT OPTIONAL DELIBERATELY, and the argument for closing it is a real one so it
 * is recorded with the answer. `collectResultText`'s `echo` parameter one level
 * down was defaulted and is now REQUIRED, on the ground that a third caller could
 * otherwise ship with the discriminator silently unwired — a shape only a
 * call-site mutant finds. The identical argument reaches here, and the difference
 * that decided it is what the two parameters fence: `collectResultText` is private
 * with two callers inside this file, while this is the public entry every unit row
 * in the suite uses to ask what a RESULT alone supports. Requiring it turns ~30 of
 * those rows into explicit `undefined` and deletes the strictness default with it.
 *
 * WHAT REPLACES THE COMPILE ERROR is a behavioural pin on the caller that exists,
 * and it was measured rather than assumed: deleting `toolInput` at the call site
 * below reds exactly two rows in agent-model.test.ts and nothing else. One of them
 * already existed (the `echoed from the spawn input` cell of the crash-brief row);
 * the other is new and supplies the direction that cell lacks — the same result
 * beside a spawn brief that names no limit still condemns the model — so an echo
 * that suppresses everything is red too. THE RESIDUAL, stated rather than closed: a
 * THIRD production caller can still omit the argument and silently get the
 * result-only answer, and only review would notice. The two pins do not fence that;
 * requiring the parameter would.
 */
export function classifySubagentStop(
  response: unknown,
  requireStructuredFailure: boolean = true,
  spawnInput?: unknown,
): ModelFailureKind | 'stopped' | null {
  const outcome = structuredOutcome(response);
  // Every host may return an arbitrary successful subagent report. An explicit
  // success envelope wins over incident vocabulary quoted inside that report;
  // legacy hosts that return only an unstructured failure string still retain
  // the text-classification fallback below.
  if (outcome === 'success') return null;
  const structuredFailure = outcome === 'failure';
  // Cursor's successful Task report is arbitrary model-written prose. It may
  // quote an incident, a test fixture, or "model not enabled" instructions; none
  // of that is a runtime failure unless Cursor marks the result failed/error.
  if (requireStructuredFailure && !structuredFailure) return null;
  const text = collectResultText(response, spawnInputEcho(spawnInput));
  const classified = classifyModelFailureText(text);
  if (classified !== 'generic') return classified;
  return structuredFailure ? 'stopped' : null;
}

function composerFloorChoice(
  ctx: Ctx,
  cwd: string,
  runId: string,
  role: string,
  recommended: string,
  composer: string,
): HookResult {
  const choice = readModelChoice(cwd, runId);
  if (choice === 'use-fallback') {
    return context(
      `traffic-one — ${role} API/usage limit. React NOW; do not wait for other running subagents. `
      + `Re-send the ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line of the prompt and model="${composer}" `
      + `(the Composer fallback explicitly accepted by the user). Resume from whatever the stopped agent already completed instead of restarting from scratch.`,
      { systemMessage: `traffic-one: ${role} API/usage limit — respawning on ${composer}` },
    );
  }
  if (choice === 'enable-retry') {
    return context(
      `traffic-one — ${role} API/usage limit. Do not proceed on the Composer fallback. `
      + `Restore API budget for **${recommended}**, then re-send the same ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line and model="${recommended}". `
      + 'Resume from whatever the stopped agent already completed instead of restarting from scratch.',
      { systemMessage: `traffic-one: restore API budget for ${recommended}, then retry ${role}` },
    );
  }

  markModelChoicePrompted(cwd, runId);
  const prose = `traffic-one — ${role} hit an API/usage limit and the next eligible model in its original tier is the Composer floor.\n\n`
    + `**enable** — Restore API budget for **${recommended}**, then reply **enable**; I’ll retry on the recommended model.\n\n`
    + `**fallback** — Proceed now on **${composer}**.`;
  return context(prose, {
    systemMessage: `traffic-one: ${role} needs your enable/fallback choice before Composer`,
    promptRequest: modelUnavailablePromptRequest(recommended, composer, prose),
  });
}

export function recordSpawnedAgent(ctx: Ctx): HookResult {
  // Without continuation the registry is dead weight — skip the write entirely
  // so non-teams hosts keep byte-identical run dirs.
  if (!subagentContinuationAvailable(process.env, ctx.host)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  if (toolName && !/^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const roleResolution = inferTrafficOneSpawnRoleEvidence(toolInput);
  if (roleResolution.kind !== 'evidence') return noop();
  const role = roleResolution.evidence.role;

  // Codex spawn results do not reliably contain the child id (live responses
  // may return only task_name). Requested tool_input.model is intent, not proof
  // of the runtime model. SubagentStart/child PreToolUse own the verified claim
  // and registry write; never let this parent-side event create a reusable row.
  if (ctx.host === 'codex') return noop();

  // The wrapper when a host sends one, otherwise the payload itself. Reading the
  // four wrapper spellings and stopping there saw NOTHING on any host that names
  // no wrapper — of the hosts that reach this recorder, Cursor spreads the result
  // across flat top-level fields and Copilot's result key is not established
  // anywhere — so the mid-run failure branch below was inert on both and a
  // subagent that had already died was re-recorded as LIVE.
  // Neither reader below may look at the whole of it. On a payload-fed host the
  // spawn prompt is part of the text the classifier classified, and measured, a
  // LIVE agent whose prompt merely mentioned an API limit read as dead on
  // Copilot, while on Cursor a genuine crash whose prompt mentioned one was
  // upgraded to `api-limit` and condemned the model. The id extractor had the
  // mirror of that fault: a `[t1-replace-agent]` prompt quotes the id it was told
  // to retire, so the corpse was extracted and re-registered as live. Both now
  // take the same by-name input exclusion from the shared leaf — `collectResultText`
  // for the text, `extractSpawnedAgentId` for the id — so what each counts as
  // evidence is untouched and only the value they read it out of is smaller.
  // Each takes ONE MORE exclusion beyond that, and they are not the same one: the
  // four brief spellings the shared vocabulary must refuse arrive at this payload's
  // TOP LEVEL on a flat host, where no input key covers them, and the two readers
  // need opposite things from them. The id extractor keeps a structured
  // `agent_id`/`agentId` key inside a brief and drops the prose; the classifier
  // drops the prose except a `message` in a record that reports a decisive verdict
  // of its own, because that is the shape every host spells a failure in.
  // The classifier gets the tool INPUT as well, and nothing else here does: it is
  // the only reader whose last ambiguity — a brief the host echoed into the result
  // beside a real failure — is decidable from a second copy rather than from the
  // result alone.
  const spawnEcho = spawnInputEcho(toolInput);
  const response = toolResultPayload(raw);
  const stateCwd = ctx.host === 'cursor'
    ? resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot })
    : ctx.cwd;

  // MID-RUN FAILURE (api limit / stopped): when PostToolUse is delivered, its
  // result is the earliest synchronous signal a parallel subagent died. Without
  // this branch the recorder RE-RECORDS the dead agent as live (Cursor prints
  // `Agent ID:` even for a stopped run) and the reuse gate then demands
  // continuation of a dead agent while the orchestrator idles until the sibling
  // finishes. Retire the agent and tell the orchestrator to respawn NOW on the
  // next same-tier fallback model.
  const classifiedStopKind = classifySubagentStop(response, ctx.host === 'cursor', toolInput);
  if (classifiedStopKind) {
    if (ctx.host === 'cursor') {
      const outcome: ModelFailureKind = classifiedStopKind === 'stopped' ? 'generic' : classifiedStopKind;
      persistCorrelatedCursorPostToolFailure(
        ctx,
        role,
        asString(toolInput.model),
        outcome,
        // Narrowed for the same reason the classification above is: this text is
        // persisted as the observation's `error` and re-run through
        // classifyModelFailureText whenever the row has no outcome yet, so a
        // prompt reaching it condemns a model in the durable ledger.
        collectResultText(response, spawnEcho),
      );
      // Only a matching immutable SubagentStart proves which model actually
      // ran. An uncorrelated result may be surfaced by Cursor itself, but it may
      // not condemn a model or retire an arbitrary same-role agent here.
      // Persist only: returning this role's directive here would bypass the
      // complete-parent delivery CAS. Parallel PostToolUse results could then
      // fragment sibling roles, and the next Stop/prompt pass would deliver the
      // same still-unclaimed result again. Lifecycle/prompt reconciliation owns
      // the one aggregated, at-most-once continuation for the parent.
      return noop();
    }

    // Runtime Settings guidance is Cursor-specific. Other hosts retain their
    // established generic stopped-agent recovery for explicit availability text.
    const stopKind: 'api-limit' | 'stopped' = classifiedStopKind === 'api-limit'
      ? 'api-limit'
      : 'stopped';
    // Resolve host-scoped performance/team preferences from the hook's canonical
    // host, even in embedded/test runners that do not carry Cursor's env marker.
    const stopState = readEffectiveState(stateCwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
    const stopRunId = stopState && typeof stopState.currentRunId === 'string' ? stopState.currentRunId.trim() : '';
    if (stopRunId) markRunAgentReplaced(stateCwd, stopRunId, role);
    const exhausted = asString(toolInput.model);
    // Remember the dead model for this run+role so the respawn (and any later
    // retry) rotates OFF it — the same store the Cursor PreToolUse gate reads,
    // keeping both hosts on one exhaustion ledger.
    const allExhausted = stopKind === 'api-limit' && stopRunId && exhausted
      ? recordExhaustedModel(stateCwd, stopRunId, role, exhausted)
      : (stopRunId ? exhaustedModelsForRole(stateCwd, stopRunId, role) : []);
    const policy = stopRunId ? readRunModelPolicy(stateCwd, stopRunId) : null;
    if (stopRunId && !policy) {
      return context(
        `traffic-one — ${role} stopped, but immutable model-policy.json is missing for run ${stopRunId}. `
        + 'Do not select a retry model from mutable global configuration; start a repaired parent run.',
      );
    }
    const originalTier = policy?.roles[role]?.tier || null;
    const capturedModels = policy?.host === 'cursor' ? policy.cursorAvailableModels : undefined;
    const fallbackCandidate = stopKind === 'api-limit' && originalTier
      ? resolveRunPolicyFallback(policy!, {
        tier: originalTier,
        exhaustedModels: allExhausted,
        capturedModels,
      })
      : null;
    const fallback = fallbackCandidate?.model || '';
    // Composer is the normal first candidate for a cheapest-tier worker. For a
    // highest/balanced role it is a real floor drop and stays user-owned.
    if (stopKind === 'api-limit'
      && stopRunId
      && originalTier
      && originalTier !== 'cheapest'
      && fallbackCandidate
      && /^composer/i.test(fallbackCandidate.family)) {
      const preferred = policy!.tiers[originalTier][0] || '';
      const recommended = preferred || exhausted;
      return composerFloorChoice(ctx, stateCwd, stopRunId, role, recommended, fallbackCandidate.model);
    }
    if (stopKind === 'api-limit' && stopRunId && originalTier && !fallbackCandidate) {
      const row = policy!.tiers[originalTier];
      const allActuallyLimited = row.length > 0 && row.every((family) => (
        allExhausted.some((model) => modelMatchesExpected(model, family) || modelMatchesExpected(family, model))
      ));
      const composerAccepted = originalTier === 'cheapest' || readModelChoice(stateCwd, stopRunId) === 'use-fallback';
      if (allActuallyLimited && composerAccepted) {
        markModelExhaustionTerminal(stateCwd, stopRunId, role);
        return context(
          `traffic-one — model rotation is terminal for ${role}: every eligible model actually started from the role's original ${originalTier} tier reached an API/usage limit (${allExhausted.join(', ')}). Stop retrying this role until the user restores API budget.`,
          { systemMessage: `traffic-one: ${role} exhausted every ${originalTier}-tier model` },
        );
      }
    }
    const modelStep = fallback
      ? ` Respawn with model: "${fallback}" (next same-tier fallback — "${exhausted}" is exhausted for this session; do not re-use it).`
      : ' Respawn with the next same-tier fallback model from the announced lineup if the failure was an API/usage limit.';
    const reason = stopKind === 'api-limit' ? 'API/usage limit' : 'stopped mid-run';
    return context(
      `traffic-one — ${role} ${reason}. React NOW; do not wait for other running subagents. `
      + `Re-send the ${role} task with ${REPLACE_AGENT_MARKER} on the FIRST line of the prompt (the stopped agent was retired from the reuse registry).${modelStep} `
      + 'Resume from whatever the stopped agent already completed instead of restarting the work from scratch.',
      { systemMessage: `traffic-one: ${role} ${reason}${fallback ? ` — respawning on ${fallback}` : ' — respawning'}` },
    );
  }

  // No second payload fallback here: the shared reader above already answers the
  // wrapper-or-payload question once, so a private copy of it could only drift.
  let agentId = extractSpawnedAgentId(response);
  // Never fabricate a Windsurf agent id from the requested profile. Devin emits
  // PostToolUse even when `run_subagent` fails (for example, an unregistered
  // custom profile); treating the profile as live poisons the corrective retry.
  if (!agentId || !isResumeCapableAgentId(agentId)) return noop();

  const state = readEffectiveState(stateCwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  const runId = state && typeof state.currentRunId === 'string' && state.currentRunId.trim() ? state.currentRunId.trim() : null;
  if (!runId) return noop();

  recordRunAgent(stateCwd, runId, role, {
    agentId,
    resumeId: agentId,
    model: asString(toolInput.model) || null,
    agentType: asString(toolInput.agent_type ?? toolInput.agentType ?? toolInput.subagent_type ?? toolInput.type) || null,
    parentSessionId: hookSessionIdentity(raw).sessionId,
    roleSource: roleResolution.evidence.source,
  });
  return noop();
}
