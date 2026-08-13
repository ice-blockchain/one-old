import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_INPUT_KEYS,
  toolResultContainer,
  toolResultNumeric,
  toolResultPayload,
  toolResultText,
  toolResultVerdictSources,
  toolResultWithoutInput,
} from '../tool-result';

const RESULT = 'ready in 412 ms';
const COMMAND = 'node ~/.traffic-one/bin/lighthouse-runner.cjs --route /';

/**
 * The five payload families a tool result actually arrives in, as the adapters and
 * the two installed wrappers deliver them — NOT as a host's documentation reads,
 * since one of the seven has no documented result field anywhere in this tree.
 *
 * `container` records whether the family NAMES a value that carries the result.
 * The last row is the one that matters most: a family nobody has written yet.
 */
const FAMILIES: { family: string; hosts: string; raw: Record<string, unknown>; container: boolean }[] = [
  {
    family: 'wrapper',
    hosts: 'claude, codex, Devin Local',
    raw: { tool_name: 'Bash', tool_input: { command: COMMAND }, tool_response: { stdout: RESULT } },
    container: true,
  },
  {
    family: 'wrapper, camel spelling',
    hosts: 'codex',
    raw: { tool_input: { command: COMMAND }, toolResponse: { output: RESULT } },
    container: true,
  },
  {
    family: 'flat top level',
    hosts: 'cursor',
    raw: { command: COMMAND, output: RESULT, exit_code: 0 },
    container: true,
  },
  {
    family: 'output container',
    hosts: 'opencode, kilo',
    raw: { tool_name: 'bash', input: {}, output: { title: 'bash', args: { command: COMMAND }, output: RESULT } },
    container: true,
  },
  {
    family: 'cascade tool_info',
    hosts: 'windsurf (legacy Cascade)',
    raw: { agent_action_name: 'post_run_command', tool_info: { command_line: COMMAND, output: RESULT, exit_code: 0 } },
    container: true,
  },
  {
    family: 'a SIXTH family, container not named here',
    hosts: 'none today',
    raw: { tool_name: 'shell', tool_input: { command: COMMAND }, some_future_result: { body: RESULT } },
    container: false,
  },
];

test('the result text is read out of every family, including one this file does not know', () => {
  for (const entry of FAMILIES) {
    const text = toolResultText(entry.raw);
    assert.ok(
      text.includes(RESULT),
      `${entry.family} (${entry.hosts}): the result text must be readable without naming the field it arrived in`,
    );
  }
});

/**
 * The Claude and Copilot content-block shape — and, until this row existed, the
 * one branch of this leaf no test entered. Instrumented for executions per
 * branch over the five suites that cover it, `collect`'s ARRAY recursion ran 0
 * times; with this row it runs 3, and every other branch was already entered.
 *
 * A mutant DELETING that branch still survives, and the reason is worth writing
 * down so the next campaign does not chase it: the deletion is observationally
 * equivalent. An array is `typeof 'object'`, so it falls through to the record
 * walk below, whose `Object.keys` yields the same members in the same order at
 * the same depth. Differentially measured over 14 array-bearing payloads, the two
 * versions agreed on 13; the single distinguisher is an array carrying a
 * non-index own property.
 *
 * The PREMISE that used to be recorded for that last step was "which `JSON.parse`
 * cannot produce", and it is FALSE: four of the seven adapters (copilot, kilo,
 * opencode, windsurf) CONSTRUCT the top-level record they hand over rather than
 * passing parsed stdin through, so not every value reaching the walk is
 * `JSON.parse` output. The conclusion survives, for a different and narrower
 * reason — those constructions build plain objects and plain arrays, `length` is
 * non-enumerable, and a sparse hole yields `undefined`, which returns
 * immediately — so no array reaching this walk on any of the seven carries a
 * non-index own property. Stated as what it is: an argument about what the
 * adapters build, not a guarantee from the parser.
 *
 * So the branch is a fast path rather than a behaviour — but it is a fast path
 * over the shape Claude results actually arrive in, and it was, until now,
 * entirely unexercised.
 */
