// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isAuthenticatedLocal } from '../../shared/auth';
import { isWebState, readEffectiveState } from '../../shared/state';
import { logToolUse } from '../../shared/token-logger';

const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;

export function postBuildPageSpeed(ctx: Ctx): HookResult {
  if (!isAuthenticatedLocal()) return noop();
  logToolUse(ctx.cwd, ctx.input.raw && typeof ctx.input.raw === 'object' ? (ctx.input.raw as Record<string, unknown>) : null);
  const command = ctx.input.tool?.command ?? '';
  if (!BUILD_COMMAND_RE.test(command)) return noop();
  if (!isWebState(readEffectiveState(ctx.cwd))) return noop();
  return context(
    [
      '[traffic-one] A production build just ran for a web stack.',
      'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
      '',
      '  node "${TRAFFIC_ONE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}}/scripts/lighthouse-runner.mjs" --route /',
      '',
      'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, explicitly report page speed as unverified with concrete risks.',
    ].join('\n'),
    { systemMessage: 'traffic-one page-speed gate pending after build' },
  );
}
