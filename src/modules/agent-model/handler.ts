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
import { stateWritePermitted } from '../../shared/fsjson';
import { runHostCapabilityPath } from '../../shared/host/capabilities';
import { resetRecoveryLine } from '../../shared/reset-command';
import { obj, type Rec } from '../../shared/obj';
import { context, deny, noop } from '../../core/result';
import { stripToolNamespace } from '../../core/events';
import type { Ctx, HookResult } from '../../core/types';
import {
  captureClaimDebug,
  ensureCurrentRunId,
  hookSessionIdentity,
  readEffectiveState,
  runLedgerStatusRecord,
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
  RUN_MODEL_POLICY_SCHEMA_VERSION,
} from '../../shared/run-model-policy';
import {
  activeRunBootstrapPath,
  ensureRunBootstrap,
  roleRequiresCompiledAssignment,
} from '../../shared/run-bootstrap-policy';
import { readCompiledArchitecture, readRuntimeAssignments } from '../../shared/architecture-contract';

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

/**
 * The path as the AGENT will read it, derived from the path the runtime actually
 * opens rather than from a template over the run id. `safeRunId` rewrites every
 * character outside `[A-Za-z0-9._-]` and clips at 160, so a hand-edited
 * `currentRunId` makes a `runs/${runId}/…` template name a file that is NOT the
 * one being judged — and a deny whose whole remedy is "that ONE file" must not
 * misname it.
 */
function projectRelative(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join('/');
}

/**
 * THE THREE RUN-SIDECAR DENIES SHARE ONE MEASURED FACT, so it is stated once
 * here: `.traffic-one/runs/` IS GITIGNORED, and none of these files has a
 * committed copy.
 *
 * `runs/` is one of `TRAFFIC_ONE_RUN_STATE_ENTRIES` in
 * architecture-contract/scaffold-content.ts, so the `.gitignore` the product
 * writes hides the whole subtree. MEASURED (.tmp/denyprose/routes-2.txt) on a
 * real `git init` fixture through `ensureProjectGitignore`: `git check-ignore`
 * reports `model-policy.json`, `host-capability-v1.json` and
 * `bootstrap/<role>/active.json` all IGNORED, `git add -A` stages ZERO paths
 * under `runs/`, and `.traffic-one/.one.json` is NOT ignored and IS staged.
 *
 * That last row is why this fact has to be said rather than assumed: the run-id
 * deny beside these three legitimately offers `git show HEAD:<pointer>` and a
 * verbatim restore, because the state pointer really is committed by design.
 * Copying that shape onto a run sidecar would be the `backups/` defect again —
 * a recovery route pointing at bytes that were never there. So none of the three
 * denies below names git, and each says what IS on disk instead.
 *
 * The write fence is the second shared fact, MEASURED in each state separately
 * through the real Claude PreToolUse entry points (`check-onboarding-gate`,
 * `check-plan-write`, `check-library-allowlist`) rather than inherited: with the
 * policy torn, `cat <sidecar>`, `git show`, and `git status --porcelain` are
 * permitted while `Write`, `Edit`, `rm -f <sidecar>`, `rm -rf runs/<id>` and the
 * control `git restore .traffic-one` are REFUSED by all three — and the control
 * `Write src/x.ts` is refused too, so the reads passing is a property of reads
 * and not of an unfenced fixture. `plan-readiness/contracts.ts`
 * `runtimeOwnedRunSidecar` is the predicate: `.traffic-one/runs/<id>/<anything>`
 * except `architecture-input-v1.json`.
 */
const NO_COMMITTED_COPY = ` There is nothing to restore it from either: \`${STATE_DIR}/runs/\` is gitignored by`
  + ' design, so no commit carries a copy of that file.';

