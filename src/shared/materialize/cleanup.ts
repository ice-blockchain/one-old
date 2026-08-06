// src/shared/materialize/cleanup.ts
// Previous-manifest load + stale-asset cleanup + legacy migration helpers.
// Ported 1:1 from scripts/hook-runtime/materialize/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { movePath, readText, removePath, writeTextFile } from '../fsjson';
import { templatePath } from '../stacks';
import { removeGeneratedFile, removeGeneratedManifest, removeGeneratedSkillDir, removeGeneratedTree } from './generated';

type Rec = Record<string, unknown>;

export function loadPreviousManifest(cwd: string): Rec {
  const candidates = [
    path.join(cwd, '.traffic-one', 'manifest.json'),
    path.join(cwd, '.traffic-one', 'rules', 'manifest.json'),
  ];
  for (const manifestPath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed as Rec;
    } catch {
      // try the next candidate
    }
  }
  return {};
}

function migrateLegacyMemoryFile(cwd: string, fileName: string): boolean {
  const legacyPath = path.join(cwd, '.traffic-one', 'rules', fileName);
  const targetPath = path.join(cwd, '.traffic-one', fileName);
  if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isDirectory()) return false;
  if (!fs.existsSync(targetPath)) {
    return movePath(legacyPath, targetPath);
  }
  if (readText(legacyPath) === readText(targetPath)) {
    return removePath(legacyPath);
  }
  return false;
}

const LEGACY_ROOT_DOCUMENTATION_FILES = [
  'api.md',
  'database.md',
  'deployment.md',
  'environment-setup.md',
  'security.md',
];

