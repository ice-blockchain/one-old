// src/modules/plan-guard/plan-write/index.ts
// The plan-write gate dispatcher: routes each write through readiness,
// run-team, run-id, and static checks. Target classification lives in
// targets.ts.

import * as path from 'path';
import { asString } from '../../../adapters/coerce';
import { obj, type Rec } from '../../../shared/obj';
import { deny, noop } from '../../../core/result';
import type { Ctx, HookResult } from '../../../core/types';
import { isPluginAuthoringRoot } from '../../../shared/authoring-root';
import { pluginUseDeclined } from '../../../shared/state/plugin-use';
import { modelChoiceReplyPending } from '../../agent-model/model-choice';
import {
  BUILD_ARTIFACT_RE,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteExternalTemp,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  shellAssetImportDest,
  shellStrayDeleteTarget,
  shellTrafficOneWriteTargets,
  shellWriteTargetsStateDir,
} from '../../../shared/feature-source';
import { parseApplyPatch, patchTextFromToolInput } from '../../../shared/apply-patch';
import { projectRelativeHookPath } from '../../../shared/hook/paths';
import { materializeProjectIfNeeded, migrateArchitectureDocsToPlan } from '../../../shared/materialize';
import { pluginRoot } from '../../../shared/paths';
import { makeSkillBlock } from '../../../shared/skill-block';
import { activeAgentRole, hookSessionIdentity, isNativeState, readEffectiveState, resolveRunAgentContext, roleForRunSessionId } from '../../../shared/state';
import { capturePlanGuardDebug } from '../../../shared/state/claim-capture';
import { canonicalToolName, commandFromToolInput, isShellToolName, normalizedToolName, parsedToolInput } from '../../../shared/tool-classify';
import {
  capabilityProfileForRun,
  isDeletableStrayArtifact,
  readCompiledArchitecture,
} from '../../../shared/architecture-contract';
import { profileHasWebUi } from '../../../shared/capabilities';
import { planReadinessViolations } from '../plan-readiness';
import { runIdPathViolation } from '../plan-runid';
import { runTeamEnforcementViolation } from '../plan-runteam';
import { planStaticViolations, makePlanBlock } from '../plan-static';
import { resolveToolScope } from '../../../shared/tool-scope';

