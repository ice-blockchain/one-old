// src/runners/opencode-mcp/server.ts
// A zero-dependency MCP stdio server (newline-delimited JSON-RPC 2.0). The plugin
// ships no node_modules, so we cannot use @modelcontextprotocol/sdk — but the
// stdio surface we need is tiny: initialize, tools/list, tools/call, ping, and
// the initialized notification. stdout carries ONLY JSON-RPC frames; everything
// diagnostic goes to stderr (anything else corrupts the transport).

import type { Readable, Writable } from 'stream';

import { asRecord, asString } from '../../adapters/coerce';
import {
  OPENCODE_MCP_PROTOCOL_VERSION,
  OPENCODE_MCP_SERVER_KEY,
  OPENCODE_MCP_SERVER_VERSION,
  OPENCODE_MCP_TOOL_DELEGATE,
  OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN,
  OPENCODE_MCP_TOOL_STATUS,
} from '../../config/opencode-mcp';
import { delegateFromPlanResumable, delegateResumable, delegateStatus } from './delegate';

type Id = string | number | null;
interface RpcMessage { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown; }

const TOOLS = [
  {
    name: OPENCODE_MCP_TOOL_DELEGATE,
    description:
      'Run the locally-installed OpenCode CLI (`opencode run`) to implement ONE bounded, low-risk coding unit in this workspace. The edit happens in an isolated throwaway git worktree and only a clean, error-free diff inside `allowedFiles` is applied back; a review digest is written. RESUMABLE: the run executes in the background and this call waits a bounded window, so it survives the host\'s ~120s tool-call timeout. It returns one of: {ok:true, action:"delegated", digest, touched} → proceed to review; {ok:false, action:"skipped"|"failed"|"no-changes"} → re-spawn the paid role (fallback); or {running:true, reservedFiles} → still running. On {running:true}: the background worker keeps ITSELF alive (your calls are not its keep-alive), so do useful work, then wait long in one turn via opencode_status {runId, role, waitMs: 90000}; to abandon it, call opencode_status {cancel:true} — never just go silent. Re-calling after a terminal result with the SAME `task`/`allowedFiles`/`model` just replays that same terminal result (observed 1cu-cursor: seven delegations of one unit because terminal results were read as "still running"). CHANGING `task`, `allowedFiles`, or `model` starts a genuinely new delegation — that is how you retry after fixing a rejected allowlist. The user enabled this delegation in the Traffic One setup wizard; OpenCode selects its own model (a free model by default), so no `model` argument is needed.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Traffic One role being delegated, e.g. senior-frontend.' },
        task: { type: 'string', description: "The role's self-contained task: its assigned scope + acceptance criteria, with no external context the run cannot see. Required on the first call; ignored on re-calls of a run already in progress." },
        runId: { type: 'string', description: 'The current run id (currentRunId) — scopes the attempt marker, digest, and the background run.' },
        allowedFiles: { type: 'string', description: 'Required comma/newline-separated repo-relative allowlist for this bounded unit, e.g. `src/routes/api.ts, src/controllers/batch.ts`. In MAINTENANCE phase these must be EXACT FILE paths — globs and directories (`src/**`, `src/routes/`) are rejected before the run starts, because they cannot authorize a paid fallback; list every file you intend to create or modify. Product files ONLY: `.traffic-one/**` (digests included — the runner writes those itself), `node_modules/`, and build output are refused. Any diff outside this scope is rejected.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root (the directory containing .traffic-one). Must match the gate cwd. Defaults to the server cwd.' },
        model: { type: 'string', description: 'Optional model pin (e.g. a paid `opencode/gpt-5.5`, which requires `opencode auth login`). Omit to let OpenCode use its default free model.' },
      },
      required: ['role', 'task', 'runId', 'allowedFiles'],
    },
  },
  {
    name: OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN,
    description:
      "Run the locally-installed OpenCode CLI to implement EVERY bounded unit the architect queued in <projectRoot>/.traffic-one/plan.md, in one background batch (each in its own isolated worktree, only clean diffs applied). RESUMABLE (same as opencode_delegate): returns {total, delegated, units:[...]} when finished, or {running:true, reservedFiles} → the batch worker keeps ITSELF alive; do useful work, then wait long in one turn via opencode_status {runId, waitMs: 90000}, or abandon explicitly via opencode_status {cancel:true}. Best-effort: a unit OpenCode does not deliver falls back to a paid subagent. The user enabled this delegation in the Traffic One setup wizard; OpenCode picks its own free model unless `model` is set.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The current run id (currentRunId).' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root (the directory containing .traffic-one). Defaults to the server cwd.' },
        model: { type: 'string', description: 'Optional model pin applied to every queued unit. Omit to let OpenCode use its default free model.' },
      },
      required: ['runId'],
    },
  },
  {
    name: OPENCODE_MCP_TOOL_STATUS,
    description:
      'Status + control of a background delegation. Returns {status:"running"|"done"|"unknown", result?, reservedFiles?}. With `waitMs` it becomes a bounded LONG WAIT: it blocks up to waitMs (server-clamped safely under the ~120s host tool ceiling — ask for 90000) and returns the terminal result the moment the run finishes; one long wait replaces several short re-polls, and the worker keeps itself alive either way. With `cancel:true` it explicitly abandons the delegation: the worker is killed BEFORE any diff applies (a cancel that lands while a clean diff is mid-apply is refused with {applying:true} — call again without cancel to collect the imminent terminal result). Cancel is the ONLY sanctioned way to walk away to the paid fallback; going silent is not.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The run id used for the delegation.' },
        role: { type: 'string', description: 'The delegated role; omit for the plan-batch run.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root. Defaults to the server cwd.' },
        waitMs: { type: 'number', description: 'Optional bounded long-wait in milliseconds (recommended: 90000). Server-clamped under the host tool-call ceiling; 0/omitted returns immediately.' },
        cancel: { type: 'boolean', description: 'Explicitly cancel the delegation and mark it abandoned; refused while a clean diff is being applied to the working tree.' },
      },
      required: ['runId'],
    },
  },
];

