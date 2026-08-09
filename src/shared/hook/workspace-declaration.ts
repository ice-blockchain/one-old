// src/shared/hook/workspace-declaration.ts
// READS a workspace declaration and answers ONE question: does this container's
// declaration POSITIVELY claim that descendant as a member?
//
// WHY THIS IS SEPARATE FROM `dirDeclaresWorkspace`. That predicate answers "may
// this directory ANCHOR resolution", and it is lenient on purpose — the cost of
// a false positive there is resolving up one level (hook/paths.ts:182-185). The
// same answer is also consumed by shared/retention.ts isLeakedNestedRoot, where
// the cost of a false positive is DELETING a project's `.traffic-one`. Measured
// on the polyglot workspace fixture (test-environment/core/polyglot-workspace.ts):
// a container `package.json` carrying `workspaces: ['packages/*']` with no
// `packages/` directory on disk made all three independently onboarded members —
// one node, one Go, one Python — climb past their own mode-bearing `.one.json`
// onto the container, and the SessionStart sweep planned deletion of all three.
//
// The two consumers cannot share one predicate because their SAFE DIRECTIONS ARE
// OPPOSITE. When the declaration cannot be read, resolution is safest climbing
// (a miss mints a stray `.traffic-one` into a sub-package) and deletion is safest
// refusing (a miss destroys real project state). So this module answers only the
// deletion-authority question, and answers it NEGATIVELY whenever it is not sure:
// an unreadable file, a syntax outside the subset below, or a single pattern it
// cannot compile all yield "no claim". Resolution keeps its leniency untouched —
// `dirDeclaresWorkspace` is not routed through here, so the resolution hot path
// pays no extra file read either.
//
// Dependency-free by contract (the hook runtime ships no npm packages), so both
// the pnpm YAML reader and the glob matcher are hand-written and deliberately
// cover a NAMED SUBSET rather than pretending to be general.

import * as fs from 'fs';
import * as path from 'path';

import { readJson } from '../fsjson';

/**
 * What a container's declaration says about its members.
 *
 * `opaque` is the load-bearing arm: the directory DOES declare a workspace (so
 * `dirDeclaresWorkspace` still says yes and resolution is unchanged) but the
 * member list could not be established, so no deletion may be justified by it.
 */
export type WorkspaceDeclaration =
  | { readonly kind: 'none' }
  | { readonly kind: 'opaque'; readonly why: string }
  | { readonly kind: 'patterns'; readonly patterns: readonly string[] };

type Rec = Record<string, unknown>;

const PNPM_WORKSPACE_FILES = ['pnpm-workspace.yaml', 'pnpm-workspace.yml'] as const;

// ── declaration shapes ───────────────────────────────────────────────────────
// Handled: npm/yarn/bun `workspaces: [...]`, `workspaces: { packages: [...] }`,
// and a pnpm-workspace.yaml/.yml `packages:` list (block or flow).
// Declined, each to the no-authority side: any other YAML shape, a non-string
// pattern entry, and a pattern using brace/extglob/character-class syntax.

export function readWorkspaceDeclaration(dir: string): WorkspaceDeclaration {
  const resolved = path.resolve(dir);
  // pnpm first, matching dirDeclaresWorkspace's own order: a repo carrying both
  // files is a pnpm workspace, and package.json `workspaces` is then inert.
  for (const name of PNPM_WORKSPACE_FILES) {
    const file = path.join(resolved, name);
    if (!fs.existsSync(file)) continue;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // The declaration exists and we cannot see through it. It still anchors
      // resolution; it grants nothing here.
      return { kind: 'opaque', why: `${name} is unreadable (${String(error)})` };
    }
    return compile(parsePnpmPackages(text), name);
  }

  const pkg = readJson<Rec>(path.join(resolved, 'package.json'), {} as Rec);
  const ws = pkg ? pkg.workspaces : undefined;
  // Both arms mirror dirDeclaresWorkspace EXACTLY, including its asymmetry: the
  // array arm requires a non-empty list to count as a declaration at all, while
  // the object arm counts an empty `packages` array. Reproduced rather than
  // tidied, because a difference here would be a difference in what anchors
  // resolution — which this change is not permitted to move.
  if (Array.isArray(ws)) {
    if (ws.length === 0) return { kind: 'none' };
    return compile(ws.every((entry) => typeof entry === 'string') ? (ws as string[]) : null, 'package.json workspaces');
  }
  if (ws && typeof ws === 'object') {
    const packages = (ws as Rec).packages;
    if (!Array.isArray(packages)) return { kind: 'none' };
    return compile(
      packages.every((entry) => typeof entry === 'string') ? (packages as string[]) : null,
      'package.json workspaces.packages',
    );
  }
  return { kind: 'none' };
}