test('a content[] block list is walked, and the input inside one is still excluded', () => {
  const text = toolResultText({
    tool_input: { command: COMMAND },
    tool_response: {
      content: [{ type: 'text', text: RESULT }, { type: 'text', text: 'and a second block' }, { command: COMMAND }],
    },
  });
  assert.ok(text.includes(RESULT), 'the first block');
  assert.ok(text.includes('and a second block'), 'and every block after it, not just the first');
  assert.ok(!text.includes(COMMAND), 'the exclusion goes through the array, not around it');
  assert.ok(
    toolResultText({ content: [[{ text: RESULT }]] }).includes(RESULT),
    'the recursion is a recursion: an array inside an array is still walked',
  );
});

/**
 * The half that keeps the walk honest. A tool result is read by SHAPE, so the only
 * thing standing between "read everything" and "read the command back as if the
 * tool had printed it" is the input exclusion — and a runner invocation quotes
 * routes, URLs and, in this repo's own tests, whole status lines.
 */
test('the input is never part of the result text, wherever a host keeps it', () => {
  const places: { label: string; raw: Record<string, unknown> }[] = [
    { label: 'tool_input.command', raw: { tool_input: { command: COMMAND }, stdout: RESULT } },
    { label: 'top-level command', raw: { command: COMMAND, output: RESULT } },
    { label: 'cascade command_line', raw: { tool_info: { command_line: COMMAND, output: RESULT } } },
    { label: 'opencode output.args', raw: { output: { args: { command: COMMAND }, output: RESULT } } },
    // `tool_calls[].args` is documented; the result key beside it is one of the
    // three constructed Copilot shapes and is not — see the disclosure at the
    // head of tool-result.ts. Only the exclusion is under test here.
    { label: 'copilot tool_calls[].args', raw: { tool_calls: [{ id: '1', name: 'shell', args: { command: COMMAND } }], tool_output: RESULT } },
    { label: 'a prompt', raw: { prompt: COMMAND, output: RESULT } },
  ];
  for (const place of places) {
    const text = toolResultText(place.raw);
    assert.ok(text.includes(RESULT), `${place.label}: the result itself must survive the exclusion`);
    assert.ok(!text.includes(COMMAND), `${place.label}: the tool input must not be read as the tool's output`);
  }
});

test('every input spelling in the shared set is excluded, and the set is not empty', () => {
  assert.ok(TOOL_INPUT_KEYS.size >= 15, 'the shared input vocabulary must actually be populated');
  for (const key of TOOL_INPUT_KEYS) {
    const raw: Record<string, unknown> = { stdout: RESULT };
    raw[key] = COMMAND;
    assert.ok(
      !toolResultText(raw).includes(COMMAND),
      `${key} is in the shared input set but its value still reached the result text`,
    );
  }
});

/**
 * The row above iterates the set to prove the exclusion CLOSES over it, which means
 * deleting a member deletes its own assertion with it. That is a closure check, not
 * a check that the set is the right set. Pinned against a literal so removing a
 * spelling reddens HERE, at the vocabulary, rather than only at whichever aimed row
 * above happens to use that spelling — and so adding one is a deliberate act with a
 * reason, not a quiet widening of what counts as input.
 */
test('the shared input vocabulary is exactly this membership', () => {
  const expected = [
    'tool_input', 'toolInput', 'input', 'args', 'arguments', 'tool_args', 'toolArgs',
    'tool_calls', 'toolCalls', 'parameters', 'command', 'cmd', 'shell_command', 'shellCommand',
    'command_line', 'commandLine', 'prompt',
  ];
  assert.deepEqual(
    [...TOOL_INPUT_KEYS].sort(),
    [...expected].sort(),
    'a spelling was added to or removed from the shared input set',
  );
});

/**
 * STRICT. Null is the answer for a family this file cannot name, and that is the
 * property a caller doing byte ACCOUNTING needs: the token logger must record 0
 * rather than fall back to the payload and count the command as output. The text
 * reader above still reads that same payload, which is why both functions exist.
 */
test('a container is identified for every known family and refused for an unknown one', () => {
  for (const entry of FAMILIES) {
    const container = toolResultContainer(entry.raw);
    if (entry.container) {
      assert.notEqual(container, null, `${entry.family}: this family names a result container`);
      assert.ok(
        JSON.stringify(container).includes(RESULT),
        `${entry.family}: the identified container must be the one holding the result`,
      );
    } else {
      assert.equal(
        container,
        null,
        `${entry.family}: an unnamed container must be refused rather than guessed — a wrong guess is measured as if it were a result`,
      );
    }
  }
});

