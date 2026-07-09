// src/adapters/select.ts
import type { HostId } from '../core/types';
import { makeClaudeAdapter } from './claude';
import { makeCopilotAdapter } from './copilot';
import { makeCursorAdapter } from './cursor';
import { makeKiloAdapter } from './kilo';
import { makeOpenCodeAdapter } from './opencode';
import { makeWindsurfAdapter } from './windsurf';
import type { HostAdapter } from './types';

export function selectAdapter(host: HostId): HostAdapter {
  if (host === 'cursor') return makeCursorAdapter();
  if (host === 'opencode') return makeOpenCodeAdapter();
  if (host === 'kilo') return makeKiloAdapter();
  if (host === 'copilot') return makeCopilotAdapter();
  if (host === 'windsurf') return makeWindsurfAdapter();
  return makeClaudeAdapter(host === 'codex' ? 'codex' : 'claude');
}
