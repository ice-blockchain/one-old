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

import * as fs from 'fs';
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
  shellCommandHasWritePrimitive,
  shellAssetImportDest,
  shellTrafficOneWriteTargets,
  shellWriteTargetsStateDir,
} from '../../shared/feature-source';
import { parseApplyPatch, patchTextFromToolInput, type PatchFileOperation } from '../../shared/apply-patch';
import { projectRelativeHookPath } from '../../shared/hook-paths';
import { materializeProjectIfNeeded, migrateArchitectureDocsToPlan } from '../../shared/materialize';
import { pluginRoot } from '../../shared/paths';
import { makeSkillBlock } from '../../shared/skill-block';
import { activeAgentRole, hookSessionIdentity, isNativeState, readEffectiveState, resolveRunAgentContext, roleForRunSessionId } from '../../shared/state';
import { capturePlanGuardDebug } from '../../shared/state/claim-capture';
import { canonicalToolName, commandFromToolInput, isShellToolName, normalizedToolName, parsedToolInput } from '../../shared/tool-classify';
import {
  capabilityProfileForRun,
  readCompiledArchitecture,
  type CompiledArchitectureV1,
} from '../../shared/architecture-contract';
import { profileHasWebUi } from '../../shared/capabilities';
import { planReadinessViolations } from './plan-readiness';
import { runIdPathViolation } from './plan-runid';
import { runTeamEnforcementViolation } from './plan-runteam';
import { planStaticViolations, makePlanBlock } from './plan-static';
import { resolveToolScope } from '../../shared/tool-scope';

const block = makePlanBlock(makeSkillBlock(pluginRoot));

interface GateTarget {
  filePath: string;
  resultContent: string;
  addedContent: string;
  staticCheck: boolean;
}

interface TextEditSpec {
  oldText: string;
  newText: string;
  replaceAll: boolean;
}

type TextEditReconstruction =
  | { ok: true; resultContent: string; addedContent: string }
  | { ok: false; error: string };

const HOT_EDIT_MAX_BYTES = 2 * 1024 * 1024;

function normalizedRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+/g, '/');
}

function underRoot(filePath: string, root: string): boolean {
  const file = normalizedRelative(filePath);
  const boundary = normalizedRelative(root).replace(/\/+$/, '');
  return Boolean(boundary)
    && (file === boundary || file.startsWith(`${boundary}/`));
}

/**
 * CompiledArchitectureV1, not a fixed React/monorepo regex, owns the write
 * boundary for a v2 run. The legacy regex remains only for pre-contract runs.
 */
function isCompiledFeatureTarget(
  architecture: CompiledArchitectureV1 | null,
  filePath: string,
): boolean {
  if (!architecture || !filePath) return false;
  const roots = [
    ...architecture.sourceRoots,
    ...architecture.layers.pages,
    ...architecture.layers.components,
    ...architecture.layers.features,
    ...architecture.layers.lib,
  ];
  return architecture.entrypoints.some((entrypoint) => (
    normalizedRelative(entrypoint) === normalizedRelative(filePath)
  )) || roots.some((root) => underRoot(filePath, root));
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function commandAppearsToWriteCompiledFeature(
  command: string,
  architecture: CompiledArchitectureV1 | null,
): boolean {
  if (!architecture || !shellCommandHasWritePrimitive(command)) return false;
  const roots = [
    ...architecture.sourceRoots,
    ...architecture.layers.pages,
    ...architecture.layers.components,
    ...architecture.layers.features,
    ...architecture.layers.lib,
    ...architecture.entrypoints.map((entrypoint) => path.posix.dirname(
      normalizedRelative(entrypoint),
    )),
  ]
    .map(normalizedRelative)
    .filter((root) => root && root !== '.');
  return [...new Set(roots)].some((root) => (
    new RegExp(`(?:^|[\\s'"\\x22\`=(:,/])${regexEscape(root)}(?:/|$|[\\s'"\\x22\`;|&)])`)
      .test(command.replace(/\\\\/g, '/'))
  ));
}

function ownString(rec: Rec | null, keys: readonly string[]): { found: boolean; value: string } {
  if (!rec) return { found: false, value: '' };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(rec, key) && typeof rec[key] === 'string') {
      return { found: true, value: rec[key] as string };
    }
  }
  return { found: false, value: '' };
}

