// src/runners/security-check/scanners-secrets.ts
// External tools, secret scanning, and supabase SQL checks.

import * as fs from 'fs';
import * as path from 'path';
import { type Issue, type Rec, type ScanReport } from './constants';
import {
  gitOutput, hasAllowComment, hasCommand, isDocumentationOrFixturePath,
  isInsideGitWorkTree, isRuntimeAppSecurityPath, isSecurityHeaderConfigPath,
  lineForIndex, missingToolInstallPrompt, parseAuditJson, projectFiles,
  readPackageJson, readTextFile, relativePath, runCommand, splitNul,
} from './helpers';

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

