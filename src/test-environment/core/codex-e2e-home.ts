// Isolated CODEX_HOME for live release E2E.
//
// Codex currently applies profile-v2 to model-visible plugin metadata, but a
// plugin enabled only through that layer may not contribute runtime hooks to
// `codex exec`. A disposable base home avoids that host limitation: only the
// content-addressed staged plugin is installed in its base config, while auth
// is copied with 0600 permissions and removed after the run.

import * as fs from 'fs';
import * as path from 'path';

import type { CodexMarketplaceStage } from './current-dist';

const HOME_MARKER_NAME = '.traffic-one-e2e-home.json';
const SAFE_HOME_NAME = /^\.codex-home-traffic-one-e2e-[a-f0-9]{16}-[A-Za-z0-9]+$/;

interface CodexE2EHomeMarker {
  version: 1;
  kind: 'traffic-one-codex-e2e-home';
  home: string;
  parent: string;
  marketplaceName: string;
  pluginSelector: string;
  sourceFingerprint: string;
}

export interface CodexE2EHome {
  path: string;
  parent: string;
  name: string;
  markerPath: string;
  markerBytes: Buffer;
  marketplaceName: string;
}

export interface CodexE2EHomeCheck {
  ok: boolean;
  detail: string;
}

function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeExclusive(file: string, bytes: Buffer, mode: number): void {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(file); } catch { /* best effort */ }
    throw error;
  }
  fs.closeSync(fd);
  fs.chmodSync(file, mode);
}

function readRegular0600(file: string, label: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${label} is accessible outside its owner: ${file}`);
  }
  return fs.readFileSync(file);
}

export function createCodexE2EHome(
  ambientCodexHome: string,
  stagesRoot: string,
  marketplace: CodexMarketplaceStage,
): CodexE2EHome {
  const sourceHome = path.resolve(ambientCodexHome);
  const parent = path.resolve(stagesRoot);
  const name = `.codex-home-${marketplace.name}`;
  if (!SAFE_HOME_NAME.test(name)) {
    throw new Error(`unsafe Codex E2E home name ${JSON.stringify(name)}`);
  }
  const home = path.join(parent, name);
  if (path.dirname(home) !== parent || fs.existsSync(home)) {
    throw new Error(`Codex E2E home is not a fresh direct child: ${home}`);
  }

  const authBytes = readRegular0600(path.join(sourceHome, 'auth.json'), 'Codex auth source');
  fs.mkdirSync(parent, { recursive: true });
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);

  try {
    writeExclusive(path.join(home, 'auth.json'), authBytes, 0o600);
    writeExclusive(
      path.join(home, 'config.toml'),
      Buffer.from('[analytics]\nenabled = false\n', 'utf8'),
      0o600,
    );
    const marker: CodexE2EHomeMarker = {
      version: 1,
      kind: 'traffic-one-codex-e2e-home',
      home,
      parent,
      marketplaceName: marketplace.name,
      pluginSelector: marketplace.pluginSelector,
      sourceFingerprint: marketplace.sourceFingerprint,
    };
    const markerBytes = canonicalJson(marker);
    const markerPath = path.join(home, HOME_MARKER_NAME);
    writeExclusive(markerPath, markerBytes, 0o600);
    return {
      path: home,
      parent,
      name,
      markerPath,
      markerBytes,
      marketplaceName: marketplace.name,
    };
  } catch (error) {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    throw error;
  }
}

function validateCodexE2EHome(home: CodexE2EHome): string | null {
  const resolved = path.resolve(home.path);
  const parent = path.resolve(home.parent);
  if (
    !SAFE_HOME_NAME.test(home.name)
    || path.basename(resolved) !== home.name
    || path.dirname(resolved) !== parent
  ) {
    return `home path/name mismatch: ${resolved} (${home.name})`;
  }
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    return `home is unavailable: ${resolved}: ${String(error)}`;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return `home is not a real directory: ${resolved}`;
  if ((stat.mode & 0o777) !== 0o700) return `home mode changed from 0700: ${resolved}`;
  if (path.resolve(home.markerPath) !== path.join(resolved, HOME_MARKER_NAME)) {
    return `home marker escaped its directory: ${home.markerPath}`;
  }
  let marker: Buffer;
  try {
    marker = fs.readFileSync(home.markerPath);
  } catch (error) {
    return `home marker is unavailable: ${home.markerPath}: ${String(error)}`;
  }
  if (!marker.equals(home.markerBytes)) return `home marker contents changed: ${home.markerPath}`;
  return null;
}

export function cleanupCodexE2EHome(home: CodexE2EHome): CodexE2EHomeCheck {
  const unsafe = validateCodexE2EHome(home);
  if (unsafe) return { ok: false, detail: unsafe };
  try {
    fs.rmSync(home.path, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, detail: `could not remove isolated Codex home ${home.path}: ${String(error)}` };
  }
  return { ok: true, detail: `removed isolated Codex home ${home.path}` };
}
