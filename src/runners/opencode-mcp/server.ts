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
} from '../../config/opencode-mcp';
import { runDelegate, runDelegateFromPlan } from './delegate';

type Id = string | number | null;
interface RpcMessage { jsonrpc?: unknown; id?: Id; method?: unknown; params?: unknown; }

const TOOLS = [
  {
    name: OPENCODE_MCP_TOOL_DELEGATE,
    description:
      'Delegate ONE bounded, low-risk coding unit to the free OpenCode agent (runs in a throwaway git worktree; only a clean, error-free diff is applied to the tree; a digest is written). Returns the runner JSON: {ok, action, digest, touched, error, model}. On ok:false the attempt is recorded for this run, so the spawn gate then allows the paid fallback. Use for the roles the gate forces onto OpenCode.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Traffic One role being delegated, e.g. senior-frontend.' },
        task: { type: 'string', description: "The role's self-contained task: its assigned scope + acceptance criteria, with no external context the run cannot see." },
        runId: { type: 'string', description: 'The current run id (currentRunId) — scopes the attempt marker and digest.' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root (the directory containing .traffic-one). Must match the gate cwd. Defaults to the server cwd.' },
        model: { type: 'string', description: 'Optional model override, e.g. opencode/deepseek-v4-flash-free or an ollama/* model for on-device execution.' },
      },
      required: ['role', 'task', 'runId'],
    },
  },
  {
    name: OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN,
    description:
      "Delegate EVERY bounded unit the architect queued in <projectRoot>/.traffic-one/plan.md to OpenCode, in one batch. Returns {total, delegated, units:[{role, task, action, touched}]}. Best-effort: a unit OpenCode does not deliver (action !== 'delegated') simply falls back to a paid subagent. Never fails the build.",
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The current run id (currentRunId).' },
        projectRoot: { type: 'string', description: 'Absolute path to the project root (the directory containing .traffic-one). Defaults to the server cwd.' },
        model: { type: 'string', description: 'Optional model override applied to every queued unit.' },
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
  let runnerResult;
  if (name === OPENCODE_MCP_TOOL_DELEGATE) {
    runnerResult = await runDelegate({
      role: asString(args.role),
      task: asString(args.task),
      runId: asString(args.runId),
      projectRoot: asString(args.projectRoot),
      model: asString(args.model),
    });
  } else if (name === OPENCODE_MCP_TOOL_DELEGATE_FROM_PLAN) {
    runnerResult = await runDelegateFromPlan({
      runId: asString(args.runId),
      projectRoot: asString(args.projectRoot),
      model: asString(args.model),
    });
  } else {
    return errorResp(id, -32602, `Unknown tool: ${name || '(none)'}`);
  }
  return result(id, {
    content: [{ type: 'text', text: JSON.stringify(runnerResult) }],
    // delegate() carries an explicit ok:boolean; from-plan has no ok (best-effort
    // batch) so it is never surfaced as a tool error.
    isError: runnerResult.ok === false,
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