function result(id: Id, res: unknown): object {
  return { jsonrpc: '2.0', id: id ?? null, result: res };
}

function errorResp(id: Id, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleToolCall(id: Id, params: unknown): Promise<object> {
  const p = asRecord(params);
  const name = asString(p.name);
  const args = asRecord(p.arguments);
  if (name === OPENCODE_MCP_TOOL_STATUS) {
    const rawWait = args.waitMs;
    const status = await delegateStatus({
      runId: asString(args.runId),
      role: asString(args.role),
      projectRoot: asString(args.projectRoot),
      waitMs: typeof rawWait === 'number' ? rawWait : Number(asString(rawWait)) || 0,
      cancel: args.cancel === true || asString(args.cancel) === 'true',
    });
    return result(id, { content: [{ type: 'text', text: JSON.stringify(status) }], isError: false });
  }
  let runnerResult;
  if (name === OPENCODE_MCP_TOOL_DELEGATE) {
    runnerResult = await delegateResumable({
      role: asString(args.role),
      task: asString(args.task),
      runId: asString(args.runId),
      allowedFiles: asString(args.allowedFiles),
      projectRoot: asString(args.projectRoot),
      model: asString(args.model),
    });
  } else if (name === OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN) {
    runnerResult = await delegateFromPlanResumable({
      runId: asString(args.runId),
      projectRoot: asString(args.projectRoot),
      model: asString(args.model),
    });
  } else {
    return errorResp(id, -32602, `Unknown tool: ${name || '(none)'}`);
  }
  return result(id, {
    content: [{ type: 'text', text: JSON.stringify(runnerResult) }],
    // {running:true} is NOT an error (re-call to keep waiting); a finished
    // delegate carries ok:boolean (ok:false → declined → fall back); from-plan has
    // no ok (best-effort batch) so it is never surfaced as a tool error.
    isError: runnerResult.ok === false && !runnerResult.running,
  });
}

// Dispatch one JSON-RPC message → its response object, or null for notifications
// (which take no reply). Requests carry an `id`; notifications do not.
export async function dispatch(msg: RpcMessage): Promise<object | null> {
  const id = (msg.id ?? undefined) as Id | undefined;
  const isNotification = msg.id === undefined;
  const method = asString(msg.method);
  switch (method) {
    case 'initialize': {
      const params = asRecord(msg.params);
      const requested = asString(params.protocolVersion);
      return result(id ?? null, {
        protocolVersion: requested || OPENCODE_MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: OPENCODE_MCP_SERVER_KEY, version: OPENCODE_MCP_SERVER_VERSION },
      });
    }
    case 'ping':
      return result(id ?? null, {});
    case 'tools/list':
      return result(id ?? null, { tools: TOOLS });
    case 'tools/call':
      return handleToolCall(id ?? null, msg.params);
    default:
      // notifications/initialized, notifications/cancelled, etc. — no reply.
      if (isNotification) return null;
      return errorResp(id ?? null, -32601, `Method not found: ${method || '(none)'}`);
  }
}

function handleLine(line: string, output: Writable): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: RpcMessage;
  try {
    msg = JSON.parse(trimmed) as RpcMessage;
  } catch {
    // Unparseable → no id to echo; emit the spec's parse-error with a null id.
    output.write(`${JSON.stringify(errorResp(null, -32700, 'Parse error'))}\n`);
    return;
  }
  void dispatch(msg)
    .then((resp) => { if (resp) output.write(`${JSON.stringify(resp)}\n`); })
    .catch((err) => {
      // Only requests (with an id) get an error reply; notifications stay silent.
      if (msg.id !== undefined) {
        output.write(`${JSON.stringify(errorResp(msg.id ?? null, -32603, `Internal error: ${(err as Error).message}`))}\n`);
      }
    });
}

// Wire a readable (stdin) to a writable (stdout) as the MCP stdio transport.
// Messages are newline-delimited JSON; we buffer partial chunks and dispatch each
// complete line. The data listener keeps the process alive until the host closes
// stdin, at which point the stream ends and the process exits naturally.
export function attach(input: Readable, output: Writable): void {
  let buf = '';
  input.setEncoding('utf8');
  input.on('data', (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handleLine(line, output);
      nl = buf.indexOf('\n');
    }
  });
  // Flush a final frame that arrived without a trailing newline before EOF.
  // Conformant clients newline-terminate every message, but a pipe that closes
  // mid-frame shouldn't silently drop the last request.
  input.on('end', () => {
    if (buf.trim()) { handleLine(buf, output); buf = ''; }
  });
}
