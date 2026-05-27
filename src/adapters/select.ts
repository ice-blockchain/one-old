// src/adapters/select.ts
import type { HostId } from '../core/types';
import { makeClaudeAdapter } from './claude';
import { makeCursorAdapter } from './cursor';
import type { HostAdapter } from './types';

export function selectAdapter(host: HostId): HostAdapter {
  if (host === 'cursor') return makeCursorAdapter();
  return makeClaudeAdapter(host === 'codex' ? 'codex' : 'claude');
}
