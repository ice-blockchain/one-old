// src/shared/managed-runtime.ts
// Last-resort language-runtime provider shared by every toolchain runner. When
// the GUI-PATH-proof resolver (runtime-resolve.ts) AND the per-tool managers
// (nvm/pyenv/pipx/PATH/Homebrew) all fail to surface a satisfying Python/Node,
// this downloads a SELF-CONTAINED interpreter from the official distribution
// into ~/.traffic-one/toolchains/_runtimes/<kind>/<version>/ and hands back an
// absolute binary path.
//
// Why this is safe (the whole reason we do NOT auto-run `brew install`):
//   - the runtime lands in a Traffic One-managed dir, NEVER on PATH, NEVER the
//     system python3/node, NEVER the user's pyenv/nvm default → a machine with
//     projects pinned to older Python/Node is completely unaffected;
//   - it is verified against the publisher's own checksum file before use;
//   - it NEVER throws and NEVER blocks: any failure (offline, unsupported
//     platform, bad download, binary won't run) returns {ok:false,
//     action:'skipped'} so the caller keeps its existing install-skipped/defer
//     path. The code-graph providers are a token optimization, never a gate.
//
// Tranche 1: darwin + linux × x64 + arm64 (see src/config/managed-runtimes.ts).
//
// SYNC by design: the toolchain runners are deeply synchronous (spawnSync
// everywhere), so the network download runs in a spawnSync'd child `node` — the
// parent blocks, no async ripples through ensure*Tool/bootstrap/main.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { runtimeAsset, type RuntimeAsset, type RuntimeKind } from '../config/managed-runtimes';
import { managedRuntimeDir } from './toolchain-paths';

export type { RuntimeKind } from '../config/managed-runtimes';

export interface ManagedRuntimeResult {
  ok: boolean;
  path: string | null;    // absolute interpreter binary (…/bin/python3 | …/bin/node)
  binDir: string | null;  // its bin dir → callers find npm/pip alongside
  version: string | null;
  action: 'used-managed' | 'downloaded' | 'skipped';
  error: string | null;
}

const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const CHECKSUM_TIMEOUT_MS = 60 * 1000;

// Kill-switch. Disabled when EITHER the dedicated managed-runtime switch OR the
// shared runtime-probe switch is set: a user/CI that forbids out-of-PATH probing
// definitely does not want a 50-200MB download, and the test suite sets the
// former (src/build/test-preload.mjs) so `npm test` never hits the network.
function downloadDisabled(): boolean {
  return process.env.TRAFFIC_ONE_MANAGED_RUNTIME_OFF === '1'
    || process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF === '1';
}

function binName(kind: RuntimeKind): string {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return (kind === 'node' ? 'node' : 'python3') + ext;
}

// Probe the just-extracted (or cached) interpreter: confirm it RUNS and meets the
// minimum. Catches a broken extract / arch mismatch / unsigned-binary block. Pure
// read; returns the version string or null.
function probeManagedVersion(
  binPath: string,
  kind: RuntimeKind,
  minMajor: number,
  minMinor: number,
): string | null {
  if (!fs.existsSync(binPath)) return null;
  const args = kind === 'node'
    ? ['--version']
    : ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])'];
  let result;
  try {
    result = spawnSync(binPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 1000 });
  } catch {
    return null;
  }
  if (result.status !== 0) return null;
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec((result.stdout || '').trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const meets = major > minMajor || (major === minMajor && minor >= minMinor);
  return meets ? `${major}.${minor}.${m[3]}` : null;
}

// Parse the publisher's checksum file → the expected lower-case sha256 hex.
//   shasums-list : Node's SHASUMS256.txt — "<hash>  <archiveName>" per line.
//   sidecar-hex  : python-build-standalone's <asset>.sha256 — bare 64-hex.
export function parseChecksum(
  style: RuntimeAsset['checksumStyle'],
  raw: string,
  archiveName: string,
): string | null {
  if (style === 'sidecar-hex') {
    const m = /[a-fA-F0-9]{64}/.exec(raw || '');
    return m ? m[0].toLowerCase() : null;
  }
  for (const line of (raw || '').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1] === archiveName && /^[a-fA-F0-9]{64}$/.test(parts[0] as string)) {
      return (parts[0] as string).toLowerCase();
    }
  }
  return null;
}

// Inline downloader run in a child `node` (keeps the parent synchronous, stays
// dependency-free — only Node built-ins). Streams URL→file, follows redirects
// (GitHub release assets 302 to a CDN), and verifies sha256 when T1_SHA is set.
// Args ride env vars (argv shape under `-e` is ambiguous).
const DOWNLOADER_SRC = `
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const url = process.env.T1_URL, dest = process.env.T1_DEST, expected = (process.env.T1_SHA || '').toLowerCase();
function get(u, n, cb) {
  if (n > 10) { cb(new Error('too many redirects')); return; }
  https.get(u, { headers: { 'user-agent': 'traffic-one' } }, function (res) {
    const s = res.statusCode || 0;
    if (s >= 300 && s < 400 && res.headers.location) { res.resume(); get(res.headers.location, n + 1, cb); return; }
    if (s !== 200) { res.resume(); cb(new Error('HTTP ' + s)); return; }
    cb(null, res);
  }).on('error', cb);
}
get(url, 0, function (err, res) {
  if (err) { console.error(err.message); process.exit(2); }
  const h = crypto.createHash('sha256');
  const out = fs.createWriteStream(dest);
  res.on('data', function (d) { h.update(d); });
  res.pipe(out);
  out.on('finish', function () {
    const got = h.digest('hex');
    if (expected && got !== expected) { console.error('checksum mismatch'); process.exit(3); }
    process.exit(0);
  });
  out.on('error', function (e) { console.error(e.message); process.exit(4); });
});
`;

