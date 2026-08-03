// src/runners/opencode/models.ts
// Model chain resolution with the process-lifetime free-chain memo, stream
// parsing, and model-advance classification.

import * as fs from 'fs';
import { OPENCODE_FREE_MODELS } from '../../config/model-tiers';
import { managedNpmBin } from '../toolchain';

import {
  which,
  type DelegateOpts,
  type Rec,
} from './types';

export function resolveBin(): string | null {
  const managed = managedNpmBin('opencode', 'opencode');
  if (fs.existsSync(managed)) return managed;
  return which('opencode');
}

// The free-model chain is walked per delegation; remember (for this process —
// the MCP server is long-lived, and --from-plan loops units in one process) how
// far we got, so a retired promo model is not re-tried on every single unit.
// Never persisted: a plugin update with a fresh chain resets it naturally.
let freeChainStart = 0;

// Test-only: the memo is module-level process state, so in-process tests must
// reset it between cases to stay order-independent.
export function resetOpenCodeModelMemo(): void {
  freeChainStart = 0;
}

// Model resolution. An EXPLICIT model (opts.model or openCode.model in local
// preferences) is the user's choice: it is tried alone, with NO fallback — we
// never silently swap a model someone pinned. Only the default free chain
// falls back, advancing on model-class errors.
export function resolveModels(state: Rec, opts: DelegateOpts): { models: string[]; fromChain: boolean } {
  if (opts.model) return { models: [opts.model], fromChain: false };
  const openCode = state.openCode && typeof state.openCode === 'object' ? (state.openCode as Rec) : null;
  if (openCode && typeof openCode.model === 'string' && openCode.model) {
    return { models: [openCode.model], fromChain: false };
  }
  const start = Math.min(freeChainStart, OPENCODE_FREE_MODELS.length - 1);
  return { models: OPENCODE_FREE_MODELS.slice(start), fromChain: true };
}

// `opencode run` emits NDJSON. Pull out error events + the assistant text.
// Non-JSON lines (e.g. a first-run DB-migration banner) are ignored. The error
// name AND message are both kept: classification needs the raw class name
// (e.g. "ProviderModelNotFoundError") when the message is empty.
export function parseStream(stdout: string): {
  errored: boolean;
  errName: string;
  errorMsg: string;
  summary: string;
  /**
   * The model's LAST text part — its concluding statement.
   *
   * `summary` is every part joined in stream order, so head-slicing it (which is
   * what the digest does) yields the model thinking out loud rather than what it
   * did: reviewers were handed "Let me verify eslint-plugin-i18next behavior in a
   * temp sandbox…" and "Now I have everything I need. Writing the file:" as the
   * record of a delegated unit. The last part is where models put the result.
   */
  lastText: string;
} {
  let errored = false;
  let errName = '';
  let errorMsg = '';
  const texts: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] !== '{') continue;
    let obj: Rec;
    try { obj = JSON.parse(line) as Rec; } catch { continue; }
    if (obj.type === 'error') {
      errored = true;
      const err = obj.error && typeof obj.error === 'object' ? (obj.error as Rec) : {};
      const data = err.data && typeof err.data === 'object' ? (err.data as Rec) : {};
      if (typeof data.message === 'string' && data.message) errorMsg = data.message;
      if (typeof err.name === 'string' && err.name) errName = err.name;
    }
    if (obj.type === 'text') {
      const part = obj.part && typeof obj.part === 'object' ? (obj.part as Rec) : {};
      const txt = typeof part.text === 'string' ? part.text : (typeof obj.text === 'string' ? obj.text : '');
      if (txt) texts.push(txt);
    }
  }
  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();
  return {
    errored,
    errName,
    errorMsg,
    summary: flat(texts.join(' ')),
    lastText: flat(texts[texts.length - 1] || ''),
  };
}

// Decide whether the NEXT free model in the chain should be tried after an
// opencode-reported error. LIVE-VERIFIED on the pinned 1.15.13: a RETIRED or
// unknown gateway model is reported as a generic "Unexpected server error.
// Check server logs for details." — no model name, no "not found", no 401 in
// the message — so a positive match on model-error vocabulary would miss the
// exact case the chain exists for (promo rotation). Inverted policy instead:
// advance on EVERY server/model-side error, and fail fast ONLY on clearly
// environmental failures (DNS, refused/reset connections, TLS, proxy, offline)
// where a different model cannot possibly help. The asymmetry is deliberate:
// a false advance costs at most two fast-failing extra runs before the paid
// fallback; a false fail-fast kills delegation until the next plugin update.
const ENVIRONMENTAL_ERROR_RE = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket|TLS|certificate|proxy|offline/i;
export function shouldTryNextModel(errName: string, errorMsg: string): boolean {
  return !ENVIRONMENTAL_ERROR_RE.test(`${errName}: ${errorMsg}`);
}

export function runStamp(): string {
  // Matches the orchestrator's run-id shape (YYYY-MM-DDTHH-MM-SSZ); only used
  // when the caller doesn't pass --run-id (standalone/tests).
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
}

/** delegate() advances the memo when a chain model answers; keep the mutation
 * beside the memo it guards. */
export function setFreeChainStart(index: number): void {
  freeChainStart = index;
}
