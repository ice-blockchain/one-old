// src/shared/state/local-prefs/project-root-sidecar.ts
// Sibling `root` next to preferences.json: the project's realpath so uninstall
// can later find onboarded projects. Not a pref-schema key — effective state
// does not grow a path field.

import * as fs from 'fs';
import * as path from 'path';

import { readRegularFile } from '../../bounded-read';

// Same realpath rule as projectRootHash in prefs-store.ts.
export function resolvedProjectRoot(cwd: string): string {
  try {
    return fs.realpathSync(path.resolve(cwd));
  } catch {
    return path.resolve(cwd);
  }
}

export function projectRootSidecarPath(prefsPath: string): string {
  return path.join(path.dirname(prefsPath), 'root');
}

// Leaf writer: no prefs-store import. prefs-store calls this after a successful
// write so the modules do not cycle through writeProjectRootSidecar.
export function writeProjectRootSidecarAt(prefsPath: string, cwd: string): void {
  try {
    if (!cwd) return;
    const sidecarPath = projectRootSidecarPath(prefsPath);
    const parent = path.dirname(sidecarPath);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(parent, 0o700); } catch { /* best-effort */ }
    fs.writeFileSync(sidecarPath, `${resolvedProjectRoot(cwd)}\n`, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(sidecarPath, 0o600); } catch { /* best-effort */ }
  } catch {
    // Best-effort: never throw to the caller.
  }
}

export function readProjectRootSidecar(prefsDirOrSidecarPath: string): string | null {
  try {
    const sidecarPath = path.basename(prefsDirOrSidecarPath) === 'root'
      ? prefsDirOrSidecarPath
      : path.join(prefsDirOrSidecarPath, 'root');
    const text = readRegularFile(sidecarPath);
    if (text === null) return null;
    const trimmed = text.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}