/**
 * THE MODEL-POLICY DENY: the prohibition was right, the diagnosis was asserted,
 * and the remedy named no path, no command and no actor.
 *
 * It read, unconditionally: "immutable model-policy.json is corrupt for run
 * <id>. Do not reconstruct it from the current plan, One MCP cache, or project
 * availableModels; start a repaired parent run."
 *
 * THE PROHIBITION STAYS, and its reason is now stated instead of assumed. Every
 * child's model check and every published bootstrap envelope in the run is bound
 * to the `policyId` in that file (run-bootstrap-policy/index.ts hashes it into
 * the envelope), so a hand-rebuilt policy with a recomputed digest does not
 * repair the run — it silently re-authorizes it under models nobody froze. That
 * is exactly what `ensureRunModelPolicy`'s create-once refuses to do on its own.
 *
 * "IS CORRUPT" WAS ASSERTED IN SIX STATES AND TRUE IN ONE. The branch fires
 * whenever `readRunModelPolicy` returns null while `existsSync` says the file is
 * there, and that reader folds a bounded-read failure, a JSON failure and a
 * whole schema+digest validation into one `null`. DRIVEN through this gate on
 * mkdtemp fixtures (.tmp/denyprose/census-1.txt), all reaching this deny: torn
 * bytes; an EMPTY file; valid JSON that is an ARRAY and valid JSON that is a
 * STRING (neither is a record at all); a DIRECTORY at the path (EISDIR — nothing
 * was read, so nothing "is corrupt"); mode 0000 (EACCES, same); an INTACT policy
 * whose `runId` names a different run; an intact policy declaring
 * `schemaVersion` 2; an intact policy with a role row removed; and a tampered
 * field, which fails the `policyId` digest. Three of those files are not corrupt
 * in any sense a reader would recognise.
 *
 * WHAT IS UNREACHABLE, with controls, because a state nobody can reach must not
 * get a sentence: a healthy frozen policy and an ABSENT policy both walk past
 * this branch (`existsSync` is false for absent, and `ensureRunModelPolicy`
 * publishes); a DANGLING SYMLINK at the path is ABSENT to `existsSync`, which
 * follows links, so it never reaches here either; a symlink to a VALID policy
 * elsewhere reads through and is accepted; and a valid policy frozen for another
 * HOST goes to `spawn-model-policy-host-mismatch` one branch down. So — unlike
 * the run-id deny next door, whose reader refuses to follow links — this deny
 * needs no symlink arm, and saying so is the point of having measured it.
 *
 * "START A REPAIRED PARENT RUN" NAMED NOTHING, and every route it might have
 * meant was measured before one was printed:
 *
 *   THE AGENT HAS NO ROUTE AT ALL, and the deny now says so outright. MEASURED
 *     in this exact state through the real PreToolUse entry points: `Write` and
 *     `Edit` to the policy path, `rm -f` of it, and `rm -rf` of the run
 *     directory are each REFUSED (`runtimeOwnedRunSidecar`), while `cat` is
 *     permitted. There is no committed copy to restore (see NO_COMMITTED_COPY).
 *   RETRYING IS THE ONE THING THE OLD TEXT IMPLIED AND THE ONE THING THAT CANNOT
 *     WORK. The freeze is create-once — `ensureRunModelPolicy` returns null the
 *     moment `existsSync(filePath)` — so while that path exists no replacement
 *     is ever published. MEASURED: the same deny returns on every call.
 *   REMOVING THE FILE IS THE USER'S FIRST ROUTE, and it works. MEASURED: with
 *     the file gone the deny clears and a fresh policy is frozen for the SAME
 *     run id. It is stated as the user's decision rather than a step, because
 *     what it produces is a policy re-derived from the CURRENT host catalog —
 *     the silent rebase create-once exists to prevent.
 *   RETIRING THE RUN IS THE SECOND, and it is CONDITIONAL, for the reason
 *     codex-child-model.ts:467 already prints `resetRecoveryLine` conditionally:
 *     `traffic-one-reset` accepts only a terminally `failed` ledger. MEASURED
 *     (.tmp/denyprose/routes2-1.txt) with the ledger set by the real transition
 *     writer: `failed` → `ok=true code=reset`; `planned` → `run-not-failed`; no
 *     ledger → `ledger-absent`. So the command is printed on `failed` and the
 *     refusal is named otherwise — advising a command that gets refused is how
 *     prose stops being trusted.
 */
