// src/gen/emit/cursor-rules.ts
// Emits .cursor/rules/*.mdc from the rule templates (rules/**) and the
// agent role docs (agents/*.md). Absorbs the legacy Cursor sync task. The
// "GENERATED FROM … run `npm run gen`" marker is load-bearing for stale-rule
// detection + the snapshot.
//
// Token economy: Cursor attaches every alwaysApply rule body to every request,
// so only a small behavioral kernel stays always-on. Everything else ships
// agent-requested (description-only frontmatter) or glob-scoped, mirroring the
// lean pointer-index design used on Claude Code and Codex.

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
import * as fs from 'fs';

export interface RuleDocument { relPath: string; content: string; }

// Rules (paths relative to rules/) whose full body stays attached to every
// Cursor request. Everything else without globs becomes agent-requested via
// its description. Keep this set small: it is a per-request token cost.
const CURSOR_ALWAYS_KERNEL = new Set([
  'core.md',
  'common/auth-gate.md',
  'common/setup-gate.md',
  'common/skill-precedence.md',
  'common/execution-discipline.md',
  'common/security.md',
  'common/clean-code.md',
]);

function titleCase(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugForRule(ruleRel: string): string {
  let parts = ruleRel.replace(/\.md$/, '').split('/');
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

function shouldAlwaysApply(ruleRel: string, paths: string[], explicit: boolean | null): boolean {
  if (explicit !== null) return explicit;
  if (paths.length > 0) return false;
  return CURSOR_ALWAYS_KERNEL.has(ruleRel);
}

// ruleRel is the rule's path under rules/ (posix), sourceText its emitted content.
function renderCursorRule(ruleRel: string, sourceText: string): RuleDocument {
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { paths, description: frontmatterDescription, alwaysApply: explicitAlwaysApply } = parseFrontmatter(frontmatterLines);
  const sourceRelative = `rules/${ruleRel}`;
  const fallbackTitle = titleCase(path.posix.basename(ruleRel, '.md'));
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const alwaysApply = shouldAlwaysApply(ruleRel, paths, explicitAlwaysApply);
  const relPath = path.join('.cursor', 'rules', `${slugForRule(ruleRel)}.mdc`);

  const contentLines = [
    ...cursorFrontmatter(description, paths, alwaysApply),
    `<!-- GENERATED FROM: ${sourceRelative}; run \`npm run gen\` to update. -->`,
    '',
    body.trimEnd(),
    '',
  ];
  return { relPath, content: contentLines.join('\n') };
}

// agentRel is the agent doc's filename under agents/ (posix, flat).
function renderAgentRule(agentRel: string, sourceText: string): RuleDocument {
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { description: frontmatterDescription } = parseFrontmatter(frontmatterLines);
  const sourceRelative = `agents/${agentRel}`;
  const baseName = path.posix.basename(agentRel, '.md');
  const fallbackTitle = titleCase(baseName);
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const relPath = path.join('.cursor', 'rules', `00-agent-${baseName}.mdc`);

  // Cursor IS a first-class subagent host (Traffic One materializes
  // `.cursor/agents/<role>.md` per project and spawns each role through `Task`).
  // The old note claimed the opposite in EVERY generated role rule, contradicting
  // the orchestrator skill and giving the agent a reason to simulate the team.
  const note = '> Mirrored from ' + sourceRelative + ' — Cursor also attaches this role '
    + 'context on demand from the description. Spawning this role as a real subagent '
    + 'uses `Task` with the `subagent_type` from the model-gate spawn map; the '
    + 'orchestrator skill (`senior-eng-orchestrator`) describes how the roles compose.';

  const contentLines = [
    ...cursorFrontmatter(description, [], false),
    `<!-- GENERATED FROM: ${sourceRelative}; run \`npm run gen\` to update. -->`,
    '',
    note,
    '',
    body.trimEnd(),
    '',
  ];
  return { relPath, content: contentLines.join('\n') };
}

// Walk a generated plugin tree on disk (tests + tooling). The gen pipeline
// itself uses emitCursorRules, which derives from the current run's emitted
// content instead of reading the output tree back.
export function generatedCursorRules(repoRoot: string = pluginRoot()): RuleDocument[] {
  const rulesRoot = path.join(repoRoot, 'rules');
  const agentsRoot = path.join(repoRoot, 'agents');
  const ruleDocs = walkMarkdownFiles(rulesRoot, repoRoot)
    .map((source) => renderCursorRule(toPosix(path.relative(rulesRoot, source)), fs.readFileSync(source, 'utf8')));
  const agentDocs = walkMarkdownFiles(agentsRoot, repoRoot)
    .filter((source) => !source.endsWith('.agent.md'))
    .map((source) => renderAgentRule(toPosix(path.relative(agentsRoot, source)), fs.readFileSync(source, 'utf8')));
  return [...ruleDocs, ...agentDocs];
}

export function emitCursorRules(run: GenRun): void {
  // Derive from this run's emitted rules/ + agents/ trees (not the on-disk
  // output), so --check reports .mdc drift caused by source rule/agent edits.
  const docs = [
    ...run.emitted('rules/').filter((doc) => doc.relPath.endsWith('.md'))
      .map((doc) => renderCursorRule(doc.relPath.slice('rules/'.length), doc.content)),
    ...run.emitted('agents/').filter((doc) => doc.relPath.endsWith('.md') && !doc.relPath.endsWith('.agent.md'))
      .map((doc) => renderAgentRule(doc.relPath.slice('agents/'.length), doc.content)),
  ];
  for (const doc of docs) {
    run.file(doc.relPath, doc.content);
  }
}
