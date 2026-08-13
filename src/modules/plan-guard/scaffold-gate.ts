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
import { capabilityProfileForRun } from '../../shared/architecture-contract';
import { detectMode } from '../../shared/detection';
import { hostFlags } from '../../shared/host/capability-flags';
import { canonicalHost } from '../../shared/model-tiers';
import { obj } from '../../shared/obj';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { isNewProjectMode, readEffectiveState } from '../../shared/state';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { resolveToolScope, workspaceMemberRefusal } from '../../shared/tool-scope';
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
  // Only the hosts whose agent ignores the materialized rules — never touch the rest.
  if (!hostFlags(canonicalHost(ctx.host)).ignoresMaterializedGuidance) return noop();
  const scope = resolveToolScope(ctx);
  if (scope.standsDown) return noop();
  const unresolvedMember = workspaceMemberRefusal(scope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }
  const root = scope.projectRoot;
  if (pluginUseDeclined(root)) return noop();
  // Never police scaffolding confined to the plugin authoring repo.
  if (isNonProjectRoot(root)) return noop();

  const command = ctx.input.tool?.command ?? '';
  if (!SCAFFOLD_RE.test(command)) return noop();

  const state = readEffectiveState(root);
  const mode = (state.mode as string) || detectMode(root);
  // Only govern the new-project build flow; existing codebases keep their tooling.
  // Safe on the mode guess alone, unlike the writers that act on it: everything
  // past this line only ever DENIES a command the agent proposed, so a
  // misclassified repo gets an unwanted refusal it can argue with, never an
  // unasked-for change to itself.
  if (!isNewProjectMode({ mode })) return noop();

  // (A) On-stack enforcement: compare the requested scaffolder with the
  // runtime-derived framework instead of assuming every project is React/Vite.
  if ((NEXT_SCAFFOLD_RE.test(command) && !allowsNextjs(state, root)) || CRA_SCAFFOLD_RE.test(command)) {
    const profile = capabilityProfileForRun(root, state);
    const profileSummary = `profile=${profile.profileId}; framework=${profile.framework}; surfaces=${profile.surfaces.join(', ') || 'none'}; roots=${profile.sourceRoots.join(', ') || 'none'}`;
    return deny(block('scaffold-stack-gate',
      `Stack gate: this scaffolder conflicts with the runtime-derived capability contract (${profileSummary}). `
      + 'Use `.traffic-one/plan.md` and `CompiledArchitectureV1` outputs for the detected framework and roots. '
      + 'If the requested stack differs, replan and correct capability evidence before scaffolding.',
      { PROFILE_SUMMARY: profileSummary }), { denyId: 'scaffold-stack-gate', denyTarget: root });
  }

  // (B) Architect-first: no app scaffolding before the architect writes plan.md.
  if (!planExists(root)) {
    const profile = capabilityProfileForRun(root, state);
    const profileSummary = `profile=${profile.profileId}; framework=${profile.framework}; surfaces=${profile.surfaces.join(', ') || 'none'}; roots=${profile.sourceRoots.join(', ') || 'none'}; roles=${profile.roles.join(', ')}; QA=${profile.qaAdapters.join(', ') || 'stack-native build/test/lint'}`;
    if (usesMainAgentTeam(state)) {
      return deny(block('scaffold-main-agent-plan-gate',
        'Plan gate: `.traffic-one/plan.md` is missing and this project is in Low/main-agent mode. Do NOT call `run_subagent` or another subagent tool. You are the architect in this thread: write the plan and required `.traffic-one/` project memory before root config or workspace scaffolding, then continue with the same ordered phases. Do not run `create-*` app scaffolders before the plan exists. '
        + `Follow the runtime capability contract, not a frontend default: ${profileSummary}.`,
        { PROFILE_SUMMARY: profileSummary }), { denyId: 'scaffold-main-agent-plan-gate', denyTarget: root });
    }
    return deny(block('scaffold-plan-gate',
      'Plan gate: run the `senior-architect` subagent FIRST to produce `.traffic-one/plan.md` before scaffolding a '
      + 'new project. On Windsurf/Devin spawn it with `run_subagent` (profile `senior-architect`); the runtime derives '
      + 'the actual framework, roots, and allowed outputs before implementation. Do not run `create-*` app scaffolders '
      + `or invent layout conventions before the compiled plan exists. Runtime contract: ${profileSummary}.`,
      { PROFILE_SUMMARY: profileSummary }), { denyId: 'scaffold-plan-gate', denyTarget: root });
  }

  return noop();
}
