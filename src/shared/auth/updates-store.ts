// src/shared/auth/updates-store.ts
// Where the user's update feed lives between the session that FETCHED it and
// the session that SHOWS it.
//
// ── why those are different sessions ────────────────────────────────────────
// Deliberate, and load-bearing enough to state before anything else: nothing in
// this lane fetches on the SessionStart critical path. The hook has a 150 ms p95
// dispatch budget (tests/hook-timing/hook-timing.test.ts) and the probe's
// timeout is 10 000 ms — 66x the entire budget — so a blocking fetch would not
// slow SessionStart down, it would replace it. That is precisely the defect the
// hooks-fast lane removed when it took a nested synchronous spawn off this path
// (measured 927.91 ms → 238.33 ms at the OS process boundary), and this store
// exists so the same mistake cannot be reintroduced by someone who notices the
// feed is "one session stale" and decides to "fix" it.
//
// It is one session stale ON PURPOSE. The same shape as the one-mcp-sync
// precedent already on this path: a detached background worker writes, and the
// NEXT session reads what is on disk. Anyone tempted to make the read
// authoritative-and-live should read this paragraph first, then the measurement
// in modules/session/one-mcp-sync.ts.
//
// ── why MACHINE level ───────────────────────────────────────────────────────
// This is the USER's feed — one per API key, and the API key is machine-wide.
// Project-level storage would show the same announcement once per project: six
// projects, six sightings of one announcement, and six copies of a cursor that
// each advance independently. `shown` and `cursor` therefore live in one file
// beside one.json, exactly where the credential they belong to lives.
// See ./machine-sidecar.ts for the write-fence reasoning; nothing here is
// written through the guarded project-tree helpers, and it must not be.
//
// ── what a consumer gets, and what it still owes ────────────────────────────
// `unseenUpdates()` returns items that are SAFE (every string satisfies the
// ./updates-feed.ts guarantee) and NEW (never marked shown on this machine).
// Safe means inert — no controls, no bidi, no line structure, no backticks,
// bounded. It does NOT mean trustworthy: this is prose from a remote database,
// and the surface that renders it still owes the user an unambiguous frame
// saying so. Sanitisation stops the text from BREAKING the frame; only the
// frame stops it from being read as an instruction.

import { UPDATES_BLOCK_MAX_LENGTH, UPDATE_ITEMS_MAX } from '../../config/auth';
import { isoNoMs, readMachineSidecar, writeMachineSidecar } from './machine-sidecar';
import type { SafeUpdateItem, SafeUpdatesPage } from './updates-feed';

export const UPDATES_STORE_FILE = 'auth-updates.json';
const UPDATES_STORE_VERSION = 1;

export interface UpdatesStore {
  /** Sanitised, newest-last, already bounded. Never raw server prose. */
  readonly items: readonly SafeUpdateItem[];
  /** The server's opaque `nextCursor`, verbatim. Absent when fully drained. */
  readonly cursor?: string;
  /** Ids already surfaced to the user on this machine. */
  readonly shown: readonly string[];
  readonly fetchedAt?: string;
}

const EMPTY: UpdatesStore = { items: [], shown: [] };

function stringList(value: unknown, cap: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && /^\d{1,20}$/.test(entry)).slice(-cap);
}

/**
 * Re-validate on READ, not only on write.
 *
 * The file is 0600 in the machine dir, so this is not a defence against an
 * attacker who can already write it — it is a defence against the ordinary
 * case that makes injection bugs ship: a file written by an older or newer
 * version of this code, hand-edited during debugging, or restored from a
 * backup, whose contents then flow straight into agent context. Anything that
 * does not still look like a sanitised item is dropped rather than repaired.
 */
function parseItems(value: unknown): SafeUpdateItem[] {
  if (!Array.isArray(value)) return [];
  const items: SafeUpdateItem[] = [];
  for (const entry of value.slice(0, UPDATE_ITEMS_MAX)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const { id, title } = row;
    if (typeof id !== 'string' || !/^\d{1,20}$/.test(id)) continue;
    if (typeof title !== 'string' || !title) continue;
    items.push({
      id,
      ...(typeof row.kind === 'string' && row.kind ? { kind: row.kind } : {}),
      title,
      ...(typeof row.body === 'string' && row.body ? { body: row.body } : {}),
      ...(typeof row.createdAt === 'string' && row.createdAt ? { createdAt: row.createdAt } : {}),
    });
  }
  return items;
}

export function readUpdatesStore(env: NodeJS.ProcessEnv = process.env): UpdatesStore {
  const raw = readMachineSidecar(UPDATES_STORE_FILE, UPDATES_STORE_VERSION, env);
  if (!raw) return EMPTY;
  const cursor = typeof raw.cursor === 'string' && raw.cursor ? raw.cursor : '';
  const fetchedAt = typeof raw.fetchedAt === 'string' && raw.fetchedAt ? raw.fetchedAt : '';
  return {
    items: parseItems(raw.items),
    ...(cursor ? { cursor } : {}),
    shown: stringList(raw.shown, UPDATE_ITEMS_MAX),
    ...(fetchedAt ? { fetchedAt } : {}),
  };
}

