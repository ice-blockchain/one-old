import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { BOOTSTRAP_SKILLS } from '../../../config/skill-filters';
import {
  activeSkillsFor,
  cleanActiveSkills,
  copyActiveSkills,
  pruneSkillsDirective,
  roleAgentBody,
  roleKernel,
} from '../index';

test('activeSkillsFor(default state) unions common + react-vite + supabase', () => {
  const s = activeSkillsFor({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true });
  assert.ok(s.has('library-pick')); // a real _common skill
  assert.ok(!s.has('auth')); // phantom auth is no longer listed
  assert.ok(s.has('project-memory'));
  assert.ok(s.has('create-component')); // react-vite
  assert.ok(s.has('postgres-patterns')); // supabase
  assert.ok(!s.has('django-patterns'));
  assert.equal(s.has('security-scan'), false, 'host-scoped skills require an explicit host');
  assert.equal(s.has('model-tier-sync'), false, 'maintainer-only skills are unavailable in projects');
});

test('host-scoped skills activate only on their declared host', () => {
  const state = {
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    mobile: { framework: 'none' },
    onboardingComplete: true,
  };
  assert.equal(activeSkillsFor(state, 'claude').has('security-scan'), true);
  for (const host of ['codex', 'cursor', 'opencode', 'kilo', 'copilot', 'windsurf'] as const) {
    assert.equal(activeSkillsFor(state, host).has('security-scan'), false, host);
  }
  assert.equal(activeSkillsFor(state, 'claude').has('model-tier-sync'), false);
});

test('activeSkillsFor: pre-onboarding new project → no skills (bootstrap set is empty)', () => {
  const s = activeSkillsFor({ mode: 'new-project', onboardingComplete: false });
  assert.deepEqual([...s].sort(), [...BOOTSTRAP_SKILLS].sort());
  assert.equal(s.size, 0);
});

test('ionic-mobile is scoped to the Ionic profile, not plain react-vite', () => {
  // Measured on 12co: the skill added ~10,958 chars (~2,700 tokens) to every
  // react-vite frontend bootstrap although the project had no mobile surface.
  const web = activeSkillsFor({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true });
  assert.equal(web.has('ionic-mobile'), false);
  assert.equal(web.has('vite-patterns'), true); // the rest of the bucket is intact

  const ionic = activeSkillsFor({ stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'ionic-capacitor' }, onboardingComplete: true });
  assert.equal(ionic.has('ionic-mobile'), true);
});

test('activeSkillsFor accepts a stack string (legacy alias)', () => {
  const s = activeSkillsFor('default');
  assert.ok(s.has('create-component'));
  assert.ok(s.has('postgres-patterns'));
});

test('stateless Go/Python state does not inherit Postgres or API-only skills', () => {
  const go = activeSkillsFor({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'go',
    onboardingComplete: true,
    mobile: { framework: 'none' },
  });
  assert.equal(go.has('golang-patterns'), true);
  assert.equal(go.has('postgres-patterns'), false);
  assert.equal(go.has('database-migrations'), false);
  assert.equal(go.has('app-launch-checklist'), false);

  const python = activeSkillsFor({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'python',
    onboardingComplete: true,
    capabilitySurfaces: ['cli'],
    mobile: { framework: 'none' },
  });
  assert.equal(python.has('python-patterns'), true);
  assert.equal(python.has('api-design'), false);
  assert.equal(python.has('postgres-patterns'), false);

  const pythonData = activeSkillsFor({
    stack: 'custom-backend',
    frontend: 'none',
    backend: 'python',
    onboardingComplete: true,
    capabilitySurfaces: ['cli', 'data'],
    mobile: { framework: 'none' },
  });
  assert.equal(pythonData.has('postgres-patterns'), true);
  assert.equal(pythonData.has('database-migrations'), true);
});

test('pruneSkillsDirective lists active + flags wrong-stack skills', () => {
  const directive = pruneSkillsDirective(
    { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true },
    ['library-pick', 'django-patterns'],
  );
  assert.ok(directive.includes('[ACTIVE SKILLS for stack=default]'));
  assert.ok(directive.includes('[DO NOT INVOKE'));
  assert.ok(directive.includes('django-patterns'));
});

