#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULTS = {
  host: "127.0.0.1",
  lighthouseVersion: "13.2.0",
  outDir: ".traffic-one/reports/lighthouse",
  performanceMin: 90,
  fcpMax: 1500,
  lcpMax: 2500,
  tbtMax: 200,
  clsMax: 0.1,
  route: "/",
  timeoutMs: 30000
};

function parseArgs(argv) {
  const args = { ...DEFAULTS, build: true, preview: true };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1];
    switch (item) {
      case "--url":
        args.url = next;
        index += 1;
        break;
      case "--route":
        args.route = next || "/";
        index += 1;
        break;
      case "--out":
        args.outDir = next || DEFAULTS.outDir;
        index += 1;
        break;
      case "--performance-min":
        args.performanceMin = Number(next);
        index += 1;
        break;
      case "--fcp-max":
        args.fcpMax = Number(next);
        index += 1;
        break;
      case "--lcp-max":
        args.lcpMax = Number(next);
        index += 1;
        break;
      case "--tbt-max":
        args.tbtMax = Number(next);
        index += 1;
        break;
      case "--cls-max":
        args.clsMax = Number(next);
        index += 1;
        break;
      case "--lighthouse-version":
        args.lighthouseVersion = next || DEFAULTS.lighthouseVersion;
        index += 1;
        break;
      case "--skip-build":
        args.build = false;
        break;
      case "--skip-preview":
        args.preview = false;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (!args.url && item?.startsWith("http")) {
          args.url = item;
        }
    }
  }
  return args;
}

function usage() {
  return [
    "traffic-one Lighthouse runner",
    "",
    "Usage:",
    "  node scripts/lighthouse-runner.mjs [--route /] [--url http://127.0.0.1:4173/]",
    "",
    "Defaults:",
    "  Builds the project, starts a production preview on a free local port,",
    "  runs Lighthouse mobile Performance, writes JSON + HTML reports, and",
    "  exits non-zero when thresholds fail.",
    "",
    "Options:",
    "  --route <path>              Route to audit when the runner starts preview",
    "  --url <url>                 Audit an already-running URL",
    "  --out <dir>                 Report directory (default .traffic-one/reports/lighthouse)",
    "  --performance-min <score>   Minimum mobile Performance score (default 95)",
    "  --fcp-max <ms>              Maximum FCP in ms (default 1500)",
    "  --lcp-max <ms>              Maximum LCP in ms (default 2500)",
    "  --tbt-max <ms>              Maximum TBT in ms (default 200)",
    "  --cls-max <value>           Maximum CLS (default 0.1)",
    "  --skip-build                Do not run the build script",
    "  --skip-preview              Do not start preview; requires --url"
  ].join("\n");
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findUp(fileName, startDir) {
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

function detectPackageManager(rootDir) {
  const pkg = readJson(join(rootDir, "package.json"));
  const declared = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";
  if (declared.startsWith("pnpm@") || existsSync(join(rootDir, "pnpm-lock.yaml"))) return "pnpm";
  if (declared.startsWith("yarn@") || existsSync(join(rootDir, "yarn.lock"))) return "yarn";
  if (declared.startsWith("bun@") || existsSync(join(rootDir, "bun.lockb"))) return "bun";
  return "npm";
}

function packageHasDependency(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function findViteAppDir(rootDir) {
  const rootPkg = readJson(join(rootDir, "package.json"));
  if (packageHasDependency(rootPkg, "vite")) {
    return rootDir;
  }

  const appsDir = join(rootDir, "apps");
  if (!existsSync(appsDir)) {
    return rootDir;
  }

  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = join(appsDir, entry.name);
    const pkg = readJson(join(appDir, "package.json"));
    if (packageHasDependency(pkg, "vite") || pkg?.scripts?.preview?.includes("vite preview")) {
      return appDir;
    }
  }

  return rootDir;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      stdio: options.stdio || ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      if (options.forwardOutput) process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (options.forwardOutput) process.stderr.write(chunk);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`${command} ${args.join(" ")} failed with exit ${code}\n${stderr || stdout}`));
    });
  });
}

function runScriptArgs(packageManager, scriptName) {
  if (packageManager === "npm") return ["run", scriptName];
  if (packageManager === "yarn") return [scriptName];
  if (packageManager === "bun") return ["run", scriptName];
  return ["run", scriptName];
}

