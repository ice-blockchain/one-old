#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RULES_ROOT = path.join(ROOT, 'rules');
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

function renderCursorRule(sourcePath) {
  const sourceText = readText(sourcePath);
  const { frontmatterLines, body } = splitFrontmatter(sourceText);
  const { paths, description: frontmatterDescription, alwaysApply: explicitAlwaysApply } = parseFrontmatter(frontmatterLines);
  const sourceRelative = relative(sourcePath);
  const fallbackTitle = path.basename(sourcePath, '.md').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  const title = titleFromBody(body, fallbackTitle);
  const description = frontmatterDescription || `${title}. Generated from ${sourceRelative}.`;
  const alwaysApply = shouldAlwaysApply(sourcePath, paths, explicitAlwaysApply);
  const outputPath = path.join(CURSOR_RULES_ROOT, `${slugForSource(sourcePath)}.mdc`);

  const contentLines = [
    `<!-- GENERATED FROM: ${sourceRelative}; run \`node scripts/sync-cursor.cjs\` to update. -->`,
    ...cursorFrontmatter(description, paths, alwaysApply),
    '',
    body.trimEnd(),
    '',
  ];

  return { sourcePath, outputPath, content: contentLines.join('\n') };
}

function walkMarkdownFiles(root) {
  const files = [];

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

function generatedRuleDocuments() {
  return walkMarkdownFiles(RULES_ROOT).map((source) => renderCursorRule(source));
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

function normalizedCursorManifest() {
  const existing = loadExistingManifest();
  const interfaceData = existing.interface && typeof existing.interface === 'object' ? existing.interface : {};
  const defaults = {
    name: existing.name || 'traffic-one',
    displayName: existing.displayName || interfaceData.displayName || 'Traffic One',
    description:
      existing.description ||
      interfaceData.shortDescription ||
      'React, Ionic/Capacitor, and explicit React Native TypeScript workflow rules.',
    version: existing.version || '0.0.0',
    author: existing.author || { name: 'Traffic One' },
    keywords:
      existing.keywords || ['react', 'ionic', 'capacitor', 'react-native', 'typescript', 'turborepo', 'rtk-query', 'cursor-rules'],
    category: existing.category || 'engineering',
    tags: existing.tags || ['react', 'ionic', 'capacitor', 'react-native', 'typescript', 'testing', 'security'],
    skills: './skills/',
    rules: './.cursor/rules/',
  };

  for (const key of MANIFEST_ORDER) {
    if (Object.prototype.hasOwnProperty.call(existing, key) && !Object.prototype.hasOwnProperty.call(defaults, key) && key !== 'interface') {
      defaults[key] = existing[key];
    }
  }

  const ordered = {};
  for (const key of MANIFEST_ORDER) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      ordered[key] = defaults[key];
    }
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
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

function syncCursor({ check }) {
  const expectedRules = generatedRuleDocuments();
  const expectedPaths = new Set(expectedRules.map((document) => document.outputPath));
  const staleRules = staleCursorRules(expectedPaths);
  const manifest = normalizedCursorManifest();
  const differences = diffSummary(expectedRules, staleRules, manifest);

  if (check) {
    if (differences.length > 0) {
      console.log('Cursor sync is out of date:');
      for (const difference of differences) {
        console.log(`  - ${difference}`);
      }
      console.log('\nRun: node scripts/sync-cursor.cjs');
      return 1;
    }
    console.log('Cursor sync is up to date.');
    return 0;
  }

  const changed = [];
  for (const document of expectedRules) {
    if (writeTextIfChanged(document.outputPath, document.content)) {
      changed.push(relative(document.outputPath));
    }
  }

  for (const filePath of staleRules) {
    fs.unlinkSync(filePath);
    changed.push(relative(filePath));
  }

  if (writeTextIfChanged(CURSOR_PLUGIN_MANIFEST, manifest)) {
    changed.push(relative(CURSOR_PLUGIN_MANIFEST));
  }

  if (changed.length > 0) {
    console.log('Updated Cursor sync artifacts:');
    for (const filePath of changed) {
      console.log(`  - ${filePath}`);
    }
  } else {
    console.log('Cursor sync artifacts already up to date.');
  }
  return 0;
}

function parseArgs(argv) {
  return {
    check: argv.includes('--check'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/sync-cursor.cjs [--check]');
    return 0;
  }
  try {
    return syncCursor({ check: args.check });
  } catch (error) {
    console.error(`cursor sync failed: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  generatedRuleDocuments,
  normalizedCursorManifest,
  renderCursorRule,
  syncCursor,
};