test('cache surgery is a no-op outside the plugin cache path', () => {
  // pluginRoot resolves to this repo (not a .claude/plugins/cache path), so both return 0.
  assert.equal(cleanActiveSkills(), 0);
  assert.equal(copyActiveSkills('default'), 0);
});

// ── Role-scoped skill directives ──────────────────────────────────────────────────

test('roleDeclaredSkills parses the role agent-doc frontmatter (authoring repo path)', async () => {
  const { roleDeclaredSkills } = await import('../index');
  const skills = roleDeclaredSkills('senior-frontend');
  assert.ok(skills, 'senior-frontend agent doc resolves in the authoring repo');
  assert.ok(skills!.has('create-page'));
  assert.ok(skills!.has('frontend-design'));
  assert.ok(!skills!.has('postgres-patterns'));
});

test('roleSkillsDirective lists only the role∩stack skills, no wrong-stack dump', async () => {
  const { roleSkillsDirective } = await import('../index');
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const directive = roleSkillsDirective(state, 'senior-frontend', []);
  assert.ok(directive.includes('[ACTIVE SKILLS for senior-frontend on stack=default]'));
  assert.ok(directive.includes('create-page'));
  // Backend skills active on the stack must not leak into the frontend role list.
  assert.ok(!directive.includes('postgres-patterns'));
  // The long [DO NOT INVOKE] name dump is replaced by a single scope sentence.
  assert.ok(!directive.includes('[DO NOT INVOKE'));
  assert.ok(directive.includes('[SKILL SCOPE]'));
});

test('roleSkillsDirective falls back to the stack directive for unknown roles', async () => {
  const { roleSkillsDirective } = await import('../index');
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true };
  const fallback = roleSkillsDirective(state, 'not-a-real-role', []);
  assert.ok(fallback.includes('[ACTIVE SKILLS for stack=default]'));
});

test('roleAgentBody returns the role contract with frontmatter stripped (the body Cursor inlines)', () => {
  const body = roleAgentBody('senior-architect');
  assert.ok(body && body.length > 0, 'architect body resolved from the shipped/source agent doc');
  // Frontmatter is stripped — the body starts with prose, not a YAML block.
  assert.doesNotMatch(body as string, /^---\s*\nname:\s*senior-architect/, 'leading YAML frontmatter removed');
  // The body carries the host-only gate that must now reach Cursor.
  assert.match(body as string, /Required project-memory baseline/);
  assert.match(body as string, /ls \.traffic-one/);
});

test('roleAgentBody is null for malformed / unknown roles', () => {
  assert.equal(roleAgentBody('Not A Role'), null); // fails the [a-z0-9-] guard
  assert.equal(roleAgentBody(''), null);
  assert.equal(roleAgentBody('definitely-not-a-shipped-role'), null); // valid shape, no doc
});

// The kernel is the ONLY role-contract delivery on hosts without native
// agent-doc injection (Codex spawn_agent children) since the context-pack
// pager was removed — every senior role must carry one, and it must stay
// compact enough that the whole child SessionStart header fits ~16k chars.
test('every senior role doc carries a compact T1KERNEL contract kernel', () => {
  const verdictBy: Record<string, string> = {
    'senior-architect': 'PLAN_READY',
    'senior-frontend': 'IMPLEMENTED',
    'senior-backend': 'IMPLEMENTED',
    'senior-reviewer': 'CHANGES_REQUESTED',
    'senior-tester': 'TESTS_GREEN',
    'senior-shipper': 'SHIPPED',
  };
  for (const [role, verdict] of Object.entries(verdictBy)) {
    const kernel = roleKernel(role);
    assert.ok(kernel, `${role} has a T1KERNEL section`);
    assert.ok(kernel!.length <= 2_500, `${role} kernel is ${kernel!.length} chars (cap 2500)`);
    assert.ok(kernel!.includes(verdict), `${role} kernel names its verdict token ${verdict}`);
    assert.ok(kernel!.includes('ONE file per Read/shell command'), `${role} kernel keeps the anti-truncation discipline`);
  }
  assert.equal(roleKernel('definitely-not-a-shipped-role'), null);
});

