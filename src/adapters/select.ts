// src/adapters/select.ts
import type { HostId } from '../core/types';
import { makeClaudeAdapter } from './claude';
import { makeCopilotAdapter } from './copilot';
import { makeCursorAdapter } from './cursor';
import { makeOpenCodeAdapter } from './opencode';
import type { HostAdapter } from './types';

export function selectAdapter(host: HostId): HostAdapter {
  if (host === 'cursor') return makeCursorAdapter();
  if (host === 'opencode') return makeOpenCodeAdapter();
  if (host === 'copilot') return makeCopilotAdapter();
  return makeClaudeAdapter(host === 'codex' ? 'codex' : 'claude');
}
