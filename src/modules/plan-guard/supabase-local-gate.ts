// src/modules/plan-guard/supabase-local-gate.ts
// PreToolUse(shell) — Supabase LOCAL-STACK gate, all hosts.
//
// Traffic One's Supabase flow is platform-connected: agents author
// `supabase/config.toml`, `supabase/migrations/*.sql`, and
// `supabase/functions/**` in the repo, the app runs in not-configured demo
// mode behind the EnvBanner, and the USER connects the real project (env keys,
// migration apply) through the traffic.io platform. Nothing about the local
// Supabase stack belongs in a build: no `supabase start`, no Docker/OrbStack
// bootstrap, no local Postgres containers (observed 3cl: the backend launched
// OrbStack and polled the Docker daemon for minutes to run `supabase start` —
// pure waste on a project that connects via the platform).
//
// Scoped to projects whose onboarded backend is Supabase; other projects keep
// their own tooling untouched.

import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope } from '../../shared/tool-scope';
import { makePlanBlock } from './plan-static';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

// Local-stack lifecycle commands, in both direct-CLI and package-script form
// (`supabase functions serve` boots the local Deno/Docker edge runtime, so it
// is local-stack too). `db:push`, `gen:types`, `link`, and `functions:deploy`
// are NOT matched here — those are linked/deploy-side commands governed by the
// deploy gate.
export const SUPABASE_LOCAL_STACK_RE = /(^|[\s;&|(])(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:db:(?:start|stop|reset)|functions:serve)\b|(?:npx\s+|pnpm\s+dlx\s+|bunx\s+)?supabase\s+(?:start|stop)\b|(?:npx\s+|pnpm\s+dlx\s+|bunx\s+)?supabase\s+db\s+reset\b|(?:npx\s+|pnpm\s+dlx\s+|bunx\s+)?supabase\s+functions\s+serve\b)/;

export function supabaseLocalGate(ctx: Ctx): HookResult {
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const root = scope.projectRoot;
  if (pluginUseDeclined(root)) return noop();
  if (isNonProjectRoot(root)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!SUPABASE_LOCAL_STACK_RE.test(command)) return noop();

  const state = readEffectiveState(root);
  if (state.backend !== 'supabase') return noop();

  return deny(block('supabase-local-stack-gate',
    'Supabase gate: the local Supabase stack is not part of this project\'s flow — do not run `supabase start`/`stop`, `supabase db reset`, `supabase functions serve`, or the `db:start`/`db:stop`/`db:reset`/`functions:serve` scripts, and do not boot Docker/OrbStack/Colima for them. '
    + 'Author `supabase/config.toml`, `supabase/migrations/*.sql`, and `supabase/functions/**` in the repo only; the user connects the real project (env keys, migration apply) through the traffic.io platform — every setup CTA links to `https://traffic.io/` — and the app must run in not-configured demo mode behind the EnvBanner until then. '
    + 'Verify SQL by review and committed migrations, not against a local database; `supabase db push --linked` stays a shipper-gated deploy action.'),
    { denyId: 'supabase-local-stack-gate', denyTarget: command });
}