// ── roleAgentDocCandidates ordering (defect regression) ─────────────────────
// Every test above exercises only the authoring-repo layout, where
// `src/modules/<role>/agent.md` is the SOLE candidate that exists — none of
// them would notice a future edit putting `agents/` or `dist/agents/` back
// in front. `roleAgentBody`/`roleKernel`/`roleDeclaredSkills` read straight
// off disk on every call (no per-process cache, unlike `makeSkillBlock`'s
// per-moduleId Map in `shared/skill-block.ts`), so repointing `pluginRoot()`
// mid-test is safe: there is no warmed cache from an earlier test in this
// file to defeat.
const REORDER_ROLE = 'reorder-fixture-role';

function agentDoc(marker: string): string {
  return `---\nname: ${REORDER_ROLE}\n---\n${marker}\n`;
}

// Repoints TRAFFIC_ONE_PLUGIN_ROOT at a fresh temp fixture for the duration of
// `fn`, restoring the prior value (the repo root pinned by test-preload.mjs)
// afterward so no state leaks into other test files — same idiom as
// materialize/__tests__/kilo-agents.test.ts.
function withFixturePluginRoot(build: (root: string) => void, fn: () => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-skill-filters-agent-root-'));
  build(root);
  const prevRoot = process.env.TRAFFIC_ONE_PLUGIN_ROOT;
  process.env.TRAFFIC_ONE_PLUGIN_ROOT = root;
  try {
    fn();
  } finally {
    if (prevRoot === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT;
    else process.env.TRAFFIC_ONE_PLUGIN_ROOT = prevRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('roleAgentDocCandidates: src/modules/<role>/agent.md outranks a conflicting dist/agents/<role>.md — the precise defect', () => {
  withFixturePluginRoot((root) => {
    fs.mkdirSync(path.join(root, 'src', 'modules', REORDER_ROLE), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'modules', REORDER_ROLE, 'agent.md'),
      agentDoc('SRC-BODY-MARKER'),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'dist', 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'dist', 'agents', `${REORDER_ROLE}.md`),
      agentDoc('STALE-DIST-BODY-MARKER'),
      'utf8',
    );
  }, () => {
    const body = roleAgentBody(REORDER_ROLE);
    assert.ok(body?.includes('SRC-BODY-MARKER'), 'authoring source wins over the source repo\'s own built tree');
    assert.ok(!body?.includes('STALE-DIST-BODY-MARKER'), 'a stale built copy must never outrank the source it was built from');
  });
});

test('roleAgentDocCandidates: src/modules/<role>/agent.md outranks a conflicting agents/<role>.md', () => {
  withFixturePluginRoot((root) => {
    fs.mkdirSync(path.join(root, 'src', 'modules', REORDER_ROLE), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'modules', REORDER_ROLE, 'agent.md'),
      agentDoc('SRC-BODY-MARKER'),
      'utf8',
    );
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents', `${REORDER_ROLE}.md`),
      agentDoc('INSTALLED-AGENTS-BODY-MARKER'),
      'utf8',
    );
  }, () => {
    const body = roleAgentBody(REORDER_ROLE);
    assert.ok(body?.includes('SRC-BODY-MARKER'), 'authoring source wins over the installed-plugin layout');
    assert.ok(!body?.includes('INSTALLED-AGENTS-BODY-MARKER'));
  });
});

test('roleAgentDocCandidates: with no src/ present (installed-plugin layout), agents/<role>.md is used', () => {
  withFixturePluginRoot((root) => {
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'agents', `${REORDER_ROLE}.md`),
      agentDoc('INSTALLED-AGENTS-BODY-MARKER'),
      'utf8',
    );
  }, () => {
    const body = roleAgentBody(REORDER_ROLE);
    assert.ok(body?.includes('INSTALLED-AGENTS-BODY-MARKER'), 'an install ships no src/, so agents/ must still resolve');
  });
});
