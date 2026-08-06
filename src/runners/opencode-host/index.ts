// src/runners/opencode-host/index.ts
// OpenCode host runner entry: install/enable/disable/uninstall/doctor +
// run. The embedded plugin, JSONC config editing, and owner records live
// in the sibling modules; the shim calls main().

import * as fs from 'fs';
import * as path from 'path';
import {
  OPENCODE_HOST_TARGET_VERSION,
  OPENCODE_HOST_WRAPPER_API,
} from '../../config/opencode-host';

import {
  explicitCwdArg,
  opencodeGlobalPluginPath,
  opencodeProjectMarkerPath,
  projectActivationRecord,
  projectDisabledRecord,
  projectRootFromArgs,
  readOwner,
  readProjectActivation,
  runtimePluginRoot,
  type RunnerOutput,
} from './host-records';
import {
  ensureGlobalConfigPlugin,
  globalConfigHasPlugin,
  removeGlobalConfigPlugin,
} from './jsonc-config';
import {
  wrapperSource,
} from './wrapper-source';
import { uncertifiedHostInstallRefusal } from '../../shared/host/tiers';

export function installWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  const refusal = uncertifiedHostInstallRefusal('opencode', env);
  if (refusal) return { code: 1, stderr: `${refusal}\n`, stdout: '' };
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to install without explicit consent. Re-run with `install --yes` to write the global OpenCode Traffic One wrapper.\n',
      stdout: '',
    };
  }
  const file = opencodeGlobalPluginPath(env);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readOwner(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode plugin at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, wrapperSource(pluginRoot), 'utf8');
  const config = ensureGlobalConfigPlugin(env, registrationFeatureEnabled);
  if (!config.ok) {
    return { code: 1, stdout: '', stderr: `${config.error}\nwrapper: ${file}\nconfig: ${config.path}\n` };
  }
  return { code: 0, stdout: `Installed Traffic One OpenCode wrapper at ${file}\nRegistered OpenCode global plugin in ${config.path}\nRestart OpenCode to load or refresh global plugins.\n` };
}

export function enableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to enable a project without explicit consent. Re-run with `enable --cwd <project> --yes` to write the project OpenCode activation marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = opencodeProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  const existingOwned = readProjectActivation(file);
  if (fs.existsSync(file) && !existingOwned && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(projectActivationRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Enabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\nRestart OpenCode to load or refresh global plugins if this is the first enable after wrapper install.\n` };
}

export function disableProject(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  if (!argv.includes('--yes')) {
    return {
      code: 2,
      stderr: 'Refusing to disable a project without explicit consent. Re-run with `disable --cwd <project> --yes` to write the project OpenCode opt-out marker.\n',
      stdout: '',
    };
  }
  const projectRoot = projectRootFromArgs(env, argv);
  const file = opencodeProjectMarkerPath(projectRoot);
  const pluginRoot = runtimePluginRoot(env);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
    return { code: 0, stdout: `Disabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\n` };
  }
  const owner = readProjectActivation(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to overwrite unowned OpenCode activation marker at ${file}. Re-run with --force only if you intend Traffic One to replace it.\n`,
      stdout: '',
    };
  }
  fs.writeFileSync(file, `${JSON.stringify(projectDisabledRecord(pluginRoot), null, 2)}\n`, 'utf8');
  return { code: 0, stdout: `Disabled Traffic One for OpenCode project at ${projectRoot}\nmarker: ${file}\n` };
}

export function uninstallWrapper(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv.slice(2)): RunnerOutput {
  const file = opencodeGlobalPluginPath(env);
  if (!fs.existsSync(file)) return { code: 0, stdout: `No Traffic One OpenCode wrapper installed at ${file}\n` };
  const owner = readOwner(file);
  if (!owner && !argv.includes('--force')) {
    return {
      code: 1,
      stderr: `Refusing to remove unowned OpenCode plugin at ${file}. Re-run with --force only if you intend to remove it.\n`,
      stdout: '',
    };
  }
  const config = removeGlobalConfigPlugin(env);
  if (!config.ok && !argv.includes('--force')) {
    return { code: 1, stdout: '', stderr: `${config.error}\nwrapper: ${file}\nconfig: ${config.path}\n` };
  }
  fs.rmSync(file, { force: true });
  return { code: 0, stdout: `Removed Traffic One OpenCode wrapper at ${file}\nRemoved OpenCode global plugin registration from ${config.path}\n` };
}

export function doctorWrapper(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv.slice(2),
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  const file = opencodeGlobalPluginPath(env);
  const owner = readOwner(file);
  if (!fs.existsSync(file)) {
    return { code: 1, stdout: `missing: ${file}\n` };
  }
  if (!owner) {
    return { code: 1, stdout: `unowned: ${file}\n` };
  }
  const config = globalConfigHasPlugin(env, registrationFeatureEnabled);
  const currentRoot = runtimePluginRoot(env);
  const current = path.resolve(owner.pluginRoot) === path.resolve(currentRoot);
  // Wrapper API generation: an owner stamp without the field is generation 1.
  // A stale wrapper keeps working on its old surfaces, but lacks the v2 ones
  // (banner composition + session.idle delivery) until reinstalled.
  const wrapperApi = typeof owner.wrapperApi === 'number' ? owner.wrapperApi : 1;
  const apiCurrent = wrapperApi === OPENCODE_HOST_WRAPPER_API;
  const wrapperApiLine = `wrapperApi: ${wrapperApi}${apiCurrent
    ? ''
    : ` (stale-wrapper: expected ${OPENCODE_HOST_WRAPPER_API} — re-run \`install --yes\` and restart OpenCode)`}\n`;
  const projectArg = explicitCwdArg(argv);
  let projectSection = '';
  let projectOk = true;
  if (projectArg) {
    const projectRoot = path.resolve(projectArg);
    const marker = opencodeProjectMarkerPath(projectRoot);
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
    code: current && projectOk && config.ok && apiCurrent ? 0 : 1,
    stdout: `${current ? 'ok' : 'owned-by-other-install'}: ${file}\npluginRoot: ${owner.pluginRoot}\ntargetOpenCode: ${owner.targetOpenCode || OPENCODE_HOST_TARGET_VERSION}\n${wrapperApiLine}config: ${config.ok ? 'ok' : `error: ${config.error}`} (${config.path})\npluginSpec: ${config.spec}\nloadModel: registered in OpenCode global plugin array\n${projectSection}`,
  };
}

export function run(args: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): RunnerOutput {
  const command = args.find((arg) => !arg.startsWith('--')) || 'doctor';
  if (command === 'install') return installWrapper(env, args);
  if (command === 'enable') return enableProject(env, args);
  if (command === 'disable') return disableProject(env, args);
  if (command === 'uninstall') return uninstallWrapper(env, args);
  if (command === 'doctor') return doctorWrapper(env, args);
  return { code: 2, stdout: '', stderr: 'Usage: opencode-host.cjs <install --yes|enable --cwd <project> --yes|disable --cwd <project> --yes|uninstall|doctor [--cwd <project>]> [--force]\n' };
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
  opencodeGlobalConfigPath,
  opencodeGlobalPluginPath,
  opencodeProjectMarkerPath,
  readOwner,
  readProjectActivation,
  type RunnerOutput,
} from './host-records';
export { wrapperSource } from './wrapper-source';
