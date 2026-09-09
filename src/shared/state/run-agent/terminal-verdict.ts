// src/shared/state/run-agent/terminal-verdict.ts
// Terminal verdict detection: digest candidates, QA gating, and the run
// verification state.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import {  readJson, readJsonResult, type JsonRead } from '../../fsjson';
import { isQaBrowserBridgeEligible, readQaReportV1, type QaReportValidationResult } from '../../qa-report';
import { readQaReportV2, type QaV2ValidationResult } from '../../qa-report-v2';
import {
  activeRunClaimCount,
  effectiveLegacyRunOutcome,
  effectiveLegacyRunStatus,
} from '../../run-settlement';

import {
  runLedgerFile,
  safePathSegment,
} from './run-paths';
import {
  isRunLedgerOutcome,
  isRunLedgerStatus,
  type RunLedgerOutcome,
  type RunLedgerStatus,
} from './ledger';
import {
  anyRunProducedImplementerOutput,
  runHasOrchestratedArtifacts,
} from './run-settle';
import { maintenanceRunReachedTerminal } from './run-settle';
import { readRegularFileOrThrow } from '../../bounded-read';
import { exactDigestVerdict } from '../../digest-verdict';

// --- Verification settlement (terminal verdict) ----------------------------
// A digest FILE exists from the moment its role first runs (Phase 3) and is
// re-emitted on every fix-cycle pass, so EXISTENCE never means "done" — the
// verdict LINE inside must be terminal. Canonical tokens (orchestrator SKILL +
// prompt-templates): reviewer `APPROVED` (vs `CHANGES_REQUESTED`), tester
// `TESTS_GREEN` (vs `TESTS_FAILING`). The opencode runner emits `DELEGATED_OK`
// until the orchestrator normalizes it — also non-terminal here by design.

export function digestDir(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'digests', safePathSegment(runId));
}
// Resolve a role digest across BOTH spellings, NEWEST-WINS.
//
// The canonical name is `<role>.md` (roleDigestName strips `senior-`), but real
// orchestrators write `senior-<role>.md` too — observed live in cursor 14c, where
// the SAME run held `frontend.md` (the previous feature) alongside a NEWER
// `senior-frontend.md` (the current one). Preferring the canonical name BY NAME
// then handed every gate the stale digest: the QA freshness floor
// (strictQaReportResult) computed its floor from the old mtime, so a report
// predating the current implementation would have passed as fresh evidence — the
// exact stale digest/report pairing that floor exists to prevent. Ordering by
// mtime instead makes the newest emitted digest authoritative regardless of which
// spelling the orchestrator chose, and is a no-op when only one file exists.
// Newest-wins resolves WHICH verdict/mtime is authoritative. It must NEVER be able to
// hide a digest that exists: an EMPTY-but-newer `senior-<role>.md` masking a
// content-bearing `frontend.md` would falsely grant the backend-only QA exemption at
// runHasQaEvidence and settle a frontend run `verified` with ZERO QA evidence (adversarial
// review proved this by differential execution against the pre-change code). So a
// candidate only competes when it is a readable file with non-blank content, and every
// EXISTENCE/emptiness question goes through the union helper below instead of picking one
// file. Ties favour the canonical spelling, preserving the pre-change behaviour.
function digestCandidateNames(name: string): readonly string[] {
  return name.startsWith('senior-') ? [name] : [name, `senior-${name}`];
}

interface DigestCandidate { file: string; mtimeMs: number; text: string }

// Every readable, non-blank spelling of one role digest, canonical spelling FIRST so a
// stable sort keeps it winning an exact mtime tie.
function digestCandidates(cwd: string, runId: string, name: string): DigestCandidate[] {
  const found: DigestCandidate[] = [];
  for (const candidate of digestCandidateNames(name)) {
    const file = path.join(digestDir(cwd, runId), candidate);
    try {
      const st = fs.statSync(file);
      if (!st.isFile() || st.size <= 0) continue;
      // Read here, not later: statSync succeeds without read permission, so resolving by
      // stat alone let an unreadable canonical file win and return '' where the old code
      // fell back to the readable sibling — which at the QA exemption meant fake-green.
      const text = readRegularFileOrThrow(file);
      if (!text.trim()) continue;
      found.push({ file, mtimeMs: Math.floor(st.mtimeMs), text });
    } catch {
      // Missing/unreadable candidate — the other spelling may still serve.
    }
  }
  return found;
}

