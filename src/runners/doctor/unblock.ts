// src/runners/doctor/unblock.ts
// `doctor --unblock <gateId> [--run <id>] [--ttl 30m]` — the operator override,
// and the ONLY thing in this runner that writes anything anywhere. Everything
// it writes lands outside the project tree (shared/override/paths.ts).
//
// ── The three defenses, and which one is a COST rather than a boundary ───────
// 1. The gate-exemption argv grammar (shared/tool-classify.ts) does not admit
//    `--unblock`, so this command never inherits doctor's "no gate has an
//    opinion" exemption. That is NOT a claim it cannot be spawned: post-
//    onboarding, an ordinary read-only shell command is usually allowed, so the
//    grammar alone stops nothing here.
// 2. THIS FILE: a mint refuses unless stdin AND stdout are TTYs and a human
//    types back a nonce printed at that moment. This raises the price of a
//    scripted mint; it does not close it, and the earlier claim here that an
//    agent "cannot script the mint" was wrong. MEASURED: a caller that allocates
//    a pty (`script`, `expect`, forty lines of `pty.openpty`) makes both stdio
//    ends TTYs, reads the nonce off that same pty, and types it back —
//    `confirmAtTerminal` returned `confirmed` with no human present. Any
//    challenge PRINTED TO a terminal can be read from that terminal, so no
//    variation of this prompt fixes it, and none is claimed to.
// 3. The HMAC key lives outside the project tree, so a token cannot be forged
//    by writing files into the repo.
//
// What actually holds is therefore NOT the prompt. It is that a mint is
// permanently on the record and the record is checked for completeness: the run
// can never settle verified/shipped again (run-settlement's abuse guard), and
// the cheap ways of erasing that evidence are refused, because the pre-override
// snapshot and a signed mint counter in the machine-owned one.json outlive the
// ledger (shared/override/integrity.ts). A run that has ALREADY certified is
// therefore refused a mint outright (`run-already-verified` in runUnblock): that
// is the single state in which the guard has nothing left to demote — and that
// refusal reads a record NOTHING SIGNS, so it can be triggered on purpose. See
// its comment: the price is a per-run lockout out of the operator's escape
// hatch, the remedy is a new run, and the refusal names the suspicion instead of
// asserting an immutability the product does not have.
//
// ── Stated exactly, because the shorter version was false ────────────────────
// This file used to say "an override minted behind the operator's back cannot
// produce a green run, and neither can deleting it afterwards". The second half
// is not true as written, and the first half is only true of an attacker who
// stays inside the machine dir the settlement process is pointed at. What holds,
// measured:
//   - deleting the ledger, the whole per-project bucket, or duplicating a signed
//     line to keep the count up: all refused.
//   - deleting the bucket AND this project's one key in `one.json`, or the
//     bucket AND one appended byte in `one.json`, or restoring a copy of
//     `one.json` taken before the mint: still green. Those are the counter's
//     stated limits, enumerated in shared/override/integrity.ts.
//   - pointing `XDG_STATE_HOME` at a copy of the machine dir with the bucket
//     removed: green, with nothing deleted at all. Settlement trusts the
//     environment that names its machine dir, and the orchestrator invoking it
//     controls that environment. This is OLDER than the completeness checks and
//     defeats the abuse guard the same way; closing it means relocating a trust
//     root every consumer of that directory shares, which is a separate change.
//     It is named here and in integrity.ts so it can be scheduled, and it is
//     claimed to be closed nowhere.
// The TTY check is what keeps an agent from wandering into a mint by accident.
//
// ── The second operator command in this file ─────────────────────────────────
// `--reconcile-overrides` (runOverrideReconcile, at the bottom) is the named
// repair for a project whose override record cannot account for itself. It is
// here rather than beside the read-only probes because it shares everything
// that matters with the mint: it writes, it is authenticated by the same TTY +
// nonce route, and it is deliberately outside the gate-exemption grammar. What
// it is NOT is a delete — see shared/override/reconcile.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import { exec } from '../../shared/exec';
import { isDoctorIdArgument } from '../../shared/doctor-command';
import { isOverridableDenyId } from '../../config/deny-ids';
import {
  MAX_QUARANTINED_RUNS,
  OVERRIDE_DEFAULT_TTL_MS,
  mintOverride,
  overrideEvidenceReport,
  overrideReconciliationDraft,
  parseOverrideTtl,
  reconciliationRef,
  recordOverrideReconciliation,
} from '../../shared/override';
import { OVERRIDE_RECONCILE_FLAG } from './override-probe';
import { readDecisions } from '../../shared/state/decision-log';
import {
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
  readRunSettlement,
  readRunSettlementResult,
} from '../../shared/run-settlement';
import { readJson } from '../../shared/fsjson';
import { projectRootHash } from '../../shared/state/local-prefs/prefs-store';
import { pluginVersion } from '../../config/plugin-identity';

