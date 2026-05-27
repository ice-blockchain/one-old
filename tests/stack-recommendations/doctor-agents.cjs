'use strict';

module.exports = function registerDoctorAgentsTests(ctx) {
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
    writeJsonRaw,
    readProjectState,
    readEffectiveState,
    readProjectPrefs,
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

test('doctor.cjs flags ad hoc state that skipped required performance and team confirmation', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: {
      projectMode: 'new-project',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase-ready',
      mobile: { framework: 'web-only' },
      codeGraphProvider: 'GitNexus',
      subagentTeam: 'enabled',
    },
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project,
  });
  const codes = findings.map((f) => f.code);
  assert.ok(codes.includes('LEGACY_TRAFFIC_ONE_STATE'), JSON.stringify(findings, null, 2));
  assert.ok(codes.includes('NONCANONICAL_CODE_GRAPH_PROVIDER'), JSON.stringify(findings, null, 2));
  assert.ok(codes.includes('INCOMPLETE_ONBOARDING_STATE'), JSON.stringify(findings, null, 2));
  const incomplete = findings.find((f) => f.code === 'INCOMPLETE_ONBOARDING_STATE');
  assert.match(incomplete.message, /performance/);
  assert.match(incomplete.message, /team\.approved|Team Confirmation/);
});

test('doctor.cjs flags persisted onboardingComplete=false even when normalization can repair it', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: completeDefaultState({
      codeGraphProvider: 'graphify',
      onboardingComplete: false,
    }),
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project,
  });
  const incomplete = findings.find((f) => f.code === 'INCOMPLETE_ONBOARDING_STATE');
  assert.ok(incomplete, JSON.stringify(findings, null, 2));
  assert.match(incomplete.message, /onboardingComplete/);
});

test('doctor.cjs flags GITNEXUS_IN_OLD_NVM_NODE when gitnexus on PATH lives in old nvm folder', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      mode: 'new-project',
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
    });
    const node = { runningMajor: 22, runningVersion: '22.0.0', onPath: '/x/v22.0.0/bin/node', requiredMajor: 22 };
    const nvm = { installed: true, hasV22: true, v22Paths: { version: 'v22.0.0' }, installCommand: null };
    const gitnexus = {
      onPath: '/Users/cosmin/.nvm/versions/node/v20.18.3/bin/gitnexus',
      absoluteV22: '/Users/cosmin/.nvm/versions/node/v22.0.0/bin/gitnexus',
      crashRiskInOldNvm: true,
    };
    const project = {
      cwd,
      hasState: true,
      state: { codeGraphProvider: 'gitnexus', mode: 'new-project' },
      nvmrc: null,
      hasGit: false,
      artefacts: { gitnexus: null, graphify: null },
    };
    const findings = buildFindings({ node, nvm, gitnexus, project });
    const crashFinding = findings.find((f) => f.code === 'GITNEXUS_IN_OLD_NVM_NODE');
    assert.ok(crashFinding, JSON.stringify(findings, null, 2));
    assert.equal(crashFinding.severity, 'fix-needed');
    assert.match(crashFinding.message, /npm install -g gitnexus/);
  });
});

test('doctor.cjs flags NVMRC_PINNED_TO_OLD_NODE when project .nvmrc < 22 + provider is gitnexus', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const node = { runningMajor: 22, requiredMajor: 22 };
  const nvm = { installed: true, hasV22: true };
  const gitnexus = { crashRiskInOldNvm: false };
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: { codeGraphProvider: 'gitnexus', mode: 'new-project' },
    nvmrc: '20.11.0',
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({ node, nvm, gitnexus, project });
  const f = findings.find((x) => x.code === 'NVMRC_PINNED_TO_OLD_NODE');
  assert.ok(f, JSON.stringify(findings, null, 2));
  assert.equal(f.severity, 'fix-needed');
  assert.match(f.message, /\.nvmrc/);
});

test('doctor.cjs flags Codex workspace trust gaps that can skip hooks', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project: {
      cwd: '/Users/test/Documents/__1',
      hasState: false,
      state: null,
      nvmrc: null,
      hasGit: true,
      artefacts: { gitnexus: null, graphify: null },
    },
    codexHooks: {
      configExists: true,
      cwd: '/Users/test/Documents/__1',
      pluginEnabled: true,
      hookStateEntryCount: 4,
      hookStateEnabledCount: 4,
      hookStateTrustedHashCount: 4,
      missingHookEvents: [],
      trustCovered: false,
      trustedProject: null,
    },
  });
  const f = findings.find((x) => x.code === 'CODEX_WORKSPACE_UNTRUSTED');
  assert.ok(f, JSON.stringify(findings, null, 2));
  assert.equal(f.severity, 'fix-needed');
  assert.match(f.message, /not covered by a trusted Codex project root/);
  assert.match(f.message, /\/Users\/test\/Documents\/__1/);
});

