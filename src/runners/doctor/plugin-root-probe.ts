// src/runners/doctor/plugin-root-probe.ts
// Doctor probe for the resolved plugin root itself: which of the four
// TRAFFIC_ONE_PLUGIN_ROOT/CODEX_/CLAUDE_/CURSOR_ env vars supplied it (or the
// __dirname default), what layout it classifies as (src/shared/paths.ts), and
// whether its content (<root>/build-provenance.json, written by `npm run
// gen`) and runtime (<root>/scripts/build-provenance.json, written by `npm
// run build`) subtrees carry matching build identities. Read-only, like every
// other doctor probe; never denies (see findings.ts) — this is exactly the
// diagnostic surface the plan protects from ever becoming undeniable.
//
// The paths and the parse are shared/build-provenance.ts's, not this file's:
// the hook runtime's materialization freshness check reads the same file, and
// two copies of "where is it and what counts as a record" over a value an
// operator compares BY EYE against a project's manifest is a drift pair. That
// reader also validates `sourceHash` (see its type), so plugin-identity.ts's
// `contentHash` fallback chain and the runtime's `pluginContentHash` are the
// same expression over the same records instead of two that agree by habit.

import {
  contentProvenancePath as contentProvenancePathFor,
  readBuildProvenance,
  runtimeProvenancePath as runtimeProvenancePathFor,
  type BuildProvenanceRecord,
} from '../../shared/build-provenance';
import { pluginRootInfo, type PluginRootInfo } from '../../shared/paths';

export interface PluginRootProbe extends PluginRootInfo {
  readonly contentProvenancePath: string;
  readonly runtimeProvenancePath: string;
  readonly contentProvenance: BuildProvenanceRecord | null;
  readonly runtimeProvenance: BuildProvenanceRecord | null;
  // True only when BOTH copies exist and disagree — a pair where either (or
  // both) is missing predates this feature or is a partial/dev tree, not
  // evidence of a stale mixed install.
  readonly layerMismatch: boolean;
}

export function probePluginRoot(): PluginRootProbe {
  const info = pluginRootInfo();
  const contentProvenancePath = contentProvenancePathFor(info.root);
  const runtimeProvenancePath = runtimeProvenancePathFor(info.root);
  const contentProvenance = readBuildProvenance(contentProvenancePath);
  const runtimeProvenance = readBuildProvenance(runtimeProvenancePath);
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
