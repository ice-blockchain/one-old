import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';

import { generatedSkillDocs } from '../emit/skills';
import {
  agentsMarketplaceManifest,
  claudePluginManifest,
  codexPluginManifest,
  cursorPluginManifest,
} from '../sources/product';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('generatedSkillDocs re-gathers both skill trees (105 catalog + 0 bootstrap)', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  const templates = docs.filter((d) => d.relPath.startsWith(`skills-catalog${path.sep}`));
  const bootstrap = docs.filter((d) => d.relPath.startsWith(`skills${path.sep}`));
  assert.equal(templates.length, 105);
  assert.equal(bootstrap.length, 0);
  // traffic-one-doctor is a normal catalog skill now — present in skills-catalog/, absent from the (empty) bootstrap tree.
  assert.ok(!docs.some((d) => d.relPath === path.join('skills', 'traffic-one-doctor', 'SKILL.md')));
  assert.ok(docs.some((d) => d.relPath === path.join('skills-catalog', 'traffic-one-doctor', 'SKILL.md')));
  // Deterministic sort + non-empty content.
  const sorted = [...docs].map((d) => d.relPath).sort((a, b) => a.localeCompare(b));
  assert.deepEqual(docs.map((d) => d.relPath), sorted);
  for (const doc of docs) assert.ok(doc.content.length > 0, `empty: ${doc.relPath}`);
});

test('generated skills do not require architecture.md artifacts', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /\b(write|create|ship|include)\s+`?architecture\.md`?/i, doc.relPath);
    assert.doesNotMatch(doc.content, /architecture\.md`\s*\(REQUIRED\)/i, doc.relPath);
    assert.doesNotMatch(doc.content, /package-architecture/i, doc.relPath);
  }
});

test('generated skills carry no Traffic One governance boilerplate', () => {
  const docs = generatedSkillDocs(REPO_ROOT);
  for (const doc of docs) {
    assert.doesNotMatch(doc.content, /Traffic One precedence:/, doc.relPath);
    assert.doesNotMatch(doc.content, /Traffic One setup gate:/, doc.relPath);
    assert.doesNotMatch(doc.content, /Prerequisite: follow the shared/, doc.relPath);
    // Skill files reference neither dissolved policy skill.
    assert.doesNotMatch(doc.content, /`detect-project`/, doc.relPath);
    assert.doesNotMatch(doc.content, /`stack-setup`/, doc.relPath);
    // Upstream provenance frontmatter is stripped at emit time (kept in src).
    assert.doesNotMatch(doc.content, /source_commit:/, doc.relPath);
    assert.doesNotMatch(doc.content, /everything-claude-code/, doc.relPath);
  }
  // The two policy skills are gone from both trees entirely.
  assert.ok(!docs.some((d) => d.relPath.includes('detect-project')));
  assert.ok(!docs.some((d) => d.relPath.includes('stack-setup')));
});

test('all host manifests read the managed ./skills/ dir (per-stack filtering)', () => {
  const version = '0.0.0-test';
  for (const m of [claudePluginManifest(version, []), codexPluginManifest(version), cursorPluginManifest(version)]) {
    assert.equal(m.skills, './skills/');
  }
});

test('Codex manifest relies on default hook discovery and carries no unsupported instructions field', () => {
  const manifest = codexPluginManifest('0.0.0-test');
  assert.equal('hooks' in manifest, false);
  assert.equal('instructions' in manifest, false);
  const interfaceMetadata = manifest.interface as {
    category: string;
    shortDescription: string;
    defaultPrompt: string[];
  };
  assert.ok(new Set([
    'Productivity', 'Creativity', 'Developer Tools', 'Business & Operations',
    'Data & Analytics', 'Communication', 'Education & Research', 'Security',
    'Finance', 'Healthcare', 'Travel', 'Entertainment', 'Other',
  ]).has(interfaceMetadata.category));
  assert.ok(interfaceMetadata.shortDescription.length <= 30);
  assert.ok(interfaceMetadata.defaultPrompt.length <= 3);
  assert.equal(new Set(interfaceMetadata.defaultPrompt).size, interfaceMetadata.defaultPrompt.length);
  for (const prompt of interfaceMetadata.defaultPrompt) {
    assert.ok(prompt.length > 0 && prompt.length <= 128);
    assert.doesNotMatch(prompt, /[\r\n@]/);
  }
});

test('Codex marketplace entry carries complete install policy and an accepted category', () => {
  const marketplace = agentsMarketplaceManifest() as {
    plugins: Array<{
      source: { source: string; path: string };
      policy: { installation: string; authentication: string };
      category: string;
    }>;
  };
  assert.deepEqual(marketplace.plugins[0]?.source, {
    source: 'local',
    path: './plugins/traffic-one',
  });
  assert.deepEqual(marketplace.plugins[0]?.policy, {
    installation: 'AVAILABLE',
    authentication: 'ON_INSTALL',
  });
  assert.equal(marketplace.plugins[0]?.category, 'Developer Tools');
});
