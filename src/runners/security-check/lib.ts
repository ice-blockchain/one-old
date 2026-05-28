// src/runners/security-check/lib.ts
// Helpers + scanners for the Traffic One pre-deployment security check.
// Ported 1:1 from scripts/security-check-runner/{_helpers,missingToolInstallPrompt,
// parseAuditJson}.cjs. Consolidated (no circular hoisted forwarder — DI/imports
// break the cycle). All scanner regexes/logic preserved byte-for-byte.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { legacyStatePath, statePath } from '../../shared/state';
import { pluginVersion } from '../../shared/version';

type Rec = Record<string, unknown>;

export const DEFAULT_REPORT_DIR = path.join('.traffic-one', 'reports', 'security');
const STATE_REL_PATH = '.traffic-one/.one.json';
const LEGACY_STATE_REL_PATH = STATE_REL_PATH;
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

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function relativePath(cwd: string, filePath: string): string {
  return toPosix(path.relative(cwd, filePath));
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function timestampSlug(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '-').replace('Z', 'Z');
}

export function runCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer || 50 * 1024 * 1024,
  });
  return {
    command,
    args,
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error || null,
  };
}

export function hasCommand(command: string, cwd?: string, env?: NodeJS.ProcessEnv): { found: boolean; version: string | null } {
  const result = runCommand(command, ['--version'], { cwd, env, maxBuffer: 1024 * 1024 });
  return {
    found: !result.error && result.status === 0,
    version: `${result.stdout}${result.stderr}`.trim().split(/\r?\n/)[0] || null,
  };
}

export function isInsideGitWorkTree(cwd: string): boolean {
  const result = runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return !result.error && result.status === 0 && result.stdout.trim() === 'true';
}

export function gitOutput(cwd: string, args: string[]): string {
  const result = runCommand('git', args, { cwd });
  return result.status === 0 ? result.stdout : '';
}