function childDownload(url: string, dest: string, expectedSha: string, timeoutMs: number): { ok: boolean; error: string | null } {
  let result;
  try {
    result = spawnSync(process.execPath, ['-e', DOWNLOADER_SRC], {
      env: { ...process.env, T1_URL: url, T1_DEST: dest, T1_SHA: expectedSha },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'download spawn failed' };
  }
  if (result.status === 0) return { ok: true, error: null };
  return { ok: false, error: (result.stderr || '').trim() || `download exited ${result.status ?? 'null'}` };
}

// Download → verify → extract → atomic place. Throws on no error (returns a
// {ok,error} record); the caller wraps it. All temp work happens UNDER the
// toolchain root so the final rename is same-filesystem (no EXDEV).
function downloadAndExtract(asset: RuntimeAsset, finalDir: string): { ok: boolean; error: string | null } {
  const tmpRoot = `${finalDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });

    // 1. checksum file (small, fast) → expected hash.
    const sumsFile = path.join(tmpRoot, 'sums');
    const sums = childDownload(asset.checksumUrl, sumsFile, '', CHECKSUM_TIMEOUT_MS);
    if (!sums.ok) return { ok: false, error: `checksum fetch failed: ${sums.error}` };
    const expected = parseChecksum(asset.checksumStyle, fs.readFileSync(sumsFile, 'utf8'), asset.archiveName);
    if (!expected) return { ok: false, error: 'could not resolve checksum for the asset' };

    // 2. tarball, verified against the expected hash.
    const tarball = path.join(tmpRoot, asset.archiveName);
    const dl = childDownload(asset.url, tarball, expected, DOWNLOAD_TIMEOUT_MS);
    if (!dl.ok) return { ok: false, error: `download failed: ${dl.error}` };

    // 3. extract via system tar (present on macOS/Linux; same family the other
    //    runners shell out to).
    const extractTmp = path.join(tmpRoot, 'x');
    fs.mkdirSync(extractTmp, { recursive: true });
    const untar = spawnSync('tar', ['-xzf', tarball, '-C', extractTmp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: DOWNLOAD_TIMEOUT_MS });
    if (untar.status !== 0) return { ok: false, error: `tar extract failed: ${(untar.stderr || '').trim() || 'non-zero exit'}` };
    if (!fs.existsSync(path.join(extractTmp, asset.binSubdir))) {
      return { ok: false, error: `extracted archive has no ${asset.binSubdir}` };
    }

    // 4. best-effort: strip macOS quarantine (programmatic downloads usually
    //    aren't tagged, but a belt-and-braces clear avoids a Gatekeeper prompt).
    if (process.platform === 'darwin') {
      spawnSync('xattr', ['-dr', 'com.apple.quarantine', extractTmp], { stdio: 'ignore', timeout: 30 * 1000 });
    }

    // 5. atomic place: replace any partial finalDir, then rename the verified tree in.
    try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch { /* fresh */ }
    fs.mkdirSync(path.dirname(finalDir), { recursive: true });
    fs.renameSync(extractTmp, finalDir);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'install error' };
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// True when a managed runtime for `kind` could be provided NOW — already cached,
// or the platform/arch is in tranche 1 (a download could work). Network-free and
// cheap; used by the sibling-fallback gate so it only attempts a provider whose
// runtime is reachable. Returns false whenever downloads are disabled.
export function managedRuntimeAvailable(kind: RuntimeKind): boolean {
  if (downloadDisabled()) return false;
  // A published asset for this platform/arch means a runtime is reachable —
  // already cached, or a fresh download can provide it.
  return runtimeAsset(kind, process.platform, process.arch) !== null;
}

// Ensure a managed `kind` runtime satisfying >= minMajor.minMinor exists; return
// its absolute interpreter path. Reuses a cached runtime; otherwise downloads.
// NEVER throws.
export function ensureManagedRuntime(
  kind: RuntimeKind,
  opts: { minMajor: number; minMinor?: number },
): ManagedRuntimeResult {
  const minMajor = opts.minMajor;
  const minMinor = opts.minMinor ?? 0;
  const skip = (error: string): ManagedRuntimeResult => ({ ok: false, path: null, binDir: null, version: null, action: 'skipped', error });

  if (downloadDisabled()) return skip('managed runtime download disabled (TRAFFIC_ONE_MANAGED_RUNTIME_OFF / TRAFFIC_ONE_RUNTIME_PROBE_OFF)');

  const sel = runtimeAsset(kind, process.platform, process.arch);
  if (!sel) return skip(`no managed ${kind} runtime is published for ${process.platform}/${process.arch}`);

  const dir = managedRuntimeDir(kind, sel.version);
  const binPath = path.join(dir, sel.asset.binSubdir, binName(kind));

  // Cached and usable?
  const cachedV = probeManagedVersion(binPath, kind, minMajor, minMinor);
  if (cachedV) return { ok: true, path: binPath, binDir: path.dirname(binPath), version: cachedV, action: 'used-managed', error: null };

  // Download + verify + extract.
  const placed = downloadAndExtract(sel.asset, dir);
  if (!placed.ok) return skip(`managed ${kind} ${sel.version} install failed: ${placed.error}`);

  const version = probeManagedVersion(binPath, kind, minMajor, minMinor);
  if (!version) return skip(`managed ${kind} ${sel.version} installed but did not run or meet >=${minMajor}.${minMinor}`);
  return { ok: true, path: binPath, binDir: path.dirname(binPath), version, action: 'downloaded', error: null };
}
