// src/shared/qa-report-v2-schema.ts
// QaReportV2 schema: versions, every V2 interface, bounds, and the strict
// field parsers. Runtime validation lives in the siblings; the public surface
// is re-exported by qa-report-v2.ts.

import * as path from 'path';
import { sha256 } from '../text';
import {
  type VerificationContractV2,
} from '../verification-contract';

const QA_REPORT_V2_SCHEMA_VERSION = 2 as const;
export const QA_BUILD_IDENTITY_PROBE_PATH = '/.traffic-one/qa-build-identity.json';
export const QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION = 1 as const;

type QaV2Status = 'passed' | 'failed' | 'blocked-environment';

interface QaV2Check {
  id: string;
  status: 'passed' | 'failed' | 'not-applicable';
  summary?: string;
  notApplicable?: QaNotApplicableReason;
}

/**
 * WHY a `not-applicable` check carries no verdict — the FACT the producer knew,
 * carried to the validator instead of a sentence a reader can reconstruct it
 * from.
 *
 * `not-applicable` is one status over four situations that are not alike, and
 * only ONE of them may be excused. Until this field existed the validator told
 * them apart with two regular expressions over the summary (`not run:` plus
 * `declares no|could not be executed`), and THREE producers wrote prose
 * satisfying both for two incompatible reasons: the project declaring no such
 * command (stack.ts's resolution arm — the intended one), a declared command
 * whose binary is absent or unexecutable (`kind: 'unavailable'`), and a
 * declared command the shell could not find (exit 127). The last two mean a
 * test command was declared and ZERO tests ran, and both settled the run green
 * on the most common project shape in this repository — measured, on real
 * contract-compiled projects: a Node api-only project whose `npm test` exits
 * 127, and a Python project with `pytest` absent or without its execute bit.
 *
 * `resolveStackCommand` KNOWS the difference at the moment it decides; the
 * distinction was flattened into a sentence on the way out. This field is the
 * fact travelling instead, so the exemption keys on the resolution result and
 * no regular expression over prose can decide it.
 *
 *   no-command-declared    nothing to run: no manifest script and no pinned
 *                          language default. THE ONLY EXCUSABLE ONE.
 *   declared-not-runnable  declared, and its target is absent, not executable,
 *                          or not on PATH. An environment gap: something WAS
 *                          meant to run and did not.
 *   cut-short              started (or was refused a process slot) and produced
 *                          no verdict in either direction.
 *   evidence-not-captured  the browser or native surface this check reads never
 *                          produced evidence for it.
 *
 * The three that are not excusable are enumerated rather than left to the
 * field's ABSENCE, so "a runner-produced not-applicable check always says why"
 * is an invariant a test can assert over every producer
 * (__tests__/exemption-provenance.test.ts) instead of a property that holds
 * because nobody wrote the other arm. Absence still means "not excusable" — a
 * report from a runner older than this field, or a hand-authored one, carries
 * nothing here and is refused the exemption, which is the fail-closed
 * direction and the one the old prose predicate got backwards.
 */
export const QA_NOT_APPLICABLE_REASONS = [
  'no-command-declared', 'declared-not-runnable', 'cut-short', 'evidence-not-captured',
] as const;

export type QaNotApplicableReason = typeof QA_NOT_APPLICABLE_REASONS[number];

/**
 * What a reason MEANS to the two rules that read one, as a closed classification
 * a fifth reason cannot be added without deciding.
 *
 *   excusable    nothing was there to run. The exemption predicate's half of the
 *                condition; still not sufficient on its own — see
 *                `stackCommandUndeclared`.
 *   no-verdict   it should have produced a verdict and produced none. The
 *                blanket cut-short rule's half.
 *   not-excusable  everything else: reportable, never a pass, never signal death.
 *
 * A SWITCH WITH A `never` DEFAULT, and that is the whole point of the function
 * existing rather than two literals in two files. The enumeration above is a
 * runtime tuple with a runtime membership check in `parseCheck` and a `deepEqual`
 * test over its members, so a fifth member reds a test — but it reds NOTHING at
 * the two sites that decide, and those two fail in OPPOSITE directions. The
 * exemption predicate compared against the literal `'no-command-declared'`, so an
 * unclassified fifth reason was refused the exemption (fail closed, correct); the
 * blanket cut-short rule compared against the literal `'cut-short'`, so a fifth
 * reason denoting signal death slipped it (fail OPEN, and that is the direction
 * that costs). One reason cannot fail both ways at once unless the two rules key
 * on different things, which is exactly what two independent literals are.
 *
 * With this, adding a member to `QA_NOT_APPLICABLE_REASONS` and nothing else is a
 * COMPILE ERROR: `assertUnreachableReason` cannot be handed a value that is not
 * `never`. The author of the fifth reason must state which of the three it is,
 * and both rules follow from that statement instead of from two string
 * comparisons that happened to be written a hundred lines apart.
 */
