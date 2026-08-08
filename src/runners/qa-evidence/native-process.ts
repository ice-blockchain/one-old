// src/runners/qa-evidence/native-process.ts
// Bounded native process execution and artifact collection.

import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  contentHash,
  type QaNativeArtifactV1,
  type QaNativeTestSummaryV1,
} from '../../shared/qa-evidence-runtime';
import { sha256 } from '../../shared/text';

import {
  type RunnerArgs,
} from './types';
import { emitProgress } from './report-publish';
import {
  safeProjectRelative,
  strictRelative,
} from './run-context';
import {
  parseBoundedArgv,
} from './server';

export interface BoundedProcessResult {
  kind: 'completed' | 'unavailable' | 'timeout' | 'output-limit';
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface NativeMachineResult {
  parser: 'xcode-xcresult-summary-v1' | 'android-junit-xml-v1';
  summary: QaNativeTestSummaryV1;
  artifacts: QaNativeArtifactV1[];
}

export const MAX_NATIVE_PROCESS_OUTPUT = 8 * 1024 * 1024;
const MAX_NATIVE_ARTIFACTS = 25_000;
const MAX_NATIVE_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * How often a running native adapter says it is still alive.
 *
 * BORROWED: 10 s is `REFRESH_INTERVAL_MS` in
 * shared/onboarding-server/browser-arrival.ts:39, this repo's existing cadence
 * for the same job — periodically re-asserting liveness to an observer who
 * would otherwise read silence as death. Unlike the stack path, this one can
 * actually do it: `runBoundedProcess` is promise-based, so the event loop is
 * free while the child runs.
 *
 * It matters most here. `xcodebuild test` and `./gradlew connectedAndroidTest`
 * are the longest steps this runner has, they emit nothing to the caller (their
 * stdout is captured, not inherited), and their bound is now five minutes.
 */
export const NATIVE_HEARTBEAT_MS = 10 * 1000;

export function runBoundedProcess(
  command: readonly string[],
  cwd: string,
  timeoutMs: number,
  heartbeat?: { label: string; intervalMs?: number },
): Promise<BoundedProcessResult> {
  return new Promise((resolvePromise) => {
    let child: ChildProcess;
    try {
      child = spawn(command[0]!, command.slice(1), {
        cwd,
        env: { ...process.env },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolvePromise({
        kind: 'unavailable',
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let forced: BoundedProcessResult['kind'] | null = null;
    let settled = false;
    const startedAtMs = Date.now();
    const finish = (result: BoundedProcessResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (pulse) clearInterval(pulse);
      resolvePromise(result);
    };
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (forced) return;
      bytes += chunk.length;
      if (bytes > MAX_NATIVE_PROCESS_OUTPUT) {
        forced = 'output-limit';
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        return;
      }
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('error', (error: NodeJS.ErrnoException) => finish({
      kind: error.code === 'ENOENT' ? 'unavailable' : 'completed',
      exitCode: null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: `${Buffer.concat(stderr).toString('utf8')}${error.message}`,
    }));
    child.once('close', (code) => finish({
      kind: forced || 'completed',
      exitCode: typeof code === 'number' ? code : null,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    const timer = setTimeout(() => {
      forced = 'timeout';
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, timeoutMs);
    // `unref` so a heartbeat can never be the reason a process stays alive: it
    // reports on work, it is not work.
    const pulse = heartbeat
      ? setInterval(() => {
          emitProgress(
            `${heartbeat.label}: still running, ${Math.round((Date.now() - startedAtMs) / 1000)}s `
            + `of a ${Math.round(timeoutMs / 1000)}s bound, ${bytes} byte(s) captured`,
          );
        }, Math.max(1, heartbeat.intervalMs ?? NATIVE_HEARTBEAT_MS)).unref()
      : null;
  });
}

function nativeWorkingDirectory(args: RunnerArgs): string | null {
  if (!args.nativeCwd) return fs.realpathSync(args.projectRoot);
  const relative = safeProjectRelative(args.projectRoot, args.nativeCwd);
  if (!relative) return null;
  try {
    const project = fs.realpathSync(args.projectRoot);
    const cwd = fs.realpathSync(path.join(args.projectRoot, relative));
    const boundary = path.relative(project, cwd);
    return !boundary.startsWith('..') && !path.isAbsolute(boundary) && fs.statSync(cwd).isDirectory()
      ? cwd
      : null;
  } catch {
    return null;
  }
}

export function configuredNativeCommand(
  args: RunnerArgs,
  adapter: string,
): { command: string[]; cwd: string } | null {
  const command = parseBoundedArgv(args.nativeCommandJson);
  const cwd = nativeWorkingDirectory(args);
  if (!command || !cwd) return null;
  if (adapter === 'xcode-simulator') {
    if (command[0] !== 'xcodebuild'
      || !command.slice(1).some((arg) => arg === 'test' || arg === 'test-without-building')
      || !command.slice(1).some((arg) => /^platform=iOS Simulator(?:,|$)/.test(arg))
      || command.some((arg) => ['-resultBundlePath', '-resultStreamPath'].includes(arg))) return null;
    return { command, cwd };
  }
  if (adapter === 'android-emulator') {
    const executable = command[0];
    const task = command.slice(1).find((arg) => (
      /^(?::[A-Za-z0-9_.-]+)*:?connected[A-Za-z0-9_.-]*AndroidTest$/.test(arg)
    ));
    if (!executable
      || !['./gradlew', 'gradlew.bat'].includes(executable)
      || !task
      || command.some((arg) => [
        '--init-script', '-I', '--project-dir', '-p', '--settings-file', '-c', '--build-file', '-b',
      ].includes(arg))) return null;
    return { command, cwd };
  }
  return null;
}

export function nativeArtifact(
  qaRoot: string,
  absolute: string,
  startedAtMs: number,
): QaNativeArtifactV1 | null {
  try {
    const realQa = fs.realpathSync(qaRoot);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1
      || stat.mtimeMs + 1_000 < startedAtMs) return null;
    const real = fs.realpathSync(absolute);
    const boundary = path.relative(realQa, real);
    if (boundary.startsWith('..') || path.isAbsolute(boundary)) return null;
    const relative = path.relative(realQa, real).replace(/\\/g, '/');
    if (!strictRelative(relative)) return null;
    const sha256Value = contentHash(real);
    if (!sha256Value) return null;
    return {
      path: relative,
      size: stat.size,
      sha256: sha256Value,
      artifactAt: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

export function collectNativeArtifacts(
  qaRoot: string,
  root: string,
  startedAtMs: number,
): QaNativeArtifactV1[] | null {
  const artifacts: QaNativeArtifactV1[] = [];
  let bytes = 0;
  const visit = (current: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      const artifact = nativeArtifact(qaRoot, absolute, startedAtMs);
      if (!artifact) return false;
      bytes += artifact.size;
      artifacts.push(artifact);
      if (artifacts.length > MAX_NATIVE_ARTIFACTS || bytes > MAX_NATIVE_ARTIFACT_BYTES) return false;
    }
    return true;
  };
  return visit(root) && artifacts.length > 0 ? artifacts : null;
}

export function androidResultRoots(cwd: string): string[] | null {
  const roots: string[] = [];
  let visited = 0;
  const visit = (current: string, depth: number): boolean => {
    if (depth > 8 || visited > 20_000) return false;
    visited += 1;
    const candidate = path.join(current, 'build', 'outputs', 'androidTest-results', 'connected');
    try {
      if (fs.statSync(candidate).isDirectory()) roots.push(fs.realpathSync(candidate));
    } catch {
      // This module has no connected-test result root.
    }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || ['.git', '.traffic-one', 'node_modules', 'build'].includes(entry.name)) continue;
      if (!visit(path.join(current, entry.name), depth + 1)) return false;
    }
    return true;
  };
  return visit(cwd, 0) ? [...new Set(roots)].sort() : null;
}

export function androidResultFiles(roots: readonly string[]): string[] | null {
  const files: string[] = [];
  let visited = 0;
  const visit = (current: string): boolean => {
    if (visited > 50_000) return false;
    visited += 1;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!visit(absolute)) return false;
      } else if (entry.isFile() && /\.xml$/i.test(entry.name)) {
        files.push(absolute);
        if (files.length > MAX_NATIVE_ARTIFACTS) return false;
      }
    }
    return true;
  };
  for (const root of roots) {
    if (!visit(root)) return null;
  }
  return files.sort();
}

export function fileSnapshot(files: readonly string[]): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const file of files) {
    try {
      const hash = contentHash(file);
      if (hash) snapshot.set(fs.realpathSync(file), hash);
    } catch { /* incomplete input is ignored */ }
  }
  return snapshot;
}
