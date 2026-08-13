// src/gen/lib/frontmatter.ts
// Markdown frontmatter parsing + Cursor-rule frontmatter rendering, ported 1:1
// from scripts/sync-cursor/_helpers.cjs. Pure string transforms shared by the
// .cursor/rules emitter (and, later, the AGENTS.md region emitter).

import * as fs from 'fs';
import * as path from 'path';

export function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

export function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

export function jsonArray(values: string[]): string {
  return `[${values.map((value) => jsonString(value)).join(', ')}]`;
}

export interface SplitResult { frontmatterLines: string[]; body: string; }

export function splitFrontmatter(markdown: string): SplitResult {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || (lines[0] ?? '').trim() !== '---') {
    return { frontmatterLines: [], body: markdown };
  }

  for (let index = 1; index < lines.length; index += 1) {
    if ((lines[index] ?? '').trim() === '---') {
      const frontmatterLines = lines.slice(1, index);
      let body = lines.slice(index + 1).join('\n').replace(/^\n+/, '');
      if (markdown.endsWith('\n') && !body.endsWith('\n')) {
        body += '\n';
      }
      return { frontmatterLines, body };
    }
  }

  return { frontmatterLines: [], body: markdown };
}

export function parseScalar(value: unknown): string {
  const cleaned = String(value || '').trim();
  if (!cleaned) return cleaned;
  try {
    const decoded = JSON.parse(cleaned);
    return typeof decoded === 'string' ? decoded : cleaned;
  } catch {
    // A YAML single-quoted scalar escapes its own quote by DOUBLING it, so
    // stripping the outer pair is only half the job: `'Traffic One''s /deploy'`
    // has to resolve to `Traffic One's /deploy`, and stripping alone shipped the
    // doubling into every emitted description. Found by driving the seven role
    // docs through a conformant parser and comparing
    // (src/test-support/__tests__/agent-frontmatter-oracle.test.ts) — the
    // apostrophe arrived in senior-shipper's frontmatter as the correct fix for
    // an unrelated YAML error, and this scanner then read a value no YAML
    // consumer would agree with.
    if (cleaned.length >= 2 && cleaned.startsWith("'") && cleaned.endsWith("'")) {
      return cleaned.slice(1, -1).replace(/''/g, "'");
    }
    return cleaned.replace(/^["']|["']$/g, '');
  }
}

export function parseInlineList(value: string): string[] {
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export interface Frontmatter { paths: string[]; description: string | null; alwaysApply: boolean | null; }

export function parseFrontmatter(lines: string[]): Frontmatter {
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
      if (value === 'true' || value === 'false') {
        alwaysApply = value === 'true';
      }
    }
  }

  return { paths, description, alwaysApply };
}

export function titleFromBody(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith('# ')) {
      return stripped.slice(2).trim();
    }
  }
  return fallback;
}

export function cursorFrontmatter(description: string, paths: string[], alwaysApply: boolean): string[] {
  const lines = ['---'];
  lines.push(`description: ${jsonString(description)}`);
  if (paths.length > 0) {
    lines.push(`globs: ${jsonString(paths.join(', '))}`);
  }
  lines.push(`alwaysApply: ${String(alwaysApply).toLowerCase()}`);
  lines.push('---');
  return lines;
}

// Recursively collect *.md under root, sorted by their repo-root-relative posix
// path (stable, deterministic order matching the legacy sync).
export function walkMarkdownFiles(root: string, repoRoot: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(root)) return files;

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  };

  walk(root);
  const rel = (p: string): string => toPosix(path.relative(repoRoot, p));
  files.sort((left, right) => rel(left).localeCompare(rel(right)));
  return files;
}
