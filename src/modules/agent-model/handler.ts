// src/modules/agent-model/handler.ts
// The agent-model gate: agentModelGate walks spawn shape, run policy,
// reuse/replace, claims, and model enforcement. Deny builders and spawn
// parsing live in the sibling modules.

import { asString } from '../../adapters/coerce';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../shared/authoring-root';
import { readRegularFileResult } from '../../shared/bounded-read';
import { STATE_DIR, STATE_FILE } from '../../config/paths';
import { obj } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import {
  captureClaimDebug,
  ensureCurrentRunId,
  hookSessionIdentity,
  readEffectiveState,
} from '../../shared/state';
import { ensureRunnerShims } from '../../shared/runner-shims';
import { hasRunIdPlaceholder, strayRunIdInText, substituteRunIdPlaceholder } from '../../shared/run-id-paths';
import { pluginUseDeclined } from '../../shared/state/plugin-use';
import { inferTrafficOneSpawnRoleEvidence } from './role-infer';
import { resolveProjectRoot } from '../../shared/hook/paths';
import { modelCaptureCommand } from '../../shared/model-gate-command';
import {
  cursorRunPolicyMissingTiers,
  ensureRunModelPolicy,
  readRunModelPolicy,
  runModelPolicyPath,
} from '../../shared/run-model-policy';
import {
  ensureRunBootstrap,
  roleRequiresCompiledAssignment,
} from '../../shared/run-bootstrap-policy';
import { readRuntimeAssignments } from '../../shared/architecture-contract';

import {
  CURSOR_MODELS_CAPTURE_FALLBACK,
  block,
} from './handler-prose';
import { spawnBootstrapPlan } from './spawn-bootstrap';
import {
  absoluteTrafficOnePathDeny,
  absoluteTrafficOnePathsOutsideProject,
} from './spawn-hygiene';
import type { GateContext } from './gate-context';
import { openCodeFirstGates } from './gate-opencode-first';
import { reuseReplaceGates } from './gate-reuse';
import { modelEnforcementGates } from './gate-enforcement';

