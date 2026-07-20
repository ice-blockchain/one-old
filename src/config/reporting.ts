// src/config/reporting.ts
// one-mcp first-look report knobs: the endpoint, the report-id field/file, the
// status-file path, retry windows, and the walk skip lists. The report client +
// collectors live in runners/one-mcp-report/**.

// Compatibility exports for reporter/scanner modules. All Traffic One remote
// MCP knobs live in one-mcp.ts; only collector-specific skip lists remain here.
export {
  DEFAULT_PUBLIC_ENDPOINT as MCP_REPORT_ENDPOINT,
  FAILED_RETRY_MS,
  ONE_UID_FIELD,
  QUEUED_RETRY_MS,
  REPORTING_ACTIVE,
  SAVE_MCP_REPORT,
  STATUS_FILE,
} from './one-mcp';

export const SKIP_DIRS = new Set([
  '.cache', '.git', '.gitnexus', '.next', '.nuxt', '.traffic-one', '.turbo',
  'build', 'coverage', 'dist', 'graphify-out', 'node_modules', 'out', 'Pods', 'target', 'vendor',
]);
export const SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