export type QaNotApplicableDisposition = 'excusable' | 'no-verdict' | 'not-excusable';

function assertUnreachableReason(reason: never): QaNotApplicableDisposition {
  // Runtime arm for a report from a NEWER runner than this validator, which the
  // parser above refuses before reaching here — belt and braces, and it is the
  // fail-closed answer either way.
  void reason;
  return 'not-excusable';
}

export function notApplicableDisposition(
  reason: QaNotApplicableReason | undefined,
): QaNotApplicableDisposition {
  switch (reason) {
    // Absence is not excusable and not signal death: a report from a runner
    // older than the field, or a hand-authored one, says nothing and gets
    // nothing. This is the same fail-closed answer the field's own docblock
    // records, expressed once instead of at each call site.
    case undefined: return 'not-excusable';
    case 'no-command-declared': return 'excusable';
    case 'cut-short': return 'no-verdict';
    case 'declared-not-runnable': return 'not-excusable';
    case 'evidence-not-captured': return 'not-excusable';
    default: return assertUnreachableReason(reason);
  }
}

/**
 * The prefix a producer stamps on a `not-applicable` check summary when the
 * command it names STARTED, ran, and was killed before it could report — at its
 * timeout, or for overflowing its output bound.
 *
 * `not-applicable` is the only status the schema has for "no verdict was
 * observed", and it is shared by two situations that are not alike. A project
 * that declares no formatter genuinely has nothing to run, and
 * `validateQaReportV2` rightly excuses it. A test suite the runner SIGKILLed
 * mid-flight has everything to run and ran none of it, and excusing that
 * certifies untested source. This marker separates them IN THE PROSE A HUMAN
 * READS, and it lives beside the schema — not in either the producer or the
 * validator — because both sides must agree on the same string or the
 * distinction silently evaporates in one direction: a producer that stops
 * emitting it turns every cut-short check back into a free pass.
 *
 * IT IS NO LONGER WHAT THE EXEMPTION TURNS ON. `QA_NOT_APPLICABLE_REASONS`
 * below carries the same distinction as a FACT, and the validator keys on
 * that; a marker in a summary is a description of a decision rather than the
 * decision. The two are not independent guards and are not counted as such
 * anywhere — see the exemption predicate in index.ts, which says which one
 * decides and which one is defence in depth behind it.
 *
 * Deliberately not a new `status` value. The three-value union above is
 * consumed by settlement, the dimension roll-up and every gate; widening it is
 * a cross-cutting change, and it is not needed — "did not run" plus "and here
 * is why that is not excusable" already says exactly what happened.
 */
export const CHECK_INCONCLUSIVE_PREFIX = 'inconclusive:';

/**
 * The check whose absence the DISCLOSE decision is about.
 *
 * A list of one, named rather than inlined, because the population it stands for
 * is precise and the next reader will want to widen it: `stack-test` is the only
 * required id that can be excused for having no command AND whose absence means
 * no tests ran. Every other stack resolves a test command from a language
 * default (`go test ./...`, `cargo test`, `pytest -q`, `./gradlew test`,
 * `./mvnw test`), so the only shape reaching the exemption on this id is a Node
 * or plain-PHP project with a build script and no test script. `stack-lint` and
 * `stack-format` are on the same allowlist and are NOT here: a missing formatter
 * is not missing test evidence, and saying it is would make the disclosure fire
 * on nearly every run and mean nothing by the second week.
 */
export const TEST_EVIDENCE_CHECK_IDS = ['stack-test'] as const;

/**
 * Did this check set settle with its test evidence EXCUSED rather than measured?
 *
 * Derived from the checks by both the producer and the validator — the same
 * function, so the durable field and the user-facing advisory cannot disagree
 * about the same report. It is a description of the check array and nothing
 * else; the fact that makes it TRUE (a command the runtime confirmed does not
 * exist) is `stackCommandUndeclared`'s, and the exemption still turns on that.
 */
export function reportSettledWithoutTestEvidence(checks: readonly QaV2Check[]): boolean {
  return checks.some((check) => (TEST_EVIDENCE_CHECK_IDS as readonly string[]).includes(check.id)
    && check.status === 'not-applicable'
    && notApplicableDisposition(check.notApplicable) === 'excusable');
}

/**
 * Whether a check summary reports a step that was cut short rather than one
 * that never had anything to run. Case-insensitive so a summary that has been
 * through a prose normalizer still reads the same.
 */
export function inconclusiveCheckSummary(summary: unknown): boolean {
  return typeof summary === 'string'
    && summary.toLowerCase().includes(CHECK_INCONCLUSIVE_PREFIX);
}

