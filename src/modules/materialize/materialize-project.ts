// src/modules/materialize/materialize-project.ts
// The `materialize-project` manual subcommand: auth-gate, then converge the
// project's .traffic-one/** from its committed state. Ported 1:1 from
// runMaterializeProject (post.cjs:674). This is a manual CLI command (NOT wired
// into hooks.json), so it is not a pipeline gate — the host entry routes the
// subcommand straight to this action. The auth gate is reused from the session
// module (auth is a cross-cutting kernel concern shared by command actions).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { materializeProjectFromState } from '../../shared/materialize';
import { authChoiceAllowsContinue, tryWriteAuthChoice } from '../session/auth-choice';
import { authGateForHook, authRequiredHookResult } from '../session/auth-gate';

export function runMaterializeProject(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();

  const authGate = authGateForHook();
  if (!authGate.authenticated) {
    if (authChoiceAllowsContinue(cwd)) return noop();
    const writeResult = tryWriteAuthChoice('pending-choice', cwd);
    return authRequiredHookResult('PostToolUse', { authChoiceWrite: writeResult });
  }

  const out = materializeProjectFromState(cwd, { trigger: 'manual materialize-project' });
  return context(out.context, { systemMessage: out.systemMessage });
}
