// src/shared/runtime-resolve.ts
// GUI-PATH-proof language-runtime resolution shared by every toolchain runner.
//
// Why this exists: a host launched from Finder (Claude Desktop / Cursor.app)
// inherits the minimal launchd PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), where
// `python3` is the stock CLT 3.9.x and Homebrew's `/opt/homebrew/bin` is absent.
// graphifyy 0.7.10 wheels set `Requires-Python >=3.10`, so a venv built on 3.9.x
// yields "No matching distribution" — even with a modern pip. The same class of
// bug hit GitNexus (needs Node 22, but a stale PATH resolves an older nvm node).
//
// So we never trust `which` alone: we probe ABSOLUTE candidate locations
// (Homebrew, nvm, pyenv) plus PATH, run each candidate to read its real version,
// and return the first that satisfies the tool's declared minimum. Mirrors the
// nvm-glob approach already used by src/runners/gitnexus/nvm.ts.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { exec } from './exec';

const which = exec.which;
const PROBE_TIMEOUT_MS = 5 * 1000;

export interface ResolvedRuntime {
  path: string;
  version: string;
  major: number;
  minor: number;
}

function exists(p: string): boolean {
  try { return Boolean(p) && fs.existsSync(p); } catch { return false; }
}

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || '';
}

function meetsMin(major: number, minor: number, minMajor: number, minMinor: number): boolean {
  if (major > minMajor) return true;
  if (major < minMajor) return false;
  return minor >= minMinor;
}

// ── Python ──────────────────────────────────────────────────────────────────