export interface QaBuildIdentityV2 {
  runId: string;
  sourceHash: string;
  outputRoot: string;
  buildHash: string;
  pid: number;
  port: number;
  startedAt: string;
  url: string;
  fingerprint: string;
  servedFingerprint: string;
}

export interface QaServedBuildIdentityV1 {
  schemaVersion: 1;
  runId: string;
  sourceHash: string;
  buildHash: string;
  pid: number;
  port: number;
  startedAt: string;
  url: string;
  fingerprint: string;
}

export interface QaViewportV2 {
  width: number;
  status: 'passed' | 'failed';
  domAssertionsPassed: boolean;
  actionsPassed: boolean;
  routingPassed: boolean;
  hydrationPassed: boolean;
  consoleErrors: string[];
  networkErrors: string[];
  // Playwright step/navigation failures (timeouts, unreachable locators).
  // Optional and absent on pre-1.0.37 reports; absent means []. Kept separate
  // from consoleErrors so a click timeout is not misread as a page error.
  actionErrors?: string[];
  artifactAt: string;
  screenshotPath?: string;
}

interface QaRouteV2 {
  route: string;
  viewports: QaViewportV2[];
}

interface NativeQaEvidenceV2 {
  evidencePath: string;
}

/**
 * A NON-BROWSER gate verdict, recorded in the report itself.
 *
 * `requiredChecks` is a flat list of browser check ids, so a gate that is not a
 * browser check — the page-speed budget above all — had no slot in this schema
 * at all: the run's own artifact could say `"status":"passed"` with nine passing
 * checks while the performance contract it declared was failing on the evidence
 * beside it (observed 10co-e2e: performance 74 / LCP 4527ms against
 * `performanceMin: 90` / `lcpMaxMs: 2500`). `gates[]` is that slot, and
 * `persistGateRejection` is what makes the verdict durable.
 */
export interface QaGateV2 {
  id: string;
  status: 'passed' | 'failed';
  code: QaV2FailureCode;
  summary: string;
}

// Either a real evidence sidecar, or an explicit skip record: when the
// browser scenario fails, Lighthouse is not attempted — the report must SAY
// so instead of silently omitting the section (observed 8co: a
// performance-required run ended with no performance evidence and no trace of
// why). A skip record never satisfies `performance.required`.
interface LighthouseEvidenceV2 {
  evidencePath?: string;
  status?: 'skipped-scenario-failed';
  reason?: string;
}

export interface QaReportV2 {
  schemaVersion: typeof QA_REPORT_V2_SCHEMA_VERSION;
  runId: string;
  verificationContractHash: string;
  generatedAt: string;
  producer: 'senior-tester' | 'parent-runner';
  status: QaV2Status;
  sourceHash: string;
  checks: QaV2Check[];
  routes: QaRouteV2[];
  /** Non-browser gate verdicts. Optional: pre-1.0.40 reports carry none. */
  gates?: QaGateV2[];
  /**
   * This run settled with its test evidence EXCUSED rather than measured — the
   * product's DISCLOSE decision, at the top level of the durable artifact.
   *
   * Deliberately not buried in the `checks` array, and deliberately not a fifth
   * `notApplicable` reason. A later gate and a human both read this file, and
   * neither should have to know which check id carries the news or which member
   * of a closed per-check enumeration is the one that also means "tell someone".
   *
   * Optional: absent on every report older than this field, and omitted rather
   * than written `false` so the artifact carries a claim only when there is one.
   * `parseReport` refuses a value that contradicts the report's own checks —
   * see `reportSettledWithoutTestEvidence`.
   */
  settledWithoutTestEvidence?: boolean;
  /**
   * This run settled on a diff the runtime knows was PARTIAL, and this is what
   * it stepped over — the disclosure half of the decision to proceed instead of
   * refusing (`currentVerificationSourceHash`'s `qualification`).
   *
   * A string, not the boolean its `settledWithoutTestEvidence` neighbour is,
   * because the two disclosures are reconstructible to different degrees. "Which
   * test evidence was excused" is derivable from the `checks` array a reader
   * already has, so a boolean loses nothing. "What the diff could not see" is
   * derivable from NOTHING in this file — a boolean here would tell a reader that
   * something went unread and leave them no way to learn what, and naming the
   * file is the entire actionable content (gitignore it, or move the source out
   * of a directory called `dist`).
   *
   * PRESENCE is pinned by `evaluateQaReportV2`, in one direction only: a report
   * that proceeded on a qualified scan and omits this is refused
   * `scan-incomplete`, because that is a run reporting unqualified evidence it
   * does not have. The converse — a report carrying it when the live scan is now
   * clean — is NOT refused: the honest cause is a run that gitignored the
   * offending directory after publishing, and the stale claim errs toward saying
   * too much, which is the direction that cannot certify anything.
   */
  settledWithIncompleteScan?: string;
  machineEvidencePath?: string;
  build?: QaBuildIdentityV2;
  native?: NativeQaEvidenceV2;
  lighthouse?: LighthouseEvidenceV2;
  blockerSummary?: string;
}

