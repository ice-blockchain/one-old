// src/runners/traffic-one-uninstall/index.ts
// Removes every machine-global trace of Traffic One, in the one order that is
// safe, then removes the plugin bundle itself from each host CLI that has it.
//
// The ordering is not cosmetic:
//   1. The Kilo wrapper FIRST. It is fail-closed and its plugin-bundle path is
//      baked in at install time, so a wrapper left behind after the bundle is
//      gone denies every tool call in every Traffic One project on Kilo — and
//      the script that would repair it has just been deleted. OpenCode's wrapper
//      fails open, so it is merely residual, but it is removed here as well.
//   2. Windsurf/Cascade hooks + global rule, and the Codex machine-global MCP
//      block. Both survive bundle removal and keep pointing at a dead path.
//   3. The plugin bundle, via each host CLI. Every module this runner needs is
//      already loaded by then, so deleting the bundle mid-run is safe.
//   4. ~/.traffic-one — auth record, per-user preferences, runner shims, managed
//      toolchains — LAST. Earlier steps spawn host CLIs and wrapper uninstalls
//      that may touch machine state; deleting the dir after every other step has
//      run is what guarantees the user actually ends with no ~/.traffic-one
//      (previously it was removed mid-run and a later step could repopulate it).
//      When XDG_STATE_HOME redirects the active state dir, a leftover pre-XDG
//      ~/.traffic-one is swept as well — a full uninstall leaves neither behind.
//
// Onboarded projects are deliberately untouched: their `.traffic-one/` folders
// and generated instructions are project content, not plugin state.
//
// Consent-gated like every other user-level mutation here: no `--yes`, no writes.
//
// Between steps 3 and 4 sits a residue sweep, because "the host CLI removed the
// plugin" is not the same claim as "the bytes are gone". Measured against what
// the install path actually writes (build/sync-hosts.ts): `codex plugin remove`
// reclaims Codex's plugin CACHE and leaves the staged marketplace copy the
// install rsync'd into ~/.codex/local-marketplaces/traffic-one-local; `copilot
// plugin install <dir>` copies the whole bundle into
// ~/.copilot/installed-plugins/, which discoverPluginInstalls never even looked
// at; and Cursor's local install is a plain directory with no CLI behind it,
// which this runner used to only print advice about. All three outlive an
// uninstall otherwise. Directories are removed only where BOTH the ownership and
// the removal spelling are established in this repository — see
// discoverInstallResidue; everything else is reported by path and left alone,
// which is also why no `claude plugin marketplace remove` appears here: that
// spelling is nowhere in this repo, and inventing a CLI invocation for a machine
// none of these tests can observe is a guess, not an uninstall.

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runOneMcpHostCommand } from '../one-mcp-host';
import { kiloGlobalPluginPath, uninstallWrapper as uninstallKiloWrapper } from '../kilo-host';
import { opencodeGlobalPluginPath, uninstallWrapper as uninstallOpenCodeWrapper } from '../opencode-host';
import {
  uninstallWrapper as uninstallWindsurfWrapper,
  windsurfGlobalRulesPath,
  windsurfHooksPath,
} from '../windsurf-host';
import { codexConfigPath } from '../../shared/codex-mcp';
import { globalTrafficOneDir } from '../../shared/state/traffic-one-paths';
import { readRegularFileOrThrow } from '../../shared/bounded-read';

export interface RunnerOutput { code: number; stdout: string; stderr?: string }

export interface Step { label: string; ok: boolean; detail: string }

const PLUGIN_NAME = 'traffic-one';
const WINDSURF_CHANNELS = ['stable', 'next', 'insiders'] as const;

interface PluginInstall {
  host: 'claude' | 'codex' | 'cursor';
  cli: string | null;
  marketplace: string;
  dir: string;
}