function probePython(py: string): { major: number; minor: number } | null {
  if (!exists(py) && !path.isAbsolute(py)) {
    const resolved = which(py);
    if (!resolved) return null;
    py = resolved;
  }
  if (!exists(py)) return null;
  let result;
  try {
    result = spawnSync(py, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS,
    });
  } catch { return null; }
  if (result.status !== 0) return null;
  const m = /^(\d+)\.(\d+)/m.exec((result.stdout || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// Ordered absolute (or PATH-resolvable) python candidates, newest first. Explicit
// minor names (python3.13 … python3.10) come before the generic `python3` so a
// satisfying modern interpreter is preferred over the stock 3.9.x even when the
// generic name resolves first on PATH.
function pythonCandidates(minMajor: number, minMinor: number): string[] {
  if (process.platform === 'win32') return windowsPythonCandidates(minMajor, minMinor);
  const out: string[] = [];
  const dirs = ['/opt/homebrew/bin', '/usr/local/bin', path.join(home(), '.pyenv', 'shims')];
  // Probe minors from a high ceiling down to the required minimum.
  for (let minor = 13; minor >= minMinor; minor -= 1) {
    const name = `python${minMajor}.${minor}`;
    const onPath = which(name);
    if (onPath) out.push(onPath);
    for (const d of dirs) out.push(path.join(d, name));
  }
  // pyenv installed versions: ~/.pyenv/versions/<X.Y.Z>/bin/python3 (newest first).
  const pyenvVersions = path.join(home(), '.pyenv', 'versions');
  try {
    const entries = fs.readdirSync(pyenvVersions)
      .filter((v) => /^\d+\.\d+\.\d+/.test(v))
      .sort((a, b) => {
        const pa = a.split('.').map(Number);
        const pb = b.split('.').map(Number);
        for (let i = 0; i < 3; i += 1) { if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0); }
        return 0;
      });
    for (const v of entries) out.push(path.join(pyenvVersions, v, 'bin', 'python3'));
  } catch { /* no pyenv */ }
  // Generic names last (may be the stock 3.9.x — only used if it satisfies min).
  const generic = which('python3') || '';
  if (generic) out.push(generic);
  for (const d of dirs) out.push(path.join(d, 'python3'));
  out.push('/usr/bin/python3');
  const py = which('python');
  if (py) out.push(py);
  // Dedup, preserve order.
  return [...new Set(out)].filter(Boolean);
}

// Kill-switch: force "no runtime found" (returns null from both resolvers).
// A power-user/CI can set it to forbid auto-discovery of out-of-PATH runtimes;
// tests use it to exercise the graceful "nothing available → defer" branch
// hermetically (a machine with Homebrew Node/Python would otherwise resolve one).
function probeDisabled(): boolean {
  return process.env.TRAFFIC_ONE_RUNTIME_PROBE_OFF === '1';
}

// ── Windows interpreter discovery ─────────────────────────────────────────────
// Windows has no /opt/homebrew or python3.X aliases; the canonical entrypoints are
// the `py` launcher and per-user/all-users `python.exe` installs. These mirror the
// POSIX candidate logic but with Windows paths/names, guarded by process.platform.

function windowsPythonCandidates(minMajor: number, minMinor: number): string[] {
  const out: string[] = [];
  const localApp = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
  const progFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[];
  // Per-minor installs, newest first: PythonXY\python.exe (e.g. Python313).
  for (let minor = 13; minor >= minMinor; minor -= 1) {
    const tag = `Python${minMajor}${minor}`;
    out.push(path.join(localApp, 'Programs', 'Python', tag, 'python.exe'));
    for (const pf of progFiles) out.push(path.join(pf, tag, 'python.exe'));
  }
  // Generic on PATH (Windows registers python.exe, not python3).
  const onPath = which('python');
  if (onPath) out.push(onPath);
  // Microsoft Store shim LAST. When Python isn't installed this is an app-installer
  // stub; invoked WITH args (as probePython does) it returns a fast non-zero exit
  // (9009) rather than hanging, so it's harmless — ranked last only to prefer a
  // real install / `py`.
  out.push(path.join(localApp, 'Microsoft', 'WindowsApps', 'python.exe'));
  return [...new Set(out)].filter(Boolean);
}

// The Windows `py` launcher (`py -<major>`) reads the registry and selects the
// newest installed interpreter — the single most reliable Windows discovery
// mechanism. We ask it for the concrete python.exe path (callers need a real
// interpreter to run `python -m venv`, not the launcher itself).
function resolveWindowsPyLauncher(minMajor: number, minMinor: number): ResolvedRuntime | null {
  const launcher = which('py');
  if (!launcher) return null;
  let result;
  try {
    result = spawnSync(launcher, [`-${minMajor}`, '-c', 'import sys;print("%d %d %s" % (sys.version_info[0], sys.version_info[1], sys.executable))'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS,
    });
  } catch { return null; }
  if (result.status !== 0) return null;
  const m = /^(\d+)\s+(\d+)\s+(.+)$/m.exec((result.stdout || '').trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const exe = (m[3] || '').trim();
  if (!exe || !exists(exe) || !meetsMin(major, minor, minMajor, minMinor)) return null;
  return { path: exe, version: `${major}.${minor}`, major, minor };
}

// Resolve a Python interpreter satisfying >= minMajor.minMinor. Absolute-path
// preferred so a stale GUI PATH can't force the stock CLT interpreter.
export function resolvePython(minMajor: number, minMinor: number): ResolvedRuntime | null {
  if (probeDisabled()) return null;
  if (process.platform === 'win32') {
    const viaLauncher = resolveWindowsPyLauncher(minMajor, minMinor);
    if (viaLauncher) return viaLauncher;
  }
  for (const candidate of pythonCandidates(minMajor, minMinor)) {
    const v = probePython(candidate);
    if (v && meetsMin(v.major, v.minor, minMajor, minMinor)) {
      return { path: candidate, version: `${v.major}.${v.minor}`, major: v.major, minor: v.minor };
    }
  }
  return null;
}

// ── Node ────────────────────────────────────────────────────────────────────

function probeNode(node: string): { major: number; minor: number } | null {
  if (!exists(node)) return null;
  let result;
  try {
    result = spawnSync(node, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS });
  } catch { return null; }
  if (result.status !== 0) return null;
  const m = /v?(\d+)\.(\d+)\.\d+/.exec((result.stdout || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]) };
}