export interface UnblockRequest {
  readonly projectRoot: string;
  readonly gateId: string;
  /** Already resolved: `--run <id>` when given, else the project's currentRunId. */
  readonly runId: string | null;
  readonly ttl: string | null;
}

export type UnblockRefusal =
  | 'gate-id-shape'
  | 'no-run'
  | 'bad-ttl'
  | 'run-already-verified'
  | 'gate-never-denied'
  | 'gate-not-overridable'
  | 'not-interactive'
  | 'declined'
  | 'no-key'
  | 'write-failed';

/**
 * What the confirmation concluded — three values, not a boolean, because two of
 * them used to be one.
 *
 * `confirmAtTerminal` returned `false` both for "the operator cancelled" and
 * for "there is no operator: stdio is not a terminal", so `runUnblock` emitted
 * `{"refusal":"declined"}` for both and the `'not-interactive'` code declared
 * below was returned by nothing. Those are the two cases an operator reading a
 * transcript most needs to tell apart: one is a human saying no, the other is
 * something that is not a human asking.
 */
export type OverrideConfirmation = 'confirmed' | 'declined' | 'not-interactive';

export interface UnblockOutcome {
  readonly ok: boolean;
  readonly refusal?: UnblockRefusal;
  /** Operator-facing prose (stderr). Always populated. */
  readonly message: string;
  readonly tokenId?: string;
  readonly expiresAt?: string;
  readonly snapshotPath?: string;
}

// ── what the override will let past ──────────────────────────────────────────

interface GateDenyEvidence {
  /** Every gateId that has actually refused something in this run. */
  readonly gateIds: string[];
  /** The denyIds this specific gate produced, newest last. */
  readonly denyIds: string[];
  /** Whether the decision log had anything at all to say about this run. */
  readonly logHasRecords: boolean;
}

function gateDenyEvidence(projectRoot: string, runId: string, gateId: string): GateDenyEvidence {
  const records = readDecisions(projectRoot, runId);
  const gateIds = new Set<string>();
  const denyIds: string[] = [];
  for (const record of records) {
    if (record.decision !== 'deny' || !record.gateId) continue;
    gateIds.add(record.gateId);
    if (record.gateId === gateId && typeof record.denyId === 'string') denyIds.push(record.denyId);
  }
  return { gateIds: [...gateIds].sort(), denyIds, logHasRecords: records.length > 0 };
}

const MAX_SNAPSHOT_DIRTY_PATHS = 200;

function gitSnapshot(projectRoot: string): Record<string, unknown> {
  try {
    const head = exec.run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot });
    const status = exec.run('git', ['status', '--porcelain'], { cwd: projectRoot });
    const dirty = status.code === 0
      ? status.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
      : [];
    return {
      head: head.code === 0 ? head.stdout.trim() : null,
      dirtyCount: dirty.length,
      dirty: dirty.slice(0, MAX_SNAPSHOT_DIRTY_PATHS),
      dirtyTruncated: dirty.length > MAX_SNAPSHOT_DIRTY_PATHS,
    };
  } catch {
    return { head: null, dirtyCount: null, dirty: [], dirtyTruncated: false };
  }
}

const MAX_SNAPSHOT_DECISIONS = 40;