test('doctor.cjs reports missing mcp-auth env without blocking ordinary Codex startup', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { probeMcpAuth, buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const mcpAuth = probeMcpAuth({});
  assert.equal(mcpAuth.configured, true);
  assert.equal(mcpAuth.bearerTokenEnvVar, 'TRAFFIC_ONE_AUTH_KEY');
  assert.equal(mcpAuth.envPresent, false);
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project: {
      cwd: '/tmp/project',
      hasState: true,
      state: completeDefaultState(),
      normalizedState: completeDefaultState(),
      nvmrc: null,
      hasGit: true,
      artefacts: { gitnexus: null, graphify: null },
    },
    mcpAuth,
  });
  const f = findings.find((x) => x.code === 'MCP_AUTH_ENV_MISSING');
  assert.ok(f, JSON.stringify(findings, null, 2));
  assert.equal(f.severity, 'fix-needed');
  assert.match(f.message, /Traffic One features must stay gated/);
  assert.doesNotMatch(f.message, /test-session-token|tok_/);
});

test('doctor.cjs diagnoses no-hook Codex sessions and expired auth at session start', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const {
    analyzeCodexSessionFile,
    buildFindings,
    resolveCodexSession,
  } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));

  withTempDir((home) => {
    const id = '019e4f97-fca1-7370-819e-03d099ed9f00';
    const sessionsDir = path.join(home, '.codex', 'sessions', '2026', '05', '22');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const jsonl = path.join(sessionsDir, `rollout-2026-05-22T15-10-21-${id}.jsonl`);
    const authPath = path.join(home, '.traffic-one', 'auth.json');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    writeJson(authPath, {
      version: 1,
      endpoint: process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
      sessionToken: 'tok_fixture-session-token.signature',
      expiresAt: '2026-05-22T10:59:16Z',
    });
    fs.writeFileSync(jsonl, [
      JSON.stringify({
        timestamp: '2026-05-22T12:10:26.893Z',
        type: 'session_meta',
        payload: {
          id,
          timestamp: '2026-05-22T12:10:21.248Z',
          cwd: '/Users/test/Documents/__@',
          base_instructions: { text: 'You are Codex.' },
          user_instructions: { text: '# User Defaults' },
        },
      }),
      JSON.stringify({
        timestamp: '2026-05-22T12:28:11.219Z',
        type: 'response_item',
        payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Add File: /Users/test/Projects/Codex/fullstack-portfolio/package.json\n+{}\n*** End Patch\n',
        },
      }),
    ].join('\n') + '\n', 'utf8');

    assert.equal(resolveCodexSession(id, { HOME: home }), jsonl);
    const sessionDiagnostics = {
      found: true,
      ...analyzeCodexSessionFile(jsonl, {
        HOME: home,
        TRAFFIC_ONE_AUTH_STATE_PATH: authPath,
        TRAFFIC_ONE_MCP_KEY_ENDPOINT: process.env.TRAFFIC_ONE_MCP_KEY_ENDPOINT,
      }),
    };
    assert.equal(sessionDiagnostics.hookPayloadCount, 0);
    assert.equal(sessionDiagnostics.promptRequestCount, 0);
    assert.equal(sessionDiagnostics.trafficOneInstructionInjected, false);
    assert.equal(sessionDiagnostics.authState.expiredAtSessionStart, true);
    assert.equal(sessionDiagnostics.mutatingToolBeforeAuthGate, true);

    const findings = buildFindings({
      node: { runningMajor: 22, requiredMajor: 22 },
      nvm: { installed: true, hasV22: true },
      gitnexus: { crashRiskInOldNvm: false },
      project: {
        cwd: '/Users/test/Documents/__@',
        hasState: true,
        state: completeDefaultState(),
        normalizedState: completeDefaultState(),
        nvmrc: null,
        hasGit: true,
        artefacts: { gitnexus: null, graphify: null },
      },
      sessionDiagnostics,
    });
    for (const code of [
      'CODEX_HOOKS_NOT_INVOKED_FOR_SESSION',
      'TRAFFIC_ONE_INSTRUCTIONS_NOT_INJECTED',
      'TRAFFIC_ONE_AUTH_EXPIRED_AT_SESSION_START',
      'SESSION_MUTATED_BEFORE_TRAFFIC_ONE_AUTH_GATE',
    ]) {
      assert.ok(findings.some((f) => f.code === code), `${code} missing from ${JSON.stringify(findings, null, 2)}`);
    }
  });
});

