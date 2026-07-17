// Explicit maintenance CLI for the only machine-global registration that the
// Codex plugin manager cannot clean itself. Install is idempotent; uninstall is
// consent-gated and removes only Traffic One's byte-exact marked block.

import {
  ensureCodexOneMcpServerRegistered,
  removeCodexOneMcpServerRegistration,
} from '../../shared/codex-mcp';
import { oneMcpRegistrationEnabled } from '../../config/one-mcp';

export interface RunnerOutput { code: number; stdout: string; stderr?: string }

export function runOneMcpHostCommand(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  registrationFeatureEnabled?: boolean,
): RunnerOutput {
  const command = argv[0] || '';
  if (command === 'install') {
    if (!argv.includes('--yes')) {
      return { code: 2, stdout: '', stderr: 'Refusing to edit Codex machine-global config without `install --yes`.\n' };
    }
    if (!oneMcpRegistrationEnabled(env, registrationFeatureEnabled)) {
      return { code: 0, stdout: 'Codex Traffic One MCP registration: skipped-disabled\n' };
    }
    const result = ensureCodexOneMcpServerRegistered({ ...env, TRAFFIC_ONE_HOST: 'codex' });
    return {
      code: result === 'failed' ? 1 : 0,
      stdout: `Codex Traffic One MCP registration: ${result}\n`,
    };
  }
  if (command === 'uninstall') {
    if (!argv.includes('--yes')) {
      return { code: 2, stdout: '', stderr: 'Refusing to edit Codex machine-global config without `uninstall --yes`.\n' };
    }
    const result = removeCodexOneMcpServerRegistration(env);
    return {
      code: result === 'failed' || result === 'modified' ? 1 : 0,
      stdout: `Codex Traffic One MCP registration removal: ${result}\n`,
      ...(result === 'modified' ? {
        stderr: 'The Traffic One marker block differs from the generated block and was left untouched.\n',
      } : {}),
    };
  }
  return {
    code: 2,
    stdout: '',
    stderr: 'Usage: one-mcp-host.cjs <install --yes|uninstall --yes>\n',
  };
}

export function main(): number {
  const result = runOneMcpHostCommand();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

if (require.main === module) process.exitCode = main();
