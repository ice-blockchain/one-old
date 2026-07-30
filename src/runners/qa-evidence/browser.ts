// src/runners/qa-evidence/browser.ts
// Playwright driving: the runtime probe, per-viewport evidence, and the
// browser subcommand.

import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { pluginVersion } from '../../config/plugin-identity';
import { stableContractJson } from '../../shared/architecture-contract';
import { writeJson } from '../../shared/fsjson';
import {
  contentHash,
  createQaMachineEvidence,
  type QaMachineRouteEvidenceV1,
  type QaMachineViewportEvidenceV1,
} from '../../shared/qa-evidence-runtime';
import {
  qaReportV2Path,
  type QaReportV2,
} from '../../shared/qa-report-v2';
import { sha256 } from '../../shared/text';
import {
  type VerificationContractV2,
} from '../../shared/verification-contract';

import {
  type BrowserLike,
  type OwnedServer,
  type PageLike,
  type PlaywrightLike,
  type RouteScenario,
  type RunnerArgs,
} from './types';
import {
  isRecord,
} from './cli';
import {
  type LoadedRun,
  outputPath,
  publishAndValidateReport,
} from './run-context';
import {
  loadScenario,
} from './scenario';
import { startCommandServer, startStaticServer, stopOwnedServer } from './server';
import { emitProgress } from './report-publish';
import { runLighthouseOnOwnedServer } from './lighthouse';
import { RUNTIME_PROBE_INIT_SCRIPT, eventText, executeStep, httpNetworkUrl, routeSlug } from './browser-steps';

/**
 * Resolve project-local Playwright from every plausible anchor, not only the
 * project root's `package.json`.
 *
 * A Laravel, Go, or Python repo has no root manifest, and a pnpm monorepo keeps
 * Playwright in `apps/web` — both reported `playwright-missing` and exited 2 even
 * with Playwright installed. `projectLighthouseBin` already consults
 * `serverCwd`; these two now agree.
 */
function projectPlaywright(
  projectRoot: string,
  serverCwd?: string,
): { api: PlaywrightLike; version: string } | null {
  const anchors = [
    ...(serverCwd ? [path.resolve(projectRoot, serverCwd)] : []),
    projectRoot,
    path.join(projectRoot, 'apps/web'),
  ];
  for (const anchor of anchors) {
    // createRequire needs an existing anchor file; fall back to the directory
    // itself so a manifest-less root still resolves through node_modules.
    const manifest = path.join(anchor, 'package.json');
    const from = fs.existsSync(manifest) ? manifest : path.join(anchor, 'noop.js');
    const projectRequire = createRequire(from);
    for (const packageName of ['@playwright/test', 'playwright']) {
      try {
        const api = projectRequire(packageName) as Partial<PlaywrightLike>;
        const pkg = projectRequire(`${packageName}/package.json`) as { version?: unknown };
        if (typeof api.chromium?.launch === 'function' && typeof pkg.version === 'string') {
          return { api: api as PlaywrightLike, version: pkg.version };
        }
      } catch {
        // try the other local package, then the next anchor
      }
    }
  }
  return null;
}






