// src/runners/opencode-mcp/index.ts
// CLI entry for the bundled `opencode-worker` MCP server (compiles to
// scripts/opencode-mcp.cjs via SHIMS in build-runtime.ts). A long-lived stdio
// server: the host launches it once from .mcp.json, OUTSIDE the per-tool-call
// sandbox, and the orchestrator reaches it through the opencode_delegate /
// opencode_delegate_from_plan tools instead of running the runner in its own
// (possibly sandboxed) shell.

import { attach } from './server';

export { attach, dispatch } from './server';
export {
  delegateFromPlanResumable,
  planQueueRoles,
  delegateResumable,
  delegateStatus,
  parseRunnerResult,
  runDelegate,
  runDelegateFromPlan,
} from './delegate';

// Returns void (not a promise): the stdin data listener attach() installs keeps
// the event loop alive until the host closes the pipe. The build shim calls this
// and the process stays up to serve tool calls.
export function main(): void {
  attach(process.stdin, process.stdout);
}

if (require.main === module) {
  main();
}