// A list is only usable when EVERY pattern in it compiles. One unreadable
// pattern poisons the whole declaration rather than being skipped, because the
// two ways to skip one are both wrong: dropping an unreadable POSITIVE only
// costs a missed cleanup, but dropping an unreadable NEGATIVE would delete a
// directory the author explicitly excluded.
function compile(patterns: readonly string[] | null, source: string): WorkspaceDeclaration {
  if (!patterns) return { kind: 'opaque', why: `${source} holds an entry this reader cannot parse` };
  for (const pattern of patterns) {
    if (!compilePattern(pattern)) return { kind: 'opaque', why: `${source} holds the unsupported pattern ${JSON.stringify(pattern)}` };
  }
  return { kind: 'patterns', patterns };
}

// ── pnpm-workspace.yaml, a named subset ──────────────────────────────────────
// Accepted: a top-level `packages:` key whose value is a block sequence of
// scalars (plain, single- or double-quoted), or a single-line flow sequence.
// Comments and blank lines are skipped; other top-level keys (pnpm 10 catalogs,
// overrides) are ignored.
//
// Returns null — "opaque" — for everything else, and the list of exclusions is
// the interesting part: document markers (`---`), a duplicate `packages:` key, a
// tab in leading whitespace, a `packages:` value that is a mapping or a scalar,
// a block item that is not `- <scalar>`, and any plain scalar opening with a
// YAML indicator (`*` alias, `&` anchor, `!` tag, `[`/`{` flow, `|`/`>` block
// scalar, `%` directive). That last one is why `- !packages/excluded` is
// declined: unquoted, YAML reads it as a TAG, and a reader that guessed it was
// a negated glob would be guessing about the one direction that adds deletions.
// pnpm's own documentation quotes negations, and a quoted `'!packages/x'` IS
// handled.
const YAML_INDICATORS = new Set(['*', '&', '!', '[', '{', '|', '>', '%', '@', '`', '#', ',', ']', '}']);

function parsePnpmPackages(text: string): readonly string[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let found: readonly string[] | null = null;
  let seenPackagesKey = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/^(---|\.\.\.)\s*$/.test(line)) return null; // multi-document or directives end
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.includes('\t')) return null;          // tabs are not YAML indentation
    const body = line.slice(indent.length);
    if (!body || body.startsWith('#')) continue;
    if (indent.length > 0) continue;                 // inside some other key's block

    const key = /^([A-Za-z0-9_.-]+):(.*)$/.exec(body);
    if (!key) return null;                           // a top-level line we do not understand
    if (key[1] !== 'packages') continue;
    if (seenPackagesKey) return null;                // duplicate key: last-wins is a guess
    seenPackagesKey = true;

    const inline = stripComment(key[2]!.trim());
    if (inline) {
      const flow = parseFlowSequence(inline);
      if (!flow) return null;
      found = flow;
      continue;
    }
    const block = parseBlockSequence(lines, i + 1);
    if (!block) return null;
    found = block.items;
    i = block.nextIndex - 1;
  }

  // A pnpm file with no `packages:` key declares a workspace whose only member
  // is the root, so it claims no descendant. Same answer as `opaque` here, but
  // it is a DIFFERENT fact and the empty list says so.
  return found ?? [];
}

function parseBlockSequence(lines: readonly string[], start: number): { items: string[]; nextIndex: number } | null {
  const items: string[] = [];
  let i = start;
  for (; i < lines.length; i += 1) {
    const line = lines[i]!;
    const indent = /^[ \t]*/.exec(line)![0];
    if (indent.includes('\t')) return null;
    const body = line.slice(indent.length);
    if (!body) continue;
    if (body.startsWith('#')) continue;
    if (indent.length === 0) break;                  // the block ended at the next top-level key
    const item = /^-\s+(.*)$/.exec(body);
    if (!item) return null;                          // a nested mapping, or `-` with no value
    const scalar = parseScalar(item[1]!);
    if (scalar === null) return null;
    items.push(scalar);
  }
  return { items, nextIndex: i };
}

function parseFlowSequence(text: string): string[] | null {
  if (!text.startsWith('[') || !text.endsWith(']')) return null;
  const inner = text.slice(1, -1).trim();
  if (!inner) return [];
  const items: string[] = [];
  let current = '';
  let quote = '';
  for (const ch of inner) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { items.push(current); current = ''; continue; }
    current += ch;
  }
  if (quote) return null;                            // unterminated quote
  items.push(current);
  const out: string[] = [];
  for (const raw of items) {
    const scalar = parseScalar(raw.trim());
    if (scalar === null) return null;
    out.push(scalar);
  }
  return out;
}

