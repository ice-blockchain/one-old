// src/modules/plan-guard/scaffold-gate.ts
// PreToolUse(shell) scaffolder gate — WINDSURF/DEVIN ONLY.
//
// Devin Local's SWE-tier agent tends to ignore the materialized React/Vite rules
// and run an app scaffolder (`npx create-next-app …`) directly, which (a) skips
// the architect (no `.traffic-one/plan.md` yet) and (b) is off-stack. Those shell
// scaffolders slip every existing gate: they are not npm-install commands (so the
// forbidden-library gate never sees them) and carry no explicit write primitive +
// feature path (so the plan gate's feature-source-via-command check returns false).
//
// This gate closes that hole the way `deploy-gate.ts` gates deploy commands:
// regex-match the scaffolder command, then DENY based on state. It is scoped to
// Windsurf only (noop on every other host) so Claude/Cursor/Codex/OpenCode are
// completely unaffected — they keep relying on the agent following the rules.
//
// Architect-first is enforced INDIRECTLY: with scaffolders (and, via the plan
// gate, feature-source writes) blocked until `plan.md` exists, subagents mode
// must spawn `senior-architect`; in main-agent mode the current thread creates
// the plan itself before continuing.

import * as fs from 'fs';
import * as path from 'path';

import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { detectMode } from '../../shared/detection';
import { resolveProjectRoot } from '../../shared/hook-paths';
import { canonicalHost } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { allowsNextjs } from './forbidden';
import { makePlanBlock } from './plan-static';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

// App scaffolders that create a whole project/app in one command.
export const SCAFFOLD_RE = /(^|[\s;&|])(create-next-app|create-react-app|create-expo-app|create-remix|(npm|pnpm|yarn|bun)\s+create\b|npx\s+create-[\w-]+|nest\s+new\b|ng\s+new\b|vue\s+create\b|expo\s+init\b)/;

// Off-stack scaffolders for a Traffic One React/Vite web project. Matches both the
// dedicated binary (`create-next-app`) and the package-manager form (`… create next-app`).
const NEXT_SCAFFOLD_RE = /create[-\s]next-app/;
const CRA_SCAFFOLD_RE = /create[-\s]react-app/;

function planExists(root: string): boolean {
  try {
    return fs.existsSync(path.join(root, '.traffic-one', 'plan.md'));
  } catch {
    return false;
  }
}

function usesMainAgentTeam(state: Record<string, unknown>): boolean {
  return obj(state.team)?.mode === 'main-agent';
}

export function scaffoldGate(ctx: Ctx): HookResult {
  // Windsurf/Devin only — never touch other hosts.
  if (canonicalHost(ctx.host) !== 'windsurf') return noop();
  if (pluginUseDeclined(ctx.cwd)) return noop();
  // Never police scaffolding inside the plugin authoring repo.
  if (isNonProjectRoot(ctx.cwd)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!SCAFFOLD_RE.test(command)) return noop();

  // Resolve UP to the workspace root that holds onboarding/plan state, so a
  // scaffolder run from (or targeting) a sub-package still finds the real plan.md.
  const root = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  const state = readEffectiveState(root);
  const mode = (state.mode as string) || detectMode(root);
  // Only govern the new-project build flow; existing codebases keep their tooling.
  if (mode !== 'new-project') return noop();

  // (A) On-stack enforcement: never scaffold Next.js / CRA on a React/Vite project.
  if ((NEXT_SCAFFOLD_RE.test(command) && !allowsNextjs(state, root)) || CRA_SCAFFOLD_RE.test(command)) {
    return deny(block('scaffold-stack-gate',
      "Stack gate: this project's stack is React/Vite (Traffic One does not use Next.js or create-react-app). "
      + 'Scaffold the app under `apps/web` with Vite per `.traffic-one/plan.md` and `rules/modes/new-project.md` '
      + '— do not run create-next-app / create-react-app. See rules/core.md for the approved stack.'));
  }

  // (B) Architect-first: no app scaffolding before the architect writes plan.md.
  if (!planExists(root)) {
    if (usesMainAgentTeam(state)) {
      return deny(block('scaffold-main-agent-plan-gate',
        'Plan gate: `.traffic-one/plan.md` is missing and this project is in Low/main-agent mode. Do NOT call `run_subagent` or another subagent tool. You are the architect in this thread: write the plan and required `.traffic-one/` project memory before root config or workspace scaffolding, then continue with the same ordered phases. Do not run `create-*` app scaffolders before the plan exists.'));
    }
    return deny(block('scaffold-plan-gate',
      'Plan gate: run the `senior-architect` subagent FIRST to produce `.traffic-one/plan.md` before scaffolding a '
      + 'new project. On Windsurf/Devin spawn it with `run_subagent` (profile `senior-architect`); it writes the '
      + '`apps/web` Turborepo monorepo scaffold per the plan. Do not run `create-*` app scaffolders — build on the '
      + 'plan the architect produces.'));
  }

  return noop();
}