function homeDir(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function firstLine(text: string | undefined): string {
  return String(text || '').trim().split('\n').filter(Boolean).join('; ');
}

// Every (host, marketplace) pair whose cache actually holds a traffic-one plugin,
// plus Cursor's unversioned local install. Codex requires PLUGIN@MARKETPLACE, so
// the marketplace is discovered rather than assumed.
export function discoverPluginInstalls(env: NodeJS.ProcessEnv = process.env): PluginInstall[] {
  const home = homeDir(env);
  const found: PluginInstall[] = [];
  const hosts = [
    { host: 'claude', dir: '.claude', cli: 'claude' },
    { host: 'codex', dir: '.codex', cli: 'codex' },
    { host: 'cursor', dir: '.cursor', cli: null },
  ] as const;
  for (const { host, dir, cli } of hosts) {
    const cache = path.join(home, dir, 'plugins', 'cache');
    let marketplaces: string[] = [];
    try { marketplaces = fs.readdirSync(cache); } catch { marketplaces = []; }
    for (const marketplace of marketplaces) {
      const pluginDir = path.join(cache, marketplace, PLUGIN_NAME);
      try {
        if (!fs.statSync(pluginDir).isDirectory()) continue;
      } catch { continue; }
      found.push({ host, cli, marketplace, dir: pluginDir });
    }
    const local = path.join(home, dir, 'plugins', 'local', PLUGIN_NAME);
    try {
      if (fs.statSync(local).isDirectory()) found.push({ host, cli: null, marketplace: 'local', dir: local });
    } catch { /* no local install */ }
  }
  return found;
}

// ── residue no host CLI reclaims ────────────────────────────────────────────

export interface Residue {
  label: string;
  /** Absolute directory to remove, or null for a report-only finding. */
  dir: string | null;
  /** Why it survives the host's own uninstall — printed in the dry-run plan. */
  why: string;
  /** Optional host CLI call to make first, in a spelling this repo already uses. */
  cli?: readonly string[];
}

// Containment for every delete below. The paths are composed from `home` plus
// literal segments, so this cannot currently fail — it exists because the next
// entry added here will be composed from a directory ENTRY NAME read off disk,
// and a `..` in that name is the difference between removing a plugin copy and
// removing the user's home. Requires at least three segments below home, which
// no host's plugin root is shallower than.
//
// What refuses traversal here is the RESOLUTION, not a segment scan. This used
// to end with `!rest.includes('..')`, which no input could ever reach:
// path.resolve normalizes before the segments are split, so `rest` cannot hold
// a `..` (measured: `/home/dev/.copilot/installed-plugins/../../../etc`
// resolves to `/home/etc` and is refused by the containment test above, with
// zero segments examined). It is recorded rather than restored so the next
// reader does not re-add it believing it carries the traversal case.
//
// The containment is a PATH claim, not a filesystem one: this resolves, it does
// not realpath, so a SYMLINK under a residue root passes — its resolved path is
// inside home whatever it points at. The blast radius of that is one symlink:
// fs.rmSync unlinks the link and leaves the target intact (measured against a
// fixture; __tests__/uninstall.test.ts pins it). Widening this to realpath
// would refuse a legitimately symlinked plugin dir, which is the more common
// shape of the two, so the behaviour is documented and pinned rather than
// changed.
export function isRemovableResidueDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const home = path.resolve(homeDir(env));
  const resolved = path.resolve(dir);
  if (resolved === home || !resolved.startsWith(home + path.sep)) return false;
  return resolved.slice(home.length + 1).split(path.sep).filter(Boolean).length >= 3;
}

/** Does this directory hold the Traffic One plugin bundle? Read, never assumed. */
function isTrafficOneBundle(dir: string): boolean {
  try {
    const parsed = JSON.parse(readRegularFileOrThrow(path.join(dir, 'package.json'))) as { name?: unknown };
    return parsed.name === PLUGIN_NAME;
  } catch {
    return false;
  }
}

