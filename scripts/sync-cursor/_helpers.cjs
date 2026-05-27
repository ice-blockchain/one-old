'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const RULES_ROOT = path.join(ROOT, 'rules');
const AGENTS_ROOT = path.join(ROOT, 'agents');
const CURSOR_RULES_ROOT = path.join(ROOT, '.cursor', 'rules');
const CURSOR_PLUGIN_MANIFEST = path.join(ROOT, '.cursor-plugin', 'plugin.json');

const GENERATED_MARKER = '<!-- GENERATED FROM:';
const LEGACY_GENERATED_MARKER = '<!-- SOURCE OF TRUTH:';

const MANIFEST_ORDER = [
  'name',
  'displayName',
  'description',
  'version',
  'author',
  'publisher',
  'homepage',
  'repository',
  'license',
  'logo',
  'keywords',
  'category',
  'tags',
  'commands',
  'agents',
  'skills',
  'rules',
  'hooks',
  'mcpServers',
];

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function relative(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeTextIfChanged(filePath, content) {
  if (fs.existsSync(filePath) && readText(filePath) === content) {
    return false;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function jsonString(value) {
  return JSON.stringify(value);
}

function jsonArray(values) {
  return `[${values.map((value) => jsonString(value)).join(', ')}]`;
}

function splitFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') {
    return { frontmatterLines: [], body: markdown };
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
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

function parseScalar(value) {
  const cleaned = String(value || '').trim();
  if (!cleaned) {
    return cleaned;
  }
  try {
    const decoded = JSON.parse(cleaned);
    return typeof decoded === 'string' ? decoded : cleaned;
  } catch {
    return cleaned.replace(/^["']|["']$/g, '');
  }
}

function parseInlineList(value) {
  try {
    const decoded = JSON.parse(value);
    return Array.isArray(decoded) ? decoded.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseFrontmatter(lines) {
  const paths = [];
  let description = null;
  let alwaysApply = null;
  let inPaths = false;

  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (!stripped || stripped.startsWith('#')) {
      continue;
    }

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
      if (itemMatch) {
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

function titleFromBody(body, fallback) {
  for (const line of body.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith('# ')) {
      return stripped.slice(2).trim();
    }
  }
  return fallback;
}

function slugForSource(sourcePath) {
  const sourceWithoutSuffix = path.relative(RULES_ROOT, sourcePath).replace(/\.md$/, '');
  let parts = toPosix(sourceWithoutSuffix).split('/');

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

function shouldAlwaysApply(sourcePath, paths, explicit) {
  if (explicit !== null) {
    return explicit;
  }
  if (paths.length > 0) {
    return false;
  }
  const relativeParts = toPosix(path.relative(RULES_ROOT, sourcePath)).split('/');
  return relativeParts[0] !== 'modes';
}

function cursorFrontmatter(description, paths, alwaysApply) {
  const lines = ['---'];
  lines.push(`description: ${jsonString(description)}`);
  if (paths.length > 0) {
    lines.push(`globs: ${jsonArray(paths)}`);
  }
  lines.push(`alwaysApply: ${String(alwaysApply).toLowerCase()}`);
  lines.push('---');
  return lines;
}

function walkMarkdownFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  walk(root);
  files.sort((left, right) => relative(left).localeCompare(relative(right)));
  return files;
}

// Mirror agents/<role>.md → .cursor/rules/00-agent-<role>.mdc as Always-attached
// rules. Cursor has no first-class subagents, so role definitions become
// always-on context. The 00- prefix sorts them ahead of the regular rules so
// the role directives are read first.
function renderAgentRule(sourcePath) {
  const sourceText = readText(sourcePath);
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { description: frontmatterDescription } = parseFrontmatter(frontmatterLines);
  const sourceRelative = relative(sourcePath);
  const baseName = path.basename(sourcePath, '.md');
  const fallbackTitle = baseName.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const outputPath = path.join(CURSOR_RULES_ROOT, `00-agent-${baseName}.mdc`);

  const note = '> Mirrored from ' + sourceRelative + ' — Cursor has no first-class '
    + 'subagents; treat this as an always-on role context. The orchestrator skill '
    + '(`senior-eng-orchestrator`) describes how the roles compose.';

  const contentLines = [
    `<!-- GENERATED FROM: ${sourceRelative}; run \`node scripts/sync-cursor.cjs\` to update. -->`,
    ...cursorFrontmatter(description, [], true),
    '',
    note,
    '',
    body.trimEnd(),
    '',
  ];

  return { sourcePath, outputPath, content: contentLines.join('\n') };
}

function isManagedCursorRule(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  const start = readText(filePath).slice(0, 300);
  return start.includes(GENERATED_MARKER) || start.includes(LEGACY_GENERATED_MARKER);
}

function staleCursorRules(expectedPaths) {
  if (!fs.existsSync(CURSOR_RULES_ROOT)) {
    return [];
  }
  return fs
    .readdirSync(CURSOR_RULES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mdc'))
    .map((entry) => path.join(CURSOR_RULES_ROOT, entry.name))
    .filter((filePath) => !expectedPaths.has(filePath) && isManagedCursorRule(filePath))
    .sort((left, right) => relative(left).localeCompare(relative(right)));
}

function loadExistingManifest() {
  if (!fs.existsSync(CURSOR_PLUGIN_MANIFEST)) {
    return {};
  }
  try {
    const decoded = JSON.parse(readText(CURSOR_PLUGIN_MANIFEST));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
      throw new Error('manifest is not a JSON object');
    }
    return decoded;
  } catch (error) {
    throw new Error(`${relative(CURSOR_PLUGIN_MANIFEST)} is not valid JSON: ${error.message}`);
  }
}

function diffSummary(expectedRules, staleRules, manifest) {
  const differences = [];

  for (const document of expectedRules) {
    if (!fs.existsSync(document.outputPath)) {
      differences.push(`missing ${relative(document.outputPath)}`);
      continue;
    }
    if (readText(document.outputPath) !== document.content) {
      differences.push(`out of date ${relative(document.outputPath)}`);
    }
  }

  for (const filePath of staleRules) {
    differences.push(`stale ${relative(filePath)}`);
  }

  if (!fs.existsSync(CURSOR_PLUGIN_MANIFEST) || readText(CURSOR_PLUGIN_MANIFEST) !== manifest) {
    differences.push(`out of date ${relative(CURSOR_PLUGIN_MANIFEST)}`);
  }

  return differences;
}

module.exports = {
  fs,
  path,
  ROOT,
  RULES_ROOT,
  AGENTS_ROOT,
  CURSOR_RULES_ROOT,
  CURSOR_PLUGIN_MANIFEST,
  GENERATED_MARKER,
  LEGACY_GENERATED_MARKER,
  MANIFEST_ORDER,
  toPosix,
  relative,
  readText,
  writeTextIfChanged,
  jsonString,
  jsonArray,
  splitFrontmatter,
  parseScalar,
  parseInlineList,
  parseFrontmatter,
  titleFromBody,
  slugForSource,
  shouldAlwaysApply,
  cursorFrontmatter,
  walkMarkdownFiles,
  renderAgentRule,
  isManagedCursorRule,
  staleCursorRules,
  loadExistingManifest,
  diffSummary,
};
