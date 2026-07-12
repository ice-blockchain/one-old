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
import { modelChoiceReplyPending } from '../agent-model/model-choice';
import {
  applyPatchTargetPaths,
  BUILD_ARTIFACT_RE,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteExternalTemp,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
} from '../../shared/feature-source';
import { projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded, migrateArchitectureDocsToPlan } from '../../shared/materialize';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { isNativeState, readEffectiveState } from '../../shared/state';
import { capturePlanGuardDebug } from '../../shared/state/claim-capture';
import { canonicalToolName, commandFromToolInput, isShellToolName, normalizedToolName, parsedToolInput } from '../../shared/tool-classify';
import { planReadinessViolations } from './plan-readiness';
import { runIdPathViolation } from './plan-runid';
import { runTeamEnforcementViolation } from './plan-runteam';
import { planStaticViolations, makePlanBlock } from './plan-static';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

export function planWriteGate(ctx: Ctx): HookResult {
  const raw = obj(ctx.input.raw) || {};
  // Host-agnostic tool classification (see onboarding-gate): Cursor's rawName is a
  // coarse subcommand and its command/path live on ctx.input.tool, not raw.tool_input
  // — without this the shell feature-source-write deny is blind on Cursor.
  const tool = ctx.input.tool;
  const toolName = canonicalToolName(ctx.input.tool) || asString(raw.tool_name ?? raw.toolName) || 'Bash';
  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || parsedToolInput(ctx.input.tool) || {};

  // OpenCode tools carry camelCase args (write/edit → `filePath`, edit → `newString`,
  // apply_patch → `patchText`) — the snake_case reads below miss them, which would
  // blind every path-keyed gate (monorepo/plan/feature-source) on the OpenCode host.
  // The adapter already normalized these into ctx.input.tool, so fall back to the
  // canonical fields + camelCase raw names. Claude/Codex/Cursor hit the snake_case /
  // parsedToolInput reads first, so their behavior is byte-identical.
  const rawFilePath = (asString(toolInput.file_path) || asString(toolInput.filePath)
    || asString(toolInput.path) || asString(tool?.filePath)).replace(/\\/g, '/');
  const rawCommand = commandFromToolInput(toolInput) || asString(tool?.command) || asString(toolInput.patchText);
  const patchTargetPaths = normalizedToolName(toolName) === 'apply_patch'
    ? applyPatchTargetPaths(rawCommand)
    : [];

  const cwd = ctx.cwd;
  // Never gate the plugin's own authoring repo — the gate/materialiser must never
  // act on it (mirrors the onboarding gate). Without this, a stale or missing
  // .traffic-one here makes the plan gate fire on plugin development.
  if (isPluginAuthoringRoot(cwd)) return noop();
  if (authChoiceAllowsContinue(cwd)) return noop();

  const projectRoot = resolveProjectRoot(cwd, rawFilePath || patchTargetPaths[0] || '', { ceiling: ctx.input.workspaceRoot });
  // The resolver's fallback can still hand back a dir inside the plugin repo.
  if (isPluginAuthoringRoot(projectRoot)) return noop();
  const filePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);

  // Preflight convergence: ensure .traffic-one/** is current for this project
  // before we judge it (side-effect only; the outcome is intentionally ignored).
  migrateArchitectureDocsToPlan(projectRoot);
  materializeProjectIfNeeded(projectRoot, { trigger: 'plan preflight convergence' });

  const content = asString(toolInput.content) || asString(toolInput.new_string)
    || asString(toolInput.newString) || asString(tool?.content) || '';
  const state = readEffectiveState(projectRoot);
  const isNative = isNativeState(state);

  if (ctx.host === 'cursor' && state && modelChoiceReplyPending(projectRoot, state as Rec)) {
    return deny(
      'traffic-one — model choice required (build paused): reply `fallback` to proceed on the listed fallback model(s), '
      + 'or `enable` to turn on the picked model(s), re-capture Cursor models, and retry. '
      + 'Do not spawn subagents, scaffold directly, or edit project files until the user replies.',
    );
  }

  // Resolve which targets are feature source (direct path + apply_patch targets).
  const writeTargetPaths: string[] = [];
  if (filePath) writeTargetPaths.push(filePath);
  const featureTargetPaths: string[] = [];
  const buildArtifactTargetPaths: string[] = [];
  if (FEATURE_SOURCE_RE.test(filePath)) featureTargetPaths.push(filePath);
  if (BUILD_ARTIFACT_RE.test(filePath)) buildArtifactTargetPaths.push(filePath);
  for (const targetPath of patchTargetPaths) {
    const rel = projectRelativeHookPath(cwd, projectRoot, targetPath);
    if (rel && !writeTargetPaths.includes(rel)) writeTargetPaths.push(rel);
    if (FEATURE_SOURCE_RE.test(rel) && !featureTargetPaths.includes(rel)) featureTargetPaths.push(rel);
    if (BUILD_ARTIFACT_RE.test(rel) && !buildArtifactTargetPaths.includes(rel)) buildArtifactTargetPaths.push(rel);
  }
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && commandAppearsToWriteFeatureSource(rawCommand);
  const writingBuildArtifactViaCommand = isShellToolName(toolName) && commandAppearsToWriteBuildArtifact(rawCommand);
  const writingExternalTempViaCommand = isShellToolName(toolName) && commandAppearsToWriteExternalTemp(rawCommand);
  const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;
  const writingBuildArtifact = buildArtifactTargetPaths.length > 0 || writingBuildArtifactViaCommand;
  const runTeamTargetPaths = [...featureTargetPaths];
  for (const target of buildArtifactTargetPaths) {
    if (!runTeamTargetPaths.includes(target)) runTeamTargetPaths.push(target);
  }

  const violations: string[] = [];
  violations.push(...planReadinessViolations({ filePath, content, projectRoot, state, writingFeatureSource, host: ctx.host, rawData: raw, block }));
  if ((ctx.host === 'opencode' || ctx.host === 'kilo') && writingExternalTempViaCommand) {
    violations.push(block('opencode-external-temp-shell',
      'OpenCode/Kilo external-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.'));
  }
  // Run-id write-guard: a stray (e.g. `date` ISO) run-id in a runs/<id> or
  // digests/<id> write path splits run state away from currentRunId. Check the
  // direct target, apply_patch targets, and the shell command.
  const runIdTargets = [filePath, ...patchTargetPaths.map((p) => projectRelativeHookPath(cwd, projectRoot, p))];
  const runIdViolation = runIdPathViolation({ state, relTargets: runIdTargets, command: rawCommand, block });
  if (runIdViolation) violations.push(runIdViolation);
  const recordFallbackClaims = violations.length === 0;
  const runTeam = runTeamEnforcementViolation({
    host: ctx.host,
    projectRoot,
    filePath,
    state,
    rawData: raw,
    content,
    writeTargetPaths,
    featureTargetPaths: runTeamTargetPaths,
    writingFeatureSource,
    writingFeatureSourceViaCommand,
    writingBuildArtifact,
    writingBuildArtifactViaCommand,
    recordFallbackClaims,
    block,
  });
  if (runTeam) violations.push(runTeam);
  violations.push(...planStaticViolations(filePath, content, isNative, block));

  if (violations.length === 0) return noop();
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  capturePlanGuardDebug(projectRoot, runId, {
    filePath,
    filePaths: writeTargetPaths,
    host: ctx.host,
    violations: violations.map((v) => (v.length > 400 ? `${v.slice(0, 400)}…` : v)),
  });
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
}
