// src/shared/opencode-mcp-ready.ts
// Cheap spawn-path preflight: is the version-stable OpenCode MCP shim on disk?
// Doctor's CURSOR_OPENCODE_MCP_UNHEALTHY probe lives in a runner and must not
// be imported here — this is existsSync only, against the same stableBinDir()
// the probe would check.

import * as fs from 'fs';
import * as path from 'path';

import { stableBinDir } from './runner-shims';

export function openCodeMcpShimPresent(): boolean {
  return fs.existsSync(path.join(stableBinDir(), 'opencode-mcp.cjs'));
}
