import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import test from 'node:test';

const MODULES_ROOT = path.resolve(__dirname, '..', 'src', 'modules');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(MODULES_ROOT, relativePath), 'utf8');
}

test('frontend, reviewer, tester, and orchestration prompts reject broad type suppression and fixture-only live paths', () => {
  const contracts = [
    read('senior-frontend/agent.md'),
    read('senior-reviewer/agent.md'),
    read('senior-tester/agent.md'),
    read('skills/skills-catalog/senior-eng-orchestrator/resources/prompt-templates.md'),
  ];

  for (const contract of contracts) {
    assert.match(contract, /@ts-nocheck/);
    assert.match(contract, /@ts-ignore/);
    assert.match(contract, /fixtures?/i);
    assert.match(contract, /live (?:repository\/API|response|results?)/i);
  }
});
