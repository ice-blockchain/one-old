import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { distRoot, runGen, sourceRepoRoot } from '../index';
import { GenRun } from '../lib/run';
import { emitManifests, emitMcp } from '../emit/manifests';
import { emitStaticPluginFiles } from '../emit/static';
import {
  CURSOR_EVENTS,
  CURSOR_PLUGIN_ROOT_TOKEN,
  PLUGIN_ROOT_ENV_KEYS,
  claudeCommand,
  cursorCommand,
  windsurfCommand,
} from '../sources/hooks';
import { HOST_MODELS } from '../../config/model-tiers';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const MAX_CURSOR_TIER_LENGTH = Math.max(
  ...Object.values(HOST_MODELS.cursor.tiers).map((row) => row.length),
  ...Object.values(HOST_MODELS.cursor.plans ?? {})
    .flatMap((plan) => Object.values(plan).map((row) => row?.length ?? 0)),
);

function assertPortableNodeHookCommand(command: string, label: string): void {
  assert.match(command, /^node -e "/, `${label} must launch through Node`);
  assert.doesNotMatch(command, /\$\{[A-Z][A-Z0-9_]*:-/, `${label} must not use POSIX parameter expansion`);
  assert.doesNotMatch(command, /(?:^|\s)[A-Z][A-Z0-9_]*=/, `${label} must not use inline shell env assignments`);
  assert.doesNotMatch(command, /\bsh\s+-[lc]+\b/, `${label} must not require sh`);
}

test('runGen writes a generated plugin root and --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-plugin-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.ok(write.written.length > 250, `expected generated plugin files, got ${write.written.length}`);
    assert.ok(fs.existsSync(path.join(dir, '.codex-plugin', 'plugin.json')));
    // The auth gate ships as the generated kernel rule; no static 00- seed copy.
    assert.ok(!fs.existsSync(path.join(dir, '.cursor', 'rules', '00-auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, '.cursor', 'rules', 'auth-required.mdc')));
    assert.ok(fs.existsSync(path.join(dir, '.devin', 'rules', 'auth-required.md')));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(dir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks-copilot.json')));
    assert.ok(fs.existsSync(path.join(dir, 'hooks', 'hooks-windsurf.json')));
    assert.ok(fs.existsSync(path.join(dir, 'package.json')));
    assert.ok(!fs.existsSync(path.join(dir, 'src')));
    const copilotHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-copilot.json'), 'utf8'));
    assert.equal(copilotHooks.hooks.SessionStart[0].env.TRAFFIC_ONE_HOST, 'copilot');
    const windsurfHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-windsurf.json'), 'utf8'));
    assert.ok(windsurfHooks.hooks.pre_user_prompt[0].command.includes('windsurf-hook-runtime.cjs'));
    assert.ok(windsurfHooks.hooks.pre_user_prompt[0].command.includes("e.TRAFFIC_ONE_HOST='windsurf'"));
    assert.ok(windsurfHooks.hooks.post_mcp_tool_use[0].command.includes('post_mcp_tool_use'));
    for (const [event, entries] of Object.entries(windsurfHooks.hooks) as Array<[string, Array<{ command: string }>]>) {
      for (const entry of entries) assertPortableNodeHookCommand(entry.command, `Windsurf ${event}`);
    }
    const claudeHooks = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    const sharedClaudeHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8'));
    for (const [configLabel, config] of [['settings', claudeHooks], ['hooks.json', sharedClaudeHooks]] as const) {
      for (const [event, groups] of Object.entries(config.hooks) as Array<[string, Array<{ hooks: Array<{ command: string }> }>]>) {
        for (const group of groups) {
          for (const entry of group.hooks) assertPortableNodeHookCommand(entry.command, `Claude/Codex ${configLabel} ${event}`);
        }
      }
    }
    const managedClaudeGate = claudeHooks.hooks.PreToolUse.find((group: { matcher?: string }) => group.matcher?.includes('traffic-one-mcp'));
    assert.equal(managedClaudeGate.matcher, '^mcp__traffic-one-mcp__(get_config|report_codebase_metadata)$');
    assert.ok(managedClaudeGate.hooks[0].command.endsWith('check-one-mcp-tool'));
    const cursorHooks = JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks-cursor.json'), 'utf8'));
    assert.equal(CURSOR_PLUGIN_ROOT_TOKEN, '${CURSOR_PLUGIN_ROOT}');
    assert.equal(CURSOR_EVENTS.length, 12);
    assert.deepEqual(Object.keys(cursorHooks.hooks), CURSOR_EVENTS.map(({ event }) => event));
    for (const { event, subcommand } of CURSOR_EVENTS) {
      const entries = cursorHooks.hooks[event];
      assert.equal(entries.length, 1, `${event} must emit exactly one Cursor hook`);
      const entry = entries[0];
      assert.equal(
        entry.command,
        `node "${CURSOR_PLUGIN_ROOT_TOKEN}/scripts/cursor-hook-runtime.cjs" ${subcommand}`,
      );
      assert.doesNotMatch(entry.command, /\.\/scripts|:-|TRAFFIC_ONE_PLUGIN_ROOT/);
      const lifecycle = event === 'stop' || event === 'subagentStop';
      assert.deepEqual(
        Object.keys(entry).sort(),
        lifecycle ? ['command', 'loop_limit'] : ['command'],
        `${event} emitted unsupported Cursor hook fields`,
      );
      if (lifecycle) {
        assert.equal(entry.loop_limit, 8);
        assert.ok(
          entry.loop_limit > MAX_CURSOR_TIER_LENGTH,
          `${event} loop_limit must exceed the longest configured Cursor tier (${MAX_CURSOR_TIER_LENGTH})`,
        );
      }
    }
    assert.deepEqual(cursorHooks.hooks.stop, [{
      command: 'node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" cursor-stop',
      loop_limit: 8,
    }]);
    assert.deepEqual(cursorHooks.hooks.subagentStop, [{
      command: 'node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" cursor-subagent-stop',
      loop_limit: 8,
    }]);
    assert.deepEqual(cursorHooks.hooks.beforeMCPExecution, [{
      command: 'node "${CURSOR_PLUGIN_ROOT}/scripts/cursor-hook-runtime.cjs" before-mcp-execution',
    }]);
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const expectedVersion = sourcePackage.version;
    const generatedPackage = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const claudePlugin = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), 'utf8'));
    const claudeMarketplace = JSON.parse(fs.readFileSync(path.join(dir, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const codexPlugin = JSON.parse(fs.readFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), 'utf8'));
    const cursorPlugin = JSON.parse(fs.readFileSync(path.join(dir, '.cursor-plugin', 'plugin.json'), 'utf8'));
    const copilotPlugin = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
    assert.equal(generatedPackage.version, expectedVersion, 'generated package version must follow package.json');
    assert.equal(generatedPackage.engines?.node, sourcePackage.engines?.node, 'generated package Node engine must follow package.json');
    assert.equal(claudePlugin.version, expectedVersion, 'Claude plugin version must follow package.json');
    assert.equal(claudeMarketplace.plugins[0]?.version, expectedVersion, 'Claude marketplace version must follow package.json');
    assert.equal(codexPlugin.version, expectedVersion, 'Codex plugin version must follow package.json');
    assert.equal(cursorPlugin.version, expectedVersion, 'Cursor plugin version must follow package.json');
    assert.equal(copilotPlugin.version, expectedVersion, 'Copilot plugin version must follow package.json');
    assert.equal(copilotPlugin.mcpServers, './.mcp-copilot.json');
    const sharedMcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
    const copilotMcp = JSON.parse(fs.readFileSync(path.join(dir, '.mcp-copilot.json'), 'utf8'));
    for (const [label, config] of [['shared', sharedMcp], ['Copilot', copilotMcp]] as const) {
      const worker = config.mcpServers['opencode-worker'] as { command: string; args: string[] };
      assert.equal(worker.command, 'node', `${label} MCP worker must not require sh`);
      assert.equal(worker.args[0], '-e');
      assert.doesNotMatch(worker.args.join(' '), /\$\{[A-Z][A-Z0-9_]*[:+\-]/, `${label} MCP worker must not use shell expansion`);
      assert.doesNotMatch(worker.args.join(' '), /\[\s+-f\s+|\bexec\s+node\b/, `${label} MCP worker must use the Node bootstrap`);
    }
    assert.equal(sharedMcp.mcpServers['traffic-one-mcp'], undefined, 'Claude/Cursor/Codex must not expose the public server');
    assert.equal(copilotMcp.mcpServers['traffic-one-mcp'], undefined, 'milestone A keeps public registration build-disabled');
    const frontendAgent = fs.readFileSync(path.join(dir, 'agents', 'senior-frontend.agent.md'), 'utf8');
    assert.match(frontendAgent, /^tools: \["view", "search", "bash", "edit"\]$/m);
    assert.doesNotMatch(frontendAgent, /^tools: Read,/m);

    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift, [], `generated plugin drifted: ${check.drift.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated non-test documentation contains no concrete claimable Traffic One role marker', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-role-markers-'));
  const concreteMarker = /\[t1-role:\s*(?:(?:senior[-_](?:architect|frontend|backend|reviewer|tester|shipper)|quick[-_]fix)(?:[-_]\d+)?)\s*\]/i;
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = write.written.filter((relPath) => /\.(?:md|mdc)$/i.test(relPath));
    assert.ok(docs.length > 0, 'expected generated documentation to scan');
    for (const relPath of docs) {
      const content = fs.readFileSync(path.join(dir, relPath), 'utf8');
      assert.doesNotMatch(content, concreteMarker, `${relPath} contains a claimable concrete role marker`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated agent-facing documentation contains no Traffic One authoring paths or POSIX root expansion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-agent-doc-portability-'));
  // Project examples such as apps/web/src/features/** and src/services/** are
  // intentionally legal. These patterns name Traffic One's authoring topology
  // and therefore cannot resolve inside an installed plugin.
  const authoringPath = /(?:\bsrc\/(?:modules\/|gen\/|build\/|hooks\/(?:claude|copilot|cursor|devin|kilo|opencode|windsurf)-entry\.ts\b|config\/model-tiers\.ts\b|shared\/(?:performance-config|stack-layout)\.ts\b|(?:shared|runners)\/onboarding-server(?:\/|\b))|\bdist\/scripts\/)/;
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = write.written.filter((relPath) => (
      /\.(?:md|mdc)$/i.test(relPath)
      && (relPath === 'AGENTS.md'
        || relPath === 'CLAUDE.md'
        || relPath.startsWith('agents/')
        || relPath.startsWith('rules/')
        || relPath.startsWith('skills-catalog/')
        || relPath.startsWith('.cursor/rules/')
        || relPath.startsWith('.devin/rules/')
        || /^scripts\/modules\/[^/]+\/skill\/SKILL\.md$/.test(relPath))
    ));
    assert.ok(docs.length > 0, 'expected generated agent-facing documentation to scan');
    for (const relPath of docs) {
      const content = fs.readFileSync(path.join(dir, relPath), 'utf8');
      assert.doesNotMatch(content, authoringPath, `${relPath} leaks a Traffic One authoring-only src path`);
      assert.doesNotMatch(
        content,
        /\$\{[A-Z][A-Z0-9_]*:-/,
        `${relPath} embeds POSIX-only plugin-root parameter expansion`,
      );
    }

    const gateSkills = fs.readdirSync(path.join(REPO_ROOT, 'src', 'modules'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(REPO_ROOT, 'src', 'modules', entry.name, 'skill', 'SKILL.md'))
      .filter((filePath) => fs.existsSync(filePath));
    for (const filePath of gateSkills) {
      const content = fs.readFileSync(filePath, 'utf8');
      const label = path.relative(REPO_ROOT, filePath);
      assert.doesNotMatch(content, authoringPath, `${label} leaks a Traffic One authoring-only src path`);
      assert.doesNotMatch(
        content,
        /\$\{[A-Z][A-Z0-9_]*:-/,
        `${label} embeds POSIX-only plugin-root parameter expansion`,
      );
    }

    const planGuard = fs.readFileSync(
      path.join(REPO_ROOT, 'src', 'modules', 'plan-guard', 'skill', 'SKILL.md'),
      'utf8',
    );
    const launcher = planGuard.match(/node -e "([^"\n]+)" materialize-project/)?.[1];
    assert.ok(launcher, 'plan guard must include the portable materialize-project launcher');
    const pluginRoot = path.join(dir, 'installed plugin with spaces');
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'scripts', 'hook-runtime.cjs'),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      'utf8',
    );
    for (const [label, rootValue, cwd] of [
      ['absolute root', pluginRoot, dir],
      ['relative root', path.relative(dir, pluginRoot), dir],
    ] as const) {
      const launched: { status: number | null; stdout: string; stderr: string } = spawnSync(
        process.execPath,
        ['-e', launcher!, 'materialize-project'],
        {
          cwd,
          encoding: 'utf8',
          env: { ...process.env, TRAFFIC_ONE_PLUGIN_ROOT: rootValue },
        },
      );
      assert.equal(launched.status, 0, `${label}: ${launched.stderr}`);
      assert.deepEqual(JSON.parse(launched.stdout), ['materialize-project'], label);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated orchestrator contract preserves every canonical Codex task name and incident motivation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-codex-role-contract-'));
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const relPath = write.written.find((candidate) => (
      candidate.endsWith('senior-eng-orchestrator/SKILL.md')
    ));
    assert.ok(relPath, 'expected the orchestrator skill in generated output');
    const content = fs.readFileSync(path.join(dir, relPath!), 'utf8');
    for (const taskName of [
      'senior_architect',
      'senior_frontend',
      'senior_backend',
      'senior_reviewer',
      'senior_tester',
      'senior_shipper',
    ]) assert.match(content, new RegExp(`\\b${taskName}\\b`));
    assert.match(content, /spawn `message` is encrypted at rest/i);
    assert.match(content, /usable transcript identity evidence/i);
    assert.match(content, /actual model is observed by the live child hooks/i);
    assert.match(content, /incident already used `task_name: "senior_architect"`/i);
    assert.match(content, /codifies existing orchestrator behavior/i);
    assert.match(content, /Codex `spawn_agent`[^\n]*`model`[^\n]*`fork_turns: "none"`/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated tester and orchestrator contracts fail closed on incomplete or blocked QA', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-strict-qa-contract-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const tester = fs.readFileSync(path.join(dir, 'agents', 'senior-tester.md'), 'utf8');
    const shipper = fs.readFileSync(path.join(dir, 'agents', 'senior-shipper.md'), 'utf8');
    const orchestrator = fs.readFileSync(
      path.join(dir, 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md'),
      'utf8',
    );
    const testerPrompt = fs.readFileSync(
      path.join(dir, 'skills-catalog', 'senior-eng-orchestrator', 'resources', 'prompt-templates.md'),
      'utf8',
    );
    const digestContract = fs.readFileSync(
      path.join(dir, 'rules', 'common', 'agent-handoff-digests.md'),
      'utf8',
    );

    for (const [name, content] of [
      ['senior tester', tester],
      ['tester spawn template', testerPrompt],
    ] as const) {
      assert.match(content, /\.traffic-one\/reports\/qa\/<run-?id>\/report\.json/i, `${name} names the canonical report`);
      assert.match(content, /schemaVersion(?::|`)\s*1/i, `${name} requires QaReportV1`);
      assert.match(content, /390[^\n]*768[^\n]*1440|390[\s\S]{0,300}768[\s\S]{0,300}1440/, `${name} requires the full viewport matrix`);
      assert.match(content, /blocked:browser-unavailable/, `${name} distinguishes browser unavailability`);
      assert.match(content, /blocked:sandbox/, `${name} preserves sandbox blockers`);
      assert.match(content, /blocked:usage-limit/, `${name} preserves usage blockers`);
      assert.match(content, /blocked:timeout/, `${name} preserves timeout blockers`);
      assert.match(content, /Every blocked (?:outcome|status)[\s\S]{0,60}`TESTS_FAILING`/i, `${name} cannot return green when blocked`);
      assert.match(content, /no\s+frontend implementer digest/i, `${name} limits the backend-only exemption`);
    }
    assert.match(tester, /record that evidence in `tester\.md`/i,
      'fresh-build proof is recorded in the digest');
    // Freshness on disk proves only that a build exists — not that the base URL
    // served it. The one field that answers "which app answered?" is mandatory,
    // and so is owning the port (a leftover preview on 4173 passed 21/21 checks
    // against another project's app in a measured run).
    assert.match(tester, /`verifiedBuild`[\s\S]{0,400}observed OVER HTTP/i,
      'the tester must record the build identity it observed over HTTP');
    assert.match(tester, /--strictPort|free port/i,
      'the tester must own the port it sweeps rather than assume a well-known one');
    assert.match(digestContract, /verdict:[^\n]*SHIPPED[^\n]*FAILED/i,
      'canonical digest contract permits a failed shipper verdict');
    assert.match(digestContract, /exact `currentRunId`[\s\S]{0,180}never synthesize or\s+reformat/i,
      'canonical digest contract preserves the exact machine run id');

    for (const [name, content] of [
      ['senior shipper', shipper],
      ['shipper spawn template', testerPrompt],
    ] as const) {
      assert.match(content, /\.traffic-one\/reports\/qa\/<run-?id>\/report\.json/i, `${name} names the canonical QA report`);
      assert.match(content, /QaReportV1/i, `${name} requires the strict QA contract`);
      assert.match(content, /no frontend implementer digest/i, `${name} limits the backend-only exemption`);
      assert.match(content, /do not (?:stamp|deploy)|STOP/i, `${name} blocks shipping without QA`);
    }

    assert.match(orchestrator, /Codex parent-browser bridge/);
    assert.match(orchestrator, /same[^\n]*`senior-tester` agent/i);
    assert.match(orchestrator, /consumes no\s+reviewer\/tester fix cycle/i);
    assert.match(orchestrator, /Unresolved-run directive/);
    assert.match(orchestrator, /preserve currentRunId/i);
    assert.match(orchestrator, /verification blocked/);
    for (const heading of [
      'Implementation status',
      'Passing mechanical checks',
      'Unresolved reviewer/tester findings',
      'QA status',
      'User decision required',
    ]) assert.match(orchestrator, new RegExp(`${heading}:`, 'i'));
    assert.match(orchestrator, /blocked\/nonterminal run[\s\S]{0,200}never enters Phase 5/i);

    // 19c-F2: the run-status helper is reached through the version-stable shim,
    // never an env-var chain — an agent's exec sandbox on Codex has no
    // *_PLUGIN_ROOT set, so the old `node -e` launcher resolved to the PROJECT
    // dir and died with MODULE_NOT_FOUND.
    const installedRunStatus = 'node ~/.traffic-one/bin/run-status.cjs';
    const transitions = [
      '--status blocked --outcome review-cycle-cap',
      '--status blocked --outcome test-cycle-cap',
      '--status blocked --outcome environment-blocked',
      '--status failed --outcome agent-failed',
      '--status active --reason user-authorized-extra-cycle',
      '--status completed --outcome verified',
      '--status completed --outcome shipped',
    ];
    for (const [name, content] of [
      ['orchestrator', orchestrator],
      ['prompt templates', testerPrompt],
    ] as const) {
      assert.ok(content.includes(installedRunStatus), `${name} reaches run-status through the version-stable shim`);
      assert.ok(!/run-status\.cjs'\)\)"/.test(content),
        `${name} must not resolve run-status through a *_PLUGIN_ROOT env chain`);
      assert.ok(content.includes('--run-id "<run-id>"'), `${name} uses a shell-neutral run-id placeholder`);
      for (const transition of transitions) {
        assert.ok(content.includes(transition), `${name} documents ${transition}`);
      }
      assert.match(content, /completed (?:transitions|commands) are evidence-gated/i,
        `${name} keeps completed transitions behind evidence`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 19c-F3: the architect was told a `"test": "echo \"no tests\" && exit 0"` no-op
// was REQUIRED ("absence is not allowed") while the tester was told to flag it —
// a green run was blocked only by scaffolding the plugin itself demanded, and
// the frontend unblocked it with ceremony tests. Every doc must now agree that a
// config-only package omits `test` entirely.
// 19c-F1: root aborted a tester that was mid-digest 11s after a successful tool
// call, destroying a verdict, because nothing defined what "stalled" means.
test('generated role contracts agree on no-op test scripts and forbid interrupting a working agent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-role-contract-coherence-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = {
      architect: fs.readFileSync(path.join(dir, 'agents', 'senior-architect.md'), 'utf8'),
      tester: fs.readFileSync(path.join(dir, 'agents', 'senior-tester.md'), 'utf8'),
      qualityTooling: fs.readFileSync(path.join(dir, 'rules', 'common', 'quality-tooling.md'), 'utf8'),
      newProject: fs.readFileSync(path.join(dir, 'rules', 'modes', 'new-project-setup.md'), 'utf8'),
      // Mandatory architect skill for stack=default / frontend=react-vite, and
      // the authority for the scaffold's exact package.json content — the first
      // pass of this fix left the old rule live here, so it must be scanned too.
      monorepo: fs.readFileSync(
        path.join(dir, 'skills-catalog', 'monorepo-architecture', 'SKILL.md'),
        'utf8',
      ),
    };

    // No doc may PRESCRIBE the no-op; every mention must be a prohibition.
    for (const [name, content] of Object.entries(docs)) {
      for (const line of content.split('\n')) {
        if (!/no tests/i.test(line)) continue;
        assert.ok(
          /\bnever\b|\bno hollow\b|\bno-op\b|false signal|inflates|meaningless/i.test(line),
          `${name} mentions a no-tests script outside a prohibition: ${line.trim()}`,
        );
      }
      assert.ok(!/no-op is\s+allowed|allowed, absence is not/i.test(content),
        `${name} still permits a no-op test script`);
    }
    // The architect must say config-only packages omit the script.
    assert.match(docs.architect, /omits? `?test`? entirely/i);
    assert.match(docs.qualityTooling, /omits? `?test`? entirely/i);
    assert.match(docs.monorepo, /omits? `?test`? entirely/i);
    // The tester must not demand a ceremony test for a package with no source.
    assert.match(docs.tester, /not a finding/i);
    // The tester must never be told it may edit package.json: the run-team
    // ownership gate denies that write, so any such instruction is unfollowable.
    assert.doesNotMatch(docs.tester, /both are inside your scope/i);
    assert.match(docs.tester, /never edit `?package\.json`? yourself/i);

    const orchestrator = fs.readFileSync(
      path.join(dir, 'skills-catalog', 'senior-eng-orchestrator', 'SKILL.md'),
      'utf8',
    );
    assert.match(orchestrator, /never interrupt a role turn that is still working/i);
    assert.match(orchestrator, /positive evidence of inactivity/i);
    assert.match(orchestrator, /silence toward you is not evidence/i);
    // An aborted verifier's stale evidence must not be reusable.
    assert.match(orchestrator, /stop counting as current evidence/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generated instructions contain no obsolete Codex no-model or fork_context guidance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-codex-model-contract-'));
  const staleCodexNoModelClaims = [
    /\bCodex\b[^\n]{0,180}\bpass no `?model`?/i,
    /\bCodex\b[^\n]{0,180}\bwith no `?model`?/i,
    /\bCodex\b[^\n]{0,180}\bno `?model`? field/i,
    /\bCodex\b[^\n]{0,180}\bomit(?: the)? `?model`?/i,
    /\bCodex\b[^\n]{0,180}\b(?:does not|doesn't|cannot|can't)\b[^\n]{0,80}\b(?:support|accept|expose|receive)\b[^\n]{0,40}\bmodel\b/i,
    /\bCodex\b[^\n]{0,180}\bexposes no\b[^\n]{0,30}\bmodel\b/i,
  ];
  try {
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const docs = write.written.filter((relPath) => /\.(?:md|mdc)$/i.test(relPath));
    assert.ok(docs.length > 0, 'expected generated instructions to scan');
    for (const relPath of docs) {
      const content = fs.readFileSync(path.join(dir, relPath), 'utf8');
      assert.doesNotMatch(content, /\bfork_context\b/, `${relPath} uses the obsolete fork_context key`);
      for (const staleClaim of staleCodexNoModelClaims) {
        assert.doesNotMatch(content, staleClaim, `${relPath} says Codex cannot receive an explicit model`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Cursor hook commands resolve the installed runtime from a foreign cwd and fail closed without token replacement', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-cursor-hook-command-')));
  const pluginRoot = path.join(dir, 'installed plugin with spaces');
  const foreignCwd = path.join(dir, 'foreign workspace');
  const pluginRuntime = path.join(pluginRoot, 'scripts', 'cursor-hook-runtime.cjs');
  const decoyRuntime = path.join(foreignCwd, 'scripts', 'cursor-hook-runtime.cjs');
  const decoyMarker = path.join(dir, 'project-decoy-ran');
  try {
    fs.mkdirSync(path.dirname(pluginRuntime), { recursive: true });
    fs.mkdirSync(path.dirname(decoyRuntime), { recursive: true });
    fs.writeFileSync(pluginRuntime, [
      "'use strict';",
      "process.stdout.write(JSON.stringify({ runtime: 'plugin', subcommand: process.argv[2], cwd: process.cwd() }));",
    ].join('\n'), 'utf8');
    fs.writeFileSync(decoyRuntime, [
      "'use strict';",
      `require('node:fs').writeFileSync(${JSON.stringify(decoyMarker)}, 'ran', 'utf8');`,
      'process.exitCode = 91;',
    ].join('\n'), 'utf8');

    for (const { subcommand } of CURSOR_EVENTS) {
      const expanded = cursorCommand(subcommand).replaceAll(CURSOR_PLUGIN_ROOT_TOKEN, pluginRoot);
      const result = spawnSync(expanded, {
        cwd: foreignCwd,
        encoding: 'utf8',
        input: '{}',
        shell: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        runtime: 'plugin',
        subcommand,
        cwd: foreignCwd,
      });
    }
    assert.equal(fs.existsSync(decoyMarker), false, 'foreign workspace runtime must never execute');

    const env = { ...process.env };
    delete env.CURSOR_PLUGIN_ROOT;
    const unresolved = spawnSync(cursorCommand('cursor-stop'), {
      cwd: foreignCwd,
      encoding: 'utf8',
      env,
      input: '{}',
      shell: true,
    });
    assert.notEqual(unresolved.status, 0, 'an unreplaced plugin-root token must fail closed');
    assert.equal(fs.existsSync(decoyMarker), false, 'missing token replacement must not fall back to the project runtime');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude, Codex, and Windsurf hook commands resolve plugin roots through the portable Node launcher', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-portable-hook-command-')));
  const pluginRoot = path.join(dir, 'installed plugin with spaces');
  const foreignCwd = path.join(dir, 'foreign workspace');
  const decoyMarker = path.join(dir, 'project-decoy-ran');
  const runtimeSource = [
    "'use strict';",
    "let stdin='';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data',(chunk)=>{stdin+=chunk;});",
    "process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({runtime:require('path').basename(__filename),args:process.argv.slice(2),root:process.env.TRAFFIC_ONE_PLUGIN_ROOT||'',host:process.env.TRAFFIC_ONE_HOST||'',cwd:process.cwd(),stdin}));});",
  ].join('\n');
  try {
    fs.mkdirSync(path.join(pluginRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(foreignCwd, 'scripts'), { recursive: true });
    for (const runtime of ['hook-runtime.cjs', 'windsurf-hook-runtime.cjs']) {
      fs.writeFileSync(path.join(pluginRoot, 'scripts', runtime), runtimeSource, 'utf8');
      fs.writeFileSync(path.join(foreignCwd, 'scripts', runtime), [
        "'use strict';",
        `require('fs').writeFileSync(${JSON.stringify(decoyMarker)}, 'ran', 'utf8');`,
        'process.exitCode=91;',
      ].join('\n'), 'utf8');
    }

    const run = (command: string, rootKey: typeof PLUGIN_ROOT_ENV_KEYS[number]): Record<string, unknown> => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of PLUGIN_ROOT_ENV_KEYS) delete env[key];
      delete env.TRAFFIC_ONE_HOST;
      env[rootKey] = pluginRoot;
      const result = spawnSync(command, {
        cwd: foreignCwd,
        encoding: 'utf8',
        env,
        input: '{"portable":true}',
        shell: true,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };

    for (const rootKey of ['CLAUDE_PLUGIN_ROOT', 'CODEX_PLUGIN_ROOT'] as const) {
      assert.deepEqual(run(claudeCommand('check-plan-write'), rootKey), {
        runtime: 'hook-runtime.cjs',
        args: ['check-plan-write'],
        root: pluginRoot,
        host: '',
        cwd: foreignCwd,
        stdin: '{"portable":true}',
      });
    }
    assert.deepEqual(run(windsurfCommand('pre_run_command'), 'TRAFFIC_ONE_PLUGIN_ROOT'), {
      runtime: 'windsurf-hook-runtime.cjs',
      args: ['pre_run_command', '--host=windsurf'],
      root: pluginRoot,
      host: 'windsurf',
      cwd: foreignCwd,
      stdin: '{"portable":true}',
    });
    assert.equal(fs.existsSync(decoyMarker), false, 'foreign workspace runtime must never execute');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gen sweeps orphaned files in managed output dirs (deleted source content)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-orphan-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const orphanRule = path.join(dir, 'rules', 'common', 'retired-rule.md');
    const orphanMdc = path.join(dir, '.cursor', 'rules', 'retired-rule.mdc');
    const orphanWindsurf = path.join(dir, '.devin', 'rules', 'retired-rule.md');
    const retiredModelCatalog = path.join(dir, 'public', 'model-status-catalog.json');
    fs.writeFileSync(orphanRule, '# Retired\n', 'utf8');
    fs.writeFileSync(orphanMdc, '---\nalwaysApply: false\n---\n', 'utf8');
    fs.writeFileSync(orphanWindsurf, '---\ntrigger: model_decision\n---\n# Retired\n', 'utf8');
    fs.mkdirSync(path.dirname(retiredModelCatalog), { recursive: true });
    fs.writeFileSync(retiredModelCatalog, '{}\n', 'utf8');

    // check mode reports orphans as drift without touching them.
    const check = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(check.drift.sort(), [
      '.cursor/rules/retired-rule.mdc (orphan: no longer generated)',
      '.devin/rules/retired-rule.md (orphan: no longer generated)',
      'public/model-status-catalog.json (orphan: no longer generated)',
      'rules/common/retired-rule.md (orphan: no longer generated)',
    ]);
    assert.ok(fs.existsSync(orphanRule));

    // write mode prunes them.
    const write = runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(write.pruned.sort(), [
      '.cursor/rules/retired-rule.mdc',
      '.devin/rules/retired-rule.md',
      'public/model-status-catalog.json',
      'rules/common/retired-rule.md',
    ]);
    assert.ok(!fs.existsSync(orphanRule));
    assert.ok(!fs.existsSync(orphanMdc));
    assert.ok(!fs.existsSync(orphanWindsurf));
    assert.ok(!fs.existsSync(retiredModelCatalog));

    // and the tree round-trips clean again.
    const recheck = runGen({ check: true, root: dir, sourceRoot: REPO_ROOT });
    assert.deepEqual(recheck.drift, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitManifests produces all host manifests including Copilot plugin.json', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-manifests-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(write);
    emitMcp(write);
    assert.equal(write.written.length, 8);
    assert.ok(write.written.includes('.mcp.json'));
    assert.ok(write.written.includes('.mcp-copilot.json'));

    const check = new GenRun({ check: true, root: dir, sourceRoot: REPO_ROOT });
    emitManifests(check);
    emitMcp(check);
    assert.deepEqual(check.drift, []);
    assert.equal(check.written.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitMcp omits the Copilot public server when the build-time registration switch is off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-mcp-disabled-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: REPO_ROOT });
    emitMcp(write, false);
    const copilot = JSON.parse(fs.readFileSync(path.join(dir, '.mcp-copilot.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    assert.equal(copilot.mcpServers['traffic-one-mcp'], undefined);
    assert.ok(copilot.mcpServers['opencode-worker']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('emitMcp refuses direct Supabase activation and accepts the reviewed custom release endpoint', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-mcp-enabled-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: REPO_ROOT });
    assert.throws(() => emitMcp(write, true), /public release blocked for registration/);
    assert.throws(
      () => emitMcp(write, true, 'https://mcp.traffic-one.example/public-mcp'),
      /seven live rows/,
    );
    emitMcp(write, true, 'https://mcp.traffic-one.example/public-mcp', true);
    const copilot = JSON.parse(fs.readFileSync(path.join(dir, '.mcp-copilot.json'), 'utf8')) as {
      mcpServers: Record<string, { type?: string; tools?: unknown[] }>;
    };
    assert.deepEqual(copilot.mcpServers['traffic-one-mcp'], {
      type: 'http',
      url: 'https://mcp.traffic-one.example/public-mcp',
      tools: [],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('distRoot points generation at dist under the source checkout by default', () => {
  assert.equal(distRoot(REPO_ROOT), path.join(REPO_ROOT, 'dist'));
});

test('codegen ignores runtime plugin-root env vars and still reads the source checkout', () => {
  const saved = {
    traffic: process.env.TRAFFIC_ONE_PLUGIN_ROOT,
    codex: process.env.CODEX_PLUGIN_ROOT,
    claude: process.env.CLAUDE_PLUGIN_ROOT,
    cursor: process.env.CURSOR_PLUGIN_ROOT,
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-env-'));
  try {
    process.env.TRAFFIC_ONE_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CODEX_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CLAUDE_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');
    process.env.CURSOR_PLUGIN_ROOT = path.join(REPO_ROOT, 'dist');

    assert.equal(sourceRepoRoot(), REPO_ROOT);
    assert.equal(distRoot(), path.join(REPO_ROOT, 'dist'));
    const write = runGen({ check: false, root: dir });
    assert.ok(write.written.includes('AGENTS.md'));
    assert.ok(fs.existsSync(path.join(dir, 'AGENTS.md')));
  } finally {
    if (saved.traffic === undefined) delete process.env.TRAFFIC_ONE_PLUGIN_ROOT; else process.env.TRAFFIC_ONE_PLUGIN_ROOT = saved.traffic;
    if (saved.codex === undefined) delete process.env.CODEX_PLUGIN_ROOT; else process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.claude === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = saved.claude;
    if (saved.cursor === undefined) delete process.env.CURSOR_PLUGIN_ROOT; else process.env.CURSOR_PLUGIN_ROOT = saved.cursor;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('GenRun.json writes canonical 2-space JSON with a trailing newline; --check round-trips', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-'));
  try {
    const sample = { b: 1, a: [1, 2] };
    const write = new GenRun({ check: false, root: dir });
    write.json('nested/x.json', sample);
    assert.deepEqual(write.written, ['nested/x.json']);
    const onDisk = fs.readFileSync(path.join(dir, 'nested', 'x.json'), 'utf8');
    assert.equal(onDisk, `${JSON.stringify(sample, null, 2)}\n`);
    // Re-checking the just-written file reports no drift (idempotent).
    const check = new GenRun({ check: true, root: dir });
    check.json('nested/x.json', sample);
    assert.deepEqual(check.drift, []);
    // A different value drifts.
    const check2 = new GenRun({ check: true, root: dir });
    check2.json('nested/x.json', { b: 2 });
    assert.deepEqual(check2.drift, ['nested/x.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dist AGENTS.md/CLAUDE.md ship the end-user plugin instructions, not the maintainer guide', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-agents-'));
  try {
    runGen({ check: false, root: dir, sourceRoot: REPO_ROOT });
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gen', 'static', 'plugin-instructions.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), source);
    // The maintainer guide (repo root AGENTS.md) must never ship.
    assert.ok(!fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8').includes('Stand Down'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static emitter recovers when sourceRoot points at dist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't1-gen-distroot-'));
  try {
    const write = new GenRun({ check: false, root: dir, sourceRoot: path.join(REPO_ROOT, 'dist') });
    emitStaticPluginFiles(write);
    assert.ok(write.written.includes('AGENTS.md'));
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'gen', 'static', 'plugin-instructions.md'), 'utf8');
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), source);
    assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), source);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
