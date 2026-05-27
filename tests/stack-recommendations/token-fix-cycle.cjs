'use strict';

module.exports = function registerTokenFixCycleTests(ctx) {
  const {
    assert,
    fs,
    os,
    path,
    spawnSync,
    ROOT,
    HOOK_RUNTIME,
    AUTH_STATE_PATH,
    AUTH_CHOICE_STATE_PATH,
    defaultBackendValue,
    STACKS,
    stackSpecForState,
    templatePath,
    activeSkillsFor,
    computeProjectFingerprint,
    test,
    writeJson,
    seedOpenCodeResolved,
    withTempDir,
    runHook,
    makeExistingProject,
    parseStdoutJson,
    readHookModuleSource,
    readScriptSource,
    readRule,
    readCursorRule,
    readRootAgentContext,
    readClaudeContext,
    sessionContextWithMaterializedRules,
    completeDefaultState,
    compactWebdevAcademyState,
  } = ctx;

test('token-report parseJsonlFile extracts usage from assistant messages', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const jsonl = path.join(cwd, 'fixture.jsonl');
    const line1 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-17T10:00:00Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', name: 'Bash' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000, output_tokens: 50 },
      },
    });
    const line2 = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-05-17T10:01:00Z',
      message: {
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'tool_use', name: 'Write' }, { type: 'tool_use', name: 'Read' }],
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 80 },
      },
    });
    fs.writeFileSync(jsonl, `${line1}\n${line2}\n`);
    const stats = tr.parseJsonlFile(jsonl);
    assert.equal(stats.messages, 2);
    assert.equal(stats.toolUses, 3);
    assert.equal(stats.inputTokens, 150);
    assert.equal(stats.cacheCreationInputTokens, 200);
    assert.equal(stats.cacheReadInputTokens, 3000);
    assert.equal(stats.outputTokens, 130);
    assert.equal(stats.byTool.Bash, 1);
    assert.equal(stats.byTool.Write, 1);
    assert.equal(stats.byTool.Read, 1);
    assert.equal(stats.byModel['claude-sonnet-4-6'].messages, 2);
  });
});

test('token-report discoverSubagents reads agentType from meta.json', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const subDir = path.join(cwd, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'agent-abc.jsonl'), '');
    fs.writeFileSync(path.join(subDir, 'agent-abc.meta.json'), JSON.stringify({ agentType: 'traffic-one:senior-frontend', description: 'Build UI' }));
    fs.writeFileSync(path.join(subDir, 'agent-def.jsonl'), '');
    // No meta for agent-def — should fall back to 'unknown'
    const subs = tr.discoverSubagents(cwd);
    assert.equal(subs.length, 2);
    const frontend = subs.find((s) => s.id === 'agent-abc');
    assert.equal(frontend.agentType, 'traffic-one:senior-frontend');
    assert.equal(frontend.description, 'Build UI');
    const unknown = subs.find((s) => s.id === 'agent-def');
    assert.equal(unknown.agentType, 'unknown');
  });
});

test('token-report estimateCost uses model-specific pricing', () => {
  const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
  const opusStats = { byModel: { 'claude-opus-4-7': {
    inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0,
  } } };
  const sonnetStats = { byModel: { 'claude-sonnet-4-6': {
    inputTokens: 1_000_000, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0,
  } } };
  // Opus input list price = $15/M, Sonnet input list price = $3/M
  assert.equal(tr.estimateCost(opusStats), 15);
  assert.equal(tr.estimateCost(sonnetStats), 3);
});