// Only what is ACTUALLY on this machine, probed the way discoverPluginInstalls
// probes: a plan that lists paths nobody has is noise, and a plan that omits a
// path somebody does have is the bug this sweep exists to fix.
export function discoverInstallResidue(env: NodeJS.ProcessEnv = process.env): Residue[] {
  const home = homeDir(env);
  const found: Residue[] = [];

  // Codex: the staged marketplace copy. `codex plugin remove` reclaims the cache,
  // not this — it is the rsync target of the install, and the marketplace
  // registration pointing at it is removed with the one spelling sync-hosts.ts
  // already uses (`codex plugin marketplace remove`).
  const codexStaged = path.join(home, '.codex', 'local-marketplaces', 'traffic-one-local');
  if (fs.existsSync(codexStaged)) {
    found.push({
      label: 'Codex local marketplace',
      dir: codexStaged,
      why: 'the staged plugin copy the install rsyncs here; `codex plugin remove` reclaims the cache, never this',
      cli: ['codex', 'plugin', 'marketplace', 'remove', 'traffic-one-local'],
    });
  }

  // Copilot: `copilot plugin install <dir>` copies the bundle under a name
  // derived from the SOURCE directory, so the entry is identified by reading its
  // package.json rather than by expecting to find `traffic-one`.
  const copilotRoot = path.join(home, '.copilot', 'installed-plugins');
  for (const parent of [copilotRoot, path.join(copilotRoot, '_direct')]) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(parent); } catch { continue; }
    for (const entry of entries) {
      const dir = path.join(parent, entry);
      if (!isTrafficOneBundle(dir)) continue;
      found.push({
        label: `Copilot plugin copy (${entry})`,
        dir,
        why: 'a full copy of the bundle; no Copilot uninstall spelling is established in this repo, and this runner never looked here',
      });
    }
  }

  // Cursor: a local install is a plain directory with no CLI. The product's own
  // sync already removes exactly this path (build/sync-hosts.ts syncCursor), so
  // deleting it here is an established operation rather than a new one. The
  // registry-backed CACHE installs stay advisory: their host owns them.
  const cursorLocal = path.join(home, '.cursor', 'plugins', 'local', PLUGIN_NAME);
  if (fs.existsSync(cursorLocal)) {
    found.push({
      label: 'Cursor local install',
      dir: cursorLocal,
      why: 'no uninstall CLI exists for it; left behind it also double-fires every hook beside the imported bundle',
    });
  }

  // Claude's marketplace registration: reported, never removed. The directory
  // name would be unambiguous, but no `claude plugin marketplace remove`
  // spelling exists anywhere in this repo to pair with it, and deleting the
  // registration's directory while its config entry survives trades one residue
  // for a dangling one.
  const claudeMarketplace = path.join(home, '.claude', 'plugins', 'marketplaces', PLUGIN_NAME);
  if (fs.existsSync(claudeMarketplace)) {
    found.push({
      label: 'Claude marketplace registration',
      dir: null,
      why: `remove the Traffic One marketplace from Claude's plugin UI — no CLI spelling for this is established here (${claudeMarketplace})`,
    });
  }

  return found;
}

function removeResidue(item: Residue, env: NodeJS.ProcessEnv, dryRun: boolean): Step {
  const label = item.label;
  if (!item.dir) return { label, ok: true, detail: `manual: ${item.why}` };
  if (dryRun) return { label, ok: true, detail: `would remove (${item.why}): ${item.dir}` };
  if (!isRemovableResidueDir(item.dir, env)) {
    return { label, ok: false, detail: `refused: ${item.dir} is not a contained user-level plugin path` };
  }
  const details: string[] = [];
  if (item.cli) {
    const [cmd, ...args] = item.cli;
    const result = spawnSync(cmd as string, args, { encoding: 'utf8', timeout: 120_000, env });
    if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
      details.push(`\`${cmd}\` not on PATH — run \`${item.cli.join(' ')}\` yourself`);
    } else if (result.error || result.status !== 0) {
      // Never fatal: the registration may already be gone, which is what a
      // re-run and a partially-uninstalled machine both look like. The bytes
      // below are what this step is actually accountable for.
      details.push(`\`${item.cli.join(' ')}\` did not succeed (${firstLine(result.stderr) || `exit ${result.status}`})`);
    } else {
      details.push(firstLine(result.stdout) || `${item.cli.join(' ')}: done`);
    }
  }
  try {
    fs.rmSync(item.dir, { recursive: true, force: true });
    details.push(`removed ${item.dir}`);
    return { label, ok: true, detail: details.join('; ') };
  } catch (error) {
    details.push(`failed: ${error instanceof Error ? error.message : String(error)}`);
    return { label, ok: false, detail: details.join('; ') };
  }
}