export interface QaAcceptanceAttestationV1 {
  schemaVersion: typeof QA_ACCEPTANCE_ATTESTATION_SCHEMA_VERSION;
  runId: string;
  verificationContractHash: string;
  sourceHash: string;
  reportHash: string;
  evidenceHash: string;
  buildFingerprint: string;
  acceptedAt: string;
  attestationHash: string;
}

// Declared as a runtime list so a persisted gate row can be re-parsed strictly;
// the exported union is derived from it and is unchanged.
export const QA_V2_FAILURE_CODES = [
  'contract-missing',
  'report-missing',
  'invalid-json',
  'invalid-schema',
  'contract-mismatch',
  'source-mismatch',
  'scan-incomplete',
  'required-check-failed',
  'blocked-environment',
  'build-identity-invalid',
  'machine-evidence-invalid',
  'route-matrix-incomplete',
  'functional-failure',
  'screenshot-invalid',
  'native-evidence-invalid',
  'lighthouse-threshold-failed',
] as const;

export type QaV2FailureCode = typeof QA_V2_FAILURE_CODES[number];

export type QaDimensionStatus = 'passed' | 'failed' | 'advisory-warning' | 'not-required' | 'unknown';

/**
 * The QA verdict, split by what actually failed. Derived — never producer-
 * written — so the tester and the final gate cannot report contradictory
 * statuses for the same run.
 */
export interface QaDimensionsV1 {
  functionalQaStatus: QaDimensionStatus;
  accessibilityStatus: QaDimensionStatus;
  responsiveStatus: QaDimensionStatus;
  lighthouseStatus: QaDimensionStatus;
  overallStatus: 'passed' | 'failed';
}

interface QaV2ValidationAccepted {
  ok: true;
  report: QaReportV2;
  contract: VerificationContractV2;
  reportPath: string;
  advisories: string[];
  dimensions: QaDimensionsV1;
  /**
   * Set when the verdict is vouched for by the durable acceptance attestation
   * (`acceptanceRestoresReport`): the hash-pinned `generatedAt` of the ACCEPTED
   * report, in epoch ms. Tester-attestation freshness must anchor on this
   * instead of the sidecar file mtime, because the runtime itself may have
   * rewritten report-v2.json after acceptance (a persisted gate rejection
   * against a drifted build tree — observed 14cl), and that rewrite must not
   * retroactively un-attest a tester verdict written after the real report.
   */
  acceptedGeneratedAtMs?: number;
}

export interface QaV2ValidationRejected {
  ok: false;
  code: QaV2FailureCode;
  message: string;
  reportPath: string;
  report?: QaReportV2;
  contract?: VerificationContractV2;
  dimensions: QaDimensionsV1;
}

export type QaV2ValidationResult = QaV2ValidationAccepted | QaV2ValidationRejected;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]{1,500}$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
export const BUILD_START_TOLERANCE_MS = 1_000;

/**
 * Concrete schema violations behind a failed parse, so an invalid-schema
 * rejection can NAME the offending fields. "QA sidecar does not match
 * QaReportV2." named nothing — observed live (13cl): the tester hand-edited
 * the JSON blindly and re-submitted the same invalid sidecar 6+ times in 90
 * seconds. Diagnosis is the fix's entry point, so the collector records which
 * required fields are missing, which have the wrong type, and which unknown
 * keys appeared.
 */
export interface QaV2SchemaIssues {
  /** Stored violations, capped at MAX_STORED_SCHEMA_ISSUES; `total` keeps counting. */
  issues: string[];
  total: number;
}

export function newSchemaIssues(): QaV2SchemaIssues {
  return { issues: [], total: 0 };
}

const MAX_STORED_SCHEMA_ISSUES = 12;
export const QA_V2_SCHEMA_ISSUE_DISPLAY_CAP = 6;

type RecordIssue = (issue: string) => null;

function issueRecorder(collector?: QaV2SchemaIssues): { record: RecordIssue; failed: () => boolean } {
  let count = 0;
  const record: RecordIssue = (issue) => {
    count += 1;
    if (collector) {
      collector.total += 1;
      if (collector.issues.length < MAX_STORED_SCHEMA_ISSUES) collector.issues.push(issue);
    }
    return null;
  };
  return { record, failed: () => count > 0 };
}

/** Renders collected violations for a deny message, capped for readability. */
export function formatSchemaIssues(collector: QaV2SchemaIssues): string {
  if (collector.issues.length === 0) return 'the sidecar is not a JSON object';
  const shown = collector.issues.slice(0, QA_V2_SCHEMA_ISSUE_DISPLAY_CAP);
  const extra = collector.total - shown.length;
  return shown.join('; ') + (extra > 0 ? `; +${extra} more` : '');
}

