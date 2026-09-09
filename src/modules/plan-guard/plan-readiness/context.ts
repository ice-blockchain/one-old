// src/modules/plan-guard/plan-readiness/context.ts
// Shared shapes for the readiness gates: the Block prose contract, digest
// path regexes, and collapse-scan constants.

import * as fs from 'fs';
import * as path from 'path';

import { STATE_DIR_SEGMENT_SOURCE } from '../../../config/paths';
import { readRegularFile } from '../../../shared/bounded-read';
import { readJson, writeJson } from '../../../shared/fsjson';
import { appendQualityFindings } from '../../../shared/state/quality-findings';

export type Rec = Record<string, unknown>;
type Vars = Record<string, string | number | null | undefined>;
export type Block = (name: string, fallback: string, vars?: Vars) => string;

export const PLAN_FILE_RE = new RegExp(`(^|/)${STATE_DIR_SEGMENT_SOURCE}/plan\\.md$`);
export const ASSIGNMENTS_FILE_RE = new RegExp(`(^|/)${STATE_DIR_SEGMENT_SOURCE}/runs/[^/]+/assignments\\.json$`);
export const ARCHITECTURE_INPUT_RE = new RegExp(`(^|/)${STATE_DIR_SEGMENT_SOURCE}/runs/([^/]+)/architecture-input-v1\\.json$`);
export const RUN_RUNTIME_SIDECAR_RE = new RegExp(`^${STATE_DIR_SEGMENT_SOURCE}/runs/([^/]+)/(.+)$`);
// The project-level reset record, which this regex CANNOT match and must not be
// widened to: it sits one directory above any run id, deliberately, so that the
// reset it records cannot walk away from it and a retention sweep (which
// enumerates `runs/` through a `isDirectory()` filter) cannot collect it — both
// pinned in runners/traffic-one-reset/__tests__/obligations.test.ts. It gets its
// own path, its own gate and its own prose (`reset-record-owner-gate` in
// ./index.ts, plan-write/reset-record-shell.ts for the shell channels) because
// the sidecar gate's prose is about atomic publication of a run's own artifacts
// and prescribes a remedy — change ArchitectureInputV1, invoke the owning
// transition — that this file has no equivalent of. A previous round proposed
// widening the sidecar predicate to cover it; measured, that both mis-described
// the refusal and collided with the sidecar scan's live-run narrowing, which
// reads the record's own filename as a foreign run id and filters it back out.
export const RESET_RECORD_REL = '.traffic-one/runs/.resets.json';
export const RESET_RECORD_RE = new RegExp(`^${STATE_DIR_SEGMENT_SOURCE}/runs/\\.resets\\.json$`);
// NOTE: RUN_DIGEST_ARTIFACT_RE deliberately does NOT accept the `opencode-`
// prefix: it feeds the run-artifact OWNERSHIP gate, and edits to a plan-unit
// digest must stay writable by the parent. The COMPLETION regexes below DO
// accept `opencode-` so that ANY canonical verdict written into a plan-unit
// digest runs the full implementer gate battery (observed 8co:
// `opencode-frontend.md` matched no digest regex and bypassed every gate).
// The runner no longer emits a `normalize_to` hint on plan-unit digests — that
// hint was never applied in practice, and the file is now the accumulated
// ledger of ALL delegated units for the role, not the role's verdict — so this
// acceptance is defense in depth rather than the routine path.
export const RUN_DIGEST_ARTIFACT_RE =
  /^\.traffic-one\/digests\/([^/]+)\/(?:senior-)?(architect|frontend|backend|reviewer|tester|shipper)\.md$/;
export const QA_REPORT_ARTIFACT_RE = /^\.traffic-one\/reports\/qa\/([^/]+)\/report-v2\.json$/;
export const ARCHITECT_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/architect\.md$/;
export const FRONTEND_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?frontend\.md$/;
export const IMPLEMENTER_DIGEST_RE =
  /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?(frontend|backend)\.md$/;
export const REVIEWER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-)?reviewer\.md$/;
// The orchestrator's verbatim transcription of the reviewer's findings for one
// role's fix cycle (`senior-eng-orchestrator` SKILL.md, "Fix-cycle follow-up"
// step 1). Same content, second surface — the satisfiability gate reads both,
// because the reviewer's digest and this file are the only two places a finding
// becomes a durable order.
export const FIX_CYCLE_CONTEXT_RE =
  /(^|\/)\.traffic-one\/fix-cycles\/([^/]+)\/[^/]+\.md$/;