/**
 * The pre-override snapshot: what was true the instant before enforcement was
 * relaxed, so "what did this let past" is answerable afterwards by diffing
 * against it rather than by reconstructing it from memory.
 *
 * Three layers, each answering a different question a later reader will have:
 *   - the RUN's recorded verdict (ledger + canonical settlement): where the run
 *     stood before, so a later `verified` cannot be mistaken for pre-existing;
 *   - the REFUSALS this gate had already made in this run: literally the calls
 *     the token is about to let through;
 *   - the WORKING TREE (git HEAD + dirty paths): the before-picture for the
 *     writes the override enables, which is the only layer that survives if the
 *     project's own `.traffic-one/` is later cleaned.
 */
export function buildOverrideSnapshot(
  projectRoot: string,
  runId: string,
  gateId: string,
): Record<string, unknown> {
  const ledgerPath = `${projectRoot}/.traffic-one/runs/${runId}/run.json`;
  const ledger = readJson<Record<string, unknown>>(ledgerPath, {});
  const settlementRead = readRunSettlementResult(projectRoot, runId);
  const settlement = settlementRead.settlement;
  const decisions = readDecisions(projectRoot, runId)
    .filter((record) => record.decision === 'deny')
    .slice(-MAX_SNAPSHOT_DECISIONS)
    .map((record) => ({
      ts: record.ts,
      correlationId: record.correlationId,
      gateId: record.gateId ?? null,
      denyId: record.denyId ?? null,
      denyTarget: record.denyTarget ?? null,
    }));
  return {
    capturedAt: new Date().toISOString(),
    runtimeVersion: pluginVersion(),
    projectRoot,
    projectKey: projectRootHash(projectRoot),
    runId,
    gateId,
    ledger: {
      rawStatus: typeof ledger.status === 'string' ? ledger.status : null,
      rawOutcome: typeof ledger.outcome === 'string' ? ledger.outcome : null,
      effectiveStatus: effectiveLegacyRunStatus(ledger) || null,
      effectiveOutcome: effectiveLegacyRunOutcome(ledger) || null,
      canonicalStatus: typeof ledger.canonicalStatus === 'string' ? ledger.canonicalStatus : null,
    },
    // `settlementLegibility` beside the record and not folded into it: a `null`
    // settlement here is the before-picture an auditor reads as "this run had
    // no canonical verdict when the gate was relaxed", and a damaged record
    // produced exactly that `null`. The snapshot is the layer that survives a
    // later `.traffic-one/` clean, so the one thing it must not do is record an
    // unreadable record as an absent one.
    settlementLegibility: settlementRead.kind,
    settlement: settlement
      ? {
        status: settlement.status,
        reason: settlement.reason ?? null,
        revision: settlement.revision,
        incompleteChecks: settlement.incompleteChecks,
        settlementHash: settlement.settlementHash,
      }
      : null,
    recentDenies: decisions,
    git: gitSnapshot(projectRoot),
  };
}

// ── the interactive confirmation ─────────────────────────────────────────────

/**
 * A nonce printed HERE and typed back, not a plain y/n.
 *
 * `y\n` is a string any wrapper can pipe blind; this one cannot be produced
 * without having read the prompt that was generated for this specific
 * invocation. Combined with the TTY requirement it means the confirmation
 * cannot be pre-recorded, replayed from a script, or answered by something that
 * only sees the command line.
 */
export function overrideConfirmationNonce(): string {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

export function isInteractiveTerminal(stdin = process.stdin, stdout = process.stdout): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY);
}

async function askForNonce(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((resolve) => { rl.question(prompt, resolve); });
  } finally {
    rl.close();
  }
}

// ── the command ──────────────────────────────────────────────────────────────

function refuse(refusal: UnblockRefusal, message: string): UnblockOutcome {
  return { ok: false, refusal, message };
}

/**
 * Everything except the confirmation, so the checks are testable without a TTY
 * and the confirmation has no test-only bypass to grow. `confirm` is injected
 * by the CLI as the real TTY prompt; tests pass their own and never touch the
 * shipped interactive path, which is exactly the point — there is no env var
 * and no `--yes`. What that buys is the absence of a bypass INSIDE the product,
 * not the impossibility of a scripted mint: see this file's header for why a
 * pty defeats the prompt itself, and what is load-bearing instead.
 */