function modelPolicyCorruptDeny(cwd: string, runId: string): string {
  const file = runModelPolicyPath(cwd, runId);
  const rel = projectRelative(cwd, file);
  const read = readRegularFileResult(file);
  const json = read.kind === 'text'
    ? ((): { ok: true; value: unknown } | { ok: false } => {
      try { return { ok: true, value: JSON.parse(read.text) }; } catch { return { ok: false }; }
    })()
    : { ok: false } as const;
  const record: Rec | null = json.ok ? obj(json.value) : null;
  // `existsSync` said the file was there a moment ago and the bounded read says
  // it is not. That is a race and not a diagnosis, so it gets the retry it
  // deserves rather than a sentence about bytes nobody saw.
  if (read.kind === 'absent') {
    return `traffic-one — spawn blocked: run ${runId}'s immutable model policy was at \`${rel}\` when this gate`
      + ' looked for it and is gone now, so no child could be bound to a frozen policy. Nothing is wrong with the'
      + ' run. Re-send the SAME spawn, unchanged — same role, same model, same prompt: the freeze runs again on a'
      + ' path with nothing at it. Do NOT author that file and do NOT build inline because of this.';
  }
  // Named separately from the state clause because it is what the USER is asked
  // to do, and a `rm` of a DIRECTORY is not the same instruction as a `rm` of a
  // file — the sibling deny makes the same distinction for the state pointer.
  const removable = read.kind === 'unreadable' && read.errno === 'EISDIR'
    ? 'remove whatever is at that path'
    : 'delete that ONE file';
  const state = read.kind === 'unreadable'
    ? `Nothing can be read at \`${rel}\` (${read.errno}), so there are no policy bytes there to judge.`
    : !json.ok
      ? `\`${rel}\` is there and its bytes do not parse.`
      : record === null
        ? `\`${rel}\` holds valid JSON that is not an object (${Array.isArray(json.value)
          ? 'a JSON array' : `a JSON ${typeof json.value}`}), so it is not a policy record at all.`
        : typeof record.runId === 'string' && record.runId !== runId
          ? `\`${rel}\` is intact, but it is run \`${record.runId}\`'s policy and this spawn is in run \`${runId}\`.`
          : record.schemaVersion !== RUN_MODEL_POLICY_SCHEMA_VERSION
            ? `\`${rel}\` declares \`schemaVersion\` ${JSON.stringify(record.schemaVersion)}, and this runtime`
              + ` freezes and reads version ${RUN_MODEL_POLICY_SCHEMA_VERSION} only.`
            : `\`${rel}\` parses as a JSON object but does not validate as run \`${runId}\`'s frozen policy — a`
              + ' field, or the `policyId` digest taken over it, does not match what was frozen.';
  const ledger = runLedgerStatusRecord(cwd, runId);
  // Printed ONLY for `failed`, the one status `traffic-one-reset` accepts. Every
  // other status names the refusal instead, so this deny never hands over a
  // command the runner will decline.
  const retire = ledger.status === 'failed' ? ` ${resetRecoveryLine(runId)}` : ' Retiring the run is not'
    + ` available in this state: run ${runId}'s ledger ${ledger.status
      ? `reads \`${ledger.status}\`` : `is \`${ledger.legibility}\``}, and \`traffic-one-reset\` recovers only a`
    + ' terminally `failed` run — it refuses every other status.';
  return `traffic-one — spawn blocked: no child can be bound to run ${runId}'s immutable model policy. ${state}`
    + ' Do NOT reconstruct it from the current plan, the One MCP cache, or the project\'s `availableModels`, and do'
    + ' not hand-write a replacement: every child\'s model check and every published bootstrap envelope in this run'
    + ` is bound to the \`policyId\` in that file, so a rebuilt one does not repair run ${runId} — it`
    + ' re-authorizes it under models nobody froze. RETRYING CANNOT CLEAR THIS: the freeze is create-once, so while'
    + ' that path exists no replacement is ever published and this same deny returns on every spawn, indefinitely.'
    + ` You MAY read the file — \`cat ${rel}\` is permitted — and that is the whole of what you may do here:`
    + ' writing it, editing it, and removing it or the run directory are each refused for you, because it is a'
    + ` runtime-owned run sidecar.${NO_COMMITTED_COPY}`
    + ` So this is the USER's move, and there are two. Ask them to ${removable}, after which the next spawn freezes`
    + ' a fresh policy for this same run from the CURRENT host catalog — that is a rebase this gate deliberately'
    + ` will not perform on its own, so it is their decision.${retire}`
    + ' Until one of those happens, do not retry this spawn and do not build the project inline instead.';
}

