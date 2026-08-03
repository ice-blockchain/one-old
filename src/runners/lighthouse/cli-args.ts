// src/runners/lighthouse/cli-args.ts
// Lighthouse runner defaults, argument parsing, and usage text.

import { existsSync, readFileSync } from 'node:fs';
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

const THRESHOLD_FLAGS = new Set([
  '--performance-min', '--fcp-max', '--lcp-max', '--tbt-max', '--cls-max',
]);

/**
 * The run's verification contract is the single threshold authority. When one
 * exists, its budget REPLACES this CLI's defaults wholesale — a metric the
 * contract does not declare is not gated at all.
 *
 * Observed 10co: the canonical QA path enforced nothing (no declared budget)
 * while this runner applied its own `fcpMax: 1500`, so the same audit passed the
 * tester and then failed the parent gate. An explicit `--fcp-max` on the command
 * line still wins — that is a human deliberately overriding the contract.
 *
 * Best-effort and dependency-free: plain JSON reads, no shared imports (this
 * runner is ESM-only and cannot require the CJS runtime).
 */
export function contractThresholds(rootDir: string): Partial<LighthouseArgs> | null {
  const readJson = (file: string): Rec | null => {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed as Rec : null;
    } catch {
      return null;
    }
  };
  const memory = join(rootDir, '.traffic-one');
  const state = readJson(join(memory, '.one.json'));
  const runId = typeof state?.currentRunId === 'string' ? state.currentRunId.trim() : '';
  if (!runId || /[\\/]/.test(runId)) return null;
  const contract = readJson(join(memory, 'runs', runId, 'verification-v2.json'));
  const performance = contract?.performance;
  if (!performance || typeof performance !== 'object') return null;
  const thresholds = (performance as Rec).thresholds;
  if (!thresholds || typeof thresholds !== 'object') return null;
  const t = thresholds as Rec;
  const num = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );
  // Undeclared metrics become unreachable bounds rather than the CLI defaults,
  // so "the contract set no first-paint budget" reads as "do not gate FCP".
  return {
    performanceMin: num(t.performanceMin) ?? 0,
    fcpMax: num(t.fcpMaxMs) ?? Number.POSITIVE_INFINITY,
    lcpMax: num(t.lcpMaxMs) ?? Number.POSITIVE_INFINITY,
    tbtMax: num(t.tbtMaxMs) ?? Number.POSITIVE_INFINITY,
    clsMax: num(t.clsMax) ?? Number.POSITIVE_INFINITY,
  };
}

/**
 * Report artefacts belong to ONE run and ONE build.
 *
 * Observed 10co-e2e: `.traffic-one/reports/lighthouse/` carried no run id and no
 * build fingerprint, so files from different runs sat side by side and were
 * indistinguishable — the frontend self-ran Lighthouse 13.2.0 before the
 * `^12.8.2` pin existed, scored 0.98, and that number travelled downstream as
 * the run's page speed against a canonical 74. Scoping the directory under the
 * run id, and stamping the served build's entry asset into the file name, makes
 * "which run and which build is this report about?" answerable from the path.
 *
 * Best-effort and dependency-free (this runner is ESM-only and cannot require
 * the CJS runtime): with no Traffic One state, or no build on disk, the caller
 * keeps its plain output directory.
 */
export function currentRunId(rootDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(rootDir, '.traffic-one', '.one.json'), 'utf8'),
    );
    const state = parsed && typeof parsed === 'object' ? parsed as Rec : null;
    const runId = typeof state?.currentRunId === 'string' ? state.currentRunId.trim() : '';
    return runId && !/[\\/]/.test(runId) && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)
      ? runId
      : null;
  } catch {
    return null;
  }
}

/** The served build's identity: the hashed entry asset, or the Next BUILD_ID. */
export function buildFingerprintTag(rootDir: string, appDir: string): string | null {
  const sanitize = (value: string): string | null => {
    const cleaned = value.replace(/\.[cm]?js$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    return cleaned || null;
  };
  for (const dir of [appDir, rootDir]) {
    for (const outDir of ['dist', 'out', '.output/public', 'build', 'public/build']) {
      try {
        const html = readFileSync(join(dir, ...outDir.split('/'), 'index.html'), 'utf8');
        const match = /<script[^>]+src="([^"]+\.[cm]?js)"/.exec(html);
        if (match?.[1]) return sanitize(match[1].split('/').pop() || '');
      } catch {
        // not built with this layout
      }
    }
    try {
      const buildId = readFileSync(join(dir, '.next', 'BUILD_ID'), 'utf8').trim();
      if (buildId) return sanitize(buildId);
    } catch {
      // not a Next build
    }
  }
  return null;
}

/** `<outDir>/<runId>` when this is a Traffic One run; the plain dir otherwise. */
export function runScopedOutDir(rootDir: string, outDir: string, argv: readonly string[]): string {
  // An operator who passed `--out` owns that path verbatim.
  if (argv.some((item) => item === '--out')) return outDir;
  const runId = currentRunId(rootDir);
  return runId ? join(outDir, runId) : outDir;
}

const CLI_FLAG_FOR_THRESHOLD: Record<string, string> = {
  performanceMin: '--performance-min',
  fcpMax: '--fcp-max',
  lcpMax: '--lcp-max',
  tbtMax: '--tbt-max',
  clsMax: '--cls-max',
};

/**
 * Merge the run contract's budget into parsed args. A threshold the operator
 * passed on the command line always wins; everything else defers to the
 * contract. No contract (or no Traffic One project) leaves `args` untouched.
 */
export function applyContractThresholds(
  args: LighthouseArgs,
  rootDir: string,
  argv: string[],
): LighthouseArgs {
  const fromContract = contractThresholds(rootDir);
  if (!fromContract) return args;
  const cliFlags = new Set(argv.filter((item) => THRESHOLD_FLAGS.has(item)));
  const merged = { ...args };
  for (const [key, value] of Object.entries(fromContract)) {
    if (cliFlags.has(CLI_FLAG_FOR_THRESHOLD[key] || '')) continue;
    (merged as unknown as Rec)[key] = value;
  }
  return merged;
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