async function runViewport(
  browser: BrowserLike,
  owned: OwnedServer,
  contract: VerificationContractV2,
  scenario: RouteScenario,
  width: number,
  outDir: string,
  timeoutMs: number,
): Promise<QaMachineViewportEvidenceV1> {
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const actionErrors: string[] = [];
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const traceName = `${routeSlug(scenario.route)}-${width}.trace.zip`;
  const traceAbsolute = path.join(outDir, traceName);
  const screenshotName = `${routeSlug(scenario.route)}-${width}.png`;
  const screenshotAbsolute = path.join(outDir, screenshotName);
  let status: QaMachineViewportEvidenceV1['status'] = 'passed';
  let domAssertionsPassed = false;
  let actionsPassed = false;
  let routingPassed = false;
  let hydrationPassed = false;
  let screenshotPath: string | undefined;
  let screenshotHash: string | undefined;
  let page: PageLike | null = null;
  // DOM snapshots are the bulk of a trace and the only part a passing run never
  // needs: 18 traces on one green 9co run cost ~6 MB, and everything a failure
  // actually needs is captured separately — the failure screenshot, plus console,
  // network and action errors on the viewport record.
  //
  // Deliberately NOT deleting traces after the fact. `qa-report-v2/evidence.ts`
  // re-hashes `viewport.tracePath` and `artifacts.ts` folds it into the acceptance
  // attestation, so a post-hoc sweep would invalidate the report it is pruning.
  // Shrinking the payload keeps the evidence chain byte-verifiable.
  await context.tracing.start({ screenshots: true, snapshots: false, sources: false });
  try {
    await context.addInitScript(RUNTIME_PROBE_INIT_SCRIPT);
    page = await context.newPage();
    page.on('console', (value) => {
      const type = (value as { type?: () => string }).type;
      if (typeof type === 'function' && type.call(value) === 'error') consoleErrors.push(eventText(value));
    });
    page.on('pageerror', (value) => consoleErrors.push(eventText(value)));
    page.on('requestfailed', (value) => {
      const requestUrl = (value as { url?: () => string }).url;
      if (typeof requestUrl === 'function') {
        try {
          const observed = httpNetworkUrl(requestUrl.call(value));
          if (observed) networkErrors.push(`requestfailed ${observed}`);
        } catch {
          // A malformed event payload is not usable network evidence.
        }
      }
    });
    page.on('response', (value) => {
      const responseUrl = (value as { url?: () => string }).url;
      const statusCode = (value as { status?: () => number }).status;
      if (typeof responseUrl === 'function' && typeof statusCode === 'function') {
        try {
          const statusValue = statusCode.call(value);
          const observed = httpNetworkUrl(responseUrl.call(value));
          if (observed && statusValue >= 400) {
            networkErrors.push(`${statusValue} ${observed}`);
          }
        } catch {
          // A malformed event payload is not usable network evidence.
        }
      }
    });
    const target = new URL(scenario.startPath, `${owned.url}/`).href;
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForLoadState('load', { timeout: timeoutMs });
    await page.locator(scenario.stableSelector).first().waitFor({ state: 'visible', timeout: timeoutMs });
    domAssertionsPassed = true;
    const initialRuntimeState = await page.evaluate(`({
      documentToken: String(globalThis.__trafficOneQaRuntimeV1?.documentToken || "")
    })`);
    let interactiveSteps = 0;
    for (const step of scenario.steps) {
      await executeStep(page, step, timeoutMs);
      if (['click', 'fill', 'press', 'check', 'select'].includes(step.type)) interactiveSteps += 1;
    }
    actionsPassed = interactiveSteps > 0;
    await page.waitForTimeout(50);
    routingPassed = new URL(page.url()).pathname === scenario.finalPath;
    const runtimeState = await page.evaluate(`({
      documentReady: document.readyState === "complete" && !!document.body && document.body.childElementCount > 0,
      documentToken: String(globalThis.__trafficOneQaRuntimeV1?.documentToken || ""),
      listenerRegistrations: Number(globalThis.__trafficOneQaRuntimeV1?.listenerRegistrations || 0),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth
        && (!document.body || document.body.scrollWidth <= window.innerWidth)
    })`);
    const documentReplaced = isRecord(initialRuntimeState)
      && typeof initialRuntimeState.documentToken === 'string'
      && initialRuntimeState.documentToken.length > 0
      && isRecord(runtimeState)
      && typeof runtimeState.documentToken === 'string'
      && runtimeState.documentToken.length > 0
      && runtimeState.documentToken !== initialRuntimeState.documentToken;
    hydrationPassed = actionsPassed
      && isRecord(runtimeState)
      && runtimeState.documentReady === true
      && (
        (typeof runtimeState.listenerRegistrations === 'number'
          && runtimeState.listenerRegistrations > 0)
        || documentReplaced
      );
    if (contract.uiImpact === 'visual'
      && (!isRecord(runtimeState) || runtimeState.noHorizontalOverflow !== true)) {
      domAssertionsPassed = false;
      consoleErrors.push('horizontal overflow exceeds the tested viewport');
    }
    if (contract.uiImpact === 'visual') {
      await page.screenshot({ path: screenshotAbsolute, fullPage: true });
      screenshotPath = screenshotName;
      screenshotHash = contentHash(screenshotAbsolute) || undefined;
    }
    if (!domAssertionsPassed
      || !actionsPassed
      || !routingPassed
      || !hydrationPassed
      || consoleErrors.length > 0
      || networkErrors.length > 0
      || actionErrors.length > 0
      || (contract.uiImpact === 'visual' && !screenshotHash)) status = 'failed';
  } catch (error) {
    status = 'failed';
    const message = error instanceof Error
      ? error.message.slice(0, 2_000)
      : String(error).slice(0, 2_000);
    // Playwright step/navigation failures (locator timeouts, goto errors) are
    // ACTION evidence, not page console output — filing them under
    // consoleErrors misread a click timeout as an application error (8co).
    if (/^(?:locator|page|frame|mouse|keyboard)\.\w+:|timeout \d+ms exceeded|net::ERR/i.test(message)) {
      actionErrors.push(message);
    } else {
      consoleErrors.push(message);
    }
    if (page && !screenshotPath) {
      try {
        await page.screenshot({ path: screenshotAbsolute, fullPage: true });
        screenshotPath = screenshotName;
        screenshotHash = contentHash(screenshotAbsolute) || undefined;
      } catch (screenshotError) {
        consoleErrors.push(
          `failure screenshot unavailable: ${
            screenshotError instanceof Error ? screenshotError.message : String(screenshotError)
          }`.slice(0, 2_000),
        );
      }
    }
  } finally {
    await context.tracing.stop({ path: traceAbsolute });
    await context.close();
  }
  const traceHash = contentHash(traceAbsolute);
  if (!traceHash) throw new Error(`Playwright trace was not written: ${traceName}`);
  return {
    width,
    status,
    domAssertionsPassed,
    actionsPassed,
    routingPassed,
    hydrationPassed,
    consoleErrors,
    networkErrors,
    ...(actionErrors.length > 0 ? { actionErrors } : {}),
    artifactAt: new Date().toISOString(),
    tracePath: traceName,
    traceHash,
    ...(screenshotPath && screenshotHash ? { screenshotPath, screenshotHash } : {}),
  };
}