function residueSteps(env: NodeJS.ProcessEnv, dryRun: boolean): Step[] {
  const residue = discoverInstallResidue(env);
  if (residue.length === 0) return [{ label: 'install residue', ok: true, detail: 'none present' }];
  return residue.map((item) => removeResidue(item, env, dryRun));
}

function pluginCliArgs(install: PluginInstall): string[] {
  const spec = `${PLUGIN_NAME}@${install.marketplace}`;
  return install.host === 'codex' ? ['plugin', 'remove', spec] : ['plugin', 'uninstall', spec];
}

export function describePluginInstall(install: PluginInstall): string {
  if (!install.cli) {
    return `${install.host} (${install.marketplace}) — no uninstall CLI; remove it from the ${install.host} plugin UI`;
  }
  return `${install.cli} ${pluginCliArgs(install).join(' ')}`;
}

function removePluginViaCli(install: PluginInstall, env: NodeJS.ProcessEnv): Step {
  const label = `plugin bundle (${install.host}/${install.marketplace})`;
  if (!install.cli) {
    // A `local` install is a plain directory with no registry behind it, and the
    // residue sweep removes it a few steps below; saying "remove it from the
    // plugin UI" for a path this run is about to delete would send the user
    // looking for something that is already gone.
    if (install.marketplace === 'local') {
      return { label, ok: true, detail: `no uninstall CLI; the residue sweep removes the directory (${install.dir})` };
    }
    return { label, ok: true, detail: `manual: remove Traffic One from the ${install.host} plugin UI (${install.dir})` };
  }
  const result = spawnSync(install.cli, pluginCliArgs(install), { encoding: 'utf8', timeout: 120_000, env });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { label, ok: true, detail: `skipped: \`${install.cli}\` is not on PATH — run \`${describePluginInstall(install)}\` yourself` };
    }
    return { label, ok: false, detail: `failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { label, ok: false, detail: `failed (exit ${result.status}): ${firstLine(result.stderr) || firstLine(result.stdout)}` };
  }
  return { label, ok: true, detail: firstLine(result.stdout) || 'removed' };
}

// Last guard before an `rm -rf` on a path derived from the environment: it must
// look like ours and must never be the home dir or a filesystem root. Nothing in
// globalTrafficOneDir can produce such a path today — this exists so a future
// change to that resolution cannot silently widen the delete.
export function isRemovableStateDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return false;
  if (resolved === path.resolve(homeDir(env) || os.homedir())) return false;
  return path.basename(resolved) === '.traffic-one' || path.basename(resolved) === 'traffic-one';
}

function removeStateDirAt(dir: string, env: NodeJS.ProcessEnv, dryRun: boolean, dryRunDetail: string): Step {
  const label = `state dir ${dir}`;
  if (!isRemovableStateDir(dir, env)) {
    return { label, ok: false, detail: 'refused: resolved path is not a Traffic One state dir' };
  }
  if (!fs.existsSync(dir)) return { label, ok: true, detail: 'not present' };
  if (dryRun) return { label, ok: true, detail: dryRunDetail };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return { label, ok: true, detail: 'removed' };
  } catch (error) {
    return { label, ok: false, detail: `failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// The full state sweep, run LAST: the active state dir, plus — when
// XDG_STATE_HOME redirects it — any leftover pre-XDG ~/.traffic-one. A user who
// asked for an uninstall must end with NO local preferences folder at all.
function removeStateDirs(env: NodeJS.ProcessEnv, dryRun: boolean): Step[] {
  const steps = [removeStateDirAt(
    globalTrafficOneDir(env),
    env,
    dryRun,
    'would remove LAST (auth record, preferences, shims, managed toolchains)',
  )];
  const legacyHome = path.join(homeDir(env), '.traffic-one');
  if (path.resolve(legacyHome) !== path.resolve(globalTrafficOneDir(env)) && fs.existsSync(legacyHome)) {
    steps.push(removeStateDirAt(legacyHome, env, dryRun, 'would remove (pre-XDG leftover state)'));
  }
  return steps;
}

function presenceStep(label: string, file: string, action: string): Step {
  return fs.existsSync(file)
    ? { label, ok: true, detail: `${action} (${file})` }
    : { label, ok: true, detail: `not present (${file})` };
}

// First `<dir>/<cmd>` on the given PATH, symlinks included (a dangling shim is
// still residue worth naming). Deliberately env-threaded rather than a shell
// `command -v`, so the report describes the machine, not this process.
function resolveOnPath(cmd: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, cmd);
    try {
      fs.lstatSync(candidate);
      return candidate;
    } catch { /* next dir */ }
  }
  return null;
}

