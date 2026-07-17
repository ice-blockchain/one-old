import {
  ONE_MCP_CONFIG_NAME_BY_HOST,
  ONE_MCP_DECODER_VERSION,
  ONE_MCP_PAYLOAD_SCHEMA_VERSION,
  publicEndpoint,
} from '../../../config/one-mcp';
import type { HostModelKey } from '../../../config/model-tiers';
import type { HostModelSnapshot } from '../../model-tiers';
import {
  oneMcpPayloadFingerprint,
  type OneMcpModelConfigPayloadV2,
} from '../../one-mcp';
import { writeOneMcpConfigCacheEntry } from '../../one-mcp-cache';

/** Seed the authoritative runtime sidecar from a resolved test snapshot. */
export function writeRuntimeModelSnapshot(
  host: HostModelKey,
  snapshot: HostModelSnapshot,
  env: NodeJS.ProcessEnv,
  version = 1,
): void {
  const payload: OneMcpModelConfigPayloadV2 = {
    payloadSchemaVersion: 2,
    tiers: {
      high: [...snapshot.tiers.highest],
      balanced: [...snapshot.tiers.balanced],
      low: [...snapshot.tiers.cheapest],
      auto: [...snapshot.tiers.balanced],
    },
  };
  const updatedAt = /^\d{4}-\d{2}-\d{2}$/.test(snapshot.updatedAt)
    ? `${snapshot.updatedAt}T00:00:00.000Z`
    : snapshot.updatedAt;
  writeOneMcpConfigCacheEntry(host, {
    endpoint: publicEndpoint(env),
    configName: ONE_MCP_CONFIG_NAME_BY_HOST[host],
    payloadSchemaVersion: ONE_MCP_PAYLOAD_SCHEMA_VERSION,
    decoderVersion: ONE_MCP_DECODER_VERSION,
    version,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt,
    payload,
    payloadFingerprint: oneMcpPayloadFingerprint(payload),
  }, env);
}