/**
 * THE RUN-ID DENY: it made four claims, three of them false, and the fourth is the
 * reason this refusal exists at all.
 *
 * It read, unconditionally: "`.traffic-one/.one.json` exists but could not be
 * parsed, so no run id could be resolved. Do NOT mint one or hand-write the file:
 * repair or restore .one.json (a backup may exist under `.traffic-one/backups/`)
 * and retry the spawn." This is a DENY an agent must act on, not an advisory it can
 * weigh, so every clause below is measured through this gate on mkdtemp fixtures
 * with controls, and pinned in __tests__/run-id-unresolved.test.ts.
 *
 * THE DIAGNOSIS WAS FALSE IN THREE REACHABLE STATES. `ensureCurrentRunId` returns
 * `''` for more than a torn pointer, and its caller announced the torn one every
 * time. DRIVEN: with `.one.json` a DIRECTORY the read never happens at all (EISDIR
 * — no bytes, so nothing "could not be parsed", and "repair its JSON" names JSON
 * that does not exist); with a DANGLING SYMLINK at that path — the shape
 * `__tests__/write-refusal.test.ts` calls what a hostile repo ships on clone — the
 * path resolves to nothing and the real cause is fsjson's fence refusing the
 * destination; and with the consent question unanswered the pointer PARSES and it is
 * the id's persist that was refused, which is a `materializationStampRefusedCause`
 * situation and not a repair. All three produced the byte-identical "could not be
 * parsed" sentence, and one of them told the agent to repair a file that is fine. So
 * the state is READ here, with the same bounded reader state/state-loss.ts uses,
 * and named as it is: absent, unparseable, unreadable-with-an-errno, or a pointer
 * that parses fine while the WRITE was refused.
 *
 * "DO NOT MINT ONE" IS TRUE AND STAYS, with its reason strengthened rather than
 * softened. A fabricated id splits the run — assignments under one id, claims,
 * digests and markers under another — which is the 11c/13c/14c incident this
 * function's fail-closed exit exists for (state/run-agent/run-paths.ts). And
 * "there is nothing to adopt either" is now a MEASURED clause, not a guess: with a
 * live spawn-gate ledger in `runs/` this deny is never reached (the gate adopts it
 * and the spawn proceeds to the architect-phase gate instead), so reaching this
 * sentence means `recentAdoptableRunId` already looked and found nothing.
 *
 * "OR HAND-WRITE THE FILE" IS THE ONE CLAUSE THAT HAD TO GO, and it is NARROWED
 * rather than deleted, because the act it was reaching for genuinely must stay
 * forbidden. Writing state you INVENTED is the defect; writing back the bytes git
 * already carries is the only route an agent has. state/state-loss.ts's
 * `recoveryClause` measured exactly that division for the absent and blank pointer,
 * and it was RE-MEASURED here for the torn one, through the real PreToolUse entry
 * points with controls: `git show HEAD:<pointer>` and `Write` to the pointer are
 * permitted, while `git restore .traffic-one`, `git checkout -- .traffic-one` and a
 * `Write` to `src/x.ts` in the same fixture are refused — so the exemption really is
 * path-shaped rather than this state being unfenced. Also DRIVEN: restoring the
 * committed bytes verbatim clears this deny, and the committed `currentRunId` is
 * ADOPTED rather than re-minted, so the restore cannot split the run it was accused
 * of splitting. An unqualified ban left a refused agent forbidden from the one act
 * that fixes its situation, which is how a deny becomes a retry loop.
 *
 * `backups/` IS GONE. Nothing writes a state pointer there: the only writer of that
 * directory is the gitnexus bootstrap, copying exactly `AGENTS.md`, `CLAUDE.md` and
 * `.claude/skills` (config/gitnexus.ts), and the directory is itself in the
 * generated `.gitignore` — measured in the same lane that corrected the identical
 * clause in shared/retention.ts's suspension notice. What replaces it is what is
 * really on disk: the quarantine sibling, named only when it is THERE (state/
 * normalize.ts writes `<pointer>.corrupt` from writeState's replacement path, so it
 * is absent in the ordinary torn-pointer state and never written for an unreadable
 * one), and git.
 *
 * THE THREE NOTICES ON THIS STATE NOW TELL ONE STORY. retention.ts's SUSPENDED
 * notice, state-loss.ts's STATE WAS RESET advisory and this deny differ only in the
 * state they fire in: the agent restores committed bytes verbatim and may not
 * invent them, and a directory-wide `git restore` is the user's move in their own
 * terminal.
 */