import {
  appendUnique,
  commandAppearsToWriteCompiledFeature,
  isCompiledFeatureTarget,
  ownString,
  patchTargets,
  reconstructTextEdit,
  type GateTarget,
} from './targets';

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
  const isApplyPatch = normalizedToolName(toolName).toLowerCase() === 'apply_patch';
  // Codex apply_patch payloads arrive in tool_input.command — patch DATA, not a
  // shell command. Run-id/feature-write/heredoc scanners must never read patch
  // bodies as shell text (observed 3co: content strings became phantom targets).
  const rawCommand = isApplyPatch ? '' : (commandFromToolInput(toolInput) || asString(tool?.command));
  const rawPatchText = isApplyPatch
    ? patchTextFromToolInput(tool?.patchText, raw.tool_input, raw.toolInput, raw.input, raw, toolInput)
    : '';

  const toolScope = resolveToolScope(ctx);
  // Stand down only when BOTH the hook cwd and every explicit tool/command
  // target remain inside plugin authoring or machine-config space. An absolute
  // target in a real project is resolved and gated below.
  if (toolScope.standsDown) return noop();

  const structuralPatch = isApplyPatch ? parseApplyPatch(rawPatchText) : null;
  if (structuralPatch && !structuralPatch.ok) {
    return deny(`traffic-one — invalid apply_patch payload: ${structuralPatch.error}. No write was made.`);
  }
  const firstPatchTarget = structuralPatch?.ok ? structuralPatch.operations[0]?.path || '' : '';
  const patchBase = toolScope.base;
  const projectRoot = toolScope.projectRoot;
  // The resolver's fallback can still hand back a dir inside the plugin repo.
  if (isPluginAuthoringRoot(projectRoot)) return noop();
  if (pluginUseDeclined(projectRoot)) return noop();
  const directFilePath = projectRelativeHookPath(toolScope.base, projectRoot, rawFilePath);

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
  const currentRunId = typeof state.currentRunId === 'string' ? state.currentRunId : '';
  const compiledArchitecture = currentRunId
    ? readCompiledArchitecture(projectRoot, currentRunId)
    : null;
  const isFeatureTarget = (target: string): boolean => (
    FEATURE_SOURCE_RE.test(target)
    || isCompiledFeatureTarget(compiledArchitecture, target)
  );
  const isNative = isNativeState(state);
  let directResultContent = directContent;
  let directAddedContent = directContent;
  if (
    tool?.class === 'file-edit'
    && directFilePath
    && /\.(?:tsx?|jsx?|mjs|cjs|vue)$/i.test(directFilePath)
    && profileHasWebUi(capabilityProfileForRun(projectRoot, state))
  ) {
    const contentEvidence = ownString(toolInput, ['content', 'new_content', 'newContent']);
    const fallbackNew = tool?.content !== undefined
      ? tool.content
      : (contentEvidence.found ? contentEvidence.value : undefined);
    const absoluteFile = path.isAbsolute(rawFilePath)
      ? path.resolve(rawFilePath)
      : path.resolve(toolScope.base, rawFilePath);
    const reconstruction = reconstructTextEdit(absoluteFile, raw, toolInput, fallbackNew);
    if (!reconstruction.ok) {
      return deny(
        `traffic-one — plan gate violation(s):\n  - STRUCT_SCAN_INCOMPLETE: cannot safely reconstruct the complete post-Edit file `
        + `for ${directFilePath} (${reconstruction.error}). No write was made; retry with one exact old_string/new_string match `
        + 'or a complete apply_patch payload.',
      );
    }
    directResultContent = reconstruction.resultContent;
    directAddedContent = reconstruction.addedContent;
  }

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
      ? [{
        filePath: directFilePath,
        resultContent: directResultContent,
        addedContent: directAddedContent,
        staticCheck: true,
      }]
      : []);
  if (isShellToolName(toolName)) {
    for (const shellTarget of shellTrafficOneWriteTargets(rawCommand)) {
      const relative = projectRelativeHookPath(patchBase, projectRoot, shellTarget);
      if (!relative || gateTargets.some((target) => target.filePath === relative)) continue;
      gateTargets.push({
        filePath: relative,
        resultContent: '',
        addedContent: '',
        staticCheck: false,
      });
    }
  }
  const filePath = directFilePath || gateTargets[0]?.filePath || '';

  // Resolve every source and destination target. A multi-file patch is one
  // atomic tool call, but ownership/readiness/static checks run per operation.
  const writeTargetPaths: string[] = [];
  const featureTargetPaths: string[] = [];
  const buildArtifactTargetPaths: string[] = [];
  const targetContents = Object.create(null) as Record<string, string>;
  for (const target of gateTargets) {
    appendUnique(writeTargetPaths, [target.filePath]);
    if (isFeatureTarget(target.filePath)) appendUnique(featureTargetPaths, [target.filePath]);
    if (BUILD_ARTIFACT_RE.test(target.filePath)) appendUnique(buildArtifactTargetPaths, [target.filePath]);
    targetContents[target.filePath] = target.resultContent;
  }
  // Run-state carve-out: a heredoc/redirect whose only write targets are under
  // `.traffic-one/{digests,fix-cycles,runs}/` is state bookkeeping (reviewer
  // digests, fix-cycle notes), not an implementation write — even when its BODY
  // cites feature-source paths. Mirrors the Write/Edit target-path exemption.
  const shellStateDirWrite = isShellToolName(toolName) && shellWriteTargetsStateDir(rawCommand);
  // Asset-import carve-out: a single `cp`/`mv` bringing a read-only file from
  // OUTSIDE the project into a project path has a verifiable DEST — route it
  // through the same per-target ownership checks as Write/Edit instead of the
  // blanket shell-write deny (binary deliverables have no text-tool path;
  // observed 10c-codex: a generated OG raster could never be placed).
  const assetImportDest = isShellToolName(toolName) && !shellStateDirWrite
    ? shellAssetImportDest(rawCommand, patchBase, projectRoot)
    : null;
  if (assetImportDest) {
    appendUnique(writeTargetPaths, [assetImportDest]);
    if (isFeatureTarget(assetImportDest)) appendUnique(featureTargetPaths, [assetImportDest]);
    if (BUILD_ARTIFACT_RE.test(assetImportDest)) appendUnique(buildArtifactTargetPaths, [assetImportDest]);
  }
  // Stray-artifact carve-out: an exact single-file `rm` whose target is present
  // on disk, owned by NOBODY in the compiled contract, untracked, and absent
  // from the immutable baseline is cleanup, not an implementation write. Without
  // it a role that produced a stray file cannot remove it and neither can its
  // parent (observed 6co on `apps/web/public/icons/favicon.svg.png`), so the run
  // only escapes through an exact `git clean`. Everything broader — globs,
  // `-r`, multiple operands, tracked or compiled paths — stays denied.
  const strayDeleteTarget = isShellToolName(toolName) && !shellStateDirWrite && !assetImportDest
    ? shellStrayDeleteTarget(rawCommand, patchBase, projectRoot)
    : null;
  const cleaningStrayArtifact = Boolean(
    strayDeleteTarget && isDeletableStrayArtifact(projectRoot, strayDeleteTarget, compiledArchitecture),
  );
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && !shellStateDirWrite && !assetImportDest
    && !cleaningStrayArtifact
    && (
      commandAppearsToWriteFeatureSource(rawCommand)
      || commandAppearsToWriteCompiledFeature(rawCommand, compiledArchitecture)
    );
  const writingBuildArtifactViaCommand = isShellToolName(toolName) && !shellStateDirWrite && !assetImportDest
    && !cleaningStrayArtifact
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
    : [{
      filePath,
      resultContent: directResultContent,
      addedContent: directAddedContent,
      staticCheck: true,
    }];
  for (const target of readinessTargets) {
    appendUnique(violations, planReadinessViolations({
      filePath: target.filePath,
      content: target.resultContent,
      // Shell-derived targets (staticCheck false) carry no reconstructable
      // payload; content-shape gates must judge the on-disk artifact, not ''.
      contentVerified: target.staticCheck,
      projectRoot,
      state,
      writingFeatureSource: isFeatureTarget(target.filePath)
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
  const runIdViolation = runIdPathViolation({ state, relTargets: writeTargetPaths, command: rawCommand, block, projectRoot });
  if (runIdViolation) violations.push(runIdViolation);
  // Registry probes during new-project setup were prose-only
  // (rules/common/stack-recommendations.md) and agents ignored the rule when it
  // mattered: observed 5cl-claude, the frontend ran `npm view typescript
  // versions`, concluded "the registry treats 7.0.2 as latest", and EDITED the
  // stack-pinned `typescript: 5.9.3` up two majors with no ADR. Deterministic
  // deny, new-project mode only; installs (`pnpm add`, `npm install`) stay
  // untouched — they resolve inside the pinned ranges.
  if (state.mode === 'new-project'
    && /(?:^|[\s;&|(])(?:(?:npm|pnpm)\s+(?:view|show|info|v)\b|yarn\s+info\b|(?:npm|pnpm|yarn|bun)\s+outdated\b)/.test(rawCommand)) {
    violations.push(block('registry-probe-gate',
      'Registry probe gate: do not query the npm registry (`npm view`/`show`/`info`/`outdated`, `pnpm view`, `yarn info`) to pick scaffold or dependency versions during new-project setup. Versions come from the active stack contract — install with the pinned ranges (`pnpm add <pkg>` resolves the latest matching minor/patch). Only an explicit user request for a newer major overrides a pin, recorded as an ADR in `.traffic-one/decisions/`.'));
  }
  const recordFallbackClaims = violations.length === 0;
  const runTeam = runTeamEnforcementViolation({
    host: ctx.host,
    projectRoot,
    filePath,
    state,
    rawData: raw,
    content: directResultContent,
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
  // The shared state carries no per-session role (parallel implementers), so
  // resolve the writer through the run's agent registry/claims by sessionId —
  // hosts like Cursor also never flag subagent-ness in the payload, so a
  // registry match doubles as the isSubagent signal.
  const denyIdentity = hookSessionIdentity(raw);
  const registryRole = roleForRunSessionId(projectRoot, runId, denyIdentity.sessionId);
  // On Claude a subagent's hook payload carries the PARENT's session id, while
  // its claim is keyed by the child's own id, so the two lookups above always
  // miss and every subagent deny was logged with `role: null` (observed 1cl —
  // four denies, an architect claim active the whole time, no way to attribute
  // them). Fall back to the same resolver the gates themselves trust.
  const resolvedContext = registryRole
    ? null
    : resolveRunAgentContext(projectRoot, state, raw, { host: ctx.host });
  const resolvedRole = registryRole
    || (typeof resolvedContext?.role === 'string' ? resolvedContext.role : null);
  capturePlanGuardDebug(projectRoot, runId, {
    filePath,
    filePaths: writeTargetPaths,
    host: ctx.host,
    sessionId: denyIdentity.sessionId || null,
    isSubagent: denyIdentity.isSubagent || Boolean(resolvedRole),
    role: activeAgentRole(state) || resolvedRole,
    violations: violations.map((v) => (v.length > 400 ? `${v.slice(0, 400)}…` : v)),
  });
  // The trailing line prevents a real recovery failure: after a deny on a NEW
  // file the agent assumed partial content existed and issued Edit calls
  // against it ("File does not exist" ×2, observed 5cl-claude on plan.md).
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}\nNo write was applied — the denied Write/Edit/apply_patch left the target file(s) unchanged on disk. Fix the violation(s) and re-issue the FULL corrected write; do not Edit content that was never written.`);
}