test('doctor.cjs parses Codex plugin, hook, and trusted project config', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { probeCodexHooks } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  withTempDir((home) => {
    const codexHome = path.join(home, '.codex');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      '[plugins."traffic-one@traffic-one-local"]',
      'enabled = true',
      '',
      '[hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:session_start:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:abc"',
      '',
      '[hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:user_prompt_submit:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:def"',
      '',
      '[hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:pre_tool_use:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:ghi"',
      '',
      '[hooks.state."traffic-one@traffic-one-local:hooks/hooks.json:post_tool_use:0:0"]',
      'enabled = true',
      'trusted_hash = "sha256:jkl"',
      '',
      `[projects."${path.join(home, 'trusted')}"]`,
      'trust_level = "trusted"',
      '',
    ].join('\n'));
    const probe = probeCodexHooks(path.join(home, 'trusted', 'child'), { CODEX_HOME: codexHome });
    assert.equal(probe.configExists, true);
    assert.equal(probe.pluginEnabled, true);
    assert.equal(probe.hookStateEntryCount, 4);
    assert.equal(probe.hookStateTrustedHashCount, 4);
    assert.equal(probe.trustCovered, true);
    assert.deepEqual(probe.missingHookEvents, []);
  });
});

test('traffic-one-doctor skill exists with required trigger phrases', () => {
  const skillPath = path.join(ROOT, 'skills-templates', 'traffic-one-doctor', 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), 'skill file must exist');
  const text = fs.readFileSync(skillPath, 'utf8');
  // Required trigger phrases so the model picks it up on common user wording.
  for (const phrase of ['traffic one doctor', 'graph isn\'t working', '/doctor', 'gitnexus isn\'t running']) {
    assert.match(text, new RegExp(phrase.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'), 'i'), `missing trigger: ${phrase}`);
  }
  // Must reference the underlying script.
  assert.match(text, /scripts\/doctor\.cjs/);
  // Must be read-only — no install/modify language.
  assert.match(text, /read-only|never installs/i);
});

test('Traffic One entry and implementation skills fail closed when hooks are absent', () => {
  const skillPaths = [
    path.join(ROOT, 'skills', 'detect-project', 'SKILL.md'),
    path.join(ROOT, 'skills', 'stack-setup', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'detect-project', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'stack-setup', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'nextjs-turbopack', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'frontend-design', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-feature', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-page', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-service', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-component', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-native-feature', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-native-screen', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-native-service', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'create-native-component', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'tdd-workflow', 'SKILL.md'),
    path.join(ROOT, 'skills-templates', 'senior-eng-orchestrator', 'SKILL.md'),
  ];
  for (const skillPath of skillPaths) {
    const text = fs.readFileSync(skillPath, 'utf8');
    assert.match(text, /If hooks are absent or auth status is unknown/i, skillPath);
    assert.match(text, /do not infer "Traffic One inactive"/i, skillPath);
    assert.match(text, /continue ordinary work without Traffic One/i, skillPath);
  }
});

test('root agent instructions include Traffic One no-hook fallback guard', () => {
  for (const fileName of ['AGENTS.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
    assert.match(text, /If Traffic One skills are visible but hooks or these root instructions were not injected/);
    assert.match(text, /do not infer "Traffic One inactive"/);
    assert.match(text, /Continue ordinary work without Traffic One only after the user explicitly chooses/);
  }
});

test('nextjs-turbopack skill has Traffic One auth and onboarding guards', () => {
  const skillPath = path.join(ROOT, 'skills-templates', 'nextjs-turbopack', 'SKILL.md');
  const text = fs.readFileSync(skillPath, 'utf8');
  assert.match(text, /Traffic One Auth Preflight/);
  assert.match(text, /verify Traffic One auth/);
  assert.match(text, /Authenticate Traffic One \(Recommended\)/);
  assert.match(text, /Continue without Traffic One/);
  assert.match(text, /onboardingComplete: true/);
  assert.match(text, /stack-setup/);
});

test('gitnexus-runner respects codeGraphAutoRun: false (provider-agnostic opt-out)', () => {
  const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      stack: 'react-realtime-monorepo',
      codeGraphProvider: 'gitnexus',
      codeGraphAutoRun: false,
    });
    const result = bootstrap(cwd);
    assert.equal(result.ok, false);
    assert.equal(result.action, 'install-skipped');
    assert.match(result.error || '', /codeGraphAutoRun is false/);
  });
});

test('gitnexus-runner auto-passes --skip-git when project has no .git directory + surfaces stdout in error', () => {
  // Regression for trading-game: fresh scaffolds typically have no `.git/`
  // yet. GitNexus refuses non-git folders by default and writes the tip
  //   "Tip: pass --skip-git to index any folder without a .git directory."
  // to STDOUT (not stderr). The runner used to only surface `run.stderr`,
  // so users saw an opaque "gitnexus exited non-zero" with no clue why.
  // Two fixes: auto-pass `--skip-git` when `.git/` is absent, AND fall back
  // to `run.stdout` in the error message when stderr is empty.
  const runnerSrc = readScriptSource('gitnexus-runner');

  // The runner must conditionally append `--skip-git` based on a `.git/`
  // existence check at the project root. Match flexibly to keep the assert
  // resilient to small refactors.
  assert.match(runnerSrc, /existsSync\([^)]*'\.git'[^)]*\)/);
  assert.match(runnerSrc, /['"]--skip-git['"]/);

  // The non-zero-exit branch must include `run.stdout` in the error fallback
  // chain so stdout-only tips (like the --skip-git hint) reach the user.
  assert.match(
    runnerSrc.replace(/\s+/g, ' '),
    /run\.stderr\s*\|\|\s*run\.stdout/,
  );

  // Sanity: the runGitnexus helper exposes a `skippedGit` flag downstream
  // diagnostics can use (kept stable so future hook banners can surface it).
  assert.match(runnerSrc, /skippedGit/);
});

