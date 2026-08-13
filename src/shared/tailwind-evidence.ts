// src/shared/tailwind-evidence.ts
// Detect Tailwind utility usage in markup vs. an actually-installed Tailwind
// toolchain.
//
// Observed 8co: delegated components shipped dozens of Tailwind utility
// classes into a project with NO tailwindcss dependency, no config, and no
// CSS directives — build/typecheck/lint all green, rendered output visibly
// broken (utilities are inert). Styling-system mismatch is a defect the
// existing gates cannot see: the collapse scanner deliberately masks
// className strings and the formatter has no opinion.
//
// Dependency-free; used by the OpenCode post-apply verifier and the
// react-structure scan.

import * as fs from 'fs';
import * as path from 'path';

import { readCompiledArchitecture } from './architecture-contract';
import { readRegularFileOrThrow } from './bounded-read';

// Canonical, unambiguous Tailwind utilities. Deliberately narrow: generic
// words that appear in hand-written CSS class names (`container`, `card`,
// `button`) must not count. Spacing/color/typography scales with numeric
// suffixes and flex/grid keywords are Tailwind's own grammar.
const TAILWIND_UTILITY_RE = new RegExp([
  '^(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|dark|group-hover):.+$',
  '^(?:p|m)(?:[xytrbl])?-(?:\\d+(?:\\.\\d+)?|px)$',
  '^(?:gap|space-[xy])-\\d+$',
  '^(?:w|h)-(?:full|screen|\\d+(?:\\/\\d+)?)$',
  '^(?:min|max)-(?:w|h)-.+$',
  '^text-(?:xs|sm|base|lg|xl|\\d?xl|left|center|right|[a-z]+-\\d{2,3})$',
  '^bg-[a-z]+-\\d{2,3}$',
  '^border-[a-z]+-\\d{2,3}$',
  '^font-(?:thin|light|normal|medium|semibold|bold|extrabold|black)$',
  '^rounded(?:-(?:sm|md|lg|xl|2xl|3xl|full))?$',
  '^shadow(?:-(?:sm|md|lg|xl|2xl|inner|none))?$',
  '^(?:flex|inline-flex|grid|inline-grid)$',
  '^flex-(?:row|col|wrap|nowrap|1|auto|initial|none)$',
  '^grid-cols-\\d+$',
  '^items-(?:start|center|end|baseline|stretch)$',
  '^justify-(?:start|center|end|between|around|evenly)$',
  '^tracking-(?:tighter|tight|normal|wide|wider|widest)$',
  '^leading-(?:none|tight|snug|normal|relaxed|loose|\\d+)$',
].join('|'));

const CLASS_ATTR_RE = /\bclass(?:Name)?\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\})/g;

export interface TailwindUtilityEvidence {
  count: number;
  sample: string[];
}

/**
 * Distinct canonical Tailwind utilities appearing inside class/className
 * string values. Three or more distinct utilities in one file is deliberate
 * Tailwind styling, not a coincidence of naming.
 */
export function tailwindUtilityEvidence(text: string): TailwindUtilityEvidence {
  const distinct = new Set<string>();
  let match: RegExpExecArray | null;
  CLASS_ATTR_RE.lastIndex = 0;
  while ((match = CLASS_ATTR_RE.exec(text))) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    for (const token of value.split(/\s+/)) {
      if (token && TAILWIND_UTILITY_RE.test(token)) distinct.add(token);
    }
  }
  return { count: distinct.size, sample: [...distinct].sort().slice(0, 6) };
}

function readJsonSafe(file: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(file)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function manifestDeclaresTailwind(manifest: Record<string, unknown>): boolean {
  for (const key of ['dependencies', 'devDependencies']) {
    const deps = manifest[key];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)
      && Object.prototype.hasOwnProperty.call(deps, 'tailwindcss')) {
      return true;
    }
  }
  return false;
}

function dirHasTailwindConfig(dir: string): boolean {
  for (const name of [
    'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs', 'tailwind.config.ts',
  ]) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // unreadable dir — keep walking
    }
  }
  return false;
}

/**
 * True when the file can plausibly be styled by Tailwind: a `tailwindcss`
 * dependency or a tailwind config exists in the file's package directory or
 * any ancestor up to the project root. (Tailwind v4 needs no config file, so
 * the dependency alone counts; a config alone also counts for setups that
 * hoist the dependency out of visible manifests.)
 */
export function tailwindToolchainPresent(projectRoot: string, fileRel: string): boolean {
  const root = path.resolve(projectRoot);
  let dir = path.resolve(root, path.dirname(fileRel));
  for (let hops = 0; hops < 12; hops += 1) {
    const manifest = readJsonSafe(path.join(dir, 'package.json'));
    if (manifest && manifestDeclaresTailwind(manifest)) return true;
    if (dirHasTailwindConfig(dir)) return true;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

const TAILWIND_SCAFFOLD_RE = /(^|\/)(?:tailwind-config\/|tailwind\.config\.[cm]?[jt]s$)/;

/**
 * True when the run's COMPILED contract pins Tailwind — its scaffold outputs
 * include a Tailwind home — regardless of whether that home is on disk yet.
 *
 * The filesystem probe above answers "is Tailwind reachable now?", which is the
 * wrong question at Step-0. OpenCode units run BEFORE the role that scaffolds
 * the manifest (the spawn gate guarantees that ordering), and a unit's file
 * allowlist may never include a manifest or lockfile. So a unit briefed to
 * "compose with Tailwind" — which the pinned stack requires — could not satisfy
 * the probe by any legal action. Observed 9co: 3 of 4 units rolled back after
 * 14m24s, and the identical components were written without complaint by the
 * paid role five minutes later once the manifest existed.
 *
 * Stacks whose contract does NOT pin Tailwind keep the filesystem answer, so the
 * original 8co defect (inert utilities in a plain-CSS project) stays caught.
 */
export function tailwindPinnedByContract(projectRoot: string, runId: string): boolean {
  if (!runId) return false;
  let architecture: { scaffoldOutputs?: ReadonlyArray<{ path?: unknown }> } | null;
  try {
    architecture = readCompiledArchitecture(projectRoot, runId);
  } catch {
    return false;
  }
  if (!architecture) return false;
  return (architecture.scaffoldOutputs || []).some((output) => (
    typeof output.path === 'string' && TAILWIND_SCAFFOLD_RE.test(output.path.replace(/\\/g, '/'))
  ));
}
