// NESTED_TRAFFIC_ONE_ROOTS, reclassified for a Traffic One WORKSPACE.
//
// The probe reports every directory below the root that owns a `.one.json`, and
// for an ordinary project each one is a leak. For a workspace the same finding
// inverts the truth: THE MEMBER IS THE PROJECT — the container holds shared
// identity and no stack, each member holds an ordinary single-stack `.one.json`
// and owns its runs — so a member's state dir is where its state belongs. The
// finding's own advice is to point the cleanup runner at it, which for a member
// is user-initiated data loss: its runs, claims and plan.
//
// So a registered member must not be reported at all, and everything else must
// keep the wording it has, byte for byte, because a stray inside a real
// workspace is still a stray and the operator's remedy for it has not changed.
//
// The same argument reaches one directory further than "registered", and the
// last test here is why: the registry can REACH a directory without naming it (a
// symlinked entry), and the automatic SessionStart sweep deliberately withholds
// deletion for that case (hook/paths.ts's `vouched-not-member` arm). An advisory
// that tells the operator to hand-delete what the sweep spares is worse than the
// finding it replaced — the sweep is reversible policy, a hand `rm` is not — so
// the two paths ask one function, `registryEnclosureOf`, and report a stray only
// for its `none` arm.
//
// The same argument reaches the REGISTRY itself, and the last two tests here are
// why. `workspaceMembershipOf` grew an `indeterminate` arm: a container whose
// `.one.json` cannot be enumerated — torn, unreadable, or holding one malformed
// entry — makes the sweep withhold deletion for everything beneath it. The old
// rule here was "an unusable registry exempts nothing", which was consistent
// while the sweep deleted anyway and is the trap once it stops. So those
// verdicts now produce an INFORMATIONAL finding naming the unreadable registry
// and carrying no cleanup advice at all, and the byte-identical delete wording
// is reserved for `none`, where both paths still say the same thing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';

import { buildFindings } from '../findings';
import { NODE_FLOOR_MAJOR } from '../../../shared/node-floor';
import { WORKSPACE_PROJECT_MODE } from '../../../shared/hook/workspace-members';
import { probeProject, type GitnexusProbe, type NodeProbe, type NvmProbe, type ProjectProbe } from '../probes';

const CONTAINER = '/repo';

function project(over: Partial<ProjectProbe> = {}): ProjectProbe {
  return {
    cwd: CONTAINER,
    hasState: false,
    state: null,
    localPreferences: {},
    localPreferencesPath: null,
    hasLocalPreferences: false,
    normalizedState: null,
    nvmrc: null,
    hasGit: true,
    artefacts: { gitnexus: null, graphify: null },
    runState: {
      currentRunId: null,
      runDirExists: false,
      runJsonExists: false,
      runJsonStatus: null,
      hasOrchestratedArtifacts: false,
      maintenanceJsonExists: false,
      maintenanceOutcome: null,
      maintenanceOverallOutcome: null,
      maintenanceOpencodeOutcome: null,
      maintenanceFallbackAllowed: false,
      maintenanceTerminalOrFallbackPending: false,
    },
    nestedTrafficOneRoots: [],
    openCodeCli: 'managed',
    legacyCapabilityMigration: { status: 'not-applicable', message: null },
    ...over,
  };
}

const node = (): NodeProbe => ({
  runningMajor: 22, runningVersion: '22.0.0', onPath: '/usr/bin/node',
  requiredMajor: 22, pluginRequiredMajor: NODE_FLOOR_MAJOR,
});
const nvm = (): NvmProbe => ({ installed: false });
const gitnexus = (): GitnexusProbe => ({ onPath: null, absoluteV22: null, crashRiskInOldNvm: false });

function nestedFinding(over: Partial<ProjectProbe>): { severity: string; message: string } | undefined {
  return buildFindings({ node: node(), nvm: nvm(), gitnexus: gitnexus(), project: project(over) })
    .find((finding) => finding.code === 'NESTED_TRAFFIC_ONE_ROOTS');
}

function workspaceState(members: readonly string[]): Record<string, unknown> {
  return {
    mode: WORKSPACE_PROJECT_MODE,
    onboardingComplete: true,
    workspaceMembers: members.map((member) => ({ path: member })),
  };
}

test('nested roots: a REGISTERED workspace member is not a nested-root problem at all', () => {
  assert.equal(
    nestedFinding({
      state: workspaceState(['apps/web', 'services/ledger']),
      hasState: true,
      nestedTrafficOneRoots: ['/repo/apps/web', '/repo/services/ledger'],
    }),
    undefined,
    'every nested root is a member — nothing is left to report, so no finding is raised',
  );
});

