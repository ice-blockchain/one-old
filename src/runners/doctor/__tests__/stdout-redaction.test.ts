// src/runners/doctor/__tests__/stdout-redaction.test.ts
// Doctor's DEFAULT stdout is not the private half of a pair with `--bundle`:
// the traffic-one-doctor skill tells the agent to parse it, so everything it
// prints lands in model context and in the host transcript on disk. It used to
// print `probes.project.state.auth.apiKey`, the local preferences, and the full
// `projectContext.originalPrompt` verbatim — every category `--bundle` goes to
// the trouble of removing.
//
// Driven through main() against a real project on disk rather than through the
// redaction helper directly, because the defect was never in the helper: it was
// that the default path did not call it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { main } from '../index';

const PROMPT = 'PLANTED-PROMPT-migrate-the-payroll-database-for-my-employer';
const ANSWER = 'PLANTED-ANSWER-we-run-a-private-supabase-fork';
const API_KEY = 'sk-PLANTED-STDOUT-0123456789abcdef';
const DB_URL = 'postgres://admin:PLANTED-DBPASS@db.internal:5432/prod';
const PLANTED = [PROMPT, ANSWER, API_KEY, 'PLANTED-DBPASS'];

interface Captured { stdout: string; stderr: string }

async function runDoctorIn(cwd: string): Promise<Captured> {
  const captured: Captured = { stdout: '', stderr: '' };
  const realCwd = process.cwd();
  const outWrite = process.stdout.write.bind(process.stdout);
  const errWrite = process.stderr.write.bind(process.stderr);
  process.chdir(cwd);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => { captured.stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => { captured.stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    await main();
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    process.chdir(realCwd);
  }
  return captured;
}

function seedProject(cwd: string): void {
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: 'doctor-stdout-fixture', version: '0.0.0', private: true }));
  fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({
    mode: 'existing-codebase',
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    projectContext: { originalPrompt: PROMPT, answers: { goal: ANSWER } },
    auth: { apiKey: API_KEY, authenticated: true },
    // No credential in the key NAME — only in the value. The key-name pass
    // alone kept this one.
    databaseUrl: DB_URL,
  }, null, 2));
}

test('plain `doctor` stdout redacts everything --bundle does', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-doctor-stdout-')));
  const savedPrefs = process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  try {
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
    seedProject(dir);
    const { stdout } = await runDoctorIn(dir);
    const report = JSON.parse(stdout) as {
      probes: { project: { state: Record<string, unknown> } };
      plugin: { hostEvidence: { present: string[]; absent: string[] } };
    };

    for (const planted of PLANTED) {
      assert.equal(stdout.includes(planted), false, `plain doctor stdout leaked ${planted}`);
    }
    const state = report.probes.project.state;
    assert.deepEqual(state.projectContext, { originalPrompt: '[redacted]', answers: '[redacted]' });
    assert.equal((state.auth as Record<string, unknown>).apiKey, '[redacted]');
    assert.equal(state.databaseUrl, '[redacted]');
    // …while the structural state the report exists to show survives.
    assert.equal(state.mode, 'existing-codebase');
    assert.equal(state.backend, 'supabase');
    assert.equal((state.auth as Record<string, unknown>).authenticated, true);
    // The host is unknowable from a plain terminal, but WHICH markers were
    // looked for is not — so a `host: null` bug report stays usable.
    assert.ok(report.plugin.hostEvidence.absent.length > 0);
    assert.ok(report.plugin.hostEvidence.absent.includes('--host='));
  } finally {
    if (savedPrefs === undefined) delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
    else process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = savedPrefs;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