function newestDigestCandidate(cwd: string, runId: string, name: string): DigestCandidate | null {
  const found = digestCandidates(cwd, runId, name);
  if (!found.length) return null;
  return found.reduce((best, item) => (item.mtimeMs > best.mtimeMs ? item : best), found[0]!);
}

function digestFile(cwd: string, runId: string, name: string): string | null {
  return newestDigestCandidate(cwd, runId, name)?.file ?? null;
}

export function readDigest(cwd: string, runId: string, name: string): string {
  return newestDigestCandidate(cwd, runId, name)?.text ?? '';
}

/**
 * True when ANY spelling of this role digest carries content — a UNION, never a pick.
 * Use for "did this role emit anything at all" questions (the backend-only QA exemption,
 * implementer output, verifier output). Matches the existsSync-union already used by
 * anyRunProducedImplementerOutput/runHasOrchestratedArtifacts, so run-agent stays
 * internally consistent about existence.
 */
function anyDigestSpellingHasContent(cwd: string, runId: string, name: string): boolean {
  return digestCandidates(cwd, runId, name).length > 0;
}

/**
 * True when both spellings exist and their machine verdicts DISAGREE. Callers fail closed,
 * mirroring exactDigestVerdict's rule for conflicting verdict lines inside one file: a
 * disagreement means nobody has emitted an authoritative verdict, so newest-mtime must not
 * get to pick the winner (it would let a newer `senior-reviewer.md` APPROVED override a
 * canonical CHANGES_REQUESTED and rotate/settle the run).
 */
function digestVerdictsConflict(cwd: string, runId: string, name: string): boolean {
  const verdicts = digestCandidates(cwd, runId, name)
    .map((candidate) => exactDigestVerdict(candidate.text))
    .filter((verdict): verdict is string => typeof verdict === 'string');
  return new Set(verdicts).size > 1;
}

function dirHasAnyFile(dir: string, suffixes: readonly string[]): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && dirHasAnyFile(p, suffixes)) return true;
      if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function runCreatedAtMs(cwd: string, runId: string): number {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  const raw = rec && typeof rec.createdAt === 'string' ? rec.createdAt : '';
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

// Strict QA evidence is scoped to the latest contract activation, not merely to
// the run's original creation. Resuming a blocked run or upgrading an active
// legacy run advances this watermark so a report from the previous attempt can
// never become green evidence in the resumed attempt.
function runQaContractActivatedAtMs(cwd: string, runId: string): number {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  const candidates = [rec?.createdAt, rec?.qaContractActivatedAt]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .map((value) => Date.parse(value))
    .filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : 0;
}

function runQaContractVersion(cwd: string, runId: string): 1 | 2 | null {
  const rec = obj(readJson(runLedgerFile(cwd, runId), null));
  return rec?.qaContractVersion === 2 ? 2 : rec?.qaContractVersion === 1 ? 1 : null;
}

export function runUsesStrictQaContract(cwd: string, runId: string): boolean {
  return runQaContractVersion(cwd, runId) !== null;
}

function canonicalQaReportRaw(cwd: string, runId: string): Rec | null {
  const memoryDir = '.traffic' + '-one';
  return obj(readJson(path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId), 'report.json'), null));
}