/**
 * THE HOST-CAPABILITY DENY: "missing or corrupt" put two states in one sentence
 * when only one of them is durable, and the durable one is the one the remedy
 * could not reach.
 *
 * It read: "per-run host capability evidence is missing or corrupt for <host>.
 * No child was started. Repair the parent run and retry." Neither half is false.
 * Both halves are unusable: "repair the parent run" names no file, and "retry"
 * is precisely what does not work in the state that matters.
 *
 * MISSING IS SELF-CLEARING, AND THAT IS MEASURED RATHER THAN REASONED.
 * `core/dispatch.ts:36-43` calls `observeCurrentRunHostCapabilityFromHook`
 * BEFORE the pipeline runs, and `ensureRunHostCapability` writes a fresh record
 * whenever nothing is at the path. DRIVEN through the real Claude entry
 * (`runClaudeHook('check-agent-model', …)`, .tmp/denyprose/routes-2.txt): with
 * the sidecar deleted, `readRunHostCapability` is valid AFTER that invocation
 * and a `agentModelGate` call on the same fixture is then ALLOWED. So the
 * invocation that denies is the invocation that repairs it, and "re-send the
 * same spawn" is a remedy that actually completes — the shape
 * `SPAWN_CLAIM_UNAVAILABLE_FALLBACK` beside it already uses.
 *
 * PUBLISHED-BUT-INVALID IS DURABLE, and the old text told it to retry.
 * `ensureRunHostCapability` returns without writing when `!existing &&
 * existsSync(file)` — published-but-invalid is evidence loss and is never
 * silently replaced. DRIVEN, all reaching this deny and all still invalid after
 * a real hook invocation: unparseable bytes, a tampered `hostVersion` (the
 * `evidenceHash` no longer matches), a `runId` naming another run, a `host` of
 * `codex`, a DIRECTORY at the path, a DANGLING SYMLINK at the path, and mode
 * 0000. A healthy sidecar is the control and does not reach it.
 *
 * SO THE REMEDY IS A REMOVAL, AND IT IS NOT THE AGENT'S. MEASURED in the
 * unparseable state through the real entry points: `rm -f` and `Write` to that
 * path are REFUSED, `cat` is permitted. MEASURED that the removal is what
 * clears it: with the file gone, a hook invocation leaves a valid record and the
 * next gate call is allowed. And there is no copy to restore
 * (NO_COMMITTED_COPY), which is why this deny asks for a DELETION and not for
 * the version-control restore its nearest sibling
 * (`codex-child-model-ledger-illegible`) offers for a file in the same
 * gitignored directory.
 */
