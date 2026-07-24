// src/runners/lighthouse/lib.ts
// Pure helpers for the Lighthouse runner: arg parsing, package-manager
// detection, vite app discovery, report-path resolution, and the summary/
// threshold evaluation. Kept free of process/IO so they unit-test cleanly; the
// async orchestration shell lives in index.mts. Ported 1:1 from
// scripts/lighthouse-runner.mjs.

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

export function packageHasDependency(pkg: Rec | null, name: string): boolean {
  const deps = pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies as Rec : {};
  const devDeps = pkg && typeof pkg.devDependencies === 'object' ? pkg.devDependencies as Rec : {};
  return Boolean(deps[name] || devDeps[name]);
}

const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'] as const;
const NEXT_CONFIG_NAMES = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs'] as const;

export function hasViteConfig(dir: string): boolean {
  return VITE_CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

export function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

export function nextConfigOutputExport(dir: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readFileSync(file, 'utf8');
      if (/\boutput\s*:\s*['"]export['"]/i.test(raw)) return true;
    } catch {
      // unreadable config: fall through to normal next start handling
    }
  }
  return false;
}

export type PreviewKind = 'vite' | 'next' | 'static';

export interface FrontendApp {
  appDir: string;
  previewKind: PreviewKind;
  staticDir?: string;
}

function nextFrontendApp(appDir: string): FrontendApp {
  if (nextConfigOutputExport(appDir)) return { appDir, previewKind: 'static', staticDir: join(appDir, 'out') };
  return { appDir, previewKind: 'next' };
}

// The buildable app dir, from the root the runner was invoked in. A real vite
// config file wins over a dependency declaration: monorepos commonly hoist
// `vite` into the ROOT devDependencies for tooling, but root has no config and
// `vite build`/`preview` there just fails — the actual app lives in apps/*.
export function findViteAppDir(rootDir: string): string {
  if (hasViteConfig(rootDir)) return rootDir;

  const appsDir = join(rootDir, 'apps');
  if (existsSync(appsDir)) {
    let depFallback = '';
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const appDir = join(appsDir, entry.name);
      if (hasViteConfig(appDir)) return appDir;
      const pkg = readJson(join(appDir, 'package.json'));
      const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : {};
      const preview = typeof scripts.preview === 'string' ? scripts.preview : '';
      if (!depFallback && (packageHasDependency(pkg, 'vite') || preview.includes('vite preview'))) {
        depFallback = appDir;
      }
    }
    if (depFallback) return depFallback;
  }

  // No config anywhere: a root vite dependency is still the best signal left.
  const rootPkg = readJson(join(rootDir, 'package.json'));
  if (packageHasDependency(rootPkg, 'vite')) return rootDir;
  return rootDir;
}

export function findFrontendApp(rootDir: string): FrontendApp {
  if (hasNextConfig(rootDir)) return nextFrontendApp(rootDir);
  if (hasViteConfig(rootDir)) return { appDir: rootDir, previewKind: 'vite' };

  const appsDir = join(rootDir, 'apps');
  if (existsSync(appsDir)) {
    let viteFallback = '';
    let nextFallback = '';
    for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const appDir = join(appsDir, entry.name);
      if (hasNextConfig(appDir)) return nextFrontendApp(appDir);
      if (hasViteConfig(appDir)) return { appDir, previewKind: 'vite' };
      const pkg = readJson(join(appDir, 'package.json'));
      const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : {};
      const preview = typeof scripts.preview === 'string' ? scripts.preview : '';
      const start = typeof scripts.start === 'string' ? scripts.start : '';
      if (!nextFallback && (packageHasDependency(pkg, 'next') || start.includes('next start'))) nextFallback = appDir;
      if (!viteFallback && (packageHasDependency(pkg, 'vite') || preview.includes('vite preview'))) viteFallback = appDir;
    }
    if (nextFallback) return nextFrontendApp(nextFallback);
    if (viteFallback) return { appDir: viteFallback, previewKind: 'vite' };
  }

  const rootPkg = readJson(join(rootDir, 'package.json'));
  if (packageHasDependency(rootPkg, 'next')) return nextFrontendApp(rootDir);
  return { appDir: findViteAppDir(rootDir), previewKind: 'vite' };
}

