// src/shared/retention.ts
// Conservative .traffic-one retention sweep. Durable project memory is never
// touched; only correlated run artefacts and clearly-ephemeral logs/locks/backups
// are candidates. Dry-run by default.
//
// Deletion is a write, and this sweep is the single biggest one in the runtime
// (measured: 55 paths reclaimed in one SessionStart). It goes through fsjson's
// guarded removePath, so a project whose use-plugin question is unanswered is
// never reclaimed — the pending half of the product contract is byte-identity,
// and this half of breaking it is the irreversible one. Planning is unaffected:
// collectActions only reads, so a dry run still reports what WOULD go.
//
// The keep set is RECENCY plus LIVENESS. Recency alone deleted runs that agents
// were still working inside, because the newest-N window is blind to whether a
// run is alive: measured on a realistic 9-run tree, 5 runs were reclaimed and 2
// of those 5 still held live claims. See runIsLive — and note that liveness is
// deliberately built out of protections that EXPIRE, so the sweep can never
// decay into a no-op that grows `.traffic-one` without bound.

import * as fs from 'fs';
import * as path from 'path';

import { SUBAGENT_STALE_MS } from '../config/state';
import { readJson, removePath } from './fsjson';
import { resolveProjectRoot } from './hook/paths';
import { obj } from './obj';
import { runLiveClaimEvidence } from './run-settlement';
import { runLedgerStatusRecord } from './state/run-agent/terminal-verdict';

interface RetentionPolicy {
  keepRuns: number;
  backupKeep: number;
  orphanTtlDays: number;
  /** Newest Lighthouse runs kept per route; older ones are superseded copies. */
  lighthouseKeepPerRoute: number;
}

interface RetentionAction {
  action: 'remove';
  path: string;
  reason: string;
}

interface RetentionResult {
  cwd: string;
  dryRun: boolean;
  policy: RetentionPolicy;
  keepRunIds: string[];
  /**
   * The subset of `keepRunIds` retained because the run is still ALIVE (live
   * claims, or a non-terminal ledger inside the mint window) rather than merely
   * recent. Reported so a dry run can say WHY a run survived — without it the
   * newest-N reason string is the only explanation on offer, and it is the wrong
   * one for these ids.
   */
  liveRunIds: string[];
  actions: RetentionAction[];
  removed: number;
}

// Tightened after the 12co audit: 5 retained runs held 113 files / 1.17 MB in
// `runs/` plus 9.5 MB of reports for a single settled run; backups were all
// byte-identical. One backup, three runs, and one Lighthouse pair per route
// cover every recovery path the runtime actually exercises.
const DEFAULT_POLICY: RetentionPolicy = {
  keepRuns: 3,
  backupKeep: 1,
  orphanTtlDays: 3,
  lighthouseKeepPerRoute: 1,
};

function readPolicy(cwd: string): RetentionPolicy {
  const raw = obj(readJson(path.join(cwd, '.traffic-one', 'retention.json'), null));
  if (!raw) return DEFAULT_POLICY;
  const keepRuns = Number(raw.keepRuns);
  const backupKeep = Number(raw.backupKeep);
  const orphanTtlDays = Number(raw.orphanTtlDays);
  const lighthouseKeepPerRoute = Number(raw.lighthouseKeepPerRoute);
  return {
    keepRuns: Number.isFinite(keepRuns) && keepRuns >= 1 ? Math.floor(keepRuns) : DEFAULT_POLICY.keepRuns,
    backupKeep: Number.isFinite(backupKeep) && backupKeep >= 0 ? Math.floor(backupKeep) : DEFAULT_POLICY.backupKeep,
    orphanTtlDays: Number.isFinite(orphanTtlDays) && orphanTtlDays >= 0 ? orphanTtlDays : DEFAULT_POLICY.orphanTtlDays,
    lighthouseKeepPerRoute: Number.isFinite(lighthouseKeepPerRoute) && lighthouseKeepPerRoute >= 1
      ? Math.floor(lighthouseKeepPerRoute)
      : DEFAULT_POLICY.lighthouseKeepPerRoute,
  };
}

function listDirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function listFiles(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// A nested `.traffic-one/.one.json` is a LEAK (safe to remove) ONLY when it does not
// belong to its OWN independent project. We delegate that judgement to
// resolveProjectRoot — the single source of truth the write-side and every gate use —
// so cleanup can never disagree with the resolver. A genuine independent onboarded
// project (a mode-bearing `.one.json` with NO workspace ancestor) resolves to ITSELF
// and is kept; a monorepo sub-package's stray/leaked state (the packages/ui incident)
// resolves UP to the enclosing workspace root, so it differs from its own dir and is a
// deletion candidate. This mirrors nearestWorkspaceRoot/dirDeclaresWorkspace — the same
// gate isUnclaimedWorkspaceSubPackage uses on the write side.
function isLeakedNestedRoot(projectDir: string): boolean {
  const dir = path.resolve(projectDir);
  try {
    return resolveProjectRoot(dir) !== dir;
  } catch {
    return false; // never delete on an indeterminate resolution
  }
}

function listNestedTrafficOneDirs(cwd: string): string[] {
  const out: string[] = [];
  const root = path.resolve(cwd);
  const trafficDir = '.traffic' + '-one';
  const skip = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.turbo', '.pnpm-store']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || out.length >= 50) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skip.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.name === trafficDir) {
        if (path.dirname(abs) !== root
          && fs.existsSync(path.join(abs, '.one.json'))
          && isLeakedNestedRoot(path.dirname(abs))) {
          out.push(abs);
        }
        continue;
      }
      walk(abs, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

function numericDesc(a: string, b: string): number {
  return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
}

function readCurrentRunId(cwd: string): string | null {
  const state = obj(readJson(path.join(cwd, '.traffic-one', '.one.json'), null));
  const runId = state && typeof state.currentRunId === 'string' ? state.currentRunId.trim() : '';
  return runId || null;
}

function collectRunIds(cwd: string): string[] {
  const t1 = path.join(cwd, '.traffic-one');
  const ids = new Set<string>();
  for (const rel of ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')]) {
    for (const name of listDirs(path.join(t1, rel))) {
      if (name === '.once') continue;
      ids.add(name);
    }
  }
  const current = readCurrentRunId(cwd);
  if (current) ids.add(current);
  return [...ids].sort(numericDesc);
}

// How old a run is, measured from the id itself: the runtime mints run ids as
// epoch-ms stamps (run-paths.ts only ever adopts /^\d{13}$/), which is an
// IMMUTABLE birth time. A directory mtime is not — every child write moves it,
// including this sweep's own per-run debug deletions below — so mtime would let
// a run refresh its own protection. It stays as the fallback only so a foreign
// or legacy id shape is never denied protection it would otherwise earn.
function runAgeMs(cwd: string, runId: string, nowMs: number): number {
  if (/^\d{13}$/.test(runId)) {
    const minted = Number(runId);
    if (Number.isFinite(minted)) return nowMs - minted;
  }
  // `currentRunId` is attacker-controllable JSON, so a separator-bearing id must
  // not be able to steer this stat at some unrelated directory's mtime and buy
  // itself protection. Unaged is the safe answer: it protects nothing.
  if (/[\\/]/.test(runId) || runId === '.' || runId === '..') return Number.POSITIVE_INFINITY;
  try {
    return nowMs - fs.statSync(path.join(cwd, '.traffic-one', 'runs', runId)).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// The question this sweep never asked. Deleting a run is not just untidy while
// an agent is still inside it: claim resolution walks EVERY run on disk
// (runIdsForLookup, claims-pending.ts) to find the record that grants an agent
// its write authority, so reclaiming a live run's directory demotes a working
// agent to `no-claim` and the gates start refusing its writes.
//
// Both protection sources are deliberately SELF-LIMITING, because a keep-set
// that only ever grows is a worse bug than the one this fixes:
//
//   - Live claims decay on their own. The claim walk (run-settlement/io.ts)
//     already ignores any claim untouched for longer than SUBAGENT_STALE_MS, so
//     this borrows an expiry instead of inventing one.
//
//     It reads that walk through runLiveClaimEvidence and NOT through
//     activeRunClaimCount, and the difference is the whole reason the
//     three-valued reader exists. activeRunClaimCount folds a scan that could
//     not FINISH — the 2,048-entry bound, or one unreadable subdirectory — into
//     `Math.max(1, count)`: "at least one live claim". That sentinel is right
//     for the callers it was written for, which are settlement VETOES, and it
//     is wrong here, because the two directions only LOOK like the same
//     direction.
//
//     For a veto, ignorance-as-keep is SELF-LIMITING: the refusal lifts the
//     moment the scan succeeds. For a DELETER it is SELF-DEFEATING, because the
//     only thing that would remove the records the scan choked on is the sweep
//     the sentinel suppresses, so the condition never clears on its own.
//     MEASURED on a run holding 2,100 claims every one of which was 30 days
//     stale: the sentinel reported 1, the sweep filed the run under liveRunIds
//     — RESERVED outside the newest-N budget, see keepRunIds — and it held that
//     slot permanently while two NEWER runs were reclaimed around it.
//
//     So the ignorance is read as ignorance and answered on its own terms; the
//     `unknown` arm in runIsLive says how, and what bounds it.
//
//   - A non-terminal LEDGER decays not at all: the abandoned run described in
//     the orphan rule below sat at `status: active` indefinitely. Protecting
//     every non-terminal ledger would make that exact run immortal and re-open
//     the 8cl defect this file already closed, so the ledger alone only
//     protects a run still inside the mint window — long enough to cover a run
//     minted seconds ago that has not yet written its first claim, which is the
//     window in which it is most fragile and least provably alive.
//
// A TERMINAL ledger does not override a live claim. Settlement records a verdict
// about the PAST; a fresh claim is evidence about the PRESENT, and the two
// disagreeing means a claim outlived its settlement, not that the holder is
// gone. run-settle.ts and runCompletionEvidenceAllows both refuse to reach
// terminal at all while claims are live, so the combination is already an
// anomaly — and in an anomaly the reversible choice is to keep.
//
// Neither use of `runAgeMs` below is skew-guarded, and that is the deliberate
// choice rather than an oversight. A run id minted while the clock ran ahead
// gives `runAgeMs` a negative age, which is inside every window forever, so
// such a run is never reclaimed through either arm — an unbounded-disk bug, and
// a real one. Refusing to protect it would trade that for an IRREVERSIBLE one,
// and the trade is one-sided rather than balanced: `runAgeMs` is consumed in
// exactly two places, both spelled `age < WINDOW -> KEEP`, so a guard here can
// only ever ADD deletions and can never prevent one.
//
// It would also arrive at the worst possible moment. The claim walk USED to
// read a future stamp as maximally fresh exactly as this does; since
// `ageAttestsLiveness` landed in run-settlement/io.ts it no longer does, so a
// future-stamped claim has ALREADY lost its claim-side protection. MEASURED
// with a skew guard fitted here: a run whose ledger still says `active` and
// whose claims are future-stamped goes from protected to reclaimable — both
// protections gone at the same instant, for a run an agent may be working
// inside. The asymmetry decides it: keeping a dead run costs disk, deleting a
// live one demotes a working agent to `no-claim` and the gates start refusing
// its writes.
//
// So the cost is what it is, and it is named here rather than left to be
// rediscovered: a future-minted id is protected INDEFINITELY through both arms,
// the ledger one and the ignorance one. Accepted — it is the conservative
// direction, and the ignorance half is a strictly narrower shape than the
// status quo it replaces, which protected EVERY run with an unfinishable scan
// forever regardless of age. Both halves are pinned by name in
// __tests__/retention.test.ts ("the skew trade, made visible" and "the accepted
// cost") so a guard fitted here can never land looking free.
//
// The half of the exposure that is NOT ours, stated so the ledger above is not
// mistaken for full cover: a future-minted run whose ledger is terminal and
// whose claims are future-stamped is protected by nothing at all. That is
// decided in run-settlement/io.ts, not here.
function runIsLive(cwd: string, runId: string, nowMs: number): boolean {
  // Ledger first: one file read, and it settles the fresh-mint case without
  // paying for a recursive claim walk.
  const status = runLedgerStatusRecord(cwd, runId).status;
  if ((status === 'planned' || status === 'active') && runAgeMs(cwd, runId, nowMs) < SUBAGENT_STALE_MS) return true;
  const claims = runLiveClaimEvidence(cwd, runId);
  if (claims === 'live') return true;
  if (claims === 'none') return false;
  // A scan that could not finish is ignorance, not evidence. Keeping on it is
  // right while the run could still be in use and self-defeating past that, so
  // it is answered with the one thing still legible about the run — its own
  // birth stamp — under a BORROWED window, never an invented one.
  // SUBAGENT_STALE_MS is already spent twice over on this exact question: by
  // the ledger arm above, and by the claim walk itself when it decides a claim
  // still attests liveness. Ignorance therefore protects for as long as the
  // live claim it stands in for could have, and no longer.
  return runAgeMs(cwd, runId, nowMs) < SUBAGENT_STALE_MS;
}

function keepRunIds(
  cwd: string,
  policy: RetentionPolicy,
  nowMs: number,
  protectRunIds: readonly string[] = [],
): { keep: Set<string>; live: Set<string> } {
  const current = readCurrentRunId(cwd);
  const ids = collectRunIds(cwd);
  const keep = new Set<string>();
  if (current) keep.add(current);
  // Caller-protected ids (the run being settled) are unconditional: a settle
  // of an OLDER run must never reclaim the ledger it wrote milliseconds ago.
  for (const id of protectRunIds) if (id) keep.add(id);
  // Live runs are RESERVED outside the newest-N budget, exactly as the
  // caller-protected ids above are, and for the same reason: liveness is a
  // correctness requirement, not a retention preference. Charging it to the
  // budget would let a live OLD run evict a recent one — trading a wrong
  // deletion for a different wrong deletion — and would make how much history
  // a project retains depend on how many agents happen to be running right now.
  const live = new Set<string>();
  for (const id of ids) {
    if (!runIsLive(cwd, id, nowMs)) continue;
    live.add(id);
    keep.add(id);
  }
  const reserved = keep.size;
  for (const id of ids) {
    if (keep.size >= policy.keepRuns + reserved) break;
    keep.add(id);
  }
  return { keep, live };
}

function maybeAction(actions: RetentionAction[], filePath: string, reason: string): void {
  actions.push({ action: 'remove', path: filePath, reason });
}

function isOlderThan(filePath: string, ttlMs: number, nowMs: number): boolean {
  try {
    return (nowMs - fs.statSync(filePath).mtimeMs) >= ttlMs;
  } catch {
    return false;
  }
}

function collectActions(cwd: string, policy: RetentionPolicy, nowMs: number, protectRunIds: readonly string[] = []): { keep: Set<string>; live: Set<string>; actions: RetentionAction[] } {
  const t1 = path.join(cwd, '.traffic-one');
  const { keep, live } = keepRunIds(cwd, policy, nowMs, protectRunIds);
  const actions: RetentionAction[] = [];

  for (const rel of ['runs', 'digests', 'fix-cycles', path.join('reports', 'qa')]) {
    const root = path.join(t1, rel);
    for (const id of listDirs(root)) {
      if (id === '.once') continue;
      if (!keep.has(id)) maybeAction(actions, path.join(root, id), `older than retained run set (${policy.keepRuns})`);
    }
  }

  // Runs that never reached a compiled architecture are not runs — they were
  // minted, captured a baseline, and abandoned. Observed 8cl: a run minted 3.5
  // minutes AFTER the previous one settled `agent-failed`, holding a 1.63 MB
  // baseline, still `status: active`, while `currentRunId` stayed on the earlier
  // run. Nothing reclaimed it because the keep-set counts it as one of the five
  // most recent. The TTL keeps an in-flight pre-PLAN_READY run untouched.
  //
  // This rule deletes runs the keep set RETAINED, so it needs the liveness
  // question asked separately — being inside `keep` is not what protects a run
  // here. A pre-PLAN_READY run that is still holding live claims is the very
  // shape the TTL was meant to spare, and the TTL alone does not spare it: a
  // long-lived or resumed run passes 3 days while an agent is working in it.
  const ttl = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
  const currentRunId = readCurrentRunId(cwd);
  for (const id of listDirs(path.join(t1, 'runs'))) {
    if (id === '.once' || id === currentRunId || protectRunIds.includes(id) || live.has(id)) continue;
    const runDir = path.join(t1, 'runs', id);
    if (actions.some((action) => action.path === runDir)) continue;
    if (fs.existsSync(path.join(runDir, 'architecture-v1.json'))) continue;
    if (!isOlderThan(runDir, ttl, nowMs)) continue;
    maybeAction(actions, runDir, `abandoned before architecture compilation and older than ${policy.orphanTtlDays} days`);
  }

  const backups = listDirs(path.join(t1, 'backups')).sort(numericDesc);
  for (const name of backups.slice(policy.backupKeep)) {
    maybeAction(actions, path.join(t1, 'backups', name), `older than retained backup set (${policy.backupKeep})`);
  }

  const ttlMs = policy.orphanTtlDays * 24 * 60 * 60 * 1000;
  for (const rel of [path.join('runs', '.once'), '.once']) {
    const root = path.join(t1, rel);
    for (const name of [...listDirs(root), ...listFiles(root)]) {
      const target = path.join(root, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale one-time marker older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  for (const rel of ['.codegraph-build-lock', '.opencode-heal-lock']) {
    const target = path.join(t1, rel);
    if (fs.existsSync(target) && (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs))) {
      maybeAction(actions, target, `stale lock older than ${policy.orphanTtlDays} days`);
    }
  }

  const debugRoot = path.join(t1, 'debug');
  for (const name of listFiles(debugRoot)) {
    const target = path.join(debugRoot, name);
    if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
      maybeAction(actions, target, `stale debug log older than ${policy.orphanTtlDays} days`);
    }
  }

  // Per-run diagnostic captures (claim-capture.jsonl, plan-guard-deny.jsonl)
  // live under runs/<id>/debug/ and were previously reclaimed only when the
  // whole run dir aged out of the keep set — RETAINED runs kept them forever.
  for (const id of listDirs(path.join(t1, 'runs'))) {
    if (id === '.once') continue;
    const runDebug = path.join(t1, 'runs', id, 'debug');
    for (const name of listFiles(runDebug)) {
      const target = path.join(runDebug, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale run debug log older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  for (const rel of [path.join('reports', 'lighthouse'), 'logs']) {
    const root = path.join(t1, rel);
    for (const name of [...listDirs(root), ...listFiles(root)]) {
      const target = path.join(root, name);
      if (ttlMs === 0 || isOlderThan(target, ttlMs, nowMs)) {
        maybeAction(actions, target, `stale ${rel} artefact older than ${policy.orphanTtlDays} days`);
      }
    }
  }

  // Lighthouse reports carry a timestamp in their filename, so no run ever
  // supersedes the previous one and a TTL-only sweep keeps every copy inside the
  // window. Observed 9co: 10 HTML+JSON pairs, 13.6 MB, one run — while the actual
  // evidence artefact is an 863-byte `lighthouse-evidence-v1.json` in the QA dir.
  // Keep the newest few per route; the rest are superseded duplicates.
  const lighthouseRoot = path.join(t1, 'reports', 'lighthouse');
  // Reports are written run-scoped (`reports/lighthouse/<runId>/…`); pre-1.0.40
  // artefacts sit flat in the root, so both layouts are swept.
  for (const dir of ['', ...listDirs(lighthouseRoot)]) {
    const root = dir ? path.join(lighthouseRoot, dir) : lighthouseRoot;
    const byRoute = new Map<string, string[]>();
    for (const name of listFiles(root)) {
      if (actions.some((action) => action.path === path.join(root, name))) continue;
      // `<route>[-<buildTag>]-<ISO timestamp>.report.{json,html}` — group on the
      // route+build prefix, so a new build never supersedes another build's file.
      const match = /^(.*?)-\d{4}-\d{2}-\d{2}T[\d-]+Z\.report\.(?:json|html)$/.exec(name);
      if (!match) continue;
      const bucket = byRoute.get(match[1]!) || [];
      bucket.push(name);
      byRoute.set(match[1]!, bucket);
    }
    for (const [, names] of byRoute) {
      // Two files per run (json + html), so keeping 2 runs means 4 files.
      for (const name of names.sort().reverse().slice(policy.lighthouseKeepPerRoute * 2)) {
        maybeAction(
          actions,
          path.join(root, name),
          `superseded Lighthouse report (keeping ${policy.lighthouseKeepPerRoute} per route)`,
        );
      }
    }
  }

  for (const nested of listNestedTrafficOneDirs(cwd)) {
    maybeAction(actions, nested, 'leaked nested Traffic One state root inside ancestor workspace');
  }

  return { keep, live, actions };
}

export function sweepTrafficOneRetention(cwd: string, opts: { dryRun?: boolean; nowMs?: number; protectRunIds?: readonly string[] } = {}): RetentionResult {
  const dryRun = opts.dryRun !== false;
  const policy = readPolicy(cwd);
  const { keep, live, actions } = collectActions(cwd, policy, opts.nowMs ?? Date.now(), opts.protectRunIds ?? []);
  let removed = 0;
  if (!dryRun) {
    for (const action of actions) {
      try {
        if (removePath(action.path)) removed += 1;
      } catch {
        // best-effort; never abort cleanup because one path is busy
      }
    }
  }
  return {
    cwd,
    dryRun,
    policy,
    keepRunIds: [...keep].sort(numericDesc),
    liveRunIds: [...live].sort(numericDesc),
    actions,
    removed,
  };
}

// Post-settlement trigger: reclaim superseded artefacts the moment a run reaches
// a terminal ledger state instead of waiting for the next SessionStart (observed
// 12co: 113 run files + 9.5 MB of reports sat untouched until a later session
// swept). Runs strictly AFTER the terminal ledger write. The settled run id is
// protected EXPLICITLY: `currentRunId` alone is not enough — the deny remedies
// legitimately settle OLDER runs (blocked/failed cleanup), and an adversarial
// review proved the keep-window could reclaim the very ledger such a settle
// wrote milliseconds earlier.
export function sweepAfterTerminalSettlement(cwd: string, settledRunId?: string): void {
  try {
    sweepTrafficOneRetention(cwd, {
      dryRun: false,
      ...(settledRunId ? { protectRunIds: [settledRunId] } : {}),
    });
  } catch {
    // best-effort: settlement must never fail because cleanup did
  }
}

// Enforce the backup cap at WRITE time. The full sweep only runs at SessionStart,
// so a session that re-bootstraps the code graph N times accumulates N snapshots
// (measured: 9 in 18 minutes under `backupKeep: 3`, all byte-identical). `keepName`
// is the snapshot the caller may still restore from — never a candidate — and at
// least one snapshot always survives even when the policy asks for zero.
export function pruneTrafficOneBackups(cwd: string, keepName?: string): number {
  const root = path.join(cwd, '.traffic-one', 'backups');
  const keep = Math.max(1, readPolicy(cwd).backupKeep);
  let removed = 0;
  for (const name of listDirs(root).sort(numericDesc).slice(keep)) {
    if (keepName && name === keepName) continue;
    try {
      if (removePath(path.join(root, name))) removed += 1;
    } catch {
      // best-effort; never abort a bootstrap because one path is busy
    }
  }
  return removed;
}