function hostCapabilityDeny(cwd: string, runId: string, host: string): string {
  const file = runHostCapabilityPath(cwd, runId);
  const rel = projectRelative(cwd, file);
  const read = readRegularFileResult(file);
  if (read.kind === 'absent') {
    return `traffic-one — spawn blocked: run ${runId} has no host-capability record for ${host} — \`${rel}\` is`
      + ' not on disk, and no child may be bound to enforcement evidence that is not there. This one is'
      + ' SELF-CLEARING: the request path writes that record from the host contract before any gate runs, so this'
      + ' invocation has already created it. Re-send the SAME spawn, unchanged — same role, same model, same'
      + ' prompt. Do NOT author that file, do not change the role or the model, and do not build inline instead.';
  }
  const removable = read.kind === 'unreadable' && read.errno === 'EISDIR'
    ? 'remove whatever is at that path'
    : 'delete that ONE file';
  const state = read.kind === 'unreadable'
    ? `Nothing can be read at \`${rel}\` (${read.errno}).`
    : `\`${rel}\` is on disk but does not validate as run ${runId}'s ${host} capability record.`;
  return 'traffic-one — spawn blocked: this spawn has no host-capability evidence to bind a child to, so no child'
    + ` was started. ${state}`
    + ' RETRYING CANNOT CLEAR THIS: a published-but-invalid capability record is evidence loss, so the runtime'
    + ' never replaces whatever is already at that path, and the same deny returns on every spawn. Clearing that'
    + ' path is what clears the deny — the next hook invocation writes a fresh record from the host contract — and'
    + ` it is refused for YOU: \`${rel}\` is a runtime-owned run sidecar, so your Write, Edit and \`rm\` are all`
    + ` denied there, though reading it is permitted.${NO_COMMITTED_COPY}`
    + ` Ask the USER to ${removable}, then re-send this spawn unchanged. Do not spawn another child into this run`
    + ' in the meantime, and do not build the project inline instead.';
}

/**
 * THE BOOTSTRAP-PUBLISH DENY: two causes with nothing in common, one sentence,
 * and a remedy — "Repair the parent materialization/policy and retry" — that
 * names the wrong subsystem for both.
 *
 * A NARROW DOOR, which is what made the measurement worth doing. This deny sits
 * inside `allowSpawn`, which the phase and model gates invoke only on their way
 * to an ALLOW, and two self-healing siblings claim most of the surface first. So
 * the census varied the ROLE and the run shape as well as the disk
 * (.tmp/denyprose/census-d3-1.txt), and exactly TWO states reach it:
 *
 *   NO WORK UNIT COMPILES FOR THE ROLE. `senior-reviewer` in a run with no
 *     compiled architecture and no published assignments: DRIVEN, this deny,
 *     durably, with the publish target perfectly writable. Materialization is
 *     intact in that fixture — so "repair the parent materialization" named a
 *     subsystem that is not involved. And it is precisely the case
 *     `spawn-role-no-compiled-assignment` beside it cannot claim: that arm needs
 *     `readRuntimeAssignments` to return a set it can consult, and this run has
 *     none. The deny now says that in prose, because an orchestrator told
 *     "repair and retry" retries, and nothing about a retry compiles a plan.
 *   THE PUBLISH TARGET IS FENCED OFF. With the role's bootstrap directory
 *     replaced by a symlink to a directory OUTSIDE `.traffic-one/`,
 *     `stateWritePermitted` is false and the envelope write is refused before
 *     any bytes are computed: DRIVEN, this deny, durable across retries, and
 *     CLEARED the moment the link is removed — a removal that is itself refused
 *     for the agent (MEASURED). `stateWritePermitted` is the discriminator
 *     because it asks the fence's own question with no side effect, and it
 *     answers TRUE in the first state above, so it separates the two rather
 *     than merely describing one.
 *
 * WHAT IS NOT REACHABLE HERE, and worth recording because it is a worse outcome
 * than this deny: a role bootstrap directory at mode 0555, and a FILE planted
 * where the `bootstrap` directory belongs, both make `ensureRunBootstrap` THROW
 * (EACCES, ENOTDIR) — fsjson's writers rethrow every errno but ELOOP, and this
 * call site does not guard. Those land as a crashed-pipeline deny with none of
 * this text. Same shape as the escaping EACCES in `ensureCurrentRunId` the
 * sibling round reported; not fixed here, reported.
 */