test('token-report parseCodexJsonlFile extracts Codex totals and Traffic One estimates', () => {
  withTempDir((cwd) => {
    const tr = require(path.join(ROOT, 'scripts', 'token-report.cjs'));
    const jsonl = path.join(cwd, 'rollout-2026-05-18T10-00-00-session.jsonl');
    const lines = [
      {
        timestamp: '2026-05-18T10:00:00Z',
        type: 'session_meta',
        payload: {
          id: 'session',
          timestamp: '2026-05-18T10:00:00Z',
          cwd,
          originator: 'Codex Desktop',
          model: 'gpt-5.2',
          base_instructions: { text: 'Traffic One rules live in .traffic-one/rules.' },
        },
      },
      {
        timestamp: '2026-05-18T10:00:05Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'functions.exec_command' },
      },
      {
        timestamp: '2026-05-18T10:00:06Z',
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          output: 'Original token count: 1,234\nOutput:\nTraffic One .traffic-one/rules materialized.',
        },
      },
      {
        timestamp: '2026-05-18T10:00:10Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 250,
              output_tokens: 60,
              reasoning_output_tokens: 9,
              total_tokens: 1060,
            },
            last_token_usage: {
              input_tokens: 400,
              cached_input_tokens: 100,
              output_tokens: 10,
              reasoning_output_tokens: 3,
              total_tokens: 410,
            },
            model_context_window: 258400,
          },
        },
      },
    ];
    fs.writeFileSync(jsonl, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');

    const report = tr.parseCodexJsonlFile(jsonl);
    assert.equal(report.session.id, 'session');
    assert.equal(report.stats.messages, 1);
    assert.equal(report.stats.toolUses, 1);
    assert.equal(report.stats.inputTokens, 750);
    assert.equal(report.stats.cacheReadInputTokens, 250);
    assert.equal(report.stats.outputTokens, 60);
    assert.equal(report.stats.reasoningOutputTokens, 9);
    assert.equal(report.stats.modelContextWindow, 258400);
    assert.equal(tr.totalTokens(report.stats), 1060);
    assert.equal(report.stats.byModel['gpt-5.2'].messages, 1);
    assert.equal(report.trafficOne.directToolOutputTokens, 1234);
    assert.equal(report.trafficOne.directToolOutputs, 1);
    assert.ok(report.trafficOne.instructionApproxTokens > 0);
  });
});

test('token-logger isEnabled honors TRAFFIC_ONE_TOKEN_LOG env var', () => {
  const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
  const prev = process.env[tl.ENV_FLAG];
  delete process.env[tl.ENV_FLAG];
  assert.equal(tl.isEnabled(), false);
  process.env[tl.ENV_FLAG] = '1';
  assert.equal(tl.isEnabled(), true);
  process.env[tl.ENV_FLAG] = 'true';
  assert.equal(tl.isEnabled(), true);
  process.env[tl.ENV_FLAG] = '0';
  assert.equal(tl.isEnabled(), false);
  if (prev === undefined) delete process.env[tl.ENV_FLAG];
  else process.env[tl.ENV_FLAG] = prev;
});

test('token-logger writes one JSONL line per tool use when enabled', () => {
  withTempDir((cwd) => {
    const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
    const prev = process.env[tl.ENV_FLAG];
    process.env[tl.ENV_FLAG] = '1';
    try {
      tl.logToolUse(cwd, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/foo.ts', content: 'console.log(1);' },
        tool_response: 'ok',
      });
      tl.logToolUse(cwd, {
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        tool_response: 'foo\nbar\n',
      });
    } finally {
      if (prev === undefined) delete process.env[tl.ENV_FLAG];
      else process.env[tl.ENV_FLAG] = prev;
    }
    const logPath = path.join(cwd, tl.LOG_REL_PATH);
    assert.ok(fs.existsSync(logPath));
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const entry1 = JSON.parse(lines[0]);
    assert.equal(entry1.toolName, 'Write');
    assert.equal(entry1.hookEvent, 'PostToolUse');
    assert.ok(entry1.inputBytes > 0);
    assert.ok(entry1.estTokens > 0);
  });
});

test('token-logger is a no-op when env var is unset', () => {
  withTempDir((cwd) => {
    const tl = require(path.join(ROOT, 'scripts', 'hook-runtime', 'token-logger.cjs'));
    const prev = process.env[tl.ENV_FLAG];
    delete process.env[tl.ENV_FLAG];
    try {
      tl.logToolUse(cwd, { tool_name: 'Bash', tool_input: { command: 'ls' } });
    } finally {
      if (prev !== undefined) process.env[tl.ENV_FLAG] = prev;
    }
    assert.equal(fs.existsSync(path.join(cwd, tl.LOG_REL_PATH)), false);
  });
});

test('token-usage-report skill exists with required trigger phrases', () => {
  const skillPath = path.join(ROOT, 'skills-templates', 'token-usage-report', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'token-usage-report SKILL.md missing');
  const text = fs.readFileSync(skillPath, 'utf8');
  assert.match(text, /name:\s*token-usage-report/);
  assert.match(text, /how many tokens/);
  assert.match(text, /TRAFFIC_ONE_TOKEN_LOG/);
  assert.match(text, /token-report\.cjs/);
});