/** "missing (required)" when the field is absent, the type requirement otherwise. */
function expectedIssue(value: unknown, field: string, requirement: string): string {
  return value === undefined ? `${field}: missing (required)` : `${field}: ${requirement}`;
}

// Key names come from an UNTRUSTED file and are echoed into deny prose: strip
// control characters and bound both each name and how many are listed.
function describeUnknownKeys(keys: string[]): string {
  const shown = keys.slice(0, QA_V2_SCHEMA_ISSUE_DISPLAY_CAP)
    .map((key) => Array.from(key.slice(0, 40), (ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f ? '?' : ch;
    }).join(''));
  const extra = keys.length - shown.length;
  return shown.join(', ') + (extra > 0 ? ` (+${extra} more)` : '');
}

export function qaReportV2Path(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'reports', 'qa', runId, 'report-v2.json');
}

export function qaAcceptanceAttestationPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'qa-acceptance-v1.json');
}

export function expectedBuildFingerprint(runId: string, sourceHash: string, buildHash: string): string {
  return sha256(`${runId}\0${sourceHash}\0${buildHash}`);
}

export function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeString(value: unknown, max = 500): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && SAFE_TEXT_RE.test(value);
}

export function safeRelativePath(value: unknown, max = 4_096): value is string {
  return safeString(value, max)
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !/[*?[\]{};]/.test(value)
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length <= 2_000)) return null;
  return [...value] as string[];
}

function parseCheck(value: unknown, at: string, record: RecordIssue): QaV2Check | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  if (!safeString(value.id, 160)) return record(expectedIssue(value.id, `${at}.id`, 'must be a non-empty string without control characters (max 160 chars)'));
  if (!['passed', 'failed', 'not-applicable'].includes(String(value.status))) {
    return record(expectedIssue(value.status, `${at}.status`, 'must be "passed", "failed", or "not-applicable"'));
  }
  if (value.summary !== undefined && !safeString(value.summary)) {
    return record(`${at}.summary: must be a non-empty string without control characters (max 500 chars)`);
  }
  // An unrecognized reason is REFUSED rather than dropped, and a reason on a
  // check that reached a verdict is refused too. Dropping either would let a
  // report through whose exemption claim this parser silently rewrote — and
  // silently rewriting the field the exemption keys on is the whole defect
  // class the field exists to close.
  if (value.notApplicable !== undefined) {
    if (!(QA_NOT_APPLICABLE_REASONS as readonly string[]).includes(String(value.notApplicable))) {
      return record(`${at}.notApplicable: must be one of ${QA_NOT_APPLICABLE_REASONS.join(', ')}`);
    }
    if (value.status !== 'not-applicable') {
      return record(`${at}.notApplicable: allowed only on a "not-applicable" check`);
    }
  }
  return {
    id: value.id,
    status: value.status as QaV2Check['status'],
    ...(typeof value.summary === 'string' ? { summary: value.summary } : {}),
    ...(value.notApplicable === undefined
      ? {}
      : { notApplicable: value.notApplicable as QaNotApplicableReason }),
  };
}

function parseGate(value: unknown, at: string, record: RecordIssue): QaGateV2 | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  const unknown = Object.keys(value).filter((key) => !['id', 'status', 'code', 'summary'].includes(key));
  if (unknown.length > 0) return record(`${at}: unknown key${unknown.length === 1 ? '' : 's'} ${describeUnknownKeys(unknown)}`);
  if (!safeString(value.id, 160)) return record(expectedIssue(value.id, `${at}.id`, 'must be a non-empty string without control characters (max 160 chars)'));
  if (!['passed', 'failed'].includes(String(value.status))) {
    return record(expectedIssue(value.status, `${at}.status`, 'must be "passed" or "failed"'));
  }
  if (!(QA_V2_FAILURE_CODES as readonly string[]).includes(String(value.code))) {
    return record(expectedIssue(value.code, `${at}.code`, 'must be a known QA failure code'));
  }
  if (!safeString(value.summary)) return record(expectedIssue(value.summary, `${at}.summary`, 'must be a non-empty string without control characters (max 500 chars)'));
  return {
    id: value.id,
    status: value.status as QaGateV2['status'],
    code: value.code as QaV2FailureCode,
    summary: value.summary,
  };
}

