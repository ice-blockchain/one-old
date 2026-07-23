// Standalone release entrypoint. A package script can call this file directly:
//   tsx src/test-environment/codex-trust-upgrade-proof.ts

import * as path from 'path';

import { REPO_ROOT_PATH } from './config/test-config';
import { runCodexTrustUpgradeProof } from './core/codex-trust-upgrade-proof';

interface CliOptions {
  distRoot: string;
  codexBin?: string;
  timeoutMs?: number;
}

export function parseCodexTrustProofArgs(argv: string[]): CliOptions {
  const options: CliOptions = { distRoot: path.join(REPO_ROOT_PATH, 'dist') };
  for (const arg of argv) {
    if (arg.startsWith('--dist-root=')) options.distRoot = path.resolve(arg.slice('--dist-root='.length));
    else if (arg.startsWith('--codex-bin=')) options.codexBin = arg.slice('--codex-bin='.length);
    else if (arg.startsWith('--timeout=')) {
      const timeoutMs = Number(arg.slice('--timeout='.length));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error(`invalid --timeout value: ${arg}`);
      options.timeoutMs = timeoutMs;
    } else {
      throw new Error(`unknown Codex trust proof argument: ${arg}`);
    }
  }
  return options;
}

export async function codexTrustProofMain(argv = process.argv.slice(2)): Promise<number> {
  const options = parseCodexTrustProofArgs(argv);
  const result = await runCodexTrustUpgradeProof(options);
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`${status}: Codex trust-upgrade proof (${result.durationMs}ms)`);
  console.log(`  ${result.detail}`);
  console.log(`  plugin=${result.pluginId} v1-trusted=${result.beforeTrusted}/${result.expectedHooks} v2-trusted=${result.afterTrusted}/${result.expectedHooks}`);
  console.log(`  observed=[${result.observedEvents.join(', ')}]`);
  for (const note of result.notes) console.log(`  note: ${note}`);
  return result.ok ? 0 : 1;
}

if (require.main === module) {
  codexTrustProofMain().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
