// src/modules/plan-guard/plan-write.ts
// PreToolUse file-write/file-edit plan gate (priority 20). Assembles the
// decomposed checks ported from runCheckPlanWrite:
//   1. preflight convergence (materialize the project on disk if needed)
//   2. project-readiness gates (monorepo / state / materialization / plan)
//   3. run-team ownership enforcement
//   4. static layout/style checks
// then emits one bundled deny. Auth is enforced by the priority-0 session gate
// before this runs.
//
// Ordering note: the legacy bundle interleaves the plan gate between run-team
// and the static checks; here the plan gate is emitted by the readiness pass
// (before run-team). The set of violations is identical — only the relative
// order of the (rarely co-occurring) plan + run-team lines differs.

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { authChoiceAllowsContinue } from '../session/auth-choice';
import {
  applyPatchTargetPaths,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
} from '../../shared/feature-source';
import { projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded, migrateArchitectureDocsToPlan } from '../../shared/materialize';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { isNativeState, readEffectiveState } from '../../shared/state';
import { canonicalToolName, commandFromToolInput, isShellToolName, normalizedToolName, parsedToolInput } from '../../shared/tool-classify';
import { planReadinessViolations } from './plan-readiness';
import { runTeamEnforcementViolation } from './plan-runteam';
import { planStaticViolations, makePlanBlock } from './plan-static';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

export function planWriteGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // Host-agnostic tool classification (see onboarding-gate): Cursor's rawName is a
  // coarse subcommand and its command/path live on ctx.input.tool, not raw.tool_input
  // — without this the shell feature-source-write deny is blind on Cursor.
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName) || 'Bash';
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};

  const rawFilePath = asString(toolInput.file_path).replace(/\\/g, '/');
  const rawCommand = commandFromToolInput(toolInput);
  const patchTargetPaths = normalizedToolName(toolName) === 'apply_patch'
    ? applyPatchTargetPaths(rawCommand)
    : [];

  const cwd = ctx.cwd;
  // Never gate the plugin's own authoring repo — the gate/materialiser must never
  // act on it (mirrors the onboarding gate). Without this, a stale or missing
  // .traffic-one here makes the plan gate fire on plugin development.
  if (isPluginAuthoringRoot(cwd)) return noop();
  if (authChoiceAllowsContinue(cwd)) return noop();

  const projectRoot = resolveProjectRoot(cwd, rawFilePath || patchTargetPaths[0] || '');
  // The resolver's fallback can still hand back a dir inside the plugin repo.
  if (isPluginAuthoringRoot(projectRoot)) return noop();
  const filePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);

  // Preflight convergence: ensure .traffic-one/** is current for this project
  // before we judge it (side-effect only; the outcome is intentionally ignored).
  migrateArchitectureDocsToPlan(projectRoot);
  materializeProjectIfNeeded(projectRoot, { trigger: 'plan preflight convergence' });

  const content = asString(toolInput.content) || asString(toolInput.new_string) || '';
  const state = readEffectiveState(projectRoot);
  const isNative = isNativeState(state);

  // Resolve which targets are feature source (direct path + apply_patch targets).
  const featureTargetPaths: string[] = [];
  if (FEATURE_SOURCE_RE.test(filePath)) featureTargetPaths.push(filePath);
  for (const targetPath of patchTargetPaths) {
    const rel = projectRelativeHookPath(cwd, projectRoot, targetPath);
    if (FEATURE_SOURCE_RE.test(rel) && !featureTargetPaths.includes(rel)) featureTargetPaths.push(rel);
  }
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && commandAppearsToWriteFeatureSource(rawCommand);
  const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;

  const violations: string[] = [];
  violations.push(...planReadinessViolations({ filePath, content, projectRoot, state, writingFeatureSource, block }));
  const runTeam = runTeamEnforcementViolation({
    projectRoot, filePath, state, rawData: raw, featureTargetPaths, writingFeatureSource, writingFeatureSourceViaCommand, block,
  });
  if (runTeam) violations.push(runTeam);
  violations.push(...planStaticViolations(filePath, content, isNative, block));

  if (violations.length === 0) return noop();
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
}
