// src/core/dispatch.ts
// The request path: raw host invocation → adapter.parse → buildContext →
// runPipeline → adapter.serialize. The host entry scripts pick an adapter
// (adapters/select) and a handler set (registry) and call this.

import type { Handler } from './types';
import type { HostAdapter, RawInvocation } from '../adapters/types';
import { buildContext } from './context';
import { runPipeline } from './pipeline';
import { maybeTraceHook } from '../shared/hook-trace';
import { observeCurrentRunHostCapabilityFromHook } from '../shared/host-capabilities';
import { resolveToolProjectRoot } from '../shared/tool-scope';

export async function dispatch(
  adapter: HostAdapter,
  handlers: readonly Handler[],
  raw: RawInvocation,
): Promise<string> {
  const input = adapter.parse(raw);
  maybeTraceHook(input, raw.stdin); // off-by-default; gated by TRAFFIC_ONE_HOOK_TRACE
  const ctx = buildContext(input);
  // Persist what this run actually observed. A SessionStart-only host remains
  // completion-only; only the native primary before-tool point can upgrade the
  // per-run sidecar to preventive enforcement. Resolve from the full tool
  // scope, not raw cwd: hooks may start in a nested package or in this plugin's
  // source while targeting an external end-user project.
  observeCurrentRunHostCapabilityFromHook(
    resolveToolProjectRoot(ctx),
    input,
    process.env,
    'invoked',
  );
  const result = await runPipeline(handlers, ctx);
  // The first build gate may mint currentRunId during this invocation. Record
  // the canonical pipeline decision separately from hook coverage: merely
  // reaching a before-tool callback (or dispatching with no handlers) is not
  // evidence that this host/runtime can enforce a denial.
  observeCurrentRunHostCapabilityFromHook(
    resolveToolProjectRoot(ctx),
    input,
    process.env,
    result.kind === 'deny' ? 'denied' : 'allowed',
  );
  return adapter.serialize(result, input);
}

// The handlers a given hook subcommand invokes — those that declared the
// subcommand in their `subcommands`. runPipeline still re-filters by (event,
// tool class) + orders by priority, so the auth gate (priority 0) runs first
// for the gate subcommands it participates in, then short-circuits on deny.
// Reproduces the legacy 1:1 subcommand→handler dispatch (each legacy gate
// checked auth first) while keeping routing module-local (no central map).
export function handlersForSubcommand(handlers: readonly Handler[], subcommand: string): Handler[] {
  return handlers.filter((handler) => handler.subcommands?.includes(subcommand));
}

// Route a raw host invocation for a specific subcommand through the pipeline.
// The host entry resolves argv→subcommand, picks the adapter, and calls this.
export async function dispatchSubcommand(
  adapter: HostAdapter,
  handlers: readonly Handler[],
  subcommand: string,
  raw: RawInvocation,
): Promise<string> {
  return dispatch(adapter, handlersForSubcommand(handlers, subcommand), raw);
}
