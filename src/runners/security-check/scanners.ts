// src/runners/security-check/scanners.ts
// App security, supply-chain, audit, and mobile scanners.

import * as fs from 'fs';
import * as path from 'path';
import { type Issue, type Rec, type ScanReport } from './constants';
import {
  gitOutput, hasAllowComment, hasCommand, isDocumentationOrFixturePath,
  isInsideGitWorkTree, isRuntimeAppSecurityPath, isSecurityHeaderConfigPath,
  lineForIndex, missingToolInstallPrompt, parseAuditJson, projectFiles,
  readPackageJson, readTextFile, relativePath, runCommand, splitNul,
} from './helpers';

import { scanSecrets, scanSupabaseSql, type TextFile } from './scanners-secrets';

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

function scanSupplyChain(cwd: string, textFiles: TextFile[], report: ScanReport): void {
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

function runPackageAudit(cwd: string, presentLockfiles: string[], report: ScanReport): void {
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
export {
  runGitleaks,
  runTrufflehog,
  scanExternalTools,
  scanSecrets,
  scanSupabaseSql,
  type TextFile,
} from './scanners-secrets';