test('the container strips the input it shares an object with', () => {
  const opencode = toolResultContainer({ output: { title: 'bash', args: { command: COMMAND }, output: RESULT } });
  assert.ok(!Object.prototype.hasOwnProperty.call(opencode as object, 'args'), '`output.args` is the INPUT of an OpenCode tool call');
  assert.ok(!JSON.stringify(opencode).includes(COMMAND), 'no part of the command may be counted as result bytes');
  const cascade = toolResultContainer({ tool_info: { command_line: COMMAND, output: RESULT, exit_code: 1 } });
  assert.ok(!JSON.stringify(cascade).includes(COMMAND), 'Cascade keeps the command in the same record as the result');
  assert.ok(JSON.stringify(cascade).includes(RESULT), 'stripping the input must not take the result with it');
});

/**
 * What widening the exclusion through ARRAYS moves for the one consumer that
 * counts BYTES rather than reads evidence, stated as a number because "no
 * behaviour change" would be false. The token logger books the container's size
 * as `outputBytes`, and an input key behind an array used to be inside that
 * count: measured, `{ tool_response: { content: [{ input: { command } }, { text }] } }`
 * booked 62 bytes and now books 34, and a wrapper that IS an array booked 50 and
 * now books 22. The delta is exactly the input, so every move is an overcount
 * being corrected in the direction this reader's own docblock already claims —
 * "input bytes are not counted as output bytes" — which was true only at object
 * depths. The file has no reader in `src/` and the writer is behind an opt-in
 * flag, so nothing downstream reprices.
 */
test('the container strips an input key that sits behind an array, and books fewer bytes for it', () => {
  const behindArray = toolResultContainer({ tool_response: { content: [{ input: { command: COMMAND } }, { text: RESULT }] } });
  assert.ok(!JSON.stringify(behindArray).includes(COMMAND), 'an input key one array member down is still the input');
  assert.ok(JSON.stringify(behindArray).includes(RESULT), 'and the block beside it is still the result');
  const arrayWrapper = toolResultContainer({ tool_response: [{ input: { command: COMMAND } }, { text: RESULT }] });
  assert.ok(Array.isArray(arrayWrapper), 'a wrapper whose value IS an array stays an array');
  assert.ok(!JSON.stringify(arrayWrapper).includes(COMMAND), 'and is walked rather than measured whole');
});

test('a wrapper wins over a container, and a null wrapper is not a wrapper', () => {
  const both = toolResultContainer({ tool_response: { stdout: 'wrapped' }, output: 'flat' });
  assert.equal(JSON.stringify(both), JSON.stringify({ stdout: 'wrapped' }), 'a host that sends both is a wrapper host');
  assert.equal(toolResultContainer({ tool_response: null, output: 'flat' }), 'flat', 'an absent wrapper must not shadow the container');
  const nulled = { tool_response: null, stdout: RESULT };
  assert.equal(toolResultPayload(nulled), nulled, 'a null wrapper falls through to the payload itself');
  assert.ok(toolResultText(nulled).includes(RESULT), 'so the result beside it is still read');
});

/**
 * LENIENT, and why page-speed uses it rather than the container: on a flat host the
 * result is spread across sibling top-level fields, so narrowing to the one field
 * that looks like a container would silently drop the rest.
 */
test('the lenient payload keeps sibling result fields the container would drop', () => {
  const raw = { command: COMMAND, output: 'the summary', stderr: 'the diagnostics' };
  assert.equal(toolResultContainer(raw), 'the summary', 'the container is the one field a host named');
  const text = toolResultText(raw);
  assert.ok(text.includes('the summary') && text.includes('the diagnostics'), 'both are the tool result; only one is the container');
});

/**
 * `toolResultExitCode` and `toolResultFailed` used to live here, with a test each
 * that read like a pin on shipping behaviour. They had NO production
 * consumer — searched: this file, its test, and two prose citations that named
 * them as if they constrained something running — so a third of this leaf's
 * exported surface was dead while being quoted as evidence. They were deleted
 * rather than disclosed, and this row is what replaced them: the one piece either
 * function contributed that a live reader needed.
 *
 * `model-gate.ts`'s `shellExitFailed` is that reader, and its ladder stays its
 * own — it also hunts a Traffic One STOP sentinel through `stderr`/`output`
 * spellings no generic result reader should know. What it must not have a second
 * copy of is what counts as a NUMBER: hosts spell `status` and `code` with word
 * statuses and error names too.
 */
