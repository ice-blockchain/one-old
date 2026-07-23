// src/test-environment/run.ts
// CLI entry for the Traffic One multi-host test environment. Run via:
//   npm run test:env            (fast deterministic, pure-node only)
//   npm run test:env -- --e2e   (also drive host CLIs — real LLM spend)
//
// This file is NEVER compiled into dist (see tsconfig.build.json exclude); it is
// a tsx-run maintainer tool.

import * as fs from 'fs';
import * as path from 'path';

import type { Category, CaseRunResult, HostId, RootTestConfig, VerdictHost } from './core/types';
import { ALL_CATEGORIES, ALL_HOSTS, defaultConfig } from './config/test-config';
import { ALL_CASES } from './config/cases';
import { discoverAssertions } from './assertions/registry';
import { preflight } from './core/preflight';
import { buildAndInstall, cleanupBuildInstall, type BuildResult } from './core/build-and-install';
import {
  runRequiredCodexTrustUpgradeProof,
} from './core/codex-trust-upgrade-proof';
import { runCase, reassertCase } from './core/case-runner';
import { releaseResultFailed } from './core/result-policy';
import { writeReport } from './reporting/aggregate-report';
import { runVerdict } from './reporting/verdict';
import type { CaseRunResult as CaseRunResultType, HostRunResult } from './core/types';

interface Flags {
  hosts?: HostId[];
  categories?: Category[];
  cases?: string[];
  verdictHost?: VerdictHost;
  noBuild?: boolean;
  noInstall?: boolean;
  concurrency?: number;
  timeoutMs?: number;
  auth?: 'on' | 'off';
  dryRun?: boolean;
  e2e?: boolean;
  strict?: boolean;
  runsDir?: string;
  reassert?: string;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = {};
  const multi = (raw: string): string[] => raw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const arg of argv) {
    const [key, rawValue] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, ''];
    const value = rawValue ?? '';
    switch (key) {
      case '--host': f.hosts = multi(value).filter((h): h is HostId => (ALL_HOSTS as string[]).includes(h)); break;
      case '--category': f.categories = multi(value).filter((c): c is Category => (ALL_CATEGORIES as string[]).includes(c)); break;
      case '--case': f.cases = multi(value); break;
      case '--verdict-host': f.verdictHost = (value as VerdictHost); break;
      case '--no-build': f.noBuild = true; break;
      case '--no-install': f.noInstall = true; break;
      case '--concurrency': f.concurrency = Number(value) || 1; break;
      case '--timeout': f.timeoutMs = Number(value) || undefined; break;
      case '--auth': f.auth = value === 'on' ? 'on' : 'off'; break;
      case '--dry-run': f.dryRun = true; break;
      case '--e2e': f.e2e = true; break;
      case '--all': f.e2e = true; break;
      case '--strict': f.strict = true; break;
      case '--runs-dir': case '--artifacts': f.runsDir = value; break;
      case '--reassert': f.reassert = value; break;
      default: break;
    }
  }
  return f;
}

function applyFlags(config: RootTestConfig, f: Flags): RootTestConfig {
  if (f.hosts && f.hosts.length) config.enabledHosts = f.hosts;
  if (f.categories && f.categories.length) config.enabledCategories = f.categories;
  if (f.cases && f.cases.length) config.caseFilter = f.cases;
  if (f.verdictHost) config.verdictHost = f.verdictHost;
  if (f.noBuild) config.build.refreshDist = false;
  if (f.noInstall) config.build.updateHosts = false;
  if (f.concurrency) config.concurrency = f.concurrency;
  if (f.timeoutMs) config.defaultTimeoutMs = f.timeoutMs;
  if (f.auth) config.auth = f.auth;
  if (f.dryRun) config.dryRun = true;
  if (f.e2e) config.includeHostE2E = true;
  if (f.strict) config.strict = true;
  if (f.runsDir) config.runsRoot = f.runsDir;
  return config;
}

interface PlannedRun {
  caseId: string;
  targets: (HostId | 'pure-node')[];
}

function cleanupReleaseInstall(build: BuildResult): boolean {
  const cleanup = cleanupBuildInstall(build);
  for (const note of cleanup.notes) console.log(`  cleanup: ${note}`);
  for (const failure of cleanup.failures) {
    console.error(`release-install cleanup failed (${failure.host}): ${failure.detail}`);
  }
  return cleanup.failures.length === 0;
}

