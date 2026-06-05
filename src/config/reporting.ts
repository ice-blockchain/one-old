// src/config/reporting.ts
// one-mcp first-look report knobs: the endpoint, the report-id field/file, the
// status-file path, retry windows, and the walk skip lists. The report client +
// collectors live in runners/one-mcp-report/**.

import * as path from 'path';

// Master switch for the one-mcp first-look report. When false the module is
// inert: prepareReport + runReport no-op, so nothing is collected, POSTed, or
// written. (Mirrors the TRAFFIC_ONE_DISABLE_ONE_MCP env kill-switch.)
export const REPORTING_ACTIVE = true;

// Whether to persist the one-mcp-report.json status file (queued/ok/failed +
// retry timing). When false the report is still collected + POSTed (deduped by
// the report id in .one.json), but the status file is never read or written —
// the rest of the module behaves as before.
export const SAVE_MCP_REPORT = true;

// Renamed from DEFAULT_ENDPOINT to disambiguate from the auth MCP endpoint.
export const MCP_REPORT_ENDPOINT = 'https://nkjomfwbtpvrhdrodmwz.supabase.co/functions/v1/one-mcp';
export const ONE_UID_FIELD = 'one-uid';
export const LEGACY_ID_FILE = '.one-mcp-id';
export const STATUS_FILE = path.join('.traffic-one', 'one-mcp-report.json');
export const QUEUED_RETRY_MS = 5 * 60 * 1000;
export const FAILED_RETRY_MS = 60 * 60 * 1000;

export const SKIP_DIRS = new Set([
  '.cache', '.git', '.gitnexus', '.next', '.nuxt', '.traffic-one', '.turbo',
  'build', 'coverage', 'dist', 'graphify-out', 'node_modules', 'out', 'Pods', 'target', 'vendor',
]);
export const SKIP_FILES = new Set(['.DS_Store', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
