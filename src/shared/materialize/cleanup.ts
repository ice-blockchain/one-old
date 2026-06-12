// src/shared/materialize/cleanup.ts
// Previous-manifest load + stale-asset cleanup + legacy migration helpers.
// Ported 1:1 from scripts/hook-runtime/materialize/_helpers.cjs.

import * as fs from 'fs';
import * as path from 'path';

import { readText } from '../fsjson';
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

export function migrateLegacyMemoryFile(cwd: string, fileName: string): boolean {
  const legacyPath = path.join(cwd, '.traffic-one', 'rules', fileName);
  const targetPath = path.join(cwd, '.traffic-one', fileName);
  if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isDirectory()) return false;
  if (!fs.existsSync(targetPath)) {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.renameSync(legacyPath, targetPath);
    return true;
  }
  if (readText(legacyPath) === readText(targetPath)) {
    fs.rmSync(legacyPath, { force: true });
    return true;
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

function migratedRootDocBlock(fileName: string, content: string): string {
  return [
    `## Migrated From Root \`${fileName}\``,
    '',
    `The notes below were moved from legacy root \`${fileName}\`. Keep future edits in \`.traffic-one/${fileName}\` so Traffic One project context stays compact.`,
    '',
    compactLegacyRootContent(content) || '_Empty legacy file._',
  ].join('\n');
}

export function migrateLegacyRootDocumentationFile(cwd: string, fileName: string): boolean {
  const legacyPath = path.join(cwd, fileName);
  const targetPath = path.join(cwd, '.traffic-one', fileName);
  if (!fs.existsSync(legacyPath) || fs.lstatSync(legacyPath).isDirectory()) return false;

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (!fs.existsSync(targetPath)) {
    fs.renameSync(legacyPath, targetPath);
    return true;
  }

  const legacyText = readText(legacyPath) ?? '';
  const targetText = readText(targetPath) ?? '';
  const legacyNorm = normalizeMarkdown(legacyText);
  const targetNorm = normalizeMarkdown(targetText);

  if (!legacyNorm || targetNorm === legacyNorm || targetNorm.includes(legacyNorm)) {
    fs.rmSync(legacyPath, { force: true });
    return true;
  }

  if (!targetNorm) {
    fs.writeFileSync(targetPath, `${legacyText.trimEnd()}\n`, 'utf8');
    fs.rmSync(legacyPath, { force: true });
    return true;
  }

  const marker = `## Migrated From Root \`${fileName}\``;
  if (!targetText.includes(marker)) {
    fs.writeFileSync(
      targetPath,
      `${targetText.trimEnd()}\n\n${migratedRootDocBlock(fileName, legacyText)}\n`,
      'utf8',
    );
  }
  fs.rmSync(legacyPath, { force: true });
  return true;
}

export function migrateLegacyRootDocumentation(cwd: string): number {
  let migrated = 0;
  for (const fileName of LEGACY_ROOT_DOCUMENTATION_FILES) {
    if (migrateLegacyRootDocumentationFile(cwd, fileName)) migrated += 1;
  }
  return migrated;
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
  removed += migrateLegacyRootDocumentation(cwd);

  const prevSkills = Array.isArray(previous.skills) ? (previous.skills as string[]) : [];
  for (const name of prevSkills) {
    if (nextSkillNames.has(name)) continue;
    if (removeGeneratedSkillDir(path.join(skillsRoot, name))) removed += 1;
  }
  return removed;
}

export function modeRulesForState(root: string, state: Rec): string[] {
  const mode = state && typeof state.mode === 'string' ? state.mode : '';
  if (!mode) return [];
  const relPath = `rules/modes/${mode}.md`;
  if (!fs.existsSync(path.join(root, templatePath(relPath)))) return [];
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