function execArgs(packageManager, executable, args) {
  if (packageManager === "npm") return ["exec", "--", executable, ...args];
  if (packageManager === "yarn") return ["exec", executable, ...args];
  if (packageManager === "bun") return ["x", executable, ...args];
  return ["exec", executable, ...args];
}

function dlxArgs(packageManager, packageName, args) {
  if (packageManager === "npm") return ["exec", "--yes", "--package", packageName, "--", "lighthouse", ...args];
  if (packageManager === "yarn") return ["dlx", packageName, ...args];
  if (packageManager === "bun") return ["x", packageName, ...args];
  return ["dlx", packageName, ...args];
}

async function freePort() {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.listen(0, DEFAULTS.host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 4173;
      server.close(() => resolvePromise(port));
    });
    server.on("error", rejectPromise);
  });
}

function startPreview(packageManager, appDir, port) {
  const args = execArgs(packageManager, "vite", [
    "preview",
    "--host",
    DEFAULTS.host,
    "--port",
    String(port),
    "--strictPort"
  ]);
  const child = spawn(packageManager, args, {
    cwd: appDir,
    env: { ...process.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => process.stderr.write(chunk));
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status < 500) {
        return;
      }
    } catch {
      // Retry until the preview server is ready.
    }
    await delay(250);
  }
  throw new Error(`Preview did not become ready within ${timeoutMs}ms: ${url}`);
}

function normalizeRoute(route) {
  if (!route || route === "/") return "/";
  return route.startsWith("/") ? route : `/${route}`;
}

function createAuditUrl(baseUrl, route) {
  const url = new URL(baseUrl);
  url.pathname = normalizeRoute(route);
  return url.toString();
}