export async function browserCommand(
  args: RunnerArgs,
  loaded: LoadedRun,
): Promise<number> {
  if (!loaded.contract.browserRequired) {
    // Not an error: a correct state for every no-web-surface contract. Exiting 2
    // here made "this run needs no browser" indistinguishable from a real
    // failure, and an api-only run had nothing else to call.
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: 'not-required',
      uiImpact: loaded.contract.uiImpact,
      hint: 'run `stack` for build/test/lint evidence on contracts with no browser surface',
    })}\n`);
    return 0;
  }
  const scenario = loadScenario(args, loaded.contract);
  const out = outputPath(args, 'machine-evidence-v1.json');
  if (!scenario || !out) {
    process.stderr.write('qa-evidence: scenario/output path is invalid or does not cover changedRoutes exactly.\n');
    return 2;
  }
  fs.mkdirSync(path.dirname(out.absolute), { recursive: true });
  const scenarioHash = sha256(stableContractJson(scenario));
  emitProgress(`preflight ok — run ${args.runId}, ${scenario.routes.length} route(s), build ${loaded.manifest.fileCount} file(s)`);
  const owned = args.serverCommandJson
    ? await startCommandServer(args, loaded)
    : await startStaticServer(args, loaded);
  emitProgress(`serving ${owned.url} (${owned.mode})`);
  let stopped = false;
  const stopOnce = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await stopOwnedServer(owned);
  };
  try {
  const startedAt = new Date().toISOString();
  const playwright = projectPlaywright(args.projectRoot, args.serverCwd);
  if (!playwright) {
    const blockerSummary =
      'Project-local Playwright is unavailable. Install @playwright/test and its browser binary.';
    emitProgress(`blocked: ${blockerSummary}`);
    const evidence = createQaMachineEvidence({
      runnerVersion: pluginVersion(),
      playwrightVersion: 'unavailable',
      runId: args.runId,
      verificationContractHash: loaded.contract.contractHash,
      sourceHash: loaded.sourceHash,
      buildOutputRoot: loaded.manifest.outputRoot,
      buildHash: loaded.manifest.manifestHash,
      buildFingerprint: loaded.fingerprint,
      serverMode: owned.mode,
      serverPid: process.pid,
      serverPort: owned.port,
      serverStartedAt: owned.startedAt,
      serverUrl: owned.url,
      servedAssetHashes: [],
      scenarioHash,
      startedAt,
      generatedAt: new Date().toISOString(),
      status: 'blocked-environment',
      routes: [],
      blockerSummary,
    });
    writeJson(out.absolute, evidence);
    let published: ReturnType<typeof publishAndValidateReport>;
    try {
      published = publishAndValidateReport(
        args,
        loaded,
        owned,
        out.relative,
        'blocked-environment',
        [],
        blockerSummary,
        undefined,
        {
          routes: [],
          visual: loaded.contract.uiImpact === 'visual',
          playwrightOk: false,
          launchBlocker: null,
          servedOk: false,
          blockerSummary,
        },
      );
    } finally {
      await stopOnce();
    }
    process.stdout.write(`${JSON.stringify({
      ok: false,
      status: 'blocked-environment',
      reason: 'playwright-missing',
      machineEvidencePath: out.relative,
      reportPath: qaReportV2Path(args.projectRoot, args.runId),
      validation: {
        ok: published.ok,
        ...(published.code ? { code: published.code } : {}),
        ...(published.message ? { message: published.message } : {}),
      },
    })}\n`);
    return 2;
  }

  let browser: BrowserLike | null = null;
  const routes: QaMachineRouteEvidenceV1[] = [];
  let blocker: string | null = null;
  try {
    browser = await playwright.api.chromium.launch({ headless: true });
    const widths = loaded.contract.requiredScreenshotWidths.length > 0
      ? loaded.contract.requiredScreenshotWidths
      : [1440];
    let routeIndex = 0;
    for (const route of scenario.routes) {
      routeIndex += 1;
      const viewports: QaMachineViewportEvidenceV1[] = [];
      for (const width of widths) {
        emitProgress(`route ${routeIndex}/${scenario.routes.length} ${route.route} @${width}`);
        viewports.push(await runViewport(
          browser,
          owned,
          loaded.contract,
          route,
          width,
          path.dirname(out.absolute),
          args.timeoutMs,
        ));
      }
      routes.push({ route: route.route, viewports });
    }
  } catch (error) {
    blocker = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
  } finally {
    try { await browser?.close(); } catch { /* best effort */ }
  }
  const browserScenarioFailed = Boolean(blocker)
    || routes.some((route) => route.viewports.some((viewport) => viewport.status !== 'passed'));
  const lighthouseRequested = loaded.contract.performance.required || args.withLighthouse;
  if (lighthouseRequested) {
    emitProgress(browserScenarioFailed
      ? 'skipping Lighthouse: browser scenario failed'
      : 'running Lighthouse audit (can take minutes)');
  }
  const lighthouse = lighthouseRequested && !browserScenarioFailed
    ? await runLighthouseOnOwnedServer(args, loaded, owned)
    : null;
  // A performance-required run whose scenario failed must SAY Lighthouse was
  // skipped — a silently absent section reads as "nobody thought about
  // performance" (observed 8co).
  const lighthouseReportField: QaReportV2['lighthouse'] | undefined = lighthouse?.evidencePath
    ? { evidencePath: lighthouse.evidencePath }
    : lighthouseRequested && browserScenarioFailed
      ? {
          status: 'skipped-scenario-failed' as const,
          reason: 'browser scenario failed; Lighthouse was not attempted',
        }
      : undefined;
  const servedAssetHashes = [...owned.servedAssetHashes].sort();
  const failed = browserScenarioFailed
    || servedAssetHashes.length === 0
    || lighthouse?.status === 'failed';
  const browserUnavailable = Boolean(blocker && /browser.*(?:missing|install|executable)|playwright.*install/i.test(blocker));
  const environmentBlocked = browserUnavailable || lighthouse?.status === 'blocked-environment';
  const status = environmentBlocked
    ? 'blocked-environment' as const
    : failed
      ? 'failed' as const
      : 'passed' as const;
  const blockerSummary = blocker
    || lighthouse?.blockerSummary
    || (servedAssetHashes.length === 0
      ? 'Served responses did not match the build output manifest.'
      : undefined);
  const evidence = createQaMachineEvidence({
    runnerVersion: pluginVersion(),
    playwrightVersion: playwright.version,
    runId: args.runId,
    verificationContractHash: loaded.contract.contractHash,
    sourceHash: loaded.sourceHash,
    buildOutputRoot: loaded.manifest.outputRoot,
    buildHash: loaded.manifest.manifestHash,
    buildFingerprint: loaded.fingerprint,
    serverMode: owned.mode,
    serverPid: process.pid,
    serverPort: owned.port,
    serverStartedAt: owned.startedAt,
    serverUrl: owned.url,
    servedAssetHashes,
    scenarioHash,
    startedAt,
    generatedAt: new Date().toISOString(),
    status,
    routes,
    ...(blockerSummary ? { blockerSummary } : {}),
  });
  writeJson(out.absolute, evidence);
  const reportRoutes = routes.map((route) => ({
    route: route.route,
    viewports: route.viewports.map((viewport) => ({
      width: viewport.width,
      status: viewport.status,
      domAssertionsPassed: viewport.domAssertionsPassed,
      actionsPassed: viewport.actionsPassed,
      routingPassed: viewport.routingPassed,
      hydrationPassed: viewport.hydrationPassed,
      consoleErrors: viewport.consoleErrors,
      networkErrors: viewport.networkErrors,
      ...(viewport.actionErrors && viewport.actionErrors.length > 0
        ? { actionErrors: viewport.actionErrors }
        : {}),
      artifactAt: viewport.artifactAt,
      ...(viewport.screenshotPath ? { screenshotPath: viewport.screenshotPath } : {}),
    })),
  }));
  emitProgress('publishing report-v2.json');
  let published: ReturnType<typeof publishAndValidateReport>;
  try {
    published = publishAndValidateReport(
      args,
      loaded,
      owned,
      out.relative,
      status,
      reportRoutes,
      evidence.blockerSummary,
      lighthouseReportField,
      {
        routes: reportRoutes,
        visual: loaded.contract.uiImpact === 'visual',
        playwrightOk: true,
        launchBlocker: blocker,
        servedOk: servedAssetHashes.length > 0,
        ...(evidence.blockerSummary ? { blockerSummary: evidence.blockerSummary } : {}),
      },
    );
  } finally {
    await stopOnce();
  }
  process.stdout.write(`${JSON.stringify({
    ok: published.ok,
    status,
    machineEvidencePath: out.relative,
    reportPath: qaReportV2Path(args.projectRoot, args.runId),
    validation: {
      ok: published.ok,
      ...(published.code ? { code: published.code } : {}),
      ...(published.message ? { message: published.message } : {}),
    },
    ...(evidence.blockerSummary ? { blockerSummary: evidence.blockerSummary } : {}),
  })}\n`);
  if (status === 'blocked-environment') return 2;
  return published.ok ? 0 : 1;
  } finally {
    await stopOnce();
  }
}
