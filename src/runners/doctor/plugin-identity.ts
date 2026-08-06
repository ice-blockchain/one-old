// src/runners/doctor/plugin-identity.ts
// The `plugin: {version, contentHash, root, layout, source, host}` block wired into
// both doctor's plain and `--bundle` output. Every field is READ off state
// something else already computed — never re-derived — because a second
// implementation of "what plugin is this" is exactly how the two could
// silently disagree:
//   - root/layout/source: pluginRootInfo() (src/shared/paths.ts), via the
//     existing probePluginRoot() (plugin-root-probe.ts) so there is one probe of
//     the resolved root, not two.
//   - contentHash: build-provenance.json's OWN `sourceHash` field, read by
//     probePluginRoot() from whichever of the content/runtime subtrees has
//     it. Deliberately NOT a live recompute: build-provenance.ts's hashing
//     logic lives under src/gen/lib/**, which tsconfig.build.json excludes
//     from the compiled runtime (dist/scripts/**) by design — `npm run gen`
//     is a build-time tool, not part of the dependency-free hook runtime
//     doctor.cjs ships in. Importing it here would compile fine under tsx
//     (dev/test) and then fail to resolve in the shipped `scripts/doctor.cjs`
//     the moment this ran from an installed plugin. Reading the field the
//     build already wrote (exactly what plugin-root-probe.ts's own
//     `contentProvenance`/`runtimeProvenance` do) is the only version of
//     "reuse, don't reinvent" that is deployable. A source checkout that has
//     never run `npm run gen`/`npm run build` has neither file yet — reports
//     `contentHash: null` rather than fabricating one, same as
//     `layerMismatch` already tolerates an absent pair.
//   - version: pluginVersion() (src/config/plugin-identity.ts), pointed at
//     THIS probe's resolved root (not the ambient default) so a doctor
//     invoked with an explicit TRAFFIC_ONE_PLUGIN_ROOT override reports that
//     root's version, not whichever one __dirname would have resolved.
//   - host: detectHost() (src/shared/host/index.ts) — the same detection
//     every hook entry uses; doctor is normally invoked from a plain
//     terminal, so this is env/argv-based, not host-hook-payload-based. But
//     detectHost's job is to always return SOMETHING a gate can decide with,
//     so it falls back to 'claude' when no marker is present — and doctor's
//     normal invocation (a human in a terminal) is exactly that case. A
//     report that prints host "claude" on a machine running Codex is worse
//     than one that admits it does not know, so this reports `null` unless
//     there is positive evidence. See hostEvidence() below — which also
//     reports WHICH markers were present and absent, because a bare `null`
//     drops the only field identifying the host from the bug report and
//     leaves the reader unable to tell "unknown" from "no host".

import { pluginVersion } from '../../config/plugin-identity';
import type { HostId } from '../../core/types';
import { detectHost } from '../../shared/host';
import { probePluginRoot, type PluginRootProbe } from './plugin-root-probe';

export interface PluginIdentity {
  readonly version: string;
  readonly contentHash: string | null;
  readonly root: string;
  readonly layout: PluginRootProbe['layout'];
  /**
   * WHICH of the four *_PLUGIN_ROOT env vars supplied `root`, or 'default' for
   * the runtime's own location — the same evidence-with-the-value rule applied
   * to `host` below. `probes.pluginRoot.source` already carries this, but an
   * operator triaging a bug report reads this block first, and "wrong plugin in
   * force" is indistinguishable from "right plugin" until you know whether a
   * stale override chose the path.
   */
  readonly source: PluginRootProbe['source'];
  /** null = no host marker in env/argv (a plain terminal invocation). */
  readonly host: HostId | null;
  /**
   * WHICH markers were looked for and what was found — the evidence behind
   * `host`, so a `host: null` report is still usable. A bare null loses the
   * only field naming the host, and an operator reading a bug report cannot
   * tell "we did not detect it" from "no host was involved". Marker VALUES are
   * never included: `CURSOR_PLUGIN_ROOT` etc. are absolute paths already
   * reported by the plugin-root probe, and this field only has to answer
   * "present or absent".
   */
  readonly hostEvidence: {
    /** Marker names that were set (env) or supplied (`--host=`), sorted. */
    readonly present: string[];
    /** Marker names that were looked for and absent, sorted. */
    readonly absent: string[];
  };
}

function resolveContentHash(probe: PluginRootProbe): string | null {
  return probe.contentProvenance?.sourceHash ?? probe.runtimeProvenance?.sourceHash ?? null;
}

// Exactly the signals detectHost() treats as authoritative (an explicit
// `--host=` arg, TRAFFIC_ONE_HOST, CURSOR_PLUGIN_ROOT, the three Codex
// markers), plus CLAUDE_PLUGIN_ROOT — which detectHost does not need to
// consult, because its own fallback is already 'claude', but which IS real
// evidence of a Claude-hosted invocation. Anything else is the fallback, and
// the fallback is not knowledge.
const HOST_ENV_MARKERS = [
  'TRAFFIC_ONE_HOST',
  'CURSOR_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
  'CODEX_PLUGIN_ROOT',
  'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
  'CODEX_THREAD_ID',
] as const;

const HOST_ARGV_MARKER = '--host=';

function hostEvidence(env: NodeJS.ProcessEnv, argv: readonly string[]): PluginIdentity['hostEvidence'] {
  const present: string[] = [];
  const absent: string[] = [];
  const bucket = (name: string, seen: boolean): void => { (seen ? present : absent).push(name); };
  bucket(HOST_ARGV_MARKER, argv.some((arg) => typeof arg === 'string' && arg.startsWith(HOST_ARGV_MARKER)));
  for (const name of HOST_ENV_MARKERS) bucket(name, Boolean(env[name]));
  return { present: present.sort(), absent: absent.sort() };
}

export function probePluginIdentity(
  pluginRootProbe: PluginRootProbe = probePluginRoot(),
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): PluginIdentity {
  const evidence = hostEvidence(env, argv);
  return {
    version: pluginVersion(pluginRootProbe.root),
    contentHash: resolveContentHash(pluginRootProbe),
    root: pluginRootProbe.root,
    layout: pluginRootProbe.layout,
    source: pluginRootProbe.source,
    host: evidence.present.length > 0 ? detectHost(env, argv) : null,
    hostEvidence: evidence,
  };
}
