// src/modules/session/session-start-lib.ts
// Local SessionStart helpers: digest retention sweep, graph-preview read, the
// token-economy banner, and session-time materialization convergence. Ported
// 1:1 from session-start.cjs + tokenEconomyBanner (_helpers.cjs). The toolchain
// drift probe + the one-mcp reporter are Step-5 runner concerns, injected here
// as optional dependencies (default: no-op) so this stays runner-free.

import * as fs from 'fs';
import * as path from 'path';

import { isPluginAuthoringRoot } from '../../shared/authoring-root';
import { STACK_IDS } from '../../shared/config';
import { detectMode } from '../../shared/detection';
import { hasMaterializedProjectAssets, materializeProjectAssets } from '../../shared/materialize';
import { nowIsoNoMs } from '../../shared/text';
import {
  isMaterialized,
  normalizeState,
  readEffectiveState,
  stackFingerprint,
  stateVersion,
  writeState,
} from '../../shared/state';

type Rec = Record<string, unknown>;

// Keep the newest `keepCount` orchestrator digest runs; remove older ones.
export function sweepOldDigests(cwd: string, keepCount = 5): number {
  const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
  if (!fs.existsSync(digestsRoot)) return 0;
  let entries: string[];
  try {
    entries = fs.readdirSync(digestsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries.slice(keepCount)) {
    try {
      fs.rmSync(path.join(digestsRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // best-effort; never block SessionStart on retention sweep
    }
  }
  return removed;
}

// The ~500-token graph preview written by the gitnexus/graphify runners.
export function readGraphPreview(cwd: string): string {
  const previewPath = path.join(cwd, '.traffic-one', 'graph-preview.md');
  if (!fs.existsSync(previewPath)) return '';
  try {
    return `\n${fs.readFileSync(previewPath, 'utf8').trimEnd()}\n`;
  } catch {
    return '';
  }
}

export interface ToolStatus {
  status: string;
  installed?: string;
  minimum?: string;
  recommended?: string;
}
export interface ToolchainProbe {
  toolStatus(name: string, installedVersion: unknown): ToolStatus;
  getToolSpec(name: string): { installCommand?: string } | null;
}

// Memory / codebase-graph / digest / toolchain-drift hints injected at session
// start. The toolchain drift hints require a probe (Step-5 toolchain runner);
// when omitted, only the memory/graph/digest banners are emitted.
export function tokenEconomyBanner(cwd: string, probe?: ToolchainProbe | null): string {
  const lines: string[] = [];
  const memoryPaths = [
    '.traffic-one/product.md', '.traffic-one/stack.md', '.traffic-one/coding.md',
    '.traffic-one/security.md', '.traffic-one/known-issues.md', '.traffic-one/agent-log.md',
  ];
  if (memoryPaths.some((relPath) => fs.existsSync(path.join(cwd, relPath)))) {
    lines.push('[memory] .traffic-one/ project memory present — read product/stack/rules/known-issues before broad source reads.');
  }
  if (fs.existsSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'))) {
    lines.push('[graph: graphify] graphify-out/GRAPH_REPORT.md present — consult before grep/glob for module/structure questions.');
  }
  if (fs.existsSync(path.join(cwd, '.gitnexus'))) {
    lines.push('[graph: gitnexus] .gitnexus/ present — consult before grep/glob for module/structure questions.');
  }
  try {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    if (fs.existsSync(digestsRoot)) {
      const runs = fs.readdirSync(digestsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
      if (runs.length > 0) {
        lines.push(`[digests] Latest orchestrator run: .traffic-one/digests/${runs[0]}/ — read predecessor digests before re-reading the diff.`);
      }
    }
  } catch {
    // best-effort; banner is informational
  }
  if (probe) {
    try {
      const state = readEffectiveState(cwd);
      const toolchain = (state && (state.toolchain as Rec)) || {};
      for (const [name, stamp] of Object.entries(toolchain)) {
        const installedVersion = stamp && typeof stamp === 'object' ? (stamp as Rec).installedVersion : null;
        const status = probe.toolStatus(name, installedVersion);
        if (status.status === 'too-old') {
          const spec = probe.getToolSpec(name) || {};
          lines.push(`[toolchain] ${name} ${status.installed} is below the minimum supported (${status.minimum}). Upgrade: \`${spec.installCommand || `<upgrade ${name}>`}\`.`);
        } else if (status.status === 'outdated') {
          lines.push(`[toolchain] ${name} ${status.installed} installed; recommended is ${status.recommended}.`);
        }
      }
    } catch {
      // best-effort; banner is informational
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

// Converge session-time materialization for an onboarded project. Returns true
// when it (re)materialized. The one-mcp reporter is injected (default no-op).
export function ensureSessionMaterialization(
  cwd: string,
  state: Rec,
  reportOneMcp: (cwd: string, state: Rec, trigger: string) => void = () => {},
): boolean {
  if (isPluginAuthoringRoot(cwd)) return false;
  if (!state || typeof state !== 'object') return false;
  if (state.onboardingComplete !== true) return false;
  if (!state.stack || !STACK_IDS.has(state.stack as string)) return false;

  if (isMaterialized(state) && hasMaterializedProjectAssets(cwd, state)) {
    reportOneMcp(cwd, state, 'session materialization already current');
    return false;
  }

  normalizeState(state, (state.mode as string) || detectMode(cwd));
  const materialized = materializeProjectAssets(cwd, state);
  if (materialized.skipped) {
    reportOneMcp(cwd, state, 'session materialization skipped');
    return false;
  }
  state.materializedStack = stackFingerprint(state);
  state.materializedAt = nowIsoNoMs();
  state.materializedVersion = stateVersion();
  writeState(cwd, state);
  reportOneMcp(cwd, state, 'session materialization');
  return true;
}