export function splitNul(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

export function shouldIgnoreFingerprint(relPath: string): boolean {
  const normalized = toPosix(relPath);
  return FINGERPRINT_IGNORES.some((ignored) => normalized === ignored || normalized.startsWith(ignored));
}

export function trafficStateHasOnlyStampFields(cwd: string, relPath: string): boolean {
  const normalized = toPosix(relPath);
  if (normalized !== STATE_REL_PATH && normalized !== LEGACY_STATE_REL_PATH) {
    return false;
  }
  try {
    const decoded = JSON.parse(fs.readFileSync(path.join(cwd, relPath), 'utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return false;
    }
    const copy: Rec = { ...(decoded as Rec) };
    for (const field of SECURITY_STAMP_FIELDS) {
      delete copy[field];
    }
    return Object.keys(copy).length === 0;
  } catch {
    return false;
  }
}

export function normalizeTrafficState(content: string): string {
  try {
    const decoded = JSON.parse(content);
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      return content;
    }
    const rec = decoded as Rec;
    for (const field of SECURITY_STAMP_FIELDS) {
      delete rec[field];
    }
    return `${JSON.stringify(rec, null, 2)}\n`;
  } catch {
    return content;
  }
}

export function hashFileForFingerprint(cwd: string, relPath: string): Buffer | string {
  const absPath = path.join(cwd, relPath);
  if (!fs.existsSync(absPath)) {
    return '<deleted>';
  }
  const bytes = fs.readFileSync(absPath);
  const normalized = toPosix(relPath);
  if (normalized === STATE_REL_PATH || normalized === LEGACY_STATE_REL_PATH) {
    return normalizeTrafficState(bytes.toString('utf8'));
  }
  return bytes;
}

export function walkFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (currentDir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (WALK_IGNORES.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const rel = relativePath(cwd, fullPath);
      if (rel.startsWith('.traffic-one/reports/security/')) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(cwd);
  return out.sort();
}

export function listFingerprintFiles(cwd: string): string[] {
  if (isInsideGitWorkTree(cwd)) {
    const tracked = splitNul(gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    return [...new Set(tracked)]
      .map(toPosix)
      .filter((filePath) => !shouldIgnoreFingerprint(filePath))
      .filter((filePath) => !trafficStateHasOnlyStampFields(cwd, filePath))
      .sort();
  }
  return walkFiles(cwd)
    .filter((filePath) => !shouldIgnoreFingerprint(filePath))
    .filter((filePath) => !trafficStateHasOnlyStampFields(cwd, filePath))
    .sort();
}

export function readTextFile(cwd: string, relPath: string): string | null {
  const absPath = path.join(cwd, relPath);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buffer.length > 1024 * 1024) return null;
  if (buffer.includes(0)) return null;
  const ext = path.extname(relPath).toLowerCase();
  const base = path.basename(relPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(ext) && !base.startsWith('.env') && base !== '_headers') {
    return null;
  }
  return buffer.toString('utf8');
}

export function projectFiles(cwd: string): string[] {
  if (isInsideGitWorkTree(cwd)) {
    const files = splitNul(gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    return [...new Set(files)].map(toPosix).filter((filePath) => !shouldIgnoreFingerprint(filePath)).sort();
  }
  return walkFiles(cwd).filter((filePath) => !shouldIgnoreFingerprint(filePath));
}

export function lineForIndex(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

export interface SecurityOptions {
  cwd: string;
  strict: boolean;
  stamp: boolean;
  reportDir: string | null;
  help?: boolean;
}

export function parseArgs(argv: string[]): SecurityOptions {
  const options: SecurityOptions = { cwd: process.cwd(), strict: false, stamp: false, reportDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--strict') options.strict = true;
    else if (arg === '--stamp') options.stamp = true;
    else if (arg === '--no-stamp') options.stamp = false;
    else if (arg === '--report-dir') { options.reportDir = argv[index + 1] || null; index += 1; }
    else if (arg === '--cwd') { options.cwd = argv[index + 1] || options.cwd; index += 1; }
    else if (arg === '--help' || arg === '-h') options.help = true;
  }
  return options;
}

export function helpText(): string {
  return [
    'Usage: node scripts/security-check-runner.cjs [--strict] [--stamp|--no-stamp] [--report-dir <dir>]',
    '',
    'Runs the Traffic One pre-deployment security scanner.',
    '--strict     Fail on high-confidence security issues and missing required scanners.',
    '--stamp      On a passing run, write lastSecurityCheck* fields to .traffic-one/.one.json.',
    '--no-stamp   Do not write .traffic-one/.one.json. This is the CI default.',
  ].join('\n');
}

export function createReporter(): { issues: Issue[]; addIssue: AddIssue } {
  const issues: Issue[] = [];
  const addIssue: AddIssue = (severity, category, message, details = {}) => {
    issues.push({
      severity,
      category,
      message,
      file: details.file || null,
      line: details.line || null,
      evidence: details.evidence || null,
      remediation: details.remediation || null,
    });
  };
  return { issues, addIssue };
}

export function hasAllowComment(text: string, index: number, token: string): boolean {
  const start = Math.max(0, index - 500);
  const context = text.slice(start, index + 500).toLowerCase();
  return context.includes(token.toLowerCase());
}

export function isDocumentationOrFixturePath(filePath: string): boolean {
  const normalized = toPosix(filePath);
  const base = path.basename(normalized).toLowerCase();
  return (
    normalized.endsWith('.md')
    || normalized.endsWith('.mdc')
    || normalized.startsWith('skills/')
    || normalized.startsWith('rules/')
    || normalized.startsWith('agents/')
    || normalized.startsWith('docs/')
    || normalized.startsWith('.cursor/rules/')
    || normalized.startsWith('test/')
    || normalized.startsWith('tests/')
    || normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/__tests__/')
    || normalized.includes('/fixtures/')
    || normalized.includes('/__fixtures__/')
    || normalized.includes('/mocks/')
    || normalized.includes('/__mocks__/')
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)
    || /^test-.*\.[cm]?js$/.test(base)
    || ['agents.md', 'claude.md', 'readme.md'].includes(base)
  );
}

export function isRuntimeAppSecurityPath(filePath: string): boolean {
  const normalized = toPosix(filePath);
  if (isDocumentationOrFixturePath(normalized)) return false;
  return (
    normalized.startsWith('apps/')
    || normalized.startsWith('src/')
    || normalized.startsWith('server/')
    || normalized.startsWith('api/')
    || normalized.startsWith('services/')
    || normalized.startsWith('supabase/functions/')
    || normalized.startsWith('packages/api')
    || normalized.startsWith('packages/ws-client/')
    || normalized.startsWith('packages/ui/')
    || normalized.startsWith('packages/ui-native/')
    || /\.(route|controller)\.[cm]?[jt]s$/.test(normalized)
  );
}

export function isSecurityHeaderConfigPath(filePath: string): boolean {
  const normalized = toPosix(filePath);
  const base = path.basename(normalized).toLowerCase();
  return (
    base === '_headers'
    || base === 'vercel.json'
    || base === 'netlify.toml'
    || base === 'wrangler.toml'
    || base === 'next.config.js'
    || base === 'next.config.mjs'
    || base === 'next.config.ts'
    || normalized.includes('/nginx')
    || normalized.includes('/caddyfile')
  );
}

export function parseAuditJson(stdout: string): { parsed: boolean; high: number; critical: number } {
  try {
    const parsed = JSON.parse(stdout) as Rec;
    const metadata = parsed.metadata as Rec | undefined;
    const vulns = metadata && typeof metadata === 'object' ? metadata.vulnerabilities as Rec | undefined : undefined;
    if (vulns) {
      return { parsed: true, high: Number(vulns.high || 0), critical: Number(vulns.critical || 0) };
    }
    if (Array.isArray(parsed.vulnerabilities)) {
      const items = parsed.vulnerabilities as Rec[];
      return {
        parsed: true,
        high: items.filter((item) => item.severity === 'high').length,
        critical: items.filter((item) => item.severity === 'critical').length,
      };
    }
    if (parsed.advisories && typeof parsed.advisories === 'object') {
      const values = Object.values(parsed.advisories as Rec) as Rec[];
      return {
        parsed: true,
        high: values.filter((item) => item.severity === 'high').length,
        critical: values.filter((item) => item.severity === 'critical').length,
      };
    }
  } catch {
    // fall through
  }
  return { parsed: false, high: 0, critical: 0 };
}

export function missingToolInstallPrompt(missingTools: string[], cwd: string = process.cwd()): string {
  const brew = hasCommand('brew', cwd, process.env);
  const installCommand = brew.found
    ? `brew install ${missingTools.join(' ')}`
    : '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"\n'
      + `brew install ${missingTools.join(' ')}`;

  return [
    'Traffic One needs local security scanners before it can run the pre-deployment gate.',
    '',
    `Missing: ${missingTools.join(', ')}`,
    '',
    'Benefits of installing them:',
    '- gitleaks scans the working tree and full git history for API keys, service-role keys, tokens, and committed .env secrets before they reach production.',
    '- trufflehog verifies/flags known and unknown secrets across git history, catching leaks that simple pattern matching misses.',
    '- Together they make the local deploy gate match CI instead of discovering credential leaks only after a push.',
    '',
    brew.found
      ? 'Recommended install command:'
      : 'Homebrew was not found. Ask the user to install Homebrew first, then install the scanners:',
    '',
    installCommand,
  ].join('\n');
}

export function scanExternalTools(cwd: string, reportDir: string, report: ScanReport): void {
  const gitleaks = hasCommand('gitleaks', cwd, process.env);
  const trufflehog = hasCommand('trufflehog', cwd, process.env);
  report.tools.gitleaks = gitleaks.version || 'missing';
  report.tools.trufflehog = trufflehog.version || 'missing';
  const missingTools = [
    gitleaks.found ? null : 'gitleaks',
    trufflehog.found ? null : 'trufflehog',
  ].filter((value): value is string => Boolean(value));

  if (missingTools.length > 0) {
    report.installPrompt = missingToolInstallPrompt(missingTools, cwd);
  }

  if (!gitleaks.found) {
    report.addIssue('high', 'secrets', 'gitleaks is required for pre-deployment secret scanning but was not found on PATH.', {
      remediation: 'Ask the user to install gitleaks locally with Homebrew, or use CI where v8.30.1 is pinned.',
    });
  } else {
    runGitleaks(cwd, reportDir, report, 'git-history', ['git', '--log-opts=--all', '--redact=100', '--report-format=json']);
    runGitleaks(cwd, reportDir, report, 'working-tree', ['dir', '--redact=100', '--report-format=json']);
  }

  if (!trufflehog.found) {
    report.addIssue('high', 'secrets', 'trufflehog is required for pre-deployment verified/unknown secret scanning but was not found on PATH.', {
      remediation: 'Ask the user to install trufflehog locally with Homebrew, or use CI where v3.94.3 is pinned.',
    });
  } else {
    runTrufflehog(cwd, report);
  }
}

export function runGitleaks(cwd: string, reportDir: string, report: ScanReport, name: string, baseArgs: string[]): void {
  const reportPath = path.join(reportDir, `gitleaks-${name}.json`);
  const args = [...baseArgs, '--report-path', reportPath, '.'];
  const result = runCommand('gitleaks', args, { cwd });
  report.externalReports[`gitleaks-${name}`] = relativePath(cwd, reportPath);
  let findings: Rec[] = [];
  try {
    const text = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
    findings = text.trim() ? JSON.parse(text) as Rec[] : [];
  } catch {
    findings = [];
  }
  if (Array.isArray(findings) && findings.length > 0) {
    for (const finding of findings.slice(0, 50)) {
      report.addIssue('high', 'secrets', `gitleaks ${name} found ${finding.RuleID || 'a secret'}.`, {
        file: (finding.File as string) || null,
        line: (finding.StartLine as number) || (finding.Line as number) || null,
        evidence: (finding.Fingerprint as string) || (finding.Description as string) || null,
        remediation: 'Rotate the leaked credential, remove it from code/history, and rerun the scanner.',
      });
    }
    if (findings.length > 50) {
      report.addIssue('high', 'secrets', `gitleaks ${name} found ${findings.length - 50} additional secrets.`, {
        remediation: `See ${relativePath(cwd, reportPath)} for the full finding set.`,
      });
    }
  } else if (result.status !== 0) {
    report.addIssue('high', 'secrets', `gitleaks ${name} scan failed before producing a clean report.`, {
      evidence: result.stderr || result.stdout || `exit ${result.status}`,
      remediation: 'Fix the scanner invocation or run it locally to inspect the failure.',
    });
  }
}

export function runTrufflehog(cwd: string, report: ScanReport): void {
  const result = runCommand('trufflehog', ['--no-update', 'git', 'file://.', '--results=verified,unknown', '--json', '--fail'], { cwd });
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
  const findings: Rec[] = [];
  for (const line of lines) {
    try {
      findings.push(JSON.parse(line) as Rec);
    } catch {
      // Ignore non-JSON progress output.
    }
  }
  for (const finding of findings.slice(0, 50)) {
    const sourceMeta = finding.SourceMetadata as Rec | undefined;
    const data = sourceMeta && typeof sourceMeta === 'object' ? sourceMeta.Data as Rec | undefined : undefined;
    const gitData = (data && typeof data === 'object' ? data.Git as Rec | undefined : undefined) || {};
    const severity: Issue['severity'] = finding.Verified === true ? 'high' : 'medium';
    report.addIssue(severity, 'secrets', `trufflehog found ${finding.DetectorName || 'a secret'} (${finding.Verified ? 'verified' : 'unknown'}).`, {
      file: (gitData.file as string) || null,
      line: (gitData.line as number) || null,
      evidence: (gitData.commit as string) || (finding.Redacted as string) || null,
      remediation: 'Rotate the leaked credential and remove it from git history before deploying.',
    });
  }
  if (findings.length > 50) {
    report.addIssue('high', 'secrets', `trufflehog found ${findings.length - 50} additional secrets.`, {
      remediation: 'Rerun trufflehog locally for the full output.',
    });
  } else if (result.status !== 0 && result.status !== 183 && findings.length === 0) {
    report.addIssue('high', 'secrets', 'trufflehog scan failed before producing a clean report.', {
      evidence: result.stderr || result.stdout || `exit ${result.status}`,
      remediation: 'Fix the scanner invocation or run it locally to inspect the failure.',
    });
  }
}

export interface TextFile { filePath: string; text: string; }

export function scanProject(cwd: string, report: ScanReport): void {
  const files = projectFiles(cwd);
  const textFiles: TextFile[] = files
    .map((filePath) => ({ filePath, text: readTextFile(cwd, filePath) }))
    .filter((entry): entry is TextFile => entry.text !== null);

  scanSecrets(cwd, textFiles, report);
  scanSupabaseSql(textFiles, report);
  scanAppSecurity(cwd, textFiles, report);
  scanSupplyChain(cwd, textFiles, report);
  scanMobile(textFiles, report);
}

export function scanSecrets(cwd: string, textFiles: TextFile[], report: ScanReport): void {
  const tracked = isInsideGitWorkTree(cwd)
    ? splitNul(gitOutput(cwd, ['ls-files', '-z']))
    : textFiles.map((entry) => entry.filePath);
  for (const filePath of tracked) {
    const base = path.basename(filePath).toLowerCase();
    if (
      base.startsWith('.env')
      && !['.env.example', '.env.sample', '.env.template', '.env.defaults'].includes(base)
    ) {
      report.addIssue('high', 'secrets', 'Environment file is tracked or deployable.', {
        file: filePath,
        remediation: 'Remove the file from git, rotate any leaked values, and keep only .env.example templates.',
      });
    }
  }

  const clientSecretName = /\b(?:VITE|NEXT_PUBLIC|EXPO_PUBLIC)_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|JWT|DATABASE|DB_|OPENAI|ANTHROPIC|STRIPE|PRIVATE|ADMIN|PASSWORD)[A-Z0-9_]*\b/g;
  const secretValue = /\b(?:SUPABASE_SERVICE_ROLE_KEY|JWT_SECRET|service_role|sb_secret_[A-Za-z0-9_]+|sk-(?:live|proj|test)-[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/[^\s'"]+|ghp_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16})\b/g;
  const hardcodedFallback = /(?:process\.env|import\.meta\.env|Deno\.env\.get\([^)]+\))[\s\S]{0,80}(?:\|\||\?\?)[\s\S]{0,30}['"][^'"]*(?:sk-|service_role|sb_secret_|postgres(?:ql)?:\/\/|JWT_SECRET|SUPABASE_SERVICE_ROLE)/g;

  for (const { filePath, text } of textFiles) {
    const isExample = isDocumentationOrFixturePath(filePath);
    const isClientSurface = /(^|\/)(src|app|components|pages|packages\/ui|packages\/ui-native)\//.test(filePath)
      && !/(server|api|supabase\/functions|\.test\.|\.spec\.)/.test(filePath);
    if (!isExample) {
      for (const match of text.matchAll(clientSecretName)) {
        report.addIssue('high', 'secrets', 'Client-prefixed environment variable appears to contain a secret.', {
          file: filePath,
          line: lineForIndex(text, match.index || 0),
          evidence: match[0],
          remediation: 'Move this value to server-only env or Supabase Edge Function secrets.',
        });
      }
    }
    for (const match of text.matchAll(secretValue)) {
      if (isClientSurface || /capacitor\.config|app\.json|app\.config|eas\.json/.test(filePath)) {
        report.addIssue('high', 'secrets', 'Browser/mobile reachable file contains a secret-looking credential.', {
          file: filePath,
          line: lineForIndex(text, match.index || 0),
          evidence: match[0].slice(0, 24),
          remediation: 'Rotate the value and move it behind a trusted server boundary.',
        });
      }
    }
    if (!isExample) {
      for (const match of text.matchAll(hardcodedFallback)) {
        report.addIssue('high', 'secrets', 'Environment variable has a hardcoded secret fallback.', {
          file: filePath,
          line: lineForIndex(text, match.index || 0),
          remediation: 'Fail fast on missing env vars instead of shipping fallback credentials.',
        });
      }
    }
    if (/localStorage\.(?:setItem|getItem)\([^)]*(?:token|jwt|session|refresh)/i.test(text)) {
      report.addIssue('high', 'auth', 'JWT/session token appears to be stored in localStorage.', {
        file: filePath,
        remediation: 'Use httpOnly cookies, in-memory state, expo-secure-store, or a reviewed Capacitor secure storage plugin.',
      });
    }
    if (/supabase\.auth\.admin\b/.test(text) && isClientSurface) {
      report.addIssue('high', 'secrets', 'Supabase auth admin API is referenced from a client surface.', {
        file: filePath,
        remediation: 'Call admin APIs only from trusted server code with server-side authorization.',
      });
    }
  }
}

export function scanSupabaseSql(textFiles: TextFile[], report: ScanReport): void {
  const sqlFiles = textFiles.filter(({ filePath }) => filePath.endsWith('.sql') || filePath.includes('supabase/migrations/'));
  for (const { filePath, text } of sqlFiles) {
    const lower = text.toLowerCase();
    const tableNames = new Set<string>();
    for (const match of lower.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?public"?\.)?"?([a-z_][\w]*)"?/g)) {
      if (match[1]) tableNames.add(match[1]);
    }
    for (const tableName of tableNames) {
      const rlsRe = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:"?public"?\\.)?"?${tableName}"?\\s+enable\\s+row\\s+level\\s+security`, 'i');
      if (!rlsRe.test(text)) {
        report.addIssue('high', 'supabase-rls', `Public table "${tableName}" is created without enabling RLS.`, {
          file: filePath,
          remediation: `Add "alter table public.${tableName} enable row level security;" in the same migration.`,
        });
      }
    }

    for (const match of text.matchAll(/create\s+policy\b[\s\S]*?;/gi)) {
      const block = match[0];
      const blockLower = block.toLowerCase();
      const line = lineForIndex(text, match.index || 0);
      const command = blockLower.match(/\sfor\s+(select|insert|update|delete|all)\b/)?.[1] ?? 'all';
      const hasAuthenticated = /\bto\s+[^;]*(?:\bauthenticated\b)/i.test(block);
      const hasPublicRole = /\bto\s+[^;]*(?:\bpublic\b|\banon\b)/i.test(block);
      const allowPublicRead = command === 'select' && hasAllowComment(text, match.index || 0, 'traffic-one-allow-public-read');

      if (!/\bto\s+/i.test(block)) {
        report.addIssue('high', 'supabase-rls', 'RLS policy is missing an explicit TO role.', {
          file: filePath,
          line,
          remediation: 'Use "to authenticated" unless this is an explicitly allowlisted public read.',
        });
      }
      if (!hasAuthenticated && !allowPublicRead) {
        report.addIssue('high', 'supabase-rls', 'RLS policy does not explicitly target authenticated users.', {
          file: filePath,
          line,
          remediation: 'Add "to authenticated" or add a traffic-one-allow-public-read comment for intentional public SELECT.',
        });
      }
      if (hasPublicRole && !allowPublicRead) {
        report.addIssue('high', 'supabase-rls', 'RLS policy targets anon/public without an explicit public-read allowlist.', {
          file: filePath,
          line,
          remediation: 'Restrict the policy to authenticated or add a reviewed public-read allowlist comment.',
        });
      }
      for (const authMatch of blockLower.matchAll(/auth\.uid\(\)/g)) {
        const before = blockLower.slice(Math.max(0, (authMatch.index || 0) - 24), authMatch.index || 0);
        if (!/\(\s*select\s*$/.test(before)) {
          report.addIssue('high', 'supabase-rls', 'RLS policy calls auth.uid() without wrapping it in (select auth.uid()).', {
            file: filePath,
            line,
            remediation: 'Use "(select auth.uid())" so Postgres can cache the value per statement.',
          });
          break;
        }
      }
      if (/auth\.jwt\(\)[\s\S]{0,80}user_metadata/.test(blockLower)) {
        report.addIssue('high', 'supabase-rls', 'RLS policy uses user_metadata as an authorization primitive.', {
          file: filePath,
          line,
          remediation: 'Use app_metadata or a server-owned roles table instead.',
        });
      }
    }

    for (const match of text.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:"?public"?\.)?"?([a-z_][\w]*)"?[\s\S]*?;/gi)) {
      const viewName = match[1];
      if (viewName && !/security_invoker\s*=\s*true/i.test(match[0])) {
        const revokeRe = new RegExp(`revoke[\\s\\S]+on[\\s\\S]+${viewName}[\\s\\S]+from[\\s\\S]+(?:anon|authenticated)`, 'i');
        if (!revokeRe.test(text)) {
          report.addIssue('high', 'supabase-rls', `View "${viewName}" may bypass RLS because security_invoker is not enabled.`, {
            file: filePath,
            line: lineForIndex(text, match.index || 0),
            remediation: 'Use "with (security_invoker = true)" on PG15+ or revoke anon/authenticated access.',
          });
        }
      }
    }

    if (/create\s+extension[\s\S]{0,120}\b(http|pg_net)\b/i.test(text)) {
      report.addIssue('high', 'supabase-rls', 'Network-capable Postgres extension is enabled.', {
        file: filePath,
        remediation: 'Keep network-capable functions out of exposed RPC paths and review for SSRF.',
      });
    }
    if (/grant\s+execute\s+on\s+function[\s\S]+to\s+(?:anon|authenticated)/i.test(text) && /\b(?:http_|net\.http|http_get|http_post)\b/i.test(text)) {
      report.addIssue('high', 'supabase-rls', 'Network-capable function is exposed through RPC.', {
        file: filePath,
        remediation: 'Revoke anon/authenticated execute or move the function to a trusted server-only path.',
      });
    }
    if (
      /insert\s+into\s+storage\.buckets[\s\S]{0,500}(?:public\s*=>\s*true)/i.test(text)
      || /insert\s+into\s+storage\.buckets\s*\([^)]*\bpublic\b[^)]*\)\s*values\s*\([^;]*\btrue\b/i.test(text)
    ) {
      report.addIssue('high', 'storage', 'Supabase Storage bucket is public by default.', {
        file: filePath,
        remediation: 'Default buckets to private and serve files through signed URLs or authenticated object access.',
      });
    }
    if (/storage\.buckets/i.test(text) && !/on\s+storage\.objects/i.test(text)) {
      report.addIssue('high', 'storage', 'Storage bucket is created without storage.objects RLS policies.', {
        file: filePath,
        remediation: 'Add SELECT/INSERT/UPDATE/DELETE policies on storage.objects for the bucket.',
      });
    }
    for (const match of text.matchAll(/create\s+policy\b[\s\S]*?on\s+storage\.objects[\s\S]*?;/gi)) {
      const block = match[0];
      const line = lineForIndex(text, match.index || 0);
      if (!/\bto\s+authenticated\b/i.test(block)) {
        report.addIssue('high', 'storage', 'storage.objects policy does not target authenticated users.', {
          file: filePath,
          line,
          remediation: 'Restrict Storage policies to authenticated users unless a public read is explicitly reviewed.',
        });
      }
      if (/\bfor\s+(insert|update|delete|all)\b/i.test(block) && !/\bbucket_id\s*=/.test(block)) {
        report.addIssue('high', 'storage', 'Writable storage.objects policy is not scoped to a bucket_id.', {
          file: filePath,
          line,
          remediation: 'Scope writable object policies to the intended bucket and user-owned path.',
        });
      }
    }
  }
}

export function scanAppSecurity(cwd: string, textFiles: TextFile[], report: ScanReport): void {
  const appTextFiles = textFiles.filter(({ filePath }) => isRuntimeAppSecurityPath(filePath));
  const headerTextFiles = textFiles.filter(({ filePath }) =>
    isRuntimeAppSecurityPath(filePath) || isSecurityHeaderConfigPath(filePath));
  const allText = headerTextFiles.map(({ text }) => text).join('\n');
  const hasHeaderEvidence = /content-security-policy|frame-ancestors|strict-transport-security|permissions-policy|referrer-policy/i.test(allText);
  const packageJson = readPackageJson(cwd);
  const deps: Rec = packageJson ? { ...((packageJson.dependencies as Rec) || {}), ...((packageJson.devDependencies as Rec) || {}) } : {};
  if ((deps.react || deps.vite || deps.next) && !hasHeaderEvidence) {
    report.addIssue('high', 'headers', 'SPA/web app has no security-header evidence.', {
      remediation: 'Configure CSP, HSTS, frame-ancestors/X-Frame-Options, Referrer-Policy, and Permissions-Policy on the production host.',
    });
  }

  for (const { filePath, text } of appTextFiles) {
    const lowerPath = filePath.toLowerCase();
    const isServer = /(^|\/)(server|api|routes?|controllers?|supabase\/functions)(\/|$)|\.(route|controller)\.(ts|js)$/.test(lowerPath);
    const isStateChanging = /\b(POST|PUT|PATCH|DELETE)\b|export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)|Deno\.serve|app\.(post|put|patch|delete)\(/.test(text);
    if (isServer && isStateChanging && !/(auth\.uid|getUser|requireAuth|withAuth|jwtVerify|verifyJwt|session|currentUser|auth\.getUser)/i.test(text) && !/traffic-one-public-endpoint/i.test(text)) {
      report.addIssue('high', 'access-control', 'State-changing endpoint has no server-side authentication evidence.', {
        file: filePath,
        remediation: 'Authenticate in trusted server code before mutating data.',
      });
    }
    if (isServer && isStateChanging && /\.(update|delete|upsert|insert)\b/i.test(text) && !/(owner|user_id|auth\.uid|candidate_id|employer_id|account_id|tenant_id)/i.test(text)) {
      report.addIssue('high', 'access-control', 'State-changing data access has no ownership/tenant check evidence.', {
        file: filePath,
        remediation: 'Enforce record ownership server-side or through RLS policies, not only in the UI.',
      });
    }
    if (isServer && /(auth|otp|signup|sign-up|reset|password|openai|anthropic|llm|completion|generate)/i.test(`${filePath}\n${text}`) && !/(rateLimit|limiter|throttle|arcjet|upstash|slowDown|quota)/i.test(text)) {
      report.addIssue('high', 'rate-limit', 'Sensitive or expensive endpoint has no rate-limit evidence.', {
        file: filePath,
        remediation: 'Add rate limiting to auth, reset, OTP, signup, AI/LLM, and expensive query paths.',
      });
    }
    if (isServer && /fetch\(\s*(?:url|targetUrl|requestUrl|req\.|request\.|params\.|searchParams\.get)/i.test(text)) {
      report.addIssue('high', 'access-control', 'Server fetch appears to use a user-controlled URL.', {
        file: filePath,
        remediation: 'Allowlist hosts/schemes and proxy only vetted destinations to avoid SSRF.',
      });
    }
    if (/access-control-allow-origin['"]?\s*[:,]\s*['"]\*/i.test(text) && /access-control-allow-credentials['"]?\s*[:,]\s*['"]?true/i.test(text)) {
      report.addIssue('high', 'cors', 'CORS allows wildcard origins with credentials.', {
        file: filePath,
        remediation: 'Use an explicit allowed_origins list for credentialed requests.',
      });
    }
    if (lowerPath.includes('supabase/functions/') && !/OPTIONS|corsHeaders|Access-Control-Allow-Origin/i.test(text)) {
      report.addIssue('high', 'cors', 'Supabase Edge Function has no CORS/preflight evidence.', {
        file: filePath,
        remediation: 'Handle OPTIONS preflight and set restrictive CORS headers.',
      });
    }
    if (/(?:query|execute|raw|sql)\s*\(\s*`[\s\S]*\$\{/i.test(text) || /EXECUTE\s+[^;]*\|\|/i.test(text)) {
      report.addIssue('high', 'injection', 'Potential dynamic SQL construction from interpolation/concatenation.', {
        file: filePath,
        remediation: 'Use parameterized queries or typed query builders only.',
      });
    }
    if (/dangerouslySetInnerHTML/i.test(text) && !/DOMPurify|sanitize/i.test(text)) {
      report.addIssue('high', 'xss', 'dangerouslySetInnerHTML is used without sanitizer evidence.', {
        file: filePath,
        remediation: 'Sanitize trusted HTML with DOMPurify and enforce a CSP.',
      });
    }
    if (/react-markdown|marked\(|markdown-it/i.test(text) && !/rehype-sanitize|DOMPurify|sanitize/i.test(text)) {
      report.addIssue('high', 'xss', 'Markdown rendering has no sanitizer evidence.', {
        file: filePath,
        remediation: 'Use rehype-sanitize or DOMPurify for untrusted Markdown.',
      });
    }
    if (/(multer|formData|\.upload\(|createBucket|storage\.from\()/i.test(text) && !/(fileSizeLimit|maxFileSize|allowedMimeTypes|mime|content-type|size)/i.test(text)) {
      report.addIssue('high', 'uploads', 'File upload/storage code has no MIME or size limit evidence.', {
        file: filePath,
        remediation: 'Validate MIME type, extension, size, bucket, and user-owned path before upload.',
      });
    }
    if (/\/admin|adminroute|role\s*===\s*['"]admin['"]|roles?\.includes\(['"]admin['"]\)/i.test(`${filePath}\n${text}`) && !isServer) {
      report.addIssue('high', 'access-control', 'Admin access appears to be gated only in client/UI code.', {
        file: filePath,
        remediation: 'Enforce admin authorization in server code or RLS policies.',
      });
    }
    if (/createHash\(['"](?:md5|sha1)['"]\)[\s\S]{0,120}password/i.test(text) || /password[\s\S]{0,120}createHash\(['"](?:md5|sha1)['"]\)/i.test(text)) {
      report.addIssue('high', 'crypto', 'Password hashing appears to use MD5/SHA1.', {
        file: filePath,
        remediation: 'Use bcrypt or argon2 with reviewed parameters.',
      });
    }
    if (isServer && /(admin|payment|stripe|auth|login|signup)/i.test(`${filePath}\n${text}`) && !/(logger|audit|Sentry|captureException|console\.(warn|error))/i.test(text)) {
      report.addIssue('medium', 'logging', 'Sensitive endpoint has no security logging/alerting evidence.', {
        file: filePath,
        remediation: 'Log auth events, admin actions, payment events, and authorization failures without secrets/PII.',
      });
    }
  }
}

export function scanSupplyChain(cwd: string, textFiles: TextFile[], report: ScanReport): void {
  const pkg = readPackageJson(cwd);
  if (!pkg) return;
  const lockfiles = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lockb', 'bun.lock'];
  const presentLockfiles = lockfiles.filter((lockfile) => fs.existsSync(path.join(cwd, lockfile)));
  if (presentLockfiles.length === 0) {
    report.addIssue('high', 'supply-chain', 'package.json exists without a committed lockfile.', {
      file: 'package.json',
      remediation: 'Commit the package-manager lockfile before deploying.',
    });
  }
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : {};
  for (const [name, script] of Object.entries(scripts)) {
    if (/^(preinstall|install|postinstall|prepare)$/.test(name) && /\b(curl|wget|nc|bash\s+-c|sh\s+-c|node\s+-e|base64|eval)\b/i.test(String(script))) {
      report.addIssue('high', 'supply-chain', `Suspicious lifecycle script "${name}" detected.`, {
        file: 'package.json',
        evidence: String(script).slice(0, 120),
        remediation: 'Remove network/shell lifecycle scripts or document a reviewed supply-chain exception.',
      });
    }
  }
  const lockText = textFiles
    .filter(({ filePath }) => lockfiles.includes(path.basename(filePath)) || filePath === 'package.json')
    .map(({ text }) => text)
    .join('\n');
  if (/(Shai-Hulud|SHA1HULUD|setup_bun\.js|bun_environment\.js)/i.test(lockText)) {
    report.addIssue('high', 'supply-chain', 'Known malicious npm campaign indicator found in dependency metadata.', {
      remediation: 'Stop deployment, isolate the environment, rotate credentials, and investigate package integrity.',
    });
  }
  for (const { filePath, text } of textFiles) {
    if (/<script\b[^>]+src=["']https?:\/\/[^"']+["'][^>]*>/i.test(text)) {
      for (const match of text.matchAll(/<script\b[^>]+src=["']https?:\/\/[^"']+["'][^>]*>/gi)) {
        if (!/\bintegrity=["'][^"']+["']/i.test(match[0])) {
          report.addIssue('high', 'supply-chain', 'CDN-loaded script is missing Subresource Integrity.', {
            file: filePath,
            line: lineForIndex(text, match.index || 0),
            remediation: 'Add SRI or self-host the script.',
          });
        }
      }
    }
  }
  runPackageAudit(cwd, presentLockfiles, report);
}

export function runPackageAudit(cwd: string, presentLockfiles: string[], report: ScanReport): void {
  if (presentLockfiles.length === 0) return;
  let command = 'npm';
  let args = ['audit', '--omit=dev', '--json'];
  if (presentLockfiles.includes('pnpm-lock.yaml')) {
    command = 'pnpm';
    args = ['audit', '--prod', '--json'];
  } else if (presentLockfiles.includes('yarn.lock')) {
    command = 'yarn';
    args = ['npm', 'audit', '--environment', 'production', '--json'];
  } else if (presentLockfiles.includes('bun.lock') || presentLockfiles.includes('bun.lockb')) {
    command = 'bun';
    args = ['audit', '--json'];
  }
  const binary = hasCommand(command, cwd, process.env);
  if (!binary.found) {
    report.addIssue('high', 'supply-chain', `${command} is required to audit production dependencies but was not found on PATH.`, {
      remediation: 'Install the package manager or run the pinned CI workflow.',
    });
    return;
  }
  const result = runCommand(command, args, { cwd });
  const parsed = parseAuditJson(result.stdout);
  if (parsed.high + parsed.critical > 0) {
    report.addIssue('high', 'supply-chain', `Production dependency audit found ${parsed.high} high and ${parsed.critical} critical vulnerabilities.`, {
      remediation: 'Upgrade, patch, or remove affected dependencies before deploy.',
    });
  } else if (result.status !== 0 && !parsed.parsed) {
    report.addIssue('high', 'supply-chain', 'Dependency audit failed before producing a readable report.', {
      evidence: result.stderr || result.stdout || `exit ${result.status}`,
      remediation: 'Run the audit command locally and fix the invocation or dependency metadata.',
    });
  }
}

export function scanMobile(textFiles: TextFile[], report: ScanReport): void {
  const hasCapacitor = textFiles.some(({ filePath }) => /capacitor\.config\.(ts|js|json)$|ionic\.config\.json$/.test(filePath));
  const hasExpo = textFiles.some(({ filePath, text }) => /app\.(json|config\.(ts|js))$/.test(filePath) && /expo/i.test(text));
  if (!hasCapacitor && !hasExpo) return;
  const combined = textFiles.map(({ text }) => text).join('\n');
  if (/SUPABASE_SERVICE_ROLE_KEY|sb_secret_|sk-live|sk-proj|STRIPE_SECRET|OPENAI_API_KEY|JWT_SECRET/.test(combined)) {
    report.addIssue('high', 'mobile', 'Mobile project contains bundled secret-looking configuration.', {
      remediation: 'A packaged IPA/APK is extractable; move secrets to a server or Edge Function.',
    });
  }
  if (hasExpo && /AsyncStorage[\s\S]{0,120}(token|session|refresh|jwt)/i.test(combined)) {
    report.addIssue('high', 'mobile', 'React Native token/session storage uses AsyncStorage.', {
      remediation: 'Use expo-secure-store for tokens and refresh secrets.',
    });
  }
  if (hasCapacitor && /localStorage[\s\S]{0,120}(token|session|refresh|jwt)/i.test(combined)) {
    report.addIssue('high', 'mobile', 'Capacitor token/session storage uses localStorage.', {
      remediation: 'Use a reviewed Capacitor secure storage plugin, Keychain, or Keystore.',
    });
  }
  if (/@supabase\/supabase-js|createClient\(/.test(combined) && !/flowType\s*:\s*['"]pkce['"]|FlowType\.PKCE|flowType\s*=\s*FlowType\.PKCE/i.test(combined)) {
    report.addIssue('high', 'mobile', 'Supabase mobile auth has no PKCE flow evidence.', {
      remediation: 'Configure Supabase auth with flowType: "pkce" and validated deep-link handling.',
    });
  }
}

export function readPackageJson(cwd: string): Rec | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Rec;
  } catch {
    return null;
  }
}

export interface ReportPaths { jsonPath: string; markdownPath: string; relativeJsonPath: string; relativeMarkdownPath: string; }

export function writeReports(cwd: string, reportDir: string, report: Report): ReportPaths {
  fs.mkdirSync(reportDir, { recursive: true });
  const slug = timestampSlug(report.generatedAt);
  const jsonPath = path.join(reportDir, `security-check-${slug}.json`);
  const markdownPath = path.join(reportDir, `security-check-${slug}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownPath, renderMarkdownReport(report), 'utf8');
  return {
    jsonPath,
    markdownPath,
    relativeJsonPath: relativePath(cwd, jsonPath),
    relativeMarkdownPath: relativePath(cwd, markdownPath),
  };
}

export function renderMarkdownReport(report: Report): string {
  const blockers = report.issues.filter((issue) => issue.severity === 'high');
  const warnings = report.issues.filter((issue) => issue.severity !== 'high');
  const lines = [
    '# Traffic One Pre-Deployment Security Check',
    '',
    `Status: ${report.status.toUpperCase()}`,
    `Generated: ${report.generatedAt}`,
    `Fingerprint: ${report.fingerprint.fingerprint}`,
    '',
    `High findings: ${blockers.length}`,
    `Warnings: ${warnings.length}`,
    '',
  ];
  for (const issue of report.issues) {
    const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : 'project';
    lines.push(`- [${issue.severity}] ${issue.category} — ${location} — ${issue.message}`);
    if (issue.remediation) {
      lines.push(`  Fix: ${issue.remediation}`);
    }
  }
  if (report.issues.length === 0) {
    lines.push('No findings.');
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

export function stampState(cwd: string, report: Report, relativeReportPath: string): void {
  const nextStatePath = statePath(cwd);
  const oldStatePath = legacyStatePath(cwd);
  let state: Rec = {};
  try {
    const readableStatePath = fs.existsSync(nextStatePath) ? nextStatePath : oldStatePath;
    state = JSON.parse(fs.readFileSync(readableStatePath, 'utf8')) as Rec;
  } catch {
    state = {};
  }
  state.lastSecurityCheckAt = report.generatedAt;
  state.lastSecurityCheckStatus = 'passed';
  state.lastSecurityCheckFingerprint = report.fingerprint.fingerprint;
  state.lastSecurityCheckReport = relativeReportPath;
  delete state.pluginVersion;
  const version = pluginVersion();
  if (version) {
    state.version = version;
  }
  fs.mkdirSync(path.dirname(nextStatePath), { recursive: true });
  fs.writeFileSync(nextStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