export async function runUnblock(
  request: UnblockRequest,
  confirm: (summary: string, nonce: string) => Promise<OverrideConfirmation>,
): Promise<UnblockOutcome> {
  const { projectRoot, gateId } = request;
  if (!gateId || !isDoctorIdArgument(gateId)) {
    return refuse('gate-id-shape', `Refusing: \`${gateId}\` is not a gate id (letters/digits joined by . _ -).`);
  }
  if (!request.runId) {
    return refuse('no-run', 'Refusing: no run to scope this override to. Every override is run-scoped so the '
      + 'abuse guard can name exactly one run; pass `--run <id>`, or run this from a project whose '
      + '`.traffic-one/.one.json` has a `currentRunId`.');
  }
  const runId = request.runId;
  const ttlMs = request.ttl === null ? OVERRIDE_DEFAULT_TTL_MS : parseOverrideTtl(request.ttl);
  if (ttlMs === null) {
    return refuse('bad-ttl', `Refusing: \`--ttl ${request.ttl}\` is not a bounded window. Use <n>s / <n>m / <n>h, at most 24h.`);
  }

  // A run that has ALREADY CERTIFIED, refused — the abuse guard reached from the
  // other direction, and the one state in which it cannot fire.
  //
  // Every other mint is honest because run-settlement/io.ts demotes the run to
  // `validating` the next time anything tries to certify it, permanently and
  // TTL-blind. For THIS run the guard has nothing left to demote: the
  // certificate is already written, no writer in the product replaces it (io.ts's
  // terminal guard returns `verified`/`failed`/`blocked` unchanged, and only
  // `blocked -> active` has an authorized edge), and every tool call the token
  // lets through afterwards rides on it. That is the laundering shape this
  // feature exists to close, so the mint is refused rather than sold as safe.
  //
  // GATED ON A FORGEABLE RECORD, and the refusal says so out loud rather than
  // resting on an immutability the product does not have. `settlementHash` is an
  // unkeyed digest over the record with sorted keys, so anything that can write
  // the project tree can WRITE a `verified` settlement this reader accepts —
  // MEASURED, twenty lines — and thereby deny the operator the escape hatch,
  // once per run, for every new run. That is the product's pre-existing forgery
  // floor (the same one that lets fabricated evidence certify a fresh run id),
  // and this refusal WIDENS ITS CONSEQUENCE from "forge a verdict" to "forge a
  // verdict and disable recovery".
  //
  // Refused anyway, because the alternative is worse in the direction that
  // matters: minting on a `verified` run launders work that is already
  // certified, and the operator has a route out that a planted certificate
  // cannot follow them down — a new run. What the refusal owes them is the
  // SUSPICION, which is why the message below names the file, says the
  // certificate may have been planted, and tells them how to check.
  // KNOWN-ISSUES.md carries the lockout as a residual.
  //
  // ONLY `verified`, and the enumeration is the argument. Of the seven canonical
  // statuses (run-settlement/types.ts) `planned`, `active`, `code-delivered` and
  // `validating` are non-terminal and certify nothing — `validating` is where the
  // abuse guard itself parks an overridden run, so refusing it would refuse the
  // second override on a run the first one already devalued. `failed` and
  // `blocked` ARE terminal, and are exactly where a wedged operator legitimately
  // needs this: neither is a claim about evidence, so a relaxed gate launders
  // nothing, `blocked` is the state a resume is authorized out of, and a run with
  // no settlement at all (the overwhelmingly common case) is untouched. So the
  // refusal costs no recovery: a run that certified is by definition not wedged.
  const settlement = readRunSettlement(projectRoot, runId);
  if (settlement?.status === 'verified') {
    return refuse('run-already-verified',
      `Refusing: run \`${runId}\` has already settled \`verified\`, and nothing in this product replaces a `
      + 'certificate once it is written. An override here would relax a gate for work that keeps a certificate '
      + 'earned BEFORE the relaxation — the one case where "this run can never settle verified again" cannot be '
      + 'made true, because it already did. Nothing was minted, and this run\'s verdict is unchanged.\n'
      + 'IF YOU DID NOT EXPECT THIS RUN TO BE CERTIFIED, the certificate may have been PLANTED. Its integrity '
      + 'hash is an ordinary digest, not a signature, so anything that can write this project can produce a '
      + `settlement that reads as verified. Check \`.traffic-one/runs/${runId}/settlement-v2.json\`: an honest `
      + 'certification is reached by the runtime, so its `revision` counts up from earlier settlements of this '
      + 'run, its `updatedAt` matches when the run actually finished, and `.traffic-one/runs/'
      + `${runId}/run.json\` agrees with it. A revision of 1 on a run that was driven for a while, a timestamp `
      + 'that does not match, or a run.json that never left `active` is a planted record, and a planted record '
      + 'is a report to whoever owns this machine — not something to work around.\n'
      + 'What to do instead: do the work in a run that has not certified. Re-prompt the parent agent in this '
      + `project so a new run is minted, then run this command again with \`--run <that id>\`; work done after a `
      + 'certification is outside what that certificate covers either way. Every state an override is legitimate '
      + 'for still mints — including a run that settled `failed` or `blocked`, which is the usual wedge.');
  }

  // Typo protection, and the only check that can tell the operator they are
  // about to unblock a gate that never refused anything: the decision log
  // already records `gateId` on every deny, so the set of gates worth naming is
  // knowable rather than guessable. Skipped entirely when the log is empty —
  // logging can be off (T1_DECISION_LOG) or the project may not be writable,
  // and refusing to mint because we cannot see evidence would take the escape
  // hatch away in precisely the "everything is broken" case it exists for.
  const evidence = gateDenyEvidence(projectRoot, runId, gateId);
  if (evidence.logHasRecords && !evidence.gateIds.includes(gateId)) {
    return refuse('gate-never-denied',
      `Refusing: gate \`${gateId}\` has not denied anything in run \`${runId}\`. `
      + (evidence.gateIds.length
        ? `Gates that did: ${evidence.gateIds.join(', ')}.`
        : 'No gate has denied anything in this run.'));
  }
  // The never-overridable list, enforced at MINT time as well as at read time.
  // The pipeline would refuse to honour such a token anyway, so this only
  // prevents an operator being handed a token that silently does nothing —
  // which is worse than a refusal, because they would then believe the gate was
  // lifted and act on it.
  if (evidence.denyIds.length > 0 && !evidence.denyIds.some((denyId) => isOverridableDenyId(denyId))) {
    return refuse('gate-not-overridable',
      `Refusing: every refusal gate \`${gateId}\` made in run \`${runId}\` `
      + `(${[...new Set(evidence.denyIds)].join(', ')}) is on the never-overridable list `
      + '(config/deny-ids.ts). No override can lift these — fix the cause, or settle this run and start a new one.');
  }

  const nonce = overrideConfirmationNonce();
  const summary = [
    'traffic-one — OPERATOR OVERRIDE',
    '',
    `  gate        ${gateId}`,
    `  run         ${runId}`,
    `  project     ${projectRoot}`,
    `  window      ${Math.round(ttlMs / 60000)} minute(s) from now`,
    '',
    'This disables one enforcement gate for one run. Consequences, all of them permanent:',
    `  - run \`${runId}\` can never settle as verified or shipped, even after the override expires;`,
    '  - the override is recorded, with your username and a snapshot of the run state, under the',
    '    machine dir outside this project;',
    '  - nothing about the work this lets through is reviewed by anything else.',
  ].join('\n');

  const confirmation = await confirm(summary, nonce);
  if (confirmation === 'not-interactive') {
    return refuse('not-interactive', 'No override minted: nothing was there to confirm it.');
  }
  if (confirmation !== 'confirmed') {
    return refuse('declined', 'No override minted.');
  }

  const result = mintOverride({
    projectRoot,
    runId,
    scope: 'gate',
    target: gateId,
    ttlMs,
    snapshot: buildOverrideSnapshot(projectRoot, runId, gateId),
  });
  if (!result.ok) {
    if (result.reason === 'no-key') {
      return refuse('no-key', 'Refusing: could not read or create the per-install override key under the machine dir '
        + '(unwritable HOME, or a symlink where the key should be). No override minted.');
    }
    if (result.reason === 'counter-unwritable') {
      // Named separately because the fix is a specific file and the alternative
      // was minting anyway: this project's signed mint counter lives in that
      // envelope, and a mint whose counter cannot advance is a mint no witness
      // outside the override bucket will ever be able to account for.
      return refuse('write-failed', 'Refusing: the machine settings envelope (~/.traffic-one/one.json) will not '
        + 'accept a write — its `schemaVersion` is one this runtime does not support, it is not parseable JSON, or '
        + 'something other than a file is at that path. The signed mint counter that records this override lives '
        + 'there, and minting without it would leave the mint invisible to the one witness that survives deleting '
        + 'the override bucket. Fix or move that file (nothing else here is lost) and run this again. No override '
        + 'minted.');
    }
    if (result.reason === 'counter-locked') {
      // The only refusal here a retry fixes, which the generic line below cannot
      // say: the envelope is intact and another process is holding its lock, so
      // there is no file to repair and nothing for the operator to decide. It
      // shares `write-failed` with the arm above because the code has never
      // separated the content causes either — the prose is what discriminates.
      return refuse('write-failed', 'Refusing: another process is writing the machine settings envelope '
        + '(~/.traffic-one/one.json) and this mint could not take its lock in time. Nothing is damaged and nothing '
        + 'was written — run this again. No override minted.');
    }
    return refuse('write-failed', `Refusing: the override could not be recorded (${result.reason}). No override minted.`);
  }
  return {
    ok: true,
    message: [
      `Override minted for gate \`${gateId}\` on run \`${runId}\`.`,
      `  token     ${result.token.id}`,
      `  expires   ${result.token.expiresAt}`,
      `  snapshot  ${result.snapshotPath}`,
      '',
      `Run \`${runId}\` is now permanently ineligible for verified/shipped.`,
    ].join('\n'),
    tokenId: result.token.id,
    expiresAt: result.token.expiresAt,
    snapshotPath: result.snapshotPath,
  };
}