test('gitnexus-runner does not refuse when gitnexus is on PATH (trust user PATH)', () => {
  // v2.8.1 behaviour: when an `gitnexus` binary already lives on PATH, the
  // runner trusts the user's setup and tries it — even when the active
  // process is on Node <22. If that binary turns out to crash, the
  // resulting stderr/stdout is surfaced in the error stamp so the user
  // gets a specific diagnosis. Refusal pre-flight only fires when there
  // is NO usable path forward (no absolute nvm-v22 binary, no PATH
  // binary, no v22 npm to install with).
  //
  // Regression motivation: when the user has gitnexus installed via a
  // non-nvm mechanism (Homebrew, custom prefix, fork) the runner should
  // not pre-emptively refuse based on `process.versions.node` alone.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    // Fake gitnexus binary that exits 0 (no `.gitnexus/` produced).
    const fakeBin = path.join(cwd, '.fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    const fakeGitnexus = path.join(fakeBin, 'gitnexus');
    fs.writeFileSync(fakeGitnexus, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(fakeGitnexus, 0o755);

    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = `${fakeBin}:/usr/bin:/bin`;
    process.env.HOME = cwd;  // no `.nvm/` -> findNvmNode22 returns null
    try {
      const { bootstrap } = require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      const result = bootstrap(cwd, { nodeMajor: 20 });
      // Must NOT be a version-mismatch refusal. The runner uses the on-PATH
      // binary, then reports "gitnexus ran but `.gitnexus/` was not
      // produced" (because the fake binary doesn't actually generate it).
      assert.notEqual(result.action, 'node-version-mismatch');
      assert.equal(result.ok, false);
      assert.match(result.error || '', /\.gitnexus\/?.*not produced/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

test('gitnexus-runner refuses on Node <22 with the actionable upgrade command', () => {
  // Stub HOME so `findNvmNode22()` returns null and the refusal branch
  // fires deterministically regardless of what's installed on the host.
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
  withTempDir((cwd) => {
    const prevPath = process.env.PATH;
    const prevHome = process.env.HOME;
    process.env.PATH = '/nonexistent-path-that-does-not-exist';
    process.env.HOME = cwd;
    try {
      const { bootstrap, GITNEXUS_MIN_NODE_MAJOR, currentNodeMajor } =
        require(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'));
      // Sanity-check the helpers exist + behave as documented.
      assert.equal(GITNEXUS_MIN_NODE_MAJOR, 22);
      assert.ok(typeof currentNodeMajor() === 'number' || currentNodeMajor() === null);

      const result = bootstrap(cwd, { nodeMajor: 20 });
      assert.equal(result.ok, false);
      assert.equal(result.action, 'node-version-mismatch');
      assert.equal(result.nodeMajor, 20);
      assert.equal(result.requiredNodeMajor, 22);
      // Banner must contain the exact upgrade sequence so the agent can
      // relay it verbatim to beginner users.
      assert.match(result.error, /Node >=22/);
      assert.match(result.error, /nvm install 22/);
      assert.match(result.error, /nvm alias default 22/);
      // Must offer the graphify fallback so users on locked Node can switch.
      assert.match(result.error, /graphify/);

      // The runner must stamp local prefs so subsequent runs surface the error
      // in the orchestrator summary without mutating committed project state.
      const state = readProjectPrefs(cwd);
      assert.match(state.gitnexusLastError, /Node >=22/);
      assert.match(state.gitnexusLastErrorAt, /^\d{4}-\d{2}-\d{2}T/);
    } finally {
      process.env.PATH = prevPath;
      process.env.HOME = prevHome;
      delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'gitnexus-runner.cjs'))];
    }
  });
});

// ── Toolchain version tracking (2.9.69) ────────────────────────────────────

test('toolchain spec lists gitnexus + graphify + security scanners with valid semver', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  const spec = tch.loadSpec();
  for (const name of ['gitnexus', 'graphify', 'gitleaks', 'trufflehog']) {
    const entry = spec[name];
    assert.ok(entry, `spec must include ${name}`);
    assert.match(entry.recommended, /^\d+\.\d+\.\d+$/, `${name}.recommended must be a semver`);
    assert.match(entry.minimum, /^\d+\.\d+\.\d+$/, `${name}.minimum must be a semver`);
    // recommended must be >= minimum.
    assert.ok(tch.compareSemver(entry.recommended, entry.minimum) >= 0, `${name}.recommended must be >= minimum`);
    assert.ok(entry.versionCommand, `${name} must declare versionCommand`);
    assert.ok(entry.installCommand, `${name} must declare installCommand`);
  }
});

test('toolStatus classifies current / outdated / too-old / missing correctly', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  // gitnexus spec: minimum 1.0.0, recommended 1.6.4.
  assert.equal(tch.toolStatus('gitnexus', '1.6.4').status, 'current');
  assert.equal(tch.toolStatus('gitnexus', '2.0.0').status, 'current');
  assert.equal(tch.toolStatus('gitnexus', '1.5.0').status, 'outdated');
  assert.equal(tch.toolStatus('gitnexus', '0.9.0').status, 'too-old');
  assert.equal(tch.toolStatus('gitnexus', null).status, 'missing');
  assert.equal(tch.toolStatus('unknown-tool', '1.0.0').status, 'unknown');
});

test('compareSemver handles equal, less, greater, malformed', () => {
  const { compareSemver } = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('1.2.3', '1.2.4'), -1);
  assert.equal(compareSemver('2.0.0', '1.9.9'), 1);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0); // tolerant `v` prefix
  assert.equal(compareSemver('1.2', '1.2.3'), null); // malformed → null
  assert.equal(compareSemver('abc', '1.2.3'), null);
});