export const TESTER_DIGEST_RE = /(^|\/)\.traffic-one\/digests\/([^/]+)\/(?:senior-|opencode-)?tester\.md$/;
// Collapsed-source delivery guard. A single source line packing an entire
// component/route (observed 16c: apps/web/src/App.tsx held the whole app —
// Catalog, CoursePage, LessonPage, Dashboard, routing, data — as one-line
// functions up to 1722 chars, leaving every scaffolded pages/features/components
// dir empty; the frontend still reported IMPLEMENTED because build/typecheck
// pass on collapsed code). A hand-written code line does not approach this
// length; a long string/URL/data-URI has none of the statement/JSX punctuation
// required below, so the threshold is safe from false positives.
// Backend languages are here because collapse is a defect in every language, not
// just the frontend's — but they route to the RAW >500-char arm, never to
// `collapsedLineNumber`. That detector runs `lexicalMask`, a JS/TS lexer, which
// produces nonsense on Go or Python for exactly the reason CSS was left on the
// raw arm. The raw arm's predicate is pure punctuation counting (3+ `;` on one
// line), and packing statements onto a single line is precisely what REQUIRES
// explicit semicolons in both Go and Python — so it fits them without a lexer.
export const COLLAPSE_SOURCE_RE = /\.(?:tsx?|jsx?|mjs|cjs|css|scss|go|py)$/;
// Dependency and build roots for every language above. Without `vendor`/`.venv`
// the Go and Python arms would walk vendored dependencies and blow
// COLLAPSE_MAX_FILES, turning a clean project into STRUCT_SCAN_INCOMPLETE.
// `.svelte-kit`, `.nuxt` and `.angular` are the same class one framework over —
// each is a generated cache the framework writes on every dev/build run, and
// each holds hundreds of emitted `.js`/`.ts` files that COLLAPSE_SOURCE_RE
// claims — and `target` is the Rust/Maven/Gradle output root, which carries the
// wasm-pack and web-resource bundles for the same reason. The bound they blew is
// the file COUNT, not the verdict: the scan reports a truncation the project
// cannot act on, because the offending tree is not source anyone wrote.
export const COLLAPSE_SKIP_DIR_RE = /(^|\/)(node_modules|dist|build|coverage|out|target|\.turbo|\.next|\.nuxt|\.vite|\.svelte-kit|\.angular|generated|__generated__|vendor|\.venv|venv|__pycache__|site-packages|\.tox)(\/|$)/;
export const COLLAPSE_LINE_CHARS = 500;
export const COLLAPSE_MAX_FILES = 600;

/**
 * STRUCT_SCAN_INCOMPLETE, delivered rather than enforced. Every site that used
 * to refuse on a truncated scan calls this instead, and the prose it refused
 * with is the message it records — the operator-facing text did not move, only
 * the channel.
 *
 * What licenses the demotion is the verification contract, not this scan. An
 * incomplete baseline diff now pins `uiImpact` to `truncatedScanUiImpactFloor`,
 * the domain maximum, so a truncated run owes MORE evidence than a complete one
 * and can never settle `verified` cheaply (see the note above
 * `uiImpactWithPlannedFloor`). What the deny cost, meanwhile, was every run on a
 * project whose generated tree the writer cannot shrink: the bound is a file
 * COUNT, and "narrow generated/output roots" is not an instruction an
 * implementer holding a `.nuxt` cache can act on.
 *
 * Recorded is not silent. The ledger is what the completion digest consolidates
 * into the run's fix-cycle document, so the finding reaches a human on the same
 * surface every other batched quality finding does. It is banked under
 * `main-agent` rather than the writer: `consolidateQualityFindings` folds that
 * bucket into EVERY role's document, and a partial diff is a fact about the run
 * — the implementer and the reviewer both need it — not a note to whoever
 * happened to trip the scan. Attributing it to one role would also race the
 * consolidation that role's own completion digest has already performed.
 */
export function recordScanIncomplete(
  projectRoot: string,
  runId: string,
  message: string,
): void {
  appendQualityFindings(projectRoot, runId, 'main-agent', [{
    id: 'STRUCT_SCAN_INCOMPLETE',
    severity: 'warning',
    file: '<scan>',
    message,
  }]);
}

function scanBoundPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, '.traffic-one', 'runs', runId, 'scan-bound.json');
}

