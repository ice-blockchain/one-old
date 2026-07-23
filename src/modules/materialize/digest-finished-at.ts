// src/modules/materialize/digest-finished-at.ts
// F3 enforcement — trustworthy digest `finished_at`.
//
// Roles hand-type the `finished_at:` line in their handoff digests. The
// `date -u` mandate in rules/common/agent-handoff-digests.md is advisory, and in
// e2e 5c three of five roles ignored it and wrote FUTURE-dated / fabricated
// timestamps (backend +14m, frontend local-time-as-UTC +3h, reviewer +3.4h) —
// undetected, because the settlement "digest sanity check" only verifies a
// digest exists, never that its timestamp is real. The digest PostToolUse hook
// host-stamps an implausible value with the real write-time so run metadata can
// be trusted regardless of what the agent guessed.
//
// This module is a PURE string transform (no fs) so it is trivially testable;
// the hook (post-stack-setup.ts) owns the read/write and passes `nowMs`.

// Mirror of qa-report.ts ISO_UTC_INSTANT_RE — millisecond fraction optional.
const ISO_UTC_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const FINISHED_AT_LINE_RE = /^finished_at:[ \t]*(.*)$/m;
const VERDICT_LINE_RE = /^verdict:.*$/m;
// Tolerate a little clock skew before calling a future timestamp a fabrication.
const FUTURE_SKEW_MS = 2 * 60 * 1000;
// Stale-past bound: `finished_at` is stamped at digest-write time, so compliant
// agents land within seconds of the write (observed 8c: −3s…−7s). A value many
// minutes older than the write is a guess, not a measurement (observed 8c: the
// architect backdated 9m39s and passed the future/before-run checks). 5 minutes
// keeps a generous compose-then-write margin while catching that failure mode.
const STALE_PAST_MS = 5 * 60 * 1000;

export type FinishedAtReason = 'missing' | 'malformed' | 'future' | 'before-run' | 'stale';

export interface FinishedAtFix {
  /** Digest content with the finished_at line stamped to the real write-time. */
  readonly content: string;
  /** The rejected value (trimmed), or null when the line was absent/empty. */
  readonly from: string | null;
  /** The canonical host now written in (matches `date -u`, no ms). */
  readonly to: string;
  readonly reason: FinishedAtReason;
}

// Valid iff the ISO-UTC regex matches, it parses, and the millisecond expansion
// round-trips (so calendar rollovers like 2026-02-30 still reject). Ported from
// qa-report.parseCanonicalInstant so both timestamp gates agree.
function canonicalInstantMs(value: string): number | null {
  if (!ISO_UTC_INSTANT_RE.test(value)) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return canonical === value || canonical === value.replace(/Z$/, '.000Z') ? parsed : null;
}

// `date -u +%Y-%m-%dT%H:%M:%SZ` form (second precision, no millis).
export function stampInstant(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// Returns a fix when the digest's finished_at is missing, malformed, in the
// future beyond skew, (when runStartMs is known) dated before the run began, or
// stale — more than STALE_PAST_MS before the actual write; otherwise null — a
// present, plausible value is left byte-identical. On a digest UPDATE that kept
// an old finished_at, the stale clamp re-stamps it to the update time, which is
// the correct semantics: the role just finished more work now.
export function normalizeDigestFinishedAt(
  content: string,
  nowMs: number,
  opts: { runStartMs?: number } = {},
): FinishedAtFix | null {
  const to = stampInstant(nowMs);
  const line = content.match(FINISHED_AT_LINE_RE);
  if (!line) {
    // Insert directly under the machine-readable verdict line (top of file if
    // there is none) so the header stays parseable.
    const insert = `finished_at: ${to}`;
    const verdict = content.match(VERDICT_LINE_RE);
    const next = verdict
      ? content.replace(VERDICT_LINE_RE, `${verdict[0]}\n${insert}`)
      : `${insert}\n${content}`;
    return { content: next, from: null, to, reason: 'missing' };
  }
  const raw = (line[1] || '').trim();
  const ms = raw ? canonicalInstantMs(raw) : null;
  let reason: FinishedAtReason | null = null;
  if (ms === null) reason = raw ? 'malformed' : 'missing';
  else if (ms > nowMs + FUTURE_SKEW_MS) reason = 'future';
  else if (typeof opts.runStartMs === 'number' && ms < opts.runStartMs - FUTURE_SKEW_MS) reason = 'before-run';
  else if (ms < nowMs - STALE_PAST_MS) reason = 'stale';
  if (reason === null) return null;
  const next = content.replace(FINISHED_AT_LINE_RE, `finished_at: ${to}`);
  return { content: next, from: raw || null, to, reason };
}