// ADVISORY ONLY — never removes anything. Traffic One used to install graphify
// through pipx, which lands in the user's pipx home instead of the managed
// toolchain root, so the state sweep above cannot reach it. We report it and
// stop there: provenance is undecidable (the user may have installed graphifyy
// for themselves), and running `pipx uninstall` on their tool would be a worse
// failure than leaving a stray one behind.
function pipxGraphifyStep(env: NodeJS.ProcessEnv): Step {
  const label = 'graphify installed outside ~/.traffic-one';
  const onPath = resolveOnPath('graphify', env);
  if (!onPath) return { label, ok: true, detail: 'not present' };
  let target = onPath;
  try {
    target = fs.realpathSync(onPath);
  } catch {
    try { target = fs.readlinkSync(onPath); } catch { /* keep the PATH entry */ }
  }
  if (!/[\\/]pipx[\\/]venvs[\\/]/.test(target)) {
    return { label, ok: true, detail: `\`graphify\` on PATH is not a pipx install — not ours, left alone (${onPath})` };
  }
  return {
    label,
    ok: true,
    detail: `\`graphify\` on PATH resolves into a pipx venv (${target}) — older Traffic One versions installed it there. `
      + 'It is NOT removed by this uninstall. If you do not use graphifyy yourself: `pipx uninstall graphifyy`',
  };
}

function hostStep(label: string, result: RunnerOutput): Step {
  return {
    label,
    ok: result.code === 0,
    detail: (result.code === 0 ? firstLine(result.stdout) : firstLine(result.stderr) || firstLine(result.stdout))
      || (result.code === 0 ? 'done' : `exit ${result.code}`),
  };
}

interface UninstallOptions {
  dryRun: boolean;
  keepPlugin: boolean;
}

export function runUninstall(options: UninstallOptions, env: NodeJS.ProcessEnv = process.env): { code: number; steps: Step[] } {
  const steps: Step[] = [];
  const installs = discoverPluginInstalls(env);

  if (options.dryRun) {
    // A preview is only useful if it reports what is actually on this machine, so
    // each integration is probed rather than described from the install recipe.
    steps.push(presenceStep(
      'Kilo wrapper',
      kiloGlobalPluginPath(env),
      'would remove it FIRST — it is fail-closed, so a wrapper outliving the bundle denies every tool call',
    ));
    steps.push(presenceStep(
      'OpenCode wrapper',
      opencodeGlobalPluginPath(env),
      'would remove it and its entry in the OpenCode global config',
    ));
    for (const channel of WINDSURF_CHANNELS) {
      steps.push(presenceStep(
        `Windsurf integration (${channel})`,
        windsurfHooksPath(env, ['--channel', channel]),
        `would remove the Cascade/Devin hooks and the global rule (${windsurfGlobalRulesPath(env, ['--channel', channel])})`,
      ));
    }
    steps.push(presenceStep(
      'Codex MCP block',
      codexConfigPath(env),
      'would remove the Traffic One marked block if it is still byte-exact',
    ));
    for (const install of installs) {
      steps.push({
        label: `plugin bundle (${install.host}/${install.marketplace})`,
        ok: true,
        detail: options.keepPlugin ? 'kept (--keep-plugin)' : `would run: ${describePluginInstall(install)}`,
      });
    }
    if (installs.length === 0) steps.push({ label: 'plugin bundle', ok: true, detail: 'no installed bundle found' });
    if (!options.keepPlugin) steps.push(...residueSteps(env, true));
    steps.push(...removeStateDirs(env, true));
    steps.push(pipxGraphifyStep(env));
    return { code: 0, steps };
  }

  // 1-2. User-level host integrations, while the bundle they point at still exists.
  steps.push(hostStep('Kilo wrapper', uninstallKiloWrapper(env, ['uninstall'])));
  steps.push(hostStep('OpenCode wrapper', uninstallOpenCodeWrapper(env, ['uninstall'])));
  for (const channel of WINDSURF_CHANNELS) {
    steps.push(hostStep(`Windsurf integration (${channel})`, uninstallWindsurfWrapper(env, ['uninstall', '--yes', '--channel', channel])));
  }
  steps.push(hostStep('Codex MCP block', runOneMcpHostCommand(['uninstall', '--yes'], env)));

  // 3. The bundle itself (every module this runner needs is already loaded).
  if (options.keepPlugin) {
    steps.push({ label: 'plugin bundle', ok: true, detail: 'kept (--keep-plugin)' });
  } else if (installs.length === 0) {
    steps.push({ label: 'plugin bundle', ok: true, detail: 'no installed bundle found' });
  } else {
    for (const install of installs) steps.push(removePluginViaCli(install, env));
  }

  // 3b. Residue the host CLIs do not reclaim. After the CLI removals, because
  // `codex plugin remove` needs the marketplace this step then unregisters, and
  // before the state sweep, because it spawns a host CLI that may touch
  // ~/.traffic-one. Skipped under --keep-plugin: these ARE the bundle.
  if (!options.keepPlugin) steps.push(...residueSteps(env, false));

  // 4. Machine-global state LAST — after every step that could touch it, so the
  // user genuinely ends with no ~/.traffic-one.
  steps.push(...removeStateDirs(env, false));

  // 5. Advisory tail: name what a past pipx-installed graphify left behind that
  // step 4 provably cannot reach. Reports only; never fails the run.
  steps.push(pipxGraphifyStep(env));

  return { code: steps.every((step) => step.ok) ? 0 : 1, steps };
}