test('a word status is not an exit code, and the reader that needs one shares this answer', () => {
  assert.equal(toolResultNumeric(2), 2);
  assert.equal(toolResultNumeric(0), 0, 'zero is a code, not an absence');
  assert.equal(toolResultNumeric('1'), 1, 'a numeric string is a code');
  assert.equal(toolResultNumeric('completed'), null, 'a word status is not a code');
  assert.equal(toolResultNumeric('ENOENT'), null, 'an error name is not a code');
  assert.equal(toolResultNumeric(''), null);
  assert.equal(toolResultNumeric(undefined), null, 'nothing sent, nothing answered');
  assert.equal(toolResultNumeric(Number.NaN), null);
  assert.equal(toolResultNumeric(Number.POSITIVE_INFINITY), null, 'not finite is not a code');
  assert.equal(toolResultNumeric(true), null, 'a boolean is a success flag, not a code');
});

/**
 * WHERE a verdict about this tool call can honestly be read, split by depth.
 *
 * The projection two readers share — the mid-run subagent-failure classifier and
 * `model-gate`'s `shellExitFailed` — and the reason it answers WHERE and not WHAT.
 * Both need "the payload's own top level, then one level into whatever envelope
 * carried the result"; neither can use `toolResultContainer`, which refuses an
 * envelope no host named, and that refusal was measured as a live fail-open in
 * both of them.
 *
 * The SPLIT is the part a caller must not collapse, so it is pinned as a split
 * rather than as a flat list: the two depths do not admit the same evidence, and
 * a single list is exactly what made a nested `metadata.error` read as the tool
 * call's own failure.
 *
 * A LIST is transparent to POSITION rather than a position of its own, which is
 * the one axis this projection got wrong for as long as it existed: a record
 * member of an array sits where the array sits, except that it can never occupy
 * the OWN level, since a member of a list is not the result's own top level.
 * Both halves are pinned below, because the widening and its three wrong
 * versions are one edit apart.
 */