function normalizeMarkdown(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

function compactLegacyRootContent(content: string): string {
  const lines = content.trim().split('\n');
  if (lines[0] && /^#\s+/.test(lines[0])) {
    lines.shift();
    while (lines[0] === '') lines.shift();
  }
  return lines.join('\n').trim();
}

// What a migrated block actually EMBEDS — one authority, so the "did the carry
// land" check below cannot drift from the text the block carries. The heading is
// dropped because the target owns its own (`# Security Memory` + `## Migrated
// From Root security.md` reads correctly; two H1s do not), and a heading-only
// file falls back to the whole thing rather than being reduced to a placeholder
// that carries none of its bytes.
function migratedBody(content: string): string {
  const normalized = normalizeMarkdown(content);
  return compactLegacyRootContent(normalized) || normalized || '_Empty legacy file._';
}

function rootDocMarker(fileName: string): string {
  return `## Migrated From Root \`${fileName}\``;
}

// The heading is the marker and repeats on every block; the guidance sentence
// does not. A root file the owner rewrites can be carried here more than once,
// and project memory rides in an agent's context — the same paragraph twice is
// tokens spent saying nothing new.
function migratedRootDocBlock(fileName: string, content: string, withGuidance: boolean): string {
  return [
    rootDocMarker(fileName),
    '',
    ...(withGuidance
      ? [`The notes below were copied from legacy root \`${fileName}\`. Keep future edits in \`.traffic-one/${fileName}\` so Traffic One project context stays compact.`, '']
      : []),
    migratedBody(content),
  ].join('\n');
}

/**
 * COPY a legacy root documentation file's content into `.traffic-one/`.
 *
 * It used to MOVE it, unconditionally, for every consenting project — no mode
 * gate, no evidence of any kind. `api.md`, `database.md`, `deployment.md`,
 * `environment-setup.md` and `security.md` are ordinary filenames that a huge
 * number of repositories use for their own purposes, so a documentation
 * repository simply lost all five from its root on the first materialization
 * (measured: `D api.md | D database.md | D deployment.md | D environment-setup.md
 * | D security.md`, on a repo with committed history that Traffic One had never
 * written a byte into).
 *
 * The move was never defensible, because Traffic One CANNOT PROVE it wrote these
 * files. They are the old project-memory convention, authored by agents
 * following prose — they carry no generated marker, and no on-disk signal
 * distinguishes "Traffic One's legacy output" from "the user's own API
 * reference". A previous-manifest gate would only delay the deletion by one run,
 * since every consenting project acquires a manifest on its first
 * materialization. With ownership unprovable, the only branch that stays honest
 * is the one that never deletes: the canonical copy under `.traffic-one/` — the
 * one the rules, the architect's readiness check and the work-unit contract
 * actually read — is still created, which is the whole functional point of the
 * migration, and the file at the project root stays where its owner put it. The
 * auto-documentation skill still tells the AGENT to consolidate and remove root
 * copies; that is a visible action a user can see and stop, which a hook's
 * silent `rename()` is not.
 *
 * `readText`/`writeTextFile` rather than `movePath`: this is a copy, so the
 * fenced text writer is the right primitive, and the UTF-8 round trip it costs
 * is recoverable in a way the byte-preserving MOVE it replaces was not — the
 * source is still there.
 */
function adoptLegacyRootDocumentationFile(cwd: string, fileName: string): void {
  const rootPath = path.join(cwd, fileName);
  const targetPath = path.join(cwd, '.traffic-one', fileName);
  if (!fs.existsSync(rootPath) || fs.lstatSync(rootPath).isDirectory()) return;

  const rootText = readText(rootPath) ?? '';
  const rootNorm = normalizeMarkdown(rootText);
  if (!rootNorm) return;

  // No bare mkdir for `.traffic-one/`: writeTextFile creates its own parent, and
  // only once it has decided to write at all.
  const targetText = fs.existsSync(targetPath) ? (readText(targetPath) ?? '') : '';
  const targetNorm = normalizeMarkdown(targetText);
  if (!targetNorm) {
    writeTextFile(targetPath, `${rootText.trimEnd()}\n`);
    return;
  }
  // Already carried, either whole or as a previously appended block. Checking
  // the CONTENT and not the `## Migrated From Root` marker is the difference
  // between an idempotent no-op and skipping the carry for a root file the user
  // has since rewritten — the `&&` short-circuit this replaces did the latter,
  // and then deleted the source anyway.
  if (targetNorm.includes(rootNorm) || targetNorm.includes(migratedBody(rootNorm))) return;
  const block = migratedRootDocBlock(fileName, rootNorm, !targetText.includes(rootDocMarker(fileName)));
  writeTextFile(targetPath, `${targetText.trimEnd()}\n\n${block}\n`);
}

// Returns nothing to count: adoption COPIES, so it removes no path and must not
// inflate cleanupPrevious's removal total.
function adoptLegacyRootDocumentation(cwd: string): void {
  for (const fileName of LEGACY_ROOT_DOCUMENTATION_FILES) {
    adoptLegacyRootDocumentationFile(cwd, fileName);
  }
}

export function cleanupPrevious(cwd: string, previous: Rec, nextRulePaths: Set<string>, nextSkillNames: Set<string>): number {
  let removed = 0;
  const projectMemoryRoot = path.join(cwd, '.traffic-one');
  const legacyActiveRoot = path.join(cwd, '.traffic-one', 'rules', 'active');
  const skillsRoot = path.join(cwd, '.traffic-one', 'skills');

  const prevRules = Array.isArray(previous.rules) ? (previous.rules as string[]) : [];
  for (const relPath of prevRules) {
    if (removeGeneratedFile(path.join(legacyActiveRoot, relPath))) removed += 1;
    if (nextRulePaths.has(relPath)) continue;
    if (removeGeneratedFile(path.join(projectMemoryRoot, relPath))) removed += 1;
  }

  if (removeGeneratedTree(legacyActiveRoot)) removed += 1;
  if (removeGeneratedFile(path.join(cwd, '.traffic-one', 'rules', 'AGENTS.md'))) removed += 1;
  if (removeGeneratedManifest(path.join(cwd, '.traffic-one', 'rules', 'manifest.json'))) removed += 1;
  if (migrateLegacyMemoryFile(cwd, 'coding.md')) removed += 1;
  if (migrateLegacyMemoryFile(cwd, 'security.md')) removed += 1;
  adoptLegacyRootDocumentation(cwd);

  const prevSkills = Array.isArray(previous.skills) ? (previous.skills as string[]) : [];
  for (const name of prevSkills) {
    if (nextSkillNames.has(name)) continue;
    if (removeGeneratedSkillDir(path.join(skillsRoot, name))) removed += 1;
  }
  return removed;
}

const NEW_PROJECT_ARCHITECTURE_RULE = 'rules/modes/new-project-architecture.md';
const DEFAULT_VITE_NEW_PROJECT_SETUP_RULE = 'rules/modes/new-project-setup.md';

// Closed at compile time in this dependency-free materializer layer.
// profile-rule-routing.test.ts also compares it against the canonical runtime
// STRUCTURAL_PROFILE_IDS tuple, so either side changing alone fails the suite.
type StructuralProfileId =
  | 'vite-react'
  | 'next-app'
  | 'next-pages'
  | 'nuxt'
  | 'vue'
  | 'sveltekit'
  | 'svelte'
  | 'astro'
  | 'angular'
  | 'server-rendered'
  | 'generic-web'
  | 'unsupported-hybrid'
  | 'react-native'
  | 'swift-native'
  | 'kotlin-native'
  | 'flutter-native'
  | 'backend-only';

export const NEW_PROJECT_PROFILE_RULE_BY_ID: Readonly<Record<StructuralProfileId, string>> = {
  'vite-react': 'rules/modes/new-project-vite-react.md',
  'next-app': 'rules/modes/new-project-next-app.md',
  'next-pages': 'rules/modes/new-project-next-pages.md',
  nuxt: 'rules/modes/new-project-nuxt.md',
  vue: 'rules/modes/new-project-vue.md',
  sveltekit: 'rules/modes/new-project-sveltekit.md',
  svelte: 'rules/modes/new-project-svelte.md',
  astro: 'rules/modes/new-project-astro.md',
  angular: 'rules/modes/new-project-angular.md',
  'server-rendered': 'rules/modes/new-project-server-rendered.md',
  'generic-web': 'rules/modes/new-project-generic-web.md',
  'unsupported-hybrid': 'rules/modes/new-project-unsupported-hybrid.md',
  'react-native': 'rules/modes/new-project-react-native.md',
  'swift-native': 'rules/modes/new-project-swift-native.md',
  'kotlin-native': 'rules/modes/new-project-kotlin-native.md',
  'flutter-native': 'rules/modes/new-project-flutter-native.md',
  'backend-only': 'rules/modes/new-project-backend-only.md',
};

function profileRuleFor(profileId?: string): string | null {
  if (
    !profileId
    || !Object.prototype.hasOwnProperty.call(NEW_PROJECT_PROFILE_RULE_BY_ID, profileId)
  ) {
    return null;
  }
  return NEW_PROJECT_PROFILE_RULE_BY_ID[profileId as StructuralProfileId];
}

function defaultViteNewProject(state: Rec, profileId?: string): boolean {
  const defaultStack = state.stack === 'default' || state.stack === 'react-realtime-monorepo';
  return defaultStack && profileId === 'vite-react';
}

function existingRulePaths(root: string, relPaths: readonly string[]): string[] {
  return relPaths.filter((relPath) => fs.existsSync(path.join(root, templatePath(relPath))));
}

/**
 * Blocking mode rules. The new-project spine is universal and exactly one
 * profile rule is selected from the immutable runtime capability profile.
 * Missing/unknown profiles fail closed to the spine instead of guessing.
 */
export function modeRulesForState(root: string, state: Rec, profileId?: string): string[] {
  const mode = state && typeof state.mode === 'string' ? state.mode : '';
  if (!mode) return [];
  const relPath = `rules/modes/${mode}.md`;
  if (!fs.existsSync(path.join(root, templatePath(relPath)))) return [];
  // The mode guess selects GUIDANCE here, and every path it selects is copied
  // inside `.traffic-one/` — Traffic One's own space, re-derived on the next
  // converge. A wrong guess costs the agent the wrong rule doc to read, which is
  // what a guess is allowed to cost; no evidence veto belongs on this one.
  if (mode === 'new-project') {
    const profileRule = profileRuleFor(profileId);
    return [
      relPath,
      ...(profileRule && fs.existsSync(path.join(root, templatePath(profileRule)))
        ? [profileRule]
        : []),
    ];
  }
  // Large mode rules are split into on-demand slices named `<mode>-<topic>.md`
  // next to the spine; materialize whatever slices exist so the spine's
  // pointers resolve inside the project.
  const slices: string[] = [];
  try {
    const modesDir = path.dirname(path.join(root, templatePath(relPath)));
    for (const name of fs.readdirSync(modesDir).sort()) {
      if (name.startsWith(`${mode}-`) && name.endsWith('.md')) slices.push(`rules/modes/${name}`);
    }
  } catch {
    // best effort — the spine alone still materializes
  }
  return [relPath, ...slices];
}

/**
 * Every new project receives the universal architecture/control-plane index.
 * The detailed setup checklist remains exclusive to the default Vite profile.
 */
export function modeReferenceRulesForState(root: string, state: Rec, profileId?: string): string[] {
  const mode = state && typeof state.mode === 'string' ? state.mode : '';
  if (mode !== 'new-project') return [];
  return existingRulePaths(root, [
    NEW_PROJECT_ARCHITECTURE_RULE,
    ...(defaultViteNewProject(state, profileId)
      ? [DEFAULT_VITE_NEW_PROJECT_SETUP_RULE]
      : []),
  ]);
}
