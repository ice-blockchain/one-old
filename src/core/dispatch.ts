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
