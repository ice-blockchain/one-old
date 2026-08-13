// src/runners/lighthouse/cli-args.ts
// Lighthouse runner defaults, argument parsing, and usage text.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { readRegularText } from './bounded-read';

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
 *
 * Both reads are BOUNDED (./bounded-read): these are project-relative paths a
 * clone can deliver as a symlink, and a FIFO or a device at either one used to
 * park the runner in `open(2)` for as long as anyone was willing to wait. A
 * shape that cannot be read lands on the `null` this reader already answers for
 * a corrupt contract, which is the honest verdict — there is no budget here we
 * can trust, so the CLI's own defaults gate the audit, exactly as they do for a
 * project that declares no contract at all.
 */
export function contractThresholds(rootDir: string): Partial<LighthouseArgs> | null {
  const readJson = (file: string): Rec | null => {
    try {
      const parsed: unknown = JSON.parse(readRegularText(file));
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
 *
 * BOUNDED (./bounded-read). `.one.json` is the clone-deliverable path this whole
 * class was found at, and an unreadable shape answers `null` — the same answer a
 * project with no Traffic One state gives, and the right one: an unscoped report
 * directory is a cosmetic loss, where a runner that never returns reports no
 * page speed at all.
 */
export function currentRunId(rootDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(
      readRegularText(join(rootDir, '.traffic-one', '.one.json')),
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

/**
 * The served build's identity: the hashed entry asset, or the Next BUILD_ID.
 *
 * Both reads are BOUNDED (./bounded-read). These paths are BUILD OUTPUT, which
 * makes them the easiest of the lot to point somewhere hostile — a build script
 * writes them, and the two `catch`es below already mean "this project is not
 * built with this layout". A shape that cannot be read joins them, so the report
 * simply carries no build tag; the audit itself is unaffected.
 */
export function buildFingerprintTag(rootDir: string, appDir: string): string | null {
  const sanitize = (value: string): string | null => {
    const cleaned = value.replace(/\.[cm]?js$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
    return cleaned || null;
  };
  for (const dir of [appDir, rootDir]) {
    for (const outDir of ['dist', 'out', '.output/public', 'build', 'public/build']) {
      try {
        const html = readRegularText(join(dir, ...outDir.split('/'), 'index.html'));
        const match = /<script[^>]+src="([^"]+\.[cm]?js)"/.exec(html);
        if (match?.[1]) return sanitize(match[1].split('/').pop() || '');
      } catch {
        // not built with this layout
      }
    }
    try {
      const buildId = readRegularText(join(dir, '.next', 'BUILD_ID')).trim();
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

export type BlockedStatus = 'blocked:sandbox' | 'blocked:usage-limit' | 'blocked:timeout'
  | 'blocked:lighthouse-missing' | 'blocked:preview-command-missing';

/**
 * The failures that are NOT environment gaps, and therefore not `blocked:*`.
 *
 * `blocked:` says something outside this repository stopped the measurement — a
 * sandbox denying a bind, a quota, a host missing a binary — and an agent is told
 * to report page speed as unverified and move on. Putting a broken build under
 * that prefix would launder a red into an environment excuse, which is the exact
 * failure class this runner's own bounds exist to prevent, so these get their own
 * prefix and their own repair.
 *
 * `failed:project` is a precondition of auditing that this project, or the way the
 * runner was invoked, did not meet: no production build to preview, no URL to
 * audit, a build script that failed. The runner worked; there was nothing
 * auditable in front of it.
 *
 * `failed:unclassified` is the terminal arm, and it exists so the contract at
 * index.mts — one final JSON status line, always — can be TOTAL. It claims
 * nothing about whose repair it is, which is the honest answer for an error no
 * one anticipated, and also for the two this runner throws when the audit
 * finished without leaving a readable artifact: the page, the Lighthouse CLI and
 * the host are all live candidates there and the runner cannot tell them apart.
 * A status that guessed would send the reader to the wrong file.
 */
export type FailedStatus = 'failed:project' | 'failed:unclassified';

export type RunnerStatus = BlockedStatus | FailedStatus;

/**
 * Every status this runner can print, as one runtime list.
 *
 * Exported because the totality property in
 * __tests__/preview-start-failure.test.ts checks MEMBERSHIP rather than
 * non-nullness: a classifier that answered `undefined`, or a string outside the
 * union that only a cast made possible, would satisfy "always returns something"
 * and still leave the caller with a status it does not know.
 */
export const RUNNER_STATUSES: readonly RunnerStatus[] = [
  'blocked:sandbox',
  'blocked:usage-limit',
  'blocked:timeout',
  'blocked:lighthouse-missing',
  'blocked:preview-command-missing',
  'failed:project',
  'failed:unclassified',
];

// Canonical missing-binary message: thrown by the runner in --local-only mode and
// matched by classifyBlockedStatus, so the caller always gets a structured,
// actionable status instead of an approval-layer denial of the dlx branch.
export function lighthouseMissingMessage(packageManager: PackageManager, lighthouseVersion: string): string {
  const add = packageManager === 'yarn' ? 'yarn add -D' : packageManager === 'npm' ? 'npm install -D' : `${packageManager} add -D`;
  return `No local Lighthouse binary (node_modules/.bin/lighthouse) and network install is disabled (--local-only). `
    + `Install it as a devDependency with the project's package manager (\`${add} lighthouse@${lighthouseVersion}\`) and re-run. `
    + 'Do not drop --local-only on hosts whose approval layer denies registry-download execution.';
}

/**
 * Canonical preview-refusal message: thrown when the operating system will not
 * execute the package manager the preview needs, and matched by
 * `classifyBlockedStatus` — the same contract the message above has, for the same
 * reason. A binary this run needs that is not usable on this host is an
 * environment gap, and this runner reports those as a structured `blocked:*`
 * status rather than as a bare failure.
 *
 * It gets its OWN status rather than joining an existing one because every
 * existing arm would misdirect the repair. `blocked:sandbox` says the host denied
 * us a port or a Chrome, `blocked:usage-limit` says an API refused us, and
 * `blocked:timeout` — the one this used to be mistaken for — says the preview
 * server was given time and did not use it. Here the preview server was never
 * started, so the fix is to install the package manager or point the runner at a
 * URL that is already serving, not to raise `--timeout`.
 */
export function previewCommandMissingMessage(
  packageManager: PackageManager,
  spawnFailure: string,
): string {
  return `The preview command could not be executed: ${spawnFailure}. `
    + `\`${packageManager}\` is the package manager this project declares, and this host cannot run it `
    + '(not installed, not on PATH, or not executable). The preview server never started, so nothing '
    + 'was served and nothing was audited — this is not a readiness timeout. Install '
    + `${packageManager}, or audit an already-running URL with \`--url <url> --skip-preview\`.`;
}

// Maps a runner failure message to the structured status the page-speed hook
// parses. Sandbox and usage-limit keep priority over the timeout branch so a
// bind-denial that also mentions a timeout still reads as blocked:sandbox.
//
// THE ORDER OF THE FIRST TWO BRANCHES IS LOAD-BEARING, and not for the reason
// the sentence above gives. A preview refusal quotes node's own spawn error, and
// the everyday second shape of one is `spawn ./dev.sh EACCES` — which the sandbox
// pattern below matches on the bare word. Moving the preview branch under it
// would report a package manager without its execute bit as the host denying a
// port bind, and send the reader to Codex escalation for a chmod.
export function classifyBlockedStatus(message: string): BlockedStatus | null {
  if (/No local Lighthouse binary/i.test(message)) return 'blocked:lighthouse-missing';
  if (/preview command could not be executed/i.test(message)) return 'blocked:preview-command-missing';
  if (/listen EPERM|EACCES|operation not permitted|Chrome.*(failed|sandbox)|No usable sandbox|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(message)) {
    return 'blocked:sandbox';
  }
  if (/usage limit|rate limit|quota/i.test(message)) return 'blocked:usage-limit';
  // `did not become ready` is the readiness wait's own wording, and it belongs
  // here rather than being left to fall through: it is the SIBLING of the branch
  // above it — the preview that started and never bound, against the preview that
  // never started — and until this arm existed it matched none of these patterns,
  // so the one failure the runner is most likely to hit produced no status line at
  // all. Which is the same contract break as an uncaught spawn error, reached
  // politely: `main` prints the message to stderr, the page-speed hook parses
  // stdout, and page speed silently goes unreported rather than UNVERIFIED.
  if (/timed out|timeout|exceeded .*budget|did not become ready/i.test(message)) return 'blocked:timeout';
  return null;
}

// A precondition of auditing that this project — or the way the runner was
// invoked — did not meet. Nothing here is an environment gap: the host is fine,
// there is simply nothing auditable in front of the runner.
//
// The exit-code branch reads the command out of the message because that is the
// only place it survives: `runCommand` is shared by the build script and the
// audit child and reports both as `<argv> failed with exit N`, so the SAME arm
// would otherwise have to answer for a broken build (fix the project) and for
// Lighthouse itself exiting non-zero (could be the page, the CLI, or Chrome).
// Matching the build wording keeps the first honest and lets the second fall to
// the terminal arm, which is the accurate answer for it. Threading a typed error
// out of `runCommand` would carry the distinction properly and is the better
// shape, but it touches every caller of a function two other paths depend on;
// this stays inside the classifier.
function classifyProjectFault(message: string): FailedStatus | null {
  if (/build metadata is missing|static export output is missing/i.test(message)) return 'failed:project';
  if (/No URL to audit|--skip-preview requires --url/i.test(message)) return 'failed:project';
  if (/\bbuild failed with exit \d+/i.test(message)) return 'failed:project';
  return null;
}

/**
 * The TOTAL classifier, and the one `main` must use.
 *
 * index.mts promises one final JSON status line on every exit, and its watchdog
 * exists to honour that promise for a hang. The failure path made the same
 * promise and did not keep it: it printed the line only when
 * `classifyBlockedStatus` recognised the message, so every unrecognised error
 * exited with empty stdout — no line for the page-speed hook to parse, and
 * therefore page speed silently unreported rather than reported UNVERIFIED. Three
 * routes reached that hole by known messages and any new `throw` reached it by
 * default, which is the wrong default for a total contract.
 *
 * `classifyBlockedStatus` stays partial on purpose. It answers a narrower
 * question — "is this an environment gap" — that the sandbox-escalation branch in
 * the page-speed hook still needs to ask, and widening it would have forced
 * project faults into `blocked:*`. Totality belongs here, in the function whose
 * job is "what do we print", and the return type carries it: no `| null` to
 * forget to handle.
 */
export function classifyRunnerFailure(message: string): RunnerStatus {
  return classifyBlockedStatus(message) ?? classifyProjectFault(message) ?? 'failed:unclassified';
}

/**
 * Every JSON file this runner reads off the project: `package.json` at the root
 * and in each `apps/*`, and the Lighthouse report the audit just wrote.
 *
 * BOUNDED (./bounded-read), and `null` keeps meaning exactly what it meant — "no
 * usable JSON here". Absence, a parse failure and a hostile shape have always
 * been one answer at this reader, and the callers are written for it: package
 * manager detection falls back to npm, app detection falls back to the root, and
 * the report reader raises `Could not read Lighthouse report`, which is a failure
 * the runner reports rather than one it hangs on.
 */
export function readJson(filePath: string): Rec | null {
  try {
    return JSON.parse(readRegularText(filePath)) as Rec;
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

