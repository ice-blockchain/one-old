// src/modules/materialize/materialize-project.ts
// The `materialize-project` manual subcommand: auth-gate, then converge the
// project's .traffic-one/** from its committed state. Ported 1:1 from
// runMaterializeProject (post.cjs:674). This is a manual CLI command (NOT wired
// into hooks.json), so it is not a pipeline gate — the host entry routes the
// subcommand straight to this action. The auth gate is reused from the session
// module (auth is a cross-cutting kernel concern shared by command actions).

import { context, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { authEnforced, isLocallyAuthenticated } from '../../shared/auth';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { materializeProjectFromState } from '../../shared/materialize';
import { pluginUseDeclined } from '../../shared/state/plugin-use';

export function runMaterializeProject(ctx: Ctx): HookResult {
  const cwd = ctx.cwd;
  if (isPluginAuthoringRoot(cwd)) return noop();
  if (pluginUseDeclined(cwd)) return noop();

  // Auth gate: a pure local boolean read. When auth is enforced but the web API
  // key isn't entered yet, do nothing — the session/onboarding gates surface the
  // wizard's api-key page; this manual convergence just waits until it's entered.
  if (authEnforced() && !isLocallyAuthenticated()) return noop();

  const out = materializeProjectFromState(cwd, { trigger: 'manual materialize-project' });
  return context(out.context, { systemMessage: out.systemMessage });
}