function strictQaReportResult(cwd: string, runId: string): QaReportValidationResult {
  const activatedAtMs = runQaContractActivatedAtMs(cwd, runId);
  let frontendDigestMtimeMs = 0;
  const frontendFile = digestFile(cwd, runId, 'frontend.md');
  if (frontendFile) {
    try { frontendDigestMtimeMs = Math.floor(fs.statSync(frontendFile).mtimeMs); } catch { /* missing digest */ }
  }
  // Plan-unit delegated writes land in opencode-frontend.md; a QA report older
  // than that delegated change validated stale UI (8co). The floor takes the
  // newest implementer-side digest of either spelling. (Deliberately NOT part
  // of digestCandidates: verdict resolution must never treat DELEGATED_OK as
  // a competing frontend verdict.)
  let opencodeDigestMtimeMs = 0;
  try {
    opencodeDigestMtimeMs = Math.floor(
      fs.statSync(path.join(digestDir(cwd, runId), 'opencode-frontend.md')).mtimeMs,
    );
  } catch { /* no delegated digest */ }
  const freshnessFloorMs = Math.max(activatedAtMs, frontendDigestMtimeMs, opencodeDigestMtimeMs);
  return readQaReportV1(cwd, runId, {
    ...(freshnessFloorMs > 0 ? { minimumGeneratedAtMs: freshnessFloorMs } : {}),
  });
}

function strictQaReportV2Result(cwd: string, runId: string): QaV2ValidationResult {
  return readQaReportV2(cwd, runId);
}

export function runHasExplicitBlockedQaOutcome(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (runQaContractVersion(cwd, runId) === 2) {
    const result = strictQaReportV2Result(cwd, runId);
    return !result.ok && result.code === 'blocked-environment' && result.report !== undefined;
  }
  if (runUsesStrictQaContract(cwd, runId)) {
    const result = strictQaReportResult(cwd, runId);
    return !result.ok
      && result.report !== undefined
      && typeof result.status === 'string'
      && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(result.status);
  }
  const tester = readDigest(cwd, runId, 'tester.md');
  if (/\bblocked:(?:browser-unavailable|sandbox|usage-limit|timeout)\b/i.test(tester)) return true;
  const raw = canonicalQaReportRaw(cwd, runId);
  return typeof raw?.status === 'string'
    && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(raw.status);
}

// Browser-unavailable is recoverable by the parent-browser bridge and must keep
// the run active. The other validated blocker classes require user-visible
// environment settlement. Legacy/raw reports cannot qualify for the bridge.
export function runHasEnvironmentBlockedQaOutcome(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  if (!runUsesStrictQaContract(cwd, runId)) return runHasExplicitBlockedQaOutcome(cwd, runId);
  if (runQaContractVersion(cwd, runId) === 2) {
    const result = strictQaReportV2Result(cwd, runId);
    return !result.ok && result.code === 'blocked-environment' && result.report !== undefined;
  }
  const result = strictQaReportResult(cwd, runId);
  return !result.ok
    && result.report !== undefined
    && typeof result.status === 'string'
    && /^blocked:(?:browser-unavailable|sandbox|usage-limit|timeout)$/.test(result.status)
    && !isQaBrowserBridgeEligible(result);
}