test('token-usage-report is in SKILL_FILTERS._common', () => {
  const { SKILL_FILTERS } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'skill-filters', 'skill-filters.cjs'));
  assert.ok(SKILL_FILTERS._common.has('token-usage-report'), 'token-usage-report not in _common');
});

// ── Fix-cycle slim bundle (2.9.70) ───────────────────────────────────────────

test('getSpawnIndex returns 0 when spawnIndex missing or role not present', () => {
  const { getSpawnIndex } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  assert.equal(getSpawnIndex({}, 'senior-frontend'), 0);
  assert.equal(getSpawnIndex({ spawnIndex: {} }, 'senior-frontend'), 0);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 1 } }, 'senior-frontend'), 1);
  assert.equal(getSpawnIndex({ spawnIndex: { 'senior-frontend': 3 } }, 'senior-frontend'), 3);
});

test('isFixCycleSession requires subagent + spawnIndex > 1', () => {
  const { isFixCycleSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  const fresh = new Date().toISOString();
  const base = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: fresh,
    currentRunId: '2026-05-18T08-00-00Z',
    activeAgentRole: 'senior-frontend',
  };
  // spawnIndex=1 is the FIRST spawn (not a fix-cycle)
  assert.equal(isFixCycleSession({ ...base, spawnIndex: { 'senior-frontend': 1 } }), false);
  // spawnIndex=2 IS a fix-cycle
  assert.equal(isFixCycleSession({ ...base, spawnIndex: { 'senior-frontend': 2 } }), true);
  // Without currentRunId, never a subagent session
  assert.equal(isFixCycleSession({ ...base, currentRunId: null, spawnIndex: { 'senior-frontend': 2 } }), false);
});

test('packFixCycleHeader emits ultra-slim bundle with both pointers', () => {
  const { packFixCycleHeader } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  const { body } = packFixCycleHeader('/cwd', 'senior-frontend', '2026-05-18T08-00-00Z', 2);
  assert.ok(body.length < 1500, `fix-cycle header too large: ${body.length} bytes`);
  assert.match(body, /FIX-CYCLE #1/);
  assert.match(body, /\.traffic-one\/fix-cycles\/2026-05-18T08-00-00Z\/senior-frontend-fix-1\.md/);
  assert.match(body, /\.traffic-one\/digests\/2026-05-18T08-00-00Z\/frontend\.md/);
  assert.match(body, /do not re-explore/i);
});

test('roleDigestName maps senior-* to short digest filename', () => {
  const { roleDigestName } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  assert.equal(roleDigestName('senior-frontend'), 'frontend');
  assert.equal(roleDigestName('senior-backend'), 'backend');
  assert.equal(roleDigestName('senior-architect'), 'architect');
  assert.equal(roleDigestName('senior-reviewer'), 'reviewer');
  assert.equal(roleDigestName('senior-tester'), 'tester');
  assert.equal(roleDigestName('senior-shipper'), 'shipper');
});

test('runSessionStart emits ultra-slim bundle for fix-cycle re-spawn', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: '2.9.70',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-18T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.70',
      currentRunId: '2026-05-18T11-00-00Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 2 },
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.ok(context.length < 1500, `fix-cycle bundle too large: ${context.length} bytes`);
    assert.match(context, /FIX-CYCLE #1/);
    assert.match(context, /fix-cycles/);
    assert.match(context, /do not re-explore/i);
    // Should NOT include the role-scoped rule index that the standard subagent branch emits
    assert.ok(!context.includes('## Active rule index'), 'fix-cycle leaked rule index');
  });
});

test('runSessionStart emits standard slim bundle when spawnIndex is 1', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: '2.9.70',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-18T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.70',
      currentRunId: '2026-05-18T11-00-00Z',
      activeAgentRole: 'senior-frontend',
      spawnIndex: { 'senior-frontend': 1 },
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    // First spawn should get the standard subagent slim bundle with rule index, NOT fix-cycle
    assert.match(context, /## Active rule index/);
    assert.ok(!context.includes('FIX-CYCLE'), 'first spawn should not be fix-cycle');
  });
});
};
