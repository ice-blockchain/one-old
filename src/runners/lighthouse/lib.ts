// src/runners/lighthouse/lib.ts
// Project detection, server orchestration, and result shaping for the
// lighthouse runner. CLI parsing lives in cli-args.ts.

import { existsSync, readdirSync } from 'node:fs';
import {  join } from 'node:path';

import { readRegularText } from './bounded-read';
import {
  readJson,
  type PackageManager,
} from './cli-args';

type Rec = Record<string, unknown>;

export function packageHasDependency(pkg: Rec | null, name: string): boolean {
  const deps = pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies as Rec : {};
  const devDeps = pkg && typeof pkg.devDependencies === 'object' ? pkg.devDependencies as Rec : {};
  return Boolean(deps[name] || devDeps[name]);
}

const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'] as const;
const NEXT_CONFIG_NAMES = ['next.config.ts', 'next.config.js', 'next.config.mjs', 'next.config.cjs'] as const;

function hasViteConfig(dir: string): boolean {
  return VITE_CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

function hasNextConfig(dir: string): boolean {
  return NEXT_CONFIG_NAMES.some((name) => existsSync(join(dir, name)));
}

// BOUNDED (./bounded-read), and this is the site the class was found at: a Next
// config is a file every clone carries, git records a symlink as mode 120000, so
// `next.config.js -> /dev/zero` needs no local process at all. Measured before
// the bound, one child per shape under a parent SIGKILL at 8 000 ms — the figure
// IS the deadline, so the read never returned: 8 011 ms on a FIFO and 8 047 ms on
// a /dev/zero link, against a control that answered with the config parsed. It
// answers in 301 ms and 307 ms now, most of which is the child starting node.
//
// A shape that cannot be read keeps the existing `catch`: the runner has no
// evidence this project static-exports, so it previews it the ordinary way. That
// is the same conservative answer an unparseable config already got, and the
// worse outcome — guessing `export` and then finding no `out/` — is a
// `failed:project` the operator did not earn.
export function nextConfigOutputExport(dir: string): boolean {
  for (const name of NEXT_CONFIG_NAMES) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    try {
      const raw = readRegularText(file);
      if (/\boutput\s*:\s*['"]export['"]/i.test(raw)) return true;
    } catch {
      // unreadable config: fall through to normal next start handling
    }
  }
  return false;
}

type PreviewKind = 'vite' | 'next' | 'static';

interface FrontendApp {
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

// `buildTag` is the served build's identity (hashed entry asset / Next
// BUILD_ID). Without it a report file names only a route and a wall-clock time,
// so two runs' artefacts are indistinguishable once they share a directory —
// which is exactly how a stale 98 was quoted against a canonical 74.
export function reportBaseName(url: string, buildTag?: string | null): string {
  const parsed = new URL(url);
  const route = parsed.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'home';
  const tag = buildTag ? `-${buildTag}` : '';
  return `${route}${tag}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
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

interface Thresholds {
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
const GATE_TOLERANCE_RATIO = 0.03;

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
export {
  DEFAULTS,
  buildFingerprintTag,
  classifyBlockedStatus,
  classifyRunnerFailure,
  currentRunId,
  detectPackageManager,
  findUp,
  runScopedOutDir,
  applyContractThresholds,
  contractThresholds,
  lighthouseMissingMessage,
  parseArgs,
  previewCommandMissingMessage,
  readJson,
  RUNNER_STATUSES,
  type BlockedStatus,
  type FailedStatus,
  type LighthouseArgs,
  type PackageManager,
  type RunnerStatus,
  usage,
} from './cli-args';