function dirHasFreshFile(dir: string, suffixes: readonly string[], minMtimeMs: number): boolean {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory() && dirHasFreshFile(p, suffixes, minMtimeMs)) return true;
      if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        if (minMtimeMs <= 0) return true;
        try {
          if (fs.statSync(p).mtimeMs + 1000 >= minMtimeMs) return true;
        } catch {
          // ignore unreadable candidates
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export function runHasQaEvidence(cwd: string, runId: string): boolean {
  // An explicit environment/browser blocker always wins, including for a run
  // that otherwise qualifies for the backend-only exemption.
  if (runHasExplicitBlockedQaOutcome(cwd, runId)) return false;
  // V2 is risk-derived for every surface, including API-only projects. Its
  // none/nonvisual contracts deliberately avoid a browser but still require
  // the stack-specific build/test/lint evidence, so backend-only is not an
  // exemption from the V2 report.
  if (runQaContractVersion(cwd, runId) === 2) {
    const result = strictQaReportV2Result(cwd, runId);
    if (!result.ok) return false;
    const testerFile = digestFile(cwd, runId, 'tester.md');
    if (!testerFile) return false;
    try {
      // "Did the tester re-attest AFTER this report" — normally anchored on the
      // sidecar file mtime. When the verdict is attestation-backed
      // (`acceptedGeneratedAtMs`), the anchor is the MINIMUM of the file mtime
      // and the hash-pinned generatedAt of the ACCEPTED report: the file mtime
      // can be newer solely because the runtime itself rewrote report-v2.json
      // after acceptance (a persisted gate rejection against a drifted build
      // tree — observed 14cl), and that self-rewrite must not retroactively
      // un-attest the tester. A genuinely NEW report moves both timestamps
      // forward, so it still requires a fresh tester verdict.
      const reportMtimeMs = Math.floor(fs.statSync(result.reportPath).mtimeMs);
      const reportAnchorMs = result.acceptedGeneratedAtMs !== undefined
        ? Math.min(reportMtimeMs, result.acceptedGeneratedAtMs)
        : reportMtimeMs;
      return Math.floor(fs.statSync(testerFile).mtimeMs) >= reportAnchorMs;
    } catch {
      return false;
    }
  }
  // Backend-only is an exact per-run property: the current run has no frontend
  // implementer digest. Project stack detection and prose N/A claims cannot exempt
  // a run after the frontend implementer has emitted its digest.
  if (!anyDigestSpellingHasContent(cwd, runId, 'frontend.md')) return true;
  if (runUsesStrictQaContract(cwd, runId)) {
    const result = strictQaReportResult(cwd, runId);
    if (!result.ok) return false;
    // Every report is provisional until the tester role re-emits its canonical
    // verdict after the report. This covers both a tester-authored matrix and a
    // parent-browser replacement, and prevents a stale digest/report pairing
    // after a same-run implementation fix.
    const testerFile = digestFile(cwd, runId, 'tester.md');
    if (!testerFile) return false;
    try {
      const testerMtimeMs = Math.floor(fs.statSync(testerFile).mtimeMs);
      const reportMtimeMs = Math.floor(fs.statSync(result.reportPath).mtimeMs);
      // The canonical file write-time establishes whether the tester re-attested
      // after this report. generatedAt is already validated for freshness, but
      // may legitimately be a few milliseconds ahead of the filesystem clock.
      return testerMtimeMs >= reportMtimeMs;
    } catch {
      return false;
    }
  }

  // Pre-contract ledgers keep their historical artifact behavior for compatibility,
  // except that an explicit structured/digest blocker can never be interpreted as
  // passing evidence.
  const memoryDir = '.traffic' + '-one';
  const qaDir = path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId));
  if (fs.existsSync(path.join(qaDir, 'report.json'))) return true;
  if (dirHasAnyFile(qaDir, ['.png', '.jpg', '.jpeg', '.webp', '.json'])) return true;
  const lighthouseDir = path.join(cwd, memoryDir, 'reports', 'lighthouse');
  if (dirHasFreshFile(lighthouseDir, ['.json', '.html'], runCreatedAtMs(cwd, runId))) return true;
  return false;
}

export function runLedgerStatusRecord(cwd: string, runId: string): {
  status: RunLedgerStatus | null;
  outcome: RunLedgerOutcome | null;
  /**
   * WHY `status` is null, for the one caller that cannot treat the three
   * reasons alike. `status: null` folds "there is no ledger" together with
   * "there is one and we could not read it", which is the right fold for every
   * gate here — all of them fail closed and a fold toward null is closed. It is
   * the wrong fold for shared/retention.ts, whose failure direction is a
   * DELETE: a run whose `run.json` was torn by a crashed write or a merge looks
   * exactly like a run that never had one, and the mint-window arm that spares
   * a live run then never fires. The kinds are `readJsonResult`'s own, not a
   * second taxonomy — `absent` really is absent, and only `corrupt`/
   * `unreadable` mean we could not tell.
   */
  legibility: JsonRead<unknown>['kind'];
} {
  const read = readJsonResult<unknown>(runLedgerFile(cwd, runId));
  const ledger = obj(read.kind === 'ok' ? read.value : null);
  const status = effectiveLegacyRunStatus(ledger);
  const outcome = effectiveLegacyRunOutcome(ledger);
  return {
    status: isRunLedgerStatus(status) ? status : null,
    outcome: isRunLedgerOutcome(outcome) ? outcome : null,
    legibility: read.kind,
  };
}