function selectRuns(config: RootTestConfig): PlannedRun[] {
  const runs: PlannedRun[] = [];
  for (const c of ALL_CASES) {
    if (!config.enabledCategories.includes(c.category)) continue;
    if (config.caseFilter && !config.caseFilter.includes(c.id)) continue;
    if (c.layer === 'host-e2e' && !config.includeHostE2E) continue;

    if (c.layer === 'pure-node') {
      runs.push({ caseId: c.id, targets: ['pure-node'] });
    } else {
      const hosts = (c.hostFilter ?? config.enabledHosts).filter((h) => config.enabledHosts.includes(h));
      if (hosts.length) runs.push({ caseId: c.id, targets: hosts });
    }
  }
  return runs;
}

async function reassertRun(
  dirArg: string,
  config: RootTestConfig,
  caseById: Map<string, (typeof ALL_CASES)[number]>,
  startedAt: string,
): Promise<number> {
  const dir = path.resolve(dirArg);
  let prior: { results?: CaseRunResultType[] };
  try {
    prior = JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')) as { results?: CaseRunResultType[] };
  } catch (e) {
    console.error(`--reassert: cannot read ${path.join(dir, 'results.json')}: ${String(e)}`);
    return 2;
  }
  const assertions = discoverAssertions();
  console.log(`reassert ${dir}\nassertions: ${[...assertions.keys()].join(', ')}`);

  const out: CaseRunResultType[] = [];
  for (const r of prior.results ?? []) {
    const testCase = caseById.get(r.caseId);
    if (!testCase) { console.log(`  skip ${r.caseId} (no such case in current config)`); continue; }
    const rr = await reassertCase(testCase, r.host, config, assertions, dir, r.hostResult as HostRunResult);
    const f = rr.assertions.filter((a) => a.status === 'FAIL').length;
    console.log(`reassert ${r.caseId} @ ${r.host} ... ${f > 0 ? `FAIL (${f})` : 'ok'}`);
    out.push(rr);
  }

  const summary = writeReport(out, config, startedAt, dir);
  console.log(`\nreport: ${summary.reportPath}`);
  console.log(`assertions: PASS ${summary.pass} · FAIL ${summary.fail} · SKIP ${summary.skip} · INCONCLUSIVE ${summary.inconclusive} · UNSUPPORTED ${summary.unsupported}`);
  return releaseResultFailed(summary, config.strict) ? 1 : 0;
}