function parseViewport(value: unknown, at: string, record: RecordIssue): QaViewportV2 | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  if (!Number.isInteger(value.width) || Number(value.width) < 240 || Number(value.width) > 4_000) {
    return record(expectedIssue(value.width, `${at}.width`, 'must be an integer between 240 and 4000'));
  }
  if (!['passed', 'failed'].includes(String(value.status))) {
    return record(expectedIssue(value.status, `${at}.status`, 'must be "passed" or "failed"'));
  }
  if (typeof value.domAssertionsPassed !== 'boolean') return record(expectedIssue(value.domAssertionsPassed, `${at}.domAssertionsPassed`, 'must be a boolean'));
  if (typeof value.actionsPassed !== 'boolean') return record(expectedIssue(value.actionsPassed, `${at}.actionsPassed`, 'must be a boolean'));
  if (typeof value.routingPassed !== 'boolean') return record(expectedIssue(value.routingPassed, `${at}.routingPassed`, 'must be a boolean'));
  if (typeof value.hydrationPassed !== 'boolean') return record(expectedIssue(value.hydrationPassed, `${at}.hydrationPassed`, 'must be a boolean'));
  if (isoMs(value.artifactAt) === null) {
    return record(expectedIssue(value.artifactAt, `${at}.artifactAt`, 'must be an ISO-8601 UTC instant (e.g. 2026-01-01T12:00:00.000Z)'));
  }
  const consoleErrors = stringArray(value.consoleErrors);
  if (!consoleErrors) return record(expectedIssue(value.consoleErrors, `${at}.consoleErrors`, 'must be an array of strings'));
  const networkErrors = stringArray(value.networkErrors);
  if (!networkErrors) return record(expectedIssue(value.networkErrors, `${at}.networkErrors`, 'must be an array of strings'));
  const actionErrors = value.actionErrors === undefined ? undefined : stringArray(value.actionErrors);
  if (value.actionErrors !== undefined && !actionErrors) {
    return record(`${at}.actionErrors: must be an array of strings`);
  }
  if (value.screenshotPath !== undefined && !safeRelativePath(value.screenshotPath)) {
    return record(`${at}.screenshotPath: must be a project-relative path (no absolute paths, "..", "\\", or glob characters)`);
  }
  return {
    width: Number(value.width),
    status: value.status as QaViewportV2['status'],
    domAssertionsPassed: value.domAssertionsPassed,
    actionsPassed: value.actionsPassed,
    routingPassed: value.routingPassed,
    hydrationPassed: value.hydrationPassed,
    consoleErrors,
    networkErrors,
    ...(actionErrors ? { actionErrors } : {}),
    artifactAt: value.artifactAt as string,
    ...(typeof value.screenshotPath === 'string' ? { screenshotPath: value.screenshotPath } : {}),
  };
}

function parseRoute(value: unknown, at: string, record: RecordIssue): QaRouteV2 | null {
  // Evidence is keyed by the CONTRACT route, so `*` (the router-idiomatic
  // catch-all) is a legal identity here even though it is never a URL — the
  // runner probes it through a concrete `startPath`.
  if (!isRecord(value)) return record(`${at}: must be an object`);
  if (!safeString(value.route, 2_048) || !(value.route === '*' || value.route.startsWith('/'))) {
    return record(expectedIssue(value.route, `${at}.route`, 'must be "*" or a path starting with "/"'));
  }
  if (!Array.isArray(value.viewports)) {
    return record(expectedIssue(value.viewports, `${at}.viewports`, 'must be an array of viewport objects'));
  }
  const viewports = value.viewports.map((viewport, index) => parseViewport(viewport, `${at}.viewports[${index}]`, record));
  if (viewports.some((viewport) => !viewport)) return null;
  return { route: value.route, viewports: viewports as QaViewportV2[] };
}

const HEX_64 = 'must be a 64-char lowercase sha256 hex string';

function parseBuild(value: unknown, at: string, record: RecordIssue): QaBuildIdentityV2 | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  if (!safeString(value.runId, 128)) return record(expectedIssue(value.runId, `${at}.runId`, 'must be a non-empty string (max 128 chars)'));
  if (!SHA256_HEX_RE.test(String(value.sourceHash))) return record(expectedIssue(value.sourceHash, `${at}.sourceHash`, HEX_64));
  if (!safeRelativePath(value.outputRoot)) return record(expectedIssue(value.outputRoot, `${at}.outputRoot`, 'must be a project-relative path'));
  if (!SHA256_HEX_RE.test(String(value.buildHash))) return record(expectedIssue(value.buildHash, `${at}.buildHash`, HEX_64));
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) {
    return record(expectedIssue(value.pid, `${at}.pid`, 'must be a positive integer'));
  }
  if (!Number.isSafeInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65_535) {
    return record(expectedIssue(value.port, `${at}.port`, 'must be an integer between 1 and 65535'));
  }
  if (isoMs(value.startedAt) === null) {
    return record(expectedIssue(value.startedAt, `${at}.startedAt`, 'must be an ISO-8601 UTC instant (e.g. 2026-01-01T12:00:00.000Z)'));
  }
  if (!safeString(value.url, 2_048)) return record(expectedIssue(value.url, `${at}.url`, 'must be a non-empty string (max 2048 chars)'));
  if (!SHA256_HEX_RE.test(String(value.fingerprint))) return record(expectedIssue(value.fingerprint, `${at}.fingerprint`, HEX_64));
  if (!SHA256_HEX_RE.test(String(value.servedFingerprint))) return record(expectedIssue(value.servedFingerprint, `${at}.servedFingerprint`, HEX_64));
  return value as unknown as QaBuildIdentityV2;
}