test('nested roots: a genuine stray beside the members keeps its EXACT wording', () => {
  const finding = nestedFinding({
    state: workspaceState(['apps/web']),
    hasState: true,
    nestedTrafficOneRoots: ['/repo/apps/web', '/repo/tools/scratch'],
  });
  assert.equal(finding?.severity, 'fix-needed');
  assert.equal(
    finding?.message,
    'Nested Traffic One state roots were found inside this workspace: /repo/tools/scratch. '
    + 'Hooks will not delete them automatically; inspect them, then use the cleanup runner in apply mode '
    + 'only after confirming the ancestor workspace root is the real project.',
    'the member is gone from the list and the operator advice is byte-identical for the stray',
  );
});

test('nested roots: state INSIDE a member is a stray in the member, not the member itself', () => {
  // EXACT membership, matching hook/paths.ts isRegisteredWorkspaceMember rather
  // than the resolver's ancestor-or-self redirect: `<member>/internal` is not a
  // member, and a `.traffic-one` there is a leak the member's own sweep heals.
  const finding = nestedFinding({
    state: workspaceState(['apps/web']),
    hasState: true,
    nestedTrafficOneRoots: ['/repo/apps/web/internal'],
  });
  assert.match(finding?.message ?? '', /\/repo\/apps\/web\/internal/);
});

test('nested roots: an OPTED-OUT member carries no delete advice — the sweep spares it too', () => {
  // Opting out grants no AUTHORITY — `members` excludes the entry, so every
  // resolver answers for it as it does for a directory nobody wrote down — and
  // for as long as this finding keyed on authority it advised deleting the state
  // of a directory whose flag says "Traffic One leaves this alone". On the
  // DELETION axis the resolver reads the entry (registryEnclosureOf's opt-out
  // arm: `vouched`), and the sweep therefore never treats it as a leaked nested
  // root. An absent entry is "nobody considered this directory"; an opted-out
  // entry is a decision recorded ABOUT it, which is exactly what `none` denies.
  assert.equal(
    nestedFinding({
      state: {
        mode: WORKSPACE_PROJECT_MODE,
        onboardingComplete: true,
        workspaceMembers: [{ path: 'apps/web', optOut: true }],
      },
      hasState: true,
      nestedTrafficOneRoots: ['/repo/apps/web'],
    }),
    undefined,
  );
});

test('nested roots: an UNUSABLE registry advises nothing — the sweep spares what it cannot adjudicate', () => {
  // The reversal, and the reason for it. `workspaceMembershipOf` answers
  // `indeterminate` for every directory under a container whose registry cannot
  // be enumerated, and the resolution walk reads that as "withhold the
  // deletion". An advisory that told the operator to hand-delete the same
  // directory would be the trap this module's docblock forbids — worse than the
  // finding it replaced, because a hand `rm` is not reversible policy. The
  // directory is still NAMED, so nothing is silenced; what is withdrawn is the
  // instruction, and the remedy offered is the one that makes the question
  // answerable.
  for (const [label, state] of [
    ['a non-array registry', { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: 'apps/web' }],
    ['a malformed entry', { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [{ path: '../escape' }] }],
    ['a glob entry, which a registry may never carry', { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: [{ path: 'apps/*' }] }],
    ['two entries colliding on one id', {
      mode: WORKSPACE_PROJECT_MODE,
      workspaceMembers: [{ path: 'apps/web', id: 'same' }, { path: 'tools/scratch', id: 'same' }],
    }],
  ] as const) {
    const over = {
      state: state as Record<string, unknown>,
      hasState: true,
      nestedTrafficOneRoots: ['/repo/apps/web'],
    };
    assert.equal(nestedFinding(over), undefined, `${label}: no delete advice may be attached`);

    const informational = buildFindings({
      node: node(), nvm: nvm(), gitnexus: gitnexus(), project: project(over),
    }).find((finding) => finding.code === 'NESTED_TRAFFIC_ONE_ROOTS_MEMBERSHIP_UNKNOWN');
    assert.equal(informational?.severity, 'info', label);
    assert.match(informational?.message ?? '', /\/repo\/apps\/web/, `${label}: the directory is still named`);
    assert.doesNotMatch(informational?.message ?? '', /cleanup runner/, `${label}: and carries no cleanup instruction`);
  }
});