test('mergeToolchainStamp writes installedVersion + installedAt under toolchain.<name>', () => {
  const tch = require(path.join(ROOT, 'scripts', 'toolchain.cjs'));
  const before = { stack: 'react-realtime-monorepo', otherField: 'preserved' };
  const after = tch.mergeToolchainStamp(before, 'gitnexus', {
    version: '1.6.4',
    binPath: '/usr/local/bin/gitnexus',
    at: '2026-05-13T00:00:00Z',
  });
  assert.equal(after.otherField, 'preserved', 'sibling state fields must survive');
  assert.equal(after.toolchain.gitnexus.installedVersion, '1.6.4');
  assert.equal(after.toolchain.gitnexus.installedAt, '2026-05-13T00:00:00Z');
  assert.equal(after.toolchain.gitnexus.binPath, '/usr/local/bin/gitnexus');
});

test('doctor.cjs flags TOOLCHAIN_OUTDATED (severity info) when installed < recommended but >= minimum', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const node = { runningMajor: 22, requiredMajor: 22 };
  const nvm = { installed: true, hasV22: true };
  const gitnexus = { crashRiskInOldNvm: false };
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: {
      codeGraphProvider: 'gitnexus',
      mode: 'new-project',
      toolchain: { gitnexus: { installedVersion: '1.5.0' } },  // < recommended 1.6.4 but > minimum 1.0.0
    },
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({ node, nvm, gitnexus, project });
  const drift = findings.find((f) => f.code === 'TOOLCHAIN_OUTDATED' && f.tool === 'gitnexus');
  assert.ok(drift, JSON.stringify(findings, null, 2));
  assert.equal(drift.severity, 'info');
  assert.match(drift.message, /1\.5\.0/);
  assert.match(drift.message, /1\.6\.4/);
  assert.ok(drift.recommendedCommand);
});

test('doctor.cjs flags TOOLCHAIN_OUTDATED (severity fix-needed) when installed < minimum', () => {
  delete require.cache[require.resolve(path.join(ROOT, 'scripts', 'doctor.cjs'))];
  const { buildFindings } = require(path.join(ROOT, 'scripts', 'doctor.cjs'));
  const project = {
    cwd: '/tmp',
    hasState: true,
    state: {
      codeGraphProvider: 'graphify',
      mode: 'new-project',
      toolchain: { graphify: { installedVersion: '0.3.0' } },  // below minimum 0.4.0
    },
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
  };
  const findings = buildFindings({
    node: { runningMajor: 22, requiredMajor: 22 },
    nvm: { installed: true, hasV22: true },
    gitnexus: { crashRiskInOldNvm: false },
    project,
  });
  const drift = findings.find((f) => f.code === 'TOOLCHAIN_OUTDATED' && f.tool === 'graphify');
  assert.ok(drift, JSON.stringify(findings, null, 2));
  assert.equal(drift.severity, 'fix-needed');
  assert.match(drift.message, /minimum supported is 0\.4\.0/);
});