/** The shipped confirmation: a real terminal, or nothing. */
export async function confirmAtTerminal(summary: string, nonce: string): Promise<OverrideConfirmation> {
  if (!isInteractiveTerminal()) {
    // Says what is true and stops there. The previous wording ("it is what
    // stops an agent minting its own override") promised a boundary this check
    // does not provide — a pty makes both ends a TTY and puts the nonce where
    // whatever allocated it can read it. What survives the pty is the record:
    // the mint is permanent and erasing it is refused, which is the sentence
    // worth printing to whoever is reading this.
    process.stderr.write(`${summary}\n\nRefusing: an override is minted only from an interactive terminal `
      + '(stdin and stdout must both be a TTY), and this invocation has neither. Run the command yourself, '
      + 'in your own shell. If you did not start this and something else did: a mint is recorded permanently '
      + 'under the machine dir, and a run it names can never settle verified or shipped.\n');
    return 'not-interactive';
  }
  process.stderr.write(`${summary}\n\n`);
  const typed = await askForNonce(`Type ${nonce} to confirm, anything else to cancel: `);
  return typed.trim() === nonce ? 'confirmed' : 'declined';
}

// ── the repair ───────────────────────────────────────────────────────────────

export type ReconcileRefusal =
  | 'nothing-to-reconcile'
  | 'unfingerprintable'
  | 'too-many-runs'
  | 'not-interactive'
  | 'declined'
  | 'no-key'
  | 'write-failed';

