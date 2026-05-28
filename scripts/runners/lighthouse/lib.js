"use strict";
// src/runners/lighthouse/lib.ts
// Pure helpers for the Lighthouse runner: arg parsing, package-manager
// detection, vite app discovery, report-path resolution, and the summary/
// threshold evaluation. Kept free of process/IO so they unit-test cleanly; the
// async orchestration shell lives in index.mts. Ported 1:1 from
// scripts/lighthouse-runner.mjs.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULTS = void 0;
exports.parseArgs = parseArgs;
exports.usage = usage;
exports.readJson = readJson;
exports.findUp = findUp;
exports.detectPackageManager = detectPackageManager;
exports.packageHasDependency = packageHasDependency;
exports.findViteAppDir = findViteAppDir;
exports.runScriptArgs = runScriptArgs;
exports.execArgs = execArgs;
exports.dlxArgs = dlxArgs;
exports.normalizeRoute = normalizeRoute;
exports.createAuditUrl = createAuditUrl;
exports.localLighthouseBin = localLighthouseBin;
exports.reportBaseName = reportBaseName;
exports.findReportJson = findReportJson;
exports.findReportHtml = findReportHtml;
exports.displayValue = displayValue;
exports.numericValue = numericValue;
exports.parseSummary = parseSummary;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
exports.DEFAULTS = {
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
};
function parseArgs(argv) {
    const args = { ...exports.DEFAULTS, build: true, preview: true };
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
                args.outDir = next || exports.DEFAULTS.outDir;
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
                args.lighthouseVersion = next || exports.DEFAULTS.lighthouseVersion;
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
function usage() {
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
function readJson(filePath) {
    try {
        return JSON.parse((0, node_fs_1.readFileSync)(filePath, 'utf8'));
    }
    catch {
        return null;
    }
}
function findUp(fileName, startDir) {
    let dir = (0, node_path_1.resolve)(startDir);
    for (let depth = 0; depth < 8; depth += 1) {
        const candidate = (0, node_path_1.join)(dir, fileName);
        if ((0, node_fs_1.existsSync)(candidate)) {
            return candidate;
        }
        const parent = (0, node_path_1.dirname)(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return null;
}
function detectPackageManager(rootDir) {
    const pkg = readJson((0, node_path_1.join)(rootDir, 'package.json'));
    const declared = pkg && typeof pkg.packageManager === 'string' ? pkg.packageManager : '';
    if (declared.startsWith('pnpm@') || (0, node_fs_1.existsSync)((0, node_path_1.join)(rootDir, 'pnpm-lock.yaml')))
        return 'pnpm';
    if (declared.startsWith('yarn@') || (0, node_fs_1.existsSync)((0, node_path_1.join)(rootDir, 'yarn.lock')))
        return 'yarn';
    if (declared.startsWith('bun@') || (0, node_fs_1.existsSync)((0, node_path_1.join)(rootDir, 'bun.lockb')))
        return 'bun';
    return 'npm';
}
function packageHasDependency(pkg, name) {
    const deps = pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
    const devDeps = pkg && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {};
    return Boolean(deps[name] || devDeps[name]);
}
function findViteAppDir(rootDir) {
    const rootPkg = readJson((0, node_path_1.join)(rootDir, 'package.json'));
    if (packageHasDependency(rootPkg, 'vite')) {
        return rootDir;
    }
    const appsDir = (0, node_path_1.join)(rootDir, 'apps');
    if (!(0, node_fs_1.existsSync)(appsDir)) {
        return rootDir;
    }
    for (const entry of (0, node_fs_1.readdirSync)(appsDir, { withFileTypes: true })) {
        if (!entry.isDirectory())
            continue;
        const appDir = (0, node_path_1.join)(appsDir, entry.name);
        const pkg = readJson((0, node_path_1.join)(appDir, 'package.json'));
        const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {};
        const preview = typeof scripts.preview === 'string' ? scripts.preview : '';
        if (packageHasDependency(pkg, 'vite') || preview.includes('vite preview')) {
            return appDir;
        }
    }
    return rootDir;
}
function runScriptArgs(packageManager, scriptName) {
    if (packageManager === 'npm')
        return ['run', scriptName];
    if (packageManager === 'yarn')
        return [scriptName];
    if (packageManager === 'bun')
        return ['run', scriptName];
    return ['run', scriptName];
}
function execArgs(packageManager, executable, args) {
    if (packageManager === 'npm')
        return ['exec', '--', executable, ...args];
    if (packageManager === 'yarn')
        return ['exec', executable, ...args];
    if (packageManager === 'bun')
        return ['x', executable, ...args];
    return ['exec', executable, ...args];
}
function dlxArgs(packageManager, packageName, args) {
    if (packageManager === 'npm')
        return ['exec', '--yes', '--package', packageName, '--', 'lighthouse', ...args];
    if (packageManager === 'yarn')
        return ['dlx', packageName, ...args];
    if (packageManager === 'bun')
        return ['x', packageName, ...args];
    return ['dlx', packageName, ...args];
}
function normalizeRoute(route) {
    if (!route || route === '/')
        return '/';
    return route.startsWith('/') ? route : `/${route}`;
}
function createAuditUrl(baseUrl, route) {
    const url = new URL(baseUrl);
    url.pathname = normalizeRoute(route);
    return url.toString();
}
function localLighthouseBin(rootDir, appDir) {
    const binName = process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse';
    for (const dir of [rootDir, appDir]) {
        const candidate = (0, node_path_1.join)(dir, 'node_modules', '.bin', binName);
        if ((0, node_fs_1.existsSync)(candidate)) {
            return candidate;
        }
    }
    return null;
}
function reportBaseName(url) {
    const parsed = new URL(url);
    const route = parsed.pathname.replace(/[^a-z0-9]+/gi, '-').replace(/(^-|-$)/g, '') || 'home';
    return `${route}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}
function findReportJson(outDir, baseName) {
    const files = (0, node_fs_1.readdirSync)(outDir);
    const exact = [`${baseName}.report.json`, `${baseName}.json`];
    for (const file of exact) {
        if (files.includes(file)) {
            return (0, node_path_1.join)(outDir, file);
        }
    }
    const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith('.json'));
    return fallback ? (0, node_path_1.join)(outDir, fallback) : null;
}
function findReportHtml(outDir, baseName) {
    const files = (0, node_fs_1.readdirSync)(outDir);
    const exact = [`${baseName}.report.html`, `${baseName}.html`];
    for (const file of exact) {
        if (files.includes(file)) {
            return (0, node_path_1.join)(outDir, file);
        }
    }
    const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith('.html'));
    return fallback ? (0, node_path_1.join)(outDir, fallback) : null;
}
function displayValue(audits, id) {
    const audit = audits[id];
    return audit?.displayValue ?? audit?.numericValue ?? null;
}
function numericValue(audits, id) {
    const audit = audits[id];
    const value = audit?.numericValue;
    return typeof value === 'number' ? value : null;
}
function parseSummary(report, thresholds) {
    const audits = (report.audits && typeof report.audits === 'object' ? report.audits : {});
    const categories = report.categories;
    const perfCategory = categories && typeof categories === 'object' ? categories.performance : undefined;
    const performance = Math.round((perfCategory?.score ?? 0) * 100);
    const metrics = {
        performance,
        fcp: displayValue(audits, 'first-contentful-paint'),
        lcp: displayValue(audits, 'largest-contentful-paint'),
        tbt: displayValue(audits, 'total-blocking-time'),
        cls: displayValue(audits, 'cumulative-layout-shift'),
        speedIndex: displayValue(audits, 'speed-index'),
    };
    const failures = [];
    const fcpMs = numericValue(audits, 'first-contentful-paint');
    const lcpMs = numericValue(audits, 'largest-contentful-paint');
    const tbtMs = numericValue(audits, 'total-blocking-time');
    const cls = numericValue(audits, 'cumulative-layout-shift');
    if (performance < thresholds.performanceMin)
        failures.push(`Performance ${performance} < ${thresholds.performanceMin}`);
    if (fcpMs !== null && fcpMs > thresholds.fcpMax)
        failures.push(`FCP ${Math.round(fcpMs)}ms > ${thresholds.fcpMax}ms`);
    if (lcpMs !== null && lcpMs > thresholds.lcpMax)
        failures.push(`LCP ${Math.round(lcpMs)}ms > ${thresholds.lcpMax}ms`);
    if (tbtMs !== null && tbtMs > thresholds.tbtMax)
        failures.push(`TBT ${Math.round(tbtMs)}ms > ${thresholds.tbtMax}ms`);
    if (cls !== null && cls > thresholds.clsMax)
        failures.push(`CLS ${cls} > ${thresholds.clsMax}`);
    const topOpportunities = Object.values(audits)
        .filter((audit) => {
        const a = audit;
        const details = a && typeof a.details === 'object' ? a.details : null;
        return Boolean(details && details.type === 'opportunity' && a?.score !== 1);
    })
        .sort((left, right) => (right.numericSavingsMs ?? 0) - (left.numericSavingsMs ?? 0))
        .slice(0, 5)
        .map((audit) => ({
        title: audit.title,
        savingsMs: Math.round(audit.numericSavingsMs ?? 0),
        displayValue: audit.displayValue || null,
    }));
    return { metrics, failures, topOpportunities };
}
