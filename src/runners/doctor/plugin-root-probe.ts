// src/runners/doctor/plugin-root-probe.ts
// Doctor probe for the resolved plugin root itself: which of the four
// TRAFFIC_ONE_PLUGIN_ROOT/CODEX_/CLAUDE_/CURSOR_ env vars supplied it (or the
// __dirname default), what layout it classifies as (src/shared/paths.ts), and
// whether its content (<root>/build-provenance.json, written by `npm run
// gen`) and runtime (<root>/scripts/build-provenance.json, written by `npm
// run build`) subtrees carry matching build identities. Read-only, like every
// other doctor probe; never denies (see findings.ts) — this is exactly the
// diagnostic surface the plan protects from ever becoming undeniable.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRootInfo, type PluginRootInfo } from '../../shared/paths';

interface BuildProvenanceLike {
  readonly gitSha?: string | null;
  readonly sourceHash?: string;
}

function readProvenance(file: string): BuildProvenanceLike | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as BuildProvenanceLike) : null;
  } catch {
    return null;
  }
}

export interface PluginRootProbe extends PluginRootInfo {
  readonly contentProvenancePath: string;
  readonly runtimeProvenancePath: string;
  readonly contentProvenance: BuildProvenanceLike | null;
  readonly runtimeProvenance: BuildProvenanceLike | null;
  // True only when BOTH copies exist and disagree — a pair where either (or
  // both) is missing predates this feature or is a partial/dev tree, not
  // evidence of a stale mixed install.
  readonly layerMismatch: boolean;
}

export function probePluginRoot(): PluginRootProbe {
  const info = pluginRootInfo();
  const contentProvenancePath = path.join(info.root, 'build-provenance.json');
  const runtimeProvenancePath = path.join(info.root, 'scripts', 'build-provenance.json');
  const contentProvenance = readProvenance(contentProvenancePath);
  const runtimeProvenance = readProvenance(runtimeProvenancePath);
  const layerMismatch = Boolean(
    contentProvenance
    && runtimeProvenance
    && (contentProvenance.gitSha !== runtimeProvenance.gitSha
      || contentProvenance.sourceHash !== runtimeProvenance.sourceHash),
  );
  return {
    ...info,
    contentProvenancePath,
    runtimeProvenancePath,
    contentProvenance,
    runtimeProvenance,
    layerMismatch,
  };
}
