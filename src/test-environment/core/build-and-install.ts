// src/test-environment/core/build-and-install.ts
// Refresh dist (gen + build) and idempotently update each enabled host so a
// host-e2e run exercises the latest plugin. Skipped entirely for pure-node-only
// runs (those reuse src/ directly and need neither dist nor an installed host).

import { spawnSync } from 'child_process';
import * as path from 'path';

import type { HostCommandConfig, HostId, RootTestConfig } from './types';
import { REPO_ROOT_PATH } from '../config/test-config';

export interface BuildResult {
  distRoot: string;
  built: boolean;
  installed: HostId[];
  notes: string[];
}

function run(cmd: string, args: string[], cwd: string): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000 });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { ok: res.status === 0, out };
}

function expandInstallArgs(args: string[], distRoot: string): string[] {
  return args.map((a) => a.replace('{DIST}', distRoot));
}

export function buildAndInstall(
  config: RootTestConfig,
  hostsToInstall: HostId[],
): BuildResult {
  const distRoot = path.join(REPO_ROOT_PATH, 'dist');
  const notes: string[] = [];
  const installed: HostId[] = [];
  let built = false;

  if (config.build.refreshDist) {
    const r = run('npm', ['run', 'plugin:build'], REPO_ROOT_PATH);
    built = r.ok;
    if (!r.ok) notes.push(`plugin:build FAILED:\n${r.out.slice(-2000)}`);
  } else {
    notes.push('skipped dist build (--no-build)');
  }

  if (config.build.updateHosts) {
    for (const host of hostsToInstall) {
      const cfg: HostCommandConfig = config.hosts[host];
      const steps = cfg.installArgs ?? [];
      if (steps.length === 0) {
        if (host === 'cursor') {
          notes.push('cursor: live dir pointer — run `/add-plugin ' + distRoot + '` once inside the editor (cannot be scripted).');
        }
        continue;
      }
      let allOk = true;
      for (const step of steps) {
        // Install/update commands are best-effort idempotent: "already added"
        // style non-zero exits are expected and only noted, never fatal.
        const r = run(cfg.bin, expandInstallArgs(step, distRoot), REPO_ROOT_PATH);
        if (!r.ok) {
          allOk = false;
          notes.push(`${host} \`${cfg.bin} ${step.join(' ')}\` non-zero (continuing): ${r.out.slice(-300).trim()}`);
        }
      }
      if (allOk) installed.push(host);
    }
  } else {
    notes.push('skipped host update (--no-install)');
  }

  return { distRoot, built, installed, notes };
}