test('nested roots: an unreadable registry with nothing nested says nothing at all', () => {
  // The finding is ABOUT nested roots. A container whose registry is unusable
  // and holds no nested state root has no question to be unsure about, and a
  // diagnostic that reported one would be noise in every torn-state report.
  assert.equal(
    buildFindings({
      node: node(),
      nvm: nvm(),
      gitnexus: gitnexus(),
      project: project({
        state: { mode: WORKSPACE_PROJECT_MODE, workspaceMembers: 'apps/web' },
        hasState: true,
        nestedTrafficOneRoots: [],
      }),
    }).find((finding) => finding.code === 'NESTED_TRAFFIC_ONE_ROOTS_MEMBERSHIP_UNKNOWN'),
    undefined,
  );
});

test('nested roots: a FORGED or stale entry silences a real stray, and that is the safe direction', () => {
  // Accepted rather than overlooked. Anyone who can add `{ path: 'tools/scratch' }`
  // to the container's `.one.json` can silence this finding for that directory,
  // and an entry left behind after a member was deleted and the directory
  // reused does the same by accident. The finding's own advice is to point the
  // cleanup runner at the directory, so a false NEGATIVE costs an unreported
  // stray while a false POSITIVE costs a live project its runs, claims and
  // plan. The registry lives in the same state file that decided this is a
  // workspace at all, so trusting it is no weaker than trusting the mode.
  assert.equal(
    nestedFinding({
      state: workspaceState(['apps/web', 'tools/scratch']),
      hasState: true,
      nestedTrafficOneRoots: ['/repo/apps/web', '/repo/tools/scratch'],
    }),
    undefined,
    'the entry is taken at its word — suppression, not a report',
  );
});

test('nested roots: a workspace NESTED inside an ordinary project is not a stray, nor are its members', () => {
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 't1-nested-ws-above-')));
  TEMP_DIRS.push(root);
  fs.mkdirSync(nodePath.join(root, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'existing-codebase', onboardingComplete: true }),
    'utf8',
  );
  const ws = nodePath.join(root, 'nested-ws');
  fs.mkdirSync(nodePath.join(ws, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(ws, '.traffic-one', '.one.json'),
    JSON.stringify({
      mode: WORKSPACE_PROJECT_MODE,
      onboardingComplete: true,
      workspaceMembers: [{ path: 'apps/web' }, { path: 'services/ledger' }],
    }),
    'utf8',
  );
  for (const member of ['apps/web', 'services/ledger']) {
    const dir = nodePath.join(ws, ...member.split('/'));
    fs.mkdirSync(nodePath.join(dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(
      nodePath.join(dir, '.traffic-one', '.one.json'),
      JSON.stringify({ mode: 'existing-codebase' }),
      'utf8',
    );
  }
  const stray = nodePath.join(root, 'tools', 'scratch');
  fs.mkdirSync(nodePath.join(stray, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(stray, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'new-project' }),
    'utf8',
  );

  const probed = probeProject(root);
  const finding = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gitnexus(), project: probed,
  }).find((row) => row.code === 'NESTED_TRAFFIC_ONE_ROOTS');
  assert.equal(finding?.severity, 'fix-needed');
  assert.equal(
    finding?.message,
    `Nested Traffic One state roots were found inside this workspace: ${stray}. `
    + 'Hooks will not delete them automatically; inspect them, then use the cleanup runner in apply mode '
    + 'only after confirming the ancestor workspace root is the real project.',
    'the nested container and its members are gone from the list; only the stray remains',
  );
});

test('nested roots: an unreadable nested workspace does not list its members as strays', () => {
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 't1-nested-ws-opaque-')));
  TEMP_DIRS.push(root);
  fs.mkdirSync(nodePath.join(root, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(root, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'existing-codebase', onboardingComplete: true }),
    'utf8',
  );
  const ws = nodePath.join(root, 'nested-ws');
  const member = nodePath.join(ws, 'apps', 'web');
  fs.mkdirSync(nodePath.join(ws, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(ws, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: WORKSPACE_PROJECT_MODE, workspaceMembers: 'apps/web' }),
    'utf8',
  );
  fs.mkdirSync(nodePath.join(member, '.traffic-one'), { recursive: true });
  fs.writeFileSync(
    nodePath.join(member, '.traffic-one', '.one.json'),
    JSON.stringify({ mode: 'existing-codebase' }),
    'utf8',
  );

  const findings = buildFindings({
    node: node(), nvm: nvm(), gitnexus: gitnexus(), project: probeProject(root),
  });
  assert.equal(
    findings.find((row) => row.code === 'NESTED_TRAFFIC_ONE_ROOTS'),
    undefined,
    'members under an unreadable nested registry are not cleanup candidates',
  );
  const unknown = findings.find((row) => row.code === 'NESTED_TRAFFIC_ONE_ROOTS_MEMBERSHIP_UNKNOWN');
  assert.equal(unknown?.severity, 'info');
  assert.match(unknown?.message ?? '', /apps\/web/);
  assert.doesNotMatch(unknown?.message ?? '', /cleanup runner/);
});

