// src/gen/emit/cursor-rules.ts
// Emits .cursor/rules/*.mdc from the rule templates (rules-templates/**) and the
// agent role docs (agents/*.md). Absorbs the legacy Cursor sync task. Byte-identical
// to the committed .mdc files (golden-verified). The "GENERATED FROM … run
// `npm run gen`" header is load-bearing for stale-rule detection + the snapshot.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRoot } from '../../shared/paths';
import type { GenRun } from '../lib/run';
import {
  cursorFrontmatter,
  parseFrontmatter,
  splitFrontmatter,
  titleFromBody,
  toPosix,
  walkMarkdownFiles,
} from '../lib/frontmatter';

export interface RuleDocument { relPath: string; content: string; }

function titleCase(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeTo(repoRoot: string, filePath: string): string {
  return toPosix(path.relative(repoRoot, filePath));
}

function slugForSource(sourcePath: string, rulesRoot: string): string {
  const sourceWithoutSuffix = path.relative(rulesRoot, sourcePath).replace(/\.md$/, '');
  let parts = toPosix(sourceWithoutSuffix).split('/');
  if (parts[0] === 'common' && parts[1] === 'auth-gate') {
    return 'auth-required';
  }
  if (parts[0] === 'frontend' && parts[1] === 'react') {
    parts = parts.slice(1);
  } else if (parts[0] === 'frontend' && parts[1] === 'react-native') {
    parts = parts.slice(1);
  } else if (parts[0] === 'frontend' && parts[1] === 'ionic') {
    parts = parts.slice(1);
  } else if (parts[0] === 'modes') {
    parts = ['mode', ...parts.slice(1)];
  }
  return parts.join('-');
}

function shouldAlwaysApply(sourcePath: string, paths: string[], explicit: boolean | null, rulesRoot: string): boolean {
  if (explicit !== null) return explicit;
  if (paths.length > 0) return false;
  const relativeParts = toPosix(path.relative(rulesRoot, sourcePath)).split('/');
  return relativeParts[0] !== 'modes';
}

function renderCursorRule(sourcePath: string, repoRoot: string, rulesRoot: string): RuleDocument {
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { paths, description: frontmatterDescription, alwaysApply: explicitAlwaysApply } = parseFrontmatter(frontmatterLines);
  const sourceRelative = relativeTo(repoRoot, sourcePath);
  const fallbackTitle = titleCase(path.basename(sourcePath, '.md'));
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const alwaysApply = shouldAlwaysApply(sourcePath, paths, explicitAlwaysApply, rulesRoot);
  const relPath = path.join('.cursor', 'rules', `${slugForSource(sourcePath, rulesRoot)}.mdc`);

  const contentLines = [
    `<!-- GENERATED FROM: ${sourceRelative}; run \`npm run gen\` to update. -->`,
    ...cursorFrontmatter(description, paths, alwaysApply),
    '',
    body.trimEnd(),
    '',
  ];
  return { relPath, content: contentLines.join('\n') };
}

function renderAgentRule(sourcePath: string, repoRoot: string): RuleDocument {
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { description: frontmatterDescription } = parseFrontmatter(frontmatterLines);
  const sourceRelative = relativeTo(repoRoot, sourcePath);
  const baseName = path.basename(sourcePath, '.md');
  const fallbackTitle = titleCase(baseName);
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const relPath = path.join('.cursor', 'rules', `00-agent-${baseName}.mdc`);

  const note = '> Mirrored from ' + sourceRelative + ' — Cursor has no first-class '
    + 'subagents; treat this as an always-on role context. The orchestrator skill '
    + '(`senior-eng-orchestrator`) describes how the roles compose.';

  const contentLines = [
    `<!-- GENERATED FROM: ${sourceRelative}; run \`npm run gen\` to update. -->`,
    ...cursorFrontmatter(description, [], true),
    '',
    note,
    '',
    body.trimEnd(),
    '',
  ];
  return { relPath, content: contentLines.join('\n') };
}

export function generatedCursorRules(repoRoot: string = pluginRoot()): RuleDocument[] {
  const rulesRoot = path.join(repoRoot, 'rules-templates');
  const agentsRoot = path.join(repoRoot, 'agents');
  const ruleDocs = walkMarkdownFiles(rulesRoot, repoRoot).map((source) => renderCursorRule(source, repoRoot, rulesRoot));
  const agentDocs = walkMarkdownFiles(agentsRoot, repoRoot).map((source) => renderAgentRule(source, repoRoot));
  return [...ruleDocs, ...agentDocs];
}

export function emitCursorRules(run: GenRun): void {
  for (const doc of generatedCursorRules(run.root)) {
    run.file(doc.relPath, doc.content);
  }
}