export interface ReconcileOutcome {
  readonly ok: boolean;
  readonly refusal?: ReconcileRefusal;
  readonly message: string;
  readonly reconciled?: string[];
  readonly quarantinedRuns?: number;
  readonly ref?: string;
}

/**
 * Every run this project has on disk, sorted — the quarantine list.
 *
 * Enumerated from the run DIRECTORIES rather than from the settlements, because
 * the question is "which runs could the missing evidence have been about", and
 * a run with no settlement yet is still one of them.
 */
export function projectRunIds(projectRoot: string): { readonly runs: string[]; readonly complete: boolean } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(projectRoot, '.traffic-one', 'runs'), { withFileTypes: true });
  } catch {
    // No runs directory is a complete answer: there is nothing to quarantine.
    // An unreadable one is not, and is reported as incomplete below, which
    // refuses the reconciliation rather than quarantining a guess.
    return { runs: [], complete: !fs.existsSync(path.join(projectRoot, '.traffic-one', 'runs')) };
  }
  const runs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  return { runs, complete: runs.length <= MAX_QUARANTINED_RUNS };
}

/**
 * `doctor --reconcile-overrides`: record a signed acknowledgement of an
 * override record that cannot account for itself.
 *
 * Split from its confirmation exactly like `runUnblock`, for the same reason —
 * the tests drive this function and the shipped prompt has no bypass to grow.
 *
 * It refuses when there is NOTHING to reconcile, and that refusal is
 * load-bearing rather than tidy: a reconciliation quarantines every run in the
 * project, so minting one against a healthy record would be a way to
 * permanently refuse certification for work nobody has complained about.
 */