test('a verdict is readable at the payload top level and one level into any envelope, and no further', () => {
  for (const envelope of ['tool_response', 'execution_record', 'tool_output', 'output', 'tool_info']) {
    const sources = toolResultVerdictSources({ [envelope]: { status: 'error', text: RESULT }, tool_input: { command: COMMAND } });
    assert.equal(sources.nested.length, 1, `${envelope}: the envelope is one nested source`);
    assert.equal(sources.nested[0]?.status, 'error', `${envelope}: read without naming the envelope`);
    assert.ok(sources.own && envelope in sources.own, `${envelope}: and the payload own level is still a source`);
    assert.ok(sources.own && !('tool_input' in sources.own), `${envelope}: with the input excluded, by the one shared vocabulary`);
  }
  // A LIST COSTS NO LEVEL, and this row used to pin the opposite — `a record
  // inside an array is not one of this tool call verdict sources` — on the
  // argument that `obj()` refuses an array and that the refusal was
  // load-bearing. It was load-bearing in the wrong direction. `content[]` is
  // Claude's own result shape and `steps[]` is one of Copilot's, so no member of
  // either was a verdict source anywhere; and because record-agent's brief
  // exclusion is co-located with these positions on purpose, a real limit under
  // `message` inside one was then dropped as brief prose for want of a decisive
  // record to belong to. Measured end to end through `recordSpawnedAgent` on
  // materialized fixtures, `{ content: [{ status: 'error', message: '…API usage
  // limit' }] }` returned noop: the dead child stayed registered as the run's
  // LIVE agent and the exhaustion ledger stayed empty, while the byte-identical
  // payload spelling the limit `text` retired it and condemned its model. One
  // rule seen from two sides, so one fix.
  const withList = toolResultVerdictSources({ steps: [{ status: 'error' }], execution_record: { status: 'running' } });
  assert.deepEqual(
    [...withList.nested.map((source) => source.status)].sort(),
    ['error', 'running'],
    'a record inside an own-level list is a nested source, exactly as a record child is',
  );
  assert.deepEqual(
    toolResultVerdictSources({ content: [{ status: 'error' }] }).nested.map((source) => source.status),
    ['error'],
    'including the list shape Claude results actually arrive in',
  );
  // A result that IS a list: no own record to read a verdict from (an array
  // carries no `status`), and its members are still one position in.
  const bareList = toolResultVerdictSources([{ status: 'error' }, 'a text block']);
  assert.equal(bareList.own, null, 'an array has no own top level to report a verdict at');
  assert.deepEqual(bareList.nested.map((source) => source.status), ['error'], 'but its record members are nested sources');
  // The three WRONG versions of that widening, each killed here rather than only
  // in a distant classifier row.
  //  1. a member promoted to the OWN position. `own` is where a bare `error`
  //     counts as the tool's own failure, and admitting one at every list depth
  //     is exactly the fail-open the position rule exists for — an echoed spawn
  //     brief beside a nested warning retiring a live agent.
  const promoted = toolResultVerdictSources({ content: [{ status: 'error', error: 'boom' }] });
  assert.equal(promoted.own?.status, undefined, 'the payload own level is the payload, never a member of a list it carries');
  assert.equal(promoted.own?.error, undefined, 'so a bare error inside a list is not an own-level error');
  //  2. transparency that RECURSES. A list inside a list is one position
  //     further in, which is what keeps this from flattening a tree into the
  //     level above it.
  assert.deepEqual(toolResultVerdictSources({ content: [[{ status: 'error' }]] }).nested, [], 'a list inside a list is below the sources');
  //  3. transparency that ignores the one-level bound. A list inside an ENVELOPE
  //     is two positions in, exactly as a record two levels down is.
  assert.deepEqual(
    toolResultVerdictSources({ execution_record: { steps: [{ status: 'error' }] } }).nested.map((source) => source.status),
    [undefined],
    'a step list inside an envelope is below the sources',
  );
  // The bound. A verdict two levels down belongs to some nested child, and
  // reading it as the tool's own is the mistake this exists to refuse.
  const deep = toolResultVerdictSources({ execution_record: { child: { status: 'error' } } });
  assert.equal(deep.nested.length, 1, 'the envelope is a source');
  assert.equal(deep.nested[0]?.status, undefined, 'its child is not');
  // Split, not flattened: `own` and `nested` are distinguishable, because the
  // callers admit different fields at each.
  const flat = toolResultVerdictSources({ status: 'error', metadata: { error: 'a deprecation warning' } });
  assert.equal(flat.own?.status, 'error');
  assert.deepEqual(flat.nested.map((source) => source.error), ['a deprecation warning']);
  // Only a RECORD can report a verdict, so a list of scalars offers no source
  // even though the list itself is now walked — the indices are not envelopes.
  assert.deepEqual(toolResultVerdictSources({ content: ['a text block', 7, null] }).nested, [], 'a list of scalars carries no source');
  assert.deepEqual(toolResultVerdictSources('run_subagent failed').nested, [], 'a bare failure string carries no structured source');
  assert.equal(toolResultVerdictSources('run_subagent failed').own, null);
  assert.equal(toolResultVerdictSources(null).own, null);
  // A wrapper is NOT unwrapped here: this projects a value a caller already
  // resolved, and the classifier hands it `toolResultPayload(raw)`.
  const wrapped = toolResultVerdictSources(toolResultPayload({ tool_response: { status: 'error' } }));
  assert.equal(wrapped.own?.status, 'error', 'the caller unwraps; this reads what it is handed');
});

/**
 * The PROJECTION, as distinct from the walk: same value, same shape, input taken
 * out. It exists because the two readers above answer the wrong question for a
 * caller that has to serialize a result — `toolResultText` flattens it to values
 * and `toolResultContainer` answers null wherever no host named a container.
 */
test('the input is removed from a payload without flattening it, at any object depth', () => {
  const projected = toolResultWithoutInput({
    tool_name: 'Task',
    tool_input: { prompt: COMMAND },
    execution_record: { status: 'stopped', args: { command: COMMAND }, text: RESULT },
  }) as Record<string, unknown>;
  const serialized = JSON.stringify(projected);
  assert.ok(!serialized.includes(COMMAND), 'no input value survives, at the top level or nested');
  assert.ok(serialized.includes(RESULT), 'the result does');
  assert.ok(serialized.includes('execution_record'), 'the shape is preserved: a container this file cannot name is still there');
  assert.ok(serialized.includes('status'), 'and so are its keys');
});