// Best-effort `latest` symlink → newest run, for quick access. All runs are kept.
function updateLatestPointer(runsRoot: string, runDir: string): void {
  const link = path.join(runsRoot, 'latest');
  try {
    fs.rmSync(link, { force: true });
    fs.symlinkSync(runDir, link, 'dir');
  } catch { /* symlinks may be unavailable; ignore */ }
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const config = applyFlags(defaultConfig(), flags);
  const startedAt = new Date().toISOString();
  const runStamp = startedAt.replace(/[:.]/g, '-');
  const runDir = path.join(config.runsRoot, runStamp);
  const caseById = new Map(ALL_CASES.map((c) => [c.id, c]));

  // --reassert <dir>: re-evaluate a prior run's assertions against its persisted
  // projects. No host calls, no token spend — for iterating on assertions.
  if (flags.reassert) return reassertRun(flags.reassert, config, caseById, startedAt);

  const planned = selectRuns(config);

  const anyE2E = planned.some((p) => p.targets.some((t) => t !== 'pure-node'));
  const e2eHosts = new Set<HostId>();
  for (const p of planned) for (const t of p.targets) if (t !== 'pure-node') e2eHosts.add(t);

  // Preflight
  const pf = preflight(config.hosts, config.enabledHosts);
  console.log(`node ${process.version} (ok=${pf.nodeOk}) · hosts available: ${ALL_HOSTS.map((h) => `${h}=${pf.hostAvailable[h] ? 'yes' : 'no'}`).join(' ')}`);
  if (!pf.nodeOk && anyE2E) {
    console.error('Node >=22 required for host-e2e/build. Run under nvm v22 (`nvm use 22`).');
    return 2;
  }
  if (anyE2E && e2eHosts.has('claude') && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.warn('⚠ host-e2e auth (claude): `claude -p` runs non-interactively and cannot refresh an');
    console.warn('  OAuth token, so it 401s even when interactive `claude` works (worse inside a Claude');
    console.warn('  Code session). Fix once: `claude setup-token` → `export CLAUDE_CODE_OAUTH_TOKEN=<token>`,');
    console.warn('  then re-run in that shell (the token is inherited; works nested too).');
  }
  if (anyE2E && e2eHosts.has('cursor') && !process.env.CURSOR_API_KEY) {
    console.warn('⚠ host-e2e auth (cursor): set `export CURSOR_API_KEY=<key>` (or `cursor-agent login`');
    console.warn('  once) so headless cursor-agent can authenticate. Also confirm `/add-plugin <dist>`');
    console.warn('  was run once in the Cursor editor, or the plugin may not load in headless mode.');
  }

  if (config.dryRun) {
    console.log('\n--- DRY RUN ---');
    console.log(`run dir: ${runDir}`);
    console.log(`host-e2e: ${config.includeHostE2E ? 'on' : 'off'} · verdict: ${config.verdictHost}`);
    for (const p of planned) console.log(`  ${p.caseId} -> [${p.targets.join(', ')}]`);
    if (anyE2E) {
      console.log('\nresolved host commands:');
      for (const h of e2eHosts) console.log(`  ${h}: ${config.hosts[h].bin} ${config.hosts[h].runArgs.join(' ')}${config.hosts[h].verified ? '' : '  (DEFAULTS-TO-VERIFY)'}`);
    }
    console.log(`\n${planned.length} case-run(s) planned.`);
    return 0;
  }

  // Build + install only when host-e2e runs are planned.
  let distRoot = '';
  let releaseBuild: BuildResult | null = null;
  if (anyE2E) {
    const build = buildAndInstall(config, [...e2eHosts]);
    releaseBuild = build;
    distRoot = build.distRoot;
    console.log(`build: dist=${distRoot} fingerprint=${build.distFingerprint || 'unavailable'} built=${build.built} installed=[${build.installed.join(', ')}] session=[${build.sessionProof.join(', ')}] per-case=[${build.perCaseProof.join(', ')}] exempted=[${build.exempted.join(', ')}]`);
    for (const n of build.notes) console.log(`  note: ${n}`);
    if (config.build.refreshDist && !build.built) {
      console.error('dist build failed — aborting host-e2e run.');
      cleanupReleaseInstall(build);
      return 2;
    }
    if (!build.currentDistReady) {
      for (const failure of build.currentDistFailures) {
        console.error(`current-dist proof failed (${failure.host}): ${failure.detail}`);
      }
      console.error('selected hosts are not proven to use the current dist — aborting host-e2e run.');
      cleanupReleaseInstall(build);
      return 2;
    }
    if (e2eHosts.has('codex')) {
      console.log('codex trust-upgrade proof: isolated v1 approval -> byte-identical hooks on v2 (no bypass)');
    }
    const proof = await runRequiredCodexTrustUpgradeProof(e2eHosts, {
      distRoot: build.distRoot,
      codexBin: config.hosts.codex.bin,
    });
    if (proof) {
      for (const note of proof.notes) console.log(`  trust-proof note: ${note}`);
      if (!proof.ok) {
        console.error(`codex trust-upgrade proof failed at ${proof.stage}: ${proof.detail}`);
        console.error('Codex E2E cases are blocked because persisted hook trust was not proven.');
        cleanupReleaseInstall(build);
        return 2;
      }
      console.log(`  trust-proof: ${proof.afterTrusted}/${proof.expectedHooks} trusted; observed [${proof.observedEvents.join(', ')}]`);
    }
  }

  let exitCode = 0;
  let cleanupOk = true;
  try {
    const assertions = discoverAssertions();
    console.log(`assertions: ${[...assertions.keys()].join(', ')}`);

    // Execute (serial — in-process state isolation assumes concurrency 1).
    const results: CaseRunResult[] = [];
    for (const p of planned) {
      const testCase = caseById.get(p.caseId);
      if (!testCase) continue;
      for (const target of p.targets) {
        process.stdout.write(`run ${p.caseId} @ ${target} ... `);
        const r = await runCase(testCase, target, config, distRoot, assertions, runDir);
        const f = r.assertions.filter((a) => a.status === 'FAIL').length;
        console.log(f > 0 ? `FAIL (${f})` : 'ok');
        results.push(r);
      }
    }

    const summary = writeReport(results, config, startedAt, runDir);
    updateLatestPointer(config.runsRoot, runDir);
    console.log(`\nrun dir: ${runDir}`);
    console.log(`report: ${summary.reportPath}`);
    console.log(`assertions: PASS ${summary.pass} · FAIL ${summary.fail} · SKIP ${summary.skip} · INCONCLUSIVE ${summary.inconclusive} · UNSUPPORTED ${summary.unsupported}`);

    const verdict = await runVerdict(config, distRoot, runDir);
    if (verdict.ran) console.log(`verdict (${verdict.host}): ${verdict.status}${verdict.verdictPath ? ` → ${verdict.verdictPath}` : ` — ${verdict.note}`}`);
    else if (verdict.note) console.log(`verdict: ${verdict.note}`);

    const failed = releaseResultFailed(summary, config.strict);
    exitCode = failed ? 1 : 0;
  } finally {
    if (releaseBuild) cleanupOk = cleanupReleaseInstall(releaseBuild);
  }
  return cleanupOk ? exitCode : 2;
}

main().then((code) => { process.exitCode = code; }).catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
