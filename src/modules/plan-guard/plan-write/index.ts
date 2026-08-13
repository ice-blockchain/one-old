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
import { hostFlags } from '../../../shared/host/capability-flags';
import { pluginUseDeclined } from '../../../shared/state/plugin-use';
import { modelChoiceReplyPending } from '../../agent-model/model-choice';
import {
  BUILD_ARTIFACT_RE,
  commandAppearsToWriteBuildArtifact,
  commandAppearsToWriteExternalTemp,
  commandAppearsToWriteFeatureSource,
  FEATURE_SOURCE_RE,
  heredocBodies,
  shellAssetImportDest,
  shellStrayDeleteTarget,
  shellTrafficOneWriteTargets,
  shellWriteTargetsStateDir,
} from '../../../shared/feature-source';
import { parseApplyPatch, patchTextFromToolInput } from '../../../shared/apply-patch';
import { projectRelativeHookPath } from '../../../shared/hook/paths';
import { materializeProjectIfNeeded } from '../../../shared/materialize';
import { pluginRoot } from '../../../shared/paths';
import { makeSkillBlock } from '../../../shared/skill-block';
import { activeAgentRole, explainUnresolvedRunAgent, hookSessionIdentity, isNativeState, isNewProjectMode, readEffectiveState, readState, resolveRunAgentContext, roleForRunSessionId } from '../../../shared/state';
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
import { openCodeReservedFilesViolation, runTeamEnforcementViolation } from '../plan-runteam';
import {
  assetExtensionMismatchViolations, planStaticViolations, makePlanBlock, type Vars,
} from '../plan-static';
import { resolveToolScope, workspaceMemberRefusal } from '../../../shared/tool-scope';
import { isDenyId, type DenyId } from '../../../config/deny-ids';

import { shellResetRecordDestruction } from './reset-record-shell';
import { shellRuntimeSidecarDestruction } from './sidecar-shell';
import {
  appendUnique,
  commandAppearsToWriteCompiledFeature,
  isCompiledFeatureTarget,
  ownString,
  patchTargets,
  reconstructTextEdit,
  type GateTarget,
} from './targets';

const rawBlock = makePlanBlock(makeSkillBlock(pluginRoot));