test('SessionStart tokenEconomyBanner surfaces a one-line toolchain nudge per drifted tool', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: 2,
      mode: 'existing-codebase',
      stack: 'react-realtime-monorepo',
      backend: 'supabase',
      realtime: 'none',
      codeGraphProvider: 'gitnexus',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-13T00:00:00Z',
      toolchain: {
        gitnexus: { installedVersion: '1.5.0' },  // outdated, not too-old
        graphify: { installedVersion: '0.3.0' },  // too-old
      },
    });
    // Make it look like an existing project so detection accepts the state.
    makeExistingProject(cwd, { react: '^18.0.0' });

    const result = runHook(cwd, 'session-start');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /\[toolchain\] gitnexus 1\.5\.0 installed; recommended is 1\.6\.4/);
    assert.match(context, /\[toolchain\] graphify 0\.3\.0 is below the minimum supported \(0\.4\.0\)/);
  });
});

test('manifests bumped to 2.9.69', () => {
  for (const rel of [
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
    '.cursor-plugin/plugin.json',
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.match(text, /"version":\s*"2\.9\.69"/, `${rel} must be bumped to 2.9.69`);
  }
});

// ── Per-subagent rule scoping (2.9.69) ──────────────────────────────────────

test('isSubagentSession returns true when currentRunId + fresh materialization match', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  const fresh = new Date().toISOString();
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: fresh,
    currentRunId: '2026-05-17T08-00-00Z',
  };
  assert.equal(isSubagentSession(state), true);
});

test('isSubagentSession returns false when materialization is stale (>30 min)', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: stale,
    currentRunId: '2026-05-17T08-00-00Z',
  };
  assert.equal(isSubagentSession(state), false);
});

test('isSubagentSession returns false when currentRunId is missing', () => {
  const { isSubagentSession } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'state', 'state.cjs'));
  const state = {
    stack: 'default', frontend: 'react-vite', backend: 'supabase',
    mobile: { framework: 'none' },
    materializedStack: 'default|react-vite|supabase|none',
    materializedAt: new Date().toISOString(),
  };
  assert.equal(isSubagentSession(state), false);
});

test('AGENT_ROLE_BASE_RULES covers all 6 senior roles with curated sets', () => {
  const { AGENT_ROLE_BASE_RULES } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks', 'stacks.cjs'));
  const roles = ['senior-architect', 'senior-frontend', 'senior-backend',
                 'senior-reviewer', 'senior-tester', 'senior-shipper'];
  for (const role of roles) {
    assert.ok(Array.isArray(AGENT_ROLE_BASE_RULES[role]), `${role} missing`);
    assert.ok(AGENT_ROLE_BASE_RULES[role].length >= 3, `${role} has too few rules`);
  }
});

test('roleScopedRules excludes non-relevant rules per role', () => {
  const { roleScopedRules } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'stacks', 'stacks.cjs'));
  const state = { stack: 'default', frontend: 'react-vite', backend: 'supabase', mobile: { framework: 'none' } };
  const frontendRules = roleScopedRules('senior-frontend', state);
  const backendRules  = roleScopedRules('senior-backend', state);
  const reviewerRules = roleScopedRules('senior-reviewer', state);
  // Frontend gets frontend rules, no backend rules
  assert.ok(frontendRules.some((r) => r.startsWith('rules/frontend/')), 'frontend missing frontend rules');
  assert.ok(!frontendRules.some((r) => r.startsWith('rules/backend/')), 'frontend should not have backend rules');
  // Backend gets backend rules, no frontend rules
  assert.ok(backendRules.some((r) => r.startsWith('rules/backend/')), 'backend missing backend rules');
  assert.ok(!backendRules.some((r) => r.startsWith('rules/frontend/')), 'backend should not have frontend rules');
  // Reviewer sees both for cross-cutting review
  assert.ok(reviewerRules.some((r) => r.startsWith('rules/common/security.md')), 'reviewer missing security');
});

test('packRuleIndex emits bullet list of paths, no rule content', () => {
  const { packRuleIndex } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'packing.cjs'));
  const rules = ['rules/common/security.md', 'rules/common/clean-code.md', 'rules/core.md'];
  const { body } = packRuleIndex(ROOT, rules);
  assert.match(body, /## Active rule index/);
  assert.match(body, /- \.traffic-one\/rules\/common\/security\.md/);
  assert.doesNotMatch(body, /\.traffic-one\/rules\/active/);
  assert.ok(body.length < 5000, `index too large: ${body.length} bytes`);
  // Should NOT contain actual rule content (no '# Security Baseline' from security.md)
  assert.ok(!body.includes('# Security Baseline'), 'index leaked rule content');
});

test('runSessionStart emits slim bundle when state.currentRunId is set', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: '2.9.69',
      stack: 'default',
      frontend: 'react-vite',
      backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      realtime: 'none',
      confirmed: true,
      onboardingComplete: true,
      confirmedAt: '2026-05-17T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.69',
      currentRunId: '2026-05-17T11-00-00Z',
      activeAgentRole: 'senior-frontend',
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.ok(context.length < 8000, `subagent bundle too large: ${context.length} bytes`);
    assert.match(context, /subagent/i);
    assert.match(context, /senior-frontend/);
    // Should NOT include full rule content (no '# ── rules/' headers from packBundle)
    assert.ok(!context.includes('# ── rules/'), 'subagent bundle leaked rule content');
  });
});

