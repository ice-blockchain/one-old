// src/runners/security-check/helpers.ts
// Low-level helpers: process/git exec, fingerprint + file walking, path
// classifiers, audit-json parsing, CLI args, the reporter, and package.json IO.
import * as fs from 'fs';
import * as path from 'path';

import { spawnTool } from '../../shared/spawn-tool';

import {
  AUTHORING_SCAN_SKIP_PREFIXES, FINGERPRINT_IGNORES, LEGACY_STATE_REL_PATH,
  SECURITY_STAMP_FIELDS, STATE_REL_PATH, TEXT_EXTENSIONS, WALK_IGNORES,
} from '../../config/security';
import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import {
  type AddIssue, type CommandResult, type Issue, type Rec,
} from './constants';
import { readRegularBytesOrThrow, readRegularFileOrThrow } from '../../shared/bounded-read';

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
  // spawnTool (not raw spawnSync): on Windows the package managers this audits
  // (npm/pnpm/yarn) resolve to `.cmd` shims that Node >=22 refuses to spawn
  // without it; bare names also get PATHEXT-aware resolution. POSIX = passthrough.
  const result = spawnTool(command, args, {
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
    const decoded = JSON.parse(readRegularFileOrThrow(path.join(cwd, relPath)));
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
  const bytes = readRegularBytesOrThrow(absPath);
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
    buffer = readRegularBytesOrThrow(absPath);
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
  // On Traffic One's own authoring repo, drop the template/detector/onboarding
  // trees that legitimately carry example secrets + detection regexes (see
  // AUTHORING_SCAN_SKIP_PREFIXES). Real end-user scans (not authoring-root) keep
  // full coverage.
  const skipAuthoring = isPluginAuthoringRoot(cwd);
  const keep = (filePath: string): boolean =>
    !shouldIgnoreFingerprint(filePath)
    && !(skipAuthoring && AUTHORING_SCAN_SKIP_PREFIXES.some((prefix) => filePath.startsWith(prefix)));
  if (isInsideGitWorkTree(cwd)) {
    const files = splitNul(gitOutput(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    return [...new Set(files)].map(toPosix).filter(keep).sort();
  }
  return walkFiles(cwd).filter(keep);
}

/**
 * Blanks JS/TS comments, PRESERVING every byte offset and newline — so a line
 * number computed from the result still points at the right line of the original.
 *
 * The app-security rules below match code SHAPES: a template literal handed to
 * `query(`, a `dangerouslySetInnerHTML`, an admin route. Prose is not code, and
 * matching it produced findings that named this repository's own explanatory
 * comments as vulnerabilities:
 *
 *   - `// … execute bit — reported // \`stack-test: not-applicable\`, was excused …`
 *     was reported as dynamic SQL construction (qa-evidence/stack.ts).
 *   - a comment documenting the doctor redactor's own test vectors, which spells a
 *     fake `postgres://admin:pass@host`, was reported BOTH as an admin route gated
 *     only in UI code and as a browser-reachable credential (doctor/bundle.ts).
 *
 * Secret scanning deliberately does NOT use this: a credential pasted into a
 * comment is a real leak, and `scanSecrets` keeps reading the whole file.
 *
 * String and template literals are tracked, because `//` inside `'https://…'`
 * opens no comment and blanking from there would erase real code. A `/` preceded
 * by a backslash is left alone for the same reason: `/\/\//` is a regex, not a
 * comment. Both fallbacks err toward keeping text, so an ambiguous case is still
 * scanned rather than silently exempted.
 */
export function stripComments(text: string): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < out.length; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    const escaped = i > 0 && text[i - 1] === '\\';
    if (ch === '/' && next === '/' && !escaped) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*' && !escaped) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === ch) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join('');
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
    '--stamp      On a passing run with no high findings, write lastSecurityCheck* fields (including lastSecurityCheckStrict) to .traffic-one/.one.json.',
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

export function readPackageJson(cwd: string): Rec | null {
  try {
    return JSON.parse(readRegularFileOrThrow(path.join(cwd, 'package.json'))) as Rec;
  } catch {
    return null;
  }
}