// This single aggregator deny (bottom of planWriteGate) can be reached through
// ~50 distinct block() call sites spread across plan-static/plan-readiness/
// plan-runteam/plan-runid, each already naming its own cause. Rather than
// invent one parallel id for the whole aggregator (which would collapse every
// distinct cause into one budget bucket — exactly what a declared id exists to
// avoid), mine the id from whichever registered block actually fired FIRST.
// `run-team-suffix` is a decorative fragment glued onto a DIFFERENT violation's
// text (see plan-runteam.ts), never itself a violation, so it is deliberately
// skipped rather than recorded.
//
// The accumulator is PER INVOCATION and must stay that way: it was module
// scope once, latched by a `!firstFired` guard that nothing reset, so in any
// process that dispatches more than one hook (the replay corpus, test:env,
// doctor's run reconstruction) every plan-write deny after the first reported
// whichever cause fired first — ~50 distinct causes collapsing onto one id,
// and a later allow-at-N budget keyed on `denyId` would then unblock all of
// them at once after spending one bucket on an unrelated violation. One-shot
// hook processes hid it. Created fresh here, per call, so the identity is a
// function of THIS write and never of call ordering.
//
// The three parameters are ANNOTATED, redundantly, and that redundancy is the
// point. plan-guard's `Block` is the one wrapper in the repo whose argument
// order is `(name, fallback, vars)` while every other is `(name, vars,
// fallback)`, and correcting it means swapping arguments 2 and 3 at ~100 call
// sites. The compiler reports 99 of them. It cannot report THIS one: with the
// parameters unannotated they are contextually typed from `Block`, so after the
// swap #2 is a `Vars` still NAMED `fallback` and #3 a `string` still named
// `vars` — and because the body forwards them positionally, in the same order,
// the result is type-correct AND runtime-correct. Only the identifiers become
// lies, silently, forever. Writing the types out makes the same swap a
// parameter-type mismatch here like everywhere else. Do not "clean up" these
// annotations; deleting them is what re-opens the hole.
function makeViolationBlock(fired: { denyId: DenyId | null }): typeof rawBlock {
  return (name: string, fallback: string, vars?: Vars) => {
    if (!fired.denyId && name !== 'run-team-suffix' && isDenyId(name)) fired.denyId = name;
    return rawBlock(name, fallback, vars);
  };
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
  // Ahead of the patch parse: a workspace container has no plan, no compiled
  // architecture and no run team, so there is nothing for the reconstruction
  // below to be validated against even when the envelope is perfect.
  const unresolvedMember = workspaceMemberRefusal(toolScope);
  if (unresolvedMember) {
    return deny(unresolvedMember.reason,
      { denyId: unresolvedMember.denyId, denyTarget: unresolvedMember.denyTarget });
  }

  const structuralPatch = isApplyPatch ? parseApplyPatch(rawPatchText) : null;
  if (structuralPatch && !structuralPatch.ok) {
    return deny(`traffic-one — invalid apply_patch payload: ${structuralPatch.error}. No write was made.`,
      { denyId: 'apply-patch-payload-invalid', denyTarget: rawFilePath || undefined });
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
    // A DIFFERENT cause from the structural failure above, and the remedy the
    // agent has to act on differs too: the envelope parsed, so the syntax is
    // fine — this is the patch's context not matching what is on disk under
    // `patchBase` ("re-read the file and rebuild the hunks"), not "fix the
    // patch syntax". One id per cause, so the budget can bound a drifting
    // agent's re-reads without also spending the malformed-envelope bucket.
    return deny(`traffic-one — invalid apply_patch payload: ${reconstructedPatch.error}. No write was made.`,
      { denyId: 'apply-patch-reconstruction-failed', denyTarget: firstPatchTarget || rawFilePath || undefined });
  }

  // Preflight convergence: ensure .traffic-one/** is current for this project
  // before we judge it (side-effect only; the outcome is intentionally ignored).
  // `materializeProjectIfNeeded` runs the legacy-plan migration itself, behind
  // the stateless-sub-package refusal that must precede it; calling the migration
  // again here only did the same walk twice and did it unguarded.
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
        { denyId: 'plan-write-struct-scan-incomplete', denyTarget: directFilePath },
      );
    }
    directResultContent = reconstruction.resultContent;
    directAddedContent = reconstruction.addedContent;
  }

  if (hostFlags(ctx.host).modelChoiceNeedsUserReply && state && modelChoiceReplyPending(projectRoot, state as Rec)) {
    return deny(
      'traffic-one — model choice required (build paused): reply `fallback` to proceed on the listed fallback model(s), '
      + 'or `enable` to turn on the picked model(s), re-capture Cursor models, and retry. '
      + 'Do not spawn subagents, scaffold directly, or edit project files until the user replies.',
      { denyId: 'plan-write-model-choice-pending' },
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
    const shellBody = heredocBodies(rawCommand);
    // Sidecars a command destroys without naming one — a directory-scoped `rm`,
    // `find … -delete`, an inline interpreter unlink, `git clean`. Added FIRST so
    // the refusal names the runtime artifact rather than whichever sibling path
    // the command happened to mention (see plan-write/sidecar-shell.ts).
    for (const sidecar of shellRuntimeSidecarDestruction(
      rawCommand, patchBase, projectRoot, shellBody, 2, currentRunId,
    )) {
      if (gateTargets.some((target) => target.filePath === sidecar)) continue;
      gateTargets.push({
        filePath: sidecar,
        resultContent: '',
        addedContent: '',
        staticCheck: false,
      });
    }
    // The reset record, which neither scan above can see: the sidecar
    // enumeration is filtered to `runs/<id>/<entry>` paths, and
    // `shellTrafficOneWriteTargets` only looks once
    // `shellCommandHasWritePrimitive` has recognised a mutation — a fail-OPEN
    // question that admitted `bash -c 'rm -f …'`, `install /dev/null …`, an
    // interpreter heredoc and `perl -pi -e` on this path, measured, with a live
    // run pointer in place. Its own scan asks the opposite question and is
    // therefore not downstream of either (see reset-record-shell.ts).
    for (const record of shellResetRecordDestruction(rawCommand, patchBase, projectRoot, shellBody)) {
      if (gateTargets.some((target) => target.filePath === record)) continue;
      gateTargets.push({
        filePath: record,
        resultContent: '',
        addedContent: '',
        staticCheck: false,
      });
    }
    for (const shellTarget of shellTrafficOneWriteTargets(rawCommand)) {
      const relative = projectRelativeHookPath(patchBase, projectRoot, shellTarget);
      if (!relative || gateTargets.some((target) => target.filePath === relative)) continue;
      gateTargets.push({
        filePath: relative,
        resultContent: '',
        addedContent: '',
        staticCheck: false,
        ...(shellBody ? { shellBody } : {}),
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

  // Per-invocation violation identity (see makeViolationBlock): every gate
  // below resolves its prose through this `block`, so the FIRST registered
  // cause to fire during THIS call is the one the aggregator deny reports.
  const firstFiredViolation: { denyId: DenyId | null } = { denyId: null };
  const block = makeViolationBlock(firstFiredViolation);

  const violations: string[] = [];
  // Which targets actually OFFENDED. The refusal's subject used to be
  // `filePath` — the direct target, else `gateTargets[0]`, the patch's FIRST
  // operation — so on a multi-file apply_patch the deny named whichever file the
  // agent happened to write first, which had usually violated nothing. Two
  // readers depend on that subject: `runs/<id>/debug/decisions.jsonl` (stamped
  // by core/pipeline.ts), where it is the only record of WHICH file was refused,
  // and the repeat counter, which signs a refusal as `denyTarget` plus the whole
  // rendered reason (shared/state/deny-repeat.ts). Measured on a 3-op patch
  // whose first operation stayed constant while the agent cleared the offenders
  // one at a time: three refusals with an identical path-free reason and an
  // identical first op collapsed into ONE bucket and escalated on the third —
  // an agent making real progress told to STOP RETRYING about a file it had
  // already fixed. Naming the offender splits that into three counts of one,
  // while the identical patch drawn three times still reaches the threshold.
  //
  // Only the per-target rules can attribute: readiness, the state-mode
  // downgrade guard and the static family each judge ONE target per iteration,
  // so the target whose iteration grew `violations` is the one to name. The
  // rest — run-team ownership, OpenCode reservations, run-id paths, the
  // registry probe, model choice — judge the write or the command as a whole
  // and have no offending target to offer, so those keep today's subject.
  const offendingTargets = new Set<string>();
  // `appendUnique` dedupes, so a later target whose lines an earlier one
  // already rendered is not recorded. That never moves the answer: the earlier
  // target offended too and is resolved first.
  const noteOffender = (target: string, before: number): void => {
    if (target && violations.length > before) offendingTargets.add(target);
  };
  const readinessTargets = gateTargets.length > 0
    ? gateTargets
    : [{
      filePath,
      resultContent: directResultContent,
      addedContent: directAddedContent,
      staticCheck: true,
    }];
  for (const target of readinessTargets) {
    const before = violations.length;
    appendUnique(violations, planReadinessViolations({
      filePath: target.filePath,
      content: target.resultContent,
      addedContent: target.addedContent,
      // Shell-derived targets (staticCheck false) carry no reconstructable
      // payload; content-shape gates must judge the on-disk artifact, not ''.
      contentVerified: target.staticCheck,
      projectRoot,
      state,
      writingFeatureSource: isFeatureTarget(target.filePath)
        || (gateTargets.length === 0 && writingFeatureSourceViaCommand),
      shellBody: target.shellBody,
      host: ctx.host,
      rawData: raw,
      block,
    }));
    noteOffender(target.filePath, before);
  }
  if (hostFlags(ctx.host).opencodeSelfHosted && writingExternalTempViaCommand) {
    violations.push(block('opencode-external-temp-shell',
      'OpenCode/Kilo external-path gate: do not write scratch logs or build output under `/tmp`, `/private/tmp`, or `/var/tmp` from a model command. Those paths trigger host external-directory permission prompts and can stall the run. Write temporary diagnostics inside the project, for example `.traffic-one/tmp/<runId>/`, or print the output to stdout.'));
  }
  // Mode-downgrade guard: mode is set at onboarding, and the architecture-gate
  // family stands down on every mode that is not `new-project` — so a CONFIRMED
  // new-project state flipping its own mode mid-run disarms the stack, layout
  // and structure gates in one write. Deny the transition on the
  // content-verified write channels; onboarding and runtime state writes do
  // not pass through this gate, and creating/repairing an UNCONFIRMED state
  // (what the state-gate prose instructs) stays allowed.
  //
  // The condition is DEPARTURE from `new-project`, not arrival at `existing*`.
  // Testing the destination named one of the ways out and left the rest open:
  // `{"mode": ""}`, an omitted `mode`, `"workspace"` — none of them was refused,
  // while the run's architecture and verification contracts stayed frozen
  // against the profile the old mode selected.
  //
  // The three are not the same defect, and the deny prose says so. `"workspace"`
  // — any UNRECOGNIZED value — stands the gates down exactly as
  // `existing-codebase` does and stays that way. An empty, absent or null mode
  // SELF-HEALS: `normalizeState` defaults a non-string/blank mode back to
  // `new-project`, so the next materialization pass repairs the file and the
  // gates re-arm. What it costs is still worth refusing — the value is
  // undeclared until that pass runs, and every gate that reads the state
  // in between reads a mode this project never chose — but the reason is a
  // window, not a permanent stand-down, and a deny that overstates its own cause
  // teaches the reader to discount the next one.
  const STATE_FILE_REL = '.traffic-one/.one.json';
  for (const target of gateTargets) {
    if (target.filePath !== STATE_FILE_REL || !target.staticCheck) continue;
    const rawOnDisk = readState(projectRoot);
    // Through the predicate at BOTH ends. On disk, because a hand-edited
    // ` New-Project ` is a scaffolded project to every gate that reads it and
    // must therefore be one to the guard that protects them; and on the
    // proposal, because the two sides have to agree on what the mode is before
    // they can agree that it changed.
    if (!isNewProjectMode(rawOnDisk)
      || (rawOnDisk.confirmed !== true && rawOnDisk.onboardingComplete !== true)) continue;
    let proposed: Record<string, unknown>;
    try {
      proposed = JSON.parse(target.resultContent) as Record<string, unknown>;
    } catch {
      continue; // not parseable JSON — other validation owns corrupt writes
    }
    if (!isNewProjectMode(proposed)) {
      violations.push(block('state-mode-downgrade',
        'State mode gate: this project was onboarded as `new-project`; rewriting `.traffic-one/.one.json` to any other mode mid-run would disarm the architecture gates that mode selects. An UNRECOGNIZED `mode` counts — `workspace`, `brownfield`, anything the mode table does not name stands the same gates down as `existing-codebase` while the run\'s compiled architecture and verification contracts stay frozen against the old profile. An empty, absent or null `mode` is refused for a different reason: state normalization repairs it back to `new-project` on the next materialization pass, so the write does not survive as written and any gate reading the file before that pass reads a mode this project never declared. Mode changes go through onboarding, not a state-file edit. If the user explicitly wants this project treated as an existing codebase, re-run Traffic One onboarding.'));
      offendingTargets.add(target.filePath);
      break;
    }
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
  if (isNewProjectMode(state)
    && /(?:^|[\s;&|(])(?:(?:npm|pnpm)\s+(?:view|show|info|v)\b|yarn\s+info\b|(?:npm|pnpm|yarn|bun)\s+outdated\b)/.test(rawCommand)) {
    violations.push(block('registry-probe-gate',
      'Registry probe gate: do not query the npm registry (`npm view`/`show`/`info`/`outdated`, `pnpm view`, `yarn info`) to pick scaffold or dependency versions during new-project setup. Versions come from the active stack contract — install with the pinned ranges (`pnpm add <pkg>` resolves the latest matching minor/patch). Only an explicit user request for a newer major overrides a pin, recorded as an ADR in `.traffic-one/decisions/`.'));
  }
  // Live OpenCode reservations: a verifiably RUNNING delegated unit's
  // allowedFiles are off-limits to every paid writer (serial mode included).
  // Feature + build-artifact targets only — state-dir writes (digests,
  // fix-cycle notes) stay free, and a stale ledger never denies.
  const reservation = openCodeReservedFilesViolation({
    projectRoot,
    state,
    targets: runTeamTargetPaths,
    block,
  });
  if (reservation) violations.push(reservation);
  // Not-scaffolded stand-down: the static checks enforce the prescribed
  // stack/layout (Tailwind-only styling, component placement, named exports,
  // …) and a repository Traffic One did not create keeps its own conventions
  // (observed: an existing vanilla-extract repo was denied its own `.css.ts`
  // styling). Only the file-integrity asset check survives; everything else —
  // readiness, run-id, run-team ownership, reservations — applies in every mode.
  //
  // `!isNewProjectMode`, not `isExistingProjectMode`: an UNDECLARED mode is a
  // repository Traffic One did not create either, and it was receiving the
  // whole prescribed-stack opinion derived from `defaultStateForStack` — a
  // guess. The satisfiability sweep's `existingMode` mirrors this exact
  // predicate (plan-readiness/satisfiability.ts) and has to, or the compiled
  // contract is checked against gates that are not the ones that will run.
  //
  // JUDGED HERE, RENDERED BELOW, and the split is the whole of the fix. The
  // run-team gate is the only violation source in this dispatcher that WRITES:
  // its fallback branch stakes a first-write claim on the target, which locks
  // that path to this session for the rest of the run. It may therefore only do
  // so for a write that is actually going to be allowed — and until this moved,
  // `recordFallbackClaims` was decided at a point where the fourteen static
  // rules had not run yet. MEASURED on a materialized monorepo, a live
  // `senior-frontend` writing `packages/ui/src/lib/format.ts` (outside every
  // assignment, so the fallback branch is the one that answers) with `: any` in
  // the content: the write was refused for `no-any` — the SOLE violation — and
  // `runs/<id>/claims/packages_ui_src_lib_format.ts.json` was staked anyway.
  const staticTargets = gateTargets.filter((candidate) => candidate.staticCheck);
  // A SEPARATE accumulator, so judging early does not also report early. The
  // aggregator names the first registered cause to fire, and moving the static
  // family ahead of the run-team gate would otherwise re-label every deny where
  // both fire. Its identity is registered below, at the position it used to
  // fire in.
  //
  // THAT RESTORES THE IDENTITY, NOT THE WHOLE RENDER, and the difference is
  // where this paragraph was wrong before. "Byte-identical for every input, the
  // staked claim the only thing that moved" was true of the re-ordering and
  // FALSE of the change as a whole, because the flag below gated the entire
  // fallback-claim call — a function that both RECORDS a claim and CHECKS
  // whether somebody else holds one. Suppressing it on a doomed write therefore
  // suppressed the ownership-conflict deny too: measured, a path already held by
  // one child and written by another with a static violation denied with one
  // bullet naming the static rule where the old ordering gave two and named the
  // conflict, while the same fixture with clean content reported the conflict in
  // both builds. The author fixed the static rule, retried, and only then
  // learned the path belonged to another role — and because deny-repeat.ts signs
  // a refusal with the whole rendered reason, the two denies escalated in
  // different buckets.
  //
  // The flag now suppresses only the RECORD (plan-runteam.ts threads it through
  // as `record: false`, and through the scope-attribution mint as
  // `mint: false`), so every check runs on a doomed write and the render is
  // byte-identical again — for both mints, the thing that moves is what is
  // written, not what is said.
  const staticFired: { denyId: DenyId | null } = { denyId: null };
  const staticBlock = makeViolationBlock(staticFired);
  const staticViolationsFor = !isNewProjectMode(state)
    ? (target: GateTarget) => assetExtensionMismatchViolations(target.filePath, target.addedContent, staticBlock)
    : (target: GateTarget) => planStaticViolations(target.filePath, target.addedContent, isNative, staticBlock);
  const staticFindings = staticTargets.map((target) => staticViolationsFor(target));
  const recordFallbackClaims = violations.length === 0
    && staticFindings.every((found) => found.length === 0);
  const runTeam = runTeamEnforcementViolation({
    host: ctx.host,
    projectRoot,
    // The workspace MEMBER this write anchored to, '' outside a workspace. The
    // fence above has already refused every call that could not name exactly
    // one, so a non-empty value here is always the member that owns every
    // target — which is precisely what makes it usable as an attribution guard.
    workspaceMember: toolScope.workspace.kind === 'member' ? toolScope.workspace.member : '',
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
  // The static family's identity, registered at the position it was judged in
  // before the move above — after every earlier cause has had its chance.
  if (!firstFiredViolation.denyId) firstFiredViolation.denyId = staticFired.denyId;
  // Every static rule names itself and none of them names the FILE — the 14
  // block() call sites in plan-static.ts all have `filePath` in scope and pass
  // it to none of their prose. On a one-file Write that costs nothing (the
  // agent knows what it just wrote, and `denyTarget` carries it), but a
  // multi-file apply_patch is judged per operation and `appendUnique` dedupes
  // identical lines: an `any` in the seventh file of a ten-file patch rendered
  // the byte-identical text an `any` in the first file did, so the whole family
  // collapsed to one render per rule no matter which file tripped it. The
  // aggregator's own `denyTarget` names an offending target now (see
  // `offendingTargets` above), but it names exactly ONE of them, so it can
  // never stand in for the per-line naming a multi-file patch needs.
  //
  // That collapse also reaches the repeat counter, which signs a refusal as
  // `denyTarget` plus the whole rendered reason (shared/state/deny-repeat.ts):
  // two patches tripping the same rule in DIFFERENT files shared one signature
  // and one escalation bucket, so an agent clearing them file by file — real
  // progress — was counted as looping. Naming the target splits those counts
  // back apart.
  //
  // Only when more than one file is being judged, so every single-target render
  // stays byte-identical to today's.
  const nameStaticTarget = staticTargets.length > 1;
  for (let index = 0; index < staticTargets.length; index += 1) {
    const target = staticTargets[index]!;
    const before = violations.length;
    const found = staticFindings[index]!;
    appendUnique(violations, nameStaticTarget ? found.map((violation) => `${target.filePath}: ${violation}`) : found);
    noteOffender(target.filePath, before);
  }

  if (violations.length === 0) return noop();
  // First in OPERATION order, not in the order the gates happened to run: which
  // rule noticed is an implementation detail of this dispatcher, while the
  // patch's own ordering is what the agent wrote and what the reason lists.
  // Falls back to `filePath` — today's subject — when nothing per-target
  // offended, which is the honest answer for a cause that has no target.
  const denyTarget = readinessTargets
    .find((target) => offendingTargets.has(target.filePath))?.filePath || filePath;
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
  const effectiveRole = activeAgentRole(state) || resolvedRole;
  capturePlanGuardDebug(projectRoot, runId, {
    filePath,
    filePaths: writeTargetPaths,
    host: ctx.host,
    sessionId: denyIdentity.sessionId || null,
    // Per-AGENT attribution. `sessionId` is the ORCHESTRATOR's for every child
    // on Codex and on Claude agent-teams, so all 13 denies of one run carried
    // the same id together with `isSubagent: true` and a subagent role — the
    // violation history of an individual agent across a fix cycle could not be
    // reconstructed. The child's own keys are the host agent id (which
    // claim-capture already records as `raw.agent_id`) and, on Codex where
    // there is no agent id, the transcript-derived thread id. Record both, plus
    // the claim the gates themselves resolved.
    agentId: denyIdentity.agentId || null,
    threadId: denyIdentity.threadId || null,
    ...(resolvedContext?.claimId ? { claimId: resolvedContext.claimId } : {}),
    isSubagent: denyIdentity.isSubagent || Boolean(resolvedRole),
    role: effectiveRole,
    // WHY nothing resolved, not just that nothing did. A bare `role: null`
    // forced transcript archaeology to tell "this child spawned before its
    // claim was staked" from "the run's ledger is closed so no claim can ever
    // exist" — the same log line for a transient race and a permanent deadlock.
    ...(effectiveRole ? {} : { unresolved: explainUnresolvedRunAgent(projectRoot, state, raw) }),
    violations: violations.map((v) => (v.length > 400 ? `${v.slice(0, 400)}…` : v)),
  });
  // An unchanged retry draws this exact message again — forever, with nothing
  // counting (measured in 17cl: 15 of 25 denies were repeats of four (file,
  // reason) pairs, one refused seven times over 25 minutes before a replan
  // resolved a one-line fix the text had already named). This gate used to count
  // that itself and append the escalation here; core/pipeline.ts's deny exit now
  // does it for EVERY gate, keyed on this whole rendered reason plus `denyTarget`
  // — which is strictly more discriminating than the (filePath, violations) key
  // that lived here, and no longer something the other ~120 gates have to
  // remember. Nothing about the text below changed; the paragraph is appended to
  // it on the way out.
  //
  // The trailing line prevents a real recovery failure: after a deny on a NEW
  // file the agent assumed partial content existed and issued Edit calls
  // against it ("File does not exist" ×2, observed 5cl-claude on plan.md).
  return deny(`traffic-one — plan gate violation(s):\n${violations.map((v) => `  - ${v}`).join('\n')}\nNo write was applied — the denied Write/Edit/apply_patch left the target file(s) unchanged on disk. Fix the violation(s) and re-issue the FULL corrected write; do not Edit content that was never written.`,
    { denyId: firstFiredViolation.denyId ?? 'plan-write-violation-unattributed', denyTarget: denyTarget || undefined });
}
