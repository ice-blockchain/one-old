// src/shared/state/local-prefs/recorded-project-roots.ts
// Uninstall's project census: walk globalTrafficOneDir/projects/<hash>/ and,
// when XDG_STATE_HOME redirects, also leftover ~/.traffic-one/projects/, then
// read the sibling `root` sidecar. Deduplicates by realpath of the project
// root. Kept out of project-root-sidecar.ts so that leaf stays free of
// prefs-store, and out of prefs-store so listing does not sit on the write path.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { projectRootHash } from './prefs-store';
import { readProjectRootSidecar } from './project-root-sidecar';
import { globalTrafficOneDir } from '../traffic-one-paths';

export type RecordedProjectRootStatus =
  | 'ok'
  | 'missing-root'
  | 'hash-mismatch'
  | 'not-a-directory';

export interface RecordedProjectRoot {
  hash: string;
  root: string | null;
  status: RecordedProjectRootStatus;
}

export function realResolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

export function resolvedHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return realResolve(env.HOME || env.USERPROFILE || os.homedir());
}

// Project roots we will sweep: a real directory, under $HOME, not $HOME, not `/`.
// Both sides are realpath'd — on macOS mkdtemp HOME is `/var/folders/...` while
// the sidecar stores `/private/var/folders/...`, and path.resolve does not fold
// that alias. Hash matching is a separate check.
export function isContainedProjectRoot(root: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = resolvedHomeDir(env);
  let resolved: string;
  try {
    if (!fs.statSync(root).isDirectory()) return false;
    resolved = fs.realpathSync(path.resolve(root));
  } catch {
    return false;
  }
  if (resolved === path.parse(resolved).root) return false;
  return resolved !== home && resolved.startsWith(home + path.sep);
}

function leftoverTrafficOneDir(env: NodeJS.ProcessEnv): string {
  return path.join(env.HOME || env.USERPROFILE || os.homedir(), '.traffic-one');
}

function listRecordedProjectRootsFromDir(
  projectsDir: string,
  env: NodeJS.ProcessEnv,
): RecordedProjectRoot[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  const found: RecordedProjectRoot[] = [];
  for (const hash of names) {
    const bucket = path.join(projectsDir, hash);
    try {
      if (!fs.statSync(bucket).isDirectory()) continue;
    } catch {
      continue;
    }

    const root = readProjectRootSidecar(bucket);
    if (!root) {
      found.push({ hash, root: null, status: 'missing-root' });
      continue;
    }

    let isDir = false;
    try {
      isDir = fs.statSync(root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      found.push({ hash, root, status: 'not-a-directory' });
      continue;
    }
    if (projectRootHash(root) !== hash) {
      found.push({ hash, root, status: 'hash-mismatch' });
      continue;
    }
    if (!isContainedProjectRoot(root, env)) {
      // `/`, $HOME, or outside home: not a sweepable project directory.
      found.push({ hash, root, status: 'not-a-directory' });
      continue;
    }
    found.push({ hash, root: realResolve(root), status: 'ok' });
  }
  return found;
}

function preferRecordedRoot(existing: RecordedProjectRoot, incoming: RecordedProjectRoot): RecordedProjectRoot {
  if (incoming.status === 'ok' && existing.status !== 'ok') return incoming;
  return existing;
}

export function listRecordedProjectRoots(env: NodeJS.ProcessEnv = process.env): RecordedProjectRoot[] {
  const primary = globalTrafficOneDir(env);
  const leftover = leftoverTrafficOneDir(env);
  const dirs = [path.join(primary, 'projects')];
  if (realResolve(leftover) !== realResolve(primary)) {
    dirs.push(path.join(leftover, 'projects'));
  }

  const byRoot = new Map<string, RecordedProjectRoot>();
  const noRoot: RecordedProjectRoot[] = [];
  for (const projectsDir of dirs) {
    for (const rec of listRecordedProjectRootsFromDir(projectsDir, env)) {
      if (!rec.root) {
        noRoot.push(rec);
        continue;
      }
      const key = realResolve(rec.root);
      const existing = byRoot.get(key);
      byRoot.set(key, existing ? preferRecordedRoot(existing, rec) : rec);
    }
  }
  return [...byRoot.values(), ...noRoot];
}