function editSpec(rec: Rec | null, fallbackNew?: string): TextEditSpec | null {
  const oldText = ownString(rec, ['old_string', 'oldString', 'old_str', 'oldText']);
  const newText = ownString(rec, ['new_string', 'newString', 'new_str', 'newText', 'new_content', 'newContent']);
  if (!oldText.found || (!newText.found && fallbackNew === undefined)) return null;
  return {
    oldText: oldText.value,
    newText: newText.found ? newText.value : (fallbackNew as string),
    replaceAll: rec?.replace_all === true || rec?.replaceAll === true,
  };
}

function editSpecs(raw: Rec, toolInput: Rec, fallbackNew?: string): TextEditSpec[] | null {
  const editsValue = Array.isArray(toolInput.edits)
    ? toolInput.edits
    : (Array.isArray(raw.edits) ? raw.edits : null);
  if (editsValue) {
    if (editsValue.length === 0) return null;
    const specs = editsValue.map((entry) => editSpec(obj(entry)));
    return specs.every((spec): spec is TextEditSpec => spec !== null) ? specs : null;
  }
  return [editSpec(toolInput, fallbackNew) || editSpec(raw, fallbackNew)].filter(
    (spec): spec is TextEditSpec => spec !== null,
  );
}

function occurrenceCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let cursor = 0;
  while ((cursor = haystack.indexOf(needle, cursor)) !== -1) {
    count += 1;
    cursor += needle.length;
  }
  return count;
}

function reconstructTextEdit(
  absoluteFile: string,
  raw: Rec,
  toolInput: Rec,
  fallbackNew?: string,
): TextEditReconstruction {
  let current: string;
  try {
    const stat = fs.statSync(absoluteFile);
    if (!stat.isFile()) return { ok: false, error: 'target is not a regular file' };
    if (stat.size > HOT_EDIT_MAX_BYTES) {
      return { ok: false, error: `target exceeds the ${HOT_EDIT_MAX_BYTES}-byte hot-scan limit` };
    }
    current = fs.readFileSync(absoluteFile, 'utf8');
    if (current.includes('\0')) return { ok: false, error: 'target is binary' };
  } catch {
    return { ok: false, error: 'target does not exist or is unreadable' };
  }

  const specs = editSpecs(raw, toolInput, fallbackNew);
  if (!specs || specs.length === 0) {
    return { ok: false, error: 'old_string/new_string edit evidence is missing or incomplete' };
  }
  const added: string[] = [];
  for (const [index, spec] of specs.entries()) {
    if (!spec.oldText) {
      return { ok: false, error: `edit ${index + 1} has an empty old_string` };
    }
    const occurrences = occurrenceCount(current, spec.oldText);
    if (occurrences === 0) {
      return { ok: false, error: `edit ${index + 1} old_string does not match the current file` };
    }
    if (!spec.replaceAll && occurrences !== 1) {
      return { ok: false, error: `edit ${index + 1} old_string is ambiguous (${occurrences} matches)` };
    }
    current = spec.replaceAll
      ? current.split(spec.oldText).join(spec.newText)
      : current.replace(spec.oldText, spec.newText);
    added.push(spec.newText);
  }
  return { ok: true, resultContent: current, addedContent: added.join('\n') };
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
  const writingFeatureSourceViaCommand = isShellToolName(toolName) && !shellStateDirWrite && !assetImportDest
    && (
      commandAppearsToWriteFeatureSource(rawCommand)
      || commandAppearsToWriteCompiledFeature(rawCommand, compiledArchitecture)
    );
  const writingBuildArtifactViaCommand = isShellToolName(toolName) && !shellStateDirWrite && !assetImportDest
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
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`);
}
