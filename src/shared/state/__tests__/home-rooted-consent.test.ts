// The $HOME-rooted session, which is where saying "no" to Traffic One used to
// destroy the user's machine state.
//
// `<$HOME>/.traffic-one` IS the per-user machine directory whenever
// XDG_STATE_HOME is unset — the shipped default — and a session rooted at $HOME
// is an ordinary shape: an editor opened with no folder, a Codex scratch task, a
// user who ran the agent from their home directory. Three separate places
// treated that path as if it were an ordinary project's state dir:
//
//   * removeDeclinedProjectArtifacts deleted it WHOLESALE for a project that is
//     not onboarded, taking the authenticated API key, every other project's
//     recorded consent, the version-stable runner shims host tool approvals are
//     pinned to, and every managed toolchain — and the decline was then not even
//     recorded, because the prefs file had just been written INSIDE the tree that
//     was removed, so the user was asked again and could destroy it again;
//   * the write fence's machine-dir carve-out was a blanket prefix match, so for
//     this one shape every path under the state dir was allowed while the
//     question was still pending — the default-closed guarantee did not hold;
//   * removeStrayProjectArtifactsFromGlobalDir deleted the prefs bucket that
//     holds the $HOME answer, on every SessionStart in EVERY project, so a
//     recorded answer could not survive a session in an unrelated directory.
//
// Every fixture redirects HOME into a temp dir. These tests exercise the code
// path that deletes the machine directory; a leaked HOME here deletes the
// developer's own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { declineOutput } from '../../../runners/onboarding-wait/wizard-output';
import { writeJson, writeTextFile } from '../../fsjson';
import { defaultProjectPrefsPath } from '../local-prefs';
import { oneMcpCachePath } from '../../one-mcp/cache';
import { oneSettingsPath } from '../../one-settings';
import { overrideLedgerPath } from '../../override';
import { overrideKeyPath } from '../../override/paths';
import { stableBinDir } from '../../runner-shims';
import { toolchainRoot } from '../../toolchain-paths';
import { sha256 } from '../../text';
import { projectLocalPrefsPath, removeStrayProjectArtifactsFromGlobalDir } from '../traffic-one-paths';
import {
  projectRootForStatePath,
  projectStateWriteAllowed,
  readPluginUseChoice,
  recordPluginUseChoice,
  resetPluginUseCache,
  withPreConsentProjectWrites,
} from '../plugin-use';

// ── fixture ──────────────────────────────────────────────────────────────────

interface HomeCase {
  /** The session root, which is also $HOME — so `<home>/.traffic-one` is the machine dir. */
  home: string;
  machineDir: string;
  /** A second, unrelated project whose recorded consent must survive everything. */
  otherProject: string;
  base: string;
}

const ENV_KEYS = [
  'HOME', 'XDG_STATE_HOME', 'TRAFFIC_ONE_PROJECT_PREFS_PATH',
  'TRAFFIC_ONE_STATE_PATH', 'TRAFFIC_ONE_ASK_USE_PLUGIN',
] as const;

