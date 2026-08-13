// src/shared/i18n-seed.ts
// Deterministic catalog-key seeding: a `<Trans ns i18nKey>fallback</Trans>` in
// the change under review DECLARES the source-locale copy, so a catalog key it
// references being missing is auto-fixable, not deniable — seed the fallback
// into the source locale and a clearly marked TODO into every other declared
// locale, then let the caller re-validate. Only MISSING or blank values are
// ever written (the ensureScaffoldContent "only when missing/blank" rule:
// non-empty agent content is never overwritten), only JSON catalogs are
// touched (other formats are not deterministically writable), and the caller
// gets a restore handle so a deny path can leave the tree exactly as it found
// it. Empty-value and extra-key parity findings stay denies — they carry no
// in-change fallback to seed from.

import * as fs from 'fs';
import * as path from 'path';

import type { CompiledI18nContractV1 } from './architecture-contract';
import type { I18nReference } from './i18n-enforcement';
import { readRegularFileOrThrow } from './bounded-read';

export interface I18nSeedResult {
  /** `namespace:key` identifiers that were written into at least one catalog. */
  seededKeys: string[];
  /** Put every touched catalog back to its pre-seed bytes. */
  restore: () => void;
}

type JsonObject = Record<string, unknown>;

function keySegments(
  catalogNamespaces: readonly string[],
  reference: I18nReference,
): string[] {
  const segments = reference.key.split('.').filter(Boolean);
  // Multi-namespace catalogs nest each namespace at the top level (the
  // flattened form `ns.key` is what entriesForNamespace strips back off).
  return catalogNamespaces.length === 1 ? segments : [reference.namespace, ...segments];
}

// Seed one key into a parsed catalog object. Returns true when the object was
// changed. Existing NON-EMPTY leaves and structurally conflicting paths (an
// intermediate segment that already holds a non-object) are left untouched —
// restructuring agent content is not deterministic.
function seedInto(root: JsonObject, segments: readonly string[], value: string): boolean {
  let node: JsonObject = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (child === undefined) {
      const created: JsonObject = {};
      node[segment] = created;
      node = created;
      continue;
    }
    if (!child || typeof child !== 'object' || Array.isArray(child)) return false;
    node = child as JsonObject;
  }
  const leaf = segments[segments.length - 1]!;
  const existing = node[leaf];
  if (existing !== undefined
    && !(typeof existing === 'string' && existing.trim() === '')) return false;
  node[leaf] = value;
  return true;
}

/**
 * Seed every referenced-with-fallback key that is missing (or blank) from a
 * declared JSON catalog: the fallback text into the source locale, a
 * `TODO(<sourceLocale> copy): <fallback>` marker into the other locales.
 */
export function seedI18nCatalogKeys(
  projectRoot: string,
  i18n: CompiledI18nContractV1,
  references: readonly I18nReference[],
): I18nSeedResult {
  const originals = new Map<string, string>(); // catalog path → pre-seed bytes
  const parsed = new Map<string, JsonObject>();
  const seededKeys: string[] = [];
  const seedable = references.filter((reference) => (
    typeof reference.fallback === 'string' && reference.fallback.trim().length > 0
  ));
  for (const reference of seedable) {
    let seeded = false;
    for (const locale of i18n.locales) {
      const catalog = i18n.catalogs.find((candidate) => (
        candidate.format === 'json'
        && candidate.locales.includes(locale)
        && candidate.namespaces.includes(reference.namespace)
      ));
      if (!catalog) continue;
      let root = parsed.get(catalog.path);
      if (!root) {
        let text: string;
        try {
          text = readRegularFileOrThrow(path.join(projectRoot, catalog.path));
        } catch {
          continue; // a missing catalog FILE stays the validator's deny
        }
        try {
          const value = JSON.parse(text) as unknown;
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          root = value as JsonObject;
        } catch {
          continue; // unparsable agent content — never rewrite it
        }
        originals.set(catalog.path, text);
        parsed.set(catalog.path, root);
      }
      const value = locale === i18n.sourceLocale
        ? reference.fallback!.trim()
        : `TODO(${i18n.sourceLocale} copy): ${reference.fallback!.trim()}`;
      if (seedInto(root, keySegments(catalog.namespaces, reference), value)) seeded = true;
    }
    if (seeded) seededKeys.push(`${reference.namespace}:${reference.key}`);
  }
  const touched: string[] = [];
  if (seededKeys.length > 0) {
    for (const [rel, root] of parsed) {
      const next = `${JSON.stringify(root, null, 2)}\n`;
      if (next === originals.get(rel)) continue;
      try {
        fs.writeFileSync(path.join(projectRoot, rel), next, 'utf8');
        touched.push(rel);
      } catch {
        // best-effort — the validator re-runs either way
      }
    }
  }
  return {
    seededKeys: touched.length > 0 ? seededKeys : [],
    restore: () => {
      for (const rel of touched) {
        const previous = originals.get(rel);
        if (previous === undefined) continue;
        try {
          fs.writeFileSync(path.join(projectRoot, rel), previous, 'utf8');
        } catch {
          // best-effort restore
        }
      }
    },
  };
}