/**
 * The distinction that makes this a third function rather than a call to the walk.
 * A host can carry the whole signal in a KEY — `{ rate_limit_exceeded: true }` is
 * the API-limit vocabulary with no string value anywhere — and the walk collects
 * values, so it sees nothing. Measured on the classifier this projection serves,
 * swapping it for `toolResultText` turned that row from a detected limit into
 * silence.
 */
test('the projection keeps evidence carried by a key, which the value walk cannot see', () => {
  const raw = { tool_input: { prompt: COMMAND }, tool_response: { rate_limit_exceeded: true } };
  assert.ok(
    JSON.stringify(toolResultWithoutInput(toolResultPayload(raw))).includes('rate_limit_exceeded'),
    'the key is the evidence and it survives the projection',
  );
  assert.ok(
    !toolResultText(raw).includes('rate_limit_exceeded'),
    'the walk collects values, so the same evidence is invisible to it — this is why both exist',
  );
});

/**
 * Nothing to strip is not the same as nothing to return. A legacy host answers a
 * failed spawn with a bare failure STRING and no envelope at all; a projection
 * that demanded a record would turn that documented text fallback into null.
 */
test('a scalar that is not a record comes back unchanged', () => {
  assert.equal(toolResultWithoutInput('run_subagent failed: rate limit'), 'run_subagent failed: rate limit');
  assert.equal(toolResultWithoutInput(null), null);
  assert.equal(toolResultWithoutInput(7), 7);
});

/**
 * AN ARRAY IS WALKED, and this row used to assert the opposite — `an array is
 * returned as-is, by identity` — on the argument that every spelling in the
 * vocabulary is an object KEY and the one whose value is an array (`tool_calls`)
 * is dropped by name before any member is reached. True of `tool_calls`, and
 * false as a general claim: an array sits ABOVE a named key as easily as below
 * one, and `obj()` refuses arrays, so the exclusion never reached through one.
 *
 * The identity was therefore not a property worth keeping — it was the defect,
 * stated as a guarantee. Measured through the real recorder, `{ content: [{ type:
 * 'tool_use', input: { prompt } }] }` on Cursor handed the id a
 * `[t1-replace-agent]` brief quotes as RETIRED back to the run registry as this
 * run's live agent. `obj()` is engine-wide and other fences narrow through it
 * deliberately, so the array case is handled in the walks that need it and
 * `obj()` is untouched.
 *
 * A payload that IS an array is walked for the same reason rather than as a
 * special case: it is the degenerate position of the same class, and a
 * Claude-family result is a content-block LIST. What that costs is identity —
 * a walked array is a new array — and no consumer depends on it.
 */
test('an array is walked, not passed through: the exclusion reaches into one', () => {
  const array = [{ text: RESULT }, { input: { command: COMMAND } }];
  const walked = toolResultWithoutInput(array);
  assert.notEqual(walked, array, 'a walked array is a new array; identity is not the property');
  assert.ok(Array.isArray(walked), 'and it is still an array');
  assert.ok(JSON.stringify(walked).includes(RESULT), 'the result survives');
  assert.ok(!JSON.stringify(walked).includes(COMMAND), 'the input inside it does not');
  // Every position the three narrowing readers share, now that they agree: an
  // input key under an array, under a record under an array, and inside a nested
  // array. Each of these survived the projection before this round.
  for (const [label, payload] of [
    ['content[] tool_use block', { content: [{ type: 'tool_use', input: { prompt: COMMAND } }], stdout: RESULT }],
    ['a step list', { execution_record: { steps: [{ args: { command: COMMAND } }], stdout: RESULT } }],
    ['an array inside an array', { content: [[{ command: COMMAND }]], stdout: RESULT }],
  ] as const) {
    const projected = JSON.stringify(toolResultWithoutInput(payload));
    assert.ok(!projected.includes(COMMAND), `${label}: the input must not survive the projection`);
    assert.ok(projected.includes(RESULT), `${label}: the result must`);
    assert.ok(!toolResultText(payload).includes(COMMAND), `${label}: and the value walk agrees, as it always did`);
  }
});