function usage(): string {
  return [
    'Usage: traffic-one-uninstall.cjs [--yes] [--dry-run] [--keep-plugin]',
    '',
    'Removes every machine-global Traffic One artifact: the user-level host',
    'integrations (Kilo, OpenCode, Windsurf, the Codex MCP block), the plugin',
    'bundle from each host CLI that has it, the bundle copies no host CLI',
    'reclaims (the Codex local marketplace, a Copilot plugin copy, a Cursor local',
    'install), and — LAST, so nothing can repopulate it — the entire state dir',
    '~/.traffic-one (saved API key, per-project preferences, runner shims,',
    'managed toolchains).',
    '',
    'Onboarded projects are never touched: their .traffic-one/ folders are',
    'project content. Delete them per project, or with `git rm -r`.',
    '',
    '  --yes           apply (required; nothing is written without it)',
    '  --dry-run       print the plan and exit',
    '  --keep-plugin   clean everything but leave the installed bundle in place',
  ].join('\n');
}

function render(steps: Step[], dryRun: boolean): string {
  const lines = [`traffic-one uninstall ${dryRun ? 'dry-run' : 'apply'}:`];
  for (const step of steps) lines.push(`- [${step.ok ? 'ok' : 'FAILED'}] ${step.label}: ${step.detail}`);
  return `${lines.join('\n')}\n`;
}

export function run(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  if (argv.includes('--help') || argv.includes('-h')) return { code: 0, stdout: `${usage()}\n` };
  const keepPlugin = argv.includes('--keep-plugin');
  const apply = argv.includes('--yes');
  const dryRun = argv.includes('--dry-run') || !apply;

  const result = runUninstall({ dryRun, keepPlugin }, env);
  const stdout = render(result.steps, dryRun);

  if (dryRun && !argv.includes('--dry-run')) {
    return {
      code: 2,
      stdout,
      stderr: 'Traffic One uninstall removes user-level host config and ~/.traffic-one. Re-run with --yes to apply.\n',
    };
  }
  if (!dryRun) {
    return {
      code: result.code,
      stdout: `${stdout}\nRestart the host now — this session's hooks still point at the removed plugin and will error until it does.\n`,
    };
  }
  return { code: result.code, stdout };
}

export function main(): number {
  const result = run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) process.exitCode = main();