test('codex worker spawn creates per-agent run claim without activeAgentRole', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const prevCodexRoot = process.env.CODEX_PLUGIN_ROOT;
    process.env.CODEX_PLUGIN_ROOT = ROOT;
    try {
      const result = runHook(cwd, 'check-agent-model', {
        session_id: 'parent-session',
        tool_name: 'spawn_agent',
        tool_input: {
          agent_type: 'worker',
          model: 'gpt-5-codex',
          message: 'You are acting as Traffic One senior-backend for this run.',
        },
      });
      assert.equal(result.stdout, '');
    } finally {
      if (prevCodexRoot === undefined) delete process.env.CODEX_PLUGIN_ROOT;
      else process.env.CODEX_PLUGIN_ROOT = prevCodexRoot;
    }

    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));
    assert.ok(state.currentRunId, 'currentRunId should be stamped');
    assert.equal(state.activeAgentRole, undefined, 'new run claims must not use shared activeAgentRole');
    assert.equal(state.spawnIndex['senior-backend'], 1);

    const pendingDir = path.join(cwd, '.traffic-one', 'runs', state.currentRunId, 'pending');
    const files = fs.readdirSync(pendingDir).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1);
    const claim = JSON.parse(fs.readFileSync(path.join(pendingDir, files[0]), 'utf8'));
    assert.equal(claim.role, 'senior-backend');
    assert.equal(claim.parentSessionId, 'parent-session');
  });
});

test('subagent SessionStart claims pending run state by child session id', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const prevCodexRoot = process.env.CODEX_PLUGIN_ROOT;
    process.env.CODEX_PLUGIN_ROOT = ROOT;
    try {
      runHook(cwd, 'check-agent-model', {
        session_id: 'parent-session',
        tool_name: 'spawn_agent',
        tool_input: {
          agent_type: 'worker',
          model: 'gpt-5-codex',
          message: 'You are acting as Traffic One senior-backend for this run.',
        },
      });
    } finally {
      if (prevCodexRoot === undefined) delete process.env.CODEX_PLUGIN_ROOT;
      else process.env.CODEX_PLUGIN_ROOT = prevCodexRoot;
    }

    const state = JSON.parse(fs.readFileSync(path.join(cwd, '.traffic-one/.one.json'), 'utf8'));
    const result = runHook(cwd, 'session-start', {
      session_id: 'child-backend-session',
      thread_source: 'subagent',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'parent-session',
          },
        },
      },
    });
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /senior-backend/);
    assert.match(context, new RegExp(state.currentRunId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const claimedPath = path.join(cwd, '.traffic-one', 'runs', state.currentRunId, 'child-backend-session.json');
    assert.ok(fs.existsSync(claimedPath), 'child session claim file should exist');
    const claimed = JSON.parse(fs.readFileSync(claimedPath, 'utf8'));
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.role, 'senior-backend');
  });
});

test('fresh per-agent run claim survives an older materialization timestamp', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });

    const statePath = path.join(cwd, '.traffic-one/.one.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.materializedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    writeJson(statePath, state);

    const prevCodexRoot = process.env.CODEX_PLUGIN_ROOT;
    process.env.CODEX_PLUGIN_ROOT = ROOT;
    try {
      runHook(cwd, 'check-agent-model', {
        session_id: 'parent-session',
        tool_name: 'spawn_agent',
        tool_input: {
          agent_type: 'worker',
          model: 'gpt-5-codex',
          message: 'You are acting as Traffic One senior-backend for this run.',
        },
      });
    } finally {
      if (prevCodexRoot === undefined) delete process.env.CODEX_PLUGIN_ROOT;
      else process.env.CODEX_PLUGIN_ROOT = prevCodexRoot;
    }

    const result = runHook(cwd, 'session-start', {
      session_id: 'child-backend-session',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-session' } } },
    });
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /senior-backend/);
    assert.match(context, /\[subagent\] Full rules already loaded by parent session/);
  });
});