/**
 * One vocabulary, three readers. Pinned by iteration so a spelling that the
 * container strips but the projection keeps — the drift this file exists to
 * prevent — reddens here rather than at whichever caller notices first.
 */
test('the projection excludes exactly what the container excludes', () => {
  for (const key of TOOL_INPUT_KEYS) {
    const raw: Record<string, unknown> = { stdout: RESULT };
    raw[key] = COMMAND;
    assert.ok(
      !JSON.stringify(toolResultWithoutInput(raw)).includes(COMMAND),
      `${key} is in the shared input set but survived the projection`,
    );
    assert.ok(JSON.stringify(toolResultWithoutInput(raw)).includes(RESULT), `${key}: the result must survive with it`);
  }
});

/**
 * Where the vocabulary STOPS, pinned so the next reader with a leak reaches for
 * its own exclusion instead of widening this one. `role-infer.ts` treats
 * `message`, `task`, `instructions` and `description` as spawn-input text, and it
 * is right to — but this set still must not, because those are CONTENT spellings
 * a result uses too. `{ status: 'error', message: 'you have hit your API usage
 * limit' }` is an ordinary failure envelope, and admitting `message` here would
 * delete that evidence from all three readers at once.
 *
 * The cost of holding the line, measured rather than argued. Such a field
 * survives at the payload's TOP LEVEL, and inside any container that is not
 * itself an input key. Nested under a named input key it goes with the subtree,
 * and that is how all three hosts reaching the spawn recorder send a brief — but
 * "closed in practice" was the wrong word for the rest of it: on Cursor and on
 * the Copilot envelope family a brief at the top level is reachable (both
 * adapters read a top-level `message` as prompt text), unobserved but not barred,
 * and it leaked its quoted agent id into the run registry.
 *
 * Closed at the READERS that could not tolerate it, and not here. Both live in
 * `record-agent.ts` and both take the list from `role-infer.ts`, but they exclude
 * different things because they are asking different questions: the id extractor
 * keeps only a structured `agent_id`/`agentId` KEY inside a brief-named subtree,
 * and the failure classifier drops a brief-named string outright except `message`
 * in a record reporting a decisive verdict of its own.
 *
 * The classifier having its own exclusion at all is new, and it corrects a claim
 * this comment used to make. "The classifier keeps reading them" was recorded as
 * forced, on the argument that no position rule separates a `message` in a status
 * envelope from a brief naming a limit. Measured, an ordinary first-spawn product
 * brief at the payload TOP LEVEL classified `api-limit` on Copilot and retired a
 * LIVE agent; the rule that separates them is CO-LOCATION with a verdict, not
 * depth. What that still leaves open is pinned in agent-model.test.ts, next to
 * the rows that measure it.
 */
test('the four role-infer text spellings are deliberately absent, and this is what that costs', () => {
  for (const key of ['message', 'task', 'instructions', 'description']) {
    assert.ok(!TOOL_INPUT_KEYS.has(key), `${key} must not be admitted to the shared input set`);
    const nested = { tool_input: { [key]: COMMAND }, stdout: RESULT };
    assert.ok(
      !JSON.stringify(toolResultWithoutInput(nested)).includes(COMMAND),
      `${key}: nested under a named input key it goes with the subtree`,
    );
    const bare: Record<string, unknown> = { stdout: RESULT };
    bare[key] = COMMAND;
    assert.ok(
      JSON.stringify(toolResultWithoutInput(bare)).includes(COMMAND),
      `${key}: bare at the top level it survives this projection — closed downstream at BOTH record-agent readers, each with its own exclusion, and in neither case here`,
    );
  }
  assert.ok(
    toolResultText({ tool_response: { status: 'error', message: 'you have hit your API usage limit' } }).includes('API usage limit'),
    'and this is the evidence admitting `message` would cost: a failure the classifier reads today',
  );
});

