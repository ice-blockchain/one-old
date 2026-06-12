// src/modules/page-speed/handler.ts
// PostToolUse(shell) advisory: after a production build on a web stack, remind
// the agent to run the Lighthouse mobile gate. Ported 1:1 from
// runPostBuildPageSpeed in scripts/hook-runtime/handlers/post.cjs — including
// the opt-in per-tool token log (no-op unless TRAFFIC_ONE_TOKEN_LOG=1).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authSatisfied } from '../../shared/auth';
import { firstEmitThisSession } from '../../shared/once';
import { hookSessionIdentity, isWebState, readEffectiveState } from '../../shared/state';
import { logToolUse } from '../../shared/token-logger';

const BUILD_COMMAND_RE = /(^|[\s;&|])(pnpm|npm|yarn|bun|turbo|vite)(\s[^;&|]*?)?\s+build(\s|$)/;

export function postBuildPageSpeed(ctx: Ctx): HookResult {
  if (!authSatisfied()) return noop();
  logToolUse(ctx.cwd, ctx.input.raw && typeof ctx.input.raw === 'object' ? (ctx.input.raw as Record<string, unknown>) : null);
  const command = ctx.input.tool?.command ?? '';
  if (!BUILD_COMMAND_RE.test(command)) return noop();
  if (!isWebState(readEffectiveState(ctx.cwd))) return noop();
  // Iterative implement-verify loops run `npm run build` many times; the full
  // advisory injects once per session, later builds get a one-line reminder.
  if (!firstEmitThisSession(ctx.cwd, 'pagespeed-advisory', hookSessionIdentity(ctx.input.raw).sessionId)) {
    return context(
      '[traffic-one] Lighthouse mobile gate still pending — run: node ~/.traffic-one/bin/lighthouse-runner.cjs --route / (the runner ships with the PLUGIN, not the repo).',
      { systemMessage: 'traffic-one page-speed gate pending after build' },
    );
  }
  return context(
    [
      '[traffic-one] A production build just ran for a web stack.',
      'Before final delivery for generated/changed React or Ionic routes, run the Lighthouse mobile gate:',
      '',
      '  node ~/.traffic-one/bin/lighthouse-runner.cjs --route /',
      '',
      'Audit `/` plus the 1-2 heaviest public routes (catalog/listing pages — rerun with `--route <path>`); the home route alone hides heavy-route regressions. A metric flagged `withinTolerance` passed the gate — do NOT iterate on it. A confirmation re-run with no code changes in between may add `--skip-build`. The summary also carries Accessibility/Best-Practices/SEO scores from the same audit — surface a11y warnings to the team.',
      '',
      'If the runner fails, use the reported Lighthouse opportunities to make targeted fixes, then rerun once or twice before reporting the result. If the environment blocks Lighthouse, explicitly report page speed as unverified with concrete risks.',
    ].join('\n'),
    { systemMessage: 'traffic-one page-speed gate pending after build' },
  );
}
