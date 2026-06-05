// src/config/security.ts
// Pre-deployment security-check knobs: report location, the state-file paths the
// scan exempts, the state fields it stamps, and the text-extension / ignore lists
// for the file walk. The scan logic + result types live in
// runners/security-check/** (types stay in security-check/constants.ts).

import * as path from 'path';

export const DEFAULT_REPORT_DIR = path.join('.traffic-one', 'reports', 'security');
export const STATE_REL_PATH = '.traffic-one/.one.json';
export const LEGACY_STATE_REL_PATH = STATE_REL_PATH;
export const SECURITY_STAMP_FIELDS = [
  'lastSecurityCheckAt',
  'lastSecurityCheckStatus',
  'lastSecurityCheckFingerprint',
  'lastSecurityCheckReport',
  'lastShipperApprovalAt',
];

export const TEXT_EXTENSIONS = new Set([
  '.cjs', '.conf', '.config', '.css', '.csv', '.env', '.html', '.js', '.json',
  '.jsx', '.md', '.mjs', '.mts', '.sql', '.toml', '.ts', '.tsx', '.txt',
  '.yaml', '.yml',
]);

export const FINGERPRINT_IGNORES = [
  '.git/', 'node_modules/', '.pnpm-store/', '.turbo/', '.cache/', 'dist/',
  'build/', '.next/', '.expo/', '.traffic-one/reports/security/', '.traffic-one.deploy.log',
];

export const WALK_IGNORES = new Set([
  '.git', 'node_modules', '.pnpm-store', '.turbo', '.cache', 'dist', 'build', '.next', '.expo',
]);