export function shipperDigestCompleted(cwd: string, runId: string): boolean {
  if (digestVerdictsConflict(cwd, runId, 'shipper.md')) return false;
  const shipper = readDigest(cwd, runId, 'shipper.md');
  const shipped = /(?:^|\n)\s*(?:verdict\s*:\s*)?SHIPPED\s*(?:\r?\n|$)/im.test(shipper);
  const failed = /(?:^|\n)\s*(?:verdict\s*:\s*)?FAILED\s*(?:\r?\n|$)/im.test(shipper);
  return shipped && !failed;
}

// exactDigestVerdict lives in shared/digest-verdict.ts so the readiness
// gates (digestClaimsVerdict) parse the same lines settlement does.

// True when run <runId>'s verification has TERMINALLY settled: a shipper digest
// (written only post-deploy, after reviewer+tester already passed) exists, OR
// reviewer PASSED and tester PASSED. The canonical tester token is `TESTS_GREEN`,
// but legacy orchestrators deviated (observed live: gpt-5.5 wrote the tester digest
// with `verdict: APPROVED`), so pre-contract runs retain that compatibility token.
// Contract-v1 runs require `TESTS_GREEN`. In both cases a NON-terminal token
// (`TESTS_FAILING` or delegated-but-unverified `DELEGATED_OK`) wins. A
// `CHANGES_REQUESTED` reviewer or a
// mid-fix-cycle `TESTS_FAILING` tester stays non-terminal. The "passing token present
// AND non-terminal token absent" shape avoids a false positive from a digest that
// merely mentions the other token.
export function testerDigestPassedForRun(cwd: string, runId: string, tester: string): boolean {
  if (digestVerdictsConflict(cwd, runId, 'tester.md')) return false;
  if (runUsesStrictQaContract(cwd, runId)) {
    return exactDigestVerdict(tester) === 'TESTS_GREEN';
  }
  const passingToken = /\b(TESTS_GREEN|APPROVED)\b/.test(tester);
  return passingToken && !/\b(TESTS_FAILING|DELEGATED_OK)\b/.test(tester);
}

export function reviewerDigestApprovedForRun(cwd: string, runId: string, reviewer: string): boolean {
  // Both spellings present with DISAGREEING verdicts = no authoritative verdict. Fail
  // closed rather than letting mtime crown a `senior-reviewer.md` APPROVED over a
  // canonical CHANGES_REQUESTED (which would settle/rotate a rejected run).
  if (digestVerdictsConflict(cwd, runId, 'reviewer.md')) return false;
  if (runUsesStrictQaContract(cwd, runId)) {
    return exactDigestVerdict(reviewer) === 'APPROVED';
  }
  return /\bAPPROVED\b/.test(reviewer) && !/\bCHANGES_REQUESTED\b/.test(reviewer);
}

/**
 * The machine verdict token this run's <name> digest resolves to, or null when
 * no authoritative verdict exists (no digest, no verdict line, or conflicting
 * verdicts across spellings/lines). Diagnostic only — settlement decisions go
 * through the role-specific predicates above; this exists so a refused
 * transition can NAME what the parser actually saw instead of "rejected".
 */
export function runDigestVerdict(cwd: string, runId: string, name: string): string | null {
  if (digestVerdictsConflict(cwd, runId, name)) return null;
  return exactDigestVerdict(readDigest(cwd, runId, name));
}

