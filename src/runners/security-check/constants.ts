// src/runners/security-check/constants.ts
// Shared constants + types for the pre-deployment security check.
import * as path from 'path';

export type Rec = Record<string, unknown>;

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

export interface Issue {
  severity: 'high' | 'medium' | 'low';
  category: string;
  message: string;
  file: string | null;
  line: number | null;
  evidence: string | null;
  remediation: string | null;
}

export type AddIssue = (severity: Issue['severity'], category: string, message: string, details?: Partial<Pick<Issue, 'file' | 'line' | 'evidence' | 'remediation'>>) => void;

export interface Fingerprint { fingerprint: string; head: string; fileCount: number; }

export interface Report {
  generatedAt: string;
  status: string;
  strict: boolean;
  cwd: string;
  fingerprint: Fingerprint;
  tools: Rec;
  externalReports: Rec;
  issues: Issue[];
  installPrompt?: string;
}

export type ScanReport = Report & { addIssue: AddIssue };

export interface CommandResult { command: string; args: string[]; status: number; stdout: string; stderr: string; error: Error | null; }