function bootstrapPublishDeny(cwd: string, runId: string, role: string, assignments: boolean): string {
  const active = activeRunBootstrapPath(cwd, runId, role);
  const rel = projectRelative(cwd, active);
  if (!stateWritePermitted(active)) {
    return `traffic-one — spawn blocked: \`${role}\`'s bootstrap envelope for run ${runId} cannot be published`
      + ` because the state write fence REFUSES its destination, \`${rel}\`, before any envelope bytes are`
      + ' computed. No child was started, and nothing about the plan or the model is wrong. Four things refuse'
      + ' that write: an unanswered "use Traffic One here?" consent question for this project, a symlink at or'
      + ` above that path, a path that resolves outside \`${STATE_DIR}/\`, and a path nothing can resolve.`
      + ' Retrying changes none of them, and nothing you can write fixes a refused write: clearing whatever'
      + ' occupies that path is refused for you too, because it is a runtime-owned run sidecar. If the consent'
      + ' question is the cause, answer it and re-send this spawn; otherwise report this to the USER, naming that'
      + ' exact path, and do not spawn into this run in the meantime.';
  }
  const architecture = Boolean(readCompiledArchitecture(cwd, runId));
  // The fence said yes, so the destination is not the problem: the inputs are.
  const cause = !architecture && !assignments
    ? `Run ${runId} has no compiled architecture and no published assignments, so there is no plan for`
      + ` \`${role}\`'s work unit to be compiled FROM. This is NOT the "\`${role}\` has no assignment" refusal`
      + ' beside it — that one reads a published assignment set, and this run has none. The architect phase is what'
      + ' produces both, and no retry of this spawn compiles a plan: complete (or replan) the architect phase'
      + ' first, and if it has already run in this run, report that to the USER.'
    : `Run ${runId} has ${architecture ? 'a compiled architecture' : 'no compiled architecture'} and`
      + ` ${assignments ? 'published assignments' : 'no published assignments'}, and \`${role}\`'s work unit still`
      + ' did not compile from them. Nothing about re-sending this spawn changes those inputs, so do not retry it'
      + ' unchanged; report it to the USER, naming this run and this role.';
  return `traffic-one — spawn blocked: no work unit could be compiled for \`${role}\` in run ${runId}, so the`
    + ' parent had no role/rule/skill bootstrap to publish and no child was started. The destination is not what'
    + ` is wrong — \`${rel}\` is writable. ${cause}`
    + ' Do NOT author an envelope for this role and do not build the project inline instead.';
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
    // "is corrupt" was announced for a directory, a mode-0000 file and three
    // INTACT policies too, and "start a repaired parent run" named no path, no
    // command and no actor — see modelPolicyCorruptDeny.
    return deny(modelPolicyCorruptDeny(cwd, spawnRunId), {
      denyId: 'spawn-model-policy-corrupt',
      denyTarget: spawnRunId,
    });
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
        // "missing or corrupt" folded a state the request path has already
        // repaired into one that no retry ever clears, and "repair the parent
        // run and retry" named neither the file nor who may touch it — see
        // hostCapabilityDeny.
        return deny(hostCapabilityDeny(cwd, spawnRunId, ctx.host), {
          denyId: 'spawn-host-capability-missing',
          denyTarget: spawnRunId,
        });
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
        // "Repair the parent materialization/policy and retry" named the wrong
        // subsystem for both reachable states — materialization is intact in
        // one and the destination's fence is the whole story in the other — and
        // named no path and no actor for either. See bootstrapPublishDeny.
        return deny(bootstrapPublishDeny(cwd, spawnRunId, role, Boolean(publishedAssignments)), {
          denyId: 'spawn-bootstrap-publish-failed',
          denyTarget: role,
        });
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
