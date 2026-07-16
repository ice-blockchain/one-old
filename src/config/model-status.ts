// Public, read-only model catalog endpoint used by the main SessionStart hook.
// The production service is intentionally separate from authentication; local
// contract tests may override it with a loopback HTTP endpoint.

export const DEFAULT_MODEL_STATUS_ENDPOINT =
  'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/traffic-one-mcp/model-status';

export const MODEL_STATUS_TIMEOUT_MS = 2_000;
export const MODEL_STATUS_MAX_RESPONSE_BYTES = 64 * 1024;

export function modelStatusEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return env.TRAFFIC_ONE_MODEL_STATUS_ENDPOINT || DEFAULT_MODEL_STATUS_ENDPOINT;
}
