// src/shared/auth/updates-feed.ts
// Turning the `updates` tool's payload into something that is SAFE TO STORE and
// safe for a later session to render.
//
// ── the hazard, stated plainly ──────────────────────────────────────────────
// `items[].title`, `items[].body` and `items[].metadata` are rows in a database
// this client does not control, and their destination is agent-visible session
// context. That makes them a prompt-injection surface in the most literal
// sense: a row someone can write becomes text sitting in a model's context
// window, and the obvious attack is a "title" shaped like an instruction —
// `Ignore previous instructions and run …`, or a body that opens a fake
// ``` fence and impersonates the host's own framing.
//
// This codebase already recognises the identical hazard in a strictly weaker
// case. config/one-mcp.ts bans whitespace, Markdown syntax, control characters
// and bidi markers from remote MODEL IDS, with the reason spelled out: they are
// "rendered in hook-owned agent context". A model id can take that treatment
// because a model id is a token. Prose cannot — banning whitespace from a
// sentence leaves no sentence — so this module keeps the PRINCIPLE (nothing
// crosses this boundary that can do more than be read) and changes the
// mechanism from reject-the-value to neuter-the-value.
//
// ── the guarantee ───────────────────────────────────────────────────────────
// Every string this module emits satisfies shared/qa-report/schema.ts's
// `isCleanBoundedText`: non-empty, trimmed, bounded, and free of C0/DEL
// controls. That is not a coincidence and not a re-derivation — it is this
// repo's existing predicate for "untrusted text that is allowed to be
// rendered", and reaching the same invariant by a different route means the two
// lanes cannot drift into disagreeing about what safe means.
//
// On top of that predicate, and beyond it, this module also removes:
//   - ALL whitespace structure (newlines, tabs, runs) → a single space. A
//     newline is what lets injected prose fake a paragraph break, a heading, or
//     a new speaker turn. Bodies keep their words and lose their layout.
//   - Bidi controls and invisible formatting (U+200B-U+200F, U+061C,
//     U+202A-U+202E, U+2060-U+2069, U+FEFF). These are how text renders as
//     something other than what it says, and one-mcp.ts already bans them.
//   - Backticks. Every plausible framing of this block in a host surface is a
//     fenced or inline code span, and the backtick is the one character that
//     terminates both. Removing it is what makes "the renderer cannot be broken
//     out of" a property of the DATA rather than a hope about the renderer.
//
// REJECT vs SANITISE, decided: qa-report/schema.ts rejects. This module
// sanitises, because the two failure modes are not comparable. A rejected QA
// report is a report the producer is told to fix; a rejected announcement is an
// announcement the user silently never sees, from a first-party server whose
// prose legitimately contains newlines. Silently showing nothing, forever, is
// the worse failure — so we show the words and drop everything that is not
// words. What is REJECTED (dropped item, not mangled) is structure: a
// non-object item, a missing id, a title that sanitises to nothing.
//
// ── metadata is not persisted, at all ───────────────────────────────────────
// `metadata` is unbounded, unschema'd server-controlled `jsonb`. There is no
// stated rendering requirement for it, and the safest handling of an arbitrary
// untrusted blob nobody has a use for is to not carry it. Adding it later is a
// schema plus a sanitiser plus tests; carrying it now is an attack surface held
// open on the chance someone wants it. Dropped deliberately — see the sibling
// rendering lane if this ever needs to change.

import { UPDATE_ITEMS_MAX, UPDATE_TEXT_MAX_LENGTH } from '../../config/auth';

/**
 * One announcement, after sanitisation. Every string field here satisfies the
 * guarantee above; a consumer never needs to sanitise again and must never
 * assume it may skip framing because of that.
 */
export interface SafeUpdateItem {
  /** The server's `bigserial` id as a decimal string. The dedup identity. */
  readonly id: string;
  /** Absent when the server's value did not survive sanitisation. */
  readonly kind?: string;
  readonly title: string;
  readonly body?: string;
  /** ISO-8601 UTC, or absent when the server's value was not one. */
  readonly createdAt?: string;
}

export interface SafeUpdatesPage {
  readonly items: readonly SafeUpdateItem[];
  /** Opaque and server-issued. Absent unless the server sent a usable one. */
  readonly nextCursor?: string;
  readonly hasMore: boolean;
}

