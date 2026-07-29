// src/runners/lighthouse/cli-args.ts
// Lighthouse runner defaults, argument parsing, and usage text.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Rec = Record<string, unknown>;

export const DEFAULTS = {
  host: '127.0.0.1',
  lighthouseVersion: '13.2.0',
  outDir: '.traffic-one/reports/lighthouse',
  performanceMin: 90,
  fcpMax: 1500,
  lcpMax: 2500,
  tbtMax: 200,
  clsMax: 0.1,
  route: '/',
  timeoutMs: 30000,
  lighthouseTimeoutMs: 120000,
  maxRuntimeMs: 240000,
} as const;

export interface LighthouseArgs {
  host: string;
  lighthouseVersion: string;
  outDir: string;
  performanceMin: number;
  fcpMax: number;
  lcpMax: number;
  tbtMax: number;
  clsMax: number;
  route: string;
  timeoutMs: number;
  lighthouseTimeoutMs: number;
  maxRuntimeMs: number;
  build: boolean;
  preview: boolean;
  // Never fall back to a network install (`pnpm dlx lighthouse@…`) when no local
  // binary exists — exit with blocked:lighthouse-missing instead. Approval layers
  // that deny registry-download execution (observed: Codex Desktop guardian) deny
  // the WHOLE runner when the dlx branch is reachable; this flag makes the
  // no-download contract explicit in the invocation.
  localOnly: boolean;
  url?: string;
  help?: boolean;
  skipPreview?: boolean;
}

export function parseArgs(argv: string[]): LighthouseArgs {
  const args: LighthouseArgs = { ...DEFAULTS, build: true, preview: true, localOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    switch (item) {
      case '--url':
        args.url = next;
        index += 1;
        break;
      case '--route':
        args.route = next || '/';
        index += 1;
        break;
      case '--out':
        args.outDir = next || DEFAULTS.outDir;
        index += 1;
        break;
      case '--performance-min':
        args.performanceMin = Number(next);
        index += 1;
        break;
      case '--fcp-max':
        args.fcpMax = Number(next);
        index += 1;
        break;
      case '--lcp-max':
        args.lcpMax = Number(next);
        index += 1;
        break;
      case '--tbt-max':
        args.tbtMax = Number(next);
        index += 1;
        break;
      case '--cls-max':
        args.clsMax = Number(next);
        index += 1;
        break;
      case '--lighthouse-version':
        args.lighthouseVersion = next || DEFAULTS.lighthouseVersion;
        index += 1;
        break;
      case '--timeout':
        {
          const parsed = Number(next);
          args.timeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.timeoutMs;
        }
        index += 1;
        break;
      case '--lighthouse-timeout':
        {
          const parsed = Number(next);
          args.lighthouseTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.lighthouseTimeoutMs;
        }
        index += 1;
        break;
      case '--max-runtime':
        {
          const parsed = Number(next);
          args.maxRuntimeMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULTS.maxRuntimeMs;
        }
        index += 1;
        break;
      case '--skip-build':
        args.build = false;
        break;
      case '--skip-preview':
        args.preview = false;
        break;
      case '--local-only':
        args.localOnly = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (!args.url && item?.startsWith('http')) {
          args.url = item;
        }
    }
  }
  return args;
}

export function usage(): string {
  return [
    'traffic-one Lighthouse runner',
    '',
    'Usage:',
    '  node scripts/lighthouse-runner.mjs [--route /] [--url http://127.0.0.1:4173/]',
    '',
    'Defaults:',
    '  Builds the project, starts a production preview on a free local port,',
    '  runs Lighthouse mobile Performance, writes JSON + HTML reports, and',
    '  exits non-zero when thresholds fail.',
    '',
    'Options:',
    '  --route <path>              Route to audit when the runner starts preview',
    '  --url <url>                 Audit an already-running URL',
    '  --out <dir>                 Report directory (default .traffic-one/reports/lighthouse)',
    '  --performance-min <score>   Minimum mobile Performance score (default 95)',
    '  --fcp-max <ms>              Maximum FCP in ms (default 1500)',
    '  --lcp-max <ms>              Maximum LCP in ms (default 2500)',
    '  --tbt-max <ms>              Maximum TBT in ms (default 200)',
    '  --cls-max <value>           Maximum CLS (default 0.1)',
    '  --timeout <ms>              Preview readiness timeout (default 30000; Next uses at least 90000)',
    '  --lighthouse-timeout <ms>   Lighthouse audit child timeout (default 120000)',
    '  --max-runtime <ms>          Overall runner budget before it aborts with blocked:timeout (default 240000)',
    '  --skip-build                Do not run the build script',
    '  --skip-preview              Do not start preview; requires --url',
    '  --local-only                Never network-install lighthouse (no `dlx`); exit',
    '                              blocked:lighthouse-missing when no local binary exists.',
    '                              Also enabled via TRAFFIC_ONE_LIGHTHOUSE_LOCAL_ONLY=1.',
  ].join('\n');
}

export type BlockedStatus = 'blocked:sandbox' | 'blocked:usage-limit' | 'blocked:timeout' | 'blocked:lighthouse-missing';

// Canonical missing-binary message: thrown by the runner in --local-only mode and
// matched by classifyBlockedStatus, so the caller always gets a structured,
// actionable status instead of an approval-layer denial of the dlx branch.
export function lighthouseMissingMessage(packageManager: PackageManager, lighthouseVersion: string): string {
  const add = packageManager === 'yarn' ? 'yarn add -D' : packageManager === 'npm' ? 'npm install -D' : `${packageManager} add -D`;
  return `No local Lighthouse binary (node_modules/.bin/lighthouse) and network install is disabled (--local-only). `
    + `Install it as a devDependency with the project's package manager (\`${add} lighthouse@${lighthouseVersion}\`) and re-run. `
    + 'Do not drop --local-only on hosts whose approval layer denies registry-download execution.';
}

// Maps a runner failure message to the structured status the page-speed hook
// parses. Sandbox and usage-limit keep priority over the timeout branch so a
// bind-denial that also mentions a timeout still reads as blocked:sandbox.
export function classifyBlockedStatus(message: string): BlockedStatus | null {
  if (/No local Lighthouse binary/i.test(message)) return 'blocked:lighthouse-missing';
  if (/listen EPERM|EACCES|operation not permitted|Chrome.*(failed|sandbox)|No usable sandbox|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(message)) {
    return 'blocked:sandbox';
  }
  if (/usage limit|rate limit|quota/i.test(message)) return 'blocked:usage-limit';
  if (/timed out|timeout|exceeded .*budget/i.test(message)) return 'blocked:timeout';
  return null;
}

export function readJson(filePath: string): Rec | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as Rec;
  } catch {
    return null;
  }
}

export function findUp(fileName: string, startDir: string): string | null {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export function detectPackageManager(rootDir: string): PackageManager {
  const pkg = readJson(join(rootDir, 'package.json'));
  const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
  if (declared.startsWith('pnpm@') || existsSync(join(rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (declared.startsWith('yarn@') || existsSync(join(rootDir, 'yarn.lock'))) return 'yarn';
  if (declared.startsWith('bun@') || existsSync(join(rootDir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