export async function runOverrideReconcile(
  request: { readonly projectRoot: string },
  confirm: (summary: string, nonce: string) => Promise<OverrideConfirmation>,
): Promise<ReconcileOutcome> {
  const { projectRoot } = request;
  const report = overrideEvidenceReport(projectRoot);
  if (report.checks.length === 0) {
    return {
      ok: false,
      refusal: 'nothing-to-reconcile',
      message: 'Nothing to reconcile: this project\'s operator-override record accounts for itself. '
        + 'A reconciliation permanently refuses certification for every run this project already has, '
        + 'so it is not minted speculatively.',
    };
  }
  // BEFORE anything is charged for: would this acknowledgement forgive what it
  // is being minted against? A reconciliation quarantines every run in the
  // project permanently, so one that forgives nothing is the entire bill for none
  // of the goods — MEASURED on an `unreadable` ledger and on an orphan whose file
  // cannot be read, where the fingerprint is '' by construction and the repair
  // nonetheless printed `Reconciled: …` with a ref, burned every run on disk,
  // changed no verdict, and could be re-run to burn the next batch. It also makes
  // SUPPORT.md's standing promise true: the repair declines a record that is
  // merely unreadable, because fixing the permissions loses nothing.
  const draft = overrideReconciliationDraft(projectRoot);
  if (draft.unforgiven.length > 0) {
    return {
      ok: false,
      refusal: 'unfingerprintable',
      message: `Refusing: ${draft.unforgiven.join(', ')} cannot be fingerprinted, so an acknowledgement of it `
        + 'would forgive nothing while permanently refusing certification for every run this project has on '
        + 'disk. Nothing was written. This is what an override record that is UNREADABLE rather than damaged '
        + 'looks like — the ledger, the snapshot directory or one snapshot file cannot be read at all. Fix the '
        + 'permissions (or the symlink, or the directory in the way) and run this again: no evidence is lost by '
        + 'doing so, and if the record then accounts for itself there is nothing left to reconcile.',
    };
  }
  const { runs, complete } = projectRunIds(projectRoot);
  if (!complete) {
    return {
      ok: false,
      refusal: 'too-many-runs',
      message: `Refusing: this project has more than ${MAX_QUARANTINED_RUNS} runs on disk, or its `
        + '`.traffic-one/runs/` could not be listed. A reconciliation has to NAME every run it '
        + 'quarantines — one that cannot is an acknowledgement with nothing behind it — so archive or '
        + 'clean up old runs, or fix the directory, and run this again.',
    };
  }

  const nonce = overrideConfirmationNonce();
  const summary = [
    'traffic-one — OPERATOR OVERRIDE RECONCILIATION',
    '',
    `  project     ${projectRoot}`,
    `  findings    ${report.checks.join(', ')}`,
    `  ledger      ${report.ledger} (${report.vouchableMints} mint(s) this install can vouch for)`,
    `  orphans     ${report.orphanSnapshots.length} snapshot(s) no ledger line accounts for`,
    `  counter     ${report.mintCounter.state}${report.mintCounter.count === null ? '' : ` / ${report.mintCounter.count}`}`,
    `  runs        ${runs.length} in this project`,
    '',
    'This does NOT delete anything. It appends a signed statement that you looked at exactly this',
    'state and accepted it, so certification can resume for work that comes after. Consequences,',
    'all of them permanent:',
    `  - all ${runs.length} run(s) currently in this project can never settle as verified or shipped;`,
    '  - the acknowledgement is recorded with your username under the machine dir, beside the',
    '    evidence it accounts for, which stays exactly where it is;',
    `  - this project's signed mint counter is pinned at ${report.vouchableMints}, so a later mint — or the`,
    '    disappearance of the counter itself — is a state nobody acknowledged;',
    '  - it covers THIS state only — one more orphaned snapshot, one more missing ledger line, one',
    '    more mint, and the project refuses again until you look again.',
  ].join('\n');

  const confirmation = await confirm(summary, nonce);
  if (confirmation === 'not-interactive') {
    return { ok: false, refusal: 'not-interactive', message: 'Nothing reconciled: nothing was there to confirm it.' };
  }
  if (confirmation !== 'confirmed') {
    return { ok: false, refusal: 'declined', message: 'Nothing reconciled.' };
  }

  const result = recordOverrideReconciliation({
    projectRoot,
    fingerprint: draft.fingerprint,
    quarantinedRuns: runs,
  });
  if (!result.ok) {
    return result.reason === 'no-key'
      ? {
        ok: false,
        refusal: 'no-key',
        message: 'Refusing: could not read the per-install override key under the machine dir. An '
          + 'unsigned acknowledgement accounts for nothing, so none was written.',
      }
      : {
        ok: false,
        refusal: result.reason === 'too-many-runs' ? 'too-many-runs' : 'write-failed',
        message: `Refusing: the reconciliation could not be recorded (${result.reason}). Nothing was written.`,
      };
  }
  return {
    ok: true,
    reconciled: report.checks,
    quarantinedRuns: runs.length,
    ref: reconciliationRef(result.entry),
    message: [
      `Reconciled: ${report.checks.join(', ')}.`,
      `  ref       ${reconciliationRef(result.entry)}`,
      `  runs      ${runs.length} run(s) permanently ineligible for verified/shipped`,
      '',
      'Nothing was deleted. The evidence and this acknowledgement are both on the record.',
    ].join('\n'),
  };
}