/** A YAML scalar this reader is willing to vouch for, or null for "cannot tell". */
function parseScalar(raw: string): string | null {
  if (!raw) return null;
  const first = raw[0]!;
  if (first === "'") {
    if (raw.length < 2 || !raw.endsWith("'")) return null;
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (first === '"') {
    if (raw.length < 2 || !raw.endsWith('"')) return null;
    const inner = raw.slice(1, -1);
    if (inner.includes('\\')) return null;           // escape sequences are not interpreted here
    return inner;
  }
  if (YAML_INDICATORS.has(first)) return null;
  const plain = stripComment(raw).trim();
  return plain || null;
}

// A `#` only starts a comment when preceded by whitespace, so a `#` inside a
// path-like scalar survives.
function stripComment(text: string): string {
  const at = text.search(/(^|\s)#/);
  return at < 0 ? text : text.slice(0, at);
}

// ── membership ───────────────────────────────────────────────────────────────

/**
 * Does `root`'s workspace declaration positively claim `descendant`?
 *
 * The answer is yes when a declared pattern matches the descendant's path
 * relative to the root, OR matches an ANCESTOR of it below the root: a stray
 * `packages/ui/sub/.traffic-one` sits inside the declared member `packages/ui`
 * and is the workspace's own leak just as much as one at `packages/ui` is.
 * Without the ancestor arm this change would have withdrawn deletion authority
 * from strays nested inside genuine members, which is a bigger retreat than the
 * defect warrants.
 *
 * Negative patterns are applied per candidate: a candidate matched by a `!`
 * pattern is not claimed, even if a positive pattern also matches it.
 */
export function workspaceClaimsDescendant(root: string, descendant: string): boolean {
  const declaration = readWorkspaceDeclaration(root);
  if (declaration.kind !== 'patterns') return false;
  const rel = path.relative(path.resolve(root), path.resolve(descendant)).replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.startsWith('../')) return false;
  const compiled: { negated: boolean; segments: readonly string[] }[] = [];
  for (const pattern of declaration.patterns) {
    const segments = compilePattern(pattern);
    if (!segments) return false;                     // unreachable: readWorkspaceDeclaration pre-compiles
    compiled.push({ negated: pattern.startsWith('!'), segments });
  }
  const parts = rel.split('/');
  for (let depth = parts.length; depth >= 1; depth -= 1) {
    if (claims(compiled, parts.slice(0, depth))) return true;
  }
  return false;
}

function claims(
  patterns: readonly { negated: boolean; segments: readonly string[] }[],
  candidate: readonly string[],
): boolean {
  let positive = false;
  for (const { negated, segments } of patterns) {
    if (!matchSegments(segments, candidate)) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

// ── the glob subset ──────────────────────────────────────────────────────────
// Supported: `*` (within one path segment), `**` (one or more whole segments,
// or zero when it sits between two other segments, matching minimatch), `?`, a
// leading `!` negation, and literal segments. `./` prefixes and trailing
// slashes are normalized away.
//
// Declined (the pattern is unsupported, so the whole declaration goes opaque):
// brace expansion `{a,b}`, character classes `[a-z]`, and extglob `?(…)`/`!(…)`
// — every extglob form carries a parenthesis, so the three characters below
// cover all of them. Those are matchable by minimatch and this reader has no
// business guessing at them when the outcome is a deletion. `+`, `@`, `^` and
// `$` are NOT listed: outside an extglob they are ordinary characters in a
// directory name (`packages/@scope/*` is a real pnpm pattern) and
// `segmentMatches` escapes them.
const UNSUPPORTED_GLOB_SYNTAX = /[{}[\]()]/;

/** Pattern → segment list, or null when the syntax is outside the subset. */
function compilePattern(pattern: string): readonly string[] | null {
  if (typeof pattern !== 'string') return null;
  const body = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (UNSUPPORTED_GLOB_SYNTAX.test(body)) return null;
  const normalized = body.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments;
}

function matchSegments(pattern: readonly string[], candidate: readonly string[]): boolean {
  if (pattern.length === 0) return candidate.length === 0;
  const [head, ...rest] = pattern;
  if (head === '**') {
    // Trailing `**` needs at least one segment (`a/**` does not match `a`);
    // between segments it may consume none (`a/**/b` matches `a/b`).
    if (rest.length === 0) return candidate.length >= 1;
    for (let skip = 0; skip <= candidate.length; skip += 1) {
      if (matchSegments(rest, candidate.slice(skip))) return true;
    }
    return false;
  }
  if (candidate.length === 0) return false;
  return segmentMatches(head!, candidate[0]!) && matchSegments(rest, candidate.slice(1));
}

function segmentMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === name;
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') { source += '[^/]*'; continue; }
    if (ch === '?') { source += '[^/]'; continue; }
    source += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`).test(name);
}
