// src/shared/build-provenance.ts
// The ONE reader of `build-provenance.json` — the file `npm run gen` writes at
// `<root>/build-provenance.json` and `npm run build` writes at
// `<root>/scripts/build-provenance.json` (src/gen/lib/build-provenance.ts).
//
// It lives in `shared/` because it has two consumers on opposite sides of the
// layering: the hook runtime's materialization freshness check
// (shared/materialize/has-assets.ts) and doctor's plugin-root probe
// (runners/doctor/plugin-root-probe.ts, and through it plugin-identity.ts's
// `plugin.contentHash`). `shared/` importing `runners/` would invert the
// layering, so before this file the two carried separate copies of the paths
// and the parse — a drift pair over a value an operator compares BY EYE between
// doctor's output and a project's `.traffic-one/manifest.json`.
//
// Read, never recomputed: the hashing logic lives under `src/gen/lib/**`, which
// tsconfig.build.json excludes from `dist/scripts/**` by design, so importing it
// here would compile under tsx and then fail to resolve in the shipped runtime.
// Same reasoning, verbatim, as runners/doctor/plugin-identity.ts.

import * as path from 'path';

import { pluginRoot } from './paths';
import { readRegularFileOrThrow } from './bounded-read';

/**
 * A provenance record as the reader below hands it out.
 *
 * `sourceHash` is PRESENT ONLY WHEN IT IS A REAL IDENTITY — a non-empty string,
 * trimmed. The doctor-side declaration this replaces said `sourceHash?: string`
 * and checked nothing, so a `{"sourceHash": 42}` or `{"sourceHash": ""}` on disk
 * reached `plugin-identity.ts`'s `contentHash: string | null` as a number or an
 * empty string, and short-circuited its `??` fallback to the runtime subtree
 * that DID have a real one. Validating at the single read makes the declared
 * type true for both consumers without either of them re-checking, and makes
 * that `??` chain and `pluginContentHash` below the same expression by
 * construction rather than by two people keeping them in step.
 *
 * `gitSha` is deliberately left as the doctor declared it: it is interpolated
 * into one diagnostic sentence (findings.ts's layer-mismatch message) and
 * compared for equality, never treated as an identity, so it carries none of
 * the risk above.
 */
export interface BuildProvenanceRecord {
  readonly gitSha?: string | null;
  readonly sourceHash?: string;
}

export function contentProvenancePath(root: string): string {
  return path.join(root, 'build-provenance.json');
}

export function runtimeProvenancePath(root: string): string {
  return path.join(root, 'scripts', 'build-provenance.json');
}

// Returns the parsed object itself when its `sourceHash` is already canonical,
// so the common path allocates nothing and doctor's `--bundle` keeps printing
// the record it read. Every other field is carried through untouched.
function withValidatedSourceHash(record: Record<string, unknown>): BuildProvenanceRecord {
  const raw = record.sourceHash;
  const hash = typeof raw === 'string' ? raw.trim() : '';
  if (hash && hash === raw) return record as BuildProvenanceRecord;
  const copy = { ...record };
  if (hash) copy.sourceHash = hash;
  else delete copy.sourceHash;
  return copy as BuildProvenanceRecord;
}

/**
 * The record at `file`, or null when there is not one.
 *
 * Deliberately NOT `readJson(file, {})`: a plain-object result is the whole
 * contract here, and `readJson` hands back a top-level array or string as-is.
 * `null` for those is the behaviour plugin-root-probe.ts already had, and the
 * one its `layerMismatch` is written against — a non-object file must read as
 * "this subtree has no provenance", not as an empty record that happens to
 * compare equal to another empty one.
 *
 * Never throws: an absent file, a directory of the same name, an unreadable
 * one and a truncated one are all "no provenance here".
 */
export function readBuildProvenance(file: string): BuildProvenanceRecord | null {
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(file)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? withValidatedSourceHash(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * WHICH BUILD of the plugin the resolved root is, or `null` when it cannot say.
 *
 * This is the freshness signal a project's materialized `.traffic-one/rules/**`
 * and `.traffic-one/skills/**` are stamped with. It replaced
 * `state.materializedVersion === stateVersion()` — package.json's hand-bumped
 * version. Measured on this repo's history: of the last 14 non-merge commits
 * that changed the emitted content tree, 11 carried no version bump (10 of 14
 * counting only `rules/**` + `skills-catalog/**`, the two trees materialization
 * actually copies). HEAD is a live instance —
 * `skills-catalog/traffic-one-doctor/SKILL.md` gained 97 lines after the
 * v1.0.52 release commit while package.json still says 1.0.52 — so an upgraded
 * install kept the previous release's skill and doctor reported healthy. A
 * signal a human has to remember to move is not a signal.
 *
 * Deliberately NOT a new hash: `sourceHash` is already emitted into both
 * generated subtrees and is already what doctor prints as `plugin.contentHash`,
 * so an operator can compare doctor's output against the project's
 * `.traffic-one/manifest.json` `pluginContentHash` by eye and equal means
 * current.
 *
 * It is a SUPERSET signal, and that is the safe direction. The content tree is
 * generated from `src/**`, so every content change moves `sourceHash` — stale
 * content cannot read as fresh. The converse is not true: a runtime-only
 * TypeScript change also moves it and costs one extra materialization pass per
 * project (~36 ms, measured in modules/agent-model/converge.ts's note on the
 * same sweep), paid once per plugin BUILD, not per hook.
 *
 * Content subtree first, runtime second. This is the SAME EXPRESSION
 * `plugin-identity.ts`'s `resolveContentHash` evaluates over the same two
 * records, which is the point of validating in the reader: doctor and
 * materialization cannot name different builds for one root. Content first is
 * also the right bias here specifically — `rules/` and `skills-catalog/` are
 * what gets copied, so when a mixed install disagrees with itself (the probe's
 * `layerMismatch`) the content half is the half this project's bytes came from.
 *
 * `null` is not a failure and must never be read as staleness. A source
 * checkout that has never run `npm run gen`, a fixture root, a partial tree, an
 * install predating the stamp — none of them can answer, and answering "stale"
 * for them would re-materialize forever against a root materializeProjectAssets
 * refuses anyway. Every caller falls back to the pre-existing signals.
 */
export function pluginContentHash(root: string = pluginRoot()): string | null {
  return readBuildProvenance(contentProvenancePath(root))?.sourceHash
    ?? readBuildProvenance(runtimeProvenancePath(root))?.sourceHash
    ?? null;
}
