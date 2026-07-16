import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetAuthoringRootCache } from '../../../shared/authoring-root';
import {
  EXHAUSTED_MODEL_TTL_MS,
  clearExhaustedModels,
  exhaustedModelsForRole,
  markModelExhaustionTerminal,
  modelExhaustionTerminalForRole,
  modelIsExhausted,
  recordExhaustedModel,
} from '../exhausted-models';

function tmp(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-exhausted-models-')));
}

function storePath(cwd: string, runId: string): string {
  return path.join(cwd, '.traffic-one', 'runs', runId, 'exhausted-models.json');
}

test('v2 store reads legacy role arrays, applies TTL, and preserves roles on atomic upgrade', () => {
  const cwd = tmp();
  const runId = 'run-v2';
  const now = Date.parse('2026-07-15T10:00:00.000Z');
  const p = storePath(cwd, runId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      'senior-backend': [
        { model: 'expired-model', at: new Date(now - EXHAUSTED_MODEL_TTL_MS - 1).toISOString() },
        { model: 'gpt-5.6-terra-medium', at: new Date(now - 1_000).toISOString() },
      ],
      'senior-frontend': ['legacy-model-without-timestamp'],
    }), 'utf8');

    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-backend', now), ['gpt-5.6-terra-medium']);
    assert.equal(modelIsExhausted(cwd, runId, 'senior-backend', 'gpt-5.6-terra', now), true, 'family matching is retained');
    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-frontend', now), ['legacy-model-without-timestamp']);

    recordExhaustedModel(cwd, runId, 'senior-backend', 'claude-sonnet-5-thinking-high', now);
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    assert.equal(raw.version, 2);
    const roles = raw.roles as Record<string, { entries: Array<{ model: string }> }>;
    assert.deepEqual(roles['senior-backend']!.entries.map((entry) => entry.model), [
      'gpt-5.6-terra-medium',
      'claude-sonnet-5-thinking-high',
    ]);
    assert.deepEqual(roles['senior-frontend']!.entries.map((entry) => entry.model), ['legacy-model-without-timestamp']);
    assert.equal(fs.readdirSync(path.dirname(p)).some((name) => name.includes('.tmp') || name.endsWith('.lock')), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('terminal marker is per role, survives model TTL, and full-run clear removes entries and terminals', () => {
  const cwd = tmp();
  const runId = 'run-terminal';
  const now = Date.parse('2026-07-15T10:00:00.000Z');
  try {
    recordExhaustedModel(cwd, runId, 'senior-backend', 'gpt-5.6-terra-medium', now);
    assert.equal(markModelExhaustionTerminal(cwd, runId, 'senior-backend', now), true);
    recordExhaustedModel(cwd, runId, 'senior-architect', 'claude-opus-4-8-thinking-high', now);

    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'), true);
    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-architect'), false);
    assert.deepEqual(
      exhaustedModelsForRole(cwd, runId, 'senior-backend', now + EXHAUSTED_MODEL_TTL_MS + 1),
      [],
      'individual exhausted entries still expire',
    );
    assert.equal(
      modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'),
      true,
      'terminal state does not dissolve with entry TTL',
    );

    clearExhaustedModels(cwd, runId);
    assert.deepEqual(exhaustedModelsForRole(cwd, runId, 'senior-architect'), []);
    assert.equal(modelExhaustionTerminalForRole(cwd, runId, 'senior-backend'), false);
    assert.equal(fs.existsSync(storePath(cwd, runId)), false);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('all exhausted-model mutators stand down in plugin authoring roots', () => {
  const cwd = tmp();
  resetAuthoringRootCache();
  try {
    fs.mkdirSync(path.join(cwd, 'src', 'gen'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'src', 'gen', 'index.ts'), '// generator', 'utf8');
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'traffic-one' }), 'utf8');
    resetAuthoringRootCache();

    assert.deepEqual(recordExhaustedModel(cwd, 'run-stand-down', 'senior-backend', 'gpt-5.6-terra-medium'), []);
    assert.equal(markModelExhaustionTerminal(cwd, 'run-stand-down', 'senior-backend'), false);
    clearExhaustedModels(cwd, 'run-stand-down');
    assert.equal(fs.existsSync(path.join(cwd, '.traffic-one')), false, 'no project state is created in the source repo');
  } finally {
    resetAuthoringRootCache();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