test('per-agent run state allows claimed role writes and blocks parent writes', () => {
  withTempDir((cwd) => {
    writeJson(path.join(cwd, '.traffic-one/.one.json'), completeDefaultState());
    runHook(cwd, 'check-onboarding-gate', {
      tool_input: { command: 'ls -la' },
    });
    fs.writeFileSync(path.join(cwd, '.traffic-one', 'plan.md'), '# Plan\n', 'utf8');

    const prevCodexRoot = process.env.CODEX_PLUGIN_ROOT;
    process.env.CODEX_PLUGIN_ROOT = ROOT;
    try {
      runHook(cwd, 'check-agent-model', {
        session_id: 'parent-session',
        tool_name: 'spawn_agent',
        tool_input: {
          agent_type: 'worker',
          model: 'gpt-5-codex',
          message: 'You are acting as Traffic One senior-backend for this run.',
        },
      });
    } finally {
      if (prevCodexRoot === undefined) delete process.env.CODEX_PLUGIN_ROOT;
      else process.env.CODEX_PLUGIN_ROOT = prevCodexRoot;
    }

    runHook(cwd, 'session-start', {
      session_id: 'child-backend-session',
      thread_source: 'subagent',
      source: { subagent: { thread_spawn: { parent_thread_id: 'parent-session' } } },
    });

    const apiPath = ['packages', 'api-client', 'src', 'index.ts'].join('/');
    const childWrite = runHook(cwd, 'check-architecture-write', {
      session_id: 'child-backend-session',
      thread_source: 'subagent',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${apiPath}\n+export const ok = true;\n*** End Patch\n`,
      },
    });
    assert.equal(childWrite.stdout, '');

    const parentWrite = runHook(cwd, 'check-architecture-write', {
      session_id: 'parent-session',
      tool_name: 'apply_patch',
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${apiPath}\n+export const nope = true;\n*** End Patch\n`,
      },
    });
    assert.match(parentWrite.stdout, /permissionDecision/);
    assert.match(parentWrite.stdout, /Run-team enforcement gate/);
  });
});

test('sweepOldDigests keeps only the N most recent directories', () => {
  withTempDir((cwd) => {
    const digestsRoot = path.join(cwd, '.traffic-one', 'digests');
    fs.mkdirSync(digestsRoot, { recursive: true });
    const stamps = [
      '2026-01-01T00-00-00Z', '2026-02-01T00-00-00Z', '2026-03-01T00-00-00Z',
      '2026-04-01T00-00-00Z', '2026-05-01T00-00-00Z', '2026-06-01T00-00-00Z',
      '2026-07-01T00-00-00Z',
    ];
    for (const s of stamps) {
      fs.mkdirSync(path.join(digestsRoot, s));
      fs.writeFileSync(path.join(digestsRoot, s, 'architect.md'), '# digest');
    }
    // Trigger SessionStart so sweep runs
    writeJson(path.join(cwd, '.traffic-one/.one.json'), { stack: 'minimal' });
    runHook(cwd, 'session-start', '');
    const remaining = fs.readdirSync(digestsRoot).sort();
    assert.equal(remaining.length, 5, `expected 5 remaining, got ${remaining.length}`);
    // Should keep the 5 most recent (newest sorted alphabetically by ISO)
    assert.deepEqual(remaining, [
      '2026-03-01T00-00-00Z', '2026-04-01T00-00-00Z', '2026-05-01T00-00-00Z',
      '2026-06-01T00-00-00Z', '2026-07-01T00-00-00Z',
    ]);
  });
});

test('graph-preview is included in subagent SessionStart when present', () => {
  withTempDir((cwd) => {
    fs.mkdirSync(path.join(cwd, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, '.traffic-one', 'graph-preview.md'),
      '## Codebase graph preview\n\nProvider: test · 3 modules:\n- apps/web\n- packages/ui\n- packages/api\n',
    );
    writeJson(path.join(cwd, '.traffic-one/.one.json'), {
      version: '2.9.69',
      stack: 'default', frontend: 'react-vite', backend: 'supabase',
      mobile: { enabled: false, framework: 'none', source: 'none' },
      confirmed: true, onboardingComplete: true,
      confirmedAt: '2026-05-17T10:00:00Z',
      codeGraphProvider: 'graphify',
      toolchain: { gitnexus: { installedVersion: null, installedAt: null },
                   graphify: { installedVersion: null, installedAt: null },
                   gitleaks: { installedVersion: null, installedAt: null },
                   trufflehog: { installedVersion: null, installedAt: null } },
      materializedStack: 'default|react-vite|supabase|none',
      materializedAt: new Date().toISOString(),
      materializedVersion: '2.9.69',
      currentRunId: '2026-05-17T11-00-00Z',
      activeAgentRole: 'senior-architect',
    });
    const result = runHook(cwd, 'session-start', '');
    const payload = parseStdoutJson(result);
    const context = payload.hookSpecificOutput.additionalContext;
    assert.match(context, /Codebase graph preview/);
    assert.match(context, /apps\/web/);
  });
});

test('generateGraphPreview returns null when graph artefact is missing', () => {
  withTempDir((cwd) => {
    const { generateGraphPreview } = require(path.join(ROOT, 'scripts', 'hook-runtime', 'materialize', 'materialize.cjs'));
    assert.equal(generateGraphPreview(cwd, 'graphify'), null);
    assert.equal(generateGraphPreview(cwd, 'gitnexus'), null);
  });
});

// ── Token usage report (2.9.69) ──────────────────────────────────────────────

};