function withHomeRootedSession(fn: (ctx: HomeCase) => void): void {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't1-home-consent-')));
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const home = path.join(base, 'homeproj');
  const otherProject = path.join(base, 'other-project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(otherProject, { recursive: true });
  process.env.HOME = home;
  // Unset on purpose: with XDG_STATE_HOME set, the machine dir moves out of
  // $HOME and this whole class of collision cannot happen. The default is the
  // dangerous configuration, so the default is what gets tested.
  delete process.env.XDG_STATE_HOME;
  // No pinned prefs path either — the hash-keyed per-project bucket under the
  // temp HOME is the thing the sweep used to delete.
  delete process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH;
  delete process.env.TRAFFIC_ONE_STATE_PATH;
  process.env.TRAFFIC_ONE_ASK_USE_PLUGIN = '1'; // the shipped default, pinned explicitly
  resetPluginUseCache();
  try {
    fn({ home, machineDir: path.join(home, '.traffic-one'), otherProject, base });
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetPluginUseCache();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** The machine state a real user has, by name, so a failure says WHICH one went. */
function seedMachineState(ctx: HomeCase): void {
  const { machineDir, otherProject } = ctx;
  fs.mkdirSync(path.join(machineDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(machineDir, 'toolchains', 'opencode', 'npm-prefix'), { recursive: true });
  fs.writeFileSync(oneSettingsPath(), `${JSON.stringify({
    schemaVersion: 3,
    auth: { version: 1, authenticated: true, apiKey: 'sk-the-users-real-key', updatedAt: '2099-01-01T00:00:00Z' },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(machineDir, 'bin', 'traffic-one-onboarding-wait'), '#!/bin/sh\n', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'toolchains', 'opencode', 'npm-prefix', 'marker'), 'installed\n', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'one-mcp.json'), '{"models":[]}\n', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'windsurf-plugin-root'), '/somewhere\n', 'utf8');
  fs.writeFileSync(path.join(machineDir, 'secret.env'), 'TOKEN=1\n', 'utf8');
  // Another project's recorded consent + wizard answers, in its own bucket.
  const otherPrefs = defaultProjectPrefsPath(otherProject);
  fs.mkdirSync(path.dirname(otherPrefs), { recursive: true });
  fs.writeFileSync(otherPrefs, `${JSON.stringify({
    pluginUse: { enabled: true, source: 'wizard', decidedAt: '2026-01-01T00:00:00Z' },
    team: { mode: 'subagents' },
  }, null, 2)}\n`, 'utf8');
}

function assertMachineStateIntact(ctx: HomeCase): void {
  const { machineDir, otherProject } = ctx;
  assert.equal(fs.existsSync(machineDir), true, 'the machine state directory still exists');
  assert.equal(
    JSON.parse(fs.readFileSync(oneSettingsPath(), 'utf8')).auth.apiKey,
    'sk-the-users-real-key',
    'the authenticated API key survives',
  );
  assert.equal(
    JSON.parse(fs.readFileSync(defaultProjectPrefsPath(otherProject), 'utf8')).pluginUse.enabled,
    true,
    "another project's recorded consent survives",
  );
  assert.equal(
    fs.readFileSync(path.join(machineDir, 'bin', 'traffic-one-onboarding-wait'), 'utf8'),
    '#!/bin/sh\n',
    'the version-stable runner shims survive (host tool approvals are pinned to them)',
  );
  assert.equal(
    fs.readFileSync(path.join(machineDir, 'toolchains', 'opencode', 'npm-prefix', 'marker'), 'utf8'),
    'installed\n',
    'the managed toolchains survive',
  );
  for (const rel of ['one-mcp.json', 'windsurf-plugin-root', 'secret.env']) {
    assert.equal(fs.existsSync(path.join(machineDir, rel)), true, `${rel} survives`);
  }
}

// ── BLOCKER: the decline ─────────────────────────────────────────────────────

// Driven through declineOutput, the real `--decline` command body
// (runners/onboarding-wait/index.ts passes it the raw session cwd with no
// project-root resolution), not through removeDeclinedProjectArtifacts directly:
// the sweep was reachable from the user-facing command, and a test that calls the
// primitive proves nothing about the path a user actually takes.
test('declining a $HOME-rooted session leaves the machine directory intact and records the decline', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);

    const stdout = declineOutput(ctx.home, 'cursor');

    assert.match(stdout, /^TRAFFIC_ONE_DISABLED\n/, 'the stdout protocol token is unchanged');
    assertMachineStateIntact(ctx);
    // The other half of the same defect: the prefs file recording the decline
    // used to live inside the tree the sweep removed, so the answer vanished with
    // it and the user was asked again next session — and could destroy it again.
    resetPluginUseCache();
    assert.equal(readPluginUseChoice(ctx.home)?.enabled, false, 'the decline is durably recorded');
  });
});

// The runtime residue still goes: a decline has to mean the activity log goes,
// and that half must not be lost to the machine-dir carve-out.
test('a $HOME-rooted decline still reclaims the runtime residue it is responsible for', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);
    fs.mkdirSync(path.join(ctx.machineDir, 'debug'), { recursive: true });
    fs.mkdirSync(path.join(ctx.machineDir, 'runs', '.once'), { recursive: true });
    fs.writeFileSync(path.join(ctx.machineDir, 'debug', 'decisions.jsonl'), '{"decision":"deny"}\n', 'utf8');
    fs.writeFileSync(path.join(ctx.machineDir, 'runs', '.once', 'marker'), 'x\n', 'utf8');

    declineOutput(ctx.home, 'cursor');

    assert.equal(fs.existsSync(path.join(ctx.machineDir, 'debug')), false, 'the activity log goes');
    assert.equal(fs.existsSync(path.join(ctx.machineDir, 'runs', '.once')), false, 'the once-markers go');
    assertMachineStateIntact(ctx);
  });
});

// An ORDINARY project is unaffected by the carve-out: the wholesale delete is
// still what a never-onboarded decline does. Without this the fix above could be
// "never delete anything", which passes every assertion in this file and disables
// the decline sweep for everyone.
test('an ordinary never-onboarded project still loses its whole state dir on decline', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);
    const ordinary = path.join(ctx.base, 'ordinary-project');
    const stateDir = path.join(ordinary, '.traffic-one');
    fs.mkdirSync(path.join(stateDir, 'runs', '.once'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runs', '.once', 'marker'), 'x\n', 'utf8');

    recordPluginUseChoice(ordinary, false, 'command');

    assert.equal(fs.existsSync(stateDir), false, 'the project state dir is swept wholesale');
    assertMachineStateIntact(ctx);
  });
});

// The decline has to be recorded wherever the answer file lives. Writing it
// BEFORE the sweep put it inside the tree the sweep removes — that is how a
// $HOME decline came to be forgotten, and the prefs override reproduces the same
// ordering hazard on an ordinary project (the legacy project-local layout, which
// resolveTrafficOneEnv strips for hosts but embedded callers may still set). The
// sweep runs first and the answer is written after it, so the record survives by
// construction rather than by where it happens to live.
test('a decline is recorded even when the answer file lives inside the swept state dir', () => {
  withHomeRootedSession((ctx) => {
    const project = path.join(ctx.base, 'legacy-prefs-project');
    const stateDir = path.join(project, '.traffic-one');
    const prefs = projectLocalPrefsPath(project);
    fs.mkdirSync(path.join(stateDir, 'runs', '.once'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'runs', '.once', 'marker'), 'x\n', 'utf8');
    fs.writeFileSync(prefs, '{}\n', 'utf8');
    process.env.TRAFFIC_ONE_PROJECT_PREFS_PATH = prefs;
    resetPluginUseCache();

    recordPluginUseChoice(project, false, 'command');

    assert.equal(fs.existsSync(path.join(stateDir, 'runs')), false, 'the runtime residue is still swept');
    resetPluginUseCache();
    assert.equal(readPluginUseChoice(project)?.enabled, false, 'the decline outlives the sweep');
  });
});

// The same incident by a second route: an XDG_STATE_HOME pointing inside a
// project's state dir puts the machine dir UNDER the tree the wholesale branch
// removes, so the guard has to be containment and not just equality. No shipped
// layout does this; the point is that the shape cannot destroy the machine dir.
test('the wholesale decline sweep spares a machine dir nested inside the state dir', () => {
  withHomeRootedSession((ctx) => {
    const project = ctx.otherProject;
    process.env.XDG_STATE_HOME = path.join(project, '.traffic-one', 'xdg');
    resetPluginUseCache();
    const machineDir = path.join(project, '.traffic-one', 'xdg', 'traffic-one');
    fs.mkdirSync(machineDir, { recursive: true });
    fs.writeFileSync(path.join(machineDir, 'one.json'), '{"auth":{"apiKey":"sk-nested"}}\n', 'utf8');

    recordPluginUseChoice(project, false, 'command');

    assert.equal(
      fs.existsSync(path.join(machineDir, 'one.json')), true,
      'a machine dir under the project state dir survives the decline',
    );
    resetPluginUseCache();
    assert.equal(readPluginUseChoice(project)?.enabled, false, 'the decline is still recorded');
  });
});

// ── SHOULD-FIX: the fence is ON for this shape ───────────────────────────────

test('the write fence governs a $HOME-rooted project like any other', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);
    const target = path.join(ctx.machineDir, 'runs', '1', 'ledger.json');
    const textTarget = path.join(ctx.machineDir, 'plan.md');

    assert.equal(projectRootForStatePath(target), ctx.home, 'the state dir belongs to the $HOME project');
    assert.equal(projectStateWriteAllowed(target), false, 'pending refuses');
    writeJson(target, { runId: '1' });
    assert.equal(fs.existsSync(target), false, 'writeJson refused');
    assert.equal(writeTextFile(textTarget, '# plan\n'), false);
    assert.equal(fs.existsSync(textTarget), false, 'writeTextFile refused');

    // …and the machine-owned entries beside them are still writable, because the
    // consent answer itself lives there: fencing them would make recording an
    // answer impossible and deadlock the product.
    recordPluginUseChoice(ctx.home, true, 'wizard');
    assert.equal(projectStateWriteAllowed(target), true, 'the fence acts the moment the answer is yes');
    writeJson(target, { runId: '1' });
    assert.equal(fs.existsSync(target), true);
  });
});

// The carve-out is now an ALLOWLIST, so an entry it forgets gets fenced. This is
// what makes that failure loud: every machine-owned path the codebase actually
// derives, from the helpers that derive it, must be exempt.
test('every machine-owned path the codebase derives stays exempt from the fence', () => {
  withHomeRootedSession((ctx) => {
    // Declined, i.e. the strictest state: nothing under a project's state dir may
    // be written, so anything below that is NOT exempt would be refused.
    recordPluginUseChoice(ctx.home, false, 'command');
    const machineOwned = [
      oneSettingsPath(),                                  // the auth record
      defaultProjectPrefsPath(ctx.otherProject),          // per-project prefs (the consent answer)
      defaultProjectPrefsPath(ctx.home),                  // …including this project's own
      oneMcpCachePath(),                                  // the One MCP model cache
      path.join(stableBinDir(), 'traffic-one-doctor'),     // version-stable runner shims
      path.join(toolchainRoot(), 'opencode', 'marker'),    // managed toolchains
      path.join(ctx.machineDir, 'windsurf-plugin-root'),
      path.join(ctx.machineDir, 'secret.env'),
      // The operator-override store. A $HOME-rooted mint is exactly the shape
      // that made this an allowlist question: without the entry, the per-install
      // key and the audit ledger are governed by the "$HOME project"'s own
      // unanswered use-plugin question, so the override would be refused —
      // silently, in the one situation the escape hatch exists for.
      overrideKeyPath(),
      overrideLedgerPath(ctx.otherProject),
      // A machine-owned file's own sidecars: the lock that guards the consent
      // answer, and the atomic-write temp file beside it.
      `${oneSettingsPath()}.lock`,
      `${oneSettingsPath()}.${process.pid}.tmp`,
    ];
    for (const target of machineOwned) {
      assert.ok(
        target.startsWith(`${ctx.machineDir}${path.sep}`),
        `${target} must be under the machine dir for this assertion to mean anything`,
      );
      assert.equal(projectRootForStatePath(target), null, `${target} is machine state, not project state`);
      assert.equal(projectStateWriteAllowed(target), true, `${target} must stay writable`);
    }
  });
});

// ── SHOULD-FIX: the recorded answer survives the stray-artifact self-heal ────

test('a recorded $HOME answer survives the stray-artifact sweep; an unanswered bucket is still reclaimed', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);
    const homeBucket = path.join(ctx.machineDir, 'projects', sha256(ctx.home));

    // No answer yet → the bucket is pre-guard residue and the self-heal reclaims
    // it, exactly as before. Asserted first so the case below is a real contrast.
    fs.mkdirSync(path.join(homeBucket, 'onboarding', 'claude'), { recursive: true });
    removeStrayProjectArtifactsFromGlobalDir();
    assert.equal(fs.existsSync(homeBucket), false, 'an unanswered bucket is still reclaimed');
    assertMachineStateIntact(ctx);

    // With an answer on record the bucket IS the answer. Deleting it re-asked the
    // question on the next session in ANY project — and answering "no" again ran
    // the decline sweep against the machine dir.
    for (const enabled of [true, false]) {
      recordPluginUseChoice(ctx.home, enabled, 'wizard');
      removeStrayProjectArtifactsFromGlobalDir();
      resetPluginUseCache();
      assert.equal(
        readPluginUseChoice(ctx.home)?.enabled,
        enabled,
        `a recorded ${enabled ? 'consent' : 'decline'} for $HOME survives the sweep`,
      );
    }
    assertMachineStateIntact(ctx);
  });
});

// The self-heal's own job, unchanged: $HOME is an isMachineConfigRoot, so
// Traffic One never legitimately materializes a project tree into the machine
// dir, and those names are residue whether an answer exists or not.
test('the stray-artifact sweep still reclaims project artifacts once an answer exists', () => {
  withHomeRootedSession((ctx) => {
    seedMachineState(ctx);
    recordPluginUseChoice(ctx.home, true, 'wizard');
    fs.mkdirSync(path.join(ctx.machineDir, 'rules', 'core'), { recursive: true });
    fs.writeFileSync(path.join(ctx.machineDir, '.one.json'), '{"mode":"existing-codebase"}', 'utf8');
    fs.writeFileSync(path.join(ctx.machineDir, 'manifest.json'), '{}', 'utf8');

    removeStrayProjectArtifactsFromGlobalDir();

    for (const gone of ['.one.json', 'manifest.json', 'rules']) {
      assert.equal(fs.existsSync(path.join(ctx.machineDir, gone)), false, `${gone} reclaimed`);
    }
    assertMachineStateIntact(ctx);
  });
});

// ── SHOULD-FIX: the pre-consent window is path-scoped ────────────────────────

test('the pre-consent write window licenses only the project it names', () => {
  withHomeRootedSession((ctx) => {
    const declining = ctx.otherProject;
    const bystander = path.join(ctx.base, 'third-project');
    fs.mkdirSync(bystander, { recursive: true });
    const decliningTarget = path.join(declining, '.traffic-one', 'x.json');
    const bystanderTarget = path.join(bystander, '.traffic-one', 'x.json');

    assert.equal(projectStateWriteAllowed(decliningTarget), false, 'both are pending outside the window');
    assert.equal(projectStateWriteAllowed(bystanderTarget), false);

    withPreConsentProjectWrites('decline-cleanup', declining, () => {
      assert.equal(
        projectStateWriteAllowed(decliningTarget), true,
        'the declining project is writable — undoing pre-answer writes is what the window is FOR',
      );
      assert.equal(
        projectStateWriteAllowed(bystanderTarget), false,
        "another pending project's state dir must NOT open just because this one is being declined",
      );
    });

    assert.equal(projectStateWriteAllowed(decliningTarget), false, 'the window closes again');
  });
});

// ── the path classifier's remaining boundaries ───────────────────────────────

// On macOS's default case-insensitive filesystem these spell the SAME FILE as the
// fenced path, so a case-sensitive compare was a way past the fence for any
// externally-supplied path.
test('case-variant state-dir spellings are fenced, and resolve to the same project', () => {
  withHomeRootedSession((ctx) => {
    const project = ctx.otherProject;
    for (const spelling of ['.traffic-one', '.Traffic-One', '.TRAFFIC-ONE', '.traffic-ONE']) {
      const target = path.join(project, spelling, 'x.json');
      assert.equal(projectRootForStatePath(target), project, `${spelling} resolves to the project`);
      assert.equal(projectStateWriteAllowed(target), false, `${spelling} is fenced while pending`);
    }
    // Still not the state dir, in any casing: a suffix makes it a different name.
    assert.equal(projectRootForStatePath(path.join(project, '.traffic-one-backup', 'x')), null);
    assert.equal(projectRootForStatePath(path.join(project, '.Traffic-One-Backup', 'x')), null);
  });
});

// The doc comment used to claim the OUTER project governs a nested state dir. It
// governs one nested INSIDE another state dir; a sibling package's own state dir
// belongs to that package. Both spellings are pinned so the comment and the
// behaviour cannot drift apart again.
test('a nested package owns its own state dir; a state dir inside a state dir belongs to the outer project', () => {
  withHomeRootedSession((ctx) => {
    const root = ctx.otherProject;
    const pkg = path.join(root, 'packages', 'ui');
    fs.mkdirSync(pkg, { recursive: true });
    recordPluginUseChoice(root, true, 'wizard');

    assert.equal(projectRootForStatePath(path.join(root, '.traffic-one', 'x.json')), root);
    assert.equal(projectStateWriteAllowed(path.join(root, '.traffic-one', 'x.json')), true);
    // Inside the outer state dir → still the outer project's consent.
    assert.equal(projectRootForStatePath(path.join(root, '.traffic-one', 'x', '.traffic-one', 'y.json')), root);
    // A sibling package is its own project as far as consent goes, and its own
    // question is unanswered.
    assert.equal(projectRootForStatePath(path.join(pkg, '.traffic-one', 'x.json')), pkg);
    assert.equal(projectStateWriteAllowed(path.join(pkg, '.traffic-one', 'x.json')), false);
  });
});
