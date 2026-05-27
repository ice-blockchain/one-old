// src/adapters/types.ts
// The port: a HostAdapter is the ONLY place that knows a host's raw wire shape.
// It maps a raw hook invocation → canonical HookInput, and a canonical
// HookResult → the host's stdout string. Core + modules never see host shapes.

import type { HookInput, HookResult, HostId } from '../core/types';

export interface RawInvocation {
  readonly stdin: string;
  readonly argv: readonly string[];
}

export interface HostAdapter {
  readonly id: HostId;
  parse(raw: RawInvocation): HookInput;
  serialize(result: HookResult, input: HookInput): string;
}
