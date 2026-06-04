// src/runners/security-check/constants.ts
// Shared types for the pre-deployment security check. The tunable knobs (report
// dir, ignore lists, text extensions, stamp fields) live in config/security.ts.

export type Rec = Record<string, unknown>;

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
