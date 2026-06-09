import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

import { ensureSessionMaterialization, readGraphPreview, shouldBuildCodeGraph, sweepOldDigests, tokenEconomyBanner } from '../session-start-lib';

function withTmp(fn: (cwd: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-sslib-'));
  const env = process.env;
  const prev = env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  env.TRAFFIC_ONE_PROJECT_PREFS_PATH = path.join(dir, 'prefs.json');
  try { fn(dir); } finally {
    if (prev === undefined) delete env.TRAFFIC_ONE_PROJECT_PREFS_PATH; else env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('shouldBuildCodeGraph: builds for existing project missing a graph; guards otherwise', () => {
  withTmp((cwd) => {
    const NOW = Date.parse('2026-06-08T12:00:00Z');
    const base = { mode: 'existing-codebase', codeGraphProvider: 'graphify' };
    // existing + provider + no artifact → build
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), true);
    // artifact present → skip
    fs.mkdirSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graphify-out', 'GRAPH_REPORT.md'), '# g', 'utf8');
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), false);
    fs.rmSync(path.join(cwd, '.traffic-one', 'graphify-out'), { recursive: true, force: true });
    // cooldown via disk lock: recent attempt → skip; stale (>30min) → build again
    const lock = path.join(cwd, '.traffic-one', '.codegraph-build-lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '2026-06-08T11:50:00Z', 'utf8'); // 10 min ago
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), false);
    fs.writeFileSync(lock, '2026-06-08T11:00:00Z', 'utf8'); // 60 min ago
    assert.equal(shouldBuildCodeGraph(cwd, { ...base }, NOW), true);
    fs.rmSync(lock, { force: true });
    // new-project mode → never; no provider → never; auto-run off → never
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'new-project', codeGraphProvider: 'graphify' }, NOW), false);
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase' }, NOW), false);
    assert.equal(shouldBuildCodeGraph(cwd, { ...base, codeGraphAutoRun: false }, NOW), false);
    // gitnexus keys on .gitnexus/
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), true);
    fs.mkdirSync(path.join(cwd, '.traffic-one', '.gitnexus'), { recursive: true });
    assert.equal(shouldBuildCodeGraph(cwd, { mode: 'existing-codebase', codeGraphProvider: 'gitnexus' }, NOW), false);
  });
});

test('sweepOldDigests keeps the newest N digest runs', () => {
  withTmp((cwd) => {
    const digests = path.join(cwd, '.traffic-one', 'digests');
    for (const n of ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']) {
      fs.mkdirSync(path.join(digests, n), { recursive: true });
    }
    assert.equal(sweepOldDigests(cwd, 2), 2); // removed the 2 oldest
    const remaining = fs.readdirSync(digests).sort();
    assert.deepEqual(remaining, ['2026-01-03', '2026-01-04']);
    // no digests dir → 0
    assert.equal(sweepOldDigests(path.join(cwd, 'nope'), 2), 0);
  });
});

test('readGraphPreview returns the preview content or empty string', () => {
  withTmp((cwd) => {
    assert.equal(readGraphPreview(cwd), '');
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'graph-preview.md'), 'modules: a, b', 'utf8');
    assert.ok(readGraphPreview(cwd).includes('modules: a, b'));
  });
});

test('tokenEconomyBanner surfaces memory + graph hints, and toolchain drift via the probe', () => {
  withTmp((cwd) => {
    assert.equal(tokenEconomyBanner(cwd), ''); // nothing present
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'stack.md'), 'x', 'utf8');
    fs.mkdirSync(path.join(cwd, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'graphify-out', 'GRAPH_REPORT.md'), 'g', 'utf8');
    const banner = tokenEconomyBanner(cwd);
    assert.ok(banner.includes('[memory]'));
    assert.ok(banner.includes('[graph: graphify]'));
    // a probe surfaces toolchain drift; without one, no [toolchain] line
    assert.ok(!banner.includes('[toolchain]'));
    fs.writeFileSync(path.join(cwd, '.traffic-one', '.one.json'), JSON.stringify({ toolchain: { gitnexus: { installedVersion: '1.0.0' } } }), 'utf8');
    const probe = {
      toolStatus: () => ({ status: 'outdated', installed: '1.0.0', recommended: '2.0.0' }),
      getToolSpec: () => ({ installCommand: 'npm i -g gitnexus' }),
    };
    assert.ok(tokenEconomyBanner(cwd, probe).includes('[toolchain] gitnexus 1.0.0 installed; recommended is 2.0.0'));
  });
});

test('ensureSessionMaterialization no-ops for incomplete / already-current state', () => {
  withTmp((cwd) => {
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: false }), false);
    assert.equal(ensureSessionMaterialization(cwd, { onboardingComplete: true, stack: 'not-a-stack' }), false);
    // already materialized → false + reporter fires
    const t1 = path.join(cwd, '.traffic-one');
    fs.mkdirSync(path.join(t1, 'rules', 'common'), { recursive: true });
    fs.mkdirSync(path.join(t1, 'skills', 'project-memory'), { recursive: true });
    fs.writeFileSync(path.join(t1, 'rules', 'common', 'auth-gate.md'), 'r', 'utf8');
    fs.writeFileSync(path.join(t1, 'skills', 'project-memory', 'SKILL.md'), 's', 'utf8');
    fs.writeFileSync(path.join(t1, 'manifest.json'), JSON.stringify({ generatedBy: 'traffic-one', stack: 'default', rules: ['rules/common/auth-gate.md'], skills: ['project-memory'] }), 'utf8');
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'x\n<!-- GENERATED BY traffic-one: project-local active rules -->\n', 'utf8');
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'see agents', 'utf8');
    const state = { mode: 'new-project', stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' }, onboardingComplete: true, materializedStack: 'default|react-vite|supabase|none' };
    let reported = 0;
    assert.equal(ensureSessionMaterialization(cwd, state, () => { reported += 1; }), false);
    assert.equal(reported, 1);
  });
});
