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

import * as path from 'path';

import { asString } from '../../adapters/coerce';
import { obj, type Rec } from '../../shared/obj';
import { deny, noop } from '../../core/result';
import type { Ctx, HookResult } from '../../core/types';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { modelChoiceReplyPending } from '../agent-model/model-choice';
import {
  BUILD_ARTIFACT_RE,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteExternalTemp,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  shellWriteTargetsStateDir,
} from '../../shared/feature-source';
import { parseApplyPatch, patchTextFromToolInput, type PatchFileOperation } from '../../shared/apply-patch';
import { projectRelativeHookPath, resolveProjectRoot } from '../../shared/hook-paths';
import { materializeProjectIfNeeded, migrateArchitectureDocsToPlan } from '../../shared/materialize';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { activeAgentRole, hookSessionIdentity, isNativeState, readEffectiveState } from '../../shared/state';
import { capturePlanGuardDebug } from '../../shared/state/claim-capture';
import { canonicalToolName, commandFromToolInput, isShellToolName, normalizedToolName, parsedToolInput } from '../../shared/tool-classify';
import { planReadinessViolations } from './plan-readiness';
import { runIdPathViolation } from './plan-runid';
import { runTeamEnforcementViolation } from './plan-runteam';
import { planStaticViolations, makePlanBlock } from './plan-static';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

interface GateTarget {
  filePath: string;
  resultContent: string;
  addedContent: string;
  staticCheck: boolean;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (value && !target.includes(value)) target.push(value);
  }
}