/**
 * A BOUNDED scan hit its hard bound during this run: the structure walk's file
 * cap, or COLLAPSE_MAX_FILES. Durable because the discovery and the compensation
 * happen in different hook invocations — the frontend digest trips the collapse
 * bound, the reviewer digest refreshes the verification contract — and the floor
 * must still be raised when it does.
 *
 * Separate from `scanComplete`, which is the baseline diff alone and may not
 * carry these: a `scanComplete: false` contract cannot be certified AT ALL
 * (validateQaReportV2 rejects it as `scan-incomplete`), so folding a generated
 * tree too large to walk into that field would replace a legible warning with an
 * unexplained QA rejection at the end of the run.
 *
 * First writer wins and the reason is kept; the flag is what the floor reads and
 * a second bound cannot make it truer. Best-effort like every record on this
 * path: a refused write leaves the floor unraised, which is why the structure
 * report keeps `truncationKind` as its own durable record of the same fact.
 *
 * Best-effort is deliberate rather than tolerated, and the three properties that
 * make it enough are worth naming because this file now decides how much browser
 * evidence a run owes:
 *
 *   - `writeJson` is tmp+rename with O_NOFOLLOW, so a reader sees the previous
 *     bytes or the new ones. A HALF-written record is not a reachable state
 *     through this writer; a truncated `scan-bound.json` can only be authored,
 *     and every channel that authors one is refused by
 *     `runtime-sidecar-owner-gate` (including the shell routes that name no file
 *     — see plan-write/sidecar-shell.ts).
 *   - The fact is a property of the TREE, not of the run, so it is re-derived
 *     rather than remembered. Both bounded scans re-derive, at different sites,
 *     and the second one had to be added: the structure walk's cap comes back on
 *     the next `runFullStructureScan` over the same source roots, but the
 *     COLLAPSE bound does not — `runFullStructureScan` performs no collapse walk
 *     at all, because `repairCollapsedSource` runs only on an implementer
 *     digest. That gap was a real window rather than a theoretical one: a bound
 *     recorded at the frontend digest reaches no PUBLISHED contract until every
 *     implementer role has delivered, and a record deleted inside that window
 *     left the run with no floor and nothing to re-derive it from.
 *     `refreshVerificationAfterImplementation` now runs its own bounded collapse
 *     walk before reading this flag, so a lost write costs the floor until the
 *     next refresh, not for the run.
 *   - Once the floor reaches a PUBLISHED contract it stops depending on this file
 *     at all — the weakening ratchet holds `uiImpact` up, and the pin lifts only
 *     when the bound actually clears (see refreshVerificationAfterImplementation).
 *
 * So an `fsync` here would buy durability across power loss for a fact the next
 * scan re-derives anyway, at the ~4 ms the measurement above `writeJsonDurable`
 * records — spent on every run, to protect the one window where the alternative
 * is already self-repairing.
 */
export function recordScanBoundHit(projectRoot: string, runId: string, reason: string): void {
  if (!runId) return;
  const target = scanBoundPath(projectRoot, runId);
  if (readJson<{ bound?: boolean } | null>(target, null)?.bound === true) return;
  writeJson(target, { bound: true, reason, recordedAt: new Date().toISOString() });
}

/**
 * Whether a bounded scan in THIS run went unfinished.
 *
 * An explicit boolean `bound` is a STATEMENT and is honoured either way. Anything
 * else present at this path is a damaged or forged record rather than a reading:
 * `recordScanBoundHit` is the only writer, it writes `bound: true` once, and no
 * writer anywhere produces `{}`, `[]`, `{"bound":"true"}` or a zero-length file.
 * Those read as bound, because a run paying for browser evidence it may not owe
 * is recoverable and shipping unverified UI is not. A MISSING file is the honest
 * negative — nothing recorded, nothing owed — and another run's record lives at
 * another path and is correctly invisible here.
 */
export function boundedScanTruncated(projectRoot: string, runId: string): boolean {
  if (!runId) return false;
  const target = scanBoundPath(projectRoot, runId);
  const record = readJson<{ bound?: unknown } | null>(target, null);
  if (record && typeof record === 'object' && typeof (record as { bound?: unknown }).bound === 'boolean') {
    return (record as { bound: boolean }).bound;
  }
  return fs.existsSync(target);
}

export function exists(projectRoot: string, relPath: string): boolean {
  return fs.existsSync(path.join(projectRoot, relPath));
}
export function existsAny(projectRoot: string, relPaths: string[]): boolean {
  return relPaths.some((relPath) => exists(projectRoot, relPath));
}
/**
 * A project file's trimmed bytes, or `null` when it could not be read.
 *
 * BOUNDED (shared/bounded-read.ts). This is the reader every project-memory
 * check in architect.ts goes through — `.traffic-one/product.md`, `stack.md`,
 * `security.md`, `api.md`, each `decisions/*.md` — and the bare
 * `fs.readFileSync` it replaces made all of them unbounded. MEASURED at
 * `product.md` through the real entry point (`architectPhaseIncompleteReasons`,
 * reached from agent-model/gate-enforcement.ts and
 * plan-guard/build-orchestration-directive.ts, both hook paths): a FIFO
 * SIGKILLed the call at 12 018 ms with the planted path as the last read,
 * against a 1.9 s regular-file control (load 9.54 of 10).
 *
 * A non-regular file joins `null` where every read failure already was, and
 * that is the fail-CLOSED direction here: `hasRealContent` reads `null` as
 * "missing or incomplete" and the memory-baseline gate names the file. The one
 * mapping that would be wrong is the empty string — an `O_NONBLOCK` FIFO reads
 * as EOF, and `''.length >= 16` is false anyway, so it would arrive at the same
 * verdict by accident rather than by decision. `null` says which.
 */
export function readTrimmed(projectRoot: string, relPath: string): string | null {
  try {
    return readRegularFile(path.join(projectRoot, relPath))?.trim() ?? null;
  } catch {
    return null;
  }
}