// nvm-managed node bins with major >= minMajor, newest first (absolute paths).
function nvmNodes(minMajor: number): string[] {
  const root = path.join(home(), '.nvm', 'versions', 'node');
  let entries: string[] = [];
  try { entries = fs.readdirSync(root); } catch { return []; }
  return entries
    .map((name) => /^v(\d+)\.(\d+)\.(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => Boolean(m) && Number(m![1]) >= minMajor)
    .sort((a, b) => {
      for (let i = 1; i <= 3; i += 1) { if (Number(b[i]) !== Number(a[i])) return Number(b[i]) - Number(a[i]); }
      return 0;
    })
    .map((m) => path.join(root, m[0], 'bin', 'node'))
    .filter(exists);
}

// Glob a version-manager node store (fnm/volta/nvm-windows) for vX.Y.Z dirs with
// major>=min, newest first, mapping each to <dir>/<subdir>/node.exe (subdir '' →
// node.exe at the version-dir root, as nvm-windows/volta use).
function windowsNodeVersionStore(root: string, subdir: string, minMajor: number): string[] {
  let entries: string[] = [];
  try { entries = fs.readdirSync(root); } catch { return []; }
  return entries
    .map((name) => ({ name, m: /^v?(\d+)\.(\d+)\.(\d+)$/.exec(name) }))
    .filter((e): e is { name: string; m: RegExpExecArray } => Boolean(e.m) && Number(e.m![1]) >= minMajor)
    .sort((a, b) => { for (let i = 1; i <= 3; i += 1) { const d = Number(b.m[i]) - Number(a.m[i]); if (d) return d; } return 0; })
    .map((e) => path.join(root, e.name, subdir, 'node.exe'))
    .filter(exists);
}

function windowsNodeCandidates(minMajor: number): string[] {
  const out: string[] = [];
  const localApp = process.env.LOCALAPPDATA || path.join(home(), 'AppData', 'Local');
  const appData = process.env.APPDATA || path.join(home(), 'AppData', 'Roaming');
  // nvm-windows: %NVM_HOME% (or %APPDATA%\nvm)\v<X.Y.Z>\node.exe (node.exe at root).
  out.push(...windowsNodeVersionStore(process.env.NVM_HOME || path.join(appData, 'nvm'), '', minMajor));
  // fnm: %APPDATA%\fnm\node-versions\v<X.Y.Z>\installation\node.exe
  out.push(...windowsNodeVersionStore(path.join(appData, 'fnm', 'node-versions'), 'installation', minMajor));
  // volta: %LOCALAPPDATA%\Volta\tools\image\node\<X.Y.Z>\node.exe
  out.push(...windowsNodeVersionStore(path.join(localApp, 'Volta', 'tools', 'image', 'node'), '', minMajor));
  const onPath = which('node');
  if (onPath) out.push(onPath);
  for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean) as string[]) {
    out.push(path.join(pf, 'nodejs', 'node.exe'));
  }
  return [...new Set(out)].filter(Boolean);
}

function nodeCandidates(minMajor: number): string[] {
  if (process.platform === 'win32') return windowsNodeCandidates(minMajor);
  const out: string[] = [...nvmNodes(minMajor)];
  const onPath = which('node');
  if (onPath) out.push(onPath);
  out.push('/opt/homebrew/bin/node', '/usr/local/bin/node');
  return [...new Set(out)].filter(Boolean);
}

// Resolve a Node binary satisfying >= minMajor, nvm-first then PATH/Homebrew.
export function resolveNode(minMajor: number): ResolvedRuntime | null {
  if (probeDisabled()) return null;
  for (const candidate of nodeCandidates(minMajor)) {
    const v = probeNode(candidate);
    if (v && v.major >= minMajor) {
      return { path: candidate, version: `${v.major}.${v.minor}`, major: v.major, minor: v.minor };
    }
  }
  return null;
}

// The npm binary sitting next to a resolved node (same bin dir). Lets a runner
// install through the matching npm without trusting PATH order.
export function npmNextToNode(nodePath: string): string | null {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const npm = path.join(path.dirname(nodePath), `npm${ext}`);
  return exists(npm) ? npm : null;
}

// ── Shared message ────────────────────────────────────────────────────────────

// One beginner-friendly message all runners reuse when no satisfying runtime is
// found. The caller is responsible for degrading gracefully (fallback / defer) —
// this only explains, it never blocks.
export function runtimeMissingMessage(tool: string, runtime: 'python' | 'node', minMajor: number, minMinor = 0): string {
  const need = runtime === 'python' ? `Python >=${minMajor}.${minMinor}` : `Node >=${minMajor}`;
  let hint: string;
  if (process.platform === 'win32') {
    hint = runtime === 'python'
      ? 'Install Python from python.org or `winget install Python.Python.3.12` — Traffic One looks for the `py` launcher, per-user/all-users installs, and PATH.'
      : 'Install Node from nodejs.org or `winget install OpenJS.NodeJS` (or nvm-windows) — Traffic One looks for standard, nvm-windows, fnm and volta locations and PATH.';
  } else {
    hint = runtime === 'python'
      ? 'Install a newer Python (e.g. `brew install python@3.12`) — Traffic One looks for one on PATH and in Homebrew/pyenv locations.'
      : 'Install a newer Node (e.g. `nvm install 22` or `brew install node`) — Traffic One looks for one via nvm and Homebrew.';
  }
  return `${tool} needs ${need}, and none was found on this machine. ${hint}`;
}