function writeStore(store: UpdatesStore, env: NodeJS.ProcessEnv): boolean {
  return writeMachineSidecar(UPDATES_STORE_FILE, UPDATES_STORE_VERSION, {
    items: store.items,
    ...(store.cursor ? { cursor: store.cursor } : {}),
    shown: store.shown,
    ...(store.fetchedAt ? { fetchedAt: store.fetchedAt } : {}),
  }, env);
}

/**
 * Fold a freshly fetched page into the store. FALSE when the write was refused.
 *
 * Three decisions worth naming:
 *
 *  - The cursor advances ONLY when the server sent a new one. A page with no
 *    `nextCursor` means the feed is drained, and the stored cursor is kept so
 *    the next probe resumes from the same place rather than re-reading the feed
 *    from row zero and re-showing everything the user has already dismissed.
 *
 *  - Items ACCUMULATE across pages, oldest dropped first, capped. A user who
 *    has not started a session in a fortnight should still get the backlog, and
 *    at one page per day the store is how the pages add up.
 *
 *  - `shown` is pruned to the ids still present. It is a dedup ledger, not an
 *    audit log; letting it grow forever would make the file the largest thing
 *    in the machine dir to remember announcements no longer in existence.
 */
export function recordUpdatesPage(
  page: SafeUpdatesPage,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const current = readUpdatesStore(env);
  const byId = new Map<string, SafeUpdateItem>();
  for (const item of current.items) byId.set(item.id, item);
  for (const item of page.items) byId.set(item.id, item);
  const items = [...byId.values()].slice(-UPDATE_ITEMS_MAX);
  const live = new Set(items.map((item) => item.id));
  const cursor = page.nextCursor || current.cursor || '';
  return writeStore({
    items,
    ...(cursor ? { cursor } : {}),
    shown: current.shown.filter((id) => live.has(id)),
    fetchedAt: isoNoMs(nowMs),
  }, env);
}

/**
 * What this machine has not shown yet, oldest first, bounded to what will fit
 * in one rendered block.
 *
 * The character budget is applied HERE rather than in the renderer, because it
 * is a property of the destination (agent context, config/auth.ts
 * UPDATES_BLOCK_MAX_LENGTH, borrowed from the seed-prompt bound) and not of any
 * one presentation of it. A renderer is free to show fewer.
 */
export function unseenUpdates(env: NodeJS.ProcessEnv = process.env): SafeUpdateItem[] {
  const store = readUpdatesStore(env);
  const shown = new Set(store.shown);
  const unseen: SafeUpdateItem[] = [];
  let budget = UPDATES_BLOCK_MAX_LENGTH;
  for (const item of store.items) {
    if (shown.has(item.id)) continue;
    const cost = item.title.length + (item.body?.length ?? 0);
    if (unseen.length > 0 && cost > budget) break;
    budget -= cost;
    unseen.push(item);
  }
  return unseen;
}

/**
 * Mark items shown. FALSE when the write was refused — and a caller that
 * ignores that boolean will show the same announcement on every session.
 *
 * ── mark AFTER rendering, and spend the boolean as a NOTICE ─────────────────
 * This doc used to say "mark BEFORE it renders, not after", and the surface
 * that now consumes it (modules/session/session-start.ts commitShownUpdates)
 * deliberately does the opposite, on both halves. Recorded here rather than
 * only there, because the next reader arrives at this signature first.
 *
 * ORDER. SessionStart's entry wraps its whole body in a catch that answers a
 * throw with `noop()`, so a mark taken before the body runs is a mark taken on
 * a session that may render nothing — and an announcement marked without being
 * shown is gone permanently, which is strictly worse than one shown twice.
 * The caller therefore marks only once the block is provably inside the
 * HookResult it is about to return, which also covers the case where a deny
 * short-circuits the advisory merge and silently drops the block.
 *
 * REFUSAL. "Mark first, and skip the render when the mark is refused" is the
 * other thing that ordering bought, and it is the wrong trade: on a machine
 * whose sidecar is unwritable it converts "shows the same item every session"
 * into "never shows any announcement at all, forever, silently". The caller
 * renders anyway and appends a notice naming this file and the refusal —
 * the same shape session-start.ts's STATE_NOT_RECORDED uses for a refused
 * `.one.json`. Repetition is additionally bounded by the once-per-session
 * throttle on that surface.
 */
export function markUpdatesShown(ids: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (ids.length === 0) return true;
  const store = readUpdatesStore(env);
  const shown = new Set(store.shown);
  for (const id of ids) shown.add(id);
  const live = new Set(store.items.map((item) => item.id));
  return writeStore({
    items: store.items,
    ...(store.cursor ? { cursor: store.cursor } : {}),
    shown: [...shown].filter((id) => live.has(id)),
    ...(store.fetchedAt ? { fetchedAt: store.fetchedAt } : {}),
  }, env);
}

/**
 * Drop the whole feed. Called when the key is REVOKED: the feed is the
 * property of the identity behind that key, and leaving one user's
 * announcements on disk for whoever signs in next is both a privacy leak and a
 * correctness bug (their cursor is bound to the previous user and the server
 * would reject it on every future page).
 */
export function clearUpdatesStore(env: NodeJS.ProcessEnv = process.env): boolean {
  return writeStore(EMPTY, env);
}