function localLighthouseBin(rootDir, appDir) {
  const binName = process.platform === "win32" ? "lighthouse.cmd" : "lighthouse";
  for (const dir of [rootDir, appDir]) {
    const candidate = join(dir, "node_modules", ".bin", binName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function reportBaseName(url) {
  const parsed = new URL(url);
  const route = parsed.pathname.replace(/[^a-z0-9]+/gi, "-").replace(/(^-|-$)/g, "") || "home";
  return `${route}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

function findReportJson(outDir, baseName) {
  const files = readdirSync(outDir);
  const exact = [`${baseName}.report.json`, `${baseName}.json`];
  for (const file of exact) {
    if (files.includes(file)) {
      return join(outDir, file);
    }
  }
  const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith(".json"));
  return fallback ? join(outDir, fallback) : null;
}

function findReportHtml(outDir, baseName) {
  const files = readdirSync(outDir);
  const exact = [`${baseName}.report.html`, `${baseName}.html`];
  for (const file of exact) {
    if (files.includes(file)) {
      return join(outDir, file);
    }
  }
  const fallback = files.find((file) => file.startsWith(baseName) && file.endsWith(".html"));
  return fallback ? join(outDir, fallback) : null;
}

async function runLighthouse({ appDir, rootDir, packageManager, url, outDir, lighthouseVersion }) {
  mkdirSync(outDir, { recursive: true });
  const baseName = reportBaseName(url);
  const outputBase = join(outDir, baseName);
  const lighthouseArgs = [
    url,
    "--only-categories=performance",
    "--chrome-flags=--headless --no-sandbox",
    "--output=json",
    "--output=html",
    `--output-path=${outputBase}`,
    "--quiet"
  ];
  const localBin = localLighthouseBin(rootDir, appDir);
  if (localBin) {
    await runCommand(localBin, lighthouseArgs, { cwd: appDir });
  } else {
    await runCommand(packageManager, dlxArgs(packageManager, `lighthouse@${lighthouseVersion}`, lighthouseArgs), {
      cwd: rootDir
    });
  }

  const jsonPath = findReportJson(outDir, baseName);
  const htmlPath = findReportHtml(outDir, baseName);
  if (!jsonPath) {
    throw new Error(`Lighthouse finished but no JSON report was found in ${outDir}`);
  }
  return { jsonPath, htmlPath };
}

function displayValue(audits, id) {
  return audits[id]?.displayValue ?? audits[id]?.numericValue ?? null;
}

function numericValue(audits, id) {
  const value = audits[id]?.numericValue;
  return typeof value === "number" ? value : null;
}

function parseSummary(report, thresholds) {
  const audits = report.audits || {};
  const performance = Math.round((report.categories?.performance?.score ?? 0) * 100);
  const metrics = {
    performance,
    fcp: displayValue(audits, "first-contentful-paint"),
    lcp: displayValue(audits, "largest-contentful-paint"),
    tbt: displayValue(audits, "total-blocking-time"),
    cls: displayValue(audits, "cumulative-layout-shift"),
    speedIndex: displayValue(audits, "speed-index")
  };
  const failures = [];
  const fcpMs = numericValue(audits, "first-contentful-paint");
  const lcpMs = numericValue(audits, "largest-contentful-paint");
  const tbtMs = numericValue(audits, "total-blocking-time");
  const cls = numericValue(audits, "cumulative-layout-shift");

  if (performance < thresholds.performanceMin) failures.push(`Performance ${performance} < ${thresholds.performanceMin}`);
  if (fcpMs !== null && fcpMs > thresholds.fcpMax) failures.push(`FCP ${Math.round(fcpMs)}ms > ${thresholds.fcpMax}ms`);
  if (lcpMs !== null && lcpMs > thresholds.lcpMax) failures.push(`LCP ${Math.round(lcpMs)}ms > ${thresholds.lcpMax}ms`);
  if (tbtMs !== null && tbtMs > thresholds.tbtMax) failures.push(`TBT ${Math.round(tbtMs)}ms > ${thresholds.tbtMax}ms`);
  if (cls !== null && cls > thresholds.clsMax) failures.push(`CLS ${cls} > ${thresholds.clsMax}`);

  const topOpportunities = Object.values(audits)
    .filter((audit) => audit?.details?.type === "opportunity" && audit.score !== 1)
    .sort((left, right) => (right.numericSavingsMs ?? 0) - (left.numericSavingsMs ?? 0))
    .slice(0, 5)
    .map((audit) => ({
      title: audit.title,
      savingsMs: Math.round(audit.numericSavingsMs ?? 0),
      displayValue: audit.displayValue || null
    }));

  return { metrics, failures, topOpportunities };
}

function killPreview(child) {
  if (!child || child.killed) {
    return;
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The parent environment may own the process; best-effort cleanup.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.skipPreview && !args.url) {
    throw new Error("--skip-preview requires --url");
  }

  const rootPackage = findUp("package.json", process.cwd());
  const rootDir = rootPackage ? dirname(rootPackage) : process.cwd();
  const appDir = findViteAppDir(rootDir);
  const packageManager = detectPackageManager(rootDir);
  let previewProcess = null;

  try {
    if (args.build) {
      await runCommand(packageManager, runScriptArgs(packageManager, "build"), {
        cwd: existsSync(join(rootDir, "package.json")) ? rootDir : appDir,
        forwardOutput: true
      });
    }

    let auditUrl = args.url;
    if (!auditUrl && args.preview) {
      const port = await freePort();
      previewProcess = startPreview(packageManager, appDir, port);
      const baseUrl = `http://${DEFAULTS.host}:${port}/`;
      auditUrl = createAuditUrl(baseUrl, args.route);
      await waitForHttp(auditUrl, args.timeoutMs);
    }

    if (!auditUrl) {
      throw new Error("No URL to audit. Provide --url or allow the runner to start preview.");
    }

    const outDir = resolve(rootDir, args.outDir);
    const reportPaths = await runLighthouse({
      appDir,
      rootDir,
      packageManager,
      url: auditUrl,
      outDir,
      lighthouseVersion: args.lighthouseVersion
    });
    const report = readJson(reportPaths.jsonPath);
    if (!report) {
      throw new Error(`Could not read Lighthouse report: ${reportPaths.jsonPath}`);
    }
    const summary = parseSummary(report, args);
    const output = {
      url: auditUrl,
      buildMode: "production-preview",
      appDir: appDir === rootDir ? "." : appDir.slice(rootDir.length + 1),
      reports: {
        json: reportPaths.jsonPath,
        html: reportPaths.htmlPath
      },
      ...summary
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (summary.failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    killPreview(previewProcess);
  }
}

main().catch((error) => {
  process.stderr.write(`[traffic-one lighthouse] ${error.message}\n`);
  process.exitCode = 1;
});
