// src/shared/exec.ts
// The ONE process/exec layer: a single which() (legacy had several) + run().
// Implements the Exec service consumed via Ctx.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { Exec, ExecResult } from '../core/types';

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

function run(cmd: string, args: readonly string[], opts: { cwd?: string } = {}): ExecResult {
  const result = spawnSync(cmd, [...args], { cwd: opts.cwd, encoding: 'utf8' });
  return {
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export const exec: Exec = { which, run };
