import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SKILL_FILTERS } from '../../../config/skill-filters';
import { capabilityProfileForProject } from '../../capabilities';
import { activeSkillsForProject } from '../../skill-filters';
import { writeCopilotAgentFiles } from '../copilot-agents';
import { writeCursorAgentFiles } from '../cursor-agents';
import { writeKiloAgentFiles } from '../kilo-agents';
import { writeWindsurfAgentFiles } from '../windsurf-agents';

const FULL_STATE = {
  stack: 'default',
  frontend: 'react-vite',
  backend: 'supabase',
  mobile: { framework: 'none' },
};

const API_STATE = {
  stack: 'custom-backend',
  frontend: 'none',
  backend: 'other',
  mobile: { framework: 'none' },
};

const FRONTEND_AGENT_PATHS = [
  '.cursor/agents/senior-frontend.md',
  '.github/agents/senior-frontend.agent.md',
  '.kilo/agents/senior-frontend.md',
  '.devin/agents/senior-frontend/AGENT.md',
];

const BACKEND_AGENT_PATHS = [
  '.cursor/agents/senior-backend.md',
  '.github/agents/senior-backend.agent.md',
  '.kilo/agents/senior-backend.md',
  '.devin/agents/senior-backend/AGENT.md',
];

const FRONTEND_SKILLS = new Set([
  'web-ui',
  'react-vite',
  'nextjs',
  'nuxt',
  'custom-web',
  'ionic-capacitor',
].flatMap((bucket) => [...(SKILL_FILTERS[bucket] || [])]));

function assertFrontendMaterializationRemoved(
  setup: (root: string) => void,
  expectedBackendSkill: string,
  expectedSurface: 'api' | 'cli',
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't1-capability-roles-'));
  try {
    // First publish a genuine UI profile, then add the backend fixture and
    // verify that capability-derived materialization removes stale frontend
    // agents. Laravel detection intentionally overrides a contradictory
    // `FULL_STATE` once composer/app markers exist, so the fixture must be
    // introduced only after the UI files have been created.
    writeCursorAgentFiles(root, FULL_STATE);
    writeCopilotAgentFiles(root, FULL_STATE);
    writeKiloAgentFiles(root, FULL_STATE);
    writeWindsurfAgentFiles(root, FULL_STATE);

    for (const frontend of FRONTEND_AGENT_PATHS) {
      assert.equal(fs.existsSync(path.join(root, frontend)), true, frontend);
    }

    setup(root);
    const profile = capabilityProfileForProject(root, API_STATE);
    assert.equal(profile.profileId, 'backend-only');
    assert.equal(profile.roles.includes('senior-frontend'), false);
    assert.equal(profile.surfaces.includes(expectedSurface), true);
    assert.deepEqual(profile.qaAdapters, []);

    const skills = activeSkillsForProject(root, API_STATE);
    assert.equal(skills.has(expectedBackendSkill), true);
    assert.equal(skills.has('browser-qa'), false);
    for (const frontendSkill of FRONTEND_SKILLS) {
      assert.equal(skills.has(frontendSkill), false, frontendSkill);
    }

    writeCursorAgentFiles(root, API_STATE);
    writeCopilotAgentFiles(root, API_STATE);
    writeKiloAgentFiles(root, API_STATE);
    writeWindsurfAgentFiles(root, API_STATE);

    for (const frontend of FRONTEND_AGENT_PATHS) {
      assert.equal(fs.existsSync(path.join(root, frontend)), false, frontend);
    }
    for (const backend of BACKEND_AGENT_PATHS) {
      assert.equal(fs.existsSync(path.join(root, backend)), true, backend);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('host-native agent materialization removes frontend roles and skills from a detected Go API', () => {
  assertFrontendMaterializationRemoved(
    (root) => fs.writeFileSync(path.join(root, 'go.mod'), 'module example.test/api\n\ngo 1.24\n'),
    'golang-patterns',
    'api',
  );
});

test('host-native agent materialization removes frontend roles and skills from Laravel API-only', () => {
  assertFrontendMaterializationRemoved(
    (root) => {
      fs.writeFileSync(path.join(root, 'composer.json'), JSON.stringify({
        require: { 'laravel/framework': '^12.0' },
      }));
      fs.mkdirSync(path.join(root, 'app/Http/Controllers'), { recursive: true });
    },
    'laravel-patterns',
    'api',
  );
});

test('host-native agent materialization removes frontend roles and skills from a detected Python CLI', () => {
  assertFrontendMaterializationRemoved(
    (root) => fs.writeFileSync(path.join(root, 'sync.py'), 'print("ok")\n'),
    'python-patterns',
    'cli',
  );
});
