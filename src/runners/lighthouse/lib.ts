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
  build: boolean;
  preview: boolean;
  url?: string;
  help?: boolean;
  skipPreview?: boolean;
}

export function parseArgs(argv: string[]): LighthouseArgs {
  const args: LighthouseArgs = { ...DEFAULTS, build: true, preview: true };
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
      case '--skip-build':
        args.build = false;
        break;
      case '--skip-preview':
        args.preview = false;
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
    '  --skip-build                Do not run the build script',
    '  --skip-preview              Do not start preview; requires --url',
  ].join('\n');
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

export function findViteAppDir(rootDir: string): string {
  const rootPkg = readJson(join(rootDir, 'package.json'));
  if (packageHasDependency(rootPkg, 'vite')) {
    return rootDir;
  }

  const appsDir = join(rootDir, 'apps');
  if (!existsSync(appsDir)) {
    return rootDir;
  }

  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = join(appsDir, entry.name);
    const pkg = readJson(join(appDir, 'package.json'));
    const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts as Rec : {};
    const preview = typeof scripts.preview === 'string' ? scripts.preview : '';
    if (packageHasDependency(pkg, 'vite') || preview.includes('vite preview')) {
      return appDir;
    }
  }

  return rootDir;
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

export interface Summary {
  metrics: {
    performance: number;
    fcp: string | number | null;
    lcp: string | number | null;
    tbt: string | number | null;
    cls: string | number | null;
    speedIndex: string | number | null;
  };
  failures: string[];
  topOpportunities: { title: unknown; savingsMs: number; displayValue: unknown }[];
}

export function parseSummary(report: Rec, thresholds: Thresholds): Summary {
  const audits = (report.audits && typeof report.audits === 'object' ? report.audits : {}) as Rec;
  const categories = report.categories as Rec | undefined;
  const perfCategory = categories && typeof categories === 'object' ? categories.performance as Rec | undefined : undefined;
  const performance = Math.round(((perfCategory?.score as number | undefined) ?? 0) * 100);
  const metrics = {
    performance,
    fcp: displayValue(audits, 'first-contentful-paint'),
    lcp: displayValue(audits, 'largest-contentful-paint'),
    tbt: displayValue(audits, 'total-blocking-time'),
    cls: displayValue(audits, 'cumulative-layout-shift'),
    speedIndex: displayValue(audits, 'speed-index'),
  };
  const failures: string[] = [];
  const fcpMs = numericValue(audits, 'first-contentful-paint');
  const lcpMs = numericValue(audits, 'largest-contentful-paint');
  const tbtMs = numericValue(audits, 'total-blocking-time');
  const cls = numericValue(audits, 'cumulative-layout-shift');

  if (performance < thresholds.performanceMin) failures.push(`Performance ${performance} < ${thresholds.performanceMin}`);
  if (fcpMs !== null && fcpMs > thresholds.fcpMax) failures.push(`FCP ${Math.round(fcpMs)}ms > ${thresholds.fcpMax}ms`);
  if (lcpMs !== null && lcpMs > thresholds.lcpMax) failures.push(`LCP ${Math.round(lcpMs)}ms > ${thresholds.lcpMax}ms`);
  if (tbtMs !== null && tbtMs > thresholds.tbtMax) failures.push(`TBT ${Math.round(tbtMs)}ms > ${thresholds.tbtMax}ms`);
  if (cls !== null && cls > thresholds.clsMax) failures.push(`CLS ${cls} > ${thresholds.clsMax}`);

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

  return { metrics, failures, topOpportunities };
}
