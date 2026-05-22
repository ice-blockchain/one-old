#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-${process.pid}.json`);
const AUTH_CHOICE_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-choice-${process.pid}.json`);
const PLUGIN_ROOT = path.resolve(__dirname, '..');
process.env.TRAFFIC_ONE_AUTH_STATE_PATH = AUTH_STATE_PATH;
process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = AUTH_CHOICE_STATE_PATH;
process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT = 'http://127.0.0.1:8787/mcp';
delete process.env.TRAFFIC_ONE_AUTH_ALLOW_REMOTE_CHECK_FAILURE;
fs.rmSync(AUTH_CHOICE_STATE_PATH, { force: true });

const {
  buildMcpPayload,
  collectMetadata,
  prepareReport,
  runReport,
  uuidV7,
} = require('./one-mcp-report.cjs');
const handlers = require('./hook-runtime/handlers.cjs');
const authClient = require('./traffic-one-auth.cjs');

assert.equal(authClient.authEndpointUrl('http://localhost:8787/mcp').protocol, 'http:');
assert.equal(authClient.authEndpointUrl('http://127.0.0.1:8787/mcp').protocol, 'http:');
assert.equal(authClient.authEndpointUrl('https://example.com/mcp').protocol, 'https:');
assert.throws(
  () => authClient.authEndpointUrl('http://example.com/mcp'),
  /non-HTTPS MCP auth endpoint/,
);
assert.throws(
  () => authClient.authEndpointUrl('https://user:pass@example.com/mcp'),
  /must not include URL credentials/,
);

function seedAuthState(
  expiresAt = '2099-01-01T00:00:00Z',
  lastRemoteCheckedAt = '2099-01-01T00:00:00Z',
) {
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });
  fs.writeFileSync(AUTH_STATE_PATH, `${JSON.stringify({
    version: 1,
    endpoint: process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
    sessionToken: 'tok_test-session-token.signature',
    expiresAt,
    keyId: 'test-key',
    authenticatedAt: '2026-05-21T00:00:00Z',
    lastRemoteCheckedAt,
    lastRemoteCheckOkAt: lastRemoteCheckedAt,
  }, null, 2)}\n`, 'utf8');
}

seedAuthState();

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
    projectContext: {
      source: 'prompted',
      originalPrompt: 'Create a Traffic One project',
      summary: 'Traffic One test project.',
      answers: { audience: 'test users' },
      collectedAt: '2026-05-20T00:00:00Z',
    },
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
      approved: true,
    },
    performance: {
      level: 'high',
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
  const unauthRoot = makeProject();
  const previousAuthStatePath = process.env.TRAFFIC_ONE_AUTH_STATE_PATH;
  process.env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-missing-${process.pid}.json`);
  try {
    const unauthPrepare = prepareReport(unauthRoot, { spawn: false, trigger: 'unauth-test' });
    assert.equal(unauthPrepare.started, false);
    assert.equal(unauthPrepare.reason, 'auth-required');
    assert.equal(fs.existsSync(path.join(unauthRoot, '.one-mcp-id')), false);
    assert.equal(fs.existsSync(path.join(unauthRoot, '.traffic-one', 'agent-log.md')), false);

    const previousCwd = process.cwd();
    try {
      process.chdir(unauthRoot);
      const sessionStart = handlers.runSessionStart();
      const sessionPayload = JSON.parse(sessionStart.stdout);
      assert.equal(sessionPayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.equal(sessionPayload.promptRequest.kind, 'single_select');
      assert.equal(sessionPayload.promptRequest.title, 'Traffic One');
      assert.equal(sessionPayload.promptRequest.blocking, true);
      assert.deepEqual(
        sessionPayload.promptRequest.options.map((option) => option.id),
        ['authenticate', 'continue_without'],
      );
      assert.deepEqual(
        sessionPayload.promptRequest.options.map((option) => option.label),
        ['Authenticate Traffic One (Recommended)', 'Continue without Traffic One'],
      );
      assert.match(sessionPayload.promptRequest.fallbackText, /Traffic One authentication is required/);
      assert.match(sessionPayload.hookSpecificOutput.additionalContext, /Traffic One authentication is required/);
      assert.match(sessionPayload.hookSpecificOutput.additionalContext, /Traffic One is inactive/);
      assert.match(sessionPayload.hookSpecificOutput.additionalContext, /Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin/);
      assert.match(sessionPayload.hookSpecificOutput.additionalContext, /modal selector/);
      assert.doesNotMatch(sessionPayload.hookSpecificOutput.additionalContext, /TRAFFIC_ONE_AUTH_KEY=<test-key>/);

      const promptSubmit = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'Create a Traffic One project',
      }));
      const promptPayload = JSON.parse(promptSubmit.stdout);
      assert.equal(promptPayload.decision, undefined);
      assert.equal(promptPayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.equal(promptPayload.promptRequest.kind, 'single_select');
      assert.deepEqual(
        promptPayload.promptRequest.options.map((option) => option.label),
        ['Authenticate Traffic One (Recommended)', 'Continue without Traffic One'],
      );
      assert.equal(promptPayload.hookSpecificOutput.permissionDecision, undefined);
      assert.match(promptPayload.hookSpecificOutput.additionalContext, /Traffic One authentication is required/);
      assert.match(promptPayload.hookSpecificOutput.additionalContext, /Do you want to authenticate Traffic One now, or continue without using the Traffic One plugin/);
      assert.match(promptPayload.hookSpecificOutput.additionalContext, /Do not answer pending Traffic One onboarding choices/);
      assert.match(promptPayload.hookSpecificOutput.additionalContext, /until the user makes this auth choice/);

      const deniedBeforeChoice = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'apps/web/src/Blocked.tsx', content: 'export const x = 1;\n' },
      }));
      const deniedBeforeChoicePayload = JSON.parse(deniedBeforeChoice.stdout);
      assert.equal(deniedBeforeChoicePayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.equal(deniedBeforeChoicePayload.promptRequest.kind, 'single_select');
      assert.match(deniedBeforeChoicePayload.promptRequest.fallbackText, /authentication choice required/i);
      assert.equal(deniedBeforeChoicePayload.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(deniedBeforeChoicePayload.hookSpecificOutput.permissionDecisionReason, /authentication choice required/i);
      assert.match(deniedBeforeChoicePayload.hookSpecificOutput.permissionDecisionReason, /Do you want to authenticate Traffic One now/);

      const deniedCodexShellBeforeChoice = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'exec_command',
        tool_input: { cmd: 'sed -n 1,40p package.json' },
      }));
      const deniedCodexShellPayload = JSON.parse(deniedCodexShellBeforeChoice.stdout);
      assert.equal(deniedCodexShellPayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.equal(deniedCodexShellPayload.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(deniedCodexShellPayload.hookSpecificOutput.permissionDecisionReason, /authentication choice required/i);

      const allowedCodexAuthCommand = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'exec_command',
        tool_input: { cmd: 'node /tmp/plugin/scripts/traffic-one-auth.cjs status' },
      }));
      assert.equal(allowedCodexAuthCommand.stdout, '');

      {
        const previousChoiceStatePath = process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH;
        const blocker = path.join(os.tmpdir(), `traffic-one-auth-choice-blocker-${process.pid}`);
        fs.rmSync(blocker, { recursive: true, force: true });
        fs.writeFileSync(blocker, 'not a directory\n', 'utf8');
        process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = path.join(blocker, 'choice.json');
        try {
          const writeFailSession = handlers.runSessionStart();
          const writeFailSessionPayload = JSON.parse(writeFailSession.stdout);
          assert.equal(writeFailSessionPayload.promptRequest.id, 'traffic-one.auth.choice');
          assert.match(writeFailSessionPayload.hookSpecificOutput.additionalContext, /could not persist the auth choice state/i);
          assert.doesNotMatch(writeFailSessionPayload.hookSpecificOutput.additionalContext, /PLUGIN MODE: UNKNOWN/);

          const writeFailPrompt = handlers.runUserPromptSubmit(JSON.stringify({
            prompt: 'Build a Traffic One app',
          }));
          const writeFailPromptPayload = JSON.parse(writeFailPrompt.stdout);
          assert.equal(writeFailPromptPayload.promptRequest.id, 'traffic-one.auth.choice');
          assert.match(writeFailPromptPayload.hookSpecificOutput.additionalContext, /could not persist the auth choice state/i);
          assert.doesNotMatch(writeFailPromptPayload.hookSpecificOutput.additionalContext, /PLUGIN MODE: UNKNOWN/);

          const writeFailGate = handlers.runCheckOnboardingGate(JSON.stringify({
            tool_name: 'Write',
            tool_input: { file_path: 'README.md', content: 'blocked while auth choice storage is unavailable\n' },
          }));
          const writeFailGatePayload = JSON.parse(writeFailGate.stdout);
          assert.equal(writeFailGatePayload.hookSpecificOutput.permissionDecision, 'deny');
          assert.equal(writeFailGatePayload.promptRequest.id, 'traffic-one.auth.choice');
        } finally {
          process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = previousChoiceStatePath;
          fs.rmSync(blocker, { force: true });
        }
      }

      fs.rmSync(AUTH_CHOICE_STATE_PATH, { force: true });
      const bareWithoutChoice = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'without',
      }));
      const bareWithoutPayload = JSON.parse(bareWithoutChoice.stdout);
      assert.equal(bareWithoutPayload.systemMessage, 'traffic-one inactive: user chose to continue without Traffic One');

      fs.rmSync(AUTH_CHOICE_STATE_PATH, { force: true });
      const continueChoice = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: "don't use traffic one",
      }));
      const continuePayload = JSON.parse(continueChoice.stdout);
      assert.equal(continuePayload.systemMessage, 'traffic-one inactive: user chose to continue without Traffic One');
      assert.match(continuePayload.hookSpecificOutput.additionalContext, /Proceed with the user request using normal non-Traffic-One behavior only/);
      assert.match(continuePayload.hookSpecificOutput.additionalContext, /Do not run Traffic One skills/);
      assert.match(continuePayload.hookSpecificOutput.additionalContext, /prompt is not repeated/);

      const skipped = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'apps/web/src/AllowedAfterChoice.tsx', content: 'export const x = 1;\n' },
      }));
      assert.equal(skipped.stdout, '');

      const skippedCodexShell = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'exec_command',
        tool_input: { cmd: 'sed -n 1,40p package.json' },
      }));
      assert.equal(skippedCodexShell.stdout, '');

      const noRepeatPrompt = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'Create a normal thing',
      }));
      assert.equal(noRepeatPrompt.stdout, '');

      const noRepeatSession = handlers.runSessionStart();
      assert.equal(noRepeatSession.stdout, '');

      const secondUnauthRoot = makeProject();
      process.chdir(secondUnauthRoot);
      const repeatOtherProjectPrompt = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'Create a normal thing in a different project',
      }));
      const repeatOtherProjectPayload = JSON.parse(repeatOtherProjectPrompt.stdout);
      assert.match(repeatOtherProjectPayload.hookSpecificOutput.additionalContext, /Traffic One authentication is required/);
      assert.match(repeatOtherProjectPayload.hookSpecificOutput.additionalContext, /continue without using the Traffic One plugin/);
      const deniedOtherProjectWrite = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'apps/web/src/BlockedInSecondProject.tsx', content: 'export const x = 1;\n' },
      }));
      const deniedOtherProjectPayload = JSON.parse(deniedOtherProjectWrite.stdout);
      assert.equal(deniedOtherProjectPayload.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(deniedOtherProjectPayload.hookSpecificOutput.permissionDecisionReason, /authentication choice required/i);

      process.chdir(unauthRoot);
      const authenticateChoice = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'authenticate Traffic One',
      }));
      const authenticatePayload = JSON.parse(authenticateChoice.stdout);
      assert.equal(authenticatePayload.systemMessage, 'traffic-one authentication key required');
      assert.equal(authenticatePayload.promptRequest.id, 'traffic-one.auth.api-key');
      assert.equal(authenticatePayload.promptRequest.kind, 'secure_text');
      assert.equal(authenticatePayload.promptRequest.sensitive, true);
      assert.equal(authenticatePayload.promptRequest.blocking, true);
      assert.doesNotMatch(JSON.stringify(authenticatePayload.promptRequest), /tok_test-session-token|<test-key>/);
      assert.match(authenticatePayload.hookSpecificOutput.additionalContext, /Do not continue implementation yet/);
      assert.match(authenticatePayload.hookSpecificOutput.additionalContext, /API key/);
      assert.match(authenticatePayload.hookSpecificOutput.additionalContext, /run authentication internally/);
      assert.doesNotMatch(authenticatePayload.hookSpecificOutput.additionalContext, /show the login command|Please run this|To authenticate, run:/);

      const deniedAfterAuthenticateChoice = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'apps/web/src/BlockedAfterAuthChoice.tsx', content: 'export const x = 1;\n' },
      }));
      const deniedAfterAuthenticatePayload = JSON.parse(deniedAfterAuthenticateChoice.stdout);
      assert.equal(deniedAfterAuthenticatePayload.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(deniedAfterAuthenticatePayload.hookSpecificOutput.permissionDecisionReason, /authentication choice required/i);

      const allowedAuthCommand = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'node /tmp/plugin/scripts/traffic-one-auth.cjs status' },
      }));
      assert.equal(allowedAuthCommand.stdout, '');

      process.chdir(secondUnauthRoot);
      const authenticateCarriesAcrossProjects = handlers.runUserPromptSubmit(JSON.stringify({
        prompt: 'continue this second project',
      }));
      const authenticateAcrossPayload = JSON.parse(authenticateCarriesAcrossProjects.stdout);
      assert.equal(authenticateAcrossPayload.systemMessage, 'traffic-one authentication key required');
      assert.match(authenticateAcrossPayload.hookSpecificOutput.additionalContext, /API key/);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    process.env.TRAFFIC_ONE_AUTH_STATE_PATH = previousAuthStatePath;
    seedAuthState();
  }

  seedAuthState('2099-01-01T00:00:00Z', '2026-05-20T00:00:00Z');
  assert.equal(
    authClient.authRemoteCheckDue(
      authClient.readAuthState(),
      process.env,
      Date.parse('2026-05-21T00:00:01Z'),
    ),
    true,
  );
  seedAuthState('2099-01-01T00:00:00Z', '2026-05-21T00:00:00Z');
  assert.equal(
    authClient.authRemoteCheckDue(
      authClient.readAuthState(),
      process.env,
      Date.parse('2026-05-21T12:00:00Z'),
    ),
    false,
  );

  {
    const remoteFailureRoot = makeProject();
    seedAuthState('2099-01-01T00:00:00Z', '2026-05-20T00:00:00Z');
    const previousCwd = process.cwd();
    try {
      process.chdir(remoteFailureRoot);
      const remoteFailureSession = handlers.runSessionStart();
      const remoteFailurePayload = JSON.parse(remoteFailureSession.stdout);
      assert.equal(remoteFailurePayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.match(remoteFailurePayload.hookSpecificOutput.additionalContext, /Traffic One authentication is required/);
      assert.doesNotMatch(remoteFailurePayload.hookSpecificOutput.additionalContext, /PLUGIN MODE: UNKNOWN/);
    } finally {
      process.chdir(previousCwd);
      seedAuthState();
    }
  }

  seedAuthState('2000-01-01T00:00:00Z');
  assert.equal(fs.existsSync(AUTH_STATE_PATH), true);
  fs.writeFileSync(AUTH_CHOICE_STATE_PATH, `${JSON.stringify({
    version: 1,
    choices: {
      [process.cwd()]: {
        status: 'continue-without-traffic-one',
        cwd: process.cwd(),
        updatedAt: '2026-05-21T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    },
  }, null, 2)}\n`, 'utf8');
  assert.equal(fs.existsSync(AUTH_CHOICE_STATE_PATH), true);
  const logoutResult = await authClient.logout([], process.env);
  assert.equal(logoutResult.ok, true);
  assert.equal(logoutResult.authenticated, false);
  assert.equal(fs.existsSync(AUTH_STATE_PATH), false);
  assert.equal(fs.existsSync(AUTH_CHOICE_STATE_PATH), false);
  const loggedOutStatus = await authClient.status([], process.env);
  assert.equal(loggedOutStatus.authenticated, false);
  assert.equal(loggedOutStatus.reason, 'missing-auth-state');
  seedAuthState();

  {
    const previousChoiceStatePath = process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH;
    const previousAuthStatePath = process.env.TRAFFIC_ONE_AUTH_STATE_PATH;
    try {
      delete process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH;
      process.env.TRAFFIC_ONE_AUTH_STATE_PATH = path.join(os.tmpdir(), `traffic-one-auth-fallback-delete-${process.pid}.json`);
      const authChoicePaths = authClient.authChoiceStatePaths(process.env);
      assert.equal(authChoicePaths.length, 2);
      fs.mkdirSync(path.dirname(authChoicePaths[1]), { recursive: true });
      fs.writeFileSync(authChoicePaths[1], '{"version":3,"choices":{}}\n', 'utf8');
      assert.equal(fs.existsSync(authChoicePaths[1]), true);
      const fallbackLogout = await authClient.logout([], process.env);
      assert.equal(fallbackLogout.ok, true);
      assert.equal(fs.existsSync(authChoicePaths[1]), false);
    } finally {
      process.env.TRAFFIC_ONE_AUTH_CHOICE_STATE_PATH = previousChoiceStatePath;
      process.env.TRAFFIC_ONE_AUTH_STATE_PATH = previousAuthStatePath;
      seedAuthState();
    }
  }

  const expiredRoot = makeProject();
  seedAuthState('2000-01-01T00:00:00Z');
  try {
    const expiredPrepare = prepareReport(expiredRoot, { spawn: false, trigger: 'expired-auth-test' });
    assert.equal(expiredPrepare.started, false);
    assert.equal(expiredPrepare.reason, 'auth-required');
    assert.equal(fs.existsSync(path.join(expiredRoot, '.one-mcp-id')), false);

    const previousCwd = process.cwd();
    try {
      process.chdir(expiredRoot);
      const expiredSessionStart = handlers.runSessionStart();
      const expiredSessionPayload = JSON.parse(expiredSessionStart.stdout);
      assert.equal(expiredSessionPayload.promptRequest.id, 'traffic-one.auth.choice');
      assert.match(expiredSessionPayload.hookSpecificOutput.additionalContext, /Traffic One authentication is required/);
      const skipped = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: 'apps/web/src/Expired.tsx', content: 'export const x = 1;\n' },
      }));
      const skippedPayload = JSON.parse(skipped.stdout);
      assert.equal(skippedPayload.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(skippedPayload.hookSpecificOutput.permissionDecisionReason, /authentication choice required/i);
    } finally {
      process.chdir(previousCwd);
    }
  } finally {
    seedAuthState();
  }

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
  assert.equal(fs.existsSync(path.join(root, '.traffic-one', 'agent-log.md')), false);

  const failedRoot = makeProject();
  const failedPrepared = prepareReport(failedRoot, { spawn: false, trigger: 'failed-transport-test' });
  const failed = await runReport(failedRoot, {
    transport: async () => {
      throw new Error('simulated endpoint failure');
    },
  });
  assert.equal(failed.ok, false);
  const failedStatus = JSON.parse(fs.readFileSync(path.join(failedRoot, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(failedStatus.status, 'failed');
  assert.equal(failedStatus.reportId, failedPrepared.reportId);
  assert.match(failedStatus.error, /simulated endpoint failure/);
  assert.equal(fs.existsSync(path.join(failedRoot, '.traffic-one', 'agent-log.md')), false);

  {
    const previousCwd = process.cwd();
    try {
      process.chdir(failedRoot);
      const gateAfterReportFailure = handlers.runCheckOnboardingGate(JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npm view react version' },
      }));
      assert.doesNotMatch(gateAfterReportFailure.stdout, /permissionDecision/);
      assert.doesNotMatch(gateAfterReportFailure.stdout, /one-mcp/i);
    } finally {
      process.chdir(previousCwd);
    }
  }

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

  const pluginCwdHintRoot = makeProject();
  process.env.TRAFFIC_ONE_ONE_MCP_NO_SPAWN = '1';
  try {
    process.chdir(PLUGIN_ROOT);
    const hookResult = handlers.runPostStackSetup(JSON.stringify({
      tool_input: {
        file_path: path.join(pluginCwdHintRoot, 'package.json'),
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
  const pluginCwdHintId = fs.readFileSync(path.join(pluginCwdHintRoot, '.one-mcp-id'), 'utf8').trim();
  assert.match(pluginCwdHintId, /^[A-Za-z0-9._:-]{1,128}$/);
  const pluginCwdHintStatus = JSON.parse(fs.readFileSync(path.join(pluginCwdHintRoot, '.traffic-one/one-mcp-report.json'), 'utf8'));
  assert.equal(pluginCwdHintStatus.status, 'queued');
  assert.equal(pluginCwdHintStatus.reportId, pluginCwdHintId);
  assert.equal(pluginCwdHintStatus.mcpPayload.params.arguments.report_id, pluginCwdHintId);

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