export function runScriptArgs(packageManager: PackageManager, scriptName: string): string[] {
  if (packageManager === 'npm') return ['run', scriptName];
  if (packageManager === 'yarn') return [scriptName];
  if (packageManager === 'bun') return ['run', scriptName];
  return ['run', scriptName];
}

export function execArgs(packageManager: PackageManager, executable: string, args: string[]): string[] {
  if (packageManager === 'npm') return ['exec', '--', executable, ...args];
  if (packageManager === 'yarn') return ['exec', executable, ...args];
  if (packageManager === 'bun') return ['x', executable, ...args];
  return ['exec', executable, ...args];
}

export function dlxArgs(packageManager: PackageManager, packageName: string, args: string[]): string[] {
  if (packageManager === 'npm') return ['exec', '--yes', '--package', packageName, '--', 'lighthouse', ...args];
  if (packageManager === 'yarn') return ['dlx', packageName, ...args];
  if (packageManager === 'bun') return ['x', packageName, ...args];
  return ['dlx', packageName, ...args];
}

export function normalizeRoute(route: string): string {
  if (!route || route === '/') return '/';
  return route.startsWith('/') ? route : `/${route}`;
}

export function createAuditUrl(baseUrl: string, route: string): string {
  const url = new URL(baseUrl);
  url.pathname = normalizeRoute(route);
  return url.toString();
}

