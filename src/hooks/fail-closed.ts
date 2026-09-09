// Last-resort host-wire fallbacks. runPipeline protects failures thrown by a
// handler, while these helpers protect the wider boundary: module discovery,
// adapter parsing, context construction, and serialization. A pre-tool hook must
// never become an empty success merely because the plugin runtime is damaged.

import { codexHookEvidenceMarker } from '../shared/codex-hook-evidence';
import { isExemptShellToolName, isTrafficOneDoctorCommand, isTrafficOneResetCommand } from '../shared/tool-classify';

// Shared remediation sentence — interpolated into every fail-closed deny,
// including generated host wrappers (kilo-host), so the prose can't drift.
// Cursor's user channel gets the short first sentence; the agent channel
// (and every single-channel host) gets the full sentence.
export const PRE_TOOL_USER_REMEDIATION = 'Retry the same action.';
export const PRE_TOOL_REMEDIATION = `${PRE_TOOL_USER_REMEDIATION} If it keeps happening, run Traffic One doctor.`;

// Host hook payloads are required to be JSON objects. The shared adapters use a
// permissive parser for lifecycle compatibility, so validate at the entry
// boundary before a pre-tool dispatch: otherwise malformed/truncated stdin is
// normalized to `{}` and silently becomes an allow.
export function hasValidHookObjectPayload(stdin: string): boolean {
  try {
    const parsed = JSON.parse(stdin);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

type HookRecord = Record<string, unknown>;
type PreToolPayloadSurface = 'nested' | 'wrapper' | 'cursor' | 'copilot' | 'windsurf';

function hookRecord(stdin: string): HookRecord | null {
  try {
    const parsed = JSON.parse(stdin) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as HookRecord
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): HookRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as HookRecord
    : {};
}

function firstText(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function hasOwnValue(value: HookRecord, ...keys: readonly string[]): boolean {
  return keys.some((key) => Object.prototype.hasOwnProperty.call(value, key)
    && value[key] !== undefined
    && value[key] !== null);
}

function workspaceIdentity(data: HookRecord): string {
  const input = record(data.input);
  const session = record(data.session);
  const workspace = record(data.workspace);
  const info = record(data.tool_info ?? data.toolInfo);
  const direct = firstText(
    data.cwd, data.projectRoot, data.workspaceRoot, data.workspace_root, data.root,
    data.workdir, data.workingDir,
    input.cwd, input.projectRoot, input.workspaceRoot,
    session.cwd, session.root,
    workspace.root, workspace.path,
    info.cwd, info.working_directory, info.workingDirectory,
    // Cascade file hooks may omit cwd and identify the project only through an
    // absolute file target; its adapter intentionally derives cwd from this.
    data.file_path, data.filePath, data.path, data.uri,
    info.file_path, info.filePath, info.path, info.uri,
  );
  if (direct) return direct;
  const roots = data.workspace_roots ?? data.workspaceRoots ?? data.workspaceFolders;
  const values = Array.isArray(roots) ? roots : (roots == null ? [] : [roots]);
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    const item = record(value);
    const path = firstText(item.path, item.uri, item.fsPath);
    if (path) return path;
  }
  return '';
}

// The generic ("wrapper"/fallback) input record, shared by every helper below
// that needs to look at a wrapper tool call's arguments regardless of which
// of the several documented field names carries them (`tool_input`, `output.
// args`, `tool.args`, …) — kept as ONE priority list so a caller who wants
// the wrapper's tool name and a caller who wants its command argument agree
// on which field wins when more than one is present.
function genericToolInputRecord(data: HookRecord): HookRecord {
  const tool = record(data.tool);
  const output = record(data.output);
  return record(
    data.tool_input
      ?? data.toolInput
      ?? output.args
      ?? data.input
      ?? data.args
      ?? data.arguments
      ?? tool.input
      ?? tool.args
      ?? tool.arguments,
  );
}

function genericToolName(data: HookRecord): string {
  const tool = record(data.tool);
  const output = record(data.output);
  const outputArgs = record(output.args);
  const input = genericToolInputRecord(data);
  return firstText(
    data.tool_name, data.toolName, data.toolNameRaw, data.name,
    typeof data.tool === 'string' ? data.tool : undefined,
    tool.name, tool.id, tool.tool, tool.type,
    input.tool_name, input.toolName, input.name, input.tool,
    outputArgs.tool_name, outputArgs.toolName, outputArgs.name,
  );
}

function genericToolInputPresent(data: HookRecord): boolean {
  const tool = record(data.tool);
  const output = record(data.output);
  return hasOwnValue(data, 'tool_input', 'toolInput', 'input', 'args', 'arguments')
    || hasOwnValue(output, 'args')
    || hasOwnValue(tool, 'input', 'args', 'arguments');
}

function commandText(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  const info = record(data.tool_info ?? data.toolInfo);
  return firstText(
    data.command, data.cmd, data.shell_command, data.shellCommand,
    input.command, input.cmd,
    info.command_line, info.commandLine, info.command, info.cmd,
  );
}

function filePathText(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  const info = record(data.tool_info ?? data.toolInfo);
  const document = record(data.document);
  return firstText(
    data.file_path, data.filePath, data.path, data.uri,
    input.file_path, input.filePath, input.path, input.uri,
    info.file_path, info.filePath, info.path, info.uri,
    document.path, document.uri,
  );
}

// Syntax alone is insufficient at a blocking boundary: `{ "cwd": "..." }`
// is valid JSON but gives the adapter no tool to classify, which becomes a
// silent allow. Validate the minimum fields each host/subcommand needs while
// leaving lifecycle and post-tool payloads on their existing fail-open path.
export function hasValidPreToolPayload(
  stdin: string,
  subcommand: string | undefined,
  surface: PreToolPayloadSurface,
): boolean {
  const data = hookRecord(stdin);
  if (!data || !workspaceIdentity(data)) return false;
  const sub = String(subcommand || '');

  if (surface === 'nested') {
    return Boolean(firstText(data.tool_name, data.toolName))
      && hasOwnValue(data, 'tool_input', 'toolInput');
  }
  if (surface === 'wrapper') {
    return Boolean(genericToolName(data)) && genericToolInputPresent(data);
  }
  if (surface === 'copilot') {
    const calls = data.tool_calls ?? data.toolCalls;
    const callHasTool = Array.isArray(calls) && calls.some((value) => {
      const call = record(value);
      return Boolean(firstText(call.name, call.tool_name, call.toolName))
        && hasOwnValue(call, 'args', 'arguments', 'input');
    });
    return callHasTool || (Boolean(genericToolName(data))
      && hasOwnValue(data, 'tool_args', 'toolArgs', 'tool_input', 'toolInput', 'input', 'args', 'arguments'));
  }
  if (surface === 'cursor') {
    if (sub === 'before-shell-execution') return Boolean(commandText(data));
    if (sub === 'before-read-file') return Boolean(filePathText(data));
    if (sub === 'before-mcp-execution') {
      const server = firstText(
        data.mcp_server_name, data.mcpServerName, data.server_name, data.serverName,
        data.server, data.command, data.url,
      );
      const tool = firstText(data.mcp_tool_name, data.mcpToolName, data.tool_name, data.toolName, data.name);
      return Boolean(server && tool);
    }
    return Boolean(genericToolName(data)) && genericToolInputPresent(data);
  }

  const info = record(data.tool_info ?? data.toolInfo ?? data.input);
  if (sub === 'pre_run_command') return Boolean(commandText(data));
  if (sub === 'pre_read_code' || sub === 'pre_write_code') return Boolean(filePathText(data));
  if (sub === 'pre_mcp_tool_use') {
    return Boolean(firstText(info.mcp_server_name, info.mcpServerName)
      && firstText(info.mcp_tool_name, info.mcpToolName));
  }
  return false;
}

// ── Per-surface EXECUTED command text ────────────────────────────────────
//
// commandText() above is a deliberately permissive union used for payload
// VALIDATION ("is there a command at all"), where reading one field too many
// only ever rejects more. It is the wrong reader for an exemption: it puts
// top-level `data.command` ahead of everything, so a payload carrying a
// stray `command` sibling would be JUDGED on that string while the host
// actually executes a different field. Each reader below instead mirrors, in
// order, exactly what that surface's own adapter reads — so the text this
// exemption inspects is the text that runs.
//
// Claude/Codex (adapters/claude.ts): `tool_input.command ?? .cmd`, nothing
// top-level.
function nestedShellCommand(data: HookRecord): string {
  const input = record(data.tool_input ?? data.toolInput);
  return firstText(input.command, input.cmd);
}

// Cursor (adapters/cursor.ts).
function cursorShellCommand(data: HookRecord): string {
  const input = record(data.input ?? data.tool_input ?? data.toolInput);
  return firstText(data.command, data.cmd, data.shell_command, data.shellCommand, input.command, input.cmd);
}

// Windsurf/Devin (adapters/windsurf.ts): the command lives ONLY on the
// tool_info record — this surface is why the union reader was wrong.
function windsurfShellCommand(data: HookRecord): string {
  const info = record(data.tool_info ?? data.toolInfo ?? data.input);
  return firstText(info.command_line, info.commandLine, info.command, info.cmd);
}

// Kilo/OpenCode wrapper (adapters/kilo.ts): top-level first, then the nested
// input record (which is where output.args/tool.args land), then tool.command.
function wrapperShellCommand(data: HookRecord): string {
  const input = genericToolInputRecord(data);
  const tool = record(data.tool);
  return firstText(data.command, data.cmd, input.command, input.cmd, tool.command);
}

// Copilot flat shape (adapters/copilot.ts).
function copilotFlatShellCommand(data: HookRecord): string {
  const toolArgs = parseArgsRecord(data.tool_args ?? data.toolArgs ?? data.tool_input ?? data.toolInput);
  const input = record(data.input ?? toolArgs);
  return firstText(data.command, data.cmd, input.command, input.cmd, toolArgs.command, toolArgs.cmd);
}

// Copilot sends tool-call arguments either as an object or as a JSON STRING;
// its adapter parses both (parseToolArgs), so this must too or a legitimate
// doctor call in the stringified shape would stay blocked.
function parseArgsRecord(value: unknown): HookRecord {
  if (typeof value === 'string' && value.trim()) {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return record(value);
}

// Every shell command this payload would execute, IF the payload is shaped as a
// shell tool invocation on this surface — null when it is not one (a file edit,
// an MCP call, a bare read; none of those is how doctor is invoked) or when any
// member of a batch is not a shell call. A LIST, not a string, because Copilot
// can carry several `tool_calls` in one payload: the exemption below has to
// clear all of them, not the first one that happens to be doctor.
//
// `isExemptShellToolName`, never `isShellToolName`: the latter reads the last
// dot-segment, so `mcp__evil.Bash` (or `someserver.Bash`, or a qualified
// `exec_command`) was shell HERE, and a `command` field beside it carried the
// whole payload over the boundary while the fields the server actually executes
// went unread. See that predicate's docblock for what was measured before
// narrowing, and the SECURITY block below for the claim this corrects.
//
// The tool NAME is only half of it, and the smaller half. A server may call its
// tool `Bash` with no qualifier at all, and no predicate over a name can tell
// that apart from a host's own shell tool. What can is the SUBCOMMAND: two
// surfaces route MCP calls to a dedicated one, and on those a shell command is
// not merely unlikely, it is a shape the host does not produce. Cursor sends
// shell on `before-shell-execution`; Windsurf sends it on `pre_run_command`;
// `before-mcp-execution` and `pre_mcp_tool_use` are MCP-only, and this file's
// own payload validation already requires an mcp server+tool pair on them. So
// they deliver no exemption regardless of what the tool is called.
//
// TWO of the five surfaces, and the other three have no second end: `nested`,
// `wrapper` and `copilot` carry no subcommand, so on those the name test is the
// only test and its strength is the host's naming CONVENTION (MCP tools arrive
// qualified). No hostile shape got through either way — that is measured — but
// a convention and a fence are different claims and the SECURITY block below
// says which is which.
const MCP_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set(['before-mcp-execution', 'pre_mcp_tool_use']);

function shellCommandBatchForSurface(
  data: HookRecord,
  subcommand: string,
  surface: PreToolPayloadSurface,
): string[] | null {
  if (MCP_ONLY_SUBCOMMANDS.has(subcommand)) return null;
  if (surface === 'cursor') {
    return subcommand === 'before-shell-execution'
      ? [cursorShellCommand(data)]
      : (isExemptShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null);
  }
  if (surface === 'windsurf') {
    return subcommand === 'pre_run_command'
      ? [windsurfShellCommand(data)]
      : (isExemptShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null);
  }
  if (surface === 'nested') {
    return isExemptShellToolName(firstText(data.tool_name, data.toolName)) ? [nestedShellCommand(data)] : null;
  }
  if (surface === 'copilot') {
    const calls = data.tool_calls ?? data.toolCalls;
    if (Array.isArray(calls)) {
      if (calls.length === 0) return null;
      const commands: string[] = [];
      for (const value of calls) {
        const call = record(value);
        if (!isExemptShellToolName(firstText(call.name, call.tool_name, call.toolName))) return null;
        const args = parseArgsRecord(call.args ?? call.arguments ?? call.toolArgs ?? call.tool_args ?? call.input);
        commands.push(firstText(args.command, args.cmd));
      }
      return commands;
    }
    return isExemptShellToolName(genericToolName(data)) ? [copilotFlatShellCommand(data)] : null;
  }
  // 'wrapper' (Kilo/OpenCode).
  return isExemptShellToolName(genericToolName(data)) ? [wrapperShellCommand(data)] : null;
}

// ── The recovery allowlist ───────────────────────────────────────────────────
// One row per RUNNER that must stay reachable when everything else is broken,
// each row an exact argv grammar. A table rather than an `if` on doctor because
// the property being asserted is about the SET ("recovery is never gated"), and
// a set spread across call sites is a set nobody can audit; this way the
// complete answer to "what can bypass the fail-closed boundary?" is the length
// of this array.
//
// THE RULE FOR ADDING A ROW, and it is not negotiable: a row must not be able
// to buy its caller a DECISION the gates would have withheld. This boundary is
// reached precisely because the machinery that would have judged the call is
// broken, so whatever a row admits is admitted UNJUDGED — and the exemption is
// sound only because what it admits, judged or not, is the same thing either
// way (see the SECURITY block below).
//
// For doctor that holds the short way: it is read-only, so there is no decision
// to buy. A MUTATING runner can only qualify the long way, by carrying every
// precondition the gates would have applied INSIDE itself, evaluated from disk
// under the project's own lock — so that reaching it unjudged and reaching it
// judged produce the identical outcome. `reset` is the only runner that has
// ever cleared that bar, and the five properties it clears it with are stated
// on its row. Read them as the test, not as a description.
//
// Worked example, because this one WILL come up: `run-status --status failed`
// is the standard way to unwedge a stuck run, and it belongs on no allowlist.
// It rewrites the run ledger, it takes the verdict from ARGV rather than from
// disk, and a wedged run is exactly the state in which an agent would most like
// to declare the run over — the gates that stop it doing so are the point. An
// operator with a genuinely wedged run runs it from their own terminal, where
// no hook fires at all; that is what the escape hatch IS. (Same reasoning
// forbids a blanket "no gate may deny anything inside the plugin root" rule,
// which would un-gate it by the back door.)
//
// `doctor --unblock <gateId>` is likewise absent, from tool-classify.ts's
// grammar and therefore from here: it is the one doctor invocation that writes,
// and an agent able to mint its own override has a bypass, not an escape hatch.
// The PreToolUse deny is namesDoctorUnblock / doctor-unblock-agent-mint, not
// an exemption row.
interface RecoveryRunner {
  readonly id: string;
  /** The runner's own exact argv grammar. Biased to DENY; see tool-classify.ts. */
  readonly matches: (command: string) => boolean;
}

// EXPORTED for one reason: the rule above is prose, and prose is not an
// invariant — the next author can satisfy it by believing they satisfy it.
// __tests__/recovery-runners.test.ts pins this table's exact membership and
// restates the rule at the failure site, so a new row cannot appear without a
// deliberate test edit that puts the rule in front of whoever adds it, and
// mechanically asserts the five properties the `reset` row claims below — plus,
// since a citation is itself a claim, that every test its rule block NAMES
// exists.
export const RECOVERY_RUNNERS: readonly RecoveryRunner[] = [
  { id: 'doctor', matches: (command) => isTrafficOneDoctorCommand('Bash', { command }) },
  // `traffic-one-reset --run-id <id>`: the one recovery edge out of a terminal
  // `failed` run, and the only mutating row this table has. It clears the bar
  // above on five properties, each of which is enforced in code and pinned by a
  // test, not asserted here (__tests__/recovery-runners.test.ts names the exact
  // test for each):
  //   1. Its precondition comes from DISK, never from argv. It refuses unless
  //      <id> IS the project's `currentRunId` and that run's ledger legibly
  //      reads terminal `failed` (through effectiveLegacyRunStatus, so a V2 run
  //      behind the rollback barrier is not mistaken for one). Argv selects
  //      WHICH run is checked; it can never state the verdict.
  //   2. Nothing an agent may run DECLARES `failed`. The verb is the property:
  //      `run-status --status failed` states the verdict from argv, and it is
  //      gated and on no allowlist, so the two exemptions cannot compose
  //      DIRECTLY into "declare the run over, then reset out of it". Terminal
  //      `failed` is nonetheless REACHABLE by an agent — an OpenCode delegation
  //      that fails terminally with paid fallback disallowed writes it, and the
  //      settlement reconciler adopts it at the next prompt boundary — measured
  //      through a maintenance path with no status command anywhere. This row
  //      used to claim the stronger, false thing and lean on it. What prices the
  //      composition it cannot rule out is property 5's widening: reaching
  //      `failed` and resetting carries the bounds with you, and at WIDEN_AT
  //      resets the successor inherits more, so the loop stops being free ON
  //      CURSOR. That qualifier was missing and it is not hedging: the widening
  //      is priced at exactly one deny, `correlatedCursorFailureGate`, which
  //      returns null on `ctx.host !== 'cursor'`. The reader's other two call
  //      sites (cursor-failure-select.ts:211, cursor-failure-persist.ts:152)
  //      only skip a redundant store write, so on Claude and Codex the
  //      inherited marker gates nothing at any deny and this lean has no price
  //      behind it. What holds on every host is the CARRY — the bounds keyed by
  //      the run id follow the pointer regardless — so the composition is
  //      conserved everywhere and REFUSED only on Cursor.
  //      THAT LEAN IS ONLY AS GOOD AS THE PRICE, and for one round it was not
  //      good at all: the widening was implemented as an extra carry INTO
  //      `exhausted-models.json`, so the single capability that drops that bound
  //      — holding its lease — also suppressed the price. Measured over six
  //      cycles against a successor whose lease was held: nothing widened, ever,
  //      while the control widened from cycle 3. The price now lands in
  //      `.resets.json` (one writer, no lease, written by the same call that
  //      counts the reset), and the same six cycles now widen from 3 with the
  //      lease still held. THAT "ONE WRITER" IS LOAD-BEARING FOR THIS ROW AND
  //      WAS BRIEFLY FALSE: the discharge half was a second lease-free
  //      read-modify-write reached from a hook, and every increment it clobbers
  //      rolls the ladder back toward the free resets this row leans on it to
  //      price. Measured at 58-72 lost per 300 with two real processes when the
  //      writer was live; re-derived on a reconstruction of it at 104-143 lost
  //      per 300 over three trials, against a control that loses none. The loss
  //      rate is load- and shape-dependent and is not a constant — what the row
  //      leans on is that it is not zero.
  //      The discharge is a fold in `resetObligationFor` now, not a write. What
  //      pins that is a behavioural table — every product entrypoint that could
  //      acquire a write, driven, with the record byte-compared across it, and
  //      the reset command in the table as the positive control. It replaces a
  //      source scan for the path's spellings, which an adversarial review beat
  //      in one character (a template literal) with a real second writer live on
  //      the hook path and the whole surface green; that scan is kept only as a
  //      tripwire for the naive spelling.
  //      THE RESIDUAL THIS ROW NAMED FOR ONE ROUND DESCRIBED THE WRONG
  //      ADVERSARY, and the correction is recorded rather than swapped in
  //      silently. It said: "an actor with UNMEDIATED writes into
  //      `.traffic-one/` can delete that record — and EVERY OTHER BOUND WITH IT
  //      — but nothing on this row grants that capability, and an actor who
  //      already has it does not need a reset." Both emphasised clauses were
  //      false, and false in the direction the row leaned. The actor needed no
  //      unmediated write: `rm -f .traffic-one/runs/.resets.json` as an ordinary
  //      Bash tool call, straight through the hook, and measured through the
  //      real `planWriteGate` on a materialized fixture — 7 of 27 erasure
  //      channels PERMITTED with a run pointer live, and all 27 permitted with
  //      `currentRunId` absent, because the only thing refusing the path was
  //      `strayRunIdInText` misreading the filename as a fabricated run id and
  //      that guard stands down when nothing is minted. Nor did it take every
  //      bound with it: the other two sit inside `runs/<id>/` and are refused by
  //      `runtime-sidecar-owner-gate`, so the mediated actor deleted the ONE
  //      bound this row's price depends on and nothing else. The record's price
  //      was therefore the least defended of the three, not the best.
  //      WHAT HOLDS NOW is a fence of the record's own:
  //      `reset-record-owner-gate` (modules/plan-guard/plan-readiness/index.ts,
  //      with plan-write/reset-record-shell.ts reading the shell shapes) refuses
  //      every channel the gate can see — Write/Edit/apply_patch, a named shell
  //      write under any verb that is not a recognised read, and destruction of
  //      a directory containing the record. It reads no run pointer, so the
  //      `currentRunId`-absent variant is closed too, and the same 27 channels
  //      now measure 0 escapes across all four pointer variants. The misparse
  //      that used to stand there is deliberately gone (shared/run-id-paths.ts
  //      skips dot-prefixed segments), so this row leans on a fence rather than
  //      on an accident, and both halves are pinned at the gate in
  //      modules/plan-guard/__tests__/reset-record-fence.test.ts.
  //      THE REMAINING RESIDUAL is narrower and is genuinely unmediated: a write
  //      that never passes the hook (a spawned process, an editor outside the
  //      session) still reaches the record, as it reaches everything else in the
  //      project. THE MEDIATED HALF OF THAT SENTENCE LISTED FOUR MEMBERS AND
  //      THREE OF THEM ARE NOW REFUSED, so the false version is recorded rather
  //      than swapped out. It said: "What survives inside the mediated channel
  //      is a shell line that hides the path from static reading — assembled
  //      through `cd`, a variable, `$(…)`, or joined inside interpreter code —
  //      which is a breach of this fence rather than a route it grants, and is
  //      the same residue every path-based gate in this tree carries."
  //      Re-measured at the gate on a materialized fixture, with real bash run
  //      on a parallel fixture to say whether the line erases anything at all,
  //      in each state this fence is reached in — a live run, a finished one,
  //      and after a reset: `cd` into `runs/` and then naming the record, the
  //      runs directory held in a variable and expanded, and an interpreter
  //      join whose pieces still leave a whole `.traffic-one` OR a whole
  //      `.resets.json` are refused in every one of them. WHICH fence refuses
  //      is worth naming, because leaning on the wrong one is the mistake this
  //      row already made once, and it is not uniformly this one: while a run
  //      directory exists, MOST of these are answered first by the run's own
  //      `runtime-assignments-owner-gate`, and only once it is gone — the state
  //      where the record is the only thing left in `runs/` to destroy — does
  //      this record's fence answer them. So what is measured is that the write
  //      is refused in every one of those states, NOT that this row's own fence
  //      is the thing refusing it in every one.
  //      WHAT ACTUALLY SURVIVES is three mechanisms, not four spellings:
  //        - what a substitution PRINTS. The gate reads a substitution's own
  //          body as a statement, so a destructive body is refused there; a
  //          body that only reads (`cat` of a file that holds the path) is a
  //          legal read, and the operand it yields exists only at run time.
  //          Survives in every state.
  //        - a substitution or an `eval` whose body spells the runs directory
  //          itself, once no run directory exists. While one does, the sidecar
  //          pair refuses it.
  //        - an interpreter join that splits BOTH names through the middle, so
  //          no fragment spells either `.traffic-one` or the record's filename.
  //          Survives in every state.
  //      All three are lines built so that no reader of the text can see which
  //      file they name, which is why each is a breach of this fence rather
  //      than a route it grants.
  //      THE CLOSING GENERALISATION IS WITHDRAWN, not restated. "The same
  //      residue every path-based gate in this tree carries" is a claim about a
  //      population nobody enumerated — the shape this tree has had falsified
  //      twice — and the two fences that were actually measured against each
  //      other disagree: the `$(…)`/`eval` member is refused by the run-scoped
  //      sidecar pair while a run directory exists and reaches noop at this
  //      fence once it is gone. So the residue is a property of the gate AND of
  //      the project state rather than a floor every gate shares. What the two
  //      measured fences do share is the substitution's printed operand and the
  //      fully-split join. No third gate was measured, and nothing here says
  //      what one would show.
  //   3. It cannot fabricate progress. It writes no terminal outcome, mints no
  //      override, and never touches the failed run's ledger — the successor is
  //      `planned`, which is where a run starts anyway.
  //   4. It destroys nothing. The retired run's dir, digests and evidence stay
  //      on disk; only `currentRunId` moves.
  //   5. It does not LAUNDER what the pointer keys. Properties 3 and 4 are about
  //      what it writes; this one is about what a pointer move DISCARDS, and it
  //      is what makes property 2's residual survivable: every `runs/<id>/` entry
  //      is classified, the bounds are carried to the successor
  //      (runners/traffic-one-reset/obligations.ts), every reset is recorded, and
  //      at WIDEN_AT the successor inherits the terminal exhaustion its
  //      predecessor reached — recorded in `.resets.json` rather than carried
  //      into the store it applies to, so the price is not defeatable by the
  //      capability that defeats the bound (see property 2). THE PRICE IS NOW IN
  //      TWO PLACES, which is what answers the residual property 2 discloses
  //      rather than closing it: the reset also stamps the count and that
  //      inherited exhaustion into the successor's own `runs/<id>/run.json`
  //      beside the `supersedes` it already writes, and both readers take the
  //      record UNION that mirror with the user's enable/retry discharge ahead
  //      of both (runners/traffic-one-reset/resets.ts THE MIRROR). So erasing
  //      the record ALONE — the three spellings above — no longer buys a free
  //      reset or an unbound respawn, measured after a real `rm` through the
  //      printed-substitution spelling. It buys the payoff back by taking BOTH
  //      copies, which the same spelling does at no refusal when it is aimed at
  //      `runs/` instead of at one file, so this is a narrower breach and not a
  //      closed one. WHAT ENFORCES IT
  //      is named because it is not obvious and was read wrongly once: the
  //      inheritance is a deny at the Cursor spawn gate
  //      (correlatedCursorFailureGate → `cursor-api-limit-terminal`), not a
  //      record something might one day consult. The reader's other two call
  //      sites merely skip a redundant write, so an audit that stops at them
  //      concludes this row leans on nothing.
  // So an agent that reaches this unjudged gets exactly what it would have got
  // judged: on a wedged project, the recovery; on any other project, a refusal.
  { id: 'reset', matches: (command) => isTrafficOneResetCommand('Bash', { command }) },
];

function isRecoveryCommand(command: string): boolean {
  return Boolean(command) && RECOVERY_RUNNERS.some((runner) => runner.matches(command));
}

// A fail-closed boundary — the early payload-validation check and the runtime
// catch block below — sees only raw, unparsed stdin. It runs BEFORE (or
// instead of, once the pipeline has thrown) the adapter/pipeline machinery
// that normally turns that stdin into the (toolName, toolInput) pair the
// onboarding gate's OWN isTrafficOneDoctorCommand check runs on. This helper
// closes that gap by extracting the same shell-command text directly off raw
// stdin (the pattern isManagedCursorMcpInvocation in cursor-entry.ts already
// uses for a different early, pre-dispatch decision) and running it through
// the identical bounded exact-argv grammar.
//
// SECURITY: this is the only recovery exemption anywhere in the fail-closed
// boundary, and every constraint below is deliberate, not incidental:
//  - it can only ever produce a NOOP (fall through to the normal allow path),
//    never a deny, an elevated tool, or a state mutation — a bug here can at
//    worst UNDER-exempt (doctor stays blocked), never grant a new capability;
//  - it fires only when the raw payload parses as an object AND is shaped as
//    a Bash/exec_command invocation (never Write/Edit/apply_patch). "Never
//    MCP" was ASSERTED here and was false: shell-ness was decided from the
//    last dot-segment of the tool name, so `mcp__evil.Bash` carrying a
//    `command` field cleared this boundary — and for a real MCP tool that
//    field is not what executes, so every other argument in the call rode
//    along unjudged. The byte-match that protects the sibling row does not
//    reach it, because the string being matched is not the string the server
//    runs. Now narrowed at both ends WHERE A SECOND END EXISTS, which is not
//    everywhere and the earlier "closed at both ends" overstated it: an
//    exemption always requires an UNQUALIFIED shell tool name
//    (isExemptShellToolName), and on the two surfaces that route MCP to a
//    dedicated subcommand — `cursor` and `windsurf` — a subcommand a host
//    reserves for MCP yields no exemption at all (MCP_ONLY_SUBCOMMANDS). On
//    `nested`, `wrapper` and `copilot` there is no subcommand to consult, so
//    the residual rests entirely on the host NAMING CONVENTION: those surfaces
//    qualify MCP tool names (`mcp__server.Tool`, `server.tool`), and an
//    unqualified `Bash` from a server that declines to qualify would be
//    indistinguishable from the host's own shell tool. That is a convention,
//    not a fence, and it is the honest boundary of this claim. Both ends are
//    measured against every adapter fixture and the replay corpus, and nothing
//    hostile got through; see those two for what was checked;
//  - on a multi-call payload (Copilot's `tool_calls`) EVERY call must be a
//    shell call AND must satisfy a grammar. Requiring only one to match
//    exempted the whole payload off a single doctor entry, so
//    `[doctor, rm -rf /]` passed while `[rm -rf /, doctor]` did not — a batch
//    is exempt only if there is nothing in it but recovery commands;
//  - the command text itself must satisfy some row's bounded exact-argv
//    grammar (tool-classify.ts): for doctor, `node <doctorScriptPath()>` with
//    at most one recognized flag — no prefix match, no arbitrary trailing
//    argv, no other binary, no shell metacharacters (cleanShellWords rejects
//    those upstream). Widening what this exemption admits means widening one
//    of those grammars, each unit-tested adversarially on its own;
//  - it needs nothing from the subsystems a fail-closed boundary exists
//    BECAUSE they might be broken (module discovery, the pipeline, state
//    I/O) — it is pure string parsing over the same JSON the boundary has
//    already decoded, so it stays available exactly when doctor itself needs
//    to become reachable;
//  - it grants no capability a user did not already have: the pre-tool gate
//    this bypasses exists to stop an AUTOMATED agent action, not a human
//    running a binary directly, and the model can only reach this shape by
//    literally re-emitting a documented recovery command.
export function isFailClosedRecoveryExemption(
  stdin: string,
  subcommand: string | undefined,
  surface: PreToolPayloadSurface,
): boolean {
  const data = hookRecord(stdin);
  if (!data) return false;
  const commands = shellCommandBatchForSurface(data, String(subcommand || ''), surface);
  if (!commands || commands.length === 0) return false;
  return commands.every(isRecoveryCommand);
}

// Honor a recognized recovery command; if the check itself throws, fail closed
// (do not exempt). A throw here must not disable the pre-tool deny.
export function safeFailClosedRecoveryExemption(
  stdin: string,
  subcommand: string | undefined,
  surface: PreToolPayloadSurface,
): boolean {
  try {
    return isFailClosedRecoveryExemption(stdin, subcommand, surface);
  } catch {
    return false;
  }
}

export function preToolFailureReason(host: string): string {
  return `Traffic One ${host} pre-tool gate could not make a decision because the host payload or runtime failed, so this tool call is blocked fail-closed. ${PRE_TOOL_REMEDIATION}`;
}

export function isGatePreToolSubcommand(subcommand: string | undefined): boolean {
  const value = String(subcommand || '');
  return value.startsWith('check-') || value === 'pre-graphify-hint';
}

export function isCursorPreToolSubcommand(subcommand: string | undefined): boolean {
  return new Set(['before-shell-execution', 'before-read-file', 'before-mcp-execution', 'before-tool-use']).has(String(subcommand || ''));
}

export function isWindsurfPreToolAction(action: string | undefined): boolean {
  return new Set(['pre_read_code', 'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use']).has(String(action || ''));
}

export function nestedPreToolDeny(host: string, reason: string = preToolFailureReason(host)): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      ...(host.trim().toLowerCase() === 'codex'
        ? { additionalContext: codexHookEvidenceMarker('PreToolUse') }
        : {}),
    },
  });
}

export function cursorPreToolDeny(reason?: string): string {
  const agentMessage = reason ?? preToolFailureReason('Cursor');
  // Default fail-closed path: calm user chrome, full reason to the agent.
  // A caller-supplied reason (managed MCP deny) stays the same on both sides.
  const userMessage = reason === undefined ? PRE_TOOL_USER_REMEDIATION : agentMessage;
  return JSON.stringify({ permission: 'deny', user_message: userMessage, agent_message: agentMessage });
}

export function copilotPreToolDeny(surface: 'cli' | 'vscode', reason: string = preToolFailureReason('Copilot')): string {
  return surface === 'cli'
    ? JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason })
    : nestedPreToolDeny('Copilot', reason);
}

export function wrapperPreToolDeny(host: string): string {
  return JSON.stringify({ kind: 'deny', reason: preToolFailureReason(host) });
}

export function devinPreToolDeny(): string {
  return JSON.stringify({ decision: 'block', reason: preToolFailureReason('Windsurf/Devin') });
}
