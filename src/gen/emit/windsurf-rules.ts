// src/gen/emit/windsurf-rules.ts
// Emits Devin Desktop / Windsurf Cascade workspace rules from generated rules
// and agent role docs.

import * as fs from 'fs';
import * as path from 'path';

import { pluginRoot } from '../../shared/paths';
import { renderWindsurfRuleDocs, type WindsurfRuleDocument } from '../../shared/windsurf-rules';
import type { GenRun } from '../lib/run';
import { toPosix, walkMarkdownFiles } from '../lib/frontmatter';

export function generatedWindsurfRules(repoRoot: string = pluginRoot()): WindsurfRuleDocument[] {
  const rulesRoot = path.join(repoRoot, 'rules');
  const agentsRoot = path.join(repoRoot, 'agents');
  const ruleDocs = walkMarkdownFiles(rulesRoot, repoRoot)
    .flatMap((source) => renderWindsurfRuleDocs(`rules/${toPosix(path.relative(rulesRoot, source))}`, fs.readFileSync(source, 'utf8')));
  const agentDocs = walkMarkdownFiles(agentsRoot, repoRoot)
    .filter((source) => !source.endsWith('.agent.md'))
    .flatMap((source) => renderWindsurfRuleDocs(`agents/${toPosix(path.relative(agentsRoot, source))}`, fs.readFileSync(source, 'utf8')));
  return [...ruleDocs, ...agentDocs];
}

export function emitWindsurfRules(run: GenRun): void {
  const docs = [
    ...run.emitted('rules/').filter((doc) => doc.relPath.endsWith('.md'))
      .flatMap((doc) => renderWindsurfRuleDocs(doc.relPath, doc.content)),
    ...run.emitted('agents/').filter((doc) => doc.relPath.endsWith('.md') && !doc.relPath.endsWith('.agent.md'))
      .flatMap((doc) => renderWindsurfRuleDocs(doc.relPath, doc.content)),
  ];
  for (const doc of docs) run.file(doc.relPath, doc.content);
}
