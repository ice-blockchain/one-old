// src/runners/kilo-host/index.ts
// Kilo host runner entry: install/enable/disable/uninstall/doctor + run.
// The embedded plugin source, JSONC config editing, and owner records live
// in the sibling modules; the shim calls main().

import * as fs from 'fs';
import * as path from 'path';
import {
  KILO_HOOK_CHAT_MESSAGE,
  KILO_HOOK_EVENT,
  KILO_HOOK_PERMISSION_ASK,
  KILO_HOOK_SHELL_ENV,
  KILO_HOOK_SYSTEM_TRANSFORM,
  KILO_HOOK_TOOL_AFTER,
  KILO_HOOK_TOOL_BEFORE,
  KILO_HOST_GLOBAL_CONFIG_DEFAULT_FILE,
  KILO_HOST_GLOBAL_CONFIG_DIR_REL,
  KILO_HOST_GLOBAL_CONFIG_FILES,
  KILO_HOST_GLOBAL_PLUGIN_FILE,
  KILO_HOST_GLOBAL_PLUGIN_ID,
  KILO_HOST_GLOBAL_PLUGINS_REL,
  KILO_HOST_PACKAGE,
  KILO_HOST_PROJECT_MARKER_REL,
  KILO_HOST_TARGET_VERSION,
} from '../../config/kilo-host';
import {
  DEFAULT_PUBLIC_ENDPOINT,
  ONE_MCP_MANAGED_TOOLS,
  ONE_MCP_REGISTRATION,
  ONE_MCP_SERVER_NAME,
} from '../../config/one-mcp';

import {
  explicitCwdArg,
  kiloGlobalConfigPath,
  kiloGlobalPluginPath,
  kiloProjectMarkerPath,
  projectActivationRecord,
  projectDisabledRecord,
  projectRootFromArgs,
  readOwner,
  readProjectActivation,
  runtimePluginRoot,
  type RunnerOutput,
} from './host-records';
import {
  ensureOneMcpDisabled,
  oneMcpDisabledStatus,
} from './jsonc-config';
import {
  wrapperSource,
} from './wrapper-source';

export function installWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to install without explicit consent. Re-run with `install --yes` to write the global Kilo Traffic One wrapper.\n',
      stdout: '',
    };
  }
  const file = kiloGlobalPluginPath(env);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readOwner(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo plugin at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperSource(pluginRoot), 'utf8');
  const registrationEnabled = registrationFeatureEnabled ?? ONE_MCP_REGISTRATION;
  if (registrationEnabled) {
    const config = ensureOneMcpDisabled(env);
    if (!config.ok) {
      return { code: 1, stdout: '', stderr: `${config.error}\nwrapper: ${file}\nconfig: ${config.path}\n` };
    }
  }
  const registrationLine = registrationEnabled
    ? `Registered disabled traffic-one-mcp in ${kiloGlobalConfigPath(env)}\n`
    : 'Public traffic-one-mcp registration is disabled by Traffic One configuration.\n';
  return { code: 0, stdout: `Installed Traffic One Kilo wrapper at ${file}\n${registrationLine}Restart Kilo to load or refresh global plugins.\n` };
}

export function enableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to enable a project without explicit consent. Re-run with `enable --cwd <project> --yes` to write the project Kilo activation marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = kiloProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readProjectActivation(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(projectActivationRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Enabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\nRestart Kilo to load or refresh global plugins if this is the first enable after wrapper install.\n` };
}

export function disableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to disable a project without explicit consent. Re-run with `disable --cwd <project> --yes` to write the project Kilo opt-out marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = kiloProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
    return { code: 0, stdout: `Disabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\n` };
  }
  const owner = readProjectActivation(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned Kilo activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Disabled Traffic One for Kilo project at ${projectRoot}\nmarker: ${file}\n` };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const file = kiloGlobalPluginPath(env);
  if (!fs.existsSync(file)) return { code: 0, stdout: `No Traffic One Kilo wrapper installed at ${file}\n` };
  const owner = readOwner(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to remove unowned Kilo plugin at ${file}. Re-run with --force only if you intend to remove it.\n`,
      stdout: '',
    };
  }
  fs.rmSync(file, { force: true });
  return { code: 0, stdout: `Removed Traffic One Kilo wrapper at ${file}\n` };
}

export function doctorWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  const file = kiloGlobalPluginPath(env);
  const owner = readOwner(file);
  if (!fs.existsSync(file)) {
    return { code: 1, stdout: `missing: ${file}\n` };
  }
  if (!owner) {
    return { code: 1, stdout: `unowned: ${file}\n` };
  }
  const currentRoot = runtimePluginRoot(env);
  const current = path.resolve(owner.pluginRoot) === path.resolve(currentRoot);
  const registrationEnabled = registrationFeatureEnabled ?? ONE_MCP_REGISTRATION;
  const config = registrationEnabled
    ? oneMcpDisabledStatus(env)
    : { ok: true as const, path: kiloGlobalConfigPath(env), changed: false as const };
  const projectArg = explicitCwdArg(argv);
  let projectSection = '';
  let projectOk = true;
  if (projectArg) {
    const projectRoot = path.resolve(projectArg);
    const marker = kiloProjectMarkerPath(projectRoot);
    const activation = readProjectActivation(marker);
    const markerExists = fs.existsSync(marker);
    projectOk = !activation || activation.enabled !== false;
    const status = activation
      ? (activation.enabled === false ? 'disabled' : 'enabled-marker')
      : (markerExists ? 'unowned' : 'automatic');
    if (markerExists && !activation) projectOk = false;
    projectSection = `projectActivation: ${status}\nprojectRoot: ${projectRoot}\nprojectMarker: ${marker}\n`;
  }
  return {
    code: current && projectOk && config.ok ? 0 : 1,
    stdout: `${current ? 'ok' : 'owned-by-other-install'}: ${file}\npluginRoot: ${owner.pluginRoot}\ntargetKilo: ${owner.targetKilo || KILO_HOST_TARGET_VERSION}\nconfig: ${registrationEnabled ? (config.ok ? 'ok' : `error: ${config.error}`) : 'registration-disabled'} (${config.path})\nloadModel: auto-loaded from Kilo global plugin directory\n${projectSection}`,
  };
}

export function run(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  const command = args.find((arg) => !arg.startsWith('--')) || 'doctor';
  if (command === 'install') return installWrapper(env, args);
  if (command === 'enable') return enableProject(env, args);
  if (command === 'disable') return disableProject(env, args);
  if (command === 'uninstall') return uninstallWrapper(env, args);
  if (command === 'doctor') return doctorWrapper(env, args);
  return { code: 2, stdout: '', stderr: 'Usage: kilo-host.cjs <install --yes|enable --cwd <project> --yes|disable --cwd <project> --yes|uninstall|doctor [--cwd <project>]> [--force]\n' };
}

export function main(): number {
  const result = run();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) {
  process.exitCode = main();
}

export {
  kiloConfigDir,
  kiloGlobalConfigPath,
  kiloGlobalPluginPath,
  kiloProjectMarkerPath,
  readOwner,
  readProjectActivation,
  type RunnerOutput,
} from './host-records';
export { wrapperSource } from './wrapper-source';