export function parseServedBuild(value: unknown): QaServedBuildIdentityV1 | null {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !safeString(value.runId, 128)
    || !/^[a-f0-9]{64}$/.test(String(value.sourceHash))
    || !safeString(value.buildHash, 256)
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) <= 0
    || !Number.isSafeInteger(value.port)
    || Number(value.port) < 1
    || Number(value.port) > 65_535
    || isoMs(value.startedAt) === null
    || !safeString(value.url, 2_048)
    || !/^[a-f0-9]{64}$/.test(String(value.fingerprint))) return null;
  return value as unknown as QaServedBuildIdentityV1;
}

function parseNative(value: unknown, at: string, record: RecordIssue): NativeQaEvidenceV2 | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  const unknown = Object.keys(value).filter((key) => key !== 'evidencePath');
  if (unknown.length > 0) return record(`${at}: unknown key${unknown.length === 1 ? '' : 's'} ${describeUnknownKeys(unknown)}`);
  if (!safeRelativePath(value.evidencePath)) {
    return record(expectedIssue(value.evidencePath, `${at}.evidencePath`, 'must be a project-relative path'));
  }
  return { evidencePath: value.evidencePath };
}

function parseLighthouse(value: unknown, at: string, record: RecordIssue): LighthouseEvidenceV2 | null {
  if (!isRecord(value)) return record(`${at}: must be an object`);
  const unknown = Object.keys(value).filter((key) => !['evidencePath', 'status', 'reason'].includes(key));
  if (unknown.length > 0) return record(`${at}: unknown key${unknown.length === 1 ? '' : 's'} ${describeUnknownKeys(unknown)}`);
  const hasPath = value.evidencePath !== undefined;
  const hasStatus = value.status !== undefined;
  if (!hasPath && !hasStatus) return record(`${at}: must set evidencePath or status`);
  if (hasPath && !safeRelativePath(value.evidencePath)) {
    return record(`${at}.evidencePath: must be a project-relative path`);
  }
  if (hasStatus && value.status !== 'skipped-scenario-failed') {
    return record(`${at}.status: must be "skipped-scenario-failed"`);
  }
  if (value.reason !== undefined && (!hasStatus || !safeString(value.reason))) {
    return record(`${at}.reason: allowed only alongside status and must be a non-empty string (max 500 chars)`);
  }
  return {
    ...(hasPath ? { evidencePath: value.evidencePath as string } : {}),
    ...(hasStatus ? { status: 'skipped-scenario-failed' as const } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
  };
}

const REPORT_KEYS: readonly string[] = [
  'schemaVersion',
  'runId',
  'verificationContractHash',
  'generatedAt',
  'producer',
  'status',
  'sourceHash',
  'checks',
  'routes',
  'gates',
  'settledWithoutTestEvidence',
  'settledWithIncompleteScan',
  'machineEvidencePath',
  'build',
  'native',
  'lighthouse',
  'blockerSummary',
];

// Every violation is recorded and checking CONTINUES, so one rejection names
// every offending top-level field at once instead of one per retry. Unknown
// top-level keys are violations too: the runtime publisher emits only the
// typed field set, so an unknown key is a hand-authored report's typo — the
// exact thing the message must name (a misspelled optional key used to be
// silently dropped and resurface later as a different failure code).
export function parseReport(value: unknown, collector?: QaV2SchemaIssues): QaReportV2 | null {
  const { record, failed } = issueRecorder(collector);
  if (!isRecord(value)) return record('report: must be a JSON object');
  const unknownKeys = Object.keys(value).filter((key) => !REPORT_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    record(`unknown top-level key${unknownKeys.length === 1 ? '' : 's'}: ${describeUnknownKeys(unknownKeys)}`);
  }
  if (value.schemaVersion !== QA_REPORT_V2_SCHEMA_VERSION) {
    record(expectedIssue(value.schemaVersion, 'schemaVersion', 'must be the number 2'));
  }
  if (!safeString(value.runId, 128)) record(expectedIssue(value.runId, 'runId', 'must be a non-empty string (max 128 chars)'));
  if (!SHA256_HEX_RE.test(String(value.verificationContractHash))) {
    record(expectedIssue(value.verificationContractHash, 'verificationContractHash', HEX_64));
  }
  if (isoMs(value.generatedAt) === null) {
    record(expectedIssue(value.generatedAt, 'generatedAt', 'must be an ISO-8601 UTC instant (e.g. 2026-01-01T12:00:00.000Z)'));
  }
  if (!['senior-tester', 'parent-runner'].includes(String(value.producer))) {
    record(expectedIssue(value.producer, 'producer', 'must be "senior-tester" or "parent-runner"'));
  }
  if (!['passed', 'failed', 'blocked-environment'].includes(String(value.status))) {
    record(expectedIssue(value.status, 'status', 'must be "passed", "failed", or "blocked-environment"'));
  }
  if (!SHA256_HEX_RE.test(String(value.sourceHash))) record(expectedIssue(value.sourceHash, 'sourceHash', HEX_64));
  if (value.machineEvidencePath !== undefined && !safeRelativePath(value.machineEvidencePath)) {
    record('machineEvidencePath: must be a project-relative path (no absolute paths, "..", "\\", or glob characters)');
  }
  if (value.blockerSummary !== undefined && !safeString(value.blockerSummary)) {
    record('blockerSummary: must be a non-empty string without control characters (max 500 chars)');
  }
  const checks = Array.isArray(value.checks)
    ? value.checks.map((check, index) => parseCheck(check, `checks[${index}]`, record))
    : record(expectedIssue(value.checks, 'checks', 'must be an array of check objects'));
  const routes = Array.isArray(value.routes)
    ? value.routes.map((route, index) => parseRoute(route, `routes[${index}]`, record))
    : record(expectedIssue(value.routes, 'routes', 'must be an array of route objects'));
  const gates = value.gates === undefined
    ? undefined
    : Array.isArray(value.gates)
      ? value.gates.map((gate, index) => parseGate(gate, `gates[${index}]`, record))
      : record(expectedIssue(value.gates, 'gates', 'must be an array of gate objects'));
  // PINNED TO THE CHECKS, in both directions, for the same reason the reason
  // field is: a disclosure a report may set independently of what it reports is
  // a second answer to one question, and the next reader would not know which
  // one to believe. A report claiming the disclosure it does not owe, or
  // suppressing the one it does, is refused rather than silently corrected.
  // Absence is not a claim and stays legal — that is every report older than
  // this field.
  if (value.settledWithoutTestEvidence !== undefined) {
    if (typeof value.settledWithoutTestEvidence !== 'boolean') {
      record(expectedIssue(value.settledWithoutTestEvidence, 'settledWithoutTestEvidence', 'must be a boolean'));
    } else if (Array.isArray(checks)
      && checks.every((check): check is QaV2Check => Boolean(check))
      && value.settledWithoutTestEvidence !== reportSettledWithoutTestEvidence(checks)) {
      record('settledWithoutTestEvidence: must agree with the checks it summarises '
        + `(checks say ${reportSettledWithoutTestEvidence(checks)})`);
    }
  }
  // Not pinned HERE, unlike its neighbour above, and the difference is not an
  // omission: what the diff could not see is a fact about the live worktree, so
  // there is nothing in these bytes to check it against. `evaluateQaReportV2`
  // holds it to `currentVerificationSourceHash`, which is the only party that
  // knows. This parser's job is the shape.
  if (value.settledWithIncompleteScan !== undefined && !safeString(value.settledWithIncompleteScan)) {
    record(expectedIssue(
      value.settledWithIncompleteScan,
      'settledWithIncompleteScan',
      'must be a non-empty string without control characters (max 500 chars)',
    ));
  }
  const build = value.build === undefined ? undefined : parseBuild(value.build, 'build', record);
  const native = value.native === undefined ? undefined : parseNative(value.native, 'native', record);
  const lighthouse = value.lighthouse === undefined ? undefined : parseLighthouse(value.lighthouse, 'lighthouse', record);
  if (failed() || !checks || !routes) return null;
  return {
    schemaVersion: 2,
    runId: value.runId as string,
    verificationContractHash: value.verificationContractHash as string,
    generatedAt: value.generatedAt as string,
    producer: value.producer as QaReportV2['producer'],
    status: value.status as QaV2Status,
    sourceHash: value.sourceHash as string,
    checks: checks as QaV2Check[],
    routes: routes as QaRouteV2[],
    ...(gates ? { gates: gates as QaGateV2[] } : {}),
    ...(typeof value.settledWithoutTestEvidence === 'boolean'
      ? { settledWithoutTestEvidence: value.settledWithoutTestEvidence }
      : {}),
    ...(typeof value.settledWithIncompleteScan === 'string'
      ? { settledWithIncompleteScan: value.settledWithIncompleteScan }
      : {}),
    ...(typeof value.machineEvidencePath === 'string'
      ? { machineEvidencePath: value.machineEvidencePath }
      : {}),
    ...(build ? { build } : {}),
    ...(native ? { native } : {}),
    ...(lighthouse ? { lighthouse } : {}),
    ...(typeof value.blockerSummary === 'string' ? { blockerSummary: value.blockerSummary } : {}),
  };
}
