// src/core/dispatch.ts
// The request path: raw host invocation → adapter.parse → buildContext →
// runPipeline → adapter.serialize. The host entry scripts pick an adapter
// (adapters/select) and a handler set (registry) and call this.

import type { Handler } from './types';
import type { HostAdapter, RawInvocation } from '../adapters/types';
import { buildContext } from './context';
import { runPipeline } from './pipeline';

export async function dispatch(
  adapter: HostAdapter,
  handlers: readonly Handler[],
  raw: RawInvocation,
): Promise<string> {
  const input = adapter.parse(raw);
  const ctx = buildContext(input);
  const result = await runPipeline(handlers, ctx);
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