export function runCompletionEvidenceAllows(
  cwd: string,
  runId: string,
  outcome: RunLedgerOutcome | undefined,
): boolean {
  if (activeRunClaimCount(cwd, runId) > 0) return false;
  if (outcome === 'shipped') {
    if (!shipperDigestCompleted(cwd, runId)) return false;
    const ledger = runLedgerStatusRecord(cwd, runId);
    // A verified run may advance to shipped. A direct active→shipped
    // transition must still prove reviewer, tester, and QA first; the shipper
    // digest alone cannot manufacture verification.
    if (ledger.status === 'completed'
      && (ledger.outcome === 'verified' || ledger.outcome === 'shipped')) return true;
  } else if (outcome !== 'verified') {
    return false;
  }
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  return reviewerDigestApprovedForRun(cwd, runId, reviewer)
    && testerDigestPassedForRun(cwd, runId, tester)
    && runHasQaEvidence(cwd, runId);
}

export function buildRunReachedTerminalVerdict(cwd: string, runId: string): boolean {
  const ledger = runLedgerStatusRecord(cwd, runId);
  if (ledger.status === 'blocked' || ledger.status === 'failed') return false;
  if (ledger.status === 'completed' && (ledger.outcome === 'verified' || ledger.outcome === 'shipped')) return true;
  if (shipperDigestCompleted(cwd, runId)) return true;
  const reviewer = readDigest(cwd, runId, 'reviewer.md');
  const tester = readDigest(cwd, runId, 'tester.md');
  const reviewerApproved = reviewerDigestApprovedForRun(cwd, runId, reviewer);
  const testerPassed = testerDigestPassedForRun(cwd, runId, tester);
  return reviewerApproved && testerPassed && runHasQaEvidence(cwd, runId);
}

export function runReachedTerminalVerdict(cwd: string, runId: unknown): boolean {
  if (typeof runId !== 'string' || !runId) return false;
  return maintenanceRunReachedTerminal(cwd, runId) || buildRunReachedTerminalVerdict(cwd, runId);
}

type RunVerificationState = 'terminal' | 'not-started' | 'nonterminal' | 'empty';

export function runProducedImplementerOutput(cwd: string, runId: string): boolean {
  return anyDigestSpellingHasContent(cwd, runId, 'frontend.md')
    || anyDigestSpellingHasContent(cwd, runId, 'backend.md');
}

function runHasQaReportFile(cwd: string, runId: string): boolean {
  const memoryDir = '.traffic' + '-one';
  const qaDir = path.join(cwd, memoryDir, 'reports', 'qa', safePathSegment(runId));
  return fs.existsSync(path.join(qaDir, 'report.json'))
    || fs.existsSync(path.join(qaDir, 'report-v2.json'));
}

// Machine-readable current-run classification for prompt-boundary lifecycle
// settlement. A verifier artifact without the complete terminal combination is
// always nonterminal, including delegated-only, requested-changes, failing, and
// blocked QA results.
export function runVerificationState(cwd: string, runId: unknown): RunVerificationState {
  if (typeof runId !== 'string' || !runId) return 'empty';
  const ledger = runLedgerStatusRecord(cwd, runId);
  if (ledger.status === 'blocked' || ledger.status === 'failed') return 'nonterminal';
  // Maintenance outcome markers have their own routing semantics. They must not
  // make a build terminal: build settlement is only strict verification or shipper.
  if (buildRunReachedTerminalVerdict(cwd, runId)) return 'terminal';
  const implementerOutput = runProducedImplementerOutput(cwd, runId);
  const verifierOutput = anyDigestSpellingHasContent(cwd, runId, 'reviewer.md')
    || anyDigestSpellingHasContent(cwd, runId, 'tester.md')
    || anyDigestSpellingHasContent(cwd, runId, 'shipper.md')
    || runHasQaReportFile(cwd, runId);
  if (verifierOutput) return 'nonterminal';
  return implementerOutput ? 'not-started' : 'empty';
}

