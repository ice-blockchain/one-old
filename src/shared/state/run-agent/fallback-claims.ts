// src/shared/state/run-agent/fallback-claims.ts
// Legacy fallback claims over the owned-dir lock.

import { obj, type Rec } from '../../obj';
import * as fs from 'fs';
import * as path from 'path';
import { isNonProjectRoot } from '../../authoring-root';
import { parseJson, readJson, readText, writeJson } from '../../fsjson';
import { normalizeRelPath, type AssignedScope } from '../../scope';
import {
  PENDING_AGENT_CLAIM_STALE_MS,
  RUNS_REL_DIR,
  SUBAGENT_STALE_MS,
  VALID_AGENT_ROLES,
} from '../../../config/state';
import { stateTimestamp } from '../io';

import {
  fallbackClaimFile,
  fallbackClaimsDir,
  runDir,
} from './run-paths';
import {
  withOwnedDirLock,
} from './locks';
import {
  isFreshTimestamp,
} from './session-identity';
import {
  type RunAgentContext,
} from './context-resolve';

const FALLBACK_CLAIMS_LOCK_TIMEOUT_MS = 2_000;
const FALLBACK_CLAIMS_LOCK_STALE_MS = 15_000;
const FALLBACK_CLAIMS_LOCK_RETRY_MS = 10;
const FALLBACK_CLAIMS_WAIT = new Int32Array(new SharedArrayBuffer(4));


function fallbackClaimsLockDir(cwd: string, runId: string): string {
  return path.join(runDir(cwd, runId), '.claims.lock');
}

export function withFallbackClaimsLock(cwd: string, runId: string, mutate: () => void): boolean {
  return withOwnedDirLock(
    fallbackClaimsLockDir(cwd, runId),
    FALLBACK_CLAIMS_LOCK_TIMEOUT_MS,
    FALLBACK_CLAIMS_LOCK_STALE_MS,
    FALLBACK_CLAIMS_LOCK_RETRY_MS,
    FALLBACK_CLAIMS_WAIT,
    mutate,
  );
}

interface FallbackClaimBackup {
  filePath: string;
  raw: string;
}

export function releaseFallbackClaimsForHolderUnlocked(
  cwd: string,
  runId: string,
  holder: string,
): { ok: boolean; removed: FallbackClaimBackup[] } {
  const dir = fallbackClaimsDir(cwd, runId);
  const removed: FallbackClaimBackup[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return obj(error)?.code === 'ENOENT'
      ? { ok: true, removed }
      : { ok: false, removed };
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(dir, entry.name);
    const claim = obj(readJson(file, null));
    if (!claim || String(claim.runId || '') !== runId || claim.holder !== holder) continue;
    try {
      const raw = fs.readFileSync(file, 'utf8');
      fs.rmSync(file, { force: true });
      removed.push({ filePath: file, raw });
    } catch {
      // The durable rebind journal owns forward recovery. Report the exact
      // partial deletion set instead of attempting rollback: restoring a subset
      // can itself fail and would erase the accounting needed for a safe retry.
      return { ok: false, removed };
    }
  }
  return { ok: true, removed };
}

export function tryFallbackClaim(
  cwd: string,
  ctx: RunAgentContext,
  target: string,
): { blocked: boolean; holder?: string } {
  const runId = ctx && ctx.runId != null ? String(ctx.runId) : '';
  if (!runId) return { blocked: false };
  if (isNonProjectRoot(cwd)) return { blocked: false }; // no claim files in the plugin's own repo
  const myKey = String(ctx.sessionId || ctx.claimId || ctx.role || '');
  const file = fallbackClaimFile(cwd, runId, normalizeRelPath(target));
  let result: { blocked: boolean; holder?: string } = { blocked: false };
  const locked = withFallbackClaimsLock(cwd, runId, () => {
    const existing = obj(readJson(file, null));
    if (existing
      && isFreshTimestamp(existing.createdAt, SUBAGENT_STALE_MS)
      && typeof existing.holder === 'string' && existing.holder
      && existing.holder !== myKey) {
      result = { blocked: true, holder: existing.holder };
      return;
    }
    const claim: Rec = {
      version: 1,
      runId,
      path: normalizeRelPath(target),
      holder: myKey,
      role: typeof ctx.role === 'string' ? ctx.role : null,
      sessionId: ctx.sessionId || null,
      createdAt: stateTimestamp(),
    };
    try {
      fs.mkdirSync(fallbackClaimsDir(cwd, runId), { recursive: true });
      writeJson(file, claim);
    } catch {
      // best-effort lock; never block the writer on a lock-write failure
    }
  });
  return locked ? result : { blocked: false };
}

