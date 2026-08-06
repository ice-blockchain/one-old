// src/runners/doctor/unblock.ts
// `doctor --unblock <gateId> [--run <id>] [--ttl 30m]` — the operator override,
// and the ONLY thing in this runner that writes anything anywhere. Everything
// it writes lands outside the project tree (shared/override/paths.ts).
//
// ── The three independent defenses, and which one carries the weight ─────────
// 1. The gate-exemption argv grammar (shared/tool-classify.ts) does not admit
//    `--unblock`, so this command never inherits doctor's "no gate has an
//    opinion" exemption. That is NOT a claim it cannot be spawned: post-
//    onboarding, an ordinary read-only shell command is usually allowed, so the
//    grammar alone stops nothing here.
// 2. THIS FILE: a mint refuses unless stdin AND stdout are TTYs and a human
//    types back a nonce printed at that moment. An agent tool call runs with
//    piped stdio and never sees the nonce, so it cannot script the mint. This
//    is the defense that actually holds against the realistic case.
// 3. The HMAC key lives outside the project tree, so a token cannot be forged
//    by writing files into the repo.
//
// The residual: a host that allocates a PTY for tool calls AND surfaces their
// output to the model could, in principle, echo the nonce back. That is why the
// abuse guard is not optional — a minted override is recorded, permanently, and
// the run can never settle verified/shipped again. An override that gets minted
// behind the operator's back still cannot produce a green run.

import * as readline from 'readline';

import { exec } from '../../shared/exec';
import { isDoctorIdArgument } from '../../shared/doctor-command';
import { isOverridableDenyId } from '../../config/deny-ids';
import {
  OVERRIDE_DEFAULT_TTL_MS,
  mintOverride,
  parseOverrideTtl,
} from '../../shared/override';
import { readDecisions } from '../../shared/state/decision-log';
import { effectiveLegacyRunOutcome, effectiveLegacyRunStatus, readRunSettlement } from '../../shared/run-settlement';
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
  | 'gate-never-denied'
  | 'gate-not-overridable'
  | 'not-interactive'
  | 'declined'
  | 'no-key'
  | 'write-failed';

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
  const settlement = readRunSettlement(projectRoot, runId);
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
 * shipped interactive path, which is exactly the point — there is no env var,
 * no `--yes`, and no way to reach the mint from a script.
 */
export async function runUnblock(
  request: UnblockRequest,
  confirm: (summary: string, nonce: string) => Promise<boolean>,
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

  if (!(await confirm(summary, nonce))) {
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
    return result.reason === 'no-key'
      ? refuse('no-key', 'Refusing: could not read or create the per-install override key under the machine dir '
        + '(unwritable HOME, or a symlink where the key should be). No override minted.')
      : refuse('write-failed', `Refusing: the override could not be recorded (${result.reason}). No override minted.`);
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
export async function confirmAtTerminal(summary: string, nonce: string): Promise<boolean> {
  if (!isInteractiveTerminal()) {
    process.stderr.write(`${summary}\n\nRefusing: an override is minted only from an interactive terminal `
      + '(stdin and stdout must both be a TTY). This is not a configuration problem — it is what stops an '
      + 'agent minting its own override. Run this command yourself.\n');
    return false;
  }
  process.stderr.write(`${summary}\n\n`);
  const typed = await askForNonce(`Type ${nonce} to confirm, anything else to cancel: `);
  return typed.trim() === nonce;
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