export function localLighthouseBin(rootDir: string, appDir: string): string | null {
  const binName = process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse';
  for (const dir of [rootDir, appDir]) {
    const candidate = join(dir, 'node_modules', '.bin', binName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function reportBaseName(url: string): string {
  const parsed = new URL(url);
  const route = parsed.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'home';
  return `${route}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

export function findReportJson(outDir: string, baseName: string): string | null {
  const files = readdirSync(outDir);
  const exact = [`${baseName}.report.json`, `${baseName}.json`];
  for (const file of exact) {
    if (files.includes(file)) {
      return join(outDir, file);
    }
  }
  const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith('.json'));
  return fallback ? join(outDir, fallback) : null;
}

export function findReportHtml(outDir: string, baseName: string): string | null {
  const files = readdirSync(outDir);
  const exact = [`${baseName}.report.html`, `${baseName}.html`];
  for (const file of exact) {
    if (files.includes(file)) {
      return join(outDir, file);
    }
  }
  const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith('.html'));
  return fallback ? join(outDir, fallback) : null;
}

export function displayValue(audits: Rec, id: string): string | number | null {
  const audit = audits[id] as Rec | undefined;
  return (audit?.displayValue as string | undefined) ?? (audit?.numericValue as number | undefined) ?? null;
}

export function numericValue(audits: Rec, id: string): number | null {
  const audit = audits[id] as Rec | undefined;
  const value = audit?.numericValue;
  return typeof value === 'number' ? value : null;
}

export interface Thresholds {
  performanceMin: number;
  fcpMax: number;
  lcpMax: number;
  tbtMax: number;
  clsMax: number;
}

// A metric past its threshold but within GATE_TOLERANCE_RATIO does NOT fail the
// gate — Lighthouse has run-to-run noise at that margin (measured live: three
// fix cycles + reruns chasing a stable 5–6ms FCP residue). It is reported in
// `withinTolerance` so the residual stays visible without burning iterations.
export const GATE_TOLERANCE_RATIO = 0.03;

export interface Summary {
  metrics: {
    performance: number;
    accessibility: number | null;
    bestPractices: number | null;
    seo: number | null;
    fcp: string | number | null;
    lcp: string | number | null;
    tbt: string | number | null;
    cls: string | number | null;
    speedIndex: string | number | null;
  };
  failures: string[];
  withinTolerance: string[];
  // Non-gating findings from the SAME audit JSON (free): accessibility score
  // below 90 plus its worst failing audits. No prior run ever produced an a11y
  // signal despite the rules requiring it — the data was being discarded.
  warnings: string[];
  topOpportunities: { title: unknown; savingsMs: number; displayValue: unknown }[];
}

export function parseSummary(report: Rec, thresholds: Thresholds): Summary {
  const audits = (report.audits && typeof report.audits === 'object' ? report.audits : {}) as Rec;
  const categories = report.categories as Rec | undefined;
  const categoryScore = (name: string): number | null => {
    const cat = categories && typeof categories === 'object' ? categories[name] as Rec | undefined : undefined;
    const score = cat?.score as number | undefined;
    return typeof score === 'number' ? Math.round(score * 100) : null;
  };
  const performance = categoryScore('performance') ?? 0;
  const accessibility = categoryScore('accessibility');
  const bestPractices = categoryScore('best-practices');
  const seo = categoryScore('seo');
  const metrics = {
    performance,
    accessibility,
    bestPractices,
    seo,
    fcp: displayValue(audits, 'first-contentful-paint'),
    lcp: displayValue(audits, 'largest-contentful-paint'),
    tbt: displayValue(audits, 'total-blocking-time'),
    cls: displayValue(audits, 'cumulative-layout-shift'),
    speedIndex: displayValue(audits, 'speed-index'),
  };
  const failures: string[] = [];
  const withinTolerance: string[] = [];
  const warnings: string[] = [];
  const fcpMs = numericValue(audits, 'first-contentful-paint');
  const lcpMs = numericValue(audits, 'largest-contentful-paint');
  const tbtMs = numericValue(audits, 'total-blocking-time');
  const cls = numericValue(audits, 'cumulative-layout-shift');

  // value ≤ max → pass; max < value ≤ max·(1+tol) → withinTolerance (no gate
  // fail); value > max·(1+tol) → failure.
  const gateTimeMetric = (label: string, valueMs: number | null, maxMs: number): void => {
    if (valueMs === null || valueMs <= maxMs) return;
    const line = `${label} ${Math.round(valueMs)}ms > ${maxMs}ms`;
    if (valueMs <= maxMs * (1 + GATE_TOLERANCE_RATIO)) withinTolerance.push(`${line} (within ${Math.round(GATE_TOLERANCE_RATIO * 100)}% tolerance — do not iterate further on this)`);
    else failures.push(line);
  };
  if (performance < thresholds.performanceMin) failures.push(`Performance ${performance} < ${thresholds.performanceMin}`);
  gateTimeMetric('FCP', fcpMs, thresholds.fcpMax);
  gateTimeMetric('LCP', lcpMs, thresholds.lcpMax);
  gateTimeMetric('TBT', tbtMs, thresholds.tbtMax);
  if (cls !== null && cls > thresholds.clsMax) {
    const line = `CLS ${cls} > ${thresholds.clsMax}`;
    if (cls <= thresholds.clsMax * (1 + GATE_TOLERANCE_RATIO)) withinTolerance.push(`${line} (within tolerance)`);
    else failures.push(line);
  }

  // Accessibility findings ride the same report for free — warn, never gate.
  if (accessibility !== null && accessibility < 90) {
    const worstA11y = Object.values(audits)
      .filter((audit): audit is Rec => {
        const a = audit as Rec | null;
        return Boolean(a && typeof a.score === 'number' && (a.score as number) < 1 && typeof a.id === 'string'
          && /contrast|label|alt|aria|name|focus|tab/i.test(String(a.id)));
      })
      .slice(0, 3)
      .map((a) => String(a.title || a.id));
    warnings.push(`Accessibility ${accessibility} < 90${worstA11y.length ? ` — worst: ${worstA11y.join('; ')}` : ''}`);
  }

  const topOpportunities = Object.values(audits)
    .filter((audit): audit is Rec => {
      const a = audit as Rec | null;
      const details = a && typeof a.details === 'object' ? a.details as Rec : null;
      return Boolean(details && details.type === 'opportunity' && a?.score !== 1);
    })
    .sort((left, right) => ((right.numericSavingsMs as number | undefined) ?? 0) - ((left.numericSavingsMs as number | undefined) ?? 0))
    .slice(0, 5)
    .map((audit) => ({
      title: audit.title,
      savingsMs: Math.round((audit.numericSavingsMs as number | undefined) ?? 0),
      displayValue: audit.displayValue || null,
    }));

  return { metrics, failures, withinTolerance, warnings, topOpportunities };
}
