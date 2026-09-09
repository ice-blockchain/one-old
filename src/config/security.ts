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
  'lastSecurityCheckStrict',
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

// Trees the built-in project scanners skip ONLY when the scan target is Traffic
// One's own authoring repo (detected via isPluginAuthoringRoot). These hold
// skill/rule/agent TEMPLATES + their generated mirrors (which carry example
// credentials as teaching material), the security scanner's OWN source + test
// fixtures (its detection regexes literally look like secrets), and the
// onboarding prompt-text builders (domain prose such as "admin roles"). Skipping
// them keeps dogfooding the scanner on the plugin repo clean WITHOUT changing how
// real end-user projects are scanned — the skip is gated on authoring-root only,
// and gitleaks/trufflehog still scan every tracked file (incl. git history) for
// genuinely committed secrets.
export const AUTHORING_SCAN_SKIP_PREFIXES = [
  'skills/', 'rules/', 'agents/', 'commands/',
  'src/modules/skills/', 'src/modules/rules/', 'src/modules/agents/', 'src/modules/commands/',
  'src/runners/security-check/',
  'src/shared/onboarding/',
];
