// src/config/managed-runtimes.ts
// Pins + asset matrix for Traffic One's managed standalone-runtime fetcher
// (src/shared/managed-runtime.ts). When no satisfying Python/Node is found on the
// machine, the fetcher downloads a self-contained interpreter from the official
// distribution into ~/.traffic-one/toolchains/_runtimes/<kind>/<version>/ —
// isolated, never global, never on PATH, never touching the user's other projects.
//
// Bump a pin here when a newer runtime is desired; the fetcher verifies every
// download against the PUBLISHER'S OWN checksum file (Node's SHASUMS256.txt list,
// python-build-standalone's per-asset .sha256 sidecar), so no hash ever needs to
// live in (and rot in) source.
//
// Tranche 1 covers darwin + linux × x64 + arm64. Other platforms (Windows,
// musl, exotic arches) return null → the caller degrades to its existing
// install-skipped/defer path. The asset builders are PURE so they unit-test
// without touching the network.

export type RuntimeKind = 'python' | 'node';

export interface NodePin { version: string; }
export interface PythonPin { version: string; releaseTag: string; }

// Node: official LTS line satisfying gitnexus' Node >=22 (and opencode's >=18).
export const NODE_PIN: NodePin = { version: '22.11.0' };

// Python: python-build-standalone (astral-sh) "install_only" build, >=3.10 for
// graphify. Needs BOTH the CPython version and the PBS release date tag.
export const PYTHON_PIN: PythonPin = { version: '3.12.7', releaseTag: '20241016' };

export interface RuntimeAsset {
  url: string;                                   // archive URL
  archiveName: string;                           // basename (matched in a SHASUMS list)
  checksumUrl: string;                           // publisher's checksum file
  checksumStyle: 'shasums-list' | 'sidecar-hex'; // how to read the checksum file
  format: 'tar.gz' | 'zip';                      // archive container → extractor selection
  binSubdir: string;                             // bin dir relative to the extraction root
}

// Node platform tokens. Windows ships .zip (handled below); win-arm64 exists from
// Node 20+. macOS/Linux ship .tar.gz.
const NODE_PLATFORM: Record<string, string> = { darwin: 'darwin', linux: 'linux', win32: 'win' };
const NODE_ARCH: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
// python-build-standalone target triples. NOTE: there is NO aarch64-pc-windows-msvc
// install_only build, so win32:arm64 is intentionally absent → graceful skip on
// Windows-ARM (it can run the x64 build under emulation, but we don't auto-map it).
const PY_TRIPLE: Record<string, string> = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'win32:x64': 'x86_64-pc-windows-msvc',
};

export function nodeAsset(pin: NodePin, platform: string, arch: string): RuntimeAsset | null {
  const plat = NODE_PLATFORM[platform];
  const a = NODE_ARCH[arch];
  if (!plat || !a) return null;
  const stem = `node-v${pin.version}-${plat}-${a}`;
  // Windows: .zip with node.exe + npm.cmd at the stem ROOT (no bin/ subdir).
  // macOS/Linux: .tar.gz with the binaries under <stem>/bin.
  const isWin = platform === 'win32';
  const ext = isWin ? 'zip' : 'tar.gz';
  return {
    url: `https://nodejs.org/dist/v${pin.version}/${stem}.${ext}`,
    archiveName: `${stem}.${ext}`,
    checksumUrl: `https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt`,
    checksumStyle: 'shasums-list',
    format: isWin ? 'zip' : 'tar.gz',
    binSubdir: isWin ? stem : `${stem}/bin`,
  };
}

export function pythonAsset(pin: PythonPin, platform: string, arch: string): RuntimeAsset | null {
  const triple = PY_TRIPLE[`${platform}:${arch}`];
  if (!triple) return null;
  const archiveName = `cpython-${pin.version}+${pin.releaseTag}-${triple}-install_only.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${pin.releaseTag}/${archiveName}`;
  // install_only extracts to ./python/. On Windows python.exe sits at python/ ROOT
  // (no bin/, no python3 alias); on macOS/Linux the interpreter is python/bin/python3.
  // The archive is .tar.gz on EVERY OS (unlike Node), so the tar extractor covers it.
  return {
    url,
    archiveName,
    checksumUrl: `${url}.sha256`,
    checksumStyle: 'sidecar-hex',
    format: 'tar.gz',
    binSubdir: platform === 'win32' ? 'python' : 'python/bin',
  };
}

// The pinned asset for a runtime on the given platform/arch, plus the resolved
// version string. Returns null when the platform/arch is outside tranche 1.
export function runtimeAsset(
  kind: RuntimeKind,
  platform: string,
  arch: string,
): { asset: RuntimeAsset; version: string } | null {
  if (kind === 'node') {
    const asset = nodeAsset(NODE_PIN, platform, arch);
    return asset ? { asset, version: NODE_PIN.version } : null;
  }
  const asset = pythonAsset(PYTHON_PIN, platform, arch);
  return asset ? { asset, version: PYTHON_PIN.version } : null;
}