// ── the arm the sweep spares ─────────────────────────────────────────────────
//
// Real directories, because the question is a filesystem identity one: a
// registry entry that is a SYMLINK reaches the directory it points at, and
// nothing about the two spellings says so.

const TEMP_DIRS: string[] = [];
after(() => {
  for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true });
});

function workspaceOnDisk(): string {
  const root = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), 't1-nested-')));
  TEMP_DIRS.push(root);
  for (const dir of ['secret', nodePath.join('tools', 'scratch')]) {
    fs.mkdirSync(nodePath.join(root, dir, '.traffic-one'), { recursive: true });
    fs.writeFileSync(nodePath.join(root, dir, '.traffic-one', '.one.json'), '{"mode":"new-project"}', 'utf8');
  }
  // The entry the registry names. It is not the directory it reaches.
  fs.symlinkSync(nodePath.join(root, 'secret'), nodePath.join(root, 'x'), 'dir');
  return root;
}

test('nested roots: a VOUCHED directory is not a stray — the sweep spares it, so the advisory must too', () => {
  const root = workspaceOnDisk();
  const secret = nodePath.join(root, 'secret');
  assert.equal(
    nestedFinding({
      cwd: root,
      state: workspaceState(['x']),
      hasState: true,
      nestedTrafficOneRoots: [secret],
    }),
    undefined,
    'the registry entry `x` reaches this directory without naming it: no member authority, and no delete advice',
  );

  // The control, in the SAME workspace: a directory no entry reaches at all is
  // still a stray, still `fix-needed`, and still carries the wording another
  // lane pins byte for byte.
  const stray = nodePath.join(root, 'tools', 'scratch');
  const finding = nestedFinding({
    cwd: root,
    state: workspaceState(['x']),
    hasState: true,
    nestedTrafficOneRoots: [secret, stray],
  });
  assert.equal(finding?.severity, 'fix-needed');
  assert.equal(
    finding?.message,
    `Nested Traffic One state roots were found inside this workspace: ${stray}. `
    + 'Hooks will not delete them automatically; inspect them, then use the cleanup runner in apply mode '
    + 'only after confirming the ancestor workspace root is the real project.',
    'the vouched directory is gone from the list and the stray reads exactly as it always did',
  );
});

test('nested roots: an entry that NAMES its directory is a member on disk too, not merely vouched', () => {
  // The other side of `namesDirectly`, which is what keeps the exemption from
  // being "anything the registry can reach": `secret` spelled directly is a
  // member, and the finding is silent for the same directory under both
  // spellings — but only one of them also carries a member's authority, which is
  // decided in hook/paths.ts and not here.
  const root = workspaceOnDisk();
  assert.equal(
    nestedFinding({
      cwd: root,
      state: workspaceState(['secret']),
      hasState: true,
      nestedTrafficOneRoots: [nodePath.join(root, 'secret')],
    }),
    undefined,
  );
});

test('nested roots: every non-workspace project reports exactly what it always did', () => {
  for (const [label, state] of [
    ['no state at all', null],
    ['new-project', { mode: 'new-project' }],
    ['existing-codebase', { mode: 'existing-codebase' }],
    ['existing-with-supabase', { mode: 'existing-with-supabase' }],
    // The nested root is even NAMED like a member — the mode is what decides,
    // so a non-workspace project cannot accidentally exempt a sub-package.
    ['a monorepo root that registers nothing', { mode: 'new-project', workspaceMembers: [{ path: 'apps/web' }] }],
  ] as const) {
    const finding = nestedFinding({
      state: state as Record<string, unknown> | null,
      nestedTrafficOneRoots: ['/repo/apps/web'],
    });
    assert.equal(finding?.severity, 'fix-needed', label);
    assert.match(finding?.message ?? '', /\/repo\/apps\/web/, label);
  }
});