/**
 * Was the repair asked for? Read off argv HERE rather than in lib.ts's
 * parseArgs, beside doctor's diagnostic flags, and the placement is the point:
 * `DoctorArgs` describes what the report is about, this is a different command
 * that happens to share a binary. parseArgs ignores an unrecognized flag, so
 * the two do not interact, and the gate-exemption grammar (tool-classify.ts)
 * enumerates the flags it admits and therefore already refuses this one.
 */
export function wantsOverrideReconcile(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes(OVERRIDE_RECONCILE_FLAG);
}

/** Entry point used by runners/doctor/index.ts. Returns the process exit code. */
export async function reconcileMain(projectRoot: string): Promise<number> {
  const outcome = await runOverrideReconcile({ projectRoot }, confirmAtTerminal);
  if (outcome.message) process.stderr.write(`${outcome.message}\n`);
  process.stdout.write(`${JSON.stringify({
    reconcileOverrides: outcome.ok ? 'recorded' : 'refused',
    ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    ...(outcome.ok ? { reconciled: outcome.reconciled, quarantinedRuns: outcome.quarantinedRuns, ref: outcome.ref } : {}),
  })}\n`);
  return outcome.ok ? 0 : 1;
}

/** Entry point used by runners/doctor/index.ts. Returns the process exit code. */
export async function unblockMain(request: UnblockRequest): Promise<number> {
  const outcome = await runUnblock(request, confirmAtTerminal);
  // stderr for the human, one line of JSON on stdout so the shape matches every
  // other doctor invocation (stdout parseable, stderr legible).
  if (outcome.message) process.stderr.write(`${outcome.message}\n`);
  process.stdout.write(`${JSON.stringify({
    unblock: outcome.ok ? 'minted' : 'refused',
    ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
    ...(outcome.tokenId ? { tokenId: outcome.tokenId, expiresAt: outcome.expiresAt } : {}),
  })}\n`);
  return outcome.ok ? 0 : 1;
}
