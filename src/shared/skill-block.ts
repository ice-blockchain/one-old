// src/shared/skill-block.ts
// Generalised auth `T1AUTH` bridge → `T1BLOCK`. Any module keeps its agent-facing
// directive PROSE in modules/<id>/skill/SKILL.md inside fenced markers:
//   <!-- T1BLOCK:BEGIN <name> -->  ...text, may contain {{VARS}}...  <!-- T1BLOCK:END <name> -->
// skillBlock(id, name, vars, fallback) returns that text with vars substituted —
// so logic in code never embeds prose, and a missing block never breaks
// enforcement (logic lives in the gate).
//
// ── the three prose sources, in the order they are consulted ─────────────────
//   1. the live T1BLOCK in <pluginRoot>/{src,scripts}/modules/<id>/skill/SKILL.md
//   2. SKILL_FALLBACKS — the same bodies, generated into a TS module beside this
//      one (build/gen-skill-fallbacks.ts) and reached WITHOUT pluginRoot()
//   3. the caller's explicit `fallback` argument
//
// (2) before (3) is deliberate and is the whole property this ordering buys: the
// torn-install path renders WHAT THE HEALTHY PATH RENDERS. A per-call-site
// literal is only ever read when SKILL.md is unreadable, so on a healthy tree it
// is already dead text; letting it win over the generated copy would mean a
// broken install renders prose no working install has ever shown. The explicit
// argument therefore survives as the LAST tier, reached only for a block that
// exists in no SKILL.md at all — which is the one case the table cannot serve
// (see TS_ONLY_PROSE in __tests__/skill-block-coverage.test.ts).
//
// The table is why a call site no longer has to carry a transcription of its own
// block: 34 sites passed no fallback and rendered `''` on a torn install, and
// the 20 pairs that DID carry one had drifted from the block they copied. Both
// are properties of having two hand-maintained sources, and both go away when
// the second source is generated from the first.
//
// The import is STATIC and eager, and costs 0.77 ms of `require` for 157 blocks
// (~100 KB of string literals) in the compiled CJS shape, measured, once per
// hook process. Left eager against host budgets in the hundreds of milliseconds:
// a lazy `require()` inside the lookup would save that on the healthy path, at
// the price of making the one input this design exists to keep unconditional
// resolvable at a moment when it can be caught and swallowed. A missing sibling
// should be a load-time throw here, exactly as it is for the dozens of other
// siblings `scripts/hook-runtime.cjs` reaches.

import * as path from 'path';

import type { SkillBlockFn } from '../core/types';
import { applyVars, extractBlock, fallbackKey } from './skill-markers';
import { SKILL_FALLBACKS } from './skill-fallbacks.generated';
import { readRegularFileOrThrow } from './bounded-read';

export { applyVars, extractBlock, fallbackKey, listBlockNames, MARKER } from './skill-markers';

/**
 * The generated body for a block, or null. `Object.hasOwn` rather than a plain
 * index read: the table is an object literal, so a block named `constructor` or
 * `toString` would otherwise resolve to something off the prototype and be
 * rendered at an agent.
 */
export function generatedFallback(moduleId: string, blockName: string): string | null {
  const key = fallbackKey(moduleId, blockName);
  return Object.hasOwn(SKILL_FALLBACKS, key) ? SKILL_FALLBACKS[key]! : null;
}

export function makeSkillBlock(resolvePluginRoot: () => string): SkillBlockFn {
  const cache = new Map<string, string>();
  return (moduleId, blockName, vars, fallback = '') => {
    let source = cache.get(moduleId);
    if (source === undefined) {
      // Prefer the authoring source (src/, always current in dev + present when
      // src/ ships); fall back to the compiled copy (scripts/, shipped by the
      // build) so wording resolves even when src/ is stripped from an install.
      const root = resolvePluginRoot();
      source = '';
      for (const base of ['src', 'scripts'] as const) {
        try {
          const text = readRegularFileOrThrow(path.join(root, base, 'modules', moduleId, 'skill', 'SKILL.md'));
          if (text) { source = text; break; }
        } catch {
          // try the next candidate
        }
      }
      cache.set(moduleId, source);
    }
    const body = source ? extractBlock(source, blockName) : null;
    const text = body ?? generatedFallback(moduleId, blockName) ?? fallback;
    return applyVars(text, vars);
  };
}
