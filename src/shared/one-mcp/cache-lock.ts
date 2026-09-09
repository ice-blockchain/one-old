// src/shared/one-mcp/cache-lock.ts
// The owner-stamped cache lock with stale/abandoned reap. Lives under the
// 0700 per-user machine dir, so EPERM is not-ours (see per-user-dir-lock.ts).

import {
  ONE_MCP_CACHE_LOCK_RETRY_MS,
  ONE_MCP_CACHE_LOCK_STALE_MS,
  ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
} from '../../config/one-mcp';
import {
  acquirePerUserDirLock,
  releasePerUserDirLock,
  type PerUserDirLock,
} from '../per-user-dir-lock';

export type CacheLock = PerUserDirLock;

export function acquireCacheLock(filePath: string): CacheLock | null {
  return acquirePerUserDirLock(filePath, {
    timeoutMs: ONE_MCP_CACHE_LOCK_TIMEOUT_MS,
    retryMs: ONE_MCP_CACHE_LOCK_RETRY_MS,
    staleMs: ONE_MCP_CACHE_LOCK_STALE_MS,
  });
}

export function releaseCacheLock(lock: CacheLock): void {
  releasePerUserDirLock(lock);
}