/**
 * Copilot's result field is an ASSUMPTION, and the head of tool-result.ts is the
 * one place that records what that rests on. This does not promote one shape. It
 * pins the blast radius — which readers cannot tell the shapes apart, and which
 * ones can and in which direction each errs — so that a live Copilot install
 * settling the question is a small change rather than an audit.
 *
 * This row used to be titled "nothing a shipping reader concludes depends on
 * which constructed Copilot shape is right", and that was FALSE in both
 * directions it could be. It asserted on the serialized PROJECTION rather than on
 * what a shipping reader consults, so it missed that record-agent's failure
 * classifier read its structured verdict from the payload's top level only —
 * legible under `tool_response`, invisible under the other two, and measured end
 * to end that wrote a dead subagent back into the run registry as live. That is
 * fixed at the reader (`toolResultVerdictSources`, pinned above and end to end in
 * agent-model.test.ts, since the classifier is not this leaf's to import).
 *
 * And the version after THAT asserted the same shape one layer down. It read
 * `toolResultWithoutInput(toolResultPayload(raw))` under the claim that this was
 * "record-agent's two readers … the same projection", which had already stopped
 * being true in both halves: the id extractor takes an additional brief
 * exclusion, and the classifier's structured half goes through
 * `toolResultVerdictSources` while its text half takes a brief exclusion of its
 * own. What is shared is the INPUT vocabulary and nothing else, so that is what
 * this row asserts now — and what each reader adds on top of it is pinned where
 * it is implemented.
 */
test('which readers cannot tell the constructed Copilot shapes apart, and which one still can', () => {
  for (const envelope of ['tool_response', 'execution_record', 'tool_output']) {
    const raw: Record<string, unknown> = {
      tool_name: 'task',
      tool_args: JSON.stringify({ command: COMMAND }),
      tool_input: { command: COMMAND },
    };
    raw[envelope] = { status: 'failed', text: RESULT };
    // page-speed's reader: a walk, so the envelope's name is never consulted.
    assert.ok(toolResultText(raw).includes(RESULT), `${envelope}: the result text is read`);
    assert.ok(!toolResultText(raw).includes(COMMAND), `${envelope}: and the input still is not`);
    // The one thing record-agent's two readers really do share, and all they
    // share: this vocabulary, and therefore this exclusion.
    const projected = JSON.stringify(toolResultWithoutInput(toolResultPayload(raw)));
    assert.ok(!projected.includes(COMMAND), `${envelope}: the shared exclusion drops the input`);
    // And the structured verdict both they and model-gate consult, which is
    // legible in all three shapes because it names none of them.
    const sources = toolResultVerdictSources(toolResultPayload(raw));
    assert.deepEqual(
      [sources.own, ...sources.nested].map((source) => source?.status).filter(Boolean),
      ['failed'],
      `${envelope}: exactly one source reports the verdict, wherever the envelope put it`,
    );
  }
  // The reader that is STILL sensitive, and the direction it fails in. Byte
  // ACCOUNTING refuses to guess an unnamed container, so on two of the three
  // shapes the token logger books zero output bytes instead of measuring the
  // wrong value — an undercount, never a wrong count, into a file with no reader
  // in `src/` and behind an opt-in flag. Null is the honest answer HERE, so that
  // stays.
  //
  // `model-gate`'s `shellExitFailed` used to be the second, reading a FAILED gate
  // as PASSING on the two unnamed shapes. It no longer reaches them through this
  // function at all — it reads `toolResultVerdictSources` — and the flip is pinned
  // in modules/agent-model/__tests__/model-gate.test.ts, where reverting it reds.
  assert.notEqual(toolResultContainer({ tool_response: { text: RESULT } }), null, 'a wrapper spelling is named, so it is measured');
  assert.equal(toolResultContainer({ execution_record: { text: RESULT } }), null, 'an envelope nothing names is refused, not guessed');
  assert.equal(toolResultContainer({ tool_output: RESULT }), null, 'and so is a flat key nothing names');
});

/**
 * The walk is bounded, inherited from the reader this leaf replaced. Pinned rather
 * than assumed: a host that nests a result deeper than this is read as silence, and
 * that is a known limit rather than an accident to rediscover.
 */
test('the walk is bounded at four levels below the payload', () => {
  assert.ok(toolResultText({ a: { b: { c: { d: RESULT } } } }).includes(RESULT), 'four levels is inside the bound');
  assert.ok(!toolResultText({ a: { b: { c: { d: { e: RESULT } } } } }).includes(RESULT), 'five is outside it');
});