function patchTargets(
  operations: readonly PatchFileOperation[],
  cwd: string,
  projectRoot: string,
): GateTarget[] {
  const targets: GateTarget[] = [];
  const add = (file: string, resultContent: string, addedContent: string, staticCheck: boolean): void => {
    const filePath = projectRelativeHookPath(cwd, projectRoot, file);
    if (!filePath) return;
    targets.push({ filePath, resultContent, addedContent, staticCheck });
  };
  for (const operation of operations) {
    if (operation.kind === 'delete') {
      add(operation.path, '', '', false);
    } else if (operation.kind === 'move') {
      // A move mutates both paths: ownership/readiness checks see the source
      // deletion and destination write. Every source line is newly introduced
      // at the destination, so destination static checks inspect the complete
      // reconstructed result (including a pure move with no hunks).
      add(operation.path, '', '', false);
      add(
        operation.destinationPath as string,
        operation.resultContent || '',
        operation.resultContent || '',
        true,
      );
    } else {
      add(operation.path, operation.resultContent || '', operation.addedContent, true);
    }
  }
  return targets;
}

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
  const rawCommand = commandFromToolInput(toolInput) || asString(tool?.command);
  const isApplyPatch = normalizedToolName(toolName).toLowerCase() === 'apply_patch';
  const rawPatchText = isApplyPatch
    ? patchTextFromToolInput(tool?.patchText, raw.tool_input, raw.toolInput, raw.input, raw, toolInput)
    : '';

  const cwd = ctx.cwd;
  // Never gate the plugin's own authoring repo — the gate/materialiser must never
  // act on it (mirrors the onboarding gate). Without this, a stale or missing
  // .traffic-one here makes the plan gate fire on plugin development.
  if (isPluginAuthoringRoot(cwd)) return noop();
  if (pluginUseDeclined(cwd)) return noop();

  const structuralPatch = isApplyPatch ? parseApplyPatch(rawPatchText) : null;
  if (structuralPatch && !structuralPatch.ok) {
    return deny(`traffic-one — invalid apply_patch payload: ${structuralPatch.error}. No write was made.`);
  }
  const firstPatchTarget = structuralPatch?.ok ? structuralPatch.operations[0]?.path || '' : '';
  const patchBase = tool?.workdir
    ? (path.isAbsolute(tool.workdir) ? path.resolve(tool.workdir) : path.resolve(cwd, tool.workdir))
    : cwd;
  const resolutionBase = isApplyPatch ? patchBase : cwd;
  const projectRoot = resolveProjectRoot(resolutionBase, rawFilePath || firstPatchTarget, { ceiling: ctx.input.workspaceRoot });
  // The resolver's fallback can still hand back a dir inside the plugin repo.
  if (isPluginAuthoringRoot(projectRoot)) return noop();
  const directFilePath = projectRelativeHookPath(cwd, projectRoot, rawFilePath);

  // Reconstruct before convergence: convergence may legitimately refresh
  // generated .traffic-one files, but validation must describe the exact
  // pre-tool filesystem the patch itself was authored against.
  const reconstructedPatch = isApplyPatch ? parseApplyPatch(rawPatchText, { baseDir: patchBase }) : null;
  if (reconstructedPatch && !reconstructedPatch.ok) {
    return deny(`traffic-one — invalid apply_patch payload: ${reconstructedPatch.error}. No write was made.`);
  }

  // Preflight convergence: ensure .traffic-one/** is current for this project
  // before we judge it (side-effect only; the outcome is intentionally ignored).
  migrateArchitectureDocsToPlan(projectRoot);
  materializeProjectIfNeeded(projectRoot, { trigger: 'plan preflight convergence' });

  const directContent = asString(toolInput.content) || asString(toolInput.new_string)
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

  const gateTargets: GateTarget[] = reconstructedPatch?.ok
    ? patchTargets(reconstructedPatch.operations, patchBase, projectRoot)
    : (directFilePath
      ? [{ filePath: directFilePath, resultContent: directContent, addedContent: directContent, staticCheck: true }]
      : []);
  const filePath = directFilePath || gateTargets[0]?.filePath || '';

  // Resolve every source and destination target. A multi-file patch is one
  // atomic tool call, but ownership/readiness/static checks run per operation.
  const writeTargetPaths: string[] = [];
  const featureTargetPaths: string[] = [];
  const buildArtifactTargetPaths: string[] = [];
  const targetContents = Object.create(null) as Record<string, string>;
  for (const target of gateTargets) {
    appendUnique(writeTargetPaths, [target.filePath]);
    if (FEATURE_SOURCE_RE.test(target.filePath)) appendUnique(featureTargetPaths, [target.filePath]);
    if (BUILD_ARTIFACT_RE.test(target.filePath)) appendUnique(buildArtifactTargetPaths, [target.filePath]);
    targetContents[target.filePath] = target.resultContent;
  }
  // Run-state carve-out: a heredoc/redirect whose only write targets are under
  // `.traffic-one/{digests,fix-cycles,runs}/` is state bookkeeping (reviewer
  // digests, fix-cycle notes), not an implementation write — even when its BODY
  // cites feature-source paths. Mirrors the Write/Edit target-path exemption.
  const shellStateDirWrite = isShellToolName(toolName) && shellWriteTargetsStateDir(rawCommand);
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && !shellStateDirWrite
    && commandAppearsToWriteFeatureSource(rawCommand);
  const writingBuildArtifactViaCommand = isShellToolName(toolName) && !shellStateDirWrite
    && commandAppearsToWriteBuildArtifact(rawCommand);
  const writingExternalTempViaCommand = isShellToolName(toolName) && commandAppearsToWriteExternalTemp(rawCommand);
  const writingFeatureSource = featureTargetPaths.length > 0 || writingFeatureSourceViaCommand;
  const writingBuildArtifact = buildArtifactTargetPaths.length > 0 || writingBuildArtifactViaCommand;
  const runTeamTargetPaths = [...featureTargetPaths];
  for (const target of buildArtifactTargetPaths) {
    if (!runTeamTargetPaths.includes(target)) runTeamTargetPaths.push(target);
  }

  const violations: string[] = [];
  const readinessTargets = gateTargets.length > 0
    ? gateTargets
    : [{ filePath, resultContent: directContent, addedContent: directContent, staticCheck: true }];
  for (const target of readinessTargets) {
    appendUnique(violations, planReadinessViolations({
      filePath: target.filePath,
      content: target.resultContent,
      projectRoot,
      state,
      writingFeatureSource: FEATURE_SOURCE_RE.test(target.filePath)
        || (gateTargets.length === 0 && writingFeatureSourceViaCommand),
      host: ctx.host,
      rawData: raw,
      block,
    }));
  }
  if ((ctx.host === 'opencode' || ctx.host === 'kilo') && writingExternalTempViaCommand) {
    violations.push(block('opencode-external-temp-shell',
      'OpenCode/Kilo external-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.'));
  }
  // Run-id write-guard: a stray (e.g. `date` ISO) run-id in a runs/<id> or
  // digests/<id> write path splits run state away from currentRunId. Check the
  // direct target, apply_patch targets, and the shell command.
  const runIdViolation = runIdPathViolation({ state, relTargets: writeTargetPaths, command: rawCommand, block });
  if (runIdViolation) violations.push(runIdViolation);
  const recordFallbackClaims = violations.length === 0;
  const runTeam = runTeamEnforcementViolation({
    host: ctx.host,
    projectRoot,
    filePath,
    state,
    rawData: raw,
    content: directContent,
    writeTargetPaths,
    targetContents,
    featureTargetPaths: runTeamTargetPaths,
    writingFeatureSource,
    writingFeatureSourceViaCommand,
    writingBuildArtifact,
    writingBuildArtifactViaCommand,
    recordFallbackClaims,
    block,
  });
  if (runTeam) violations.push(runTeam);
  for (const target of gateTargets.filter((candidate) => candidate.staticCheck)) {
    appendUnique(violations, planStaticViolations(target.filePath, target.addedContent, isNative, block));
  }

  if (violations.length === 0) return noop();
  const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
  // Attribution makes multi-agent runs debuggable: without it a deny line can't
  // be tied to the subagent that was denied except by transcript archaeology.
  const denyIdentity = hookSessionIdentity(raw);
  capturePlanGuardDebug(projectRoot, runId, {
    filePath,
    filePaths: writeTargetPaths,
    host: ctx.host,
    sessionId: denyIdentity.sessionId || null,
    isSubagent: denyIdentity.isSubagent || false,
    role: activeAgentRole(state),
    violations: violations.map((v) => (v.length > 400 ? `${v.slice(0, 400)}…` : v)),
  });
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
}