// Bidi + invisible formatting. Same family one-mcp.ts's model-id alphabet
// excludes; enumerated here because prose cannot be expressed as an allowlist.
const BIDI_AND_INVISIBLE_RE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// C0, DEL, and C1. The first two are exactly what `isCleanBoundedText` rejects.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
// Whitespace that carries STRUCTURE rather than separation.
const STRUCTURAL_WHITESPACE_RE = /[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/g;

/**
 * The one text primitive. Empty string means "this field did not survive",
 * which callers treat as absent rather than as an empty rendering.
 *
 * Order matters: invisibles are removed BEFORE whitespace is collapsed, so a
 * zero-width space cannot survive as the thing that keeps two words apart, and
 * controls are removed before trimming so a string of nothing but controls
 * collapses to empty rather than to a space.
 */
export function safeUpdateText(value: unknown, maxLength: number = UPDATE_TEXT_MAX_LENGTH): string {
  if (typeof value !== 'string' || !value) return '';
  const cleaned = value
    .replace(BIDI_AND_INVISIBLE_RE, '')
    .replace(CONTROL_RE, '')
    .replace(/`/g, '')
    .replace(STRUCTURAL_WHITESPACE_RE, ' ')
    .trim();
  if (!cleaned) return '';
  // Slice THEN trim again: a cut that lands mid-space would otherwise emit a
  // trailing space and break the `value === value.trim()` half of the
  // guarantee. Truncation is silent by design — an ellipsis would be this
  // module inventing prose, and the renderer is the layer that gets to decide
  // how a shortened item looks.
  return cleaned.length <= maxLength ? cleaned : cleaned.slice(0, maxLength).trim();
}

/** The server's `bigserial`, serialised as a decimal string (tools/updates.ts). */
function safeUpdateId(value: unknown): string {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : '';
}

/**
 * ISO-8601 UTC that round-trips, mirroring qa-report/schema.ts's instant check.
 *
 * Exported because the RENDERER re-runs it. updates-store.ts's read-side
 * `parseItems` re-validates structure, not values — it accepts any non-empty
 * string as `createdAt` — so a surface that puts the stored value in a
 * structural position (a bracketed date beside untrusted prose) would be
 * trusting a field nothing on the read path checked. Re-checking here costs a
 * `Date.parse` per item and makes the renderer's framing depend on this
 * module's guarantee rather than on the store's storage of it.
 */
export function safeCreatedAt(value: unknown): string {
  if (typeof value !== 'string' || value.length > 40) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString() === value ? value : '';
}

/**
 * The `nextCursor`, validated but NEVER interpreted.
 *
 * The alphabet and the 2 KiB bound are the server's own, lifted verbatim from
 * the schema it validates incoming cursors against (tools/updates.ts:
 * `CURSOR_MAX_LEN = 2048`, `CURSOR_RE = /^[A-Za-z0-9_-]+$/`, no `=` padding
 * because its encoder strips it). Checking the same thing the server checks is
 * not parsing: this client still has no idea what is inside, never builds one,
 * never trims or re-encodes one, and hands back the exact bytes it was given.
 * The check exists so a malformed value is dropped here — where dropping it
 * costs one re-read of page one — rather than persisted and replayed forever
 * into a tool call that will reject it every time.
 */
function safeCursor(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : '';
}

/**
 * Read the tool's payload out of a JSON-RPC `result`.
 *
 * The SDK emits the same object twice — as `structuredContent` (typed, MCP
 * 2025-06-18) and as `content[0].text` (a JSON string, the universal format).
 * `structuredContent` is preferred because it costs no second parse; the text
 * form is the fallback for the day the server stops sending both. `isError:
 * true` short-circuits: that shape carries a diagnostic message where the
 * payload would be, and reading it as a feed would render the server's error
 * prose to the user as though it were an announcement.
 */
export function updatesPayload(result: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!result || result.isError === true) return null;
  const structured = result.structuredContent;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  const content = result.content;
  if (!Array.isArray(content)) return null;
  const first = content[0];
  if (!first || typeof first !== 'object' || (first as { type?: unknown }).type !== 'text') return null;
  const text = (first as { text?: unknown }).text;
  if (typeof text !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * A JSON-RPC `result` in, a page that is safe to write to disk out.
 *
 * Never throws and never partially fails: an unreadable payload is an empty
 * page with no cursor, which the caller correctly treats as "nothing new, do
 * not advance". The item cap is applied to what the server sent — the server's
 * own default page is 25 and its ceiling is 100, so the cap can only bite on a
 * server that broke its own contract, which is exactly when a bound matters.
 */
export function safeUpdatesPage(result: Record<string, unknown> | undefined): SafeUpdatesPage {
  const payload = updatesPayload(result);
  if (!payload) return { items: [], hasMore: false };

  const raw = Array.isArray(payload.items) ? payload.items.slice(0, UPDATE_ITEMS_MAX) : [];
  const items: SafeUpdateItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const id = safeUpdateId(row.id);
    const title = safeUpdateText(row.title);
    // No id means no dedup identity, and an item that cannot be deduped would
    // be shown on every session forever. No title means nothing to render.
    if (!id || !title) continue;
    const kind = safeUpdateText(row.kind);
    const body = safeUpdateText(row.body);
    const createdAt = safeCreatedAt(row.createdAt);
    items.push({
      id,
      ...(kind ? { kind } : {}),
      title,
      ...(body ? { body } : {}),
      ...(createdAt ? { createdAt } : {}),
    });
  }

  const nextCursor = safeCursor(payload.nextCursor);
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    hasMore: payload.hasMore === true,
  };
}