function runIdUnresolvedDeny(cwd: string): string {
  const pointer = `${STATE_DIR}/.one.json`;
  const file = path.join(cwd, STATE_FILE);
  const read = readRegularFileResult(file);
  const parses = read.kind === 'text' && (() => {
    try { return obj(JSON.parse(read.text)) !== null; } catch { return false; }
  })();
  // Named only when it is on disk. The quarantine is written by the state write
  // that REPLACES unparseable bytes, so the ordinary torn pointer has none.
  const quarantine = ((): string => {
    try {
      fs.lstatSync(`${file}.corrupt`);
      return ` The bytes that did not parse are preserved beside it at \`${pointer}.corrupt\` — nothing in the`
        + ' runtime reads that file, and a hand repair works from it.';
    } catch {
      return '';
    }
  })();
  // A SYMLINK at the pointer path reads as `absent` (the bounded open does not
  // follow it) while `lstat` still finds an entry — and a Write there is refused by
  // the fence for the link-ness alone, so "absent, go restore it" would send the
  // agent into a refusal. Asked separately for that reason.
  const link = ((): boolean => {
    try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
  })();
  const clearFirst = ' has to be cleared before a pointer can be written there, and that is a removal rather'
    + ' than a write. If that is refused for you, say so to the user instead of retrying.';
  const state = link
    ? `\`${pointer}\` is a SYMLINK: the state write fence refuses to write THROUGH one, and there is no pointer`
      + ` behind it to repair. The link${clearFirst}`
    : read.kind === 'absent'
      ? `\`${pointer}\` is not there at all.`
      : read.kind === 'unreadable'
        ? `nothing can be read at \`${pointer}\` (${read.errno}), so there are no JSON bytes there to repair.`
          + ` Whatever is at that path${clearFirst}`
        : parses
          ? `\`${pointer}\` parses, so the pointer is not what is wrong — the id could not be PERSISTED. A state`
            + ' write to that path was refused (an unanswered "use Traffic One here?" question, a symlink planted'
            + ' at the destination, or a path that leaves the state dir), and this gate will not hand back an id'
            + ' no later read would find. Nothing you can write fixes a refused write: report this to the user.'
          : `\`${pointer}\` is there and its bytes do not parse.${quarantine}`;
  // The restore is worth printing wherever a committed copy could land: not for a
  // pointer that already parses, where the fault is the write and not the bytes.
  const restore = parses
    ? ''
    : ` What you MAY do is put the COMMITTED pointer back VERBATIM: \`${pointer}\` is committed by design, so`
      + ` read HEAD's copy with \`git show HEAD:${pointer}\` (a read — permitted in this state) and write those`
      + ' exact bytes with Write or apply_patch, the one path the state write fence exempts. Change NOTHING in'
      + ' them: a `currentRunId` you typed is a fabricated id whatever file it lands in, and the committed one is'
      + ' adopted rather than re-minted. Restoring the state directory with git is refused for you even on a'
      + " healthy project — that is the user's route, in their own terminal. Then retry this spawn.";
  return `traffic-one — spawn blocked: no run id could be resolved, so a child would start under an id nothing`
    + ` on disk carries. ${state}`
    + ' Do NOT mint one and do NOT author state to get past this: a fabricated id splits the run — assignments'
    + ' under one id, claims, digests and markers under another — and strands every live child. There is nothing'
    + ` to adopt either; this gate already looked for a live run in \`${STATE_DIR}/runs/\` and found none.`
    + restore;
}

