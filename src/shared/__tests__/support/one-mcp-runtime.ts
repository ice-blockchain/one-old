import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  publicEndpoint,
} from '../../../config/one-mcp';
import type { HostModelKey } from '../../../config/model-tiers';
import type { HostModelSnapshot } from '../../model-tiers';
import {
  oneMcpPayloadFingerprint,
  type OneMcpModelConfigPayload,
} from '../../one-mcp';
import { writeOneMcpConfigCacheEntry } from '../../one-mcp-cache';

/** Seed the authoritative runtime sidecar from a resolved test snapshot. */
export function writeRuntimeModelSnapshot(
  host: HostModelKey,
  snapshot: HostModelSnapshot,
  env: NodeJS.ProcessEnv,
  version = 1,
): void {
  const payload: OneMcpModelConfigPayload = {
    tiers: {
      high: [...snapshot.tiers.highest],
      balanced: [...snapshot.tiers.balanced],
      low: [...snapshot.tiers.cheapest],
      auto: [...snapshot.tiers.balanced],
    },
  };
  const updatedAt = `2026-07-${String(10 + Math.min(version, 9)).padStart(2, '0')}T00:00:00.000Z`;
  writeOneMcpConfigCacheEntry(host, {
    endpoint: publicEndpoint(env),
    configName: ONE_MCP_CONFIG_NAME_BY_HOST[host],
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  }, env);
}
