// src/shared/windsurf-rules.ts
// Shared renderer for Devin Desktop / Windsurf Cascade workspace rules.

import * as path from 'path';

import { GENERATED_MARKER } from './materialize/generated';

export interface WindsurfRuleDocument { relPath: string; content: string; }

export const WINDSURF_RULES_REL = path.join('.devin', 'rules');
export const WINDSURF_RULE_CHAR_LIMIT = 12000;

const BODY_CHUNK_LIMIT = 10500;

const WINDSURF_ALWAYS_KERNEL = new Set([
  'core.md',
  'common/auth-gate.md',
  'common/setup-gate.md',
  'common/skill-precedence.md',
  'common/execution-discipline.md',
  'common/security.md',
  'common/clean-code.md',
]);

interface SplitResult { frontmatterLines: string[]; body: string; }
interface ParsedFrontmatter { paths: string[]; description: string | null; alwaysApply: boolean | null; }

function splitFrontmatter(markdown: string): SplitResult {
  const lines = markdown.split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { frontmatterLines: [], body: markdown };
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      return { frontmatterLines: lines.slice(1, i), body: lines.slice(i + 1).join('\n').replace(/^\n+/, '') };
    }
  }
  return { frontmatterLines: [], body: markdown };
}

function parseScalar(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return '';
  try {
    const decoded = JSON.parse(cleaned) as unknown;
    return typeof decoded === 'string' ? decoded : cleaned;
  } catch {
    return cleaned.replace(/^["']|["']$/g, '');
  }
}

function parseInlineList(value: string): string[] {
  try {
    const decoded = JSON.parse(value) as unknown;
    return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseFrontmatter(lines: readonly string[]): ParsedFrontmatter {
  const paths: string[] = [];
  let description: string | null = null;
  let alwaysApply: boolean | null = null;
  let inPaths = false;

  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith('#')) continue;

    if (stripped.startsWith('paths:')) {
      inPaths = true;
      const inlineValue = stripped.slice(stripped.indexOf(':') + 1).trim();
      if (inlineValue.startsWith('[')) {
        paths.push(...parseInlineList(inlineValue));
        inPaths = false;
      }
      continue;
    }

    if (inPaths) {
      const itemMatch = rawLine.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch && itemMatch[1] !== undefined) {
        paths.push(parseScalar(itemMatch[1]));
        continue;
      }
      inPaths = false;
    }

    if (stripped.startsWith('description:')) {
      description = parseScalar(stripped.slice(stripped.indexOf(':') + 1));
      continue;
    }

    if (stripped.startsWith('alwaysApply:')) {
      const value = stripped.slice(stripped.indexOf(':') + 1).trim().toLowerCase();
      if (value === 'true' || value === 'false') alwaysApply = value === 'true';
    }
  }

  return { paths, description, alwaysApply };
}

function titleFromBody(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith('# ')) return stripped.slice(2).trim();
  }
  return fallback;
}

function titleCase(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function slugForRule(ruleRel: string): string {
  let parts = ruleRel.replace(/\.md$/, '').split('/');
  if (parts[0] === 'common' && parts[1] === 'auth-gate') return 'auth-required';
  if (parts[0] === 'frontend' && (parts[1] === 'react' || parts[1] === 'react-native' || parts[1] === 'ionic')) {
    parts = parts.slice(1);
  } else if (parts[0] === 'modes') {
    parts = ['mode', ...parts.slice(1)];
  }
  return parts.join('-');
}

function sourceSlug(sourceRel: string): string {
  const rel = toPosix(sourceRel);
  if (rel.startsWith('agents/')) return `00-agent-${path.posix.basename(rel, '.md')}`;
  if (rel.startsWith('rules/')) return slugForRule(rel.slice('rules/'.length));
  return rel.replace(/\.md$/, '').split('/').join('-');
}

function chunksFor(body: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    const trimmed = current.trimEnd();
    if (trimmed) chunks.push(trimmed);
    current = '';
  };

  for (const line of body.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > limit) {
      flush();
      current = line;
    } else {
      current = next;
    }
  }
  flush();
  return chunks.length > 0 ? chunks : [''];
}

function triggerFor(sourceRel: string, ruleRel: string, paths: readonly string[], explicitAlwaysApply: boolean | null): string {
  if (sourceRel.startsWith('agents/')) return 'model_decision';
  if (paths.length > 0) return 'glob';
  if (explicitAlwaysApply !== null) return explicitAlwaysApply ? 'always_on' : 'model_decision';
  return WINDSURF_ALWAYS_KERNEL.has(ruleRel) ? 'always_on' : 'model_decision';
}

function frontmatter(trigger: string, description: string, paths: readonly string[]): string[] {
  const lines = ['---', `trigger: ${trigger}`, `description: ${JSON.stringify(description)}`];
  if (trigger === 'glob' && paths.length > 0) lines.push(`globs: ${JSON.stringify(paths.join(', '))}`);
  lines.push('---');
  return lines;
}

export function renderWindsurfRuleDocs(sourceRel: string, sourceText: string): WindsurfRuleDocument[] {
  const rel = toPosix(sourceRel);
  const isAgent = rel.startsWith('agents/');
  const ruleRel = rel.startsWith('rules/') ? rel.slice('rules/'.length) : rel;
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const parsed = parseFrontmatter(frontmatterLines);
  const fallbackTitle = titleCase(path.posix.basename(rel, '.md'));
  const title = titleFromBody(body, fallbackTitle);
  const description = parsed.description || `${title}. Generated from ${rel}.`;
  const trigger = triggerFor(rel, ruleRel, parsed.paths, parsed.alwaysApply);
  const marker = `${GENERATED_MARKER}\n<!-- GENERATED FROM: ${rel}; run \`npm run gen\` to update. -->`;
  const renderedBody = isAgent
    ? [
      'Mirrored Traffic One role context. On Devin Local this role also has a native custom profile at `.devin/agents/<role>/AGENT.md` — the orchestrator spawns it by name with the `run_subagent` tool (see the senior-eng-orchestrator skill). Use this doc as that subagent’s role contract; if `run_subagent` is unavailable on an older single-agent build, use it as on-demand guidance instead.',
      '',
      body.trimEnd(),
    ].join('\n')
    : body.trimEnd();

  const chunks = chunksFor(renderedBody, BODY_CHUNK_LIMIT);
  const slug = sourceSlug(rel);
  const docs = chunks.map((chunk, index) => {
    const multi = chunks.length > 1;
    const partSuffix = multi ? `-${String(index + 1).padStart(2, '0')}` : '';
    const partNote = multi ? `Part ${index + 1} of ${chunks.length}. ` : '';
    const content = [
      ...frontmatter(trigger, `${partNote}${description}`, parsed.paths),
      '',
      marker,
      '',
      ...(multi ? [`# ${title} (Part ${index + 1})`, ''] : []),
      chunk,
      '',
    ].join('\n');
    return { relPath: path.join(WINDSURF_RULES_REL, `${slug}${partSuffix}.md`), content };
  });
  return docs.filter((doc) => doc.content.length <= WINDSURF_RULE_CHAR_LIMIT);
}
