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
  url: string;                                   // tarball URL
  archiveName: string;                           // basename (matched in a SHASUMS list)
  checksumUrl: string;                           // publisher's checksum file
  checksumStyle: 'shasums-list' | 'sidecar-hex'; // how to read the checksum file
  binSubdir: string;                             // bin dir relative to the extraction root
}

const NODE_PLATFORM: Record<string, string> = { darwin: 'darwin', linux: 'linux' };
const NODE_ARCH: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
// python-build-standalone target triples.
const PY_TRIPLE: Record<string, string> = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
};

export function nodeAsset(pin: NodePin, platform: string, arch: string): RuntimeAsset | null {
  const plat = NODE_PLATFORM[platform];
  const a = NODE_ARCH[arch];
  if (!plat || !a) return null;
  const stem = `node-v${pin.version}-${plat}-${a}`;
  return {
    url: `https://nodejs.org/dist/v${pin.version}/${stem}.tar.gz`,
    archiveName: `${stem}.tar.gz`,
    checksumUrl: `https://nodejs.org/dist/v${pin.version}/SHASUMS256.txt`,
    checksumStyle: 'shasums-list',
    binSubdir: `${stem}/bin`, // tarball top dir is the stem; npm/npx ship inside bin/
  };
}

export function pythonAsset(pin: PythonPin, platform: string, arch: string): RuntimeAsset | null {
  const triple = PY_TRIPLE[`${platform}:${arch}`];
  if (!triple) return null;
  const archiveName = `cpython-${pin.version}+${pin.releaseTag}-${triple}-install_only.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${pin.releaseTag}/${archiveName}`;
  return {
    url,
    archiveName,
    checksumUrl: `${url}.sha256`,
    checksumStyle: 'sidecar-hex',
    binSubdir: 'python/bin', // install_only archives extract to ./python/
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
