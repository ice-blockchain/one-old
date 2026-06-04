// src/config/token-logger.ts
// In-flight per-tool token logger knobs: the opt-in env var and the log file path.
// The logger logic (isEnabled, append, rotate) lives in shared/token-logger.ts.

import * as path from 'path';

export const TOKEN_LOG_ENV_FLAG = 'TRAFFIC_ONE_TOKEN_LOG';
export const LOG_REL_PATH = path.join('.traffic-one', 'token-log.jsonl');
