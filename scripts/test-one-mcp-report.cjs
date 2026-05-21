#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildMcpPayload,
  collectMetadata,
  prepareReport,
  runReport,
  uuidV7,
} = require('./one-mcp-report.cjs');
const handlers = require('./hook-runtime/handlers.cjs');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-one-mcp-'));
}

function writeFile(root, relPath, body) {
  const filePath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function completedState(mode = 'new-project') {
  return {
    version: '0.0.0-test',
    mode,
    stack: 'default',
    frontend: 'react-vite',
    backend: 'supabase',
    mobile: {
      enabled: false,
      framework: 'none',
      source: 'prompted',
    },
    technologies: {
      frontend: ['React', 'Vite', 'TypeScript'],
      backend: ['Supabase'],
      mobile: [],
    },
    realtime: 'light',
    codeGraphProvider: 'gitnexus',
    team: {
      mode: 'subagents',
      source: 'prompted',
    },
    toolchain: {
      gitnexus: { installedVersion: null, installedAt: null },
      graphify: { installedVersion: null, installedAt: null },
      gitleaks: { installedVersion: null, installedAt: null },
      trufflehog: { installedVersion: null, installedAt: null },
    },
    confirmed: true,
    onboardingComplete: true,
    confirmedAt: '2026-05-20T00:00:00Z',
  };
}

function makeProject(options = {}) {
  const root = tmpProject();
  writeFile(root, 'package.json', `${JSON.stringify({
    packageManager: 'pnpm@10.0.0',
    dependencies: {
      '@supabase/supabase-js': '^2.0.0',
      react: '^19.0.0',
      vite: '^7.0.0',
    },
    devDependencies: {
      typescript: '^5.0.0',
    },
  }, null, 2)}\n`);
  writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - apps/*\n');
  writeFile(root, '.traffic-one.json', `${JSON.stringify(completedState(options.mode), null, 2)}\n`);
  writeFile(root, 'apps/web/src/App.tsx', [
    'export function App() {',
    '  return <main>Hello</main>;',
    '}',
    '',
  ].join('\n'));
  writeFile(root, 'apps/web/src/App.test.tsx', 'test("ignored", () => {});\n');
  return root;
}

async function main() {
  assert.match(
    uuidV7(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  const empty = tmpProject();
  assert.deepEqual(prepareReport(empty, { spawn: false }), {
    started: false,
    reason: 'no-codebase',
  });
  assert.equal(fs.existsSync(path.join(empty, '.one-mcp-id')), false);

  const root = makeProject();
  const prepared = prepareReport(root, { spawn: false, trigger: 'test' });
  assert.equal(prepared.started, true);
  assert.equal(prepared.spawned, false);
  assert.match(prepared.reportId, /^[A-Za-z0-9._:-]{1,128}$/);

  const idText = fs.readFileSync(path.join(root, '.one-mcp-id'), 'utf8');
  assert.equal(idText, `${prepared.reportId}\n`);

  const status = JSON.parse(fs.readFileSync(path.join(root, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(status.status, 'queued');
  assert.equal(status.reportId, prepared.reportId);
  assert.equal(status.trigger, 'test');
  assert.equal(status.mcpPayload.method, 'tools/call');
  assert.equal(status.mcpPayload.params.name, 'report_codebase_metadata');
  assert.equal(status.mcpPayload.params.arguments.report_id, prepared.reportId);

  const meta = collectMetadata(root, JSON.parse(fs.readFileSync(path.join(root, '.traffic-one.json'), 'utf8')), prepared.reportId);
  assert.equal(meta.report_id, prepared.reportId);
  assert(meta.technologies.includes('react'));
  assert(meta.technologies.includes('vite'));
  assert(meta.technologies.includes('supabase'));
  assert(meta.technologies.includes('typescript'));
  assert(meta.technologies.includes('pnpm'));
  assert(meta.file_extensions.tsx > 0);
  assert.equal(meta.file_extensions.lock, undefined);
  assert(meta.architecture_components.some((c) => c.type === 'database' && c.name === 'postgresql'));
  assert(meta.architecture_components.some((c) => c.type === 'third_party_service' && c.name === 'supabase'));
  assert.equal(JSON.stringify(meta).includes(root), false);
  assert.deepEqual(status.mcpPayload, buildMcpPayload(meta));
  assert.equal(JSON.stringify(status.mcpPayload).includes(root), false);

  let sentPayload = null;
  const reported = await runReport(root, {
    transport: async (_endpoint, payload) => {
      sentPayload = payload;
      return '{}';
    },
  });
  assert.equal(reported.ok, true);
  assert.deepEqual(sentPayload, meta);
  const okStatus = JSON.parse(fs.readFileSync(path.join(root, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(okStatus.status, 'ok');
  assert.deepEqual(okStatus.mcpPayload, buildMcpPayload(meta));

  const secondPrepare = prepareReport(root, { spawn: false, trigger: 'second-test' });
  assert.equal(secondPrepare.started, false);
  assert.equal(secondPrepare.reason, 'already-registered');

  const existingIdRoot = makeProject();
  writeFile(existingIdRoot, '.one-mcp-id', `${uuidV7()}\n`);
  const existingPrepare = prepareReport(existingIdRoot, { spawn: false, trigger: 'existing-id-test' });
  assert.equal(existingPrepare.started, false);
  assert.equal(existingPrepare.reason, 'already-registered');
  let called = false;
  const notQueued = await runReport(existingIdRoot, {
    transport: async () => {
      called = true;
    },
  });
  assert.equal(notQueued.skipped, 'not-queued');
  assert.equal(called, false);

  const backfillRoot = makeProject();
  const backfillId = uuidV7();
  writeFile(backfillRoot, '.one-mcp-id', `${backfillId}\n`);
  writeFile(backfillRoot, '.traffic-one/one-mcp-report.json', `${JSON.stringify({
    status: 'queued',
    reportId: backfillId,
    attempts: 0,
  }, null, 2)}\n`);
  const backfilled = prepareReport(backfillRoot, { spawn: false, trigger: 'backfill-test' });
  assert.equal(backfilled.started, false);
  assert.equal(backfilled.reason, 'already-registered');
  assert.equal(backfilled.debugPayloadSaved, true);
  const backfilledStatus = JSON.parse(fs.readFileSync(path.join(backfillRoot, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(backfilledStatus.mcpPayload.params.arguments.report_id, backfillId);

  const hookRoot = makeProject();
  const previousCwd = process.cwd();
  const previousNoSpawn = process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN;
  const previousDisable = process.env.TRAFFIC_ONE_DISABLE_ONE_MCP;
  process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = '1';
  try {
    process.chdir(hookRoot);
    const hookResult = handlers.runPostStackSetup(JSON.stringify({
      tool_input: {
        file_path: path.join(hookRoot, 'package.json'),
      },
    }));
    assert.equal(hookResult.exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    if (previousNoSpawn === undefined) {
      delete process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN;
    } else {
      process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = previousNoSpawn;
    }
    if (previousDisable === undefined) {
      delete process.env.TRAFFIC_ONE_DISABLE_ONE_MCP;
    } else {
      process.env.TRAFFIC_ONE_DISABLE_ONE_MCP = previousDisable;
    }
  }
  const hookId = fs.readFileSync(path.join(hookRoot, '.one-mcp-id'), 'utf8').trim();
  assert.match(hookId, /^[A-Za-z0-9._:-]{1,128}$/);
  const hookStatus = JSON.parse(fs.readFileSync(path.join(hookRoot, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(hookStatus.status, 'queued');
  assert.equal(hookStatus.reportId, hookId);
  assert.equal(hookStatus.mcpPayload.params.arguments.report_id, hookId);

  const absoluteHintRoot = makeProject();
  process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = '1';
  process.env.TRAFFIC_ONE_DISABLE_ONE_MCP = '1';
  try {
    process.chdir(absoluteHintRoot);
    handlers.runPostStackSetup(JSON.stringify({
      tool_input: {
        file_path: path.join(absoluteHintRoot, '.traffic-one.json'),
      },
    }));
  } finally {
    process.chdir(previousCwd);
    delete process.env.TRAFFIC_ONE_DISABLE_ONE_MCP;
  }
  assert.equal(fs.existsSync(path.join(absoluteHintRoot, '.one-mcp-id')), false);

  try {
    process.chdir(os.tmpdir());
    const hookResult = handlers.runPostStackSetup(JSON.stringify({
      tool_input: {
        file_path: path.join(absoluteHintRoot, 'package.json'),
      },
    }));
    assert.equal(hookResult.exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    if (previousNoSpawn === undefined) {
      delete process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN;
    } else {
      process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = previousNoSpawn;
    }
    if (previousDisable === undefined) {
      delete process.env.TRAFFIC_ONE_DISABLE_ONE_MCP;
    } else {
      process.env.TRAFFIC_ONE_DISABLE_ONE_MCP = previousDisable;
    }
  }
  const absoluteHintId = fs.readFileSync(path.join(absoluteHintRoot, '.one-mcp-id'), 'utf8').trim();
  assert.match(absoluteHintId, /^[A-Za-z0-9._:-]{1,128}$/);
  const absoluteHintStatus = JSON.parse(fs.readFileSync(path.join(absoluteHintRoot, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(absoluteHintStatus.status, 'queued');
  assert.equal(absoluteHintStatus.reportId, absoluteHintId);
  assert.equal(absoluteHintStatus.mcpPayload.params.arguments.report_id, absoluteHintId);

  const existingModeRoot = makeProject({ mode: 'existing-codebase' });
  process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = '1';
  try {
    process.chdir(existingModeRoot);
    const hookResult = handlers.runPostStackSetup(JSON.stringify({
      tool_input: {
        file_path: path.join(existingModeRoot, '.traffic-one.json'),
      },
    }));
    assert.equal(hookResult.exitCode, 0);
  } finally {
    process.chdir(previousCwd);
    if (previousNoSpawn === undefined) {
      delete process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN;
    } else {
      process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = previousNoSpawn;
    }
  }
  const existingModeId = fs.readFileSync(path.join(existingModeRoot, '.one-mcp-id'), 'utf8').trim();
  assert.match(existingModeId, /^[A-Za-z0-9._:-]{1,128}$/);

  console.log('one-mcp report tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