export function agentModelGate(ctx: Ctx): HookResult {
  if (pluginUseDeclined(ctx.cwd)) return noop();

  const raw = obj(ctx.input.raw) || {};
  const toolName = ctx.input.tool?.rawName || asString(raw.tool_name ?? raw.toolName);
  // Normalize a host namespace (Codex `multi_agent_v1.spawn_agent`) to the bare name
  // before matching, so the gate can't silently bail on a qualified spawn tool.
  if (toolName && !/^(Task|Agent|spawn_agent|run_subagent|spawn_subagent)$/i.test(stripToolNamespace(toolName))) return noop();

  const toolInput = obj(raw.tool_input) || obj(raw.toolInput) || {};
  const roleResolution = inferTrafficOneSpawnRoleEvidence(toolInput);
  const cwd = resolveProjectRoot(ctx.cwd, undefined, { ceiling: ctx.input.workspaceRoot });
  // The plugin's own repo / a generated tree is never an end-user project: no run
  // ids, no model policy, no spawn gating. Mirrors the write-guard stand-down.
  if (isNonProjectRoot(cwd)) return noop();
  const state = readEffectiveState(cwd, { ...process.env, TRAFFIC_ONE_HOST: ctx.host });
  if (!state || typeof state !== 'object') return noop();
  if (roleResolution.kind === 'conflict') {
    const runId = typeof state.currentRunId === 'string' ? state.currentRunId : null;
    const conflictCandidates = Array.from(new Map(
      roleResolution.candidates.map(({ role, source }) => [
        `${role}\u0000${source}`,
        { role, source },
      ]),
    ).values()).slice(0, 8);
    const candidateList = conflictCandidates
      .map(({ role, source }) => `\`${role}\` (${source})`)
      .join(', ');
    captureClaimDebug(cwd, runId, 'spawn-role-conflict', {
      host: ctx.host,
      candidates: conflictCandidates,
    });
    return deny(block('spawn-role-conflict', { CANDIDATES: candidateList },
      `Traffic One spawn identity gate: this spawn carries conflicting valid Traffic One role evidence in the same highest-priority tier: ${candidateList}. The spawn was blocked before a child started. Do not retry it unchanged and do not guess which role won. Correct or remove the stale identity field or marker so every valid item in that tier agrees on exactly one canonical role, then retry the same task. On Codex, keep one exact canonical task_name and ensure higher-tier agent_path/agent_type metadata, when present, names the same role.`),
      { denyId: 'spawn-role-conflict' });
  }
  if (roleResolution.kind !== 'evidence') return noop();
  const roleEvidence = roleResolution.evidence;
  const role = roleEvidence.role;

  // A backgrounded role spawn detaches the child from the orchestrator turn:
  // the parent's turn — and in a headless session the whole process — can end
  // while the child is still working, killing it mid-run with its claim staked
  // and nothing delivered (observed live: ep-new-feature run 1785662486571 —
  // the architect was spawned with run_in_background:true, the parent ended
  // its turn "while it completes", the headless session exited, and no plan
  // or code ever landed while the host reported success). Same contract as
  // the onboarding waiter's background deny: foreground only.
  if (toolInput.run_in_background === true) {
    return deny(
      `traffic-one — spawn blocked: role agents must run in the FOREGROUND of the orchestrator turn. Re-issue this exact \`${role}\` spawn WITHOUT \`run_in_background\` and wait for the child's result in this same turn — a backgrounded role agent is killed when the turn or session ends, leaving its run claim dangling and nothing delivered.`,
      { denyId: 'spawn-background-forbidden', denyTarget: role },
    );
  }

  // A role spawn is imminent → make sure the version-stable runner shims exist
  // BEFORE any subagent runs prose that references ~/.traffic-one/bin. This is
  // the reliable cross-host site: Codex executes PreToolUse but not the
  // SessionStart injection path. Idempotent, ~1ms when already current.
  ensureRunnerShims();

  // Run-id integrity at the spawn boundary. The run-id is `currentRunId` (a
  // gate-minted epoch-ms digit string). Models STILL fabricate a `date`/ISO id in the spawn
  // prompt despite the pre-mint + announce + prose (observed: composer-2.5 typing an
  // ISO timestamp it never read from `.one.json`). A wrong id splits run state —
  // assignments under one id, the gate's run-claims/OpenCode markers under another —
  // and strands digest handoffs (implementers READ a `digests/<id>/` path the write-
  // guard redirected elsewhere). Refuse a spawn whose prompt references ANY other
  // run-id, naming the correct one, so the orchestrator rebuilds the prompt. The
  // plan-write guard is the write-side backstop; this fixes the prompt's read/handoff
  // paths the write-guard can't reach.
  const spawnIdentity = hookSessionIdentity(raw);
  const stateRunId = typeof state.currentRunId === 'string' && state.currentRunId.trim()
    ? state.currentRunId.trim()
    : null;
  if (spawnIdentity.isSubagent && !stateRunId) {
    return deny(
      'traffic-one — spawn blocked: a child cannot mint the parent run id or model policy. '
      + 'The parent must start the run, acknowledge Performance, and freeze model-policy.json before spawning children.',
      { denyId: 'spawn-child-cannot-mint-run' },
    );
  }
  const spawnRunId = ensureCurrentRunId(cwd, state);
  // ensureCurrentRunId now fails closed rather than minting a sibling run over
  // an unreadable `.one.json` — a fabricated id strands every live child.
  if (!spawnRunId) {
    // The reason is derived from the pointer's actual state — see
    // runIdUnresolvedDeny: "could not be parsed" was announced for a directory and
    // a fenced write too, and named a `backups/` copy that never exists.
    return deny(runIdUnresolvedDeny(cwd), { denyId: 'spawn-run-id-unparseable' });
  }
  const configuredSubagentTeam = obj(state.team)?.mode === 'subagents';
  const existingRunPolicy = readRunModelPolicy(cwd, spawnRunId);
  if (!existingRunPolicy && fs.existsSync(runModelPolicyPath(cwd, spawnRunId))) {
    return deny(
      `traffic-one — spawn blocked: immutable model-policy.json is corrupt for run ${spawnRunId}. `
      + 'Do not reconstruct it from the current plan, One MCP cache, or project availableModels; start a repaired parent run.',
      { denyId: 'spawn-model-policy-corrupt', denyTarget: spawnRunId },
    );
  }
  if (existingRunPolicy && existingRunPolicy.host !== ctx.host) {
    return deny(
      `traffic-one — spawn blocked: run ${spawnRunId} is frozen for host ${existingRunPolicy.host}, `
      + `not ${ctx.host}. Start a new parent run for the active host; do not rebase model-policy.json.`,
      { denyId: 'spawn-model-policy-host-mismatch', denyTarget: spawnRunId },
    );
  }
  if (spawnIdentity.isSubagent && !existingRunPolicy) {
    return deny(
      `traffic-one — spawn blocked: a child cannot create or rebase immutable model-policy.json for run ${spawnRunId}. `
      + 'The parent must repair the run before spawning or retrying a child.',
      { denyId: 'spawn-child-cannot-create-policy', denyTarget: spawnRunId },
    );
  }
  const subagentTeam = configuredSubagentTeam || Boolean(existingRunPolicy);
  const cursorMissingTiers = configuredSubagentTeam && ctx.host === 'cursor' && !existingRunPolicy
    ? cursorRunPolicyMissingTiers(
      cwd,
      ctx.host,
      state,
      { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
    )
    : null;
  if (cursorMissingTiers?.length) {
    return deny(block('cursor-models-capture', {
      RUN_ID: spawnRunId,
      MISSING_TIERS: cursorMissingTiers.join(', '),
      CAPTURE_CMD: modelCaptureCommand(cwd, 'cursor'),
    }, CURSOR_MODELS_CAPTURE_FALLBACK), { denyId: 'cursor-models-capture', denyTarget: spawnRunId });
  }
  const runPolicy = existingRunPolicy
    || (configuredSubagentTeam
      ? ensureRunModelPolicy(
        cwd,
        spawnRunId,
        ctx.host,
        state,
        { ...process.env, TRAFFIC_ONE_HOST: ctx.host },
      )
      : null);
  if (subagentTeam && !runPolicy) {
    return deny(
      `traffic-one — spawn blocked: immutable model-policy.json is unavailable for run ${spawnRunId}. `
      + 'The parent must complete/acknowledge Performance and freeze the active host catalog before any child starts.',
      { denyId: 'spawn-model-policy-unavailable', denyTarget: spawnRunId },
    );
  }
  // The spawn's prompt across every host field — reused by the run-id guard here AND
  // the agent-reuse marker check below (single source of the field list).
  const spawnPromptFields = ['prompt', 'message', 'task', 'description'] as const;
  const spawnPromptText = spawnPromptFields.map((field) => toolInput[field])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const badTrafficOnePaths = absoluteTrafficOnePathsOutsideProject(spawnPromptText, cwd);
  if (badTrafficOnePaths.length > 0) {
    return absoluteTrafficOnePathDeny(badTrafficOnePaths, cwd);
  }
  // Placeholder-tolerant run-id check: the orchestrator templates ship
  // `runs/<run-id>/…` paths with the literal `<run-id>` placeholder, and a
  // template-faithful prompt must not be denied for it (observed 6c: the FIRST
  // architect spawn of the run died on the placeholder as "Couldn't start").
  // Normalize the placeholder to the current run id in the CHECKED text only —
  // a genuinely fabricated id (`date`/ISO, foreign epoch) still denies, and the
  // plan-gate WRITE guard still rejects literal `<run-id>` write paths.
  const strayRunId = strayRunIdInText(substituteRunIdPlaceholder(spawnPromptText, spawnRunId), spawnRunId);
  if (strayRunId) {
    // SELF-HEALING deny: hand back the spawn prompt with the run-id ALREADY corrected so a weak
    // orchestrator can copy-paste it verbatim, instead of being told to "rebuild" it (composer-2.5
    // read "rebuild the prompt" as an impossible task and fell back to an inline single-model build
    // — observed in 21b). Loop the detector so a SECOND fabricated id can't survive into the echoed
    // prompt and re-deny the retry. Echo only when the prompt is paste-sized; otherwise give the
    // exact substitution. This deny has NO once-marker — it is self-correcting, so it can fire as
    // many times as needed without tripping the no-deadlock budget.
    let fixed = substituteRunIdPlaceholder(spawnPromptText, spawnRunId);
    for (let i = 0; i < 8; i++) {
      const s = strayRunIdInText(fixed, spawnRunId);
      if (!s) break;
      fixed = fixed.split(s).join(spawnRunId);
    }
    const action = fixed.length <= 2000
      ? `RE-ISSUE THE SAME Task spawn — same subagent_type, same model — with this exact prompt (run-id already corrected), copied VERBATIM:\n----\n${fixed}\n----`
      : `RE-ISSUE THE SAME Task spawn — same subagent_type, same model — after replacing EVERY \`${strayRunId}\` with \`${spawnRunId}\` in your prompt (it appears in the "Run ID:" line and the \`.traffic-one/runs/\` and \`digests/\` paths).`;
    return deny(`traffic-one — run-id gate: your spawn prompt used run-id \`${strayRunId}\`, but the ONLY valid run-id is \`currentRunId\` = \`${spawnRunId}\` (read from .traffic-one/.one.json — never \`date\`/ISO/UTC). ${action}`,
      { denyId: 'spawn-run-id-mismatch', denyTarget: spawnRunId });
  }

  // Claude can rewrite a tool call's input from PreToolUse (updatedInput — a
  // FULL tool_input replacement), so when the allowed prompt still carries the
  // literal `<run-id>` placeholder, hand the child fully substituted paths
  // instead of leaving it the placeholder to resolve. Other hosts can only
  // allow/deny; there the child resolves `<run-id>` itself (Run ID header +
  // .one.json), with the plan-gate write guard as the backstop. Every ALLOW
  // exit below this point must flow through allowSpawn().
  const placeholderPromptFields = ctx.host === 'claude' && spawnRunId
    ? spawnPromptFields.filter((field) => typeof toolInput[field] === 'string'
      && hasRunIdPlaceholder(toolInput[field]))
    : [];
  const allowSpawn = (result: HookResult): HookResult => {
    if (result.kind === 'deny') return result;
    const updatedToolInput: Record<string, unknown> = { ...toolInput };
    for (const field of placeholderPromptFields) {
      updatedToolInput[field] = substituteRunIdPlaceholder(toolInput[field] as string, spawnRunId);
    }
    let changed = placeholderPromptFields.length > 0;
    if (subagentTeam && runPolicy) {
      // ONE derivation of the publish inputs, shared with the reuse gate's
      // quick-fix scope regrant (spawn-bootstrap.ts) — every field feeds the
      // envelope hash, so two derivations would publish two envelopes for one
      // spawn.
      const plan = spawnBootstrapPlan({
        ctx,
        cwd,
        toolInput,
        role,
        evidenceSource: roleEvidence.source,
        runId: spawnRunId,
        modelPolicyId: runPolicy.policyId,
        spawnPromptText,
      });
      if (plan.kind === 'capability-missing') {
        return deny(
          `traffic-one — spawn blocked: per-run host capability evidence is missing or corrupt for ${ctx.host}. `
          + 'No child was started. Repair the parent run and retry.',
          { denyId: 'spawn-host-capability-missing', denyTarget: spawnRunId },
        );
      }
      const boundedMaintenanceOutputs = plan.boundedScope;
      const envelope = ensureRunBootstrap(cwd, spawnRunId, role, state, plan.options);
      if (!envelope) {
        // Since PLAN_READY may now be accepted with a capability role the
        // compiled contract assigns nothing (roleSkippableWithoutAssignment),
        // spawning that role reaches this branch — and the generic "repair and
        // retry" remedy can never succeed there, so a literal-minded
        // orchestrator retried forever. Name the real cause and the real exit.
        const publishedAssignments = readRuntimeAssignments(cwd, spawnRunId);
        if (roleRequiresCompiledAssignment(role)
          && publishedAssignments
          && !publishedAssignments.assignments.some((entry) => entry.role === role)) {
          return deny(
            `traffic-one — spawn blocked: \`${role}\` has NO compiled assignment in run ${spawnRunId} — the plan gives this role nothing to build, so it is not part of this run. Do not spawn or retry it; proceed with the assigned roles (${publishedAssignments.assignments.map((entry) => entry.role).join(', ') || 'none'}). If this role genuinely has work, replan: change ArchitectureInputV1 so runtime compiles an assignment for it.`,
            { denyId: 'spawn-role-no-compiled-assignment', denyTarget: role },
          );
        }
        // A bounded-capable maintenance role spawned with NO scope in a run
        // that has no compiled assignments: the envelope is unfulfillable by
        // construction, so "repair and retry" loops forever. Observed live
        // (ep-text-edit e2e, run 1785661319400): headless sessions get no
        // UserPromptSubmit, so the parent never saw the triage directive's
        // spawn recipe, sent bare quick-fix spawns, burned six denies, and
        // silently gave up. Name the exact fix so the flow self-heals.
        if (!boundedMaintenanceOutputs
          && !publishedAssignments
          && ['quick-fix', 'senior-frontend', 'senior-backend'].includes(role)) {
          return deny(
            `traffic-one — spawn blocked: \`${role}\` needs a parent-supplied bounded maintenance scope, and this spawn carried none (run ${spawnRunId} has no compiled assignments to scope it from). Re-send the SAME spawn and include the exact files this task may create or modify: either the structured \`allowedFiles\` field, or ONE line in the prompt of the form [t1-bounded-scope: {"outputs": ["src/App.tsx"]}] listing every exact repo-relative file path (globs and directories are rejected). The runtime publishes the bounded WorkUnitContract from that scope; without it no maintenance write can be authorized. Do not retry without adding the scope.`,
            { denyId: 'spawn-bounded-scope-missing', denyTarget: role },
          );
        }
        return deny(
          `traffic-one — spawn blocked: parent could not resolve and atomically publish the role/rule/skill bootstrap `
          + `for ${role} in run ${spawnRunId}. No child was started. Repair the parent materialization/policy and retry.`,
          { denyId: 'spawn-bootstrap-publish-failed', denyTarget: role },
        );
      }
      // The immutable envelope is the bootstrap transport shared by all hosts.
      // Host-specific prompt/agent renderers already inject the role contract;
      // returning updated tool input here would turn an otherwise plain allow
      // into a host-dependent context result and is not supported uniformly.
    }
    if (!changed) return result;
    return result.kind === 'context'
      ? { ...result, updatedToolInput }
      : context('', { updatedToolInput });
  };

  const gateCtx: GateContext = {
    ctx, cwd, state, raw, toolName, toolInput, role, roleEvidence,
    spawnRunId, runPolicy, subagentTeam, spawnPromptText, allowSpawn,
  };
  const openCodeFirst = openCodeFirstGates(gateCtx);
  if (openCodeFirst) return openCodeFirst;
  const reuse = reuseReplaceGates(gateCtx);
  if (reuse) return reuse;
  return modelEnforcementGates(gateCtx);
}

export { CURSOR_MODELS_CAPTURE_FALLBACK } from './handler-prose';
